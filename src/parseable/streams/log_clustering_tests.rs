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

//! Writer-level tests for opt-in log severity clustering.
//!
//! Every clustered file is compared with a file written by the unchanged
//! default path from the same pushes: identical schema, row-group membership,
//! row values, manifest statistics and file naming, with only the order of
//! rows inside each row group (and the dropped footer order claim) differing.

use std::collections::BTreeMap;

use arrow::util::display::{ArrayFormatter, FormatOptions};
use arrow_array::{
    Array, BooleanArray, DictionaryArray, Float64Array, Int32Array, Int64Array, StringArray,
    TimestampMillisecondArray, types::Int32Type,
};
use arrow_schema::{DataType, Field, TimeUnit};
use chrono::NaiveDate;
use clap::Parser;
use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;
use temp_dir::TempDir;

use super::log_clustering::{
    LogClusterKey, LogClusterSkip, cluster_row_group, resolve_cluster_key, stream_is_applicable,
};
use super::*;
use crate::{catalog::manifest::create_from_parquet_file, handlers::TelemetryType};

const SEVERITY: &str = "severity_text";
const ROW_GROUP: usize = 128;
const ROWS: usize = 1000;

type Row = Vec<String>;

fn minute() -> NaiveDateTime {
    NaiveDate::from_ymd_opt(2026, 10, 17)
        .unwrap()
        .and_hms_milli_opt(12, 59, 3, 0)
        .unwrap()
}

fn log_schema() -> Arc<Schema> {
    Arc::new(Schema::new(vec![
        Field::new(
            DEFAULT_TIMESTAMP_KEY,
            DataType::Timestamp(TimeUnit::Millisecond, None),
            true,
        ),
        Field::new("id", DataType::Int64, false),
        Field::new(SEVERITY, DataType::Utf8, true),
        Field::new("message", DataType::Utf8, true),
    ]))
}

/// Deterministic pseudo-random severity, including a case variant and NULL.
fn severity(id: usize) -> Option<&'static str> {
    const VALUES: [Option<&str>; 7] = [
        Some("INFO"),
        Some("DEBUG"),
        Some("INFO"),
        Some("WARN"),
        Some("ERROR"),
        None,
        Some("error"),
    ];
    VALUES[(id * 7919 + 13) % VALUES.len()]
}

/// One request per `chunk` rows. Timestamps are mostly ascending per request
/// with repeats and a few NULLs, as concurrent producers would leave them.
fn requests(schema: &Arc<Schema>, chunk: usize) -> Vec<RecordBatch> {
    (0..ROWS)
        .collect_vec()
        .chunks(chunk)
        .map(|ids| {
            let times = ids
                .iter()
                .map(|id| (id % 97 != 0).then_some(1_760_000_000_000 + (*id as i64 / 3) * 7))
                .collect::<Vec<_>>();
            RecordBatch::try_new(
                schema.clone(),
                vec![
                    Arc::new(TimestampMillisecondArray::from(times)),
                    Arc::new(Int64Array::from_iter_values(
                        ids.iter().map(|id| *id as i64),
                    )),
                    Arc::new(StringArray::from(
                        ids.iter().map(|id| severity(*id)).collect::<Vec<_>>(),
                    )),
                    Arc::new(StringArray::from(
                        ids.iter()
                            .map(|id| (id % 11 != 0).then(|| format!("message {}", id % 23)))
                            .collect::<Vec<_>>(),
                    )),
                ],
            )
            .unwrap()
        })
        .collect()
}

fn stream_with(
    dir: &TempDir,
    cluster: Option<&str>,
    metadata: LogStreamMetadata,
    name: &str,
) -> StreamRef {
    Stream::new(
        Arc::new(Options {
            local_staging_path: dir.path().to_path_buf(),
            row_group_size: ROW_GROUP,
            log_severity_cluster_column: cluster.map(str::to_owned),
            ..Default::default()
        }),
        name,
        metadata,
        None,
        &None,
    )
}

/// Pushes every batch under its schema key, flushes and converts the minute.
/// With a custom partition, each batch carries one value of that column.
fn convert(stream: &StreamRef, batches: &[(&str, RecordBatch)]) -> Vec<PathBuf> {
    let custom_partition = stream.get_custom_partition();
    for (key, batch) in batches {
        let values = custom_partition
            .iter()
            .map(|column| {
                let array = batch.column_by_name(column).unwrap();
                (
                    column.clone(),
                    arrow::util::display::array_value_to_string(array, 0).unwrap(),
                )
            })
            .collect::<HashMap<_, _>>();
        stream
            .push(key, batch, minute(), &values, StreamType::UserDefined)
            .unwrap();
    }
    stream.flush(true).unwrap();
    let time_partition = stream.get_time_partition();
    stream
        .convert_disk_files_to_parquet(
            time_partition.as_ref(),
            custom_partition.as_ref(),
            false,
            true,
            &None,
        )
        .unwrap();
    assert!(stream.arrow_files().is_empty());
    let mut files = stream.parquet_files();
    files.sort();
    assert!(!files.is_empty());
    files
}

