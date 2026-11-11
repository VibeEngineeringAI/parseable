//! Deadline enforcement for every SQL operation, including transactions.
use crate::storage::ObjectStorageError;
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio_postgres::{Row, types::ToSql};

pub(crate) struct Client {
    inner: Option<deadpool_postgres::Client>,
    timeout: Duration,
    poisoned: Arc<AtomicBool>,
    cancel: tokio_postgres::CancelToken,
    tls: tokio_postgres_rustls::MakeRustlsConnect,
}
impl Drop for Client {
    fn drop(&mut self) {
        if self.poisoned.load(Ordering::SeqCst)
            && let Some(c) = self.inner.take()
        {
            drop(deadpool_postgres::Client::take(c));
        }
    }
}
struct Pending<'a>(&'a AtomicBool, bool);
impl Drop for Pending<'_> {
    fn drop(&mut self) {
        if self.1 {
            self.0.store(true, Ordering::SeqCst);
        }
    }
}
async fn bounded<T>(
    timeout: Duration,
    poisoned: &AtomicBool,
    cancel: &tokio_postgres::CancelToken,
    tls: &tokio_postgres_rustls::MakeRustlsConnect,
    call: impl std::future::Future<Output = Result<T, tokio_postgres::Error>>,
) -> Result<T, ObjectStorageError> {
    let mut pending = Pending(poisoned, true);
    let result = tokio::time::timeout(timeout, call).await;
    pending.1 = false;
    match result {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(e)) => {
            if e.code() == Some(&tokio_postgres::error::SqlState::READ_ONLY_SQL_TRANSACTION)
                || e.is_closed()
            {
                poisoned.store(true, Ordering::SeqCst);
            }
            if e.as_db_error()
                .is_some_and(|e| e.message().contains("stream deletion pending"))
            {
                Err(ObjectStorageError::StreamDeleting)
            } else {
                Err(ObjectStorageError::MetastoreUnavailable(
                    e.as_db_error()
                        .map(|d| d.to_string())
                        .unwrap_or_else(|| e.to_string()),
                ))
            }
        }
        Err(_) => {
            poisoned.store(true, Ordering::SeqCst);
            // Cancellation has its own bounded network wait. A lost connection
            // still leaves an ambiguous result; never automatically retry writes.
            let _ = tokio::time::timeout(Duration::from_secs(1), cancel.cancel_query(tls.clone()))
                .await;
            Err(ObjectStorageError::MetastoreUnavailable(
                "SQL client deadline exceeded".into(),
            ))
        }
    }
}
macro_rules! methods {
    () => {
        pub async fn query(
            &self,
            sql: &str,
            params: &[&(dyn ToSql + Sync)],
        ) -> Result<Vec<Row>, ObjectStorageError> {
            bounded(
                self.timeout,
                &self.poisoned,
                &self.cancel,
                &self.tls,
                self.raw().query(sql, params),
            )
            .await
        }
        pub async fn query_one(
            &self,
            sql: &str,
            params: &[&(dyn ToSql + Sync)],
        ) -> Result<Row, ObjectStorageError> {
            bounded(
                self.timeout,
                &self.poisoned,
                &self.cancel,
                &self.tls,
                self.raw().query_one(sql, params),
            )
            .await
        }
        pub async fn query_opt(
            &self,
            sql: &str,
            params: &[&(dyn ToSql + Sync)],
        ) -> Result<Option<Row>, ObjectStorageError> {
            bounded(
                self.timeout,
                &self.poisoned,
                &self.cancel,
                &self.tls,
                self.raw().query_opt(sql, params),
            )
            .await
        }
        pub async fn execute(
            &self,
            sql: &str,
            params: &[&(dyn ToSql + Sync)],
        ) -> Result<u64, ObjectStorageError> {
            bounded(
                self.timeout,
                &self.poisoned,
                &self.cancel,
                &self.tls,
                self.raw().execute(sql, params),
            )
            .await
        }
        pub async fn batch_execute(&self, sql: &str) -> Result<(), ObjectStorageError> {
            bounded(
                self.timeout,
                &self.poisoned,
                &self.cancel,
                &self.tls,
                self.raw().batch_execute(sql),
            )
            .await
        }
    };
}
impl Client {
    pub fn new(
        inner: deadpool_postgres::Client,
        timeout: Duration,
        tls: tokio_postgres_rustls::MakeRustlsConnect,
    ) -> Self {
        let cancel = inner.cancel_token();
        Self {
            inner: Some(inner),
            timeout,
            cancel,
            tls,
            poisoned: Arc::new(AtomicBool::new(false)),
        }
    }
    pub fn discard_on_drop(&self) {
        self.poisoned.store(true, Ordering::SeqCst);
    }
    pub fn set_timeout(&mut self, timeout: Duration) {
        self.timeout = timeout;
    }
    fn raw(&self) -> &tokio_postgres::Client {
        self.inner.as_ref().unwrap()
    }
    methods!();
    pub async fn transaction(&mut self) -> Result<Transaction<'_>, ObjectStorageError> {
        let inner = bounded(
            self.timeout,
            &self.poisoned,
            &self.cancel,
            &self.tls,
            self.inner.as_mut().unwrap().transaction(),
        )
        .await?;
        Ok(Transaction {
            inner,
            timeout: self.timeout,
            poisoned: self.poisoned.clone(),
            cancel: self.cancel.clone(),
            tls: self.tls.clone(),
        })
    }
}
pub(crate) struct Transaction<'a> {
    inner: deadpool_postgres::Transaction<'a>,
    timeout: Duration,
    poisoned: Arc<AtomicBool>,
    cancel: tokio_postgres::CancelToken,
    tls: tokio_postgres_rustls::MakeRustlsConnect,
}
impl Transaction<'_> {
    fn raw(&self) -> &tokio_postgres::Transaction<'_> {
        &self.inner
    }
    methods!();
    pub async fn commit(self) -> Result<(), ObjectStorageError> {
        bounded(
            self.timeout,
            &self.poisoned,
            &self.cancel,
            &self.tls,
            self.inner.commit(),
        )
        .await
    }
}
