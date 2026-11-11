//! SQL document primitives. No connection is held during object storage I/O.
use super::postgres_metastore::PostgresOptions;
use crate::storage::object_storage::{
    ConditionalMetadataError, MetadataVersion, MetadataWriteCondition, VersionedMetadata,
};
use crate::storage::{ObjectStorage, ObjectStorageError};
use bytes::Bytes;
use relative_path::RelativePath;
use std::{sync::Arc, time::Duration};

#[derive(Debug)]
pub struct PostgresDocuments {
    pool: deadpool_postgres::Pool,
    deadline: Duration,
    bucket: String,
    expected_id: Option<String>,
    storage: Arc<dyn ObjectStorage>,
    initialized: tokio::sync::OnceCell<()>,
    #[cfg(test)]
    pub(super) deletion_fault: std::sync::atomic::AtomicU8,
}
fn err(e: impl std::fmt::Display) -> ObjectStorageError {
    if e.to_string().contains("stream deletion pending") {
        ObjectStorageError::StreamDeleting
    } else {
        ObjectStorageError::MetastoreUnavailable(e.to_string())
    }
}
fn tenant(t: &Option<String>) -> &str {
    t.as_deref()
        .filter(|v| !v.is_empty() && *v != "DEFAULT_TENANT")
        .unwrap_or("")
}
fn version(v: i64) -> MetadataVersion {
    MetadataVersion {
        e_tag: None,
        version: Some(v.to_string()),
    }
}
pub(super) fn configured_roots(
    ca: Option<&std::path::Path>,
) -> anyhow::Result<rustls::RootCertStore> {
    let mut roots = rustls::RootCertStore::empty();
    if let Some(path) = ca {
        for certificate in
            rustls_pemfile::certs(&mut std::io::BufReader::new(std::fs::File::open(path)?))
        {
            roots.add(certificate?)?;
        }
        anyhow::ensure!(
            !roots.is_empty(),
            "configured CA bundle contains no certificates"
        );
    } else {
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    }
    Ok(roots)
}
impl PostgresDocuments {
    pub fn new(
        options: &PostgresOptions,
        bucket: String,
        storage: Arc<dyn ObjectStorage>,
    ) -> anyhow::Result<Self> {
        let mut config: tokio_postgres::Config =
            options.metastore_postgres_url.as_deref().unwrap().parse()?;
        let timeout = Duration::from_millis(options.metastore_postgres_connect_timeout_ms);
        config.connect_timeout(timeout);
        config.tcp_user_timeout(Duration::from_millis(
            options.metastore_postgres_statement_timeout_ms,
        ));
        config
            .keepalives(true)
            .keepalives_idle(Duration::from_secs(1))
            .keepalives_interval(Duration::from_secs(1))
            .keepalives_retries(3);
        config.target_session_attrs(tokio_postgres::config::TargetSessionAttrs::ReadWrite);
        let prior_options = config.get_options().unwrap_or("").to_owned();
        config.options(format!(
            "{prior_options} -c statement_timeout={} -c lock_timeout={}",
            options.metastore_postgres_statement_timeout_ms,
            options.metastore_postgres_statement_timeout_ms
        ));
        // Prefer/allow permit plaintext downgrade; opt-in mode defaults to verified TLS.
        if config.get_ssl_mode() != tokio_postgres::config::SslMode::Disable {
            config.ssl_mode(tokio_postgres::config::SslMode::Require);
        }
        let roots = configured_roots(options.metastore_postgres_ca.as_deref())?;
        if options.metastore_postgres_ca.is_some()
            && config.get_ssl_mode() == tokio_postgres::config::SslMode::Disable
        {
            tracing::warn!("PostgreSQL CA configured with sslmode=disable; CA is unused");
        }
        let tls = rustls::ClientConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()?
        .with_root_certificates(roots)
        .with_no_client_auth();
        let manager = deadpool_postgres::Manager::new(
            config,
            tokio_postgres_rustls::MakeRustlsConnect::new(tls),
        );
        let pool = deadpool_postgres::Pool::builder(manager)
            .max_size(options.metastore_postgres_pool_size as usize)
            .runtime(deadpool_postgres::Runtime::Tokio1)
            .wait_timeout(Some(timeout))
            .create_timeout(Some(timeout))
            .recycle_timeout(Some(timeout))
            .build()?;
        Ok(Self {
            pool,
            deadline: Duration::from_millis(
                options
                    .metastore_postgres_statement_timeout_ms
                    .saturating_add(250),
            ),
            bucket,
            expected_id: options.metastore_postgres_id.clone(),
            storage,
            initialized: tokio::sync::OnceCell::new(),
            #[cfg(test)]
            deletion_fault: std::sync::atomic::AtomicU8::new(0),
        })
    }
    pub(crate) async fn client(
        &self,
    ) -> Result<super::postgres_client::Client, ObjectStorageError> {
        Ok(super::postgres_client::Client::new(
            tokio::time::timeout(self.deadline, self.pool.get())
                .await
                .map_err(err)?
                .map_err(err)?,
            self.deadline,
        ))
    }
    pub async fn check_migration_guard(&self) -> Result<(), ObjectStorageError> {
        super::migration::guard(self.storage.as_ref(), true)
            .await
            .map_err(err)
    }
    pub async fn check(&self, _: &Option<String>) -> Result<(), ObjectStorageError> {
        super::migration::guard(self.storage.as_ref(), true)
            .await
            .map_err(err)?;
        self.initialized.get_or_try_init(|| async {
            let mut client = self.client().await?;
            let tx = client.transaction().await.map_err(err)?;
            tx.batch_execute("SELECT pg_advisory_xact_lock(8104050183641399916)").await.map_err(err)?;
            let (actual, _, created) = self.bootstrap(&tx, &uuid::Uuid::new_v4().to_string()).await?;
            if tx.query_opt("SELECT state FROM parseable_transfer WHERE singleton", &[]).await.map_err(err)?.is_some_and(|r| r.get::<_,String>(0) != "ready") { return Err(err("offline transfer incomplete or exported; use migration command")); }

            tx.commit().await.map_err(err)?;
            drop(client);
            // Pair outside SQL: never hold a pooled connection during bucket I/O.
            let marker = RelativePath::new(".parseable/postgres-metastore-id");
            if !created {
                // A concurrent first initializer may still be publishing pairing.
                for _ in 0..20 {
                    if super::migration::optional(self.storage.as_ref(), ".parseable/postgres-metastore-id").await.map_err(err)?.is_some() { break; }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            }
            if !created && super::migration::optional(self.storage.as_ref(), ".parseable/postgres-metastore-id").await.map_err(err)?.is_none() && std::env::var("P_METASTORE_POSTGRES_ALLOW_UNPAIRED").as_deref() != Ok("true") {
                return Err(err("nonempty database and missing bucket pairing marker; restore the marker or explicitly set P_METASTORE_POSTGRES_ALLOW_UNPAIRED=true after verifying the bucket"));
            }
            match self.storage.put_metadata_conditional(marker, Bytes::from(actual.clone()), MetadataWriteCondition::Create, &None).await {
                Ok(_) | Err(ConditionalMetadataError::Conflict) => {},
                Err(e) => return Err(err(e)),
            }
            let paired = self.storage.get_object(marker, &None).await?;
            if paired.as_ref() != actual.as_bytes() { return Err(err("bucket is paired with a different PostgreSQL backend UUID")); }
            tracing::info!(backend_id = actual, "PostgreSQL metastore initialized");
            Ok(())
        }).await.map(|_| ())
    }
    async fn bootstrap(
        &self,
        tx: &super::postgres_client::Transaction<'_>,
        id: &str,
    ) -> Result<(String, bool, bool), ObjectStorageError> {
        // Bootstrap is additive; version checks precede any future forward migration.
        tx.batch_execute(include_str!("../migrations/000_identity.sql"))
            .await
            .map_err(err)?;
        let created = tx.execute("INSERT INTO parseable_backend(id,bucket,schema_version,protocol_version) VALUES($1,$2,0,1) ON CONFLICT DO NOTHING", &[&id,&self.bucket]).await.map_err(err)? == 1;
        let row = tx
            .query_one(
                "SELECT id,bucket,schema_version,protocol_version FROM parseable_backend",
                &[],
            )
            .await
            .map_err(err)?;
        let actual: String = row.get(0);
        if row.get::<_, String>(1) != self.bucket
            || self.expected_id.as_ref().is_some_and(|id| id != &actual)
        {
            return Err(err("backend/bucket identity mismatch"));
        }
        if !(0..=2).contains(&row.get::<_, i32>(2)) || row.get::<_, i32>(3) != 1 {
            return Err(err(
                "unsupported schema/protocol version; upgrade this server",
            ));
        }
        if row.get::<_, i32>(2) == 0 {
            tx.batch_execute(include_str!("../migrations/001_documents.sql"))
                .await
                .map_err(err)?;
            tx.execute(
                "UPDATE parseable_backend SET schema_version=1 WHERE singleton",
                &[],
            )
            .await
            .map_err(err)?;
        }
        if row.get::<_, i32>(2) < 2 {
            tx.batch_execute(include_str!("../migrations/002_review_fixes.sql"))
                .await
                .map_err(err)?;
        }
        tx.batch_execute("CREATE TABLE IF NOT EXISTS parseable_transfer (singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), state text NOT NULL)").await.map_err(err)?;
        let has_documents: bool = tx
            .query_one("SELECT EXISTS(SELECT 1 FROM parseable_documents)", &[])
            .await?
            .get(0);
        Ok((actual, has_documents, created))
    }
    // Probe both dependencies without requiring a bucket metadata document.
    pub async fn check_health(&self, t: &Option<String>) -> Result<(), ObjectStorageError> {
        let database = async {
            self.client()
                .await?
                .batch_execute("SELECT 1")
                .await
                .map_err(err)?;
            Ok::<_, ObjectStorageError>(())
        };
        let bucket = async {
            self.storage
                .get_object(RelativePath::new(".parseable/postgres-metastore-id"), t)
                .await
                .map(|_| ())
        };
        tokio::time::timeout(self.deadline, async {
            tokio::try_join!(database, bucket)?;
            Ok(())
        })
        .await
        .map_err(err)?
    }
    pub async fn read_latency(&self, t: &Option<String>) -> Duration {
        let start = std::time::Instant::now();
        let result = self.check_health(t).await;
        tracing::info!(?result, "PostgreSQL and data bucket combined probe");
        start.elapsed()
    }
    pub async fn stream_exists(
        &self,
        stream: &str,
        t: &Option<String>,
    ) -> Result<bool, ObjectStorageError> {
        let path = crate::storage::object_storage::stream_data_path(stream, &[".stream"], t);
        Ok(self.client().await?.query_one("SELECT EXISTS(SELECT 1 FROM parseable_documents WHERE tenant=$1 AND key >= $2 || '/' AND key < $2 || '0' AND key LIKE '%stream.json')", &[&tenant(t), &path.as_str()]).await?.get(0))
    }

    pub async fn is_stream_deleting(
        &self,
        stream: &str,
        t: &Option<String>,
    ) -> Result<bool, ObjectStorageError> {
        let path =
            crate::storage::object_storage::stream_data_path(stream, &[".stream", ".deleting"], t);
        Ok(self
            .get_metadata_versioned(&path, t)
            .await
            .map_err(err)?
            .is_some())
    }
    async fn remove_rows(
        &self,
        path: &RelativePath,
        t: &Option<String>,
    ) -> Result<(), ObjectStorageError> {
        self.client().await?.execute("DELETE FROM parseable_documents WHERE tenant=$1 AND ($2='' OR key=$2 OR (key >= $2 || '/' AND key < $2 || '0'))", &[&tenant(t), &path.as_str()]).await.map_err(err)?;
        Ok(())
    }
    async fn delete_data(
        &self,
        path: &RelativePath,
        t: &Option<String>,
    ) -> Result<(), ObjectStorageError> {
        match self.storage.delete_prefix(path, t).await {
            Err(ObjectStorageError::NoSuchKey(_)) => Ok(()),
            Err(ObjectStorageError::IoError(e)) if e.kind() == std::io::ErrorKind::NotFound => {
                Ok(())
            }
            result => result,
        }
    }
    pub async fn delete_stream(
        &self,
        stream: &str,
        t: &Option<String>,
    ) -> Result<(), ObjectStorageError> {
        let marker =
            crate::storage::object_storage::stream_data_path(stream, &[".stream", ".deleting"], t);
        self.put_object(&marker, Bytes::new(), t).await?;
        let path = crate::storage::object_storage::stream_data_path(stream, &[], t);
        #[cfg(test)]
        if self
            .deletion_fault
            .load(std::sync::atomic::Ordering::SeqCst)
            == 1
        {
            return Err(err("injected bucket failure"));
        }
        self.delete_data(&path, t).await?;
        #[cfg(test)]
        if self
            .deletion_fault
            .load(std::sync::atomic::Ordering::SeqCst)
            == 2
        {
            return Err(err("injected crash after data deletion"));
        }
        self.remove_rows(&path, t).await
    }
    pub async fn delete_partition(
        &self,
        path: &RelativePath,
        t: &Option<String>,
    ) -> Result<(), ObjectStorageError> {
        self.delete_data(path, t).await?;
        #[cfg(test)]
        if self
            .deletion_fault
            .load(std::sync::atomic::Ordering::SeqCst)
            == 3
        {
            return Err(err("injected partition cleanup failure"));
        }
        self.remove_rows(path, t).await
    }
    pub async fn list_tenant_candidates(&self) -> Result<Vec<String>, ObjectStorageError> {
        let mut candidates: std::collections::BTreeSet<String> = self
            .client()
            .await?
            .query(
                "SELECT DISTINCT tenant FROM parseable_documents WHERE tenant <> ''",
                &[],
            )
            .await
            .map_err(err)?
            .into_iter()
            .map(|r| r.get(0))
            .collect();
        let default_streams: std::collections::HashSet<String> = self
            .keys("", "")
            .await?
            .iter()
            .filter_map(|k| {
                k.split_once('/').and_then(|(s, rest)| {
                    (rest.starts_with(".stream/") || rest == ".stream.json" || rest == ".schema")
                        .then(|| s.to_owned())
                })
            })
            .collect();
        candidates.extend(
            self.storage
                .list_dirs_relative(RelativePath::new(""), &None)
                .await?
                .into_iter()
                .filter(|p| !p.starts_with('.') && !default_streams.contains(p)),
        );
        Ok(candidates.into_iter().collect())
    }
    pub fn absolute_url(&self, path: &RelativePath) -> object_store::path::Path {
        object_store::path::Path::parse(path.as_str()).expect("valid document key")
    }
    pub async fn manifest_batch(
        &self,
        paths: &[String],
        t: &Option<String>,
    ) -> Result<Vec<(String, Bytes)>, ObjectStorageError> {
        let base = self.storage.absolute_url(RelativePath::new(""));
        let normalized: Vec<String> = paths
            .iter()
            .map(|p| {
                p.strip_prefix(base.as_ref())
                    .and_then(|p| p.strip_prefix('/'))
                    .unwrap_or(p)
                    .to_owned()
            })
            .collect();
        let rows = self
            .client()
            .await?
            .query(
                "SELECT key,body FROM parseable_documents WHERE tenant=$1 AND key=ANY($2)",
                &[&tenant(t), &normalized],
            )
            .await?;
        let bodies: std::collections::HashMap<String, Bytes> = rows
            .into_iter()
            .map(|r| (r.get(0), Bytes::from(r.get::<_, Vec<u8>>(1))))
            .collect();
        Ok(paths
            .iter()
            .zip(normalized)
            .filter_map(|(original, key)| bodies.get(&key).map(|b| (original.clone(), b.clone())))
            .collect())
    }
    pub async fn get_object(
        &self,
        path: &RelativePath,
        t: &Option<String>,
    ) -> Result<Bytes, ObjectStorageError> {
        self.get_metadata_versioned(path, t)
            .await
            .map_err(err)?
            .map(|r| r.bytes)
            .ok_or_else(|| ObjectStorageError::NoSuchKey(path.to_string()))
    }
    pub async fn get_metadata_versioned(
        &self,
        path: &RelativePath,
        t: &Option<String>,
    ) -> Result<Option<VersionedMetadata>, ConditionalMetadataError> {
        let base = self.storage.absolute_url(RelativePath::new(""));
        let normalized = path
            .as_str()
            .strip_prefix(base.as_ref())
            .and_then(|p| p.strip_prefix('/'))
            .unwrap_or(path.as_str());
        let c = self.client().await?;
        Ok(c.query_opt(
            "SELECT body,version FROM parseable_documents WHERE tenant=$1 AND key=$2",
            &[&tenant(t), &normalized],
        )
        .await
        .map_err(err)?
        .map(|r| VersionedMetadata {
            bytes: Bytes::from(r.get::<_, Vec<u8>>(0)),
            version: version(r.get(1)),
        }))
    }
    pub async fn put_object(
        &self,
        path: &RelativePath,
        body: Bytes,
        t: &Option<String>,
    ) -> Result<(), ObjectStorageError> {
        let c = self.client().await?;
        c.execute("INSERT INTO parseable_documents(tenant,kind,key,body) VALUES($1,$2,$3,$4) ON CONFLICT(tenant,key) DO UPDATE SET body=EXCLUDED.body, version=nextval('parseable_document_version'),updated_at=now()", &[&tenant(t), &kind(path), &path.as_str(), &&body[..]]).await.map_err(err)?;
        Ok(())
    }
    pub async fn put_metadata_conditional(
        &self,
        path: &RelativePath,
        body: Bytes,
        condition: MetadataWriteCondition,
        t: &Option<String>,
    ) -> Result<MetadataVersion, ConditionalMetadataError> {
        let c = self.client().await?;
        let row = match condition {
            MetadataWriteCondition::Create => c.query_opt("INSERT INTO parseable_documents(tenant,kind,key,body) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING version", &[&tenant(t),&kind(path),&path.as_str(),&&body[..]]).await.map_err(err)?,
            MetadataWriteCondition::Update(v) => { let v = v.version.and_then(|v| v.parse::<i64>().ok()).ok_or(ConditionalMetadataError::Conflict)?;
                c.query_opt("UPDATE parseable_documents SET body=$3,version=nextval('parseable_document_version'),updated_at=now() WHERE tenant=$1 AND key=$2 AND version=$4 RETURNING version", &[&tenant(t),&path.as_str(),&&body[..],&v]).await.map_err(err)? }
        };
        row.map(|r| version(r.get(0)))
            .ok_or(ConditionalMetadataError::Conflict)
    }
    pub async fn delete_metadata_conditional(
        &self,
        path: &RelativePath,
        v: MetadataVersion,
        t: &Option<String>,
    ) -> Result<(), ConditionalMetadataError> {
        let v = v
            .version
            .and_then(|v| v.parse::<i64>().ok())
            .ok_or(ConditionalMetadataError::Conflict)?;
        let count = self
            .client()
            .await?
            .execute(
                "DELETE FROM parseable_documents WHERE tenant=$1 AND key=$2 AND version=$3",
                &[&tenant(t), &path.as_str(), &v],
            )
            .await
            .map_err(err)?;
        if count == 0 {
            Err(ConditionalMetadataError::Conflict)
        } else {
            Ok(())
        }
    }
    pub async fn delete_object(
        &self,
        path: &RelativePath,
        t: &Option<String>,
    ) -> Result<(), ObjectStorageError> {
        self.client()
            .await?
            .execute(
                "DELETE FROM parseable_documents WHERE tenant=$1 AND key=$2",
                &[&tenant(t), &path.as_str()],
            )
            .await
            .map_err(err)?;
        Ok(())
    }
    async fn rows(
        &self,
        prefix: &str,
        t: Option<&str>,
    ) -> Result<Vec<(String, Bytes)>, ObjectStorageError> {
        let prefix = prefix.trim_matches('/');
        Ok(self.client().await?.query("SELECT key,body FROM parseable_documents WHERE tenant=$2 AND ($1='' OR key=$1 OR (key >= $1 || '/' AND key < $1 || '0')) ORDER BY key", &[&prefix,&t.unwrap_or("")]).await?.into_iter().map(|r| (r.get(0),Bytes::from(r.get::<_,Vec<u8>>(1)))).collect())
    }
    async fn keys(&self, prefix: &str, t: &str) -> Result<Vec<String>, ObjectStorageError> {
        Ok(self.client().await?.query("SELECT key FROM parseable_documents WHERE tenant=$1 AND ($2='' OR key=$2 OR (key >= $2 || '/' AND key < $2 || '0')) ORDER BY key", &[&t,&prefix]).await?.into_iter().map(|r|r.get(0)).collect())
    }
    pub async fn list_streams(
        &self,
        t: &Option<String>,
    ) -> Result<std::collections::HashSet<String>, ObjectStorageError> {
        let prefix = if tenant(t).is_empty() {
            String::new()
        } else {
            format!("{}/", tenant(t))
        };
        let keys = self
            .client()
            .await?
            .query(
                "SELECT key FROM parseable_documents WHERE tenant=$1 AND key LIKE '%/.stream/%'",
                &[&tenant(t)],
            )
            .await?;
        let keys: std::collections::HashSet<String> = keys.into_iter().map(|r| r.get(0)).collect();
        Ok(keys
            .iter()
            .filter(|k| k.ends_with("stream.json"))
            .filter_map(|k| {
                k.strip_prefix(&prefix)?
                    .split_once('/')
                    .map(|(s, _)| s.to_owned())
            })
            .filter(|s| !keys.contains(&format!("{prefix}{s}/.stream/.deleting")))
            .collect())
    }
    pub async fn get_objects(
        &self,
        path: Option<&RelativePath>,
        filter: Box<dyn Fn(String) -> bool + Send>,
        t: &Option<String>,
    ) -> Result<Vec<Bytes>, ObjectStorageError> {
        // Node registry objects are deployment-global; tenant is metrics context
        // for this existing trait API, and is not part of its path.
        let root = path.map(|p| p.as_str()).unwrap_or("");
        let scope = if root == ".parseable" { "" } else { tenant(t) };
        Ok(self
            .rows(root, Some(scope))
            .await?
            .into_iter()
            .filter(|(p, _)| filter(p.rsplit('/').next().unwrap().to_owned()))
            .map(|(_, b)| b)
            .collect())
    }
    pub async fn delete_prefix(
        &self,
        path: &RelativePath,
        _: &Option<String>,
    ) -> Result<(), ObjectStorageError> {
        if path.as_str().is_empty() || path.as_str().contains('/') {
            return Err(err("tenant deletion requires one nonempty path component"));
        }
        self.delete_data(path, &None).await?;
        self.client()
            .await?
            .execute(
                "DELETE FROM parseable_documents WHERE tenant=$1",
                &[&path.as_str()],
            )
            .await
            .map_err(err)?;
        Ok(())
    }
    pub async fn list_dirs_relative(
        &self,
        path: &RelativePath,
        t: &Option<String>,
    ) -> Result<Vec<String>, ObjectStorageError> {
        let prefix = format!("{}/", path.as_str().trim_end_matches('/'));
        Ok(self
            .keys(path.as_str(), tenant(t))
            .await?
            .into_iter()
            .filter_map(|p| {
                p.strip_prefix(&prefix)
                    .and_then(|p| p.split_once('/'))
                    .map(|(p, _)| p.to_owned())
            })
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect())
    }
    pub async fn list_with_delimiter(
        &self,
        path: Option<object_store::path::Path>,
        t: &Option<String>,
    ) -> Result<object_store::ListResult, ObjectStorageError> {
        let base = path.as_ref().map(|p| p.as_ref()).unwrap_or("");
        let prefix = if base.is_empty() {
            String::new()
        } else {
            format!("{base}/")
        };
        let mut dirs = std::collections::BTreeSet::new();
        let mut objects = Vec::new();
        for key in self.keys(base, tenant(t)).await? {
            let Some(suffix) = key.strip_prefix(&prefix) else {
                continue;
            };
            if let Some((dir, _)) = suffix.split_once('/') {
                dirs.insert(
                    object_store::path::Path::parse(format!("{prefix}{dir}")).map_err(err)?,
                );
            } else {
                objects.push(object_store::ObjectMeta {
                    location: object_store::path::Path::parse(key).map_err(err)?,
                    last_modified: chrono::Utc::now(),
                    size: 0,
                    e_tag: None,
                    version: None,
                });
            }
        }
        Ok(object_store::ListResult {
            common_prefixes: dirs.into_iter().collect(),
            objects,
        })
    }
    pub async fn schema_objects(
        &self,
        stream: &str,
        t: &Option<String>,
    ) -> Result<Vec<(String, Bytes)>, ObjectStorageError> {
        let prefix = format!(
            "{}{stream}/.stream",
            if tenant(t).is_empty() {
                String::new()
            } else {
                format!("{}/", tenant(t))
            }
        );
        Ok(self
            .rows(&prefix, Some(tenant(t)))
            .await?
            .into_iter()
            .filter_map(|(p, b)| {
                let name = p.rsplit('/').next()?.to_owned();
                name.contains(".schema").then_some((name, b))
            })
            .collect())
    }
}
pub(crate) fn kind(path: &RelativePath) -> &'static str {
    let name = path.file_name().unwrap_or("");
    if name.ends_with("manifest.json") {
        "manifest"
    } else if name.ends_with("stream.json") {
        "stream"
    } else if name.contains(".schema") {
        "schema"
    } else {
        "document"
    }
}

