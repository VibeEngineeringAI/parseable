// SPDX-License-Identifier: AGPL-3.0-or-later
//! Explicit, read-only dashboard execution. Configuration validation never calls this module.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

use actix_web::{HttpRequest, HttpResponse, web::Json};
use chrono::DateTime;
use futures_util::{StreamExt, stream};
use once_cell::sync::Lazy;
use regex::{Captures, Regex};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::Semaphore;

use crate::handlers::http::{
    promql,
    query::{self, Query},
    users::dashboards::DashboardError,
};
use crate::users::{
    dashboard_patch::{self, DashboardOperation},
    dashboard_service,
    dashboards::validate_dashboard_id,
};
use crate::utils::{
    actix::extract_session_key_from_req, arrow::record_batches_to_json, get_tenant_id_from_request,
};
use crate::{
    handlers::http::middleware,
    rbac::{Response, Users, role::Action},
};

const MAX_BYTES: usize = 1024 * 1024;
const MAX_TILES: usize = 32;
const MAX_QUERY_BYTES: usize = 16 * 1024;
const MAX_RANGE_MS: i64 = 31 * 86400 * 1000;
static PREVIEW_SLOTS: Lazy<Arc<Semaphore>> = Lazy::new(|| Arc::new(Semaphore::new(16)));
static SQL_SLOTS: Lazy<Arc<Semaphore>> = Lazy::new(|| Arc::new(Semaphore::new(8)));
static TOKENS: Lazy<Regex> = Lazy::new(|| Regex::new(r"\$\{?([A-Za-z0-9_]+)\}?").unwrap());
static SQL_TOKENS: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"--[^\n]*|/\*[\s\S]*?\*/|'(?:''|[^'])*'|"(\$\{?([A-Za-z0-9_]+)\}?)"|\$\{?([A-Za-z0-9_]+)\}?"#).unwrap()
});
static ALL_MATCHER: Lazy<Regex> = Lazy::new(|| Regex::new(r#"(^|[^!=<>])=\s*"\.\*""#).unwrap());
type Values = BTreeMap<String, Value>;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PreviewRequest {
    dashboard_id: Option<String>,
    document: Option<Value>,
    #[serde(default)]
    operations: Vec<DashboardOperation>,
    revision: Option<String>,
    tile_ids: Option<Vec<String>>,
    start_time: String,
    end_time: String,
    #[serde(default)]
    variables: Values,
    row_limit: Option<usize>,
}

fn bad(message: impl Into<String>) -> DashboardError {
    DashboardError::api(400, "INVALID_PREVIEW", message, json!({}))
}
fn text(value: &Value) -> &str {
    value.as_str().unwrap_or("")
}
fn id(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}
fn literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}
fn array(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn selection(value: &Value) -> Vec<&str> {
    match value {
        Value::String(value) => vec![value],
        Value::Array(values) => values.iter().filter_map(Value::as_str).collect(),
        _ => vec![],
    }
}
fn first(value: &Value) -> Option<&str> {
    selection(value).into_iter().next()
}
fn number_string(number: &serde_json::Number) -> Result<String, String> {
    let value = number.as_f64().ok_or("Unsupported numeric filter")?;
    if value.abs() > 9_007_199_254_740_991.0 {
        return Err(
            "Numeric builder filters outside JavaScript's safe range are unsupported".into(),
        );
    }
    Ok(if value == 0.0 {
        "0".into()
    } else if value.fract() == 0.0 {
        format!("{value:.0}")
    } else {
        value.to_string()
    })
}
fn integer(value: &Value) -> Option<u64> {
    value
        .as_f64()
        .filter(|v| *v >= 0.0 && *v <= 9_007_199_254_740_991.0 && v.fract() == 0.0)
        .map(|v| v as u64)
}
fn token_name(value: &str) -> Option<&str> {
    let capture = TOKENS.captures(value)?;
    (capture.get(0)?.as_str() == value).then(|| capture.get(1).unwrap().as_str())
}
fn dataset_names(definitions: &[Value]) -> BTreeSet<&str> {
    definitions
        .iter()
        .filter(|v| v["type"] == "dataset")
        .filter_map(|v| v["name"].as_str())
        .collect()
}
fn interpolate_sql(source: &str, values: &Values, definitions: &[Value]) -> String {
    let datasets = dataset_names(definitions);
    let dataset = |name: &str| {
        values
            .get(name)
            .and_then(first)
            .filter(|s| !s.is_empty())
            .map(id)
    };
    SQL_TOKENS
        .replace_all(source, |caps: &Captures<'_>| {
            let token = &caps[0];
            if token.starts_with("--") || token.starts_with("/*") {
                return token.to_owned();
            }
            if token.starts_with('\'') {
                let contents = &token[1..token.len() - 1];
                if let Some(name) = token_name(contents).filter(|name| !datasets.contains(name)) {
                    if let Some(value) = values.get(name) {
                        let selected = selection(value);
                        if !selected.is_empty() {
                            return selected
                                .into_iter()
                                .map(literal)
                                .collect::<Vec<_>>()
                                .join(",");
                        }
                    }
                    return token.to_owned();
                }
                return format!(
                    "'{}'",
                    TOKENS.replace_all(contents, |part: &Captures<'_>| {
                        let name = &part[1];
                        let value = if datasets.contains(name) {
                            dataset(name)
                        } else {
                            values.get(name).and_then(first).map(str::to_owned)
                        };
                        value
                            .map(|v| v.replace('\'', "''"))
                            .unwrap_or_else(|| part[0].to_owned())
                    })
                );
            }
            let name = caps.get(3).or_else(|| caps.get(2)).unwrap().as_str();
            if datasets.contains(name) {
                return dataset(name).unwrap_or_else(|| token.to_owned());
            }
            let Some(value) = values.get(name) else {
                return token.to_owned();
            };
            let selected = selection(value);
            if selected.is_empty() {
                return token.to_owned();
            }
            if caps.get(2).is_some() {
                selected.into_iter().map(id).collect::<Vec<_>>().join(",")
            } else {
                selected.join(",")
            }
        })
        .into_owned()
}
fn prom_escape(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
        .replace('\t', "\\t")
}
fn regex_escape(value: &str) -> String {
    value
        .chars()
        .flat_map(|c| {
            if ".*+?^${}()|[]\\".contains(c) {
                vec!['\\', c]
            } else {
                vec![c]
            }
        })
        .collect()
}
fn interpolate_promql(source: &str, values: &Values) -> String {
    let result = TOKENS.replace_all(source, |caps: &Captures<'_>| match values.get(&caps[1]) {
        Some(Value::String(value)) => prom_escape(value),
        Some(Value::Array(items)) if !items.is_empty() => format!(
            "({})",
            items
                .iter()
                .filter_map(Value::as_str)
                .map(|s| prom_escape(&regex_escape(s)))
                .collect::<Vec<_>>()
                .join("|")
        ),
        _ => caps[0].to_owned(),
    });
    ALL_MATCHER
        .replace_all(&result, "${1}=~\".*\"")
        .into_owned()
}
fn resolve_dataset(source: &str, values: &Values) -> String {
    let result = TOKENS
        .replace_all(source, |caps: &Captures<'_>| match values.get(&caps[1]) {
            Some(Value::String(s)) => s.clone(),
            Some(Value::Array(items)) if !items.is_empty() => format!(
                "({})",
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join("|")
            ),
            _ => caps[0].to_owned(),
        })
        .into_owned();
    if token_name(&result).is_some() {
        String::new()
    } else {
        result
    }
}
fn tile_dataset(tile: &Value) -> &str {
    tile["dbName"]
        .as_str()
        .or_else(|| tile["dbName"].get(0).and_then(Value::as_str))
        .unwrap_or("")
}

