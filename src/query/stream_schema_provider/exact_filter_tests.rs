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

//! Filters `StandardTableProvider` reports as `Exact` must be enforced by every scan it unions.
//!
//! DataFusion drops the `FilterExec` above a scan for `Exact` filters. Parquet scans enforce them
//! through the source predicate, but `MemTable` (in-memory staging) and `ListingTable` (legacy
//! listing) ignore pushed filters, so their rows must be filtered by the provider.

use std::{fs, path::PathBuf};

use arrow_array::{Int64Array, TimestampMillisecondArray};
use arrow_schema::{DataType, Field, TimeUnit};
use chrono::NaiveDate;
use datafusion::{
    physical_plan::collect,
    prelude::{SessionConfig, SessionContext},
};
use parquet::arrow::ArrowWriter;
use temp_dir::TempDir;

use super::*;
use crate::storage::LocalFS;

/// A provider with `StandardTableProvider`'s filter pushdown and its scan of a table that ignores
/// pushed filters.
#[derive(Debug)]
struct ExactPushdownTable {
    inner: Arc<dyn TableProvider>,
}

#[async_trait::async_trait]
impl TableProvider for ExactPushdownTable {
    fn schema(&self) -> SchemaRef {
        self.inner.schema()
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
    ) -> DataFusionResult<Arc<dyn ExecutionPlan>> {
        scan_enforcing_exact_filters(self.inner.as_ref(), state, projection, filters, limit).await
    }

    fn supports_filters_pushdown(
        &self,
        filters: &[&Expr],
    ) -> DataFusionResult<Vec<TableProviderFilterPushDown>> {
        Ok(filters
            .iter()
            .map(|filter| {
                if expr_in_boundary(filter) {
                    TableProviderFilterPushDown::Exact
                } else {
                    TableProviderFilterPushDown::Inexact
                }
            })
            .collect())
    }
}

fn millis(hour: u32, minute: u32, second: u32) -> i64 {
    NaiveDate::from_ymd_opt(2026, 10, 17)
        .unwrap()
        .and_hms_opt(hour, minute, second)
        .unwrap()
        .and_utc()
        .timestamp_millis()
}

fn schema() -> SchemaRef {
    let timestamp = DataType::Timestamp(TimeUnit::Millisecond, None);
    Arc::new(Schema::new(vec![
        Field::new(DEFAULT_TIMESTAMP_KEY, timestamp.clone(), false),
        Field::new("created_at", timestamp, false),
        Field::new("id", DataType::Int64, false),
    ]))
}

/// Ids 0..4 are at 12:29:30 and created in 2019; ids 4..8 are at 12:30:30 and created in 2021.
fn batch(schema: &SchemaRef) -> RecordBatch {
    let old_created = DateTime::parse_from_rfc3339("2019-06-01T00:00:00Z")
        .unwrap()
        .timestamp_millis();
    let new_created = DateTime::parse_from_rfc3339("2021-06-01T00:00:00Z")
        .unwrap()
        .timestamp_millis();
    let (times, created): (Vec<_>, Vec<_>) = (0..8)
        .map(|id| {
            if id < 4 {
                (millis(12, 29, 30), old_created)
            } else {
                (millis(12, 30, 30), new_created)
            }
        })
        .unzip();
    RecordBatch::try_new(
        schema.clone(),
        vec![
            Arc::new(TimestampMillisecondArray::from(times)),
            Arc::new(TimestampMillisecondArray::from(created)),
            Arc::new(Int64Array::from_iter_values(0..8)),
        ],
    )
    .unwrap()
}

/// Queries whose time predicates `expr_in_boundary` reports as `Exact`, and the ids they select.
const QUERIES: [(&str, &[i64]); 5] = [
    (
        "SELECT id FROM t WHERE created_at >= '2020-01-01T00:00:00' ORDER BY id",
        &[4, 5, 6, 7],
    ),
    (
        "SELECT id FROM t WHERE p_timestamp < '2026-10-17T12:30:00' ORDER BY id",
        &[0, 1, 2, 3],
    ),
    (
        "SELECT id FROM t WHERE p_timestamp >= '2026-10-17T12:30:00' AND id < 6 ORDER BY id",
        &[4, 5],
    ),
    (
        "SELECT p_timestamp, id FROM t WHERE created_at < '2020-01-01T00:00:00' ORDER BY id",
        &[0, 1, 2, 3],
    ),
    (
        "SELECT * FROM t WHERE created_at > '2020-01-01T00:00:00' ORDER BY id",
        &[4, 5, 6, 7],
    ),
];

