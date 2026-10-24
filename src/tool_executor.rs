use std::{collections::HashMap, ops::ControlFlow};

use actix_web::{HttpRequest, HttpResponse, body::to_bytes_limited, http::header::HeaderMap, web};
use chrono::{DateTime, Duration, LocalResult, TimeZone, Utc};
use chrono_tz::Tz;
use futures::{StreamExt, stream};
use serde_json::{Value, json};
use ulid::Ulid;

use crate::{
    datafusion::sql::{
        parser::{DFParser, Statement as DFStatement},
        sqlparser::ast::{
            DataType as SqlDataType, Expr as SqlExpr, SelectItem, SetExpr,
            Statement as SqlStatement, visit_expressions,
        },
    },
    handlers::http::{
        alerts, cluster, health_check, logstream,
        modal::query::querier_logstream,
        query,
        query_context::{self, LogContextRequest},
        rbac, role, targets,
        users::{dashboards, filters},
    },
    parseable::PARSEABLE,
    prism::logstream::get_prism_logstream_info,
    rbac::{Response, Users, map::SessionKey, role::Action},
    tool_catalog::{ToolCallRequest, ToolCallResult, oss_tool_specs},
    utils::{
        actix::extract_session_key_from_req,
        get_tenant_id_from_request,
        time::{TimeRange, parse_start_time_expression, parse_time_expression, truncate_to_minute},
    },
};

fn required_string<'a>(arguments: &'a Value, name: &str) -> Result<&'a str, String> {
    arguments
        .get(name)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("missing required string argument `{name}`"))
}

fn bounded_integer(arguments: &Value, name: &str, default: u64, min: u64, max: u64) -> u64 {
    arguments
        .get(name)
        .and_then(Value::as_u64)
        .unwrap_or(default)
        .clamp(min, max)
}

fn quote_identifier(identifier: &str) -> String {
    format!("\"{}\"", identifier.replace('"', "\"\""))
}

fn quote_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

const MAX_TOOL_ROWS: u64 = 500;
const MAX_TOOL_COLUMNS: usize = 10;
const DATASET_DISCOVERY_CONCURRENCY: usize = 8;

pub fn validate_tool_sql(query: &str) -> Result<(), String> {
    let statements =
        DFParser::parse_sql(query.trim()).map_err(|error| format!("invalid SQL: {error}"))?;
    if statements.len() != 1 {
        return Err("exactly one SQL statement is required".to_owned());
    }
    let Some(DFStatement::Statement(statement)) = statements.front() else {
        return Err("only SQL SELECT queries are allowed".to_owned());
    };
    let SqlStatement::Query(query) = statement.as_ref() else {
        return Err("only SQL SELECT queries are allowed".to_owned());
    };
    let unsupported_cast = match visit_expressions(query, |expression| {
        let SqlExpr::Cast { data_type, .. } = expression else {
            return ControlFlow::Continue(());
        };
        let replacement = match data_type {
            SqlDataType::Int64 | SqlDataType::UInt64 => "BIGINT",
            SqlDataType::Float64 => "DOUBLE",
            _ => return ControlFlow::Continue(()),
        };
        ControlFlow::Break((data_type.to_string(), replacement))
    }) {
        ControlFlow::Break(unsupported) => Some(unsupported),
        ControlFlow::Continue(()) => None,
    };
    if let Some((unsupported, replacement)) = unsupported_cast {
        return Err(format!(
            "unsupported DataFusion SQL cast type `{unsupported}`; use `{replacement}` instead"
        ));
    }
    fn validate_projection(body: &SetExpr) -> Result<(), String> {
        match body {
            SetExpr::Select(select) => {
                if select.projection.len() > MAX_TOOL_COLUMNS {
                    return Err(format!(
                        "query selects {} columns; the tool limit is {MAX_TOOL_COLUMNS}",
                        select.projection.len()
                    ));
                }
                if select.projection.iter().any(|item| {
                    matches!(
                        item,
                        SelectItem::Wildcard(_) | SelectItem::QualifiedWildcard(_, _)
                    )
                }) {
                    return Err(format!(
                        "wildcard selection is not allowed; select at most {MAX_TOOL_COLUMNS} explicit columns"
                    ));
                }
                Ok(())
            }
            SetExpr::Query(query) => validate_projection(query.body.as_ref()),
            SetExpr::SetOperation { left, right, .. } => {
                validate_projection(left)?;
                validate_projection(right)
            }
            _ => Err("unsupported SQL query form".to_owned()),
        }
    }
    validate_projection(query.body.as_ref())
}

pub fn bounded_tool_sql(query: &str) -> Result<String, String> {
    validate_tool_sql(query)?;
    Ok(format!(
        "SELECT * FROM ({}\n) AS \"__parseable_tool_result\" LIMIT {MAX_TOOL_ROWS}",
        query.trim().trim_end_matches(';')
    ))
}

pub fn enforce_tool_tabular_limits(mut value: Value) -> Result<Value, String> {
    let rows = match &mut value {
        Value::Array(rows) => rows,
        Value::Object(object) => object
            .get_mut("records")
            .and_then(Value::as_array_mut)
            .ok_or_else(|| "query response is not tabular".to_owned())?,
        _ => return Err("query response is not tabular".to_owned()),
    };
    rows.truncate(MAX_TOOL_ROWS as usize);
    if let Some(column_count) = rows
        .iter()
        .filter_map(Value::as_object)
        .map(serde_json::Map::len)
        .max()
        && column_count > MAX_TOOL_COLUMNS
    {
        return Err(format!(
            "query selected {column_count} columns; the tool limit is {MAX_TOOL_COLUMNS}"
        ));
    }
    Ok(value)
}

fn bounded_select(query: &str) -> Result<String, String> {
    bounded_tool_sql(query)
}

fn visible_datasets(tenant_id: &Option<String>, session_key: &SessionKey) -> Vec<String> {
    let internal_datasets = PARSEABLE
        .streams
        .list_internal_streams(tenant_id)
        .into_iter()
        .collect::<std::collections::HashSet<_>>();
    let mut datasets = PARSEABLE
        .streams
        .list(tenant_id)
        .into_iter()
        .filter(|dataset| !internal_datasets.contains(dataset))
        .filter(|dataset| {
            Users.authorize(session_key.clone(), Action::ListStream, Some(dataset), None)
                == Response::Authorized
        })
        .collect::<Vec<_>>();
    datasets.sort_unstable();
    datasets
}

async fn visible_dataset_catalog(
    tenant_id: &Option<String>,
    session_key: &SessionKey,
) -> Vec<Value> {
    let mut catalog = Vec::new();
    for name in visible_datasets(tenant_id, session_key) {
        let telemetry_type = if PARSEABLE.check_or_load_stream(&name, tenant_id).await {
            PARSEABLE
                .get_stream(&name, tenant_id)
                .ok()
                .and_then(|stream| {
                    stream
                        .metadata
                        .read()
                        .ok()
                        .map(|metadata| metadata.telemetry_type.to_string())
                })
        } else {
            None
        };
        catalog.push(json!({
            "name": name,
            "telemetryType": telemetry_type,
        }));
    }
    catalog
}

fn resolve_time_range(arguments: &Value) -> Result<Value, String> {
    resolve_time_range_at(arguments, Utc::now())
}

pub fn resolve_time_range_at(arguments: &Value, reference: DateTime<Utc>) -> Result<Value, String> {
    let expression = required_string(arguments, "expression")?;
    let timezone_name = arguments
        .get("timezone")
        .and_then(Value::as_str)
        .unwrap_or("UTC");
    let timezone = timezone_name
        .parse::<Tz>()
        .map_err(|_| format!("invalid IANA timezone `{timezone_name}`"))?;
    let normalized = expression.trim().to_ascii_lowercase();
    let range = if normalized == "today" || normalized == "yesterday" {
        let date = reference.with_timezone(&timezone).date_naive()
            - Duration::days(i64::from(normalized == "yesterday"));
        let local_start = date
            .and_hms_opt(0, 0, 0)
            .ok_or_else(|| "could not construct local day boundary".to_owned())?;
        let start = match timezone.from_local_datetime(&local_start) {
            LocalResult::Single(start) | LocalResult::Ambiguous(start, _) => {
                start.with_timezone(&Utc)
            }
            LocalResult::None => return Err("local day boundary does not exist".to_owned()),
        };
        let end = if normalized == "today" {
            reference
        } else {
            let next_local_start = (date + Duration::days(1))
                .and_hms_opt(0, 0, 0)
                .ok_or_else(|| "could not construct local day boundary".to_owned())?;
            match timezone.from_local_datetime(&next_local_start) {
                LocalResult::Single(end) | LocalResult::Ambiguous(end, _) => {
                    end.with_timezone(&Utc)
                }
                LocalResult::None => return Err("local day boundary does not exist".to_owned()),
            }
        };
        TimeRange::new(start, end)
    } else if let Some(duration) = normalized
        .strip_prefix("last ")
        .or_else(|| normalized.strip_prefix("past "))
        .or_else(|| normalized.strip_prefix("now-"))
    {
        let duration = duration.trim();
        let duration_with_quantity =
            (!duration.chars().any(|character| character.is_ascii_digit())).then(|| {
                let unit = duration
                    .strip_prefix("an ")
                    .or_else(|| duration.strip_prefix("a "))
                    .unwrap_or(duration);
                format!("1 {unit}")
            });
        let duration = duration_with_quantity.as_deref().unwrap_or(duration);
        let duration = humantime::parse_duration(duration)
            .map_err(|error| format!("invalid time duration: {error}"))?;
        let duration = Duration::from_std(duration)
            .map_err(|error| format!("time duration is too large: {error}"))?;
        let start = reference
            .checked_sub_signed(duration)
            .ok_or_else(|| "time duration is too large".to_owned())?;
        TimeRange::new(start, reference)
    } else if let Some((start, end)) = expression.split_once(" to ") {
        TimeRange::parse_human_time(start.trim(), end.trim()).map_err(|error| error.to_string())?
    } else if DateTime::parse_from_rfc3339(expression).is_ok() {
        TimeRange::parse_human_time(expression, &reference.to_rfc3339())
            .map_err(|error| error.to_string())?
    } else {
        TimeRange::parse_human_time(expression, "now").map_err(|error| error.to_string())?
    };
    Ok(json!({
        "expression": expression,
        "timezone": timezone_name,
        "startTime": range.start.to_rfc3339(),
        "endTime": range.end.to_rfc3339(),
    }))
}

fn nested_string<'a>(value: &'a Value, name: &str) -> Option<&'a str> {
    match value {
        Value::Object(object) => object
            .get(name)
            .and_then(Value::as_str)
            .or_else(|| object.values().find_map(|value| nested_string(value, name))),
        Value::Array(array) => array.iter().find_map(|value| nested_string(value, name)),
        _ => None,
    }
}

async fn response_value(response: HttpResponse) -> Result<Value, String> {
    let status = response.status();
    let bytes = to_bytes_limited(response.into_body(), 1024 * 1024)
        .await
        .map_err(|error| format!("tool response body error: {error:?}"))?
        .map_err(|error| format!("tool response exceeded 1 MiB: {error}"))?;
    let value = serde_json::from_slice(&bytes)
        .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into_owned()));
    if status.is_success() {
        Ok(value)
    } else {
        Err(format!("handler returned HTTP {status}: {value}"))
    }
}

fn authorize(
    session_key: &SessionKey,
    action: Action,
    resource: Option<&str>,
    user: Option<&str>,
) -> Result<(), String> {
    if !Users.session_exists(session_key) {
        return Err(
            "Your session has expired or is no longer valid. Please re-authenticate to access this resource."
                .to_owned(),
        );
    }
    match Users.authorize(session_key.clone(), action, resource, user) {
        Response::Authorized => Ok(()),
        Response::Suspended(message) => Err(message),
        Response::UnAuthorized | Response::ReloadRequired => {
            Err(format!("Caller is not authorized to perform {action:?}"))
        }
    }
}

fn dataset_matches_telemetry_type(dataset: &Value, expected: Option<&str>) -> bool {
    expected.is_none_or(|expected| {
        dataset
            .get("telemetryType")
            .and_then(Value::as_str)
            .is_some_and(|actual| actual.eq_ignore_ascii_case(expected))
    })
}

/// Whether `name` occurs in `query` as a whole token. Dataset names may contain
/// `-` and `_`, so those count as part of a name rather than as boundaries.
fn query_mentions_dataset_name(query: &str, name: &str) -> bool {
    let is_name_character =
        |character: char| character.is_ascii_alphanumeric() || character == '_' || character == '-';
    !name.is_empty()
        && query.match_indices(name).any(|(start, matched)| {
            !query[..start]
                .chars()
                .next_back()
                .is_some_and(is_name_character)
                && !query[start + matched.len()..]
                    .chars()
                    .next()
                    .is_some_and(is_name_character)
        })
}

