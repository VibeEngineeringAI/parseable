//! Per-stream refresh batching without a freshness interval. Only requests
//! registered before a fetch starts may share its result. Requests arriving
//! during that fetch form the next batch, so a later query never inherits an
//! older listing than its own independent reload could have observed.

use std::sync::atomic::{AtomicU64, Ordering};

use tokio::sync::Mutex;

use crate::option::Mode;

#[derive(Default)]
pub(super) struct SchemaRefresh {
    requests: AtomicU64,
    completed: Mutex<Option<(u64, Result<(), String>)>>,
}

// Preserve Stream's public unwind-safety contract. The lock and cached result
// never escape this type. Unwinding/cancellation drops the guard without
// installing a result; monotonically increasing request IDs force a retry.
impl std::panic::UnwindSafe for SchemaRefresh {}
impl std::panic::RefUnwindSafe for SchemaRefresh {}

impl SchemaRefresh {
    pub(super) async fn run<F, Fut>(&self, mode: Mode, refresh: F) -> anyhow::Result<()>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = anyhow::Result<()>>,
    {
        // Staged schema uploads also update memory in standalone mode. Keep
        // distributed modes fresh, including Ingest/Index conservatively.
        if mode == Mode::All {
            return Ok(());
        }
        let request = self.requests.fetch_add(1, Ordering::SeqCst) + 1;
        let mut completed = self.completed.lock().await;
        if let Some((covered, result)) = &*completed
            && *covered >= request
        {
            return result.clone().map_err(anyhow::Error::msg);
        }

        // Let runnable callers register before starting this batch's listing.
        tokio::task::yield_now().await;
        let covered = self.requests.load(Ordering::SeqCst);
        let result = refresh().await.map_err(|error| format!("{error:#}"));
        *completed = Some((covered, result.clone()));
        result.map_err(anyhow::Error::msg)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, atomic::AtomicUsize};

    use super::*;

    #[tokio::test]
    async fn resident_all_mode_does_no_storage_work() {
        SchemaRefresh::default()
            .run(Mode::All, || async {
                panic!("resident All reload accessed storage")
            })
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn concurrent_refreshes_coalesce_without_reusing_an_older_fetch() {
        let refresh = Arc::new(SchemaRefresh::default());
        let calls = Arc::new(AtomicUsize::new(0));
        let (started, start_rx) = tokio::sync::oneshot::channel();
        let (finish, finish_rx) = tokio::sync::oneshot::channel();
        let first = {
            let refresh = refresh.clone();
            let calls = calls.clone();
            tokio::spawn(async move {
                refresh
                    .run(Mode::Query, || async {
                        calls.fetch_add(1, Ordering::SeqCst);
                        started.send(()).unwrap();
                        finish_rx.await.unwrap();
                        Ok(())
                    })
                    .await
                    .unwrap();
            })
        };
        start_rx.await.unwrap();
        let mut waiters = Vec::new();
        for _ in 0..20 {
            let refresh = refresh.clone();
            let calls = calls.clone();
            waiters.push(tokio::spawn(async move {
                refresh
                    .run(Mode::Query, || async {
                        calls.fetch_add(1, Ordering::SeqCst);
                        Ok(())
                    })
                    .await
                    .unwrap();
            }));
        }
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            while refresh.requests.load(Ordering::SeqCst) < 21 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        finish.send(()).unwrap();
        first.await.unwrap();
        for waiter in waiters {
            waiter.await.unwrap();
        }
        // The late arrivals require one newer fetch, shared by their batch.
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        refresh
            .run(Mode::Prism, || async {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
            .await
            .unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn panicked_and_cancelled_refreshes_allow_retry() {
        let refresh = Arc::new(SchemaRefresh::default());
        let panicked = {
            let refresh = refresh.clone();
            tokio::spawn(async move {
                refresh
                    .run(Mode::Query, || async { panic!("refresh panicked") })
                    .await
            })
        };
        assert!(panicked.await.unwrap_err().is_panic());
        refresh.run(Mode::Query, || async { Ok(()) }).await.unwrap();

        let (started, start_rx) = tokio::sync::oneshot::channel();
        let cancelled = {
            let refresh = refresh.clone();
            tokio::spawn(async move {
                refresh
                    .run(Mode::Query, || async {
                        started.send(()).unwrap();
                        std::future::pending::<()>().await;
                        Ok(())
                    })
                    .await
            })
        };
        start_rx.await.unwrap();
        cancelled.abort();
        assert!(cancelled.await.unwrap_err().is_cancelled());
        tokio::time::timeout(
            std::time::Duration::from_secs(10),
            refresh.run(Mode::Query, || async { Ok(()) }),
        )
        .await
        .unwrap()
        .unwrap();
    }

    #[tokio::test]
    async fn failed_refresh_is_retried_by_the_next_query() {
        let refresh = SchemaRefresh::default();
        assert!(
            refresh
                .run(Mode::Query, || async { anyhow::bail!("unavailable") })
                .await
                .is_err()
        );
        refresh.run(Mode::Query, || async { Ok(()) }).await.unwrap();
    }
}
