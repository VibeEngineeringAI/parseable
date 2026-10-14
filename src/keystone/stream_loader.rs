//! Read-only, exact-scope hydration. Never publish aggregate stream metadata or schemas.
//! Caller must check current credential and Query permissions before invoking this loader.
use super::{
    domain::{Principal, ScopeVersion},
    query_bridge::storage_tenant,
    tools::ToolError,
};
use crate::{
    metadata::LogStreamMetadata,
    parseable::PARSEABLE,
    storage::{
        ObjectStorage, ObjectStoreFormat, SCHEMA_FILE_NAME, STREAM_METADATA_FILE_NAME,
        STREAM_ROOT_DIRECTORY, StreamType, object_storage::is_tombstoned,
    },
};
use arrow_schema::{DataType, Schema, TimeUnit};
use std::{collections::HashMap, sync::Arc};

const MAX_DOCUMENT_BYTES: usize = 1024 * 1024;
const MAX_SCOPE_METADATA_BYTES: usize = 8 * 1024 * 1024;
const MAX_DOCUMENTS: usize = 64;
const MAX_FIELDS: usize = 4096;

struct LoadedCatalog {
    metadata: ObjectStoreFormat,
    schema: Arc<Schema>,
}
fn parse_catalog(documents: &[(String, Vec<u8>)]) -> Result<LoadedCatalog, ToolError> {
    let mut metadata = Vec::new();
    let mut schemas = Vec::new();
    for (name, bytes) in documents {
        if bytes.len() > MAX_DOCUMENT_BYTES {
            return Err(ToolError::OutputLimit);
        }
        if name.ends_with(STREAM_METADATA_FILE_NAME) {
            let value: ObjectStoreFormat =
                serde_json::from_slice(bytes).map_err(|_| ToolError::Execution)?;
            if value.stream_type == StreamType::Internal {
                return Err(ToolError::Scope);
            }
            metadata.push(value);
        } else if name.ends_with(SCHEMA_FILE_NAME) {
            let schema: Schema = serde_json::from_slice(bytes).map_err(|_| ToolError::Execution)?;
            if schema.fields().len() > MAX_FIELDS {
                return Err(ToolError::OutputLimit);
            }
            schemas.push(schema);
        }
    }
    let mut first = metadata.first().cloned().ok_or(ToolError::Unavailable)?;
    let time = |metadata: &ObjectStoreFormat| {
        metadata
            .time_partition
            .as_deref()
            .filter(|column| !column.is_empty())
            .unwrap_or(crate::event::DEFAULT_TIMESTAMP_KEY)
            .to_owned()
    };
    let mut manifests = std::collections::BTreeMap::new();
    for item in metadata {
        if time(&item) != time(&first)
            || item.stream_type != first.stream_type
            || item.custom_partition != first.custom_partition
            || item.schema_version != first.schema_version
            || item.static_schema_flag != first.static_schema_flag
        {
            return Err(ToolError::Scope);
        }
        for manifest in item.snapshot.manifest_list {
            manifests.insert(
                (
                    manifest.manifest_path.clone(),
                    manifest.time_lower_bound,
                    manifest.time_upper_bound,
                ),
                manifest,
            );
        }
    }
    first.snapshot.manifest_list = manifests.into_values().collect();
    if schemas.is_empty() {
        return Err(ToolError::Unavailable);
    }
    let schema = Arc::new(Schema::try_merge(schemas).map_err(|_| ToolError::Execution)?);
    if schema.fields().len() > MAX_FIELDS {
        return Err(ToolError::OutputLimit);
    }
    let time_column = first
        .time_partition
        .as_deref()
        .filter(|column| !column.is_empty())
        .unwrap_or(crate::event::DEFAULT_TIMESTAMP_KEY);
    let field = schema
        .field_with_name(time_column)
        .map_err(|_| ToolError::Scope)?;
    if time_column.len() > 256
        || !matches!(
            field.data_type(),
            DataType::Timestamp(TimeUnit::Millisecond | TimeUnit::Nanosecond, _)
        )
    {
        return Err(ToolError::Scope);
    }
    Ok(LoadedCatalog {
        metadata: first,
        schema,
    })
}

