//! Offline document transfer. Bodies are processed one at a time; inventories hold keys only.
use super::postgres_documents::PostgresDocuments;
use crate::storage::{ObjectStorage, ObjectStorageError};
use anyhow::{Context, ensure};
use bytes::Bytes;
use relative_path::RelativePath;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, sync::Arc};

pub(crate) type InventoryDocument = (
    String,
    (String, &'static str),
    chrono::DateTime<chrono::Utc>,
);

pub const PAIR: &str = ".parseable/postgres-metastore-id";
pub const BUSY: &str = ".parseable/metastore-migration";

fn migration_help_requested() -> bool {
    std::env::args().any(|a| a == "--metadata-migration" || a.starts_with("--metadata-migration="))
}

#[derive(clap::Args, Debug, Default)]
pub struct MigrationOptions {
    /// Offline operation; requires the server and all other writers to be stopped.
    #[arg(long, value_enum)]
    pub metadata_migration: Option<Action>,
    #[arg(long, hide = !migration_help_requested(), requires = "metadata_migration")]
    pub acknowledge_server_stopped: bool,
    #[arg(
        long = "dry-run",
        visible_alias = "migration-dry-run",
        hide = !migration_help_requested(), requires = "metadata_migration"
    )]
    pub migration_dry_run: bool,
    /// Retired broad override; use the explicit bucket-change override instead.
    #[arg(long, hide = !migration_help_requested(), requires = "metadata_migration")]
    pub migration_force: bool,
    /// Explicitly authorize overwriting metadata changed by bucket writers since import.
    #[arg(long, hide = !migration_help_requested(), requires = "metadata_migration")]
    pub overwrite_bucket_changes_since_import: bool,
    #[arg(
        long,
        hide = !migration_help_requested(), requires = "metadata_migration",
        conflicts_with = "migration_dry_run"
    )]
    pub abort: bool,
    /// Permit missing snapshot manifests during import, retaining the dangling reference.
    #[arg(long, hide = !migration_help_requested(), requires = "metadata_migration")]
    pub allow_dangling_snapshot_references: bool,
    #[cfg(test)]
    #[arg(skip)]
    pub injected_failure: Option<&'static str>,
}
#[derive(clap::ValueEnum, Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Import,
    Export,
    Verify,
}