fn write_pair(
    metadata: impl Fn() -> LogStreamMetadata,
    cluster: &str,
    batches: &[(&str, RecordBatch)],
) -> (Vec<PathBuf>, Vec<PathBuf>, TempDir, TempDir) {
    let default_dir = TempDir::new().unwrap();
    let clustered_dir = TempDir::new().unwrap();
    let default_files = convert(
        &stream_with(&default_dir, None, metadata(), "clustering"),
        batches,
    );
    let clustered_files = convert(
        &stream_with(&clustered_dir, Some(cluster), metadata(), "clustering"),
        batches,
    );
    (default_files, clustered_files, default_dir, clustered_dir)
}

fn format_rows(batch: &RecordBatch) -> Vec<Row> {
    let options = FormatOptions::default().with_null("<NULL>");
    let formatters = batch
        .columns()
        .iter()
        .map(|column| ArrayFormatter::try_new(column.as_ref(), &options).unwrap())
        .collect::<Vec<_>>();
    (0..batch.num_rows())
        .map(|row| {
            formatters
                .iter()
                .map(|formatter| formatter.value(row).to_string())
                .collect()
        })
        .collect()
}

/// Every row group's rows in physical order.
fn row_groups(path: &Path) -> Vec<Vec<Row>> {
    let groups = ParquetRecordBatchReaderBuilder::try_new(File::open(path).unwrap())
        .unwrap()
        .metadata()
        .num_row_groups();
    (0..groups)
        .map(|group| {
            ParquetRecordBatchReaderBuilder::try_new(File::open(path).unwrap())
                .unwrap()
                .with_row_groups(vec![group])
                .build()
                .unwrap()
                .flat_map(|batch| format_rows(&batch.unwrap()))
                .collect()
        })
        .collect()
}

fn arrow_schema(path: &Path) -> Arc<Schema> {
    ParquetRecordBatchReaderBuilder::try_new(File::open(path).unwrap())
        .unwrap()
        .schema()
        .clone()
}

fn footer_sorting(path: &Path) -> Vec<Option<Vec<SortingColumn>>> {
    ParquetRecordBatchReaderBuilder::try_new(File::open(path).unwrap())
        .unwrap()
        .metadata()
        .row_groups()
        .iter()
        .map(|group| group.sorting_columns().cloned())
        .collect()
}

/// File name with the per-conversion random segment removed.
fn stable_name(path: &Path) -> String {
    let name = path.file_name().unwrap().to_str().unwrap();
    let (front, _) = name.split_once(".data.").unwrap();
    format!("{front}.data.<random>.parquet")
}

fn column_index(path: &Path, name: &str) -> usize {
    arrow_schema(path).index_of(name).unwrap()
}

/// `(severity ASC NULLS LAST, time DESC NULLS LAST)` holds inside `rows`.
fn assert_clustered(rows: &[Row], severity_idx: usize, time_idx: usize) {
    let key = |row: &Row| {
        let severity = (row[severity_idx] != "<NULL>").then(|| row[severity_idx].clone());
        let time = (row[time_idx] != "<NULL>").then(|| row[time_idx].clone());
        // ISO-8601 strings of one unit order like their instants.
        (
            severity.is_none(),
            severity,
            time.is_none(),
            std::cmp::Reverse(time),
        )
    };
    for pair in rows.windows(2) {
        assert!(
            key(&pair[0]) <= key(&pair[1]),
            "rows out of cluster order: {:?} then {:?}",
            pair[0],
            pair[1]
        );
    }
}

fn sorted(mut rows: Vec<Row>) -> Vec<Row> {
    rows.sort();
    rows
}

