//! Actual DataFusion reads from a server-resolved tenant stream, without SQL/HTTP adapters.
//! The pool bounds tracked engine memory, not staging clones or manifest planning allocations.
use super::{
    domain::{Principal, ScopeVersion},
    tools::{
        GrantAuthorizer, ReadExecutor, ReadOperation, RunGrant, ToolError, validate_operation,
    },
};
use arrow_schema::{DataType, SchemaRef, TimeUnit};
use async_trait::async_trait;
use datafusion::{
    catalog::Session,
    common::{Column, ScalarValue, TableReference, ToDFSchema, tree_node::TreeNodeRecursion},
    datasource::{TableProvider, provider_as_source, source_as_provider},
    error::{DataFusionError, Result as DFResult},
    execution::{context::SessionConfig, session_state::SessionStateBuilder},
    logical_expr::{Expr, LogicalPlan, LogicalPlanBuilder, TableType},
    physical_expr::expressions::col as physical_col,
    physical_plan::{
        ExecutionPlan, execute_stream, filter::FilterExec, projection::ProjectionExec,
    },
    prelude::{SessionContext, lit},
};
use futures_util::StreamExt;
use std::{any::Any, io::Write, sync::Arc};
use tokio_util::sync::CancellationToken;

pub const QUERY_MEMORY_BYTES: usize = 32 * 1024 * 1024;
const OUTPUT_BYTES: usize = 1024 * 1024;

struct ResolvedSource {
    principal: Principal,
    dataset: String,
    time_column: String,
    provider: Arc<dyn TableProvider>,
}
#[async_trait]
trait SourceResolver: Send + Sync {
    async fn resolve(
        &self,
        principal: &Principal,
        dataset: &str,
    ) -> Result<ResolvedSource, ToolError>;
    fn context(&self) -> Result<SessionContext, ToolError>;
    async fn prepare(&self, _: &Principal, _: &ScopeVersion) -> Result<(), ToolError> {
        Ok(())
    }
}
struct ParseableSource;
/// Authenticated identity remains DEFAULT_TENANT, but OSS storage uses root paths.
pub(super) fn storage_tenant(principal: &Principal) -> Option<String> {
    (principal.tenant_id != crate::parseable::DEFAULT_TENANT).then(|| principal.tenant_id.clone())
}
#[async_trait]
impl SourceResolver for ParseableSource {
    async fn prepare(&self, principal: &Principal, scope: &ScopeVersion) -> Result<(), ToolError> {
        super::stream_loader::prepare_scope(principal, scope).await
    }
    async fn resolve(
        &self,
        principal: &Principal,
        dataset: &str,
    ) -> Result<ResolvedSource, ToolError> {
        let tenant = storage_tenant(principal);
        let stream = crate::parseable::PARSEABLE
            .get_stream(dataset, &tenant)
            .map_err(|_| ToolError::Unauthorized)?;
        if stream.get_stream_type() == crate::storage::StreamType::Internal {
            return Err(ToolError::Scope);
        }
        let time_column = stream
            .get_time_partition()
            .unwrap_or_else(|| crate::event::DEFAULT_TIMESTAMP_KEY.into());
        // This concrete provider binds its storage paths to this tenant and stream; no catalog lookup or external source is accepted.
        let provider = crate::query::stream_schema_provider::native_read_only_table(
            stream.get_schema(),
            dataset.to_owned(),
            tenant,
            super::stream_loader::resident_metadata(principal, dataset, &stream).await?,
            crate::parseable::PARSEABLE.storage().get_object_store(),
            crate::parseable::PARSEABLE.metastore.clone(),
            crate::parseable::PARSEABLE.storage().name() == "drive",
        );
        Ok(ResolvedSource {
            principal: principal.clone(),
            dataset: dataset.into(),
            time_column,
            provider,
        })
    }
    fn context(&self) -> Result<SessionContext, ToolError> {
        let runtime = crate::parseable::PARSEABLE
            .storage()
            .get_datafusion_runtime()
            .with_memory_limit(QUERY_MEMORY_BYTES, 1.0)
            .with_metadata_cache_limit(0)
            .with_object_list_cache_limit(0)
            .with_file_statistics_cache_limit(0)
            .with_max_temp_directory_size(0)
            .build()
            .map_err(|_| ToolError::Unavailable)?;
        Ok(context_with_runtime(Arc::new(runtime)))
    }
}
fn context_with_runtime(
    runtime: Arc<datafusion::execution::runtime_env::RuntimeEnv>,
) -> SessionContext {
    let config = SessionConfig::default()
        .with_create_default_catalog_and_schema(false)
        .with_information_schema(false)
        .with_batch_size(256)
        .with_target_partitions(1);
    let state = SessionStateBuilder::new()
        .with_default_features()
        .with_config(config)
        .with_runtime_env(runtime)
        .build();
    SessionContext::new_with_state(state)
}

/// Only this wrapper may occur in a resolved logical scan. It repeats mandatory
/// predicates at scan dispatch and retains a physical residual filter even when
/// a storage provider reports approximate/inexact pushdown.
#[derive(Debug)]
struct BoundedSource {
    principal: Principal,
    dataset: String,
    provider: Arc<dyn TableProvider>,
    predicate: Expr,
    scan_filters: [Expr; 2],
}
#[async_trait]
impl TableProvider for BoundedSource {
    fn schema(&self) -> SchemaRef {
        self.provider.schema()
    }
    fn table_type(&self) -> TableType {
        TableType::Base
    }
    async fn scan(
        &self,
        state: &dyn Session,
        projection: Option<&Vec<usize>>,
        _: &[Expr],
        _: Option<usize>,
    ) -> DFResult<Arc<dyn ExecutionPlan>> {
        // Never pass a pre-filter LIMIT to the provider: it could consume rows outside the scope.
        let plan = self
            .provider
            .scan(state, None, &self.scan_filters, None)
            .await?;
        let predicate =
            state.create_physical_expr(self.predicate.clone(), &plan.schema().to_dfschema()?)?;
        let mut plan: Arc<dyn ExecutionPlan> = Arc::new(FilterExec::try_new(predicate, plan)?);
        if let Some(indices) = projection {
            let schema = plan.schema();
            let expressions = indices
                .iter()
                .map(|index| {
                    let name = schema.field(*index).name().clone();
                    Ok((physical_col(&name, &schema)?, name))
                })
                .collect::<DFResult<Vec<_>>>()?;
            plan = Arc::new(ProjectionExec::try_new(expressions, plan)?);
        }
        Ok(plan)
    }
}