#[cfg(test)]
impl PostgresDocuments {
    pub async fn verify_partition_contract(&self) {
        // The SQL trigger fails precisely after data deletion, before row deletion.
        let tenants = [
            Some("partition-a".to_owned()),
            Some("partition-b".to_owned()),
        ];
        let dates = ["date=2026-01-01", "date=2026-01-02"];
        for t in &tenants {
            for date in dates {
                let prefix = format!("{}/logs/{date}", t.as_ref().unwrap());
                self.put_object(
                    RelativePath::new(&format!("{prefix}/manifest.json")),
                    Bytes::from(prefix.clone()),
                    t,
                )
                .await
                .unwrap();
                self.storage
                    .put_object(
                        RelativePath::new(&format!("{prefix}/data.parquet")),
                        Bytes::from(prefix),
                        t,
                    )
                    .await
                    .unwrap();
            }
        }
        let client = self.client().await.unwrap();
        client.batch_execute("CREATE FUNCTION fail_partition_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.key = 'partition-a/logs/date=2026-01-01/manifest.json' THEN RAISE EXCEPTION 'injected partition row failure'; END IF; RETURN OLD; END $$; CREATE TRIGGER partition_delete_fault BEFORE DELETE ON parseable_documents FOR EACH ROW EXECUTE FUNCTION fail_partition_delete();").await.unwrap();
        let path = RelativePath::new("partition-a/logs/date=2026-01-01");
        let error = self.delete_partition(path, &tenants[0]).await.unwrap_err();
        assert!(error.to_string().contains("PostgreSQL"), "{error}");
        assert!(
            self.storage
                .get_object(
                    RelativePath::new("partition-a/logs/date=2026-01-01/data.parquet"),
                    &tenants[0]
                )
                .await
                .is_err()
        );
        assert!(
            self.get_object(
                RelativePath::new("partition-a/logs/date=2026-01-01/manifest.json"),
                &tenants[0]
            )
            .await
            .is_ok()
        );
        client.batch_execute("DROP TRIGGER partition_delete_fault ON parseable_documents; DROP FUNCTION fail_partition_delete();").await.unwrap();
        drop(client);
        self.delete_partition(path, &tenants[0]).await.unwrap();
        self.delete_partition(path, &tenants[0]).await.unwrap();
        for (i, t) in tenants.iter().enumerate() {
            for (j, date) in dates.iter().enumerate() {
                let prefix = format!("{}/logs/{date}", t.as_ref().unwrap());
                let manifest = self
                    .get_object(RelativePath::new(&format!("{prefix}/manifest.json")), t)
                    .await;
                let data = self
                    .storage
                    .get_object(RelativePath::new(&format!("{prefix}/data.parquet")), t)
                    .await;
                if i == 0 && j == 0 {
                    assert!(manifest.is_err());
                    assert!(data.is_err());
                } else {
                    assert_eq!(manifest.unwrap(), Bytes::from(prefix.clone()));
                    assert_eq!(data.unwrap(), Bytes::from(prefix));
                }
            }
            self.delete_prefix(RelativePath::new(t.as_ref().unwrap()), t)
                .await
                .unwrap();
        }
    }
    pub async fn verify_deleted_stream_rows(&self) {
        let count: i64 = self.client().await.unwrap().query_one("SELECT count(*) FROM parseable_documents WHERE starts_with(key,'contractlogs/') OR starts_with(key,'tenant-contract/contractlogs/')", &[]).await.unwrap().get(0);
        assert_eq!(count, 0);
    }
    pub async fn verify_database_contract(&self, options: &PostgresOptions) {
        for fault in [1, 2] {
            let t = Some("failure-tenant".to_owned());
            let key = RelativePath::new("failure-tenant/retry/.stream/.stream.json");
            self.put_object(key, Bytes::from_static(b"{}"), &t)
                .await
                .unwrap();
            self.put_object(
                RelativePath::new("retry/.stream/.stream.json"),
                Bytes::from_static(b"other tenant"),
                &None,
            )
            .await
            .unwrap();
            let data = RelativePath::new("failure-tenant/retry/date=2026-01-01/data.parquet");
            self.storage
                .put_object(data, Bytes::from_static(b"data"), &t)
                .await
                .unwrap();
            self.deletion_fault
                .store(fault, std::sync::atomic::Ordering::SeqCst);
            assert!(self.delete_stream("retry", &t).await.is_err());
            assert!(self.is_stream_deleting("retry", &t).await.unwrap());
            assert_eq!(self.storage.get_object(data, &t).await.is_ok(), fault == 1);
            let restarted =
                Arc::new(Self::new(options, self.bucket.clone(), self.storage.clone()).unwrap());
            restarted.check(&None).await.unwrap();
            let restarted_store = super::postgres_metastore::PostgresMetastore {
                storage: restarted.clone(),
            };
            assert!(
                !crate::metastore::metastore_traits::Metastore::list_streams(&restarted_store, &t)
                    .await
                    .unwrap()
                    .contains("retry")
            );
            assert!(restarted.is_stream_deleting("retry", &t).await.unwrap());
            restarted.delete_stream("retry", &t).await.unwrap();
            assert!(
                restarted
                    .rows("failure-tenant/retry", Some("failure-tenant"))
                    .await
                    .unwrap()
                    .is_empty()
            );
            restarted
                .put_object(key, Bytes::from_static(b"recreated"), &t)
                .await
                .unwrap();
            assert_eq!(
                restarted.get_object(key, &t).await.unwrap(),
                Bytes::from_static(b"recreated")
            );
            self.deletion_fault
                .store(0, std::sync::atomic::Ordering::SeqCst);
            self.delete_stream("retry", &t).await.unwrap();
            assert!(!self.stream_exists("retry", &t).await.unwrap());
            assert!(!self.is_stream_deleting("retry", &t).await.unwrap());
            assert!(self.stream_exists("retry", &None).await.unwrap());
            self.delete_stream("retry", &None).await.unwrap();
        }
        // Distinct raw tenant keys coexist, including SQL-only and bucket-only
        // candidates. Enumeration order is unspecified: compare sets.
        let baseline: std::collections::BTreeSet<_> = self
            .list_tenant_candidates()
            .await
            .unwrap()
            .into_iter()
            .collect();
        for name in ["discovery-sql", "discovery-duplicate", "discovery-invalid"] {
            self.put_object(
                RelativePath::new(&format!("{name}/.parseable/.parseable.json")),
                Bytes::from_static(b"{}"),
                &Some(name.into()),
            )
            .await
            .unwrap();
        }
        for name in ["discovery-data", "discovery-duplicate", ".discovery-hidden"] {
            self.storage
                .put_object(
                    RelativePath::new(&format!("{name}/data.parquet")),
                    Bytes::from_static(b"data"),
                    &None,
                )
                .await
                .unwrap();
        }
        let candidates: std::collections::BTreeSet<_> = self
            .list_tenant_candidates()
            .await
            .unwrap()
            .into_iter()
            .collect();
        assert_eq!(
            candidates
                .difference(&baseline)
                .cloned()
                .collect::<std::collections::BTreeSet<_>>(),
            [
                "discovery-sql",
                "discovery-data",
                "discovery-duplicate",
                "discovery-invalid"
            ]
            .into_iter()
            .map(str::to_owned)
            .collect()
        );
        for name in [
            "discovery-sql",
            "discovery-data",
            "discovery-duplicate",
            "discovery-invalid",
            ".discovery-hidden",
        ] {
            self.delete_prefix(RelativePath::new(name), &None)
                .await
                .unwrap();
        }
        let client = self.client().await.unwrap();
        let started = std::time::Instant::now();
        assert!(client.query("SELECT pg_sleep(10)", &[]).await.is_err());
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(client.query("SELECT 1", &[]).await.is_ok());
        drop(client);
        // Pool saturation is bounded and returned as an error.
        let held = futures::future::join_all((0..4).map(|_| self.client())).await;
        assert!(held.iter().all(Result::is_ok));
        let started = std::time::Instant::now();
        assert!(self.client().await.is_err());
        assert!(started.elapsed() < Duration::from_secs(3));
        drop(held);
        let marker = RelativePath::new(".parseable/postgres-metastore-id");
        let paired = self.storage.get_object(marker, &None).await.unwrap();
        self.storage.delete_object(marker, &None).await.unwrap();
        let started = std::time::Instant::now();
        assert!(self.check_health(&None).await.is_err());
        assert!(started.elapsed() < Duration::from_secs(3));
        self.storage
            .put_object(marker, Bytes::from_static(b"wrong-backend"), &None)
            .await
            .unwrap();
        let partial = Self::new(options, self.bucket.clone(), self.storage.clone()).unwrap();
        let error = partial.check(&None).await.unwrap_err();
        assert!(
            error
                .to_string()
                .contains("different PostgreSQL backend UUID"),
            "{error}"
        );
        self.storage
            .put_object(marker, paired, &None)
            .await
            .unwrap();
        partial.check(&None).await.unwrap();
        partial.check_health(&None).await.unwrap();
        let path = RelativePath::new("contract/concurrent.json");
        self.put_object(path, Bytes::from_static(b"initial"), &None)
            .await
            .unwrap();
        let original = self
            .get_metadata_versioned(path, &None)
            .await
            .unwrap()
            .unwrap();
        let writes = (0..12).map(|i| {
            self.put_metadata_conditional(
                path,
                Bytes::from(i.to_string()),
                MetadataWriteCondition::Update(original.version.clone()),
                &None,
            )
        });
        let results = futures::future::join_all(writes).await;
        assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
        let before_delete = self
            .get_metadata_versioned(path, &None)
            .await
            .unwrap()
            .unwrap()
            .version;
        self.delete_object(path, &None).await.unwrap();
        self.put_object(path, Bytes::new(), &None).await.unwrap();
        let recreated = self
            .get_metadata_versioned(path, &None)
            .await
            .unwrap()
            .unwrap()
            .version;
        assert!(
            recreated.version.unwrap().parse::<i64>().unwrap()
                > before_delete.version.unwrap().parse::<i64>().unwrap()
        );
        self.delete_object(path, &None).await.unwrap();
    }
}

