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

//! Query results over Parquet files whose footer claims a time ordering that their rows do not
//! have.
//!
//! The files come from the real staging writer (`Stream::push` -> `flush` ->
//! `convert_disk_files_to_parquet`), and their manifest entries from `create_from_parquet_file`.
//! Scans are planned with the production `partitioned_files` and `parquet_scan_plan`, or for data
//! no manifest covers, `ListingTableBuilder`. Every result is compared with an independent sort of
//! the decoded rows. Where a `LIMIT` cuts through equal timestamps the test only checks that the
//! rows came from that timestamp, because SQL leaves their order and selection open.

use std::{
    collections::{BTreeMap, HashMap},
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

use arrow_array::{Array, Float64Array, Int64Array, TimestampMillisecondArray};
use arrow_schema::{DataType, Field, TimeUnit};
use chrono::NaiveDate;
use datafusion::{
    execution::SessionStateBuilder,
    physical_plan::{collect, displayable},
    prelude::{SessionConfig, SessionContext},
};
use parquet::{
    arrow::{ArrowWriter, ProjectionMask, arrow_reader::ParquetRecordBatchReaderBuilder},
    file::{metadata::SortingColumn, properties::WriterProperties},
};
use serde_json::json;
use sha2::{Digest, Sha256};
use temp_dir::TempDir;

use super::*;
use crate::{
    catalog::manifest::{SortOrder, create_from_parquet_file},
    cli::Options,
    metadata::LogStreamMetadata,
    parseable::Stream,
    storage::{LocalFS, StreamType},
};

/// `P_EXECUTION_BATCH_SIZE` default (src/cli.rs).
const EXECUTION_BATCH_SIZE: usize = 20000;
const TARGET_PARTITIONS: usize = 4;

/// `(time in epoch ms, unique row id)`.
type Row = (Option<i64>, i64);

/// The options of `Query::create_session_state`, which reads the CLI-parsed `PARSEABLE` global.
/// The memory pool and metadata cache are omitted; they do not change plans or results.
fn production_session() -> SessionContext {
    let mut config = SessionConfig::default()
        .with_parquet_pruning(true)
        .with_prefer_existing_sort(true)
        .with_collect_statistics(true)
        .with_batch_size(EXECUTION_BATCH_SIZE)
        .with_target_partitions(TARGET_PARTITIONS);
    let options = config.options_mut();
    options.execution.parquet.pushdown_filters = true;
    options.execution.parquet.reorder_filters = true;
    options.execution.parquet.binary_as_string = true;
    options.execution.enable_file_stream_work_stealing = true;
    options.optimizer.repartition_file_scans = true;
    options.optimizer.enable_dynamic_filter_pushdown = true;
    options.optimizer.enable_topk_aggregation = true;
    options.optimizer.enable_topk_repartition = true;
    options.optimizer.enable_sort_pushdown = true;
    options.execution.parquet.metadata_size_hint = Some(2 * 1024 * 1024);
    options
        .execution
        .use_row_number_estimates_to_optimize_partitioning = true;
    options.execution.parquet.enable_page_index = true;
    options.execution.parquet.max_predicate_cache_size = Some(1024 * 1024 * 1024);
    options.execution.parquet.schema_force_view_types = true;
    options.explain.show_statistics = true;
    let state = SessionStateBuilder::new()
        .with_default_features()
        .with_config(config)
        .build();
    SessionContext::new_with_state(state)
}

/// A table over manifest entries, scanned like `StandardTableProvider` scans manifest files.
#[derive(Debug)]
struct ManifestTable {
    schema: SchemaRef,
    files: Vec<File>,
    time_column: String,
    advertised_order: Mutex<Vec<bool>>,
}

impl ManifestTable {
    fn new(schema: SchemaRef, files: Vec<File>, time_column: &str) -> Arc<Self> {
        Arc::new(Self {
            schema,
            files,
            time_column: time_column.to_owned(),
            advertised_order: Mutex::new(Vec::new()),
        })
    }
}

#[async_trait::async_trait]
impl TableProvider for ManifestTable {
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
    ) -> Result<Arc<dyn ExecutionPlan>, DataFusionError> {
        let (partitions, statistics, ordered) = partitioned_files(
            &self.schema,
            &None,
            self.files.clone(),
            state.config_options().execution.target_partitions,
            false,
            &self.time_column,
        );
        self.advertised_order.lock().unwrap().push(ordered);
        parquet_scan_plan(
            self.schema.clone(),
            ObjectStoreUrl::local_filesystem(),
            partitions,
            statistics,
            projection,
            filters,
            limit,
            state,
            EXECUTION_BATCH_SIZE,
        )
        .await
    }
}

fn id_value(array: &dyn Array, index: usize) -> i64 {
    if let Some(values) = array.as_any().downcast_ref::<Int64Array>() {
        return values.value(index);
    }
    let value = array
        .as_any()
        .downcast_ref::<Float64Array>()
        .expect("id column must be Int64 or Float64")
        .value(index);
    assert_eq!(value.fract(), 0.0, "id {value} is not integral");
    value as i64
}

