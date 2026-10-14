//! Single-coordinator runtime; configuration comes only from operator deployment inputs.
use super::{
    api::{ApiError, BoundAccess, ExecutionService, RunRequest, StartJob},
    coordinator::{Coordinator, StartRun},
    domain::*,
    grants::{CurrentGrantAuthorizer, GrantCapacity, presented_api_key},
    providers::{
        FrozenProviderContext, ModelProposal, ModelProvider, ProviderError,
        destination::DestinationBinding,
        live::{GenerationConfig, LiveModelProvider},
        secrets::{EncryptedFileSecretStore, ProviderSecret, SecretReference, SecretStore},
        transport::{PinnedHttpsTransport, ProviderTransport},
    },
    query_bridge::ScopedQueryExecutor,
    repository::NativeRepository,
};
use actix_web::{HttpRequest, http::StatusCode};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, LazyLock, RwLock},
    time::Duration,
};
use zeroize::Zeroizing;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CredentialRecord {
    reference: String,
    binding: DestinationBinding,
    revision: u64,
    model: String,
}

struct ConfiguredProviders {
    generation: GenerationConfig,
    store: Arc<dyn SecretStore>,
    transport: Arc<dyn ProviderTransport>,
    records: RwLock<BTreeMap<String, CredentialRecord>>,
    metadata: PathBuf,
    /// Owned by at most one save at a time, including a save whose request was dropped.
    mutation: Arc<tokio::sync::Mutex<()>>,
}
/// Authoritative credential manifest inside the encrypted store's directory.
const MANIFEST: &str = "providers.json";
/// A manifest write that did not complete.
#[derive(Debug, PartialEq, Eq)]
enum Unpublished {
    /// Nothing was renamed into place; the previous manifest is authoritative.
    Rejected,
    /// The new manifest was renamed into place but its directory sync failed, so
    /// either manifest may survive a crash. Both referenced versions are kept.
    Uncertain,
}
fn admin_required() -> ApiError {
    ApiError {
        status: StatusCode::FORBIDDEN,
        code: "admin_required",
    }
}
/// Sealed versions are durable first; this manifest is renamed into place last.
fn write_manifest(metadata: &Path, bytes: &[u8]) -> std::result::Result<(), Unpublished> {
    let directory = metadata.parent().ok_or(Unpublished::Rejected)?;
    let temporary = metadata.with_extension(format!("{}.pending", uuid::Uuid::new_v4()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let staged = (|| -> std::io::Result<()> {
        let mut file = options.open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&temporary, metadata)
    })();
    if staged.is_err() {
        let _ = fs::remove_file(&temporary);
        return Err(Unpublished::Rejected);
    }
    File::open(directory)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| Unpublished::Uncertain)
}
impl ConfiguredProviders {
    /// Startup only, before any request: the encrypted store holds the exclusive
    /// directory lock and the manifest parsed here is authoritative, so residue
    /// it does not reference is swept. Unreadable manifests fail closed untouched.
    fn open(
        directory: &Path,
        key: [u8; 32],
        generation: GenerationConfig,
        transport: Arc<dyn ProviderTransport>,
    ) -> Option<Self> {
        let store = EncryptedFileSecretStore::open(directory, key).ok()?;
        let metadata = directory.join(MANIFEST);
        let records: BTreeMap<String, CredentialRecord> = if metadata.exists() {
            let metadata_info = fs::symlink_metadata(&metadata).ok()?;
            if !metadata_info.is_file() || metadata_info.len() > 1024 * 1024 {
                return None;
            }
            let bytes = fs::read(&metadata).ok()?;
            serde_json::from_slice(&bytes).ok()?
        } else {
            BTreeMap::new()
        };
        if records.len() > 256 || records.keys().any(|tenant| validate_id(tenant).is_err()) {
            return None;
        }
        // Unreferenced versions are quarantined, never deleted: a valid manifest may
        // still be stale (e.g. restored from backup), and a later manifest that
        // references them again restores them. Counts only, never names.
        let live: BTreeSet<String> = records.values().map(|r| r.reference.clone()).collect();
        match store.sweep(MANIFEST, &live) {
            Err(_) => tracing::warn!("keystone credential residue cleanup skipped"),
            Ok(report) if report.quarantined + report.retained > 0 || report.truncated => {
                tracing::warn!(
                    quarantined = report.quarantined,
                    retained = report.retained,
                    restored = report.restored,
                    truncated = report.truncated,
                    "keystone credential versions unreferenced by the manifest were kept for manual review"
                )
            }
            Ok(report) if report.restored > 0 => tracing::info!(
                restored = report.restored,
                "keystone credential versions restored from quarantine"
            ),
            Ok(_) => {}
        }
        Some(Self {
            generation,
            store: Arc::new(store),
            transport,
            records: RwLock::new(records),
            metadata,
            mutation: Arc::new(tokio::sync::Mutex::new(())),
        })
    }
    fn revision(&self, tenant: &str) -> Option<u64> {
        let records = self.records.read().ok()?;
        let record = records.get(tenant)?;
        if record.model != self.generation.model() {
            return None;
        }
        self.generation
            .destination()
            .check_binding(&record.binding)
            .ok()?;
        Some(record.revision)
    }
    /// Called only inside `save`, so at most one blocking manifest write exists.
    async fn publish(
        &self,
        records: &BTreeMap<String, CredentialRecord>,
    ) -> std::result::Result<(), Unpublished> {
        let bytes = serde_json::to_vec(records).map_err(|_| Unpublished::Rejected)?;
        if bytes.len() > 1024 * 1024 {
            return Err(Unpublished::Rejected);
        }
        let metadata = self.metadata.clone();
        tokio::task::spawn_blocking(move || write_manifest(&metadata, &bytes))
            .await
            .unwrap_or(Err(Unpublished::Uncertain))
    }
    /// Caller holds `mutation` and has checked `permit` once already.
    async fn save(
        &self,
        tenant: &str,
        secret: ProviderSecret,
        permit: &dyn super::api::EventPermit,
    ) -> std::result::Result<(), ApiError> {
        let mut next = self
            .records
            .read()
            .map_err(|_| unavailable("secret_store_unavailable"))?
            .clone();
        if !next.contains_key(tenant) && next.len() >= 256 {
            return Err(unavailable("provider_capacity"));
        }
        let previous = next.get(tenant).cloned();
        let revision = previous
            .as_ref()
            .map_or(Some(1), |r| r.revision.checked_add(1))
            .ok_or(unavailable("provider_capacity"))?;
        let destination = self.generation.destination();
        let reference = self
            .store
            .put(tenant, destination, secret)
            .await
            .map_err(|_| unavailable("secret_store_unavailable"))?;
        next.insert(
            tenant.to_owned(),
            CredentialRecord {
                reference: reference.0.clone(),
                binding: destination.binding().clone(),
                revision,
                model: self.generation.model().into(),
            },
        );
        if !permit.administer() {
            let _ = self.store.delete(tenant, &reference, destination).await;
            return Err(admin_required());
        }
        match self.publish(&next).await {
            Ok(()) => {}
            Err(Unpublished::Rejected) => {
                let _ = self.store.delete(tenant, &reference, destination).await;
                return Err(unavailable("secret_store_unavailable"));
            }
            Err(Unpublished::Uncertain) => {
                // Mirror the manifest now in place, but keep the previous version:
                // a crash may restore the old manifest. The next open sweeps
                // whichever one the surviving manifest does not reference.
                *self
                    .records
                    .write()
                    .map_err(|_| unavailable("secret_store_unavailable"))? = next;
                return Err(unavailable("secret_store_unavailable"));
            }
        }
        // Only a version no surviving record references is retired: a malformed or
        // merged manifest may bind one id to several tenants, and the record that
        // can verify it must keep it. `next` is exactly what was just published.
        let superseded = previous
            .map(|p| p.reference)
            .filter(|old| next.values().all(|r| &r.reference != old));
        *self
            .records
            .write()
            .map_err(|_| unavailable("secret_store_unavailable"))? = next;
        if let Some(superseded) = superseded {
            // By path: the old binding may no longer verify after a policy change.
            // A failure leaves an unreferenced version for the next open's quarantine.
            let _ = self
                .store
                .retire(tenant, &SecretReference(superseded))
                .await;
        }
        Ok(())
    }
}
#[async_trait]
impl ModelProvider for ConfiguredProviders {
    fn request_manifest(&self, context: &FrozenProviderContext) -> Option<serde_json::Value> {
        Some(
            serde_json::json!({"endpoint":self.generation.destination().endpoint().as_str(),"body":self.generation.request_body(context)}),
        )
    }
    async fn propose(
        &self,
        _: &FrozenProviderContext,
    ) -> std::result::Result<ModelProposal, ProviderError> {
        Err(ProviderError::BindingInvalid)
    }
    async fn propose_versioned(
        &self,
        tenant: &str,
        revision: u64,
        context: &FrozenProviderContext,
    ) -> std::result::Result<ModelProposal, ProviderError> {
        let record = self
            .records
            .read()
            .map_err(|_| ProviderError::BindingInvalid)?
            .get(tenant)
            .cloned()
            .ok_or(ProviderError::BindingInvalid)?;
        if record.revision != revision || record.model != self.generation.model() {
            return Err(ProviderError::BindingInvalid);
        }
        self.generation
            .destination()
            .check_binding(&record.binding)?;
        let provider = LiveModelProvider::new(
            self.generation.clone(),
            tenant.into(),
            SecretReference(record.reference),
            self.store.clone(),
            self.transport.clone(),
        )?;
        let answer = provider.propose_for_tenant(tenant, context).await?;
        if self.revision(tenant) != Some(revision) {
            return Err(ProviderError::BindingInvalid);
        }
        Ok(answer)
    }
}

