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

//! Timestamp preflight with a bounded geometric window schedule.
use std::sync::Arc;

use datafusion::{
    arrow::datatypes::DataType,
    common::{
        Column, ScalarValue,
        tree_node::{Transformed, TreeNode},
    },
    error::Result,
    logical_expr::{Expr, Filter, LogicalPlan, LogicalPlanBuilder, Operator, Volatility},
    prelude::{SessionContext, lit},
};

pub(super) struct Candidate {
    probe: LogicalPlan,
    column: Column,
    rows: usize,
}

// Bound the probe TopK state even for very large requested limits/offsets.
const MAX_ROWS: usize = 1000;
// Narrow object-store queries lose to the extra metadata round trip.
const MIN_COLUMNS: usize = 8;

fn literal_usize(expr: Option<&Expr>, default: usize) -> Option<usize> {
    match expr {
        None => Some(default),
        Some(Expr::Literal(ScalarValue::Int64(Some(n)), _)) => usize::try_from(*n).ok(),
        _ => None,
    }
}

// A schedule bounds the sum of requested time spans, not bytes or CPU: skewed
// data and minute-file granularity can exceed the temporal fraction.
const FIRST_WINDOW_MS: i64 = 60_000;
const GROWTH: i64 = 8;
const MAX_PROBES: usize = 3;

fn windows(start: i64, end: i64) -> Vec<i64> {
    let Some(range) = end.checked_sub(start).filter(|r| *r > 0) else {
        return vec![];
    };
    let cap = range / 10;
    let mut width = FIRST_WINDOW_MS.min(cap);
    let mut result = Vec::new();
    for _ in 0..MAX_PROBES {
        if width == 0 || width > cap {
            break;
        }
        result.push(end - width);
        let Some(next) = width.checked_mul(GROWTH) else {
            break;
        };
        width = next;
    }
    result
}

// An arbitrary reference to time (e.g. in an OR) does not exclude nulls.
fn excludes_null_time(expr: &Expr, time: &str) -> bool {
    let Expr::BinaryExpr(b) = expr else {
        return false;
    };
    if b.op == Operator::And {
        return excludes_null_time(&b.left, time) || excludes_null_time(&b.right, time);
    }
    matches!((&*b.left, &*b.right), (Expr::Column(c), Expr::Literal(_, _)) if c.name == time)
        && matches!(
            b.op,
            Operator::Gt | Operator::GtEq | Operator::Lt | Operator::LtEq | Operator::Eq
        )
}

/// The probes and the final query are separate executions, each with its own
/// start time. A threshold found by a probe only holds for the final query if
/// the predicate gives the same answer for a row in both, so anything that
/// depends on when or how often it is evaluated (`now()`, `random()`), and any
/// subquery, leaves the query to run without a prefilter.
fn repeatable(predicate: &Expr) -> bool {
    !predicate
        .exists(|expr| {
            Ok(match expr {
                Expr::ScalarFunction(function) => {
                    function.func.signature().volatility != Volatility::Immutable
                }
                // Subqueries are not walked into, so none is accepted
                Expr::ScalarSubquery(_)
                | Expr::Exists(_)
                | Expr::InSubquery(_)
                | Expr::SetComparison(_)
                | Expr::OuterReferenceColumn(..)
                // Values or functions this check cannot vouch for
                | Expr::ScalarVariable(..)
                | Expr::Placeholder(_)
                | Expr::HigherOrderFunction(_)
                | Expr::Lambda(_)
                | Expr::LambdaVariable(_)
                | Expr::Unnest(_)
                | Expr::AggregateFunction(_)
                | Expr::WindowFunction(_) => true,
                _ => false,
            })
        })
        .unwrap_or(true)
}

