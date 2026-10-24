use std::collections::HashSet;

use actix_web::{HttpRequest, HttpResponse, Responder, web};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use ulid::Ulid;

use crate::{
    apikeys::{ApiKeyError, CreateApiKeyRequest},
    handlers::http::{
        modal::utils::rbac_utils::{get_metadata, put_metadata},
        rbac::{RBACError, UPDATE_LOCK},
    },
    parseable::DEFAULT_TENANT,
    rbac::{
        Users,
        map::{roles, users},
        user::{User, UserType},
    },
    utils::{get_user_and_tenant_from_request, is_admin},
};

/// Verify the caller is an admin of their tenant or a super-admin.
fn verify_admin(req: &HttpRequest) -> Result<(String, Option<String>), ApiKeyError> {
    let (userid, tenant_id) = get_user_and_tenant_from_request(req)
        .map_err(|_| ApiKeyError::Unauthorized("Missing user identity".into()))?;

    if is_admin(req).map_err(|err| ApiKeyError::Unauthorized(err.to_string()))? {
        return Ok((userid, tenant_id));
    }

    Err(ApiKeyError::Unauthorized(
        "Only admins can manage API keys".into(),
    ))
}

/// Generate a fresh, opaque API key value as a UUID v4 string
/// (matches the original api key format used by CreateApiKeyRequest clients).
fn generate_api_key_value() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// Serialisable shape returned by create / get.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApiKeyResponse<'a> {
    key_id: Ulid,
    api_key: &'a str,
    key_name: &'a str,
    roles: &'a HashSet<String>,
    created_by: &'a str,
    created_at: DateTime<Utc>,
    modified_at: DateTime<Utc>,
    expires_at: Option<DateTime<Utc>>,
}

impl<'a> TryFrom<&'a User> for ApiKeyResponse<'a> {
    type Error = ApiKeyError;

    fn try_from(user: &'a User) -> Result<Self, Self::Error> {
        let api_key = user
            .as_api_key()
            .ok_or_else(|| ApiKeyError::KeyNotFound(user.userid().to_string()))?;
        Ok(Self {
            key_id: api_key.key_id,
            api_key: &api_key.api_key,
            key_name: &api_key.key_name,
            roles: &user.roles,
            created_by: &api_key.created_by,
            created_at: api_key.created_at,
            modified_at: api_key.modified_at,
            expires_at: api_key.expires_at,
        })
    }
}