fn rows_of(batches: &[RecordBatch], time_column: &str, id_column: &str) -> Vec<Row> {
    let mut rows = Vec::new();
    for batch in batches {
        let times = batch
            .column_by_name(time_column)
            .unwrap()
            .as_any()
            .downcast_ref::<TimestampMillisecondArray>()
            .expect("time column must be Timestamp(Millisecond)");
        let ids = batch.column_by_name(id_column).unwrap();
        for index in 0..batch.num_rows() {
            let time = (!times.is_null(index)).then(|| times.value(index));
            rows.push((time, id_value(ids.as_ref(), index)));
        }
    }
    rows
}

/// `(key in epoch ms, count)` rows of a grouped query.
fn groups_of(batches: &[RecordBatch], key_column: &str) -> Vec<(i64, i64)> {
    let mut groups = Vec::new();
    for batch in batches {
        let keys = arrow::compute::cast(
            batch.column_by_name(key_column).unwrap(),
            &DataType::Timestamp(TimeUnit::Millisecond, None),
        )
        .unwrap();
        let keys = keys
            .as_any()
            .downcast_ref::<TimestampMillisecondArray>()
            .unwrap();
        let counts = batch
            .column_by_name("n")
            .unwrap()
            .as_any()
            .downcast_ref::<Int64Array>()
            .unwrap();
        for index in 0..batch.num_rows() {
            groups.push((keys.value(index), counts.value(index)));
        }
    }
    groups
}

struct Outcome {
    batches: Vec<RecordBatch>,
    plan: String,
    advertised_order: Vec<bool>,
}

async fn run(table: Arc<ManifestTable>, sql: &str) -> Outcome {
    let context = production_session();
    context.register_table("t", table.clone()).unwrap();
    let plan = context
        .sql(sql)
        .await
        .unwrap()
        .create_physical_plan()
        .await
        .unwrap();
    let plan_text = displayable(plan.as_ref()).indent(true).to_string();
    let batches = collect(plan, context.task_ctx()).await.unwrap();
    Outcome {
        batches,
        plan: plan_text,
        advertised_order: table.advertised_order.lock().unwrap().clone(),
    }
}

#[derive(Clone, Copy)]
enum TimeOrder {
    /// `DESC NULLS LAST`, as written explicitly in SQL.
    DescNullsLast,
    /// Plain `DESC`, which DataFusion reads as `NULLS FIRST`.
    Desc,
    /// Plain `ASC`, which DataFusion reads as `NULLS LAST`.
    Asc,
}

impl TimeOrder {
    fn compare(self, a: Option<i64>, b: Option<i64>) -> std::cmp::Ordering {
        use std::cmp::Ordering::{Greater, Less};
        let nulls_first = matches!(self, TimeOrder::Desc);
        match (a, b) {
            (Some(a), Some(b)) if matches!(self, TimeOrder::Asc) => a.cmp(&b),
            (Some(a), Some(b)) => b.cmp(&a),
            (None, Some(_)) => {
                if nulls_first {
                    Less
                } else {
                    Greater
                }
            }
            (Some(_), None) => {
                if nulls_first {
                    Greater
                } else {
                    Less
                }
            }
            (None, None) => std::cmp::Ordering::Equal,
        }
    }
}

/// Checks the first `limit` rows of `ORDER BY time <order>` (and `id DESC` when `id_tiebreak`)
/// against every stored row. Ids are unique, so with the tiebreak the expected rows are exact.
/// Without it, rows sharing a timestamp may come in any order, and when the limit cuts through a
/// timestamp any of its rows may be chosen; only those freedoms are allowed.
fn top_rows_mismatch(
    actual: &[Row],
    stored: &[Row],
    limit: usize,
    order: TimeOrder,
    id_tiebreak: bool,
) -> Option<String> {
    let mut expected = stored.to_vec();
    expected.sort_by(|a, b| {
        order.compare(a.0, b.0).then_with(|| {
            if id_tiebreak {
                b.1.cmp(&a.1)
            } else {
                std::cmp::Ordering::Equal
            }
        })
    });
    expected.truncate(limit);
    if id_tiebreak {
        return (actual != expected).then(|| {
            let index = actual.iter().zip(&expected).position(|(a, b)| a != b);
            format!(
                "rows differ (actual {} rows, expected {}); first difference at {index:?}",
                actual.len(),
                expected.len()
            )
        });
    }
    let actual_times = actual.iter().map(|row| row.0).collect_vec();
    let expected_times = expected.iter().map(|row| row.0).collect_vec();
    if actual_times != expected_times {
        let index = actual_times
            .iter()
            .zip(&expected_times)
            .position(|(a, b)| a != b);
        return Some(format!(
            "timestamps differ (actual {} rows, expected {}); first difference at {index:?}: \
             actual {:?}, expected {:?}",
            actual.len(),
            expected.len(),
            index.map(|i| actual_times[i]),
            index.map(|i| expected_times[i]),
        ));
    }
    let mut stored_ids = HashMap::<Option<i64>, Vec<i64>>::new();
    for row in stored {
        stored_ids.entry(row.0).or_default().push(row.1);
    }
    let mut actual_ids = HashMap::<Option<i64>, Vec<i64>>::new();
    for row in actual {
        actual_ids.entry(row.0).or_default().push(row.1);
    }
    for (time, ids) in &mut actual_ids {
        let all = stored_ids.get_mut(time).unwrap();
        ids.sort_unstable();
        all.sort_unstable();
        if ids.windows(2).any(|pair| pair[0] == pair[1]) {
            return Some(format!("duplicate ids at {time:?}"));
        }
        let complete = ids.len() == all.len();
        if (complete && ids != all) || ids.iter().any(|id| all.binary_search(id).is_err()) {
            return Some(format!("ids at {time:?} are not rows stored at that time"));
        }
    }
    None
}

