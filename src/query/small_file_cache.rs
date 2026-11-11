/*
 * Parseable Server (C) 2022 - 2025 Parseable, Inc.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 */

//! Validated small-file bodies. Each physical scan validates before serving
//! bytes, so remote overwrites and deletes are visible without a TTL. Cache
//! scope identifies the configured provider across per-query runtime instances.
use bytes::Bytes;
use datafusion::{
    datasource::{
        listing::PartitionedFile,
        physical_plan::parquet::{DefaultParquetFileReaderFactory, ParquetFileReaderFactory},
    },
    physical_plan::metrics::ExecutionPlanMetricsSet,
};
use futures_util::{FutureExt, future::BoxFuture};
use object_store::{GetOptions, GetRange, ObjectStore, ObjectStoreExt, path::Path};
use parquet::{
    arrow::{arrow_reader::ArrowReaderOptions, async_reader::AsyncFileReader},
    errors::{ParquetError, Result},
    file::metadata::{ParquetMetaData, ParquetMetaDataReader},
};
use std::{
    collections::HashMap,
    ops::Range,
    sync::{Arc, LazyLock, Mutex},
};

const MAX_FILE: u64 = 256 * 1024;
#[cfg(test)]
const MAX_BYTES: usize = 64 * 1024 * 1024;
const SCAN_BYTES: usize = 8 * 1024 * 1024;
const MAX_ENTRIES: usize = 4096;
#[derive(Debug, Clone)]
struct Entry {
    scope: usize,
    path: Path,
    etag: String,
    bytes: Bytes,
}
type Key = (usize, Path);
#[derive(Debug)]
struct Node {
    entry: Entry,
    prev: Option<Key>,
    next: Option<Key>,
}
#[derive(Debug, Default)]
struct Cache {
    entries: HashMap<Key, Node>,
    first: Option<Key>,
    last: Option<Key>,
    bytes: usize,
}
impl Cache {
    fn remove(&mut self, scope: usize, path: &Path) -> Option<Entry> {
        let node = self.entries.remove(&(scope, path.clone()))?;
        if let Some(prev) = &node.prev {
            self.entries.get_mut(prev).unwrap().next = node.next.clone();
        } else {
            self.first = node.next.clone();
        }
        if let Some(next) = &node.next {
            self.entries.get_mut(next).unwrap().prev = node.prev.clone();
        } else {
            self.last = node.prev.clone();
        }
        self.bytes -= node.entry.bytes.len();
        Some(node.entry)
    }
    fn insert(&mut self, entry: Entry, budget: usize) {
        self.remove(entry.scope, &entry.path);
        if entry.bytes.len() > budget {
            return;
        }
        while self.bytes + entry.bytes.len() > budget || self.entries.len() >= MAX_ENTRIES {
            let (scope, path) = self.first.clone().expect("nonempty cache");
            self.remove(scope, &path);
        }
        let key = (entry.scope, entry.path.clone());
        if let Some(last) = &self.last {
            self.entries.get_mut(last).unwrap().next = Some(key.clone());
        } else {
            self.first = Some(key.clone());
        }
        self.bytes += entry.bytes.len();
        self.entries.insert(
            key.clone(),
            Node {
                entry,
                prev: self.last.take(),
                next: None,
            },
        );
        self.last = Some(key);
    }
}
static CACHE: LazyLock<Mutex<Cache>> = LazyLock::new(Mutex::default);

async fn load(
    cache: &Mutex<Cache>,
    scope: usize,
    store: &Arc<dyn ObjectStore>,
    path: &Path,
    namespace: &str,
    budget: usize,
) -> object_store::Result<(u64, Option<Bytes>)> {
    let key = Path::from(format!("{namespace}{}", path.as_ref()));
    // Keep a private reference during validation; eviction cannot lose the body
    // needed for a 304. Do not hold the cache lock across network I/O.
    let old = {
        let mut cache = cache.lock().unwrap();
        let old = cache.remove(scope, &key);
        if let Some(entry) = old.clone() {
            cache.insert(entry, budget);
        }
        old
    };
    let response = store
        .get_opts(
            path,
            GetOptions {
                if_none_match: old.as_ref().map(|e| e.etag.clone()),
                range: Some(GetRange::Bounded(0..MAX_FILE + 1)),
                ..Default::default()
            },
        )
        .await;
    match response {
        Err(object_store::Error::NotModified { .. }) if old.is_some() => {
            let bytes = old.unwrap().bytes;
            Ok((bytes.len() as u64, Some(bytes)))
        }
        Ok(response) => {
            let size = response.meta.size;
            let etag = response.meta.e_tag.clone();
            if size > MAX_FILE {
                cache.lock().unwrap().remove(scope, &key);
                return Ok((size, None));
            }
            let bytes = match response.bytes().await {
                Ok(bytes) => bytes,
                Err(error) => {
                    cache.lock().unwrap().remove(scope, &key);
                    return Err(error);
                }
            };
            let mut cache = cache.lock().unwrap();
            cache.remove(scope, &key);
            if let Some(etag) = etag.filter(|tag| !tag.starts_with("W/")) {
                cache.insert(
                    Entry {
                        scope,
                        path: key.clone(),
                        etag,
                        bytes: bytes.clone(),
                    },
                    budget,
                );
            }
            Ok((size, Some(bytes)))
        }
        Err(error) if non_partial(&error) => {
            cache.lock().unwrap().remove(scope, &key);
            // HEAD obtains the current size without trusting a stale manifest.
            Ok((store.head(path).await?.size, None))
        }
        Err(error) => {
            cache.lock().unwrap().remove(scope, &key);
            Err(error)
        }
    }
}

