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

use std::{collections::HashMap, fmt::Display};

use actix_web::{Either, http::header::HeaderMap};
use arrow::{compute::cast, datatypes::DataType, util::display::array_value_to_string};
use arrow_array::{Array, Float64Array, RecordBatch};
use datafusion::{
    logical_expr::{Literal, LogicalPlan},
    prelude::{Expr, lit},
};
use tracing::trace;

use crate::{
    alerts::{
        AlertTrait, LogicalOperator, WhereConfigOperator,
        alert_structs::{AlertQueryResult, ConditionConfig, Conditions, GroupResult},
        resolve_alert_output_layout,
    },
    handlers::http::{
        cluster::send_query_request,
        query::{Query, create_streams_for_distributed},
    },
    option::Mode,
    parseable::PARSEABLE,
    query::{QUERY_SESSION, execute, resolve_stream_names},
    tenants::TENANT_METADATA,
    utils::time::TimeRange,
};

use super::{ALERTS, AlertError, AlertOperator, AlertState};

/// accept the alert
///
/// alert contains query and the threshold_config
///
/// execute the query and compute the output of the query
///
/// compare the output with the threshold_config
///
/// collect the results in the end
///
/// check whether notification needs to be triggered or not
pub async fn evaluate_alert(alert: &dyn AlertTrait) -> Result<(), AlertError> {
    if alert
        .get_tenant_id()
        .as_deref()
        .is_some_and(|tenant| TENANT_METADATA.is_workspace_suspended(tenant))
    {
        return Ok(());
    }

    trace!("RUNNING EVAL TASK FOR- {alert:?}");

    if alert.get_query_type() == super::AlertQueryType::Promql {
        return super::promql_alerts::evaluate(*alert.get_id(), alert.get_tenant_id()).await;
    }
    // Snapshot a generation before executing without locks. CRUD uses the same
    // lifecycle, so stale queries cannot restore an edited or disabled rule.
    let lifecycle = super::promql_alerts::lifecycle(*alert.get_id());
    let manager = super::get_alert_manager().await;
    let (current, generation) = {
        let guard = lifecycle.lock().await;
        let current = manager
            .get_alert_by_id(*alert.get_id(), alert.get_tenant_id())
            .await?;
        if current.get_state() == &AlertState::Disabled {
            return Ok(());
        }
        (current, *guard)
    };
    // AlertError can wrap an Actix ResponseError, which is not Send. Keep only
    // its sanitized diagnostic while crossing scheduler await points.
    let result = current
        .eval_alert()
        .await
        .map_err(|error| super::target::safe_runtime_error(&error.to_string()));
    let mut guard = lifecycle.lock().await;
    let latest = manager
        .get_alert_by_id(*current.get_id(), current.get_tenant_id())
        .await
        .map_err(|error| super::target::safe_runtime_error(&error.to_string()));
    if !sql_result_is_current(
        *guard,
        generation,
        latest.as_ref().ok().map(|rule| *rule.get_state()),
    ) {
        return Ok(());
    }
    *guard += 1;
    let mut config = latest.map_err(AlertError::CustomError)?.to_alert_config();
    let runtime = serde_json::json!({
        "health": if result.is_ok() { "ok" } else { "error" },
        "error": result.as_ref().err(),
        "lastEvaluatedAt": chrono::Utc::now(),
    });
    let previous = config
        .other_fields
        .as_ref()
        .and_then(|fields| fields.get("sqlRuntime"));
    let persist_error = sql_error_needs_persistence(previous, &runtime, result.is_err());
    config
        .other_fields
        .get_or_insert_with(Default::default)
        .insert("sqlRuntime".into(), runtime);
    // Successful evaluations include runtime in the existing state write below.
    // Identical failures refresh their timestamp in memory; only a health/error
    // change writes storage. A restart retains the last persisted error observation.
    if persist_error {
        PARSEABLE
            .metastore
            .put_alert(&config, &config.tenant_id)
            .await?;
    }
    manager
        .update(&super::alert_types::ThresholdAlert::from(config))
        .await;
    let message = result.map_err(AlertError::CustomError)?;
    update_alert_state(&*current, message).await
}

fn sql_error_needs_persistence(
    previous: Option<&serde_json::Value>,
    runtime: &serde_json::Value,
    failed: bool,
) -> bool {
    failed
        && previous.is_none_or(|previous| {
            previous.get("health") != runtime.get("health")
                || previous.get("error") != runtime.get("error")
        })
}

fn sql_result_is_current(generation: u64, observed: u64, state: Option<AlertState>) -> bool {
    generation == observed && state.is_some_and(|state| state != AlertState::Disabled)
}

/// SQL failures retain a scheduler with a capped exponential recovery delay.
pub(crate) fn sql_retry_delay(failures: u32) -> u64 {
    1u64.checked_shl(failures.saturating_sub(1).min(5))
        .unwrap_or(30)
        .min(30)
}

/// Extract time range from alert evaluation configuration
pub fn extract_time_range(eval_config: &super::EvalConfig) -> Result<TimeRange, AlertError> {
    let (start_time, end_time) = match eval_config {
        super::EvalConfig::RollingWindow(rolling_window) => (&rolling_window.eval_start, "now"),
    };

    TimeRange::parse_human_time(start_time, end_time)
        .map_err(|err| AlertError::CustomError(err.to_string()))
}

