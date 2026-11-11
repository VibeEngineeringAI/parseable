super::document_metastore::document_metastore!(
    PostgresMetastore,
    super::postgres_documents::PostgresDocuments,
    false,
    {
        async fn manifest_batch(
            &self,
            paths: &[String],
            tenant: &Option<String>,
        ) -> Result<Option<HashMap<String, Option<Manifest>>>, MetastoreError> {
            let mut result: HashMap<String, Option<Manifest>> =
                paths.iter().map(|p| (p.clone(), None)).collect();
            let chunks = self.storage.manifest_chunks(paths, tenant);
            futures::pin_mut!(chunks);
            while let Some(rows) = chunks.try_next().await? {
                for (key, body) in rows {
                    result.insert(key, Some(decode_manifest_blocking(body).await?));
                }
            }
            Ok(Some(result))
        }
        async fn metadata_dates(
            &self,
            stream: &str,
            tenant: &Option<String>,
        ) -> Result<Vec<String>, MetastoreError> {
            let path = crate::storage::object_storage::stream_data_path(stream, &[], tenant);
            Ok(self.storage.list_dirs_relative(&path, tenant).await?)
        }
        async fn check_health(&self, tenant_id: &Option<String>) -> Result<(), MetastoreError> {
            Ok(self.storage.check_health(tenant_id).await?)
        }

        async fn read_latency(&self, tenant_id: &Option<String>) -> std::time::Duration {
            self.storage.read_latency(tenant_id).await
        }

        async fn stream_exists(
            &self,
            stream_name: &str,
            tenant_id: &Option<String>,
        ) -> Result<bool, MetastoreError> {
            Ok(self.storage.stream_exists(stream_name, tenant_id).await?)
        }

        async fn is_stream_deleting(
            &self,
            stream_name: &str,
            tenant_id: &Option<String>,
        ) -> Result<bool, MetastoreError> {
            Ok(self
                .storage
                .is_stream_deleting(stream_name, tenant_id)
                .await?)
        }

        async fn delete_stream(
            &self,
            stream_name: &str,
            tenant_id: &Option<String>,
        ) -> Result<(), MetastoreError> {
            Ok(self.storage.delete_stream(stream_name, tenant_id).await?)
        }

        async fn delete_stream_partition(
            &self,
            stream_name: &str,
            date: &str,
            tenant_id: &Option<String>,
        ) -> Result<(), MetastoreError> {
            let path =
                crate::storage::object_storage::stream_data_path(stream_name, &[date], tenant_id);
            Ok(self.storage.delete_partition(&path, tenant_id).await?)
        }

        async fn list_tenant_candidates(&self) -> Result<Vec<String>, MetastoreError> {
            Ok(self.storage.list_tenant_candidates().await?)
        }
    }
);

// Parse tuning as text first: whether it is meaningful depends on the parsed URL,
// including CLI overrides of environment values. Do not inspect process argv.
#[derive(clap::Args)]
struct PostgresArguments {
    /// Opt in to PostgreSQL metadata. Never falls back to bucket metadata.
    #[arg(long, env = "P_METASTORE_POSTGRES_URL", hide_env_values = true)]
    pub metastore_postgres_url: Option<String>,
    #[arg(long, env = "P_METASTORE_POSTGRES_POOL_SIZE", default_value = "16")]
    pub metastore_postgres_pool_size: String,
    #[arg(
        long,
        env = "P_METASTORE_POSTGRES_CONNECT_TIMEOUT_MS",
        default_value = "5000"
    )]
    pub metastore_postgres_connect_timeout_ms: String,
    #[arg(
        long,
        env = "P_METASTORE_POSTGRES_STATEMENT_TIMEOUT_MS",
        default_value = "10000"
    )]
    pub metastore_postgres_statement_timeout_ms: String,
    /// Optionally pin a previously initialized backend UUID.
    #[arg(long, env = "P_METASTORE_POSTGRES_ID")]
    pub metastore_postgres_id: Option<String>,
    /// Optional PEM CA bundle. TLS mode is controlled by sslmode in the URL.
    #[arg(long, env = "P_METASTORE_POSTGRES_CA")]
    pub metastore_postgres_ca: Option<std::path::PathBuf>,
}

#[derive(Clone)]
pub struct PostgresOptions {
    pub metastore_postgres_url: Option<String>,
    pub metastore_postgres_pool_size: u32,
    pub metastore_postgres_connect_timeout_ms: u64,
    pub metastore_postgres_statement_timeout_ms: u64,
    pub metastore_postgres_id: Option<String>,
    pub metastore_postgres_ca: Option<std::path::PathBuf>,
}
impl clap::Args for PostgresOptions {
    fn augment_args(cmd: clap::Command) -> clap::Command {
        PostgresArguments::augment_args(cmd)
    }
    fn augment_args_for_update(cmd: clap::Command) -> clap::Command {
        PostgresArguments::augment_args_for_update(cmd)
    }
}
impl TryFrom<PostgresArguments> for PostgresOptions {
    type Error = clap::Error;
    fn try_from(raw: PostgresArguments) -> Result<Self, Self::Error> {
        let mut options = Self {
            metastore_postgres_url: raw.metastore_postgres_url.filter(|v| !v.trim().is_empty()),
            metastore_postgres_id: raw.metastore_postgres_id,
            metastore_postgres_ca: raw.metastore_postgres_ca,
            ..Default::default()
        };
        fn positive<T: std::str::FromStr + Default + PartialEq>(
            value: &str,
            name: &str,
        ) -> Result<T, clap::Error> {
            value
                .parse::<T>()
                .ok()
                .filter(|v| *v != T::default())
                .ok_or_else(|| {
                    clap::Error::raw(
                        clap::error::ErrorKind::ValueValidation,
                        format!("{name} must be a positive integer"),
                    )
                })
        }
        if options.enabled() {
            options.metastore_postgres_pool_size =
                positive(&raw.metastore_postgres_pool_size, "PostgreSQL pool size")?;
            options.metastore_postgres_connect_timeout_ms = positive(
                &raw.metastore_postgres_connect_timeout_ms,
                "PostgreSQL connect timeout",
            )?;
            options.metastore_postgres_statement_timeout_ms = positive(
                &raw.metastore_postgres_statement_timeout_ms,
                "PostgreSQL statement timeout",
            )?;
        }
        Ok(options)
    }
}
impl clap::FromArgMatches for PostgresOptions {
    fn from_arg_matches(matches: &clap::ArgMatches) -> Result<Self, clap::Error> {
        PostgresArguments::from_arg_matches(matches)?.try_into()
    }
    fn update_from_arg_matches(&mut self, matches: &clap::ArgMatches) -> Result<(), clap::Error> {
        let mut raw = PostgresArguments {
            metastore_postgres_url: self.metastore_postgres_url.clone(),
            metastore_postgres_pool_size: self.metastore_postgres_pool_size.to_string(),
            metastore_postgres_connect_timeout_ms: self
                .metastore_postgres_connect_timeout_ms
                .to_string(),
            metastore_postgres_statement_timeout_ms: self
                .metastore_postgres_statement_timeout_ms
                .to_string(),
            metastore_postgres_id: self.metastore_postgres_id.clone(),
            metastore_postgres_ca: self.metastore_postgres_ca.clone(),
        };
        raw.update_from_arg_matches(matches)?;
        *self = raw.try_into()?;
        Ok(())
    }
}

impl std::fmt::Debug for PostgresOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PostgresOptions")
            .field("enabled", &self.enabled())
            .finish_non_exhaustive()
    }
}
impl PostgresOptions {
    pub fn enabled(&self) -> bool {
        self.metastore_postgres_url
            .as_deref()
            .is_some_and(|v| !v.trim().is_empty())
    }
}
impl Default for PostgresOptions {
    fn default() -> Self {
        Self {
            metastore_postgres_url: None,
            metastore_postgres_pool_size: 16,
            metastore_postgres_connect_timeout_ms: 5000,
            metastore_postgres_statement_timeout_ms: 10000,
            metastore_postgres_id: None,
            metastore_postgres_ca: None,
        }
    }
}