/// Clustering changes only the row order inside each row group.
fn assert_same_logical_content(default_files: &[PathBuf], clustered_files: &[PathBuf]) {
    assert_eq!(default_files.len(), clustered_files.len());
    for (default, clustered) in default_files.iter().zip(clustered_files) {
        assert_eq!(stable_name(default), stable_name(clustered));
        assert_eq!(arrow_schema(default), arrow_schema(clustered));
        let default_groups = row_groups(default);
        let clustered_groups = row_groups(clustered);
        assert_eq!(
            default_groups.iter().map(Vec::len).collect_vec(),
            clustered_groups.iter().map(Vec::len).collect_vec(),
            "row-group sizes must match"
        );
        for (default_rows, clustered_rows) in default_groups.into_iter().zip(clustered_groups) {
            assert_eq!(
                sorted(default_rows),
                sorted(clustered_rows),
                "row-group membership must match"
            );
        }

        let default_manifest = create_from_parquet_file("d".into(), default).unwrap();
        let clustered_manifest = create_from_parquet_file("c".into(), clustered).unwrap();
        assert_eq!(default_manifest.num_rows, clustered_manifest.num_rows);
        let columns = |file: &crate::catalog::manifest::File| {
            file.columns
                .iter()
                .map(|column| {
                    (
                        column.name.clone(),
                        (column.null_count, format!("{:?}", column.stats)),
                    )
                })
                .collect::<BTreeMap<_, _>>()
        };
        assert_eq!(
            columns(&default_manifest),
            columns(&clustered_manifest),
            "manifest null counts and min/max must match"
        );
        assert!(!default_manifest.sort_order_id.is_empty());
        assert!(
            clustered_manifest.sort_order_id.is_empty(),
            "clustered files must not claim an order"
        );
    }
}

#[test]
fn clustered_files_keep_row_groups_values_and_manifest_stats() {
    let schema = log_schema();
    let batches = requests(&schema, 37)
        .into_iter()
        .map(|batch| ("logs", batch))
        .collect_vec();
    let (default_files, clustered_files, _a, _b) =
        write_pair(LogStreamMetadata::default, SEVERITY, &batches);
    assert_same_logical_content(&default_files, &clustered_files);

    let path = &clustered_files[0];
    let groups = row_groups(path);
    // 1000 rows at 128 per group: seven full groups and a partial final one.
    assert_eq!(
        groups.iter().map(Vec::len).collect_vec(),
        [128, 128, 128, 128, 128, 128, 128, 104]
    );
    let severity_idx = column_index(path, SEVERITY);
    let time_idx = column_index(path, DEFAULT_TIMESTAMP_KEY);
    for rows in &groups {
        assert_clustered(rows, severity_idx, time_idx);
    }
    // The default layout interleaves severities, so the test is meaningful.
    let default_first = &row_groups(&default_files[0])[0];
    assert!(
        default_first
            .windows(2)
            .any(|pair| pair[0][severity_idx] > pair[1][severity_idx])
    );

    assert!(
        footer_sorting(&default_files[0])
            .iter()
            .all(|claim| claim.is_some())
    );
    assert!(footer_sorting(path).iter().all(Option::is_none));
    // Total row count and timestamp unit are unchanged.
    let total = groups.iter().map(Vec::len).sum::<usize>();
    assert_eq!(total, ROWS);
    assert_eq!(
        arrow_schema(path)
            .field_with_name(DEFAULT_TIMESTAMP_KEY)
            .unwrap()
            .data_type(),
        &DataType::Timestamp(TimeUnit::Millisecond, None)
    );
}

#[test]
fn clustering_ties_keep_writer_order() {
    let schema = log_schema();
    // One timestamp for every row, so only severity and input order decide.
    let batch = RecordBatch::try_new(
        schema.clone(),
        vec![
            Arc::new(TimestampMillisecondArray::from(vec![Some(5); 6])),
            Arc::new(Int64Array::from(vec![0, 1, 2, 3, 4, 5])),
            Arc::new(StringArray::from(vec![
                Some("b"),
                Some("a"),
                None,
                Some("b"),
                Some("a"),
                None,
            ])),
            Arc::new(StringArray::from(vec![Some("m"); 6])),
        ],
    )
    .unwrap();
    let key = LogClusterKey {
        cluster_idx: 2,
        time_idx: Some(0),
    };
    let clustered = cluster_row_group(&schema, vec![batch.slice(0, 4), batch.slice(4, 2)], key)
        .expect("cluster");
    let ids = clustered
        .column(1)
        .as_any()
        .downcast_ref::<Int64Array>()
        .unwrap();
    assert_eq!(ids.values(), &[1, 4, 0, 3, 2, 5]);

    // Time DESC NULLS LAST breaks severity ties.
    let batch = RecordBatch::try_new(
        schema.clone(),
        vec![
            Arc::new(TimestampMillisecondArray::from(vec![
                Some(1),
                None,
                Some(3),
                Some(2),
            ])),
            Arc::new(Int64Array::from(vec![0, 1, 2, 3])),
            Arc::new(StringArray::from(vec![Some("a"); 4])),
            Arc::new(StringArray::from(vec![Some("m"); 4])),
        ],
    )
    .unwrap();
    let clustered = cluster_row_group(&schema, vec![batch], key).unwrap();
    let ids = clustered
        .column(1)
        .as_any()
        .downcast_ref::<Int64Array>()
        .unwrap();
    assert_eq!(ids.values(), &[2, 3, 0, 1]);
}