pub fn resolve_dataset_candidates(payload: Value, arguments: &Value) -> Value {
    let query = arguments
        .get("query")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    let limit = bounded_integer(arguments, "limit", 5, 1, 20) as usize;
    let Some(datasets) = payload.as_array() else {
        return payload;
    };
    let telemetry_type = arguments
        .get("telemetryType")
        .and_then(Value::as_str)
        .map(str::to_ascii_lowercase);

    let requested_dataset = arguments
        .get("selectedDataset")
        .or_else(|| arguments.get("contextDataset"))
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty());
    if let Some(requested_dataset) = requested_dataset {
        // Dataset names are case-sensitive: prefer an exact match and fall
        // back to a case-insensitive match only when it is unique.
        fn dataset_name(dataset: &Value) -> Option<&str> {
            dataset.get("name").and_then(Value::as_str)
        }
        let exact = datasets
            .iter()
            .find(|dataset| dataset_name(dataset) == Some(requested_dataset));
        let case_insensitive = datasets
            .iter()
            .filter(|dataset| {
                dataset_name(dataset)
                    .is_some_and(|name| name.eq_ignore_ascii_case(requested_dataset))
            })
            .collect::<Vec<_>>();
        let selected = match (exact, case_insensitive.as_slice()) {
            (Some(dataset), _) => Some(dataset),
            (None, [dataset]) => Some(*dataset),
            (None, []) => None,
            (None, matches) => {
                return json!({
                    "status": "ambiguous",
                    "datasets": [],
                    "candidates": matches
                        .iter()
                        .map(|dataset| json!({
                            "name": dataset_name(dataset),
                            "reasons": ["case-insensitive dataset name match"],
                            "dataset": dataset,
                        }))
                        .collect::<Vec<_>>(),
                    "message": format!(
                        "Dataset `{requested_dataset}` matches several caller-visible datasets that differ only in case. Call resolve_dataset again with the exact dataset name."
                    ),
                });
            }
        };
        return match selected {
            Some(dataset) if dataset_matches_telemetry_type(dataset, telemetry_type.as_deref()) => {
                json!({
                "status": "resolved",
                "datasets": [dataset],
                "selectedDatasets": [dataset.get("name").and_then(Value::as_str).unwrap_or(requested_dataset)],
                "confidence": 1.0,
                "reason": if arguments.get("selectedDataset").is_some() {
                    "explicit candidate selection validated against caller-visible datasets"
                } else {
                    "trusted page-context dataset validated against caller-visible datasets"
                }
                })
            }
            Some(_) => json!({
                "status": "not_found",
                "datasets": [],
                "message": format!(
                    "Dataset `{requested_dataset}` does not match requested telemetry type `{}`",
                    telemetry_type.as_deref().unwrap_or_default()
                ),
            }),
            None => json!({
                "status": "error",
                "message": format!("Dataset `{requested_dataset}` is not visible to this caller"),
            }),
        };
    }

    if datasets.len() == 1 {
        let dataset = &datasets[0];
        if !dataset_matches_telemetry_type(dataset, telemetry_type.as_deref()) {
            return json!({
                "status": "not_found",
                "datasets": [],
                "message": format!(
                    "The only caller-visible dataset does not match requested telemetry type `{}`",
                    telemetry_type.as_deref().unwrap_or_default()
                ),
            });
        }
        return json!({
            "status": "resolved",
            "datasets": [dataset],
            "selectedDatasets": [dataset.get("name").and_then(Value::as_str).unwrap_or_default()],
            "confidence": 1.0,
            "reason": "only caller-visible dataset"
        });
    }

    let terms = query
        .split(|character: char| !character.is_ascii_alphanumeric() && character != '_')
        .filter(|term| term.len() > 2)
        .collect::<Vec<_>>();
    let mut scored = datasets
        .iter()
        .filter_map(|dataset| {
            let original_name = dataset.get("name")?.as_str()?;
            if !dataset_matches_telemetry_type(dataset, telemetry_type.as_deref()) {
                return None;
            }
            let name = original_name.to_ascii_lowercase();
            let mut score = 0_u64;
            let mut reasons = Vec::new();
            if !query.is_empty() && name == query {
                score += 1_000;
                reasons.push("exact dataset name");
            } else if !query.is_empty() && query_mentions_dataset_name(&query, &name) {
                score += 750;
                reasons.push("dataset name explicitly mentioned in the question");
            } else if !query.is_empty() && name.contains(&query) {
                score += 500;
                reasons.push("query matches the dataset name");
            }
            let term_matches = terms.iter().filter(|term| name.contains(**term)).count() as u64;
            if term_matches > 0 {
                score += term_matches * 25;
                reasons.push("dataset-name token match");
            }
            if telemetry_type.is_some() {
                score += 15;
                reasons.push("telemetry type match");
            }
            Some((score, original_name.to_owned(), reasons, dataset.clone()))
        })
        .collect::<Vec<_>>();
    scored.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| left.1.cmp(&right.1)));

    if let Some((score, name, _, dataset)) = scored.first()
        && *score >= 500
        && scored.get(1).is_none_or(|second| *score > second.0)
    {
        return json!({
            "status": "resolved",
            "datasets": [dataset],
            "selectedDatasets": [name],
            "confidence": 0.95,
            "reason": "unique exact dataset-name match"
        });
    }

    let candidates = scored
        .into_iter()
        .take(limit)
        .map(|(score, name, reasons, dataset)| {
            json!({
                "name": name,
                "score": score,
                "reasons": reasons,
                "dataset": dataset,
            })
        })
        .collect::<Vec<_>>();
    json!({
        "status": if candidates.is_empty() { "not_found" } else { "ambiguous" },
        "datasets": [],
        "candidates": candidates,
        "query": query,
        "message": if datasets.is_empty() {
            "No caller-visible datasets were found.".to_owned()
        } else if candidates.is_empty() {
            match telemetry_type.as_deref() {
                Some(telemetry_type) => format!(
                    "No caller-visible datasets match requested telemetry type `{telemetry_type}`."
                ),
                None => "No caller-visible datasets match the request.".to_owned(),
            }
        } else {
            "Dataset resolution is ambiguous. Inspect candidate schemas, then call resolve_dataset again with selectedDataset.".to_owned()
        }
    })
}

#[derive(Clone, Copy)]
struct OssToolContext<'a> {
    session_key: &'a SessionKey,
    tenant_id: &'a Option<String>,
    query_headers: &'a HeaderMap,
}

async fn execute_dataset_resolution_tool(
    name: &str,
    arguments: &Value,
    context: OssToolContext<'_>,
) -> Result<Value, String> {
    match name {
        "list_datasets" => Ok(visible_datasets(context.tenant_id, context.session_key)
            .into_iter()
            .map(|name| json!({ "name": name }))
            .collect()),
        "resolve_dataset" => {
            let datasets = visible_dataset_catalog(context.tenant_id, context.session_key).await;
            Ok(resolve_dataset_candidates(
                Value::Array(datasets),
                arguments,
            ))
        }
        "resolve_time_range" => resolve_time_range(arguments),
        _ => unreachable!("dataset resolution dispatcher only receives known tools"),
    }
}

enum DatasetActivity {
    Skipped,
    Count { name: String, events: u64 },
    Error { name: String, message: String },
}

async fn discover_datasets(
    arguments: &Value,
    context: OssToolContext<'_>,
) -> Result<Value, String> {
    let start_time = required_string(arguments, "startTime")?.to_owned();
    let end_time = required_string(arguments, "endTime")?.to_owned();
    TimeRange::parse_human_time(&start_time, &end_time).map_err(|error| error.to_string())?;
    let telemetry_type = required_string(arguments, "telemetryType")?.to_ascii_lowercase();
    if !matches!(telemetry_type.as_str(), "logs" | "metrics" | "traces") {
        return Err("telemetryType must be logs, metrics, or traces".to_owned());
    }
    let limit = bounded_integer(arguments, "limit", 50, 1, 500) as usize;
    let datasets = visible_datasets(context.tenant_id, context.session_key);
    let visible_datasets = datasets.len();

    let activity = stream::iter(datasets)
        .map(|name| {
            let start_time = start_time.clone();
            let end_time = end_time.clone();
            let telemetry_type = telemetry_type.clone();
            async move {
                if Users.authorize(
                    context.session_key.clone(),
                    Action::Query,
                    Some(&name),
                    None,
                ) != Response::Authorized
                {
                    return DatasetActivity::Skipped;
                }
                if !PARSEABLE
                    .check_or_load_stream(&name, context.tenant_id)
                    .await
                {
                    return DatasetActivity::Error {
                        name,
                        message: "dataset metadata is unavailable".to_owned(),
                    };
                }
                let actual_telemetry_type = match PARSEABLE.get_stream(&name, context.tenant_id) {
                    Ok(stream) => match stream.metadata.read() {
                        Ok(metadata) => metadata.telemetry_type.to_string(),
                        Err(error) => {
                            return DatasetActivity::Error {
                                name,
                                message: error.to_string(),
                            };
                        }
                    },
                    Err(error) => {
                        return DatasetActivity::Error {
                            name,
                            message: error.to_string(),
                        };
                    }
                };
                if actual_telemetry_type != telemetry_type {
                    return DatasetActivity::Skipped;
                }

                let request = crate::query::CountsRequest {
                    stream: name.clone(),
                    start_time,
                    end_time,
                    num_bins: Some(1),
                    conditions: None,
                };
                match request.get_bin_density(context.tenant_id).await {
                    Ok(counts) => DatasetActivity::Count {
                        name,
                        events: counts.into_iter().map(|record| record.count).sum(),
                    },
                    Err(error) => DatasetActivity::Error {
                        name,
                        message: error.to_string(),
                    },
                }
            }
        })
        .buffer_unordered(DATASET_DISCOVERY_CONCURRENCY)
        .collect::<Vec<_>>()
        .await;

    Ok(summarize_dataset_activity(
        activity,
        limit,
        visible_datasets,
        &telemetry_type,
        &start_time,
        &end_time,
    ))
}

/// Builds the `discover_datasets` result from per-dataset activity.
fn summarize_dataset_activity(
    activity: Vec<DatasetActivity>,
    limit: usize,
    visible_datasets: usize,
    telemetry_type: &str,
    start_time: &str,
    end_time: &str,
) -> Value {
    let mut active = Vec::new();
    let mut queried_datasets = 0_usize;
    let mut errors = Vec::new();
    for result in activity {
        match result {
            DatasetActivity::Skipped => {}
            DatasetActivity::Count { name, events } => {
                queried_datasets += 1;
                if events > 0 {
                    active.push((name, events));
                }
            }
            DatasetActivity::Error { name, message } => {
                errors.push(json!({ "name": name, "message": message }));
            }
        }
    }
    active.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| left.0.cmp(&right.0)));
    let unavailable_datasets = errors.len();

    if active.is_empty() && !errors.is_empty() {
        tracing::warn!(
            telemetry_type,
            visible_datasets,
            queried_datasets,
            unavailable_datasets,
            "dataset activity discovery was incomplete"
        );
        return json!({
            "status": "error",
            "message": "Dataset activity could not be determined reliably for the requested telemetry type and time range.",
            "telemetryType": telemetry_type,
            "startTime": start_time,
            "endTime": end_time,
            "visibleDatasets": visible_datasets,
            "queriedDatasets": queried_datasets,
            "unavailableDatasets": errors.into_iter().take(20).collect::<Vec<_>>(),
        });
    }

    let active_count = active.len();
    let selected = active
        .into_iter()
        .take(limit)
        .map(|(name, events)| json!({ "name": name, "eventsInRange": events }))
        .collect::<Vec<_>>();
    let selected_names = selected
        .iter()
        .filter_map(|dataset| dataset.get("name").and_then(Value::as_str))
        .collect::<Vec<_>>();
    json!({
        "status": if selected.is_empty() { "not_found" } else { "resolved" },
        "selectionSource": "activity_in_resolved_time_range",
        "telemetryType": telemetry_type,
        "startTime": start_time,
        "endTime": end_time,
        "queriedDatasets": queried_datasets,
        "visibleDatasets": visible_datasets,
        "activeDatasetCount": active_count,
        "truncated": active_count > selected.len(),
        "datasets": selected,
        "selectedDatasets": selected_names,
        "unavailableDatasets": errors.into_iter().take(20).collect::<Vec<_>>(),
    })
}

fn schema_tool_result(schema: &arrow_schema::Schema, arguments: &Value) -> Result<Value, String> {
    match arguments.get("format") {
        None => serde_json::to_value(schema).map_err(|error| error.to_string()),
        Some(Value::String(format)) if format == "json" => {
            serde_json::to_value(schema).map_err(|error| error.to_string())
        }
        Some(Value::String(format)) if format == "compact" => {
            Ok(Value::String(logstream::compact_schema(schema)))
        }
        _ => Err("schema format must be `json` or `compact`".to_owned()),
    }
}

async fn execute_dataset_metadata_tool(
    name: &str,
    arguments: &Value,
    context: OssToolContext<'_>,
) -> Result<Value, String> {
    let dataset = required_string(arguments, "dataset")?;
    match name {
        "get_dataset_schema" => {
            authorize(context.session_key, Action::GetSchema, Some(dataset), None)?;
            let schema = logstream::get_schema_internal(dataset, context.tenant_id)
                .await
                .map_err(|error| error.to_string())?;
            schema_tool_result(&schema, arguments)
        }
        "get_dataset_info" => {
            authorize(
                context.session_key,
                Action::GetStreamInfo,
                Some(dataset),
                None,
            )?;
            serde_json::to_value(
                get_prism_logstream_info(dataset, context.tenant_id)
                    .await
                    .map_err(|error| error.to_string())?,
            )
            .map_err(|error| error.to_string())
        }
        "get_dataset_stats" => {
            authorize(context.session_key, Action::GetStats, Some(dataset), None)?;
            querier_logstream::get_stats_internal(dataset, context.tenant_id, None)
                .await
                .map_err(|error| error.to_string())
        }
        _ => unreachable!("dataset metadata dispatcher only receives known tools"),
    }
}

pub fn sample_events_query(
    arguments: &Value,
    fields: &[String],
    reference: DateTime<Utc>,
) -> Result<query::Query, String> {
    let dataset = required_string(arguments, "dataset")?;
    let limit = bounded_integer(arguments, "limit", 10, 1, 100);
    let (start, end) = match (
        arguments.get("startTime").and_then(Value::as_str),
        arguments.get("endTime").and_then(Value::as_str),
    ) {
        (Some(start), Some(end)) => {
            let range =
                TimeRange::parse_human_time(start, end).map_err(|error| error.to_string())?;
            (range.start, range.end)
        }
        (None, None) => {
            let minutes = bounded_integer(arguments, "minutes", 60, 1, 1440);
            (reference - Duration::minutes(minutes as i64), reference)
        }
        _ => return Err("startTime and endTime must be provided together".to_owned()),
    };
    let preferred = [
        "p_timestamp",
        "service.name",
        "service_name",
        "severity_text",
        "severity_number",
        "body",
        "message",
        "trace_id",
        "span_id",
        "duration_nano",
    ];
    let mut selected = preferred
        .iter()
        .filter(|candidate| fields.iter().any(|field| field == **candidate))
        .map(|field| (*field).to_owned())
        .collect::<Vec<_>>();
    for field in fields {
        if selected.len() >= MAX_TOOL_COLUMNS {
            break;
        }
        if !selected.contains(field) {
            selected.push(field.clone());
        }
    }
    if selected.is_empty() {
        return Err("dataset schema has no fields".to_owned());
    }
    let order = if selected.iter().any(|field| field == "p_timestamp") {
        " ORDER BY \"p_timestamp\" DESC"
    } else {
        ""
    };
    Ok(query::Query {
        query: format!(
            "SELECT {} FROM {}{order} LIMIT {limit}",
            selected
                .iter()
                .map(|field| quote_identifier(field))
                .collect::<Vec<_>>()
                .join(", "),
            quote_identifier(dataset),
        ),
        start_time: start.to_rfc3339(),
        end_time: end.to_rfc3339(),
        send_null: true,
        fields: false,
        streaming: false,
        filter_tags: None,
    })
}

pub async fn dataset_field_names(
    dataset: &str,
    tenant_id: &Option<String>,
) -> Result<Vec<String>, String> {
    let schema = logstream::get_schema_internal(dataset, tenant_id)
        .await
        .map_err(|error| error.to_string())?;
    Ok(schema
        .fields()
        .iter()
        .map(|field| field.name().to_owned())
        .collect())
}

