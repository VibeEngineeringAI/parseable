//! Short-lived grants contain credential references and digests, never login secrets.
//! API keys are checked against their current user record, not their ephemeral HTTP session.
use super::{
    domain::{Principal, ScopeVersion},
    tools::{GrantAuthorizer, RunGrant, ToolError},
};
use crate::rbac::{
    Users,
    map::{SessionKey, read_user_groups, sessions},
    role::{Action, ParseableResourceType, Permission},
    roles_to_permission,
};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, Mutex},
};

/// Borrow the credential chosen by authentication middleware. The raw header is
/// never copied into a grant, persisted, or logged. Keep precedence/spacing in
/// sync with handlers::http::middleware::extract_api_key.
pub(super) fn presented_api_key(req: &actix_web::HttpRequest) -> Option<&str> {
    if let Some(key) = req
        .headers()
        .get("x-api-key")
        .and_then(|value| value.to_str().ok())
    {
        return Some(key);
    }
    req.headers()
        .get(actix_web::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split_once(' '))
        .and_then(|(scheme, key)| {
            scheme
                .eq_ignore_ascii_case("Bearer")
                .then_some(key.trim_start_matches(' '))
        })
        .filter(|key| !key.is_empty())
}

const GRANT_SECONDS: i64 = 180;

/// Live grants a registry may hold at once, per principal, per tenant and overall.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GrantCapacity {
    pub principal: usize,
    pub tenant: usize,
    pub total: usize,
}
impl GrantCapacity {
    /// Run and live-progress observer grants.
    pub const STANDARD: Self = Self {
        principal: 8,
        tenant: 32,
        total: 256,
    };
    /// Provider-credential administration. Saves are serialized and hold a permit
    /// only for one request, so a small dedicated pool stays available when
    /// observers exhaust theirs.
    pub const CREDENTIAL_ADMIN: Self = Self {
        principal: 2,
        tenant: 4,
        total: 64,
    };
}

#[derive(Clone, Default)]
struct QueryAccess {
    all: bool,
    admin: bool,
    datasets: BTreeSet<String>,
}
impl QueryAccess {
    fn from_permissions(permissions: &[Permission]) -> Self {
        let mut access = Self::default();
        for permission in permissions {
            if matches!(
                permission,
                Permission::Unit(Action::All | Action::SuperAdmin)
                    | Permission::Resource(
                        Action::All | Action::SuperAdmin,
                        None | Some(ParseableResourceType::All)
                    )
            ) {
                access.admin = true;
            }
            match permission {
                Permission::Unit(Action::Query | Action::All | Action::SuperAdmin)
                | Permission::Resource(Action::Query | Action::All | Action::SuperAdmin, None)
                | Permission::Resource(
                    Action::Query | Action::All | Action::SuperAdmin,
                    Some(ParseableResourceType::All),
                ) => access.all = true,
                Permission::Resource(
                    Action::Query | Action::All | Action::SuperAdmin,
                    Some(ParseableResourceType::Stream(dataset)),
                ) => {
                    if dataset == "*" {
                        access.all = true;
                    } else {
                        access.datasets.insert(dataset.clone());
                    }
                }
                _ => {}
            }
        }
        access
    }
    fn permits(&self, dataset: &str) -> bool {
        self.all || self.datasets.contains(dataset)
    }
    fn intersection(&self, other: &Self) -> Self {
        let mut access = if self.all {
            other.clone()
        } else if other.all {
            self.clone()
        } else {
            Self {
                all: false,
                admin: false,
                datasets: self
                    .datasets
                    .intersection(&other.datasets)
                    .cloned()
                    .collect(),
            }
        };
        access.admin = self.admin && other.admin;
        access
    }
}

#[derive(Clone)]
enum CredentialBinding {
    Session([u8; 32]),
    ApiKey {
        key_id: ulid::Ulid,
        digest: [u8; 32],
    },
}
#[derive(Clone)]
struct CredentialState {
    principal: Principal,
    access: QueryAccess,
    expires_at: i64,
}
#[derive(Clone)]
struct Entry {
    principal: Principal,
    binding: CredentialBinding,
    ceiling: QueryAccess,
    expires_at: i64,
}

fn digest(salt: &str, bytes: &[u8]) -> [u8; 32] {
    let mut digest = Sha256::new();
    digest.update(salt.as_bytes());
    digest.update([0]);
    digest.update(bytes);
    digest.finalize().into()
}
fn session_digest(salt: &str, key: &SessionKey) -> Result<[u8; 32], ToolError> {
    // Serialization is transient and never logged or retained in the grant registry.
    let encoded =
        zeroize::Zeroizing::new(serde_json::to_vec(key).map_err(|_| ToolError::Unauthorized)?);
    Ok(digest(salt, &encoded))
}

trait CredentialSource: Send + Sync {
    fn current(&self, entry: &Entry, salt: &str) -> Result<CredentialState, ToolError>;
    fn user_dataset(&self, principal: &Principal, dataset: &str) -> bool;
}
struct CurrentStore;

