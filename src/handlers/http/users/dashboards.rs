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
        header::{ETAG, IF_MATCH},
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
    let tags = query.get("tags").map(|s| {
        s.split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect()
    });
    let mut rows = list_dashboards_internal(0, tags, &get_tenant_id_from_request(&req)).await?;
    if let Some(search) = query.get("query") {
        let search = search.to_lowercase();
        rows.retain(|d| {
            d["title"]
                .as_str()
                .is_some_and(|s| s.to_lowercase().contains(&search))
        });
    }
    if let Some(after) = query.get("after") {
        rows.retain(|d| {
            d["dashboardId"]
                .as_str()
                .is_some_and(|id| id > after.as_str())
        });
    }
    if limit > 0 {
        rows.truncate(limit.min(500));
    }
    Ok(web::Json(rows))
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
    rows.sort_by(|a, b| a["dashboardId"].as_str().cmp(&b["dashboardId"].as_str()));
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

pub async fn get_dashboard(
    req: HttpRequest,
    id: Path<String>,
) -> Result<HttpResponse, DashboardError> {
    Ok(document_response(
        dashboard_service::get_json(
            validate_dashboard_id(id.into_inner())?,
            &get_tenant_id_from_request(&req),
        )
        .await?,
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
    let (actor, tenant) = actor(&req)?;
    let result =
        dashboard_service::create_json(&actor, &tenant, document, &write_options(&req)?).await?;
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
        DashboardMutation::Metadata(query)
    } else {
        DashboardMutation::Replace(
            body.ok_or(DashboardError::Metadata("Request body is required"))?
                .into_inner(),
        )
    };
    let result = dashboard_service::mutate_json(
        &actor,
        validate_dashboard_id(id.into_inner())?,
        &tenant,
        mutation,
        &write_options(&req)?,
    )
    .await?;
    Ok(document_response(result["dashboard"].clone()))
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
    .await?;
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
    .await?;
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
            Self::Unauthorized => StatusCode::FORBIDDEN,
            Self::MetastoreError(e) => e.status_code(),
            Self::Api { status, .. } => {
                StatusCode::from_u16(*status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR)
            }
        }
    }
    fn error_response(&self) -> HttpResponse {
        HttpResponse::build(self.status_code())
            .json(json!({"error":self.detail(),"message":self.to_string()}))
    }
}