/// Serialisable shape returned by list (api_key value masked).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApiKeyListEntry {
    key_id: Ulid,
    api_key: String,
    key_name: String,
    roles: HashSet<String>,
    created_by: String,
    created_at: DateTime<Utc>,
    modified_at: DateTime<Utc>,
    expires_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ValidateApiKeyResponse {
    valid: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidateApiKeyRequest {
    api_key: String,
}

impl ApiKeyListEntry {
    fn from_user(user: &User) -> Option<Self> {
        let api_key = user.as_api_key()?;
        let masked = if api_key.api_key.len() >= 4 {
            let last4 = &api_key.api_key[api_key.api_key.len() - 4..];
            format!("****{last4}")
        } else {
            "****".to_string()
        };
        Some(Self {
            key_id: api_key.key_id,
            api_key: masked,
            key_name: api_key.key_name.clone(),
            roles: user.roles.clone(),
            created_by: api_key.created_by.clone(),
            created_at: api_key.created_at,
            modified_at: api_key.modified_at,
            expires_at: api_key.expires_at,
        })
    }
}

fn tenant_or_default(tenant: &Option<String>) -> &str {
    tenant.as_deref().unwrap_or(DEFAULT_TENANT)
}

/// Collect all API-key-backed users for a tenant into an owned list.
/// Read lock on the users map is held only for the duration of this fn.
fn collect_tenant_api_keys(tenant_id: &Option<String>) -> Vec<User> {
    let users_guard = users();
    let tenant = tenant_or_default(tenant_id);
    users_guard
        .get(tenant)
        .into_iter()
        .flat_map(|m| m.values())
        .filter(|u| matches!(u.ty, UserType::ApiKey(_)))
        .cloned()
        .collect()
}

/// Validate that every role in the request exists in the tenant's role map.
/// Mirrors the check performed by the native-user CRUD endpoint.
fn validate_roles(
    role_names: &HashSet<String>,
    tenant_id: &Option<String>,
) -> Result<(), ApiKeyError> {
    let tenant = tenant_or_default(tenant_id);
    let tenant_roles = roles();
    let missing: Vec<String> = role_names
        .iter()
        .filter(|r| {
            tenant_roles
                .get(tenant)
                .map(|m| !m.contains_key(*r))
                .unwrap_or(true)
        })
        .cloned()
        .collect();
    if missing.is_empty() {
        Ok(())
    } else {
        Err(ApiKeyError::Rbac(RBACError::RolesDoNotExist(missing)))
    }
}

/// POST /api/prism/v1/apikeys
///
/// Create a new API key. Only admins can create keys.
pub async fn create_api_key(
    req: HttpRequest,
    web::Json(body): web::Json<CreateApiKeyRequest>,
) -> Result<impl Responder, ApiKeyError> {
    let (created_by, tenant_id) = verify_admin(&req)?;

    let guard = UPDATE_LOCK.lock().await;

    // Reject any role names that don't exist in this tenant while holding the
    // update lock so a concurrent role update cannot invalidate the check.
    validate_roles(&body.roles, &tenant_id)?;

    // Duplicate key-name detection inside the same tenant.
    let existing = collect_tenant_api_keys(&tenant_id);
    if existing
        .iter()
        .filter_map(|u| u.as_api_key())
        .any(|k| k.key_name == body.key_name)
    {
        return Err(ApiKeyError::DuplicateKeyName(body.key_name));
    }

    let key_id = Ulid::new();
    let api_key_value = generate_api_key_value();
    let mut user = User::new_api_key(
        key_id,
        api_key_value,
        body.key_name,
        body.roles,
        created_by,
        tenant_id.clone(),
    );

    if let UserType::ApiKey(key) = &mut user.ty {
        key.expires_at = body
            .ttl_seconds
            .map(|seconds| key.created_at + chrono::TimeDelta::seconds(seconds));
    }

    // Persist the new user in parseable.json and push into memory on this node.
    let mut metadata = get_metadata(&tenant_id).await?;
    metadata.users.push(user.clone());
    put_metadata(&metadata, &tenant_id).await?;
    Users.put_user(user.clone());

    // Drop the lock once local state is durable; the cluster fan-out below
    // can be slow and must not block other create/delete requests.
    drop(guard);

    // Best-effort sync to other live nodes (reuses the standard user sync).
    let caller_userid = user
        .as_api_key()
        .map(|k| k.created_by.clone())
        .unwrap_or_default();
    if let Err(e) = crate::handlers::http::cluster::sync_user_creation(
        &req,
        user.clone(),
        &None,
        &tenant_id,
        &caller_userid,
    )
    .await
    {
        tracing::error!("Failed to sync API-key user creation: {e}");
    }

    let response = ApiKeyResponse::try_from(&user)?;
    Ok(HttpResponse::Ok().json(response))
}

/// DELETE /api/prism/v1/apikeys/{key_id}
///
/// Delete an API key by key_id. Only admins can delete keys.
pub async fn delete_api_key(
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<impl Responder, ApiKeyError> {
    let (caller_userid, tenant_id) = verify_admin(&req)?;
    let key_id_str = path.into_inner();
    let key_id =
        Ulid::from_string(&key_id_str).map_err(|_| ApiKeyError::KeyNotFound(key_id_str.clone()))?;

    let guard = UPDATE_LOCK.lock().await;

    // Find the user entry for this api key.
    let (userid, key_name) = collect_tenant_api_keys(&tenant_id)
        .into_iter()
        .find_map(|u| {
            u.as_api_key()
                .filter(|k| k.key_id == key_id)
                .map(|k| (u.userid().to_string(), k.key_name.clone()))
        })
        .ok_or_else(|| ApiKeyError::KeyNotFound(key_id.to_string()))?;

    // Make cluster revocation part of the success contract. If this fails, we
    // leave the local key intact so the caller can retry the same revocation.
    if let Err(e) = crate::handlers::http::cluster::sync_user_deletion_with_ingestors(
        &req,
        &userid,
        &tenant_id,
        &caller_userid,
    )
    .await
    {
        tracing::error!("Failed to sync API-key user deletion: {e}");
        return Err(ApiKeyError::RevocationSyncFailed(e.to_string()));
    }

    // Remove from parseable.json.
    let mut metadata = get_metadata(&tenant_id).await?;
    metadata.users.retain(|u| u.userid() != userid.as_str());
    put_metadata(&metadata, &tenant_id).await?;

    // Remove from in-memory map on this node.
    Users.delete_user(&userid, &tenant_id);

    drop(guard);

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "keyId": key_id,
        "keyName": key_name,
        "message": "API key deleted successfully",
    })))
}