async fn sample_events(arguments: &Value, context: OssToolContext<'_>) -> Result<Value, String> {
    let dataset = required_string(arguments, "dataset")?;
    authorize(context.session_key, Action::Query, Some(dataset), None)?;
    let fields = dataset_field_names(dataset, context.tenant_id).await?;
    let response = query::query_internal(
        sample_events_query(arguments, &fields, Utc::now())?,
        context.session_key,
        context.tenant_id,
    )
    .await
    .map_err(|error| error.to_string())?;
    enforce_tool_tabular_limits(response_value(response).await?)
}

pub fn log_context_request(arguments: &Value) -> Result<Value, String> {
    let dataset = required_string(arguments, "dataset")?;
    let timestamp = required_string(arguments, "pTimestamp")?;
    let mut body = serde_json::Map::from_iter([
        ("dataset".to_owned(), json!(dataset)),
        ("pTimestamp".to_owned(), json!(timestamp)),
    ]);
    let mut match_fields = 0;
    for name in ["log", "body", "message"] {
        if let Some(value) = arguments.get(name).and_then(Value::as_str) {
            body.insert(name.to_owned(), json!(value));
            match_fields += 1;
        }
    }
    if match_fields != 1 {
        return Err(
            "get_log_context requires exactly one exact `log`, `body`, or `message` value from the anchor row"
                .to_owned(),
        );
    }
    for name in ["contextWindow", "contextStartTime", "contextEndTime"] {
        if let Some(value) = arguments.get(name).and_then(Value::as_str) {
            body.insert(name.to_owned(), json!(value));
        }
    }
    if !body.contains_key("contextWindow")
        && !body.contains_key("contextStartTime")
        && !body.contains_key("contextEndTime")
    {
        body.insert("contextWindow".to_owned(), json!("5 minutes"));
    }
    if let Some(conditions) = arguments.get("conditions") {
        body.insert("conditions".to_owned(), conditions.clone());
    }
    body.insert(
        "pageSize".to_owned(),
        json!(bounded_integer(arguments, "pageSize", 100, 1, 500)),
    );
    Ok(Value::Object(body))
}

pub fn project_log_context_result(mut value: Value) -> Value {
    const PREFERRED_FIELDS: [&str; 10] = [
        "p_timestamp",
        "service.name",
        "service_name",
        "severity_text",
        "severity_description",
        "body",
        "message",
        "log",
        "trace_id",
        "span_id",
    ];
    let rows = match &mut value {
        Value::Array(rows) => Some(rows),
        Value::Object(object) => object.get_mut("records").and_then(Value::as_array_mut),
        _ => None,
    };
    if let Some(rows) = rows {
        rows.truncate(MAX_TOOL_ROWS as usize);
        for row in rows {
            let Some(object) = row.as_object_mut() else {
                continue;
            };
            let mut selected = PREFERRED_FIELDS
                .iter()
                .filter(|field| object.contains_key(**field))
                .take(MAX_TOOL_COLUMNS)
                .map(|field| (*field).to_owned())
                .collect::<Vec<_>>();
            for field in object.keys() {
                if selected.len() >= MAX_TOOL_COLUMNS {
                    break;
                }
                if !selected.contains(field) {
                    selected.push(field.clone());
                }
            }
            object.retain(|field, _| selected.contains(field));
        }
    }
    value
}

async fn get_log_context(arguments: &Value, context: OssToolContext<'_>) -> Result<Value, String> {
    let request = serde_json::from_value::<LogContextRequest>(log_context_request(arguments)?)
        .map_err(|error| format!("invalid log context request: {error}"))?;
    let dataset = required_string(arguments, "dataset")?;
    authorize(context.session_key, Action::Query, Some(dataset), None)?;
    query::create_streams_for_distributed(vec![dataset.to_owned()], context.tenant_id)
        .await
        .map_err(|error| error.to_string())?;
    let response = query_context::query_context_for_authorized_dataset(request, context.tenant_id)
        .await
        .map_err(|error| error.to_string())?;
    let response = serde_json::to_value(response).map_err(|error| error.to_string())?;
    Ok(project_log_context_result(response))
}

// Keep the explicit severity policy aligned with frontend/src/lib/errorAnalytics.ts.
// Message text and p_log_category are intentionally not evidence of an error.
const ERROR_SEVERITY_TEXT: &str = "'ERROR', 'ERROR2', 'ERROR3', 'ERROR4', 'ERR', 'FATAL', 'FATAL2', 'FATAL3', 'FATAL4', 'CRITICAL', 'CRIT', 'ALERT', 'EMERG', 'EMERGENCY', 'PANIC', 'SEVERE'";
const LOG_SEVERITY_FIELDS: &[&str] = &[
    "level",
    "log_level",
    "severity",
    "severity_text",
    "severity_description",
];

fn coalesced_log_text(fields: &[String], candidates: &[&str], fallback: &str) -> String {
    let mut expressions = candidates
        .iter()
        .filter(|candidate| fields.iter().any(|field| field == **candidate))
        .map(|field| format!("NULLIF(CAST({} AS VARCHAR), '')", quote_identifier(field)))
        .collect::<Vec<_>>();
    if expressions.is_empty() {
        return fallback.to_owned();
    }
    expressions.push(fallback.to_owned());
    format!("COALESCE({})", expressions.join(", "))
}

fn log_text_severity_predicate(field: &str) -> String {
    let text = format!(
        "UPPER(TRIM(CAST({} AS VARCHAR))) IN ({ERROR_SEVERITY_TEXT})",
        quote_identifier(field),
    );
    if field == "level" {
        // Pino/Bunyan codes only apply to `level`, not OTel severity_number.
        format!("({text} OR TRY_CAST(\"level\" AS DOUBLE) IN (50, 60))")
    } else {
        text
    }
}

pub fn list_log_errors_query(
    dataset: &str,
    fields: &[String],
    limit: u64,
    time_column: &str,
    range: &TimeRange,
) -> Result<String, String> {
    let service = coalesced_log_text(
        fields,
        &["service.name", "service", "service_name"],
        "'unknown'",
    );
    let severity_fields = LOG_SEVERITY_FIELDS
        .iter()
        .filter(|field| fields.iter().any(|candidate| candidate == **field))
        .copied()
        .collect::<Vec<_>>();
    // Label the row with an error severity, not an unrelated non-error alias
    // (for example level=info alongside severity_text=ERROR).
    let severity = if severity_fields.is_empty() {
        "'error'".to_owned()
    } else {
        format!(
            "CASE {} ELSE 'error' END",
            severity_fields
                .iter()
                .map(|field| format!(
                    "WHEN {} THEN UPPER(TRIM(CAST({} AS VARCHAR)))",
                    log_text_severity_predicate(field),
                    quote_identifier(field)
                ))
                .collect::<Vec<_>>()
                .join(" ")
        )
    };
    let error_type = coalesced_log_text(
        fields,
        &[
            "event_exception.type",
            "exception.type",
            "error.type",
            "error.kind",
            "exception_type",
            "error_type",
        ],
        &severity,
    );
    let message = coalesced_log_text(
        fields,
        &[
            "event_exception.message",
            "exception.message",
            "message",
            "msg",
            "body",
            "log",
            "error.message",
        ],
        "CAST(NULL AS VARCHAR)",
    );
    let sample_message = format!("MAX({message})");
    let time_column = quote_identifier(time_column);
    let last_seen = format!("MAX({time_column})");
    let mut predicates = severity_fields
        .iter()
        .map(|field| log_text_severity_predicate(field))
        .collect::<Vec<_>>();
    if fields.iter().any(|field| field == "severity_number") {
        // DOUBLE keeps fractional and out-of-range numbers from being truncated
        // into a valid code. Invalid text becomes NULL rather than failing a query.
        predicates.push(
            "TRY_CAST(\"severity_number\" AS DOUBLE) IN (17, 18, 19, 20, 21, 22, 23, 24)"
                .to_owned(),
        );
    }
    if predicates.is_empty() {
        return Err("log dataset has no supported explicit severity field (level, log_level, severity, severity_text, severity_description, severity_number)".to_owned());
    }
    Ok(format!(
        "SELECT {service} AS \"serviceName\", {error_type} AS \"errorType\", {sample_message} AS \"sampleMessage\", COUNT(*) AS \"occurrences\", {last_seen} AS \"lastSeen\" FROM {} WHERE ({}) AND {time_column} >= TIMESTAMP {} AND {time_column} < TIMESTAMP {} GROUP BY {service}, {error_type} ORDER BY \"occurrences\" DESC LIMIT {}",
        quote_identifier(dataset),
        predicates.join(" OR "),
        quote_literal(&range.start.to_rfc3339()),
        quote_literal(&range.end.to_rfc3339()),
        limit.clamp(1, 500),
    ))
}

fn log_error_query_request(
    dataset: &str,
    fields: &[String],
    time_column: &str,
    limit: u64,
    arguments: &Value,
    now: DateTime<Utc>,
) -> Result<query::Query, String> {
    let start = parse_start_time_expression(required_string(arguments, "startTime")?, now)
        .map_err(|error| format!("invalid log error start time: {error}"))?;
    let end = parse_time_expression(required_string(arguments, "endTime")?, now)
        .map_err(|error| format!("invalid log error end time: {error}"))?;
    if start >= end {
        return Err("log error start time must be before end time".to_owned());
    }
    let range = TimeRange { start, end };
    // The generic query API rounds transport bounds to minutes. Expand its
    // envelope, while keeping exact half-open bounds in the SQL predicates.
    let transport_end = truncate_to_minute(end)
        .checked_add_signed(Duration::minutes(1))
        .ok_or_else(|| "log error end time is outside the supported range".to_owned())?;
    Ok(query::Query {
        query: bounded_select(&list_log_errors_query(
            dataset,
            fields,
            limit,
            time_column,
            &range,
        )?)?,
        start_time: truncate_to_minute(start).to_rfc3339(),
        end_time: transport_end.to_rfc3339(),
        send_null: true,
        fields: false,
        streaming: false,
        filter_tags: None,
    })
}