/// Query execution credentials for both saved SQL rules and their read-only preview.
pub(crate) fn alert_execution_headers(
    tenant_id: &Option<String>,
) -> Result<Option<HeaderMap>, AlertError> {
    use crate::handlers::http::middleware::{CLUSTER_SECRET, CLUSTER_SECRET_HEADER};
    use actix_web::http::header::{HeaderName, HeaderValue};
    let tenant = tenant_id
        .as_deref()
        .unwrap_or(crate::parseable::DEFAULT_TENANT);
    let Some((_, hash)) = CLUSTER_SECRET.get() else {
        return Ok(None);
    };
    let mut headers = HeaderMap::new();
    let header_value = |value: &str| {
        HeaderValue::from_str(value).map_err(|_| {
            AlertError::ValidationFailure("Invalid internal alert execution credential".into())
        })
    };
    if let Some(header) = TENANT_METADATA.get_global_query_auth(tenant) {
        headers.insert(
            HeaderName::from_static("authorization"),
            header_value(&header)?,
        );
    }
    headers.insert(
        HeaderName::from_static(CLUSTER_SECRET_HEADER),
        header_value(hash)?,
    );
    headers.insert(
        HeaderName::from_static("intra-cluster-tenant"),
        header_value(tenant)?,
    );
    Ok(Some(headers))
}

/// The shared threshold semantics for execution and preview, including the
/// historical zero value for a simple query that returns no rows.
pub fn evaluate_query_result(
    result: &AlertQueryResult,
    threshold: &super::ThresholdConfig,
) -> Vec<(GroupResult, bool)> {
    let groups = if result.is_simple_query {
        vec![result.groups.first().cloned().unwrap_or(GroupResult {
            group_values: HashMap::new(),
            aggregate_value: 0.0,
        })]
    } else {
        result.groups.clone()
    };
    groups
        .into_iter()
        .map(|group| {
            let breached =
                evaluate_condition(&threshold.operator, group.aggregate_value, threshold.value);
            (group, breached)
        })
        .collect()
}

/// Execute the alert query based on the current mode and return structured group results
pub async fn execute_alert_query(
    auth_token: Option<HeaderMap>,
    query: &str,
    time_range: &TimeRange,
    tenant_id: &Option<String>,
) -> Result<AlertQueryResult, AlertError> {
    match PARSEABLE.options.mode {
        Mode::All | Mode::Query => execute_local_query(query, time_range, tenant_id).await,
        Mode::Prism => execute_remote_query(auth_token, query, time_range, tenant_id).await,
        _ => Err(AlertError::CustomError(format!(
            "Unsupported mode '{:?}' for alert evaluation",
            PARSEABLE.options.mode
        ))),
    }
}

/// Execute alert query locally (Query/All mode)
async fn execute_local_query(
    query: &str,
    time_range: &TimeRange,
    tenant_id: &Option<String>,
) -> Result<AlertQueryResult, AlertError> {
    let mut session_state = QUERY_SESSION.get_ctx().state();
    session_state
        .config_mut()
        .options_mut()
        .catalog
        .default_schema = tenant_id.as_deref().unwrap_or("public").to_owned();
    let tables = resolve_stream_names(query)?;
    create_streams_for_distributed(tables.clone(), tenant_id)
        .await
        .map_err(|err| AlertError::CustomError(format!("Failed to create streams: {err}")))?;

    let raw_logical_plan = session_state.create_logical_plan(query).await?;
    let query = crate::query::Query {
        raw_logical_plan: raw_logical_plan.clone(),
        time_range: time_range.clone(),
        filter_tag: None,
    };

    let (records, _) = execute(query, false, tenant_id)
        .await
        .map_err(|err| AlertError::CustomError(format!("Failed to execute query: {err}")))?;

    let records = match records {
        Either::Left(rbs) => rbs,
        Either::Right(_) => {
            return Err(AlertError::CustomError(
                "Query returned no results".to_string(),
            ));
        }
    };

    extract_group_results(records, raw_logical_plan)
}

/// Execute alert query remotely (Prism mode)
async fn execute_remote_query(
    auth_token: Option<HeaderMap>,
    query: &str,
    time_range: &TimeRange,
    tenant_id: &Option<String>,
) -> Result<AlertQueryResult, AlertError> {
    let mut session_state = QUERY_SESSION.get_ctx().state();
    session_state
        .config_mut()
        .options_mut()
        .catalog
        .default_schema = tenant_id.as_deref().unwrap_or("public").to_owned();
    let raw_logical_plan = session_state.create_logical_plan(query).await?;

    let query_request = Query {
        query: query.to_string(),
        start_time: time_range.start.to_rfc3339(),
        end_time: time_range.end.to_rfc3339(),
        streaming: false,
        send_null: false,
        fields: false,
        filter_tags: None,
    };

    let (result_value, _) = send_query_request(auth_token, &query_request, tenant_id)
        .await
        .map_err(|err| AlertError::CustomError(format!("Failed to send query request: {err}")))?;

    convert_result_to_group_results(result_value, raw_logical_plan)
}