/// Construct offline transfer using the same provider and SQL options as the server.
pub async fn run_migration(
    provider: &dyn crate::storage::ObjectStorageProvider,
    options: &crate::cli::Options,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        options.postgres.enabled(),
        "P_METASTORE_POSTGRES_URL is required"
    );
    anyhow::ensure!(
        std::env::var_os("P_STAGING_DIR").is_some()
            || std::env::args()
                .any(|a| a == "--local-staging-path" || a.starts_with("--local-staging-path=")),
        "migration requires explicit P_STAGING_DIR or --local-staging-path"
    );
    // Staging metadata alone is normal; event buffers must have uploaded first.
    let staging = options.local_staging_path.canonicalize().map_err(|e| {
        anyhow::anyhow!(
            "staging directory must exist ({}): {e}",
            options.local_staging_path.display()
        )
    })?;
    anyhow::ensure!(staging.is_dir(), "staging path must be a directory");
    eprintln!("Resolved staging directory: {}", staging.display());
    eprintln!(
        "Environment file: {}",
        crate::interactive::loaded_env_path()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|| "none (explicit environment/CLI only)".into())
    );
    let mut dirs = vec![staging];
    while let Some(dir) = dirs.pop() {
        if !dir.exists() {
            continue;
        }
        for entry in std::fs::read_dir(dir)? {
            let path = entry?.path();
            if path.is_dir() {
                dirs.push(path);
            } else if path
                .extension()
                .is_some_and(|e| e == "arrows" || e == "parquet" || e == "arrow" || e == "part")
            {
                anyhow::bail!("unsynced staging data: {}", path.display());
            }
        }
    }
    let storage = provider.construct_client();
    let db = super::postgres_documents::PostgresDocuments::new(
        &options.postgres,
        provider.get_endpoint(),
        storage.clone(),
    )?;
    super::migration::run(storage, &db, &options.migration).await
}

#[cfg(test)]
mod contract_tests {
    use super::*;
    use crate::{
        metastore::metastore_traits::*,
        storage::{LocalFS, ObjectStorage},
    };
    use bytes::Bytes;
    use std::sync::Arc;

    fn test_dir() -> tempfile::TempDir {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(".postgres-smoke/unit");
        std::fs::create_dir_all(&root).unwrap();
        tempfile::tempdir_in(root).unwrap()
    }

