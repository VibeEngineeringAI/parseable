// SPDX-License-Identifier: AGPL-3.0-or-later
//! Community PromQL HTTP API over existing OTLP metric datasets.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::Arc;
use std::time::Duration;

use actix_web::{HttpRequest, HttpResponse, ResponseError, Scope, http::StatusCode, web};
use chrono::{DateTime, NaiveDateTime, Utc};
use once_cell::sync::Lazy;
use serde_json::{Map, Value, json};
use tokio::sync::Semaphore;

use crate::event::format::LogSource;
use crate::handlers::http::middleware::RouteExt;
use crate::handlers::http::query::{Query, get_records_and_fields_for_authorized_query};
use crate::otel::metrics::OTEL_METRICS_KNOWN_FIELD_LIST;
use crate::parseable::PARSEABLE;
use crate::promql::{self, Labels, QueryPlan, Sample, Series};
use crate::rbac::{Users, role::Action};
use crate::utils::{
    actix::extract_session_key_from_req, arrow::record_batches_to_json, get_tenant_id_from_request,
    user_auth_for_datasets,
};

const MAX_RANGE_MS: i64 = 31 * 24 * 60 * 60 * 1000;
const MAX_QUERY_BYTES: usize = 16 * 1024;
const MAX_BATCH_BYTES: usize = 64 * 1024 * 1024;
static REQUEST_SLOTS: Lazy<Arc<Semaphore>> = Lazy::new(|| Arc::new(Semaphore::new(32)));
static QUERY_SLOTS: Lazy<Arc<Semaphore>> = Lazy::new(|| Arc::new(Semaphore::new(4)));

pub fn scope() -> Scope {
    web::scope("/prometheus/api/v1")
        .service(
            web::resource("/query")
                .route(web::get().to(instant_get).authorize(Action::Query))
                .route(web::post().to(instant_post).authorize(Action::Query)),
        )
        .service(
            web::resource("/query_range")
                .route(web::get().to(range_get).authorize(Action::Query))
                .route(web::post().to(range_post).authorize(Action::Query)),
        )
        .service(web::resource("/labels").route(web::get().to(labels_get).authorize(Action::Query)))
        .service(
            web::resource("/label/{name}/values")
                .route(web::get().to(label_values_get).authorize(Action::Query)),
        )
}

#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct ApiError {
    status: StatusCode,
    kind: &'static str,
    message: String,
}

impl ApiError {
    fn bad(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            kind: "bad_data",
            message: message.into(),
        }
    }
    fn execution(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::UNPROCESSABLE_ENTITY,
            kind: "execution",
            message: message.into(),
        }
    }
    fn unavailable(kind: &'static str, message: &str) -> Self {
        Self {
            status: StatusCode::SERVICE_UNAVAILABLE,
            kind,
            message: message.into(),
        }
    }
    fn auth(error: actix_web::Error) -> Self {
        Self {
            status: error.as_response_error().status_code(),
            kind: "forbidden",
            message: error.to_string(),
        }
    }
}

impl ResponseError for ApiError {
    fn status_code(&self) -> StatusCode {
        self.status
    }
    fn error_response(&self) -> HttpResponse {
        HttpResponse::build(self.status)
            .json(json!({"status":"error","errorType":self.kind,"error":self.message}))
    }
}

async fn instant_get(req: HttpRequest) -> Result<HttpResponse, ApiError> {
    handle(req, None, false).await
}
async fn instant_post(req: HttpRequest, body: web::Bytes) -> Result<HttpResponse, ApiError> {
    handle(req, Some(body), false).await
}
async fn range_get(req: HttpRequest) -> Result<HttpResponse, ApiError> {
    handle(req, None, true).await
}
async fn range_post(req: HttpRequest, body: web::Bytes) -> Result<HttpResponse, ApiError> {
    handle(req, Some(body), true).await
}

/// Reject duplicate/unsupported options rather than silently changing query meaning.
fn parameters(req: &HttpRequest, body: Option<&[u8]>) -> Result<HashMap<String, String>, ApiError> {
    if req.query_string().len() + body.map_or(0, <[u8]>::len) > MAX_QUERY_BYTES {
        return Err(ApiError::bad("query parameters exceed 16 KiB"));
    }
    let mut params = HashMap::new();
    let mut insert = |bytes: &[u8]| -> Result<(), ApiError> {
        for (key, value) in url::form_urlencoded::parse(bytes) {
            if params
                .insert(key.into_owned(), value.into_owned())
                .is_some()
            {
                return Err(ApiError::bad("duplicate query parameter"));
            }
        }
        Ok(())
    };
    insert(req.query_string().as_bytes())?;
    if let Some(body) = body {
        let content_type = req
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        if content_type.split(';').next().unwrap_or("").trim()
            != "application/x-www-form-urlencoded"
        {
            return Err(ApiError::bad(
                "POST requires application/x-www-form-urlencoded",
            ));
        }
        insert(body)?;
    }
    Ok(params)
}