pub struct NativeExecution {
    repository: Arc<NativeRepository>,
    coordinator: Arc<Coordinator>,
    grants: Arc<CurrentGrantAuthorizer>,
    providers: Arc<ConfiguredProviders>,
    observers: Arc<CurrentGrantAuthorizer>,
    /// Separate from `observers`: open progress streams must not block key saves.
    administrators: Arc<CurrentGrantAuthorizer>,
    /// Who each live `credential_authority` permit was issued to, so `credential`
    /// can refuse a permit used for any other principal or issued elsewhere.
    /// A `Weak` pins the allocation, so a matching address is the same permit.
    /// Bounded by the administrators' grant capacity; dead entries are pruned.
    administrator_permits: std::sync::Mutex<Vec<(std::sync::Weak<Observer>, Principal)>>,
}
fn grant_error(error: super::tools::ToolError) -> ApiError {
    if error == super::tools::ToolError::Unavailable {
        unavailable("grant_capacity")
    } else {
        ApiError {
            status: StatusCode::UNAUTHORIZED,
            code: "authentication_required",
        }
    }
}
/// Same request-local credential lookup as candidate authorization; only digests
/// of it ever reach the grant registry.
fn request_session(
    req: &HttpRequest,
) -> std::result::Result<crate::rbac::map::SessionKey, ApiError> {
    super::runtime::request_session_key(req).ok_or(ApiError {
        status: StatusCode::UNAUTHORIZED,
        code: "authentication_required",
    })
}
fn unavailable(code: &'static str) -> ApiError {
    ApiError {
        status: StatusCode::SERVICE_UNAVAILABLE,
        code,
    }
}
struct Observer {
    grants: Arc<CurrentGrantAuthorizer>,
    grant: super::tools::RunGrant,
}
impl super::api::EventPermit for Observer {
    fn administer(&self) -> bool {
        self.grants.authorize_admin(&self.grant).is_ok()
    }
    fn allowed(&self, scope: &ScopeVersion) -> bool {
        super::tools::GrantAuthorizer::authorize(self.grants.as_ref(), &self.grant, scope).is_ok()
    }
}
impl Drop for Observer {
    fn drop(&mut self) {
        self.grants.release(&self.grant);
    }
}
/// Worker threads for accepted runs. Coordinator checkpoints are synchronous durable
/// commits, so runs never execute on HTTP workers or `QUERY_RUNTIME`; at most this many
/// can be inside a checkpoint at once, and waiting runs hold no thread.
const EXECUTION_THREADS: usize = 4;
static EXECUTION_RUNTIME: LazyLock<tokio::runtime::Runtime> = LazyLock::new(|| {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(EXECUTION_THREADS)
        .max_blocking_threads(EXECUTION_THREADS)
        .thread_name("keystone-execution")
        .enable_all()
        .build()
        .expect("keystone execution runtime should be constructible")
});

/// One run acceptance, owned by a repository blocking job from the durable commit through
/// dispatch, so a dropped request can neither strand an accepted run nor dispatch it twice.
struct Acceptance {
    coordinator: Arc<Coordinator>,
    /// Returns the fresh grant on drop unless the newly accepted run takes it over.
    release: Observer,
    access: BoundAccess,
    investigation_id: String,
    body: RunRequest,
    idempotency_key: String,
    provider_config_revision: u64,
}
impl Acceptance {
    fn run(self, repository: &NativeRepository) -> std::result::Result<Run, ApiError> {
        // The lane may have queued this job; `begin` rechecks the grant itself too.
        let access = self.access.revalidate()?;
        let (id, body) = (&self.investigation_id, &self.body);
        let snapshot = repository.read(&access.principal, id, |d| access.can_read(d))?;
        let node = snapshot.node(&body.node_id, body.node_version)?;
        if node.investigation_id != *id {
            return Err(KeystoneError::NotFound.into());
        }
        let parent = node.parent.as_ref().and_then(|p| {
            snapshot
                .exports
                .get(&format!("{}-v{}", p.node_id, p.version))
        });
        let selected_evidence_ids = node
            .context_manifest_id
            .as_ref()
            .and_then(|id| snapshot.contexts.get(id))
            .map(|c| c.manifest.evidence.iter().map(|e| e.id.clone()).collect())
            .unwrap_or_default();
        let request = StartRun {
            principal: access.principal.clone(),
            grant: self.release.grant.clone(),
            authorization_revision: "current_roles_v1".into(),
            investigation_id: id.clone(),
            node_id: body.node_id.clone(),
            node_version: body.node_version,
            expected_revision: body.expected_revision,
            idempotency_key: self.idempotency_key.clone(),
            selected_evidence_ids,
            scope_change_reviewed: parent.is_some_and(|p| !p.scope.same_bounds(&node.scope)),
            provider_config_revision: self.provider_config_revision,
        };
        // The whole admission and commit stay inside `begin`, unchanged.
        let run = self.coordinator.begin(&request)?;
        if !self
            .coordinator
            .run_uses_grant(&run.id, &self.release.grant.credential_id)
        {
            return Ok(run);
        }
        // begin is durably idempotent; execute rejects duplicate dispatch and terminal replays.
        let (coordinator, release) = (self.coordinator, self.release);
        let principal = access.principal;
        let run_id = run.id.clone();
        // No recovery here: a rejected claim means another execution owns the run
        // or it is already terminal, and other pre-claim errors mean the repository
        // is unusable until reopen, which interrupts unfinished runs. The grant is
        // held until the execution really ends. Spawns are bounded by the
        // coordinator's accepted-run limit: only a newly accepted run reaches here.
        EXECUTION_RUNTIME.spawn(async move {
            let _release = release;
            match coordinator.execute(&principal, &run_id).await {
                Ok(_) => {}
                Err(KeystoneError::Conflict) => {
                    tracing::debug!(run_id = %run_id, "keystone execution claim rejected")
                }
                Err(error) => tracing::warn!(
                    run_id = %run_id,
                    code = ApiError::from(error).code,
                    "keystone execution returned an error"
                ),
            }
        });
        Ok(run)
    }
}

