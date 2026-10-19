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
*
*/

use std::{
    future::{Ready, ready},
    rc::Rc,
    sync::Arc,
};

use actix_web::{
    Error, HttpMessage, HttpRequest, Route,
    dev::{Service, ServiceRequest, ServiceResponse, Transform, forward_ready},
    error::{ErrorBadRequest, ErrorForbidden, ErrorServiceUnavailable, ErrorUnauthorized},
    http::header::{self, HeaderMap, HeaderName, HeaderValue},
};
use argon2::{Argon2, PasswordHash, PasswordVerifier};
use chrono::{TimeDelta, Utc};
use dashmap::DashMap;
use futures_util::future::LocalBoxFuture;
use once_cell::sync::{Lazy, OnceCell};
use ulid::Ulid;

use crate::{
    handlers::{
        AUTHORIZATION_KEY, KINESIS_COMMON_ATTRIBUTES_KEY, LOG_SOURCE_KEY, LOG_SOURCE_KINESIS,
        STREAM_NAME_HEADER_KEY, TENANT_ID,
        http::{ingest::PostError, modal::OIDC_CLIENT, rbac::RBACError},
    },
    option::Mode,
    parseable::{DEFAULT_TENANT, PARSEABLE},
    rbac::{
        EXPIRY_DURATION,
        map::{SessionKey, mut_sessions, sessions, users},
        roles_to_permission, user,
        user::UserType,
    },
    tenants::TENANT_METADATA,
    utils::{get_user_and_tenant_from_request, get_user_from_request},
};
use crate::{
    rbac::Users,
    rbac::{self, role::Action},
    utils::actix::extract_session_key,
};

use serde::{Deserialize, Serialize};

pub const CLUSTER_SECRET_HEADER: &str = "x-p-cluster-secret";
pub static CLUSTER_SECRET: OnceCell<(String, String)> = OnceCell::new();

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub common_attributes: CommonAttributes,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct CommonAttributes {
    #[serde(rename = "Authorization")]
    authorization: String,
    #[serde(rename = "X-P-Stream")]
    pub x_p_stream: String,
}

pub trait RouteExt {
    /// Authenticate a multiplexed endpoint whose handler authorizes each operation.
    fn authenticate(self) -> Self;
    fn authorize(self, action: Action) -> Self;
    fn authorize_for_resource(self, action: Action) -> Self;
    fn authorize_for_user(self, action: Action) -> Self;
}

impl RouteExt for Route {
    fn authenticate(self) -> Self {
        self.wrap(Auth {
            action: Action::Query,
            method: auth_session_only,
        })
    }
    fn authorize(self, action: Action) -> Self {
        self.wrap(Auth {
            action,
            method: auth_no_context,
        })
    }

    fn authorize_for_resource(self, action: Action) -> Self {
        self.wrap(Auth {
            action,
            method: auth_resource_context,
        })
    }

    fn authorize_for_user(self, action: Action) -> Self {
        self.wrap(Auth {
            action,
            method: auth_user_context,
        })
    }
}

// Authentication Layer with no context
pub struct Auth {
    pub action: Action,
    pub method: fn(&mut ServiceRequest, Action) -> Result<rbac::Response, Error>,
}

impl<S, B> Transform<S, ServiceRequest> for Auth
where
    S: Service<ServiceRequest, Response = ServiceResponse<B>, Error = Error> + 'static,
    S::Future: 'static,
    B: 'static,
{
    type Response = ServiceResponse<B>;
    type Error = Error;
    type InitError = ();
    type Transform = AuthMiddleware<S>;
    type Future = Ready<Result<Self::Transform, Self::InitError>>;

    fn new_transform(&self, service: S) -> Self::Future {
        ready(Ok(AuthMiddleware {
            action: self.action,
            service: Rc::new(service),
            auth_method: self.method,
        }))
    }
}

pub struct AuthMiddleware<S> {
    action: Action,
    auth_method: fn(&mut ServiceRequest, Action) -> Result<rbac::Response, Error>,
    service: Rc<S>,
}