/// Convert JSON result value to AlertQueryResult
/// Handles both simple queries and GROUP BY queries with multiple rows
fn convert_result_to_group_results(
    result_value: serde_json::Value,
    plan: LogicalPlan,
) -> Result<AlertQueryResult, AlertError> {
    let array_val = result_value
        .as_array()
        .ok_or_else(|| AlertError::CustomError("Expected array in query result".to_string()))?;

    let layout = resolve_alert_output_layout(&plan)?;

    if array_val.is_empty() {
        return Ok(AlertQueryResult {
            groups: vec![],
            is_simple_query: layout.dimension_indices.is_empty(),
        });
    }

    let aggregate_key = &layout.measure_name;
    let is_simple_query = layout.dimension_indices.is_empty();
    let mut groups = Vec::new();

    // Process each row as a separate group
    for row in array_val {
        if let Some(object) = row.as_object() {
            let aggregate_value = match object.get(aggregate_key) {
                Some(serde_json::Value::Null) => 0.0,
                Some(value) => value.as_f64().ok_or_else(|| {
                    AlertError::CustomError(format!(
                        "Non-numeric value found in aggregate column '{aggregate_key}'"
                    ))
                })?,
                None => {
                    return Err(AlertError::CustomError(format!(
                        "Aggregate column '{aggregate_key}' missing from query result"
                    )));
                }
            };
            let group_values = object
                .iter()
                .filter(|(key, _)| *key != aggregate_key)
                .map(|(key, value)| {
                    let rendered = match value {
                        serde_json::Value::String(text) => text.clone(),
                        other => other.to_string(),
                    };
                    (key.clone(), rendered)
                })
                .collect();

            groups.push(GroupResult {
                group_values,
                aggregate_value,
            });
        }
    }

    Ok(AlertQueryResult {
        groups,
        is_simple_query,
    })
}

/// Extract string value from an Arrow array at the given row index
fn extract_string_value(column: &dyn Array, row_index: usize) -> Result<String, AlertError> {
    if column.is_null(row_index) {
        return Ok("null".to_string());
    }
    Ok(array_value_to_string(column, row_index)?)
}

pub fn evaluate_condition(operator: &AlertOperator, actual: f64, expected: f64) -> bool {
    match operator {
        AlertOperator::GreaterThan => actual > expected,
        AlertOperator::LessThan => actual < expected,
        AlertOperator::Equal => actual == expected,
        AlertOperator::NotEqual => actual != expected,
        AlertOperator::GreaterThanOrEqual => actual >= expected,
        AlertOperator::LessThanOrEqual => actual <= expected,
    }
}

async fn update_alert_state(
    alert: &dyn AlertTrait,
    message: Option<String>,
) -> Result<(), AlertError> {
    // Get the alert manager reference while holding the lock briefly
    let alerts = {
        let guard = ALERTS.read().await;
        if let Some(alerts) = guard.as_ref() {
            alerts.clone()
        } else {
            return Err(AlertError::CustomError("No AlertManager set".into()));
        }
    };

    // Now perform the state update
    if let Some(msg) = message {
        alerts
            .update_state(
                *alert.get_id(),
                AlertState::Triggered,
                Some(msg),
                alert.get_tenant_id(),
            )
            .await
    } else if alerts
        .get_state(*alert.get_id(), alert.get_tenant_id())
        .await?
        .eq(&AlertState::Triggered)
    {
        alerts
            .update_state(
                *alert.get_id(),
                AlertState::NotTriggered,
                Some("".into()),
                alert.get_tenant_id(),
            )
            .await
    } else {
        alerts
            .update_state(
                *alert.get_id(),
                AlertState::NotTriggered,
                None,
                alert.get_tenant_id(),
            )
            .await
    }
}

/// Extract group results from record batches, supporting both simple and GROUP BY queries
fn extract_group_results(
    records: Vec<RecordBatch>,
    plan: LogicalPlan,
) -> Result<AlertQueryResult, AlertError> {
    trace!("records-\n{records:?}");

    let layout = resolve_alert_output_layout(&plan)?;

    if records.is_empty() {
        return Ok(AlertQueryResult {
            groups: vec![],
            is_simple_query: layout.dimension_indices.is_empty(),
        });
    }

    let is_simple_query = layout.dimension_indices.is_empty();

    let mut groups = Vec::new();

    for batch in &records {
        let schema = batch.schema();
        let measure_values = cast(batch.column(layout.measure_index), &DataType::Float64)?;
        let measure_values = measure_values
            .as_any()
            .downcast_ref::<Float64Array>()
            .ok_or_else(|| {
                AlertError::CustomError("Failed to cast alert value to Float64".into())
            })?;
        for row_index in 0..batch.num_rows() {
            let mut group_values = HashMap::new();
            let aggregate_value = if measure_values.is_null(row_index) {
                0.0
            } else {
                measure_values.value(row_index)
            };

            for dimension_index in &layout.dimension_indices {
                let field = schema.field(*dimension_index);
                let value =
                    extract_string_value(batch.column(*dimension_index).as_ref(), row_index)?;
                group_values.insert(field.name().clone(), value);
            }

            groups.push(GroupResult {
                group_values,
                aggregate_value,
            });
        }
    }

    Ok(AlertQueryResult {
        groups,
        is_simple_query,
    })
}