async fn ids(context: &SessionContext, sql: &str) -> Vec<i64> {
    let plan = context
        .sql(sql)
        .await
        .unwrap()
        .create_physical_plan()
        .await
        .unwrap();
    let batches = collect(plan, context.task_ctx()).await.unwrap();
    batches
        .iter()
        .flat_map(|batch| {
            let ids = batch
                .column_by_name("id")
                .unwrap()
                .as_any()
                .downcast_ref::<Int64Array>()
                .unwrap();
            ids.values().to_vec()
        })
        .collect()
}

/// Checks `QUERIES`, a `LIMIT` that must count only matching rows, and a count without projected
/// columns against `table`.
async fn check(table: Arc<dyn TableProvider>) {
    let mut config = SessionConfig::new();
    config.options_mut().execution.parquet.pushdown_filters = true;
    let context = SessionContext::new_with_config(config);
    context
        .register_table("t", Arc::new(ExactPushdownTable { inner: table }))
        .unwrap();
    let mut failures = Vec::new();
    for (sql, expected) in QUERIES {
        let actual = ids(&context, sql).await;
        if actual != expected {
            failures.push(format!("{sql}: {actual:?}"));
        }
    }
    let sql = "SELECT id FROM t WHERE created_at >= '2020-01-01T00:00:00' LIMIT 2";
    let limited = ids(&context, sql).await;
    if limited.len() != 2 || limited.iter().any(|id| *id < 4) {
        failures.push(format!("{sql}: {limited:?}"));
    }
    // No column is projected for the count.
    let sql = "SELECT count(*) AS id FROM t WHERE created_at >= '2020-01-01T00:00:00'";
    let count = ids(&context, sql).await;
    if count != [4] {
        failures.push(format!("{sql}: {count:?}"));
    }
    assert!(failures.is_empty(), "{failures:#?}");
}

#[tokio::test]
async fn staging_memory_scan_enforces_exact_filters() {
    let schema = schema();
    let table = reversed_mem_table(vec![batch(&schema)], schema).unwrap();
    check(Arc::new(table)).await;
}

#[tokio::test]
async fn legacy_listing_scan_enforces_exact_filters() {
    let schema = schema();
    let store = TempDir::new().unwrap();
    let stream_dir = store.path().join("exact");
    let minute_dir = stream_dir.join("date=2026-10-17/hour=12/minute=29");
    fs::create_dir_all(&minute_dir).unwrap();
    let file = fs::File::create(minute_dir.join("listed.data.parquet")).unwrap();
    let mut writer = ArrowWriter::try_new(file, schema.clone(), None).unwrap();
    writer.write(&batch(&schema)).unwrap();
    writer.close().unwrap();

    // `LocalFS::query_prefixes` resolves prefixes against `/`, so the stream is named by its
    // absolute path without the leading `/`.
    let storage: Arc<dyn ObjectStorage> = Arc::new(LocalFS::new(PathBuf::from("/")));
    let midnight = |day| {
        NaiveDate::from_ymd_opt(2026, 10, day)
            .unwrap()
            .and_hms_opt(0, 0, 0)
            .unwrap()
    };
    let time_filters = [
        PartialTimeFilter::Low(Bound::Included(midnight(16))),
        PartialTimeFilter::High(Bound::Excluded(midnight(18))),
    ];
    let stream = stream_dir.to_str().unwrap()[1..].to_owned();
    let table = ListingTableBuilder::new(stream)
        .populate_via_listing(storage.clone(), &time_filters)
        .await
        .unwrap()
        .build(schema, |prefixes| storage.query_prefixes(prefixes))
        .unwrap()
        .expect("the file is listed");
    check(table).await;
}