impl<S, B> Service<ServiceRequest> for AuthMiddleware<S>
where
    S: Service<ServiceRequest, Response = ServiceResponse<B>, Error = Error> + 'static,
    S::Future: 'static,
    B: 'static,
{
    type Response = ServiceResponse<B>;
    type Error = Error;
    type Future = LocalBoxFuture<'static, Result<Self::Response, Self::Error>>;

    forward_ready!(service);

    fn call(&self, mut req: ServiceRequest) -> Self::Future {
        // Extract Kinesis Firehose headers if applicable
        if self.action.eq(&Action::Ingest) {
            extract_kinesis_headers(&mut req);
        }

        // Capture the incoming tenant header value before `get_user_and_tenant`
        // potentially mutates it, so the API-key branch below sees the original
        // client-supplied value.
        let tenant_id = req
            .headers()
            .get(TENANT_ID)
            .or_else(|| req.headers().get("intra-cluster-tenant"))
            .and_then(|v| v.to_str().ok())
            .filter(|tenant| !tenant.eq(&DEFAULT_TENANT))
            .map(String::from);

        // an optional error to track the presence of CORRECT tenant header in case of ingestion
        let mut header_error = None;
        let user_and_tenant_id = get_user_and_tenant(&self.action, &mut req, &mut header_error);

        // If an API key is present in X-API-KEY or as a Bearer token, resolve it to the backing
        // `UserType::ApiKey` user and register an ephemeral session whose
        // permissions are derived from the user's assigned roles (same flow
        // as native/OAuth users). The request then falls through to the
        // normal auth check, which consults the session permissions.
        let api_key_session_id = if let Some(api_key) = extract_api_key(&req) {
            let tenant_id: Option<String> = tenant_id.clone();
            match find_api_key_user(&api_key, &tenant_id) {
                Some(user) => {
                    let Some(api_key) = user.as_api_key() else {
                        return Box::pin(async { Err(ErrorUnauthorized("Invalid API key")) });
                    };
                    let tenant = user.tenant.as_deref().unwrap_or(DEFAULT_TENANT);
                    let permissions = roles_to_permission(user.roles(), tenant);
                    let session_id = Ulid::new();
                    let session_key = SessionKey::SessionId(session_id);
                    mut_sessions().track_new(
                        user.userid().to_owned(),
                        session_key.clone(),
                        api_key.session_expires_at(Utc::now()),
                        permissions,
                        &user.tenant,
                    );
                    insert_api_key_tenant_header(&mut req, &user, is_multi_tenant());
                    req.extensions_mut().insert(session_key);
                    Some(session_id)
                }
                None => {
                    let source_ip = req
                        .peer_addr()
                        .map(|address| address.ip().to_string())
                        .unwrap_or_else(|| "unknown".to_string());
                    let endpoint = req.path();
                    let user_agent = req
                        .headers()
                        .get(header::USER_AGENT)
                        .and_then(|value| value.to_str().ok())
                        .unwrap_or_default();
                    let dataset = req
                        .match_info()
                        .get("logstream")
                        .or_else(|| {
                            req.headers()
                                .get(STREAM_NAME_HEADER_KEY)
                                .and_then(|value| value.to_str().ok())
                        })
                        .unwrap_or("unknown");

                    tracing::warn!(
                        source_ip,
                        endpoint,
                        user_agent,
                        dataset,
                        requested_tenant = tenant_id.as_deref().unwrap_or("unknown"),
                        "Invalid API key"
                    );
                    return Box::pin(async { Err(ErrorUnauthorized("Invalid API key")) });
                }
            }
        } else {
            None
        };

        let key: Result<SessionKey, Error> = extract_session_key(&mut req);

        // if action is ingestion, check if tenant is correct for basic auth user
        if self.action.eq(&Action::Ingest)
            && let Ok(key) = &key
            && let SessionKey::BasicAuth { username, password } = &key
            && let Ok((_, tenant)) = &user_and_tenant_id
            && let Some(tenant) = tenant.as_ref()
            && !Users.validate_basic_user_tenant_id(username, password, tenant)
        {
            header_error = Some(actix_web::Error::from(PostError::Header(
                crate::utils::header_parsing::ParseHeaderError::InvalidTenantId,
            )));
        }

        let auth_result: Result<_, Error> = (self.auth_method)(&mut req, self.action);
        let headers = req.headers().clone();
        let service = Rc::clone(&self.service);
        let auth_method = self.auth_method;
        let action = self.action;
        Box::pin(async move {
            // Guard cleans up the ephemeral session created for an API-key
            // request when this future finishes (success OR failure).
            struct ApiKeySessionGuard(Option<Ulid>);
            impl Drop for ApiKeySessionGuard {
                fn drop(&mut self) {
                    if let Some(sid) = self.0 {
                        mut_sessions().remove_session(&SessionKey::SessionId(sid));
                    }
                }
            }
            let _api_key_guard = ApiKeySessionGuard(api_key_session_id);

            let Ok(key) = key else {
                return Err(ErrorUnauthorized(
                    "Your session has expired or is no longer valid. Please re-authenticate to access this resource.",
                ));
            };

            if let Some(err) = header_error {
                return Err(err);
            }

            auth_result?;
            let api_key_session = api_key_session_id.map(SessionKey::SessionId);
            // Basic auth retains its existing precedence when both mechanisms
            // are supplied. Only the selected non-API session may be refreshed.
            if api_key_session.as_ref() != Some(&key) && sessions().is_session_expired(&key) {
                refresh_token(user_and_tenant_id, &key, headers).await?;
            }
            if let Some(api_key_session) = &api_key_session {
                // This per-request session is capped by the credential's expiry.
                // Check it after any Basic refresh without scanning users again.
                let sessions = sessions();
                if sessions.get(api_key_session).is_none()
                    || sessions.is_session_expired(api_key_session)
                {
                    return Err(ErrorUnauthorized("Invalid API key"));
                }
            }
            // Recheck after any async refresh or administrative grant change.
            match auth_method(&mut req, action)? {
                rbac::Response::UnAuthorized => {
                    return Err(ErrorForbidden(
                        "You don't have permission to access this resource. Please contact your administrator for assistance.",
                    ));
                }
                rbac::Response::ReloadRequired => {
                    return Err(ErrorUnauthorized(
                        "Your session has expired or is no longer valid. Please re-authenticate to access this resource.",
                    ));
                }
                rbac::Response::Suspended(msg) => {
                    return Err(ErrorBadRequest(msg));
                }
                _ => {}
            }

            service.call(req).await
        })
    }
}

/// Extract Kinesis Firehose headers (Authorization, X-P-Stream) from
/// the x-amz-firehose-common-attributes custom header when present.
fn extract_kinesis_headers(req: &mut ServiceRequest) {
    if let Some(kinesis_common_attributes) =
        req.request().headers().get(KINESIS_COMMON_ATTRIBUTES_KEY)
        && let Ok(attribute_value) = kinesis_common_attributes.to_str()
        && let Ok(message) = serde_json::from_str::<Message>(attribute_value)
        && let Ok(auth_value) =
            header::HeaderValue::from_str(&message.common_attributes.authorization)
        && let Ok(stream_name_key) =
            header::HeaderValue::from_str(&message.common_attributes.x_p_stream)
    {
        req.headers_mut()
            .insert(HeaderName::from_static(AUTHORIZATION_KEY), auth_value);
        req.headers_mut().insert(
            HeaderName::from_static(STREAM_NAME_HEADER_KEY),
            stream_name_key,
        );
        req.headers_mut().insert(
            HeaderName::from_static(LOG_SOURCE_KEY),
            header::HeaderValue::from_static(LOG_SOURCE_KINESIS),
        );
    }
}

