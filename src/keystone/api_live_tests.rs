//! Real Actix routes, coordinator and filesystem commits with explicitly synthetic
//! authentication, telemetry and model boundaries. No provider network calls.
use super::*;
use crate::keystone::{
    coordinator::{Coordinator, StartRun},
    providers::{FixtureModelProvider, ModelProposal},
    tools::{GrantAuthorizer, ReadExecutor, ReadOperation, RunGrant, ToolError},
};
use actix_web::{App, test};
use async_trait::async_trait;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio_util::sync::CancellationToken;
struct Authority(Arc<AtomicBool>);
impl GrantAuthorizer for Authority {
    fn authorize(&self, _: &RunGrant, _: &ScopeVersion) -> std::result::Result<(), ToolError> {
        if self.0.load(Ordering::SeqCst) {
            Ok(())
        } else {
            Err(ToolError::Unauthorized)
        }
    }
}
impl EventPermit for Authority {
    fn allowed(&self, _: &ScopeVersion) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}
struct Rows;
#[async_trait]
impl ReadExecutor for Rows {
    async fn execute(
        &self,
        _: &RunGrant,
        scope: &ScopeVersion,
        operation: &ReadOperation,
        _: CancellationToken,
    ) -> std::result::Result<serde_json::Value, ToolError> {
        let ReadOperation::Sample { dataset, .. } = operation else {
            return Err(ToolError::Scope);
        };
        Ok(
            json!({"dataset":dataset,"start":scope.absolute_start,"end":scope.absolute_end,"rowCount":1,"rows":[{"message":"synthetic scoped row","nested":{"safe":true}}]}),
        )
    }
}
struct Execution {
    repo: Arc<NativeRepository>,
    coordinator: Arc<Coordinator>,
    allowed: Arc<AtomicBool>,
}
#[async_trait]
impl ExecutionService for Execution {
    fn ready(&self, _: &Principal) -> bool {
        true
    }
    fn secret_store_ready(&self) -> bool {
        false
    }
    fn observe(&self, _: &HttpRequest) -> std::result::Result<Arc<dyn EventPermit>, ApiError> {
        Ok(Arc::new(Authority(self.allowed.clone())))
    }
    fn start(
        &self,
        _: &HttpRequest,
        access: &BoundAccess,
        id: &str,
        body: &RunRequest,
        key: &str,
    ) -> std::result::Result<StartJob, ApiError> {
        let (repo, coordinator) = (self.repo.clone(), self.coordinator.clone());
        let (bound, id, body, key) = (access.clone(), id.to_owned(), body.clone(), key.to_owned());
        Ok(Box::pin(async move {
            let principal = bound.access().principal.clone();
            let engine = coordinator.clone();
            let (run, dispatch) = repo
                .blocking(move |repo| {
                    let access = bound.revalidate()?;
                    let snapshot = repo.read(&access.principal, &id, |d| access.can_read(d))?;
                    let node = snapshot.node(&body.node_id, body.node_version)?;
                    let evidence = node
                        .context_manifest_id
                        .as_ref()
                        .and_then(|id| snapshot.contexts.get(id))
                        .map(|c| c.manifest.evidence.iter().map(|e| e.id.clone()).collect())
                        .unwrap_or_default();
                    let grant = RunGrant {
                        principal: access.principal.clone(),
                        credential_id: uuid::Uuid::new_v4().to_string(),
                        expires_at: chrono::Utc::now().timestamp() + 120,
                    };
                    let run = coordinator.begin(&StartRun {
                        principal: access.principal.clone(),
                        grant: grant.clone(),
                        authorization_revision: "test-current".into(),
                        investigation_id: id,
                        node_id: body.node_id.clone(),
                        node_version: body.node_version,
                        expected_revision: body.expected_revision,
                        idempotency_key: key,
                        selected_evidence_ids: evidence,
                        scope_change_reviewed: false,
                        provider_config_revision: 1,
                    })?;
                    let dispatch = coordinator.run_uses_grant(&run.id, &grant.credential_id);
                    Ok::<_, ApiError>((run, dispatch))
                })
                .await?;
            // Fixture only: the production service dispatches inside the blocking job.
            if dispatch {
                let id = run.id.clone();
                actix_web::rt::spawn(async move {
                    engine.execute(&principal, &id).await.unwrap();
                });
            }
            Ok(run)
        }))
    }
    async fn cancel(
        &self,
        access: &BoundAccess,
        _: &str,
        run: &str,
    ) -> std::result::Result<Run, ApiError> {
        Ok(self
            .coordinator
            .cancel(&access.revalidate()?.principal, run)?)
    }
    async fn credential(
        &self,
        _: &Principal,
        _: super::super::providers::secrets::ProviderSecret,
        _: Arc<dyn EventPermit>,
    ) -> std::result::Result<(), ApiError> {
        Err(ApiError {
            status: StatusCode::SERVICE_UNAVAILABLE,
            code: "fixture_has_no_secrets",
        })
    }
}
fn owner1() -> Access {
    Access {
        principal: Principal {
            tenant_id: "tenant1".into(),
            owner_id: "owner1".into(),
        },
        datasets: BTreeSet::from(["logs".into()]),
        all_datasets: false,
        manage_providers: false,
    }
}
fn access(_: &HttpRequest) -> std::result::Result<BoundAccess, ApiError> {
    Ok(BoundAccess::unchanged(owner1()))
}