pub fn get_filter_string(where_clause: &Conditions) -> Result<String, String> {
    let op = where_clause
        .operator
        .as_ref()
        .unwrap_or(&LogicalOperator::And);

    let joiner = match op {
        LogicalOperator::And => " AND ",
        LogicalOperator::Or => " OR ",
    };

    let mut exprs = vec![];

    // Process flat condition_config entries
    for condition in &where_clause.condition_config {
        exprs.push(condition_to_expr(condition)?);
    }

    // Process nested groups recursively
    if let Some(groups) = &where_clause.groups {
        for group in groups {
            let group_expr = get_filter_string(group)?;
            // Wrap each group in parentheses to preserve precedence
            exprs.push(format!("({group_expr})"));
        }
    }

    if exprs.is_empty() {
        return Err(String::from(
            "conditions must have at least one condition or group",
        ));
    }

    Ok(exprs.join(joiner))
}

fn condition_to_expr(condition: &ConditionConfig) -> Result<String, String> {
    // is null / is not null don't take a value
    if condition.operator == WhereConfigOperator::IsNull
        || condition.operator == WhereConfigOperator::IsNotNull
    {
        if condition.value.as_ref().is_some_and(|v| !v.is_empty()) {
            return Err(
                "value must be null when operator is either `is null` or `is not null`".into(),
            );
        }
        return Ok(format!(
            "{} {}",
            quote_identifier(&condition.column),
            condition.operator
        ));
    }

    let value = condition.value.as_deref().unwrap_or("");

    let is_list_type = condition
        .column_type
        .as_ref()
        .is_some_and(|t| t.starts_with("list"));

    if is_list_type {
        list_condition_expr(&condition.column, &condition.operator, value)
    } else {
        scalar_condition_expr(
            &condition.column,
            &condition.operator,
            value,
            condition.column_type.as_deref(),
        )
    }
}

/// Split a comma-separated list of array elements in a quote-aware manner.
///
/// A plain `str::split(',')` breaks on commas that appear inside single-quoted
/// strings (e.g. `'New York, NY'`). This function walks the input char-by-char
/// and only treats a comma as a delimiter when it appears *outside* of a
/// single-quoted string. Doubled single quotes (`''`) inside a quoted string
/// are treated as an escaped quote character, not as a string terminator.
///
/// Returns `Err` if the input ends while still inside an open quoted string.
fn split_array_elements(value: &str) -> Result<Vec<&str>, String> {
    let mut elements = Vec::new();
    let mut in_quote = false;
    let mut start = 0;
    let chars: Vec<char> = value.chars().collect();
    let len = chars.len();
    let mut i = 0;

    while i < len {
        match chars[i] {
            '\'' if in_quote => {
                // Check for escaped quote: '' inside a quoted string
                if i + 1 < len && chars[i + 1] == '\'' {
                    i += 2; // skip both quotes, stay in_quote
                    continue;
                }
                // Closing quote
                in_quote = false;
            }
            '\'' => {
                in_quote = true;
            }
            ',' if !in_quote => {
                let byte_start = value
                    .char_indices()
                    .nth(start)
                    .map_or(value.len(), |(b, _)| b);
                let byte_end = value.char_indices().nth(i).map_or(value.len(), |(b, _)| b);
                elements.push(&value[byte_start..byte_end]);
                start = i + 1;
            }
            _ => {}
        }
        i += 1;
    }

    if in_quote {
        return Err("Unterminated quoted string in array value".to_string());
    }

    // Push the final element
    let byte_start = value
        .char_indices()
        .nth(start)
        .map_or(value.len(), |(b, _)| b);
    elements.push(&value[byte_start..]);

    Ok(elements)
}

/// Sanitize and validate each element of a comma-separated array value intended
/// for interpolation into an SQL `ARRAY[...]` literal.
///
/// Each element must be one of:
/// - A valid numeric literal (integer or float)
/// - A valid boolean literal (`true` or `false`)
/// - A single-quoted string (internal single quotes escaped as `''`)
/// - A bare unquoted string (automatically wrapped in single quotes, mirrors
///   the behaviour of `scalar_condition_expr`)
///
/// Any element containing bracket characters `[` or `]` is rejected outright
/// to prevent escaping the `ARRAY[...]` context, regardless of quoting.
///
/// The input is split using a quote-aware splitter so that commas inside
/// single-quoted strings (e.g. `'New York, NY'`) are not treated as delimiters.
///
/// Returns the sanitized, comma-joined string ready for interpolation, or an
/// `Err` describing the first offending element.
fn sanitize_array_elements(value: &str) -> Result<String, String> {
    let raw_elements = split_array_elements(value)?;

    let sanitized: Result<Vec<String>, String> = raw_elements
        .into_iter()
        .map(|elem| {
            let elem = elem.trim();

            // Reject bracket characters that could escape the ARRAY[...] context.
            // This is the primary injection guard; the quoting logic below is
            // consistent with scalar_condition_expr and does not rely on this check.
            if elem.contains('[') || elem.contains(']') {
                return Err(format!(
                    "Invalid array element: '{elem}' contains bracket characters"
                ));
            }

            // Numeric literal — pass through as-is
            if let Ok(number) = elem.parse::<f64>() {
                if !number.is_finite() {
                    return Err("Array numeric literal must be finite".into());
                }
                return Ok(elem.to_string());
            }

            // Boolean literal — pass through as-is
            if elem.parse::<bool>().is_ok() {
                return Ok(elem.to_string());
            }

            // Single-quoted string — strip outer quotes, re-escape internals, re-wrap.
            if elem.starts_with('\'') && elem.ends_with('\'') && elem.len() >= 2 {
                let inner = &elem[1..elem.len() - 1];
                let escaped = inner.replace('\'', "''");
                return Ok(format!("'{escaped}'"));
            }

            // Bare unquoted string — escape single quotes and wrap in single quotes.
            Ok(format!("'{}'", elem.replace('\'', "''")))
        })
        .collect();

    Ok(sanitized?.join(", "))
}