/// Extract an API key from X-API-KEY or an Authorization Bearer token.
/// X-API-KEY takes precedence when both headers are present.
fn extract_api_key(req: &ServiceRequest) -> Option<String> {
    if let Some(api_key) = req
        .headers()
        .get("x-api-key")
        .and_then(|v| v.to_str().ok())
        .map(String::from)
    {
        return Some(api_key);
    }

    req.headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split_once(' '))
        .and_then(|(scheme, api_key)| {
            scheme
                .eq_ignore_ascii_case("Bearer")
                .then_some(api_key.trim_start_matches(' '))
        })
        .filter(|api_key| !api_key.is_empty())
        .map(String::from)
}

/// Add the tenant resolved from an API-key user to a multi-tenant request.
fn insert_api_key_tenant_header(
    req: &mut ServiceRequest,
    user: &user::User,
    is_multi_tenant: bool,
) {
    if is_multi_tenant {
        let tenant = user.tenant.as_deref().unwrap_or(DEFAULT_TENANT);
        req.headers_mut().insert(
            HeaderName::from_static(TENANT_ID),
            HeaderValue::from_str(tenant).unwrap(),
        );
    }
}

/// Unit tests cannot initialize `PARSEABLE`, which parses the process arguments,
/// so they exercise the middleware in single-tenant mode.
#[cfg(not(test))]
fn is_multi_tenant() -> bool {
    PARSEABLE.options.is_multi_tenant()
}

#[cfg(test)]
fn is_multi_tenant() -> bool {
    false
}

/// Resolve an incoming API key value to its backing `UserType::ApiKey` user.
/// In multi-tenant deployments the `tenant_hint` is required and the lookup
/// is scoped to that tenant; in single-tenant deployments we look in the
/// default tenant. This prevents an API key from one tenant authenticating a
/// request that is claiming another.
fn find_api_key_user(api_key_value: &str, tenant_id: &Option<String>) -> Option<user::User> {
    let tenant = if is_multi_tenant() {
        tenant_id.as_deref()?
    } else {
        DEFAULT_TENANT
    };

    let users_guard = users();
    let tenant_users = users_guard.get(tenant)?;
    let now = Utc::now();
    tenant_users.values().find_map(|user| {
        if let UserType::ApiKey(api_key) = &user.ty
            && api_key.matches_active_key(api_key_value, now)
        {
            Some(user.clone())
        } else {
            None
        }
    })
}

#[inline]
fn get_user_and_tenant(
    action: &Action,
    request: &mut ServiceRequest,
    header_error: &mut Option<Error>,
) -> Result<(Result<String, RBACError>, Option<String>), RBACError> {
    if is_multi_tenant() {
        // if ingestion then tenant MUST be present and should not be DEFAULT_TENANT
        let tenant = if action.eq(&Action::Ingest) {
            if let Some(tenant) = request.headers().get(TENANT_ID)
                && let Ok(tenant) = tenant.to_str()
            {
                if tenant.eq(DEFAULT_TENANT) {
                    *header_error = Some(actix_web::Error::from(PostError::Header(
                        crate::utils::header_parsing::ParseHeaderError::InvalidTenantId,
                    )));
                }
                Some(tenant.to_owned())
            } else {
                // tenant header is not present, error out
                *header_error = Some(actix_web::Error::from(PostError::Header(
                    crate::utils::header_parsing::ParseHeaderError::MissingTenantId,
                )));
                None
            }
        } else if action.eq(&Action::SuperAdmin) || action.eq(&Action::Login) {
            None
        } else {
            // tenant header should not be present, modify request to add
            let mut t = None;
            if let Ok((_, tenant)) = get_user_and_tenant_from_request(request.request())
                && let Some(tid) = tenant.as_ref()
            {
                request.headers_mut().insert(
                    HeaderName::from_static(TENANT_ID),
                    HeaderValue::from_str(tid).unwrap(),
                );
                t = tenant;
            } else {
                // remove the header if already present
                request.headers_mut().remove(TENANT_ID);
            }
            t
        };
        let userid = get_user_from_request(request.request());
        Ok((userid, tenant))
    } else {
        // not multi-tenant, tenant header should NOT be present
        if request.headers().get(TENANT_ID).is_some() {
            *header_error = Some(actix_web::Error::from(PostError::Header(
                crate::utils::header_parsing::ParseHeaderError::UnexpectedHeader(TENANT_ID.into()),
            )));
        }
        let userid = get_user_from_request(request.request());
        Ok((userid, None))
    }
}

// Serialize refreshes per (tenant, userid) and reload bearer state after waiting.
// Concurrent browser requests must not reuse a refresh token that the previous
// request rotated; other users' refreshes proceed independently.
type RefreshLocks = DashMap<(String, String), Arc<tokio::sync::Mutex<()>>>;
static OAUTH_REFRESH_LOCKS: Lazy<RefreshLocks> = Lazy::new(DashMap::new);

const SESSION_EXPIRED: &str = "Your session has expired. Please re-authenticate.";