/// Diagnostic model: `[diagnostic:hold]` in the frozen context delays the answer long
/// enough to exercise real native cancellation. Dropping the future stops the wait.
struct BrowserDiagnosticModel;
#[async_trait]
impl crate::keystone::providers::ModelProvider for BrowserDiagnosticModel {
    async fn propose(
        &self,
        context: &crate::keystone::providers::FrozenProviderContext,
    ) -> std::result::Result<ModelProposal, crate::keystone::providers::ProviderError> {
        let delay = if context
            .serialized()
            .to_ascii_lowercase()
            .contains("[diagnostic:hold]")
        {
            90
        } else {
            2
        };
        tokio::time::sleep(std::time::Duration::from_secs(delay)).await;
        Ok(ModelProposal {
            explanation: "Synthetic diagnostic answer from a real native run; no provider call."
                .into(),
        })
    }
}

/// Opt-in socket harness, deliberately excluded from ordinary library tests.
/// Real native routes, projections, SSE, coordinator and durable repository;
/// synthetic fixed owner/grants, dataset metadata, rows and model. No production
/// runtime, login middleware, query engine, credentials or provider transport.
/// `frontend/npm run test:keystone-native` owns the frontend, socket and lifecycle.
#[actix_web::test]
#[ignore = "isolated browser diagnostic; launched by npm run test:keystone-native"]
async fn native_browser_diagnostic_server() {
    let port: u16 = std::env::var("KEYSTONE_DIAGNOSTIC_PORT")
        .unwrap_or_else(|_| "0".into())
        .parse()
        .expect("diagnostic port must be a u16");
    let lifetime: u64 = std::env::var("KEYSTONE_DIAGNOSTIC_SECONDS")
        .unwrap_or_else(|_| "600".into())
        .parse()
        .expect("diagnostic lifetime must be seconds");
    assert!((1..=1800).contains(&lifetime));
    let temporary = tempfile::Builder::new()
        .prefix("keystone-native-browser-")
        .tempdir()
        .unwrap();
    let directory = std::env::var_os("KEYSTONE_DIAGNOSTIC_DIRECTORY")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| temporary.path().to_owned());
    std::fs::create_dir_all(&directory).unwrap();
    let repo = Arc::new(NativeRepository::open(&directory).unwrap());
    let allowed = Arc::new(AtomicBool::new(true));
    let coordinator = Arc::new(Coordinator::new_with_reads(
        repo.clone(),
        Arc::new(BrowserDiagnosticModel),
        Arc::new(Authority(allowed.clone())),
        Arc::new(Rows),
    ));
    let execution: Arc<dyn ExecutionService> = Arc::new(Execution {
        repo: repo.clone(),
        coordinator,
        allowed,
    });
    let identity = std::env::var("KEYSTONE_DIAGNOSTIC_ID")
        .expect("launcher must supply a unique fixture identity");
    let response_identity = identity.clone();
    let server = actix_web::HttpServer::new(move || {
        App::new()
            .wrap(
                actix_web::middleware::DefaultHeaders::new()
                    .add(("x-keystone-native-fixture", response_identity.clone())),
            )
            .service(web::scope("/api/prism/v1").service(scope(
                web::Data::new(ApiState {
                    scope_preparer: None,
                    repository: Some(repo.clone()),
                    authorize: access,
                    mode: "all",
                    execution: Some(execution.clone()),
                }),
                |route| route,
            )))
            .route(
                "/api/v1/logstream",
                web::get().to(|| async { HttpResponse::Ok().json(json!([{"name":"logs"}])) }),
            )
            .route(
                "/api/v1/logstream/logs/info",
                web::get().to(|| async {
                    HttpResponse::Ok()
                        .json(json!({"streamType":"UserDefined","telemetryType":"logs"}))
                }),
            )
            .route(
                "/api/v1/users/{id}",
                web::get().to(|| async {
                    HttpResponse::Ok()
                        .json(json!({"id":"owner1","username":"synthetic-native-diagnostic"}))
                }),
            )
    })
    .workers(1)
    .bind(("127.0.0.1", port))
    .expect("diagnostic loopback socket must bind");
    let address = server.addrs()[0];
    let server = server.run();
    let handle = server.handle();
    let task = actix_web::rt::spawn(server);
    if let Some(path) = std::env::var_os("KEYSTONE_DIAGNOSTIC_READY_FILE") {
        let path = std::path::PathBuf::from(path);
        let pending = path.with_extension("tmp");
        std::fs::write(
            &pending,
            json!({"url":format!("http://{address}"),"identity":identity}).to_string(),
        )
        .unwrap();
        std::fs::rename(pending, path).unwrap();
    }
    eprintln!("Synthetic native browser diagnostic listening on {address}; expires in {lifetime}s");
    tokio::time::sleep(std::time::Duration::from_secs(lifetime)).await;
    handle.stop(true).await;
    task.await.unwrap().unwrap();
}

