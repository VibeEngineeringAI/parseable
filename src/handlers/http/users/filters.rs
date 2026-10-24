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

use crate::{
    handlers::http::rbac::RBACError,
    metastore::MetastoreError,
    parseable::PARSEABLE,
    rbac::{Users, map::SessionKey},
    storage::{ObjectStorageError, StreamType},
    users::filters::{
        CURRENT_FILTER_VERSION, FILTER_MUTATION_LOCK, FILTERS, Filter, FilterType,
        SQL_FILTER_STREAM_NAME,
    },
    utils::{
        actix::extract_session_key_from_req, get_hash, get_user_and_tenant_from_request, is_admin,
        is_admin_for_session,
    },
    validator,
};
use actix_web::http::StatusCode;
use actix_web::{
    HttpRequest, HttpResponse, Responder,
    http::header::ContentType,
    web::{self, Json, Path},
};
use serde_json::Error as SerdeError;
use ulid::Ulid;

pub async fn list(req: HttpRequest) -> Result<impl Responder, FiltersError> {
    let key =
        extract_session_key_from_req(&req).map_err(|e| FiltersError::Custom(e.to_string()))?;
    let filters = list_internal(&key).await;
    Ok((web::Json(filters), StatusCode::OK))
}

pub async fn list_internal(key: &SessionKey) -> Vec<Filter> {
    FILTERS.list_filters(key).await
}

pub async fn get(
    req: HttpRequest,
    filter_id: Path<String>,
) -> Result<impl Responder, FiltersError> {
    let key =
        extract_session_key_from_req(&req).map_err(|e| FiltersError::Custom(e.to_string()))?;
    let (_, tenant_id) = get_user_and_tenant_from_request(&req)?;
    let filter_id = filter_id.into_inner();
    let filter = get_internal(&filter_id, &key, &tenant_id).await?;
    Ok((web::Json(filter), StatusCode::OK))
}

pub async fn get_internal(
    filter_id: &str,
    key: &SessionKey,
    tenant_id: &Option<String>,
) -> Result<Filter, FiltersError> {
    let user_id = Users
        .get_userid_from_session(key)
        .map(|(user_id, _)| get_hash(&user_id))
        .ok_or_else(|| FiltersError::Custom("unknown user session".to_owned()))?;
    FILTERS
        .get_filter(filter_id, &user_id, is_admin_for_session(key), tenant_id)
        .await
        .ok_or(FiltersError::Metadata(
            "Filter does not exist or user is not authorized",
        ))
}

pub async fn post(
    req: HttpRequest,
    Json(mut filter): Json<Filter>,
) -> Result<impl Responder, FiltersError> {
    validate_stream_name(&filter.stream_name, &filter.query.filter_type)?;
    let _mutation = FILTER_MUTATION_LOCK.lock().await;

    let (mut user_id, tenant_id) = get_user_and_tenant_from_request(&req)?;
    user_id = get_hash(&user_id);
    let filter_id = Ulid::new().to_string();
    filter.filter_id = Some(filter_id.clone());
    filter.user_id = Some(user_id.clone());
    filter.version = Some(CURRENT_FILTER_VERSION.to_string());
    filter.tenant_id.clone_from(&tenant_id);
    PARSEABLE.metastore.put_filter(&filter, &tenant_id).await?;
    FILTERS.update(&filter, &tenant_id).await;

    Ok((web::Json(filter), StatusCode::OK))
}

pub async fn update(
    req: HttpRequest,
    filter_id: Path<String>,
    Json(mut filter): Json<Filter>,
) -> Result<impl Responder, FiltersError> {
    validate_stream_name(&filter.stream_name, &filter.query.filter_type)?;
    let _mutation = FILTER_MUTATION_LOCK.lock().await;

    let (mut user_id, tenant_id) = get_user_and_tenant_from_request(&req)?;
    user_id = get_hash(&user_id);
    let filter_id = filter_id.into_inner();
    let is_admin = is_admin(&req).map_err(|e| FiltersError::Custom(e.to_string()))?;

    let existing = FILTERS
        .get_filter(&filter_id, &user_id, is_admin, &tenant_id)
        .await
        .ok_or(FiltersError::Metadata(
            "Filter does not exist or user is not authorized",
        ))?;
    preserve_filter_identity(&existing, &mut filter);
    filter.filter_id = Some(filter_id.clone());
    filter.version = Some(CURRENT_FILTER_VERSION.to_string());
    filter.tenant_id.clone_from(&tenant_id);

    PARSEABLE.metastore.put_filter(&filter, &tenant_id).await?;
    FILTERS.update(&filter, &tenant_id).await;
    PARSEABLE
        .metastore
        .reconcile_filter(&filter, &tenant_id)
        .await?;

    Ok((web::Json(filter), StatusCode::OK))
}