#[inline]
pub async fn refresh_token(
    user_and_tenant_id: Result<(Result<String, RBACError>, Option<String>), RBACError>,
    key: &SessionKey,
    headers: HeaderMap,
) -> Result<(), Error> {
    if !sessions().is_session_expired(key) {
        return Ok(());
    }
    let (userid, tenant_id) = user_and_tenant_id
        .and_then(|(userid, tenant)| userid.map(|userid| (userid, tenant)))
        .map_err(|_| ErrorUnauthorized(SESSION_EXPIRED))?;
    let user = Users
        .get_user(&userid, &tenant_id)
        .ok_or_else(|| ErrorUnauthorized(SESSION_EXPIRED))?;
    if user.is_oauth() {
        let lock_key = (
            tenant_id.as_deref().unwrap_or(DEFAULT_TENANT).to_owned(),
            userid.clone(),
        );
        let lock = OAUTH_REFRESH_LOCKS
            .entry(lock_key.clone())
            .or_default()
            .clone();
        let result = {
            let _refresh_guard = lock.lock().await;
            refresh_oauth_session(&userid, &tenant_id, key, headers).await
        };
        drop(lock);
        // Waiters hold their own clone, so an entry is only dropped when idle.
        OAUTH_REFRESH_LOCKS.remove_if(&lock_key, |_, lock| Arc::strong_count(lock) == 1);
        return result;
    }
    // Serialize native renewal with administrative writes.
    let _guard = crate::handlers::http::rbac::UPDATE_LOCK.lock().await;
    if !Users
        .get_userid_from_session(key)
        .is_some_and(|(user, tenant)| {
            user == userid && tenant == tenant_id.as_deref().unwrap_or(DEFAULT_TENANT)
        })
    {
        return Err(ErrorUnauthorized(SESSION_EXPIRED));
    }
    let current = Users
        .get_user(&userid, &tenant_id)
        .ok_or_else(|| ErrorUnauthorized(SESSION_EXPIRED))?;
    Users.new_session(&current, key.clone(), EXPIRY_DURATION);
    Ok(())
}

/// Must run under the user's refresh lock. Only an affirmative refusal from the
/// provider (or a deleted/rebound user) ends all of the user's sessions;
/// transient provider or storage failures fail just this request and leave the
/// expired session in place so the next request retries.
async fn refresh_oauth_session(
    userid: &str,
    tenant_id: &Option<String>,
    key: &SessionKey,
    headers: HeaderMap,
) -> Result<(), Error> {
    use crate::{handlers::http::oidc::OIDCError, oauth::AuthorizationRevoked};

    // Another request may have refreshed this session while we waited.
    if !sessions().is_session_expired(key) {
        return Ok(());
    }
    // Reload after waiting: the previous holder may have rotated the bearer.
    let user = Users
        .get_user(userid, tenant_id)
        .ok_or_else(|| ErrorUnauthorized(SESSION_EXPIRED))?;
    let UserType::OAuth(oauth) = &user.ty else {
        return Err(ErrorUnauthorized(SESSION_EXPIRED));
    };
    let revoke = || {
        mut_sessions().remove_user(userid, tenant_id.as_deref().unwrap_or(DEFAULT_TENANT));
        ErrorUnauthorized(SESSION_EXPIRED)
    };
    let unavailable = || {
        ErrorServiceUnavailable(
            "Unable to revalidate your session with the identity provider. Please retry.",
        )
    };
    let session = match OIDC_CLIENT.get() {
        Some(client) => client
            .read()
            .await
            .refresh_session(oauth, Some(PARSEABLE.options.scope.as_str()), headers)
            .await
            .map_err(|error| {
                if AuthorizationRevoked::is_revoked(&error) {
                    revoke()
                } else {
                    tracing::warn!("OIDC session refresh failed transiently: {error}");
                    unavailable()
                }
            })?,
        None => return Err(revoke()),
    };
    match crate::handlers::http::oidc::reconcile_oauth_session(
        session,
        tenant_id.clone(),
        Some(userid),
        key.clone(),
    )
    .await
    {
        Ok(_) => Ok(()),
        Err(OIDCError::Unauthorized) => Err(revoke()),
        Err(error) => {
            tracing::warn!("Failed to persist refreshed OIDC authorization: {error}");
            Err(unavailable())
        }
    }
}

#[inline(always)]
pub fn check_suspension(req: &HttpRequest, action: Action) -> rbac::Response {
    let tenant = req.headers().get(TENANT_ID).and_then(|v| v.to_str().ok());
    check_suspension_for_tenant(tenant, action)
}

/// Variant of check_suspension that takes the tenant id directly.
/// Useful when the caller has already captured the tenant from the request
/// (e.g., before another function may have mutated the TENANT_ID header).
pub fn check_suspension_for_tenant(tenant: Option<&str>, action: Action) -> rbac::Response {
    if let Some(tenant) = tenant
        && let Ok(Some(suspension)) = TENANT_METADATA.is_action_suspended(tenant, &action)
    {
        return rbac::Response::Suspended(suspension);
    }
    rbac::Response::Authorized
}

pub fn auth_no_context(req: &mut ServiceRequest, action: Action) -> Result<rbac::Response, Error> {
    // check if tenant is suspended
    if let rbac::Response::Suspended(msg) = check_suspension(req.request(), action) {
        return Ok(rbac::Response::Suspended(msg));
    }
    let creds = if let Some(session) = req.extensions().get::<SessionKey>() {
        Ok(session.clone())
    } else {
        extract_session_key(req)
    };
    // let creds = extract_session_key(req);
    creds.map(|key| Users.authorize(key, action, None, None))
}

fn auth_session_only(req: &mut ServiceRequest, _action: Action) -> Result<rbac::Response, Error> {
    let cached = { req.extensions().get::<SessionKey>().cloned() };
    let key = match cached {
        Some(key) => key,
        None => extract_session_key(req)?,
    };
    if !Users.session_exists(&key) {
        // Basic credentials are verified and lazily registered by authorize.
        // Its resource decision is intentionally left to the selected tool.
        let _ = Users.authorize(key.clone(), Action::GetAbout, None, None);
    }
    Ok(if Users.session_exists(&key) {
        rbac::Response::Authorized
    } else {
        rbac::Response::ReloadRequired
    })
}