#[actix_web::test]
async fn real_routes_run_replay_branch_projection_layout_and_restart() {
    let directory = tempfile::tempdir().unwrap();
    let repo = Arc::new(NativeRepository::open(directory.path()).unwrap());
    let allowed = Arc::new(AtomicBool::new(true));
    let engine = Arc::new(Coordinator::new_with_reads(
        repo.clone(),
        Arc::new(FixtureModelProvider {
            proposal: ModelProposal {
                explanation: "Synthetic bounded answer".into(),
            },
        }),
        Arc::new(Authority(allowed.clone())),
        Arc::new(Rows),
    ));
    let execution = Arc::new(Execution {
        repo: repo.clone(),
        coordinator: engine,
        allowed,
    });
    let app = test::init_service(App::new().service(scope(
        web::Data::new(ApiState {
            scope_preparer: None,
            repository: Some(repo.clone()),
            authorize: access,
            mode: "all",
            execution: Some(execution),
        }),
        |route| route,
    )))
    .await;
    let (_, _, node) = crate::keystone::context::tests::fixture();
    let created:serde_json::Value=test::call_and_read_body_json(&app,test::TestRequest::post().uri("/keystone/native/investigations").insert_header(("Idempotency-Key","create-live")).set_json(json!({"title":"Live route fixture","prompt":"Explain scoped sample","scope":node.scope})).to_request()).await;
    let id = created["investigation"]["id"].as_str().unwrap();
    let base = format!("/keystone/native/investigations/{id}");
    let graph: serde_json::Value = test::call_and_read_body_json(
        &app,
        test::TestRequest::get()
            .uri(&format!("{base}/graph"))
            .to_request(),
    )
    .await;
    assert_eq!(graph["nodes"][0]["status"], "draft");
    let root = graph["rootNodeId"].as_str().unwrap();
    let start = || {
        test::TestRequest::post()
            .uri(&format!("{base}/runs"))
            .insert_header(("Idempotency-Key", "run-live"))
            .set_json(
                json!({"nodeId":root,"nodeVersion":1,"expectedRevision":graph["semanticRevision"]}),
            )
            .to_request()
    };
    let accepted: serde_json::Value = test::call_and_read_body_json(&app, start()).await;
    let run = accepted["run"]["id"].as_str().unwrap();
    let replay: serde_json::Value = test::call_and_read_body_json(&app, start()).await;
    assert_eq!(accepted["run"]["id"], replay["run"]["id"]);
    let stream = test::call_and_read_body(
        &app,
        test::TestRequest::get()
            .uri(&format!("{base}/runs/{run}/events?after=0"))
            .to_request(),
    )
    .await;
    let stream = String::from_utf8(stream.to_vec()).unwrap();
    assert!(stream.contains("Synthetic bounded answer"));
    assert!(stream.contains("scoped sample"));
    assert!(stream.contains("synthetic scoped row"));
    assert_eq!(repo.snapshot().unwrap().runs.len(), 1);
    let graph: serde_json::Value = test::call_and_read_body_json(
        &app,
        test::TestRequest::get()
            .uri(&format!("{base}/graph"))
            .to_request(),
    )
    .await;
    assert_eq!(graph["nodes"][0]["status"], "completed");
    assert!(
        graph["nodes"][0]["createdAt"]
            .as_str()
            .unwrap()
            .ends_with('Z')
    );
    let export: serde_json::Value = test::call_and_read_body_json(
        &app,
        test::TestRequest::get()
            .uri(&format!("{base}/nodes/{root}/export"))
            .to_request(),
    )
    .await;
    assert_eq!(
        export["evidence"][0]["rows"][0].as_array().unwrap().len(),
        2
    );
    assert_eq!(export["scope"]["start"], node.scope.absolute_start);
    assert_eq!(export["scope"]["end"], node.scope.absolute_end);
    let branch:serde_json::Value=test::call_and_read_body_json(&app,test::TestRequest::post().uri(&format!("{base}/nodes")).insert_header(("Idempotency-Key","branch-live")).set_json(json!({"parentNodeId":root,"parentVersion":1,"parentExportSha256":export["exportHash"],"contextPolicy":CONTEXT_POLICY,"intent":"explore","prompt":"Another angle","expectedRevision":graph["semanticRevision"],"requestedScope":null,"scopeChangeReviewed":false,"exportedEvidenceIds":[]})).to_request()).await;
    assert_eq!(branch["context"]["manifest"]["evidence"], json!([]));
    assert_eq!(
        branch["node"]["scope"]["absoluteStart"],
        node.scope.absolute_start
    );
    let layout:serde_json::Value=test::call_and_read_body_json(&app,test::TestRequest::put().uri(&format!("{base}/layout")).set_json(json!({"expectedRevision":0,"nodes":{root:{"x":20,"y":40,"width":320,"height":200,"pinned":false,"collapsed":true}}})).to_request()).await;
    assert_eq!(layout["layout"]["nodes"][root]["collapsed"], true);
    let id = id.to_owned();
    let root = root.to_owned();
    drop(app);
    drop(repo);
    let reopened = NativeRepository::open(directory.path()).unwrap();
    let state = reopened.snapshot().unwrap();
    assert_eq!(state.runs.len(), 1);
    assert_eq!(state.layouts[&id].nodes[&root].collapsed, Some(true));
    assert!(
        state
            .runs
            .values()
            .all(|r| r.status == RunStatus::Completed)
    );
}