#[test]
fn already_clustered_or_tiny_groups_are_returned_unchanged() {
    let schema = log_schema();
    let batch = requests(&schema, 1).remove(0);
    let key = LogClusterKey {
        cluster_idx: 2,
        time_idx: Some(0),
    };
    let one = cluster_row_group(&schema, vec![batch.clone()], key).unwrap();
    assert_eq!(one, batch);
}

#[test]
fn integer_and_dictionary_columns_cluster() {
    let schema = Arc::new(Schema::new(vec![
        Field::new(
            DEFAULT_TIMESTAMP_KEY,
            DataType::Timestamp(TimeUnit::Millisecond, None),
            true,
        ),
        Field::new("id", DataType::Int64, false),
        Field::new("severity_number", DataType::Int32, true),
        Field::new(
            "level",
            DataType::Dictionary(Box::new(DataType::Int32), Box::new(DataType::Utf8)),
            true,
        ),
    ]));
    let batch = RecordBatch::try_new(
        schema.clone(),
        vec![
            Arc::new(TimestampMillisecondArray::from(vec![Some(1); 5])),
            Arc::new(Int64Array::from(vec![0, 1, 2, 3, 4])),
            Arc::new(Int32Array::from(vec![
                Some(9),
                None,
                Some(17),
                Some(9),
                Some(1),
            ])),
            Arc::new(
                vec![
                    Some("warn"),
                    Some("error"),
                    None,
                    Some("error"),
                    Some("info"),
                ]
                .into_iter()
                .collect::<DictionaryArray<Int32Type>>(),
            ),
        ],
    )
    .unwrap();
    let ids = |key| {
        let batch = cluster_row_group(&schema, vec![batch.clone()], key).unwrap();
        batch
            .column(1)
            .as_any()
            .downcast_ref::<Int64Array>()
            .unwrap()
            .values()
            .to_vec()
    };
    for (column, expected) in [
        ("severity_number", vec![4, 0, 3, 2, 1]),
        ("level", vec![1, 3, 4, 0, 2]),
    ] {
        let key = resolve_cluster_key(Some(column), true, &schema, None).unwrap();
        assert_eq!(ids(key), expected, "{column}");
    }
}

#[test]
fn resolve_cluster_key_cases() {
    let schema = Schema::new(vec![
        Field::new(
            DEFAULT_TIMESTAMP_KEY,
            DataType::Timestamp(TimeUnit::Millisecond, None),
            false,
        ),
        Field::new(SEVERITY, DataType::Utf8, true),
        Field::new("view", DataType::Utf8View, true),
        Field::new("big", DataType::LargeUtf8, true),
        Field::new("number", DataType::UInt8, true),
        Field::new("float", DataType::Float64, true),
        Field::new("flag", DataType::Boolean, true),
        Field::new(
            "event_time",
            DataType::Timestamp(TimeUnit::Millisecond, None),
            true,
        ),
        Field::new("text_time", DataType::Utf8, true),
    ]);
    assert_eq!(
        resolve_cluster_key(None, true, &schema, None),
        Err(LogClusterSkip::Disabled)
    );
    assert_eq!(
        resolve_cluster_key(Some(SEVERITY), false, &schema, None),
        Err(LogClusterSkip::NotApplicable)
    );
    assert_eq!(
        resolve_cluster_key(Some("missing"), true, &schema, None),
        Err(LogClusterSkip::MissingColumn)
    );
    for (column, data_type) in [
        ("float", DataType::Float64),
        ("flag", DataType::Boolean),
        (
            DEFAULT_TIMESTAMP_KEY,
            DataType::Timestamp(TimeUnit::Millisecond, None),
        ),
    ] {
        assert_eq!(
            resolve_cluster_key(Some(column), true, &schema, None),
            Err(LogClusterSkip::UnsupportedType(data_type))
        );
    }
    for (column, index) in [(SEVERITY, 1), ("view", 2), ("big", 3), ("number", 4)] {
        assert_eq!(
            resolve_cluster_key(Some(column), true, &schema, None),
            Ok(LogClusterKey {
                cluster_idx: index,
                time_idx: Some(0)
            })
        );
    }
    // A custom time partition supplies the secondary key...
    assert_eq!(
        resolve_cluster_key(Some(SEVERITY), true, &schema, Some("event_time")),
        Ok(LogClusterKey {
            cluster_idx: 1,
            time_idx: Some(7)
        })
    );
    // ...but only when it is a timestamp column that exists.
    for time_partition in ["text_time", "absent"] {
        assert_eq!(
            resolve_cluster_key(Some(SEVERITY), true, &schema, Some(time_partition)),
            Ok(LogClusterKey {
                cluster_idx: 1,
                time_idx: None
            })
        );
    }
}

