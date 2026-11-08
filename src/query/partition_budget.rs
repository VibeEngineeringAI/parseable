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

pub(super) struct PartitionBudget {
    budget: Option<u64>,
    floor: u64,
    active: Arc<AtomicUsize>,
}

impl PartitionBudget {
    pub(super) fn new(budget: Option<u64>, floor: u64) -> Self {
        Self {
            budget,
            floor,
            active: Arc::default(),
        }
    }

    fn enter(&self, ceiling: usize) -> (usize, Option<Arc<QueryLease>>) {
        let Some(budget) = self.budget else {
            return (ceiling, None);
        };
        let active = self.active.fetch_add(1, Ordering::Relaxed) + 1;
        let lease = Arc::new(QueryLease(Arc::clone(&self.active)));
        let target = (budget / active as u64)
            .max(self.floor)
            .max(1)
            .min(ceiling as u64) as usize;
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
pub(super) struct QueryLease(Arc<AtomicUsize>);

impl Drop for QueryLease {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Relaxed);
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