fn non_partial(error: &object_store::Error) -> bool {
    use std::error::Error;
    let mut cause: &dyn Error = error;
    loop {
        if cause.to_string() == "Received non-partial response when range requested" {
            return true;
        }
        match cause.source() {
            Some(source) => cause = source,
            None => return false,
        }
    }
}

// Metadata and data readers of one physical scan share a bounded view. A new
// physical scan always validates against storage; it cannot inherit this view.
async fn load_for_scan(
    view: &Mutex<Cache>,
    scope: usize,
    store: &Arc<dyn ObjectStore>,
    path: &Path,
    namespace: &str,
    budget: usize,
) -> object_store::Result<(u64, Option<Bytes>)> {
    let key = Path::from(format!("{namespace}{}", path.as_ref()));
    {
        let mut view = view.lock().unwrap();
        if let Some(entry) = view.remove(scope, &key) {
            let bytes = entry.bytes.clone();
            view.insert(entry, SCAN_BYTES);
            return Ok((bytes.len() as u64, Some(bytes)));
        }
    }
    let result = load(&CACHE, scope, store, path, namespace, budget).await?;
    if let Some(bytes) = &result.1 {
        view.lock().unwrap().insert(
            Entry {
                scope,
                path: key,
                etag: String::new(),
                bytes: bytes.clone(),
            },
            SCAN_BYTES,
        );
    }
    Ok(result)
}

pub(super) fn install(
    plan: Arc<dyn datafusion::physical_plan::ExecutionPlan>,
    store: Arc<dyn ObjectStore>,
    scope: usize,
    budget: usize,
    enabled: bool,
) -> datafusion::common::Result<Arc<dyn datafusion::physical_plan::ExecutionPlan>> {
    if !enabled || budget == 0 {
        return Ok(plan);
    }
    use datafusion::datasource::{
        physical_plan::{FileScanConfigBuilder, ParquetSource},
        source::DataSourceExec,
    };
    let exec = plan
        .downcast_ref::<DataSourceExec>()
        .expect("ParquetFormat returns DataSourceExec");
    let (conf, source) = exec
        .downcast_to_file_source::<ParquetSource>()
        .expect("parquet source");
    // Bypass scans whose predicted working set cannot survive one traversal.
    let small = conf
        .file_groups
        .iter()
        .flat_map(|group| group.iter())
        .filter(|file| file.object_meta.size <= MAX_FILE)
        .collect::<Vec<_>>();
    if small.len() > MAX_ENTRIES
        || small
            .iter()
            .map(|file| file.object_meta.size as u128)
            .sum::<u128>()
            > budget as u128
    {
        return Ok(plan);
    }
    let namespace = conf.object_store_url.to_string();
    let fallback = source
        .parquet_file_reader_factory()
        .cloned()
        .unwrap_or_else(|| Arc::new(DefaultParquetFileReaderFactory::new(store.clone())));
    let source =
        source
            .clone()
            .with_parquet_file_reader_factory(Arc::new(SmallFileReaderFactory {
                store,
                fallback,
                scope,
                namespace,
                budget,
                view: Arc::new(Mutex::default()),
            }));
    Ok(Arc::new(
        exec.clone().with_data_source(Arc::new(
            FileScanConfigBuilder::from(conf.clone())
                .with_source(Arc::new(source))
                .build(),
        )),
    ))
}

