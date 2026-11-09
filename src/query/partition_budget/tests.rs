// SPDX-License-Identifier: AGPL-3.0-or-later
use super::*;
use std::time::Duration;

use arrow_array::{Int64Array, RecordBatch, TimestampMillisecondArray};
use arrow_schema::{DataType, Field, Schema, TimeUnit};
use datafusion::{
    catalog::MemorySchemaProvider,
    common::config::ConfigOptions,
    datasource::MemTable,
    execution::{SessionStateBuilder, runtime_env::RuntimeEnvBuilder},
    logical_expr::{Volatility, create_udf},
    physical_optimizer::PhysicalOptimizerRule,
    physical_plan::{ExecutionPlan, stream::RecordBatchStreamAdapter},
    prelude::SessionConfig,
};
use futures::StreamExt;

#[test]
fn defaults_ceiling_floor_and_load_snapshot() {
    let off = PartitionBudget::new(None, 1);
    assert_eq!(off.enter(37).0, 37); // explicit overrides survive
    assert!(off.enter(37).1.is_none());
    assert_eq!(off.active.load(Ordering::Relaxed), 0);

    let budget = PartitionBudget::new(Some(32), 8);
    let mut leases = Vec::new();
    for expected in [32, 16, 10, 8, 8, 8, 8, 8] {
        let (target, lease) = budget.enter(37);
        assert_eq!(target, expected);
        leases.push(lease);
    }
    assert_eq!(budget.active.load(Ordering::Relaxed), 8);
    leases.clear();
    assert_eq!(budget.active.load(Ordering::Relaxed), 0);
    assert_eq!(budget.enter(3).0, 3); // floor never defeats the override
    assert_eq!(PartitionBudget::new(Some(1), 1).enter(37).0, 1);
    assert_eq!(PartitionBudget::new(Some(u64::MAX), 1).enter(37).0, 37);
}