#[test]
fn only_user_defined_log_streams_are_applicable() {
    let json = || vec![LogSource::Json];
    assert!(stream_is_applicable(
        StreamType::UserDefined,
        TelemetryType::Logs,
        json()
    ));
    assert!(stream_is_applicable(
        StreamType::UserDefined,
        TelemetryType::Logs,
        vec![LogSource::OtelLogs, LogSource::Kinesis]
    ));
    assert!(stream_is_applicable(
        StreamType::UserDefined,
        TelemetryType::Logs,
        Vec::new()
    ));
    assert!(!stream_is_applicable(
        StreamType::Internal,
        TelemetryType::Logs,
        json()
    ));
    for telemetry in [
        TelemetryType::Metrics,
        TelemetryType::Traces,
        TelemetryType::Events,
    ] {
        assert!(!stream_is_applicable(
            StreamType::UserDefined,
            telemetry,
            json()
        ));
    }
    for source in [
        LogSource::OtelMetrics,
        LogSource::OtelTraces,
        LogSource::Pmeta,
    ] {
        assert!(!stream_is_applicable(
            StreamType::UserDefined,
            TelemetryType::Logs,
            vec![LogSource::OtelLogs, source]
        ));
    }
}

fn file_bytes(files: &[PathBuf]) -> Vec<(String, Vec<u8>)> {
    files
        .iter()
        .map(|path| (stable_name(path), fs::read(path).unwrap()))
        .collect()
}

/// With the column configured, non-applicable streams and unusable columns
/// write byte-identical files to the default writer.
#[test]
fn skipped_outputs_are_byte_identical_to_default() {
    let schema = log_schema();
    let batches = requests(&schema, 50)
        .into_iter()
        .map(|batch| ("logs", batch))
        .collect_vec();
    let with_sources = |sources: Vec<LogSource>| {
        move || LogStreamMetadata {
            log_source: sources
                .iter()
                .cloned()
                .map(|source| LogSourceEntry::new(source, HashSet::new()))
                .collect(),
            ..Default::default()
        }
    };
    type MetadataFn = Box<dyn Fn() -> LogStreamMetadata>;
    let cases: Vec<(&str, MetadataFn, &str)> = vec![
        (
            "internal",
            Box::new(|| LogStreamMetadata {
                stream_type: StreamType::Internal,
                ..Default::default()
            }),
            SEVERITY,
        ),
        (
            "traces telemetry",
            Box::new(|| LogStreamMetadata {
                telemetry_type: TelemetryType::Traces,
                ..Default::default()
            }),
            SEVERITY,
        ),
        (
            "otel traces source",
            Box::new(with_sources(vec![LogSource::OtelTraces])),
            SEVERITY,
        ),
        (
            "otel metrics source",
            Box::new(with_sources(vec![LogSource::OtelMetrics])),
            SEVERITY,
        ),
        (
            "missing column",
            Box::new(LogStreamMetadata::default),
            "level",
        ),
        (
            "unsupported timestamp column",
            Box::new(LogStreamMetadata::default),
            DEFAULT_TIMESTAMP_KEY,
        ),
    ];
    for (case, metadata, column) in cases {
        let (default_files, clustered_files, _a, _b) = write_pair(&metadata, column, &batches);
        assert_eq!(
            file_bytes(&default_files),
            file_bytes(&clustered_files),
            "{case}"
        );
    }
}

#[test]
fn unsupported_value_types_are_byte_identical_to_default() {
    for (data_type, column) in [
        (
            DataType::Float64,
            Arc::new(Float64Array::from(vec![Some(1.5), None, Some(0.5)])) as ArrayRef,
        ),
        (
            DataType::Boolean,
            Arc::new(BooleanArray::from(vec![Some(true), None, Some(false)])) as ArrayRef,
        ),
    ] {
        let schema = Arc::new(Schema::new(vec![
            Field::new(
                DEFAULT_TIMESTAMP_KEY,
                DataType::Timestamp(TimeUnit::Millisecond, None),
                false,
            ),
            Field::new(SEVERITY, data_type, true),
        ]));
        let batch = RecordBatch::try_new(
            schema,
            vec![
                Arc::new(TimestampMillisecondArray::from(vec![3, 2, 1])),
                column,
            ],
        )
        .unwrap();
        let (default_files, clustered_files, _a, _b) =
            write_pair(LogStreamMetadata::default, SEVERITY, &[("logs", batch)]);
        assert_eq!(file_bytes(&default_files), file_bytes(&clustered_files));
        assert!(
            footer_sorting(&clustered_files[0])
                .iter()
                .all(Option::is_some)
        );
    }
}