#[derive(Debug)]
pub(super) struct SmallFileReaderFactory {
    view: Arc<Mutex<Cache>>,
    scope: usize,
    namespace: String,
    budget: usize,
    pub store: Arc<dyn ObjectStore>,
    fallback: Arc<dyn ParquetFileReaderFactory>,
}
impl ParquetFileReaderFactory for SmallFileReaderFactory {
    fn create_reader(
        &self,
        partition: usize,
        file: PartitionedFile,
        hint: Option<usize>,
        metrics: &ExecutionPlanMetricsSet,
    ) -> datafusion::common::Result<Box<dyn AsyncFileReader + Send>> {
        let fallback = self
            .fallback
            .create_reader(partition, file.clone(), hint, metrics)?;
        let file_metrics = datafusion::datasource::physical_plan::ParquetFileMetrics::new(
            partition,
            file.object_meta.location.as_ref(),
            metrics,
        );
        Ok(Box::new(Reader {
            file_metrics,
            hint,
            view: self.view.clone(),
            store: self.store.clone(),
            scope: self.scope,
            namespace: self.namespace.clone(),
            budget: self.budget,
            file,
            partition,
            metrics: metrics.clone(),
            fallback,
            factory: self.fallback.clone(),
            initialized: false,
            bytes: None,
        }))
    }
}
struct Reader {
    hint: Option<usize>,
    view: Arc<Mutex<Cache>>,
    file_metrics: datafusion::datasource::physical_plan::ParquetFileMetrics,
    scope: usize,
    namespace: String,
    budget: usize,
    factory: Arc<dyn ParquetFileReaderFactory>,
    store: Arc<dyn ObjectStore>,
    file: PartitionedFile,
    partition: usize,
    metrics: ExecutionPlanMetricsSet,
    fallback: Box<dyn AsyncFileReader + Send>,
    initialized: bool,
    bytes: Option<Bytes>,
}
impl Reader {
    async fn init(&mut self) -> Result<()> {
        if !self.initialized {
            if self.file.object_meta.size > MAX_FILE {
                self.initialized = true;
                return Ok(());
            }
            let (size, bytes) = load_for_scan(
                &self.view,
                self.scope,
                &self.store,
                &self.file.object_meta.location,
                &self.namespace,
                self.budget,
            )
            .await
            .map_err(|e| ParquetError::External(Box::new(e)))?;
            if bytes.is_none() {
                self.file.object_meta.size = size;
                self.fallback = self
                    .factory
                    .create_reader(self.partition, self.file.clone(), self.hint, &self.metrics)
                    .map_err(|e| ParquetError::External(Box::new(e)))?;
            }
            self.bytes = bytes;
            self.initialized = true;
        }
        Ok(())
    }
}
impl AsyncFileReader for Reader {
    fn get_bytes(&mut self, range: Range<u64>) -> BoxFuture<'_, Result<Bytes>> {
        async move {
            self.init().await?;
            if let Some(bytes) = &self.bytes {
                if range.start > range.end || range.end > bytes.len() as u64 {
                    return Err(ParquetError::General("Invalid parquet byte range".into()));
                }
                self.file_metrics
                    .bytes_scanned
                    .add((range.end - range.start) as usize);
                Ok(bytes.slice(range.start as usize..range.end as usize))
            } else {
                self.fallback.get_bytes(range).await
            }
        }
        .boxed()
    }
    fn get_byte_ranges(&mut self, ranges: Vec<Range<u64>>) -> BoxFuture<'_, Result<Vec<Bytes>>> {
        async move {
            self.init().await?;
            if self.bytes.is_none() {
                return self.fallback.get_byte_ranges(ranges).await;
            }
            let mut out = Vec::with_capacity(ranges.len());
            for range in ranges {
                out.push(self.get_bytes(range).await?);
            }
            Ok(out)
        }
        .boxed()
    }
    fn get_metadata<'a>(
        &'a mut self,
        options: Option<&'a ArrowReaderOptions>,
    ) -> BoxFuture<'a, Result<Arc<ParquetMetaData>>> {
        async move {
            self.init().await?;
            if self.bytes.is_none() {
                match self.fallback.get_metadata(options).await {
                    Ok(metadata) => return Ok(metadata),
                    Err(error) => {
                        // A formerly large object may have shrunk while the
                        // manifest still describes its old footer position.
                        let current = self
                            .store
                            .head(&self.file.object_meta.location)
                            .await
                            .map_err(|e| ParquetError::External(Box::new(e)))?;
                        if current.size == self.file.object_meta.size {
                            return Err(error);
                        }
                        self.file.object_meta = current;
                        self.fallback = self
                            .factory
                            .create_reader(
                                self.partition,
                                self.file.clone(),
                                self.hint,
                                &self.metrics,
                            )
                            .map_err(|e| ParquetError::External(Box::new(e)))?;
                        self.initialized = false;
                        self.init().await?;
                    }
                }
            }
            if let Some(bytes) = &self.bytes {
                let size = bytes.len() as u64;
                let mut reader = std::io::Cursor::new(bytes.clone());
                Ok(Arc::new(
                    ParquetMetaDataReader::new()
                        .with_arrow_reader_options(options)
                        .load_and_finish(&mut reader, size)
                        .await?,
                ))
            } else {
                self.fallback.get_metadata(options).await
            }
        }
        .boxed()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::{StorageMetricWindow, metrics_layer::MetricLayer};
    use object_store::{ObjectStoreExt, memory::InMemory};

    #[tokio::test]
    async fn hit_miss_overwrite_delete_recreate_and_store_isolation() {
        let store: Arc<dyn ObjectStore> =
            Arc::new(MetricLayer::new(InMemory::new(), "small-cache-test"));
        let cache = Mutex::new(Cache::default());
        let path = Path::from("tenant/stream/file.parquet");
        store
            .put(&path, Bytes::from_static(b"old").into())
            .await
            .unwrap();
        let window = StorageMetricWindow::start("small-cache-test");
        assert_eq!(
            load(&cache, 1, &store, &path, "", MAX_BYTES)
                .await
                .unwrap()
                .1
                .unwrap(),
            "old"
        );
        assert_eq!(
            load(&cache, 1, &store, &path, "", MAX_BYTES)
                .await
                .unwrap()
                .1
                .unwrap(),
            "old"
        );
        assert_eq!(window.delta().get_requests, 2, "one validation per reader");
        assert_eq!(window.delta().read_bytes, 3);
        assert_eq!(window.delta().not_modified_requests, 1);
        assert_eq!(window.delta().non_2xx_requests, 0);
        assert_eq!(
            crate::metrics::STORAGE_REQUEST_RESPONSE_TIME
                .with_label_values(&["small-cache-test", "GET", "304"])
                .get_sample_count(),
            1
        );
        assert_eq!(cache.lock().unwrap().entries.len(), 1);
        store
            .put(&path, Bytes::from_static(b"new").into())
            .await
            .unwrap();
        assert_eq!(
            load(&cache, 1, &store, &path, "", MAX_BYTES)
                .await
                .unwrap()
                .1
                .unwrap(),
            "new"
        );
        store.delete(&path).await.unwrap();
        assert!(load(&cache, 1, &store, &path, "", MAX_BYTES).await.is_err());
        assert!(cache.lock().unwrap().entries.is_empty());
        store
            .put(&path, Bytes::from_static(b"reborn").into())
            .await
            .unwrap();
        assert_eq!(
            load(&cache, 1, &store, &path, "", MAX_BYTES)
                .await
                .unwrap()
                .1
                .unwrap(),
            "reborn"
        );
        let other: Arc<dyn ObjectStore> = Arc::new(InMemory::new());
        other
            .put(&path, Bytes::from_static(b"separate").into())
            .await
            .unwrap();
        assert_eq!(
            load(&cache, 1, &other, &path, "s3://other/", MAX_BYTES)
                .await
                .unwrap()
                .1
                .unwrap(),
            "separate"
        );
        assert_eq!(
            load(&cache, 1, &store, &path, "s3://original/", MAX_BYTES)
                .await
                .unwrap()
                .1
                .unwrap(),
            "reborn"
        );
        other.delete(&path).await.unwrap();
        assert!(load(&cache, 2, &other, &path, "", MAX_BYTES).await.is_err());
        store
            .put(&path, Bytes::from(vec![0; MAX_FILE as usize + 1]).into())
            .await
            .unwrap();
        assert!(
            load(&cache, 1, &store, &path, "", MAX_BYTES)
                .await
                .unwrap()
                .1
                .is_none()
        );
        assert!(cache.lock().unwrap().remove(1, &path).is_none());
    }

    #[tokio::test]
    async fn scan_view_is_bounded_and_new_scan_validates_changes() {
        let store: Arc<dyn ObjectStore> = Arc::new(InMemory::new());
        let scope = 99881;
        let path = Path::from("view/file.parquet");
        let view = Mutex::new(Cache::default());
        store
            .put(&path, Bytes::from_static(b"one").into())
            .await
            .unwrap();
        assert_eq!(
            load_for_scan(&view, scope, &store, &path, "", MAX_BYTES)
                .await
                .unwrap()
                .1
                .unwrap(),
            "one"
        );
        store
            .put(&path, Bytes::from_static(b"two").into())
            .await
            .unwrap();
        assert_eq!(
            load_for_scan(&view, scope, &store, &path, "", MAX_BYTES)
                .await
                .unwrap()
                .1
                .unwrap(),
            "one",
            "one scan retains its validated body"
        );
        let next = Mutex::new(Cache::default());
        assert_eq!(
            load_for_scan(&next, scope, &store, &path, "", MAX_BYTES)
                .await
                .unwrap()
                .1
                .unwrap(),
            "two",
            "new scan must validate"
        );
        store.delete(&path).await.unwrap();
        let next = Mutex::new(Cache::default());
        assert!(
            load_for_scan(&next, scope, &store, &path, "", MAX_BYTES)
                .await
                .is_err()
        );
        let mut view = view.lock().unwrap();
        for i in 0..40 {
            view.insert(
                Entry {
                    scope,
                    path: Path::from(format!("{i}")),
                    etag: String::new(),
                    bytes: Bytes::from(vec![0; MAX_FILE as usize]),
                },
                SCAN_BYTES,
            );
        }
        assert!(view.bytes <= SCAN_BYTES);
        assert!(view.remove(scope, &path).is_none());
    }

    #[test]
    fn bounds_eviction_and_replacement() {
        let mut cache = Cache::default();
        let entry = |name: &str, len| Entry {
            scope: 1,
            path: Path::from(name),
            etag: "v1".into(),
            bytes: Bytes::from(vec![0; len]),
        };
        cache.insert(entry("a", 3), 5);
        cache.insert(entry("b", 3), 5);
        assert!(cache.remove(1, &Path::from("a")).is_none());
        assert_eq!(cache.bytes, 3);
        cache.insert(entry("b", 2), 5);
        assert_eq!(cache.bytes, 2);
        cache.insert(entry("huge", 6), 5);
        assert_eq!(cache.bytes, 2);
        for i in 0..MAX_ENTRIES + 1 {
            cache.insert(entry(&i.to_string(), 0), 5);
        }
        assert_eq!(cache.entries.len(), MAX_ENTRIES);
        assert!(cache.remove(1, &Path::from("0")).is_none());
    }
}