fn current_user_access(principal: &Principal) -> Result<QueryAccess, ToolError> {
    let user = Users
        .get_user(&principal.owner_id, &Some(principal.tenant_id.clone()))
        .ok_or(ToolError::Unauthorized)?;
    let mut names = user.roles();
    if !user.protected {
        let groups = read_user_groups();
        for name in &user.user_groups {
            if let Some(group) = groups.get(&principal.tenant_id).and_then(|g| g.get(name)) {
                names.extend(group.roles.iter().cloned());
            }
        }
    }
    Ok(QueryAccess::from_permissions(&roles_to_permission(
        names,
        &principal.tenant_id,
    )))
}
impl CredentialSource for CurrentStore {
    fn current(&self, entry: &Entry, salt: &str) -> Result<CredentialState, ToolError> {
        let now = chrono::Utc::now();
        let principal = &entry.principal;
        // Session lock precedes Users/Groups/Roles, following the RBAC store's lock order.
        let (credential_access, expires_at) = match &entry.binding {
            CredentialBinding::Session(expected) => {
                let permissions = sessions()
                    .permissions_matching_session(
                        &principal.owner_id,
                        &principal.tenant_id,
                        |key| session_digest(salt, key).ok().as_ref() == Some(expected),
                    )
                    .ok_or(ToolError::Unauthorized)?;
                let access = QueryAccess::from_permissions(&permissions);
                (Some(access), entry.expires_at)
            }
            CredentialBinding::ApiKey {
                key_id,
                digest: expected,
            } => {
                let user = Users
                    .get_user(&principal.owner_id, &Some(principal.tenant_id.clone()))
                    .ok_or(ToolError::Unauthorized)?;
                let key = user.as_api_key().ok_or(ToolError::Unauthorized)?;
                if key.key_id != *key_id
                    || key.is_expired_at(now)
                    || digest(salt, key.api_key.as_bytes()) != *expected
                {
                    return Err(ToolError::Unauthorized);
                }
                (
                    None,
                    key.expires_at.map_or(entry.expires_at, |expiry| {
                        expiry.timestamp().min(entry.expires_at)
                    }),
                )
            }
        };
        let mut access = current_user_access(principal)?;
        if let Some(credential) = credential_access {
            access.admin &= credential.admin;
            if !credential.all {
                if access.all {
                    access.datasets = credential.datasets;
                    access.all = false;
                } else {
                    access
                        .datasets
                        .retain(|dataset| credential.datasets.contains(dataset));
                }
            }
        }
        Ok(CredentialState {
            principal: principal.clone(),
            access,
            expires_at,
        })
    }
    fn user_dataset(&self, principal: &Principal, dataset: &str) -> bool {
        crate::parseable::PARSEABLE
            .get_stream(dataset, &Some(principal.tenant_id.clone()))
            .is_ok_and(|stream| {
                !stream.is_deleting()
                    && stream.get_stream_type() != crate::storage::StreamType::Internal
            })
    }
}

/// The session-derived principal and the request credential as digests salted with
/// `salt`, with no ceiling yet. Nothing borrowed is retained.
fn bind(key: &SessionKey, presented_api_key: Option<&str>, salt: &str) -> Result<Entry, ToolError> {
    let now = chrono::Utc::now();
    let principal = {
        let store = sessions();
        if store.is_session_expired(key) {
            return Err(ToolError::Unauthorized);
        }
        let (owner_id, tenant_id) = store
            .get_user_and_tenant_id(key)
            .ok_or(ToolError::Unauthorized)?;
        Principal {
            owner_id,
            tenant_id,
        }
    };
    let user = Users
        .get_user(&principal.owner_id, &Some(principal.tenant_id.clone()))
        .ok_or(ToolError::Unauthorized)?;
    let (binding, expires_at) = if let Some(api_key) = user.as_api_key() {
        let presented = presented_api_key.ok_or(ToolError::Unauthorized)?;
        if api_key.is_expired_at(now) || presented != api_key.api_key {
            return Err(ToolError::Unauthorized);
        }
        (
            CredentialBinding::ApiKey {
                key_id: api_key.key_id,
                digest: digest(salt, presented.as_bytes()),
            },
            api_key
                .expires_at
                .map_or(now.timestamp() + GRANT_SECONDS, |expiry| {
                    expiry.timestamp().min(now.timestamp() + GRANT_SECONDS)
                }),
        )
    } else {
        if presented_api_key.is_some() {
            return Err(ToolError::Unauthorized);
        }
        (
            CredentialBinding::Session(session_digest(salt, key)?),
            now.timestamp() + GRANT_SECONDS,
        )
    };
    Ok(Entry {
        principal,
        binding,
        ceiling: QueryAccess::default(),
        expires_at,
    })
}

/// What a bound credential may do now.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CurrentRights {
    pub principal: Principal,
    /// Query on every dataset.
    pub all: bool,
    pub datasets: BTreeSet<String>,
    pub admin: bool,
}