/// A source written before the column existed is adapted with NULLs, which
/// cluster last; an all-NULL file still writes valid unclaimed row groups.
#[test]
fn evolved_and_all_null_columns_cluster_nulls_last() {
    let full = log_schema();
    let without = Arc::new(Schema::new(
        full.fields()
            .iter()
            .filter(|field| field.name() != SEVERITY)
            .cloned()
            .collect::<Vec<_>>(),
    ));
    let mut batches = Vec::new();
    for (index, batch) in requests(&full, 100).into_iter().enumerate() {
        if index % 2 == 0 {
            let columns = batch
                .schema()
                .fields()
                .iter()
                .zip(batch.columns())
                .filter(|(field, _)| field.name() != SEVERITY)
                .map(|(_, column)| column.clone())
                .collect();
            batches.push((
                "old",
                RecordBatch::try_new(without.clone(), columns).unwrap(),
            ));
        } else {
            batches.push(("new", batch));
        }
    }
    let (default_files, clustered_files, _a, _b) =
        write_pair(LogStreamMetadata::default, SEVERITY, &batches);
    assert_same_logical_content(&default_files, &clustered_files);
    let path = &clustered_files[0];
    let severity_idx = column_index(path, SEVERITY);
    let time_idx = column_index(path, DEFAULT_TIMESTAMP_KEY);
    let groups = row_groups(path);
    assert!(
        groups
            .iter()
            .flatten()
            .any(|row| row[severity_idx] == "<NULL>"),
        "fixture must contain adapted NULLs"
    );
    for rows in &groups {
        assert_clustered(rows, severity_idx, time_idx);
    }

    // When no source has the column, the merged schema lacks it too and the
    // default writer runs.
    let only_old = batches
        .iter()
        .filter(|(key, _)| *key == "old")
        .cloned()
        .collect_vec();
    let (default_files, clustered_files, _a, _b) =
        write_pair(LogStreamMetadata::default, SEVERITY, &only_old);
    assert_eq!(file_bytes(&default_files), file_bytes(&clustered_files));

    // All-NULL severity values: membership and order (NULLs keep time order).
    let nulls = requests(&full, 100)
        .into_iter()
        .map(|batch| {
            let mut columns = batch.columns().to_vec();
            columns[2] = arrow_array::new_null_array(&DataType::Utf8, batch.num_rows());
            (
                "nulls",
                RecordBatch::try_new(full.clone(), columns).unwrap(),
            )
        })
        .collect_vec();
    let (default_files, clustered_files, _a, _b) =
        write_pair(LogStreamMetadata::default, SEVERITY, &nulls);
    assert_same_logical_content(&default_files, &clustered_files);
    for rows in row_groups(&clustered_files[0]) {
        assert_clustered(&rows, severity_idx, time_idx);
    }
}

/// A custom time partition is the secondary key; row groups still match.
#[test]
fn custom_time_partition_is_secondary_key() {
    let base = log_schema();
    let mut fields = base.fields().iter().cloned().collect_vec();
    fields.push(Arc::new(Field::new(
        "event_time",
        DataType::Timestamp(TimeUnit::Millisecond, None),
        false,
    )));
    let schema = Arc::new(Schema::new(fields));
    let batches = requests(&base, 64)
        .into_iter()
        .map(|batch| {
            let rows = batch.num_rows() as i64;
            let ids = batch
                .column(1)
                .as_any()
                .downcast_ref::<Int64Array>()
                .unwrap()
                .clone();
            let mut columns = batch.columns().to_vec();
            columns.push(Arc::new(TimestampMillisecondArray::from_iter_values(
                ids.values()
                    .iter()
                    .map(|id| 1_000_000 + (id * 37) % 211 + rows),
            )));
            (
                "logs",
                RecordBatch::try_new(schema.clone(), columns).unwrap(),
            )
        })
        .collect_vec();
    let metadata = || LogStreamMetadata {
        time_partition: Some("event_time".to_owned()),
        ..Default::default()
    };
    let (default_files, clustered_files, _a, _b) = write_pair(metadata, SEVERITY, &batches);
    assert_same_logical_content(&default_files, &clustered_files);
    for path in &clustered_files {
        let severity_idx = column_index(path, SEVERITY);
        let time_idx = column_index(path, "event_time");
        for rows in row_groups(path) {
            assert_clustered(&rows, severity_idx, time_idx);
        }
    }
}