#[cfg(test)]
mod measurement {
    use super::*;
    use crate::{
        promql::{self, QueryPlan, Sample, Series},
        query::stream_schema_provider::build_parquet_scan_components,
        storage::{StorageMetricWindow, metrics_layer::MetricLayer},
    };
    use arrow_array::{Array, Float64Array, RecordBatch, StringArray, TimestampMillisecondArray};
    use arrow_schema::{DataType, Field, Schema, SchemaRef, TimeUnit};
    use datafusion::{
        catalog::Session,
        datasource::{
            TableProvider,
            file_format::FileFormat,
            physical_plan::{FileGroup, FileScanConfigBuilder},
        },
        execution::object_store::ObjectStoreUrl,
        logical_expr::TableType,
        physical_plan::ExecutionPlan,
        prelude::{Expr, SessionConfig, SessionContext},
    };
    use object_store::ObjectStoreExt;
    use parquet::arrow::ArrowWriter;

    #[derive(Debug)]
    struct Table {
        schema: SchemaRef,
        files: Vec<PartitionedFile>,
        cached: bool,
        disabled: bool,
    }
    #[async_trait::async_trait]
    impl TableProvider for Table {
        fn schema(&self) -> SchemaRef {
            self.schema.clone()
        }
        fn table_type(&self) -> TableType {
            TableType::Base
        }
        async fn scan(
            &self,
            state: &dyn Session,
            projection: Option<&Vec<usize>>,
            filters: &[Expr],
            limit: Option<usize>,
        ) -> datafusion::common::Result<Arc<dyn ExecutionPlan>> {
            let url = ObjectStoreUrl::parse("s3://cache-measurement").unwrap();
            let (format, source) =
                build_parquet_scan_components(self.schema.clone(), filters, state)?;
            let mut builder = FileScanConfigBuilder::new(url.clone(), source.into())
                .with_file_groups(
                    self.files
                        .chunks(15)
                        .map(|files| FileGroup::new(files.to_vec()))
                        .collect(),
                )
                .with_limit(limit);
            if let Some(p) = projection {
                builder = builder.with_projection_indices(Some(p.clone()))?;
            }
            let plan = format.create_physical_plan(state, builder.build()).await?;
            if self.cached {
                install(
                    plan,
                    state.runtime_env().object_store(url)?,
                    12345,
                    MAX_BYTES,
                    true,
                )
            } else if self.disabled {
                install(
                    plan,
                    state.runtime_env().object_store(url)?,
                    12345,
                    MAX_BYTES,
                    false,
                )
            } else {
                Ok(plan)
            }
        }
    }