/// Grouped oracle: `bin_ms`-wide, epoch-anchored bins of the non-null times, newest first.
fn grouped_oracle(rows: &[Row], bin_ms: i64, limit: Option<usize>) -> Vec<(i64, i64)> {
    let mut groups = BTreeMap::<i64, i64>::new();
    for time in rows.iter().filter_map(|row| row.0) {
        *groups.entry(time - time.rem_euclid(bin_ms)).or_default() += 1;
    }
    let mut groups = groups.into_iter().rev().collect_vec();
    if let Some(limit) = limit {
        groups.truncate(limit);
    }
    groups
}

/// Decodes the time and id columns one row group at a time, in physical order.
fn decode_row_groups(path: &Path, time_column: &str, id_column: &str) -> Vec<Vec<Row>> {
    let builder = ParquetRecordBatchReaderBuilder::try_new(fs::File::open(path).unwrap()).unwrap();
    let parquet_schema = builder.metadata().file_metadata().schema_descr_ptr();
    let leaves = [time_column, id_column].map(|name| {
        parquet_schema
            .columns()
            .iter()
            .position(|column| column.path().string() == name)
            .unwrap()
    });
    (0..builder.metadata().num_row_groups())
        .map(|row_group| {
            let batches = ParquetRecordBatchReaderBuilder::try_new(fs::File::open(path).unwrap())
                .unwrap()
                .with_projection(ProjectionMask::leaves(&parquet_schema, leaves))
                .with_row_groups(vec![row_group])
                .build()
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            rows_of(&batches, time_column, id_column)
        })
        .collect()
}

/// Counts adjacent rows that break `DESC NULLS LAST`.
fn desc_nulls_last_breaks(rows: &[Row]) -> usize {
    rows.windows(2)
        .filter(|pair| match (pair[0].0, pair[1].0) {
            (None, Some(_)) => true,
            (Some(previous), Some(next)) => next > previous,
            _ => false,
        })
        .count()
}

fn footer_sorting_columns(path: &Path) -> Vec<Option<Vec<SortingColumn>>> {
    ParquetRecordBatchReaderBuilder::try_new(fs::File::open(path).unwrap())
        .unwrap()
        .metadata()
        .row_groups()
        .iter()
        .map(|row_group| row_group.sorting_columns().cloned())
        .collect()
}

fn time_desc_claim(column_idx: i32) -> Vec<SortingColumn> {
    vec![SortingColumn {
        column_idx,
        descending: true,
        nulls_first: false,
    }]
}

/// One stored Parquet file with its real manifest entry and decoded rows.
struct StoredFile {
    path: PathBuf,
    schema: SchemaRef,
    manifest: File,
    time_column: String,
    row_groups: Vec<Vec<Row>>,
}

impl StoredFile {
    fn open(path: PathBuf, time_column: &str, id_column: &str) -> Self {
        let schema = ParquetRecordBatchReaderBuilder::try_new(fs::File::open(&path).unwrap())
            .unwrap()
            .schema()
            .clone();
        let manifest = create_from_parquet_file(
            path.to_str().unwrap().trim_start_matches('/').to_owned(),
            &path,
        )
        .unwrap();
        let row_groups = decode_row_groups(&path, time_column, id_column);
        Self {
            path,
            schema,
            manifest,
            time_column: time_column.to_owned(),
            row_groups,
        }
    }

    fn rows(&self) -> Vec<Row> {
        self.row_groups.concat()
    }

    fn table(&self) -> Arc<ManifestTable> {
        ManifestTable::new(
            self.schema.clone(),
            vec![self.manifest.clone()],
            &self.time_column,
        )
    }

    fn assert_manifest_claims_time_desc(&self) {
        assert_eq!(
            self.manifest.sort_order_id,
            vec![(self.time_column.clone(), SortOrder::DescNullsLast)]
        );
    }
}

/// Collects mismatches so that one run records every wrong answer, then fails once.
#[derive(Default)]
struct Checks {
    failures: Vec<String>,
}

impl Checks {
    async fn top_rows(
        &mut self,
        case: &str,
        file: &StoredFile,
        sql: &str,
        limit: usize,
        order: TimeOrder,
        id_tiebreak: bool,
    ) {
        let id_column = if file.schema.field_with_name("id").is_ok() {
            "id"
        } else {
            "seq"
        };
        let outcome = run(file.table(), sql).await;
        let actual = rows_of(&outcome.batches, &file.time_column, id_column);
        let mismatch = top_rows_mismatch(&actual, &file.rows(), limit, order, id_tiebreak);
        println!(
            "ORDERING_JSON {}",
            json!({
                "case": case,
                "sql": sql,
                "advertised_order": outcome.advertised_order,
                "rows": actual.len(),
                "first_rows": actual.iter().take(16).collect_vec(),
                "mismatch": mismatch,
                "plan": outcome.plan,
            })
        );
        if let Some(mismatch) = mismatch {
            self.failures.push(format!("{case}: {sql}: {mismatch}"));
        }
    }