/// Custom-partitioned streams cluster each partition's file independently,
/// with the same column encodings as the default writer.
#[test]
fn custom_partition_files_cluster_independently() {
    let base = log_schema();
    let mut fields = base.fields().iter().cloned().collect_vec();
    fields.push(Arc::new(Field::new("tenant", DataType::Utf8, false)));
    let schema = Arc::new(Schema::new(fields));
    let batches = requests(&base, 40)
        .into_iter()
        .enumerate()
        .map(|(index, batch)| {
            let tenant = ["alpha", "beta", "gamma"][index % 3];
            let mut columns = batch.columns().to_vec();
            columns.push(Arc::new(StringArray::from(vec![tenant; batch.num_rows()])));
            (
                "logs",
                RecordBatch::try_new(schema.clone(), columns).unwrap(),
            )
        })
        .collect_vec();
    let metadata = || LogStreamMetadata {
        custom_partition: Some("tenant".to_owned()),
        ..Default::default()
    };
    let (default_files, clustered_files, _a, _b) = write_pair(metadata, SEVERITY, &batches);
    assert_eq!(clustered_files.len(), 3, "one file per tenant");
    assert_same_logical_content(&default_files, &clustered_files);
    let encodings = |path: &Path| {
        ParquetRecordBatchReaderBuilder::try_new(File::open(path).unwrap())
            .unwrap()
            .metadata()
            .row_groups()
            .iter()
            .map(|group| {
                group
                    .columns()
                    .iter()
                    .map(|column| column.encodings().collect_vec())
                    .collect_vec()
            })
            .collect_vec()
    };
    for (default, clustered) in default_files.iter().zip(&clustered_files) {
        assert_eq!(encodings(default), encodings(clustered));
    }
    for path in &clustered_files {
        let severity_idx = column_index(path, SEVERITY);
        let time_idx = column_index(path, DEFAULT_TIMESTAMP_KEY);
        let tenant_idx = column_index(path, "tenant");
        let groups = row_groups(path);
        let tenants = groups
            .iter()
            .flatten()
            .map(|row| row[tenant_idx].clone())
            .unique()
            .collect_vec();
        assert_eq!(tenants.len(), 1, "{path:?}");
        for rows in &groups {
            assert_clustered(rows, severity_idx, time_idx);
        }
    }
}

#[test]
fn zero_row_group_target_is_rejected() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("zero.parquet");
    let schema = log_schema();
    let error = log_clustering::write_clustered_log_parquet(
        &mut File::create(&path).unwrap(),
        requests(&schema, 10).into_iter().map(Ok),
        &schema,
        &WriterProperties::builder().build(),
        0,
        LogClusterKey {
            cluster_idx: 2,
            time_idx: Some(0),
        },
    )
    .unwrap_err();
    assert!(
        matches!(&error, StagingError::Parquet(inner) if inner.to_string().contains("greater than zero")),
        "{error:?}"
    );
}

#[test]
fn cluster_column_option_parses_and_defaults_off() {
    use crate::option::validation::cluster_column;
    assert_eq!(cluster_column(" severity_text ").unwrap(), SEVERITY);
    assert!(cluster_column("  ").is_err());
    assert!(cluster_column("a,b").is_err());

    let parsed = Options::try_parse_from(["parseable"]).unwrap();
    assert_eq!(parsed.log_severity_cluster_column, None);
    let parsed = Options::try_parse_from([
        "parseable",
        "--log-severity-cluster-column",
        "severity_number",
    ])
    .unwrap();
    assert_eq!(
        parsed.log_severity_cluster_column.as_deref(),
        Some("severity_number")
    );
}

/// Independent reference order: a stable `std` sort with explicit
/// `(severity ASC NULLS LAST, time DESC NULLS LAST)` comparisons.
fn reference_order(batch: &RecordBatch, severity_idx: usize, time_idx: usize) -> Vec<u32> {
    let severity = batch
        .column(severity_idx)
        .as_any()
        .downcast_ref::<StringArray>()
        .unwrap();
    let time = batch
        .column(time_idx)
        .as_any()
        .downcast_ref::<TimestampMillisecondArray>()
        .unwrap();
    let key = |row: usize| {
        (
            severity.is_null(row),
            severity.is_valid(row).then(|| severity.value(row)),
            time.is_null(row),
            std::cmp::Reverse(time.is_valid(row).then(|| time.value(row))),
        )
    };
    let mut order = (0..batch.num_rows()).collect_vec();
    order.sort_by_key(|row| key(*row));
    order.into_iter().map(|row| row as u32).collect()
}