async fn load_catalog(
    storage: &dyn ObjectStorage,
    dataset: &str,
    tenant: &Option<String>,
    remaining: &mut usize,
) -> Result<LoadedCatalog, ToolError> {
    let prefix = relative_path::RelativePathBuf::from_iter([
        tenant.as_deref().unwrap_or(""),
        dataset,
        STREAM_ROOT_DIRECTORY,
    ]);
    let documents = storage
        .native_catalog_documents(
            &prefix,
            tenant,
            MAX_DOCUMENTS,
            MAX_DOCUMENT_BYTES,
            *remaining,
        )
        .await
        .map_err(|_| ToolError::Unavailable)?;
    let mut documents_owned = Vec::new();
    for (name, bytes) in documents {
        if bytes.len() > MAX_DOCUMENT_BYTES || bytes.len() > *remaining {
            return Err(ToolError::OutputLimit);
        }
        *remaining -= bytes.len();
        documents_owned.push((name, bytes.to_vec()));
    }
    parse_catalog(&documents_owned)
}

fn memory_metadata(catalog: LoadedCatalog) -> LogStreamMetadata {
    let format = catalog.metadata;
    let fields: HashMap<_, _> = catalog
        .schema
        .fields()
        .iter()
        .map(|field| (field.name().clone(), field.clone()))
        .collect();
    let mut metadata = LogStreamMetadata::new(
        format.created_at,
        format.time_partition.unwrap_or_default(),
        format
            .time_partition_limit
            .and_then(|limit| limit.parse().ok()),
        format.custom_partition,
        format.static_schema_flag,
        fields,
        format.stream_type,
        format.schema_version,
        format.log_source,
        format.telemetry_type,
        format.dataset_tags,
        format.dataset_labels,
        format.infer_timestamp,
    );
    metadata.hot_tier_enabled = format.hot_tier_enabled;
    metadata.hot_tier = format.hot_tier;
    metadata
}

pub async fn prepare_scope(principal: &Principal, scope: &ScopeVersion) -> Result<(), ToolError> {
    scope.validate().map_err(|_| ToolError::Scope)?;
    if scope.approved_by != principal.owner_id {
        return Err(ToolError::Unauthorized);
    }
    let tenant = storage_tenant(principal);
    let storage = PARSEABLE
        .metastore
        .native_read_only_catalog_storage()
        .ok_or(ToolError::Unavailable)?;
    let mut remaining = MAX_SCOPE_METADATA_BYTES;
    for dataset in &scope.datasets {
        if is_tombstoned(storage.as_ref(), dataset, &tenant)
            .await
            .map_err(|_| ToolError::Unavailable)?
        {
            return Err(ToolError::Scope);
        }
        if let Ok(stream) = PARSEABLE.get_stream(dataset, &tenant) {
            if stream.is_deleting() || stream.get_stream_type() == StreamType::Internal {
                return Err(ToolError::Scope);
            }
            continue;
        }
        let catalog = load_catalog(storage.as_ref(), dataset, &tenant, &mut remaining).await?;
        if is_tombstoned(storage.as_ref(), dataset, &tenant)
            .await
            .map_err(|_| ToolError::Unavailable)?
        {
            return Err(ToolError::Scope);
        }
        // Stream construction initializes locks/cache only. No put_schema,
        // put_stream_json, ingestion, sync or local writer is invoked.
        let stream = PARSEABLE.streams.get_or_create(
            PARSEABLE.options.clone(),
            dataset.clone(),
            memory_metadata(catalog),
            None,
            &tenant,
        );
        if stream.is_deleting() || stream.get_stream_type() == StreamType::Internal {
            return Err(ToolError::Scope);
        }
        if is_tombstoned(storage.as_ref(), dataset, &tenant)
            .await
            .map_err(|_| ToolError::Unavailable)?
        {
            stream.mark_deleting();
            return Err(ToolError::Scope);
        }
    }
    Ok(())
}