impl PostgresDocuments {
    pub(crate) async fn migrate(
        &self,
        store: Arc<dyn ObjectStorage>,
        opts: &super::migration::MigrationOptions,
        keys: &[super::migration::InventoryDocument],
    ) -> anyhow::Result<()> {
        use super::migration::{Action, BUSY, PAIR, digest, optional};
        use anyhow::ensure;
        let action = opts.metadata_migration.unwrap();
        let mut client = self.client().await?;
        // All remote I/O and validation happen before the import transaction.
        let tx = &client;
        if action == Action::Verify {
            let exists: bool = tx
                .query_one("SELECT to_regclass('parseable_documents') IS NOT NULL", &[])
                .await?
                .get(0);
            let bucket_keys: std::collections::BTreeSet<_> = keys
                .iter()
                .map(|(k, (t, _), _)| (t.as_str(), k.as_str()))
                .collect();
            let mut differences = 0;
            for (key, (tenant, kind), _) in keys {
                let bucket = store.get_object(RelativePath::new(key), &None).await?;
                let sql = if exists {
                    tx.query_opt(
                        "SELECT body FROM parseable_documents WHERE tenant=$1 AND key=$2",
                        &[tenant, key],
                    )
                    .await?
                    .map(|r| r.get::<_, Vec<u8>>(0))
                } else {
                    None
                };
                if sql.as_deref() != Some(bucket.as_ref()) {
                    println!(
                        "DIFFERENT tenant={tenant:?} kind={kind} key={key} bucket={} sql={}",
                        digest(&bucket),
                        sql.as_ref()
                            .map(|b| digest(b))
                            .unwrap_or_else(|| "missing".into())
                    );
                    differences += 1;
                }
            }
            if exists {
                let mut last = (String::new(), String::new());
                loop {
                    let rows = tx.query("SELECT tenant,key,kind FROM parseable_documents WHERE (tenant COLLATE \"C\",key COLLATE \"C\") > ($1,$2) ORDER BY tenant COLLATE \"C\",key COLLATE \"C\" LIMIT 128", &[&last.0,&last.1]).await?;
                    if rows.is_empty() {
                        break;
                    }
                    for row in rows {
                        last = (row.get(0), row.get(1));
                        if !bucket_keys.contains(&(last.0.as_str(), last.1.as_str())) {
                            println!(
                                "SQL ONLY tenant={:?} kind={} key={}",
                                last.0,
                                row.get::<_, String>(2),
                                last.1
                            );
                            differences += 1;
                        }
                    }
                }
            }
            ensure!(differences == 0, "{differences} metadata differences");
            println!("representations match");
            return Ok(());
        }
        let prior_busy = optional(store.as_ref(), BUSY).await?;
        let initial_id = prior_busy
            .as_ref()
            .and_then(|b| std::str::from_utf8(b).ok())
            .and_then(|s| s.strip_prefix("Import:"))
            .map(str::to_owned)
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let bootstrap_tx = client.transaction().await?;
        bootstrap_tx
            .query("SELECT pg_advisory_xact_lock(8104050183641399916)", &[])
            .await?;
        let (id, _, _) = self.bootstrap(&bootstrap_tx, &initial_id).await?;
        bootstrap_tx.commit().await?;
        let tx = &client;
        let state = format!("{action:?}:{id}");
        let busy = optional(store.as_ref(), BUSY).await?;
        ensure!(
            busy.as_ref().is_none_or(|b| b.as_ref() == state.as_bytes()),
            "another transfer owns the bucket migration marker"
        );
        let pair = optional(store.as_ref(), PAIR).await?;
        ensure!(
            pair.as_ref().is_none_or(|b| b.as_ref() == id.as_bytes()),
            "bucket paired with another database"
        );
        let count: i64 = tx
            .query_one("SELECT count(*) FROM parseable_documents", &[])
            .await?
            .get(0);
        if action == Action::Import {
            ensure!(
                count == 0 || busy.is_some(),
                "refusing import into nonempty database"
            );
            if count != 0 {
                ensure!(
                    count as usize == keys.len(),
                    "resumed import inventory changed"
                );
            }
        } else {
            ensure!(
                pair.is_some() || busy.is_some(),
                "export requires a paired bucket or interrupted export"
            );
            // Preflight every destination before any overwrite.
            let mut last = (String::new(), String::new());
            loop {
                let rows = tx.query("SELECT tenant,key,body FROM parseable_documents WHERE (tenant COLLATE \"C\",key COLLATE \"C\") > ($1,$2) ORDER BY tenant COLLATE \"C\",key COLLATE \"C\" LIMIT 32", &[&last.0,&last.1]).await?;
                if rows.is_empty() {
                    break;
                }
                for row in rows {
                    last = (row.get(0), row.get(1));
                    let body: Vec<u8> = row.get(2);
                    self.validate_export_row(&client, &last.1, &Bytes::from(body.clone()))
                        .await?;
                    if let Some(old) = optional(store.as_ref(), &last.1).await? {
                        let baseline = self.import_digest(&client, &last.1).await?;
                        ensure!(
                            old.as_ref() == body
                                || baseline.as_deref() == Some(digest(&old).as_str())
                                || opts.overwrite_bucket_changes_since_import,
                            "bucket changed since import: {}; after backup use --overwrite-bucket-changes-since-import",
                            last.1
                        );
                    }
                }
            }
            // Bucket-only metadata would resurrect deleted SQL objects on downgrade.
            for (key, (tenant, _), _) in keys {
                if tx
                    .query_opt(
                        "SELECT 1 FROM parseable_documents WHERE tenant=$1 AND key=$2",
                        &[tenant, key],
                    )
                    .await?
                    .is_none()
                {
                    ensure!(
                        self.import_digest(&client, key).await?.as_deref()
                            == Some(
                                digest(&store.get_object(RelativePath::new(key), &None).await?)
                                    .as_str()
                            )
                            || opts.overwrite_bucket_changes_since_import,
                        "bucket-only metadata changed since import: {key}; use --overwrite-bucket-changes-since-import after backup"
                    );
                }
            }
        }
        store
            .put_metadata_conditional(
                RelativePath::new(BUSY),
                Bytes::from(state.clone()),
                MetadataWriteCondition::Create,
                &None,
            )
            .await
            .or_else(|e| {
                if matches!(e, ConditionalMetadataError::Conflict) && busy.is_some() {
                    Ok(version(0))
                } else {
                    Err(e)
                }
            })?;
        super::migration::failure_point(opts, "marker")?;
        if action == Action::Import {
            let spool = tempfile::tempdir_in(std::env::current_dir()?)?;
            for (index, (key, _, _)) in keys.iter().enumerate() {
                let body = store.get_object(RelativePath::new(key), &None).await?;
                std::fs::write(spool.path().join(index.to_string()), &body)?;
            }
            super::migration::failure_point(opts, "spool")?;
            let current = store.metadata_inventory().await?;
            let current: Vec<_> = current
                .into_iter()
                .filter(|(k, _)| super::migration::document_scope(k).is_some())
                .collect();
            ensure!(
                current.len() == keys.len()
                    && current
                        .iter()
                        .zip(keys)
                        .all(|((k, m), (old, _, om))| k == old && m == om),
                "bucket metadata changed during import"
            );
            let tx = client.transaction().await?;
            tx.query("SELECT pg_advisory_xact_lock(8104050183641399916)", &[])
                .await?;
            tx.batch_execute("CREATE TABLE IF NOT EXISTS parseable_import_digests (key text PRIMARY KEY, digest text NOT NULL)").await?;
            for (index, batch) in keys.chunks(32).enumerate() {
                let mut tenants = Vec::new();
                let mut kinds = Vec::new();
                let mut paths = Vec::new();
                let mut bodies = Vec::new();
                for (key, (tenant, kind), _) in batch {
                    let body = Bytes::from(std::fs::read(
                        spool.path().join((index * 32 + bodies.len()).to_string()),
                    )?);
                    tenants.push(tenant.clone());
                    kinds.push(kind.to_string());
                    paths.push(key.clone());
                    bodies.push(body.to_vec());
                }
                if count == 0 {
                    tx.execute("INSERT INTO parseable_documents(tenant,kind,key,body) SELECT * FROM unnest($1::text[],$2::text[],$3::text[],$4::bytea[])", &[&tenants,&kinds,&paths,&bodies]).await?;
                }
                for ((key, tenant), body) in paths.iter().zip(&tenants).zip(&bodies) {
                    tx.execute("INSERT INTO parseable_import_digests(key,digest) VALUES($1,$2) ON CONFLICT DO NOTHING", &[key, &digest(body)]).await?;
                    let reread: Vec<u8> = tx
                        .query_one(
                            "SELECT body FROM parseable_documents WHERE tenant=$1 AND key=$2",
                            &[tenant, key],
                        )
                        .await?
                        .get(0);
                    ensure!(digest(body) == digest(&reread), "SQL digest differs: {key}");
                }
                eprintln!(
                    "verified import {}/{}",
                    ((index + 1) * 32).min(keys.len()),
                    keys.len()
                );
            }
            tx.execute("INSERT INTO parseable_transfer(state) VALUES('ready') ON CONFLICT(singleton) DO UPDATE SET state='ready'", &[]).await?;
            super::migration::failure_point(opts, "import-before-commit")?;
            tx.commit().await?;
            super::migration::failure_point(opts, "import-commit")?;
            store
                .put_metadata_conditional(
                    RelativePath::new(PAIR),
                    Bytes::from(id.clone()),
                    MetadataWriteCondition::Create,
                    &None,
                )
                .await
                .or_else(|e| {
                    if matches!(e, ConditionalMetadataError::Conflict) {
                        Ok(version(0))
                    } else {
                        Err(e)
                    }
                })?;
            ensure!(
                optional(store.as_ref(), PAIR).await?.unwrap().as_ref() == id.as_bytes(),
                "pair mismatch"
            );
            super::migration::failure_point(opts, "paired")?;
        } else {
            tx.execute("INSERT INTO parseable_transfer(state) VALUES('exported') ON CONFLICT(singleton) DO UPDATE SET state='exported'", &[]).await?;
            super::migration::failure_point(opts, "export-state")?;
            let mut last = (String::new(), String::new());
            loop {
                let rows = client.query("SELECT tenant,key,body FROM parseable_documents WHERE (tenant COLLATE \"C\",key COLLATE \"C\") > ($1,$2) ORDER BY tenant COLLATE \"C\",key COLLATE \"C\" LIMIT 32", &[&last.0,&last.1]).await?;
                if rows.is_empty() {
                    break;
                }
                for row in rows {
                    last = (row.get(0), row.get(1));
                    let body = Bytes::from(row.get::<_, Vec<u8>>(2));
                    store
                        .put_object(RelativePath::new(&last.1), body.clone(), &None)
                        .await?;
                    ensure!(
                        store.get_object(RelativePath::new(&last.1), &None).await? == body,
                        "export verification failed: {}",
                        last.1
                    );
                    super::migration::failure_point(opts, "object-write")?;
                    eprintln!("verified export {}", last.1);
                }
            }
            for (key, (tenant, _), _) in keys {
                if client
                    .query_opt(
                        "SELECT 1 FROM parseable_documents WHERE tenant=$1 AND key=$2",
                        &[tenant, key],
                    )
                    .await?
                    .is_none()
                {
                    store.delete_object(RelativePath::new(key), &None).await?;
                    super::migration::failure_point(opts, "bucket-delete")?;
                }
            }
            // Validate stream references only after all destination documents exist.
            let mut last_key = String::new();
            loop {
                let rows = client.query("SELECT key,body FROM parseable_documents WHERE key COLLATE \"C\" > $1 ORDER BY key COLLATE \"C\" LIMIT 32", &[&last_key]).await?;
                if rows.is_empty() {
                    break;
                }
                for row in rows {
                    last_key = row.get(0);
                    super::migration::validate(
                        store.as_ref(),
                        &last_key,
                        &Bytes::from(row.get::<_, Vec<u8>>(1)),
                    )
                    .await?;
                }
            }
            if optional(store.as_ref(), PAIR).await?.is_some() {
                store.delete_object(RelativePath::new(PAIR), &None).await?;
            }
            super::migration::failure_point(opts, "pair-removed")?;
        }
        store.delete_object(RelativePath::new(BUSY), &None).await?;
        Ok(())
    }
}