pub async fn delete(
    req: HttpRequest,
    filter_id: Path<String>,
) -> Result<HttpResponse, FiltersError> {
    let _mutation = FILTER_MUTATION_LOCK.lock().await;
    let (mut user_id, tenant_id) = get_user_and_tenant_from_request(&req)?;
    user_id = get_hash(&user_id);
    let filter_id = filter_id.into_inner();
    let is_admin = is_admin(&req).map_err(|e| FiltersError::Custom(e.to_string()))?;
    let filter = FILTERS
        .get_filter(&filter_id, &user_id, is_admin, &tenant_id)
        .await
        .ok_or(FiltersError::Metadata(
            "Filter does not exist or user is not authorized",
        ))?;

    PARSEABLE
        .metastore
        .delete_filter(&filter, &tenant_id)
        .await?;
    FILTERS.delete_filter(&filter, &tenant_id).await;

    Ok(HttpResponse::Ok().finish())
}

/// Conversion deliberately accepts no client filter payload: metadata and ownership
/// come from the authorized stored record.
pub async fn convert_to_sql(
    req: HttpRequest,
    filter_id: Path<String>,
) -> Result<impl Responder, FiltersError> {
    let _mutation = FILTER_MUTATION_LOCK.lock().await;
    let (user_id, tenant_id) = get_user_and_tenant_from_request(&req)?;
    let is_admin = is_admin(&req).map_err(|e| FiltersError::Custom(e.to_string()))?;
    let mut filter = FILTERS
        .get_filter(&filter_id, &get_hash(&user_id), is_admin, &tenant_id)
        .await
        .ok_or(FiltersError::Metadata(
            "Filter does not exist or user is not authorized",
        ))?;
    convert_filter_to_sql(&mut filter)?;
    filter.tenant_id.clone_from(&tenant_id);
    PARSEABLE.metastore.put_filter(&filter, &tenant_id).await?;
    // Once the write succeeds, serve the new record even if alias cleanup fails.
    // A retry or startup reconciliation can safely finish cleanup.
    FILTERS.update(&filter, &tenant_id).await;
    PARSEABLE
        .metastore
        .reconcile_filter(&filter, &tenant_id)
        .await?;
    Ok((web::Json(filter), StatusCode::OK))
}

fn convert_filter_to_sql(filter: &mut Filter) -> Result<(), FiltersError> {
    if filter.query.filter_type != FilterType::SQL {
        return Err(FiltersError::Metadata("Only SQL filters can be converted"));
    }
    SQL_FILTER_STREAM_NAME.clone_into(&mut filter.stream_name);
    Ok(())
}

fn preserve_filter_identity(existing: &Filter, incoming: &mut Filter) {
    incoming.user_id.clone_from(&existing.user_id);
    if existing.query.filter_type == FilterType::SQL
        && existing.stream_name == SQL_FILTER_STREAM_NAME
        && incoming.query.filter_type == FilterType::SQL
    {
        // A client holding an older dataset-scoped copy must not undo conversion.
        SQL_FILTER_STREAM_NAME.clone_into(&mut incoming.stream_name);
    }
}

fn validate_stream_name(stream_name: &str, filter_type: &FilterType) -> Result<(), FiltersError> {
    if matches!(filter_type, FilterType::SQL) && stream_name == SQL_FILTER_STREAM_NAME {
        return Ok(());
    }
    validator::stream_name(stream_name, StreamType::UserDefined)
        .map_err(FiltersError::InvalidStreamName)
}