struct PreparationState {
    permitted: AtomicBool,
    metadata_loaded: AtomicBool,
    revoke_during_prepare: bool,
}
struct PrepareMetadata;
#[async_trait(?Send)]
impl ScopePreparer for PrepareMetadata {
    fn candidate_access(&self, req: &HttpRequest) -> std::result::Result<BoundAccess, ApiError> {
        use actix_web::HttpMessage;
        let shared = req
            .extensions()
            .get::<Arc<PreparationState>>()
            .expect("synthetic request preparation state")
            .clone();
        let candidate = move || {
            let mut candidate = owner1();
            if !shared.permitted.load(Ordering::SeqCst) {
                candidate.datasets.clear();
            }
            Ok::<_, ApiError>(candidate)
        };
        Ok(BoundAccess::new(candidate()?, Arc::new(candidate)))
    }
    async fn prepare(
        &self,
        req: &HttpRequest,
        candidate: &ScopeVersion,
    ) -> std::result::Result<(), ApiError> {
        use actix_web::HttpMessage;
        let shared = req
            .extensions()
            .get::<Arc<PreparationState>>()
            .expect("synthetic request preparation state")
            .clone();
        // The fixture separates a valid read grant from a populated metadata
        // cache, just as an unloaded live dataset requires preparation first.
        if !shared.permitted.load(Ordering::SeqCst) {
            return Err(KeystoneError::Forbidden.into());
        }
        assert_eq!(candidate.datasets, ["logs"]);
        assert_eq!(candidate.approved_by, "owner1");
        tokio::task::yield_now().await;
        shared.metadata_loaded.store(true, Ordering::SeqCst);
        if shared.revoke_during_prepare {
            shared.permitted.store(false, Ordering::SeqCst);
        }
        Ok(())
    }
}
fn prepared_access(req: &HttpRequest) -> std::result::Result<BoundAccess, ApiError> {
    use actix_web::HttpMessage;
    let shared = req
        .extensions()
        .get::<Arc<PreparationState>>()
        .expect("synthetic request preparation state")
        .clone();
    let current = move || {
        let mut access = owner1();
        if !shared.metadata_loaded.load(Ordering::SeqCst)
            || !shared.permitted.load(Ordering::SeqCst)
        {
            access.datasets.clear();
        }
        Ok::<_, ApiError>(access)
    };
    Ok(BoundAccess::new(current()?, Arc::new(current)))
}
#[actix_web::test]
async fn unloaded_metadata_is_prepared_before_create_and_revocation_prevents_persistence() {
    use actix_web::HttpMessage;
    for scenario in ["prepare", "revoke_during_await", "forbidden_before_prepare"] {
        let directory = tempfile::Builder::new()
            .prefix("keystone-scope-prepare-")
            .tempdir_in("/dev/shm")
            .unwrap();
        let repo = Arc::new(NativeRepository::open(directory.path()).unwrap());
        let shared = Arc::new(PreparationState {
            permitted: AtomicBool::new(scenario != "forbidden_before_prepare"),
            metadata_loaded: AtomicBool::new(false),
            revoke_during_prepare: scenario == "revoke_during_await",
        });
        let app = test::init_service(App::new().service(scope(
            web::Data::new(ApiState {
                repository: Some(repo.clone()),
                authorize: prepared_access,
                mode: "all",
                execution: None,
                scope_preparer: Some(Arc::new(PrepareMetadata)),
            }),
            |route| route,
        )))
        .await;
        let (_, _, mut node) = crate::keystone::context::tests::fixture();
        node.scope.approved_by = "untrusted-client-approver".into();
        let request = test::TestRequest::post()
            .uri("/keystone/native/investigations")
            .insert_header(("Idempotency-Key", "scope-prepared-create"))
            .set_json(json!({"title":"Scope hydration fixture","prompt":"Read logs after metadata preparation","scope":node.scope}))
            .to_request();
        request.extensions_mut().insert(shared.clone());
        let before_request = test::TestRequest::default().to_http_request();
        before_request.extensions_mut().insert(shared.clone());
        assert!(
            !prepared_access(&before_request)
                .unwrap()
                .access()
                .can_read("logs")
        );
        let response = test::call_service(&app, request).await;
        let status = response.status();
        let body: serde_json::Value = test::read_body_json(response).await;
        let committed = repo.snapshot().unwrap();
        if scenario == "prepare" {
            assert_eq!(status, StatusCode::CREATED);
            assert!(shared.metadata_loaded.load(Ordering::SeqCst));
            assert_eq!(committed.investigations.len(), 1);
            assert_eq!(committed.nodes.len(), 1);
            assert_eq!(
                committed.nodes.values().next().unwrap().scope.approved_by,
                "owner1"
            );
            assert_eq!(body["investigation"]["ownerId"], "owner1");
        } else {
            assert_eq!(status, StatusCode::NOT_FOUND);
            assert_eq!(body["error"]["code"], "not_found");
            assert!(committed.investigations.is_empty());
            assert!(committed.nodes.is_empty());
            assert!(committed.contexts.is_empty());
            assert!(committed.idempotency.is_empty());
            assert_eq!(
                shared.metadata_loaded.load(Ordering::SeqCst),
                scenario == "revoke_during_await"
            );
        }
    }
}