async fn list_log_errors(arguments: &Value, context: OssToolContext<'_>) -> Result<Value, String> {
    let dataset = required_string(arguments, "dataset")?;
    authorize(context.session_key, Action::Query, Some(dataset), None)?;
    let info = serde_json::to_value(
        get_prism_logstream_info(dataset, context.tenant_id)
            .await
            .map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    if nested_string(&info, "telemetryType").is_none_or(|value| value != "logs") {
        return Err(format!(
            "tool requires a logs dataset, but `{dataset}` is not logs telemetry"
        ));
    }
    let schema = logstream::get_schema_internal(dataset, context.tenant_id)
        .await
        .map_err(|error| error.to_string())?;
    let fields = schema
        .fields()
        .iter()
        .map(|field| field.name().to_owned())
        .collect::<Vec<_>>();
    let limit = bounded_integer(arguments, "limit", 50, 1, 500);
    let time_column = nested_string(&info, "timePartition").unwrap_or("p_timestamp");
    let request =
        log_error_query_request(dataset, &fields, time_column, limit, arguments, Utc::now())?;
    let response = query::query_internal(request, context.session_key, context.tenant_id)
        .await
        .map_err(|error| error.to_string())?;
    let records = response_value(response).await?;
    let total = records.as_array().map_or(0, Vec::len);
    Ok(json!({
        "total": total,
        "offset": 0,
        "limit": limit,
        "records": records,
    }))
}

async fn execute_sql_tool(
    name: &str,
    arguments: &Value,
    context: OssToolContext<'_>,
) -> Result<Value, String> {
    authorize(context.session_key, Action::Query, None, None)?;
    let query_text = required_string(arguments, "query")?;
    let query_text = if name == "explain_query" {
        format!("EXPLAIN {}", bounded_select(query_text)?)
    } else {
        bounded_select(query_text)?
    };
    let response = query::query_internal(
        query::Query {
            query: query_text,
            start_time: required_string(arguments, "startTime")?.to_owned(),
            end_time: required_string(arguments, "endTime")?.to_owned(),
            send_null: true,
            fields: false,
            streaming: false,
            filter_tags: None,
        },
        context.session_key,
        context.tenant_id,
    )
    .await
    .map_err(|error| error.to_string())?;
    response_value(response).await
}

async fn execute_alert_tool(
    name: &str,
    arguments: &Value,
    context: OssToolContext<'_>,
) -> Result<Value, String> {
    match name {
        "list_alerts" => {
            authorize(context.session_key, Action::GetAlert, None, None)?;
            serde_json::to_value(
                alerts::list_internal(context.session_key.clone(), &HashMap::new())
                    .await
                    .map_err(|error| error.to_string())?,
            )
            .map_err(|error| error.to_string())
        }
        "get_alert" => {
            authorize(context.session_key, Action::GetAlert, None, None)?;
            let id = Ulid::from_string(required_string(arguments, "alert_id")?)
                .map_err(|error| error.to_string())?;
            serde_json::to_value(
                alerts::get_internal(context.session_key, id, context.tenant_id)
                    .await
                    .map_err(|error| error.to_string())?,
            )
            .map_err(|error| error.to_string())
        }
        "list_alert_tags" => {
            authorize(context.session_key, Action::GetAlert, None, None)?;
            serde_json::to_value(
                alerts::list_tags_internal(context.tenant_id)
                    .await
                    .map_err(|error| error.to_string())?,
            )
            .map_err(|error| error.to_string())
        }
        "enable_alert" | "disable_alert" | "evaluate_alert" => {
            authorize(context.session_key, Action::PutAlert, None, None)?;
            let id = Ulid::from_string(required_string(arguments, "alert_id")?)
                .map_err(|error| error.to_string())?;
            let response = match name {
                "enable_alert" => {
                    alerts::enable_alert_internal(context.session_key, id, context.tenant_id).await
                }
                "disable_alert" => {
                    alerts::disable_alert_internal(context.session_key, id, context.tenant_id).await
                }
                _ => {
                    alerts::evaluate_alert_internal(context.session_key, id, context.tenant_id)
                        .await
                }
            }
            .map_err(|error| error.to_string())?;
            serde_json::to_value(response).map_err(|error| error.to_string())
        }
        "create_alert" => create_alert(arguments, context).await,
        _ => unreachable!("alert dispatcher only receives known tools"),
    }
}

async fn create_alert(arguments: &Value, context: OssToolContext<'_>) -> Result<Value, String> {
    authorize(context.session_key, Action::PutAlert, None, None)?;
    let request = serde_json::from_value(
        arguments
            .get("spec")
            .cloned()
            .ok_or_else(|| "missing required object argument `spec`".to_owned())?,
    )
    .map_err(|error| format!("invalid alert spec: {error}"))?;
    serde_json::to_value(
        alerts::post_internal(request, context.session_key, context.tenant_id)
            .await
            .map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())
}

async fn execute_alert_target_tool(
    name: &str,
    arguments: &Value,
    context: OssToolContext<'_>,
) -> Result<Value, String> {
    match name {
        "list_alert_targets" => {
            authorize(context.session_key, Action::GetAlert, None, None)?;
            serde_json::to_value(
                targets::list_internal(context.tenant_id)
                    .await
                    .map_err(|error| error.to_string())?,
            )
            .map_err(|error| error.to_string())
        }
        "get_alert_target" => {
            authorize(context.session_key, Action::GetAlert, None, None)?;
            let id = Ulid::from_string(required_string(arguments, "target_id")?)
                .map_err(|error| error.to_string())?;
            targets::get_internal(id, context.tenant_id)
                .await
                .map_err(|error| error.to_string())
        }
        "create_alert_target" => {
            authorize(context.session_key, Action::PutAlert, None, None)?;
            let target = serde_json::from_value(
                arguments
                    .get("spec")
                    .cloned()
                    .ok_or_else(|| "missing required object argument `spec`".to_owned())?,
            )
            .map_err(|error| format!("invalid alert target spec: {error}"))?;
            targets::post_internal(target, context.tenant_id)
                .await
                .map_err(|error| error.to_string())
        }
        _ => unreachable!("alert target dispatcher only receives known tools"),
    }
}

async fn execute_trace_tool(
    name: &str,
    arguments: &Value,
    context: OssToolContext<'_>,
) -> Result<Value, String> {
    let datasets = [required_string(arguments, "dataset")?.to_owned()];
    let start_time = required_string(arguments, "startTime")?.to_owned();
    let end_time = required_string(arguments, "endTime")?.to_owned();
    let default_limit = if name == "list_trace_errors" { 50 } else { 100 };
    let limit = bounded_integer(arguments, "limit", default_limit, 1, 500) as usize;
    let mut results = Vec::new();
    let mut errors = Vec::new();
    for dataset in datasets {
        if let Err(message) = authorize(context.session_key, Action::Query, Some(&dataset), None) {
            errors.push(json!({ "dataset": dataset, "message": message }));
            continue;
        }
        let response = if name == "get_trace" {
            crate::handlers::http::traces::get_trace_detail_internal(
                crate::handlers::http::traces::TraceDetailRequest {
                    dataset: dataset.clone(),
                    trace_id: required_string(arguments, "traceId")?.to_owned(),
                    start_time: start_time.clone(),
                    end_time: end_time.clone(),
                },
                context.tenant_id,
                context.session_key,
                Some(context.query_headers.clone()),
            )
            .await
        } else {
            crate::handlers::http::traces::list_traces_internal(
                crate::handlers::http::traces::TraceListRequest {
                    dataset: dataset.clone(),
                    service_name: arguments
                        .get("serviceName")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    start_time: start_time.clone(),
                    end_time: end_time.clone(),
                    sort_by: None,
                    conditions: None,
                    options: (name == "list_trace_errors")
                        .then_some(crate::handlers::http::traces::TraceListOption::ErrorSpans),
                    limit: Some(limit),
                    offset: Some(0),
                },
                context.tenant_id,
                context.session_key,
                Some(context.query_headers.clone()),
            )
            .await
        };
        match response {
            Ok(response) => results.push(json!({ "dataset": dataset, "response": response })),
            Err(error) => errors.push(json!({
                "dataset": dataset,
                "message": error.to_string(),
            })),
        }
    }
    if results.is_empty() {
        return Err(format!("all selected datasets failed: {errors:?}"));
    }
    Ok(json!({ "results": results, "errors": errors }))
}

fn time_bucket_interval(range: &TimeRange, bucket_count: u64) -> String {
    let seconds = (range.end - range.start).num_seconds().max(1) as u64;
    format!("{} seconds", (seconds / bucket_count.max(1)).max(1))
}

fn trace_activity_range(arguments: &Value, now: DateTime<Utc>) -> Result<TimeRange, String> {
    let start = parse_start_time_expression(required_string(arguments, "startTime")?, now)
        .map_err(|error| format!("invalid trace activity start time: {error}"))?;
    let end = parse_time_expression(required_string(arguments, "endTime")?, now)
        .map_err(|error| format!("invalid trace activity end time: {error}"))?;
    if start >= end {
        return Err("trace activity start time must be before end time".to_owned());
    }
    Ok(TimeRange { start, end })
}

fn trace_activity_query(
    dataset: &str,
    time_field: &str,
    interval: &str,
    range: &TimeRange,
    group_by: &[String],
    clauses: &[String],
) -> String {
    let time_column = quote_identifier(time_field);
    let start = quote_literal(&range.start.to_rfc3339());
    // Bucket from the requested start so the first bucket is not partial.
    let bucket = format!(
        "CAST(DATE_BIN({}, {time_column}, TIMESTAMP {start}) AS TEXT)",
        quote_literal(interval),
    );
    let mut select = vec![format!("{bucket} AS \"time\"")];
    select.extend(group_by.iter().map(|field| quote_identifier(field)));
    select.push("COUNT(DISTINCT \"span_span_id\") AS \"span_count\"".to_owned());
    select.push("COUNT(DISTINCT \"span_trace_id\") AS \"trace_count\"".to_owned());
    let groups = (1..=group_by.len() + 1)
        .map(|position| position.to_string())
        .collect::<Vec<_>>()
        .join(", ");
    // The query API rounds its transport range to minutes, so keep the exact
    // half-open requested range in the SQL.
    let mut predicates = vec![
        format!("{time_column} >= TIMESTAMP {start}"),
        format!(
            "{time_column} < TIMESTAMP {}",
            quote_literal(&range.end.to_rfc3339())
        ),
    ];
    predicates.extend(clauses.iter().cloned());
    let where_clause = format!(" WHERE {}", predicates.join(" AND "));
    // One row past the tool limit lets the caller detect truncation.
    format!(
        "SELECT {} FROM {}{} GROUP BY {} ORDER BY 1 LIMIT {}",
        select.join(", "),
        quote_identifier(dataset),
        where_clause,
        groups,
        MAX_TOOL_ROWS + 1,
    )
}

/// Caps trace activity rows at the tool limit and reports whether any were dropped.
fn truncate_trace_activity_rows(rows: &mut Value) -> bool {
    let rows = match rows {
        Value::Array(rows) => rows,
        Value::Object(object) => match object.get_mut("records").and_then(Value::as_array_mut) {
            Some(rows) => rows,
            None => return false,
        },
        _ => return false,
    };
    let truncated = rows.len() > MAX_TOOL_ROWS as usize;
    rows.truncate(MAX_TOOL_ROWS as usize);
    truncated
}

async fn trace_activity_fields(
    dataset: &str,
    context: OssToolContext<'_>,
) -> Result<(Vec<String>, String), String> {
    authorize(context.session_key, Action::Query, Some(dataset), None)?;
    if !PARSEABLE
        .check_or_load_stream(dataset, context.tenant_id)
        .await
    {
        return Err(format!("dataset `{dataset}` metadata is unavailable"));
    }
    let stream = PARSEABLE
        .get_stream(dataset, context.tenant_id)
        .map_err(|error| error.to_string())?;
    let telemetry_type = stream
        .metadata
        .read()
        .map_err(|error| error.to_string())?
        .telemetry_type
        .to_string();
    if telemetry_type != "traces" {
        return Err(format!(
            "dataset `{dataset}` has telemetry type `{telemetry_type}`; expected `traces`"
        ));
    }
    let schema = logstream::get_schema_internal(dataset, context.tenant_id)
        .await
        .map_err(|error| error.to_string())?;
    let fields = schema
        .fields()
        .iter()
        .map(|field| field.name().to_owned())
        .collect::<Vec<_>>();
    let time_field = trace_activity_time_field(dataset, &fields, stream.get_time_partition())?;
    Ok((fields, time_field))
}

/// Checks that a traces dataset's fields support activity counts and returns
/// the time column to bucket on.
fn trace_activity_time_field(
    dataset: &str,
    fields: &[String],
    time_partition: Option<String>,
) -> Result<String, String> {
    for required in ["span_span_id", "span_trace_id"] {
        if !fields.iter().any(|field| field == required) {
            return Err(format!(
                "trace dataset `{dataset}` is missing required field `{required}`"
            ));
        }
    }
    let time_field = time_partition.unwrap_or_else(|| "p_timestamp".to_owned());
    if !fields.contains(&time_field) {
        return Err(format!(
            "trace dataset `{dataset}` is missing time field `{time_field}`"
        ));
    }
    Ok(time_field)
}

fn trace_activity_group_by(arguments: &Value, fields: &[String]) -> Result<Vec<String>, String> {
    let group_by = arguments
        .get("groupBy")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|value| {
            value
                .as_str()
                .map(str::to_owned)
                .ok_or_else(|| "groupBy entries must be strings".to_owned())
        })
        .collect::<Result<Vec<_>, _>>()?;
    if group_by.len() > 5 {
        return Err("groupBy may contain at most 5 fields".to_owned());
    }
    if let Some(field) = group_by.iter().find(|field| !fields.contains(field)) {
        return Err(format!("groupBy field `{field}` does not exist"));
    }
    Ok(group_by)
}

fn trace_activity_filter_clauses(
    arguments: &Value,
    fields: &[String],
) -> Result<Vec<String>, String> {
    arguments
        .get("filters")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .map(|(field, value)| {
            if !fields.iter().any(|candidate| candidate == field) {
                return Err(format!("filter field `{field}` does not exist"));
            }
            match value {
                Value::String(value) => Ok(format!(
                    "{} = {}",
                    quote_identifier(field),
                    quote_literal(value)
                )),
                Value::Number(value) => Ok(format!("{} = {value}", quote_identifier(field))),
                Value::Bool(value) => Ok(format!("{} = {value}", quote_identifier(field))),
                Value::Null => Ok(format!("{} IS NULL", quote_identifier(field))),
                _ => Err("filter values must be JSON scalars".to_owned()),
            }
        })
        .collect()
}

fn trace_activity_request(query: &str, range: &TimeRange) -> Result<query::Query, String> {
    // Widen the minute-rounded transport envelope to cover the exact range.
    let transport_end = truncate_to_minute(range.end)
        .checked_add_signed(Duration::minutes(1))
        .ok_or_else(|| "trace activity end time is outside the supported range".to_owned())?;
    // The generated query carries its own LIMIT; wrapping it in the generic
    // 500-row bound would hide the extra row used to detect truncation.
    validate_tool_sql(query)?;
    Ok(query::Query {
        query: query.to_owned(),
        start_time: truncate_to_minute(range.start).to_rfc3339(),
        end_time: transport_end.to_rfc3339(),
        send_null: true,
        fields: false,
        streaming: false,
        filter_tags: None,
    })
}

async fn execute_trace_activity_tool(
    arguments: &Value,
    context: OssToolContext<'_>,
) -> Result<Value, String> {
    let dataset = required_string(arguments, "dataset")?;
    let range = trace_activity_range(arguments, Utc::now())?;
    let (fields, time_field) = trace_activity_fields(dataset, context).await?;
    let group_by = trace_activity_group_by(arguments, &fields)?;
    let clauses = trace_activity_filter_clauses(arguments, &fields)?;
    let bucket_count = bounded_integer(arguments, "bucketCount", 60, 1, 100);
    let interval = time_bucket_interval(&range, bucket_count);
    let query = trace_activity_query(dataset, &time_field, &interval, &range, &group_by, &clauses);
    let response = query::query_internal(
        trace_activity_request(&query, &range)?,
        context.session_key,
        context.tenant_id,
    )
    .await
    .map_err(|error| error.to_string())?;
    let mut rows = response_value(response).await?;
    let truncated = truncate_trace_activity_rows(&mut rows);
    Ok(json!({
        "dataset": dataset,
        "queryType": "sql",
        "query": query,
        "bucketInterval": interval,
        "semantics": {
            "span_count": "COUNT(DISTINCT span_span_id)",
            "trace_count": "COUNT(DISTINCT span_trace_id)"
        },
        "rows": rows,
        "truncated": truncated,
    }))
}

async fn execute_identity_tool(
    name: &str,
    arguments: &Value,
    context: OssToolContext<'_>,
) -> Result<Value, String> {
    match name {
        "list_users" => {
            authorize(context.session_key, Action::ListUser, None, None)?;
            Ok(rbac::list_users_internal(context.tenant_id))
        }
        "get_user" => {
            let user = required_string(arguments, "userid")?;
            authorize(context.session_key, Action::GetUserRoles, None, Some(user))?;
            serde_json::to_value(
                rbac::get_user_internal(user, context.tenant_id)
                    .map_err(|error| error.to_string())?,
            )
            .map_err(|error| error.to_string())
        }
        "get_user_roles" => {
            let user = required_string(arguments, "userid")?;
            authorize(context.session_key, Action::GetUserRoles, None, Some(user))?;
            rbac::get_role_internal(user, context.tenant_id).map_err(|error| error.to_string())
        }
        "list_roles" => {
            authorize(context.session_key, Action::ListRole, None, None)?;
            serde_json::to_value(
                role::list_internal(context.tenant_id)
                    .await
                    .map_err(|error| error.to_string())?,
            )
            .map_err(|error| error.to_string())
        }
        "get_role" => {
            authorize(context.session_key, Action::GetRole, None, None)?;
            serde_json::to_value(
                role::get_internal(required_string(arguments, "name")?, context.tenant_id)
                    .await
                    .map_err(|error| error.to_string())?,
            )
            .map_err(|error| error.to_string())
        }
        "get_default_role" => {
            authorize(context.session_key, Action::GetRole, None, None)?;
            Ok(role::get_default_internal(context.tenant_id))
        }
        _ => unreachable!("identity dispatcher only receives known tools"),
    }
}