fn timestamp_scalar(value: &str, datatype: &DataType) -> Result<ScalarValue, ToolError> {
    let instant = chrono::DateTime::parse_from_rfc3339(value).map_err(|_| ToolError::Scope)?;
    let nanos = instant.timestamp_nanos_opt().ok_or(ToolError::Scope)?;
    let ceil = |divisor: i64| nanos.div_euclid(divisor) + i64::from(nanos.rem_euclid(divisor) != 0);
    // Ceil both half-open endpoints to the source precision; truncating start would widen the scope.
    match datatype {
        DataType::Timestamp(TimeUnit::Millisecond, zone) => Ok(ScalarValue::TimestampMillisecond(
            Some(ceil(1_000_000)),
            zone.clone(),
        )),
        DataType::Timestamp(TimeUnit::Nanosecond, zone) => {
            Ok(ScalarValue::TimestampNanosecond(Some(nanos), zone.clone()))
        }
        _ => Err(ToolError::Scope),
    }
}
fn bounded_source(
    source: ResolvedSource,
    start: &str,
    end: &str,
) -> Result<Arc<BoundedSource>, ToolError> {
    let schema = source.provider.schema();
    let field = schema
        .field_with_name(&source.time_column)
        .map_err(|_| ToolError::Scope)?;
    // Storage's primary-time extractor accepts only separate ms/ns comparisons.
    // Keep the same immutable predicates in the scan and in the residual filter.
    let lower = Expr::Column(Column::from_name(source.time_column.clone()))
        .gt_eq(lit(timestamp_scalar(start, field.data_type())?));
    let upper = Expr::Column(Column::from_name(source.time_column.clone()))
        .lt(lit(timestamp_scalar(end, field.data_type())?));
    let predicate = lower.clone().and(upper.clone());
    Ok(Arc::new(BoundedSource {
        principal: source.principal,
        dataset: source.dataset,
        provider: source.provider,
        predicate,
        scan_filters: [lower, upper],
    }))
}
fn validate_scans(
    plan: &LogicalPlan,
    expected: &Arc<BoundedSource>,
    allow_empty: bool,
) -> Result<(), ToolError> {
    let mut scans = 0;
    plan.apply_with_subqueries(|plan| {
        match plan {
            LogicalPlan::TableScan(scan) => {
                let provider = source_as_provider(&scan.source)?;
                let provider = (provider.as_ref() as &dyn Any)
                    .downcast_ref::<BoundedSource>()
                    .ok_or_else(|| DataFusionError::Plan("unbound source".into()))?;
                if scan.table_name != TableReference::bare(expected.dataset.as_str())
                    || provider.principal != expected.principal
                    || provider.dataset != expected.dataset
                    || provider.predicate != expected.predicate
                    || provider.scan_filters != expected.scan_filters
                    || !Arc::ptr_eq(&provider.provider, &expected.provider)
                {
                    return Err(DataFusionError::Plan("scope mismatch".into()));
                }
                scans += 1;
            }
            LogicalPlan::Filter(_) | LogicalPlan::Limit(_) | LogicalPlan::Projection(_) => {}
            LogicalPlan::EmptyRelation(_) if allow_empty => {}
            _ => return Err(DataFusionError::Plan("unsupported read plan".into())),
        }
        Ok(TreeNodeRecursion::Continue)
    })
    .map_err(|_| ToolError::Scope)?;
    if scans == 1 || allow_empty && scans == 0 {
        Ok(())
    } else {
        Err(ToolError::Scope)
    }
}

const READ_DEADLINE: std::time::Duration = std::time::Duration::from_secs(30);
const MANIFEST_COMPRESSED_BYTES: usize = 8 * 1024 * 1024;
const MANIFEST_DECODED_BYTES: usize = 16 * 1024 * 1024;