#[actix_web::test]
async fn live_sse_observer_revocation_emits_typed_error_after_headers() {
    let directory = tempfile::Builder::new()
        .prefix("keystone-sse-revoke-")
        .tempdir_in("/dev/shm")
        .unwrap();
    let repo = Arc::new(NativeRepository::open(directory.path()).unwrap());
    let (principal, investigation, node) = crate::keystone::context::tests::fixture();
    repo.create(
        &principal,
        investigation.clone(),
        node.clone(),
        IdempotencyRequest {
            key: "sse-create".into(),
            fingerprint: "sse-create".into(),
        },
    )
    .unwrap();
    let allowed = Arc::new(AtomicBool::new(true));
    let coordinator = Arc::new(Coordinator::new(
        repo.clone(),
        Arc::new(FixtureModelProvider {
            proposal: ModelProposal {
                explanation: "MUST_NOT_BE_DISPATCHED".into(),
            },
        }),
        Arc::new(Authority(allowed.clone())),
        Arc::new(Rows),
    ));
    let queued = coordinator
        .begin(&StartRun {
            principal: principal.clone(),
            grant: RunGrant {
                principal: principal.clone(),
                credential_id: "sse-fixture-grant".into(),
                expires_at: chrono::Utc::now().timestamp() + 120,
            },
            authorization_revision: "auth-v1".into(),
            investigation_id: investigation.id.clone(),
            node_id: node.id.clone(),
            node_version: 1,
            expected_revision: 0,
            idempotency_key: "sse-run".into(),
            selected_evidence_ids: vec![],
            scope_change_reviewed: false,
            provider_config_revision: 1,
        })
        .unwrap();
    let execution = Arc::new(Execution {
        repo: repo.clone(),
        coordinator: coordinator.clone(),
        allowed: allowed.clone(),
    });
    let app = test::init_service(App::new().service(scope(
        web::Data::new(ApiState {
            scope_preparer: None,
            repository: Some(repo.clone()),
            authorize: access,
            mode: "all",
            execution: Some(execution),
        }),
        |route| route,
    )))
    .await;
    let response = test::call_service(
        &app,
        test::TestRequest::get()
            .uri(&format!(
                "/keystone/native/investigations/{}/runs/{}/events?after=0",
                investigation.id, queued.id
            ))
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers().get("Content-Type").unwrap(),
        "text/event-stream"
    );
    // Headers have been accepted while authorized; revocation changes the live
    // body stream into its stable typed error frame, without exposing history.
    allowed.store(false, Ordering::SeqCst);
    let body = tokio::time::timeout(std::time::Duration::from_secs(2), test::read_body(response))
        .await
        .unwrap();
    let body = std::str::from_utf8(&body).unwrap();
    assert!(body.starts_with("event: error\n"));
    let data = body
        .lines()
        .find_map(|line| line.strip_prefix("data: "))
        .unwrap();
    let frame: serde_json::Value = serde_json::from_str(data).unwrap();
    assert_eq!(
        frame,
        json!({"schemaVersion":1,"error":{"code":"authorization_revoked"}})
    );
    assert!(!body.contains("MUST_NOT_BE_DISPATCHED"));
    assert!(!body.contains("hidden_P_sentinel"));
    assert!(!body.contains("accepted"));
    let state = repo.snapshot().unwrap();
    assert_eq!(state.runs[&queued.id].status, RunStatus::Queued);
    assert_eq!(state.events[&queued.id].len(), 1);
    assert!(state.artifacts.is_empty());
    assert!(state.exports.is_empty());
    coordinator.cancel(&principal, &queued.id).unwrap();
}