    #[derive(serde::Serialize)]
    struct Document {
        id: String,
        path: String,
        value: String,
    }
    impl MetastoreObject for Document {
        fn get_object_path(&self) -> String {
            self.path.clone()
        }
        fn get_object_id(&self) -> String {
            self.id.clone()
        }
    }
    fn initialize_context() {
        fn factory() -> crate::parseable::Parseable {
            use crate::storage::object_storage::ObjectStorageProvider;
            let startup_root = std::env::var("P_CONTRACT_STARTUP_ROOT").ok();
            let root = startup_root
                .as_ref()
                .map(std::path::PathBuf::from)
                .or_else(|| {
                    std::env::var("P_CONTRACT_CONTEXT_ROOT")
                        .ok()
                        .map(std::path::PathBuf::from)
                })
                .unwrap_or_else(|| test_dir().path().to_owned());
            let provider = Arc::new(crate::storage::FSConfig { root });
            let storage = provider.construct_client();
            let mut options = crate::cli::Options::default();
            let metastore: Arc<dyn Metastore> = if startup_root.is_some() {
                options.multi_tenancy = true;
                options.postgres.metastore_postgres_url =
                    Some(std::env::var("P_CONTRACT_STARTUP_URL").unwrap());
                options.postgres.metastore_postgres_statement_timeout_ms =
                    if std::env::var("P_CONTRACT_STARTUP_FAILURE").as_deref() == Ok("none") {
                        500
                    } else {
                        5000
                    };
                Arc::new(PostgresMetastore {
                    storage: Arc::new(
                        super::super::postgres_documents::PostgresDocuments::new(
                            &options.postgres,
                            std::env::var("P_CONTRACT_STARTUP_BUCKET").unwrap(),
                            storage.clone(),
                        )
                        .unwrap(),
                    ),
                })
            } else {
                Arc::new(super::super::object_store_metastore::ObjectStoreMetastore {
                    storage: storage.clone(),
                })
            };
            let context = crate::parseable::Parseable::new(
                options,
                #[cfg(feature = "kafka")]
                <crate::connectors::kafka::config::KafkaConfig as clap::Parser>::parse_from([
                    "contract",
                ]),
                provider,
                metastore,
                storage,
            );
            if startup_root.is_none() {
                *context.tenants.write().unwrap() = vec![String::new(), "tenant-contract".into()];
            }
            context
        }
        let _ = crate::parseable::CONTRACT_PARSEABLE_FACTORY.set(factory);
        once_cell::sync::Lazy::force(&crate::parseable::PARSEABLE);
    }
    async fn contract(store: Arc<dyn Metastore>, sql: bool) {
        initialize_context();
        store.initiate_connection().await.unwrap();
        for tenant in [None, Some("tenant-contract".to_owned())] {
            let root = tenant.as_ref().map(|t| format!("{t}/")).unwrap_or_default();
            let object = Document {
                id: ulid::Ulid::new().to_string(),
                path: format!("{root}.users/owner/dashboards/space %_é'.json"),
                value: format!("faithful bytes-{root}"),
            };
            store.put_dashboard(&object, &tenant).await.unwrap();
            let dashboards = store.get_tenant_dashboards(&tenant).await.unwrap();
            assert_eq!(
                dashboards,
                vec![crate::storage::object_storage::to_bytes(&object)]
            );
            let read = store
                .get_dashboard_versioned(&object.path, &tenant)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(read.bytes, dashboards[0]);
            assert!(matches!(
                store
                    .put_dashboard_conditional(
                        &object.path,
                        Bytes::new(),
                        MetadataWriteCondition::Create,
                        &tenant
                    )
                    .await,
                Err(ConditionalMetadataError::Conflict)
            ));
            let next = store
                .put_dashboard_conditional(
                    &object.path,
                    Bytes::from_static(b"new"),
                    MetadataWriteCondition::Update(read.version.clone()),
                    &tenant,
                )
                .await
                .unwrap();
            assert!(matches!(
                store
                    .put_dashboard_conditional(
                        &object.path,
                        Bytes::new(),
                        MetadataWriteCondition::Update(read.version.clone()),
                        &tenant
                    )
                    .await,
                Err(ConditionalMetadataError::Conflict)
            ));
            assert!(matches!(
                store
                    .delete_dashboard_conditional(&object.path, read.version.clone(), &tenant)
                    .await,
                Err(ConditionalMetadataError::Conflict)
            ));
            store
                .delete_dashboard_conditional(&object.path, next, &tenant)
                .await
                .unwrap();
            assert!(
                store
                    .get_dashboard_versioned(&object.path, &tenant)
                    .await
                    .unwrap()
                    .is_none()
            );
            // Concurrent creates have exactly one winner.
            let writes = (0..12).map(|_| {
                store.put_dashboard_conditional(
                    &object.path,
                    Bytes::from_static(b"{}"),
                    MetadataWriteCondition::Create,
                    &tenant,
                )
            });
            let results = futures::future::join_all(writes).await;
            assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
            assert_eq!(
                results
                    .iter()
                    .filter(|r| matches!(r, Err(ConditionalMetadataError::Conflict)))
                    .count(),
                11
            );
            let recreated = store
                .get_dashboard_versioned(&object.path, &tenant)
                .await
                .unwrap()
                .unwrap();
            assert!(matches!(
                store
                    .put_dashboard_conditional(
                        &object.path,
                        Bytes::from_static(b"stale"),
                        MetadataWriteCondition::Update(read.version.clone()),
                        &tenant
                    )
                    .await,
                Err(ConditionalMetadataError::Conflict)
            ));
            let updates = (0..12).map(|i| {
                store.put_dashboard_conditional(
                    &object.path,
                    Bytes::from(i.to_string()),
                    MetadataWriteCondition::Update(recreated.version.clone()),
                    &tenant,
                )
            });
            let updates = futures::future::join_all(updates).await;
            assert_eq!(updates.iter().filter(|r| r.is_ok()).count(), 1);
            assert_eq!(
                updates
                    .iter()
                    .filter(|r| matches!(r, Err(ConditionalMetadataError::Conflict)))
                    .count(),
                11
            );
            let winner = updates.iter().position(Result::is_ok).unwrap();
            assert_eq!(
                store
                    .get_dashboard_versioned(&object.path, &tenant)
                    .await
                    .unwrap()
                    .unwrap()
                    .bytes,
                Bytes::from(winner.to_string())
            );
            store.delete_dashboard(&object, &tenant).await.unwrap();
            assert!(
                store
                    .get_tenant_dashboards(&tenant)
                    .await
                    .unwrap()
                    .is_empty()
            );
            store.put_keystone(&object, &tenant).await.unwrap();
            store.put_conversation(&object, &tenant).await.unwrap();
            let objects = store
                .get_objects(&format!("{root}.keystone"), &tenant)
                .await
                .unwrap();
            assert_eq!(
                objects,
                vec![crate::storage::object_storage::to_bytes(&object); 2]
            );
            store.delete_keystone(&object, &tenant).await.unwrap();
            store.delete_conversation(&object, &tenant).await.unwrap();
            store.put_llmconfig(&object, &tenant).await.unwrap();
            store.delete_llmconfig(&object, &tenant).await.unwrap();
            store.put_target(&object, &tenant).await.unwrap();
            store.delete_target(&object, &tenant).await.unwrap();
            store.put_chat(&object, &tenant).await.unwrap();
            store.delete_chat(&object, &tenant).await.unwrap();
            assert!(
                store
                    .get_alert_state_entry(&ulid::Ulid::new(), &tenant)
                    .await
                    .unwrap()
                    .is_none()
            );
            assert!(store.get_mttr_history(&tenant).await.unwrap().is_none());
            assert!(
                store
                    .get_all_stream_jsons(
                        "absent",
                        Some(crate::option::Mode::Query),
                        &tenant,
                        false
                    )
                    .await
                    .is_err()
            );
            let directory_marker = Document {
                id: object.id.clone(),
                path: format!("{root}absent/.stream/placeholder"),
                value: String::new(),
            };
            store
                .put_dashboard(&directory_marker, &tenant)
                .await
                .unwrap();
            store
                .delete_dashboard(&directory_marker, &tenant)
                .await
                .unwrap();
            assert!(
                store
                    .get_all_stream_jsons(
                        "absent",
                        Some(crate::option::Mode::Ingest),
                        &tenant,
                        false
                    )
                    .await
                    .unwrap()
                    .is_empty()
            );
            assert!(
                store
                    .get_manifest(
                        "absent",
                        chrono::Utc::now(),
                        chrono::Utc::now(),
                        Some(format!("{root}absent/date=2026-01-01/manifest.json")),
                        &tenant
                    )
                    .await
                    .unwrap()
                    .is_none()
            );
            store.put_alert(&object, &tenant).await.unwrap();
            store.delete_alert(&object, &tenant).await.unwrap();
            store.delete_alert(&object, &tenant).await.unwrap();
            assert!(
                store
                    .get_stream_json("absent", true, &tenant, false)
                    .await
                    .is_err()
            );
            assert!(
                store
                    .get_parseable_metadata(&tenant)
                    .await
                    .unwrap()
                    .is_none()
            );
            store
                .put_parseable_metadata(&object, &tenant)
                .await
                .unwrap();
            assert_eq!(
                store
                    .get_parseable_metadata(&tenant)
                    .await
                    .unwrap()
                    .unwrap(),
                crate::storage::object_storage::to_bytes(&object)
            );
        }
        for tenant in [None, Some("tenant-contract".to_owned())] {
            let root = tenant.as_ref().map(|t| format!("{t}/")).unwrap_or_default();
            let schema = arrow_schema::Schema::new(vec![arrow_schema::Field::new(
                if tenant.is_some() {
                    "named_value"
                } else {
                    "default_value"
                },
                arrow_schema::DataType::Int64,
                false,
            )]);
            store
                .put_schema(schema.clone(), "contractlogs", &tenant)
                .await
                .unwrap();
            assert_eq!(
                serde_json::from_slice::<arrow_schema::Schema>(
                    &store.get_schema("contractlogs", &tenant).await.unwrap()
                )
                .unwrap(),
                schema
            );
            assert_eq!(
                store
                    .get_all_schemas("contractlogs", &tenant)
                    .await
                    .unwrap(),
                vec![schema.clone()]
            );
            assert_eq!(
                store
                    .refresh_schema("contractlogs", &tenant, ".schema")
                    .await
                    .unwrap(),
                schema
            );
            if tenant.is_none() {
                assert_eq!(
                    store
                        .get_all_schemas("contractlogs", &Some(String::new()))
                        .await
                        .unwrap(),
                    vec![schema.clone()]
                );
                assert_eq!(
                    store
                        .refresh_schema("contractlogs", &Some(String::new()), ".schema")
                        .await
                        .unwrap(),
                    schema
                );
            }
            for field in ["ingestor_a", "ingestor_b"] {
                let path = format!("{root}contractlogs/.stream/.{field}.schema");
                let fragment = arrow_schema::Schema::new(vec![arrow_schema::Field::new(
                    field,
                    arrow_schema::DataType::Utf8,
                    true,
                )]);
                store
                    .put_dashboard_conditional(
                        &path,
                        crate::storage::object_storage::to_bytes(&fragment),
                        MetadataWriteCondition::Create,
                        &tenant,
                    )
                    .await
                    .unwrap();
            }
            let merged = store
                .refresh_schema("contractlogs", &tenant, ".schema")
                .await
                .unwrap();
            let names = |s: &arrow_schema::Schema| {
                s.fields()
                    .iter()
                    .map(|f| f.name().clone())
                    .collect::<std::collections::BTreeSet<_>>()
            };
            let expected_names = [
                schema.fields()[0].name().as_str(),
                "ingestor_a",
                "ingestor_b",
            ]
            .into_iter()
            .map(str::to_owned)
            .collect();
            assert_eq!(names(&merged), expected_names);
            let persisted: arrow_schema::Schema =
                serde_json::from_slice(&store.get_schema("contractlogs", &tenant).await.unwrap())
                    .unwrap();
            assert_eq!(names(&persisted), names(&merged));
            let metadata = crate::storage::ObjectStoreFormat::default();
            store
                .put_stream_json(&metadata, "contractlogs", &tenant)
                .await
                .unwrap();
            assert_eq!(
                store
                    .get_stream_json("contractlogs", false, &tenant, false)
                    .await
                    .unwrap(),
                crate::storage::object_storage::to_bytes(&metadata)
            );
            assert_eq!(
                store
                    .get_all_stream_jsons("contractlogs", None, &tenant, false)
                    .await
                    .unwrap(),
                vec![crate::storage::object_storage::to_bytes(&metadata)]
            );
            if sql {
                assert!(
                    store
                        .list_streams(&tenant)
                        .await
                        .unwrap()
                        .contains("contractlogs")
                );
            }
            // LocalFS listing uses the process-global provider; covered by the
            // separate regression so this defect cannot suppress all CRUD checks.
            let lower = chrono::Utc::now();
            let upper = lower;
            let manifest = crate::catalog::manifest::Manifest {
                files: (0..10_000)
                    .map(|i| crate::catalog::manifest::File {
                        file_path: format!(
                            "{root}contractlogs/date=2026-01-01/space %_é'/{i}.parquet"
                        ),
                        num_rows: i,
                        file_size: 1234,
                        ..Default::default()
                    })
                    .collect(),
                ..Default::default()
            };
            store
                .put_manifest(&manifest, "contractlogs", lower, upper, &tenant)
                .await
                .unwrap();
            assert_eq!(
                serde_json::to_value(
                    store
                        .get_manifest("contractlogs", lower, upper, None, &tenant)
                        .await
                        .unwrap()
                        .unwrap()
                )
                .unwrap(),
                serde_json::to_value(&manifest).unwrap()
            );
            assert!(
                store
                    .get_manifest_path("contractlogs", lower, upper, &tenant)
                    .await
                    .unwrap()
                    .ends_with("manifest.json")
            );
            let listing = store
                .get_manifest_files_for_dates(
                    "contractlogs",
                    &tenant,
                    &[format!("date={}", lower.format("%Y-%m-%d"))],
                )
                .await;
            if sql {
                assert_eq!(
                    serde_json::to_value(listing.unwrap()).unwrap(),
                    serde_json::json!({ (format!("date={}", lower.format("%Y-%m-%d"))): [manifest] })
                );
            } else {
                assert!(listing.is_err());
            } // LocalFS has no delimiter LIST.
            assert!(store.stream_exists("contractlogs", &tenant).await.unwrap());
            assert!(
                !store
                    .is_stream_deleting("contractlogs", &tenant)
                    .await
                    .unwrap()
            );
            assert!(store.read_latency(&tenant).await < std::time::Duration::from_secs(5));
            store.check_health(&tenant).await.unwrap();
            let candidates = store.list_tenant_candidates().await.unwrap();
            if tenant.is_some() {
                assert!(candidates.contains(&"tenant-contract".to_owned()));
            }

            store
                .delete_manifest("contractlogs", lower, upper, &tenant)
                .await
                .unwrap();
            assert!(
                store
                    .get_manifest("contractlogs", lower, upper, None, &tenant)
                    .await
                    .unwrap()
                    .is_none()
            );
            store
                .delete_stream_partition(
                    "contractlogs",
                    &format!("date={}", lower.format("%Y-%m-%d")),
                    &tenant,
                )
                .await
                .unwrap();
            let state = crate::alerts::alert_structs::AlertStateEntry::new(
                ulid::Ulid::new(),
                crate::alerts::alert_enums::AlertState::default(),
                tenant.clone(),
            );
            store.put_alert_state(&state, &tenant).await.unwrap();
            assert!(
                store
                    .get_alert_state_entry(&state.alert_id, &tenant)
                    .await
                    .unwrap()
                    .is_some()
            );
            let states = store.get_alert_states(&tenant).await.unwrap();
            assert_eq!(states.len(), 1);
            if tenant.is_none() {
                assert_eq!(
                    store
                        .get_alert_states(&Some(crate::parseable::DEFAULT_TENANT.into()))
                        .await
                        .unwrap()
                        .len(),
                    1
                );
            }
            store.delete_alert_state(&state, &tenant).await.unwrap();
            assert!(
                store
                    .get_alert_state_entry(&state.alert_id, &tenant)
                    .await
                    .unwrap()
                    .is_none()
            );
            let history = crate::alerts::alert_structs::MTTRHistory {
                daily_stats: vec![],
                tenant_id: tenant.clone(),
            };
            store.put_mttr_history(&history, &tenant).await.unwrap();
            assert_eq!(
                serde_json::to_value(store.get_mttr_history(&tenant).await.unwrap().unwrap())
                    .unwrap(),
                serde_json::to_value(&history).unwrap()
            );
            let policy = crate::alerts::outbound_http_policy::AlertTargetPolicyConfig {
                allow_private: tenant.is_some(),
                ..Default::default()
            };
            store.put_outbound_policy(&tenant, &policy).await.unwrap();
            let filter:crate::users::filters::Filter=serde_json::from_value(serde_json::json!({
                "version":"v2","user_id":"owner","filter_id":"contract","stream_name":"orders","filter_name":"contract","tenant_id":tenant,
                "query":{"filter_type":"sql","filter_query":"select * from orders","filter_builder":null},"time_filter":null
            })).unwrap();
            store.put_filter(&filter, &tenant).await.unwrap();
            store.reconcile_filter(&filter, &tenant).await.unwrap();
            let config = Document {
                id: "config".into(),
                path: format!("{root}.settings/llmconfigs/contract.json"),
                value: format!("config-{root}"),
            };
            store.put_llmconfig(&config, &tenant).await.unwrap();
            let target: crate::alerts::target::Target = serde_json::from_value(serde_json::json!({
                "name": format!("target-{root}"), "type":"webhook",
                "endpoint":"https://hook.example/x", "tenantId": tenant,
                "id": "01ARZ3NDEKTSV4RRFFQ69G5FAV"
            }))
            .unwrap();
            store.put_target(&target, &tenant).await.unwrap();
            let chat = Document {
                id: "chat".into(),
                path: format!("{root}.users/owner/chats/contract.json"),
                value: format!("chat-{root}"),
            };
            store.put_chat(&chat, &tenant).await.unwrap();
            let key = Document {
                id: "key".into(),
                path: String::new(),
                value: format!("key-{root}"),
            };
            store.put_keystone(&key, &tenant).await.unwrap();
            store.put_conversation(&key, &tenant).await.unwrap();
        }
        // The global getters must preserve both populated namespaces. Vec order
        // is not part of Metastore's contract: compare byte sets per tenant.
        let expected = |id: &str,
                        suffix: &str,
                        label: &str|
         -> std::collections::HashMap<String, Vec<Bytes>> {
            [None, Some("tenant-contract".to_owned())]
                .into_iter()
                .map(|tenant| {
                    let root = tenant.as_ref().map(|t| format!("{t}/")).unwrap_or_default();
                    let document = Document {
                        id: id.into(),
                        path: if suffix.is_empty() {
                            String::new()
                        } else {
                            format!("{root}{suffix}")
                        },
                        value: format!("{label}-{root}"),
                    };
                    (
                        tenant.unwrap_or_else(|| crate::parseable::DEFAULT_TENANT.into()),
                        vec![crate::storage::object_storage::to_bytes(&document)],
                    )
                })
                .collect()
        };
        assert_eq!(
            store.get_keystones().await.unwrap(),
            expected("key", "", "key")
        );
        assert_eq!(
            store.get_conversations().await.unwrap(),
            expected("key", "", "key")
        );
        // MTTR history is incorrectly returned as an alert. The exact empty
        // alert inventory assertion lives in the ignored regression below.
        assert_eq!(
            store.get_llmconfigs().await.unwrap(),
            expected("config", ".settings/llmconfigs/contract.json", "config")
        );
        let targets = store.get_targets().await.unwrap();
        assert_eq!(targets.len(), 2);
        for (tenant, values) in targets {
            assert_eq!(values.len(), 1, "typed target was silently discarded");
            assert_eq!(
                values[0].name,
                if tenant == crate::parseable::DEFAULT_TENANT {
                    "target-"
                } else {
                    "target-tenant-contract/"
                }
            );
        }
        let policies = store.get_outbound_policies().await.unwrap();
        assert_eq!(policies.len(), 2);
        assert!(!policies[""].allow_private);
        assert!(policies["tenant-contract"].allow_private);
        assert_eq!(
            store.get_dashboards().await.unwrap(),
            expected("", "", "")
                .into_keys()
                .map(|t| (t, vec![]))
                .collect()
        );
        let chats = store.get_chats().await.unwrap();
        assert_eq!(chats.len(), 2);
        for (tenant, bytes) in expected("chat", ".users/owner/chats/contract.json", "chat") {
            let users = chats.get(&tenant).unwrap();
            assert_eq!(users.get("owner").unwrap().value(), &bytes);
        }
        let filters = store.get_filters().await.unwrap();
        assert_eq!(filters.len(), 2);
        for (tenant, filters) in filters {
            assert_eq!(
                filters.len(),
                1,
                "filter delete must exercise a populated tenant"
            );
            for filter in filters {
                store
                    .delete_filter(
                        &filter,
                        &Some(if tenant == crate::parseable::DEFAULT_TENANT {
                            String::new()
                        } else {
                            tenant.clone()
                        }),
                    )
                    .await
                    .unwrap();
            }
        }
        let node = crate::handlers::http::modal::NodeMetadata {
            domain_name: "contract.invalid".into(),
            node_id: "contract".into(),
            ..Default::default()
        };
        store.put_node_metadata(&node).await.unwrap();
        assert_eq!(
            store
                .get_node_metadata(crate::handlers::http::modal::NodeType::Ingestor, &None)
                .await
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            store.get_ingestor_metadata().await.unwrap(),
            vec![crate::storage::object_storage::to_bytes(&node)]
        );
        assert!(
            store
                .delete_node_metadata(
                    "contract.invalid",
                    crate::handlers::http::modal::NodeType::Ingestor
                )
                .await
                .unwrap()
        );
        assert!(
            !store
                .delete_node_metadata(
                    "missing.invalid",
                    crate::handlers::http::modal::NodeType::Ingestor
                )
                .await
                .unwrap()
        );
        for tenant in [None, Some("tenant-contract".to_owned())] {
            // LocalFS stream deletion historically ignores tenant scope; cloud/SQL do not.
            if !sql && tenant.is_some() {
                continue;
            }
            store.delete_stream("contractlogs", &tenant).await.unwrap();
            assert!(!store.stream_exists("contractlogs", &tenant).await.unwrap());
            store
                .put_stream_json(
                    &crate::storage::ObjectStoreFormat::default(),
                    "contractlogs",
                    &tenant,
                )
                .await
                .unwrap();
            assert!(store.stream_exists("contractlogs", &tenant).await.unwrap());
            assert!(
                !store
                    .is_stream_deleting("contractlogs", &tenant)
                    .await
                    .unwrap()
            );
            store.delete_stream("contractlogs", &tenant).await.unwrap();
        }
        let survivor = store.get_parseable_metadata(&None).await.unwrap().unwrap();
        assert!(
            store
                .get_parseable_metadata(&Some("tenant-contract".into()))
                .await
                .unwrap()
                .is_some()
        );
        store.delete_tenant("tenant-contract").await.unwrap();
        assert!(
            store
                .get_parseable_metadata(&Some("tenant-contract".into()))
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(
            store.get_parseable_metadata(&None).await.unwrap().unwrap(),
            survivor
        );
        assert!(
            store
                .get_parseable_metadata(&Some("other-tenant".into()))
                .await
                .unwrap()
                .is_none()
        );
    }
    // Explicit regression cases use disposable databases and always clean up,
    // including when the assertion demonstrates a product defect.
    async fn postgres_regression(case: u8) {
        use futures::FutureExt;
        initialize_context();
        let Ok(url) = std::env::var("P_TEST_POSTGRES_URL") else {
            eprintln!("SKIP PostgreSQL regression {case}: P_TEST_POSTGRES_URL unset");
            return;
        };
        if case == 3 && std::env::var_os("P_TEST_POSTGRES_CONTAINER").is_none() {
            eprintln!("SKIP paused-server regression: P_TEST_POSTGRES_CONTAINER unset");
            return;
        }
        let (admin, connection) = tokio_postgres::connect(&url, tokio_postgres::NoTls)
            .await
            .unwrap();
        let task = tokio::spawn(async move { connection.await.unwrap() });
        let database = format!(
            "regression_{}",
            ulid::Ulid::new().to_string().to_lowercase()
        );
        admin
            .batch_execute(&format!("CREATE DATABASE {database}"))
            .await
            .unwrap();
        let mut url = url::Url::parse(&url).unwrap();
        url.set_path(&database);
        let result = std::panic::AssertUnwindSafe(async {
            let dir = test_dir();
            let storage: Arc<dyn ObjectStorage> = Arc::new(LocalFS::new(dir.path().to_owned()));
            let options = PostgresOptions {
                metastore_postgres_url: Some(url.to_string()),
                metastore_postgres_statement_timeout_ms: if case == 7 { 5000 } else { 500 },
                metastore_postgres_connect_timeout_ms: 500,
                ..Default::default()
            };
            let documents = Arc::new(
                super::super::postgres_documents::PostgresDocuments::new(
                    &options,
                    database.clone(),
                    storage,
                )
                .unwrap(),
            );
            documents.check(&None).await.unwrap();
            let store = PostgresMetastore {
                storage: documents.clone(),
            };
            if case == 7 {
                let abort = super::super::migration::MigrationOptions {
                    metadata_migration: Some(super::super::migration::Action::Export),
                    acknowledge_server_stopped: true, abort: true, ..Default::default()
                };
                super::super::migration::run(Arc::new(LocalFS::new(dir.path().to_owned())), &documents, &abort).await.unwrap();
                let name = dir.path().file_name().unwrap().to_str().unwrap();
                for tenant in [None, Some(name.to_owned())] {
                    let prefix = tenant.as_ref().map(|t| format!("{t}/")).unwrap_or_default();
                    let exact = format!("{prefix}{name}/date=2026-01-01/manifest.json");
                    documents.put_object(RelativePath::new(&exact), Bytes::from_static(b"exact"), &tenant).await.unwrap();
                    assert_eq!(documents.get_object(RelativePath::new(&exact), &tenant).await.unwrap(), Bytes::from_static(b"exact"));
                    let absolute = format!("{}/{exact}", dir.path().to_string_lossy().trim_start_matches('/'));
                    assert_eq!(documents.get_object(RelativePath::new(&absolute), &tenant).await.unwrap(), Bytes::from_static(b"exact"));
                    let paths = vec![exact.clone(), absolute];
                    assert_eq!(documents.manifest_batch(&paths, &tenant).await.unwrap().len(), 2);
                    documents.put_object(RelativePath::new(&format!("{prefix}{name}/.stream/.deleting")), Bytes::new(), &tenant).await.unwrap();
                    assert!(matches!(documents.put_object(RelativePath::new(&exact), Bytes::new(), &tenant).await, Err(ObjectStorageError::StreamDeleting)));
                }
                let collision = super::super::postgres_documents::PostgresDocuments::new(
                    &options, database.clone(), Arc::new(LocalFS::new(std::path::PathBuf::from("logs")))).unwrap();
                for tenant in [None, Some("logs".to_owned())] {
                    let key = if tenant.is_none() { "logs/date=2026-01-01/exact.manifest.json" } else { "logs/logs/date=2026-01-01/exact.manifest.json" };
                    let fallback = key.strip_prefix("logs/").unwrap();
                    collision.put_object(RelativePath::new(key), Bytes::from_static(b"exact"), &tenant).await.unwrap();
                    collision.put_object(RelativePath::new(fallback), Bytes::from_static(b"fallback"), &tenant).await.unwrap();
                    assert_eq!(collision.get_object(RelativePath::new(key), &tenant).await.unwrap(), Bytes::from_static(b"exact"));
                    assert_eq!(collision.manifest_batch(&[key.to_owned()], &tenant).await.unwrap()[0].1, Bytes::from_static(b"exact"));
                }
                // SQL tenant candidates cannot bypass deletion collision protection.
                store.put_stream_json(&crate::storage::ObjectStoreFormat::default(), "protected", &None).await.unwrap();
                documents.put_object(RelativePath::new("protected/other/.stream/.schema"), Bytes::new(), &Some("protected".into())).await.unwrap();
                let data = dir.path().join("protected/date=2026-01-01/data.parquet");
                std::fs::create_dir_all(data.parent().unwrap()).unwrap();
                std::fs::write(&data, b"sentinel").unwrap();
                assert!(documents.list_tenant_candidates().await.unwrap().contains(&"protected".to_owned()));
                assert!(documents.delete_prefix(RelativePath::new("protected"), &None).await.unwrap_err().to_string().contains("collides"));
                assert_eq!(std::fs::read(&data).unwrap(), b"sentinel");
                store.put_stream_json(&crate::storage::ObjectStoreFormat::default(), "alias", &Some(crate::parseable::DEFAULT_TENANT.into())).await.unwrap();
                assert!(store.stream_exists("alias", &None).await.unwrap());
                assert!(documents.get_object(RelativePath::new("alias/.stream/.stream.json"), &None).await.is_ok());
                let paths: Vec<_> = (0..70).map(|i| format!("batch/date=2026-01-01/{i}.manifest.json")).collect();
                for key in &paths { documents.put_object(RelativePath::new(key), Bytes::new(), &None).await.unwrap(); }
                assert_eq!(documents.manifest_batch(&paths, &None).await.unwrap().len(), 70);
                let large_paths: Vec<_> = (0..3).map(|i| format!("large/date=2026-01-01/{i}.manifest.json")).collect();
                for key in &large_paths { documents.put_object(RelativePath::new(key), Bytes::from(vec![b'x'; 5 * 1024 * 1024]), &None).await.unwrap(); }
                // Model growth between the size lookup and the body read:
                // only sizing queries see one byte; body queries see real data.
                documents.client().await.unwrap().batch_execute("ALTER TABLE parseable_documents RENAME TO batch_documents; CREATE VIEW parseable_documents AS SELECT tenant,kind,key,CASE WHEN current_query() LIKE 'SELECT key,octet_length%' THEN substring(body from 1 for 1) ELSE body END AS body,version,created_at,updated_at FROM batch_documents;").await.unwrap();
                let chunks = documents.manifest_chunks(&large_paths, &None);
                futures::pin_mut!(chunks);
                use futures::TryStreamExt;
                let mut chunks_seen = 0;
                while let Some(rows) = chunks.try_next().await.unwrap() {
                    assert!(rows.iter().map(|(_, body)| body.len()).sum::<usize>() <= 8 * 1024 * 1024);
                    chunks_seen += 1;
                }
                assert_eq!(chunks_seen, 3);
                documents.client().await.unwrap().batch_execute("DROP VIEW parseable_documents; ALTER TABLE batch_documents RENAME TO parseable_documents;").await.unwrap();
                documents.client().await.unwrap().batch_execute(include_str!("../migrations/002_review_fixes.sql")).await.unwrap();
                let restart_a = super::super::postgres_documents::PostgresDocuments::new(&options, database.clone(), Arc::new(LocalFS::new(dir.path().to_owned()))).unwrap();
                let restart_b = super::super::postgres_documents::PostgresDocuments::new(&options, database.clone(), Arc::new(LocalFS::new(dir.path().to_owned()))).unwrap();
                tokio::try_join!(restart_a.check(&None), restart_b.check(&None)).unwrap();
                assert_eq!(documents.get_object(RelativePath::new(&large_paths[0]), &None).await.unwrap().len(), 5 * 1024 * 1024);
                assert_eq!(documents.client().await.unwrap().query_one("SELECT schema_version FROM parseable_backend", &[]).await.unwrap().get::<_, i32>(0), 3);
                documents.put_object(RelativePath::new("upgrade/.stream/.deleting"), Bytes::new(), &None).await.unwrap();
                assert!(matches!(documents.put_object(RelativePath::new("upgrade/date=2026-01-01/manifest.json"), Bytes::new(), &None).await, Err(ObjectStorageError::StreamDeleting)));


            } else if case == 0 {
                let date = chrono::Utc::now();
                let manifest = crate::catalog::manifest::Manifest::default();
                store
                    .put_manifest(&manifest, "logs", date, date, &None)
                    .await
                    .unwrap();
                let path = store
                    .get_manifest_path("logs", date, date, &None)
                    .await
                    .unwrap();
                assert!(
                    store
                        .get_manifest("logs", date, date, Some(path), &None)
                        .await
                        .unwrap()
                        .is_some(),
                    "B1: returned manifest path must be readable"
                );
            } else if case == 1 {
                store
                    .put_stream_json(&crate::storage::ObjectStoreFormat::default(), "logs", &None)
                    .await
                    .unwrap();
                store
                    .delete_stream("logs", &Some(crate::parseable::DEFAULT_TENANT.into()))
                    .await
                    .unwrap();
                assert!(
                    !store.stream_exists("logs", &None).await.unwrap(),
                    "m5: default tenant alias must delete default rows"
                );
            } else if case == 2 {
                let fresh = test_dir();
                let empty: Arc<dyn ObjectStorage> = Arc::new(LocalFS::new(fresh.path().to_owned()));
                let repaired = super::super::postgres_documents::PostgresDocuments::new(
                    &options,
                    database.clone(),
                    empty,
                )
                .unwrap();
                assert!(
                    repaired.check(&None).await.is_err(),
                    "m9: a missing pairing marker must require explicit repair"
                );
            } else if case == 3 {
                let container = std::env::var("P_TEST_POSTGRES_CONTAINER")
                    .expect("requires disposable Docker container name");
                // Pausing an established server leaves TCP open and prevents
                // server-side statement_timeout from sending a response.
                assert!(
                    std::process::Command::new("docker")
                        .args(["pause", &container])
                        .status()
                        .unwrap()
                        .success()
                );
                let result = tokio::time::timeout(
                    std::time::Duration::from_secs(2),
                    documents.check_health(&None),
                )
                .await;
                assert!(
                    std::process::Command::new("docker")
                        .args(["unpause", &container])
                        .status()
                        .unwrap()
                        .success()
                );
                assert!(
                    result.is_ok(),
                    "M2: health exceeded its client deadline against a nonresponsive database"
                );
            } else {
                let output = std::process::Command::new(std::env::current_exe().unwrap())
                    .args(["--exact", "metastore::metastores::postgres_metastore::contract_tests::startup_cleanup_child", "--ignored", "--nocapture"])
                    .env("P_CONTRACT_STARTUP_ROOT", dir.path())
                    .env("P_CONTRACT_STARTUP_URL", url.as_str())
                    .env("P_CONTRACT_STARTUP_BUCKET", &database)
                    .env("P_CONTRACT_STARTUP_FAILURE", match case { 5 => "late-failure", 6 => "default-stream", _ => "none" })
                    .output().unwrap();
                assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stdout).to_string() + &String::from_utf8_lossy(&output.stderr));
            }
        })
        .catch_unwind()
        .await;
        admin
            .batch_execute(&format!("DROP DATABASE {database} WITH (FORCE)"))
            .await
            .unwrap();
        drop(admin);
        task.await.unwrap();
        if let Err(panic) = result {
            std::panic::resume_unwind(panic);
        }
    }
    #[tokio::test]
    #[ignore = "requires PostgreSQL 17; starts an isolated process for the global context"]
    async fn postgres_startup_cleanup() {
        postgres_regression(4).await;
    }

    #[tokio::test]
    async fn postgres_startup_default_stream_regression() {
        postgres_regression(6).await;
    }

    #[tokio::test]
    async fn postgres_startup_mid_scan_failure_regression() {
        postgres_regression(5).await;
    }

    #[tokio::test]
    #[ignore = "internal child fixture; invoked by postgres_startup_cleanup"]
    async fn startup_cleanup_child() {
        initialize_context();
        let context = &crate::parseable::PARSEABLE;
        let store = &context.metastore;
        store.initiate_connection().await.unwrap();
        let url = std::env::var("P_CONTRACT_STARTUP_URL").unwrap();
        let (mut client, connection) = tokio_postgres::connect(&url, tokio_postgres::NoTls)
            .await
            .unwrap();
        let task = tokio::spawn(async move { connection.await.unwrap() });
        let storage = context.storage.get_object_store();
        if std::env::var("P_CONTRACT_STARTUP_FAILURE").as_deref() == Ok("default-stream") {
            store
                .put_stream_json(
                    &crate::storage::ObjectStoreFormat::default(),
                    "defaultlogs",
                    &None,
                )
                .await
                .unwrap();
            storage
                .put_object(
                    RelativePath::new("defaultlogs/date=2026-01-01/data.parquet"),
                    Bytes::from_static(b"default tenant data"),
                    &None,
                )
                .await
                .unwrap();
            let invalid = Document {
                id: "collision".into(),
                path: "defaultlogs/other/.stream/.schema".into(),
                value: "invalid".into(),
            };
            store
                .put_dashboard(&invalid, &Some("defaultlogs".into()))
                .await
                .unwrap();
            context.validate_multi_tenancy().await.unwrap();
            assert_eq!(
                storage
                    .get_object(
                        RelativePath::new("defaultlogs/date=2026-01-01/data.parquet"),
                        &None
                    )
                    .await
                    .expect("m6: startup must preserve default-tenant stream data"),
                Bytes::from_static(b"default tenant data")
            );
            assert!(store.stream_exists("defaultlogs", &None).await.unwrap());
            return;
        }
        if std::env::var("P_CONTRACT_STARTUP_FAILURE").as_deref() == Ok("late-failure") {
            let invalid = Document {
                id: "invalid".into(),
                path: "a-invalid/.stream/.schema".into(),
                value: "sentinel".into(),
            };
            store
                .put_dashboard(&invalid, &Some("a-invalid".into()))
                .await
                .unwrap();
            store
                .put_parseable_metadata(
                    &crate::storage::store_metadata::StorageMetadata::default(),
                    &Some("z-valid".into()),
                )
                .await
                .unwrap();
            storage
                .put_object(
                    RelativePath::new("a-invalid/data.parquet"),
                    Bytes::from_static(b"sentinel"),
                    &None,
                )
                .await
                .unwrap();
            // Restrict the injected SQL error to the per-tenant body read;
            // volatile view expressions can also execute during discovery.
            client.batch_execute("ALTER TABLE parseable_documents RENAME TO startup_documents; CREATE FUNCTION startup_read_failure() RETURNS bytea LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected transient tenant read failure' USING ERRCODE='08006'; END $$; CREATE VIEW parseable_documents AS SELECT tenant,kind,key,CASE WHEN tenant='z-valid' AND key='z-valid/.parseable.json' AND (current_query() LIKE 'SELECT body%FROM parseable_documents%' OR current_query() LIKE 'SELECT key,body%FROM parseable_documents%') THEN startup_read_failure() ELSE body END AS body,version,created_at,updated_at FROM startup_documents;").await.unwrap();
            assert!(context.validate_multi_tenancy().await.is_err());
            assert_eq!(
                storage
                    .get_object(RelativePath::new("a-invalid/data.parquet"), &None)
                    .await
                    .unwrap(),
                Bytes::from_static(b"sentinel"),
                "a late database read failure must preserve earlier invalid tenant data"
            );
            let remaining: i64 = client
                .query_one(
                    "SELECT count(*) FROM startup_documents WHERE tenant='a-invalid'",
                    &[],
                )
                .await
                .unwrap()
                .get(0);
            assert_eq!(
                remaining, 1,
                "a late database read failure must preserve earlier invalid tenant rows"
            );
            return;
        }
        for tenant in ["sqlonly", "duplicate"] {
            let metadata = crate::storage::store_metadata::StorageMetadata::default();
            store
                .put_parseable_metadata(&metadata, &Some(tenant.into()))
                .await
                .unwrap();
        }
        let invalid = Document {
            id: "invalid".into(),
            path: "invalid/.stream/.schema".into(),
            value: "invalid candidate".into(),
        };
        store
            .put_dashboard(&invalid, &Some("invalid".into()))
            .await
            .unwrap();
        for tenant in ["dataonly", "duplicate", "invalid", ".hidden"] {
            storage
                .put_object(
                    RelativePath::new(&format!("{tenant}/data.parquet")),
                    Bytes::from(tenant.to_owned()),
                    &None,
                )
                .await
                .unwrap();
        }
        let before = client
            .query(
                "SELECT tenant,key,body FROM parseable_documents ORDER BY tenant,key",
                &[],
            )
            .await
            .unwrap()
            .into_iter()
            .map(|r| {
                (
                    r.get::<_, String>(0),
                    r.get::<_, String>(1),
                    r.get::<_, Vec<u8>>(2),
                )
            })
            .collect::<Vec<_>>();
        // A transient database failure in discovery must admit no cleanup.
        let tx = client.transaction().await.unwrap();
        tx.batch_execute("LOCK TABLE parseable_documents IN ACCESS EXCLUSIVE MODE")
            .await
            .unwrap();
        let started = std::time::Instant::now();
        let result = context.validate_multi_tenancy().await;
        tx.rollback().await.unwrap();
        assert!(result.is_err());
        assert!(started.elapsed() < std::time::Duration::from_secs(3));
        // A temporarily unavailable bucket must also admit no cleanup.
        let root = std::path::PathBuf::from(std::env::var("P_CONTRACT_STARTUP_ROOT").unwrap());
        let offline = root.with_extension("offline");
        std::fs::rename(&root, &offline).unwrap();
        std::fs::write(&root, b"temporarily unavailable bucket root").unwrap();
        let result = context.validate_multi_tenancy().await;
        std::fs::remove_file(&root).unwrap();
        std::fs::rename(&offline, &root).unwrap();
        assert!(result.is_err());
        let after = client
            .query(
                "SELECT tenant,key,body FROM parseable_documents ORDER BY tenant,key",
                &[],
            )
            .await
            .unwrap()
            .into_iter()
            .map(|r| {
                (
                    r.get::<_, String>(0),
                    r.get::<_, String>(1),
                    r.get::<_, Vec<u8>>(2),
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(after, before);
        for tenant in ["dataonly", "duplicate", "invalid", ".hidden"] {
            assert_eq!(
                storage
                    .get_object(RelativePath::new(&format!("{tenant}/data.parquet")), &None)
                    .await
                    .unwrap(),
                Bytes::from(tenant.to_owned())
            );
        }
        context.validate_multi_tenancy().await.unwrap();
        assert_eq!(
            context
                .list_tenants()
                .unwrap()
                .into_iter()
                .collect::<std::collections::BTreeSet<_>>(),
            ["sqlonly".to_owned(), "duplicate".to_owned()]
                .into_iter()
                .collect()
        );
        let rows = client
            .query(
                "SELECT tenant,key FROM parseable_documents ORDER BY tenant,key",
                &[],
            )
            .await
            .unwrap()
            .into_iter()
            .map(|r| (r.get::<_, String>(0), r.get::<_, String>(1)))
            .collect::<Vec<_>>();
        assert_eq!(
            rows,
            vec![
                ("duplicate".into(), "duplicate/.parseable.json".into()),
                ("sqlonly".into(), "sqlonly/.parseable.json".into())
            ]
        );
        for tenant in ["dataonly", "invalid"] {
            assert!(
                storage
                    .get_object(RelativePath::new(&format!("{tenant}/data.parquet")), &None)
                    .await
                    .is_err()
            );
        }
        for tenant in ["duplicate", ".hidden"] {
            assert_eq!(
                storage
                    .get_object(RelativePath::new(&format!("{tenant}/data.parquet")), &None)
                    .await
                    .unwrap(),
                Bytes::from(tenant.to_owned())
            );
        }
        drop(client);
        task.await.unwrap();
    }
    #[tokio::test]
    async fn alert_listing_excludes_mttr_history() {
        initialize_context();
        let dir = test_dir();
        let storage: Arc<dyn ObjectStorage> = Arc::new(LocalFS::new(dir.path().to_owned()));
        let store = super::super::object_store_metastore::ObjectStoreMetastore { storage };
        let history = crate::alerts::alert_structs::MTTRHistory {
            daily_stats: vec![],
            tenant_id: None,
        };
        store.put_mttr_history(&history, &None).await.unwrap();
        assert!(store.get_alerts().await.unwrap()[crate::parseable::DEFAULT_TENANT].is_empty());
    }
    #[tokio::test]
    async fn postgres_health_deadline_regression() {
        postgres_regression(3).await;
    }
    #[tokio::test]
    async fn postgres_round_two_backend_regressions() {
        postgres_regression(7).await;
    }
    #[tokio::test]
    async fn postgres_manifest_url_regression() {
        postgres_regression(0).await;
    }
    #[tokio::test]
    async fn postgres_default_alias_regression() {
        postgres_regression(1).await;
    }
    #[tokio::test]
    async fn postgres_empty_bucket_pairing_regression() {
        postgres_regression(2).await;
    }
    #[tokio::test]
    async fn local_listing_uses_the_selected_backend() {
        initialize_context();
        let dir = test_dir();
        let storage: Arc<dyn ObjectStorage> = Arc::new(LocalFS::new(dir.path().to_owned()));
        let store = super::super::object_store_metastore::ObjectStoreMetastore { storage };
        store
            .put_stream_json(
                &crate::storage::ObjectStoreFormat::default(),
                "isolated",
                &None,
            )
            .await
            .unwrap();
        assert_eq!(
            store.list_streams(&None).await.unwrap(),
            ["isolated".to_owned()].into_iter().collect()
        );
    }
    #[test]
    fn target_tenant_survives_persistence_roundtrip() {
        let target: crate::alerts::target::Target = serde_json::from_value(serde_json::json!({
            "name":"named target", "type":"webhook", "endpoint":"https://hook.example/x", "tenantId":"tenant-contract"
        })).unwrap();
        let mut legacy = serde_json::to_value(&target).unwrap();
        legacy.as_object_mut().unwrap().remove("tenantId");
        legacy["tenant"] = serde_json::json!("tenant-contract");
        assert_eq!(
            serde_json::from_value::<crate::alerts::target::Target>(legacy)
                .unwrap()
                .tenant,
            target.tenant
        );
        let persisted = crate::storage::object_storage::to_bytes(&target);
        let loaded: crate::alerts::target::Target = serde_json::from_slice(&persisted).unwrap();
        assert_eq!(
            loaded.tenant, target.tenant,
            "stored Target must retain its tenant"
        );
    }
    // Global tenant/mode lookups belong to the product API. Give each shared
    // contract its own process rather than depending on which test forced the
    // global context first. The parent owns and removes the context directory.
    fn contract_process(name: &str, sql: bool) -> bool {
        if std::env::var("P_CONTRACT_ACTIVE_CHILD").as_deref() == Ok(name) {
            return false;
        }
        let context = test_dir();
        let mut command = std::process::Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                &format!("metastore::metastores::postgres_metastore::contract_tests::{name}"),
                "--nocapture",
            ])
            .env("P_CONTRACT_ACTIVE_CHILD", name)
            .env("P_CONTRACT_CONTEXT_ROOT", context.path());
        if sql {
            command.arg("--ignored");
        }
        let output = command.output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stdout).to_string()
                + &String::from_utf8_lossy(&output.stderr)
        );
        true
    }
    #[tokio::test]
    async fn object_store_contract() {
        if contract_process("object_store_contract", false) {
            return;
        }
        initialize_context();
        let dir = test_dir();
        let storage: Arc<dyn ObjectStorage> = Arc::new(LocalFS::new(dir.path().to_owned()));
        contract(
            Arc::new(super::super::object_store_metastore::ObjectStoreMetastore { storage }),
            false,
        )
        .await;
    }
    #[tokio::test]
    #[ignore = "requires PostgreSQL 17; run explicitly with P_TEST_POSTGRES_URL"]
    async fn postgres_contract() {
        if contract_process("postgres_contract", true) {
            return;
        }
        let url = std::env::var("P_TEST_POSTGRES_URL")
            .expect("P_TEST_POSTGRES_URL required for explicitly requested SQL tests");
        let (admin, connection) = tokio_postgres::connect(&url, tokio_postgres::NoTls)
            .await
            .unwrap();
        let connection_task = tokio::spawn(async move { connection.await.unwrap() });
        let database = format!("contract_{}", ulid::Ulid::new().to_string().to_lowercase());
        admin
            .batch_execute(&format!("CREATE DATABASE {database}"))
            .await
            .unwrap();
        let mut isolated = url::Url::parse(&url).unwrap();
        isolated.set_path(&database);
        let url = isolated.to_string();
        use futures::FutureExt;
        let outcome = std::panic::AssertUnwindSafe(async {
            let dir = test_dir();
            let storage: Arc<dyn ObjectStorage> = Arc::new(LocalFS::new(dir.path().to_owned()));
            let options = PostgresOptions {
                metastore_postgres_url: Some(url),
                metastore_postgres_pool_size: 4,
                metastore_postgres_connect_timeout_ms: 5000,
                metastore_postgres_statement_timeout_ms: 30000,
                metastore_postgres_id: None,
                metastore_postgres_ca: None,
            };
            let documents = super::super::postgres_documents::PostgresDocuments::new(
                &options,
                database.clone(),
                storage.clone(),
            )
            .unwrap();
            let concurrent = super::super::postgres_documents::PostgresDocuments::new(
                &options,
                database.clone(),
                storage.clone(),
            )
            .unwrap();
            let (first, second) = tokio::join!(documents.check(&None), concurrent.check(&None));
            first.unwrap();
            second.unwrap();
            let mismatched = super::super::postgres_documents::PostgresDocuments::new(
                &options,
                "other-bucket".into(),
                storage,
            )
            .unwrap();
            assert!(mismatched.check(&None).await.is_err());
            documents.verify_database_contract(&options).await;
            documents.verify_partition_contract().await;
            let documents = Arc::new(documents);
            let store = Arc::new(PostgresMetastore {
                storage: documents.clone(),
            });
            contract(store.clone(), true).await;
            documents.verify_deleted_stream_rows().await;
            let mut keys = Vec::new();
            fn inventory(root: &std::path::Path, path: &std::path::Path, keys: &mut Vec<String>) {
                for entry in std::fs::read_dir(path).unwrap() {
                    let path = entry.unwrap().path();
                    if path.is_dir() {
                        inventory(root, &path, keys);
                    } else {
                        keys.push(
                            path.strip_prefix(root)
                                .unwrap()
                                .to_string_lossy()
                                .into_owned(),
                        );
                    }
                }
            }
            inventory(dir.path(), dir.path(), &mut keys);
            // LocalFS conditional marker creation uses private process lock files;
            // these are not object keys on cloud stores (verified by the MinIO smoke).
            keys.retain(|key| !key.starts_with(".parseable-metadata-locks/"));
            assert_eq!(keys, vec![".parseable/postgres-metastore-id"]);
            documents
                .put_object(
                    RelativePath::new("hidden/.stream/.stream.json"),
                    Bytes::from_static(b"{}"),
                    &None,
                )
                .await
                .unwrap();
            documents
                .put_object(
                    RelativePath::new("hidden/.stream/.deleting"),
                    Bytes::new(),
                    &None,
                )
                .await
                .unwrap();
            assert!(!store.list_streams(&None).await.unwrap().contains("hidden"));
            store.delete_stream("hidden", &None).await.unwrap();
            drop(store);
            drop(documents);
        })
        .catch_unwind()
        .await;
        admin
            .batch_execute(&format!("DROP DATABASE {database} WITH (FORCE)"))
            .await
            .unwrap();
        drop(admin);
        connection_task.await.unwrap();
        if let Err(panic) = outcome {
            std::panic::resume_unwind(panic);
        }
    }
}
