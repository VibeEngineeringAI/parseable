//! Small native REST surface. Runs are rejected before acceptance until live execution is ready.
use super::{
    domain::*,
    repository::{IdempotencyRequest, InvestigationSnapshot, NativeRepository, RevisionKind},
};
use actix_web::{HttpRequest, HttpResponse, ResponseError, Route, Scope, http::StatusCode, web};
use serde::Deserialize;
use serde_json::json;
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};

#[derive(Clone)]
pub struct Access {
    pub principal: Principal,
    pub datasets: BTreeSet<String>,
    pub all_datasets: bool,
    pub manage_providers: bool,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunRequest {
    pub node_id: String,
    pub node_version: u64,
    pub expected_revision: u64,
}

/// Owned durable acceptance work. It never holds the request, a session key or a raw
/// credential; once polled into its durable phase it completes even if dropped.
pub type StartJob = futures_util::future::BoxFuture<'static, std::result::Result<Run, ApiError>>;

#[async_trait::async_trait]
pub trait ExecutionService: Send + Sync {
    fn ready(&self, principal: &Principal) -> bool;
    fn secret_store_ready(&self) -> bool;
    fn provider_configuration(&self) -> Option<serde_json::Value> {
        None
    }
    fn observe(&self, req: &HttpRequest) -> std::result::Result<Arc<dyn EventPermit>, ApiError>;
    /// Binds the run to this request's current session and roles on the request thread,
    /// then returns the job that accepts and dispatches it off the HTTP worker. The job
    /// revalidates `access` before it reads the investigation.
    fn start(
        &self,
        req: &HttpRequest,
        access: &BoundAccess,
        id: &str,
        body: &RunRequest,
        key: &str,
    ) -> std::result::Result<StartJob, ApiError>;
    /// Runs off the HTTP worker; once started it completes even if the caller is dropped.
    /// The job revalidates `access` and the run's investigation immediately before the
    /// cancel commit.
    async fn cancel(
        &self,
        access: &BoundAccess,
        investigation_id: &str,
        run: &str,
    ) -> std::result::Result<Run, ApiError>;
    /// Bind a credential save to this request's current identity, credential and
    /// roles, using capacity reserved for provider administration. Live progress
    /// observers can never exhaust it. Services without a secret store fail closed.
    fn credential_authority(
        &self,
        _req: &HttpRequest,
    ) -> std::result::Result<Arc<dyn EventPermit>, ApiError> {
        Err(ApiError {
            status: StatusCode::SERVICE_UNAVAILABLE,
            code: "secret_store_unavailable",
        })
    }
    /// `permit` must come from `credential_authority`; it is rechecked before and
    /// after the encrypted write.
    async fn credential(
        &self,
        principal: &Principal,
        secret: super::providers::secrets::ProviderSecret,
        permit: Arc<dyn EventPermit>,
    ) -> std::result::Result<(), ApiError>;
}
pub trait EventPermit: Send + Sync {
    fn allowed(&self, scope: &ScopeVersion) -> bool;
    fn administer(&self) -> bool {
        false
    }
}
impl Access {
    pub fn can_read(&self, dataset: &str) -> bool {
        !dataset.starts_with('_') && (self.all_datasets || self.datasets.contains(dataset))
    }
}
/// Resolves a request's identity, credential and roles again after its request thread.
/// Implementations hold no request, raw session key, password or API key: only the
/// session-derived principal and salted credential digests.
pub trait CurrentAccess: Send + Sync {
    fn current(&self) -> std::result::Result<Access, ApiError>;
}
impl<F> CurrentAccess for F
where
    F: Fn() -> std::result::Result<Access, ApiError> + Send + Sync,
{
    fn current(&self) -> std::result::Result<Access, ApiError> {
        self()
    }
}
/// The access a request resolved, bound to the credential it authenticated with.
/// Blocking-lane jobs can wait for a slot while sessions end, keys rotate or roles
/// change, so every job calls `revalidate` itself, immediately before its protected
/// lookup, projection or commit. What happens after that call, including sending
/// response bytes, is not rechecked.
#[derive(Clone)]
pub struct BoundAccess {
    issued: Access,
    current: Arc<dyn CurrentAccess>,
}
impl BoundAccess {
    pub fn new(issued: Access, current: Arc<dyn CurrentAccess>) -> Self {
        Self { issued, current }
    }
    /// What the request was authorized for when it was resolved. Use it only on the
    /// request thread; it also bounds every later revalidation.
    pub fn access(&self) -> &Access {
        &self.issued
    }
    /// Current access, never wider than when issued: a role granted later cannot widen
    /// it, and a different, revoked, rotated or expired identity or credential is
    /// refused before anything is looked up.
    pub fn revalidate(&self) -> std::result::Result<Access, ApiError> {
        let current = self.current.current()?;
        let issued = &self.issued;
        if current.principal != issued.principal {
            return Err(authentication_required());
        }
        let datasets = if issued.all_datasets {
            current.datasets
        } else if current.all_datasets {
            issued.datasets.clone()
        } else {
            issued
                .datasets
                .intersection(&current.datasets)
                .cloned()
                .collect()
        };
        Ok(Access {
            principal: current.principal,
            datasets,
            all_datasets: issued.all_datasets && current.all_datasets,
            manage_providers: issued.manage_providers && current.manage_providers,
        })
    }
    /// Test adapters whose identity never changes after resolution.
    #[cfg(test)]
    pub(super) fn unchanged(issued: Access) -> Self {
        let current = issued.clone();
        Self::new(issued, Arc::new(move || Ok(current.clone())))
    }
}
pub(super) fn authentication_required() -> ApiError {
    ApiError {
        status: StatusCode::UNAUTHORIZED,
        code: "authentication_required",
    }
}
#[async_trait::async_trait(?Send)]
pub trait ScopePreparer: Send + Sync {
    fn candidate_access(&self, req: &HttpRequest) -> std::result::Result<BoundAccess, ApiError>;
    /// Authorize requested datasets before reading metadata; no durable telemetry writes.
    async fn prepare(
        &self,
        req: &HttpRequest,
        scope: &ScopeVersion,
    ) -> std::result::Result<(), ApiError>;
}
pub struct ApiState {
    pub scope_preparer: Option<Arc<dyn ScopePreparer>>,
    pub repository: Option<Arc<NativeRepository>>,
    pub authorize: fn(&HttpRequest) -> std::result::Result<BoundAccess, ApiError>,
    pub mode: &'static str,
    pub execution: Option<Arc<dyn ExecutionService>>,
}
#[derive(Debug, thiserror::Error)]
#[error("{code}")]
pub struct ApiError {
    pub status: StatusCode,
    pub code: &'static str,
}
impl ResponseError for ApiError {
    fn status_code(&self) -> StatusCode {
        self.status
    }
    fn error_response(&self) -> HttpResponse {
        HttpResponse::build(self.status).json(json!({"schemaVersion":1,"error":{"code":self.code}}))
    }
}
impl From<KeystoneError> for ApiError {
    fn from(error: KeystoneError) -> Self {
        let (status, code) = match error {
            KeystoneError::RunCapacity => (StatusCode::TOO_MANY_REQUESTS, "run_capacity"),
            KeystoneError::Forbidden | KeystoneError::NotFound => {
                (StatusCode::NOT_FOUND, "not_found")
            }
            KeystoneError::QuotaExceeded(_) => {
                (StatusCode::TOO_MANY_REQUESTS, "storage_quota_exceeded")
            }
            KeystoneError::Conflict => (StatusCode::CONFLICT, "revision_conflict"),
            KeystoneError::Invalid(_) | KeystoneError::Json(_) => {
                (StatusCode::BAD_REQUEST, "invalid_request")
            }
            _ => (StatusCode::SERVICE_UNAVAILABLE, "storage_unavailable"),
        };
        Self { status, code }
    }
}
impl ApiState {
    async fn prepare_scope(
        &self,
        req: &HttpRequest,
        scope: &ScopeVersion,
    ) -> std::result::Result<(), ApiError> {
        let mut scope = scope.clone();
        scope.approved_by = (self.authorize)(req)?.access().principal.owner_id.clone();
        scope.validate()?;
        if let Some(preparer) = &self.scope_preparer {
            preparer.prepare(req, &scope).await?;
        }
        Ok(())
    }
    async fn prepare_existing(
        &self,
        req: &HttpRequest,
        id: Option<&str>,
    ) -> std::result::Result<(), ApiError> {
        let Some(preparer) = &self.scope_preparer else {
            return Ok(());
        };
        let bound = preparer.candidate_access(req)?;
        let id = id.map(str::to_owned);
        // Ownership and every current dataset grant are checked before metadata I/O.
        let plan = self
            .repository()?
            .blocking(move |repository| {
                let access = bound.revalidate()?;
                Ok::<_, ApiError>(metadata_plan(repository, &access, id.as_deref())?)
            })
            .await?;
        let Some((mut metadata_scope, datasets)) = plan else {
            return Ok(());
        };
        // Scope preparation uses only dataset identifiers. Saved time windows remain immutable.
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            for chunk in datasets.chunks(32) {
                metadata_scope.datasets = chunk.to_vec();
                preparer.prepare(req, &metadata_scope).await?;
            }
            Ok::<_, ApiError>(())
        })
        .await
        .map_err(|_| ApiError {
            status: StatusCode::SERVICE_UNAVAILABLE,
            code: "dataset_metadata_unavailable",
        })?
    }
    fn repository(&self) -> std::result::Result<Arc<NativeRepository>, ApiError> {
        self.repository.clone().ok_or(ApiError {
            status: StatusCode::SERVICE_UNAVAILABLE,
            code: "storage_unavailable",
        })
    }
    /// One owner-scoped read and its projection on the repository's bounded blocking lane,
    /// revalidated when the job starts. The request never enters the job.
    async fn read<T: Send + 'static>(
        &self,
        bound: BoundAccess,
        id: String,
        project: impl FnOnce(InvestigationSnapshot) -> Result<T> + Send + 'static,
    ) -> std::result::Result<T, ApiError> {
        self.repository()?
            .blocking(move |repository| {
                let access = bound.revalidate()?;
                let snapshot = repository.read(&access.principal, &id, |d| access.can_read(d))?;
                Ok(project(snapshot)?)
            })
            .await
    }
}