/// Capture the authoritative bounded catalog, including ingestor snapshots,
/// for the scoped provider. Check the resident time configuration agrees.
pub(super) async fn resident_metadata(
    principal: &Principal,
    dataset: &str,
    stream: &crate::parseable::Stream,
) -> Result<ObjectStoreFormat, ToolError> {
    let tenant = storage_tenant(principal);
    let storage = PARSEABLE
        .metastore
        .native_read_only_catalog_storage()
        .ok_or(ToolError::Unavailable)?;
    if stream.is_deleting()
        || is_tombstoned(storage.as_ref(), dataset, &tenant)
            .await
            .map_err(|_| ToolError::Unavailable)?
    {
        return Err(ToolError::Scope);
    }
    let mut remaining = MAX_SCOPE_METADATA_BYTES;
    let catalog = load_catalog(storage.as_ref(), dataset, &tenant, &mut remaining).await?;
    if is_tombstoned(storage.as_ref(), dataset, &tenant)
        .await
        .map_err(|_| ToolError::Unavailable)?
    {
        return Err(ToolError::Scope);
    }
    let metadata = stream.metadata.read().map_err(|_| ToolError::Unavailable)?;
    let expected_time = metadata
        .time_partition
        .as_deref()
        .filter(|name| !name.is_empty())
        .unwrap_or(crate::event::DEFAULT_TIMESTAMP_KEY);
    let actual_time = catalog
        .metadata
        .time_partition
        .as_deref()
        .filter(|name| !name.is_empty())
        .unwrap_or(crate::event::DEFAULT_TIMESTAMP_KEY);
    if metadata.deleting
        || metadata.stream_type == StreamType::Internal
        || expected_time != actual_time
    {
        return Err(ToolError::Scope);
    }
    Ok(catalog.metadata)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn documents(format: ObjectStoreFormat, schema: Schema) -> Vec<(String, Vec<u8>)> {
        vec![
            (
                STREAM_METADATA_FILE_NAME.into(),
                serde_json::to_vec(&format).unwrap(),
            ),
            (
                SCHEMA_FILE_NAME.into(),
                serde_json::to_vec(&schema).unwrap(),
            ),
        ]
    }
    fn schema() -> Schema {
        Schema::new(vec![arrow_schema::Field::new(
            crate::event::DEFAULT_TIMESTAMP_KEY,
            DataType::Timestamp(TimeUnit::Millisecond, None),
            false,
        )])
    }
    #[test]
    fn parsing_rejects_internal_corrupt_missing_time_columns_and_oversized_metadata() {
        assert!(parse_catalog(&documents(ObjectStoreFormat::default(), schema())).is_ok());
        assert!(matches!(
            parse_catalog(&documents(
                ObjectStoreFormat {
                    stream_type: StreamType::Internal,
                    ..ObjectStoreFormat::default()
                },
                schema()
            )),
            Err(ToolError::Scope)
        ));
        assert!(matches!(
            parse_catalog(&documents(ObjectStoreFormat::default(), Schema::empty())),
            Err(ToolError::Scope)
        ));
        assert!(matches!(
            parse_catalog(&[(STREAM_METADATA_FILE_NAME.into(), b"bad json".to_vec())]),
            Err(ToolError::Execution)
        ));
        assert!(matches!(
            parse_catalog(&[(
                STREAM_METADATA_FILE_NAME.into(),
                vec![0; MAX_DOCUMENT_BYTES + 1]
            )]),
            Err(ToolError::OutputLimit)
        ));
    }
    #[test]
    fn catalog_documents_must_agree_on_time_partition_and_merge_real_snapshots() {
        use crate::catalog::snapshot::ManifestItem;
        let start = chrono::DateTime::parse_from_rfc3339("2000-01-01T00:00:00Z")
            .unwrap()
            .with_timezone(&chrono::Utc);
        let item = ManifestItem {
            manifest_path: "logs/date=2000-01-01/manifest.json".into(),
            time_lower_bound: start,
            time_upper_bound: start + chrono::TimeDelta::days(1),
            events_ingested: 1,
            ingestion_size: 1,
            storage_size: 1,
        };
        let mut format = ObjectStoreFormat::default();
        format.snapshot.manifest_list.push(item.clone());
        let mut docs = documents(format.clone(), schema());
        docs.push((
            format!(".ingestor.fixture{STREAM_METADATA_FILE_NAME}"),
            serde_json::to_vec(&format).unwrap(),
        ));
        assert_eq!(
            parse_catalog(&docs)
                .unwrap()
                .metadata
                .snapshot
                .manifest_list,
            vec![item]
        );
        format.time_partition = Some("different_time".into());
        docs[2].1 = serde_json::to_vec(&format).unwrap();
        assert!(matches!(parse_catalog(&docs), Err(ToolError::Scope)));
    }

    #[tokio::test]
    async fn native_standard_provider_reads_ingestor_snapshots_and_tenant_scoped_legacy_parquet() {
        use crate::{
            catalog::{
                manifest::{File, Manifest, encode_manifest},
                partition_path,
                snapshot::ManifestItem,
            },
            metastore::metastores::object_store_metastore::ObjectStoreMetastore,
            query::stream_schema_provider::native_read_only_table,
        };
        use arrow_array::{RecordBatch, StringArray, TimestampMillisecondArray};
        use datafusion::{
            datasource::provider_as_source,
            logical_expr::LogicalPlanBuilder,
            prelude::{SessionContext, col, lit},
            scalar::ScalarValue,
        };
        use futures_util::TryStreamExt;
        let directory = tempfile::tempdir().unwrap();
        let storage = Arc::new(crate::storage::LocalFS::new(directory.path().to_owned()));
        let metastore = Arc::new(ObjectStoreMetastore {
            storage: storage.clone(),
        });
        let schema = Arc::new(Schema::new(vec![
            arrow_schema::Field::new(
                "event_time",
                DataType::Timestamp(TimeUnit::Millisecond, None),
                false,
            ),
            arrow_schema::Field::new("message", DataType::Utf8, false),
        ]));
        let start = chrono::DateTime::parse_from_rfc3339("2000-01-01T00:00:00Z")
            .unwrap()
            .with_timezone(&chrono::Utc);
        let modern = start + chrono::TimeDelta::days(1);
        let end = modern + chrono::TimeDelta::days(1);
        let write_parquet = |relative: &str, time: i64, message: &str| {
            let path = directory.path().join(relative);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            let batch = RecordBatch::try_new(
                schema.clone(),
                vec![
                    Arc::new(TimestampMillisecondArray::from(vec![time])),
                    Arc::new(StringArray::from(vec![message])),
                ],
            )
            .unwrap();
            let mut writer = parquet::arrow::ArrowWriter::try_new(
                std::fs::File::create(&path).unwrap(),
                schema.clone(),
                None,
            )
            .unwrap();
            writer.write(&batch).unwrap();
            writer.close().unwrap();
            path
        };
        // Present before the named-tenant scan; an unscoped legacy listing
        // returns ROOT and fails the named assertion below.
        write_parquet(
            "logs/date=2000-01-01/hour=00/minute=00/root.parquet",
            start.timestamp_millis(),
            "ROOT",
        );
        for tenant in [Some("named-tenant".to_owned()), None] {
            let prefix = tenant
                .as_deref()
                .map(|tenant| format!("{tenant}/logs"))
                .unwrap_or("logs".into());
            let expected_legacy = if tenant.is_some() {
                "NAMED-LEGACY"
            } else {
                "ROOT"
            };
            if tenant.is_some() {
                write_parquet(
                    &format!("{prefix}/date=2000-01-01/hour=00/minute=00/legacy.parquet"),
                    start.timestamp_millis(),
                    expected_legacy,
                );
            }
            let modern_path = write_parquet(
                &format!("{prefix}/date=2000-01-02/hour=00/minute=00/modern.parquet"),
                modern.timestamp_millis(),
                "MODERN",
            );
            let manifest_path = partition_path("logs", modern, end, &tenant).join("manifest.json");
            let manifest = Manifest {
                version: "v1".into(),
                files: vec![File {
                    file_path: modern_path.to_str().unwrap().trim_start_matches('/').into(),
                    num_rows: 1,
                    file_size: std::fs::metadata(&modern_path).unwrap().len(),
                    ..File::default()
                }],
            };
            let absolute_manifest = manifest_path.to_path(directory.path());
            std::fs::create_dir_all(absolute_manifest.parent().unwrap()).unwrap();
            std::fs::write(absolute_manifest, encode_manifest(&manifest).unwrap()).unwrap();
            let mut format = ObjectStoreFormat {
                time_partition: Some("event_time".into()),
                ..ObjectStoreFormat::default()
            };
            format.snapshot.manifest_list.push(ManifestItem {
                manifest_path: manifest_path.to_string(),
                time_lower_bound: modern,
                time_upper_bound: end,
                events_ingested: 1,
                ingestion_size: 1,
                storage_size: 1,
            });
            let base = directory.path().join(format!("{prefix}/.stream"));
            std::fs::create_dir_all(&base).unwrap();
            for (name, bytes) in documents(format, schema.as_ref().clone()) {
                std::fs::write(base.join(format!(".ingestor.fixture{name}")), bytes).unwrap();
            }
            let mut remaining = MAX_SCOPE_METADATA_BYTES;
            let loaded = load_catalog(storage.as_ref(), "logs", &tenant, &mut remaining)
                .await
                .unwrap();
            assert_eq!(loaded.metadata.snapshot.manifest_list.len(), 1);
            let table = native_read_only_table(
                loaded.schema,
                "logs".into(),
                tenant,
                loaded.metadata,
                storage.clone(),
                metastore.clone(),
                true,
            );
            let plan = LogicalPlanBuilder::scan("logs", provider_as_source(table), None)
                .unwrap()
                .filter(
                    col("event_time")
                        .gt_eq(lit(ScalarValue::TimestampMillisecond(
                            Some(start.timestamp_millis()),
                            None,
                        )))
                        .and(col("event_time").lt(lit(ScalarValue::TimestampMillisecond(
                            Some(end.timestamp_millis()),
                            None,
                        )))),
                )
                .unwrap()
                .build()
                .unwrap();
            let context = SessionContext::new();
            let batches: Vec<RecordBatch> = context
                .execute_logical_plan(plan)
                .await
                .unwrap()
                .execute_stream()
                .await
                .unwrap()
                .try_collect()
                .await
                .unwrap();
            let mut messages = batches
                .iter()
                .flat_map(|batch| {
                    batch
                        .column(1)
                        .as_any()
                        .downcast_ref::<StringArray>()
                        .unwrap()
                        .iter()
                        .map(|value| value.unwrap().to_owned())
                })
                .collect::<Vec<_>>();
            messages.sort();
            let mut expected = vec![expected_legacy.to_owned(), "MODERN".to_owned()];
            expected.sort();
            assert_eq!(messages, expected);
            assert!(!base.join(STREAM_METADATA_FILE_NAME).exists());
            assert!(!base.join(SCHEMA_FILE_NAME).exists());
        }
    }

    #[tokio::test]
    async fn ingestor_only_local_catalog_read_does_not_publish_canonical_metadata_or_schema() {
        let directory = tempfile::tempdir().unwrap();
        let storage = crate::storage::LocalFS::new(directory.path().to_owned());
        let base = directory.path().join("logs/.stream");
        std::fs::create_dir_all(&base).unwrap();
        for (name, bytes) in documents(ObjectStoreFormat::default(), schema()) {
            std::fs::write(base.join(format!(".ingestor.fixture{name}")), bytes).unwrap();
        }
        let mut remaining = MAX_SCOPE_METADATA_BYTES;
        let loaded = load_catalog(&storage, "logs", &None, &mut remaining)
            .await
            .unwrap();
        assert_eq!(loaded.schema.fields().len(), 1);
        assert!(!base.join(STREAM_METADATA_FILE_NAME).exists());
        assert!(!base.join(SCHEMA_FILE_NAME).exists());
        assert_eq!(std::fs::read_dir(base).unwrap().count(), 2);
    }
}