fn timestamp_ms(value: &str) -> Result<i64, ApiError> {
    let ms = if let Ok(seconds) = value.parse::<f64>() {
        if !seconds.is_finite() {
            return Err(ApiError::bad("timestamp must be finite"));
        }
        let ms = (seconds * 1000.0).floor();
        if !(0.0..=253_402_300_799_000.0).contains(&ms) {
            return Err(ApiError::bad("timestamp must be between 1970 and 9999"));
        }
        ms as i64
    } else {
        DateTime::parse_from_rfc3339(value)
            .map_err(|_| ApiError::bad("expected Unix seconds or RFC3339 timestamp"))?
            .timestamp_millis()
    };
    if !(0..=253_402_300_799_000).contains(&ms) {
        return Err(ApiError::bad("timestamp must be between 1970 and 9999"));
    }
    Ok(ms)
}

fn duration_ms(value: &str) -> Result<i64, ApiError> {
    let seconds = match value.parse::<f64>() {
        Ok(seconds) => seconds,
        Err(_) => promql_parser::util::parse_duration(value)
            .map_err(|_| ApiError::bad("expected duration such as 15s or numeric seconds"))?
            .as_secs_f64(),
    };
    if !seconds.is_finite() || seconds < 0.001 || seconds > MAX_RANGE_MS as f64 / 1000.0 {
        return Err(ApiError::bad("duration must be between 1ms and 31d"));
    }
    Ok((seconds * 1000.0).round() as i64)
}

fn required<'a>(params: &'a HashMap<String, String>, key: &str) -> Result<&'a str, ApiError> {
    params
        .get(key)
        .filter(|s| !s.trim().is_empty())
        .map(String::as_str)
        .ok_or_else(|| ApiError::bad(format!("missing {key} parameter")))
}

fn dataset_from_request(
    req: &HttpRequest,
    params: &HashMap<String, String>,
) -> Result<String, ApiError> {
    let header = req
        .headers()
        .get("x-p-stream")
        .map(|value| {
            value
                .to_str()
                .map_err(|_| ApiError::bad("X-P-Stream must be valid UTF-8"))
        })
        .transpose()?;
    let parameter = params.get("stream").map(String::as_str);
    if header
        .zip(parameter)
        .is_some_and(|(header, parameter)| header != parameter)
    {
        return Err(ApiError::bad(
            "X-P-Stream and stream parameter must select the same dataset",
        ));
    }
    let dataset = header
        .or(parameter)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ApiError::bad("X-P-Stream header or stream parameter is required"))?;
    crate::validator::stream_name(dataset, crate::storage::StreamType::UserDefined)
        .map_err(|e| ApiError::bad(e.to_string()))?;
    Ok(dataset.to_owned())
}

async fn authorize_dataset(
    req: &HttpRequest,
    dataset: &str,
    tenant: &Option<String>,
) -> Result<(), ApiError> {
    let creds = extract_session_key_from_req(req).map_err(ApiError::auth)?;
    let permissions = Users.get_permissions(&creds);
    user_auth_for_datasets(&permissions, &[dataset.to_owned()], tenant)
        .await
        .map_err(ApiError::auth)?;
    crate::handlers::http::query::create_streams_for_distributed(vec![dataset.to_owned()], tenant)
        .await
        .map_err(|e| ApiError::execution(e.to_string()))
}

async fn labels_get(req: HttpRequest) -> Result<HttpResponse, ApiError> {
    metadata(req, None).await
}

async fn label_values_get(
    req: HttpRequest,
    name: web::Path<String>,
) -> Result<HttpResponse, ApiError> {
    metadata(req, Some(name.into_inner())).await
}

fn metadata_parameters(
    req: &HttpRequest,
) -> Result<(HashMap<String, String>, Vec<QueryPlan>), ApiError> {
    if req.query_string().len() > MAX_QUERY_BYTES {
        return Err(ApiError::bad("query parameters exceed 16 KiB"));
    }
    let mut params = HashMap::new();
    let mut selectors = Vec::new();
    for (key, value) in url::form_urlencoded::parse(req.query_string().as_bytes()) {
        if key == "match[]" {
            if selectors.len() >= 16 {
                return Err(ApiError::bad("at most 16 match[] selectors are allowed"));
            }
            let plan = QueryPlan::parse(&value).map_err(|e| ApiError::bad(e.to_string()))?;
            if !matches!(
                promql_parser::parser::parse(&value),
                Ok(promql_parser::parser::Expr::VectorSelector(_))
            ) {
                return Err(ApiError::bad("match[] must be an instant-vector selector"));
            }
            selectors.push(plan);
        } else if !["stream", "start", "end", "limit"].contains(&key.as_ref()) {
            return Err(ApiError::bad(format!(
                "unsupported metadata parameter: {key}"
            )));
        } else if params
            .insert(key.into_owned(), value.into_owned())
            .is_some()
        {
            return Err(ApiError::bad("duplicate query parameter"));
        }
    }
    Ok((params, selectors))
}