/// `actix_web::test` runs on one thread, like a single HTTP worker: were the gated commit
/// on it, neither the gate signal nor any later request could ever be observed.
#[actix_web::test]
async fn gated_durable_commit_leaves_the_worker_responsive_and_survives_a_dropped_request() {
    use futures::FutureExt;
    let directory = tempfile::Builder::new()
        .prefix("keystone-worker-liveness-")
        .tempdir_in("/dev/shm")
        .unwrap();
    let repo = Arc::new(NativeRepository::open(directory.path()).unwrap());
    let (principal, investigation, node) = crate::keystone::context::tests::fixture();
    repo.create(
        &principal,
        investigation.clone(),
        node.clone(),
        IdempotencyRequest {
            key: "liveness-create".into(),
            fingerprint: "liveness-create".into(),
        },
    )
    .unwrap();
    let app = test::init_service(App::new().service(scope(
        web::Data::new(ApiState {
            scope_preparer: None,
            repository: Some(repo.clone()),
            authorize: access,
            mode: "all",
            execution: None,
        }),
        |route| route,
    )))
    .await;
    let base = format!("/keystone/native/investigations/{}", investigation.id);
    let (entered, release) = repo.gate_next_commit();
    let mut layout = Box::pin(test::call_service(
        &app,
        test::TestRequest::put()
            .uri(&format!("{base}/layout"))
            .set_json(json!({"expectedRevision":0,"nodes":{(node.id.clone()):{"x":10,"y":20,"width":320,"height":200,"pinned":false}}}))
            .to_request(),
    ));
    // Drive the request until its durable commit is in progress on the blocking lane.
    tokio::select! {
        biased;
        _ = entered => {}
        _ = &mut layout => panic!("the layout commit was not gated"),
    }
    // The commit holds the repository mutex, yet this worker still serves requests.
    let capabilities: serde_json::Value = test::call_and_read_body_json(
        &app,
        test::TestRequest::get()
            .uri("/keystone/native/capabilities")
            .to_request(),
    )
    .await;
    assert_eq!(capabilities["storage"], "ready");
    // A read queues behind the commit without occupying the worker.
    let mut read = Box::pin(test::call_service(
        &app,
        test::TestRequest::get().uri(&base).to_request(),
    ));
    assert!((&mut read).now_or_never().is_none());
    // The client goes away mid-commit; the started commit still completes and publishes.
    drop(layout);
    release.send(()).unwrap();
    let response = read.await;
    assert_eq!(response.status(), StatusCode::OK);
    let body: serde_json::Value = test::read_body_json(response).await;
    assert_eq!(
        body["snapshot"]["investigations"][&investigation.id]["layoutRevision"],
        1
    );
    repo.drain_blocking().await;
    assert!(repo.health().is_ok());
    let committed = repo.snapshot().unwrap();
    assert_eq!(
        committed.investigations[&investigation.id].layout_revision,
        1
    );
    drop(app);
    drop(repo);
    let reopened = NativeRepository::open(directory.path()).unwrap();
    assert_eq!(reopened.snapshot().unwrap(), committed);
}

#[actix_web::test]
async fn reopened_investigations_prepare_cold_metadata_only_for_currently_authorized_reads() {
    use actix_web::HttpMessage;
    for scenario in ["authorized", "forbidden", "revoked_during_prepare"] {
        let directory = tempfile::Builder::new()
            .prefix("keystone-reopen-prepare-")
            .tempdir_in("/dev/shm")
            .unwrap();
        let repository = NativeRepository::open(directory.path()).unwrap();
        let (principal, investigation, node) = crate::keystone::context::tests::fixture();
        repository
            .create(
                &principal,
                investigation.clone(),
                node,
                IdempotencyRequest {
                    key: "reopen-create".into(),
                    fingerprint: "reopen-create".into(),
                },
            )
            .unwrap();
        drop(repository);
        let repo = Arc::new(NativeRepository::open(directory.path()).unwrap());
        let committed_before_reads = repo.snapshot().unwrap();
        let shared = Arc::new(PreparationState {
            permitted: AtomicBool::new(scenario != "forbidden"),
            metadata_loaded: AtomicBool::new(false),
            revoke_during_prepare: scenario == "revoked_during_prepare",
        });
        let app = test::init_service(App::new().service(scope(
            web::Data::new(ApiState {
                repository: Some(repo.clone()),
                authorize: prepared_access,
                mode: "all",
                execution: None,
                scope_preparer: Some(Arc::new(PrepareMetadata)),
            }),
            |route| route,
        )))
        .await;
        let request = test::TestRequest::get()
            .uri(&format!(
                "/keystone/native/investigations/{}/graph",
                investigation.id
            ))
            .to_request();
        request.extensions_mut().insert(shared.clone());
        let response = test::call_service(&app, request).await;
        let status = response.status();
        let body: serde_json::Value = test::read_body_json(response).await;
        if scenario == "authorized" {
            assert_eq!(status, StatusCode::OK);
            assert_eq!(body["rootNodeId"], investigation.root_node_id);
            assert!(shared.metadata_loaded.load(Ordering::SeqCst));
            // Listing must prepare metadata too; a restart can otherwise hide
            // a valid saved investigation behind an initially empty cache.
            shared.metadata_loaded.store(false, Ordering::SeqCst);
            let request = test::TestRequest::get()
                .uri("/keystone/native/investigations")
                .to_request();
            request.extensions_mut().insert(shared.clone());
            let response = test::call_service(&app, request).await;
            assert_eq!(response.status(), StatusCode::OK);
            let listed: serde_json::Value = test::read_body_json(response).await;
            assert_eq!(listed["investigations"][0]["id"], investigation.id);
            assert!(shared.metadata_loaded.load(Ordering::SeqCst));
        } else {
            assert_eq!(status, StatusCode::NOT_FOUND);
            assert_eq!(body["error"]["code"], "not_found");
            assert_eq!(
                shared.metadata_loaded.load(Ordering::SeqCst),
                scenario == "revoked_during_prepare"
            );
            // Revocation also removes the investigation from summaries and
            // must not hydrate denied datasets merely to decide visibility.
            shared.metadata_loaded.store(false, Ordering::SeqCst);
            let request = test::TestRequest::get()
                .uri("/keystone/native/investigations")
                .to_request();
            request.extensions_mut().insert(shared.clone());
            let response = test::call_service(&app, request).await;
            assert_eq!(response.status(), StatusCode::OK);
            let listed: serde_json::Value = test::read_body_json(response).await;
            assert_eq!(listed["investigations"], json!([]));
            assert!(!shared.metadata_loaded.load(Ordering::SeqCst));
        }
        assert_eq!(
            repo.snapshot().unwrap(),
            committed_before_reads,
            "metadata preparation must not write investigation or telemetry records"
        );
    }
}