pub fn auth_resource_context(
    req: &mut ServiceRequest,
    action: Action,
) -> Result<rbac::Response, Error> {
    // check if tenant is suspended
    if let rbac::Response::Suspended(msg) = check_suspension(req.request(), action) {
        return Ok(rbac::Response::Suspended(msg));
    }
    let creds = extract_session_key(req);
    let usergroup = req.match_info().get("usergroup");
    let llmid = req.match_info().get("llmid");
    let mut stream = req.match_info().get("logstream");
    if let Some(usergroup) = usergroup {
        creds.map(|key| Users.authorize(key, action, Some(usergroup), None))
    } else if let Some(llmid) = llmid {
        creds.map(|key| Users.authorize(key, action, Some(llmid), None))
    } else if let Some(stream) = stream {
        creds.map(|key| Users.authorize(key, action, Some(stream), None))
    } else {
        if let Some(stream_name) = req.headers().get(STREAM_NAME_HEADER_KEY) {
            stream = Some(stream_name.to_str().unwrap());
        }
        creds.map(|key| Users.authorize(key, action, stream, None))
    }
}

pub fn auth_user_context(
    req: &mut ServiceRequest,
    action: Action,
) -> Result<rbac::Response, Error> {
    // check if tenant is suspended
    if let rbac::Response::Suspended(msg) = check_suspension(req.request(), action) {
        return Ok(rbac::Response::Suspended(msg));
    }
    let creds = extract_session_key(req);
    let user = req.match_info().get("userid");
    creds.map(|key| Users.authorize(key, action, None, user))
}

// The credentials set in the env vars (P_USERNAME & P_PASSWORD) are treated
// as root credentials. Any other user is not allowed to modify or delete
// the root user. Deny request if username is same as username
// from env variable P_USERNAME.
pub struct DisAllowRootUser;

impl<S, B> Transform<S, ServiceRequest> for DisAllowRootUser
where
    S: Service<ServiceRequest, Response = ServiceResponse<B>, Error = Error>,
    S::Future: 'static,
    B: 'static,
{
    type Response = ServiceResponse<B>;
    type Error = Error;
    type InitError = ();
    type Transform = DisallowRootUserMiddleware<S>;
    type Future = Ready<Result<Self::Transform, Self::InitError>>;

    fn new_transform(&self, service: S) -> Self::Future {
        ready(Ok(DisallowRootUserMiddleware { service }))
    }
}

pub struct DisallowRootUserMiddleware<S> {
    service: S,
}

impl<S, B> Service<ServiceRequest> for DisallowRootUserMiddleware<S>
where
    S: Service<ServiceRequest, Response = ServiceResponse<B>, Error = Error>,
    S::Future: 'static,
    B: 'static,
{
    type Response = ServiceResponse<B>;
    type Error = Error;
    type Future = LocalBoxFuture<'static, Result<Self::Response, Self::Error>>;

    forward_ready!(service);

    fn call(&self, req: ServiceRequest) -> Self::Future {
        let username = req.match_info().get("userid").unwrap_or("");
        let is_root = username == PARSEABLE.options.username;
        let fut = self.service.call(req);

        Box::pin(async move {
            if is_root {
                return Err(ErrorBadRequest("Cannot call this API for root admin user"));
            }
            fut.await
        })
    }
}

// The credentials set in the env vars (P_USERNAME & P_PASSWORD) are treated
// as root credentials. Any other user is not allowed to modify or delete
// the root user. Deny request if username is same as username
// from env variable P_USERNAME.
pub struct IntraClusterRequest;

impl<S, B> Transform<S, ServiceRequest> for IntraClusterRequest
where
    S: Service<ServiceRequest, Response = ServiceResponse<B>, Error = Error>,
    S::Future: 'static,
    B: 'static,
{
    type Response = ServiceResponse<B>;
    type Error = Error;
    type InitError = ();
    type Transform = IntraClusterRequestMiddleware<S>;
    type Future = Ready<Result<Self::Transform, Self::InitError>>;

    fn new_transform(&self, service: S) -> Self::Future {
        ready(Ok(IntraClusterRequestMiddleware { service }))
    }
}

pub struct IntraClusterRequestMiddleware<S> {
    service: S,
}

impl<S, B> Service<ServiceRequest> for IntraClusterRequestMiddleware<S>
where
    S: Service<ServiceRequest, Response = ServiceResponse<B>, Error = Error>,
    S::Future: 'static,
    B: 'static,
{
    type Response = ServiceResponse<B>;
    type Error = Error;
    type Future = LocalBoxFuture<'static, Result<Self::Response, Self::Error>>;

    forward_ready!(service);

    fn call(&self, mut req: ServiceRequest) -> Self::Future {
        let (err, id) = if let Some((secret, _)) = CLUSTER_SECRET.get() {
            if let Some(header) = req.headers().get(CLUSTER_SECRET_HEADER)
                && let Some(tenant) = req.headers().get("intra-cluster-tenant")
                && let Some(userid) = req.headers().get("intra-cluster-userid")
                && let Ok(incoming_secret) = header.to_str()
                && let Ok(tenant) = tenant.to_str()
                && let Ok(userid) = userid.to_str()
            {
                // validate the incoming header value
                let parsed_hash = PasswordHash::new(incoming_secret).unwrap();
                if Argon2::default()
                    .verify_password(secret.as_bytes(), &parsed_hash)
                    .is_ok()
                {
                    // create a user session (how to remove that later?)
                    let tenant_id = if tenant.eq(DEFAULT_TENANT) {
                        None
                    } else {
                        Some(tenant.to_owned())
                    };
                    let user = Users.get_user(userid, &tenant_id);
                    // Forwarded work must not outlive the API key that authorized it.
                    if user
                        .as_ref()
                        .and_then(|user| user.as_api_key())
                        .is_some_and(|api_key| api_key.is_expired_at(Utc::now()))
                    {
                        return Box::pin(async { Err(ErrorUnauthorized("Invalid API key")) });
                    }
                    let id = if let Some(user) = user {
                        let id = Ulid::new();
                        req.headers_mut().insert(
                            header::COOKIE,
                            HeaderValue::from_str(&format!("session={}", id)).unwrap(),
                        );

                        // remove basic auth header
                        req.headers_mut().remove(header::AUTHORIZATION);

                        let session = SessionKey::SessionId(id);
                        req.extensions_mut().insert(session.clone());
                        Users.new_session(&user, session, TimeDelta::seconds(20));
                        Some(id)
                    } else {
                        None
                    };
                    (None, id)
                } else {
                    (
                        Some("Incoming intra-cluster request validation failed"),
                        None,
                    )
                }
            } else {
                (
                    Some(
                        "Incoming intra-cluster request doesn't contain the proper header or the server was started without P_CLUSTER_SECRET",
                    ),
                    None,
                )
            }
        } else {
            (None, None)
        };

        let fut = self.service.call(req);

        Box::pin(async move {
            if let Some(err) = err {
                return Err(ErrorUnauthorized(err));
            }
            let res = fut.await;
            if let Some(id) = id {
                mut_sessions().remove_session(&SessionKey::SessionId(id));
            }
            res
        })
    }
}