/// Metadata shares the query authorization and resource limits. It returns only
/// series this evaluator can query, so builders do not suggest unsupported types.
async fn metadata(req: HttpRequest, name: Option<String>) -> Result<HttpResponse, ApiError> {
    let (params, selectors) = metadata_parameters(&req)?;
    let dataset = dataset_from_request(&req, &params)?;
    let limit = params
        .get("limit")
        .map(|v| {
            v.parse::<usize>()
                .map_err(|_| ApiError::bad("limit must be a nonnegative integer"))
        })
        .transpose()?
        .unwrap_or(0);
    if limit > promql::MAX_SERIES {
        return Err(ApiError::bad("metadata limit cannot exceed 10000"));
    }
    let end = params
        .get("end")
        .map(|s| timestamp_ms(s))
        .transpose()?
        .unwrap_or_else(|| Utc::now().timestamp_millis());
    let start = params
        .get("start")
        .map(|s| timestamp_ms(s))
        .transpose()?
        .unwrap_or_else(|| end.saturating_sub(24 * 60 * 60 * 1000).max(0));
    if start > end || end - start > MAX_RANGE_MS {
        return Err(ApiError::bad(
            "metadata range must be ordered and at most 31d",
        ));
    }
    if name
        .as_ref()
        .is_some_and(|s| s.is_empty() || s.len() > 1024)
    {
        return Err(ApiError::bad("invalid label name"));
    }
    // Bound queued HTTP requests while allowing dashboard panels to share four
    // evaluation slots. Queue time counts against the request's total deadline.
    let _request_permit = REQUEST_SLOTS
        .clone()
        .try_acquire_owned()
        .map_err(|_| ApiError::unavailable("unavailable", "PromQL request queue is full"))?;
    let work = async {
        let tenant = get_tenant_id_from_request(&req);
        authorize_dataset(&req, &dataset, &tenant).await?;
        let permit = QUERY_SLOTS.clone().acquire_owned().await.map_err(|_| {
            ApiError::unavailable("unavailable", "PromQL query service unavailable")
        })?;
        let plan = QueryPlan::parse("{__name__=~\".+\"}").expect("constant selector");
        let batches =
            load_batches(&plan, &dataset, &tenant, start, end, BatchPurpose::Metadata).await?;
        let body = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let rows =
                record_batches_to_json(&batches).map_err(|e| ApiError::execution(e.to_string()))?;
            let values = discover_labels(rows, &selectors, name.as_deref())?;
            let truncated = limit > 0 && values.len() > limit;
            let values: Vec<_> = values
                .into_iter()
                .take(if limit == 0 {
                    promql::MAX_SERIES
                } else {
                    limit
                })
                .collect();
            let mut response = json!({"status":"success", "data":values});
            if truncated {
                response["warnings"] = json!(["metadata results truncated to the requested limit"]);
            }
            serde_json::to_vec(&response).map_err(|e| ApiError::execution(e.to_string()))
        })
        .await
        .map_err(|_| ApiError::execution("PromQL metadata worker failed"))??;
        Ok(HttpResponse::Ok()
            .content_type("application/json")
            .body(body))
    };
    tokio::time::timeout(Duration::from_secs(30), work)
        .await
        .map_err(|_| ApiError::unavailable("timeout", "PromQL metadata query timed out"))?
}

fn discover_labels(
    rows: Vec<Map<String, Value>>,
    selectors: &[QueryPlan],
    name: Option<&str>,
) -> Result<BTreeSet<String>, ApiError> {
    let mut result = BTreeSet::new();
    let mut work = 0usize;
    for row in rows {
        let metric_type = row.get("metric_type").and_then(Value::as_str);
        if metric_type != Some("gauge")
            && !(metric_type == Some("sum")
                && row.get("aggregation_temporality").and_then(Value::as_f64) == Some(2.0))
        {
            continue;
        }
        let labels = metric_labels(&row)?;
        let bytes = labels
            .iter()
            .map(|(k, v)| k.len().saturating_add(v.len()).saturating_add(1))
            .sum::<usize>();
        let matchers = selectors
            .iter()
            .flat_map(QueryPlan::selectors)
            .map(|s| s.matchers.len() + 1)
            .sum::<usize>()
            .max(1);
        work = work.saturating_add(bytes.saturating_mul(matchers));
        if work > 20_000_000 {
            return Err(ApiError::execution(
                "metadata work limit exceeded; narrow the time range",
            ));
        }
        if !selectors.is_empty()
            && !selectors
                .iter()
                .flat_map(QueryPlan::selectors)
                .any(|s| s.matches(&labels))
        {
            continue;
        }
        if let Some(name) = name {
            if let Some(value) = labels.get(name) {
                result.insert(value.clone());
            }
        } else {
            result.extend(labels.into_keys());
        }
        if result.len() > promql::MAX_SERIES {
            return Err(ApiError::execution(
                "metadata exceeds 10000 distinct values; narrow the query",
            ));
        }
    }
    Ok(result)
}

