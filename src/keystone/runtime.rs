//! Parseable-specific wiring. Session material exists only during the HTTP request.
use super::{
    api::{self, Access, ApiError, ApiState},
    domain::Principal,
    repository::NativeRepository,
};
use crate::{
    handlers::http::middleware::RouteExt,
    rbac::{
        Users,
        map::{SessionKey, read_user_groups, sessions},
        role::{Action, ParseableResourceType, Permission},
        roles_to_permission,
    },
};
use actix_web::{HttpRequest, Route, Scope, http::StatusCode, web};
use std::{
    collections::BTreeSet,
    sync::{Arc, OnceLock},
};

static REPOSITORY: OnceLock<Option<Arc<NativeRepository>>> = OnceLock::new();
static EXECUTION: OnceLock<Option<Arc<dyn api::ExecutionService>>> = OnceLock::new();

pub fn scope(mode: &'static str) -> Scope {
    let mode = match crate::parseable::PARSEABLE.options.mode {
        crate::option::Mode::Ingest => "ingest",
        crate::option::Mode::Index => "index",
        crate::option::Mode::Prism => "prism",
        _ => mode,
    };
    let repository = if matches!(mode, "all" | "query") {
        REPOSITORY.get_or_init(|| {
        // Deliberate operator opt-in to a persistent, single-coordinator local directory.
        // Never infer a shared object-store lease or write the classic Keystone namespace.
        let directory=std::env::var_os("KEYSTONE_NATIVE_DIRECTORY")?;
        match NativeRepository::open(directory) {
            Ok(repository)=>Some(Arc::new(repository)),
            Err(_)=>{tracing::error!("native Keystone storage unavailable; verify directory and exclusive coordinator ownership");None}
        }
    }).clone()
    } else {
        None
    };
    let execution = repository.as_ref().and_then(|repository| {
        EXECUTION
            .get_or_init(|| {
                super::provider_runtime::NativeExecution::from_environment(repository.clone())
            })
            .clone()
    });
    api::scope(
        web::Data::new(ApiState {
            scope_preparer: Some(Arc::new(NativeScopePreparer)),
            execution,
            repository,
            authorize,
            mode,
        }),
        protect,
    )
}
fn protect(route: Route) -> Route {
    route.authorize(Action::Query)
}

