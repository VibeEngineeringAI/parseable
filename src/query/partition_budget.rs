// SPDX-License-Identifier: AGPL-3.0-or-later
//! Opt-in, planning-time parallelism tuning. This is not admission control:
//! existing queries retain their plans and the sum can exceed the budget.

use std::{
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    task::{Context, Poll},
};

use arrow_schema::SchemaRef;
use datafusion::{
    execution::{RecordBatchStream, SendableRecordBatchStream},
    prelude::SessionContext,
};
use futures::Stream;

use crate::metrics::{PARTITION_BUDGET_METRICS, PartitionBudgetMetrics};

pub(super) struct PartitionBudget {
    budget: Option<u64>,
    floor: u64,
    active: Arc<AtomicUsize>,
    metrics: PartitionBudgetMetrics,
}

impl PartitionBudget {
    pub(super) fn new(budget: Option<u64>, floor: u64) -> Self {
        Self {
            budget,
            floor,
            active: Arc::default(),
            metrics: PARTITION_BUDGET_METRICS.clone(),
        }
    }

    fn enter(&self, ceiling: usize) -> (usize, Option<Arc<QueryLease>>) {
        let Some(budget) = self.budget else {
            return (ceiling, None);
        };
        let active = self.active.fetch_add(1, Ordering::Relaxed) + 1;
        self.metrics.active.inc();
        let lease = Arc::new(QueryLease(Arc::clone(&self.active), self.metrics.clone()));
        let target = (budget / active as u64)
            .max(self.floor)
            .max(1)
            .min(ceiling as u64) as usize;
        self.metrics.target.observe(target as f64);
        tracing::debug!(
            active_queries = active,
            target_partitions = target,
            partition_ceiling = ceiling,
            partition_budget = budget,
            "query partition budget"
        );
        (target, Some(lease))
    }
}

/// Last owner releases the query, including error, timeout and abort paths.
/// Streaming workers and their receiver share ownership so neither detached
/// work nor a buffered result can prematurely disappear from the load count.
pub(super) struct QueryLease(Arc<AtomicUsize>, PartitionBudgetMetrics);

impl Drop for QueryLease {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Relaxed);
        self.1.active.dec();
    }
}

pub(super) fn query_context(
    shared: SessionContext,
    budget: &PartitionBudget,
) -> (SessionContext, Option<Arc<QueryLease>>) {
    if budget.budget.is_none() {
        return (shared, None);
    }
    // SessionState is cloned, not rebuilt: retain tenant catalogs, UDFs, custom
    // optimizer rules, extensions and the same RuntimeEnv (memory pool, stores,
    // disk manager and metadata cache). ConfigOptions uses copy-on-write.
    let mut state = shared.state();
    let (target, lease) = budget.enter(state.config().target_partitions());
    state.config_mut().options_mut().execution.target_partitions = target;
    (SessionContext::new_with_state(state), lease)
}

pub(super) struct LeasedQueryStream {
    inner: SendableRecordBatchStream,
    _lease: Option<Arc<QueryLease>>,
}

impl LeasedQueryStream {
    pub(super) fn new(inner: SendableRecordBatchStream, lease: Option<Arc<QueryLease>>) -> Self {
        Self {
            inner,
            _lease: lease,
        }
    }
}

impl Stream for LeasedQueryStream {
    type Item = datafusion::error::Result<datafusion::arrow::record_batch::RecordBatch>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let next = self.inner.as_mut().poll_next(cx);
        if matches!(next, Poll::Ready(None) | Poll::Ready(Some(Err(_)))) {
            self._lease.take();
        }
        next
    }
}

impl RecordBatchStream for LeasedQueryStream {
    fn schema(&self) -> SchemaRef {
        self.inner.schema()
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod metrics_tests {
    use super::*;

    fn isolated(budget: Option<u64>) -> PartitionBudget {
        let mut budget = PartitionBudget::new(budget, 1);
        budget.metrics = PartitionBudgetMetrics::new();
        budget
    }

    #[test]
    fn partition_budget_metrics_leases_and_targets() {
        let budget = isolated(Some(32));
        let (_, first) = budget.enter(64);
        let (_, second) = budget.enter(64);
        assert_eq!(budget.metrics.active.get(), 2);
        assert_eq!(budget.metrics.target.get_sample_count(), 2);
        assert_eq!(budget.metrics.target.get_sample_sum(), 48.0);
        let shared = first.clone();
        drop(first);
        assert_eq!(budget.metrics.active.get(), 2);
        drop(shared);
        assert_eq!(budget.metrics.active.get(), 1);
        drop(second);
        assert_eq!(budget.metrics.active.get(), 0);
        fn fail(budget: &PartitionBudget) -> Result<(), &'static str> {
            let _lease = budget.enter(64).1;
            assert_eq!(budget.metrics.active.get(), 1);
            Err("planning error")
        }
        assert!(fail(&budget).is_err());
        assert_eq!(budget.metrics.active.get(), 0);
        assert_eq!(budget.metrics.target.get_sample_count(), 3);
    }

    #[tokio::test]
    async fn partition_budget_metrics_timeout_and_abort() {
        let budget = Arc::new(isolated(Some(32)));
        let result = tokio::time::timeout(std::time::Duration::from_millis(1), async {
            let _lease = budget.enter(64).1;
            std::future::pending::<()>().await;
        })
        .await;
        assert!(result.is_err());
        assert_eq!(budget.metrics.active.get(), 0);
        let (tx, rx) = tokio::sync::oneshot::channel();
        let task_budget = budget.clone();
        let task = tokio::spawn(async move {
            let _lease = task_budget.enter(64).1;
            tx.send(()).unwrap();
            std::future::pending::<()>().await;
        });
        rx.await.unwrap();
        assert_eq!(budget.metrics.active.get(), 1);
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert_eq!(budget.metrics.active.get(), 0);
    }

    #[tokio::test]
    async fn partition_budget_metrics_stream_error_and_early_drop() {
        use datafusion::physical_plan::stream::RecordBatchStreamAdapter;
        use futures::StreamExt;

        let budget = isolated(Some(32));
        let stream = RecordBatchStreamAdapter::new(
            Arc::new(arrow_schema::Schema::empty()),
            futures::stream::once(async {
                Err(datafusion::error::DataFusionError::Execution(
                    "stream error".into(),
                ))
            }),
        );
        let mut stream = LeasedQueryStream::new(Box::pin(stream), budget.enter(64).1);
        assert_eq!(budget.metrics.active.get(), 1);
        assert!(stream.next().await.unwrap().is_err());
        assert_eq!(budget.metrics.active.get(), 0);
        drop(stream);
        assert_eq!(budget.metrics.active.get(), 0);

        let stream = RecordBatchStreamAdapter::new(
            Arc::new(arrow_schema::Schema::empty()),
            futures::stream::pending(),
        );
        let stream = LeasedQueryStream::new(Box::pin(stream), budget.enter(64).1);
        assert_eq!(budget.metrics.active.get(), 1);
        drop(stream);
        assert_eq!(budget.metrics.active.get(), 0);
    }

    #[test]
    fn partition_budget_metrics_unset_records_nothing() {
        let budget = isolated(None);
        for _ in 0..3 {
            let (target, lease) = budget.enter(37);
            assert_eq!(target, 37);
            assert!(lease.is_none());
        }
        assert_eq!(budget.metrics.active.get(), 0);
        assert_eq!(budget.metrics.target.get_sample_count(), 0);
        assert_eq!(budget.metrics.target.get_sample_sum(), 0.0);
    }
}