/// Frontend legacySql.ts conversion, with explicit errors for unsupported legacy shapes.
fn sql_query(tile: &Value) -> Result<String, String> {
    let query = &tile["chartQuery"];
    if let Some(sql) = query
        .as_str()
        .or_else(|| query["query"].as_str())
        .or_else(|| query["sql"].as_str())
    {
        return Ok(sql.to_owned());
    }
    if !query.is_object() {
        return Err("This tile has no SQL query".into());
    }
    legacy_sql(tile, query)
}
fn legacy_sql(tile: &Value, query: &Value) -> Result<String, String> {
    let unsupported = |part: &str| {
        format!(
            "This legacy {part} cannot be converted faithfully to SQL. Open it in the classic UI."
        )
    };
    let dataset = tile_dataset(tile);
    if dataset.is_empty() {
        return Err(unsupported("query with no dataset"));
    }
    let x = &query["x"];
    let y = &query["y"];
    for axis in [x, y] {
        if !axis["fields"].is_null() && !axis["fields"].is_array() {
            return Err(unsupported("fields"));
        }
        if !axis["groupBy"].is_null()
            && (!axis["groupBy"].is_array()
                || array(&axis["groupBy"]).iter().any(|v| !v.is_string()))
        {
            return Err(unsupported("grouping"));
        }
    }
    let xs = array(&x["fields"]);
    let ys = array(&y["fields"]);
    let stat = ["query-value", "gauge"].contains(&text(&tile["chartType"]));
    let timeseries = tile["chartType"] == "timeseries";
    if stat && ys.first().is_none_or(|v| text(&v["aggregate"]).is_empty()) {
        return Err(unsupported("aggregate"));
    }
    // Ordered maps reproduce JavaScript Map insertion/overwrite behavior.
    let mut expressions: Vec<(String, String)> = vec![];
    let mut groups: Vec<String> = vec![];
    let mut aliases = BTreeMap::new();
    fn set(rows: &mut Vec<(String, String)>, key: String, value: String) {
        if let Some(row) = rows.iter_mut().find(|row| row.0 == key) {
            row.1 = value;
        } else {
            rows.push((key, value));
        }
    }
    fn group(groups: &mut Vec<String>, value: &str) {
        if !groups.iter().any(|v| v == value) {
            groups.push(value.into());
        }
    }
    if timeseries && xs.first().is_some_and(|v| !text(&v["name"]).is_empty()) {
        let grain = x["granularity"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or("minute");
        if ![
            "second", "minute", "hour", "day", "week", "month", "quarter", "year",
        ]
        .contains(&grain)
        {
            return Err(unsupported("granularity"));
        }
        set(
            &mut expressions,
            "time_bucket".into(),
            format!(
                "DATE_TRUNC({}, {}) AS {}",
                literal(grain),
                id(text(&xs[0]["name"])),
                id("time_bucket")
            ),
        );
        group(&mut groups, "time_bucket");
    }
    if !stat {
        for field in xs {
            let name = text(&field["name"]);
            if name.is_empty() {
                return Err(unsupported("field"));
            }
            if timeseries
                && name == text(&xs[0]["name"])
                && field["aggregate"].as_str().is_none_or(str::is_empty)
            {
                continue;
            }
            set(
                &mut expressions,
                name.into(),
                format!("{} AS {}", id(name), id(name)),
            );
            group(&mut groups, name);
        }
    }
    let group_by: Vec<&str> = array(&x["groupBy"])
        .iter()
        .chain(array(&y["groupBy"]))
        .filter_map(Value::as_str)
        .collect();
    if stat {
        for name in &group_by {
            set(
                &mut expressions,
                (*name).into(),
                format!("{} AS {}", id(name), id(name)),
            );
        }
    }
    for field in ys.iter().take(if stat { 1 } else { ys.len() }) {
        let name = text(&field["name"]);
        let aggregate = text(&field["aggregate"]).to_uppercase();
        if aggregate.is_empty() {
            continue;
        }
        if name.is_empty()
            || !["COUNT", "SUM", "AVG", "MIN", "MAX", "COUNT(DISTINCT)"]
                .contains(&aggregate.as_str())
        {
            return Err(unsupported("aggregate"));
        }
        let star = aggregate == "COUNT" && ["All rows (*)", "*"].contains(&name);
        let alias = if star {
            "COUNT_STAR".into()
        } else {
            format!("{aggregate}_{name}")
        };
        let value = if star { "*".into() } else { id(name) };
        let expression = if aggregate == "COUNT(DISTINCT)" {
            format!("COUNT(DISTINCT {value})")
        } else {
            format!("{aggregate}({value})")
        };
        set(
            &mut expressions,
            alias.clone(),
            format!("{expression} AS {}", id(&alias)),
        );
        aliases.insert(name, alias);
    }
    for name in group_by {
        if !expressions.iter().any(|v| v.0 == name) {
            set(
                &mut expressions,
                name.into(),
                format!("{} AS {}", id(name), id(name)),
            );
        }
        group(&mut groups, name);
    }
    let mut order = vec![];
    let sort = if !y["sortBy"].is_null() {
        &y["sortBy"]
    } else {
        &x["sortBy"]
    };
    if !stat && sort.as_object().is_some_and(|v| !v.is_empty()) {
        let field = text(&sort["field"]);
        let direction = text(&sort["direction"]);
        if field.is_empty() || !["ASC", "DESC"].contains(&direction) {
            return Err(unsupported("sort"));
        }
        let alias = aliases.get(field).map(String::as_str).unwrap_or(field);
        if !expressions.iter().any(|v| v.0 == alias) {
            set(
                &mut expressions,
                alias.into(),
                format!("{} AS {}", id(field), id(alias)),
            );
        }
        order.push(format!("{} {direction}", id(alias)));
    } else if timeseries && !stat {
        order.push(format!("{} DESC", id("time_bucket")));
    }
    let mut filters = vec![];
    if !query["filters"].is_null() && !query["filters"].is_array() {
        return Err(unsupported("filter"));
    }
    for filter in array(&query["filters"]) {
        let column = text(&filter["column"]);
        let operator = text(&filter["operator"]).trim().to_lowercase();
        if column.is_empty()
            || ![
                "=",
                "!=",
                "<>",
                "<",
                ">",
                "<=",
                ">=",
                "is null",
                "is not null",
            ]
            .contains(&operator.as_str())
            || text(&filter["type"]).starts_with("list")
        {
            return Err(unsupported("filter"));
        }
        let values = if operator.contains("null") {
            vec![Value::Null]
        } else {
            filter["value"]
                .as_array()
                .cloned()
                .unwrap_or_else(|| vec![filter["value"].clone()])
        };
        let mut seen = BTreeSet::new();
        let mut predicates = vec![];
        for value in values {
            let key = if let Some(s) = value.as_str() {
                s.to_owned()
            } else if let Some(number) = value.as_number() {
                number_string(number)?
            } else {
                value.to_string()
            };
            if !seen.insert(key) {
                continue;
            }
            let name = id(&column.replace('`', ""));
            if value.is_null() {
                // Missing values are not explicit SQL NULL in the frontend converter.
                if !operator.contains("null") && filter.get("value").is_none() {
                    return Err(unsupported("filter"));
                }
                predicates.push(format!(
                    "{name} IS {}NULL",
                    if ["!=", "<>", "is not null"].contains(&operator.as_str()) {
                        "NOT "
                    } else {
                        ""
                    }
                ));
            } else {
                let value = match value {
                    Value::String(s) => literal(&s),
                    Value::Number(n) => number_string(&n)?,
                    Value::Bool(b) => b.to_string(),
                    _ => return Err(unsupported("filter")),
                };
                predicates.push(format!("{name} {} {value}", operator.to_uppercase()));
            }
        }
        if !predicates.is_empty() {
            filters.push(if predicates.len() > 1 {
                format!("({})", predicates.join(" OR "))
            } else {
                predicates.remove(0)
            });
        }
    }
    if expressions.is_empty() {
        return Err(unsupported("query"));
    }
    if !stat && !y["limit"].is_null() && integer(&y["limit"]).is_none_or(|v| v < 1) {
        return Err(unsupported("limit"));
    }
    let mut sql = format!(
        "SELECT {} FROM {}",
        expressions
            .into_iter()
            .map(|v| v.1)
            .collect::<Vec<_>>()
            .join(", "),
        id(dataset)
    );
    if !filters.is_empty() {
        sql.push_str(&format!(" WHERE {}", filters.join(" AND ")));
    }
    if !groups.is_empty() {
        sql.push_str(&format!(
            " GROUP BY {}",
            groups.iter().map(|v| id(v)).collect::<Vec<_>>().join(", ")
        ));
    }
    if !order.is_empty() {
        sql.push_str(&format!(" ORDER BY {}", order.join(", ")));
    }
    if !stat {
        if let Some(limit) = integer(&y["limit"]) {
            sql.push_str(&format!(" LIMIT {limit}"));
        }
    }
    Ok(sql)
}

fn promql_queries(tile: &Value) -> Vec<(String, String)> {
    let chart = &tile["chartQuery"];
    let legacy = &tile["promqlQuery"];
    let queries = if let Some(query) = chart.as_str() {
        vec![query.to_owned()]
    } else if let Some(queries) = chart.as_array().filter(|v| v.iter().all(Value::is_string)) {
        queries.iter().map(|v| text(v).to_owned()).collect()
    } else {
        legacy["query"]
            .as_str()
            .or_else(|| chart["query"].as_str())
            .map(|q| vec![q.to_owned()])
            .unwrap_or_default()
    };
    queries
        .into_iter()
        .enumerate()
        .map(|(index, query)| {
            let mode = if tile["promqlQueryType"].is_array() {
                text(&tile["promqlQueryType"][index])
            } else {
                let value = tile
                    .get("promqlQueryType")
                    .filter(|v| !v.is_null())
                    .or_else(|| legacy.get("type").or_else(|| chart.get("type")));
                value.and_then(Value::as_str).unwrap_or("")
            };
            (
                query,
                if ["instant", "both"].contains(&mode) {
                    mode
                } else {
                    "range"
                }
                .into(),
            )
        })
        .collect()
}
fn query_modes(tile: &Value, index: usize, mode: &str) -> (bool, bool) {
    let stat = ["query-value", "gauge", "pie", "donut"].contains(&text(&tile["chartType"]));
    let spark = index == 0
        && tile["chartType"] == "query-value"
        && tile.pointer("/config/layout/sparkline") == Some(&Value::Bool(true));
    (
        spark || (!stat && mode != "instant"),
        stat || mode != "range",
    )
}
fn query_bounds(
    start: &str,
    end: &str,
    row_limit: Option<usize>,
) -> Result<(i64, i64, usize), String> {
    let start = DateTime::parse_from_rfc3339(start)
        .map_err(|_| "startTime must be RFC3339")?
        .timestamp_millis();
    let end = DateTime::parse_from_rfc3339(end)
        .map_err(|_| "endTime must be RFC3339")?
        .timestamp_millis();
    if start < 0 || end < start || end - start > MAX_RANGE_MS {
        return Err("Preview range must be ordered and at most 31 days".into());
    }
    let limit = row_limit.unwrap_or(100);
    if !(1..=500).contains(&limit) {
        return Err("rowLimit must be between 1 and 500".into());
    }
    Ok((start, end, limit))
}
fn parse_duration(source: &str) -> Option<f64> {
    let source = source.trim();
    if let Ok(value) = source.parse::<f64>() {
        return value.is_finite().then_some(value);
    }
    let pattern = Regex::new(r"([0-9]+)(ms|[ywdhms])").unwrap();
    let mut total = 0.0;
    let mut previous = f64::INFINITY;
    let mut offset = 0;
    for cap in pattern.captures_iter(source) {
        let m = cap.get(0)?;
        if m.start() != offset {
            return None;
        }
        let scale = match &cap[2] {
            "y" => 31536000.,
            "w" => 604800.,
            "d" => 86400.,
            "h" => 3600.,
            "m" => 60.,
            "s" => 1.,
            "ms" => 0.001,
            _ => return None,
        };
        if scale >= previous {
            return None;
        }
        previous = scale;
        total += cap[1].parse::<f64>().ok()? * scale;
        offset = m.end();
    }
    (offset == source.len() && offset > 0 && total.is_finite()).then_some(total)
}
fn tile_step(tile: &Value, start: i64, end: i64, query: &str) -> Result<i64, String> {
    let stored = tile
        .get("promqlStep")
        .filter(|v| !v.is_null())
        .or_else(|| tile["promqlQuery"].get("step"))
        .filter(|v| !v.is_null())
        .or_else(|| tile["chartQuery"].get("step"));
    if let Some(value) = stored {
        let seconds = value
            .as_f64()
            .or_else(|| value.as_str().and_then(parse_duration));
        if let Some(seconds) = seconds.filter(|v| *v > 0. && v.is_finite()) {
            let ms = (seconds * 1000.).floor();
            if ms < 1. || ms > MAX_RANGE_MS as f64 {
                return Err("Step must be between 1ms and 31d".into());
            }
            return Ok(ms as i64);
        }
    }
    let max_dp = tile
        .pointer("/config/maxDataPoints")
        .or_else(|| tile.pointer("/config/layout/maxDataPoints"))
        .and_then(|v| {
            v.as_f64()
                .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
        })
        .filter(|v| *v > 0. && v.is_finite())
        .unwrap_or(500.);
    let range = ((end - start) as f64 / 1000.).max(1.);
    let mut window = f64::INFINITY;
    let mut code = String::new();
    let mut quote = None;
    let mut comment = false;
    let mut escaped = false;
    for c in query.chars() {
        if comment {
            code.push(' ');
            if c == '\n' {
                comment = false;
            }
        } else if let Some(q) = quote {
            code.push(' ');
            if escaped {
                escaped = false;
            } else if c == '\\' && q != '`' {
                escaped = true;
            } else if c == q {
                quote = None;
            }
        } else if ['"', '\'', '`'].contains(&c) {
            quote = Some(c);
            code.push(' ');
        } else if c == '#' {
            comment = true;
            code.push(' ');
        } else {
            code.push(c);
        }
    }
    let windows = Regex::new(r"\[([^\[\]]+)\]").unwrap();
    for cap in windows.captures_iter(&code) {
        if let Some(duration) = parse_duration(&cap[1]).filter(|v| *v > 0.) {
            window = window.min((duration / 4.).floor());
        }
    }
    let steps = [
        1., 2., 5., 10., 15., 30., 60., 120., 300., 600., 900., 1800., 3600., 7200., 14400.,
        21600., 43200., 86400.,
    ];
    let snap = |s: f64| {
        steps
            .iter()
            .copied()
            .find(|v| *v >= s)
            .unwrap_or_else(|| (s / 86400.).ceil() * 86400.)
    };
    let mut step = snap(((range / max_dp).ceil().max(15.)).min(window).max(1.));
    if range / step > 3000. {
        step = snap((range / 3000.).ceil());
    }
    Ok((step * 1000.) as i64)
}

fn bounded_sql(sql: &str, limit: usize) -> String {
    // A trailing SQL line comment must end before the wrapper's closing syntax.
    format!(
        "SELECT * FROM (\n{}\n) AS {} LIMIT {limit}",
        sql.trim().trim_end_matches(';'),
        id("__dashboard_preview")
    )
}

async fn sql_rows(
    req: &HttpRequest,
    sql: &str,
    start: &str,
    end: &str,
    limit: usize,
) -> Result<Vec<serde_json::Map<String, Value>>, String> {
    let _permit = SQL_SLOTS
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| "SQL preview service unavailable")?;
    if sql.len() > MAX_QUERY_BYTES {
        return Err("SQL query exceeds 16 KiB".into());
    }
    if sql.trim().is_empty() {
        return Err("This tile has no SQL query".into());
    }
    let creds = extract_session_key_from_req(req).map_err(|e| e.to_string())?;
    let tenant = get_tenant_id_from_request(req);
    let query = Query {
        query: bounded_sql(sql, limit),
        start_time: start.into(),
        end_time: end.into(),
        send_null: true,
        fields: false,
        streaming: false,
        filter_tags: None,
    };
    // This path resolves referenced datasets and calls user_auth_for_datasets
    // using the caller's real session; it never uses the authorized-query bypass.
    let (records, _) = query::get_records_and_fields(&query, &creds, &tenant)
        .await
        .map_err(|e| e.to_string())?;
    let rows = record_batches_to_json(&records.unwrap_or_default()).map_err(|e| e.to_string())?;
    if rows.len() > limit {
        return Err("Query engine exceeded preview row bound".into());
    }
    if serde_json::to_vec(&rows).map_err(|e| e.to_string())?.len() > MAX_BYTES {
        return Err("Preview rows exceed 1 MiB; narrow the query".into());
    }
    Ok(rows)
}
fn dependencies(source: &str, definitions: &[Value]) -> BTreeSet<String> {
    let names: BTreeSet<&str> = definitions
        .iter()
        .filter_map(|v| v["name"].as_str())
        .collect();
    TOKENS
        .captures_iter(source)
        .map(|v| v[1].to_owned())
        .filter(|n| names.contains(n.as_str()))
        .collect()
}
fn variable_source(variable: &Value) -> String {
    match text(&variable["type"]) {
        "sql" => text(&variable["sqlQuery"]).into(),
        "promql_query" => format!(
            "{} {}",
            text(&variable["promqlQuery"]),
            text(&variable["promqlQueryDataset"])
        ),
        "promql" => format!(
            "{} {}",
            text(&variable["dataset"]),
            variable["labelFilters"]
        ),
        _ => String::new(),
    }
}
fn select_variable_default(variable: &Value, options: &[String]) -> Result<String, String> {
    if options.iter().any(|value| value.len() > 4096)
        || text(&variable["defaultValue"]).len() > 4096
    {
        return Err(
            "Resolved variable selection exceeds 4096 bytes; provide a bounded explicit selection"
                .into(),
        );
    }
    let default = text(&variable["defaultValue"]);
    if !default.is_empty() {
        if options.iter().any(|value| value == default) {
            return Ok(default.to_owned());
        }
        if matches!(text(&variable["type"]), "sql" | "promql_query") {
            return Err("Saved variable default was not found in bounded query options; provide an explicit selection".into());
        }
    }
    Ok(options.first().cloned().unwrap_or_default())
}

