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

#[derive(Debug)]
pub(crate) struct Client {
    inner: Option<deadpool_postgres::Client>,
    timeout: Duration,
    poisoned: Arc<AtomicBool>,
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
            bounded(self.timeout, &self.poisoned, self.raw().query(sql, params)).await
        }
        pub async fn query_one(
            &self,
            sql: &str,
            params: &[&(dyn ToSql + Sync)],
        ) -> Result<Row, ObjectStorageError> {
            bounded(
                self.timeout,
                &self.poisoned,
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
                self.raw().execute(sql, params),
            )
            .await
        }
        pub async fn batch_execute(&self, sql: &str) -> Result<(), ObjectStorageError> {
            bounded(self.timeout, &self.poisoned, self.raw().batch_execute(sql)).await
        }
    };
}
impl Client {
    pub fn new(inner: deadpool_postgres::Client, timeout: Duration) -> Self {
        Self {
            inner: Some(inner),
            timeout,
            poisoned: Arc::new(AtomicBool::new(false)),
        }
    }
    fn raw(&self) -> &tokio_postgres::Client {
        self.inner.as_ref().unwrap()
    }
    methods!();
    pub async fn transaction(&mut self) -> Result<Transaction<'_>, ObjectStorageError> {
        let inner = bounded(
            self.timeout,
            &self.poisoned,
            self.inner.as_mut().unwrap().transaction(),
        )
        .await?;
        Ok(Transaction {
            inner,
            timeout: self.timeout,
            poisoned: self.poisoned.clone(),
        })
    }
}
pub(crate) struct Transaction<'a> {
    inner: deadpool_postgres::Transaction<'a>,
    timeout: Duration,
    poisoned: Arc<AtomicBool>,
}
impl Transaction<'_> {
    fn raw(&self) -> &tokio_postgres::Transaction<'_> {
        &self.inner
    }
    methods!();
    pub async fn commit(self) -> Result<(), ObjectStorageError> {
        bounded(self.timeout, &self.poisoned, self.inner.commit()).await
    }
}