/// The datasets whose metadata must be loaded before the caller's readable investigations
/// (one, or all of them) are used, and the first node's scope as the request template.
fn metadata_plan(
    repository: &NativeRepository,
    access: &Access,
    id: Option<&str>,
) -> Result<Option<(ScopeVersion, Vec<String>)>> {
    let (first, datasets) = if let Some(id) = id {
        // `read` has already authorized ownership and every node and evidence dataset.
        let snapshot = repository.read(&access.principal, id, |d| access.can_read(d))?;
        let first = snapshot
            .nodes
            .values()
            .find(|n| n.investigation_id == id)
            .map(|n| n.scope.clone());
        let datasets: BTreeSet<String> = snapshot
            .nodes
            .values()
            .filter(|n| n.investigation_id == id)
            .flat_map(|n| n.scope.datasets.iter())
            .chain(
                snapshot
                    .evidence
                    .values()
                    .filter(|e| e.investigation_id == id)
                    .flat_map(|e| e.datasets.iter()),
            )
            .cloned()
            .collect();
        (first, datasets)
    } else {
        let readable: Vec<_> = repository
            .owned_summaries(&access.principal)?
            .into_iter()
            .filter(|s| s.datasets.iter().all(|d| access.can_read(d)))
            .collect();
        let first = readable
            .iter()
            .filter_map(|s| s.first_node.as_ref())
            .min_by(|a, b| a.0.cmp(&b.0))
            .map(|(_, scope)| scope.clone());
        let datasets = readable.into_iter().flat_map(|s| s.datasets).collect();
        (first, datasets)
    };
    Ok(first.map(|scope| (scope, datasets.into_iter().collect())))
}

pub fn scope(state: web::Data<ApiState>, protect: fn(Route) -> Route) -> Scope {
    web::scope("/keystone/native")
        .app_data(state)
        .app_data(
            web::JsonConfig::default()
                .limit(64 * 1024)
                .error_handler(|_, _| {
                    ApiError {
                        status: StatusCode::BAD_REQUEST,
                        code: "invalid_json",
                    }
                    .into()
                }),
        )
        .service(web::resource("/capabilities").route(protect(web::get().to(capabilities))))
        .service(
            web::resource("/investigations")
                .route(protect(web::post().to(create)))
                .route(protect(web::get().to(list))),
        )
        .service(web::resource("/investigations/{id}").route(protect(web::get().to(read))))
        .service(web::resource("/investigations/{id}/layout").route(protect(web::put().to(layout))))
        .service(web::resource("/investigations/{id}/nodes").route(protect(web::post().to(branch))))
        .service(
            web::resource("/investigations/{id}/runs").route(protect(web::post().to(start_run))),
        )
        .service(web::resource("/ui/capabilities").route(protect(web::get().to(ui_capabilities))))
        .service(
            web::resource("/investigations/{id}/graph").route(protect(web::get().to(ui_graph))),
        )
        .service(
            web::resource("/investigations/{id}/presentation")
                .route(protect(web::get().to(ui_layout))),
        )
        .service(
            web::resource("/investigations/{id}/nodes/{node}/export")
                .route(protect(web::get().to(ui_export))),
        )
        .service(
            web::resource("/investigations/{id}/nodes/{node}/evidence")
                .route(protect(web::get().to(ui_evidence))),
        )
        .service(
            web::resource("/investigations/{id}/runs/{run}/events")
                .route(protect(web::get().to(events))),
        )
        .service(
            web::resource("/investigations/{id}/runs/{run}/cancel")
                .route(protect(web::post().to(cancel_run))),
        )
        .service(
            web::resource("/providers/credentials")
                .app_data(web::PayloadConfig::new(4096))
                .route(protect(web::put().to(credentials))),
        )
}