/// One request's credential, bound so work queued after the request thread can recheck
/// it. Like a grant it keeps only the session-derived principal and salted digests,
/// never the request, session key, password or API key. Unlike a grant it takes no
/// registry slot: it lives and dies with the job that owns it, so it needs no capacity
/// or release, and storage-only deployments can use it.
pub struct CredentialHandle {
    salt: String,
    entry: Entry,
    source: Arc<dyn CredentialSource>,
}
impl CredentialHandle {
    pub fn bind(key: &SessionKey, presented_api_key: Option<&str>) -> Result<Self, ToolError> {
        let salt = uuid::Uuid::new_v4().to_string();
        let entry = bind(key, presented_api_key, &salt)?;
        Ok(Self {
            salt,
            entry,
            source: Arc::new(CurrentStore),
        })
    }
    pub fn principal(&self) -> &Principal {
        &self.entry.principal
    }
    /// The identity's current roles, narrowed by its current session's permissions.
    /// An ended or expired session, a rotated, expired or removed API key, a removed
    /// user and an elapsed handle lifetime are all refused.
    pub fn current(&self) -> Result<CurrentRights, ToolError> {
        let now = chrono::Utc::now().timestamp();
        if self.entry.expires_at <= now {
            return Err(ToolError::Unauthorized);
        }
        let current = self.source.current(&self.entry, &self.salt)?;
        if current.principal != self.entry.principal || current.expires_at <= now {
            return Err(ToolError::Unauthorized);
        }
        Ok(CurrentRights {
            principal: current.principal,
            all: current.access.all,
            datasets: current.access.datasets,
            admin: current.access.admin,
        })
    }
}