pub(super) fn candidate(plan: &LogicalPlan, time: &str) -> Option<Candidate> {
    if plan.schema().fields().len() < MIN_COLUMNS {
        return None;
    }
    let LogicalPlan::Limit(limit) = plan else {
        return None;
    };
    let fetch = literal_usize(limit.fetch.as_deref(), 0)?;
    let rows = fetch.checked_add(literal_usize(limit.skip.as_deref(), 0)?)?;
    if fetch == 0 || rows > MAX_ROWS {
        return None;
    }
    let LogicalPlan::Sort(sort) = limit.input.as_ref() else {
        return None;
    };
    if sort.expr.len() != 1 || sort.expr[0].asc || sort.fetch.is_some_and(|n| n < rows) {
        return None;
    }
    let Expr::Column(column) = &sort.expr[0].expr else {
        return None;
    };
    if column.name != time {
        return None;
    }
    let mut input = sort.input.as_ref();
    let mut excludes_null = false;
    loop {
        match input {
            LogicalPlan::Projection(p) if p.expr.iter().all(|e| matches!(e, Expr::Column(_))) => {
                input = &p.input
            }
            LogicalPlan::Filter(f) => {
                if !repeatable(&f.predicate) {
                    return None;
                }
                excludes_null |= excludes_null_time(&f.predicate, time);
                input = &f.input;
            }
            LogicalPlan::TableScan(scan) if scan.fetch.is_none() => {
                if !scan.filters.iter().all(repeatable) {
                    return None;
                }
                if column
                    .relation
                    .as_ref()
                    .is_some_and(|r| r != &scan.table_name)
                {
                    return None;
                }
                excludes_null |= scan.filters.iter().any(|f| excludes_null_time(f, time));
                if !excludes_null
                    && sort.expr[0].nulls_first
                    && scan
                        .source
                        .schema()
                        .field_with_name(time)
                        .ok()?
                        .is_nullable()
                {
                    return None;
                }
                if !matches!(
                    scan.source.schema().field_with_name(time).ok()?.data_type(),
                    DataType::Timestamp(_, _)
                ) {
                    return None;
                }
                break;
            }
            _ => return None,
        }
    }
    // Project above the original sort input: preserves all WHERE semantics and
    // lets DataFusion prune every unused output column during optimization.
    let probe = LogicalPlanBuilder::from(sort.input.as_ref().clone())
        .project(vec![Expr::Column(column.clone())])
        .ok()?
        .sort(sort.expr.clone())
        .ok()?
        .limit(0, Some(rows))
        .ok()?
        .build()
        .ok()?;
    Some(Candidate {
        probe,
        column: column.clone(),
        rows,
    })
}

fn with_threshold(plan: LogicalPlan, column: &Column, value: ScalarValue) -> Result<LogicalPlan> {
    with_bound(plan, column, value, Operator::GtEq)
}

fn with_bound(
    plan: LogicalPlan,
    column: &Column,
    value: ScalarValue,
    op: Operator,
) -> Result<LogicalPlan> {
    plan.transform_up(|node| {
        if let LogicalPlan::TableScan(scan) = node {
            let predicate = datafusion::logical_expr::binary_expr(
                Expr::Column(Column::new(
                    Some(scan.table_name.clone()),
                    column.name.clone(),
                )),
                op,
                lit(value.clone()),
            );
            Ok(Transformed::yes(LogicalPlan::Filter(Filter::try_new(
                predicate,
                Arc::new(LogicalPlan::TableScan(scan)),
            )?)))
        } else {
            Ok(Transformed::no(node))
        }
    })
    .map(|t| t.data)
}

