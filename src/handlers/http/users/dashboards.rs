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

use std::collections::HashMap;

use crate::{
    handlers::http::rbac::RBACError,
    metastore::MetastoreError,
    storage::ObjectStorageError,
    users::{
        dashboard_patch::{self, DashboardPatchRequest},
        dashboard_service::{self, DashboardActor, DashboardMutation, DashboardWriteOptions},
        dashboards::{Dashboard, validate_dashboard_id},
    },
    utils::{get_hash, get_tenant_id_from_request, get_user_and_tenant_from_request, is_admin},
};
use actix_web::{
    HttpRequest, HttpResponse, Responder,
    http::{
        StatusCode,
        header::{ContentType, ETAG, IF_MATCH},
    },
    web::{self, Json, Path},
};
use serde_json::Error as SerdeError;
use serde_json::{Value, json};

pub fn actor(req: &HttpRequest) -> Result<(DashboardActor, Option<String>), DashboardError> {
    let (user_id, tenant) = get_user_and_tenant_from_request(req)?;
    Ok((
        DashboardActor {
            user_id: get_hash(&user_id),
            is_admin: is_admin(req).map_err(|e| DashboardError::Custom(e.to_string()))?,
        },
        tenant,
    ))
}

pub fn write_options(req: &HttpRequest) -> Result<DashboardWriteOptions, DashboardError> {
    let header = |name: &str| -> Result<Option<String>, DashboardError> {
        req.headers()
            .get(name)
            .map(|v| {
                v.to_str().map(str::to_owned).map_err(|_| {
                    DashboardError::api(
                        400,
                        "INVALID_HEADER",
                        format!("{name} must be UTF-8"),
                        json!({}),
                    )
                })
            })
            .transpose()
    };
    Ok(DashboardWriteOptions {
        expected_revision: header(IF_MATCH.as_str())?,
        idempotency_key: header("idempotency-key")?,
        dry_run: false,
    })
}

fn document_response(document: Value) -> HttpResponse {
    let revision = document
        .get("revision")
        .and_then(Value::as_str)
        .unwrap_or("");
    HttpResponse::Ok()
        .insert_header((ETAG, format!("\"{revision}\"")))
        .insert_header(("Cache-Control", "private, no-cache"))
        .json(document)
}

pub async fn list_dashboards(req: HttpRequest) -> Result<impl Responder, DashboardError> {
    let query = web::Query::<HashMap<String, String>>::from_query(req.query_string())
        .map_err(|_| DashboardError::InvalidQueryParameter)?
        .into_inner();
    let limit = query
        .get("limit")
        .map(|s| s.parse::<usize>())
        .transpose()
        .map_err(|_| DashboardError::Metadata("Invalid limit value"))?
        .unwrap_or(0);
    let tags: Option<Vec<String>> = query.get("tags").map(|s| {
        s.split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect()
    });
    if tags.as_ref().is_some_and(Vec::is_empty) {
        return Err(DashboardError::Metadata("Tags cannot be empty"));
    }
    // Legacy tag filtering ignores limit. Cursor pagination explicitly opts in
    // to ID order and applies its limit after the cursor.
    let tagged = tags.is_some();
    let rows = list_dashboards_internal(0, tags, &get_tenant_id_from_request(&req)).await?;
    Ok(web::Json(filter_listing(rows, &query, tagged, limit)))
}

fn filter_listing(
    mut rows: Vec<Value>,
    query: &HashMap<String, String>,
    tagged: bool,
    limit: usize,
) -> Vec<Value> {
    if let Some(search) = query.get("query") {
        let search = search.to_lowercase();
        rows.retain(|d| {
            d["title"]
                .as_str()
                .is_some_and(|s| s.to_lowercase().contains(&search))
        });
    }
    if let Some(after) = query.get("after") {
        rows.sort_by(|a, b| a["dashboardId"].as_str().cmp(&b["dashboardId"].as_str()));
        rows.retain(|d| {
            d["dashboardId"]
                .as_str()
                .is_some_and(|id| id > after.as_str())
        });
    }
    if limit > 0 && (!tagged || query.contains_key("after")) {
        rows.truncate(limit);
    }
    rows
}