fn query_permissions(permissions: &[Permission]) -> (bool, BTreeSet<String>) {
    let mut all = false;
    let mut datasets = BTreeSet::new();
    for permission in permissions {
        match permission {
            Permission::Unit(Action::Query | Action::All | Action::SuperAdmin)
            | Permission::Resource(Action::Query | Action::All | Action::SuperAdmin, None)
            | Permission::Resource(
                Action::Query | Action::All | Action::SuperAdmin,
                Some(ParseableResourceType::All),
            ) => all = true,
            Permission::Resource(
                Action::Query | Action::All | Action::SuperAdmin,
                Some(ParseableResourceType::Stream(name)),
            ) => {
                if name == "*" {
                    all = true;
                } else {
                    datasets.insert(name.clone());
                }
            }
            _ => {}
        }
    }
    (all, datasets)
}
/// The credential the auth middleware already validated, read with the same
/// extractor core handlers use: Basic, then the API-key extension, then the
/// session cookie. Middleware only inserts an extension for API keys. The key
/// is request-local; callers must not retain or persist it.
pub(super) fn request_session_key(req: &HttpRequest) -> Option<SessionKey> {
    crate::utils::actix::extract_session_key_from_req(req).ok()
}
fn authorize_candidate(req: &HttpRequest) -> std::result::Result<Access, ApiError> {
    let denied = || ApiError {
        status: StatusCode::UNAUTHORIZED,
        code: "authentication_required",
    };
    let key = request_session_key(req).ok_or_else(denied)?;
    let (owner_id, tenant_id) = {
        let sessions = sessions();
        if sessions.is_session_expired(&key) {
            return Err(denied());
        }
        sessions.get_user_and_tenant_id(&key).ok_or_else(denied)?
    };
    // Current identity and roles, intersected with the credential's request permissions.
    // Tenant headers are intentionally irrelevant here.
    let user = Users
        .get_user(&owner_id, &Some(tenant_id.clone()))
        .ok_or_else(denied)?;
    if let Some(api_key) = user.as_api_key() {
        // Request sessions for API keys are ephemeral. Rotation must not turn a
        // still-running request authenticated with the old key into a new grant.
        if api_key.is_expired_at(chrono::Utc::now())
            || super::grants::presented_api_key(req) != Some(api_key.api_key.as_str())
        {
            return Err(denied());
        }
    }
    let mut role_names = user.roles();
    let group_names = Users.get_user_groups(&owner_id, &Some(tenant_id.clone()));
    if !user.protected {
        let groups = read_user_groups();
        for name in group_names {
            if let Some(group) = groups.get(&tenant_id).and_then(|g| g.get(&name)) {
                role_names.extend(group.roles.iter().cloned());
            }
        }
    }
    let current_permissions = roles_to_permission(role_names, &tenant_id);
    let session_permissions = Users.get_permissions(&key);
    let admin = |permissions: &[Permission]| {
        permissions.iter().any(|p| {
            matches!(
                p,
                Permission::Unit(Action::All | Action::SuperAdmin)
                    | Permission::Resource(
                        Action::All | Action::SuperAdmin,
                        None | Some(ParseableResourceType::All)
                    )
            )
        })
    };
    let manage_providers = admin(&current_permissions) && admin(&session_permissions);
    let (current_all, current) = query_permissions(&current_permissions);
    let (session_all, session) = query_permissions(&session_permissions);
    let granted = if current_all {
        session.clone()
    } else if session_all {
        current.clone()
    } else {
        current.intersection(&session).cloned().collect()
    };
    Ok(Access {
        principal: Principal {
            tenant_id,
            owner_id,
        },
        datasets: granted,
        all_datasets: current_all && session_all,
        manage_providers,
    })
}
/// Re-resolves a bound request off its thread from salted credential digests: current
/// roles narrowed by the current session (or the same unexpired API key), as
/// `authorize_candidate` does, then, for `authorize`, current non-internal streams.
/// Needs no grant registry or provider, so storage-only deployments use it too.
struct CurrentRequest {
    credential: super::grants::CredentialHandle,
    existing_streams: bool,
}
impl api::CurrentAccess for CurrentRequest {
    fn current(&self) -> std::result::Result<Access, ApiError> {
        let rights = self
            .credential
            .current()
            .map_err(|_| api::authentication_required())?;
        let access = Access {
            principal: rights.principal,
            datasets: rights.datasets,
            all_datasets: rights.all,
            manage_providers: rights.admin,
        };
        Ok(if self.existing_streams {
            existing_streams(access)
        } else {
            access
        })
    }
}
/// Binds `issued`, just resolved from this request, to the credential it presented.
fn bind(
    req: &HttpRequest,
    issued: Access,
    existing_streams: bool,
) -> std::result::Result<api::BoundAccess, ApiError> {
    let key = request_session_key(req).ok_or_else(api::authentication_required)?;
    let credential =
        super::grants::CredentialHandle::bind(&key, super::grants::presented_api_key(req))
            .map_err(|_| api::authentication_required())?;
    if *credential.principal() != issued.principal {
        return Err(api::authentication_required());
    }
    Ok(api::BoundAccess::new(
        issued,
        Arc::new(CurrentRequest {
            credential,
            existing_streams,
        }),
    ))
}
/// Candidate access (no stream-existence filter, for metadata preparation), bound.
pub(super) fn candidate_authority(
    req: &HttpRequest,
) -> std::result::Result<api::BoundAccess, ApiError> {
    bind(req, authorize_candidate(req)?, false)
}
fn authorize(req: &HttpRequest) -> std::result::Result<api::BoundAccess, ApiError> {
    bind(req, existing_streams(authorize_candidate(req)?), true)
}
fn existing_streams(mut access: Access) -> Access {
    // Saved artifacts remain private and require current access to every dataset.
    let tenant = super::query_bridge::storage_tenant(&access.principal);
    access.datasets = crate::parseable::PARSEABLE
        .streams
        .list(&tenant)
        .into_iter()
        .filter(|name| {
            access.can_read(name)
                && crate::parseable::PARSEABLE
                    .get_stream(name, &tenant)
                    .is_ok_and(|stream| {
                        stream.get_stream_type() != crate::storage::StreamType::Internal
                    })
        })
        .collect();
    access.all_datasets = false;
    access
}
struct NativeScopePreparer;
#[async_trait::async_trait(?Send)]
impl api::ScopePreparer for NativeScopePreparer {
    fn candidate_access(
        &self,
        req: &HttpRequest,
    ) -> std::result::Result<api::BoundAccess, ApiError> {
        candidate_authority(req)
    }
    async fn prepare(
        &self,
        req: &HttpRequest,
        scope: &super::domain::ScopeVersion,
    ) -> std::result::Result<(), ApiError> {
        let access = authorize_candidate(req)?;
        if !scope
            .datasets
            .iter()
            .all(|dataset| access.can_read(dataset))
        {
            return Err(super::domain::KeystoneError::Forbidden.into());
        }
        // Bounded, cancellable metadata hydration only. The API reauthorizes after awaiting.
        tokio::time::timeout(
            std::time::Duration::from_secs(10),
            super::stream_loader::prepare_scope(&access.principal, scope),
        )
        .await
        .map_err(|_| ApiError {
            status: StatusCode::SERVICE_UNAVAILABLE,
            code: "dataset_metadata_unavailable",
        })?
        .map_err(|_| ApiError {
            status: StatusCode::NOT_FOUND,
            code: "not_found",
        })
    }
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use crate::rbac::user::{Basic, User, UserType};
    use actix_web::{HttpMessage, cookie::Cookie, http::header::AUTHORIZATION, test::TestRequest};
    use actix_web_httpauth::headers::authorization::Basic as BasicHeader;
    use std::collections::HashSet;