thread_local! {
    static RESOLVED: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}
/// The production credential binding over real RBAC fixtures, counted so a test can tell
/// that a request resolved its access before its blocking job could start.
fn counted(req: &HttpRequest) -> std::result::Result<BoundAccess, ApiError> {
    let bound = super::super::runtime::candidate_authority(req);
    RESOLVED.with(|resolved| resolved.set(resolved.get() + 1));
    bound
}
/// Fills the repository's blocking lane, drives `request` until it has resolved its access
/// and waits for a slot, applies `change`, then frees the lane and finishes the request.
async fn behind_full_lane<T>(
    repo: &Arc<NativeRepository>,
    request: impl std::future::Future<Output = T>,
    change: impl FnOnce(),
) -> T {
    let (mut releases, mut held) = (Vec::new(), Vec::new());
    for _ in 0..super::super::repository::BLOCKING_OPERATIONS {
        let (started, entered) = tokio::sync::oneshot::channel();
        let (release, wait) = std::sync::mpsc::channel::<()>();
        let repo = repo.clone();
        held.push(actix_web::rt::spawn(async move {
            repo.blocking(move |_| {
                let _ = started.send(());
                let _ = wait.recv();
                Ok::<_, KeystoneError>(())
            })
            .await
        }));
        entered.await.unwrap();
        releases.push(release);
    }
    let resolved = || RESOLVED.with(std::cell::Cell::get);
    let before = resolved();
    let mut request = std::pin::pin!(request);
    // The bound only guards against a hang; no assertion depends on timing.
    for _ in 0..10_000 {
        if resolved() > before {
            break;
        }
        tokio::select! {
            biased;
            _ = &mut request => panic!("the request must queue behind the full lane"),
            _ = tokio::task::yield_now() => {}
        }
    }
    assert!(resolved() > before, "the request never resolved its access");
    change();
    drop(releases);
    for job in held {
        job.await.unwrap().unwrap();
    }
    request.await
}