    // This uses the production ParquetFormat, scan components, metrics layer,
    // and PromQL evaluator. It isolates file I/O from HTTP admission and mutable
    // catalog reads; those costs must not be presented as measured here.
    #[tokio::test]
    #[ignore = "requires real MinIO; set P_CACHE_TEST_MINIO_ENDPOINT and run --ignored --nocapture"]
    async fn repeated_sixty_file_queries() {
        let endpoint = std::env::var("P_CACHE_TEST_MINIO_ENDPOINT")
            .expect("HTTP test requires P_CACHE_TEST_MINIO_ENDPOINT");
        let schema = Arc::new(Schema::new(vec![
            Field::new(
                "p_timestamp",
                DataType::Timestamp(TimeUnit::Millisecond, None),
                false,
            ),
            Field::new(
                "time_unix_nano",
                DataType::Timestamp(TimeUnit::Millisecond, None),
                false,
            ),
            Field::new("metric_name", DataType::Utf8, false),
            Field::new("job", DataType::Utf8, false),
            Field::new("data_point_value", DataType::Float64, false),
        ]));
        let backend: Arc<dyn ObjectStore> = s3(&endpoint);
        let store: Arc<dyn ObjectStore> = Arc::new(MetricLayer::new(backend, "cache-measurement"));
        let mut files = Vec::new();
        for minute in 0..60 {
            let times: Vec<i64> = (0..480).map(|i| minute * 60_000 + i * 125).collect();
            let batch = RecordBatch::try_new(
                schema.clone(),
                vec![
                    Arc::new(TimestampMillisecondArray::from(times.clone())),
                    Arc::new(TimestampMillisecondArray::from(times)),
                    Arc::new(StringArray::from(vec!["requests"; 480])),
                    Arc::new(StringArray::from(
                        (0..480)
                            .map(|i| if i % 2 == 0 { "api" } else { "worker" })
                            .collect::<Vec<_>>(),
                    )),
                    Arc::new(Float64Array::from(
                        (0..480)
                            .map(|i| (minute * 480 + i) as f64)
                            .collect::<Vec<_>>(),
                    )),
                ],
            )
            .unwrap();
            let mut body = Vec::new();
            let mut writer = ArrowWriter::try_new(&mut body, schema.clone(), None).unwrap();
            writer.write(&batch).unwrap();
            writer.close().unwrap();
            let path = format!("metrics/{minute}.parquet");
            files.push(PartitionedFile::new(path.clone(), body.len() as u64));
            store
                .put(&Path::from(path), Bytes::from(body).into())
                .await
                .unwrap();
        }
        println!(
            "CACHE_MEASUREMENT stored_bytes={} files={}",
            files.iter().map(|file| file.object_meta.size).sum::<u64>(),
            files.len()
        );
        let queries = [
            ("count", "SELECT COUNT(*) FROM metrics"),
            (
                "group",
                "SELECT job, SUM(data_point_value) FROM metrics WHERE data_point_value > 100 GROUP BY job ORDER BY job",
            ),
            (
                "promql",
                "SELECT time_unix_nano, data_point_value FROM metrics WHERE metric_name = 'requests' AND job = 'api' ORDER BY time_unix_nano",
            ),
        ];
        for (name, sql) in queries {
            let mut reference = None;
            let mut reference_bytes = None;
            let mut reference_requests = None;
            for (cached, disabled) in [(false, false), (false, true), (true, false)] {
                if cached {
                    let mut cache = CACHE.lock().unwrap();
                    for file in &files {
                        cache.remove(
                            12345,
                            &Path::from(format!(
                                "s3://cache-measurement/{}",
                                file.object_meta.location
                            )),
                        );
                    }
                }
                for run in 0..2 {
                    // Production builds a new query session; the process cache
                    // survives these sessions, DataFusion's session cache doesn't.
                    let mut config = SessionConfig::new().with_target_partitions(4);
                    config.options_mut().execution.parquet.metadata_size_hint =
                        Some(2 * 1024 * 1024);
                    config.options_mut().execution.parquet.enable_page_index = true;
                    config.options_mut().execution.parquet.pushdown_filters = true;
                    let ctx = SessionContext::new_with_config(config);
                    ctx.runtime_env().register_object_store(
                        &url::Url::parse("s3://cache-measurement").unwrap(),
                        store.clone(),
                    );
                    ctx.register_table(
                        "metrics",
                        Arc::new(Table {
                            schema: schema.clone(),
                            files: files.clone(),
                            cached,
                            disabled,
                        }),
                    )
                    .unwrap();
                    let not_modified = || {
                        crate::metrics::STORAGE_REQUEST_RESPONSE_TIME
                            .with_label_values(&["cache-measurement", "GET", "304"])
                            .get_sample_count()
                    };
                    let before_304 = not_modified();
                    let window = StorageMetricWindow::start("cache-measurement");
                    let df = ctx.sql(sql).await.unwrap();
                    let task = ctx.task_ctx();
                    let plan = df.create_physical_plan().await.unwrap();
                    let batches = datafusion::physical_plan::collect(plan.clone(), task)
                        .await
                        .unwrap();
                    let scanned = scanned_bytes(&plan);
                    if let Some(expected) = reference_bytes {
                        assert_eq!(scanned, expected, "{name} cached={cached} run={run}");
                    } else {
                        reference_bytes = Some(scanned);
                    }
                    let result = arrow::util::pretty::pretty_format_batches(&batches)
                        .unwrap()
                        .to_string();
                    if let Some(reference) = &reference {
                        assert_eq!(&result, reference);
                    } else {
                        reference = Some(result);
                    }
                    if name == "promql" {
                        let mut samples = Vec::new();
                        for batch in &batches {
                            let times = batch
                                .column(0)
                                .as_any()
                                .downcast_ref::<TimestampMillisecondArray>()
                                .unwrap();
                            let values = batch
                                .column(1)
                                .as_any()
                                .downcast_ref::<Float64Array>()
                                .unwrap();
                            for i in 0..times.len() {
                                samples.push(Sample {
                                    timestamp_ms: times.value(i),
                                    value: values.value(i),
                                });
                            }
                        }
                        let series = Series {
                            labels: [
                                ("__name__".into(), "requests".into()),
                                ("job".into(), "api".into()),
                            ]
                            .into(),
                            samples,
                        };
                        let plan =
                            QueryPlan::parse("sum(rate(requests{job=\"api\"}[5m]))").unwrap();
                        let result =
                            promql::evaluate_range(&plan, &[series], 300_000, 3_540_000, 60_000)
                                .unwrap();
                        let json = result.into_json();
                        let values = json["result"][0]["values"].as_array().unwrap();
                        assert_eq!(values.len(), 55);
                        for (i, point) in values.iter().enumerate() {
                            assert_eq!(point[0].as_f64().unwrap(), 300.0 + i as f64 * 60.0);
                            let value: f64 = point[1].as_str().unwrap().parse().unwrap();
                            assert!((value - 8.0).abs() < 1e-9, "{point}");
                        }
                    }
                    let delta = window.delta();
                    let requests = (delta.get_requests, delta.get_ranges_requests);
                    if disabled {
                        assert_eq!(
                            Some(requests),
                            reference_requests,
                            "kill switch must preserve original HTTP request pattern"
                        );
                    } else if !cached {
                        reference_requests = Some(requests);
                    }
                    println!(
                        "CACHE_MEASUREMENT {name} cached={cached} disabled={disabled} run={run} GET={} GET_RANGES={}",
                        delta.get_requests, delta.get_ranges_requests
                    );
                    if cached {
                        assert_eq!(delta.non_2xx_requests, 0);
                        assert_eq!(
                            delta.read_bytes,
                            if run == 0 {
                                files.iter().map(|f| f.object_meta.size).sum()
                            } else {
                                0
                            }
                        );
                        if run == 1 {
                            assert_eq!(
                                not_modified() - before_304,
                                60,
                                "warm scans validate with 304"
                            );
                        }
                        assert_eq!(delta.get_ranges_requests, 0);
                        assert_eq!(delta.get_requests, 60);
                    }
                }
            }
        }
    }
    #[tokio::test]
    async fn disabled_and_oversized_install_preserve_original_plan() {
        let ctx = SessionContext::new();
        let store: Arc<dyn ObjectStore> = Arc::new(object_store::memory::InMemory::new());
        ctx.runtime_env().register_object_store(
            &url::Url::parse("s3://cache-measurement").unwrap(),
            store.clone(),
        );
        for count in [1, MAX_ENTRIES + 1] {
            let table = Table {
                schema: Arc::new(Schema::new(vec![Field::new(
                    "value",
                    DataType::Int64,
                    false,
                )])),
                files: (0..count)
                    .map(|i| PartitionedFile::new(format!("{i}.parquet"), 10))
                    .collect(),
                cached: false,
                disabled: false,
            };
            let plan = table.scan(&ctx.state(), None, &[], None).await.unwrap();
            for (enabled, budget) in [(false, MAX_BYTES), (true, 0), (true, 9)] {
                let actual = install(plan.clone(), store.clone(), 0, budget, enabled).unwrap();
                assert!(Arc::ptr_eq(&actual, &plan));
            }
            if count > MAX_ENTRIES {
                assert!(Arc::ptr_eq(
                    &install(plan.clone(), store.clone(), 0, MAX_BYTES, true).unwrap(),
                    &plan
                ));
            }
        }
    }