    async fn groups(
        &mut self,
        case: &str,
        file: &StoredFile,
        sql: &str,
        key_column: &str,
        expected: Vec<(i64, i64)>,
        sort_actual: bool,
    ) {
        let outcome = run(file.table(), sql).await;
        let mut actual = groups_of(&outcome.batches, key_column);
        if sort_actual {
            actual.sort_by_key(|group| std::cmp::Reverse(*group));
        }
        let matches = actual == expected;
        println!(
            "ORDERING_JSON {}",
            json!({
                "case": case,
                "sql": sql,
                "advertised_order": outcome.advertised_order,
                "groups": actual.len(),
                "first_groups": actual.iter().take(16).collect_vec(),
                "matches": matches,
                "plan": outcome.plan,
            })
        );
        if !matches {
            self.failures.push(format!("{case}: {sql}: groups differ"));
        }
    }

    fn finish(self) {
        assert!(self.failures.is_empty(), "{:#?}", self.failures);
    }
}

// ---------------------------------------------------------------------------
// Files from the production staging writer
// ---------------------------------------------------------------------------

/// A past minute, so that conversion with `shutdown_signal = true` includes it.
fn staging_minute() -> NaiveDateTime {
    NaiveDate::from_ymd_opt(2026, 10, 17)
        .unwrap()
        .and_hms_milli_opt(12, 59, 3, 0)
        .unwrap()
}

fn p_timestamp_schema() -> Arc<Schema> {
    Arc::new(Schema::new(vec![
        Field::new(
            DEFAULT_TIMESTAMP_KEY,
            DataType::Timestamp(TimeUnit::Millisecond, None),
            true,
        ),
        Field::new("id", DataType::Int64, true),
    ]))
}

/// One ingest request: every row shares the request's `p_timestamp`.
fn request(schema: &Arc<Schema>, time: i64, ids: std::ops::Range<i64>) -> RecordBatch {
    let rows = ids.clone().count();
    RecordBatch::try_new(
        schema.clone(),
        vec![
            Arc::new(TimestampMillisecondArray::from(vec![time; rows])),
            Arc::new(Int64Array::from_iter_values(ids)),
        ],
    )
    .unwrap()
}

/// Pushes `batches` in writer-lock order, closing the Arrow file after each index in
/// `flush_after`, and converts the minute to one Parquet file.
fn write_with_staging_writer(
    temp_dir: &TempDir,
    row_group_size: usize,
    batches: &[RecordBatch],
    flush_after: &[usize],
    time_partition: Option<&String>,
) -> PathBuf {
    let options = Arc::new(Options {
        local_staging_path: temp_dir.path().to_path_buf(),
        row_group_size,
        ..Default::default()
    });
    let stream = Stream::new(
        options,
        "ordering",
        LogStreamMetadata::default(),
        None,
        &None,
    );
    for (index, batch) in batches.iter().enumerate() {
        stream
            .push(
                "ordering",
                batch,
                staging_minute(),
                &HashMap::new(),
                StreamType::UserDefined,
            )
            .unwrap();
        if flush_after.contains(&index) {
            stream.flush(true).unwrap();
        }
    }
    stream.flush(true).unwrap();
    stream
        .convert_disk_files_to_parquet(time_partition, None, false, true, &None)
        .unwrap();
    let files = stream.parquet_files();
    assert_eq!(
        files.len(),
        1,
        "one minute must convert to one Parquet file"
    );
    files.into_iter().next().unwrap()
}

/// Request `C` took its `p_timestamp` (1001) before request `B` (1002) but acquired the writer
/// lock after it. The single row group is not sorted, yet its footer and manifest say
/// `p_timestamp DESC NULLS LAST`.
#[tokio::test]
async fn lock_order_inversion_inside_one_row_group() {
    let temp_dir = TempDir::new().unwrap();
    let schema = p_timestamp_schema();
    let path = write_with_staging_writer(
        &temp_dir,
        262_144,
        &[
            request(&schema, 1_000, 0..4),
            request(&schema, 1_002, 4..8),
            request(&schema, 1_001, 8..12),
        ],
        &[],
        None,
    );
    let file = StoredFile::open(path, DEFAULT_TIMESTAMP_KEY, "id");
    assert_eq!(
        footer_sorting_columns(&file.path),
        vec![Some(time_desc_claim(0))]
    );
    file.assert_manifest_claims_time_desc();
    assert_eq!(
        file.rows(),
        [
            (1_001, [11, 10, 9, 8]),
            (1_002, [7, 6, 5, 4]),
            (1_000, [3, 2, 1, 0])
        ]
        .into_iter()
        .flat_map(|(time, ids)| ids.map(|id| (Some(time), id)))
        .collect_vec()
    );
    assert_eq!(desc_nulls_last_breaks(&file.row_groups[0]), 1);

    let mut checks = Checks::default();
    for (sql, limit, order, id_tiebreak) in [
        (
            "SELECT id, p_timestamp FROM t ORDER BY p_timestamp DESC NULLS LAST LIMIT 4",
            4,
            TimeOrder::DescNullsLast,
            false,
        ),
        (
            "SELECT id, p_timestamp FROM t ORDER BY p_timestamp DESC NULLS LAST LIMIT 8",
            8,
            TimeOrder::DescNullsLast,
            false,
        ),
        (
            "SELECT id, p_timestamp FROM t ORDER BY p_timestamp DESC NULLS LAST",
            12,
            TimeOrder::DescNullsLast,
            false,
        ),
        (
            "SELECT id, p_timestamp FROM t ORDER BY p_timestamp DESC NULLS LAST, id DESC LIMIT 6",
            6,
            TimeOrder::DescNullsLast,
            true,
        ),
        (
            "SELECT id, p_timestamp FROM t ORDER BY p_timestamp DESC LIMIT 4",
            4,
            TimeOrder::Desc,
            false,
        ),
        (
            "SELECT id, p_timestamp FROM t ORDER BY p_timestamp ASC LIMIT 4",
            4,
            TimeOrder::Asc,
            false,
        ),
    ] {
        checks
            .top_rows(
                "lock_order_inversion",
                &file,
                sql,
                limit,
                order,
                id_tiebreak,
            )
            .await;
    }
    checks
        .groups(
            "lock_order_inversion",
            &file,
            "SELECT p_timestamp, COUNT(*) AS n FROM t GROUP BY p_timestamp ORDER BY p_timestamp DESC",
            DEFAULT_TIMESTAMP_KEY,
            vec![(1_002, 4), (1_001, 4), (1_000, 4)],
            false,
        )
        .await;
    checks.finish();
}