pub struct CurrentGrantAuthorizer {
    entries: Mutex<BTreeMap<String, Entry>>,
    source: Arc<dyn CredentialSource>,
    capacity: GrantCapacity,
}
impl Default for CurrentGrantAuthorizer {
    fn default() -> Self {
        Self::with_capacity(GrantCapacity::STANDARD)
    }
}
impl CurrentGrantAuthorizer {
    /// An independent registry; grants issued by one are unknown to every other.
    pub fn with_capacity(capacity: GrantCapacity) -> Self {
        Self {
            entries: Mutex::new(BTreeMap::new()),
            source: Arc::new(CurrentStore),
            capacity,
        }
    }
    /// Bind the middleware-authenticated session to the exact presented API key.
    /// A key rotation between authentication and issue must never rebind the
    /// request to the replacement credential. The borrowed value is not retained.
    pub fn issue(
        &self,
        key: &SessionKey,
        presented_api_key: Option<&str>,
    ) -> Result<RunGrant, ToolError> {
        let id = uuid::Uuid::new_v4().to_string();
        let mut entry = bind(key, presented_api_key, &id)?;
        // The request's cached session permissions also bound issuance. A role
        // addition after authentication must not grant new query/admin abilities.
        let request_access = QueryAccess::from_permissions(&Users.get_permissions(key));
        // The immutable ceiling prevents subsequent role additions from widening this grant.
        let state = self.source.current(&entry, &id)?;
        entry.ceiling = state.access.intersection(&request_access);
        self.insert(id, entry)
    }
    fn insert(&self, id: String, entry: Entry) -> Result<RunGrant, ToolError> {
        let mut entries = self.entries.lock().map_err(|_| ToolError::Unavailable)?;
        entries.retain(|_, entry| entry.expires_at > chrono::Utc::now().timestamp());
        let capacity = self.capacity;
        if entries.len() >= capacity.total
            || entries
                .values()
                .filter(|existing| existing.principal == entry.principal)
                .count()
                >= capacity.principal
            || entries
                .values()
                .filter(|existing| existing.principal.tenant_id == entry.principal.tenant_id)
                .count()
                >= capacity.tenant
        {
            return Err(ToolError::Unavailable);
        }
        let grant = RunGrant {
            principal: entry.principal.clone(),
            credential_id: id.clone(),
            expires_at: entry.expires_at,
        };
        entries.insert(id, entry);
        Ok(grant)
    }
    fn checked_current(&self, grant: &RunGrant) -> Result<(Entry, CredentialState), ToolError> {
        let entry = self
            .entries
            .lock()
            .map_err(|_| ToolError::Unavailable)?
            .get(&grant.credential_id)
            .cloned()
            .ok_or(ToolError::Unauthorized)?;
        let now = chrono::Utc::now().timestamp();
        if entry.principal != grant.principal
            || entry.expires_at != grant.expires_at
            || entry.expires_at <= now
        {
            return Err(ToolError::Unauthorized);
        }
        let current = self.source.current(&entry, &grant.credential_id)?;
        if current.principal != entry.principal || current.expires_at <= now {
            return Err(ToolError::Unauthorized);
        }
        Ok((entry, current))
    }
    /// Recheck immediately before an administrative credential commit, including
    /// after every await. Query on all streams does not grant administration.
    pub fn authorize_admin(&self, grant: &RunGrant) -> Result<(), ToolError> {
        let (entry, current) = self.checked_current(grant)?;
        if entry.ceiling.admin && current.access.admin {
            Ok(())
        } else {
            Err(ToolError::Unauthorized)
        }
    }
    pub fn release(&self, grant: &RunGrant) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.remove(&grant.credential_id);
        }
    }
}
impl GrantAuthorizer for CurrentGrantAuthorizer {
    fn authorize(&self, grant: &RunGrant, scope: &ScopeVersion) -> Result<(), ToolError> {
        if scope.approved_by != grant.principal.owner_id {
            return Err(ToolError::Unauthorized);
        }
        scope.validate().map_err(|_| ToolError::Scope)?;
        let (entry, current) = self.checked_current(grant)?;
        if scope.datasets.iter().any(|dataset| {
            !current.access.permits(dataset)
                || !entry.ceiling.permits(dataset)
                || !self.source.user_dataset(&entry.principal, dataset)
        }) {
            return Err(ToolError::Unauthorized);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fake(Mutex<Option<CredentialState>>);
    impl CredentialSource for Fake {
        fn current(&self, _: &Entry, _: &str) -> Result<CredentialState, ToolError> {
            self.0
                .lock()
                .unwrap()
                .clone()
                .ok_or(ToolError::Unauthorized)
        }
        fn user_dataset(&self, _: &Principal, dataset: &str) -> bool {
            matches!(dataset, "logs" | "other")
        }
    }
    const MAX_PRINCIPAL_GRANTS: usize = GrantCapacity::STANDARD.principal;
    const MAX_TENANT_GRANTS: usize = GrantCapacity::STANDARD.tenant;
    const MAX_GRANTS: usize = GrantCapacity::STANDARD.total;
    fn fixture() -> (CurrentGrantAuthorizer, Arc<Fake>, RunGrant, ScopeVersion) {
        fixture_with(GrantCapacity::STANDARD)
    }
    fn fixture_with(
        capacity: GrantCapacity,
    ) -> (CurrentGrantAuthorizer, Arc<Fake>, RunGrant, ScopeVersion) {
        let (principal, _, node) = super::super::context::tests::fixture();
        let access = QueryAccess {
            all: false,
            admin: false,
            datasets: BTreeSet::from(["logs".into()]),
        };
        let expires_at = chrono::Utc::now().timestamp() + GRANT_SECONDS;
        let source = Arc::new(Fake(Mutex::new(Some(CredentialState {
            principal: principal.clone(),
            access: access.clone(),
            expires_at,
        }))));
        let authorizer = CurrentGrantAuthorizer {
            entries: Mutex::new(BTreeMap::new()),
            source: source.clone(),
            capacity,
        };
        let grant = authorizer
            .insert(
                "server-opaque-reference".into(),
                Entry {
                    principal,
                    binding: CredentialBinding::Session([0; 32]),
                    ceiling: access,
                    expires_at,
                },
            )
            .unwrap();
        (authorizer, source, grant, node.scope)
    }
    #[test]
    fn current_revocation_roles_expiry_and_identity_are_required() {
        let (authorizer, source, grant, scope) = fixture();
        assert!(authorizer.authorize(&grant, &scope).is_ok());
        let original = source.0.lock().unwrap().clone().unwrap();
        source.0.lock().unwrap().as_mut().unwrap().access = QueryAccess::default();
        assert_eq!(
            authorizer.authorize(&grant, &scope),
            Err(ToolError::Unauthorized)
        );
        *source.0.lock().unwrap() = Some(original.clone());
        source.0.lock().unwrap().as_mut().unwrap().expires_at = 0;
        assert_eq!(
            authorizer.authorize(&grant, &scope),
            Err(ToolError::Unauthorized)
        );
        *source.0.lock().unwrap() = Some(original.clone());
        source
            .0
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .principal
            .tenant_id = "forged".into();
        assert_eq!(
            authorizer.authorize(&grant, &scope),
            Err(ToolError::Unauthorized)
        );
        *source.0.lock().unwrap() = None;
        assert_eq!(
            authorizer.authorize(&grant, &scope),
            Err(ToolError::Unauthorized)
        );
    }
    #[test]
    fn credential_handles_recheck_identity_credential_roles_and_lifetime() {
        let (_, source, grant, _) = fixture();
        let entry = Entry {
            principal: grant.principal.clone(),
            binding: CredentialBinding::Session([0; 32]),
            ceiling: QueryAccess::default(),
            expires_at: grant.expires_at,
        };
        let handle = |entry: Entry| CredentialHandle {
            salt: "handle-salt".into(),
            entry,
            source: source.clone(),
        };
        let live = handle(entry.clone());
        assert_eq!(
            live.current(),
            Ok(CurrentRights {
                principal: grant.principal.clone(),
                all: false,
                datasets: BTreeSet::from(["logs".into()]),
                admin: false,
            })
        );
        let original = source.0.lock().unwrap().clone();
        source.0.lock().unwrap().as_mut().unwrap().access = QueryAccess::default();
        assert!(live.current().unwrap().datasets.is_empty());
        let changes: [fn(&mut CredentialState); 2] = [
            |state| state.principal.owner_id = "forged".into(),
            |state| state.expires_at = 0,
        ];
        for change in changes {
            *source.0.lock().unwrap() = original.clone();
            change(source.0.lock().unwrap().as_mut().unwrap());
            assert_eq!(live.current(), Err(ToolError::Unauthorized));
        }
        *source.0.lock().unwrap() = None;
        assert_eq!(live.current(), Err(ToolError::Unauthorized));
        *source.0.lock().unwrap() = original;
        let elapsed = handle(Entry {
            expires_at: 0,
            ..entry
        });
        assert_eq!(elapsed.current(), Err(ToolError::Unauthorized));
        assert!(live.current().is_ok());
    }
    #[test]
    fn forged_grant_scope_and_role_escalation_are_denied() {
        let (authorizer, source, grant, mut scope) = fixture();
        let mut forged = grant.clone();
        forged.principal.tenant_id = "forged".into();
        assert_eq!(
            authorizer.authorize(&forged, &scope),
            Err(ToolError::Unauthorized)
        );
        forged = grant.clone();
        forged.expires_at += 120;
        assert_eq!(
            authorizer.authorize(&forged, &scope),
            Err(ToolError::Unauthorized)
        );
        scope.approved_by = "another-owner".into();
        assert_eq!(
            authorizer.authorize(&grant, &scope),
            Err(ToolError::Unauthorized)
        );
        scope.approved_by = grant.principal.owner_id.clone();
        source.0.lock().unwrap().as_mut().unwrap().access.all = true;
        scope.datasets.push("other".into());
        assert_eq!(
            authorizer.authorize(&grant, &scope),
            Err(ToolError::Unauthorized)
        );
        scope.datasets.pop();
        assert!(authorizer.authorize(&grant, &scope).is_ok());
        authorizer.release(&grant);
        assert_eq!(
            authorizer.authorize(&grant, &scope),
            Err(ToolError::Unauthorized)
        );
        assert!(
            !QueryAccess::from_permissions(&[Permission::Resource(
                Action::QueryLLM,
                Some(ParseableResourceType::All)
            )])
            .permits("logs")
        );
    }
    #[test]
    fn registry_is_bounded_and_expired_grants_are_collected() {
        let (authorizer, _, grant, _) = fixture();
        let entry = authorizer
            .entries
            .lock()
            .unwrap()
            .get(&grant.credential_id)
            .unwrap()
            .clone();
        for id in 1..MAX_PRINCIPAL_GRANTS {
            authorizer
                .insert(format!("grant-{id}"), entry.clone())
                .unwrap();
        }
        assert!(matches!(
            authorizer.insert("over-budget".into(), entry.clone()),
            Err(ToolError::Unavailable)
        ));
        authorizer
            .entries
            .lock()
            .unwrap()
            .values_mut()
            .for_each(|entry| entry.expires_at = 0);
        authorizer.insert("after-expiry".into(), entry).unwrap();
        assert_eq!(authorizer.entries.lock().unwrap().len(), 1);
    }
    fn initialize_test_tenant() -> String {
        use crate::rbac::{
            map,
            role::model::{DefaultPrivilege, Role},
        };
        map::USERS.get_or_init(Default::default);
        map::SESSIONS.get_or_init(Default::default);
        map::USER_GROUPS.get_or_init(Default::default);
        map::ROLES.get_or_init(Default::default);
        let tenant = format!("keystone-grant-test-{}", ulid::Ulid::new());
        map::mut_roles().entry(tenant.clone()).or_default().insert(
            "query-logs".into(),
            Role::create_internal_role(vec![DefaultPrivilege::Reader {
                resource: Some(ParseableResourceType::Stream("logs".into())),
            }]),
        );
        tenant
    }
    #[test]
    fn actual_api_key_store_survives_ephemeral_session_cleanup_but_not_revocation_rotation_or_expiry()
     {
        use crate::rbac::{
            map::mut_users,
            user::{User, UserType},
        };
        let tenant = initialize_test_tenant();
        let mut user = User::new_api_key(
            ulid::Ulid::new(),
            "fixture-token-never-used-for-authentication".into(),
            "fixture".into(),
            std::collections::HashSet::from(["query-logs".into()]),
            "fixture-owner".into(),
            Some(tenant.clone()),
        );
        Users.put_user(user.clone());
        let session = SessionKey::SessionId(ulid::Ulid::new());
        Users.new_session(&user, session.clone(), chrono::TimeDelta::minutes(5));
        let authorizer = CurrentGrantAuthorizer::default();
        let grant = authorizer
            .issue(
                &session,
                Some("fixture-token-never-used-for-authentication"),
            )
            .unwrap();
        let entry = authorizer
            .entries
            .lock()
            .unwrap()
            .get(&grant.credential_id)
            .unwrap()
            .clone();
        assert!(matches!(entry.binding, CredentialBinding::ApiKey { .. }));
        Users.remove_session(&session);
        assert!(
            CurrentStore
                .current(&entry, &grant.credential_id)
                .unwrap()
                .access
                .permits("logs")
        );
        user.roles.clear();
        Users.put_user(user.clone());
        assert!(
            !CurrentStore
                .current(&entry, &grant.credential_id)
                .unwrap()
                .access
                .permits("logs")
        );
        user.roles.insert("query-logs".into());
        if let UserType::ApiKey(key) = &mut user.ty {
            key.expires_at = Some(chrono::Utc::now() - chrono::TimeDelta::seconds(1));
        }
        Users.put_user(user.clone());
        assert!(matches!(
            CurrentStore.current(&entry, &grant.credential_id),
            Err(ToolError::Unauthorized)
        ));
        if let UserType::ApiKey(key) = &mut user.ty {
            key.expires_at = None;
            key.api_key = "rotated-fixture".into();
        }
        Users.put_user(user.clone());
        assert!(matches!(
            CurrentStore.current(&entry, &grant.credential_id),
            Err(ToolError::Unauthorized)
        ));
        mut_users().get_mut(&tenant).unwrap().remove(user.userid());
        assert!(matches!(
            CurrentStore.current(&entry, &grant.credential_id),
            Err(ToolError::Unauthorized)
        ));
    }
    #[test]
    fn actual_session_store_revocation_and_current_role_changes_are_checked() {
        use crate::rbac::user::{Basic, User, UserType};
        let tenant = initialize_test_tenant();
        let user = User {
            ty: UserType::Native(Basic {
                username: format!("fixture-{}", ulid::Ulid::new()),
                password_hash: "unused-fixture".into(),
                email: None,
            }),
            roles: std::collections::HashSet::from(["query-logs".into()]),
            user_groups: Default::default(),
            tenant: Some(tenant.clone()),
            protected: false,
        };
        Users.put_user(user.clone());
        let session = SessionKey::SessionId(ulid::Ulid::new());
        Users.new_session(&user, session.clone(), chrono::TimeDelta::minutes(5));
        let authorizer = CurrentGrantAuthorizer::default();
        assert!(matches!(
            authorizer.issue(&session, Some("fixture-unrelated-api-key")),
            Err(ToolError::Unauthorized)
        ));
        let grant = authorizer.issue(&session, None).unwrap();
        let entry = authorizer
            .entries
            .lock()
            .unwrap()
            .get(&grant.credential_id)
            .unwrap()
            .clone();
        assert!(
            CurrentStore
                .current(&entry, &grant.credential_id)
                .unwrap()
                .access
                .permits("logs")
        );
        Users.remove_roles(
            user.userid(),
            std::collections::HashSet::from(["query-logs".into()]),
            &Some(tenant),
        );
        assert!(
            !CurrentStore
                .current(&entry, &grant.credential_id)
                .unwrap()
                .access
                .permits("logs")
        );
        Users.remove_session(&session);
        assert!(matches!(
            CurrentStore.current(&entry, &grant.credential_id),
            Err(ToolError::Unauthorized)
        ));
    }
    #[test]
    fn quota_isolation_preserves_other_principals_and_tenants() {
        let (authorizer, _, grant, _) = fixture();
        let mut entry = authorizer
            .entries
            .lock()
            .unwrap()
            .get(&grant.credential_id)
            .unwrap()
            .clone();
        for id in 1..MAX_PRINCIPAL_GRANTS {
            authorizer
                .insert(format!("same-owner-{id}"), entry.clone())
                .unwrap();
        }
        assert!(matches!(
            authorizer.insert("owner-limit".into(), entry.clone()),
            Err(ToolError::Unavailable)
        ));
        for id in MAX_PRINCIPAL_GRANTS..MAX_TENANT_GRANTS {
            entry.principal.owner_id = format!("owner-{id}");
            authorizer
                .insert(format!("tenant-grant-{id}"), entry.clone())
                .unwrap();
        }
        entry.principal.owner_id = "another-owner".into();
        assert!(matches!(
            authorizer.insert("tenant-limit".into(), entry.clone()),
            Err(ToolError::Unavailable)
        ));
        for id in MAX_TENANT_GRANTS..MAX_GRANTS {
            entry.principal.tenant_id = format!("tenant-{id}");
            authorizer
                .insert(format!("other-tenant-grant-{id}"), entry.clone())
                .unwrap();
        }
        entry.principal.tenant_id = "final-tenant".into();
        assert!(matches!(
            authorizer.insert("global-limit".into(), entry),
            Err(ToolError::Unavailable)
        ));
    }
    #[test]
    fn credential_admin_registry_has_its_own_smaller_bounded_capacity() {
        let (observers, _, observer_grant, _) = fixture();
        let entry = observers
            .entries
            .lock()
            .unwrap()
            .get(&observer_grant.credential_id)
            .unwrap()
            .clone();
        for id in 1..MAX_PRINCIPAL_GRANTS {
            observers
                .insert(format!("observer-{id}"), entry.clone())
                .unwrap();
        }
        assert!(matches!(
            observers.insert("observer-full".into(), entry.clone()),
            Err(ToolError::Unavailable)
        ));
        // A full observer registry has no effect on the independent admin registry.
        let (admins, _, admin_grant, _) = fixture_with(GrantCapacity::CREDENTIAL_ADMIN);
        assert!(admins.checked_current(&admin_grant).is_ok());
        let mut entry = entry;
        for id in 1..GrantCapacity::CREDENTIAL_ADMIN.principal {
            admins.insert(format!("admin-{id}"), entry.clone()).unwrap();
        }
        assert!(matches!(
            admins.insert("admin-owner-limit".into(), entry.clone()),
            Err(ToolError::Unavailable)
        ));
        for id in GrantCapacity::CREDENTIAL_ADMIN.principal..GrantCapacity::CREDENTIAL_ADMIN.tenant
        {
            entry.principal.owner_id = format!("admin-owner-{id}");
            admins
                .insert(format!("admin-tenant-{id}"), entry.clone())
                .unwrap();
        }
        entry.principal.owner_id = "another-admin".into();
        assert!(matches!(
            admins.insert("admin-tenant-limit".into(), entry),
            Err(ToolError::Unavailable)
        ));
        admins.release(&admin_grant);
        assert!(admins.checked_current(&admin_grant).is_err());
    }
    #[test]
    fn admin_requires_current_exact_admin_and_original_admin_ceiling() {
        let (authorizer, source, grant, _) = fixture();
        assert_eq!(
            authorizer.authorize_admin(&grant),
            Err(ToolError::Unauthorized)
        );
        source.0.lock().unwrap().as_mut().unwrap().access.admin = true;
        assert_eq!(
            authorizer.authorize_admin(&grant),
            Err(ToolError::Unauthorized)
        );
        authorizer
            .entries
            .lock()
            .unwrap()
            .get_mut(&grant.credential_id)
            .unwrap()
            .ceiling
            .admin = true;
        assert!(authorizer.authorize_admin(&grant).is_ok());
        source.0.lock().unwrap().as_mut().unwrap().access.admin = false;
        assert_eq!(
            authorizer.authorize_admin(&grant),
            Err(ToolError::Unauthorized)
        );
        for permission in [
            Permission::Unit(Action::Query),
            Permission::Resource(Action::Query, Some(ParseableResourceType::All)),
            Permission::Resource(Action::QueryLLM, Some(ParseableResourceType::All)),
            Permission::Resource(
                Action::All,
                Some(ParseableResourceType::Stream("logs".into())),
            ),
        ] {
            assert!(!QueryAccess::from_permissions(&[permission]).admin);
        }
    }
    #[test]
    fn actual_admin_api_key_revalidates_role_definition_key_expiry_and_revocation() {
        use crate::rbac::{
            map::{mut_roles, mut_users},
            role::model::{DefaultPrivilege, Role},
            user::{User, UserType},
        };
        let tenant = initialize_test_tenant();
        mut_roles().get_mut(&tenant).unwrap().insert(
            "credential-admin".into(),
            Role::create_internal_role(vec![DefaultPrivilege::Admin]),
        );
        let mut user = User::new_api_key(
            ulid::Ulid::new(),
            "fixture-admin-token".into(),
            "fixture".into(),
            std::collections::HashSet::from(["credential-admin".into()]),
            "fixture-owner".into(),
            Some(tenant.clone()),
        );
        Users.put_user(user.clone());
        let session = SessionKey::SessionId(ulid::Ulid::new());
        Users.new_session(&user, session.clone(), chrono::TimeDelta::minutes(5));
        let authorizer = CurrentGrantAuthorizer::default();
        let grant = authorizer
            .issue(&session, Some("fixture-admin-token"))
            .unwrap();
        Users.remove_session(&session);
        assert!(authorizer.authorize_admin(&grant).is_ok());
        mut_roles().get_mut(&tenant).unwrap().insert(
            "credential-admin".into(),
            Role::create_internal_role(vec![DefaultPrivilege::Reader { resource: None }]),
        );
        assert_eq!(
            authorizer.authorize_admin(&grant),
            Err(ToolError::Unauthorized)
        );
        mut_roles().get_mut(&tenant).unwrap().insert(
            "credential-admin".into(),
            Role::create_internal_role(vec![DefaultPrivilege::Admin]),
        );
        if let UserType::ApiKey(key) = &mut user.ty {
            key.expires_at = Some(chrono::Utc::now() - chrono::TimeDelta::seconds(1));
        }
        Users.put_user(user.clone());
        assert_eq!(
            authorizer.authorize_admin(&grant),
            Err(ToolError::Unauthorized)
        );
        mut_users().get_mut(&tenant).unwrap().remove(user.userid());
        assert_eq!(
            authorizer.authorize_admin(&grant),
            Err(ToolError::Unauthorized)
        );
    }
    #[test]
    fn rotation_before_issue_cannot_rebind_old_request_and_rotation_after_issue_revokes_grant() {
        use crate::rbac::{
            map::{mut_roles, mut_users},
            role::model::{DefaultPrivilege, Role},
            user::{User, UserType},
        };
        let tenant = initialize_test_tenant();
        mut_roles().get_mut(&tenant).unwrap().insert(
            "rotation-admin".into(),
            Role::create_internal_role(vec![DefaultPrivilege::Admin]),
        );
        let mut user = User::new_api_key(
            ulid::Ulid::new(),
            "synthetic-original-key".into(),
            "rotation fixture".into(),
            std::collections::HashSet::from(["rotation-admin".into()]),
            "fixture-owner".into(),
            Some(tenant.clone()),
        );
        Users.put_user(user.clone());
        let session = SessionKey::SessionId(ulid::Ulid::new());
        Users.new_session(&user, session.clone(), chrono::TimeDelta::minutes(5));
        let authorizer = CurrentGrantAuthorizer::default();
        assert!(matches!(
            authorizer.issue(&session, None),
            Err(ToolError::Unauthorized)
        ));
        // Authentication resolved the original request to its ephemeral session,
        // then the operator rotated the same key record before grant issuance.
        let UserType::ApiKey(key) = &mut user.ty else {
            panic!("fixture must be an API key");
        };
        key.api_key = "synthetic-replacement-key".into();
        // Change this isolated synthetic record without the normal put_user
        // session-revocation side effect, so the retained middleware session
        // actually exercises exact presented-key binding at issuance.
        mut_users()
            .get_mut(&tenant)
            .unwrap()
            .insert(user.userid().to_owned(), user.clone());
        assert!(matches!(
            authorizer.issue(&session, Some("synthetic-original-key")),
            Err(ToolError::Unauthorized)
        ));
        assert!(authorizer.entries.lock().unwrap().is_empty());
        // A request that actually presented the replacement credential can bind
        // it. Later rotations invalidate that digest without adopting a new key.
        let replacement_session = SessionKey::SessionId(ulid::Ulid::new());
        Users.new_session(
            &user,
            replacement_session.clone(),
            chrono::TimeDelta::minutes(5),
        );
        let grant = authorizer
            .issue(&replacement_session, Some("synthetic-replacement-key"))
            .unwrap();
        let entry = authorizer
            .entries
            .lock()
            .unwrap()
            .get(&grant.credential_id)
            .unwrap()
            .clone();
        assert!(
            matches!(entry.binding,CredentialBinding::ApiKey{digest:expected,..} if expected==digest(&grant.credential_id,b"synthetic-replacement-key"))
        );
        assert!(authorizer.authorize_admin(&grant).is_ok());
        let UserType::ApiKey(key) = &mut user.ty else {
            panic!("fixture must be an API key");
        };
        key.api_key = "synthetic-next-key".into();
        Users.put_user(user.clone());
        assert_eq!(
            authorizer.authorize_admin(&grant),
            Err(ToolError::Unauthorized)
        );
        assert!(matches!(
            CurrentStore.current(&entry, &grant.credential_id),
            Err(ToolError::Unauthorized)
        ));
        authorizer.release(&grant);
        Users.remove_session(&session);
        Users.remove_session(&replacement_session);
        mut_users().get_mut(&tenant).unwrap().remove(user.userid());
    }
    #[test]
    fn presented_api_key_matches_authentication_header_priority_and_spacing() {
        use actix_web::{http::header, test::TestRequest};
        let request = TestRequest::default()
            .insert_header(("X-API-KEY", "synthetic-x-key"))
            .insert_header((header::AUTHORIZATION, "Bearer synthetic-bearer-key"))
            .to_http_request();
        assert_eq!(presented_api_key(&request), Some("synthetic-x-key"));
        let request = TestRequest::default()
            .insert_header(("X-API-KEY", ""))
            .insert_header((header::AUTHORIZATION, "Bearer synthetic-bearer-key"))
            .to_http_request();
        assert_eq!(
            presented_api_key(&request),
            Some(""),
            "empty X-API-KEY still takes middleware precedence"
        );
        let request = TestRequest::default()
            .insert_header((header::AUTHORIZATION, "bEaReR   synthetic-bearer-key "))
            .to_http_request();
        assert_eq!(
            presented_api_key(&request),
            Some("synthetic-bearer-key "),
            "leading separator spaces are trimmed but credential trailing spaces are retained"
        );
        for authorization in [
            "Bearer   ",
            "Basic synthetic-value",
            "Bearers synthetic-value",
            "Bearer\tsynthetic-value",
        ] {
            let request = TestRequest::default()
                .insert_header((header::AUTHORIZATION, authorization))
                .to_http_request();
            assert_eq!(presented_api_key(&request), None);
        }
        let request = TestRequest::default()
            .insert_header((
                "X-API-KEY",
                header::HeaderValue::from_bytes(b"\xff").unwrap(),
            ))
            .insert_header((header::AUTHORIZATION, "Bearer synthetic-fallback"))
            .to_http_request();
        assert_eq!(
            presented_api_key(&request),
            Some("synthetic-fallback"),
            "invalid text header falls back exactly as middleware does"
        );
    }
    #[test]
    fn api_key_role_promotion_before_issue_cannot_widen_original_session_ceiling() {
        use crate::rbac::{
            map::{mut_roles, mut_users},
            role::model::{DefaultPrivilege, Role},
            user::User,
        };
        let tenant = initialize_test_tenant();
        let user = User::new_api_key(
            ulid::Ulid::new(),
            "synthetic-ceiling-key".into(),
            "ceiling fixture".into(),
            std::collections::HashSet::from(["query-logs".into()]),
            "fixture-owner".into(),
            Some(tenant.clone()),
        );
        Users.put_user(user.clone());
        let session = SessionKey::SessionId(ulid::Ulid::new());
        Users.new_session(&user, session.clone(), chrono::TimeDelta::minutes(5));
        // Middleware cached Reader(logs), then the definition became Admin
        // before the request issued a background grant.
        mut_roles().get_mut(&tenant).unwrap().insert(
            "query-logs".into(),
            Role::create_internal_role(vec![DefaultPrivilege::Admin]),
        );
        let authorizer = CurrentGrantAuthorizer::default();
        let grant = authorizer
            .issue(&session, Some("synthetic-ceiling-key"))
            .unwrap();
        let entry = authorizer
            .entries
            .lock()
            .unwrap()
            .get(&grant.credential_id)
            .unwrap()
            .clone();
        assert!(
            CurrentStore
                .current(&entry, &grant.credential_id)
                .unwrap()
                .access
                .admin,
            "fixture's current role must be promoted"
        );
        assert!(entry.ceiling.permits("logs"));
        assert!(!entry.ceiling.permits("other"));
        assert!(!entry.ceiling.admin);
        assert_eq!(
            authorizer.authorize_admin(&grant),
            Err(ToolError::Unauthorized)
        );
        Users.remove_session(&session);
        authorizer.release(&grant);
        mut_users().get_mut(&tenant).unwrap().remove(user.userid());
    }
}