pub async fn optional(store: &dyn ObjectStorage, key: &str) -> anyhow::Result<Option<Bytes>> {
    match store.get_object(RelativePath::new(key), &None).await {
        Ok(b) => Ok(Some(b)),
        Err(ObjectStorageError::NoSuchKey(_)) => Ok(None),
        Err(ObjectStorageError::IoError(e)) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}
pub async fn guard(store: &dyn ObjectStorage, postgres: bool) -> anyhow::Result<()> {
    ensure!(
        optional(store, BUSY).await?.is_none(),
        "offline metadata migration incomplete; stop all writers and rerun the migration command"
    );
    if let Some(id) = optional(store, PAIR).await?
        && !postgres
    {
        ensure!(
            std::env::var("P_ALLOW_PAIRED_BUCKET").is_ok_and(|v| v.as_bytes() == id.as_ref()),
            "bucket paired with PostgreSQL; object-store metadata is stale. Export first, or explicitly set P_ALLOW_PAIRED_BUCKET=<pairing-id> for disaster recovery"
        );
    }
    Ok(())
}

pub fn digest(body: &[u8]) -> String {
    format!("{:x}", Sha256::digest(body))
}

pub(crate) use super::document_metastore::document_scope;

pub(crate) fn stream_references(body: &[u8]) -> anyhow::Result<Vec<String>> {
    let value: serde_json::Value = serde_json::from_slice(body)?;
    if matches!(value["version"].as_str(), Some("v1" | "v2" | "v3")) {
        let list = value
            .pointer("/snapshot/manifest_list")
            .and_then(|v| v.as_array());
        return list
            .into_iter()
            .flatten()
            .map(|v| {
                v["manifest_path"]
                    .as_str()
                    .map(str::to_owned)
                    .context("legacy snapshot has invalid manifest path")
            })
            .collect();
    }
    let config: crate::storage::ObjectStoreFormat = serde_json::from_value(value)?;
    Ok(config
        .snapshot
        .manifest_list
        .into_iter()
        .map(|m| m.manifest_path)
        .collect())
}

pub(crate) async fn validate(
    store: &dyn ObjectStorage,
    key: &str,
    body: &Bytes,
) -> anyhow::Result<()> {
    if key.ends_with("manifest.json") {
        crate::catalog::manifest::decode_manifest(body)?;
    } else if key.ends_with("stream.json") {
        for manifest_path in stream_references(body).with_context(|| key.to_owned())? {
            let bytes = store
                .get_object(RelativePath::new(&manifest_path), &None)
                .await
                .with_context(|| format!("{key}: missing manifest {manifest_path}"))?;
            crate::catalog::manifest::decode_manifest(&bytes)?;
        }
    } else if key.contains(".schema") {
        serde_json::from_slice::<arrow_schema::Schema>(body).with_context(|| key.to_owned())?;
    }
    ensure!(
        !key.ends_with(".deleting") && !key.contains(".tombstones/"),
        "unfinished deletion: {key}"
    );
    Ok(())
}

pub async fn run(
    store: Arc<dyn ObjectStorage>,
    db: &PostgresDocuments,
    opts: &MigrationOptions,
) -> anyhow::Result<()> {
    let action = opts.metadata_migration.context("missing operation")?;
    ensure!(
        !opts.migration_force,
        "--migration-force is retired: normal rollback needs no flag; to overwrite metadata changed by bucket writers use --overwrite-bucket-changes-since-import after backup"
    );
    ensure!(
        opts.acknowledge_server_stopped,
        "requires --acknowledge-server-stopped; stop ALL servers and writers first"
    );
    eprintln!("OFFLINE migration: all servers must remain stopped. No writer fencing exists.");
    db.migration_preflight(store.as_ref(), opts).await?;
    if opts.abort {
        return db.abort_migration(store.as_ref(), action).await;
    }
    let inventory = store.metadata_inventory().await?;
    let mut skipped = 0;
    for (key, _) in &inventory {
        if document_scope(key).is_none() {
            skipped += 1;
            eprintln!("skipped key={key}");
        }
        if key.starts_with(".parseable-metadata-locks/") && key.ends_with(".lock") {
            continue;
        }
        for component in key.split('/').filter(|p| p.starts_with('.')) {
            ensure!(
                matches!(
                    component,
                    ".parseable"
                        | ".users"
                        | ".alerts"
                        | ".targets"
                        | ".settings"
                        | ".correlations"
                        | ".stream"
                        | ".dashboard-titles"
                        | ".dashboard-locators"
                        | ".dashboard-locations"
                        | ".parseable.json"
                        | ".schema"
                        | ".stream.json"
                ) || component.starts_with(".ingestor.")
                    || component.starts_with(".querier."),
                "unknown hidden metadata key: {key}"
            );
        }
    }
    eprintln!("skipped keys: {skipped}");
    let keys: Vec<_> = inventory
        .iter()
        .filter_map(|(k, modified)| document_scope(k).map(|scope| (k.clone(), scope, *modified)))
        .collect();
    let mut counts = BTreeMap::<(String, String), (usize, usize)>::new();
    for (key, (tenant, kind), modified) in &keys {
        let body = store.get_object(RelativePath::new(key), &None).await?;
        if action != Action::Export {
            match validate(store.as_ref(), key, &body).await {
                Err(e)
                    if opts.allow_dangling_snapshot_references
                        && e.to_string().contains("missing manifest") =>
                {
                    eprintln!("OVERRIDE dangling snapshot reference: {e:#}")
                }
                result => result?,
            }
        }
        if chrono::Utc::now()
            .signed_duration_since(*modified)
            .num_seconds()
            < 120
        {
            eprintln!("WARNING recently modified metadata (possible active writer): {key}");
        }
        let count = counts
            .entry((tenant.clone(), kind.to_string()))
            .or_default();
        count.0 += 1;
        count.1 += body.len();
        println!(
            "bucket tenant={tenant:?} kind={kind} key={key} bytes={} sha256={}",
            body.len(),
            digest(&body)
        );
    }
    eprintln!("counts by (tenant, kind): {counts:?}");
    // Dry-run never bootstraps SQL or writes a bucket marker.
    if opts.migration_dry_run {
        return Ok(());
    }
    db.migrate(store, opts, &keys).await
}

pub(crate) fn failure_point(opts: &MigrationOptions, step: &str) -> anyhow::Result<()> {
    #[cfg(test)]
    anyhow::ensure!(
        opts.injected_failure != Some(step),
        "injected failure: {step}"
    );
    #[cfg(not(test))]
    let _ = (opts, step);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{metastore::metastores::postgres_metastore::PostgresOptions, storage::LocalFS};

    #[test]
    fn inventory_scope_preserves_all_document_namespaces() {
        for (key, tenant, kind) in [
            (".parseable.json", "", "document"),
            ("logs/.stream.json", "", "stream"),
            ("logs/.schema", "", "schema"),
            ("tenant/logs/.stream.json", "tenant", "stream"),
            ("tenant/logs/.schema", "tenant", "schema"),
            ("tenant/.parseable.json", "tenant", "document"),
            ("logs/.stream/.ingestor.node.stream.json", "", "stream"),
            (
                "tenant/logs/.stream/.ingestor.node.schema",
                "tenant",
                "schema",
            ),
            (
                "tenant/logs/date=2026-01-01/ingestor.node.manifest.json",
                "tenant",
                "manifest",
            ),
            (
                "logs/date=2026-01-01/ingestor.node.manifest.json",
                "",
                "manifest",
            ),
            (
                "tenant/.users/owner/.dashboard-titles/key.json",
                "tenant",
                "document",
            ),
            (".parseable/ingestor.node.json", "", "document"),
        ] {
            assert_eq!(
                document_scope(key),
                Some((tenant.to_owned(), kind)),
                "{key}"
            );
        }
        for key in [PAIR, BUSY, "logs/date=2026-01-01/data.parquet"] {
            assert!(document_scope(key).is_none());
        }
    }

    #[tokio::test]
    async fn invalid_stream_and_missing_snapshot_manifest_fail_before_writes() {
        let root = tempfile::tempdir().unwrap();
        let store = LocalFS::new(root.path().to_owned());
        assert!(
            validate(
                &store,
                "logs/.stream/.stream.json",
                &Bytes::from_static(b"{}")
            )
            .await
            .is_err()
        );
        let mut config = crate::storage::ObjectStoreFormat::default();
        config
            .snapshot
            .manifest_list
            .push(crate::catalog::snapshot::ManifestItem {
                manifest_path: "logs/date=2026-01-01/ingestor.missing.manifest.json".into(),
                time_lower_bound: chrono::Utc::now(),
                time_upper_bound: chrono::Utc::now(),
                events_ingested: 0,
                ingestion_size: 0,
                storage_size: 0,
            });
        assert!(
            validate(
                &store,
                "logs/.stream/.stream.json",
                &Bytes::from(serde_json::to_vec(&config).unwrap())
            )
            .await
            .is_err()
        );
        assert!(optional(&store, BUSY).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn minio_metadata_inventory_encoding_and_scale() -> anyhow::Result<()> {
        let Ok(endpoint) = std::env::var("P_TEST_REVIEW_S3_URL") else {
            eprintln!("SKIP MinIO inventory: P_TEST_REVIEW_S3_URL unset");
            return Ok(());
        };
        if std::env::var_os("P_MINIO_INVENTORY_CHILD").is_none() {
            let output=std::process::Command::new(std::env::current_exe()?).args(["--exact","metastore::metastores::migration::tests::minio_metadata_inventory_encoding_and_scale","--nocapture"]).env("P_MINIO_INVENTORY_CHILD","1").output()?;
            anyhow::ensure!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stdout).to_string()
                    + &String::from_utf8_lossy(&output.stderr)
            );
            return Ok(());
        }
        use crate::storage::ObjectStorageProvider;
        use clap::Parser;
        #[derive(clap::Parser)]
        struct Args {
            #[command(flatten)]
            storage: crate::storage::S3Config,
        }
        let provider = Args::parse_from([
            "test",
            "--endpoint-url",
            &endpoint,
            "--region",
            "us-east-1",
            "--bucket-name",
            "review",
            "--access-key-id",
            "minioadmin",
            "--secret-key",
            "minioadmin",
        ])
        .storage;
        let store = provider.construct_client();
        let date = format!("date=2026-01-01-{}", uuid::Uuid::new_v4().simple());
        let manifest_key = format!("café/{date}/manifest.json");
        for key in [
            "café/.stream/.schema",
            ".users/auth0|é/filters/one.json",
            manifest_key.as_str(),
        ] {
            store
                .put_object(RelativePath::new(key), Bytes::from_static(b"{}"), &None)
                .await?;
        }
        let counter = || {
            crate::metrics::STORAGE_REQUEST_RESPONSE_TIME
                .with_label_values(&["s3", "LIST_DELIM", "200"])
                .get_sample_count()
        };
        let n = counter();
        let before = store.metadata_inventory().await?;
        let requests = counter() - n;
        for i in 0..100 {
            store
                .put_object(
                    RelativePath::new(&format!("café/{date}/hour=00/minute={i}/data.parquet")),
                    Bytes::new(),
                    &None,
                )
                .await?;
        }
        let n = counter();
        let after = store.metadata_inventory().await?;
        assert_eq!(
            requests,
            counter() - n,
            "parquet files must not add inventory requests"
        );
        assert_eq!(before, after);
        for (key, _) in after {
            store.get_object(RelativePath::new(&key), &None).await?;
        }
        Ok(())
    }

    #[tokio::test]
    async fn migration_round_trip_postgres() -> anyhow::Result<()> {
        let Ok(url) = std::env::var("P_TEST_POSTGRES_URL") else {
            eprintln!("skip migration PostgreSQL test: P_TEST_POSTGRES_URL unset");
            return Ok(());
        };
        let root = tempfile::tempdir()?;
        let store: Arc<dyn ObjectStorage> =
            if let Ok(endpoint) = std::env::var("P_TEST_REVIEW_S3_URL") {
                use crate::storage::ObjectStorageProvider;
                use clap::Parser;
                #[derive(clap::Parser)]
                struct Args {
                    #[command(flatten)]
                    storage: crate::storage::S3Config,
                }
                Args::parse_from([
                    "test",
                    "--endpoint-url",
                    &endpoint,
                    "--region",
                    "us-east-1",
                    "--bucket-name",
                    "migration-unit",
                    "--access-key-id",
                    "minioadmin",
                    "--secret-key",
                    "minioadmin",
                ])
                .storage
                .construct_client()
            } else {
                eprintln!("SKIP MinIO round trip: P_TEST_REVIEW_S3_URL unset; exercising LocalFS");
                Arc::new(LocalFS::new(root.path().to_owned()))
            };
        let options = PostgresOptions {
            metastore_postgres_url: Some(url.clone()),
            ..Default::default()
        };
        let admin = PostgresDocuments::new(&options, "test".into(), store.clone())?;
        let schema = format!("migration_{}", uuid::Uuid::new_v4().simple());
        admin
            .client()
            .await?
            .batch_execute(&format!("CREATE DATABASE {schema}"))
            .await?;
        let result = async {
            let mut url = url::Url::parse(&url)?;
            url.set_path(&format!("/{schema}"));
            let opts = PostgresOptions {
                metastore_postgres_url: Some(url.to_string()),
                ..Default::default()
            };
            let db = PostgresDocuments::new(&opts, "test".into(), store.clone())?;
            let plain = Bytes::from(serde_json::to_vec(
                &crate::catalog::manifest::Manifest::default(),
            )?);
            let compressed = crate::catalog::manifest::encode_manifest(
                &crate::catalog::manifest::Manifest::default(),
            )?;
            let mut documents = vec![
                (
                    ".parseable.json".to_owned(),
                    Bytes::from_static(b"{ \"users\":[], \"roles\":{} }\n"),
                ),
                (
                    "café/date=2026-01-01/ingestor.one.manifest.json".into(),
                    plain,
                ),
                (
                    "tenant/logs/date=2026-01-01/ingestor.two.manifest.json".into(),
                    compressed,
                ),
            ];
            let mut config = crate::storage::ObjectStoreFormat::default();
            config
                .snapshot
                .manifest_list
                .push(crate::catalog::snapshot::ManifestItem {
                    manifest_path: if store.store_url().scheme() == "file" {
                        store
                            .absolute_url(RelativePath::new(&documents[1].0))
                            .to_string()
                    } else {
                        documents[1].0.clone()
                    },
                    time_lower_bound: chrono::Utc::now(),
                    time_upper_bound: chrono::Utc::now(),
                    events_ingested: 0,
                    ingestion_size: 0,
                    storage_size: 0,
                });
            documents.push((
                "café/.stream/.ingestor.one.stream.json".into(),
                Bytes::from(serde_json::to_vec(&config)?),
            ));
            for prefix in [
                ".users/auth0|é/dashboards",
                ".users/owner/filters",
                ".alerts",
                ".targets",
                ".settings",
                ".parseable",
                ".correlations",
            ] {
                for tenant in ["", "tenant/"] {
                    documents.push((
                        format!("{tenant}{prefix}/fixture.json"),
                        Bytes::from_static(b"{\"unknown\":true} \n"),
                    ));
                }
            }
            for (key, body) in &documents {
                store
                    .put_object(RelativePath::new(key), body.clone(), &None)
                    .await?;
            }
            let mut command = MigrationOptions {
                metadata_migration: Some(Action::Import),
                acknowledge_server_stopped: true,
                migration_dry_run: true,
                migration_force: false,
                ..Default::default()
            };
            let pinned_options = PostgresOptions {
                metastore_postgres_id: Some("wrong-id".into()),
                ..opts.clone()
            };
            let pinned = PostgresDocuments::new(&pinned_options, "test".into(), store.clone())?;
            assert!(
                run(store.clone(), &pinned, &command)
                    .await
                    .unwrap_err()
                    .to_string()
                    .contains("pinned backend")
            );
            run(store.clone(), &db, &command).await?;
            assert!(optional(store.as_ref(), PAIR).await?.is_none());
            command.migration_dry_run = false;
            command.injected_failure = Some("marker");
            assert!(run(store.clone(), &db, &command).await.is_err());
            command.abort = true;
            run(store.clone(), &db, &command).await?;
            store.check_migration_guard().await?;
            command.abort = false;
            for step in [
                "marker",
                "spool",
                "import-before-commit",
                "import-commit",
                "paired",
            ] {
                command.injected_failure = Some(step);
                assert!(run(store.clone(), &db, &command).await.is_err(), "{step}");
            }
            command.injected_failure = None;
            command.abort = true;
            assert!(
                run(store.clone(), &db, &command).await.is_err(),
                "committed import cannot abort"
            );
            command.abort = false;
            run(store.clone(), &db, &command).await?;
            assert!(store.check_migration_guard().await.is_err());
            assert!(run(store.clone(), &db, &command).await.is_err());
            command.metadata_migration = Some(Action::Verify);
            run(store.clone(), &db, &command).await?;
            // Simulate crash after committed import, before marker cleanup.
            let id = optional(store.as_ref(), PAIR).await?.unwrap();
            store
                .put_object(
                    RelativePath::new(BUSY),
                    Bytes::from(format!("Import:{}", std::str::from_utf8(&id)?)),
                    &None,
                )
                .await?;
            command.metadata_migration = Some(Action::Import);
            run(store.clone(), &db, &command).await?;
            // Invalid SQL documents must fail before a marker or destination write.
            db.put_object(
                RelativePath::new("broken/.stream/.deleting"),
                Bytes::new(),
                &None,
            )
            .await?;
            command.metadata_migration = Some(Action::Export);
            assert!(run(store.clone(), &db, &command).await.is_err());
            assert!(optional(store.as_ref(), BUSY).await?.is_none());
            db.delete_object(RelativePath::new("broken/.stream/.deleting"), &None)
                .await?;
            // Bucket writers require explicit overwrite acknowledgement on export.
            store
                .put_object(
                    RelativePath::new(&documents[0].0),
                    Bytes::from_static(b"changed"),
                    &None,
                )
                .await?;
            command.metadata_migration = Some(Action::Export);
            assert!(run(store.clone(), &db, &command).await.is_err());
            // Restore the imported bucket body; SQL edits must then export without force.
            store
                .put_object(
                    RelativePath::new(&documents[0].0),
                    documents[0].1.clone(),
                    &None,
                )
                .await?;
            documents[0].1 = Bytes::from_static(b"{\"users\":[],\"roles\":{},\"updated\":true}");
            db.put_object(
                RelativePath::new(&documents[0].0),
                documents[0].1.clone(),
                &None,
            )
            .await?;
            let deleted = documents.pop().unwrap().0;
            let deleted_tenant = document_scope(&deleted).unwrap().0;
            db.delete_object(RelativePath::new(&deleted), &Some(deleted_tenant))
                .await?;
            for step in [
                "marker",
                "export-state",
                "object-write",
                "bucket-delete",
                "pair-removed",
            ] {
                command.injected_failure = Some(step);
                assert!(run(store.clone(), &db, &command).await.is_err(), "{step}");
                command.abort = true;
                if step == "marker" {
                    run(store.clone(), &db, &command).await?;
                    let restarted = PostgresDocuments::new(&opts, "test".into(), store.clone())?;
                    restarted.check(&None).await?;
                } else {
                    assert!(
                        run(store.clone(), &db, &command).await.is_err(),
                        "export after {step} cannot abort"
                    );
                }
                command.abort = false;
            }
            command.injected_failure = None;
            run(store.clone(), &db, &command).await?;
            assert!(optional(store.as_ref(), PAIR).await?.is_none());
            store.check_migration_guard().await?;
            assert!(optional(store.as_ref(), &deleted).await?.is_none());
            for (key, body) in documents {
                assert_eq!(
                    store.get_object(RelativePath::new(&key), &None).await?,
                    body,
                    "byte-for-byte round trip: {key}"
                );
            }
            command.metadata_migration = Some(Action::Verify);
            run(store.clone(), &db, &command).await?;
            assert!(
                db.check(&None).await.is_err(),
                "exported database must not auto-pair"
            );
            anyhow::Ok(())
        }
        .await;
        admin
            .client()
            .await?
            .batch_execute(&format!("DROP DATABASE {schema} WITH (FORCE)"))
            .await?;
        result
    }
}