async fn handle(
    req: HttpRequest,
    body: Option<web::Bytes>,
    range: bool,
) -> Result<HttpResponse, ApiError> {
    let params = parameters(&req, body.as_deref())?;
    for key in params.keys() {
        let allowed = if range {
            ["query", "start", "end", "step", "timeout", "stream"].as_slice()
        } else {
            ["query", "time", "timeout", "stream"].as_slice()
        };
        if !allowed.contains(&key.as_str()) {
            return Err(ApiError::bad(format!("unsupported parameter: {key}")));
        }
    }
    let plan = QueryPlan::parse(required(&params, "query")?).map_err(|e| match e {
        promql::PromqlError::Unsupported(_) => ApiError::execution(e.to_string()),
        _ => ApiError::bad(e.to_string()),
    })?;
    let (start, end, step) = if range {
        let start = timestamp_ms(required(&params, "start")?)?;
        let end = timestamp_ms(required(&params, "end")?)?;
        let step = duration_ms(required(&params, "step")?)?;
        if end < start || end - start > MAX_RANGE_MS {
            return Err(ApiError::bad("range must be ordered and at most 31d"));
        }
        if (end - start) / step + 1 > promql::MAX_STEPS as i64 {
            return Err(ApiError::bad("range exceeds maximum evaluation steps"));
        }
        (start, end, Some(step))
    } else {
        let time = params
            .get("time")
            .map(|v| timestamp_ms(v))
            .transpose()?
            .unwrap_or_else(|| Utc::now().timestamp_millis());
        (time, time, None)
    };
    if plan.required_history_ms() > MAX_RANGE_MS {
        return Err(ApiError::bad("selector history exceeds 31d"));
    }
    let timeout_ms = params
        .get("timeout")
        .map(|v| duration_ms(v))
        .transpose()?
        .unwrap_or(30_000)
        .min(30_000);
    let dataset = dataset_from_request(&req, &params)?;
    // Bound queued HTTP requests while allowing dashboard panels to share four
    // evaluation slots. Queue time counts against the request's total deadline.
    let _request_permit = REQUEST_SLOTS
        .clone()
        .try_acquire_owned()
        .map_err(|_| ApiError::unavailable("unavailable", "PromQL request queue is full"))?;
    let work = async {
        let tenant = get_tenant_id_from_request(&req);
        authorize_dataset(&req, &dataset, &tenant).await?;
        let body = execute_query(plan, &dataset, &tenant, start, end, step, |data| {
            serde_json::to_vec(&json!({"status":"success", "data":data.into_json()}))
                .map_err(|e| ApiError::execution(e.to_string()))
        })
        .await?;
        Ok(HttpResponse::Ok()
            .content_type("application/json")
            .body(body))
    };
    tokio::time::timeout(Duration::from_millis(timeout_ms as u64), work)
        .await
        .map_err(|_| ApiError::unavailable("timeout", "PromQL query timed out"))?
}

/// Shared storage/evaluation worker. Callers authorize the concrete dataset,
/// bound admission and apply a deadline before entering this service.
async fn execute_query<T: Send + 'static>(
    plan: QueryPlan,
    dataset: &str,
    tenant: &Option<String>,
    start: i64,
    end: i64,
    step: Option<i64>,
    finish: impl FnOnce(promql::QueryValue) -> Result<T, ApiError> + Send + 'static,
) -> Result<T, ApiError> {
    let permit =
        QUERY_SLOTS.clone().acquire_owned().await.map_err(|_| {
            ApiError::unavailable("unavailable", "PromQL query service unavailable")
        })?;
    let batches = load_batches(&plan, dataset, tenant, start, end, BatchPurpose::Query).await?;
    // Retain the execution permit through conversion and output construction,
    // even if the caller's timeout expires while this worker is running.
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        // Convert one batch at a time so the whole result is never held as
        // Arrow, a JSON buffer and parsed rows at once.
        let mut grouped = BTreeMap::new();
        for batch in batches {
            let rows = record_batches_to_json(std::slice::from_ref(&batch))
                .map_err(|e| ApiError::execution(e.to_string()))?;
            group_rows(&plan, &mut grouped, rows)?;
        }
        let series = finish_series(grouped)?;
        let data = match step {
            Some(step) => promql::evaluate_range(&plan, &series, start, end, step),
            None => promql::evaluate(&plan, &series, end),
        }
        .map_err(|e| ApiError::execution(e.to_string()))?;
        finish(data)
    })
    .await
    .map_err(|_| ApiError::execution("PromQL worker failed"))?
}

fn alert_query_plan(query: &str) -> Result<QueryPlan, String> {
    let plan = QueryPlan::parse(query).map_err(|e| e.to_string())?;
    if !plan.is_instant_vector() {
        return Err("PromQL alerts require an instant-vector expression".into());
    }
    if plan.required_history_ms() > MAX_RANGE_MS {
        return Err("selector history exceeds 31d".into());
    }
    Ok(plan)
}

pub(crate) fn validate_alert_expression(query: &str) -> Result<(), String> {
    alert_query_plan(query).map(|_| ())
}

fn alert_vector(data: promql::QueryValue) -> Result<Vec<(Labels, f64)>, ApiError> {
    let promql::QueryValue::Vector(samples) = data else {
        return Err(ApiError::execution(
            "PromQL alerts require an instant vector",
        ));
    };
    samples
        .into_iter()
        .map(|point| {
            if !point.sample.value.is_finite() {
                return Err(ApiError::execution(
                    "PromQL alert returned a non-finite value",
                ));
            }
            Ok((point.labels, point.sample.value))
        })
        .collect()
}