pub async fn list_dashboards_internal(
    limit: usize,
    tags: Option<Vec<String>>,
    tenant: &Option<String>,
) -> Result<Vec<Value>, DashboardError> {
    let mut rows = dashboard_service::list_json(tenant).await?;
    if let Some(tags) = tags {
        rows.retain(|d| {
            d["tags"].as_array().is_some_and(|values| {
                values
                    .iter()
                    .any(|v| v.as_str().is_some_and(|v| tags.iter().any(|tag| tag == v)))
            })
        });
    }
    sort_by_modified(&mut rows);
    if limit > 0 {
        rows.truncate(limit);
    }
    Ok(rows
        .into_iter()
        .map(|d| {
            let keys = [
                "dashboardId",
                "title",
                "description",
                "dataset",
                "author",
                "created",
                "modified",
                "tags",
                "isFavorite",
                "revision",
            ];
            Value::Object(
                keys.into_iter()
                    .filter_map(|k| d.get(k).map(|v| (k.to_owned(), v.clone())))
                    .collect(),
            )
        })
        .collect())
}

fn sort_by_modified(rows: &mut [Value]) {
    rows.sort_by_cached_key(|row| {
        std::cmp::Reverse(
            row["modified"]
                .as_str()
                .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok()),
        )
    });
}

#[derive(Clone, Copy)]
enum LegacyOperation {
    Get,
    Update,
    Delete,
    AddTile,
    Create,
}

// Keep the original REST error contracts at the compatibility boundary. New
// PATCH/tool APIs continue to expose the structured service errors.
fn legacy_error(error: DashboardError, operation: LegacyOperation) -> DashboardError {
    match &error {
        DashboardError::Api {
            code: "dashboard_not_found" | "dashboard_forbidden",
            ..
        } => match operation {
            LegacyOperation::Get => DashboardError::Metadata("Dashboard does not exist"),
            LegacyOperation::Update => {
                DashboardError::Metadata("Dashboard does not exist or user is not authorized")
            }
            LegacyOperation::Delete => DashboardError::Metadata(
                "Dashboard does not exist or you do not have permission to access it",
            ),
            LegacyOperation::AddTile => DashboardError::Unauthorized,
            LegacyOperation::Create => error,
        },
        DashboardError::Api {
            code: "title_conflict",
            ..
        } => DashboardError::Metadata("Dashboard title must be unique"),
        DashboardError::Api {
            code: "tile_conflict",
            ..
        } => DashboardError::Metadata("Tile already exists"),
        _ => error,
    }
}

pub async fn get_dashboard(
    req: HttpRequest,
    id: Path<String>,
) -> Result<HttpResponse, DashboardError> {
    Ok(document_response(
        dashboard_service::get_json(
            validate_dashboard_id(id.into_inner())?,
            &get_tenant_id_from_request(&req),
        )
        .await
        .map_err(|error| legacy_error(error, LegacyOperation::Get))?,
    ))
}

pub async fn get_dashboard_internal(
    id: ulid::Ulid,
    tenant: &Option<String>,
) -> Result<Dashboard, DashboardError> {
    Ok(serde_json::from_value(
        dashboard_service::get_json(id, tenant).await?,
    )?)
}

pub async fn create_dashboard(
    req: HttpRequest,
    Json(document): Json<Value>,
) -> Result<HttpResponse, DashboardError> {
    if document.get("title").and_then(Value::as_str) == Some("") {
        return Err(DashboardError::Metadata("Title must be provided"));
    }
    let (actor, tenant) = actor(&req)?;
    let result = dashboard_service::create_json(&actor, &tenant, document, &write_options(&req)?)
        .await
        .map_err(|error| legacy_error(error, LegacyOperation::Create))?;
    Ok(document_response(result["dashboard"].clone()))
}