    pub(in crate::keystone) fn tenant_with_reader() -> String {
        use crate::rbac::{
            map,
            role::model::{DefaultPrivilege, Role},
        };
        map::USERS.get_or_init(Default::default);
        map::SESSIONS.get_or_init(Default::default);
        map::USER_GROUPS.get_or_init(Default::default);
        map::ROLES.get_or_init(Default::default);
        let tenant = format!("keystone-runtime-test-{}", ulid::Ulid::new());
        map::mut_roles().entry(tenant.clone()).or_default().insert(
            "query-logs".into(),
            Role::create_internal_role(vec![DefaultPrivilege::Reader {
                resource: Some(ParseableResourceType::Stream("logs".into())),
            }]),
        );
        tenant
    }
    pub(in crate::keystone) fn native_user(tenant: &str) -> User {
        let user = User {
            ty: UserType::Native(Basic {
                username: format!("fixture-{}", ulid::Ulid::new()),
                password_hash: "unused-fixture".into(),
                email: None,
            }),
            roles: HashSet::from(["query-logs".into()]),
            user_groups: Default::default(),
            tenant: Some(tenant.into()),
            protected: false,
        };
        Users.put_user(user.clone());
        user
    }
    pub(in crate::keystone) fn basic_request(username: &str, password: &str) -> HttpRequest {
        TestRequest::default()
            .insert_header((
                AUTHORIZATION,
                BasicHeader::new(username.to_owned(), Some(password.to_owned())),
            ))
            .to_http_request()
    }
    pub(in crate::keystone) fn cookie_request(value: &str) -> HttpRequest {
        TestRequest::default()
            .cookie(Cookie::new("session", value.to_owned()))
            .to_http_request()
    }
    fn denied_status(req: &HttpRequest) -> Option<StatusCode> {
        authorize_candidate(req).err().map(|error| error.status)
    }