#[actix_web::test]
async fn queued_jobs_revalidate_identity_credential_and_roles_before_release_or_commit() {
    use crate::keystone::context::{
        build_context,
        tests::{fixture, run},
    };
    use crate::keystone::runtime::tests::{native_user, tenant_with_reader};
    use crate::rbac::{
        Users,
        map::SessionKey,
        user::{Basic, User, UserType},
    };
    use actix_web::{HttpMessage, cookie::Cookie};
    let cases = [
        ("read", "unchanged", StatusCode::OK),
        ("read", "session_ended", StatusCode::UNAUTHORIZED),
        ("read", "role_removed", StatusCode::NOT_FOUND),
        ("read", "role_granted_later", StatusCode::NOT_FOUND),
        ("read", "api_key_rotated", StatusCode::UNAUTHORIZED),
        ("events", "unchanged", StatusCode::OK),
        ("events", "session_ended", StatusCode::UNAUTHORIZED),
        ("events", "role_removed", StatusCode::NOT_FOUND),
        ("layout", "unchanged", StatusCode::OK),
        ("layout", "session_ended", StatusCode::UNAUTHORIZED),
        ("layout", "role_removed", StatusCode::NOT_FOUND),
    ];
    for (route, change, expected) in cases {
        let tenant = tenant_with_reader();
        let reader = std::collections::HashSet::from(["query-logs".to_owned()]);
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
        let user = match change {
            "api_key_rotated" => api_key("fixture-queued-key"),
            "role_granted_later" => User {
                ty: UserType::Native(Basic {
                    username: format!("fixture-{}", ulid::Ulid::new()),
                    password_hash: "unused-fixture".into(),
                    email: None,
                }),
                roles: Default::default(),
                user_groups: Default::default(),
                tenant: Some(tenant.clone()),
                protected: false,
            },
            _ => native_user(&tenant),
        };
        Users.put_user(user.clone());
        let cookie = ulid::Ulid::new();
        let session = SessionKey::SessionId(cookie);
        Users.new_session(&user, session.clone(), chrono::TimeDelta::minutes(5));
        let principal = Principal {
            tenant_id: tenant.clone(),
            owner_id: user.userid().into(),
        };

        let directory = tempfile::Builder::new()
            .prefix("keystone-queued-auth-")
            .tempdir_in("/dev/shm")
            .unwrap();
        let repo = Arc::new(NativeRepository::open(directory.path()).unwrap());
        let (_, mut investigation, mut node) = fixture();
        investigation.tenant_id = tenant.clone();
        investigation.owner_id = principal.owner_id.clone();
        node.scope.approved_by = principal.owner_id.clone();
        repo.create(
            &principal,
            investigation.clone(),
            node.clone(),
            IdempotencyRequest {
                key: "queued-create".into(),
                fingerprint: "queued-create".into(),
            },
        )
        .unwrap();
        let context = build_context(&principal, &investigation, &node, None, &[], false, |_| {
            true
        })
        .unwrap();
        let mut completed = run(
            &node,
            "runQ",
            RunStatus::Completed,
            "QUEUED_ANSWER_SENTINEL",
        );
        completed.context_manifest_id = context.manifest.id.clone();
        completed.context_hash = context.hash.clone();
        repo.transact(
            &principal,
            &investigation.id,
            0,
            RevisionKind::Semantic,
            None,
            |state| {
                state.contexts.insert(context.manifest.id.clone(), context);
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
                state.runs.insert(completed.id.clone(), completed.clone());
                Ok(json!({}))
            },
        )
        .unwrap();

        // Storage only: no execution service or provider is configured.
        let app = test::init_service(App::new().service(scope(
            web::Data::new(ApiState {
                scope_preparer: None,
                repository: Some(repo.clone()),
                authorize: counted,
                mode: "all",
                execution: None,
            }),
            |route| route,
        )))
        .await;
        let base = format!("/keystone/native/investigations/{}", investigation.id);
        let request = match route {
            "read" => test::TestRequest::get().uri(&base),
            "events" => test::TestRequest::get().uri(&format!("{base}/runs/runQ/events")),
            _ => test::TestRequest::put()
                .uri(&format!("{base}/layout"))
                .set_json(json!({"expectedRevision":0,"nodes":{(node.id.clone()):{"x":10,"y":20,"width":320,"height":200,"pinned":false}}})),
        };
        let request = if change == "api_key_rotated" {
            let request = request
                .insert_header(("x-api-key", "fixture-queued-key"))
                .to_request();
            request.extensions_mut().insert(session.clone());
            request
        } else {
            request
                .cookie(Cookie::new("session", cookie.to_string()))
                .to_request()
        };
        let tenant_roles = Some(tenant.clone());
        let response =
            behind_full_lane(&repo, test::call_service(&app, request), || match change {
                "session_ended" => {
                    Users.remove_session(&session);
                }
                "role_removed" => Users.remove_roles(user.userid(), reader.clone(), &tenant_roles),
                "role_granted_later" => {
                    Users.add_roles(user.userid(), reader.clone(), &tenant_roles)
                }
                "api_key_rotated" => Users.put_user(api_key("fixture-rotated-key")),
                _ => {}
            })
            .await;
        let status = response.status();
        let body = String::from_utf8(test::read_body(response).await.to_vec()).unwrap();
        repo.drain_blocking().await;
        let layout_revision =
            repo.snapshot().unwrap().investigations[&investigation.id].layout_revision;
        assert_eq!(status, expected, "{route} after {change}: {body}");
        if expected == StatusCode::OK {
            match route {
                "read" => assert!(body.contains("hidden_P_sentinel")),
                "events" => assert!(body.contains("QUEUED_ANSWER_SENTINEL")),
                _ => assert_eq!(layout_revision, 1),
            }
        } else {
            let code = if expected == StatusCode::UNAUTHORIZED {
                "authentication_required"
            } else {
                "not_found"
            };
            let error: serde_json::Value = serde_json::from_str(&body).unwrap();
            assert_eq!(error, json!({"schemaVersion":1,"error":{"code":code}}));
            assert_eq!(layout_revision, 0, "{route} after {change} committed");
        }
    }
}