/// The same requests with one request per row group. Each row group is sorted, so the footer's
/// row-group claim is true, but the file as a whole is not sorted.
#[tokio::test]
async fn sorted_row_groups_in_unsorted_file() {
    let temp_dir = TempDir::new().unwrap();
    let schema = p_timestamp_schema();
    let path = write_with_staging_writer(
        &temp_dir,
        4,
        &[
            request(&schema, 1_000, 0..4),
            request(&schema, 1_002, 4..8),
            request(&schema, 1_001, 8..12),
        ],
        &[],
        None,
    );
    let file = StoredFile::open(path, DEFAULT_TIMESTAMP_KEY, "id");
    assert_eq!(file.row_groups.len(), 3);
    assert!(
        file.row_groups
            .iter()
            .all(|rows| desc_nulls_last_breaks(rows) == 0)
    );
    assert_eq!(desc_nulls_last_breaks(&file.rows()), 1);
    file.assert_manifest_claims_time_desc();

    let mut checks = Checks::default();
    for (sql, limit, order) in [
        (
            "SELECT id, p_timestamp FROM t ORDER BY p_timestamp DESC NULLS LAST LIMIT 4",
            4,
            TimeOrder::DescNullsLast,
        ),
        (
            "SELECT id, p_timestamp FROM t ORDER BY p_timestamp DESC NULLS LAST LIMIT 8",
            8,
            TimeOrder::DescNullsLast,
        ),
        (
            "SELECT id, p_timestamp FROM t ORDER BY p_timestamp DESC LIMIT 4",
            4,
            TimeOrder::Desc,
        ),
    ] {
        checks
            .top_rows("sorted_row_groups", &file, sql, limit, order, false)
            .await;
    }
    checks.finish();
}

/// Control: requests in time order per Arrow file, k-merged at conversion. The file really is
/// sorted, and stays correct without an advertised ordering.
#[tokio::test]
async fn monotone_appends_control() {
    let temp_dir = TempDir::new().unwrap();
    let schema = p_timestamp_schema();
    let path = write_with_staging_writer(
        &temp_dir,
        4,
        &[
            request(&schema, 1_000, 0..4),
            request(&schema, 1_003, 4..8),
            request(&schema, 1_001, 8..12),
            request(&schema, 1_002, 12..16),
        ],
        &[1],
        None,
    );
    let file = StoredFile::open(path, DEFAULT_TIMESTAMP_KEY, "id");
    assert_eq!(desc_nulls_last_breaks(&file.rows()), 0);
    file.assert_manifest_claims_time_desc();

    let mut checks = Checks::default();
    for (sql, limit, order) in [
        (
            "SELECT id, p_timestamp FROM t ORDER BY p_timestamp DESC NULLS LAST LIMIT 8",
            8,
            TimeOrder::DescNullsLast,
        ),
        (
            "SELECT id, p_timestamp FROM t ORDER BY p_timestamp DESC NULLS LAST LIMIT 6",
            6,
            TimeOrder::DescNullsLast,
        ),
        (
            "SELECT id, p_timestamp FROM t ORDER BY p_timestamp DESC LIMIT 8",
            8,
            TimeOrder::Desc,
        ),
    ] {
        checks
            .top_rows("monotone_control", &file, sql, limit, order, false)
            .await;
    }
    checks.finish();
}