    fn s3(endpoint: &str) -> Arc<dyn ObjectStore> {
        Arc::new(
            object_store::aws::AmazonS3Builder::new()
                .with_retry(object_store::RetryConfig {
                    max_retries: 0,
                    ..Default::default()
                })
                .with_endpoint(endpoint)
                .with_allow_http(true)
                .with_region("us-east-1")
                .with_bucket_name("cache-measurement")
                .with_access_key_id("minioadmin")
                .with_secret_access_key("minioadmin")
                .build()
                .unwrap(),
        )
    }

    fn scanned_bytes(plan: &Arc<dyn ExecutionPlan>) -> usize {
        plan.metrics()
            .and_then(|m| m.sum_by_name("bytes_scanned"))
            .map(|m| m.as_usize())
            .unwrap_or(0)
            + plan
                .children()
                .iter()
                .map(|p| scanned_bytes(p))
                .sum::<usize>()
    }

    struct Proxy(std::process::Child);
    impl Drop for Proxy {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    async fn query(
        store: Arc<dyn ObjectStore>,
        size: u64,
        cached: bool,
    ) -> datafusion::common::Result<Vec<i64>> {
        let ctx = SessionContext::new();
        ctx.runtime_env()
            .register_object_store(&url::Url::parse("s3://cache-measurement").unwrap(), store);
        ctx.register_table(
            "metrics",
            Arc::new(Table {
                schema: Arc::new(Schema::new(vec![Field::new(
                    "value",
                    DataType::Int64,
                    false,
                )])),
                files: vec![PartitionedFile::new("mutations/data.parquet", size)],
                cached,
                disabled: false,
            }),
        )?;
        let batches = ctx
            .sql("SELECT value FROM metrics ORDER BY value")
            .await?
            .collect()
            .await?;
        Ok(batches
            .iter()
            .flat_map(|b| {
                b.column(0)
                    .as_any()
                    .downcast_ref::<arrow_array::Int64Array>()
                    .unwrap()
                    .values()
                    .to_vec()
            })
            .collect())
    }