impl NativeExecution {
    /// Missing configuration fails closed. No environment settings are changed.
    pub fn from_environment(
        repository: Arc<NativeRepository>,
    ) -> Option<Arc<dyn ExecutionService>> {
        let result = Self::load_environment(repository);
        if result.is_none() {
            tracing::info!(
                "native Keystone generation unavailable: verify operator model, encrypted credential store, deployment master key and egress CIDR configuration"
            );
        }
        result
    }
    fn load_environment(repository: Arc<NativeRepository>) -> Option<Arc<dyn ExecutionService>> {
        let root = PathBuf::from(std::env::var_os("KEYSTONE_NATIVE_DIRECTORY")?);
        let model = std::env::var("KEYSTONE_GENERATION_MODEL")
            .unwrap_or_else(|_| "xiaomi/mimo-v2.6-flash".into());
        // The initial provider was explicitly selected by the user. Other origins
        // require an operator-approved configuration, never a tenant key form.
        let generation = GenerationConfig::openrouter(model, 2048, 1).ok()?;
        let master = Zeroizing::new(std::env::var("KEYSTONE_SECRET_MASTER_KEY_HEX").ok()?);
        let mut key = Zeroizing::new([0u8; 32]);
        hex::decode_to_slice(master.as_bytes(), key.as_mut()).ok()?;
        let allowed = std::env::var("KEYSTONE_PROVIDER_ALLOWED_CIDRS")
            .ok()?
            .split(',')
            .map(|value| value.trim().parse())
            .collect::<std::result::Result<Vec<ipnet::IpNet>, _>>()
            .ok()?;
        let transport = Arc::new(PinnedHttpsTransport::new(allowed, Duration::from_secs(60)).ok()?);
        let providers = ConfiguredProviders::open(
            &root.join(".keystone_native/v1/credentials"),
            *key,
            generation,
            transport,
        )?;
        Some(Arc::new(Self::assemble(repository, Arc::new(providers))))
    }
    fn assemble(repository: Arc<NativeRepository>, providers: Arc<ConfiguredProviders>) -> Self {
        Self::assemble_with(
            repository,
            providers,
            |grants| -> (
                Arc<dyn super::tools::ReadExecutor>,
                Arc<dyn super::tools::GrantAuthorizer>,
            ) { (Arc::new(ScopedQueryExecutor::new(grants.clone())), grants) },
        )
    }
    /// Production passes the issuing registry itself as the coordinator's authorizer.
    fn assemble_with(
        repository: Arc<NativeRepository>,
        providers: Arc<ConfiguredProviders>,
        coordinate: impl FnOnce(
            Arc<CurrentGrantAuthorizer>,
        ) -> (
            Arc<dyn super::tools::ReadExecutor>,
            Arc<dyn super::tools::GrantAuthorizer>,
        ),
    ) -> Self {
        let grants = Arc::new(CurrentGrantAuthorizer::default());
        let (executor, authorizer) = coordinate(grants.clone());
        let coordinator = Arc::new(Coordinator::new_with_reads(
            repository.clone(),
            providers.clone(),
            authorizer,
            executor,
        ));
        Self {
            repository,
            coordinator,
            grants,
            providers,
            observers: Arc::new(CurrentGrantAuthorizer::default()),
            administrators: Arc::new(CurrentGrantAuthorizer::with_capacity(
                GrantCapacity::CREDENTIAL_ADMIN,
            )),
            administrator_permits: Default::default(),
        }
    }
    /// The principal `permit` was issued to by `credential_authority`, if it was.
    fn administrator_permit_owner(
        &self,
        permit: &Arc<dyn super::api::EventPermit>,
    ) -> Option<Principal> {
        let address = Arc::as_ptr(permit).cast::<()>();
        let mut permits = self.administrator_permits.lock().ok()?;
        permits.retain(|(issued, _)| issued.strong_count() > 0);
        permits
            .iter()
            .find(|(issued, _)| issued.as_ptr().cast::<()>() == address)
            .map(|(_, owner)| owner.clone())
    }
}
#[async_trait]
impl ExecutionService for NativeExecution {
    fn ready(&self, principal: &Principal) -> bool {
        self.providers.revision(&principal.tenant_id).is_some() && self.repository.health().is_ok()
    }
    fn provider_configuration(&self) -> Option<serde_json::Value> {
        Some(
            serde_json::json!({"model":self.providers.generation.model(),"apiBase":"https://openrouter.ai/api/v1","credentialEntry":true}),
        )
    }
    fn secret_store_ready(&self) -> bool {
        true
    }
    fn observe(
        &self,
        req: &HttpRequest,
    ) -> std::result::Result<Arc<dyn super::api::EventPermit>, ApiError> {
        let session = request_session(req)?;
        let grant = self
            .observers
            .issue(&session, presented_api_key(req))
            .map_err(grant_error)?;
        Ok(Arc::new(Observer {
            grants: self.observers.clone(),
            grant,
        }))
    }
    fn credential_authority(
        &self,
        req: &HttpRequest,
    ) -> std::result::Result<Arc<dyn super::api::EventPermit>, ApiError> {
        let session = request_session(req)?;
        let grant = self
            .administrators
            .issue(&session, presented_api_key(req))
            .map_err(grant_error)?;
        let owner = grant.principal.clone();
        let permit = Arc::new(Observer {
            grants: self.administrators.clone(),
            grant,
        });
        let mut permits = self
            .administrator_permits
            .lock()
            .map_err(|_| unavailable("grant_capacity"))?;
        permits.retain(|(issued, _)| issued.strong_count() > 0);
        permits.push((Arc::downgrade(&permit), owner));
        Ok(permit)
    }
    fn start(
        &self,
        req: &HttpRequest,
        access: &BoundAccess,
        id: &str,
        body: &RunRequest,
        key: &str,
    ) -> std::result::Result<StartJob, ApiError> {
        // Only this request thread sees the request and its session key. The job gets the
        // opaque grant (revalidated against current roles at every coordinator step) and
        // this request's bound access, which it revalidates before reading.
        let session = request_session(req)?;
        let provider_config_revision = self
            .providers
            .revision(&access.access().principal.tenant_id)
            .ok_or(unavailable("provider_unconfigured"))?;
        let grant = self
            .grants
            .issue(&session, presented_api_key(req))
            .map_err(grant_error)?;
        let acceptance = Acceptance {
            coordinator: self.coordinator.clone(),
            release: Observer {
                grants: self.grants.clone(),
                grant,
            },
            access: access.clone(),
            investigation_id: id.into(),
            body: body.clone(),
            idempotency_key: key.into(),
            provider_config_revision,
        };
        let repository = self.repository.clone();
        // Dropping the job before its blocking phase starts only returns the grant.
        Ok(Box::pin(async move {
            repository
                .blocking(move |repository| acceptance.run(repository))
                .await
        }))
    }
    async fn cancel(
        &self,
        access: &BoundAccess,
        investigation_id: &str,
        run: &str,
    ) -> std::result::Result<Run, ApiError> {
        let coordinator = self.coordinator.clone();
        let (access, investigation_id, run) =
            (access.clone(), investigation_id.to_owned(), run.to_owned());
        // Typed delegation only: the coordinator signals the owning execution and records
        // one idempotent terminal; the execution task itself is never aborted here.
        self.repository
            .blocking(move |repository| {
                // Current identity, credential and datasets, on this thread immediately
                // before the commit: waiting for the lane may have outlived them.
                let access = access.revalidate()?;
                let snapshot = repository
                    .read(&access.principal, &investigation_id, |d| access.can_read(d))?;
                if !snapshot.runs.contains_key(&run) {
                    return Err(KeystoneError::NotFound.into());
                }
                Ok(coordinator.cancel(&access.principal, &run)?)
            })
            .await
    }
    async fn credential(
        &self,
        principal: &Principal,
        secret: ProviderSecret,
        permit: Arc<dyn super::api::EventPermit>,
    ) -> std::result::Result<(), ApiError> {
        principal.validate()?;
        // The permit must be one this service issued to exactly this principal.
        if self.administrator_permit_owner(&permit).as_ref() != Some(principal) {
            return Err(admin_required());
        }
        // Waiting requests stay cancellable here; none has detached work yet.
        let guard = self.providers.mutation.clone().lock_owned().await;
        if !permit.administer() {
            return Err(admin_required());
        }
        // Once the encrypted write starts, the admin recheck, publish and retire run
        // to completion even if this request is dropped, so the manifest and the
        // in-memory records never disagree. The owned guard bounds this to one save.
        let providers = self.providers.clone();
        let tenant = principal.tenant_id.clone();
        tokio::spawn(async move {
            let _guard = guard;
            providers.save(&tenant, secret, permit.as_ref()).await
        })
        .await
        .unwrap_or_else(|_| Err(unavailable("secret_store_unavailable")))
    }
}