/// A custom time partition: each event is pushed in the client's order (newest first here), and
/// the footer still claims `event_time DESC NULLS LAST`.
#[tokio::test]
async fn time_partition_in_client_order() {
    let temp_dir = TempDir::new().unwrap();
    let schema = Arc::new(Schema::new(vec![
        Field::new(
            DEFAULT_TIMESTAMP_KEY,
            DataType::Timestamp(TimeUnit::Millisecond, None),
            true,
        ),
        Field::new(
            "event_time",
            DataType::Timestamp(TimeUnit::Millisecond, None),
            true,
        ),
        Field::new("id", DataType::Int64, true),
    ]));
    let base = staging_minute().and_utc().timestamp_millis();
    let events = [base + 30_000, base + 20_000, base + 10_000]
        .into_iter()
        .enumerate()
        .map(|(id, event_time)| {
            RecordBatch::try_new(
                schema.clone(),
                vec![
                    Arc::new(TimestampMillisecondArray::from(vec![5_000_000])),
                    Arc::new(TimestampMillisecondArray::from(vec![event_time])),
                    Arc::new(Int64Array::from(vec![id as i64])),
                ],
            )
            .unwrap()
        })
        .collect_vec();
    let time_partition = "event_time".to_owned();
    let path = write_with_staging_writer(&temp_dir, 262_144, &events, &[], Some(&time_partition));
    let file = StoredFile::open(path, "event_time", "id");
    assert_eq!(
        file.rows(),
        vec![
            (Some(base + 10_000), 2),
            (Some(base + 20_000), 1),
            (Some(base + 30_000), 0)
        ]
    );
    file.assert_manifest_claims_time_desc();

    let mut checks = Checks::default();
    for (sql, limit, order) in [
        (
            "SELECT id, event_time FROM t ORDER BY event_time DESC NULLS LAST LIMIT 1",
            1,
            TimeOrder::DescNullsLast,
        ),
        (
            "SELECT id, event_time FROM t ORDER BY event_time DESC NULLS LAST",
            3,
            TimeOrder::DescNullsLast,
        ),
        (
            "SELECT id, event_time FROM t ORDER BY event_time DESC LIMIT 1",
            1,
            TimeOrder::Desc,
        ),
    ] {
        // Event times are unique, so the expected rows are exact.
        checks
            .top_rows("time_partition", &file, sql, limit, order, true)
            .await;
    }
    checks.finish();
}

/// Each request is larger than one execution batch, and timestamp 1002 reappears after an older
/// request. Grouping must still count each key once.
#[tokio::test]
async fn reappearing_timestamp_aggregates() {
    const REQUEST_ROWS: i64 = 25_000;
    let temp_dir = TempDir::new().unwrap();
    let schema = p_timestamp_schema();
    let requests = [1_000, 1_002, 1_001, 1_002]
        .into_iter()
        .enumerate()
        .map(|(index, time)| {
            let start = index as i64 * REQUEST_ROWS;
            request(&schema, time, start..start + REQUEST_ROWS)
        })
        .collect_vec();
    let path = write_with_staging_writer(&temp_dir, 262_144, &requests, &[], None);
    let file = StoredFile::open(path, DEFAULT_TIMESTAMP_KEY, "id");
    assert_eq!(
        file.rows().iter().map(|row| row.0).dedup().collect_vec(),
        [1_002, 1_001, 1_002, 1_000].map(Some).to_vec()
    );

    let mut checks = Checks::default();
    for (sql, bin_ms, sort_actual) in [
        (
            "SELECT p_timestamp, COUNT(*) AS n FROM t GROUP BY p_timestamp ORDER BY p_timestamp DESC",
            1,
            false,
        ),
        (
            "SELECT p_timestamp, COUNT(*) AS n FROM t GROUP BY p_timestamp",
            1,
            true,
        ),
        (
            "SELECT date_bin(INTERVAL '2 milliseconds', p_timestamp, TIMESTAMP '1970-01-01 00:00:00') AS p_timestamp, COUNT(*) AS n FROM t GROUP BY 1 ORDER BY 1 DESC",
            2,
            false,
        ),
    ] {
        let expected = grouped_oracle(&file.rows(), bin_ms, None);
        checks
            .groups(
                "reappearing_timestamp",
                &file,
                sql,
                DEFAULT_TIMESTAMP_KEY,
                expected,
                sort_actual,
            )
            .await;
    }
    checks.finish();
}

// ---------------------------------------------------------------------------
// Externally written file: the Parseable writer never stores a null `p_timestamp`
// ---------------------------------------------------------------------------

fn write_external(path: &Path, times: &[Option<i64>], claim: Vec<SortingColumn>) {
    let schema = p_timestamp_schema();
    let batch = RecordBatch::try_new(
        schema.clone(),
        vec![
            Arc::new(TimestampMillisecondArray::from(times.to_vec())),
            Arc::new(Int64Array::from_iter_values(0..times.len() as i64)),
        ],
    )
    .unwrap();
    let props = WriterProperties::builder()
        .set_max_row_group_row_count(Some(2))
        .set_sorting_columns(Some(claim))
        .build();
    let mut writer =
        ArrowWriter::try_new(fs::File::create(path).unwrap(), schema, Some(props)).unwrap();
    writer.write(&batch).unwrap();
    writer.close().unwrap();
}

#[tokio::test]
async fn external_leading_null_with_nulls_last_claim() {
    let temp_dir = TempDir::new().unwrap();
    let mut checks = Checks::default();
    for (case, times) in [
        ("external_false_null_claim", vec![None, Some(5), Some(3)]),
        (
            "external_true_claim_trailing_null",
            vec![Some(9), Some(5), Some(3), None],
        ),
    ] {
        let path = temp_dir.path().join(format!("{case}.parquet"));
        write_external(&path, &times, time_desc_claim(0));
        let file = StoredFile::open(path, DEFAULT_TIMESTAMP_KEY, "id");
        file.assert_manifest_claims_time_desc();
        checks
            .top_rows(
                case,
                &file,
                "SELECT id, p_timestamp FROM t ORDER BY p_timestamp DESC NULLS LAST LIMIT 2",
                2,
                TimeOrder::DescNullsLast,
                true,
            )
            .await;
    }
    checks.finish();
}

// ---------------------------------------------------------------------------
// Data no manifest covers, scanned through `ListingTableBuilder`
// ---------------------------------------------------------------------------