pub(super) async fn prefilter_range(
    ctx: &SessionContext,
    plan: LogicalPlan,
    candidate: Candidate,
    tenant_id: &Option<String>,
    start: i64,
    end: i64,
) -> Result<LogicalPlan> {
    for lower in windows(start, end) {
        let probe = with_threshold(
            candidate.probe.clone(),
            &candidate.column,
            ScalarValue::TimestampMillisecond(Some(lower), None),
        )?;
        let probe = with_bound(
            probe,
            &candidate.column,
            ScalarValue::TimestampMillisecond(Some(end), None),
            Operator::LtEq,
        )?;
        let df = ctx.execute_logical_plan(probe).await?;
        let physical = ctx.state().create_physical_plan(df.logical_plan()).await?;
        let batches = datafusion::physical_plan::collect(physical.clone(), ctx.task_ctx()).await?;
        crate::metrics::increment_bytes_scanned_in_query_by_date(
            super::get_total_bytes_scanned(&physical),
            &chrono::Utc::now().date_naive().to_string(),
            tenant_id
                .as_deref()
                .unwrap_or(crate::parseable::DEFAULT_TENANT),
        );
        if batches.iter().map(|b| b.num_rows()).sum::<usize>() != candidate.rows {
            continue;
        }
        let Some(last) = batches.iter().rev().find(|b| b.num_rows() > 0) else {
            return Ok(plan);
        };
        let value = ScalarValue::try_from_array(last.column(0), last.num_rows() - 1)?;
        if value.is_null() {
            return Ok(plan);
        }
        return with_threshold(plan, &candidate.column, value);
    }
    Ok(plan)
}

// Previous full-range probe, retained only as a differential oracle.
#[cfg(test)]
async fn unbounded_prefilter(
    ctx: &SessionContext,
    plan: LogicalPlan,
    candidate: Candidate,
    tenant_id: &Option<String>,
) -> Result<LogicalPlan> {
    let df = ctx.execute_logical_plan(candidate.probe).await?;
    let physical = ctx.state().create_physical_plan(df.logical_plan()).await?;
    let batches = datafusion::physical_plan::collect(physical.clone(), ctx.task_ctx()).await?;
    crate::metrics::increment_bytes_scanned_in_query_by_date(
        super::get_total_bytes_scanned(&physical),
        &chrono::Utc::now().date_naive().to_string(),
        tenant_id
            .as_deref()
            .unwrap_or(crate::parseable::DEFAULT_TENANT),
    );
    if batches.iter().map(|b| b.num_rows()).sum::<usize>() != candidate.rows {
        return Ok(plan);
    }
    let Some(last) = batches.iter().rev().find(|b| b.num_rows() > 0) else {
        return Ok(plan);
    };
    let value = ScalarValue::try_from_array(last.column(0), last.num_rows() - 1)?;
    if value.is_null() {
        return Ok(plan);
    }
    with_threshold(plan, &candidate.column, value)
}