/// ModeFilterMiddleware factory
pub struct ModeFilter;

/// PathFilterMiddleware needs to implement Service trait
impl<S, B> Transform<S, ServiceRequest> for ModeFilter
where
    S: Service<ServiceRequest, Response = ServiceResponse<B>, Error = Error>,
    S::Future: 'static,
    B: 'static,
{
    type Response = ServiceResponse<B>;
    type Error = Error;
    type InitError = ();
    type Transform = ModeFilterMiddleware<S>;
    type Future = Ready<Result<Self::Transform, Self::InitError>>;

    fn new_transform(&self, service: S) -> Self::Future {
        ready(Ok(ModeFilterMiddleware { service }))
    }
}

/// Actual middleware service
pub struct ModeFilterMiddleware<S> {
    service: S,
}

/// Impl the service trait for the middleware service
impl<S, B> Service<ServiceRequest> for ModeFilterMiddleware<S>
where
    S: Service<ServiceRequest, Response = ServiceResponse<B>, Error = Error>,
    S::Future: 'static,
    B: 'static,
{
    type Response = ServiceResponse<B>;
    type Error = Error;
    type Future = LocalBoxFuture<'static, Result<Self::Response, Self::Error>>;

    // impl poll_ready
    actix_web::dev::forward_ready!(service);

    fn call(&self, req: ServiceRequest) -> Self::Future {
        let path = req.path();
        let mode = &PARSEABLE.options.mode;
        // change error messages based on mode
        match mode {
            Mode::Query => {
                // In Query mode, only allows /ingest endpoint, and /logstream endpoint with GET method
                let base_cond = path.split('/').any(|x| x == "ingest");
                let logstream_cond =
                    !(path.split('/').any(|x| x == "logstream") && req.method() == "GET");
                if base_cond {
                    Box::pin(async {
                        Err(actix_web::error::ErrorUnauthorized(
                            "Ingestion API cannot be accessed in Query Mode",
                        ))
                    })
                } else if logstream_cond {
                    Box::pin(async {
                        Err(actix_web::error::ErrorUnauthorized(
                            "Logstream cannot be changed in Query Mode",
                        ))
                    })
                } else {
                    let fut = self.service.call(req);

                    Box::pin(async move {
                        let res = fut.await?;
                        Ok(res)
                    })
                }
            }

            Mode::Ingest => {
                let accessable_endpoints = ["ingest", "logstream", "liveness", "readiness"];
                let cond = path.split('/').any(|x| accessable_endpoints.contains(&x));
                if !cond {
                    Box::pin(async {
                        Err(actix_web::error::ErrorUnauthorized(
                            "Only Ingestion API can be accessed in Ingest Mode",
                        ))
                    })
                } else {
                    let fut = self.service.call(req);

                    Box::pin(async move {
                        let res = fut.await?;
                        Ok(res)
                    })
                }
            }

            Mode::All => {
                let fut = self.service.call(req);

                Box::pin(async move {
                    let res = fut.await?;
                    Ok(res)
                })
            }

            Mode::Index | Mode::Prism => {
                let fut = self.service.call(req);

                Box::pin(async move {
                    let res = fut.await?;
                    Ok(res)
                })
            }
        }
    }
}

#[cfg(test)]
mod api_key_header_tests {
    use std::collections::HashSet;

    use actix_web::test as actix_test;

    use super::*;

    #[test]
    fn extracts_x_api_key() {
        let req = actix_test::TestRequest::default()
            .insert_header(("x-api-key", "x-api-key-value"))
            .to_srv_request();

        assert_eq!(extract_api_key(&req).as_deref(), Some("x-api-key-value"));
    }

    #[test]
    fn extracts_bearer_api_key() {
        let req = actix_test::TestRequest::default()
            .insert_header((header::AUTHORIZATION, "Bearer bearer-api-key-value"))
            .to_srv_request();

        assert_eq!(
            extract_api_key(&req).as_deref(),
            Some("bearer-api-key-value")
        );
    }

    #[test]
    fn bearer_scheme_is_case_insensitive() {
        let req = actix_test::TestRequest::default()
            .insert_header((header::AUTHORIZATION, "bearer api-key-value"))
            .to_srv_request();

        assert_eq!(extract_api_key(&req).as_deref(), Some("api-key-value"));
    }

    #[test]
    fn bearer_allows_repeated_spaces_before_api_key() {
        let req = actix_test::TestRequest::default()
            .insert_header((header::AUTHORIZATION, "Bearer   api-key-value"))
            .to_srv_request();

        assert_eq!(extract_api_key(&req).as_deref(), Some("api-key-value"));
    }

    #[test]
    fn bearer_requires_api_key() {
        let req = actix_test::TestRequest::default()
            .insert_header((header::AUTHORIZATION, "Bearer   "))
            .to_srv_request();

        assert_eq!(extract_api_key(&req), None);
    }