async fn resolve_variables(
    req: &HttpRequest,
    definitions: &[Value],
    mut needed: BTreeSet<String>,
    values: &mut Values,
    start: &str,
    end: &str,
    end_ms: i64,
) -> BTreeMap<String, String> {
    loop {
        let mut added = false;
        for variable in definitions {
            if needed.contains(text(&variable["name"]))
                && !values.contains_key(text(&variable["name"]))
            {
                for dependency in dependencies(&variable_source(variable), definitions) {
                    added |= needed.insert(dependency);
                }
            }
        }
        if !added {
            break;
        }
    }
    let mut pending: Vec<&Value> = definitions
        .iter()
        .filter(|v| needed.contains(text(&v["name"])) && !values.contains_key(text(&v["name"])))
        .collect();
    let mut errors = BTreeMap::new();
    while !pending.is_empty() {
        let mut progressed = false;
        let mut next = vec![];
        for variable in pending {
            let name = text(&variable["name"]);
            if dependencies(&variable_source(variable), definitions)
                .iter()
                .any(|dep| !values.contains_key(dep))
            {
                next.push(variable);
                continue;
            }
            progressed = true;
            let kind = text(&variable["type"]);
            let mut options: Vec<String> = vec![];
            let result: Result<(), String> = match kind {
                "text" => {
                    values.insert(
                        name.into(),
                        json!(variable["defaultValue"].as_str().unwrap_or("")),
                    );
                    Ok(())
                }
                "list" => {
                    options = array(&variable["options"])
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect();
                    Ok(())
                }
                "sql" => {
                    let sql = interpolate_sql(text(&variable["sqlQuery"]), values, definitions);
                    match sql_rows(req, &sql, start, end, 500).await {
                        Ok(rows) => {
                            options = rows
                                .into_iter()
                                .filter_map(|row| row.into_iter().next().map(|(_, v)| v))
                                .filter(|v| !v.is_null())
                                .map(|v| {
                                    v.as_str()
                                        .map(str::to_owned)
                                        .unwrap_or_else(|| v.to_string())
                                })
                                .collect();
                            Ok(())
                        }
                        Err(e) => Err(e),
                    }
                }
                "promql_query" => {
                    let stream = resolve_dataset(text(&variable["promqlQueryDataset"]), values);
                    let query = interpolate_promql(text(&variable["promqlQuery"]), values);
                    match promql::dashboard_query(req, &stream, &query, end_ms, end_ms, None).await
                    {
                        Ok(result) => {
                            let label = text(&variable["promqlQueryLabel"]);
                            options = match text(&result["resultType"]) {
                                "vector" => array(&result["result"])
                                    .iter()
                                    .filter_map(|row| {
                                        if label.is_empty() {
                                            row["value"].get(1).and_then(Value::as_str)
                                        } else {
                                            row["metric"].get(label).and_then(Value::as_str)
                                        }
                                    })
                                    .map(str::to_owned)
                                    .collect(),
                                "matrix" => array(&result["result"])
                                    .iter()
                                    .filter_map(|row| {
                                        if label.is_empty() {
                                            array(&row["values"])
                                                .last()
                                                .and_then(|v| v.get(1))
                                                .and_then(Value::as_str)
                                        } else {
                                            row["metric"].get(label).and_then(Value::as_str)
                                        }
                                    })
                                    .map(str::to_owned)
                                    .collect(),
                                _ => result["result"]
                                    .get(1)
                                    .and_then(Value::as_str)
                                    .map(|v| vec![v.to_owned()])
                                    .unwrap_or_default(),
                            };
                            Ok(())
                        }
                        Err(e) => Err(e.to_string()),
                    }
                }
                "dataset" | "promql" => Err(format!(
                    "Variable {name} requires an explicit selection in preview; dataset-list and label metadata discovery are not executed"
                )),
                _ => Err(format!("Unsupported variable type for {name}")),
            };
            if let Err(error) = result {
                errors.insert(name.into(), error);
                continue;
            }
            if kind == "text" {
                continue;
            }
            let mut seen = BTreeSet::new();
            options.retain(|v| seen.insert(v.clone()));
            if variable["includeAll"] == true {
                options.insert(0, if kind == "promql_query" { ".*" } else { "*" }.into());
            }
            let selected = match select_variable_default(variable, &options) {
                Ok(selected) => selected,
                Err(error) => {
                    errors.insert(name.into(), error);
                    continue;
                }
            };
            values.insert(name.into(), json!(selected));
        }
        if !progressed {
            for variable in next {
                errors
                    .entry(text(&variable["name"]).into())
                    .or_insert_with(|| {
                        "Variable dependencies contain a cycle or an unresolved dependency".into()
                    });
            }
            break;
        }
        pending = next;
    }
    errors
}
fn trim_promql(result: &mut Value, limit: usize) -> bool {
    let mut truncated = false;
    if let Some(series) = result["result"].as_array_mut() {
        // Scalars are a [timestamp,string] pair, not a series list.
        if series.first().is_some_and(Value::is_object) {
            if series.len() > limit {
                series.truncate(limit);
                truncated = true;
            }
            for row in series {
                if let Some(points) = row["values"].as_array_mut() {
                    if points.len() > limit {
                        let keep = points.len() - limit;
                        points.drain(..keep);
                        truncated = true;
                    }
                }
            }
        }
    }
    truncated
}
async fn execute_tile(
    req: &HttpRequest,
    tile: &Value,
    definitions: &[Value],
    values: &Values,
    start: &str,
    end: &str,
    start_ms: i64,
    end_ms: i64,
    limit: usize,
) -> Result<Value, String> {
    let source = format!(
        "{} {} {}",
        tile["chartQuery"], tile["promqlQuery"], tile["dbName"]
    );
    for name in dependencies(&source, definitions) {
        if values.get(&name).is_none_or(|v| selection(v).is_empty()) {
            return Err(format!("Select values for query variable {name}"));
        }
    }
    let kind = text(&tile["tileType"]);
    if !["", "builder", "code", "promql"].contains(&kind) {
        return Err("Unsupported tile type".into());
    }
    if kind != "promql" {
        let sql = interpolate_sql(&sql_query(tile)?, values, definitions);
        return Ok(json!({"rows":sql_rows(req,&sql,start,end,limit).await?}));
    }
    let dataset = resolve_dataset(tile_dataset(tile), values);
    if dataset.is_empty() {
        return Err("Select a dataset for this tile".into());
    }
    let queries = promql_queries(tile);
    if queries.is_empty() {
        return Err("This tile has no PromQL query".into());
    }
    if queries.len() > 8
        || queries
            .iter()
            .enumerate()
            .map(|(i, (_, mode))| {
                let (r, n) = query_modes(tile, i, mode);
                r as usize + n as usize
            })
            .sum::<usize>()
            > 8
    {
        return Err("At most 8 executed queries per tile are allowed".into());
    }
    let mut results = vec![];
    for (index, (template, mode)) in queries.into_iter().enumerate() {
        let query = interpolate_promql(&template, values);
        let (range, instant) = query_modes(tile, index, &mode);
        let mut item =
            json!({"id":char::from(b'A'+index as u8).to_string(),"pending":0,"errors":[]});
        let mut truncated = false;
        if range {
            let step = tile_step(tile, start_ms, end_ms, &query)?;
            let mut data =
                promql::dashboard_query(req, &dataset, &query, start_ms, end_ms, Some(step))
                    .await
                    .map_err(|e| e.to_string())?;
            truncated |= trim_promql(&mut data, limit);
            item["range"] = data;
        }
        if instant {
            let mut data = promql::dashboard_query(req, &dataset, &query, end_ms, end_ms, None)
                .await
                .map_err(|e| e.to_string())?;
            truncated |= trim_promql(&mut data, limit);
            item["instant"] = data;
        }
        if truncated {
            item["truncated"] = json!(true);
        }
        results.push(item);
    }
    Ok(json!({"promql":results}))
}