#[cfg(test)]
async fn prefilter(
    ctx: &SessionContext,
    plan: LogicalPlan,
    candidate: Candidate,
    tenant_id: &Option<String>,
) -> Result<LogicalPlan> {
    prefilter_range(ctx, plan, candidate, tenant_id, -100_000, 40).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use datafusion::arrow::{
        array::{ArrayRef, Int64Array, StringArray, TimestampMillisecondArray},
        datatypes::{Field, Schema},
        record_batch::RecordBatch,
    };
    use datafusion::datasource::MemTable;

    fn context(time: &str) -> SessionContext {
        let mut config = datafusion::prelude::SessionConfig::new();
        config
            .options_mut()
            .execution
            .parquet
            .schema_force_view_types = false;
        let ctx = SessionContext::new_with_config(config);
        let mut fields = vec![
            Field::new(
                time,
                DataType::Timestamp(datafusion::arrow::datatypes::TimeUnit::Millisecond, None),
                false,
            ),
            Field::new("level", DataType::Utf8, false),
        ];
        fields.extend((0..8).map(|i| Field::new(format!("v{i}"), DataType::Int64, false)));
        let schema = Arc::new(Schema::new(fields));
        let mut cols: Vec<ArrayRef> = vec![
            Arc::new(TimestampMillisecondArray::from(
                (0..257).map(|i| (i / 7) as i64).collect::<Vec<_>>(),
            )),
            Arc::new(StringArray::from(
                (0..257)
                    .map(|i| if i % 3 == 0 { "ERROR" } else { "INFO" })
                    .collect::<Vec<_>>(),
            )),
        ];
        cols.extend((0..8).map(|_| Arc::new(Int64Array::from_iter_values(0..257)) as ArrayRef));
        let batch = RecordBatch::try_new(schema.clone(), cols).unwrap();
        // Two partitions model multiple input sources, including ties across them.
        ctx.register_table(
            "logs",
            Arc::new(
                MemTable::try_new(
                    schema,
                    vec![vec![batch.slice(0, 128)], vec![batch.slice(128, 129)]],
                )
                .unwrap(),
            ),
        )
        .unwrap();
        ctx
    }

    fn assert_membership(batch: &RecordBatch) {
        let ids = batch
            .column(2)
            .as_any()
            .downcast_ref::<Int64Array>()
            .unwrap();
        let times = batch
            .column(0)
            .as_any()
            .downcast_ref::<TimestampMillisecondArray>()
            .unwrap();
        let levels = batch
            .column(1)
            .as_any()
            .downcast_ref::<StringArray>()
            .unwrap();
        for row in 0..batch.num_rows() {
            let id = ids.value(row);
            assert!((0..257).contains(&id));
            assert_eq!(times.value(row), id / 7);
            assert_eq!(
                levels.value(row),
                if id % 3 == 0 { "ERROR" } else { "INFO" }
            );
            for column in batch.columns().iter().skip(2) {
                assert_eq!(
                    column
                        .as_any()
                        .downcast_ref::<Int64Array>()
                        .unwrap()
                        .value(row),
                    id
                );
            }
        }
    }

    #[test]
    fn window_schedule_has_geometric_cost_bound() {
        assert!(windows(10, 10).is_empty());
        assert!(windows(i64::MIN, i64::MAX).is_empty());
        assert_eq!(windows(0, 600_000), vec![540_000]);
        assert_eq!(windows(0, 6_000_000), vec![5_940_000, 5_520_000]);
        assert_eq!(
            windows(0, 60_000_000),
            vec![59_940_000, 59_520_000, 56_160_000]
        );
        for range in (1..100_000_000i64).step_by(7919) {
            let schedule = windows(0, range);
            assert!(schedule.len() <= MAX_PROBES);
            let sum: i64 = schedule.iter().map(|lower| range - lower).sum();
            // Geometric sum <= (8/7) * (range/10) = 4/35 range.
            assert!(sum * 35 <= range * 4);
            assert!(schedule.iter().all(|lower| range - lower <= range / 10));
        }
    }

    #[tokio::test]
    async fn windowed_equivalence_and_fallback() {
        for time in ["p_timestamp", "event_time"] {
            let ctx = context(time);
            for (end, limit, offset, predicate, found) in [
                (40, 10, 0, "true", true),              // first window
                (100_000, 10, 0, "true", true),         // second window, old data
                (1_000_000, 10, 0, "true", false),      // data older than every probe
                (40, 999, 0, "true", false),            // short
                (40, 10, 0, "level = 'ABSENT'", false), // empty
                (60_030, 45, 0, "true", true),          // ties at inclusive window edge
                (100_000, 10, 3, "v0 % 3 = 1 AND level != 'ERROR'", true),
            ] {
                let plan = ctx.sql(&format!("SELECT * FROM logs WHERE {predicate} ORDER BY {time} DESC LIMIT {limit} OFFSET {offset}"))
                    .await.unwrap().into_unoptimized_plan();
                let plan = crate::query::stream_schema_provider::with_planning_cache(plan).unwrap();
                let legacy =
                    unbounded_prefilter(&ctx, plan.clone(), candidate(&plan, time).unwrap(), &None)
                        .await
                        .unwrap();
                let legacy = ctx
                    .execute_logical_plan(legacy)
                    .await
                    .unwrap()
                    .collect()
                    .await
                    .unwrap();
                let rewritten = prefilter_range(
                    &ctx,
                    plan.clone(),
                    candidate(&plan, time).unwrap(),
                    &None,
                    end - 10_000_000,
                    end,
                )
                .await
                .unwrap();
                assert_eq!(rewritten != plan, found, "end={end}, predicate={predicate}");
                let original = ctx
                    .execute_logical_plan(plan)
                    .await
                    .unwrap()
                    .collect()
                    .await
                    .unwrap();
                let actual = ctx
                    .execute_logical_plan(rewritten)
                    .await
                    .unwrap()
                    .collect()
                    .await
                    .unwrap();
                let timestamps = |batches: &[RecordBatch]| {
                    batches
                        .iter()
                        .flat_map(|b| {
                            b.column(0)
                                .as_any()
                                .downcast_ref::<TimestampMillisecondArray>()
                                .unwrap()
                                .values()
                                .to_vec()
                        })
                        .collect::<Vec<_>>()
                };
                assert_eq!(timestamps(&original), timestamps(&actual));
                assert_eq!(timestamps(&original), timestamps(&legacy));
                for b in actual {
                    assert_membership(&b);
                    let ts = b
                        .column(0)
                        .as_any()
                        .downcast_ref::<TimestampMillisecondArray>()
                        .unwrap();
                    let ids = b.column(2).as_any().downcast_ref::<Int64Array>().unwrap();
                    for i in 0..b.num_rows() {
                        assert!((0..257).contains(&ids.value(i)));
                        assert_eq!(ts.value(i), ids.value(i) / 7);
                    }
                }
            }
        }
    }

    #[tokio::test]
    async fn matcher_shapes() {
        let ctx = context("p_timestamp");
        for (sql, expected) in [
            (
                "SELECT * EXCEPT (v0) FROM logs ORDER BY p_timestamp DESC LIMIT 10",
                true,
            ),
            (
                "SELECT level, v0, v1, v2, v3, v4, v5, v6 FROM logs ORDER BY p_timestamp DESC LIMIT 10",
                false,
            ),
            (
                "SELECT p_timestamp AS t, level, v0, v1, v2, v3, v4, v5 FROM logs ORDER BY t DESC LIMIT 10",
                false,
            ),
            (
                "SELECT * FROM logs UNION ALL SELECT * FROM logs ORDER BY p_timestamp DESC LIMIT 10",
                false,
            ),
            (
                "SELECT * FROM logs ORDER BY p_timestamp DESC LIMIT 10",
                true,
            ),
            (
                "SELECT * FROM logs WHERE level = 'ERROR' ORDER BY logs.p_timestamp DESC LIMIT 10 OFFSET 3",
                true,
            ),
            (
                "SELECT * FROM logs ORDER BY p_timestamp ASC LIMIT 10",
                false,
            ),
            (
                "SELECT * FROM logs ORDER BY p_timestamp DESC, v0 LIMIT 10",
                false,
            ),
            ("SELECT * FROM logs ORDER BY v0 DESC LIMIT 10", false),
            ("SELECT * FROM logs ORDER BY p_timestamp DESC", false),
            (
                "SELECT * FROM logs ORDER BY p_timestamp DESC LIMIT 1001",
                false,
            ),
            (
                "SELECT * FROM logs ORDER BY p_timestamp DESC LIMIT 10 OFFSET 1000",
                false,
            ),
            (
                "SELECT * FROM logs ORDER BY p_timestamp DESC LIMIT 0",
                false,
            ),
            (
                "SELECT p_timestamp, level FROM logs ORDER BY p_timestamp DESC LIMIT 10",
                false,
            ),
            (
                "SELECT * FROM logs WHERE v0 = 123 ORDER BY p_timestamp DESC LIMIT 10",
                true,
            ),
            (
                "SELECT * FROM logs WHERE level = 'ERROS' ORDER BY p_timestamp DESC LIMIT 10",
                true,
            ),
            (
                "SELECT * FROM logs WHERE level = 'ABSENT' ORDER BY p_timestamp DESC LIMIT 10",
                true,
            ),
            (
                "SELECT *, random() FROM logs ORDER BY p_timestamp DESC LIMIT 10",
                false,
            ),
            // A predicate must give the same answer in the probe and the final query
            (
                "SELECT * FROM logs WHERE lower(level) = 'error' ORDER BY p_timestamp DESC LIMIT 10",
                true,
            ),
            (
                "SELECT * FROM logs WHERE level = 'ERROR' OR p_timestamp < now() ORDER BY p_timestamp DESC LIMIT 10",
                false,
            ),
            (
                "SELECT * FROM logs WHERE random() < 0.5 ORDER BY p_timestamp DESC LIMIT 10",
                false,
            ),
            (
                "SELECT * FROM logs WHERE level IN (SELECT level FROM logs) ORDER BY p_timestamp DESC LIMIT 10",
                false,
            ),
            (
                "SELECT * FROM logs WHERE EXISTS (SELECT 1 FROM logs) ORDER BY p_timestamp DESC LIMIT 10",
                false,
            ),
            (
                "SELECT * FROM logs WHERE v0 < ANY (SELECT v0 FROM logs) ORDER BY p_timestamp DESC LIMIT 10",
                false,
            ),
            (
                "SELECT * FROM logs WHERE level = 'ERROR' OR 1 < ALL (SELECT CASE WHEN now() < p_timestamp THEN 2 ELSE 0 END FROM logs) ORDER BY p_timestamp DESC LIMIT 10",
                false,
            ),
            (
                "SELECT * FROM logs x ORDER BY p_timestamp DESC LIMIT 10",
                false,
            ),
            (
                "SELECT DISTINCT * FROM logs ORDER BY p_timestamp DESC LIMIT 10",
                false,
            ),
            (
                "EXPLAIN SELECT * FROM logs ORDER BY p_timestamp DESC LIMIT 10",
                false,
            ),
        ] {
            let plan = ctx.sql(sql).await.unwrap().into_unoptimized_plan();
            assert_eq!(
                candidate(&plan, "p_timestamp").is_some(),
                expected,
                "{sql}\n{plan}"
            );
        }
    }

    #[tokio::test]
    async fn predicate_preserves_execution_error() {
        let ctx = context("p_timestamp");
        let plan = ctx.sql("SELECT * FROM logs WHERE CAST('bad' AS BIGINT) = 1 ORDER BY p_timestamp DESC LIMIT 10").await.unwrap().into_unoptimized_plan();
        assert!(candidate(&plan, "p_timestamp").is_some());
        let mut errors = Vec::new();
        for enabled in [false, true] {
            let rewritten = if enabled {
                if let Some(c) = candidate(&plan, "p_timestamp") {
                    match prefilter(&ctx, plan.clone(), c, &None).await {
                        Ok(p) => p,
                        Err(e) => {
                            errors.push(e.to_string());
                            continue;
                        }
                    }
                } else {
                    plan.clone()
                }
            } else {
                plan.clone()
            };
            let error = ctx
                .execute_logical_plan(rewritten)
                .await
                .unwrap()
                .collect()
                .await
                .unwrap_err();
            errors.push(error.to_string());
        }
        assert_eq!(errors[0], errors[1]);
    }

    #[tokio::test]
    async fn differential_ties_offset_filters_custom_time() {
        for time in ["p_timestamp", "event_time"] {
            let ctx = context(time);
            for (limit, offset, filter) in [
                (10, 0, ""),
                (10, 17, ""),
                (999, 0, ""),
                (10, 0, " WHERE level = 'ERROR'"),
                (10, 0, " WHERE level = 'FATAL'"),
                (10, 0, " WHERE level = 'ERROR' AND "),
            ] {
                let filter = if filter.ends_with("AND ") {
                    format!("{filter}{time} >= arrow_cast(10, 'Timestamp(Millisecond, None)')")
                } else {
                    filter.to_owned()
                };
                // Cast predicates are retained in the complete probe input.
                let sql = format!(
                    "SELECT * FROM logs{filter} ORDER BY {time} DESC LIMIT {limit} OFFSET {offset}"
                );
                let plan = ctx.sql(&sql).await.unwrap().into_unoptimized_plan();
                let original = ctx
                    .execute_logical_plan(plan.clone())
                    .await
                    .unwrap()
                    .collect()
                    .await
                    .unwrap();
                let rewritten = if let Some(c) = candidate(&plan, time) {
                    prefilter(&ctx, plan, c, &None).await.unwrap()
                } else {
                    plan
                };
                let actual = ctx
                    .execute_logical_plan(rewritten)
                    .await
                    .unwrap()
                    .collect()
                    .await
                    .unwrap();
                let timestamps = |batches: &[RecordBatch]| {
                    batches
                        .iter()
                        .flat_map(|b| {
                            b.column(0)
                                .as_any()
                                .downcast_ref::<TimestampMillisecondArray>()
                                .unwrap()
                                .values()
                                .to_vec()
                        })
                        .collect::<Vec<_>>()
                };
                assert_eq!(timestamps(&original), timestamps(&actual), "{sql}");
                for batch in actual {
                    assert_eq!(batch.schema(), original[0].schema());
                    let ids = batch
                        .column(2)
                        .as_any()
                        .downcast_ref::<Int64Array>()
                        .unwrap();
                    let ts = batch
                        .column(0)
                        .as_any()
                        .downcast_ref::<TimestampMillisecondArray>()
                        .unwrap();
                    for i in 0..batch.num_rows() {
                        assert!((0..257).contains(&ids.value(i)));
                        assert_eq!(ts.value(i), ids.value(i) / 7);
                        let levels = batch
                            .column(1)
                            .as_any()
                            .downcast_ref::<StringArray>()
                            .unwrap();
                        assert_eq!(
                            levels.value(i),
                            if ids.value(i) % 3 == 0 {
                                "ERROR"
                            } else {
                                "INFO"
                            }
                        );
                        for column in batch.columns().iter().skip(2) {
                            assert_eq!(
                                column
                                    .as_any()
                                    .downcast_ref::<Int64Array>()
                                    .unwrap()
                                    .value(i),
                                ids.value(i)
                            );
                        }
                    }
                }
            }
        }
    }

    #[derive(Debug)]
    struct MixedTable {
        staged: Arc<dyn datafusion::catalog::TableProvider>,
        parquet: Arc<dyn datafusion::catalog::TableProvider>,
    }

    #[async_trait::async_trait]
    impl datafusion::catalog::TableProvider for MixedTable {
        fn schema(&self) -> Arc<Schema> {
            self.staged.schema()
        }
        fn table_type(&self) -> datafusion::logical_expr::TableType {
            datafusion::logical_expr::TableType::Base
        }
        async fn scan(
            &self,
            state: &dyn datafusion::catalog::Session,
            projection: Option<&Vec<usize>>,
            filters: &[Expr],
            limit: Option<usize>,
        ) -> Result<Arc<dyn datafusion::physical_plan::ExecutionPlan>> {
            let staged = self.staged.scan(state, projection, filters, limit).await?;
            let parquet = self.parquet.scan(state, projection, filters, limit).await?;
            datafusion::physical_plan::union::UnionExec::try_new(vec![staged, parquet])
        }
    }

    #[tokio::test]
    async fn differential_memory_and_parquet() {
        let ctx = context("p_timestamp");
        let data = ctx
            .sql("SELECT * FROM logs")
            .await
            .unwrap()
            .collect()
            .await
            .unwrap();
        let schema = data[0].schema();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("data.parquet");
        let mut writer = parquet::arrow::ArrowWriter::try_new(
            std::fs::File::create(&path).unwrap(),
            schema.clone(),
            None,
        )
        .unwrap();
        writer.write(&data[0]).unwrap();
        writer.close().unwrap();
        let parquet = ctx
            .read_parquet(
                path.to_str().unwrap(),
                datafusion::prelude::ParquetReadOptions::default(),
            )
            .await
            .unwrap()
            .into_view();
        let staged = Arc::new(MemTable::try_new(schema, vec![vec![data[1].clone()]]).unwrap());
        ctx.register_table("mixed", Arc::new(MixedTable { staged, parquet }))
            .unwrap();
        let plan = ctx
            .sql("SELECT * FROM mixed ORDER BY p_timestamp DESC LIMIT 200 OFFSET 7")
            .await
            .unwrap()
            .into_unoptimized_plan();
        let c = candidate(&plan, "p_timestamp").unwrap();
        let baseline = ctx
            .execute_logical_plan(plan.clone())
            .await
            .unwrap()
            .collect()
            .await
            .unwrap();
        let rewritten = prefilter(&ctx, plan, c, &None).await.unwrap();
        let actual = ctx
            .execute_logical_plan(rewritten)
            .await
            .unwrap()
            .collect()
            .await
            .unwrap();
        let ts = |batches: &[RecordBatch]| {
            batches
                .iter()
                .flat_map(|b| {
                    b.column(0)
                        .as_any()
                        .downcast_ref::<TimestampMillisecondArray>()
                        .unwrap()
                        .values()
                        .to_vec()
                })
                .collect::<Vec<_>>()
        };
        assert_eq!(ts(&baseline), ts(&actual));
        assert_eq!(actual[0].schema(), baseline[0].schema());
        for batch in &actual {
            assert_membership(batch);
            let ids = batch
                .column(2)
                .as_any()
                .downcast_ref::<Int64Array>()
                .unwrap();
            let times = batch
                .column(0)
                .as_any()
                .downcast_ref::<TimestampMillisecondArray>()
                .unwrap();
            for row in 0..batch.num_rows() {
                assert!((0..257).contains(&ids.value(row)));
                assert_eq!(times.value(row), ids.value(row) / 7);
            }
        }
    }

    #[tokio::test]
    async fn nullable_null_ordering_requires_a_time_bound() {
        let ctx = SessionContext::new();
        let mut fields = vec![Field::new(
            "p_timestamp",
            DataType::Timestamp(datafusion::arrow::datatypes::TimeUnit::Millisecond, None),
            true,
        )];
        fields.extend((0..8).map(|i| Field::new(format!("v{i}"), DataType::Int64, false)));
        ctx.register_table(
            "logs",
            Arc::new(MemTable::try_new(Arc::new(Schema::new(fields)), vec![vec![]]).unwrap()),
        )
        .unwrap();
        for (suffix, expected) in [
            ("ORDER BY p_timestamp DESC NULLS FIRST LIMIT 10", false),
            ("ORDER BY p_timestamp DESC NULLS LAST LIMIT 10", true),
            (
                "WHERE p_timestamp >= TIMESTAMP '2026-01-01' ORDER BY p_timestamp DESC NULLS FIRST LIMIT 10",
                false,
            ),
        ] {
            // SQL timestamp casts are conservatively rejected before optimization.
            let plan = ctx
                .sql(&format!("SELECT * FROM logs {suffix}"))
                .await
                .unwrap()
                .into_unoptimized_plan();
            assert_eq!(
                candidate(&plan, "p_timestamp").is_some(),
                expected,
                "{plan}"
            );
        }
        let plan = ctx
            .sql("SELECT * FROM logs ORDER BY p_timestamp DESC NULLS FIRST LIMIT 10")
            .await
            .unwrap()
            .into_unoptimized_plan();
        let plan = plan
            .transform_up(|p| {
                if let LogicalPlan::TableScan(_) = p {
                    Ok(Transformed::yes(LogicalPlan::Filter(Filter::try_new(
                        datafusion::prelude::col("logs.p_timestamp")
                            .gt_eq(lit(ScalarValue::TimestampMillisecond(Some(0), None))),
                        Arc::new(p),
                    )?)))
                } else {
                    Ok(Transformed::no(p))
                }
            })
            .unwrap()
            .data;
        assert!(candidate(&plan, "p_timestamp").is_some());
    }

    #[tokio::test]
    async fn threshold_preserves_plan_schema_and_inclusive_ties() {
        let ctx = context("p_timestamp");
        let plan = ctx
            .sql("SELECT * FROM logs ORDER BY p_timestamp DESC LIMIT 10 OFFSET 5")
            .await
            .unwrap()
            .into_unoptimized_plan();
        let c = candidate(&plan, "p_timestamp").unwrap();
        assert_eq!(c.rows, 15);
        assert_eq!(c.probe.schema().fields().len(), 1);
        let rewritten = prefilter(&ctx, plan.clone(), c, &None).await.unwrap();
        assert_eq!(rewritten.schema(), plan.schema());
        assert!(
            rewritten
                .display_indent()
                .to_string()
                .contains("logs.p_timestamp >=")
        );
    }
}