/// Aborts the spawned read when its caller drops; the query runtime then drops
/// the read's future and whatever it owns directly. DataFusion child tasks it
/// spawned receive an abort but are not awaited, and an in-flight manifest
/// decode or local-file blocking call finishes its current call, within its
/// own limits, before its result is discarded.
struct AbortReadOnDrop<T>(tokio::task::JoinHandle<T>);
impl<T> Drop for AbortReadOnDrop<T> {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// Holds the calling coordinator run's lease until the read future itself has
/// been dropped (fields drop in declaration order), so an aborted read keeps
/// its run's permit and admission counted until the query runtime unwinds this
/// top-level task. Work it handed to other tasks or blocking threads is not
/// covered; see `AbortReadOnDrop`.
struct LeasedRead<F> {
    read: std::pin::Pin<Box<F>>,
    _lease: Option<super::coordinator::WorkLease>,
}
impl<F: std::future::Future> std::future::Future for LeasedRead<F> {
    type Output = F::Output;
    fn poll(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<F::Output> {
        self.read.as_mut().poll(cx)
    }
}

struct ScopedRead {
    authorizer: Arc<dyn GrantAuthorizer>,
    resolver: Arc<dyn SourceResolver>,
}
pub struct ScopedQueryExecutor {
    read: Arc<ScopedRead>,
    /// Planning and DataFusion polling run here, never on the caller's (Actix) worker.
    runtime: tokio::runtime::Handle,
    deadline: std::time::Duration,
}
impl ScopedQueryExecutor {
    pub fn new(authorizer: Arc<dyn GrantAuthorizer>) -> Self {
        Self {
            read: Arc::new(ScopedRead {
                authorizer,
                resolver: Arc::new(ParseableSource),
            }),
            runtime: crate::query::QUERY_RUNTIME.handle().clone(),
            deadline: READ_DEADLINE,
        }
    }
}
impl ScopedRead {
    async fn read(
        &self,
        grant: &RunGrant,
        scope: &ScopeVersion,
        operation: &ReadOperation,
    ) -> Result<serde_json::Value, ToolError> {
        self.authorizer.authorize(grant, scope)?;
        validate_operation(scope, operation)?;
        let dataset = match operation {
            ReadOperation::Schema { dataset } | ReadOperation::Sample { dataset, .. } => dataset,
        };
        self.resolver.prepare(&grant.principal, scope).await?;
        self.authorizer.authorize(grant, scope)?;
        let source = self.resolver.resolve(&grant.principal, dataset).await?;
        if source.principal != grant.principal || source.dataset != *dataset {
            return Err(ToolError::Scope);
        }
        let value = match operation {
            ReadOperation::Schema { .. } => {
                serde_json::json!({"dataset": dataset, "fields": source.provider.schema().fields()})
            }
            ReadOperation::Sample {
                start, end, rows, ..
            } => {
                let ctx = self.resolver.context()?;
                let source = bounded_source(source, start, end)?;
                let plan = LogicalPlanBuilder::scan(
                    TableReference::bare(dataset.as_str()),
                    provider_as_source(source.clone()),
                    None,
                )
                .map_err(|_| ToolError::Execution)?
                .filter(source.predicate.clone())
                .map_err(|_| ToolError::Execution)?
                .limit(0, Some(*rows as usize))
                .map_err(|_| ToolError::Execution)?
                .build()
                .map_err(|_| ToolError::Execution)?;
                validate_scans(&plan, &source, false)?;
                let df = ctx
                    .execute_logical_plan(plan)
                    .await
                    .map_err(|_| ToolError::Execution)?;
                let optimized = df.into_optimized_plan().map_err(|_| ToolError::Execution)?;
                validate_scans(&optimized, &source, true)?;
                self.authorizer.authorize(grant, scope)?;
                let physical = ctx
                    .state()
                    .create_physical_plan(&optimized)
                    .await
                    .map_err(|_| ToolError::Execution)?;
                let mut stream =
                    execute_stream(physical, ctx.task_ctx()).map_err(|_| ToolError::Execution)?;
                let mut writer = arrow_json::ArrayWriter::new(LimitedOutput(Vec::new()));
                let mut count = 0;
                while let Some(batch) = stream.next().await {
                    let batch = batch.map_err(|_| ToolError::Execution)?;
                    count += batch.num_rows();
                    if count > *rows as usize {
                        return Err(ToolError::OutputLimit);
                    }
                    writer.write(&batch).map_err(|_| ToolError::OutputLimit)?;
                }
                writer.finish().map_err(|_| ToolError::OutputLimit)?;
                let data: serde_json::Value = serde_json::from_slice(&writer.into_inner().0)
                    .map_err(|_| ToolError::Execution)?;
                serde_json::json!({"dataset":dataset,"start":start,"end":end,"rows":data,"rowCount":count})
            }
        };
        self.authorizer.authorize(grant, scope)?;
        if serde_json::to_vec(&value)
            .map_err(|_| ToolError::OutputLimit)?
            .len()
            > OUTPUT_BYTES
        {
            return Err(ToolError::OutputLimit);
        }
        Ok(value)
    }
}
#[async_trait]
impl ReadExecutor for ScopedQueryExecutor {
    async fn execute(
        &self,
        grant: &RunGrant,
        scope: &ScopeVersion,
        operation: &ReadOperation,
        cancel: CancellationToken,
    ) -> Result<serde_json::Value, ToolError> {
        if cancel.is_cancelled() {
            return Err(ToolError::Cancelled);
        }
        // Owned copies of the bounded grant/scope/operation only; no request or session state.
        let (read, grant, scope, operation) = (
            self.read.clone(),
            grant.clone(),
            scope.clone(),
            operation.clone(),
        );
        let deadline = self.deadline;
        let work = async move {
            // The decode budget is task-local and does not cross spawn: establish it
            // inside the spawned task so manifest limits stay enforced here.
            let budget = crate::catalog::manifest::ManifestDecodeBudget::new(
                MANIFEST_COMPRESSED_BYTES,
                MANIFEST_DECODED_BYTES,
            );
            tokio::time::timeout(
                deadline,
                budget.scope(read.read(&grant, &scope, &operation)),
            )
            .await
            .map_err(|_| ToolError::Timeout)?
        };
        // Task-locals do not cross spawn either: move the coordinator's lease in.
        let mut task = AbortReadOnDrop(self.runtime.spawn(LeasedRead {
            read: Box::pin(work),
            _lease: super::coordinator::WorkLease::current(),
        }));
        let joined = tokio::select! {
            biased;
            _ = cancel.cancelled() => {
                // Wait for the abort so the nested read has been dropped before reporting.
                task.0.abort();
                let _ = (&mut task.0).await;
                return Err(ToolError::Cancelled);
            }
            joined = &mut task.0 => joined,
        };
        match joined {
            Ok(result) => result,
            Err(error) if error.is_cancelled() => Err(ToolError::Unavailable),
            Err(_) => Err(ToolError::Execution),
        }
    }
}
struct LimitedOutput(Vec<u8>);
impl Write for LimitedOutput {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if self.0.len().saturating_add(bytes.len()) > OUTPUT_BYTES {
            return Err(std::io::Error::other("output bound"));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use std::sync::Mutex;

    /// Stand-in for QUERY_RUNTIME, which would otherwise be shared across tests.
    /// Shut down in the background: dropping a runtime inside an async test panics.
    pub(crate) struct TestQueryRuntime(Option<tokio::runtime::Runtime>);
    impl TestQueryRuntime {
        pub(crate) fn new() -> Self {
            Self(Some(
                tokio::runtime::Builder::new_multi_thread()
                    .worker_threads(2)
                    .enable_all()
                    .build()
                    .unwrap(),
            ))
        }
        pub(crate) fn handle(&self) -> tokio::runtime::Handle {
            self.0.as_ref().unwrap().handle().clone()
        }
        pub(crate) fn alive_tasks(&self) -> usize {
            self.0.as_ref().unwrap().metrics().num_alive_tasks()
        }
    }
    impl Drop for TestQueryRuntime {
        fn drop(&mut self) {
            if let Some(runtime) = self.0.take() {
                runtime.shutdown_background();
            }
        }
    }