impl PostgresDocuments {
    pub(crate) async fn migration_preflight(
        &self,
        store: &dyn ObjectStorage,
        opts: &super::migration::MigrationOptions,
    ) -> anyhow::Result<()> {
        use super::migration::{Action, BUSY, PAIR, optional};
        use anyhow::ensure;
        let client = self.client().await?;
        let busy = optional(store, BUSY).await?;
        let pair = optional(store, PAIR).await?;
        let exists: bool = client
            .query_one("SELECT to_regclass('parseable_backend') IS NOT NULL", &[])
            .await?
            .get(0);
        if !exists {
            ensure!(
                self.expected_id.is_none(),
                "pinned backend id requires an initialized database"
            );
            if let Some(marker) = &busy {
                ensure!(
                    opts.metadata_migration == Some(Action::Import)
                        && std::str::from_utf8(marker).is_ok_and(|s| s
                            .strip_prefix("Import:")
                            .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok())),
                    "another transfer owns migration marker"
                );
            }
            ensure!(
                pair.is_none(),
                "paired bucket requires its original database"
            );
            ensure!(
                opts.metadata_migration != Some(Action::Export),
                "export requires an imported database"
            );
            return Ok(());
        }
        let row = client
            .query_one(
                "SELECT id,bucket,schema_version,protocol_version FROM parseable_backend",
                &[],
            )
            .await?;
        let id: String = row.get(0);
        ensure!(
            row.get::<_, String>(1) == self.bucket
                && (0..=2).contains(&row.get::<_, i32>(2))
                && row.get::<_, i32>(3) == 1,
            "backend identity/version mismatch"
        );
        ensure!(
            self.expected_id.as_ref().is_none_or(|v| v == &id),
            "pinned backend mismatch"
        );
        ensure!(
            pair.as_ref().is_none_or(|v| v.as_ref() == id.as_bytes()),
            "bucket paired with another database"
        );
        ensure!(
            busy.as_ref()
                .is_none_or(|v| v.as_ref()
                    == format!("{:?}:{id}", opts.metadata_migration.unwrap()).as_bytes()),
            "another transfer owns migration marker"
        );
        if opts.metadata_migration == Some(Action::Export) {
            ensure!(
                pair.is_some() || busy.is_some(),
                "export requires paired bucket or interrupted export"
            );
        }
        let docs: bool = client
            .query_one("SELECT to_regclass('parseable_documents') IS NOT NULL", &[])
            .await?
            .get(0);
        if docs && opts.metadata_migration == Some(Action::Import) && !opts.abort {
            let count: i64 = client
                .query_one("SELECT count(*) FROM parseable_documents", &[])
                .await?
                .get(0);
            ensure!(
                count == 0 || busy.is_some(),
                "refusing import into nonempty database"
            );
        }
        Ok(())
    }

    async fn import_digest(
        &self,
        client: &super::postgres_client::Client,
        key: &str,
    ) -> anyhow::Result<Option<String>> {
        let exists: bool = client
            .query_one(
                "SELECT to_regclass('parseable_import_digests') IS NOT NULL",
                &[],
            )
            .await?
            .get(0);
        if !exists {
            return Ok(None);
        }
        Ok(client
            .query_opt(
                "SELECT digest FROM parseable_import_digests WHERE key=$1",
                &[&key],
            )
            .await?
            .map(|r| r.get(0)))
    }

    async fn validate_export_row(
        &self,
        client: &super::postgres_client::Client,
        key: &str,
        body: &Bytes,
    ) -> anyhow::Result<()> {
        use anyhow::ensure;
        ensure!(
            !key.ends_with(".deleting") && !key.contains(".tombstones/"),
            "unfinished deletion: {key}; start PostgreSQL mode and retry DELETE before export"
        );
        ensure!(
            super::migration::document_scope(key).is_some(),
            "unknown SQL document: {key}"
        );
        if key.ends_with("manifest.json") {
            crate::catalog::manifest::decode_manifest(body)?;
        } else if key.ends_with("stream.json") {
            for manifest_path in super::migration::stream_references(body)? {
                let base = self.storage.absolute_url(RelativePath::new(""));
                let normalized = manifest_path
                    .strip_prefix(base.as_ref())
                    .and_then(|p| p.strip_prefix('/'))
                    .unwrap_or(&manifest_path);
                let row = client
                    .query_opt(
                        "SELECT body FROM parseable_documents WHERE key=$1",
                        &[&normalized],
                    )
                    .await?;
                let row = row.ok_or_else(|| {
                    anyhow::anyhow!("{key}: missing SQL manifest {}", manifest_path)
                })?;
                crate::catalog::manifest::decode_manifest(&Bytes::from(row.get::<_, Vec<u8>>(0)))?;
            }
        } else if key.contains(".schema") {
            serde_json::from_slice::<arrow_schema::Schema>(body)?;
        } else {
            serde_json::from_slice::<serde_json::Value>(body)?;
        }
        Ok(())
    }

    pub(crate) async fn abort_migration(
        &self,
        store: &dyn ObjectStorage,
        action: super::migration::Action,
    ) -> anyhow::Result<()> {
        use super::migration::{Action, BUSY, optional};
        use anyhow::ensure;
        let client = self.client().await?;
        let exists: bool = client
            .query_one("SELECT to_regclass('parseable_transfer') IS NOT NULL", &[])
            .await?
            .get(0);
        let state = if exists {
            client
                .query_opt("SELECT state FROM parseable_transfer WHERE singleton", &[])
                .await?
                .map(|r| r.get::<_, String>(0))
        } else {
            None
        };
        match action {
            Action::Import => {
                let docs: bool = client
                    .query_one("SELECT to_regclass('parseable_documents') IS NOT NULL", &[])
                    .await?
                    .get(0);
                if docs {
                    let count: i64 = client
                        .query_one("SELECT count(*) FROM parseable_documents", &[])
                        .await?
                        .get(0);
                    ensure!(
                        count == 0,
                        "SQL contains committed documents; complete import and export instead of aborting"
                    );
                }
                ensure!(
                    state.is_none(),
                    "import committed; complete import, then export to return to bucket mode"
                );
            }
            Action::Export => {
                ensure!(
                    state.as_deref() == Some("ready"),
                    "export has begun writing; rerun export to finish; abort is unsafe"
                );
            }
            Action::Verify => anyhow::bail!("verify cannot be aborted"),
        }
        if optional(store, BUSY).await?.is_some() {
            store.delete_object(RelativePath::new(BUSY), &None).await?;
        }
        println!(
            "aborted safely; start {} mode",
            if action == Action::Import {
                "object-store"
            } else {
                "PostgreSQL"
            }
        );
        Ok(())
    }
}