async fn execute_system_tool(
    name: &str,
    arguments: &Value,
    context: OssToolContext<'_>,
) -> Result<Value, String> {
    match name {
        "ping" => {
            authorize(context.session_key, Action::GetAbout, None, None)?;
            Ok(json!({
                "about": crate::handlers::http::about::about().await.into_inner(),
                "liveness": { "status": health_check::liveness_internal().as_u16() },
                "readiness": {
                    "status": health_check::readiness_internal(context.tenant_id).await.as_u16()
                },
            }))
        }
        "get_cluster_status" => {
            authorize(context.session_key, Action::ListCluster, None, None)?;
            serde_json::to_value(
                cluster::get_cluster_info_internal(context.tenant_id)
                    .await
                    .map_err(|error| error.to_string())?,
            )
            .map_err(|error| error.to_string())
        }
        "get_cluster_metrics" => {
            authorize(context.session_key, Action::ListClusterMetrics, None, None)?;
            serde_json::to_value(
                cluster::get_cluster_metrics_internal(context.tenant_id)
                    .await
                    .map_err(|error| error.to_string())?,
            )
            .map_err(|error| error.to_string())
        }
        "get_retention" => {
            let dataset = required_string(arguments, "dataset")?;
            authorize(
                context.session_key,
                Action::GetRetention,
                Some(dataset),
                None,
            )?;
            serde_json::to_value(
                logstream::get_retention_internal(dataset, context.tenant_id)
                    .await
                    .map_err(|error| error.to_string())?,
            )
            .map_err(|error| error.to_string())
        }
        "get_hot_tier_config" => get_hot_tier_config(arguments, context).await,
        _ => unreachable!("system dispatcher only receives known tools"),
    }
}

async fn get_hot_tier_config(
    arguments: &Value,
    context: OssToolContext<'_>,
) -> Result<Value, String> {
    let dataset = required_string(arguments, "dataset")?;
    authorize(
        context.session_key,
        Action::GetHotTierEnabled,
        Some(dataset),
        None,
    )?;
    serde_json::to_value(
        logstream::get_stream_hot_tier_internal(dataset, context.tenant_id)
            .await
            .map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())
}

async fn execute_saved_object_tool(
    name: &str,
    arguments: &Value,
    context: OssToolContext<'_>,
) -> Result<Value, String> {
    match name {
        "list_filters" => {
            authorize(context.session_key, Action::ListFilter, None, None)?;
            serde_json::to_value(filters::list_internal(context.session_key).await)
                .map_err(|error| error.to_string())
        }
        "get_filter" => {
            authorize(context.session_key, Action::GetFilter, None, None)?;
            serde_json::to_value(
                filters::get_internal(
                    required_string(arguments, "id")?,
                    context.session_key,
                    context.tenant_id,
                )
                .await
                .map_err(|error| error.to_string())?,
            )
            .map_err(|error| error.to_string())
        }
        "list_dashboard_tags" => {
            authorize(context.session_key, Action::ListDashboard, None, None)?;
            serde_json::to_value(
                dashboards::list_tags_internal(context.tenant_id)
                    .await
                    .map_err(|e| e.to_string())?,
            )
            .map_err(|error| error.to_string())
        }
        "get_dashboard" => {
            authorize(context.session_key, Action::GetDashboard, None, None)?;
            let id = Ulid::from_string(required_string(arguments, "dashboardId")?)
                .map_err(|error| error.to_string())?;
            serde_json::to_value(
                dashboards::get_dashboard_internal(id, context.tenant_id)
                    .await
                    .map_err(|error| error.to_string())?,
            )
            .map_err(|error| error.to_string())
        }
        "list_dashboards" => {
            authorize(context.session_key, Action::ListDashboard, None, None)?;
            let limit = bounded_integer(arguments, "limit", 100, 1, 500) as usize;
            let query = arguments
                .get("query")
                .and_then(Value::as_str)
                .map(str::to_ascii_lowercase);
            let fetch_limit = if query.is_some() { 0 } else { limit };
            Ok(Value::Array(
                dashboards::list_dashboards_internal(fetch_limit, None, context.tenant_id)
                    .await
                    .map_err(|e| e.to_string())?
                    .into_iter()
                    .filter(|dashboard| {
                        query.as_ref().is_none_or(|query| {
                            dashboard
                                .get("title")
                                .and_then(Value::as_str)
                                .is_some_and(|title| title.to_ascii_lowercase().contains(query))
                                || dashboard.get("tags").and_then(Value::as_array).is_some_and(
                                    |tags| {
                                        tags.iter()
                                            .filter_map(Value::as_str)
                                            .any(|tag| tag.to_ascii_lowercase().contains(query))
                                    },
                                )
                        })
                    })
                    .take(limit)
                    .collect(),
            ))
        }
        _ => unreachable!("saved object dispatcher only receives known tools"),
    }
}

async fn execute_oss_tool_inner(
    name: &str,
    arguments: &Value,
    session_key: &SessionKey,
    tenant_id: &Option<String>,
    query_headers: &HeaderMap,
) -> Result<Value, String> {
    let context = OssToolContext {
        session_key,
        tenant_id,
        query_headers,
    };
    match name {
        "list_datasets" | "resolve_dataset" | "resolve_time_range" => {
            execute_dataset_resolution_tool(name, arguments, context).await
        }
        "discover_datasets" => discover_datasets(arguments, context).await,
        "get_dataset_schema" | "get_dataset_info" | "get_dataset_stats" => {
            execute_dataset_metadata_tool(name, arguments, context).await
        }
        "sample_events" => sample_events(arguments, context).await,
        "get_log_context" => get_log_context(arguments, context).await,
        "list_log_errors" => list_log_errors(arguments, context).await,
        "query_sql" | "explain_query" => execute_sql_tool(name, arguments, context).await,
        "list_alerts" | "get_alert" | "list_alert_tags" | "enable_alert" | "disable_alert"
        | "evaluate_alert" | "create_alert" => execute_alert_tool(name, arguments, context).await,
        "list_alert_targets" | "get_alert_target" | "create_alert_target" => {
            execute_alert_target_tool(name, arguments, context).await
        }
        "get_traces" | "get_trace" | "list_trace_errors" => {
            execute_trace_tool(name, arguments, context).await
        }
        "get_trace_activity" => execute_trace_activity_tool(arguments, context).await,
        "ping"
        | "get_cluster_status"
        | "get_cluster_metrics"
        | "get_retention"
        | "get_hot_tier_config" => execute_system_tool(name, arguments, context).await,
        "list_users" | "get_user" | "get_user_roles" | "list_roles" | "get_role"
        | "get_default_role" => execute_identity_tool(name, arguments, context).await,
        "list_filters"
        | "get_filter"
        | "list_dashboard_tags"
        | "get_dashboard"
        | "list_dashboards" => execute_saved_object_tool(name, arguments, context).await,
        _ => Err(format!(
            "tool `{name}` is registered but does not yet have an OSS internal executor"
        )),
    }
}

/// Execute a registered OSS tool in-process. Enterprise uses this only after
/// applying its own agent policy and action-confirmation checks, so catalog
/// validation and the underlying platform implementation remain canonical.
///
/// # Caller obligations
///
/// Unlike [`call_tool_registry`], this function applies only catalog argument
/// validation and each tool's own per-resource `authorize()` check. Before
/// calling it, the caller must:
///
/// - confirm the session is still valid (`Users.session_exists`);
/// - reject suspended tenants with
///   `middleware::check_suspension_for_tenant(tenant_id, Action::Query)`;
/// - authorize the global `Action::Query` gate for the session;
/// - restrict which tools may run. Lookup uses the full [`oss_tool_specs`],
///   including action tools such as `create_alert`, `enable_alert`,
///   `disable_alert`, `evaluate_alert` and `create_alert_target`, whereas the
///   HTTP route exposes only [`oss_read_tool_specs`] (plus dashboard writes
///   when enabled). Action tools need the caller's own confirmation policy.
///
/// The same obligations apply to [`execute_oss_tool_with_query_headers`].
///
/// [`oss_read_tool_specs`]: crate::tool_catalog::oss_read_tool_specs
pub async fn execute_oss_tool(
    name: &str,
    arguments: &Value,
    session_key: &SessionKey,
    tenant_id: &Option<String>,
    request_headers: &HeaderMap,
) -> Result<Value, String> {
    execute_oss_tool_with_query_headers(name, arguments, session_key, tenant_id, request_headers)
        .await
}

/// Execute a registered OSS tool with separate headers for internal query-node
/// requests. Prism callers use this to preserve their server-authenticated
/// routing headers without changing the external MCP execution path.
///
/// Callers must apply the session, tenant-suspension, global `Query` and
/// tool-restriction gates listed on [`execute_oss_tool`]; none are enforced
/// here.
pub async fn execute_oss_tool_with_query_headers(
    name: &str,
    arguments: &Value,
    session_key: &SessionKey,
    tenant_id: &Option<String>,
    query_headers: &HeaderMap,
) -> Result<Value, String> {
    let spec = oss_tool_specs()
        .into_iter()
        .find(|tool| tool.name == name)
        .ok_or_else(|| format!("unknown OSS tool `{name}`"))?;
    spec.validate_arguments(arguments)?;
    execute_oss_tool_inner(name, arguments, session_key, tenant_id, query_headers).await
}

/// Generic execution endpoint used by external MCP adapters.
pub async fn call_tool_registry(
    req: HttpRequest,
    web::Json(call): web::Json<ToolCallRequest>,
) -> HttpResponse {
    if !call.arguments.is_object() {
        return HttpResponse::BadRequest().json(ToolCallResult::error(
            "tool arguments must be a JSON object",
        ));
    }
    let session_key = match extract_session_key_from_req(&req) {
        Ok(session_key) => session_key,
        Err(error) => {
            return HttpResponse::Unauthorized().json(ToolCallResult::error(error.to_string()));
        }
    };
    if !Users.session_exists(&session_key) {
        return HttpResponse::Unauthorized().json(ToolCallResult::error(
            "Your session has expired or is no longer valid. Please re-authenticate to access this resource.",
        ));
    }
    let Some(spec) = crate::tool_catalog::external_tool_specs(
        crate::users::dashboard_tools::writes_enabled(&req),
    )
    .find(|tool| tool.name == call.name) else {
        return HttpResponse::NotFound().json(ToolCallResult::error("unknown tool"));
    };
    if let Err(error) = spec.validate_arguments(&call.arguments) {
        return HttpResponse::BadRequest().json(ToolCallResult::error(error));
    }
    let tenant_id = get_tenant_id_from_request(&req);
    if crate::users::dashboard_tools::is_dashboard_tool(spec.name) {
        return match crate::users::dashboard_tools::execute(&req, spec.name, &call.arguments).await
        {
            Ok(result) => HttpResponse::Ok().json(ToolCallResult::success(result)),
            Err(error) => {
                let mut result = ToolCallResult::error(error.to_string());
                result.structured_content =
                    json!({"error":crate::users::dashboard_tools::tool_error(&error)});
                HttpResponse::Ok().json(result)
            }
        };
    }
    // Multiplexed transport authentication is separate from per-tool policy.
    // Preserve the existing query gate for non-dashboard tools, including
    // tenant suspension checks, without requiring query access to edit config.
    if let crate::rbac::Response::Suspended(message) =
        crate::handlers::http::middleware::check_suspension_for_tenant(
            tenant_id.as_deref(),
            Action::Query,
        )
    {
        return HttpResponse::Forbidden().json(ToolCallResult::error(message));
    }
    if let Err(message) = authorize(&session_key, Action::Query, None, None) {
        return HttpResponse::Forbidden().json(ToolCallResult::error(message));
    }
    match execute_oss_tool_inner(
        spec.name,
        &call.arguments,
        &session_key,
        &tenant_id,
        req.headers(),
    )
    .await
    {
        Ok(result) => HttpResponse::Ok().json(ToolCallResult::success(result)),
        Err(message) => HttpResponse::Ok().json(ToolCallResult::error(message)),
    }
}

#[cfg(test)]
mod tests {
    #[actix_web::test]
    async fn bounded_tool_sql_preserves_multiline_queries_and_trailing_comments() {
        use datafusion::sql::sqlparser::{dialect::GenericDialect, parser::Parser};
        for source in [
            "SELECT\n1 AS value",
            "WITH\nx AS (SELECT 1 AS value) SELECT value FROM x",
            "SELECT 1 -- trailing comment",
        ] {
            let bounded = super::bounded_select(source).unwrap();
            assert_eq!(
                Parser::parse_sql(&GenericDialect {}, &bounded)
                    .unwrap()
                    .len(),
                1
            );
            assert!(bounded.ends_with("LIMIT 500"));
        }
        assert!(super::bounded_select("DELETE FROM logs").is_err());
        assert!(super::bounded_select("SELECT 1; SELECT 2").is_err());
    }

    use actix_web::{App, http::StatusCode, test, web};
    use chrono::{DateTime, Duration, Utc};
    use serde_json::{Value, json};

    use crate::handlers::http::query_context::LogContextRequest;

    use super::{
        bounded_tool_sql, call_tool_registry, list_log_errors_query, log_context_request,
        log_error_query_request, project_log_context_result, resolve_dataset_candidates,
        resolve_time_range_at, sample_events_query, trace_activity_query,
    };

    fn log_error_test_range() -> crate::utils::time::TimeRange {
        crate::utils::time::TimeRange {
            start: "2026-10-16T00:00:00Z".parse().unwrap(),
            end: "2026-10-17T00:00:00Z".parse().unwrap(),
        }
    }

    async fn run_log_error_fixture(fixture_sql: &str) -> Vec<Value> {
        let context = datafusion::prelude::SessionContext::new();
        let batches = context
            .sql(&format!(
                "SELECT *, TIMESTAMP '2026-10-16T12:00:00Z' AS p_timestamp FROM ({fixture_sql})"
            ))
            .await
            .unwrap()
            .collect()
            .await
            .unwrap();
        let fields = batches[0]
            .schema()
            .fields()
            .iter()
            .map(|field| field.name().clone())
            .collect::<Vec<_>>();
        context.register_batch("logs", batches[0].clone()).unwrap();
        let query =
            list_log_errors_query("logs", &fields, 500, "p_timestamp", &log_error_test_range())
                .unwrap();
        let results = context.sql(&query).await.unwrap().collect().await.unwrap();
        let mut writer = arrow_json::ArrayWriter::new(Vec::new());
        writer
            .write_batches(&results.iter().collect::<Vec<_>>())
            .unwrap();
        writer.finish().unwrap();
        serde_json::from_slice(&writer.into_inner()).unwrap()
    }

    #[actix_web::test]
    async fn shared_sql_limits_reject_wildcards_and_excess_columns() {
        assert!(bounded_tool_sql("SELECT a, b FROM logs").is_ok());
        assert!(bounded_tool_sql("SELECT * FROM logs").is_err());
        assert!(bounded_tool_sql("SELECT a,b,c,d,e,f,g,h,i,j,k FROM logs").is_err());
        let bounded = bounded_tool_sql("SELECT a FROM logs -- recent events").unwrap();
        assert!(bounded.contains("-- recent events\n) AS"));
    }