pub async fn update_dashboard(
    req: HttpRequest,
    id: Path<String>,
    body: Option<Json<Value>>,
) -> Result<HttpResponse, DashboardError> {
    let (actor, tenant) = actor(&req)?;
    let query = web::Query::<HashMap<String, String>>::from_query(req.query_string())
        .map_err(|_| DashboardError::InvalidQueryParameter)?
        .into_inner();
    let mutation = if !query.is_empty() {
        if body.is_some() {
            return Err(DashboardError::Metadata(
                "Cannot use both query parameters and request body for updates",
            ));
        }
        let mut query = query;
        if let Some(rename) = query.get("renameTo")
            && rename.trim().is_empty()
        {
            return Err(DashboardError::Metadata("Rename to cannot be empty"));
        }
        if let Some(favorite) = query.get_mut("isFavorite") {
            *favorite = (*favorite == "true").to_string();
        }
        query.retain(|key, _| matches!(key.as_str(), "isFavorite" | "tags" | "renameTo"));
        DashboardMutation::Metadata(query)
    } else {
        let document = body
            .ok_or(DashboardError::Metadata("Request body is required"))?
            .into_inner();
        validate_legacy_tiles(&document)?;
        DashboardMutation::Replace(document)
    };
    let result = dashboard_service::mutate_legacy_json(
        &actor,
        validate_dashboard_id(id.into_inner())?,
        &tenant,
        mutation,
        &write_options(&req)?,
    )
    .await
    .map_err(|error| legacy_error(error, LegacyOperation::Update))?;
    Ok(document_response(result["dashboard"].clone()))
}

fn validate_legacy_tiles(document: &Value) -> Result<(), DashboardError> {
    if let Some(tiles) = document["tiles"].as_array() {
        let ids = tiles
            .iter()
            .filter_map(|tile| tile["tile_id"].as_str())
            .collect::<Vec<_>>();
        if ids
            .iter()
            .any(|id| ulid::Ulid::from_string(id).is_ok_and(|id| id.is_nil()))
        {
            return Err(DashboardError::Metadata("Tile ID must be provided"));
        }
        if ids.iter().collect::<std::collections::HashSet<_>>().len() != ids.len() {
            return Err(DashboardError::Metadata("Tile IDs must be unique"));
        }
    }
    Ok(())
}

pub async fn patch_dashboard(
    req: HttpRequest,
    id: Path<String>,
    Json(patch): Json<DashboardPatchRequest>,
) -> Result<HttpResponse, DashboardError> {
    let (actor, tenant) = actor(&req)?;
    let mut options = write_options(&req)?;
    options.dry_run = patch.dry_run;
    if options.expected_revision.is_none() {
        options.expected_revision = patch.revision;
    }
    let result = dashboard_service::mutate_json(
        &actor,
        validate_dashboard_id(id.into_inner())?,
        &tenant,
        DashboardMutation::Patch(patch.operations),
        &options,
    )
    .await?;
    let mut response = HttpResponse::Ok();
    if let Some(rev) = result["revision"].as_str() {
        response.insert_header((ETAG, format!("\"{rev}\"")));
    }
    Ok(response.json(result))
}

pub async fn validate_dashboard(
    req: HttpRequest,
    Json(document): Json<Value>,
) -> Result<HttpResponse, DashboardError> {
    let _ = actor(&req)?;
    Ok(HttpResponse::Ok().json(dashboard_patch::validate_dashboard(&document, None)))
}

pub async fn validate_dashboard_changes(
    req: HttpRequest,
    id: Path<String>,
    Json(mut patch): Json<DashboardPatchRequest>,
) -> Result<HttpResponse, DashboardError> {
    patch.dry_run = true;
    patch_dashboard(req, id, Json(patch)).await
}