/// Evaluate an alert after its persisted execution identity has been authorized
/// for this dataset and tenant. Never call this with an untrusted dataset alone.
pub(crate) async fn execute_alert_instant(
    dataset: &str,
    query: &str,
    tenant: &Option<String>,
) -> Result<Vec<(Labels, f64)>, String> {
    if !matches!(
        PARSEABLE.options.mode,
        crate::option::Mode::All | crate::option::Mode::Query
    ) {
        return Err("Community PromQL alerts require All or Query mode".into());
    }
    let plan = alert_query_plan(query)?;
    let _admission = REQUEST_SLOTS
        .clone()
        .try_acquire_owned()
        .map_err(|_| "PromQL request queue is full".to_owned())?;
    let work = async {
        crate::handlers::http::query::create_streams_for_distributed(
            vec![dataset.to_owned()],
            tenant,
        )
        .await
        .map_err(|e| ApiError::execution(e.to_string()))?;
        let now = Utc::now().timestamp_millis();
        execute_query(plan, dataset, tenant, now, now, None, alert_vector).await
    };
    tokio::time::timeout(Duration::from_secs(30), work)
        .await
        .map_err(|_| "PromQL alert query timed out".to_owned())?
        .map_err(|e| e.to_string())
}

fn sql_string(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}
fn sql_ident(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}
/// Quoted OTLP names become equality matchers rather than selector names.
/// Push down only a necessary exact-name condition; Rust retains all matchers.
fn exact_metric_filter(plan: &QueryPlan) -> String {
    let names: Option<Vec<_>> = plan
        .selectors()
        .iter()
        .map(|selector| {
            selector.metric.as_deref().or_else(|| {
                selector.matchers.iter().find_map(|matcher| {
                    (matcher.name == "__name__"
                        && matches!(matcher.op, promql_parser::label::MatchOp::Equal))
                    .then_some(matcher.value.as_str())
                })
            })
        })
        .collect();
    match names {
        Some(names) if !names.is_empty() => format!(
            " AND \"metric_name\" IN ({})",
            names
                .into_iter()
                .map(sql_string)
                .collect::<Vec<_>>()
                .join(",")
        ),
        _ => String::new(),
    }
}

fn rfc3339(ms: i64) -> Result<String, ApiError> {
    DateTime::<Utc>::from_timestamp_millis(ms)
        .map(|t| t.to_rfc3339())
        .ok_or_else(|| ApiError::bad("timestamp out of range"))
}

#[derive(Clone, Copy)]
enum BatchPurpose {
    Query,
    Metadata,
}