pub async fn preview(
    req: HttpRequest,
    Json(request): Json<Value>,
) -> Result<HttpResponse, DashboardError> {
    Ok(HttpResponse::Ok().json(preview_value(&req, request).await?))
}

pub async fn preview_value(req: &HttpRequest, request: Value) -> Result<Value, DashboardError> {
    authorize_runtime(req, Action::Query)?;
    let _permit = PREVIEW_SLOTS.clone().try_acquire_owned().map_err(|_| {
        DashboardError::api(
            429,
            "PREVIEW_BUSY",
            "Dashboard preview request queue is full",
            json!({}),
        )
    })?;
    tokio::time::timeout(Duration::from_secs(30), preview_inner(req, request))
        .await
        .map_err(|_| {
            DashboardError::api(
                504,
                "PREVIEW_TIMEOUT",
                "Dashboard preview exceeded 30 seconds",
                json!({}),
            )
        })?
}

fn authorize_runtime(req: &HttpRequest, action: Action) -> Result<(), DashboardError> {
    let key = extract_session_key_from_req(req).map_err(|_| {
        DashboardError::api(
            401,
            "UNAUTHENTICATED",
            "Valid authentication is required",
            json!({}),
        )
    })?;
    let tenant = get_tenant_id_from_request(req);
    if let Response::Suspended(message) =
        middleware::check_suspension_for_tenant(tenant.as_deref(), action)
    {
        return Err(DashboardError::api(403, "SUSPENDED", message, json!({})));
    }
    if Users.authorize(key, action, None, None) != Response::Authorized {
        return Err(DashboardError::api(
            403,
            "FORBIDDEN",
            "Dashboard preview permission denied",
            json!({"action":format!("{action:?}")}),
        ));
    }
    Ok(())
}