    #[actix_web::test]
    async fn sql_validator_accepts_and_rejects_query_forms() {
        for accepted in [
            "SELECT COUNT(*) FROM t",
            "SELECT a FROM t UNION SELECT b FROM u",
            "SELECT CAST(a AS BIGINT), TRY_CAST(b AS DOUBLE) FROM t",
        ] {
            assert!(super::validate_tool_sql(accepted).is_ok(), "{accepted}");
        }
        for (rejected, message) in [
            (
                "SELECT a FROM t UNION SELECT * FROM u",
                "wildcard selection is not allowed",
            ),
            ("(SELECT * FROM t)", "wildcard selection is not allowed"),
            ("SELECT t.* FROM t", "wildcard selection is not allowed"),
            (
                "SELECT a::INT64 FROM t",
                "unsupported DataFusion SQL cast type `INT64`; use `BIGINT` instead",
            ),
            (
                "SELECT TRY_CAST(a AS FLOAT64) FROM t",
                "unsupported DataFusion SQL cast type `FLOAT64`; use `DOUBLE` instead",
            ),
            (
                "SELECT CAST(a AS UINT64) FROM t",
                "unsupported DataFusion SQL cast type `UInt64`; use `BIGINT` instead",
            ),
            ("VALUES (1)", "unsupported SQL query form"),
            (
                "EXPLAIN SELECT a FROM t",
                "only SQL SELECT queries are allowed",
            ),
            ("DELETE FROM t", "only SQL SELECT queries are allowed"),
            (
                "SELECT a FROM t; SELECT b FROM t",
                "exactly one SQL statement is required",
            ),
        ] {
            let error = super::validate_tool_sql(rejected).unwrap_err();
            assert!(error.contains(message), "{rejected}: {error}");
        }
    }

    #[actix_web::test]
    async fn dataset_resolution_reports_ties_case_insensitive_and_invisible_selections() {
        let datasets = json!([
            { "name": "logs" },
            { "name": "app-logs" },
            { "name": "logs-archive" }
        ]);
        let tied = resolve_dataset_candidates(
            datasets.clone(),
            &json!({ "query": "app-logs and logs-archive" }),
        );
        assert_eq!(tied["status"], "ambiguous");
        assert_eq!(tied["datasets"], json!([]));
        assert_eq!(
            tied["candidates"][0]["score"],
            tied["candidates"][1]["score"]
        );

        let selected =
            resolve_dataset_candidates(datasets.clone(), &json!({ "selectedDataset": "APP-LOGS" }));
        assert_eq!(selected["status"], "resolved");
        assert_eq!(selected["selectedDatasets"], json!(["app-logs"]));

        let invisible =
            resolve_dataset_candidates(datasets, &json!({ "selectedDataset": "secret-logs" }));
        assert_eq!(invisible["status"], "error");
        assert_eq!(
            invisible["message"],
            "Dataset `secret-logs` is not visible to this caller"
        );
    }

    #[actix_web::test]
    async fn shared_dataset_resolution_does_not_select_an_arbitrary_fallback() {
        let datasets = json!([
            { "name": "application-logs" },
            { "name": "otel-metrics" },
            { "name": "otel-traces" }
        ]);
        let resolved =
            resolve_dataset_candidates(datasets.clone(), &json!({ "query": "show otel-metrics" }));
        assert_eq!(resolved["selectedDatasets"], json!(["otel-metrics"]));

        let ambiguous = resolve_dataset_candidates(
            datasets,
            &json!({ "query": "checkout errors", "limit": 2 }),
        );
        assert_eq!(ambiguous["status"], "ambiguous");
        assert_eq!(ambiguous["candidates"].as_array().unwrap().len(), 2);

        let typed = resolve_dataset_candidates(
            json!([
                { "name": "otel-data", "telemetryType": "logs" },
                { "name": "system-data", "telemetryType": "metrics" }
            ]),
            &json!({ "query": "data", "telemetryType": "metrics" }),
        );
        assert_eq!(typed["selectedDatasets"], json!(["system-data"]));

        let explicit_mismatch = resolve_dataset_candidates(
            json!([{ "name": "otel-data", "telemetryType": "logs" }]),
            &json!({
                "query": "otel-data",
                "selectedDataset": "otel-data",
                "telemetryType": "metrics"
            }),
        );
        assert_eq!(explicit_mismatch["status"], "not_found");

        let sole_mismatch = resolve_dataset_candidates(
            json!([{ "name": "otel-data", "telemetryType": "logs" }]),
            &json!({ "query": "data", "telemetryType": "traces" }),
        );
        assert_eq!(sole_mismatch["status"], "not_found");
    }

    #[actix_web::test]
    async fn shared_dataset_resolution_requires_whole_name_mentions() {
        let datasets = json!([{ "name": "api" }, { "name": "web" }]);
        let embedded = resolve_dataset_candidates(
            datasets.clone(),
            &json!({ "query": "show rapid failures" }),
        );
        assert_ne!(embedded["status"], "resolved");

        let mentioned =
            resolve_dataset_candidates(datasets.clone(), &json!({ "query": "show api errors" }));
        assert_eq!(mentioned["status"], "resolved");
        assert_eq!(mentioned["selectedDatasets"], json!(["api"]));

        let punctuated =
            resolve_dataset_candidates(datasets, &json!({ "query": "errors in (api)?" }));
        assert_eq!(punctuated["selectedDatasets"], json!(["api"]));

        let hyphenated = json!([{ "name": "otel-metrics" }, { "name": "otel-traces" }]);
        let longer_name = resolve_dataset_candidates(
            hyphenated.clone(),
            &json!({ "query": "show otel-metrics-v2 errors" }),
        );
        assert_ne!(longer_name["status"], "resolved");
        let underscored =
            resolve_dataset_candidates(hyphenated, &json!({ "query": "show my_otel-metrics" }));
        assert_ne!(underscored["status"], "resolved");
    }

    #[actix_web::test]
    async fn shared_dataset_resolution_prefers_exact_case_selection() {
        let datasets = json!([{ "name": "Logs" }, { "name": "logs" }, { "name": "Traces" }]);
        for (requested, expected) in [("logs", "logs"), ("Logs", "Logs")] {
            let resolved = resolve_dataset_candidates(
                datasets.clone(),
                &json!({ "selectedDataset": requested }),
            );
            assert_eq!(resolved["status"], "resolved");
            assert_eq!(resolved["selectedDatasets"], json!([expected]));
            assert_eq!(resolved["datasets"][0]["name"], expected);
        }

        let unique_fallback =
            resolve_dataset_candidates(datasets.clone(), &json!({ "contextDataset": "traces" }));
        assert_eq!(unique_fallback["status"], "resolved");
        assert_eq!(unique_fallback["selectedDatasets"], json!(["Traces"]));

        let ambiguous_case =
            resolve_dataset_candidates(datasets, &json!({ "selectedDataset": "LOGS" }));
        assert_eq!(ambiguous_case["status"], "ambiguous");
        assert_eq!(ambiguous_case["datasets"], json!([]));
        let names = ambiguous_case["candidates"]
            .as_array()
            .unwrap()
            .iter()
            .map(|candidate| candidate["name"].clone())
            .collect::<Vec<_>>();
        assert_eq!(names, vec![json!("Logs"), json!("logs")]);
    }

    #[actix_web::test]
    async fn shared_dataset_resolution_reports_no_matching_candidates() {
        let none_match = resolve_dataset_candidates(
            json!([
                { "name": "app-logs", "telemetryType": "logs" },
                { "name": "otel-metrics", "telemetryType": "metrics" }
            ]),
            &json!({ "query": "checkout", "telemetryType": "traces" }),
        );
        assert_eq!(none_match["status"], "not_found");
        assert_eq!(none_match["candidates"], json!([]));
        let message = none_match["message"].as_str().unwrap();
        assert!(!message.contains("ambiguous"), "{message}");
        assert_eq!(
            message,
            "No caller-visible datasets match requested telemetry type `traces`."
        );
    }

    #[actix_web::test]
    async fn shared_time_resolution_honors_timezone_and_reference() {
        let reference = DateTime::parse_from_rfc3339("2026-10-01T12:00:00Z")
            .unwrap()
            .to_utc();
        let resolved = resolve_time_range_at(
            &json!({
                "expression": "last 30 minutes",
                "timezone": "Asia/Kolkata"
            }),
            reference,
        )
        .unwrap();
        assert_eq!(resolved["startTime"], "2026-10-01T11:30:00+00:00");
        assert_eq!(resolved["endTime"], "2026-10-01T12:00:00+00:00");
    }

    #[actix_web::test]
    async fn log_context_projection_prefers_observability_fields() {
        // Unrelated fields sort before, and are inserted before, the preferred
        // ones, so the kept set does not depend on map ordering.
        let mut row = serde_json::Map::new();
        for index in 0..12 {
            row.insert(format!("a{index:02}"), json!(index));
        }
        row.insert("body".to_owned(), json!("failed"));
        row.insert("p_timestamp".to_owned(), json!("2026-10-22T00:00:00Z"));
        row.insert("service.name".to_owned(), json!("checkout"));
        let row = Value::Object(row);

        for (shape, projected) in [
            ("array", project_log_context_result(json!([row.clone()]))),
            (
                "records",
                project_log_context_result(json!({ "anchorIndex": 0, "records": [row] }))
                    ["records"]
                    .clone(),
            ),
        ] {
            let projected = projected[0].as_object().unwrap();
            assert_eq!(projected.len(), 10, "{shape}");
            for kept in ["p_timestamp", "service.name", "body", "a00", "a06"] {
                assert!(projected.contains_key(kept), "{shape}: {kept}");
            }
            for dropped in ["a07", "a11"] {
                assert!(!projected.contains_key(dropped), "{shape}: {dropped}");
            }
        }
    }

    #[actix_web::test]
    async fn log_context_request_defaults_and_bounds() {
        let anchor = json!({
            "dataset": "logs",
            "pTimestamp": "2026-10-22T00:00:00Z",
            "body": "failed"
        });
        let request = log_context_request(&anchor).unwrap();
        assert_eq!(request["contextWindow"], "5 minutes");
        assert_eq!(request["pageSize"], 100);
        let parsed = serde_json::from_value::<LogContextRequest>(request).unwrap();
        assert_eq!(parsed.context_window.as_deref(), Some("5 minutes"));
        assert_eq!(parsed.body.as_deref(), Some("failed"));

        let mut explicit = anchor.clone();
        explicit["contextStartTime"] = json!("2026-10-21T23:50:00Z");
        explicit["contextEndTime"] = json!("2026-10-22T00:10:00Z");
        explicit["pageSize"] = json!(9999);
        let request = log_context_request(&explicit).unwrap();
        assert!(request.get("contextWindow").is_none());
        assert_eq!(request["pageSize"], 500);
        let parsed = serde_json::from_value::<LogContextRequest>(request).unwrap();
        assert_eq!(
            parsed.context_start_time.as_deref(),
            Some("2026-10-21T23:50:00Z")
        );
        assert_eq!(
            parsed.context_end_time.as_deref(),
            Some("2026-10-22T00:10:00Z")
        );
        assert_eq!(parsed.page_size, Some(500));
    }

    #[actix_web::test]
    async fn sample_events_prefers_observability_fields_and_explicit_range() {
        let query = sample_events_query(
            &json!({
                "dataset": "logs",
                "startTime": "2026-10-22T00:00:00Z",
                "endTime": "2026-10-22T01:00:00Z",
                "limit": 5
            }),
            &[
                "unused".to_owned(),
                "p_timestamp".to_owned(),
                "service.name".to_owned(),
                "body".to_owned(),
            ],
            Utc::now(),
        )
        .unwrap();

        assert_eq!(query.start_time, "2026-10-22T00:00:00+00:00");
        assert!(
            query
                .query
                .contains("\"p_timestamp\", \"service.name\", \"body\"")
        );
        assert!(query.query.contains("\"unused\""));
        assert!(query.query.ends_with("LIMIT 5"));
    }

    #[actix_web::test]
    async fn log_context_requires_exactly_one_exact_anchor_value() {
        for anchors in [
            json!({}),
            json!({ "log": "a", "body": "b" }),
            json!({ "log": "a", "body": "b", "message": "c" }),
        ] {
            let mut arguments = json!({
                "dataset": "logs",
                "pTimestamp": "2026-10-22T00:00:00Z"
            });
            arguments
                .as_object_mut()
                .unwrap()
                .extend(anchors.as_object().unwrap().clone());
            let error = log_context_request(&arguments).unwrap_err();
            assert!(error.contains("exactly one"), "{anchors}: {error}");
        }
        for anchor in ["log", "body", "message"] {
            let request = log_context_request(&json!({
                "dataset": "logs",
                "pTimestamp": "2026-10-22T00:00:00Z",
                anchor: "failed"
            }))
            .unwrap();
            assert_eq!(request[anchor], "failed");
        }
    }

    #[actix_web::test]
    async fn trace_activity_uses_distinct_span_and_trace_identifiers() {
        let query = trace_activity_query(
            "astronomy-shop-traces",
            "p_timestamp",
            "60 seconds",
            &trace_activity_test_range("2026-10-22T00:00:00Z", "2026-10-22T01:00:00Z"),
            &["service.name".to_owned()],
            &[],
        );

        assert!(query.contains("COUNT(DISTINCT \"span_span_id\") AS \"span_count\""));
        assert!(query.contains("COUNT(DISTINCT \"span_trace_id\") AS \"trace_count\""));
        assert!(query.contains("\"service.name\""));
        assert!(!query.contains("COUNT(*)"));
    }

    fn trace_activity_test_range(start: &str, end: &str) -> crate::utils::time::TimeRange {
        crate::utils::time::TimeRange {
            start: start.parse().unwrap(),
            end: end.parse().unwrap(),
        }
    }

    async fn run_trace_activity_fixture(
        group_by: &[String],
        clauses: &[String],
        status_type: &str,
    ) -> Vec<Value> {
        let arguments = json!({
            "startTime": "2026-10-22T00:00:00Z",
            "endTime": "2026-10-22T00:02:00Z",
        });
        let (interval, rows) =
            run_trace_activity_fixture_with(&arguments, 2, group_by, clauses, status_type).await;
        assert_eq!(interval, "60 seconds");
        rows
    }