fn list_condition_expr(
    column: &str,
    operator: &WhereConfigOperator,
    value: &str,
) -> Result<String, String> {
    let column = quote_identifier(column);
    // Strip surrounding brackets if present to avoid nested arrays
    let inner_value = value
        .trim()
        .strip_prefix('[')
        .and_then(|s| s.strip_suffix(']'))
        .unwrap_or(value);

    // Sanitize each element before interpolating into the SQL ARRAY literal
    let safe_value = sanitize_array_elements(inner_value)?;

    match operator {
        WhereConfigOperator::Contains => {
            Ok(format!("array_has_all({column}, ARRAY[{safe_value}])"))
        }
        WhereConfigOperator::DoesNotContain => {
            Ok(format!("NOT array_has_all({column}, ARRAY[{safe_value}])"))
        }
        WhereConfigOperator::Equal => Ok(format!("{column} = ARRAY[{safe_value}]")),
        WhereConfigOperator::NotEqual => Ok(format!("{column} != ARRAY[{safe_value}]")),
        _ => Err(format!(
            "Operator '{operator}' is not supported for list type columns"
        )),
    }
}

fn scalar_condition_expr(
    column: &str,
    operator: &WhereConfigOperator,
    value: &str,
    column_type: Option<&str>,
) -> Result<String, String> {
    let column = quote_identifier(column);
    let operator_and_value = match operator {
        WhereConfigOperator::Contains => {
            format!("LIKE '%{}%' ESCAPE '\\'", escape_like(value))
        }
        WhereConfigOperator::DoesNotContain => {
            format!("NOT LIKE '%{}%' ESCAPE '\\'", escape_like(value))
        }
        WhereConfigOperator::ILike => {
            format!("ILIKE '%{}%' ESCAPE '\\'", escape_like(value))
        }
        WhereConfigOperator::BeginsWith => {
            format!("LIKE '{}%' ESCAPE '\\'", escape_like(value))
        }
        WhereConfigOperator::DoesNotBeginWith => {
            format!("NOT LIKE '{}%' ESCAPE '\\'", escape_like(value))
        }
        WhereConfigOperator::EndsWith => {
            format!("LIKE '%{}' ESCAPE '\\'", escape_like(value))
        }
        WhereConfigOperator::DoesNotEndWith => {
            format!("NOT LIKE '%{}' ESCAPE '\\'", escape_like(value))
        }
        _ => {
            let formatted = match column_type {
                Some("bool") | Some("boolean") => value
                    .parse::<bool>()
                    .map_err(|_| format!("Invalid boolean literal: {value}"))?
                    .to_string(),
                Some("int") => value
                    .parse::<i64>()
                    .map(|value| value.to_string())
                    .or_else(|_| value.parse::<u64>().map(|value| value.to_string()))
                    .map_err(|_| format!("Invalid integer literal: {value}"))?,
                Some("float") | Some("number") => {
                    let number = value
                        .parse::<f64>()
                        .map_err(|_| format!("Invalid numeric literal: {value}"))?;
                    if !number.is_finite() {
                        return Err("Numeric literal must be finite".into());
                    }
                    number.to_string()
                }
                Some(_) => format!("'{}'", value.replace("'", "''")),
                None => match ValueType::from_string(value.to_owned()) {
                    ValueType::Number(val) => format!("{val}"),
                    ValueType::Boolean(val) => format!("{val}"),
                    ValueType::String(val) => format!("'{}'", val.replace("'", "''")),
                },
            };
            format!("{operator} {formatted}")
        }
    };
    Ok(format!("{column} {operator_and_value}"))
}