#[cfg(test)]
mod tests {
    use super::super::{
        runtime::tests::{basic_request, cookie_request, native_user, tenant_with_reader},
        tools::RunGrant,
    };
    use super::*;
    use crate::rbac::{Users, map::SessionKey, user::User};
    use actix_web::{HttpMessage, test::TestRequest};

    /// observe/start issue grants from exactly this request credential.
    fn issue(grants: &CurrentGrantAuthorizer, req: &HttpRequest) -> Option<RunGrant> {
        let session = request_session(req).ok()?;
        grants.issue(&session, presented_api_key(req)).ok()
    }

    #[test]
    fn grants_issue_from_core_basic_and_cookie_without_middleware_extension() {
        let tenant = tenant_with_reader();
        let user = native_user(&tenant);
        let basic_key = SessionKey::BasicAuth {
            username: user.userid().into(),
            password: "fixture-password".into(),
        };
        Users.new_session(&user, basic_key.clone(), chrono::TimeDelta::minutes(5));
        let cookie = ulid::Ulid::new();
        Users.new_session(
            &user,
            SessionKey::SessionId(cookie),
            chrono::TimeDelta::minutes(5),
        );
        let grants = CurrentGrantAuthorizer::default();
        for req in [
            basic_request(user.userid(), "fixture-password"),
            cookie_request(&cookie.to_string()),
        ] {
            assert!(req.extensions().get::<SessionKey>().is_none());
            let grant = issue(&grants, &req).expect("validated credential issues a grant");
            assert_eq!(grant.principal.owner_id, user.userid());
            assert_eq!(grant.principal.tenant_id, tenant);
            grants.release(&grant);
        }
        for req in [
            cookie_request("tampered-not-a-ulid"),
            TestRequest::default().to_http_request(),
        ] {
            assert_eq!(
                request_session(&req).err().map(|error| error.status),
                Some(StatusCode::UNAUTHORIZED)
            );
        }
        let wrong = basic_request(user.userid(), "wrong-fixture-password");
        assert!(issue(&grants, &wrong).is_none());
        Users.remove_session(&basic_key);
        let revoked = basic_request(user.userid(), "fixture-password");
        assert!(issue(&grants, &revoked).is_none());
    }

    #[test]
    fn grants_issue_from_middleware_api_key_extension_with_presented_key() {
        let tenant = tenant_with_reader();
        let user = User::new_api_key(
            ulid::Ulid::new(),
            "fixture-provider-key".into(),
            "fixture".into(),
            std::collections::HashSet::from(["query-logs".into()]),
            "fixture-owner".into(),
            Some(tenant),
        );
        Users.put_user(user.clone());
        let session = SessionKey::SessionId(ulid::Ulid::new());
        Users.new_session(&user, session.clone(), chrono::TimeDelta::minutes(5));
        let req = TestRequest::default()
            .insert_header(("x-api-key", "fixture-provider-key"))
            .to_http_request();
        req.extensions_mut().insert(session);
        let grants = CurrentGrantAuthorizer::default();
        let grant = issue(&grants, &req).expect("API-key session issues a grant");
        assert_eq!(grant.principal.owner_id, user.userid());
        let unkeyed = TestRequest::default().to_http_request();
        unkeyed
            .extensions_mut()
            .insert(request_session(&req).ok().unwrap());
        assert!(issue(&grants, &unkeyed).is_none());
    }

    #[derive(Default)]
    struct RecordingSecretStore {
        puts: std::sync::atomic::AtomicUsize,
        deletes: std::sync::atomic::AtomicUsize,
    }
    #[async_trait]
    impl SecretStore for RecordingSecretStore {
        async fn put(
            &self,
            _: &str,
            _: &super::super::providers::destination::ValidatedDestination,
            _: ProviderSecret,
        ) -> std::result::Result<SecretReference, ProviderError> {
            let n = self.puts.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(SecretReference(format!("fixture-ref-{n}")))
        }
        async fn delete(
            &self,
            _: &str,
            _: &SecretReference,
            _: &super::super::providers::destination::ValidatedDestination,
        ) -> std::result::Result<(), ProviderError> {
            self.deletes
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(())
        }
        async fn retire(
            &self,
            _: &str,
            _: &SecretReference,
        ) -> std::result::Result<(), ProviderError> {
            self.deletes
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(())
        }
        async fn resolve(
            &self,
            _: &str,
            _: &SecretReference,
            _: &super::super::providers::destination::ValidatedDestination,
        ) -> std::result::Result<ProviderSecret, ProviderError> {
            Err(ProviderError::SecretStoreUnavailable)
        }
    }
    /// Credential saves never reach the network.
    struct NoNetwork;
    #[async_trait]
    impl ProviderTransport for NoNetwork {
        async fn post_json(
            &self,
            _: &super::super::providers::destination::ValidatedDestination,
            _: &ProviderSecret,
            _: &[u8],
        ) -> std::result::Result<Vec<u8>, ProviderError> {
            panic!("credential administration must not dispatch provider requests")
        }
    }
    fn user_with_role(tenant: &str, role: &str) -> (User, HttpRequest, SessionKey) {
        use crate::rbac::user::{Basic, UserType};
        let user = User {
            ty: UserType::Native(Basic {
                username: format!("fixture-{}", ulid::Ulid::new()),
                password_hash: "unused-fixture".into(),
                email: None,
            }),
            roles: std::collections::HashSet::from([role.into()]),
            user_groups: Default::default(),
            tenant: Some(tenant.into()),
            protected: false,
        };
        Users.put_user(user.clone());
        let cookie = ulid::Ulid::new();
        let session = SessionKey::SessionId(cookie);
        Users.new_session(&user, session.clone(), chrono::TimeDelta::minutes(5));
        (user, cookie_request(&cookie.to_string()), session)
    }
    fn secret() -> ProviderSecret {
        ProviderSecret::new(b"synthetic-fixture-key".to_vec()).unwrap()
    }