    struct AllowAll;
    impl GrantAuthorizer for AllowAll {
        fn authorize(&self, _: &RunGrant, _: &ScopeVersion) -> Result<(), ToolError> {
            Ok(())
        }
    }
    /// Appends "start" when a read's source begins and "drop" when that source
    /// future is dropped, so tests can order teardown against later reads.
    pub(crate) type ReadLog = Arc<Mutex<Vec<&'static str>>>;
    struct Logged(ReadLog);
    impl Drop for Logged {
        fn drop(&mut self) {
            self.0.lock().unwrap().push("drop");
        }
    }
    /// Stays pending until its task is aborted. With a gate, it first blocks the
    /// query runtime thread inside a single poll until the gate is released,
    /// which no abort can interrupt.
    struct PendingSource {
        log: ReadLog,
        started: tokio::sync::mpsc::UnboundedSender<()>,
        gate: Option<Mutex<std::sync::mpsc::Receiver<()>>>,
    }
    #[async_trait]
    impl SourceResolver for PendingSource {
        async fn prepare(&self, _: &Principal, _: &ScopeVersion) -> Result<(), ToolError> {
            self.log.lock().unwrap().push("start");
            let _logged = Logged(self.log.clone());
            let _ = self.started.send(());
            if let Some(gate) = &self.gate {
                // A failure bound only: tests always release the gate.
                let _ = gate
                    .lock()
                    .unwrap()
                    .recv_timeout(std::time::Duration::from_secs(10));
            }
            std::future::pending::<()>().await;
            Ok(())
        }
        async fn resolve(&self, _: &Principal, _: &str) -> Result<ResolvedSource, ToolError> {
            Err(ToolError::Unavailable)
        }
        fn context(&self) -> Result<SessionContext, ToolError> {
            Err(ToolError::Unavailable)
        }
    }
    /// The production executor over a source that never completes on its own.
    pub(crate) fn pending_executor(
        runtime: tokio::runtime::Handle,
        gate: Option<std::sync::mpsc::Receiver<()>>,
    ) -> (
        ScopedQueryExecutor,
        ReadLog,
        tokio::sync::mpsc::UnboundedReceiver<()>,
    ) {
        let log = ReadLog::default();
        let (started, started_rx) = tokio::sync::mpsc::unbounded_channel();
        let executor = ScopedQueryExecutor {
            read: Arc::new(ScopedRead {
                authorizer: Arc::new(AllowAll),
                resolver: Arc::new(PendingSource {
                    log: log.clone(),
                    started,
                    gate: gate.map(Mutex::new),
                }),
            }),
            runtime,
            deadline: READ_DEADLINE,
        };
        (executor, log, started_rx)
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::TestQueryRuntime;
    use super::*;
    use arrow_array::{RecordBatch, TimestampMillisecondArray};
    use arrow_schema::{Field, Schema};
    use datafusion::{
        catalog::streaming::StreamingTable,
        datasource::MemTable,
        execution::{
            RecordBatchStream, SendableRecordBatchStream, TaskContext,
            runtime_env::RuntimeEnvBuilder,
        },
        physical_plan::streaming::PartitionStream,
    };
    use std::{
        pin::Pin,
        sync::atomic::{AtomicUsize, Ordering},
        task::{Context, Poll},
    };
    struct Allow;
    impl GrantAuthorizer for Allow {
        fn authorize(&self, _: &RunGrant, _: &ScopeVersion) -> Result<(), ToolError> {
            Ok(())
        }
    }
    struct FixtureSource {
        principal: Principal,
        provider: Arc<dyn TableProvider>,
        resolutions: Arc<AtomicUsize>,
    }
    #[async_trait]
    impl SourceResolver for FixtureSource {
        async fn resolve(&self, _: &Principal, dataset: &str) -> Result<ResolvedSource, ToolError> {
            self.resolutions.fetch_add(1, Ordering::SeqCst);
            Ok(ResolvedSource {
                principal: self.principal.clone(),
                dataset: dataset.into(),
                time_column: "event_time".into(),
                provider: self.provider.clone(),
            })
        }
        fn context(&self) -> Result<SessionContext, ToolError> {
            Ok(context_with_runtime(Arc::new(
                RuntimeEnvBuilder::new()
                    .with_memory_limit(QUERY_MEMORY_BYTES, 1.0)
                    .with_max_temp_directory_size(0)
                    .build()
                    .unwrap(),
            )))
        }
    }
    fn schema() -> SchemaRef {
        Arc::new(Schema::new(vec![Field::new(
            "event_time",
            DataType::Timestamp(TimeUnit::Millisecond, None),
            false,
        )]))
    }
    static SHARED_TEST_RUNTIME: once_cell::sync::Lazy<TestQueryRuntime> =
        once_cell::sync::Lazy::new(TestQueryRuntime::new);
    async fn eventually(what: &str, condition: impl Fn() -> bool) {
        // A failure bound, not a latency assertion.
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while !condition() {
                tokio::time::sleep(std::time::Duration::from_millis(1)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("{what}"));
    }
    fn executor_on(
        resolver: Arc<dyn SourceResolver>,
        runtime: tokio::runtime::Handle,
    ) -> ScopedQueryExecutor {
        ScopedQueryExecutor {
            read: Arc::new(ScopedRead {
                authorizer: Arc::new(Allow),
                resolver,
            }),
            runtime,
            deadline: READ_DEADLINE,
        }
    }
    fn fixture(
        provider: Arc<dyn TableProvider>,
    ) -> (
        ScopedQueryExecutor,
        RunGrant,
        ScopeVersion,
        ReadOperation,
        Arc<AtomicUsize>,
    ) {
        let (principal, _, node) = super::super::context::tests::fixture();
        let resolutions = Arc::new(AtomicUsize::new(0));
        let executor = executor_on(
            Arc::new(FixtureSource {
                principal: principal.clone(),
                provider,
                resolutions: resolutions.clone(),
            }),
            SHARED_TEST_RUNTIME.handle(),
        );
        let grant = RunGrant {
            principal,
            credential_id: "fixture".into(),
            expires_at: chrono::Utc::now().timestamp() + 120,
        };
        let operation = ReadOperation::Sample {
            dataset: "logs".into(),
            start: "2026-09-01T00:00:00.0001Z".into(),
            end: "2026-09-01T00:00:00.0021Z".into(),
            rows: 10,
        };
        (executor, grant, node.scope, operation, resolutions)
    }
    fn memory_source() -> Arc<dyn TableProvider> {
        let start = chrono::DateTime::parse_from_rfc3339("2026-09-01T00:00:00Z")
            .unwrap()
            .timestamp_millis();
        let batch = RecordBatch::try_new(
            schema(),
            vec![Arc::new(TimestampMillisecondArray::from(vec![
                start - 1,
                start,
                start + 1,
                start + 2,
                start + 3,
            ]))],
        )
        .unwrap();
        Arc::new(MemTable::try_new(schema(), vec![vec![batch]]).unwrap())
    }
    #[tokio::test]
    async fn actual_local_metastore_paths_preserve_oss_root_and_named_tenant_isolation() {
        use crate::{
            catalog::{
                manifest::{Manifest, encode_manifest},
                partition_path,
            },
            metastore::{
                metastore_traits::Metastore,
                metastores::object_store_metastore::ObjectStoreMetastore,
            },
            storage::LocalFS,
        };
        let directory = tempfile::tempdir().unwrap();
        let metastore = ObjectStoreMetastore {
            storage: Arc::new(LocalFS::new(directory.path().to_owned())),
        };
        let (mut principal, _, _) = super::super::context::tests::fixture();
        principal.tenant_id = crate::parseable::DEFAULT_TENANT.into();
        let start = chrono::DateTime::parse_from_rfc3339("2026-09-01T00:00:00Z")
            .unwrap()
            .with_timezone(&chrono::Utc);
        let end = start + chrono::TimeDelta::hours(1);
        let tenant = storage_tenant(&principal);
        assert_eq!(tenant, None);
        let root = partition_path("logs", start, end, &tenant).join("manifest.json");
        assert_eq!(root.as_str(), "logs/date=2026-09-01/manifest.json");
        let wrong_prefix = partition_path(
            "logs",
            start,
            end,
            &Some(crate::parseable::DEFAULT_TENANT.into()),
        )
        .join("manifest.json");
        principal.tenant_id = "named-tenant".into();
        let named_tenant = storage_tenant(&principal);
        let named = partition_path("logs", start, end, &named_tenant).join("manifest.json");
        for (path, version) in [
            (&root, "oss-root-fixture"),
            (&wrong_prefix, "wrong-default-prefix"),
            (&named, "named-tenant-fixture"),
        ] {
            let absolute = path.to_path(directory.path());
            std::fs::create_dir_all(absolute.parent().unwrap()).unwrap();
            std::fs::write(
                absolute,
                encode_manifest(&Manifest {
                    version: version.into(),
                    files: Vec::new(),
                })
                .unwrap(),
            )
            .unwrap();
        }
        // This is the actual metastore + LocalFS + blocking codec path used by
        // StandardTableProvider.collect_from_snapshot, not a MemTable substitute.
        assert_eq!(
            metastore
                .get_manifest("logs", start, end, Some(root.to_string()), &tenant)
                .await
                .unwrap()
                .unwrap()
                .version,
            "oss-root-fixture"
        );
        assert_eq!(
            metastore
                .get_manifest("logs", start, end, Some(named.to_string()), &named_tenant)
                .await
                .unwrap()
                .unwrap()
                .version,
            "named-tenant-fixture"
        );
    }
    #[tokio::test]
    async fn actual_datafusion_read_uses_explicit_time_column_and_exact_half_open_scope() {
        let (executor, grant, scope, operation, _) = fixture(memory_source());
        let value = executor
            .execute(&grant, &scope, &operation, CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(value["rowCount"], 2);
        assert_eq!(value["rows"][0]["event_time"], "2026-09-01T00:00:00.001");
        assert_eq!(value["rows"][1]["event_time"], "2026-09-01T00:00:00.002");
    }
    #[tokio::test]
    async fn unsafe_dataset_filters_and_widened_time_fail_before_source_resolution() {
        let (executor, grant, mut scope, operation, resolutions) = fixture(memory_source());
        scope.filters.insert("message".into(), "secret".into());
        assert_eq!(
            executor
                .execute(&grant, &scope, &operation, CancellationToken::new())
                .await,
            Err(ToolError::Scope)
        );
        scope.filters.clear();
        for dataset in [
            "other",
            "tenant.logs",
            "_internal",
            "https://evil/logs",
            "logs;select",
        ] {
            let op = ReadOperation::Schema {
                dataset: dataset.into(),
            };
            assert_eq!(
                executor
                    .execute(&grant, &scope, &op, CancellationToken::new())
                    .await,
                Err(ToolError::Scope)
            );
        }
        let op = ReadOperation::Sample {
            dataset: "logs".into(),
            start: "2026-08-31T23:59:59Z".into(),
            end: scope.absolute_end.clone(),
            rows: 10,
        };
        assert_eq!(
            executor
                .execute(&grant, &scope, &op, CancellationToken::new())
                .await,
            Err(ToolError::Scope)
        );
        assert_eq!(resolutions.load(Ordering::SeqCst), 0);
    }
    #[tokio::test]
    async fn forged_resolved_tenant_is_rejected_before_datafusion_execution() {
        let (executor, mut grant, scope, operation, _) = fixture(memory_source());
        grant.principal.tenant_id = "forged".into();
        assert_eq!(
            executor
                .execute(&grant, &scope, &operation, CancellationToken::new())
                .await,
            Err(ToolError::Scope)
        );
    }
    #[test]
    fn resolved_scan_rejects_an_unwrapped_or_replaced_provider() {
        let (principal, _, _) = super::super::context::tests::fixture();
        let raw = memory_source();
        let source = bounded_source(
            ResolvedSource {
                principal,
                dataset: "logs".into(),
                time_column: "event_time".into(),
                provider: raw.clone(),
            },
            "2026-09-01T00:00:00Z",
            "2026-09-01T00:00:01Z",
        )
        .unwrap();
        let plan = LogicalPlanBuilder::scan("logs", provider_as_source(raw), None)
            .unwrap()
            .build()
            .unwrap();
        assert_eq!(validate_scans(&plan, &source, false), Err(ToolError::Scope));
        let plan = LogicalPlanBuilder::scan("other", provider_as_source(source.clone()), None)
            .unwrap()
            .build()
            .unwrap();
        assert_eq!(validate_scans(&plan, &source, false), Err(ToolError::Scope));
    }
    #[test]
    fn actual_storage_primary_time_extractor_receives_both_immutable_scan_bounds() {
        use crate::query::stream_schema_provider::{PartialTimeFilter, extract_primary_filter};
        let (principal, _, _) = super::super::context::tests::fixture();
        let source = bounded_source(
            ResolvedSource {
                principal,
                dataset: "logs".into(),
                time_column: "event_time".into(),
                provider: memory_source(),
            },
            "2026-09-01T00:00:00.0001Z",
            "2026-09-01T00:00:00.0021Z",
        )
        .unwrap();
        let filters = extract_primary_filter(&source.scan_filters, &Some("event_time".into()));
        assert_eq!(filters.len(), 2);
        match &filters[0] {
            PartialTimeFilter::Low(std::ops::Bound::Included(bound)) => {
                assert_eq!(bound.and_utc().timestamp_subsec_millis(), 1)
            }
            _ => panic!("missing lower bound"),
        }
        match &filters[1] {
            PartialTimeFilter::High(std::ops::Bound::Excluded(bound)) => {
                assert_eq!(bound.and_utc().timestamp_subsec_millis(), 3)
            }
            _ => panic!("missing upper bound"),
        }
        // Unsupported precision must fail before it reaches storage planning.
        assert!(matches!(
            timestamp_scalar(
                "2026-09-01T00:00:00Z",
                &DataType::Timestamp(TimeUnit::Second, None)
            ),
            Err(ToolError::Scope)
        ));
        assert!(matches!(
            timestamp_scalar(
                "2026-09-01T00:00:00Z",
                &DataType::Timestamp(TimeUnit::Microsecond, None)
            ),
            Err(ToolError::Scope)
        ));
    }
    #[derive(Debug)]
    struct PendingPartition {
        live: Arc<AtomicUsize>,
        schema: SchemaRef,
    }
    impl PartitionStream for PendingPartition {
        fn schema(&self) -> &SchemaRef {
            &self.schema
        }
        fn execute(&self, _: Arc<TaskContext>) -> SendableRecordBatchStream {
            self.live.fetch_add(1, Ordering::SeqCst);
            Box::pin(PendingStream {
                live: self.live.clone(),
                schema: self.schema.clone(),
            })
        }
    }
    struct PendingStream {
        live: Arc<AtomicUsize>,
        schema: SchemaRef,
    }
    impl futures_util::Stream for PendingStream {
        type Item = DFResult<RecordBatch>;
        fn poll_next(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Option<Self::Item>> {
            Poll::Pending
        }
    }
    impl RecordBatchStream for PendingStream {
        fn schema(&self) -> SchemaRef {
            self.schema.clone()
        }
    }
    impl Drop for PendingStream {
        fn drop(&mut self) {
            self.live.fetch_sub(1, Ordering::SeqCst);
        }
    }
    fn pending_provider(live: &Arc<AtomicUsize>) -> Arc<dyn TableProvider> {
        // Multiple partitions exercise DataFusion's merged-stream receiver cancellation.
        let partitions: Vec<Arc<dyn PartitionStream>> = (0..2)
            .map(|_| {
                Arc::new(PendingPartition {
                    live: live.clone(),
                    schema: schema(),
                }) as Arc<dyn PartitionStream>
            })
            .collect();
        Arc::new(StreamingTable::try_new(schema(), partitions).unwrap())
    }
    #[tokio::test]
    async fn cancellation_drops_actual_datafusion_partition_stream() {
        let live = Arc::new(AtomicUsize::new(0));
        let (mut executor, grant, scope, operation, _) = fixture(pending_provider(&live));
        let runtime = TestQueryRuntime::new();
        executor.runtime = runtime.handle();
        let token = CancellationToken::new();
        let stop = async {
            eventually("partitions must open", || live.load(Ordering::SeqCst) != 0).await;
            token.cancel();
        };
        let (result, ()) = tokio::join!(
            executor.execute(&grant, &scope, &operation, token.clone()),
            stop
        );
        assert_eq!(result, Err(ToolError::Cancelled));
        eventually(
            "DataFusion must release every live partition on cancellation",
            || live.load(Ordering::SeqCst) == 0,
        )
        .await;
        eventually("cancelled read must not leave a query task", || {
            runtime.alive_tasks() == 0
        })
        .await;
    }
    #[tokio::test]
    async fn dropping_execution_future_releases_actual_datafusion_partition_streams() {
        let live = Arc::new(AtomicUsize::new(0));
        let (mut executor, grant, scope, operation, _) = fixture(pending_provider(&live));
        let runtime = TestQueryRuntime::new();
        executor.runtime = runtime.handle();
        let mut execution =
            Box::pin(executor.execute(&grant, &scope, &operation, CancellationToken::new()));
        let started = eventually("partitions must open", || live.load(Ordering::SeqCst) != 0);
        tokio::select! { result = &mut execution => panic!("pending read completed: {result:?}"), () = started => {} }
        drop(execution);
        eventually(
            "dropped execution must release DataFusion partitions",
            || live.load(Ordering::SeqCst) == 0,
        )
        .await;
        eventually("dropped execution must abort its query task", || {
            runtime.alive_tasks() == 0
        })
        .await;
    }

    /// Counts a live nested source future; released only when that future is dropped.
    struct LiveGuard(Arc<AtomicUsize>);
    impl LiveGuard {
        fn new(live: &Arc<AtomicUsize>) -> Self {
            live.fetch_add(1, Ordering::SeqCst);
            Self(live.clone())
        }
    }
    impl Drop for LiveGuard {
        fn drop(&mut self) {
            self.0.fetch_sub(1, Ordering::SeqCst);
        }
    }
    /// A source whose preparation synchronously blocks the thread polling it until
    /// the caller releases it, then optionally stays pending forever.
    struct GateSource {
        inner: FixtureSource,
        live: Arc<AtomicUsize>,
        started: tokio::sync::mpsc::UnboundedSender<std::thread::ThreadId>,
        release: std::sync::Mutex<std::sync::mpsc::Receiver<()>>,
        then_pending: bool,
    }
    #[async_trait]
    impl SourceResolver for GateSource {
        async fn prepare(&self, _: &Principal, _: &ScopeVersion) -> Result<(), ToolError> {
            let _guard = LiveGuard::new(&self.live);
            self.started.send(std::thread::current().id()).unwrap();
            // If this ran on the caller's only thread, the caller could never release it.
            self.release
                .lock()
                .unwrap()
                .recv_timeout(std::time::Duration::from_secs(10))
                .map_err(|_| ToolError::Unavailable)?;
            if self.then_pending {
                std::future::pending::<()>().await;
            }
            Ok(())
        }
        async fn resolve(
            &self,
            principal: &Principal,
            dataset: &str,
        ) -> Result<ResolvedSource, ToolError> {
            self.inner.resolve(principal, dataset).await
        }
        fn context(&self) -> Result<SessionContext, ToolError> {
            self.inner.context()
        }
    }
    struct Gate {
        executor: ScopedQueryExecutor,
        live: Arc<AtomicUsize>,
        started: tokio::sync::mpsc::UnboundedReceiver<std::thread::ThreadId>,
        release: std::sync::mpsc::Sender<()>,
        runtime: TestQueryRuntime,
    }
    fn gate(then_pending: bool) -> (Gate, RunGrant, ScopeVersion, ReadOperation) {
        let (fixture_executor, grant, scope, operation, _) = fixture(memory_source());
        let live = Arc::new(AtomicUsize::new(0));
        let (started_tx, started) = tokio::sync::mpsc::unbounded_channel();
        let (release, release_rx) = std::sync::mpsc::channel();
        let runtime = TestQueryRuntime::new();
        let executor = executor_on(
            Arc::new(GateSource {
                inner: FixtureSource {
                    principal: grant.principal.clone(),
                    provider: memory_source(),
                    resolutions: Arc::new(AtomicUsize::new(0)),
                },
                live: live.clone(),
                started: started_tx,
                release: std::sync::Mutex::new(release_rx),
                then_pending,
            }),
            runtime.handle(),
        );
        drop(fixture_executor);
        (
            Gate {
                executor,
                live,
                started,
                release,
                runtime,
            },
            grant,
            scope,
            operation,
        )
    }
    #[tokio::test(flavor = "current_thread")]
    async fn single_thread_caller_stays_responsive_while_query_runtime_works() {
        let (
            Gate {
                executor,
                live,
                mut started,
                release,
                runtime: _runtime,
            },
            grant,
            scope,
            operation,
        ) = gate(false);
        let caller = std::thread::current().id();
        let observe = async {
            let worker = started.recv().await.unwrap();
            // The read is now synchronously blocked inside the query runtime. The
            // caller's only thread can still run other tasks and timers.
            assert_ne!(worker, caller, "read must not run on the caller's thread");
            assert_eq!(tokio::spawn(async { 7 }).await.unwrap(), 7);
            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
            release.send(()).unwrap();
        };
        let (result, ()) = tokio::join!(
            executor.execute(&grant, &scope, &operation, CancellationToken::new()),
            observe
        );
        assert_eq!(result.unwrap()["rowCount"], 2);
        assert_eq!(live.load(Ordering::SeqCst), 0);
    }
    #[tokio::test]
    async fn timeout_yields_typed_timeout_and_drops_the_blocked_source() {
        let (
            Gate {
                executor,
                live,
                mut started,
                release,
                runtime,
            },
            grant,
            scope,
            operation,
        ) = gate(true);
        // Injected short deadline; production keeps READ_DEADLINE. The source
        // blocks until released, so the deadline has always elapsed by then.
        let mut executor = executor;
        executor.deadline = std::time::Duration::from_millis(1);
        let release = async {
            started.recv().await.unwrap();
            release.send(()).unwrap();
        };
        let (result, ()) = tokio::join!(
            executor.execute(&grant, &scope, &operation, CancellationToken::new()),
            release
        );
        assert_eq!(result, Err(ToolError::Timeout));
        // The timeout fires inside the task, so the source is gone before it returns.
        assert_eq!(live.load(Ordering::SeqCst), 0);
        eventually("timed-out read must not leave a query task", || {
            runtime.alive_tasks() == 0
        })
        .await;
    }
    #[tokio::test]
    async fn explicit_cancellation_drops_the_nested_source_before_returning() {
        let (
            Gate {
                executor,
                live,
                mut started,
                release,
                runtime,
            },
            grant,
            scope,
            operation,
        ) = gate(true);
        let token = CancellationToken::new();
        let cancel = async {
            started.recv().await.unwrap();
            release.send(()).unwrap();
            token.cancel();
        };
        let (result, ()) = tokio::join!(
            executor.execute(&grant, &scope, &operation, token.clone()),
            cancel
        );
        assert_eq!(result, Err(ToolError::Cancelled));
        // execute awaits the abort, so the nested future is already dropped.
        assert_eq!(live.load(Ordering::SeqCst), 0);
        eventually("cancelled read must not leave a query task", || {
            runtime.alive_tasks() == 0
        })
        .await;
    }
    #[tokio::test]
    async fn dropping_execution_future_aborts_the_blocked_source() {
        let (
            Gate {
                executor,
                live,
                mut started,
                release,
                runtime,
            },
            grant,
            scope,
            operation,
        ) = gate(true);
        let mut execution =
            Box::pin(executor.execute(&grant, &scope, &operation, CancellationToken::new()));
        tokio::select! {
            result = &mut execution => panic!("pending read completed: {result:?}"),
            worker = started.recv() => { worker.unwrap(); }
        }
        release.send(()).unwrap();
        drop(execution);
        eventually("dropped execution must drop the nested source", || {
            live.load(Ordering::SeqCst) == 0
        })
        .await;
        eventually("dropped execution must abort its query task", || {
            runtime.alive_tasks() == 0
        })
        .await;
    }

    /// Probes the native manifest decode path from inside the spawned read.
    struct BudgetProbe {
        manifest: bytes::Bytes,
        budgeted: std::sync::Mutex<Option<bool>>,
    }
    #[async_trait]
    impl SourceResolver for BudgetProbe {
        async fn prepare(&self, _: &Principal, _: &ScopeVersion) -> Result<(), ToolError> {
            let decoded =
                crate::catalog::manifest::decode_manifest_blocking(self.manifest.clone()).await;
            *self.budgeted.lock().unwrap() = Some(matches!(
                decoded,
                Err(crate::catalog::manifest::ManifestCodecError::BudgetExceeded)
            ));
            Err(ToolError::Unavailable)
        }
        async fn resolve(&self, _: &Principal, _: &str) -> Result<ResolvedSource, ToolError> {
            Err(ToolError::Unavailable)
        }
        fn context(&self) -> Result<SessionContext, ToolError> {
            Err(ToolError::Unavailable)
        }
    }
    #[tokio::test]
    async fn native_manifest_budget_is_established_inside_the_spawned_read() {
        // A valid plain manifest one byte over the compressed-input budget.
        let body = br#"{"version":"v1","files":[]}"#;
        let mut manifest = vec![b' '; MANIFEST_COMPRESSED_BYTES + 1 - body.len()];
        manifest.extend_from_slice(body);
        let manifest = bytes::Bytes::from(manifest);
        // Without a budget in scope (the classic path) the same bytes decode.
        assert!(
            crate::catalog::manifest::decode_manifest_blocking(manifest.clone())
                .await
                .is_ok()
        );
        let probe = Arc::new(BudgetProbe {
            manifest,
            budgeted: std::sync::Mutex::new(None),
        });
        let runtime = TestQueryRuntime::new();
        let executor = executor_on(probe.clone(), runtime.handle());
        let (_, grant, scope, operation, _) = fixture(memory_source());
        assert_eq!(
            executor
                .execute(&grant, &scope, &operation, CancellationToken::new())
                .await,
            Err(ToolError::Unavailable)
        );
        assert_eq!(
            *probe.budgeted.lock().unwrap(),
            Some(true),
            "the spawned read must decode under the Keystone manifest budget"
        );
    }
    /// Resolves to a real native `StandardTableProvider`.
    struct NativeSource {
        principal: Principal,
        provider: Arc<dyn TableProvider>,
    }
    #[async_trait]
    impl SourceResolver for NativeSource {
        async fn resolve(&self, _: &Principal, dataset: &str) -> Result<ResolvedSource, ToolError> {
            Ok(ResolvedSource {
                principal: self.principal.clone(),
                dataset: dataset.into(),
                time_column: crate::event::DEFAULT_TIMESTAMP_KEY.into(),
                provider: self.provider.clone(),
            })
        }
        fn context(&self) -> Result<SessionContext, ToolError> {
            Ok(context_with_runtime(Arc::new(
                RuntimeEnvBuilder::new()
                    .with_memory_limit(QUERY_MEMORY_BYTES, 1.0)
                    .with_max_temp_directory_size(0)
                    .build()
                    .unwrap(),
            )))
        }
    }
    #[tokio::test]
    async fn native_scan_planning_decodes_manifests_under_the_spawned_read_budget() {
        use crate::{
            catalog::snapshot::ManifestItem,
            metastore::{
                metastore_traits::Metastore,
                metastores::object_store_metastore::ObjectStoreMetastore,
            },
            storage::{LocalFS, ObjectStoreFormat},
        };
        let directory = tempfile::tempdir().unwrap();
        let storage = Arc::new(LocalFS::new(directory.path().to_owned()));
        let metastore = Arc::new(ObjectStoreMetastore {
            storage: storage.clone(),
        });
        let body = br#"{"version":"v1","files":[]}"#;
        // Valid plain manifests: one within, one a byte over the compressed budget.
        let mut oversized = vec![b' '; MANIFEST_COMPRESSED_BYTES + 1 - body.len()];
        oversized.extend_from_slice(body);
        let start = chrono::DateTime::parse_from_rfc3339("2026-09-01T00:00:00Z")
            .unwrap()
            .with_timezone(&chrono::Utc);
        let end = start + chrono::TimeDelta::days(1);
        let (_, grant, scope, operation, _) = fixture(memory_source());
        let runtime = TestQueryRuntime::new();
        let schema = Arc::new(Schema::new(vec![Field::new(
            crate::event::DEFAULT_TIMESTAMP_KEY,
            DataType::Timestamp(TimeUnit::Millisecond, None),
            false,
        )]));
        let mut results = Vec::new();
        for (name, bytes) in [
            ("within.json", body.to_vec()),
            ("oversized.json", oversized),
        ] {
            let path = format!("logs/date=2026-09-01/{name}");
            let absolute = directory.path().join(&path);
            std::fs::create_dir_all(absolute.parent().unwrap()).unwrap();
            std::fs::write(absolute, bytes).unwrap();
            let mut metadata = ObjectStoreFormat::default();
            metadata.snapshot.manifest_list = vec![ManifestItem {
                manifest_path: path,
                time_lower_bound: start,
                time_upper_bound: end,
                events_ingested: 0,
                ingestion_size: 0,
                storage_size: 0,
            }];
            let provider = crate::query::stream_schema_provider::native_read_only_table(
                schema.clone(),
                "logs".into(),
                None,
                metadata,
                storage.clone(),
                metastore.clone(),
                true,
            );
            let executor = executor_on(
                Arc::new(NativeSource {
                    principal: grant.principal.clone(),
                    provider,
                }),
                runtime.handle(),
            );
            results.push(
                executor
                    .execute(&grant, &scope, &operation, CancellationToken::new())
                    .await,
            );
        }
        // The same planning path succeeds within the budget, so the failure is the
        // budget: the manifest is fetched and decoded during the scan's planning.
        assert_eq!(results[0].as_ref().unwrap()["rowCount"], 0);
        assert_eq!(results[1], Err(ToolError::Execution));
        // Without the spawned read's budget in scope, the classic path decodes it.
        assert!(
            metastore
                .get_manifest(
                    "logs",
                    start,
                    end,
                    Some("logs/date=2026-09-01/oversized.json".into()),
                    &None,
                )
                .await
                .unwrap()
                .is_some()
        );
    }
    #[test]
    fn datafusion_pool_rejects_over_budget_reservations_and_output_writer_is_bounded() {
        use datafusion::execution::memory_pool::MemoryConsumer;
        let runtime = RuntimeEnvBuilder::new()
            .with_memory_limit(QUERY_MEMORY_BYTES, 1.0)
            .build()
            .unwrap();
        let reservation =
            MemoryConsumer::new("Keystone budget test").register(&runtime.memory_pool);
        assert!(reservation.try_grow(QUERY_MEMORY_BYTES + 1).is_err());
        assert_eq!(runtime.memory_pool.reserved(), 0);
        let mut output = LimitedOutput(vec![0; OUTPUT_BYTES]);
        assert!(output.write_all(b"x").is_err());
        assert_eq!(output.0.len(), OUTPUT_BYTES);
    }
}