pub async fn dashboard_capabilities(req: HttpRequest) -> Result<HttpResponse, DashboardError> {
    let mut result =
        crate::users::dashboard_tools::execute(&req, "get_dashboard_capabilities", &json!({}))
            .await?;
    result["concurrency"] = json!({"revision":"opaque ETag","requireRevisionForPatch":true,"conflictStatus":412,"atomicBatch":true});
    Ok(HttpResponse::Ok().json(result))
}

pub async fn delete_dashboard(
    req: HttpRequest,
    id: Path<String>,
) -> Result<HttpResponse, DashboardError> {
    let (actor, tenant) = actor(&req)?;
    dashboard_service::delete_json(
        &actor,
        validate_dashboard_id(id.into_inner())?,
        &tenant,
        &write_options(&req)?,
    )
    .await
    .map_err(|error| legacy_error(error, LegacyOperation::Delete))?;
    Ok(HttpResponse::Ok().finish())
}

pub async fn add_tile(
    req: HttpRequest,
    id: Path<String>,
    Json(tile): Json<Value>,
) -> Result<HttpResponse, DashboardError> {
    let (actor, tenant) = actor(&req)?;
    let result = dashboard_service::mutate_json(
        &actor,
        validate_dashboard_id(id.into_inner())?,
        &tenant,
        DashboardMutation::AddTile(tile),
        &write_options(&req)?,
    )
    .await
    .map_err(|error| legacy_error(error, LegacyOperation::AddTile))?;
    Ok(document_response(result["dashboard"].clone()))
}

pub async fn list_tags(req: HttpRequest) -> Result<impl Responder, DashboardError> {
    Ok(web::Json(
        list_tags_internal(&get_tenant_id_from_request(&req)).await?,
    ))
}

pub async fn list_tags_internal(tenant: &Option<String>) -> Result<Vec<String>, DashboardError> {
    let mut tags = dashboard_service::list_json(tenant)
        .await?
        .into_iter()
        .flat_map(|d| d["tags"].as_array().cloned().unwrap_or_default())
        .filter_map(|v| v.as_str().map(str::to_owned))
        .collect::<Vec<_>>();
    tags.sort();
    tags.dedup();
    Ok(tags)
}