    #[test]
    fn core_basic_and_cookie_credentials_authorize_without_middleware_extension() {
        let tenant = tenant_with_reader();
        let user = native_user(&tenant);
        let username = user.userid().to_owned();
        // Middleware validated these credentials but, as for every non-API-key
        // request, left no SessionKey extension behind.
        let basic_key = SessionKey::BasicAuth {
            username: username.clone(),
            password: "fixture-password".into(),
        };
        Users.new_session(&user, basic_key.clone(), chrono::TimeDelta::minutes(5));
        let cookie = ulid::Ulid::new();
        Users.new_session(
            &user,
            SessionKey::SessionId(cookie),
            chrono::TimeDelta::minutes(5),
        );
        let basic = basic_request(&username, "fixture-password");
        let session = cookie_request(&cookie.to_string());
        for req in [&basic, &session] {
            assert!(req.extensions().get::<SessionKey>().is_none());
            let Ok(access) = authorize_candidate(req) else {
                panic!("middleware-validated credential was rejected");
            };
            assert_eq!(access.principal.owner_id, username);
            assert_eq!(access.principal.tenant_id, tenant);
            assert_eq!(access.datasets, BTreeSet::from(["logs".to_owned()]));
            assert!(!access.all_datasets && !access.manage_providers);
        }
        for req in [
            basic_request(&username, "wrong-fixture-password"),
            cookie_request("tampered-not-a-ulid"),
            cookie_request(&ulid::Ulid::new().to_string()),
            TestRequest::default().to_http_request(),
        ] {
            assert_eq!(denied_status(&req), Some(StatusCode::UNAUTHORIZED));
        }
        // Current roles and revocation still bound the extracted credential.
        Users.remove_roles(
            &username,
            HashSet::from(["query-logs".into()]),
            &Some(tenant.clone()),
        );
        let Ok(access) = authorize_candidate(&basic) else {
            panic!("role removal must narrow, not reauthenticate");
        };
        assert!(access.datasets.is_empty());
        Users.remove_session(&basic_key);
        assert_eq!(denied_status(&basic), Some(StatusCode::UNAUTHORIZED));
        assert!(authorize_candidate(&session).is_ok());
    }

    #[test]
    fn middleware_api_key_extension_still_requires_the_presented_current_key() {
        let tenant = tenant_with_reader();
        let user = User::new_api_key(
            ulid::Ulid::new(),
            "fixture-runtime-key".into(),
            "fixture".into(),
            HashSet::from(["query-logs".into()]),
            "fixture-owner".into(),
            Some(tenant.clone()),
        );
        Users.put_user(user.clone());
        let session = SessionKey::SessionId(ulid::Ulid::new());
        Users.new_session(&user, session.clone(), chrono::TimeDelta::minutes(5));
        let request = |key: Option<&str>| {
            let mut req = TestRequest::default();
            if let Some(key) = key {
                req = req.insert_header(("x-api-key", key.to_owned()));
            }
            let req = req.to_http_request();
            req.extensions_mut().insert(session.clone());
            req
        };
        let Ok(access) = authorize_candidate(&request(Some("fixture-runtime-key"))) else {
            panic!("middleware API-key session was rejected");
        };
        assert_eq!(access.principal.owner_id, user.userid());
        assert_eq!(access.datasets, BTreeSet::from(["logs".to_owned()]));
        for key in [None, Some("fixture-rotated-key")] {
            assert_eq!(denied_status(&request(key)), Some(StatusCode::UNAUTHORIZED));
        }
        Users.remove_session(&session);
        assert_eq!(
            denied_status(&request(Some("fixture-runtime-key"))),
            Some(StatusCode::UNAUTHORIZED)
        );
    }