async fn load_batches(
    plan: &QueryPlan,
    dataset: &str,
    tenant: &Option<String>,
    start: i64,
    end: i64,
    purpose: BatchPurpose,
) -> Result<Vec<arrow_array::RecordBatch>, ApiError> {
    let stream = PARSEABLE
        .get_stream(dataset, tenant)
        .map_err(|e| ApiError::bad(e.to_string()))?;
    if !stream
        .get_log_source()
        .iter()
        .any(|source| source.log_source_format == LogSource::OtelMetrics)
    {
        return Err(ApiError::bad(
            "X-P-Stream must select an otel-metrics dataset",
        ));
    }
    if plan.selectors().is_empty() {
        return Ok(Vec::new());
    }
    let schema = stream.get_schema();
    if schema.fields().is_empty() {
        return Ok(Vec::new());
    }
    for name in ["metric_name", "time_unix_nano"] {
        if schema.field_with_name(name).is_err() {
            return Err(ApiError::execution(format!("dataset is missing {name}")));
        }
    }
    let metadata_only = matches!(purpose, BatchPurpose::Metadata);
    let from = start
        .saturating_sub(if metadata_only {
            0
        } else {
            plan.required_history_ms()
        })
        .max(0);
    let metric_filter = exact_metric_filter(plan);
    let exclusive_end = end + 1;
    // Discovery groups physical labels in SQL, so a busy stream with millions
    // of repeated samples does not exhaust the sample evaluator's input bound.
    let (projection, type_filter, row_limit) = if metadata_only {
        if schema.field_with_name("data_point_value").is_err() {
            return Ok(Vec::new());
        }
        if schema.field_with_name("metric_type").is_err() {
            return Err(ApiError::execution("dataset is missing metric_type"));
        }
        let fields = label_projection(
            &schema,
            &["metric_name", "metric_type", "aggregation_temporality"],
        );
        let types = if schema.field_with_name("aggregation_temporality").is_ok() {
            "(\"metric_type\" = 'gauge' OR (\"metric_type\" = 'sum' AND \"aggregation_temporality\" = 2))"
        } else {
            "\"metric_type\" = 'gauge'"
        };
        let flags = if schema.field_with_name("data_point_flags").is_ok() {
            " AND (COALESCE(CAST(\"data_point_flags\" AS BIGINT), 0) & 1) = 0"
        } else {
            ""
        };
        (
            format!("DISTINCT {fields}"),
            format!(" AND {types} AND \"data_point_value\" IS NOT NULL{flags}"),
            promql::MAX_SERIES,
        )
    } else {
        // Read only what sample evaluation uses; wide OTLP schemas also carry
        // exemplars, descriptions and histogram buckets.
        (
            label_projection(
                &schema,
                &[
                    "metric_name",
                    "metric_type",
                    "aggregation_temporality",
                    "data_point_flags",
                    "time_unix_nano",
                    "data_point_value",
                ],
            ),
            String::new(),
            promql::MAX_INPUT_SAMPLES,
        )
    };
    let query = format!(
        "SELECT {projection} FROM {} WHERE CAST(\"time_unix_nano\" AS TIMESTAMP) >= to_timestamp_millis({from}) AND CAST(\"time_unix_nano\" AS TIMESTAMP) < to_timestamp_millis({exclusive_end}){metric_filter}{type_filter} LIMIT {}",
        sql_ident(dataset),
        row_limit + 1
    );
    // The SQL API's automatic time predicate normally uses ingestion time.
    // Widen that predicate to preserve delayed/backfilled OTLP samples. The
    // explicit predicate above always filters by the original metric time.
    let time_partition = stream.get_time_partition();
    if time_partition
        .as_deref()
        .is_some_and(|name| name != "time_unix_nano")
    {
        return Err(ApiError::execution(
            "PromQL requires ingestion-time partitioning or time_unix_nano partitioning",
        ));
    }
    let partitioned_by_sample = time_partition.is_some();
    let created_at = stream
        .metadata
        .read()
        .map_err(|_| ApiError::execution("dataset metadata unavailable"))?
        .created_at
        .clone();
    let ingestion_start = DateTime::parse_from_rfc3339(&created_at)
        .map(|time| time.timestamp_millis().max(0))
        .unwrap_or(0);
    let request = Query {
        query,
        start_time: rfc3339(if partitioned_by_sample {
            from
        } else {
            ingestion_start
        })?,
        end_time: rfc3339(if partitioned_by_sample {
            end.saturating_add(1)
        } else {
            Utc::now().timestamp_millis().saturating_add(1000)
        })?,
        send_null: false,
        fields: false,
        streaming: false,
        filter_tags: None,
    };
    let (batches, _) =
        get_records_and_fields_for_authorized_query(&request, &[dataset.to_owned()], tenant)
            .await
            .map_err(|e| ApiError::execution(e.to_string()))?;
    let batches = batches.unwrap_or_default();
    if batches.iter().map(|b| b.num_rows()).sum::<usize>() > row_limit {
        return Err(ApiError::execution(
            "input sample/series limit exceeded; narrow the query or time range",
        ));
    }
    if batches
        .iter()
        .map(|b| b.get_array_memory_size())
        .sum::<usize>()
        > MAX_BATCH_BYTES
    {
        return Err(ApiError::execution(
            "input data exceeds 64 MiB; narrow the query",
        ));
    }
    Ok(batches)
}

/// Label columns plus the named known columns that exist in `schema`.
fn label_projection(schema: &arrow_schema::Schema, columns: &[&str]) -> String {
    schema
        .fields()
        .iter()
        .filter(|f| is_label_field(f.name()) || columns.contains(&f.name().as_str()))
        .map(|f| sql_ident(f.name()))
        .collect::<Vec<_>>()
        .join(", ")
}

fn sample_timestamp(value: &Value) -> Result<i64, ApiError> {
    let text = value
        .as_str()
        .ok_or_else(|| ApiError::execution("invalid metric timestamp"))?;
    if let Ok(t) = DateTime::parse_from_rfc3339(text) {
        return Ok(t.timestamp_millis());
    }
    // Arrow timestamps without a timezone serialize without a trailing Z.
    NaiveDateTime::parse_from_str(text, "%Y-%m-%dT%H:%M:%S%.f")
        .map(|t| t.and_utc().timestamp_millis())
        .map_err(|_| ApiError::execution("invalid metric timestamp"))
}

fn is_label_field(key: &str) -> bool {
    !OTEL_METRICS_KNOWN_FIELD_LIST.contains(&key)
        && !key.starts_with("exemplars_")
        && !matches!(
            key,
            "p_timestamp"
                | "p_tags"
                | "p_metadata"
                | "p_user_agent"
                | "p_src_ip"
                | "p_format"
                | "p_format_verified"
        )
}

fn metric_labels(row: &Map<String, Value>) -> Result<Labels, ApiError> {
    let name = row
        .get("metric_name")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::execution("missing metric name"))?;
    let mut labels = Labels::new();
    for (key, value) in row {
        if !is_label_field(key) || value.is_null() {
            continue;
        }
        let label = match value {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        };
        // An absent label and an empty label have the same Prometheus identity.
        if !label.is_empty() {
            labels.insert(key.clone(), label);
        }
    }
    labels.insert("__name__".to_owned(), name.to_owned());
    Ok(labels)
}