    #[tokio::test]
    async fn credential_saves_use_capacity_separate_from_live_observers() {
        use crate::rbac::{
            map,
            role::model::{DefaultPrivilege, Role},
        };
        let tenant = tenant_with_reader();
        map::mut_roles().entry(tenant.clone()).or_default().insert(
            "keystone-admin".into(),
            Role::create_internal_role(vec![DefaultPrivilege::Admin]),
        );
        let directory = tempfile::Builder::new()
            .prefix("keystone-provider-runtime-")
            .tempdir_in("/dev/shm")
            .unwrap();
        let repository = Arc::new(NativeRepository::open(directory.path().join("repo")).unwrap());
        let store = Arc::new(RecordingSecretStore::default());
        let providers = Arc::new(ConfiguredProviders {
            generation: GenerationConfig::openrouter(
                super::super::providers::live::DEFAULT_OPENROUTER_MODEL.into(),
                2048,
                1,
            )
            .unwrap(),
            store: store.clone(),
            transport: Arc::new(NoNetwork),
            records: RwLock::new(BTreeMap::new()),
            metadata: directory.path().join("providers.json"),
            mutation: Arc::new(tokio::sync::Mutex::new(())),
        });
        let execution = NativeExecution::assemble(repository, providers.clone());
        let puts = || store.puts.load(std::sync::atomic::Ordering::SeqCst);

        // Readers hold every live-progress grant the tenant is allowed.
        let mut observers = vec![];
        let readers = GrantCapacity::STANDARD.tenant / GrantCapacity::STANDARD.principal;
        for _ in 0..readers {
            let (_, req, _) = user_with_role(&tenant, "query-logs");
            for _ in 0..GrantCapacity::STANDARD.principal {
                observers.push(
                    execution
                        .observe(&req)
                        .unwrap_or_else(|_| panic!("observer capacity")),
                );
            }
        }
        let (admin, admin_req, _) = user_with_role(&tenant, "keystone-admin");
        let principal = Principal {
            owner_id: admin.userid().into(),
            tenant_id: tenant.clone(),
        };
        assert_eq!(
            execution.observe(&admin_req).err().map(|e| e.code),
            Some("grant_capacity")
        );

        // Administration is unaffected, still bounded, and released after use.
        for revision in 1..=2 {
            let permit = execution.credential_authority(&admin_req).ok().unwrap();
            execution
                .credential(&principal, secret(), permit)
                .await
                .unwrap();
            assert_eq!(puts(), revision);
            assert_eq!(providers.revision(&tenant), Some(revision as u64));
        }
        assert_eq!(store.deletes.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert!(directory.path().join("providers.json").is_file());
        let held: Vec<_> = (0..GrantCapacity::CREDENTIAL_ADMIN.principal)
            .map(|_| execution.credential_authority(&admin_req).ok().unwrap())
            .collect();
        assert_eq!(
            execution
                .credential_authority(&admin_req)
                .err()
                .map(|e| e.code),
            Some("grant_capacity")
        );
        drop(held);
        drop(observers);

        // Non-admins and revoked sessions are refused before any encrypted write.
        let (reader, reader_req, _) = user_with_role(&tenant, "query-logs");
        let reader_principal = Principal {
            owner_id: reader.userid().into(),
            tenant_id: tenant.clone(),
        };
        let permit = execution.credential_authority(&reader_req).ok().unwrap();
        let denied = execution
            .credential(&reader_principal, secret(), permit)
            .await
            .unwrap_err();
        assert_eq!(
            (denied.status, denied.code),
            (StatusCode::FORBIDDEN, "admin_required")
        );
        let (revoked, revoked_req, revoked_session) = user_with_role(&tenant, "keystone-admin");
        let permit = execution.credential_authority(&revoked_req).ok().unwrap();
        Users.remove_session(&revoked_session);
        let denied = execution
            .credential(
                &Principal {
                    owner_id: revoked.userid().into(),
                    tenant_id: tenant.clone(),
                },
                secret(),
                permit,
            )
            .await
            .unwrap_err();
        assert_eq!(
            (denied.status, denied.code),
            (StatusCode::FORBIDDEN, "admin_required")
        );
        assert!(execution.credential_authority(&revoked_req).is_err());
        assert_eq!(
            execution
                .credential_authority(&TestRequest::default().to_http_request())
                .err()
                .map(|e| e.status),
            Some(StatusCode::UNAUTHORIZED)
        );
        assert_eq!(puts(), 2);
        assert_eq!(providers.revision(&tenant), Some(2));
    }

    fn tenant_with_admin() -> String {
        use crate::rbac::{
            map,
            role::model::{DefaultPrivilege, Role},
        };
        let tenant = tenant_with_reader();
        map::mut_roles().entry(tenant.clone()).or_default().insert(
            "keystone-admin".into(),
            Role::create_internal_role(vec![DefaultPrivilege::Admin]),
        );
        tenant
    }
    fn open_fixture(credentials: &Path, policy_revision: u64) -> Option<Arc<ConfiguredProviders>> {
        ConfiguredProviders::open(
            credentials,
            [11u8; 32],
            GenerationConfig::openrouter(
                super::super::providers::live::DEFAULT_OPENROUTER_MODEL.into(),
                2048,
                policy_revision,
            )
            .unwrap(),
            Arc::new(NoNetwork),
        )
        .map(Arc::new)
    }
    fn names(directory: &Path, suffix: &str) -> BTreeSet<String> {
        fs::read_dir(directory)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .filter(|name| name.ends_with(suffix))
            .collect()
    }
    fn manifest(credentials: &Path) -> BTreeMap<String, CredentialRecord> {
        serde_json::from_slice(&fs::read(credentials.join(MANIFEST)).unwrap()).unwrap()
    }
    async fn save(
        execution: &NativeExecution,
        req: &HttpRequest,
        principal: &Principal,
    ) -> std::result::Result<(), ApiError> {
        let permit = execution.credential_authority(req).ok().unwrap();
        execution.credential(principal, secret(), permit).await
    }

    #[tokio::test]
    async fn encrypted_credential_lifecycle_sweeps_residue_and_retires_across_policy_rotation() {
        let tenant = tenant_with_admin();
        let (admin, req, _) = user_with_role(&tenant, "keystone-admin");
        let principal = Principal {
            owner_id: admin.userid().into(),
            tenant_id: tenant.clone(),
        };
        let directory = tempfile::Builder::new()
            .prefix("keystone-provider-lifecycle-")
            .tempdir_in("/dev/shm")
            .unwrap();
        let credentials = directory.path().join("credentials");
        let repository = Arc::new(NativeRepository::open(directory.path().join("repo")).unwrap());

        let providers = open_fixture(&credentials, 1).unwrap();
        let execution = NativeExecution::assemble(repository.clone(), providers.clone());
        save(&execution, &req, &principal).await.unwrap();
        save(&execution, &req, &principal).await.unwrap();
        let live = manifest(&credentials)[&tenant].reference.clone();
        // The superseded version is retired once the new manifest is durable.
        assert_eq!(
            names(&credentials, ".sealed"),
            BTreeSet::from([format!("{live}.sealed")])
        );
        assert_eq!(providers.revision(&tenant), Some(2));

        // Crash residue: an unpublished version, a torn manifest write, an
        // unknown operator file and an unpublished foreign-tenant version.
        let destination = providers.generation.destination().clone();
        providers
            .store
            .put(&tenant, &destination, secret())
            .await
            .unwrap();
        providers
            .store
            .put("other-tenant", &destination, secret())
            .await
            .unwrap();
        fs::write(
            credentials.join(format!("providers.{}.pending", uuid::Uuid::new_v4())),
            b"{\"torn",
        )
        .unwrap();
        fs::write(credentials.join("operator-notes"), b"keep").unwrap();
        assert_eq!(names(&credentials, ".sealed").len(), 3);
        // The store lock is exclusive: a second process cannot sweep live work.
        assert!(open_fixture(&credentials, 1).is_none());
        drop(execution);
        drop(providers);

        let providers = open_fixture(&credentials, 1).unwrap();
        assert_eq!(
            names(&credentials, ".sealed"),
            BTreeSet::from([format!("{live}.sealed")])
        );
        assert!(names(&credentials, ".pending").is_empty());
        assert!(credentials.join("operator-notes").is_file());
        // Unpublished versions are kept for manual review, not destroyed.
        assert_eq!(
            names(
                &credentials.join(super::super::providers::secrets::QUARANTINE),
                ".sealed"
            )
            .len(),
            2
        );
        assert_eq!(providers.revision(&tenant), Some(2));
        assert!(
            providers
                .store
                .resolve(&tenant, &SecretReference(live.clone()), &destination)
                .await
                .is_ok()
        );
        drop(providers);

        // A policy revision change: the record no longer verifies but stays
        // referenced, so it survives reopen; the next save retires it by path.
        let providers = open_fixture(&credentials, 2).unwrap();
        assert_eq!(providers.revision(&tenant), None);
        assert_eq!(
            names(&credentials, ".sealed"),
            BTreeSet::from([format!("{live}.sealed")])
        );
        let execution = NativeExecution::assemble(repository.clone(), providers.clone());
        save(&execution, &req, &principal).await.unwrap();
        let rotated = manifest(&credentials)[&tenant].reference.clone();
        assert_ne!(rotated, live);
        assert_eq!(
            names(&credentials, ".sealed"),
            BTreeSet::from([format!("{rotated}.sealed")])
        );
        assert_eq!(providers.revision(&tenant), Some(3));

        // Failed persistence: the manifest cannot be replaced. The new version is
        // removed, the live record and its version are unchanged, nothing staged.
        fs::remove_file(credentials.join(MANIFEST)).unwrap();
        fs::create_dir(credentials.join(MANIFEST)).unwrap();
        fs::write(credentials.join(MANIFEST).join("blocker"), b"").unwrap();
        let failed = save(&execution, &req, &principal).await.unwrap_err();
        assert_eq!(
            (failed.status, failed.code),
            (StatusCode::SERVICE_UNAVAILABLE, "secret_store_unavailable")
        );
        assert_eq!(providers.revision(&tenant), Some(3));
        assert_eq!(
            names(&credentials, ".sealed"),
            BTreeSet::from([format!("{rotated}.sealed")])
        );
        assert!(names(&credentials, ".pending").is_empty());
        drop(execution);
        drop(providers);
        // An unreadable manifest fails closed and sweeps nothing.
        assert!(open_fixture(&credentials, 2).is_none());
        assert_eq!(
            names(&credentials, ".sealed"),
            BTreeSet::from([format!("{rotated}.sealed")])
        );
        // No plaintext anywhere in the store.
        for name in names(&credentials, "") {
            let path = credentials.join(name);
            if path.is_file() {
                let bytes = fs::read(path).unwrap();
                assert!(
                    !bytes
                        .windows(b"synthetic-fixture-key".len())
                        .any(|w| w == b"synthetic-fixture-key")
                );
            }
        }
    }

    /// Fails every scoped read, so a run ends before any generation, and records where
    /// the coordinator ran it.
    #[derive(Default)]
    struct FailingReads {
        threads: std::sync::Mutex<Vec<Option<String>>>,
    }
    #[async_trait]
    impl super::super::tools::ReadExecutor for FailingReads {
        async fn execute(
            &self,
            _: &RunGrant,
            _: &ScopeVersion,
            _: &super::super::tools::ReadOperation,
            _: tokio_util::sync::CancellationToken,
        ) -> std::result::Result<serde_json::Value, super::super::tools::ToolError> {
            self.threads
                .lock()
                .unwrap()
                .push(std::thread::current().name().map(str::to_owned));
            Err(super::super::tools::ToolError::Unavailable)
        }
    }

    /// Admits only the fixture owner's grants for scopes that owner approved.
    struct OwnerOnly(Principal);
    impl super::super::tools::GrantAuthorizer for OwnerOnly {
        fn authorize(
            &self,
            grant: &RunGrant,
            scope: &ScopeVersion,
        ) -> std::result::Result<(), super::super::tools::ToolError> {
            if grant.principal == self.0 && scope.approved_by == self.0.owner_id {
                Ok(())
            } else {
                Err(super::super::tools::ToolError::Unauthorized)
            }
        }
    }

    #[tokio::test]
    async fn dropped_run_request_after_acceptance_dispatches_exactly_once_off_http_workers() {
        use futures::FutureExt;
        let tenant = tenant_with_reader();
        let (user, req, session) = user_with_role(&tenant, "query-logs");
        let principal = Principal {
            tenant_id: tenant.clone(),
            owner_id: user.userid().into(),
        };
        let directory = tempfile::Builder::new()
            .prefix("keystone-run-drop-")
            .tempdir_in("/dev/shm")
            .unwrap();
        let repository = Arc::new(NativeRepository::open(directory.path().join("repo")).unwrap());
        let (_, mut investigation, mut node) = super::super::context::tests::fixture();
        investigation.tenant_id = tenant.clone();
        investigation.owner_id = principal.owner_id.clone();
        node.scope.approved_by = principal.owner_id.clone();
        repository
            .create(
                &principal,
                investigation.clone(),
                node.clone(),
                super::super::repository::IdempotencyRequest {
                    key: "run-drop-create".into(),
                    fingerprint: "run-drop-create".into(),
                },
            )
            .unwrap();
        let generation = GenerationConfig::openrouter(
            super::super::providers::live::DEFAULT_OPENROUTER_MODEL.into(),
            2048,
            1,
        )
        .unwrap();
        let record = CredentialRecord {
            reference: "fixture-ref-0".into(),
            binding: generation.destination().binding().clone(),
            revision: 1,
            model: generation.model().into(),
        };
        let providers = Arc::new(ConfiguredProviders {
            generation,
            store: Arc::new(RecordingSecretStore::default()),
            transport: Arc::new(NoNetwork),
            records: RwLock::new(BTreeMap::from([(tenant.clone(), record)])),
            metadata: directory.path().join("providers.json"),
            mutation: Arc::new(tokio::sync::Mutex::new(())),
        });
        let reads = Arc::new(FailingReads::default());
        // Grants are still issued from the real session. Only the coordinator's dataset
        // authorization is replaced: the live check looks streams up in the server global.
        let execution = NativeExecution::assemble_with(repository.clone(), providers, {
            let reads = reads.clone();
            let owner = principal.clone();
            move |_| -> (
                Arc<dyn super::super::tools::ReadExecutor>,
                Arc<dyn super::super::tools::GrantAuthorizer>,
            ) { (reads, Arc::new(OwnerOnly(owner))) }
        });
        assert!(execution.ready(&principal));
        let Ok(access) = super::super::runtime::candidate_authority(&req) else {
            panic!("the fixture session must bind");
        };
        assert!(access.access().can_read("logs"));
        let body = RunRequest {
            node_id: node.id.clone(),
            node_version: 1,
            expected_revision: 0,
        };

        let (entered, release) = repository.gate_next_commit();
        let mut job = execution
            .start(&req, &access, &investigation.id, &body, "run-drop")
            .unwrap();
        // One poll admits the acceptance to the blocking lane; then the client goes away.
        assert!((&mut job).now_or_never().is_none());
        drop(job);
        // The acceptance commit is durably in progress though nobody awaits it.
        entered.await.unwrap();
        release.send(()).unwrap();
        let run = tokio::time::timeout(Duration::from_secs(60), async {
            loop {
                let state = repository.snapshot().unwrap();
                if let Some(run) = state.runs.values().find(|r| r.status.is_terminal()) {
                    break run.clone();
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("the accepted run was stranded");
        assert_eq!(run.status, RunStatus::Failed);
        let kinds = |state: &super::super::repository::RepositoryState| {
            state.events[&run.id]
                .iter()
                .map(|e| e.kind.clone())
                .collect::<Vec<_>>()
        };
        let committed = repository.snapshot().unwrap();
        assert_eq!(
            kinds(&committed),
            ["queued", "running", "read_started", "failed"]
        );
        // Executed once, on the dedicated runtime rather than an HTTP or query worker.
        assert_eq!(
            *reads.threads.lock().unwrap(),
            [Some("keystone-execution".to_owned())]
        );

        // A retry with the same key replays the accepted run and dispatches nothing.
        let replay = execution
            .start(&req, &access, &investigation.id, &body, "run-drop")
            .unwrap()
            .await
            .unwrap();
        assert_eq!(replay.id, run.id);
        repository.drain_blocking().await;
        let after = repository.snapshot().unwrap();
        assert_eq!(after.runs.len(), 1);
        assert_eq!(kinds(&after), kinds(&committed));
        assert_eq!(reads.threads.lock().unwrap().len(), 1);

        // Cancel revalidates inside its own job: a session that ends after the request
        // resolved commits nothing, while the same principal's current session can.
        let queued = execution
            .coordinator
            .begin(&StartRun {
                principal: principal.clone(),
                grant: RunGrant {
                    principal: principal.clone(),
                    credential_id: "cancel-fixture-grant".into(),
                    expires_at: chrono::Utc::now().timestamp() + 120,
                },
                authorization_revision: "current_roles_v1".into(),
                investigation_id: investigation.id.clone(),
                node_id: node.id.clone(),
                node_version: 1,
                expected_revision: after.investigations[&investigation.id].semantic_revision,
                idempotency_key: "run-cancel".into(),
                selected_evidence_ids: vec![],
                scope_change_reviewed: false,
                provider_config_revision: 1,
            })
            .unwrap();
        Users.remove_session(&session);
        let denied = execution
            .cancel(&access, &investigation.id, &queued.id)
            .await
            .unwrap_err();
        assert_eq!(
            (denied.status, denied.code),
            (StatusCode::UNAUTHORIZED, "authentication_required")
        );
        repository.drain_blocking().await;
        assert_eq!(
            repository.snapshot().unwrap().runs[&queued.id].status,
            RunStatus::Queued
        );
        let cookie = ulid::Ulid::new();
        Users.new_session(
            &user,
            SessionKey::SessionId(cookie),
            chrono::TimeDelta::minutes(5),
        );
        let Ok(current) =
            super::super::runtime::candidate_authority(&cookie_request(&cookie.to_string()))
        else {
            panic!("the principal's current session must bind");
        };
        let cancelled = execution
            .cancel(&current, &investigation.id, &queued.id)
            .await
            .unwrap();
        assert_eq!(cancelled.status, RunStatus::Cancelled);
    }

    #[tokio::test]
    async fn dropped_credential_request_still_publishes_exactly_once() {
        let tenant = tenant_with_admin();
        let (admin, req, _) = user_with_role(&tenant, "keystone-admin");
        let principal = Principal {
            owner_id: admin.userid().into(),
            tenant_id: tenant.clone(),
        };
        let directory = tempfile::Builder::new()
            .prefix("keystone-provider-cancel-")
            .tempdir_in("/dev/shm")
            .unwrap();
        let credentials = directory.path().join("credentials");
        let repository = Arc::new(NativeRepository::open(directory.path().join("repo")).unwrap());
        let providers = open_fixture(&credentials, 1).unwrap();
        let execution = NativeExecution::assemble(repository, providers.clone());
        save(&execution, &req, &principal).await.unwrap();
        let first = manifest(&credentials)[&tenant].reference.clone();

        let permit = execution.credential_authority(&req).ok().unwrap();
        // One poll, then drop: the save has been handed to its task, which cannot
        // run on this current-thread runtime before the request is gone.
        use futures::FutureExt;
        assert!(
            execution
                .credential(&principal, secret(), permit)
                .now_or_never()
                .is_none()
        );
        // The detached save owns the lock until it has fully published or rolled back.
        drop(providers.mutation.lock().await);
        let published = manifest(&credentials)[&tenant].clone();
        assert_eq!(published.revision, 2);
        assert_ne!(published.reference, first);
        assert_eq!(providers.revision(&tenant), Some(2));
        assert_eq!(
            names(&credentials, ".sealed"),
            BTreeSet::from([format!("{}.sealed", published.reference)])
        );
        assert!(names(&credentials, ".pending").is_empty());
        assert!(names(&credentials, ".sealing").is_empty());
        // Admin capacity was released once the detached save finished.
        let held: Vec<_> = (0..GrantCapacity::CREDENTIAL_ADMIN.principal)
            .map(|_| execution.credential_authority(&req).ok().unwrap())
            .collect();
        drop(held);
    }

    #[tokio::test]
    async fn stale_valid_manifest_quarantines_recoverably_and_never_destroys_keys() {
        let quarantine =
            |credentials: &Path| credentials.join(super::super::providers::secrets::QUARANTINE);
        let tenant = tenant_with_admin();
        let (admin, req, _) = user_with_role(&tenant, "keystone-admin");
        let principal = Principal {
            owner_id: admin.userid().into(),
            tenant_id: tenant.clone(),
        };
        let directory = tempfile::Builder::new()
            .prefix("keystone-provider-stale-")
            .tempdir_in("/dev/shm")
            .unwrap();
        let credentials = directory.path().join("credentials");
        let repository = Arc::new(NativeRepository::open(directory.path().join("repo")).unwrap());
        let providers = open_fixture(&credentials, 1).unwrap();
        let execution = NativeExecution::assemble(repository, providers.clone());
        save(&execution, &req, &principal).await.unwrap();
        let live = manifest(&credentials)[&tenant].reference.clone();
        let sealed = format!("{live}.sealed");
        let current = fs::read(credentials.join(MANIFEST)).unwrap();
        let ciphertext = fs::read(credentials.join(&sealed)).unwrap();
        drop(execution);
        drop(providers);

        // A syntactically valid but stale manifest, across two restarts: the key
        // is moved aside unchanged, never deleted, and the store stays usable.
        fs::write(credentials.join(MANIFEST), b"{}").unwrap();
        for _ in 0..2 {
            let providers = open_fixture(&credentials, 1).unwrap();
            assert_eq!(providers.revision(&tenant), None);
            assert!(names(&credentials, ".sealed").is_empty());
            assert_eq!(
                fs::read(quarantine(&credentials).join(&sealed)).unwrap(),
                ciphertext
            );
        }
        // Missing or unreadable manifests fail closed and move nothing.
        for torn in [b"{\"torn".as_slice(), b"[]", b"{\"bad tenant/\":{}}"] {
            fs::write(credentials.join(MANIFEST), torn).unwrap();
            assert!(open_fixture(&credentials, 1).is_none());
            assert!(quarantine(&credentials).join(&sealed).is_file());
        }
        fs::remove_file(credentials.join(MANIFEST)).unwrap();
        assert_eq!(
            open_fixture(&credentials, 1).unwrap().revision(&tenant),
            None
        );
        assert!(quarantine(&credentials).join(&sealed).is_file());

        // Restoring the current manifest restores its key, which then verifies.
        fs::write(credentials.join(MANIFEST), &current).unwrap();
        let providers = open_fixture(&credentials, 1).unwrap();
        assert_eq!(providers.revision(&tenant), Some(1));
        assert_eq!(
            names(&credentials, ".sealed"),
            BTreeSet::from([sealed.clone()])
        );
        assert!(names(&quarantine(&credentials), ".sealed").is_empty());
        let destination = providers.generation.destination().clone();
        assert!(
            providers
                .store
                .resolve(&tenant, &SecretReference(live.clone()), &destination)
                .await
                .is_ok()
        );
        drop(providers);
        // Current references are never quarantined on later restarts.
        let providers = open_fixture(&credentials, 1).unwrap();
        assert_eq!(names(&credentials, ".sealed"), BTreeSet::from([sealed]));
        assert_eq!(providers.revision(&tenant), Some(1));
    }

    #[tokio::test]
    async fn rotation_never_retires_a_version_another_record_still_references() {
        let (tenant, other) = (tenant_with_admin(), tenant_with_admin());
        assert_ne!(tenant, other);
        let (admin, req, _) = user_with_role(&tenant, "keystone-admin");
        let (other_admin, other_req, _) = user_with_role(&other, "keystone-admin");
        let principal = Principal {
            owner_id: admin.userid().into(),
            tenant_id: tenant.clone(),
        };
        let other_principal = Principal {
            owner_id: other_admin.userid().into(),
            tenant_id: other.clone(),
        };
        let directory = tempfile::Builder::new()
            .prefix("keystone-provider-shared-")
            .tempdir_in("/dev/shm")
            .unwrap();
        let credentials = directory.path().join("credentials");
        let repository = Arc::new(NativeRepository::open(directory.path().join("repo")).unwrap());
        let providers = open_fixture(&credentials, 1).unwrap();
        let execution = NativeExecution::assemble(repository.clone(), providers.clone());
        save(&execution, &other_req, &other_principal)
            .await
            .unwrap();
        drop(execution);
        drop(providers);

        // A malformed (forged or badly merged) manifest binds the other tenant's
        // version to this tenant too. It loads, but only its sealing tenant verifies.
        let mut records = manifest(&credentials);
        let shared = records[&other].clone();
        records.insert(tenant.clone(), shared.clone());
        fs::write(
            credentials.join(MANIFEST),
            serde_json::to_vec(&records).unwrap(),
        )
        .unwrap();
        let providers = open_fixture(&credentials, 1).unwrap();
        let destination = providers.generation.destination().clone();
        let reference = SecretReference(shared.reference.clone());
        assert_eq!(
            providers
                .store
                .resolve(&tenant, &reference, &destination)
                .await
                .unwrap_err(),
            ProviderError::BindingInvalid
        );
        assert!(
            providers
                .store
                .resolve(&other, &reference, &destination)
                .await
                .is_ok()
        );

        // This tenant rotates away from the shared id; the other record keeps it.
        let execution = NativeExecution::assemble(repository, providers.clone());
        save(&execution, &req, &principal).await.unwrap();
        let published = manifest(&credentials);
        assert_ne!(published[&tenant].reference, shared.reference);
        assert_eq!(published[&other].reference, shared.reference);
        assert!(
            credentials
                .join(format!("{}.sealed", shared.reference))
                .is_file()
        );
        for (owner, record) in [(&tenant, &published[&tenant]), (&other, &shared)] {
            assert!(
                providers
                    .store
                    .resolve(
                        owner,
                        &SecretReference(record.reference.clone()),
                        &destination
                    )
                    .await
                    .is_ok()
            );
        }
        assert_eq!(providers.revision(&other), Some(1));
        // Once nothing references it, the next rotation retires it as before.
        save(&execution, &other_req, &other_principal)
            .await
            .unwrap();
        assert!(
            !credentials
                .join(format!("{}.sealed", shared.reference))
                .exists()
        );
        assert_eq!(names(&credentials, ".sealed").len(), 2);
    }

    /// Claims administration unconditionally; never issued by `credential_authority`.
    struct ForgedPermit;
    impl super::super::api::EventPermit for ForgedPermit {
        fn allowed(&self, _: &ScopeVersion) -> bool {
            true
        }
        fn administer(&self) -> bool {
            true
        }
    }

    #[tokio::test]
    async fn credential_permits_bind_to_the_principal_they_were_issued_to() {
        let tenant = tenant_with_admin();
        let (admin, req, _) = user_with_role(&tenant, "keystone-admin");
        let (peer, peer_req, _) = user_with_role(&tenant, "keystone-admin");
        let principal = Principal {
            owner_id: admin.userid().into(),
            tenant_id: tenant.clone(),
        };
        let peer_principal = Principal {
            owner_id: peer.userid().into(),
            tenant_id: tenant.clone(),
        };
        let directory = tempfile::Builder::new()
            .prefix("keystone-provider-permit-")
            .tempdir_in("/dev/shm")
            .unwrap();
        let repository = Arc::new(NativeRepository::open(directory.path().join("repo")).unwrap());
        let store = Arc::new(RecordingSecretStore::default());
        let providers = Arc::new(ConfiguredProviders {
            generation: GenerationConfig::openrouter(
                super::super::providers::live::DEFAULT_OPENROUTER_MODEL.into(),
                2048,
                1,
            )
            .unwrap(),
            store: store.clone(),
            transport: Arc::new(NoNetwork),
            records: RwLock::new(BTreeMap::new()),
            metadata: directory.path().join("providers.json"),
            mutation: Arc::new(tokio::sync::Mutex::new(())),
        });
        let execution = NativeExecution::assemble(repository, providers.clone());
        let refused = |result: std::result::Result<(), ApiError>| {
            let error = result.unwrap_err();
            assert_eq!(
                (error.status, error.code),
                (StatusCode::FORBIDDEN, "admin_required")
            );
        };
        // Another admin's permit, a foreign tenant principal and a forged permit
        // are all refused before any encrypted write.
        let peer_permit = execution.credential_authority(&peer_req).ok().unwrap();
        refused(
            execution
                .credential(&principal, secret(), peer_permit.clone())
                .await,
        );
        let foreign = Principal {
            owner_id: peer_principal.owner_id.clone(),
            tenant_id: tenant_with_admin(),
        };
        refused(
            execution
                .credential(&foreign, secret(), peer_permit.clone())
                .await,
        );
        refused(
            execution
                .credential(&principal, secret(), Arc::new(ForgedPermit))
                .await,
        );
        // A permit from another service instance is not this service's permit.
        let other = NativeExecution::assemble(
            Arc::new(NativeRepository::open(directory.path().join("other")).unwrap()),
            providers.clone(),
        );
        refused(
            execution
                .credential(
                    &principal,
                    secret(),
                    other.credential_authority(&req).ok().unwrap(),
                )
                .await,
        );
        assert_eq!(store.puts.load(std::sync::atomic::Ordering::SeqCst), 0);
        // Each permit still works for its own principal, and dropped ones are pruned.
        execution
            .credential(&peer_principal, secret(), peer_permit)
            .await
            .unwrap();
        let permit = execution.credential_authority(&req).ok().unwrap();
        execution
            .credential(&principal, secret(), permit)
            .await
            .unwrap();
        assert_eq!(store.puts.load(std::sync::atomic::Ordering::SeqCst), 2);
        let _ = execution.credential_authority(&req).ok().unwrap();
        assert!(
            execution
                .administrator_permits
                .lock()
                .unwrap()
                .iter()
                .all(|(issued, _)| issued.strong_count() == 0)
        );
    }
}