pub(crate) fn quote_identifier(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('\'', "''")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

enum ValueType {
    Number(f64),
    String(String),
    Boolean(bool),
}

impl Literal for ValueType {
    fn lit(&self) -> Expr {
        match self {
            ValueType::Number(expr) => lit(*expr),
            ValueType::String(expr) => lit(expr.clone()),
            ValueType::Boolean(expr) => lit(*expr),
        }
    }
}
impl ValueType {
    fn from_string(value: String) -> Self {
        if let Ok(num) = value.parse::<f64>() {
            ValueType::Number(num)
        } else if let Ok(boolean) = value.parse::<bool>() {
            ValueType::Boolean(boolean)
        } else {
            ValueType::String(value)
        }
    }
}

impl Display for ValueType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ValueType::Number(v) => write!(f, "{v}"),
            ValueType::String(v) => write!(f, "{v}"),
            ValueType::Boolean(v) => write!(f, "{v}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::alerts::{WhereConfigOperator, resolve_alert_output_layout};
    use datafusion::prelude::SessionContext;

    const WRAPPED_AGGREGATE_QUERY: &str = r#"
        SELECT
            app,
            ROUND(SUM(cost), 4) AS estimated_spend_usd
        FROM (
            VALUES
                ('Codex', CAST(1.23456 AS DOUBLE)),
                ('Codex', CAST(2.0 AS DOUBLE)),
                ('Claude Code', CAST(4.5 AS DOUBLE))
        ) AS usage(app, cost)
        GROUP BY app
        ORDER BY app
    "#;

    #[tokio::test]
    async fn wrapped_aggregate_is_resolved_by_lineage() {
        let context = SessionContext::new();
        let dataframe = context.sql(WRAPPED_AGGREGATE_QUERY).await.unwrap();
        let plan = dataframe.logical_plan().clone();
        let layout = resolve_alert_output_layout(&plan).unwrap();

        assert_eq!(layout.measure_index, 1);
        assert_eq!(layout.measure_name, "estimated_spend_usd");
        assert_eq!(layout.dimension_indices, [0]);

        let result = extract_group_results(dataframe.collect().await.unwrap(), plan).unwrap();
        assert!(!result.is_simple_query);
        assert_eq!(result.groups.len(), 2);
        assert_eq!(result.groups[0].group_values["app"], "Claude Code");
        assert_eq!(result.groups[0].aggregate_value, 4.5);
        assert_eq!(result.groups[1].group_values["app"], "Codex");
        assert!((result.groups[1].aggregate_value - 3.2346).abs() < f64::EPSILON);
    }

    #[tokio::test]
    async fn wrapped_aggregate_uses_final_alias_for_remote_results() {
        let context = SessionContext::new();
        let plan = context
            .state()
            .create_logical_plan(WRAPPED_AGGREGATE_QUERY)
            .await
            .unwrap();
        let result = convert_result_to_group_results(
            serde_json::json!([
                {"app": "Codex", "estimated_spend_usd": 3.2346}
            ]),
            plan,
        )
        .unwrap();

        assert_eq!(result.groups[0].group_values["app"], "Codex");
        assert_eq!(result.groups[0].aggregate_value, 3.2346);
    }

    #[tokio::test]
    async fn remote_string_dimensions_are_not_json_escaped() {
        let context = SessionContext::new();
        let plan = context
            .state()
            .create_logical_plan(WRAPPED_AGGREGATE_QUERY)
            .await
            .unwrap();
        let app = r#"he said "hi" at C:\temp"#;
        let result = convert_result_to_group_results(
            serde_json::json!([
                {"app": app, "estimated_spend_usd": 3.2346}
            ]),
            plan,
        )
        .unwrap();

        assert_eq!(result.groups[0].group_values["app"], app);
    }

    #[tokio::test]
    async fn aggregate_lineage_survives_nested_scalar_expressions() {
        let context = SessionContext::new();
        let plan = context
            .state()
            .create_logical_plan(
                r#"
                    SELECT
                        app,
                        CAST(
                            CASE
                                WHEN SUM(cost) > 0
                                THEN ABS(SUM(cost) * 2) + 1
                                ELSE 0
                            END
                            AS DOUBLE
                        ) AS score
                    FROM (
                        VALUES ('Codex', CAST(1.0 AS DOUBLE))
                    ) AS usage(app, cost)
                    GROUP BY app
                "#,
            )
            .await
            .unwrap();

        let layout = resolve_alert_output_layout(&plan).unwrap();
        assert_eq!(layout.measure_name, "score");
        assert_eq!(layout.dimension_indices, [0]);
    }

    #[tokio::test]
    async fn rollup_internal_grouping_id_is_not_a_measure() {
        let context = SessionContext::new();
        let plan = context
            .state()
            .create_logical_plan(
                r#"
                    SELECT
                        region,
                        app,
                        ROUND(SUM(cost), 2) AS spend
                    FROM (
                        VALUES ('us-east', 'Codex', CAST(1.0 AS DOUBLE))
                    ) AS usage(region, app, cost)
                    GROUP BY ROLLUP(region, app)
                "#,
            )
            .await
            .unwrap();

        let layout = resolve_alert_output_layout(&plan).unwrap();
        assert_eq!(layout.measure_name, "spend");
        assert_eq!(layout.dimension_indices, [0, 1]);
    }

    #[tokio::test]
    async fn multiple_aggregate_derived_outputs_are_rejected() {
        let context = SessionContext::new();
        let plan = context
            .state()
            .create_logical_plan(
                r#"
                    SELECT
                        app,
                        SUM(cost) AS raw_spend,
                        ROUND(SUM(cost), 2) AS rounded_spend
                    FROM (
                        VALUES ('Codex', CAST(1.0 AS DOUBLE))
                    ) AS usage(app, cost)
                    GROUP BY app
                "#,
            )
            .await
            .unwrap();

        let error = resolve_alert_output_layout(&plan).unwrap_err();
        assert!(error.to_string().contains("found 2"));
    }

    // -------------------------------------------------------------------------
    // sanitize_array_elements — happy-path cases
    // -------------------------------------------------------------------------

    #[tokio::test]
    async fn rejected_mutation_serializes_with_query_apply_without_invalidating_result() {
        use super::super::promql_alerts::{forget_lifecycle, lifecycle, lock_lifecycle};
        let id = ulid::Ulid::new();
        let shared = lifecycle(id);
        let observed = *shared.lock().await;
        // The edit is still validating and holds the same guard used by apply.
        let rejected_edit = lock_lifecycle(id).await;
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let mut completion = tokio::spawn(async move {
            let _ = ready_tx.send(());
            let generation = shared.lock().await;
            sql_result_is_current(*generation, observed, Some(AlertState::NotTriggered))
        });
        ready_rx.await.unwrap();
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(10), &mut completion)
                .await
                .is_err()
        );
        // Authorization/validation rejects the edit: no successful mutation.
        drop(rejected_edit);
        assert!(
            tokio::time::timeout(std::time::Duration::from_secs(1), completion)
                .await
                .unwrap()
                .unwrap()
        );
        assert_eq!(*lock_lifecycle(id).await, observed);
        forget_lifecycle(id);
    }

    #[test]
    fn sql_runtime_uses_state_write_for_success_and_persists_only_changed_errors() {
        let success = serde_json::json!({"health":"ok","error":null,"lastEvaluatedAt":"now"});
        let error =
            serde_json::json!({"health":"error","error":"denied","lastEvaluatedAt":"earlier"});
        assert!(!sql_error_needs_persistence(None, &success, false));
        assert!(!sql_error_needs_persistence(Some(&error), &success, false));
        assert!(sql_error_needs_persistence(None, &error, true));
        assert!(sql_error_needs_persistence(Some(&success), &error, true));
        let later = serde_json::json!({"health":"error","error":"denied","lastEvaluatedAt":"now"});
        assert!(!sql_error_needs_persistence(Some(&error), &later, true));
        let changed =
            serde_json::json!({"health":"error","error":"different error","lastEvaluatedAt":"now"});
        assert!(sql_error_needs_persistence(Some(&error), &changed, true));
    }

    #[test]
    fn sql_recovery_backoff_is_bounded_and_does_not_exhaust() {
        assert_eq!(
            (1..=7).map(sql_retry_delay).collect::<Vec<_>>(),
            [1, 2, 4, 8, 16, 30, 30]
        );
        assert_eq!(sql_retry_delay(u32::MAX), 30);
    }

    #[tokio::test]
    async fn sql_in_flight_result_is_discarded_after_disable_edit_or_deletion() {
        use super::super::promql_alerts::{
            forget_lifecycle, lifecycle, lock_lifecycle, mark_lifecycle_changed,
        };
        for final_state in [
            Some(AlertState::Disabled),
            Some(AlertState::NotTriggered),
            None,
        ] {
            let id = ulid::Ulid::new();
            let lifecycle = lifecycle(id);
            let observed = *lifecycle.lock().await;
            // Represents the mutation completing while the query has released its lock.
            let mut changed = lock_lifecycle(id).await;
            mark_lifecycle_changed(&mut changed);
            assert!(!sql_result_is_current(*changed, observed, final_state));
            drop(changed);
            forget_lifecycle(id);
        }
        assert!(!sql_result_is_current(0, 0, Some(AlertState::Disabled)));
        assert!(!sql_result_is_current(0, 0, None));
        assert!(sql_result_is_current(0, 0, Some(AlertState::Triggered)));
    }

    #[test]
    fn test_sanitize_numeric_elements() {
        assert_eq!(sanitize_array_elements("1, 2, 3").unwrap(), "1, 2, 3");
        assert_eq!(sanitize_array_elements("3.14, 2.71").unwrap(), "3.14, 2.71");
    }

    #[test]
    fn test_sanitize_boolean_elements() {
        assert_eq!(
            sanitize_array_elements("true, false").unwrap(),
            "true, false"
        );
    }

    #[test]
    fn test_sanitize_bare_string_elements() {
        assert_eq!(sanitize_array_elements("foo").unwrap(), "'foo'");
        assert_eq!(sanitize_array_elements("foo, bar").unwrap(), "'foo', 'bar'");
    }

    #[test]
    fn test_sanitize_pre_quoted_string_elements() {
        assert_eq!(sanitize_array_elements("'hello'").unwrap(), "'hello'");
    }

    #[test]
    fn test_sanitize_mixed_elements() {
        assert_eq!(
            sanitize_array_elements("42, foo, 3.14").unwrap(),
            "42, 'foo', 3.14"
        );
    }

    // -------------------------------------------------------------------------
    // sanitize_array_elements — quote-aware comma splitting
    // -------------------------------------------------------------------------

    #[test]
    fn test_sanitize_quoted_string_with_comma() {
        let result = sanitize_array_elements("'New York, NY'").unwrap();
        assert_eq!(result, "'New York, NY'");
    }

    #[test]
    fn test_sanitize_quoted_string_with_comma_mixed() {
        let result = sanitize_array_elements("'New York, NY', 42").unwrap();
        assert_eq!(result, "'New York, NY', 42");
    }

    #[test]
    fn test_sanitize_quoted_string_with_comma_and_escaped_quote() {
        let result = sanitize_array_elements("'it''s here, really'").unwrap();
        assert_eq!(result, "'it''''s here, really'");
    }

    #[test]
    fn test_sanitize_multiple_quoted_with_commas() {
        let result = sanitize_array_elements("'hello, world', 'foo, bar'").unwrap();
        assert_eq!(result, "'hello, world', 'foo, bar'");
    }

    #[test]
    fn test_sanitize_unterminated_quote_returns_error() {
        let result = sanitize_array_elements("'unterminated");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Unterminated"));
    }

    // -------------------------------------------------------------------------
    // sanitize_array_elements — single-quote injection
    // -------------------------------------------------------------------------

    #[test]
    fn test_sanitize_bare_string_with_single_quote_injection() {
        let input = "foo' OR '1'='1";
        let result = sanitize_array_elements(input).unwrap();
        assert_eq!(result, "'foo'' OR ''1''=''1'");
    }

    #[test]
    fn test_sanitize_pre_quoted_string_with_internal_single_quote() {
        let input = "'it''s fine'";
        let result = sanitize_array_elements(input).unwrap();
        assert_eq!(result, "'it''''s fine'");
    }

    // -------------------------------------------------------------------------
    // sanitize_array_elements — bracket injection (primary guard)
    // -------------------------------------------------------------------------

    #[test]
    fn test_sanitize_rejects_element_with_open_bracket() {
        let result = sanitize_array_elements("foo[bar");
        assert!(result.is_err(), "Expected Err for element containing '['");
        assert!(result.unwrap_err().contains("bracket characters"));
    }

    #[test]
    fn test_sanitize_rejects_element_with_close_bracket() {
        let result = sanitize_array_elements("foo]bar");
        assert!(result.is_err(), "Expected Err for element containing ']'");
    }

    #[test]
    fn test_sanitize_rejects_injection_via_brackets() {
        let malicious = "1] OR 1=1 --";
        let result = sanitize_array_elements(malicious);
        assert!(
            result.is_err(),
            "Bracket injection attempt should be rejected"
        );
    }

    // -------------------------------------------------------------------------
    // list_condition_expr — output shape
    // -------------------------------------------------------------------------

    #[test]
    fn test_list_condition_expr_contains_numeric() {
        let result =
            list_condition_expr("tags", &WhereConfigOperator::Contains, "1, 2, 3").unwrap();
        assert_eq!(result, "array_has_all(\"tags\", ARRAY[1, 2, 3])");
    }

    #[test]
    fn test_list_condition_expr_contains_strings() {
        let result =
            list_condition_expr("tags", &WhereConfigOperator::Contains, "foo, bar").unwrap();
        assert_eq!(result, "array_has_all(\"tags\", ARRAY['foo', 'bar'])");
    }

    #[test]
    fn test_list_condition_expr_strips_outer_brackets() {
        let result = list_condition_expr("tags", &WhereConfigOperator::Equal, "[1, 2]").unwrap();
        assert_eq!(result, "\"tags\" = ARRAY[1, 2]");
    }

    #[test]
    fn test_list_condition_expr_does_not_contain() {
        let result =
            list_condition_expr("tags", &WhereConfigOperator::DoesNotContain, "foo").unwrap();
        assert_eq!(result, "NOT array_has_all(\"tags\", ARRAY['foo'])");
    }

    #[test]
    fn test_list_condition_expr_not_equal() {
        let result = list_condition_expr("tags", &WhereConfigOperator::NotEqual, "42").unwrap();
        assert_eq!(result, "\"tags\" != ARRAY[42]");
    }

    #[test]
    fn test_list_condition_expr_quoted_element_with_comma() {
        let result =
            list_condition_expr("cities", &WhereConfigOperator::Contains, "'New York, NY'")
                .unwrap();
        assert_eq!(result, "array_has_all(\"cities\", ARRAY['New York, NY'])");
    }

    #[test]
    fn test_list_condition_expr_rejects_injection() {
        let result = list_condition_expr("tags", &WhereConfigOperator::Contains, "1] OR 1=1 --");
        assert!(
            result.is_err(),
            "Injection via bracket characters must be rejected"
        );
    }

    #[test]
    fn test_list_condition_expr_unsupported_operator() {
        let result = list_condition_expr("tags", &WhereConfigOperator::GreaterThan, "1");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not supported"));
    }

    #[test]
    fn condition_columns_are_quoted_as_identifiers() {
        let scalar = scalar_condition_expr(
            "name\" OR 1=1 --",
            &WhereConfigOperator::Equal,
            "alice",
            Some("string"),
        )
        .unwrap();
        assert_eq!(scalar, "\"name\"\" OR 1=1 --\" = 'alice'");

        let list = list_condition_expr("tags\" OR 1=1 --", &WhereConfigOperator::Contains, "admin")
            .unwrap();
        assert_eq!(
            list,
            "array_has_all(\"tags\"\" OR 1=1 --\", ARRAY['admin'])"
        );
    }
}