async fn capabilities(
    req: HttpRequest,
    state: web::Data<ApiState>,
) -> std::result::Result<HttpResponse, ApiError> {
    let bound = (state.authorize)(&req)?;
    let access = bound.access();
    let storage_ready = state
        .repository
        .as_ref()
        .is_some_and(|repo| repo.health().is_ok());
    let execution_ready = state
        .execution
        .as_ref()
        .is_some_and(|e| e.ready(&access.principal));
    let secrets_ready = state
        .execution
        .as_ref()
        .is_some_and(|e| e.secret_store_ready());
    Ok(
        HttpResponse::Ok().json(json!({"schemaVersion":1,"mode":state.mode,
        "enabledModes":["all","query"],"disabled":!matches!(state.mode,"all"|"query"),
        "storage":if storage_ready {"ready"} else if state.repository.is_some() {"degraded"} else {"unavailable"},
        "investigations":storage_ready,"contextPolicy":CONTEXT_POLICY,
        "execution":if execution_ready{"ready"}else{"unavailable"},"reason":if execution_ready{serde_json::Value::Null}else if secrets_ready{json!("provider_unconfigured")}else{json!("secret_store_unavailable")},
        "generation":if execution_ready{"ready"}else{"unconfigured"},"decisions":"disabled","secretStore":if secrets_ready{"ready"}else{"unavailable"},
        "topology":"single_local_coordinator","sharing":false,"provider":state.execution.as_ref().and_then(|e|e.provider_configuration())})),
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateRequest {
    title: String,
    prompt: String,
    scope: ScopeVersion,
}
fn idempotency(
    req: &HttpRequest,
    payload: &impl serde::Serialize,
) -> std::result::Result<IdempotencyRequest, ApiError> {
    let key = req
        .headers()
        .get("Idempotency-Key")
        .and_then(|v| v.to_str().ok())
        .ok_or(ApiError {
            status: StatusCode::BAD_REQUEST,
            code: "idempotency_key_required",
        })?;
    validate_id(key)?;
    use sha2::{Digest, Sha256};
    Ok(IdempotencyRequest {
        key: key.into(),
        fingerprint: hex::encode(Sha256::digest(
            serde_json::to_vec(payload).map_err(KeystoneError::from)?,
        )),
    })
}
async fn create(
    req: HttpRequest,
    state: web::Data<ApiState>,
    body: web::Json<CreateRequest>,
) -> std::result::Result<HttpResponse, ApiError> {
    let repository = state.repository()?;
    state.prepare_scope(&req, &body.scope).await?;
    let bound = (state.authorize)(&req)?;
    let access = bound.access();
    let mut scope = body.scope.clone();
    scope.approved_by = access.principal.owner_id.clone();
    scope.validate()?;
    if !scope.datasets.iter().all(|s| access.can_read(s)) {
        return Err(KeystoneError::Forbidden.into());
    }
    let idem = idempotency(
        &req,
        &json!({"title":body.title,"prompt":body.prompt,"scope":scope}),
    )?;
    let id = uuid::Uuid::new_v4().to_string();
    let node_id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    let investigation = Investigation {
        id: id.clone(),
        schema_version: 1,
        tenant_id: access.principal.tenant_id.clone(),
        owner_id: access.principal.owner_id.clone(),
        title: body.title.clone(),
        root_node_id: node_id.clone(),
        semantic_revision: 0,
        layout_revision: 0,
        created_at: now.clone(),
        updated_at: now,
        archived: false,
    };
    let node = Node {
        id: node_id,
        investigation_id: id,
        version: 1,
        parent: None,
        branch_intent: None,
        prompt: body.prompt.clone(),
        scope,
        selected_run_id: None,
        context_manifest_id: None,
    };
    let result = repository
        .blocking(move |repository| {
            let access = bound.revalidate()?;
            if !node.scope.datasets.iter().all(|s| access.can_read(s)) {
                return Err(KeystoneError::Forbidden.into());
            }
            let result = repository.create(&access.principal, investigation, node, idem)?;
            // Replayed create responses must still satisfy current dependencies of the saved graph.
            repository.read(&access.principal, &result.id, |dataset| {
                access.can_read(dataset)
            })?;
            Ok::<_, ApiError>(result)
        })
        .await?;
    Ok(HttpResponse::Created().json(json!({"schemaVersion":1,"investigation":result})))
}
async fn read(
    req: HttpRequest,
    state: web::Data<ApiState>,
    path: web::Path<String>,
) -> std::result::Result<HttpResponse, ApiError> {
    state.prepare_existing(&req, Some(&path)).await?;
    let bound = (state.authorize)(&req)?;
    let result = state
        .read(bound, path.into_inner(), |result| {
            Ok(json!({"schemaVersion":1,"snapshot":result}))
        })
        .await?;
    Ok(HttpResponse::Ok().json(result))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ListQuery {
    after: Option<String>,
}
async fn list(
    req: HttpRequest,
    state: web::Data<ApiState>,
    query: web::Query<ListQuery>,
) -> std::result::Result<HttpResponse, ApiError> {
    state.prepare_existing(&req, None).await?;
    let bound = (state.authorize)(&req)?;
    let after = query.into_inner().after;
    let response = state
        .repository()?
        .blocking(move |repository| {
            let access = bound.revalidate()?;
            // Only the caller's own summaries are copied, never a full repository clone.
            let mut authorized = repository
                .owned_summaries(&access.principal)?
                .into_iter()
                .filter(|summary| {
                    summary.datasets.iter().all(|d| access.can_read(d))
                        && after
                            .as_ref()
                            .is_none_or(|after| summary.investigation.id > *after)
                })
                .map(|summary| summary.investigation);
            let investigations: Vec<_> = authorized.by_ref().take(100).collect();
            let next = if authorized.next().is_some() {
                investigations
                    .last()
                    .map(|investigation| investigation.id.clone())
            } else {
                None
            };
            Ok::<_, ApiError>(
                json!({"schemaVersion":1,"investigations":investigations,"next":next}),
            )
        })
        .await?;
    Ok(HttpResponse::Ok().json(response))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LayoutRequest {
    expected_revision: u64,
    nodes: BTreeMap<String, NodeGeometry>,
}
async fn layout(
    req: HttpRequest,
    state: web::Data<ApiState>,
    path: web::Path<String>,
    body: web::Json<LayoutRequest>,
) -> std::result::Result<HttpResponse, ApiError> {
    state.prepare_existing(&req, Some(&path)).await?;
    let bound = (state.authorize)(&req)?;
    let path = path.into_inner();
    let body = body.into_inner();
    let result = state
        .repository()?
        .blocking(move |repository| {
            let access = bound.revalidate()?;
            repository.read(&access.principal, &path, |d| access.can_read(d))?;
            if body.nodes.len() > MAX_NODES {
                return Err(KeystoneError::Invalid("layout limit".into()).into());
            }
            for geometry in body.nodes.values() {
                geometry.validate()?;
            }
            Ok::<_, ApiError>(repository.transact(
                &access.principal,
                &path,
                body.expected_revision,
                RevisionKind::Layout,
                None,
                |state| {
                    if body.nodes.keys().any(|id| {
                        !state
                            .nodes
                            .values()
                            .any(|n| n.id == *id && n.investigation_id == *path)
                    }) {
                        return Err(KeystoneError::Invalid("unknown layout node".into()));
                    }
                    let mut nodes = state
                        .layouts
                        .get(path.as_str())
                        .map(|l| l.nodes.clone())
                        .unwrap_or_default();
                    nodes.extend(body.nodes.clone());
                    let layout = CanvasLayout {
                        investigation_id: path.to_string(),
                        revision: body.expected_revision + 1,
                        nodes,
                    };
                    state.layouts.insert(path.to_string(), layout.clone());
                    Ok(json!({"schemaVersion":1,"layout":layout}))
                },
            )?)
        })
        .await?;
    Ok(HttpResponse::Ok().json(result))
}
async fn start_run(
    req: HttpRequest,
    state: web::Data<ApiState>,
    path: web::Path<String>,
    body: web::Bytes,
) -> std::result::Result<HttpResponse, ApiError> {
    state.prepare_existing(&req, Some(&path)).await?;
    let bound = (state.authorize)(&req)?;
    state
        .read(bound.clone(), (*path).clone(), |_| Ok(()))
        .await?;
    let execution = state
        .execution
        .as_ref()
        .filter(|e| e.ready(&bound.access().principal))
        .ok_or(ApiError {
            status: StatusCode::SERVICE_UNAVAILABLE,
            code: "execution_unavailable",
        })?;
    let key = req
        .headers()
        .get("Idempotency-Key")
        .and_then(|h| h.to_str().ok())
        .ok_or(ApiError {
            status: StatusCode::BAD_REQUEST,
            code: "idempotency_key_required",
        })?;
    validate_id(key)?;
    if body.len() > 4096 {
        return Err(ApiError {
            status: StatusCode::BAD_REQUEST,
            code: "invalid_request",
        });
    }
    let body: RunRequest = serde_json::from_slice(&body).map_err(|_| ApiError {
        status: StatusCode::BAD_REQUEST,
        code: "invalid_request",
    })?;
    // Request-bound authorization happens in `start`; acceptance, the durable commit and
    // dispatch happen in the owned job, which a client disconnect cannot strand midway.
    let run = execution.start(&req, &bound, &path, &body, key)?.await?;
    Ok(HttpResponse::Accepted().json(json!({"schemaVersion":1,"run":run})))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EventCursor {
    #[serde(default)]
    after: u64,
}
async fn events(
    req: HttpRequest,
    state: web::Data<ApiState>,
    path: web::Path<(String, String)>,
    query: web::Query<EventCursor>,
) -> std::result::Result<HttpResponse, ApiError> {
    state.prepare_existing(&req, Some(&path.0)).await?;
    let bound = (state.authorize)(&req)?;
    let (investigation_id, run_id) = path.into_inner();
    let after = query.after;
    let principal = bound.access().principal.clone();
    let lookup = run_id.clone();
    // A terminal body is built in the same revalidated job; it is sent unchanged after.
    let opening = state
        .read(bound, investigation_id.clone(), move |snapshot| {
            let run = snapshot.runs.get(&lookup).ok_or(KeystoneError::NotFound)?;
            let committed = snapshot
                .events
                .get(&run.id)
                .map(Vec::as_slice)
                .unwrap_or(&[]);
            if after > committed.last().map_or(0, |e| e.sequence) {
                return Ok(Opening::CursorAhead);
            }
            if run.status.is_terminal() {
                return Ok(Opening::Terminal(event_body(&snapshot, run, after)?.0));
            }
            Ok(Opening::Live(run.scope.clone()))
        })
        .await?;
    let scope = match opening {
        Opening::CursorAhead => {
            return Err(ApiError {
                status: StatusCode::CONFLICT,
                code: "event_cursor_ahead",
            });
        }
        Opening::Terminal(body) => return Ok(sse_response().body(body)),
        Opening::Live(scope) => scope,
    };
    let permit = state
        .execution
        .as_ref()
        .ok_or(ApiError {
            status: StatusCode::SERVICE_UNAVAILABLE,
            code: "live_events_unavailable",
        })?
        .observe(&req)?;
    let subscription = Subscription {
        repository: state.repository.clone().ok_or(KeystoneError::NotFound)?,
        permit,
        principal,
        investigation_id,
        run_id,
        scope,
        after,
        finished: false,
        expires: tokio::time::Instant::now() + std::time::Duration::from_secs(60),
    };
    let stream = futures_util::stream::unfold(subscription, |mut sub| async move {
        if sub.finished || tokio::time::Instant::now() >= sub.expires {
            return None;
        }
        if !sub.permit.allowed(&sub.scope) {
            sub.finished = true;
            return Some((
                Ok::<_, actix_web::Error>(stream_error("authorization_revoked")),
                sub,
            ));
        }
        // Each poll is one scoped read on the bounded blocking lane; the observer's grant
        // is revalidated against current roles for every dataset inside it.
        let (principal, investigation_id, run_id, scope, permit, after) = (
            sub.principal.clone(),
            sub.investigation_id.clone(),
            sub.run_id.clone(),
            sub.scope.clone(),
            sub.permit.clone(),
            sub.after,
        );
        let output = sub
            .repository
            .blocking(move |repository| -> Result<(String, u64, bool)> {
                let snapshot = repository.read(&principal, &investigation_id, |dataset| {
                    let mut scope = scope.clone();
                    scope.datasets = vec![dataset.into()];
                    permit.allowed(&scope)
                })?;
                let run = snapshot.runs.get(&run_id).ok_or(KeystoneError::NotFound)?;
                let (body, cursor) = event_body(&snapshot, run, after)?;
                Ok((body, cursor, run.status.is_terminal()))
            })
            .await;
        match output {
            Ok((body, cursor, terminal)) => {
                sub.after = cursor;
                sub.finished = terminal;
                if body.is_empty() {
                    tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
                }
                Some((
                    Ok::<_, actix_web::Error>(web::Bytes::from(if body.is_empty() {
                        ": keep-alive\n\n".into()
                    } else {
                        body
                    })),
                    sub,
                ))
            }
            Err(error) => {
                sub.finished = true;
                let code = if matches!(error, KeystoneError::Forbidden | KeystoneError::NotFound) {
                    "authorization_revoked"
                } else {
                    "stream_unavailable"
                };
                Some((Ok::<_, actix_web::Error>(stream_error(code)), sub))
            }
        }
    });
    Ok(sse_response().streaming(stream))
}
enum Opening {
    CursorAhead,
    Terminal(String),
    Live(ScopeVersion),
}
fn stream_error(code: &str) -> web::Bytes {
    web::Bytes::from(format!(
        "event: error\ndata: {}\n\n",
        json!({"schemaVersion":1,"error":{"code":code}})
    ))
}
struct Subscription {
    repository: Arc<NativeRepository>,
    permit: Arc<dyn EventPermit>,
    principal: Principal,
    investigation_id: String,
    run_id: String,
    scope: ScopeVersion,
    after: u64,
    finished: bool,
    expires: tokio::time::Instant,
}
fn sse_response() -> actix_web::HttpResponseBuilder {
    let mut response = HttpResponse::Ok();
    response
        .insert_header(("Content-Type", "text/event-stream"))
        .insert_header(("Cache-Control", "no-store"))
        .insert_header(("X-Accel-Buffering", "no"));
    response
}
fn event_body(
    snapshot: &super::repository::RepositoryState,
    run: &Run,
    after: u64,
) -> Result<(String, u64)> {
    let mut body = String::new();
    let mut cursor = after;
    for event in snapshot
        .events
        .get(&run.id)
        .map(Vec::as_slice)
        .unwrap_or(&[])
        .iter()
        .filter(|e| e.sequence > after)
        .take(128)
    {
        let mut value = serde_json::to_value(event)?;
        if let Some(id) = event
            .payload
            .get("evidenceId")
            .and_then(serde_json::Value::as_str)
        {
            let evidence = snapshot.evidence.get(id).ok_or(KeystoneError::NotFound)?;
            value["payload"]["evidence"] = super::presentation::evidence_item(snapshot, evidence)?;
        }
        if matches!(
            event.kind.as_str(),
            "completed" | "failed" | "cancelled" | "interrupted" | "partial"
        ) {
            value["payload"]["answer"] = json!(run.answer);
        }
        body.push_str(&format!(
            "id: {}\nevent: keystone\ndata: {}\n\n",
            event.sequence,
            serde_json::to_string(&value)?
        ));
        cursor = event.sequence;
    }
    Ok((body, cursor))
}

async fn cancel_run(
    req: HttpRequest,
    state: web::Data<ApiState>,
    path: web::Path<(String, String)>,
) -> std::result::Result<HttpResponse, ApiError> {
    let bound = (state.authorize)(&req)?;
    let (investigation_id, run_id) = path.into_inner();
    let run = state
        .read(bound.clone(), investigation_id.clone(), move |snapshot| {
            snapshot
                .runs
                .get(&run_id)
                .cloned()
                .ok_or(KeystoneError::NotFound)
        })
        .await?;
    if !run.status.is_terminal() {
        let execution = state.execution.as_ref().ok_or(ApiError {
            status: StatusCode::SERVICE_UNAVAILABLE,
            code: "execution_unavailable",
        })?;
        // The cancel job queues again, so it revalidates again before committing.
        let run = execution.cancel(&bound, &investigation_id, &run.id).await?;
        return Ok(HttpResponse::Ok().json(json!({"schemaVersion":1,"run":run})));
    }
    Ok(HttpResponse::Ok().json(json!({"schemaVersion":1,"run":run})))
}

#[derive(Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BranchRequest {
    parent_node_id: String,
    parent_version: u64,
    prompt: String,
    context_policy: String,
    expected_revision: u64,
    #[serde(default)]
    parent_export_sha256: Option<String>,
    #[serde(default)]
    intent: Option<String>,
    requested_scope: Option<ScopeVersion>,
    #[serde(default)]
    scope_change_reviewed: bool,
    #[serde(default)]
    exported_evidence_ids: Vec<String>,
}
async fn branch(
    req: HttpRequest,
    state: web::Data<ApiState>,
    path: web::Path<String>,
    body: web::Json<BranchRequest>,
) -> std::result::Result<HttpResponse, ApiError> {
    state.prepare_existing(&req, Some(&path)).await?;
    if let Some(scope) = &body.requested_scope {
        state.prepare_scope(&req, scope).await?;
    }
    let bound = (state.authorize)(&req)?;
    // Header-derived; its error keeps its original precedence inside the job.
    let idem = idempotency(&req, &*body);
    let path = path.into_inner();
    let body = body.into_inner();
    let result = state
        .repository()?
        .blocking(move |repo| branch_commit(repo, &bound.revalidate()?, &path, &body, idem))
        .await?;
    Ok(HttpResponse::Created().json(result))
}
fn branch_commit(
    repo: &NativeRepository,
    access: &Access,
    path: &str,
    body: &BranchRequest,
    idem: std::result::Result<IdempotencyRequest, ApiError>,
) -> std::result::Result<serde_json::Value, ApiError> {
    let snapshot = repo.read(&access.principal, path, |d| access.can_read(d))?;
    if body.context_policy != CONTEXT_POLICY {
        return Err(KeystoneError::Invalid("context policy".into()).into());
    }
    let idem = idem?;
    let parent = snapshot
        .nodes
        .values()
        .find(|n| n.id == body.parent_node_id && n.version == body.parent_version)
        .ok_or(KeystoneError::NotFound)?;
    let export = snapshot
        .exports
        .values()
        .find(|e| {
            e.node_id == parent.id
                && e.node_version == parent.version
                && Some(&e.run_id) == parent.selected_run_id.as_ref()
        })
        .ok_or(ApiError {
            status: StatusCode::CONFLICT,
            code: "completed_parent_required",
        })?;
    if body.parent_export_sha256.as_ref().is_some_and(|hash| {
        serde_json::to_vec(export).map_or(true, |bytes| super::context::hash_bytes(&bytes) != *hash)
    }) {
        return Err(KeystoneError::Conflict.into());
    }
    let mut scope = body
        .requested_scope
        .clone()
        .unwrap_or_else(|| parent.scope.clone());
    scope.approved_by = access.principal.owner_id.clone();
    let mut node = Node {
        id: uuid::Uuid::new_v4().to_string(),
        investigation_id: path.to_string(),
        version: 1,
        parent: Some(ParentReference {
            node_id: parent.id.clone(),
            version: parent.version,
        }),
        branch_intent: body.intent.clone(),
        prompt: body.prompt.clone(),
        scope,
        selected_run_id: None,
        context_manifest_id: None,
    };
    let evidence = body
        .exported_evidence_ids
        .iter()
        .map(|id| {
            snapshot
                .evidence
                .get(id)
                .cloned()
                .ok_or(KeystoneError::NotFound)
        })
        .collect::<Result<Vec<_>>>()?;
    let investigation = snapshot
        .investigations
        .get(path)
        .ok_or(KeystoneError::NotFound)?;
    let context = super::context::build_context_authorized(
        &access.principal,
        investigation,
        &node,
        Some(export),
        &evidence,
        body.scope_change_reviewed,
        // Repository read already checked every referenced artifact's ownership, expiry and datasets.
        |e| snapshot.artifacts.contains_key(&e.artifact_id),
        |d| access.can_read(d),
    )?;
    node.context_manifest_id = Some(context.manifest.id.clone());
    Ok(repo.transact(
        &access.principal,
        path,
        body.expected_revision,
        RevisionKind::Semantic,
        Some(idem),
        |snapshot| {
            snapshot.nodes.insert(node.version_key(), node.clone());
            snapshot
                .contexts
                .insert(context.manifest.id.clone(), context.clone());
            Ok(json!({"schemaVersion":1,"node":node,"context":context}))
        },
    )?)
}
async fn credentials(
    req: HttpRequest,
    state: web::Data<ApiState>,
    body: web::Bytes,
) -> std::result::Result<HttpResponse, ApiError> {
    // No repository job: the save's own permit is rechecked before and after its write.
    let bound = (state.authorize)(&req)?;
    let access = bound.access();
    if !access.manage_providers {
        return Err(ApiError {
            status: StatusCode::FORBIDDEN,
            code: "admin_required",
        });
    }
    let execution = state
        .execution
        .as_ref()
        .filter(|e| e.secret_store_ready())
        .ok_or(ApiError {
            status: StatusCode::SERVICE_UNAVAILABLE,
            code: "secret_store_unavailable",
        })?;
    // A bounded raw octet body avoids accidental credential echo by JSON validation.
    let secret =
        super::providers::secrets::ProviderSecret::new(body.to_vec()).map_err(|_| ApiError {
            status: StatusCode::BAD_REQUEST,
            code: "invalid_credential",
        })?;
    let permit = execution.credential_authority(&req)?;
    execution
        .credential(&access.principal, secret, permit)
        .await?;
    Ok(HttpResponse::NoContent().finish())
}

async fn ui_capabilities(
    req: HttpRequest,
    state: web::Data<ApiState>,
) -> std::result::Result<HttpResponse, ApiError> {
    let bound = (state.authorize)(&req)?;
    let access = bound.access();
    let ready = matches!(state.mode, "all" | "query")
        && state
            .repository
            .as_ref()
            .is_some_and(|r| r.health().is_ok());
    let execution = ready
        && state
            .execution
            .as_ref()
            .is_some_and(|e| e.ready(&access.principal));
    Ok(HttpResponse::Ok().json(json!({"schemaVersion":1,
        "generative":{"state":if execution{"ready"}else{"unconfigured"},"reason":if execution{serde_json::Value::Null}else{json!("provider_unconfigured")}},
        "tools":{"state":if execution{"ready"}else{"unavailable"},"reason":if execution{serde_json::Value::Null}else{json!("tools_unavailable")}},
        "actions":{"read":ready,"run":ready,"branch":ready,"editLayout":ready,"manageProviders":access.manage_providers}})))
}
async fn ui_graph(
    req: HttpRequest,
    state: web::Data<ApiState>,
    path: web::Path<String>,
) -> std::result::Result<HttpResponse, ApiError> {
    state.prepare_existing(&req, Some(&path)).await?;
    let bound = (state.authorize)(&req)?;
    let id = path.into_inner();
    let graph = state
        .read(bound, id.clone(), move |snapshot| {
            super::presentation::graph(&snapshot, &id)
        })
        .await?;
    Ok(HttpResponse::Ok().json(graph))
}
async fn ui_layout(
    req: HttpRequest,
    state: web::Data<ApiState>,
    path: web::Path<String>,
) -> std::result::Result<HttpResponse, ApiError> {
    state.prepare_existing(&req, Some(&path)).await?;
    let bound = (state.authorize)(&req)?;
    let id = path.into_inner();
    let layout = state
        .read(bound, id.clone(), move |snapshot| {
            super::presentation::layout(&snapshot, &id)
        })
        .await?;
    Ok(HttpResponse::Ok().json(layout))
}
async fn ui_export(
    req: HttpRequest,
    state: web::Data<ApiState>,
    path: web::Path<(String, String)>,
) -> std::result::Result<HttpResponse, ApiError> {
    state.prepare_existing(&req, Some(&path.0)).await?;
    let bound = (state.authorize)(&req)?;
    let (id, node) = path.into_inner();
    let export = state
        .read(bound, id, move |snapshot| {
            super::presentation::parent_export(&snapshot, &node)
        })
        .await?;
    Ok(HttpResponse::Ok().json(export))
}
async fn ui_evidence(
    req: HttpRequest,
    state: web::Data<ApiState>,
    path: web::Path<(String, String)>,
) -> std::result::Result<HttpResponse, ApiError> {
    state.prepare_existing(&req, Some(&path.0)).await?;
    let bound = (state.authorize)(&req)?;
    let (id, node) = path.into_inner();
    let evidence = state
        .read(bound, id, move |snapshot| {
            super::presentation::evidence(&snapshot, &node)
        })
        .await?;
    Ok(HttpResponse::Ok().json(evidence))
}

#[cfg(test)]
mod tests {
    use super::*;
    use actix_web::{App, test};
    fn access(req: &HttpRequest) -> std::result::Result<BoundAccess, ApiError> {
        resolve(req).map(BoundAccess::unchanged)
    }
    fn resolve(req: &HttpRequest) -> std::result::Result<Access, ApiError> {
        // This test-only authentication adapter simulates principals supplied by middleware.
        let tenant = req
            .headers()
            .get("test-tenant")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("tenant1");
        let owner = req
            .headers()
            .get("test-owner")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("owner1");
        Ok(Access {
            principal: Principal {
                tenant_id: tenant.into(),
                owner_id: owner.into(),
            },
            datasets: if req.headers().contains_key("test-revoked") {
                BTreeSet::new()
            } else {
                BTreeSet::from(["logs".into()])
            },
            all_datasets: false,
            manage_providers: true,
        })
    }
    #[actix_web::test]
    async fn revalidation_never_widens_issued_access_and_refuses_another_identity() {
        let mut issued = resolve(&test::TestRequest::default().to_http_request()).unwrap();
        issued.manage_providers = false;
        let current = Arc::new(std::sync::Mutex::new(Some(issued.clone())));
        let source = current.clone();
        let bound = BoundAccess::new(
            issued.clone(),
            Arc::new(move || {
                source
                    .lock()
                    .unwrap()
                    .clone()
                    .ok_or_else(authentication_required)
            }),
        );
        assert!(bound.revalidate().unwrap().can_read("logs"));
        // A later promotion to every dataset and administration is not inherited.
        {
            let mut promoted = current.lock().unwrap();
            let promoted = promoted.as_mut().unwrap();
            promoted.all_datasets = true;
            promoted.datasets.insert("metrics".into());
            promoted.manage_providers = true;
        }
        let ceiling = bound.revalidate().unwrap();
        assert!(ceiling.can_read("logs") && !ceiling.can_read("metrics"));
        assert!(!ceiling.all_datasets && !ceiling.manage_providers);
        // A later narrowing is.
        current.lock().unwrap().as_mut().unwrap().all_datasets = false;
        current.lock().unwrap().as_mut().unwrap().datasets = BTreeSet::new();
        assert!(!bound.revalidate().unwrap().can_read("logs"));
        // Another identity, or none, is refused before any lookup.
        let mut other = issued.clone();
        other.principal.tenant_id = "other".into();
        *current.lock().unwrap() = Some(other);
        assert_eq!(
            bound.revalidate().err().map(|e| (e.status, e.code)),
            Some((StatusCode::UNAUTHORIZED, "authentication_required"))
        );
        *current.lock().unwrap() = None;
        assert_eq!(
            bound.revalidate().err().map(|e| e.status),
            Some(StatusCode::UNAUTHORIZED)
        );
    }
    #[actix_web::test]
    async fn storage_failures_are_unavailable_and_capacity_is_not_a_bad_request() {
        let unavailable = ApiError::from(KeystoneError::Unavailable("private detail".into()));
        assert_eq!(unavailable.status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(unavailable.code, "storage_unavailable");
        let quota = ApiError::from(KeystoneError::QuotaExceeded("owner limit".into()));
        assert_eq!(quota.status, StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(quota.code, "storage_quota_exceeded");
    }
    fn create_body() -> serde_json::Value {
        let (_, _, node) = super::super::context::tests::fixture();
        json!({"title":"Incident","prompt":"Explain the spike","scope":node.scope})
    }

    #[actix_web::test]
    async fn branch_pins_completed_parent_and_terminal_events_replay_without_execution() {
        use super::super::context::{
            build_context,
            tests::{fixture, run},
        };
        let directory = tempfile::tempdir().unwrap();
        let repository = Arc::new(NativeRepository::open(directory.path()).unwrap());
        let (principal, investigation, node) = fixture();
        repository
            .create(
                &principal,
                investigation.clone(),
                node.clone(),
                IdempotencyRequest {
                    key: "seed".into(),
                    fingerprint: "seed".into(),
                },
            )
            .unwrap();
        let context = build_context(&principal, &investigation, &node, None, &[], false, |_| {
            true
        })
        .unwrap();
        let mut completed = run(
            &node,
            "runP",
            RunStatus::Completed,
            "Completed fixture answer",
        );
        completed.context_manifest_id = context.manifest.id.clone();
        completed.context_hash = context.hash.clone();
        let export =
            ParentExport::from_completed(&investigation, &node, &completed, vec![]).unwrap();
        repository
            .transact(
                &principal,
                &investigation.id,
                0,
                RevisionKind::Semantic,
                None,
                |state| {
                    state.contexts.insert(context.manifest.id.clone(), context);
                    state.runs.insert(completed.id.clone(), completed.clone());
                    state.exports.insert(node.version_key(), export);
                    state
                        .nodes
                        .get_mut(&node.version_key())
                        .unwrap()
                        .selected_run_id = Some(completed.id.clone());
                    state.events.insert(
                        completed.id.clone(),
                        vec![Event {
                            run_id: completed.id.clone(),
                            node_id: node.id.clone(),
                            sequence: 1,
                            timestamp: completed.updated_at.clone(),
                            schema_version: 1,
                            kind: "completed".into(),
                            payload: json!({"reason":"fixture"}),
                        }],
                    );
                    Ok(json!({}))
                },
            )
            .unwrap();
        let app = test::init_service(App::new().service(scope(
            web::Data::new(ApiState {
                scope_preparer: None,
                execution: None,
                repository: Some(repository.clone()),
                authorize: access,
                mode: "all",
            }),
            |route| route,
        )))
        .await;
        let body = json!({"parentNodeId":"P","parentVersion":1,"prompt":"Follow up","contextPolicy":"direct_parent_v1","expectedRevision":1});
        let request = || {
            test::TestRequest::post()
                .uri("/keystone/native/investigations/inv1/nodes")
                .insert_header(("Idempotency-Key", "branch1"))
                .set_json(&body)
                .to_request()
        };
        let created: serde_json::Value = test::call_and_read_body_json(&app, request()).await;
        assert_eq!(
            created["context"]["manifest"]["parentExport"]["answer"],
            "Completed fixture answer"
        );
        assert_eq!(
            created["node"]["scope"]["absoluteStart"],
            node.scope.absolute_start
        );
        assert_eq!(
            created["node"]["scope"]["absoluteEnd"],
            node.scope.absolute_end
        );
        assert_eq!(
            created["node"]["contextManifestId"],
            created["context"]["manifest"]["id"]
        );
        let duplicate: serde_json::Value = test::call_and_read_body_json(&app, request()).await;
        assert_eq!(created, duplicate);
        assert_eq!(repository.snapshot().unwrap().runs.len(), 1);
        let events = "/keystone/native/investigations/inv1/runs/runP/events";
        let response =
            test::call_service(&app, test::TestRequest::get().uri(events).to_request()).await;
        assert_eq!(
            response.headers().get("content-type").unwrap(),
            "text/event-stream"
        );
        let body = test::read_body(response).await;
        assert!(String::from_utf8_lossy(&body).starts_with("id: 1\nevent: keystone\ndata: "));
        let after = test::call_and_read_body(
            &app,
            test::TestRequest::get()
                .uri(&format!("{events}?after=1"))
                .to_request(),
        )
        .await;
        assert!(after.is_empty());
        let other = test::call_service(
            &app,
            test::TestRequest::get()
                .uri(events)
                .insert_header(("test-tenant", "other"))
                .to_request(),
        )
        .await;
        assert_eq!(other.status(), StatusCode::NOT_FOUND);
        let cancelled: serde_json::Value = test::call_and_read_body_json(
            &app,
            test::TestRequest::post()
                .uri("/keystone/native/investigations/inv1/runs/runP/cancel")
                .to_request(),
        )
        .await;
        assert_eq!(cancelled["run"]["status"], "completed");
    }
    #[actix_web::test]
    async fn private_create_duplicate_reopen_layout_and_gated_run() {
        let directory = tempfile::tempdir().unwrap();
        let repository = Arc::new(NativeRepository::open(directory.path()).unwrap());
        let state = web::Data::new(ApiState {
            scope_preparer: None,
            execution: None,
            repository: Some(repository.clone()),
            authorize: access,
            mode: "all",
        });
        let app = test::init_service(App::new().service(scope(state, |route| route))).await;
        let request = || {
            test::TestRequest::post()
                .uri("/keystone/native/investigations")
                .insert_header(("Idempotency-Key", "create-1"))
                .set_json(create_body())
                .to_request()
        };
        let first: serde_json::Value = test::call_and_read_body_json(&app, request()).await;
        let duplicate: serde_json::Value = test::call_and_read_body_json(&app, request()).await;
        assert_eq!(first, duplicate);
        let id = first["investigation"]["id"].as_str().unwrap();
        let root = first["investigation"]["rootNodeId"].as_str().unwrap();
        let uri = format!("/keystone/native/investigations/{id}");
        let snapshot: serde_json::Value =
            test::call_and_read_body_json(&app, test::TestRequest::get().uri(&uri).to_request())
                .await;
        assert_eq!(snapshot["snapshot"]["runs"], json!({}));
        let response = test::call_service(
            &app,
            test::TestRequest::post()
                .uri(&format!("{uri}/runs"))
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert!(repository.snapshot().unwrap().runs.is_empty());
        let body = json!({"expectedRevision":0,"nodes":{root:{"x":30,"y":50,"width":320,"height":240,"pinned":false}}});
        let response = test::call_service(
            &app,
            test::TestRequest::put()
                .uri(&format!("{uri}/layout"))
                .set_json(&body)
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let saved = repository.snapshot().unwrap();
        assert_eq!(saved.investigations[id].semantic_revision, 0);
        assert_eq!(saved.investigations[id].layout_revision, 1);
        let stale = test::call_service(
            &app,
            test::TestRequest::put()
                .uri(&format!("{uri}/layout"))
                .set_json(&body)
                .to_request(),
        )
        .await;
        assert_eq!(stale.status(), StatusCode::CONFLICT);
    }
    #[actix_web::test]
    async fn other_tenant_owner_revocation_and_unknown_json_fail_closed() {
        let directory = tempfile::tempdir().unwrap();
        let repository = Arc::new(NativeRepository::open(directory.path()).unwrap());
        let app = test::init_service(App::new().service(scope(
            web::Data::new(ApiState {
                scope_preparer: None,
                execution: None,
                repository: Some(repository),
                authorize: access,
                mode: "query",
            }),
            |route| route,
        )))
        .await;
        let first: serde_json::Value = test::call_and_read_body_json(
            &app,
            test::TestRequest::post()
                .uri("/keystone/native/investigations")
                .insert_header(("Idempotency-Key", "create-1"))
                .set_json(create_body())
                .to_request(),
        )
        .await;
        let uri = format!(
            "/keystone/native/investigations/{}",
            first["investigation"]["id"].as_str().unwrap()
        );
        for (header, value) in [
            ("test-tenant", "other"),
            ("test-owner", "other"),
            ("test-revoked", "true"),
        ] {
            let response = test::call_service(
                &app,
                test::TestRequest::get()
                    .uri(&uri)
                    .insert_header((header, value))
                    .to_request(),
            )
            .await;
            assert_eq!(response.status(), StatusCode::NOT_FOUND);
            let listing: serde_json::Value = test::call_and_read_body_json(
                &app,
                test::TestRequest::get()
                    .uri("/keystone/native/investigations")
                    .insert_header((header, value))
                    .to_request(),
            )
            .await;
            assert_eq!(listing["investigations"], json!([]));
        }
        let mut body = create_body();
        body["tenantId"] = json!("forged");
        let response = test::call_service(
            &app,
            test::TestRequest::post()
                .uri("/keystone/native/investigations")
                .insert_header(("Idempotency-Key", "create-2"))
                .set_json(body)
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert!(
            response
                .headers()
                .get("content-type")
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with("application/json")
        );
    }
    #[actix_web::test]
    async fn capabilities_and_secret_storage_report_unavailable_as_json() {
        for mode in ["all", "query"] {
            let app = test::init_service(App::new().service(scope(
                web::Data::new(ApiState {
                    scope_preparer: None,
                    execution: None,
                    repository: None,
                    authorize: access,
                    mode,
                }),
                |route| route,
            )))
            .await;
            let value: serde_json::Value = test::call_and_read_body_json(
                &app,
                test::TestRequest::get()
                    .uri("/keystone/native/capabilities")
                    .to_request(),
            )
            .await;
            assert_eq!(value["mode"], mode);
            assert_eq!(value["storage"], "unavailable");
            assert_eq!(value["execution"], "unavailable");
            let response = test::call_service(
                &app,
                test::TestRequest::put()
                    .uri("/keystone/native/providers/credentials")
                    .set_payload("SECRET_SENTINEL")
                    .to_request(),
            )
            .await;
            assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
            let body = test::read_body(response).await;
            assert!(!String::from_utf8_lossy(&body).contains("SECRET_SENTINEL"));
        }
    }
}

#[cfg(test)]
#[path = "api_live_tests.rs"]
mod live_tests;