#[derive(Debug, thiserror::Error)]
pub enum FiltersError {
    #[error("Failed to connect to storage: {0}")]
    ObjectStorage(#[from] ObjectStorageError),
    #[error("Serde Error: {0}")]
    Serde(#[from] SerdeError),
    #[error("Operation cannot be performed: {0}")]
    Metadata(&'static str),
    #[error("User does not exist")]
    UserDoesNotExist(#[from] RBACError),
    #[error("Error: {0}")]
    Custom(String),
    #[error("Invalid stream name: {0}")]
    InvalidStreamName(#[from] validator::error::StreamNameValidationError),
    #[error(transparent)]
    MetastoreError(#[from] MetastoreError),
}

impl actix_web::ResponseError for FiltersError {
    fn status_code(&self) -> StatusCode {
        match self {
            Self::ObjectStorage(_) => StatusCode::INTERNAL_SERVER_ERROR,
            Self::Serde(_) => StatusCode::BAD_REQUEST,
            Self::Metadata(_) => StatusCode::BAD_REQUEST,
            Self::UserDoesNotExist(_) => StatusCode::NOT_FOUND,
            Self::Custom(_) => StatusCode::INTERNAL_SERVER_ERROR,
            Self::InvalidStreamName(_) => StatusCode::BAD_REQUEST,
            Self::MetastoreError(e) => e.status_code(),
        }
    }

    fn error_response(&self) -> actix_web::HttpResponse<actix_web::body::BoxBody> {
        match self {
            FiltersError::MetastoreError(metastore_error) => {
                actix_web::HttpResponse::build(self.status_code())
                    .insert_header(ContentType::json())
                    .json(metastore_error.to_detail())
            }
            _ => actix_web::HttpResponse::build(self.status_code())
                .insert_header(ContentType::plaintext())
                .body(self.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{SQL_FILTER_STREAM_NAME, validate_stream_name};
    use crate::users::filters::FilterType;
    use crate::validator::error::StreamNameValidationError;

    #[actix_web::test]
    async fn conversion_requires_authenticated_request() {
        let request = actix_web::test::TestRequest::default().to_http_request();
        assert!(matches!(
            super::convert_to_sql(request, actix_web::web::Path::from("id".to_owned())).await,
            Err(super::FiltersError::UserDoesNotExist(_))
        ));
    }

    #[test]
    fn administrator_update_preserves_owner_and_canonical_sql_scope() {
        let existing: crate::users::filters::Filter = serde_json::from_value(serde_json::json!({
            "version":"v2", "user_id":"original-owner", "filter_id":"id",
            "stream_name":"sql", "filter_name":"View", "tenant_id":null,
            "query":{"filter_type":"sql","filter_query":"select * from orders","filter_builder":null},
            "time_filter":null, "explorer_state":{"tab":"sql"}
        })).unwrap();
        let mut incoming = existing.clone();
        incoming.user_id = Some("administrator".into());
        incoming.stream_name = "orders".into();
        super::preserve_filter_identity(&existing, &mut incoming);
        assert_eq!(incoming, existing);
    }

    #[test]
    fn conversion_preserves_complete_record_and_rejects_non_sql_filters() {
        let legacy: crate::users::filters::Filter = serde_json::from_value(serde_json::json!({
            "version":"v2", "user_id":"original-owner", "filter_id":"id",
            "stream_name":"orders", "filter_name":"View", "tenant_id":"tenant",
            "query":{"filter_type":"sql","filter_query":"select * from orders","filter_builder":null},
            "time_filter":null, "explorer_state":{"tab":"sql"}, "future_field":[1,2]
        })).unwrap();
        let mut converted = legacy.clone();
        super::convert_filter_to_sql(&mut converted).unwrap();
        assert_eq!(converted.stream_name, "sql");
        let once = converted.clone();
        super::convert_filter_to_sql(&mut converted).unwrap();
        assert_eq!(converted, once);
        converted.stream_name = legacy.stream_name.clone();
        assert_eq!(converted, legacy);
        for kind in [FilterType::Filter, FilterType::Search, FilterType::Promql] {
            converted.query.filter_type = kind;
            let unchanged = converted.clone();
            assert!(super::convert_filter_to_sql(&mut converted).is_err());
            assert_eq!(converted, unchanged);
        }
    }

    #[test]
    fn accepts_flat_stream_names() {
        for stream_name in ["team1", "orders-prod", "user_events_v2"] {
            let stream_name = stream_name.to_owned();
            assert!(validate_stream_name(&stream_name, &FilterType::Filter).is_ok());
        }
    }

    #[test]
    fn accepts_legacy_and_canonical_sql_filter_stream_names() {
        for stream_name in ["orders-prod", SQL_FILTER_STREAM_NAME] {
            assert!(validate_stream_name(stream_name, &FilterType::SQL).is_ok());
        }
        for stream_name in ["../../unsafe-path", "team1/serviceA", "", "sql/../orders"] {
            assert!(validate_stream_name(stream_name, &FilterType::SQL).is_err());
        }
        assert!(validate_stream_name(SQL_FILTER_STREAM_NAME, &FilterType::Search).is_err());
    }

    #[test]
    fn promql_filters_require_a_concrete_dataset_name() {
        // PromQL evaluation is scoped to one dataset, and listing authorizes
        // the saved filter by that dataset, so the SQL sentinel is not valid.
        assert!(validate_stream_name("otel_metrics", &FilterType::Promql).is_ok());
        for stream_name in [SQL_FILTER_STREAM_NAME, "", "team1/serviceA", "../metrics"] {
            assert!(validate_stream_name(stream_name, &FilterType::Promql).is_err());
        }
    }

    #[test]
    fn rejects_path_like_stream_names() {
        let stream_name = "team1/serviceA".to_owned();
        let err = validate_stream_name(&stream_name, &FilterType::Search)
            .expect_err("path-like names must be rejected");
        assert!(matches!(
            err,
            super::FiltersError::InvalidStreamName(StreamNameValidationError::NameSpecialChar {
                c: '/'
            })
        ));
    }
}