async fn preview_inner(req: &HttpRequest, request: Value) -> Result<Value, DashboardError> {
    if serde_json::to_vec(&request)?.len() > 2 * MAX_BYTES {
        return Err(bad("Preview request exceeds 2 MiB"));
    }
    let request: PreviewRequest =
        serde_json::from_value(request).map_err(|e| bad(e.to_string()))?;
    let (start_ms, end_ms, limit) =
        query_bounds(&request.start_time, &request.end_time, request.row_limit).map_err(bad)?;
    if request.variables.len() > 100
        || request.variables.iter().any(|(k, v)| {
            k.len() > 128
                || selection(v).len() > 100
                || match v {
                    Value::String(s) => s.len() > 4096,
                    Value::Array(a) => a.iter().any(|v| v.as_str().is_none_or(|s| s.len() > 4096)),
                    _ => true,
                }
        })
    {
        return Err(bad(
            "variables must contain at most 100 string or string-array selections",
        ));
    }
    let mut document = match (request.dashboard_id, request.document) {
        (Some(id), None) => {
            authorize_runtime(req, Action::GetDashboard)?;
            dashboard_service::get_json(
                validate_dashboard_id(id)?,
                &get_tenant_id_from_request(req),
            )
            .await?
        }
        (None, Some(document)) if document.is_object() => document,
        _ => return Err(bad("Provide exactly one of dashboardId or document")),
    };
    if let Some(revision) = request.revision {
        if document["revision"].as_str() != Some(revision.trim_matches('"')) {
            return Err(DashboardError::api(
                412,
                "REVISION_CONFLICT",
                "Dashboard changed before preview",
                json!({"revision":document["revision"]}),
            ));
        }
    }
    if !request.operations.is_empty() {
        document = dashboard_patch::apply_patch(&document, &request.operations)
            .map_err(|e| DashboardError::api(400, "INVALID_PATCH", e.to_string(), json!({})))?;
    }
    let tiles = document
        .get("tiles")
        .and_then(Value::as_array)
        .ok_or_else(|| bad("document.tiles must be an array"))?;
    let selected: Vec<&Value> = if let Some(ids) = request.tile_ids {
        if ids.len() > MAX_TILES {
            return Err(bad("At most 32 tiles can be previewed"));
        }
        let mut seen = BTreeSet::new();
        let mut selected = vec![];
        for id in ids {
            if !seen.insert(id.clone()) {
                return Err(bad("tileIds must be unique"));
            }
            selected.push(
                tiles
                    .iter()
                    .find(|tile| tile["tile_id"].as_str() == Some(&id))
                    .ok_or_else(|| bad(format!("Unknown tileId: {id}")))?,
            );
        }
        selected
    } else {
        if tiles.len() > MAX_TILES {
            return Err(bad("Select at most 32 tileIds for preview"));
        }
        tiles.iter().collect()
    };
    let definitions = array(&document["variables"]);
    if definitions.len() > 100 {
        return Err(bad("At most 100 variable definitions are supported"));
    }
    let needed = selected
        .iter()
        .flat_map(|tile| {
            dependencies(
                &format!(
                    "{} {} {}",
                    tile["chartQuery"], tile["promqlQuery"], tile["dbName"]
                ),
                definitions,
            )
        })
        .collect();
    let mut values = request.variables;
    let work = async {
        let variable_errors = resolve_variables(
            req,
            definitions,
            needed,
            &mut values,
            &request.start_time,
            &request.end_time,
            end_ms,
        )
        .await;
        let results:Vec<Value>=stream::iter(selected.into_iter().map(|tile|{
            let values=&values;let start=&request.start_time;let end=&request.end_time;
            async move{
                let began=Instant::now();
                let result=execute_tile(req,tile,definitions,values,start,end,start_ms,end_ms,limit).await;
                let mut response=json!({"tileId":tile["tile_id"],"durationMs":began.elapsed().as_millis() as u64});
                match result{Ok(data)=>{response["status"]=json!("success");if let Some(data)=data.as_object(){for(k,v)in data{response[k]=v.clone();}}},Err(error)=>{response["status"]=json!("error");response["error"]=json!(error);}}
                response
            }
        })).buffered(4).collect().await;
        Ok::<_, DashboardError>(
            json!({"results":results,"variables":values,"variableErrors":variable_errors,"revision":document["revision"],"limits":{"rowLimit":limit,"timeoutMs":30000,"maxConcurrentTiles":4},"notice":"Runtime results describe this explicit execution only; configuration validation does not guarantee successful execution."}),
        )
    };
    let mut response = work.await?;
    // Keep a single oversized tile from defeating the aggregate wire-size bound.
    if serde_json::to_vec(&response)?.len() > MAX_BYTES {
        if let Some(results) = response["results"].as_array_mut() {
            for index in (0..results.len()).rev() {
                let tile_id = results[index]["tileId"].clone();
                results[index] = json!({"tileId":tile_id,"status":"error","error":"Preview response exceeds 1 MiB; narrow the selection"});
                if serde_json::to_vec(results)?.len() < MAX_BYTES / 2 {
                    break;
                }
            }
        }
    }
    if serde_json::to_vec(&response)?.len() > MAX_BYTES {
        return Err(bad("Preview response exceeds 1 MiB"));
    }
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn values(value: Value) -> Values {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn bounded_sql_preserves_trailing_comments_and_enforces_the_outer_limit() {
        use datafusion::sql::sqlparser::{dialect::GenericDialect, parser::Parser};
        for source in [
            "SELECT 1 AS count -- trailing comment",
            "-- leading comment\nSELECT 1 AS count -- trailing comment",
            "SELECT '-- inside literal' AS message;",
        ] {
            let wrapped = bounded_sql(source, 17);
            let statements = Parser::parse_sql(&GenericDialect {}, &wrapped).unwrap();
            assert_eq!(statements.len(), 1);
            assert!(statements[0].to_string().ends_with("LIMIT 17"));
        }
        // The pre-fix wrapper comments out its own closing parenthesis.
        assert!(
            Parser::parse_sql(
                &GenericDialect {},
                "SELECT * FROM (SELECT 1 -- trailing comment) AS preview LIMIT 17"
            )
            .is_err()
        );
    }

    #[test]
    fn sql_interpolation_matches_frontend_lexical_escape_and_never_reinterprets_inserted_tokens() {
        let definitions = vec![json!({"name":"ds","type":"dataset"})];
        let inputs = values(
            json!({"ds":"a\"b","host":["a'b","c"],"word":"x'y","v":"$other","other":"injected"}),
        );
        assert_eq!(
            interpolate_sql(
                "SELECT * FROM \"$ds\" WHERE host IN ('$host') AND message='prefix ${word}'",
                &inputs,
                &definitions
            ),
            "SELECT * FROM \"a\"\"b\" WHERE host IN ('a''b','c') AND message='prefix x''y'"
        );
        assert_eq!(
            interpolate_sql("SELECT \"$host\" FROM ${ds}", &inputs, &definitions),
            "SELECT \"a'b\",\"c\" FROM \"a\"\"b\""
        );
        assert_eq!(
            interpolate_sql("SELECT '$v'", &inputs, &definitions),
            "SELECT '$other'"
        );
        let comments = values(json!({"v":"O'Brien","ds":"x'y"}));
        assert_eq!(
            interpolate_sql(
                "-- user's filter\nSELECT * FROM logs WHERE name='$v'",
                &comments,
                &definitions
            ),
            "-- user's filter\nSELECT * FROM logs WHERE name='O''Brien'"
        );
        assert_eq!(
            interpolate_sql(
                "/* user's\n filter */ SELECT * FROM logs WHERE name='$v' /* '$v */",
                &comments,
                &definitions
            ),
            "/* user's\n filter */ SELECT * FROM logs WHERE name='O''Brien' /* '$v */"
        );
        assert_eq!(
            interpolate_sql(
                "SELECT '--', '/*' FROM $ds WHERE name='$v' -- $v",
                &comments,
                &definitions
            ),
            "SELECT '--', '/*' FROM \"x'y\" WHERE name='O''Brien' -- $v"
        );
        let attack = values(json!({"v":"x'); DROP TABLE logs; -- $other","other":"expanded"}));
        assert_eq!(
            interpolate_sql("SELECT '$v'", &attack, &[]),
            "SELECT 'x''); DROP TABLE logs; -- $other'"
        );
    }
    #[test]
    fn promql_interpolation_matches_frontend_string_regex_arrays_and_all() {
        assert_eq!(
            interpolate_promql("up{host=\"$v\"}", &values(json!({"v":"a\"\n\r\t\\"}))),
            "up{host=\"a\\\"\\n\\r\\t\\\\\"}"
        );
        assert_eq!(
            interpolate_promql("up{host=~\"${v}\"}", &values(json!({"v":["a.b","c|d"]}))),
            "up{host=~\"(a\\\\.b|c\\\\|d)\"}"
        );
        assert_eq!(
            interpolate_promql("up{host=\"$v\",region!=\"$v\"}", &values(json!({"v":".*"}))),
            "up{host=~\".*\",region!=\".*\"}"
        );
        assert_eq!(
            interpolate_promql(
                "up{host=\"$v\"}",
                &values(json!({"v":"$other","other":"expanded"}))
            ),
            "up{host=\"$other\"}"
        );
        assert_eq!(
            resolve_dataset("$ds", &values(json!({"ds":"metrics"}))),
            "metrics"
        );
    }
    #[test]
    fn compiler_matches_frontend_builder_golden_queries() {
        let tile = json!({"dbName":["logs"],"chartType":"timeseries","chartQuery":{"x":{"fields":[{"name":"p_timestamp"}]},"y":{"fields":[{"name":"*","aggregate":"count"}]}}});
        assert_eq!(
            sql_query(&tile).unwrap(),
            "SELECT DATE_TRUNC('minute', \"p_timestamp\") AS \"time_bucket\", COUNT(*) AS \"COUNT_STAR\" FROM \"logs\" GROUP BY \"time_bucket\" ORDER BY \"time_bucket\" DESC"
        );
        let tile = json!({"dbName":["demodata"],"chartType":"bar","chartQuery":{"x":{"fields":[{"name":"service"}]},"y":{"fields":[{"name":"All rows (*)","aggregate":"count"}],"sortBy":{"field":"All rows (*)","direction":"DESC"},"limit":20.0},"filters":[{"column":"severity","operator":"=","value":[1.0,"1",2],"type":"number"},{"column":"host","operator":"!=","value":null,"type":"text"}]}});
        assert_eq!(
            sql_query(&tile).unwrap(),
            "SELECT \"service\" AS \"service\", COUNT(*) AS \"COUNT_STAR\" FROM \"demodata\" WHERE (\"severity\" = 1 OR \"severity\" = 2) AND \"host\" IS NOT NULL GROUP BY \"service\" ORDER BY \"COUNT_STAR\" DESC LIMIT 20"
        );
        let mut bad = tile.clone();
        bad["chartQuery"]["filters"][0]["type"] = json!("list-number");
        assert!(
            sql_query(&bad)
                .unwrap_err()
                .contains("cannot be converted faithfully")
        );
    }
    #[test]
    fn compiler_quotes_identifier_and_literal_injection_as_data() {
        let tile = json!({"dbName":"logs\"; DROP TABLE other; --","chartType":"table","chartQuery":{"x":{"fields":[{"name":"host\" FROM secret --"}]},"y":{"fields":[{"name":"*","aggregate":"COUNT"}]},"filters":[{"column":"message","operator":"=","value":"x' OR 1=1 --"}]}});
        let sql = sql_query(&tile).unwrap();
        assert!(sql.contains("FROM \"logs\"\"; DROP TABLE other; --\""));
        assert!(sql.contains("\"message\" = 'x'' OR 1=1 --'"));
    }
    #[test]
    fn mixed_promql_modes_stat_and_sparkline_match_frontend() {
        let tile = json!({"chartType":"timeseries","chartQuery":["up","rate(up[5m])","up+1"],"promqlQueryType":["instant","range","both"]});
        assert_eq!(
            promql_queries(&tile),
            vec![
                ("up".into(), "instant".into()),
                ("rate(up[5m])".into(), "range".into()),
                ("up+1".into(), "both".into())
            ]
        );
        assert_eq!(query_modes(&tile, 0, "instant"), (false, true));
        assert_eq!(query_modes(&tile, 1, "range"), (true, false));
        assert_eq!(query_modes(&tile, 2, "both"), (true, true));
        for chart in ["query-value", "gauge", "pie", "donut"] {
            let mut stat = tile.clone();
            stat["chartType"] = json!(chart);
            assert_eq!(query_modes(&stat, 0, "range"), (false, true));
        }
        let mut stat = tile.clone();
        stat["chartType"] = json!("query-value");
        stat["config"] = json!({"layout":{"sparkline":true}});
        assert_eq!(query_modes(&stat, 0, "range"), (true, true));
        assert_eq!(query_modes(&stat, 1, "range"), (false, true));
        assert_eq!(tile_step(&tile, 0, 3600_000, "up").unwrap(), 15000);
        assert_eq!(tile_step(&tile, 0, 3600_000, "rate(up[5s])").unwrap(), 2000);
        let null_fallback = json!({"promqlStep":null,"promqlQuery":{"step":"5m"}});
        assert_eq!(
            tile_step(&null_fallback, 0, 3600_000, "up").unwrap(),
            300000
        );
    }
    #[test]
    fn bounds_reject_invalid_ranges_and_rows_before_execution() {
        let start = "2026-10-01T00:00:00Z";
        assert_eq!(
            query_bounds(start, "2026-10-02T00:00:00Z", Some(500))
                .unwrap()
                .2,
            500
        );
        for end in ["bad", "2026-09-30T23:59:59Z", "2026-11-02T00:00:00Z"] {
            assert!(query_bounds(start, end, None).is_err());
        }
        for limit in [0, 501, usize::MAX] {
            assert!(query_bounds(start, start, Some(limit)).is_err());
        }
        assert!(query_bounds("1969-12-31T23:00:00Z", start, None).is_err());
    }
    #[test]
    fn bounded_variable_options_never_silently_replace_saved_dynamic_default() {
        let variable = json!({"name":"host","type":"sql","defaultValue":"z"});
        assert!(
            select_variable_default(&variable, &["a".into()])
                .unwrap_err()
                .contains("explicit selection")
        );
        assert_eq!(
            select_variable_default(&variable, &["a".into(), "z".into()]).unwrap(),
            "z"
        );
        assert!(select_variable_default(&json!({"type":"sql"}), &["x".repeat(4097)]).is_err());
        assert_eq!(
            select_variable_default(&json!({"type":"list"}), &["a".into()]).unwrap(),
            "a"
        );
    }
    #[actix_web::test]
    async fn unauthenticated_proposed_document_cannot_reach_query_execution() {
        let req = actix_web::test::TestRequest::default().to_http_request();
        let error=preview_value(&req,json!({"document":{"tiles":[]},"startTime":"2026-10-10T00:00:00Z","endTime":"2026-10-10T01:00:00Z"})).await.unwrap_err();
        assert!(matches!(error, DashboardError::Api { status: 401, .. }));
    }
}
