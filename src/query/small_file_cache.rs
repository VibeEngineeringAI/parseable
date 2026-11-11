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
use object_store::{GetOptions, GetRange, ObjectStore, path::Path};
use parquet::{
    arrow::{arrow_reader::ArrowReaderOptions, async_reader::AsyncFileReader},
    errors::{ParquetError, Result},
    file::metadata::{ParquetMetaData, ParquetMetaDataReader},
};
use std::{
    collections::VecDeque,
    ops::Range,
    sync::{Arc, LazyLock, Mutex},
};

const MAX_FILE: u64 = 256 * 1024;
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
#[derive(Debug, Default)]
struct Cache {
    entries: VecDeque<Entry>,
    bytes: usize,
}
impl Cache {
    fn remove(&mut self, scope: usize, path: &Path) -> Option<Entry> {
        let i = self
            .entries
            .iter()
            .position(|e| e.scope == scope && &e.path == path)?;
        let entry = self.entries.remove(i)?;
        self.bytes -= entry.bytes.len();
        Some(entry)
    }
    fn insert(&mut self, entry: Entry, budget: usize) {
        self.remove(entry.scope, &entry.path);
        if entry.bytes.len() > budget {
            return;
        }
        while self.bytes + entry.bytes.len() > budget || self.entries.len() >= MAX_ENTRIES {
            let old = self.entries.pop_front().expect("nonempty cache");
            self.bytes -= old.bytes.len();
        }
        self.bytes += entry.bytes.len();
        self.entries.push_back(entry);
    }
}
static CACHE: LazyLock<Mutex<Cache>> = LazyLock::new(Mutex::default);

async fn load(
    cache: &Mutex<Cache>,
    scope: usize,
    store: &Arc<dyn ObjectStore>,
    path: &Path,
) -> object_store::Result<(u64, Option<Bytes>)> {
    // Keep a private reference during validation; eviction cannot lose the body
    // needed for a 304. Do not hold the cache lock across network I/O.
    let old = {
        let mut cache = cache.lock().unwrap();
        let old = cache.remove(scope, path);
        if let Some(entry) = old.clone() {
            cache.insert(entry, MAX_BYTES);
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
                cache.lock().unwrap().remove(scope, path);
                return Ok((size, None));
            }
            let bytes = response.bytes().await?;
            let mut cache = cache.lock().unwrap();
            cache.remove(scope, path);
            if let Some(etag) = etag {
                cache.insert(
                    Entry {
                        scope,
                        path: path.clone(),
                        etag,
                        bytes: bytes.clone(),
                    },
                    MAX_BYTES,
                );
            }
            Ok((size, Some(bytes)))
        }
        Err(error) => {
            cache.lock().unwrap().remove(scope, path);
            Err(error)
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
) -> object_store::Result<(u64, Option<Bytes>)> {
    {
        let mut view = view.lock().unwrap();
        if let Some(entry) = view.remove(scope, path) {
            let bytes = entry.bytes.clone();
            view.insert(entry, SCAN_BYTES);
            return Ok((bytes.len() as u64, Some(bytes)));
        }
    }
    let result = load(&CACHE, scope, store, path).await?;
    if let Some(bytes) = &result.1 {
        view.lock().unwrap().insert(
            Entry {
                scope,
                path: path.clone(),
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
) -> datafusion::common::Result<Arc<dyn datafusion::physical_plan::ExecutionPlan>> {
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
        if file.object_meta.size > MAX_FILE {
            return Ok(fallback);
        }
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
            let (size, bytes) = load_for_scan(
                &self.view,
                self.scope,
                &self.store,
                &self.file.object_meta.location,
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
            if let Some(bytes) = &self.bytes {
                let size = bytes.len() as u64;
                Ok(Arc::new(
                    ParquetMetaDataReader::new()
                        .with_arrow_reader_options(options)
                        .load_and_finish(self, size)
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
            load(&cache, 1, &store, &path).await.unwrap().1.unwrap(),
            "old"
        );
        assert_eq!(
            load(&cache, 1, &store, &path).await.unwrap().1.unwrap(),
            "old"
        );
        assert_eq!(window.delta().get_requests, 2, "one validation per reader");
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
            load(&cache, 1, &store, &path).await.unwrap().1.unwrap(),
            "new"
        );
        store.delete(&path).await.unwrap();
        assert!(load(&cache, 1, &store, &path).await.is_err());
        assert!(cache.lock().unwrap().entries.is_empty());
        store
            .put(&path, Bytes::from_static(b"reborn").into())
            .await
            .unwrap();
        assert_eq!(
            load(&cache, 1, &store, &path).await.unwrap().1.unwrap(),
            "reborn"
        );
        let other: Arc<dyn ObjectStore> = Arc::new(InMemory::new());
        assert!(load(&cache, 2, &other, &path).await.is_err());
        store
            .put(&path, Bytes::from(vec![0; MAX_FILE as usize + 1]).into())
            .await
            .unwrap();
        assert!(load(&cache, 1, &store, &path).await.unwrap().1.is_none());
        assert!(cache.lock().unwrap().entries.is_empty());
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
            load_for_scan(&view, scope, &store, &path)
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
            load_for_scan(&view, scope, &store, &path)
                .await
                .unwrap()
                .1
                .unwrap(),
            "one",
            "one scan retains its validated body"
        );
        let next = Mutex::new(Cache::default());
        assert_eq!(
            load_for_scan(&next, scope, &store, &path)
                .await
                .unwrap()
                .1
                .unwrap(),
            "two",
            "new scan must validate"
        );
        store.delete(&path).await.unwrap();
        let next = Mutex::new(Cache::default());
        assert!(load_for_scan(&next, scope, &store, &path).await.is_err());
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
    use object_store::{ObjectStoreExt, memory::InMemory};
    use parquet::arrow::ArrowWriter;

    #[derive(Debug)]
    struct Table {
        schema: SchemaRef,
        files: Vec<PartitionedFile>,
        cached: bool,
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
                install(plan, state.runtime_env().object_store(url)?, 12345)
            } else {
                Ok(plan)
            }
        }
    }

    // This uses the production ParquetFormat, scan components, metrics layer,
    // and PromQL evaluator. It isolates file I/O from HTTP admission and mutable
    // catalog reads; those costs must not be presented as measured here.
    #[tokio::test]
    async fn repeated_sixty_file_queries() {
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
        let backend: Arc<dyn ObjectStore> =
            if let Ok(endpoint) = std::env::var("P_CACHE_TEST_MINIO_ENDPOINT") {
                Arc::new(
                    object_store::aws::AmazonS3Builder::new()
                        .with_endpoint(endpoint)
                        .with_allow_http(true)
                        .with_region("us-east-1")
                        .with_bucket_name("cache-measurement")
                        .with_access_key_id("minioadmin")
                        .with_secret_access_key("minioadmin")
                        .build()
                        .unwrap(),
                )
            } else {
                Arc::new(InMemory::new())
            };
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
            for cached in [false, true] {
                if cached {
                    let mut cache = CACHE.lock().unwrap();
                    for file in &files {
                        cache.remove(12345, &file.object_meta.location);
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
                    let batches = ctx.sql(sql).await.unwrap().collect().await.unwrap();
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
                        assert!(!result.into_json().to_string().is_empty());
                    }
                    let delta = window.delta();
                    println!(
                        "CACHE_MEASUREMENT {name} cached={cached} run={run} GET={} GET_RANGES={}",
                        delta.get_requests, delta.get_ranges_requests
                    );
                    if cached {
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
}