fn reference_cluster(schema: &Arc<Schema>, slices: &[RecordBatch]) -> RecordBatch {
    let combined = arrow::compute::concat_batches(schema, slices).unwrap();
    let indices = arrow_array::UInt32Array::from(reference_order(&combined, 2, 0));
    let columns = combined
        .columns()
        .iter()
        .map(|column| arrow::compute::take(column.as_ref(), &indices, None).unwrap())
        .collect_vec();
    RecordBatch::try_new(schema.clone(), columns).unwrap()
}

#[test]
fn interleaved_batches_match_reference_order() {
    let schema = log_schema();
    let key = LogClusterKey {
        cluster_idx: 2,
        time_idx: Some(0),
    };
    // Uneven slices, as the row-group buffer receives them from requests.
    let slices = requests(&schema, 37);
    let expected = reference_cluster(&schema, &slices);
    for output_rows in [1, 3, 64, 999, 1000, 8192] {
        let mut out = Vec::new();
        log_clustering::cluster_row_group_into(slices.clone(), key, output_rows, |batch| {
            out.push(batch);
            Ok(())
        })
        .unwrap();
        assert!(out.iter().all(|b| b.num_rows() <= output_rows));
        assert_eq!(out.iter().map(RecordBatch::num_rows).sum::<usize>(), ROWS);
        let actual = arrow::compute::concat_batches(&schema, &out).unwrap();
        assert_eq!(actual, expected, "output_rows={output_rows}");
    }

    // Already ordered input is emitted as the original slices, uncopied.
    let ordered = expected.clone();
    let ordered_slices = vec![ordered.slice(0, 400), ordered.slice(400, 600)];
    let mut out = Vec::new();
    log_clustering::cluster_row_group_into(ordered_slices.clone(), key, 64, |batch| {
        out.push(batch);
        Ok(())
    })
    .unwrap();
    assert_eq!(out, ordered_slices);
}

/// Chunked output must be byte-identical to writing each reordered row group
/// as one batch (the previous concat-and-take implementation).
#[test]
fn chunked_writer_matches_single_batch_write_bytes() {
    const BIG_ROWS: usize = 20_000;
    const TARGET: usize = 16_384;
    let schema = log_schema();
    let batches = (0..BIG_ROWS)
        .collect_vec()
        .chunks(613)
        .map(|ids| {
            RecordBatch::try_new(
                schema.clone(),
                vec![
                    Arc::new(TimestampMillisecondArray::from(
                        ids.iter()
                            .map(|id| {
                                (id % 89 != 0).then_some(1_760_000_000_000 + (*id as i64 / 5))
                            })
                            .collect::<Vec<_>>(),
                    )),
                    Arc::new(Int64Array::from_iter_values(
                        ids.iter().map(|id| *id as i64),
                    )),
                    Arc::new(StringArray::from(
                        ids.iter().map(|id| severity(*id)).collect::<Vec<_>>(),
                    )),
                    Arc::new(StringArray::from(
                        ids.iter()
                            .map(|id| (id % 13 != 0).then(|| format!("message {}", id % 401)))
                            .collect::<Vec<_>>(),
                    )),
                ],
            )
            .unwrap()
        })
        .collect_vec();
    let props = WriterProperties::builder()
        .set_max_row_group_row_count(Some(TARGET))
        .build();
    let key = LogClusterKey {
        cluster_idx: 2,
        time_idx: Some(0),
    };
    let dir = TempDir::new().unwrap();
    let actual_path = dir.path().join("chunked.parquet");
    let stats = log_clustering::write_clustered_log_parquet(
        &mut File::create(&actual_path).unwrap(),
        batches.clone().into_iter().map(Ok),
        &schema,
        &props,
        TARGET,
        key,
    )
    .unwrap();
    assert_eq!((stats.rows, stats.row_groups), (BIG_ROWS, 2));

    let combined = arrow::compute::concat_batches(&schema, &batches).unwrap();
    let expected_path = dir.path().join("single.parquet");
    let mut writer = ArrowWriter::try_new(
        File::create(&expected_path).unwrap(),
        schema.clone(),
        Some(props.clone()),
    )
    .unwrap();
    for (offset, len) in [(0, TARGET), (TARGET, BIG_ROWS - TARGET)] {
        writer
            .write(&reference_cluster(&schema, &[combined.slice(offset, len)]))
            .unwrap();
        writer.flush().unwrap();
    }
    writer.close().unwrap();

    assert_eq!(
        std::fs::read(&actual_path).unwrap(),
        std::fs::read(&expected_path).unwrap()
    );
    assert_eq!(
        row_groups(&actual_path).iter().map(Vec::len).collect_vec(),
        vec![TARGET, BIG_ROWS - TARGET]
    );
}