/// GET /api/prism/v1/apikeys
///
/// List all API keys (masked). Only admins can list keys.
pub async fn list_api_keys(req: HttpRequest) -> Result<impl Responder, ApiKeyError> {
    let (_, tenant_id) = verify_admin(&req)?;
    let entries: Vec<ApiKeyListEntry> = collect_tenant_api_keys(&tenant_id)
        .iter()
        .filter_map(ApiKeyListEntry::from_user)
        .collect();
    Ok(HttpResponse::Ok().json(entries))
}

/// POST /api/prism/v1/apikeys/validate
///
/// Validate whether an API key exists in the caller's tenant.
pub async fn validate_api_key(
    req: HttpRequest,
    web::Json(body): web::Json<ValidateApiKeyRequest>,
) -> Result<impl Responder, ApiKeyError> {
    let (_, tenant_id) = get_user_and_tenant_from_request(&req)
        .map_err(|_| ApiKeyError::Unauthorized("Missing user identity".into()))?;
    let now = Utc::now();
    let valid = collect_tenant_api_keys(&tenant_id)
        .iter()
        .filter_map(|u| u.as_api_key())
        .any(|k| k.matches_active_key(&body.api_key, now));

    Ok(HttpResponse::Ok().json(ValidateApiKeyResponse { valid }))
}