    #[test]
    fn ignores_non_bearer_authorization() {
        let req = actix_test::TestRequest::default()
            .insert_header((header::AUTHORIZATION, "Basic dXNlcjpwYXNzd29yZA=="))
            .to_srv_request();

        assert_eq!(extract_api_key(&req), None);
    }

    #[test]
    fn x_api_key_takes_precedence_over_bearer() {
        let req = actix_test::TestRequest::default()
            .insert_header(("x-api-key", "x-api-key-value"))
            .insert_header((header::AUTHORIZATION, "Bearer bearer-api-key-value"))
            .to_srv_request();

        assert_eq!(extract_api_key(&req).as_deref(), Some("x-api-key-value"));
    }

    #[test]
    fn extracted_header_values_follow_key_expiry() {
        let mut user = user::User::new_api_key(
            Ulid::new(),
            "test-secret".into(),
            "test".into(),
            HashSet::new(),
            "admin".into(),
            None,
        );
        let UserType::ApiKey(key) = &mut user.ty else {
            unreachable!()
        };
        let now = chrono::DateTime::parse_from_rfc3339("2026-01-01T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        key.expires_at = Some(now);
        for (header_name, header_value) in [
            ("x-api-key", "test-secret"),
            ("authorization", "Bearer test-secret"),
        ] {
            let request = actix_test::TestRequest::default()
                .insert_header((header_name, header_value))
                .to_srv_request();
            let value = extract_api_key(&request).unwrap();
            assert!(key.matches_active_key(&value, now - TimeDelta::nanoseconds(1)));
            assert!(!key.matches_active_key(&value, now));
            assert!(!key.matches_active_key(&value, now + TimeDelta::nanoseconds(1)));
        }
    }

    #[test]
    fn resolved_api_key_user_sets_multi_tenant_header() {
        let user = user::User::new_api_key(
            Ulid::new(),
            "valid-api-key".to_owned(),
            "test-key".to_owned(),
            HashSet::new(),
            "admin".to_owned(),
            Some("acme".to_owned()),
        );
        let mut req = actix_test::TestRequest::default().to_srv_request();

        insert_api_key_tenant_header(&mut req, &user, true);

        assert_eq!(req.headers().get(TENANT_ID).unwrap(), "acme");
    }
}

#[cfg(test)]
mod api_key_auth_tests {
    use std::collections::{HashMap, HashSet};

    use actix_web::{App, HttpResponse, http::StatusCode, test as actix_test, web};
    use argon2::{PasswordHasher, password_hash::SaltString};
    use base64::{Engine, prelude::BASE64_STANDARD};
    use chrono::DateTime;
    use parking_lot::RwLock;
    use tokio::sync::{Mutex, MutexGuard};

    use super::*;
    use crate::rbac::{
        map::{
            ROLES, SESSIONS, Sessions, USER_GROUPS, USERS, UserGroups, Users as UserMap, mut_users,
        },
        role::model::{DefaultPrivilege, Role},
    };

    const ROLE: &str = "api-key-expiry-admin";
    const CLUSTER_TEST_SECRET: &str = "api-key-expiry-cluster-secret";

    type AuthMethod = fn(&mut ServiceRequest, Action) -> Result<rbac::Response, Error>;

    static SERIAL: Mutex<()> = Mutex::const_new(());

    // `rbac::map::init` needs `PARSEABLE`, so tests create the maps directly.
    // Tests use their own users but run one at a time: concurrent first Basic
    // logins and session checks take the user and session locks in opposite order.
    async fn auth_state() -> MutexGuard<'static, ()> {
        let serial = SERIAL.lock().await;
        init_auth_maps();
        serial
    }