#[tokio::test]
async fn timeout_failure_and_caller_abort_release_load() {
    let budget = Arc::new(PartitionBudget::new(Some(32), 1));
    let result: Result<(), &str> = async {
        let _lease = budget.enter(32).1;
        Err("planning failure")
    }
    .await;
    assert!(result.is_err());
    assert_eq!(budget.active.load(Ordering::Relaxed), 0);
    let timed_out = tokio::time::timeout(Duration::from_millis(1), async {
        let _lease = budget.enter(32).1;
        std::future::pending::<()>().await;
    })
    .await;
    assert!(timed_out.is_err());
    assert_eq!(budget.active.load(Ordering::Relaxed), 0);

    let (tx, rx) = tokio::sync::oneshot::channel();
    let worker_budget = budget.clone();
    let task = tokio::spawn(async move {
        let _lease = worker_budget.enter(32).1;
        tx.send(()).unwrap();
        std::future::pending::<()>().await;
    });
    rx.await.unwrap();
    drop(crate::query::AbortQueryOnDrop(task));
    tokio::time::timeout(Duration::from_secs(1), async {
        while budget.active.load(Ordering::Relaxed) != 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn streaming_completion_error_and_early_drop_release_load() {
    let budget = PartitionBudget::new(Some(32), 1);
    for fail in [false, true] {
        let inner = RecordBatchStreamAdapter::new(
            Arc::new(Schema::empty()),
            futures::stream::iter(if fail {
                vec![Err(datafusion::error::DataFusionError::Execution(
                    "test error".into(),
                ))]
            } else {
                vec![]
            }),
        );
        let mut stream = LeasedQueryStream::new(Box::pin(inner), budget.enter(32).1);
        assert_eq!(budget.active.load(Ordering::Relaxed), 1);
        let result = stream.next().await;
        assert_eq!(result.is_some(), fail);
        assert_eq!(budget.active.load(Ordering::Relaxed), 0);
    }

    let lease = budget.enter(32).1;
    let worker_lease = lease.clone();
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let worker = tokio::spawn(async move {
        let _worker_lease = worker_lease;
        let inner =
            RecordBatchStreamAdapter::new(Arc::new(Schema::empty()), futures::stream::pending());
        started_tx.send(()).unwrap();
        crate::query::forward_partition_batches(Box::pin(inner), tx).await;
    });
    let inner = RecordBatchStreamAdapter::new(
        Arc::new(Schema::empty()),
        tokio_stream::wrappers::UnboundedReceiverStream::new(rx),
    );
    let stream = LeasedQueryStream::new(Box::pin(inner), lease);
    started_rx.await.unwrap();
    assert_eq!(budget.active.load(Ordering::Relaxed), 1);
    drop(stream); // closes the receiver and stops the pending worker
    tokio::time::timeout(Duration::from_secs(1), worker)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(budget.active.load(Ordering::Relaxed), 0);
}

#[derive(Debug)]
struct Hook;
impl PhysicalOptimizerRule for Hook {
    fn optimize(
        &self,
        plan: Arc<dyn ExecutionPlan>,
        _: &ConfigOptions,
    ) -> datafusion::error::Result<Arc<dyn ExecutionPlan>> {
        Ok(plan)
    }
    fn name(&self) -> &str {
        "partition-budget-test-hook"
    }
    fn schema_check(&self) -> bool {
        true
    }
}

#[tokio::test]
async fn isolated_config_keeps_runtime_catalogs_udfs_hooks_and_tenant_values() {
    #[derive(Debug)]
    struct PluginState;
    let plugin_state = Arc::new(PluginState);
    let runtime = Arc::new(
        RuntimeEnvBuilder::new()
            .with_memory_limit(64 * 1024 * 1024, 1.0)
            .build()
            .unwrap(),
    );
    let state = SessionStateBuilder::new()
        .with_default_features()
        .with_config(
            SessionConfig::new()
                .with_target_partitions(32)
                .with_batch_size(2)
                .with_extension(plugin_state.clone()),
        )
        .with_runtime_env(runtime.clone())
        .with_physical_optimizer_rule(Arc::new(Hook))
        .build();
    let shared = SessionContext::new_with_state(state);
    shared.register_udf(create_udf(
        "my_identity",
        vec![DataType::Int64],
        DataType::Int64,
        Volatility::Immutable,
        Arc::new(|args| Ok(args[0].clone())),
    ));
    let catalog = shared.catalog("datafusion").unwrap();
    for (tenant, offset) in [("alpha", 0), ("beta", 100)] {
        let schema_provider = Arc::new(MemorySchemaProvider::new());
        catalog
            .register_schema(tenant, schema_provider.clone())
            .unwrap();
        let batch = RecordBatch::try_new(
            Arc::new(Schema::new(vec![
                Field::new("id", DataType::Int64, false),
                Field::new("ts", DataType::Timestamp(TimeUnit::Millisecond, None), true),
                Field::new("g", DataType::Int64, true),
            ])),
            vec![
                Arc::new(Int64Array::from(
                    (0..8).map(|x| x + offset).collect::<Vec<_>>(),
                )),
                Arc::new(TimestampMillisecondArray::from(vec![
                    Some(0),
                    Some(1),
                    None,
                    Some(3),
                    Some(4),
                    Some(5),
                    Some(6),
                    Some(7),
                ])),
                Arc::new(Int64Array::from(vec![
                    Some(0),
                    Some(1),
                    Some(0),
                    None,
                    Some(0),
                    Some(1),
                    Some(0),
                    None,
                ])),
            ],
        )
        .unwrap();
        use datafusion::catalog::SchemaProvider;
        schema_provider
            .register_table(
                "logs".into(),
                Arc::new(
                    MemTable::try_new(
                        batch.schema(),
                        vec![vec![batch.clone()], vec![batch.slice(0, 0)]],
                    )
                    .unwrap(),
                ),
            )
            .unwrap();
    }
    let budget = PartitionBudget::new(Some(16), 2);
    let mut work = Vec::new();
    for n in 0..8 {
        let (ctx, lease) = query_context(shared.clone(), &budget);
        let state = ctx.state();
        assert_eq!(state.config().target_partitions(), (16 / (n + 1)).max(2));
        assert!(Arc::ptr_eq(state.runtime_env(), &runtime));
        assert!(Arc::ptr_eq(
            &state.runtime_env().memory_pool,
            &runtime.memory_pool
        ));
        assert!(Arc::ptr_eq(
            &state.runtime_env().cache_manager,
            &runtime.cache_manager
        ));
        assert!(Arc::ptr_eq(
            &state.config().get_extension::<PluginState>().unwrap(),
            &plugin_state
        ));
        assert!(Arc::ptr_eq(
            state.catalog_list(),
            shared.state().catalog_list()
        ));
        assert!(state.scalar_functions().contains_key("my_identity"));
        assert!(
            state
                .physical_optimizers()
                .iter()
                .any(|rule| rule.name() == "partition-budget-test-hook")
        );
        assert_eq!(shared.state().config().target_partitions(), 32);
        let (tenant, offset) = if n % 2 == 0 {
            ("alpha", 0)
        } else {
            ("beta", 100)
        };
        work.push(async move {
            let _lease = lease;
            // Expected IDs are an independent fixture oracle, including null time,
            // a half-open time window and an offset cutting deterministic ties.
            let sql = format!("SELECT my_identity(id) AS id FROM {tenant}.logs WHERE ts >= TIMESTAMP '1970-01-01T00:00:00.001' AND ts < TIMESTAMP '1970-01-01T00:00:00.007' ORDER BY g ASC NULLS LAST, id ASC LIMIT 3 OFFSET 1");
            let batches = ctx.sql(&sql).await.unwrap().collect().await.unwrap();
            let ids: Vec<_> = batches.iter().flat_map(|b| b.column(0).as_any().downcast_ref::<Int64Array>().unwrap().values().to_vec()).collect();
            assert_eq!(ids, [6 + offset, 1 + offset, 5 + offset]);
            let groups = ctx.sql(&format!("SELECT g, COUNT(*) AS n FROM {tenant}.logs WHERE ts IS NOT NULL GROUP BY g ORDER BY g NULLS LAST")).await.unwrap().collect().await.unwrap();
            let counts: Vec<_> = groups.iter().flat_map(|b| b.column(1).as_any().downcast_ref::<Int64Array>().unwrap().values().to_vec()).collect();
            assert_eq!(counts, [3, 2, 2]);
        });
    }
    futures::future::join_all(work).await;
    assert_eq!(budget.active.load(Ordering::Relaxed), 0);
}

#[tokio::test]
async fn execution_context_counts_collection_and_planning_errors() {
    let shared = SessionContext::new_with_config(SessionConfig::new().with_target_partitions(32));
    let budget = PartitionBudget::new(Some(16), 1);
    let (ctx, lease) = query_context(shared.clone(), &budget);
    assert_eq!(budget.active.load(Ordering::Relaxed), 1);
    assert_eq!(ctx.state().config().target_partitions(), 16);
    let batches = ctx
        .sql("SELECT 42 AS answer")
        .await
        .unwrap()
        .collect()
        .await
        .unwrap();
    assert_eq!(batches[0].num_rows(), 1);
    // Collection is complete, but the owning execution scope still holds its lease.
    assert_eq!(budget.active.load(Ordering::Relaxed), 1);
    drop(lease);
    assert_eq!(budget.active.load(Ordering::Relaxed), 0);

    let failed: datafusion::error::Result<()> = async {
        let (ctx, _lease) = query_context(shared, &budget);
        assert_eq!(budget.active.load(Ordering::Relaxed), 1);
        ctx.sql("SELECT * FROM missing_budget_test_table").await?;
        Ok(())
    }
    .await;
    assert!(failed.is_err());
    assert_eq!(budget.active.load(Ordering::Relaxed), 0);
}

#[tokio::test]
async fn unset_context_is_shared_and_lazy_planning_does_not_enter_budget() {
    let shared = SessionContext::new_with_config(SessionConfig::new().with_target_partitions(37));
    let off = PartitionBudget::new(None, 1);
    let (ctx, lease) = query_context(shared.clone(), &off);
    assert!(lease.is_none());
    assert_eq!(ctx.state().config().target_partitions(), 37);
    // Register after obtaining the context: a cloned SessionState would not see
    // this new UDF. The unset path must return the original shared session.
    shared.register_udf(create_udf(
        "registered_after_context",
        vec![DataType::Int64],
        DataType::Int64,
        Volatility::Immutable,
        Arc::new(|args| Ok(args[0].clone())),
    ));
    let frame = ctx
        .sql("SELECT registered_after_context(42)")
        .await
        .unwrap();
    assert_eq!(off.active.load(Ordering::Relaxed), 0);
    assert_eq!(frame.collect().await.unwrap()[0].num_rows(), 1);
    assert_eq!(off.active.load(Ordering::Relaxed), 0);

    let enabled = PartitionBudget::new(Some(16), 1);
    // Mirrors the HTTP/alert/Flight logical-planning contexts: no execution
    // context, no lease, and no change to the shared target.
    shared
        .state()
        .create_logical_plan("SELECT 1")
        .await
        .unwrap();
    assert_eq!(enabled.active.load(Ordering::Relaxed), 0);
    assert_eq!(shared.state().config().target_partitions(), 37);
}