#[derive(Debug, thiserror::Error)]
pub enum DashboardError {
    #[error("Failed to connect to storage: {0}")]
    ObjectStorage(#[from] ObjectStorageError),
    #[error("Serde Error: {0}")]
    Serde(#[from] SerdeError),
    #[error("Cannot perform this operation: {0}")]
    Metadata(&'static str),
    #[error("User does not exist")]
    UserDoesNotExist(#[from] RBACError),
    #[error("Error: {0}")]
    Custom(String),
    #[error("Dashboard does not exist or is not accessible")]
    Unauthorized,
    #[error("Invalid query parameter")]
    InvalidQueryParameter,
    #[error(transparent)]
    MetastoreError(#[from] MetastoreError),
    #[error("{message}")]
    Api {
        status: u16,
        code: &'static str,
        message: String,
        details: Value,
    },
}
impl DashboardError {
    pub fn api(
        status: u16,
        code: &'static str,
        message: impl Into<String>,
        details: Value,
    ) -> Self {
        Self::Api {
            status,
            code,
            message: message.into(),
            details,
        }
    }
    pub fn detail(&self) -> Value {
        match self {
            Self::Api {
                code,
                message,
                details,
                ..
            } => json!({"code":code,"message":message,"details":details}),
            _ => json!({"code":"DASHBOARD_ERROR","message":self.to_string()}),
        }
    }
}
impl actix_web::ResponseError for DashboardError {
    fn status_code(&self) -> StatusCode {
        match self {
            Self::ObjectStorage(_) | Self::Custom(_) => StatusCode::INTERNAL_SERVER_ERROR,
            Self::Serde(_) | Self::Metadata(_) | Self::InvalidQueryParameter => {
                StatusCode::BAD_REQUEST
            }
            Self::UserDoesNotExist(_) => StatusCode::NOT_FOUND,
            Self::Unauthorized => StatusCode::UNAUTHORIZED,
            Self::MetastoreError(e) => e.status_code(),
            Self::Api { status, .. } => {
                StatusCode::from_u16(*status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR)
            }
        }
    }
    fn error_response(&self) -> HttpResponse {
        match self {
            Self::Api { .. } => HttpResponse::build(self.status_code())
                .json(json!({"error":self.detail(),"message":self.to_string()})),
            Self::MetastoreError(error) => {
                HttpResponse::build(self.status_code()).json(error.to_detail())
            }
            _ => HttpResponse::build(self.status_code())
                .insert_header(ContentType::plaintext())
                .body(self.to_string()),
        }
    }
}

#[cfg(test)]
mod compatibility_tests {
    use super::*;
    use actix_web::{ResponseError, body::to_bytes};

    #[test]
    fn listing_preserves_sort_limit_tags_and_opt_in_cursor_contracts() {
        let mut rows = (0..600)
            .map(|index| json!({"dashboardId":format!("{index:03}"),"modified":null}))
            .collect::<Vec<_>>();
        rows[0]["modified"] = json!("2026-10-19T10:30:00+02:00");
        rows[1]["modified"] = json!("2026-10-19T09:00:00Z");
        sort_by_modified(&mut rows);
        assert_eq!(rows[0]["dashboardId"], "001");
        assert_eq!(rows[1]["dashboardId"], "000");
        assert_eq!(
            filter_listing(rows.clone(), &HashMap::new(), false, 550).len(),
            550
        );
        assert_eq!(
            filter_listing(rows.clone(), &HashMap::new(), false, 0).len(),
            600
        );
        assert_eq!(
            filter_listing(rows.clone(), &HashMap::new(), true, 1).len(),
            600
        );
        let cursor = HashMap::from([("after".to_owned(), "002".to_owned())]);
        let page = filter_listing(rows, &cursor, true, 2);
        assert_eq!(
            page.iter()
                .map(|row| row["dashboardId"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["003", "004"]
        );
    }

    #[actix_web::test]
    async fn empty_tags_are_rejected_before_storage_access() {
        let request = actix_web::test::TestRequest::get()
            .uri("/dashboards?tags=%20,%20&limit=5")
            .to_http_request();
        let error = match list_dashboards(request).await {
            Err(error) => error,
            Ok(_) => panic!("empty tags should fail"),
        };
        assert_eq!(error.status_code(), StatusCode::BAD_REQUEST);
        assert_eq!(
            error.to_string(),
            "Cannot perform this operation: Tags cannot be empty"
        );
    }

    #[actix_web::test]
    async fn legacy_errors_keep_plaintext_status_and_body() {
        for (operation, status, message) in [
            (
                LegacyOperation::Get,
                400,
                "Cannot perform this operation: Dashboard does not exist",
            ),
            (
                LegacyOperation::Update,
                400,
                "Cannot perform this operation: Dashboard does not exist or user is not authorized",
            ),
            (
                LegacyOperation::Delete,
                400,
                "Cannot perform this operation: Dashboard does not exist or you do not have permission to access it",
            ),
            (
                LegacyOperation::AddTile,
                401,
                "Dashboard does not exist or is not accessible",
            ),
        ] {
            let error = legacy_error(
                DashboardError::api(
                    404,
                    "dashboard_not_found",
                    "Dashboard does not exist",
                    json!({}),
                ),
                operation,
            );
            let response = error.error_response();
            assert_eq!(response.status().as_u16(), status);
            assert_eq!(
                response.headers()["content-type"],
                "text/plain; charset=utf-8"
            );
            assert_eq!(
                to_bytes(response.into_body()).await.unwrap().as_ref(),
                message.as_bytes()
            );
        }
        assert_eq!(
            DashboardError::api(412, "revision_conflict", "changed", json!({})).status_code(),
            StatusCode::PRECONDITION_FAILED
        );
    }
}