fn group_rows(
    plan: &QueryPlan,
    grouped: &mut BTreeMap<Labels, Vec<Sample>>,
    rows: Vec<Map<String, Value>>,
) -> Result<(), ApiError> {
    for row in rows {
        let labels = metric_labels(&row)?;
        if !plan
            .selectors()
            .iter()
            .any(|selector| selector.matches(&labels))
        {
            continue;
        }
        let metric_type = row.get("metric_type").and_then(Value::as_str).unwrap_or("");
        if !matches!(metric_type, "gauge" | "sum") {
            return Err(ApiError::execution(
                "only gauge and cumulative sum metrics are supported; histogram/summary translation is not implemented",
            ));
        }
        if metric_type == "sum"
            && row.get("aggregation_temporality").and_then(Value::as_f64) != Some(2.0)
        {
            return Err(ApiError::execution(
                "sum metrics require cumulative aggregation temporality",
            ));
        }
        if row
            .get("data_point_flags")
            .and_then(Value::as_f64)
            .unwrap_or(0.0) as u32
            & 1
            != 0
        {
            return Err(ApiError::execution(
                "OTLP no-recorded-value/staleness markers are not supported",
            ));
        }
        let timestamp_ms = sample_timestamp(
            row.get("time_unix_nano")
                .ok_or_else(|| ApiError::execution("missing metric timestamp"))?,
        )?;
        let value = row
            .get("data_point_value")
            .and_then(Value::as_f64)
            .ok_or_else(|| ApiError::execution("metric is missing its numeric value"))?;
        grouped.entry(labels).or_default().push(Sample {
            timestamp_ms,
            value,
        });
        if grouped.len() > promql::MAX_SERIES {
            return Err(ApiError::execution("series limit exceeded"));
        }
    }
    Ok(())
}