    #[test]
    fn bound_requests_recheck_session_key_and_roles_but_never_widen() {
        use crate::rbac::{
            map,
            role::model::{DefaultPrivilege, Role},
        };
        let unauthorized = |bound: &api::BoundAccess| bound.revalidate().err().map(|e| e.status);
        let tenant = tenant_with_reader();
        map::mut_roles().entry(tenant.clone()).or_default().insert(
            "keystone-admin".into(),
            Role::create_internal_role(vec![DefaultPrivilege::Admin]),
        );
        let user = native_user(&tenant);
        let username = user.userid().to_owned();
        let cookie = ulid::Ulid::new();
        let session = SessionKey::SessionId(cookie);
        Users.new_session(&user, session.clone(), chrono::TimeDelta::minutes(5));
        let Ok(bound) = candidate_authority(&cookie_request(&cookie.to_string())) else {
            panic!("a validated session must bind");
        };
        assert!(bound.revalidate().unwrap().can_read("logs"));
        // A role removed after the request resolved narrows its later checks.
        let reader = HashSet::from(["query-logs".to_owned()]);
        Users.remove_roles(&username, reader.clone(), &Some(tenant.clone()));
        assert!(!bound.revalidate().unwrap().can_read("logs"));
        // A broader role granted afterwards, even refreshed into the session, restores
        // no more than the issued access.
        Users.add_roles(
            &username,
            HashSet::from(["query-logs".into(), "keystone-admin".into()]),
            &Some(tenant.clone()),
        );
        let ceiling = bound.revalidate().unwrap();
        assert!(ceiling.can_read("logs") && !ceiling.can_read("metrics"));
        assert!(!ceiling.all_datasets && !ceiling.manage_providers);
        let Ok(promoted) = candidate_authority(&cookie_request(&cookie.to_string())) else {
            panic!("the promoted session must bind");
        };
        assert!(promoted.revalidate().unwrap().manage_providers);
        // Ending the session refuses both.
        Users.remove_session(&session);
        assert_eq!(unauthorized(&bound), Some(StatusCode::UNAUTHORIZED));
        assert_eq!(unauthorized(&promoted), Some(StatusCode::UNAUTHORIZED));

        // API keys: rotating the key behind the same id refuses requests bound to the old one.
        let key_id = ulid::Ulid::new();
        let api_key = |secret: &str| {
            User::new_api_key(
                key_id,
                secret.into(),
                "fixture".into(),
                reader.clone(),
                "fixture-owner".into(),
                Some(tenant.clone()),
            )
        };
        let keyed = api_key("fixture-bound-key");
        Users.put_user(keyed.clone());
        let session = SessionKey::SessionId(ulid::Ulid::new());
        Users.new_session(&keyed, session.clone(), chrono::TimeDelta::minutes(5));
        let req = TestRequest::default()
            .insert_header(("x-api-key", "fixture-bound-key"))
            .to_http_request();
        req.extensions_mut().insert(session);
        let Ok(bound) = candidate_authority(&req) else {
            panic!("a current API key must bind");
        };
        assert!(bound.revalidate().unwrap().can_read("logs"));
        Users.put_user(api_key("fixture-rotated-key"));
        assert_eq!(unauthorized(&bound), Some(StatusCode::UNAUTHORIZED));
    }

    #[test]
    fn llm_and_unrelated_permissions_never_grant_dataset_access() {
        let (all, streams) = query_permissions(&[
            Permission::Resource(Action::QueryLLM, Some(ParseableResourceType::All)),
            Permission::Resource(
                Action::Query,
                Some(ParseableResourceType::Llm("secret".into())),
            ),
            Permission::Resource(Action::GetSchema, Some(ParseableResourceType::All)),
            Permission::Resource(
                Action::Query,
                Some(ParseableResourceType::Stream("logs".into())),
            ),
        ]);
        assert!(!all);
        assert_eq!(streams, BTreeSet::from(["logs".into()]));
    }
}