    fn blocking_auth_state() -> MutexGuard<'static, ()> {
        let serial = SERIAL.blocking_lock();
        init_auth_maps();
        serial
    }

    fn init_auth_maps() {
        USERS.get_or_init(|| RwLock::new(UserMap::default()));
        SESSIONS.get_or_init(|| RwLock::new(Sessions::default()));
        USER_GROUPS.get_or_init(|| RwLock::new(UserGroups::default()));
        ROLES.get_or_init(|| {
            let role = Role::create_internal_role(vec![DefaultPrivilege::Admin]);
            let roles = HashMap::from([(ROLE.to_owned(), role)]);
            RwLock::new(HashMap::from([(DEFAULT_TENANT.to_owned(), roles)]))
        });
        CLUSTER_SECRET.get_or_init(|| {
            let salt = SaltString::encode_b64(b"api-key-expiry-salt").unwrap();
            let hash = Argon2::default()
                .hash_password(CLUSTER_TEST_SECRET.as_bytes(), &salt)
                .unwrap()
                .to_string();
            (CLUSTER_TEST_SECRET.to_owned(), hash)
        });
    }

    fn api_key_user(expires_at: Option<DateTime<Utc>>) -> (user::User, String) {
        let secret = format!("api-key-expiry-{}", Ulid::new());
        let mut user = user::User::new_api_key(
            Ulid::new(),
            secret.clone(),
            "expiry-test".into(),
            HashSet::from([ROLE.to_owned()]),
            "admin".into(),
            None,
        );
        let UserType::ApiKey(key) = &mut user.ty else {
            unreachable!()
        };
        key.expires_at = expires_at;
        mut_users().insert(user.clone());
        (user, secret)
    }

    fn api_key_headers(secret: &str) -> [(&'static str, String); 2] {
        [
            ("x-api-key", secret.to_owned()),
            ("authorization", format!("Bearer {secret}")),
        ]
    }

    fn cluster_headers(user: &user::User) -> [(&'static str, String); 3] {
        [
            (
                CLUSTER_SECRET_HEADER,
                CLUSTER_SECRET.get().unwrap().1.clone(),
            ),
            ("intra-cluster-tenant", DEFAULT_TENANT.to_owned()),
            ("intra-cluster-userid", user.userid().to_owned()),
        ]
    }

    fn has_sessions(user: &user::User) -> bool {
        sessions()
            .get_active_sessions()
            .iter()
            .any(|(_, userid, _)| userid == user.userid())
    }

    async fn request(
        method: AuthMethod,
        intra_cluster: bool,
        headers: &[(&'static str, String)],
    ) -> StatusCode {
        let route = web::get()
            .to(|| async { HttpResponse::Ok().finish() })
            .wrap(Auth {
                action: Action::Query,
                method,
            });
        let app = if intra_cluster {
            actix_test::init_service(App::new().route("/", route.wrap(IntraClusterRequest))).await
        } else {
            actix_test::init_service(App::new().route("/", route)).await
        };
        let mut req = actix_test::TestRequest::get().uri("/");
        for header in headers {
            req = req.insert_header(header.clone());
        }
        match actix_test::try_call_service(&app, req.to_request()).await {
            Ok(response) => response.status(),
            Err(error) => error.as_response_error().status_code(),
        }
    }

    /// Simulates the key's deadline passing after its session was registered.
    fn expire_session_then_authorize(
        req: &mut ServiceRequest,
        action: Action,
    ) -> Result<rbac::Response, Error> {
        let key = req.extensions().get::<SessionKey>().cloned().unwrap();
        if let Some((userid, tenant)) = Users.get_userid_from_session(&key) {
            let permissions = sessions().get(&key).cloned().unwrap_or_default();
            mut_sessions().track_new(
                userid,
                key,
                Utc::now() - TimeDelta::seconds(1),
                permissions,
                &Some(tenant),
            );
        }
        auth_no_context(req, action)
    }

    #[actix_web::test]
    async fn active_api_key_authenticates_through_both_headers() {
        let _state = auth_state().await;
        let (user, secret) = api_key_user(Some(Utc::now() + TimeDelta::hours(1)));
        for header in api_key_headers(&secret) {
            assert_eq!(
                request(auth_no_context, false, &[header]).await,
                StatusCode::OK
            );
        }
        assert!(!has_sessions(&user));
    }

    #[actix_web::test]
    async fn nonexpiring_api_key_authenticates_through_both_headers() {
        let _state = auth_state().await;
        let (_, secret) = api_key_user(None);
        for header in api_key_headers(&secret) {
            assert_eq!(
                request(auth_no_context, false, &[header]).await,
                StatusCode::OK
            );
        }
    }

    #[actix_web::test]
    async fn expired_api_key_is_rejected_through_both_headers() {
        let _state = auth_state().await;
        let (user, secret) = api_key_user(Some(Utc::now() - TimeDelta::seconds(1)));
        for header in api_key_headers(&secret) {
            assert_eq!(
                request(auth_no_context, false, &[header]).await,
                StatusCode::UNAUTHORIZED
            );
        }
        assert!(!has_sessions(&user));
    }

    #[actix_web::test]
    async fn api_key_expiring_after_session_registration_is_rejected() {
        let _state = auth_state().await;
        let (user, secret) = api_key_user(Some(Utc::now() + TimeDelta::hours(1)));
        for header in api_key_headers(&secret) {
            assert_eq!(
                request(expire_session_then_authorize, false, &[header]).await,
                StatusCode::UNAUTHORIZED
            );
        }
        assert!(!has_sessions(&user));
    }

    #[actix_web::test]
    async fn intra_cluster_request_accepts_active_api_key_user() {
        let _state = auth_state().await;
        for expires_at in [None, Some(Utc::now() + TimeDelta::hours(1))] {
            let (user, _) = api_key_user(expires_at);
            assert_eq!(
                request(auth_no_context, true, &cluster_headers(&user)).await,
                StatusCode::OK
            );
            assert!(!has_sessions(&user));
        }
    }

    #[actix_web::test]
    async fn intra_cluster_request_rejects_expired_api_key_user() {
        let _state = auth_state().await;
        let (user, _) = api_key_user(Some(Utc::now() - TimeDelta::seconds(1)));
        assert_eq!(
            request(auth_no_context, true, &cluster_headers(&user)).await,
            StatusCode::UNAUTHORIZED
        );
        assert!(!has_sessions(&user));
    }

    #[actix_web::test]
    async fn intra_cluster_request_rejects_expired_api_key_despite_forwarded_basic_auth() {
        let _state = auth_state().await;
        // Distributed trace queries also forward the tenant's stored query credentials.
        let username = format!("query-{}", Ulid::new()).to_lowercase();
        let (mut basic, password) = user::User::new_basic(username.clone(), None, false);
        basic.roles.insert(ROLE.to_owned());
        mut_users().insert(basic);
        let forwarded = (
            "authorization",
            format!(
                "Basic {}",
                BASE64_STANDARD.encode(format!("{username}:{password}"))
            ),
        );
        assert_eq!(
            request(auth_no_context, false, std::slice::from_ref(&forwarded)).await,
            StatusCode::OK
        );

        let (user, _) = api_key_user(Some(Utc::now() - TimeDelta::seconds(1)));
        let mut headers = cluster_headers(&user).to_vec();
        headers.push(forwarded);
        assert_eq!(
            request(auth_no_context, true, &headers).await,
            StatusCode::UNAUTHORIZED
        );
    }

    #[test]
    fn new_sessions_never_outlive_the_api_key() {
        let _state = blocking_auth_state();
        let now = Utc::now();
        for (expires_at, expired) in [
            (None, false),
            (Some(now + TimeDelta::hours(1)), false),
            (Some(now - TimeDelta::seconds(1)), true),
        ] {
            let (user, _) = api_key_user(expires_at);
            let session = SessionKey::SessionId(Ulid::new());
            Users.new_session(&user, session.clone(), TimeDelta::seconds(20));
            assert_eq!(sessions().is_session_expired(&session), expired);
            mut_sessions().remove_session(&session);
        }
    }
}