fn finish_series(grouped: BTreeMap<Labels, Vec<Sample>>) -> Result<Vec<Series>, ApiError> {
    let mut series = Vec::with_capacity(grouped.len());
    for (labels, mut samples) in grouped {
        samples.sort_by_key(|sample| sample.timestamp_ms);
        if samples.windows(2).any(|pair| {
            pair[0].timestamp_ms == pair[1].timestamp_ms
                && pair[0].value.to_bits() != pair[1].value.to_bits()
        }) {
            return Err(ApiError::execution(
                "conflicting samples at the same millisecond in one series",
            ));
        }
        samples.dedup_by_key(|sample| sample.timestamp_ms);
        series.push(Series { labels, samples });
    }
    Ok(series)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn alert_expression_contract_rejects_scalar_matrix_and_unsupported_work() {
        for query in [
            "up",
            "sum by (host) (up)",
            "rate(requests_total[5m])",
            "vector(1)",
        ] {
            assert!(validate_alert_expression(query).is_ok(), "{query}");
        }
        for query in ["1", "scalar(up)", "up[5m]", "up[32d]", "absent(up)"] {
            assert!(validate_alert_expression(query).is_err(), "{query}");
        }
    }

    #[test]
    fn alert_values_preserve_labels_and_empty_is_not_zero() {
        let plan = QueryPlan::parse("up").unwrap();
        let empty = promql::evaluate(&plan, &[], 1000).unwrap();
        assert!(alert_vector(empty).unwrap().is_empty());
        let labels = BTreeMap::from([("host".to_owned(), "one".to_owned())]);
        for value in [0.0, 12.0, f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            let vector = promql::QueryValue::Vector(vec![promql::InstantSample {
                labels: labels.clone(),
                sample: Sample {
                    timestamp_ms: 1000,
                    value,
                },
            }]);
            let result = alert_vector(vector);
            if value.is_finite() {
                assert_eq!(result.unwrap(), vec![(labels.clone(), value)]);
            } else {
                assert!(result.is_err());
            }
        }
    }
    use actix_web::test::TestRequest;

    fn rows_to_series(
        plan: &QueryPlan,
        rows: Vec<Map<String, Value>>,
    ) -> Result<Vec<Series>, ApiError> {
        let mut grouped = BTreeMap::new();
        group_rows(plan, &mut grouped, rows)?;
        finish_series(grouped)
    }

    #[test]
    fn exact_otlp_names_are_pushed_down_without_changing_selector_semantics() {
        for query in ["up", "{__name__=\"up\"}", "{\"up\"}"] {
            assert_eq!(
                exact_metric_filter(&QueryPlan::parse(query).unwrap()),
                " AND \"metric_name\" IN ('up')"
            );
        }
        assert_eq!(
            exact_metric_filter(&QueryPlan::parse("{__name__=\"system.cpu.time\"}").unwrap()),
            " AND \"metric_name\" IN ('system.cpu.time')"
        );
        for query in [
            "{__name__=~\"up|down\"}",
            "up + {job=\"test\"}",
            "vector(1)",
        ] {
            assert!(exact_metric_filter(&QueryPlan::parse(query).unwrap()).is_empty());
        }
        assert_eq!(
            exact_metric_filter(&QueryPlan::parse("up + {__name__=\"down\"}").unwrap()),
            " AND \"metric_name\" IN ('up','down')"
        );
    }

    #[test]
    fn dataset_alias_and_conflicts_are_validated() {
        let req = TestRequest::with_uri("/?stream=metrics").to_http_request();
        let params = parameters(&req, None).unwrap();
        assert_eq!(dataset_from_request(&req, &params).unwrap(), "metrics");
        let conflict = TestRequest::default()
            .insert_header(("x-p-stream", "other"))
            .to_http_request();
        assert!(dataset_from_request(&conflict, &params).is_err());
        assert!(dataset_from_request(&req, &HashMap::new()).is_err());
    }

    #[test]
    fn metadata_selectors_and_label_discovery_are_scoped() {
        let req =
            TestRequest::with_uri("/?stream=metrics&limit=1000&match%5B%5D=up&match%5B%5D=down")
                .to_http_request();
        let (params, selectors) = metadata_parameters(&req).unwrap();
        assert_eq!(params["limit"], "1000");
        assert_eq!(selectors.len(), 2);
        let gauge = row("2026-01-01T00:00:00Z", 1.0);
        let mut histogram = gauge.clone();
        histogram.insert("metric_type".into(), json!("histogram"));
        histogram.insert("metric_name".into(), json!("hidden"));
        let names =
            discover_labels(vec![gauge.clone(), histogram], &selectors, Some("__name__")).unwrap();
        assert_eq!(names, BTreeSet::from(["up".to_owned()]));
        let labels = discover_labels(vec![gauge.clone()], &[], None).unwrap();
        assert_eq!(
            labels,
            BTreeSet::from(["__name__".to_owned(), "job".to_owned()])
        );
        let excluded = QueryPlan::parse("up{job=\"other\"}").unwrap();
        assert!(
            discover_labels(vec![gauge], &[excluded], Some("job"))
                .unwrap()
                .is_empty()
        );
        for uri in ["/?match%5B%5D=sum(up)", "/?limit=1&limit=2", "/?unknown=1"] {
            assert!(metadata_parameters(&TestRequest::with_uri(uri).to_http_request()).is_err());
        }
    }

    #[test]
    fn times_are_validated_and_millisecond_precision() {
        assert_eq!(timestamp_ms("1.234").unwrap(), 1234);
        assert_eq!(timestamp_ms("1970-01-01T00:00:01.234Z").unwrap(), 1234);
        for invalid in ["NaN", "inf", "-1", "1e30", "tomorrow"] {
            assert!(timestamp_ms(invalid).is_err());
        }
        assert_eq!(duration_ms("1m30s").unwrap(), 90_000);
        for invalid in ["0", "-1", "NaN", "0.0001", "32d"] {
            assert!(duration_ms(invalid).is_err());
        }
    }

    #[test]
    fn form_and_query_duplicates_are_rejected() {
        let req = TestRequest::with_uri("/?query=up")
            .insert_header(("content-type", "application/x-www-form-urlencoded"))
            .to_http_request();
        assert!(parameters(&req, Some(b"query=down")).is_err());
        assert_eq!(parameters(&req, Some(b"time=1")).unwrap()["time"], "1");
    }

    fn row(time: &str, value: f64) -> Map<String, Value> {
        json!({"metric_name":"up", "metric_type":"gauge", "time_unix_nano":time, "data_point_value":value,"p_timestamp":"ignored", "job":"test", "empty":"", "__series_hash_u64":123}).as_object().unwrap().clone()
    }

    #[test]
    fn series_identity_timestamps_and_duplicate_conflicts() {
        let plan = QueryPlan::parse("up").unwrap();
        let rows = vec![
            row("2026-01-01T00:00:00.123Z", 1.0),
            row("2026-01-01T00:00:00.123", 1.0),
        ];
        let series = rows_to_series(&plan, rows).unwrap();
        assert_eq!(series.len(), 1);
        assert_eq!(series[0].samples.len(), 1);
        assert_eq!(series[0].labels.len(), 2);
        assert!(
            rows_to_series(
                &plan,
                vec![
                    row("2026-01-01T00:00:00Z", 1.0),
                    row("2026-01-01T00:00:00Z", 2.0)
                ]
            )
            .is_err()
        );
    }

    #[test]
    fn unsupported_metric_types_are_not_silently_skipped() {
        let plan = QueryPlan::parse("up").unwrap();
        let mut histogram = row("2026-01-01T00:00:00Z", 1.0);
        histogram.insert("metric_type".into(), json!("histogram"));
        assert!(rows_to_series(&plan, vec![histogram]).is_err());
        let mut delta = row("2026-01-01T00:00:00Z", 1.0);
        delta.insert("metric_type".into(), json!("sum"));
        delta.insert("aggregation_temporality".into(), json!(1));
        assert!(rows_to_series(&plan, vec![delta]).is_err());
    }

    #[test]
    fn projection_keeps_labels_and_requested_columns_only() {
        use arrow_schema::{DataType, Field, Schema};
        let schema = Schema::new(
            [
                "metric_name",
                "metric_description",
                "exemplars",
                "data_point_bucket_counts",
                "p_timestamp",
                "job",
                "data_point_value",
            ]
            .map(|name| Field::new(name, DataType::Utf8, true))
            .to_vec(),
        );
        assert_eq!(
            label_projection(&schema, &["metric_name", "data_point_value", "absent"]),
            "\"metric_name\", \"job\", \"data_point_value\""
        );
    }

    #[test]
    fn sql_literals_and_identifiers_are_escaped() {
        assert_eq!(sql_string("it's"), "'it''s'");
        assert_eq!(sql_ident("a\"b"), "\"a\"\"b\"");
    }
}