/// Places `file` where legacy listing finds it and builds the table with the production
/// `ListingTableBuilder`, as `legacy_listing_table` does for a query range before every manifest.
/// `LocalFS::query_prefixes` resolves prefixes against `/`, so the store is rooted there and the
/// stream is named by its absolute path.
async fn listed_table(store: &TempDir, file: &StoredFile) -> Arc<dyn TableProvider> {
    let stream_dir = store.path().join("ordering");
    let minute_dir = stream_dir.join("date=2026-10-17/hour=12/minute=59");
    fs::create_dir_all(&minute_dir).unwrap();
    fs::copy(&file.path, minute_dir.join("listed.data.parquet")).unwrap();
    let storage: Arc<dyn ObjectStorage> = Arc::new(LocalFS::new(PathBuf::from("/")));
    let midnight = |day| {
        NaiveDate::from_ymd_opt(2026, 10, day)
            .unwrap()
            .and_hms_opt(0, 0, 0)
            .unwrap()
    };
    // 2026-10-17 lies wholly inside the range, so it is listed by its `date=` prefix.
    let time_filters = [
        PartialTimeFilter::Low(Bound::Included(midnight(16))),
        PartialTimeFilter::High(Bound::Excluded(midnight(18))),
    ];
    // The absolute path without its leading `/`.
    let stream = stream_dir.to_str().unwrap()[1..].to_owned();
    let schema = file.schema.clone();
    ListingTableBuilder::new(stream)
        .populate_via_listing(storage.clone(), &time_filters)
        .await
        .unwrap()
        .build(schema, |prefixes| storage.query_prefixes(prefixes))
        .unwrap()
        .expect("the copied file is listed")
}

const LISTING_QUERIES: [(&str, usize, TimeOrder, bool); 6] = [
    (
        "SELECT id, p_timestamp FROM t ORDER BY p_timestamp DESC NULLS LAST LIMIT 4",
        4,
        TimeOrder::DescNullsLast,
        false,
    ),
    (
        "SELECT id, p_timestamp FROM t ORDER BY p_timestamp DESC NULLS LAST LIMIT 8",
        8,
        TimeOrder::DescNullsLast,
        false,
    ),
    (
        "SELECT id, p_timestamp FROM t ORDER BY p_timestamp DESC NULLS LAST",
        12,
        TimeOrder::DescNullsLast,
        false,
    ),
    (
        "SELECT id, p_timestamp FROM t ORDER BY p_timestamp DESC NULLS LAST, id DESC LIMIT 6",
        6,
        TimeOrder::DescNullsLast,
        true,
    ),
    (
        "SELECT id, p_timestamp FROM t ORDER BY p_timestamp DESC LIMIT 4",
        4,
        TimeOrder::Desc,
        false,
    ),
    (
        "SELECT id, p_timestamp FROM t ORDER BY p_timestamp ASC LIMIT 4",
        4,
        TimeOrder::Asc,
        false,
    ),
];

/// Lists `file` as `legacy_listing_table` does for a query range before every manifest, and
/// returns every ordering claim and wrong answer of `LISTING_QUERIES` over it.
async fn listing_failures(file: &StoredFile) -> Vec<String> {
    let store = TempDir::new().unwrap();
    let table = listed_table(&store, file).await;
    let context = production_session();
    let state = context.state();
    let scan = table.scan(&state, None, &[], None).await.unwrap();
    let mut failures = Vec::new();
    if scan.properties().output_ordering().is_some() {
        failures.push(format!(
            "the scan advertises an ordering\n{}",
            displayable(scan.as_ref()).indent(true)
        ));
    }
    context.register_table("t", table).unwrap();
    for (sql, limit, order, id_tiebreak) in LISTING_QUERIES {
        let plan = context
            .sql(sql)
            .await
            .unwrap()
            .create_physical_plan()
            .await
            .unwrap();
        let plan_text = displayable(plan.as_ref()).indent(true).to_string();
        let batches = collect(plan, context.task_ctx()).await.unwrap();
        let actual = rows_of(&batches, DEFAULT_TIMESTAMP_KEY, "id");
        let mismatch = top_rows_mismatch(&actual, &file.rows(), limit, order, id_tiebreak);
        if let Some(mismatch) = mismatch {
            failures.push(format!("{sql}: {mismatch}\n{plan_text}"));
        }
    }
    failures
}

/// The lock-order inversion above, listed: `ListingTable` would take the file's ordering from
/// its one row group's `p_timestamp DESC NULLS LAST` claim.
#[tokio::test]
async fn listing_table_ignores_footer_sort_order() {
    let temp_dir = TempDir::new().unwrap();
    let schema = p_timestamp_schema();
    let path = write_with_staging_writer(
        &temp_dir,
        262_144,
        &[
            request(&schema, 1_000, 0..4),
            request(&schema, 1_002, 4..8),
            request(&schema, 1_001, 8..12),
        ],
        &[],
        None,
    );
    let file = StoredFile::open(path, DEFAULT_TIMESTAMP_KEY, "id");
    assert_eq!(
        footer_sorting_columns(&file.path),
        vec![Some(time_desc_claim(0))]
    );
    assert_eq!(desc_nulls_last_breaks(&file.rows()), 1);
    let failures = listing_failures(&file).await;
    assert!(failures.is_empty(), "{failures:#?}");
}