/// GET /api/prism/v1/apikeys/{key_id}
///
/// Get a specific API key (full key visible). Only admins can get keys.
pub async fn get_api_key(
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<impl Responder, ApiKeyError> {
    let (_, tenant_id) = verify_admin(&req)?;
    let key_id_str = path.into_inner();
    let key_id =
        Ulid::from_string(&key_id_str).map_err(|_| ApiKeyError::KeyNotFound(key_id_str.clone()))?;

    let user = collect_tenant_api_keys(&tenant_id)
        .into_iter()
        .find(|u| u.as_api_key().map(|k| k.key_id == key_id).unwrap_or(false))
        .ok_or_else(|| ApiKeyError::KeyNotFound(key_id.to_string()))?;

    let response = ApiKeyResponse::try_from(&user)?;
    Ok(HttpResponse::Ok().json(response))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expired_key_remains_visible_with_expiry_in_detail_and_list() {
        let mut user = User::new_api_key(
            Ulid::new(),
            "test-secret".into(),
            "test".into(),
            HashSet::new(),
            "admin".into(),
            None,
        );
        let expiry = DateTime::parse_from_rfc3339("2026-01-01T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let UserType::ApiKey(key) = &mut user.ty else {
            unreachable!()
        };
        key.expires_at = Some(expiry);
        assert!(!key.matches_active_key("test-secret", expiry));
        let detail = serde_json::to_value(ApiKeyResponse::try_from(&user).unwrap()).unwrap();
        let entry = serde_json::to_value(ApiKeyListEntry::from_user(&user).unwrap()).unwrap();
        assert_eq!(detail["expiresAt"], serde_json::to_value(expiry).unwrap());
        assert_eq!(entry["expiresAt"], detail["expiresAt"]);
        assert_eq!(entry["apiKey"], "****cret");
        assert_eq!(detail["apiKey"], "test-secret");
    }

    #[test]
    fn non_expiring_responses_include_null_expiry() {
        let user = User::new_api_key(
            Ulid::new(),
            "test-secret".into(),
            "test".into(),
            HashSet::new(),
            "admin".into(),
            None,
        );
        let detail = serde_json::to_value(ApiKeyResponse::try_from(&user).unwrap()).unwrap();
        let entry = serde_json::to_value(ApiKeyListEntry::from_user(&user).unwrap()).unwrap();
        assert!(detail.get("expiresAt").unwrap().is_null());
        assert!(entry.get("expiresAt").unwrap().is_null());
    }

    mod role_escalation {
        use std::collections::HashMap;

        use actix_web::{HttpMessage, ResponseError, http::StatusCode, test::TestRequest};
        use chrono::TimeDelta;
        use parking_lot::RwLock;

        use super::*;
        use crate::rbac::{
            map::{
                ROLES, SESSIONS, SessionKey, Sessions, USER_GROUPS, USERS, UserGroups,
                Users as UserMap, mut_roles, mut_users,
            },
            role::model::{DefaultPrivilege, Role},
            user::Basic,
        };

        const ADMIN_ROLE: &str = "tenant-admin";
        const READER_ROLE: &str = "reader";
        const INTERNAL_ROLE: &str = "internal";
        // Mirrors the internal role `rbac::map::init` adds to the default tenant.
        const SUPER_ADMIN_ROLE: &str = "super-admin";
        // A user-typed role holding SuperAdmin, e.g. from legacy metadata.
        const ELEVATED_ROLE: &str = "elevated";

        // `rbac::map::init` needs `PARSEABLE`, so tests create the maps directly.
        fn init_auth_maps() {
            USERS.get_or_init(|| RwLock::new(UserMap::default()));
            SESSIONS.get_or_init(|| RwLock::new(Sessions::default()));
            USER_GROUPS.get_or_init(|| RwLock::new(UserGroups::default()));
            ROLES.get_or_init(|| RwLock::new(HashMap::new()));
        }

        /// A fresh tenant laid out like the default tenant after `map::init`.
        fn tenant() -> String {
            init_auth_maps();
            let tenant = format!("apikey-escalation-{}", Ulid::new());
            mut_roles().insert(
                tenant.clone(),
                HashMap::from([
                    (
                        ADMIN_ROLE.to_owned(),
                        Role::create_user_role(vec![DefaultPrivilege::Admin]),
                    ),
                    (
                        READER_ROLE.to_owned(),
                        Role::create_user_role(vec![DefaultPrivilege::Reader { resource: None }]),
                    ),
                    (
                        INTERNAL_ROLE.to_owned(),
                        Role::create_internal_role(vec![DefaultPrivilege::Admin]),
                    ),
                    (
                        SUPER_ADMIN_ROLE.to_owned(),
                        Role::create_internal_role(vec![DefaultPrivilege::SuperAdmin]),
                    ),
                    (
                        ELEVATED_ROLE.to_owned(),
                        Role::create_user_role(vec![DefaultPrivilege::SuperAdmin]),
                    ),
                ]),
            );
            tenant
        }

        fn role_set(name: &str) -> HashSet<String> {
            HashSet::from([name.to_owned()])
        }

        /// A request from a tenant admin (Admin, not SuperAdmin) with a live session.
        fn tenant_admin_request(tenant: &str) -> HttpRequest {
            let admin = User {
                ty: UserType::Native(Basic {
                    username: format!("admin-{}", Ulid::new()),
                    password_hash: String::new(),
                    email: None,
                }),
                roles: role_set(ADMIN_ROLE),
                user_groups: HashSet::new(),
                tenant: Some(tenant.to_owned()),
                protected: false,
            };
            mut_users().insert(admin.clone());
            let session = SessionKey::SessionId(Ulid::new());
            Users.new_session(&admin, session.clone(), TimeDelta::minutes(5));
            let req = TestRequest::default().to_http_request();
            req.extensions_mut().insert(session);
            req
        }

        #[test]
        fn validate_roles_accepts_ordinary_role() {
            let tenant = Some(tenant());
            assert!(validate_roles(&role_set(READER_ROLE), &tenant).is_ok());
        }

        #[test]
        fn validate_roles_rejects_internal_role() {
            let tenant = Some(tenant());
            let result = validate_roles(&role_set(INTERNAL_ROLE), &tenant);
            assert!(
                matches!(result, Err(ApiKeyError::Rbac(RBACError::ProtectedRole))),
                "internal role must be rejected like the native-user path, got {result:?}"
            );
        }

        #[test]
        fn validate_roles_rejects_super_admin_privilege_role() {
            let tenant = Some(tenant());
            let result = validate_roles(&role_set(ELEVATED_ROLE), &tenant);
            assert!(
                matches!(result, Err(ApiKeyError::Rbac(RBACError::ProtectedRole))),
                "role holding SuperAdmin must be rejected like the native-user path, got {result:?}"
            );
        }

        #[tokio::test]
        async fn tenant_admin_cannot_create_super_admin_api_key() {
            let tenant = tenant();
            let req = tenant_admin_request(&tenant);
            // An existing key with the same name makes the vulnerable handler stop
            // with 409 before it reaches storage, which tests cannot initialise.
            let key_name = "escalation".to_owned();
            mut_users().insert(User::new_api_key(
                Ulid::new(),
                format!("existing-{}", Ulid::new()),
                key_name.clone(),
                HashSet::new(),
                "admin".into(),
                Some(tenant.clone()),
            ));

            for role in [SUPER_ADMIN_ROLE, ELEVATED_ROLE] {
                let body = CreateApiKeyRequest {
                    key_name: key_name.clone(),
                    roles: role_set(role),
                    ttl_seconds: None,
                };
                let Err(err) = create_api_key(req.clone(), web::Json(body)).await else {
                    panic!("API key with role {role} must be rejected");
                };
                assert!(
                    matches!(err, ApiKeyError::Rbac(RBACError::ProtectedRole)),
                    "role {role}: expected ProtectedRole, got {err:?}"
                );
                assert_eq!(err.status_code(), StatusCode::BAD_REQUEST, "role {role}");
            }
        }
    }
}
