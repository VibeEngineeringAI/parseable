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

//! API key primitives.
//!
//! API keys are persisted as a third `UserType` variant (`UserType::ApiKey`)
//! inside `parseable.json`, alongside native and OAuth users. The backing
//! user's permissions are resolved from the `roles` assigned to it (same
//! mechanism as native and OAuth users).

use std::collections::HashSet;

use serde::Deserialize;

/// Request body for creating a new API key. `roles` is a set of role names
/// that must already exist in the tenant; permissions for the backing user
/// are derived from these roles (same flow as native/OAuth users).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateApiKeyRequest {
    pub key_name: String,
    #[serde(default)]
    pub roles: HashSet<String>,
    #[serde(default, deserialize_with = "deserialize_ttl_seconds")]
    pub ttl_seconds: Option<i64>,
}

/// Validate at JSON extraction so malformed or out-of-range durations return 400.
fn deserialize_ttl_seconds<'de, D>(deserializer: D) -> Result<Option<i64>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let ttl = Option::<i64>::deserialize(deserializer)?;
    if ttl.is_some_and(|seconds| !(1800..=7_776_000).contains(&seconds)) {
        return Err(serde::de::Error::custom(
            "ttlSeconds must be an integer between 1800 and 7776000",
        ));
    }
    Ok(ttl)
}

#[derive(Debug, thiserror::Error)]
pub enum ApiKeyError {
    #[error("API key not found: {0}")]
    KeyNotFound(String),

    #[error("Duplicate key name: {0}")]
    DuplicateKeyName(String),

    #[error("Unauthorized: {0}")]
    Unauthorized(String),

    #[error("API key revocation could not be synced to all live nodes: {0}")]
    RevocationSyncFailed(String),

    #[error("{0}")]
    Storage(#[from] crate::storage::ObjectStorageError),

    #[error("{0}")]
    Rbac(#[from] crate::handlers::http::rbac::RBACError),

    #[error("{0}")]
    Anyhow(#[from] anyhow::Error),
}

impl actix_web::ResponseError for ApiKeyError {
    fn status_code(&self) -> actix_web::http::StatusCode {
        match self {
            ApiKeyError::KeyNotFound(_) => actix_web::http::StatusCode::NOT_FOUND,
            ApiKeyError::DuplicateKeyName(_) => actix_web::http::StatusCode::CONFLICT,
            ApiKeyError::Unauthorized(_) => actix_web::http::StatusCode::FORBIDDEN,
            ApiKeyError::RevocationSyncFailed(_) => {
                actix_web::http::StatusCode::SERVICE_UNAVAILABLE
            }
            ApiKeyError::Rbac(err) => actix_web::ResponseError::status_code(err),
            ApiKeyError::Storage(_) | ApiKeyError::Anyhow(_) => {
                actix_web::http::StatusCode::INTERNAL_SERVER_ERROR
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        handlers::http::rbac::RBACError,
        utils::header_parsing::{HeaderBuildError, ParseHeaderError},
    };
    use actix_web::{ResponseError, http::StatusCode};
    use serde_json::json;

    #[test]
    fn sync_header_errors_preserve_status_without_revocation_wrapping() {
        let error = ApiKeyError::from(RBACError::HeaderBuild(HeaderBuildError::Internal(
            "configured username",
        )));
        assert_eq!(error.status_code(), StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(
            error.to_string(),
            "Failed to build internal request headers"
        );

        let error = ApiKeyError::from(RBACError::HeaderBuild(HeaderBuildError::Input(
            ParseHeaderError::InvalidTenantId,
        )));
        assert_eq!(error.status_code(), StatusCode::BAD_REQUEST);

        let network_failure = ApiKeyError::RevocationSyncFailed("network failure".into());
        assert_eq!(
            network_failure.status_code(),
            StatusCode::SERVICE_UNAVAILABLE
        );
    }

    #[test]
    fn ttl_accepts_inclusive_boundaries_and_no_expiration() {
        for ttl in [json!(null), json!(1800), json!(7_776_000)] {
            let request: CreateApiKeyRequest = serde_json::from_value(json!({
                "keyName": "test", "ttlSeconds": ttl
            }))
            .unwrap();
            assert_eq!(request.ttl_seconds, ttl.as_i64());
        }
        let request: CreateApiKeyRequest =
            serde_json::from_value(json!({"keyName": "legacy"})).unwrap();
        assert_eq!(request.ttl_seconds, None);
    }

    #[test]
    fn ttl_rejects_out_of_range_and_non_integer_input() {
        for ttl in [
            json!(1799),
            json!(7_776_001),
            json!(-1),
            json!(0),
            json!(1800.5),
            json!("1800"),
            json!(true),
            json!([]),
            json!({}),
            json!(u64::MAX),
        ] {
            assert!(
                serde_json::from_value::<CreateApiKeyRequest>(json!({
                    "keyName": "test", "ttlSeconds": ttl
                }))
                .is_err(),
                "accepted {ttl}"
            );
        }
    }

    #[actix_web::test]
    async fn invalid_ttl_json_extraction_returns_bad_request() {
        use actix_web::{App, HttpResponse, test, web};
        let app = test::init_service(
            App::new().route(
                "/",
                web::post()
                    .to(|_: web::Json<CreateApiKeyRequest>| async { HttpResponse::Ok().finish() }),
            ),
        )
        .await;
        for ttl in [json!(1799), json!(7_776_001), json!(1800.5), json!("1800")] {
            let req = test::TestRequest::post()
                .uri("/")
                .set_json(json!({
                    "keyName": "test", "ttlSeconds": ttl
                }))
                .to_request();
            assert_eq!(
                test::call_service(&app, req).await.status(),
                actix_web::http::StatusCode::BAD_REQUEST
            );
        }
    }
}