    /// Runs the tool's request over a fixture with Parseable's millisecond
    /// timestamps, applying the query API's minute-aligned transport range
    /// before the generated SQL, and checks that rows come back ordered by bucket.
    async fn run_trace_activity_fixture_with(
        arguments: &Value,
        bucket_count: u64,
        group_by: &[String],
        clauses: &[String],
        status_type: &str,
    ) -> (String, Vec<Value>) {
        let range = super::trace_activity_range(arguments, "2026-10-22T00:05:00Z".parse().unwrap())
            .unwrap();
        let context = datafusion::prelude::SessionContext::new();
        // Later buckets come first so that ordering depends on the query.
        let fixture = context
            .sql(&format!(
                r#"SELECT arrow_cast(at, 'Timestamp(Millisecond, None)') AS p_timestamp,
                    trace AS span_trace_id, span AS span_span_id, service AS "service.name",
                    CAST(status AS {status_type}) AS span_status_code
                   FROM (VALUES ('2026-10-22T00:01:10Z', 't3', 's4', 'checkout', 2),
                                ('2026-10-22T00:00:40Z', 't2', 's3', 'cart', 0),
                                ('2026-10-22T00:00:30Z', 't1', 's2', 'checkout', 2),
                                ('2026-10-22T00:00:20Z', 't1', 's1', 'checkout', 0),
                                ('2026-10-22T00:00:10Z', 't1', 's1', 'checkout', 0))
                   AS f(at, trace, span, service, status)"#
            ))
            .await
            .unwrap();
        let interval = super::time_bucket_interval(&range, bucket_count);
        let request = super::trace_activity_request(
            &trace_activity_query(
                "traces",
                "p_timestamp",
                &interval,
                &range,
                group_by,
                clauses,
            ),
            &range,
        )
        .unwrap();
        let envelope =
            crate::utils::time::TimeRange::parse_human_time(&request.start_time, &request.end_time)
                .unwrap();
        assert!(envelope.start <= range.start && envelope.end >= range.end);
        context
            .register_table("raw_traces", fixture.into_view())
            .unwrap();
        let fixture = context
            .sql(&format!(
                "SELECT * FROM raw_traces WHERE p_timestamp >= TIMESTAMP '{}' AND p_timestamp < TIMESTAMP '{}'",
                envelope.start.to_rfc3339(),
                envelope.end.to_rfc3339(),
            ))
            .await
            .unwrap();
        context
            .register_table("traces", fixture.into_view())
            .unwrap();
        let rows = execute_trace_activity_sql(&context, &request.query).await;
        let times = rows
            .iter()
            .map(|row| row["time"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert!(
            times.is_sorted(),
            "trace activity must be ordered by time: {times:?}"
        );
        (interval, rows)
    }

    /// Runs trace activity SQL the way the tool does: validated, without the
    /// generic 500-row wrapper.
    async fn execute_trace_activity_sql(
        context: &datafusion::prelude::SessionContext,
        query: &str,
    ) -> Vec<Value> {
        super::validate_tool_sql(query).unwrap();
        let batches = context.sql(query).await.unwrap().collect().await.unwrap();
        let mut writer = arrow_json::ArrayWriter::new(Vec::new());
        writer
            .write_batches(&batches.iter().collect::<Vec<_>>())
            .unwrap();
        writer.finish().unwrap();
        serde_json::from_slice(&writer.into_inner()).unwrap()
    }

    #[actix_web::test]
    async fn trace_activity_signals_truncation_past_the_row_limit() {
        // 20 services x 60 one-minute buckets = 1200 groups x buckets.
        let context = datafusion::prelude::SessionContext::new();
        let fixture = context
            .sql(
                r#"SELECT CAST(TO_TIMESTAMP_SECONDS(1792627200 + (value / 20) * 60) AS TIMESTAMP)
                        AS p_timestamp,
                    CONCAT('t', value) AS span_trace_id, CONCAT('s', value) AS span_span_id,
                    CONCAT('svc-', value % 20) AS "service.name"
                   FROM range(1200)"#,
            )
            .await
            .unwrap();
        context
            .register_table("traces", fixture.into_view())
            .unwrap();
        let range = trace_activity_test_range("2026-10-22T00:00:00Z", "2026-10-22T01:00:00Z");
        let interval = super::time_bucket_interval(&range, 60);
        assert_eq!(interval, "60 seconds");
        let query = trace_activity_query(
            "traces",
            "p_timestamp",
            &interval,
            &range,
            &["service.name".to_owned()],
            &[],
        );
        let mut rows = Value::Array(execute_trace_activity_sql(&context, &query).await);
        assert!(super::truncate_trace_activity_rows(&mut rows));
        let rows = rows.as_array().unwrap();
        assert_eq!(rows.len(), 500);
        // Ascending order keeps the oldest 25 buckets; the newest are the ones dropped.
        assert_eq!(rows[499]["time"], "2026-10-22T00:24:00");

        // A result that fits is returned whole and not flagged.
        let query = trace_activity_query("traces", "p_timestamp", &interval, &range, &[], &[]);
        let mut rows = Value::Array(execute_trace_activity_sql(&context, &query).await);
        assert!(!super::truncate_trace_activity_rows(&mut rows));
        assert_eq!(rows.as_array().unwrap().len(), 60);

        let mut exact = Value::Array(vec![json!({}); 500]);
        assert!(!super::truncate_trace_activity_rows(&mut exact));
        let mut records = json!({ "records": vec![json!({}); 501] });
        assert!(super::truncate_trace_activity_rows(&mut records));
        assert_eq!(records["records"].as_array().unwrap().len(), 500);
    }

    #[actix_web::test]
    async fn trace_activity_query_executes_with_distinct_bucketed_counts() {
        let rows = run_trace_activity_fixture(&["service.name".to_owned()], &[], "BIGINT").await;
        let mut summary = rows
            .iter()
            .map(|row| {
                (
                    row["time"].as_str().unwrap().to_owned(),
                    row["service.name"].as_str().unwrap().to_owned(),
                    row["span_count"].as_u64().unwrap(),
                    row["trace_count"].as_u64().unwrap(),
                )
            })
            .collect::<Vec<_>>();
        // Rows are ordered by bucket only; order groups within a bucket here.
        summary.sort();
        assert_eq!(
            summary,
            [
                ("2026-10-22T00:00:00".to_owned(), "cart".to_owned(), 1, 1),
                (
                    "2026-10-22T00:00:00".to_owned(),
                    "checkout".to_owned(),
                    2,
                    1
                ),
                (
                    "2026-10-22T00:01:00".to_owned(),
                    "checkout".to_owned(),
                    1,
                    1
                ),
            ]
        );

        let fields = ["span_status_code".to_owned()];
        let clauses = super::trace_activity_filter_clauses(
            &json!({ "filters": { "span_status_code": 2 } }),
            &fields,
        )
        .unwrap();
        // Status codes are integers in some trace datasets and Float64 in others.
        for status_type in ["BIGINT", "DOUBLE"] {
            let rows = run_trace_activity_fixture(&[], &clauses, status_type).await;
            assert_eq!(
                rows,
                [
                    json!({ "time": "2026-10-22T00:00:00", "span_count": 1, "trace_count": 1 }),
                    json!({ "time": "2026-10-22T00:01:00", "span_count": 1, "trace_count": 1 }),
                ],
                "{status_type}"
            );
        }
    }

    #[actix_web::test]
    async fn trace_activity_rejects_unknown_fields_and_quotes_filter_values() {
        let fields = vec!["service.name".to_owned(), "odd\"field".to_owned()];
        assert!(
            super::trace_activity_group_by(&json!({ "groupBy": ["missing"] }), &fields).is_err()
        );
        assert!(super::trace_activity_group_by(&json!({ "groupBy": [1] }), &fields).is_err());
        assert_eq!(
            super::trace_activity_group_by(&json!({}), &fields).unwrap(),
            Vec::<String>::new()
        );
        assert!(
            super::trace_activity_filter_clauses(
                &json!({ "filters": { "missing": "x" } }),
                &fields
            )
            .is_err()
        );
        assert!(
            super::trace_activity_filter_clauses(
                &json!({ "filters": { "service.name": ["x"] } }),
                &fields
            )
            .is_err()
        );
        let clauses = super::trace_activity_filter_clauses(
            &json!({ "filters": { "odd\"field": "it's", "service.name": null } }),
            &fields,
        )
        .unwrap();
        assert!(clauses.contains(&"\"odd\"\"field\" = 'it''s'".to_owned()));
        assert!(clauses.contains(&"\"service.name\" IS NULL".to_owned()));
        let query = trace_activity_query(
            "traces",
            "p_timestamp",
            "1 seconds",
            &trace_activity_test_range("2026-10-22T00:00:00Z", "2026-10-22T00:01:00Z"),
            &[],
            &clauses,
        );
        assert!(bounded_tool_sql(&query).is_ok());
    }

    #[actix_web::test]
    async fn trace_activity_requires_span_columns_and_uses_the_time_partition() {
        let fields =
            ["p_timestamp", "span_span_id", "span_trace_id", "event_time"].map(str::to_owned);
        let time_field = |fields: &[String], partition: Option<&str>| {
            super::trace_activity_time_field("traces", fields, partition.map(str::to_owned))
        };
        assert_eq!(time_field(&fields, None).unwrap(), "p_timestamp");
        assert_eq!(
            time_field(&fields, Some("event_time")).unwrap(),
            "event_time"
        );
        assert_eq!(
            time_field(&fields, Some("start_time")).unwrap_err(),
            "trace dataset `traces` is missing time field `start_time`"
        );
        for missing in ["span_span_id", "span_trace_id"] {
            let fields = fields
                .iter()
                .filter(|field| *field != missing)
                .cloned()
                .collect::<Vec<_>>();
            assert_eq!(
                time_field(&fields, None).unwrap_err(),
                format!("trace dataset `traces` is missing required field `{missing}`")
            );
        }
    }

    #[actix_web::test]
    async fn dataset_activity_summary_orders_truncates_and_reports_failures() {
        use super::DatasetActivity;
        let count = |name: &str, events| DatasetActivity::Count {
            name: name.to_owned(),
            events,
        };
        let error = |index: usize| DatasetActivity::Error {
            name: format!("broken-{index}"),
            message: "unavailable".to_owned(),
        };
        let summarize = |activity, limit| {
            super::summarize_dataset_activity(
                activity,
                limit,
                30,
                "logs",
                "2026-10-22T00:00:00Z",
                "2026-10-22T01:00:00Z",
            )
        };

        let summary = summarize(
            vec![
                count("b", 5),
                count("a", 5),
                count("c", 0),
                count("d", 9),
                DatasetActivity::Skipped,
                error(0),
            ],
            2,
        );
        assert_eq!(summary["status"], "resolved");
        assert_eq!(summary["selectedDatasets"], json!(["d", "a"]));
        assert_eq!(
            summary["datasets"],
            json!([
                { "name": "d", "eventsInRange": 9 },
                { "name": "a", "eventsInRange": 5 }
            ])
        );
        assert_eq!(summary["activeDatasetCount"], 3);
        assert_eq!(summary["truncated"], true);
        assert_eq!(summary["queriedDatasets"], 4);
        assert_eq!(summary["visibleDatasets"], 30);
        assert_eq!(summary["unavailableDatasets"].as_array().unwrap().len(), 1);

        let quiet = summarize(vec![count("a", 0), DatasetActivity::Skipped], 5);
        assert_eq!(quiet["status"], "not_found");
        assert_eq!(quiet["truncated"], false);

        let failed = summarize((0..25).map(error).chain([count("a", 0)]).collect(), 5);
        assert_eq!(failed["status"], "error");
        assert!(failed.get("datasets").is_none());
        assert_eq!(failed["queriedDatasets"], 1);
        assert_eq!(failed["unavailableDatasets"].as_array().unwrap().len(), 20);
    }

    #[actix_web::test]
    async fn trace_activity_bucket_interval_is_bounded() {
        assert_eq!(
            super::time_bucket_interval(
                &trace_activity_test_range("2026-10-22T00:00:00Z", "2026-10-22T01:00:00Z"),
                60
            ),
            "60 seconds"
        );
        assert_eq!(
            super::time_bucket_interval(
                &trace_activity_test_range("2026-10-22T00:00:00Z", "2026-10-22T00:00:30Z"),
                100
            ),
            "1 seconds"
        );
        // Subminute ranges size buckets from their exact, unrounded duration.
        assert_eq!(
            super::time_bucket_interval(
                &trace_activity_test_range("2026-10-22T00:00:10Z", "2026-10-22T00:00:50Z"),
                4
            ),
            "10 seconds"
        );
    }

    #[actix_web::test]
    async fn trace_activity_subminute_range_returns_exact_rows() {
        let summarize = |rows: Vec<Value>| {
            rows.iter()
                .map(|row| {
                    (
                        row["time"].as_str().unwrap().to_owned(),
                        row["span_count"].as_u64().unwrap(),
                    )
                })
                .collect::<Vec<_>>()
        };
        // Both bounds fall inside one minute; start inclusive, end exclusive,
        // buckets aligned to the requested start.
        let (interval, rows) = run_trace_activity_fixture_with(
            &json!({
                "startTime": "2026-10-22T00:00:15Z",
                "endTime": "2026-10-22T00:00:40Z",
            }),
            5,
            &[],
            &[],
            "BIGINT",
        )
        .await;
        assert_eq!(interval, "5 seconds");
        assert_eq!(
            summarize(rows),
            [
                ("2026-10-22T00:00:20".to_owned(), 1),
                ("2026-10-22T00:00:30".to_owned(), 1),
            ]
        );
        let (interval, rows) = run_trace_activity_fixture_with(
            &json!({
                "startTime": "2026-10-22T00:00:20Z",
                "endTime": "2026-10-22T00:00:30Z",
            }),
            1,
            &[],
            &[],
            "BIGINT",
        )
        .await;
        assert_eq!(interval, "10 seconds");
        assert_eq!(summarize(rows), [("2026-10-22T00:00:20".to_owned(), 1)]);
        // A range crossing a minute boundary keeps its exact edges too.
        let (interval, rows) = run_trace_activity_fixture_with(
            &json!({
                "startTime": "2026-10-22T00:00:35Z",
                "endTime": "2026-10-22T00:01:15Z",
            }),
            1,
            &[],
            &[],
            "BIGINT",
        )
        .await;
        assert_eq!(interval, "40 seconds");
        assert_eq!(summarize(rows), [("2026-10-22T00:00:35".to_owned(), 2)]);
    }

    #[actix_web::test]
    async fn trace_activity_request_validates_exact_ranges_and_widens_transport() {
        let now = "2026-10-22T00:00:30.123456Z"
            .parse::<DateTime<Utc>>()
            .unwrap();
        let range =
            super::trace_activity_range(&json!({"startTime": "now-15s", "endTime": "now"}), now)
                .unwrap();
        assert_eq!(range.start, now - Duration::seconds(15));
        assert_eq!(range.end, now);
        let query = trace_activity_query("traces", "p_timestamp", "1 seconds", &range, &[], &[]);
        assert!(query.contains(
            "\"p_timestamp\" >= TIMESTAMP '2026-10-22T00:00:15.123456+00:00' AND \"p_timestamp\" < TIMESTAMP '2026-10-22T00:00:30.123456+00:00'"
        ));
        assert!(query.contains("TIMESTAMP '2026-10-22T00:00:15.123456+00:00') AS TEXT)"));
        let request = super::trace_activity_request(&query, &range).unwrap();
        assert_eq!(request.start_time, "2026-10-22T00:00:00+00:00");
        assert_eq!(request.end_time, "2026-10-22T00:01:00+00:00");
        for (start, end) in [
            ("2026-10-22T00:00:30Z", "2026-10-22T00:00:30Z"),
            ("2026-10-22T00:00:30Z", "2026-10-22T00:00:15Z"),
            ("invalid", "now"),
            ("now-15s", "invalid"),
        ] {
            assert!(
                super::trace_activity_range(&json!({"startTime": start, "endTime": end}), now)
                    .is_err()
            );
        }
    }

    #[actix_web::test]
    async fn time_resolution_uses_local_day_boundaries_and_rejects_unknown_zones() {
        let reference = DateTime::parse_from_rfc3339("2026-10-01T12:00:00Z")
            .unwrap()
            .to_utc();
        let today = resolve_time_range_at(
            &json!({ "expression": "today", "timezone": "Asia/Kolkata" }),
            reference,
        )
        .unwrap();
        assert_eq!(today["startTime"], "2026-09-30T18:30:00+00:00");
        assert_eq!(today["endTime"], "2026-10-01T12:00:00+00:00");
        assert_eq!(today["timezone"], "Asia/Kolkata");
        let yesterday = resolve_time_range_at(
            &json!({ "expression": "yesterday", "timezone": "Asia/Kolkata" }),
            reference,
        )
        .unwrap();
        assert_eq!(yesterday["startTime"], "2026-09-29T18:30:00+00:00");
        assert_eq!(yesterday["endTime"], "2026-09-30T18:30:00+00:00");
        assert!(
            resolve_time_range_at(
                &json!({ "expression": "today", "timezone": "Mars/Base" }),
                reference
            )
            .is_err()
        );
    }

    #[actix_web::test]
    async fn sample_events_selects_at_most_ten_columns() {
        let fields = (0..15)
            .map(|index| format!("f{index}"))
            .chain(["p_timestamp".to_owned()])
            .collect::<Vec<_>>();
        let query =
            sample_events_query(&json!({ "dataset": "logs" }), &fields, Utc::now()).unwrap();
        let projection = query
            .query
            .strip_prefix("SELECT ")
            .and_then(|query| query.split_once(" FROM "))
            .unwrap()
            .0
            .split(", ")
            .collect::<Vec<_>>();
        assert_eq!(
            projection,
            [
                "\"p_timestamp\"",
                "\"f0\"",
                "\"f1\"",
                "\"f2\"",
                "\"f3\"",
                "\"f4\"",
                "\"f5\"",
                "\"f6\"",
                "\"f7\"",
                "\"f8\""
            ]
        );
        assert!(
            query
                .query
                .ends_with(" ORDER BY \"p_timestamp\" DESC LIMIT 10")
        );
    }

    #[actix_web::test]
    async fn time_resolution_rejects_durations_beyond_the_supported_range() {
        let reference = DateTime::parse_from_rfc3339("2026-10-01T12:00:00Z")
            .unwrap()
            .to_utc();
        for expression in ["last 1000000 years", "now-300000y"] {
            let error =
                resolve_time_range_at(&json!({ "expression": expression }), reference).unwrap_err();
            assert!(error.contains("too large"), "{expression}: {error}");
        }
    }

    #[actix_web::test]
    async fn sample_events_requires_both_explicit_range_bounds() {
        let fields = ["p_timestamp".to_owned()];
        for partial in [
            json!({ "dataset": "logs", "startTime": "2026-10-22T00:00:00Z" }),
            json!({ "dataset": "logs", "endTime": "2026-10-22T00:00:00Z" }),
        ] {
            assert!(sample_events_query(&partial, &fields, Utc::now()).is_err());
        }
    }

    #[actix_web::test]
    async fn log_error_query_preserves_subminute_ranges() {
        for time_column in ["p_timestamp", "event.time"] {
            for (start, end) in [
                ("2026-10-16T12:00:30Z", "2026-10-16T12:01:30Z"),
                ("2026-10-16T12:00:10Z", "2026-10-16T12:00:50Z"),
                ("2026-10-16T12:00:10.100Z", "2026-10-16T12:00:10.900Z"),
            ] {
                let start_at: DateTime<Utc> = start.parse().unwrap();
                let end_at: DateTime<Utc> = end.parse().unwrap();
                let inside = start_at + (end_at - start_at) / 2;
                let late = end_at - Duration::milliseconds(1);
                let context = datafusion::prelude::SessionContext::new();
                let fixture = context
                .sql(&format!(
                    "SELECT CAST(at AS TIMESTAMP) AS \"{time_column}\", 'ERROR' AS level, kind AS error_type{}
                     FROM (VALUES ('2026-10-16T12:00:00Z', 'before'),
                                  ('{start}', 'at-start'),
                                  ('{}', 'inside'),
                                  ('{}', 'late-inside'),
                                  ('{end}', 'at-end')) AS f(at, kind)",
                    if time_column != "p_timestamp" {
                        ", TIMESTAMP '2000-01-01T00:00:00Z' AS p_timestamp"
                    } else { "" },
                    inside.to_rfc3339(), late.to_rfc3339(),
                ))
                .await
                .unwrap();
                let fields = vec![
                    time_column.into(),
                    "p_timestamp".into(),
                    "level".into(),
                    "error_type".into(),
                ];
                let request = log_error_query_request(
                    "logs",
                    &fields,
                    time_column,
                    500,
                    &json!({"startTime": start, "endTime": end}),
                    start_at,
                )
                .unwrap();
                // Match the generic query API's minute-aligned transport filtering.
                let envelope = crate::utils::time::TimeRange::parse_human_time(
                    &request.start_time,
                    &request.end_time,
                )
                .unwrap();
                assert!(envelope.start <= start_at && envelope.end >= end_at);
                context
                    .register_table("raw_logs", fixture.into_view())
                    .unwrap();
                let fixture = context.sql(&format!(
                "SELECT * FROM raw_logs WHERE \"{time_column}\" >= TIMESTAMP '{}' AND \"{time_column}\" < TIMESTAMP '{}'",
                envelope.start.to_rfc3339(), envelope.end.to_rfc3339(),
            )).await.unwrap();
                context.register_table("logs", fixture.into_view()).unwrap();
                let result = context
                    .sql(&request.query)
                    .await
                    .unwrap()
                    .collect()
                    .await
                    .unwrap();
                let mut writer = arrow_json::ArrayWriter::new(Vec::new());
                writer
                    .write_batches(&result.iter().collect::<Vec<_>>())
                    .unwrap();
                writer.finish().unwrap();
                let rows: Vec<Value> = serde_json::from_slice(&writer.into_inner()).unwrap();
                let mut types = rows
                    .iter()
                    .map(|row| row["errorType"].as_str().unwrap())
                    .collect::<Vec<_>>();
                types.sort_unstable();
                assert_eq!(
                    types,
                    ["at-start", "inside", "late-inside"],
                    "{time_column}: {start}..{end}"
                );
                let latest = rows
                    .iter()
                    .find(|row| row["errorType"] == "late-inside")
                    .unwrap();
                assert_eq!(
                    chrono::NaiveDateTime::parse_from_str(
                        latest["lastSeen"].as_str().unwrap(),
                        "%Y-%m-%dT%H:%M:%S%.f",
                    )
                    .unwrap()
                    .and_utc(),
                    late
                );
            }
        }
    }

    #[actix_web::test]
    async fn log_error_query_validates_exact_ranges_and_resolves_relative_bounds_once() {
        let now = "2026-10-16T12:00:30.123456Z"
            .parse::<DateTime<Utc>>()
            .unwrap();
        let fields = vec!["p_timestamp".into(), "level".into()];
        let request = log_error_query_request(
            "logs",
            &fields,
            "p_timestamp",
            50,
            &json!({"startTime": "now-15s", "endTime": "now"}),
            now,
        )
        .unwrap();
        assert!(request.query.contains("2026-10-16T12:00:15.123456+00:00"));
        assert!(request.query.contains("2026-10-16T12:00:30.123456+00:00"));
        assert_eq!(request.start_time, "2026-10-16T12:00:00+00:00");
        assert_eq!(request.end_time, "2026-10-16T12:01:00+00:00");
        for (start, end) in [
            ("2026-10-16T12:00:30Z", "2026-10-16T12:00:30Z"),
            ("2026-10-16T12:00:30Z", "2026-10-16T12:00:15Z"),
            ("invalid", "now"),
            ("now-15s", "invalid"),
        ] {
            assert!(
                log_error_query_request(
                    "logs",
                    &fields,
                    "p_timestamp",
                    50,
                    &json!({"startTime": start, "endTime": end}),
                    now
                )
                .is_err()
            );
        }
    }

    #[actix_web::test]
    async fn log_error_query_uses_explicit_text_severity_not_message_substrings() {
        for field in [
            "level",
            "log_level",
            "severity",
            "severity_text",
            "severity_description",
        ] {
            let rows = run_log_error_fixture(&format!(
                "SELECT severity AS \"{field}\", message FROM (VALUES
                 ('info', '0 errors found'), (' error ', 'connection refused'),
                 ('fatal4', 'shutdown'), ('ERROR2', 'retry exhausted'),
                 ('warn', 'exception handled'), (NULL, 'panic not reproduced')) AS f(severity, message)"
            )).await;
            let mut messages = rows
                .iter()
                .map(|row| row["sampleMessage"].as_str().unwrap())
                .collect::<Vec<_>>();
            messages.sort_unstable();
            assert_eq!(
                messages,
                ["connection refused", "retry exhausted", "shutdown"],
                "{field}"
            );
        }
    }

    #[actix_web::test]
    async fn log_error_query_rejects_invalid_and_fractional_numeric_severities() {
        let rows = run_log_error_fixture(
            "SELECT severity_number, message FROM (VALUES
             ('17', 'error'), ('24', 'fatal'), ('25', 'out of range'),
             ('24.9', 'fractional'), ('garbage', 'invalid'), ('-1', 'negative'),
             ('50', 'not an otel code'), (NULL, 'unknown')) AS f(severity_number, message)",
        )
        .await;
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["occurrences"], 2);
        let rows = run_log_error_fixture(
            "SELECT level, message FROM (VALUES ('50', 'error'), ('60', 'fatal'),
             ('50.9', 'fractional'), ('17', 'otel only'), ('bad', 'bad')) AS f(level, message)",
        )
        .await;
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().all(|row| row["occurrences"] == 1));
    }

    #[actix_web::test]
    async fn log_error_query_checks_all_severity_columns_and_coalesces_row_aliases() {
        let rows = run_log_error_fixture(
            r#"SELECT level, severity_text, service_primary AS "service.name", service_name,
                exception_primary AS "exception.type", error_type AS "error.type", message, body
               FROM (VALUES ('info', 'ERROR', NULL, 'checkout', NULL, 'Timeout', NULL, 'refused'),
                            ('error', NULL, '', 'checkout', '', 'Timeout', '', 'refused'))
               AS f(level, severity_text, service_primary, service_name, exception_primary, error_type, message, body)"#
        ).await;
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["serviceName"], "checkout");
        assert_eq!(rows[0]["errorType"], "Timeout");
        assert_eq!(rows[0]["sampleMessage"], "refused");
        assert_eq!(rows[0]["occurrences"], 2);
    }

    #[actix_web::test]
    async fn log_error_query_labels_the_severity_that_actually_matched() {
        let rows = run_log_error_fixture(
            "SELECT 'info' AS level, ' error ' AS severity_text, 'refused' AS message",
        )
        .await;
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["errorType"], "ERROR");
        assert_eq!(rows[0]["occurrences"], 1);
    }

    #[actix_web::test]
    async fn log_error_query_requires_explicit_severity_and_escapes_identifiers() {
        for fields in [
            vec!["message"],
            vec!["body", "exception.type", "p_log_category"],
        ] {
            let fields = fields.into_iter().map(str::to_owned).collect::<Vec<_>>();
            assert!(
                list_log_errors_query("logs", &fields, 5, "p_timestamp", &log_error_test_range())
                    .unwrap_err()
                    .contains("explicit severity")
            );
        }
        let query = list_log_errors_query(
            "app\"logs",
            &["level".to_owned()],
            999,
            "p_timestamp",
            &log_error_test_range(),
        )
        .unwrap();
        assert!(query.contains("FROM \"app\"\"logs\""));
        assert!(query.ends_with("LIMIT 500"));
    }

    #[actix_web::test]
    async fn schema_tool_preserves_json_default_and_offers_compact_format() {
        let schema = arrow_schema::Schema::new(vec![arrow_schema::Field::new(
            "message",
            arrow_schema::DataType::Utf8,
            true,
        )]);
        let expected = serde_json::to_value(&schema).unwrap();
        assert_eq!(
            super::schema_tool_result(&schema, &json!({})).unwrap(),
            expected
        );
        assert_eq!(
            super::schema_tool_result(&schema, &json!({"format": "json"})).unwrap(),
            expected
        );
        assert_eq!(
            super::schema_tool_result(&schema, &json!({"format": "compact"})).unwrap(),
            json!("name\ttype\nmessage\tUtf8\n")
        );
        for format in [json!("xml"), json!(null), json!(1)] {
            assert!(super::schema_tool_result(&schema, &json!({"format": format})).is_err());
        }
    }

    #[actix_web::test]
    async fn invocation_endpoint_requires_authentication() {
        let app =
            test::init_service(App::new().route("/tools/call", web::post().to(call_tool_registry)))
                .await;
        let request = test::TestRequest::post()
            .uri("/tools/call")
            .set_json(json!({ "name": "list_datasets", "arguments": {} }))
            .to_request();
        let response = test::call_service(&app, request).await;

        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[actix_web::test]
    async fn arguments_must_be_an_object() {
        let app =
            test::init_service(App::new().route("/tools/call", web::post().to(call_tool_registry)))
                .await;
        let request = test::TestRequest::post()
            .uri("/tools/call")
            .set_json(json!({ "name": "list_datasets", "arguments": [] }))
            .to_request();
        let response: Value = test::call_and_read_body_json(&app, request).await;

        assert!(
            response["isError"]
                .as_bool()
                .expect("isError must be a boolean")
        );
        assert_eq!(response["content"][0]["type"], "text");
        assert_eq!(
            response["content"][0]["text"],
            "tool arguments must be a JSON object"
        );
    }
}
