//! Owned, read-only tool boundary. No HTTP request, session key, SQL or graph is accepted.
//!
//! Live execution uses a tenant-bound DataFusion source and separate engine memory pool.
//! Output bounds are not scan budgets or bounds on every storage-planning allocation.
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use super::domain::{Principal, ScopeVersion};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunGrant {
    pub principal: Principal,
    /// An opaque credential identifier, never a password, API key or SessionKey.
    pub credential_id: String,
    pub expires_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub enum ReadOperation {
    Schema {
        dataset: String,
    },
    Sample {
        dataset: String,
        start: String,
        end: String,
        rows: u16,
    },
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ToolError {
    #[error("execution capability is unavailable")]
    Unavailable,
    #[error("authorization is no longer valid")]
    Unauthorized,
    #[error("operation exceeds the approved scope")]
    Scope,
    #[error("operation cancelled")]
    Cancelled,
    #[error("operation timed out")]
    Timeout,
    #[error("query execution failed")]
    Execution,
    #[error("operation output exceeded its bound")]
    OutputLimit,
}

/// Implementations must revalidate identity, credential validity/expiry, roles and
/// exact dataset access on EVERY call. A copied session permission list is insufficient.
pub trait GrantAuthorizer: Send + Sync {
    fn authorize(&self, grant: &RunGrant, scope: &ScopeVersion) -> Result<(), ToolError>;
}

#[async_trait]
pub trait ReadExecutor: Send + Sync {
    /// Dropping this future must release all nested work. Never detach a query task.
    async fn execute(
        &self,
        grant: &RunGrant,
        scope: &ScopeVersion,
        operation: &ReadOperation,
        cancel: CancellationToken,
    ) -> Result<serde_json::Value, ToolError>;
}

pub struct UnavailableExecutor;
#[async_trait]
impl ReadExecutor for UnavailableExecutor {
    async fn execute(
        &self,
        _: &RunGrant,
        _: &ScopeVersion,
        _: &ReadOperation,
        _: CancellationToken,
    ) -> Result<serde_json::Value, ToolError> {
        Err(ToolError::Unavailable)
    }
}

pub fn validate_operation(
    scope: &ScopeVersion,
    operation: &ReadOperation,
) -> Result<(), ToolError> {
    scope.validate().map_err(|_| ToolError::Scope)?;
    // Untyped saved filters cannot be silently ignored by the read bridge.
    if !scope.filters.is_empty() {
        return Err(ToolError::Scope);
    }
    let dataset = match operation {
        ReadOperation::Schema { dataset } | ReadOperation::Sample { dataset, .. } => dataset,
    };
    // Qualified names, internal streams, external paths and SQL fragments cannot enter.
    if dataset.is_empty()
        || dataset.starts_with('_')
        || !dataset
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        || !scope.datasets.contains(dataset)
    {
        return Err(ToolError::Scope);
    }
    if let ReadOperation::Sample {
        start, end, rows, ..
    } = operation
    {
        let parse = |s: &str| chrono::DateTime::parse_from_rfc3339(s).map_err(|_| ToolError::Scope);
        if *rows == 0
            || *rows > 500
            || parse(start)? < parse(&scope.absolute_start)?
            || parse(end)? > parse(&scope.absolute_end)?
            || parse(start)? >= parse(end)?
        {
            return Err(ToolError::Scope);
        }
    }
    Ok(())
}

pub async fn invoke(
    authorizer: &dyn GrantAuthorizer,
    executor: &dyn ReadExecutor,
    grant: &RunGrant,
    scope: &ScopeVersion,
    operation: &ReadOperation,
    cancel: CancellationToken,
) -> Result<serde_json::Value, ToolError> {
    if cancel.is_cancelled() {
        return Err(ToolError::Cancelled);
    }
    if grant.expires_at <= chrono::Utc::now().timestamp() {
        return Err(ToolError::Unauthorized);
    }
    authorizer.authorize(grant, scope)?;
    validate_operation(scope, operation)?;
    let value = tokio::select! {
        biased;
        _ = cancel.cancelled() => return Err(ToolError::Cancelled),
        result = tokio::time::timeout(std::time::Duration::from_secs(30), executor.execute(grant, scope, operation, cancel.clone())) => {
            result.map_err(|_| ToolError::Timeout)??
        }
    };
    // Revocation racing the query must prevent publication of its result.
    if grant.expires_at <= chrono::Utc::now().timestamp() {
        return Err(ToolError::Unauthorized);
    }
    authorizer.authorize(grant, scope)?;
    if serde_json::to_vec(&value)
        .map_err(|_| ToolError::OutputLimit)?
        .len()
        > 1_048_576
    {
        return Err(ToolError::OutputLimit);
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    };
    struct Auth(Arc<AtomicBool>);
    impl GrantAuthorizer for Auth {
        fn authorize(&self, _: &RunGrant, _: &ScopeVersion) -> Result<(), ToolError> {
            if self.0.load(Ordering::SeqCst) {
                Ok(())
            } else {
                Err(ToolError::Unauthorized)
            }
        }
    }
    struct Pending(Arc<AtomicUsize>);
    struct Guard(Arc<AtomicUsize>);
    impl Drop for Guard {
        fn drop(&mut self) {
            self.0.fetch_sub(1, Ordering::SeqCst);
        }
    }
    #[async_trait]
    impl ReadExecutor for Pending {
        async fn execute(
            &self,
            _: &RunGrant,
            _: &ScopeVersion,
            _: &ReadOperation,
            _: CancellationToken,
        ) -> Result<serde_json::Value, ToolError> {
            self.0.fetch_add(1, Ordering::SeqCst);
            let _guard = Guard(self.0.clone());
            std::future::pending().await
        }
    }
    fn fixtures() -> (RunGrant, ScopeVersion, ReadOperation) {
        let (principal, _, node) = super::super::context::tests::fixture();
        (
            RunGrant {
                principal,
                credential_id: "credential-reference-only".into(),
                expires_at: chrono::Utc::now().timestamp() + 60,
            },
            node.scope,
            ReadOperation::Schema {
                dataset: "logs".into(),
            },
        )
    }
    #[test]
    fn rejects_effects_qualified_names_other_datasets_and_widened_time() {
        let (_, scope, _) = fixtures();
        for dataset in [
            "other",
            "catalog.schema.logs",
            "_internal",
            "logs; DROP TABLE logs",
            "https://example.com/logs",
        ] {
            assert_eq!(
                validate_operation(
                    &scope,
                    &ReadOperation::Schema {
                        dataset: dataset.into()
                    }
                ),
                Err(ToolError::Scope)
            );
        }
        for operation in ["create_alert", "enable_alert", "query", "shell"] {
            assert!(
                serde_json::from_value::<ReadOperation>(serde_json::json!({"operation":operation}))
                    .is_err()
            );
        }
        let sample = |start: &str, end: &str| ReadOperation::Sample {
            dataset: "logs".into(),
            start: start.into(),
            end: end.into(),
            rows: 10,
        };
        assert!(
            validate_operation(
                &scope,
                &sample("2026-09-01T01:00:00+01:00", "2026-10-01T00:00:00Z")
            )
            .is_ok()
        );
        assert_eq!(
            validate_operation(
                &scope,
                &sample("2026-08-31T23:59:59Z", "2026-10-01T00:00:00Z")
            ),
            Err(ToolError::Scope)
        );
        assert_eq!(
            validate_operation(
                &scope,
                &sample("2026-09-01T00:00:00Z", "2026-10-02T00:00:00Z")
            ),
            Err(ToolError::Scope)
        );
    }
    #[tokio::test]
    async fn cancel_drops_nested_query_and_releases_resources() {
        let (grant, scope, operation) = fixtures();
        let live = Arc::new(AtomicUsize::new(0));
        let executor = Pending(live.clone());
        let auth = Auth(Arc::new(AtomicBool::new(true)));
        let token = CancellationToken::new();
        let cancel = token.clone();
        let call = invoke(&auth, &executor, &grant, &scope, &operation, token);
        let stop = async {
            while live.load(Ordering::SeqCst) == 0 {
                tokio::task::yield_now().await;
            }
            cancel.cancel();
        };
        let (result, ()) = tokio::join!(call, stop);
        assert_eq!(result, Err(ToolError::Cancelled));
        assert_eq!(live.load(Ordering::SeqCst), 0);
    }
    #[tokio::test]
    async fn revoked_and_expired_grants_cannot_dispatch() {
        let (mut grant, scope, operation) = fixtures();
        let live = Arc::new(AtomicUsize::new(0));
        let executor = Pending(live.clone());
        let auth = Auth(Arc::new(AtomicBool::new(false)));
        assert_eq!(
            invoke(
                &auth,
                &executor,
                &grant,
                &scope,
                &operation,
                CancellationToken::new()
            )
            .await,
            Err(ToolError::Unauthorized)
        );
        auth.0.store(true, Ordering::SeqCst);
        grant.expires_at = 0;
        assert_eq!(
            invoke(
                &auth,
                &executor,
                &grant,
                &scope,
                &operation,
                CancellationToken::new()
            )
            .await,
            Err(ToolError::Unauthorized)
        );
        assert_eq!(live.load(Ordering::SeqCst), 0);
    }
    #[tokio::test]
    async fn revoked_during_query_result_is_not_published() {
        struct Revoke(Arc<AtomicBool>);
        #[async_trait]
        impl ReadExecutor for Revoke {
            async fn execute(
                &self,
                _: &RunGrant,
                _: &ScopeVersion,
                _: &ReadOperation,
                _: CancellationToken,
            ) -> Result<serde_json::Value, ToolError> {
                self.0.store(false, Ordering::SeqCst);
                Ok(serde_json::json!({"data":"private"}))
            }
        }
        let (grant, scope, operation) = fixtures();
        let allowed = Arc::new(AtomicBool::new(true));
        assert_eq!(
            invoke(
                &Auth(allowed.clone()),
                &Revoke(allowed),
                &grant,
                &scope,
                &operation,
                CancellationToken::new()
            )
            .await,
            Err(ToolError::Unauthorized)
        );
    }
}