/// A footer claim on a column the file does not have. Inferring an ordering from it indexes past
/// the Parquet schema and panics while listing.
#[tokio::test]
async fn listing_table_plans_footer_with_invalid_sort_column() {
    let temp_dir = TempDir::new().unwrap();
    let path = temp_dir.path().join("invalid_sort_column.parquet");
    write_external(
        &path,
        &[Some(3), Some(9), Some(5), Some(7)],
        time_desc_claim(7),
    );
    let file = StoredFile::open(path, DEFAULT_TIMESTAMP_KEY, "id");
    assert_eq!(
        footer_sorting_columns(&file.path),
        vec![Some(time_desc_claim(7)); 2]
    );
    let failures = listing_failures(&file).await;
    assert!(failures.is_empty(), "{failures:#?}");
}

// ---------------------------------------------------------------------------
// A preserved production file (opt-in: ORDERING_SOURCE_PARQUET=<path>)
// ---------------------------------------------------------------------------

/// The 1,000,000-row file from a production benchmark run. All four row groups claim
/// `p_timestamp DESC NULLS LAST` and none is sorted. `seq` is unique.
#[tokio::test]
#[ignore = "needs ORDERING_SOURCE_PARQUET"]
async fn preserved_production_file() {
    let path = PathBuf::from(
        std::env::var("ORDERING_SOURCE_PARQUET").expect("ORDERING_SOURCE_PARQUET is required"),
    );
    let file = StoredFile::open(path, DEFAULT_TIMESTAMP_KEY, "seq");
    file.assert_manifest_claims_time_desc();
    let rows = file.rows();
    assert_eq!(rows.len(), 1_000_000);
    assert_eq!(rows.iter().map(|row| row.1).unique().count(), rows.len());
    let footer = footer_sorting_columns(&file.path);
    assert_eq!(footer.len(), 4);
    assert!(
        footer
            .iter()
            .all(|claim| claim == &Some(time_desc_claim(0)))
    );
    assert!(
        file.row_groups
            .iter()
            .all(|rows| desc_nulls_last_breaks(rows) > 0)
    );
    // Digest of every stored row, newest first then `seq` descending, for an HTTP oracle to bind
    // its own readback to this decode.
    let mut sorted = rows.clone();
    sorted.sort_by(|a, b| b.cmp(a));
    let mut digest = Sha256::new();
    for (time, seq) in &sorted {
        digest.update(format!("{},{seq}\n", time.unwrap()));
    }
    println!(
        "ORDERING_JSON {}",
        json!({
            "case": "production_file_rows",
            "rows": sorted.len(),
            "sorted_rows_sha256": format!("{:x}", digest.finalize()),
            "row_group_breaks": file.row_groups.iter().map(|rows| desc_nulls_last_breaks(rows)).collect_vec(),
        })
    );

    let mut checks = Checks::default();
    for limit in [10, 1_000, 15_000, 16_000, 20_000, 100_000] {
        for (order, order_sql) in [
            (TimeOrder::DescNullsLast, "DESC NULLS LAST"),
            (TimeOrder::Desc, "DESC"),
        ] {
            let sql = format!(
                "SELECT seq, p_timestamp FROM t ORDER BY p_timestamp {order_sql} LIMIT {limit}"
            );
            checks
                .top_rows("production_file", &file, &sql, limit, order, false)
                .await;
        }
    }
    for (sql, limit, order, id_tiebreak) in [
        (
            "SELECT seq, p_timestamp FROM t ORDER BY p_timestamp DESC NULLS LAST, seq DESC LIMIT 20000",
            20_000,
            TimeOrder::DescNullsLast,
            true,
        ),
        (
            "SELECT seq, p_timestamp FROM t ORDER BY p_timestamp DESC, seq DESC LIMIT 10",
            10,
            TimeOrder::Desc,
            true,
        ),
        (
            "SELECT seq, p_timestamp FROM t ORDER BY p_timestamp ASC LIMIT 10",
            10,
            TimeOrder::Asc,
            false,
        ),
    ] {
        checks
            .top_rows("production_file", &file, sql, limit, order, id_tiebreak)
            .await;
    }
    for (sql, key, bin_ms, limit) in [
        (
            "SELECT date_bin(INTERVAL '1 second', p_timestamp, TIMESTAMP '1970-01-01 00:00:00') AS b, COUNT(*) AS n FROM t GROUP BY b ORDER BY b DESC",
            "b",
            1_000,
            None,
        ),
        (
            "SELECT date_bin(INTERVAL '10 milliseconds', p_timestamp, TIMESTAMP '1970-01-01 00:00:00') AS b, COUNT(*) AS n FROM t GROUP BY b ORDER BY b DESC",
            "b",
            10,
            None,
        ),
        (
            "SELECT p_timestamp, COUNT(*) AS n FROM t GROUP BY p_timestamp ORDER BY p_timestamp DESC",
            DEFAULT_TIMESTAMP_KEY,
            1,
            None,
        ),
        (
            "SELECT p_timestamp, COUNT(*) AS n FROM t GROUP BY p_timestamp ORDER BY p_timestamp DESC LIMIT 20",
            DEFAULT_TIMESTAMP_KEY,
            1,
            Some(20),
        ),
    ] {
        checks
            .groups(
                "production_file",
                &file,
                sql,
                key,
                grouped_oracle(&rows, bin_ms, limit),
                false,
            )
            .await;
    }
    checks.finish();
}