    fn parquet(values: Vec<i64>) -> Bytes {
        let batch = RecordBatch::try_from_iter(vec![(
            "value",
            Arc::new(arrow_array::Int64Array::from(values)) as arrow_array::ArrayRef,
        )])
        .unwrap();
        let mut body = Vec::new();
        let mut writer = ArrowWriter::try_new(&mut body, batch.schema(), None).unwrap();
        writer.write(&batch).unwrap();
        writer.close().unwrap();
        Bytes::from(body)
    }

    #[tokio::test]
    #[ignore = "requires real MinIO; set P_CACHE_TEST_MINIO_ENDPOINT and run --ignored --nocapture"]
    async fn http_mutations_and_faults() {
        use std::io::{BufRead, BufReader};
        let endpoint = std::env::var("P_CACHE_TEST_MINIO_ENDPOINT")
            .expect("HTTP test requires P_CACHE_TEST_MINIO_ENDPOINT");
        let dir = tempfile::tempdir_in(".").unwrap();
        let mode = dir.path().join("mode");
        std::fs::write(&mode, "normal").unwrap();
        let mut proxy = Proxy(
            std::process::Command::new("python3")
                .args([
                    "-u",
                    "src/query/cache_http_proxy.py",
                    &endpoint,
                    mode.to_str().unwrap(),
                ])
                .stdout(std::process::Stdio::piped())
                .spawn()
                .unwrap(),
        );
        let mut port = String::new();
        BufReader::new(proxy.0.stdout.take().unwrap())
            .read_line(&mut port)
            .unwrap();
        let backend = s3(&endpoint);
        let store: Arc<dyn ObjectStore> = Arc::new(MetricLayer::new(
            s3(&format!("http://127.0.0.1:{}", port.trim())),
            "http-mutations",
        ));
        let path = Path::from("mutations/data.parquet");
        let old = parquet(vec![1, 2, 3]);
        let new = parquet(vec![4, 5, 6]);
        assert_eq!(old.len(), new.len());
        backend.put(&path, old.clone().into()).await.unwrap();
        for _ in 0..2 {
            assert_eq!(
                query(store.clone(), old.len() as u64, true).await.unwrap(),
                [1, 2, 3]
            );
        }
        backend.put(&path, new.clone().into()).await.unwrap();
        assert_eq!(
            query(store.clone(), old.len() as u64, true).await.unwrap(),
            [4, 5, 6]
        );
        backend.delete(&path).await.unwrap();
        assert!(query(store.clone(), old.len() as u64, false).await.is_err());
        assert!(query(store.clone(), old.len() as u64, true).await.is_err());
        backend.put(&path, old.clone().into()).await.unwrap();
        assert_eq!(
            query(store.clone(), old.len() as u64, true).await.unwrap(),
            [1, 2, 3]
        );
        std::fs::write(&mode, "fail").unwrap();
        assert!(query(store.clone(), old.len() as u64, true).await.is_err());
        std::fs::write(&mode, "normal").unwrap();
        assert_eq!(
            query(store.clone(), old.len() as u64, true).await.unwrap(),
            [1, 2, 3]
        );
        backend.put(&path, new.clone().into()).await.unwrap();
        std::fs::write(&mode, "broken").unwrap();
        assert!(query(store.clone(), old.len() as u64, true).await.is_err());
        assert!(!CACHE.lock().unwrap().entries.contains_key(&(
            12345,
            Path::from("s3://cache-measurement/mutations/data.parquet")
        )));
        std::fs::write(&mode, "normal").unwrap();
        assert_eq!(
            query(store.clone(), new.len() as u64, true).await.unwrap(),
            [4, 5, 6]
        );
        for fault in ["absent", "weak", "full"] {
            // Remove a prior strong validator, then exercise two independent scans.
            backend.delete(&path).await.unwrap();
            assert!(query(store.clone(), old.len() as u64, true).await.is_err());
            backend.put(&path, new.clone().into()).await.unwrap();
            std::fs::write(&mode, fault).unwrap();
            std::fs::write(mode.with_extension("requests"), "").unwrap();
            let window = StorageMetricWindow::start("http-mutations");
            for _ in 0..2 {
                assert_eq!(
                    query(store.clone(), new.len() as u64, true).await.unwrap(),
                    [4, 5, 6]
                );
            }
            assert_eq!(window.delta().not_modified_requests, 0, "{fault}");
            if fault != "full" {
                assert_eq!(
                    std::fs::read_to_string(mode.with_extension("requests")).unwrap(),
                    "False\nFalse\n",
                    "{fault}"
                );
            }
            std::fs::write(&mode, "normal").unwrap();
        }
        // Unique integers defeat dictionary compression, producing a real large parquet file.
        let values = (0..100_000).collect::<Vec<i64>>();
        let large = parquet(values.clone());
        assert!(large.len() as u64 > MAX_FILE);
        backend.put(&path, large.clone().into()).await.unwrap();
        for size in [old.len(), large.len()] {
            assert_eq!(
                query(store.clone(), size as u64, true).await.unwrap(),
                values
            );
        }
        backend.put(&path, old.clone().into()).await.unwrap();
        for size in [large.len(), old.len()] {
            assert_eq!(
                query(store.clone(), size as u64, true).await.unwrap(),
                [1, 2, 3]
            );
        }
        backend.delete(&path).await.unwrap();
    }
}
