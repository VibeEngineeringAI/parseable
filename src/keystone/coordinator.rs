//! Bounded coordinator: optional deterministic scoped samples, then one generation.
//! No autonomous tool loop, arbitrary SQL, retries, failover or model-selected tools.
use super::{
    context::{build_context_authorized, hash_bytes},
    domain::*,
    providers::{FrozenProviderContext, ModelProvider},
    repository::{
        IdempotencyRequest, NativeRepository, RepositoryState, RevisionKind, artifact_expired,
    },
    tools::{GrantAuthorizer, ReadExecutor, ReadOperation, RunGrant, invoke},
};
use serde_json::json;
use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, oneshot};
use tokio_util::sync::CancellationToken;

const GLOBAL_CONCURRENCY: usize = 4;
const MAX_ACCEPTED_RUNS: usize = 16;
const MAX_ACCEPTED_RUNS_PER_TENANT: usize = 8;
const RUN_DEADLINE: Duration = Duration::from_secs(120);
/// How long a cancelled or timed-out run waits for its step and nested reads to
/// unwind before it records its terminal event without claiming cleanup.
const TEARDOWN_GRACE: Duration = Duration::from_secs(10);

/// Server-resolved principal/grant only; never construct from arbitrary client DTOs.
#[derive(Clone)]
pub struct StartRun {
    pub principal: Principal,
    pub grant: RunGrant,
    pub authorization_revision: String,
    pub investigation_id: String,
    pub node_id: String,
    pub node_version: u64,
    pub expected_revision: u64,
    pub idempotency_key: String,
    pub selected_evidence_ids: Vec<String>,
    pub scope_change_reviewed: bool,
    pub provider_config_revision: u64,
}

struct ActiveRun {
    run_id: String,
    grant: RunGrant,
    cancel: CancellationToken,
    /// Claimed by an execution. Its `AdmissionClaim`, not `finish`, then
    /// releases this entry once nothing of that execution remains.
    executing: bool,
}
type ActiveRuns = Arc<Mutex<BTreeMap<(String, String), ActiveRun>>>;

/// Releases a claimed run's admission entry when dropped.
struct AdmissionClaim {
    active: ActiveRuns,
    key: (String, String),
    run_id: String,
}
impl Drop for AdmissionClaim {
    fn drop(&mut self) {
        // A poisoned map already fails every admission closed.
        if let Ok(mut active) = self.active.lock()
            && active
                .get(&self.key)
                .is_some_and(|entry| entry.run_id == self.run_id)
        {
            active.remove(&self.key);
        }
    }
}

tokio::task_local! {
    static WORK_LEASE: WorkLease;
}

/// A claimed run's resource accounting: its execution permit and admission
/// entry. Each read keeps a clone inside the one top-level query task it spawns,
/// so neither is released until that task's future has been dropped, however
/// the coordinator's own future ended. The lease does not reach further:
/// DataFusion child tasks (e.g. union partitions) are aborted with that task but
/// not awaited, and bounded manifest-decode and local-file blocking calls can
/// briefly outlive it until their next cooperative boundary. Those stay under
/// their own decode and blocking limits, and their results are discarded.
#[derive(Clone)]
pub(crate) struct WorkLease {
    _inner: Arc<LeaseInner>,
}
// Fields drop in order: admission entry, then permit, then the drained signal,
// so a drained run has already released both.
struct LeaseInner {
    _claim: AdmissionClaim,
    _permit: OwnedSemaphorePermit,
    _drained: oneshot::Sender<()>,
}
impl WorkLease {
    /// The lease of the coordinator step polling the current task, if any.
    pub(crate) fn current() -> Option<Self> {
        WORK_LEASE.try_with(Clone::clone).ok()
    }
}

/// The terminal a step decided on. `execute` records it, after teardown.
struct Outcome {
    status: RunStatus,
    answer: Option<String>,
    reason: &'static str,
}
impl Outcome {
    fn failed(reason: &'static str) -> Self {
        Self {
            status: RunStatus::Failed,
            answer: None,
            reason,
        }
    }
    /// A stopped step reports its run deadline, not a generic cancellation.
    fn stopped(deadline_hit: &AtomicBool) -> Self {
        if deadline_hit.load(Ordering::SeqCst) {
            Self::failed("deadline_exceeded")
        } else {
            Self {
                status: RunStatus::Cancelled,
                answer: None,
                reason: "cancelled",
            }
        }
    }
}

pub struct Coordinator {
    repository: Arc<NativeRepository>,
    provider: Arc<dyn ModelProvider>,
    authorizer: Arc<dyn GrantAuthorizer>,
    read_executor: Arc<dyn ReadExecutor>,
    reads_enabled: bool,
    active: ActiveRuns,
    permits: Arc<Semaphore>,
    deadline: Duration,
    teardown_grace: Duration,
}

impl Coordinator {
    /// Inference readiness is checked by the caller before acceptance. Production
    /// API does not instantiate this engine while provider capabilities are disabled.
    pub fn new(
        repository: Arc<NativeRepository>,
        provider: Arc<dyn ModelProvider>,
        authorizer: Arc<dyn GrantAuthorizer>,
        read_executor: Arc<dyn ReadExecutor>,
    ) -> Self {
        Self {
            repository,
            provider,
            authorizer,
            read_executor,
            reads_enabled: false,
            active: Arc::new(Mutex::new(BTreeMap::new())),
            permits: Arc::new(Semaphore::new(GLOBAL_CONCURRENCY)),
            deadline: RUN_DEADLINE,
            teardown_grace: TEARDOWN_GRACE,
        }
    }

    /// Production opts into reads explicitly; existing injected text-only fixtures
    /// keep their original exact pinned-context behavior through `new`.
    pub fn new_with_reads(
        repository: Arc<NativeRepository>,
        provider: Arc<dyn ModelProvider>,
        authorizer: Arc<dyn GrantAuthorizer>,
        read_executor: Arc<dyn ReadExecutor>,
    ) -> Self {
        let mut coordinator = Self::new(repository, provider, authorizer, read_executor);
        coordinator.reads_enabled = true;
        coordinator
    }

    /// Durable acceptance and idempotency happen before callers can see queued events.
    pub fn begin(&self, request: &StartRun) -> Result<Run> {
        request.principal.validate()?;
        if request.principal != request.grant.principal {
            return Err(KeystoneError::Forbidden);
        }
        validate_id(&request.idempotency_key)?;
        validate_id(&request.grant.credential_id)?;
        bounded_text(
            &request.authorization_revision,
            128,
            "authorization revision",
        )?;
        if request.selected_evidence_ids.len() > 64 {
            return Err(KeystoneError::Invalid("evidence budget".into()));
        }
        let snapshot = self.repository.snapshot()?;
        let investigation = snapshot
            .investigations
            .get(&request.investigation_id)
            .ok_or(KeystoneError::NotFound)?;
        investigation.authorize(&request.principal)?;
        if investigation.archived {
            return Err(KeystoneError::Conflict);
        }
        let node = snapshot.node(&request.node_id, request.node_version)?;
        if node.investigation_id != investigation.id {
            return Err(KeystoneError::Forbidden);
        }
        self.current(&request.grant, &node.scope)?;
        if self.reads_enabled && !node.scope.filters.is_empty() {
            return Err(KeystoneError::Invalid(
                "scoped reads do not support saved filters".into(),
            ));
        }
        let fingerprint = hash_bytes(&serde_json::to_vec(&(
            "start_run_v1",
            &request.investigation_id,
            &request.node_id,
            request.node_version,
            &request.selected_evidence_ids,
            request.scope_change_reviewed,
            request.provider_config_revision,
            &request.principal,
        ))?);
        // Replays take precedence over stale revisions and active-node conflicts,
        // including after restart; they NEVER dispatch a provider again.
        if let Some(record) = snapshot.idempotency.values().find(|record| {
            record.key == request.idempotency_key
                && record.tenant_id == request.principal.tenant_id
                && record.owner_id == request.principal.owner_id
        }) {
            if record.investigation_id != request.investigation_id
                || record.fingerprint != fingerprint
            {
                return Err(KeystoneError::Conflict);
            }
            let run_id = record.response["run_id"]
                .as_str()
                .ok_or_else(|| KeystoneError::Invalid("idempotency run response".into()))?;
            let run = snapshot
                .runs
                .get(run_id)
                .cloned()
                .ok_or(KeystoneError::NotFound)?;
            let context = snapshot
                .contexts
                .get(&run.context_manifest_id)
                .ok_or(KeystoneError::NotFound)?;
            self.context_current(&snapshot, &request.grant, context)?;
            return Ok(run);
        }
        // A completed version's selected run and exported context must agree.
        // Re-running completed work requires a new immutable node version.
        if snapshot.exports.contains_key(&node.version_key()) {
            return Err(KeystoneError::Conflict);
        }
        let parent = match &node.parent {
            Some(parent) => Some(
                snapshot
                    .exports
                    .get(&format!("{}-v{}", parent.node_id, parent.version))
                    .ok_or(KeystoneError::NotFound)?,
            ),
            None => None,
        };
        if let Some(parent) = parent {
            self.current(&request.grant, &parent.scope)?;
        }
        if request.scope_change_reviewed
            != parent.is_some_and(|parent| !parent.scope.same_bounds(&node.scope))
        {
            return Err(KeystoneError::Conflict);
        }
        let pinned = if let Some(id) = &node.context_manifest_id {
            // The branch preview is the accepted input. Authorization is checked
            // again, but its ID, manifest and exact provider bytes never change.
            let pinned = snapshot.contexts.get(id).ok_or(KeystoneError::NotFound)?;
            self.validate_node_pin(&snapshot, node, request, pinned)?;
            pinned.clone()
        } else {
            let evidence = request
                .selected_evidence_ids
                .iter()
                .map(|id| {
                    snapshot
                        .evidence
                        .get(id)
                        .cloned()
                        .ok_or(KeystoneError::NotFound)
                })
                .collect::<Result<Vec<_>>>()?;
            build_context_authorized(
                &request.principal,
                investigation,
                node,
                parent,
                &evidence,
                request.scope_change_reviewed,
                |e| self.evidence_current(&snapshot, &request.grant, e).is_ok(),
                |dataset| {
                    let mut scope = node.scope.clone();
                    scope.datasets = vec![dataset.into()];
                    self.current(&request.grant, &scope).is_ok()
                },
            )?
        };
        let _ = FrozenProviderContext::try_from(&pinned)
            .map_err(|_| KeystoneError::Invalid("invalid frozen provider context".into()))?;
        let key = (investigation.id.clone(), node.id.clone());
        let mut active = self.active.lock().map_err(|_| KeystoneError::Conflict)?;
        // Acceptance may have committed while this request built its context.
        // Recheck durable idempotency under the admission mutex before treating
        // that accepted run as a conflicting request.
        let latest = self.repository.snapshot()?;
        if let Some(record) = latest.idempotency.values().find(|record| {
            record.key == request.idempotency_key
                && record.tenant_id == request.principal.tenant_id
                && record.owner_id == request.principal.owner_id
        }) {
            if record.investigation_id != request.investigation_id
                || record.fingerprint != fingerprint
            {
                return Err(KeystoneError::Conflict);
            }
            let run_id = record.response["run_id"]
                .as_str()
                .ok_or_else(|| KeystoneError::Invalid("idempotency run response".into()))?;
            let run = latest
                .runs
                .get(run_id)
                .cloned()
                .ok_or(KeystoneError::NotFound)?;
            let context = latest
                .contexts
                .get(&run.context_manifest_id)
                .ok_or(KeystoneError::NotFound)?;
            self.context_current(&latest, &request.grant, context)?;
            return Ok(run);
        }
        if active.contains_key(&key)
            || snapshot.runs.values().any(|run| {
                run.investigation_id == investigation.id
                    && run.node_id == node.id
                    && !run.status.is_terminal()
            })
        {
            return Err(KeystoneError::Conflict);
        }
        let tenant_accepted = active
            .values()
            .filter(|entry| entry.grant.principal.tenant_id == request.principal.tenant_id)
            .count();
        if active.len() >= MAX_ACCEPTED_RUNS || tenant_accepted >= MAX_ACCEPTED_RUNS_PER_TENANT {
            return Err(KeystoneError::RunCapacity);
        }
        let attempt = snapshot
            .runs
            .values()
            .filter(|run| run.investigation_id == investigation.id && run.node_id == node.id)
            .map(|run| run.attempt)
            .max()
            .unwrap_or(0)
            .checked_add(1)
            .ok_or_else(|| KeystoneError::Invalid("attempt overflow".into()))?;
        let now = chrono::Utc::now().to_rfc3339();
        let run = Run {
            id: ulid::Ulid::new().to_string(),
            node_id: node.id.clone(),
            investigation_id: investigation.id.clone(),
            attempt,
            prompt_version: node.version,
            scope: node.scope.clone(),
            context_manifest_id: pinned.manifest.id.clone(),
            context_hash: pinned.hash.clone(),
            provider_config_revision: request.provider_config_revision,
            status: RunStatus::Queued,
            answer: None,
            created_at: now.clone(),
            updated_at: now,
            grant: Some(GrantIdentity {
                principal_id: request.principal.owner_id.clone(),
                authorization_revision: request.authorization_revision.clone(),
            }),
        };
        let value = self.repository.transact(
            &request.principal,
            &investigation.id,
            request.expected_revision,
            RevisionKind::Semantic,
            Some(IdempotencyRequest {
                key: request.idempotency_key.clone(),
                fingerprint,
            }),
            |state| {
                state
                    .contexts
                    .entry(pinned.manifest.id.clone())
                    .or_insert(pinned.clone());
                state.runs.insert(run.id.clone(), run.clone());
                let committed_node = state
                    .nodes
                    .get_mut(&node.version_key())
                    .ok_or(KeystoneError::NotFound)?;
                committed_node.selected_run_id = Some(run.id.clone());
                committed_node.context_manifest_id = Some(pinned.manifest.id.clone());
                append_event(state, &run, "queued", "accepted");
                Ok(json!({"run_id":run.id}))
            },
        )?;
        let committed_id = value["run_id"]
            .as_str()
            .ok_or_else(|| KeystoneError::Invalid("idempotency run response".into()))?;
        // A concurrent durable replay must not schedule duplicate work.
        if committed_id != run.id {
            return self
                .repository
                .snapshot()?
                .runs
                .get(committed_id)
                .cloned()
                .ok_or(KeystoneError::NotFound);
        }
        active.insert(
            key,
            ActiveRun {
                run_id: run.id.clone(),
                grant: request.grant.clone(),
                cancel: CancellationToken::new(),
                executing: false,
            },
        );
        Ok(run)
    }

    /// A fresh per-request query grant must only be retained for newly accepted
    /// work. Durable idempotent replays continue using their original grant.
    pub fn run_uses_grant(&self, run_id: &str, credential_id: &str) -> bool {
        self.active
            .lock()
            .map(|active| {
                active.values().any(|entry| {
                    entry.run_id == run_id && entry.grant.credential_id == credential_id
                })
            })
            .unwrap_or(false)
    }

    /// Await this owned future. Dropping it terminates local work and records
    /// Interrupted; detached query/provider tasks are forbidden. Nested query
    /// tasks it aborted keep this run's permit and admission entry counted until
    /// they have actually been dropped.
    pub async fn execute(&self, principal: &Principal, run_id: &str) -> Result<Run> {
        let snapshot = self.repository.snapshot()?;
        let run = snapshot
            .runs
            .get(run_id)
            .cloned()
            .ok_or(KeystoneError::NotFound)?;
        snapshot
            .investigations
            .get(&run.investigation_id)
            .ok_or(KeystoneError::NotFound)?
            .authorize(principal)?;
        if run.status.is_terminal() {
            return Ok(run);
        }
        let key = (run.investigation_id.clone(), run.node_id.clone());
        let (grant, cancel, claim) = {
            let mut active = self.active.lock().map_err(|_| KeystoneError::Conflict)?;
            let entry = active.get_mut(&key).ok_or(KeystoneError::Conflict)?;
            if entry.run_id != run_id || entry.executing || &entry.grant.principal != principal {
                return Err(KeystoneError::Conflict);
            }
            entry.executing = true;
            let claim = AdmissionClaim {
                active: self.active.clone(),
                key,
                run_id: run.id.clone(),
            };
            (entry.grant.clone(), entry.cancel.clone(), claim)
        };
        let _guard = ExecutionGuard {
            coordinator: self,
            principal: principal.clone(),
            run_id: run.id.clone(),
            cancel: cancel.clone(),
        };
        let deadline = tokio::time::sleep(self.deadline);
        tokio::pin!(deadline);
        // Queued for an execution permit: nothing nested has started yet.
        let permit = tokio::select! {
            biased;
            _ = cancel.cancelled() => {
                return self.finish(principal, run_id, RunStatus::Cancelled, None, "cancelled");
            }
            () = &mut deadline => {
                return self.finish(principal, run_id, RunStatus::Failed, None, "deadline_exceeded");
            }
            permit = self.permits.clone().acquire_owned() => {
                permit.map_err(|_| KeystoneError::Conflict)?
            }
        };
        let (drained_tx, drained) = oneshot::channel();
        let lease = WorkLease {
            _inner: Arc::new(LeaseInner {
                _claim: claim,
                _permit: permit,
                _drained: drained_tx,
            }),
        };
        // The step and its nested reads watch `stop`; a user cancel reaches it
        // through its parent token, the run deadline cancels it directly.
        let stop = cancel.child_token();
        let deadline_hit = AtomicBool::new(false);
        let mut step = Box::pin(WORK_LEASE.scope(
            lease.clone(),
            self.step(principal, &run, &grant, &stop, &deadline_hit),
        ));
        let finished = tokio::select! {
            biased;
            _ = cancel.cancelled() => None,
            () = &mut deadline => {
                deadline_hit.store(true, Ordering::SeqCst);
                None
            }
            result = &mut step => Some(result),
        };
        let teardown = tokio::time::Instant::now() + self.teardown_grace;
        let finished = match finished {
            Some(result) => Some(result),
            None => {
                stop.cancel();
                tokio::time::timeout_at(teardown, &mut step).await.ok()
            }
        };
        // Dropping the step aborts whatever it still owns. An aborted top-level
        // query task holds its lease clone until the query runtime has dropped
        // it; "drained" means that, not that every child task or blocking call
        // that task started has finished (see `WorkLease`).
        drop(step);
        drop(lease);
        let drained = tokio::time::timeout_at(teardown, drained).await.is_ok();
        let outcome = match finished {
            Some(Ok(outcome)) => outcome,
            // Repository failures keep their error; the guard records Interrupted.
            Some(Err(error)) => return Err(error),
            None => Outcome::stopped(&deadline_hit),
        };
        if drained {
            return self.finish(
                principal,
                run_id,
                outcome.status,
                outcome.answer,
                outcome.reason,
            );
        }
        // A cooperative poll limit, not a lost task: work blocked inside a single
        // poll is only dropped once it yields. Record the outcome without
        // claiming cleanup; the lease keeps this run's permit and admission entry
        // counted until that work has unwound.
        tracing::warn!(
            run_id,
            reason = outcome.reason,
            "keystone run ended before its nested work unwound"
        );
        self.finish(
            principal,
            run_id,
            outcome.status,
            outcome.answer,
            &format!("{}_teardown_pending", outcome.reason),
        )
    }

    /// One claimed run's work. It never records a terminal itself: `execute`
    /// does, once whatever this step started has unwound. It returns promptly
    /// once `stop` is cancelled.
    async fn step(
        &self,
        principal: &Principal,
        run: &Run,
        grant: &RunGrant,
        stop: &CancellationToken,
        deadline_hit: &AtomicBool,
    ) -> Result<Outcome> {
        let stopped = || Ok(Outcome::stopped(deadline_hit));
        if stop.is_cancelled() {
            return stopped();
        }
        if self.current(grant, &run.scope).is_err() {
            return Ok(Outcome::failed("authorization_revoked"));
        }
        let fresh = self.repository.snapshot()?;
        let context = fresh
            .contexts
            .get(&run.context_manifest_id)
            .ok_or(KeystoneError::NotFound)?;
        if self.context_current(&fresh, grant, context).is_err() {
            return Ok(Outcome::failed("context_unavailable"));
        }
        let mut frozen = FrozenProviderContext::try_from(context)
            .map_err(|_| KeystoneError::Invalid("invalid frozen context".into()))?;
        // A run made terminal elsewhere records nothing further; `finish` is idempotent.
        if !self.mark_running(principal, run)? || stop.is_cancelled() {
            return stopped();
        }
        if self.current(grant, &run.scope).is_err() {
            return Ok(Outcome::failed("authorization_revoked"));
        }
        let mut fresh_evidence = Vec::new();
        if self.reads_enabled {
            match self
                .read_context(principal, run, grant, context, stop.clone())
                .await
            {
                Ok((dispatch, evidence)) => {
                    frozen = dispatch;
                    fresh_evidence = evidence;
                }
                Err(_) if stop.is_cancelled() => return stopped(),
                Err(_) => return Ok(Outcome::failed("scoped_read_or_context_budget_failed")),
            }
        }
        let ready = self.repository.snapshot()?;
        if self.context_current(&ready, grant, context).is_err()
            || fresh_evidence
                .iter()
                .any(|e| self.evidence_current(&ready, grant, e).is_err())
        {
            return Ok(Outcome::failed("evidence_or_authorization_revoked"));
        }
        let proposal = tokio::select! {
            biased;
            _ = stop.cancelled() => return stopped(),
            proposal = self.provider.propose_versioned(
                &principal.tenant_id,
                run.provider_config_revision,
                &frozen,
            ) => proposal,
        };
        if stop.is_cancelled() {
            return stopped();
        }
        if self.current(grant, &run.scope).is_err() {
            return Ok(Outcome::failed("authorization_revoked"));
        }
        // Recheck inherited evidence retention and dataset authorization after
        // the provider future before publishing any answer.
        let fresh = self.repository.snapshot()?;
        if self.context_current(&fresh, grant, context).is_err()
            || fresh_evidence
                .iter()
                .any(|e| self.evidence_current(&fresh, grant, e).is_err())
        {
            return Ok(Outcome::failed("context_unavailable"));
        }
        Ok(match proposal {
            Ok(proposal)
                if bounded_text(&proposal.explanation, MAX_ANSWER_BYTES, "answer").is_ok() =>
            {
                Outcome {
                    status: RunStatus::Completed,
                    answer: Some(proposal.explanation),
                    reason: "completed",
                }
            }
            _ => Outcome::failed("provider_unavailable_or_invalid"),
        })
    }

    async fn read_context(
        &self,
        principal: &Principal,
        run: &Run,
        grant: &RunGrant,
        pinned: &super::context::PinnedContext,
        cancel: CancellationToken,
    ) -> Result<(FrozenProviderContext, Vec<Evidence>)> {
        const ROW_LIMIT: u16 = 25;
        const MAX_SAMPLE_BYTES: usize = 8_000;
        let mut datasets = run.scope.datasets.clone();
        datasets.sort();
        let mut payload = json!({
            "contextPolicy":"direct_parent_plus_fresh_samples_v1",
            "pinnedContext":serde_json::from_slice::<serde_json::Value>(&pinned.bytes)?,
            "freshEvidence":[],
            "coverage":"Fresh evidence consists of bounded samples from each approved dataset within the exact absolute time bounds. Samples are not full statistics, counts, or proof of absence; omitted rows and sample membership limit conclusions."
        });
        let overhead = serde_json::to_vec(&payload)?.len();
        let remaining = super::providers::MAX_CONTEXT_BYTES.saturating_sub(overhead);
        let sample_budget =
            MAX_SAMPLE_BYTES.min(remaining.saturating_sub(4096) / datasets.len().max(1));
        if sample_budget < 512 {
            return Err(KeystoneError::Invalid(
                "fresh evidence context budget".into(),
            ));
        }
        let mut evidence = Vec::new();
        for dataset in datasets {
            self.current(grant, &run.scope)?;
            if cancel.is_cancelled() {
                return Err(KeystoneError::Conflict);
            }
            let operation = ReadOperation::Sample {
                dataset: dataset.clone(),
                start: run.scope.absolute_start.clone(),
                end: run.scope.absolute_end.clone(),
                rows: ROW_LIMIT,
            };
            let id = ulid::Ulid::new().to_string();
            let now = chrono::Utc::now().to_rfc3339();
            let invocation = ToolInvocation {
                id: id.clone(),
                provider_call_id: run.id.clone(),
                run_id: run.id.clone(),
                name: "scoped_sample_v1".into(),
                schema_version: SCHEMA_VERSION,
                arguments: serde_json::to_value(&operation)?,
                scope: run.scope.clone(),
                started_at: now,
                ended_at: None,
                status: "running".into(),
                attempt: 1,
                execution_id: Some(id.clone()),
                artifact_ids: vec![],
            };
            self.checkpoint(principal, run, |state| {
                state.tools.insert(id.clone(), invocation.clone());
                append_event(state, run, "read_started", "scoped_sample_started");
                Ok(())
            })?;
            let result = invoke(
                self.authorizer.as_ref(),
                self.read_executor.as_ref(),
                grant,
                &run.scope,
                &operation,
                cancel.clone(),
            )
            .await
            .map_err(|_| KeystoneError::Invalid("scoped sample failed".into()))?;
            let (sample, row_count, truncated) =
                bounded_sample(result, &dataset, &run.scope, ROW_LIMIT, sample_budget)?;
            let sample_bytes = serde_json::to_vec(&sample)?;
            let artifact = self.artifact(
                principal,
                run,
                "scoped_sample_v1",
                vec![dataset.clone()],
                sample.clone(),
                row_count,
                truncated,
            )?;
            let item = Evidence {
                id: ulid::Ulid::new().to_string(),
                artifact_id: artifact.id.clone(),
                investigation_id: run.investigation_id.clone(),
                node_id: run.node_id.clone(),
                run_id: run.id.clone(),
                tenant_id: principal.tenant_id.clone(),
                owner_id: principal.owner_id.clone(),
                datasets: vec![dataset.clone()],
                summary: String::from_utf8(sample_bytes)
                    .map_err(|_| KeystoneError::Invalid("sample encoding".into()))?,
            };
            self.current(grant, &run.scope)?;
            if cancel.is_cancelled() {
                return Err(KeystoneError::Conflict);
            }
            self.checkpoint(principal, run, |state| {
                self.context_current(state, grant, pinned)?;
                state
                    .artifacts
                    .insert(artifact.id.clone(), artifact.clone());
                state.evidence.insert(item.id.clone(), item.clone());
                let invocation = state.tools.get_mut(&id).ok_or(KeystoneError::NotFound)?;
                invocation.status = "completed".into();
                invocation.ended_at = Some(artifact.fetched_at.clone());
                invocation.artifact_ids = vec![artifact.id.clone()];
                append_event(state, run, "read_completed", "scoped_sample_recorded");
                if let Some(event) = state
                    .events
                    .get_mut(&run.id)
                    .and_then(|events| events.last_mut())
                {
                    event.payload["evidenceId"] = json!(item.id);
                }
                Ok(())
            })?;
            payload["freshEvidence"].as_array_mut().ok_or(KeystoneError::Conflict)?.push(json!({"id":item.id,"artifactId":artifact.id,"datasets":item.datasets,"sample":sample}));
            evidence.push(item);
        }
        let bytes = serde_json::to_vec(&payload)?;
        let hash = hash_bytes(&bytes);
        let frozen = FrozenProviderContext::freeze(&bytes, &hash)
            .map_err(|_| KeystoneError::Invalid("fresh evidence context budget".into()))?;
        let request_manifest = self.provider.request_manifest(&frozen);
        let request_manifest_hash = request_manifest
            .as_ref()
            .map(serde_json::to_vec)
            .transpose()?
            .map(|bytes| hash_bytes(&bytes));
        let request_body_hash = request_manifest
            .as_ref()
            .and_then(|manifest| manifest.get("body"))
            .map(serde_json::to_vec)
            .transpose()?
            .map(|bytes| hash_bytes(&bytes));
        let dispatch = self.artifact(
            principal,
            run,
            "provider_dispatch_context_v1",
            run.scope.datasets.clone(),
            json!({
                "pinnedContextHash":pinned.hash,
                "providerContextHash":hash,
                "providerContext":frozen.serialized(),
                "evidenceIds":evidence.iter().map(|e| e.id.clone()).collect::<Vec<_>>(),
                "providerConfigRevision":run.provider_config_revision,
            "requestManifest":request_manifest,
            "requestManifestHash":request_manifest_hash,
            "requestBodyHash":request_body_hash,
            }),
            0,
            false,
        )?;
        self.checkpoint(principal, run, |state| {
            self.context_current(state, grant, pinned)?;
            for item in &evidence {
                self.evidence_current(state, grant, item)?;
            }
            state
                .artifacts
                .insert(dispatch.id.clone(), dispatch.clone());
            append_event(
                state,
                run,
                "provider_context_pinned",
                "fresh_evidence_context_recorded",
            );
            Ok(())
        })?;
        Ok((frozen, evidence))
    }
    // Every field is a distinct part of the artifact's identity or result; a
    // one-off struct would only rename these arguments at the call sites.
    #[allow(clippy::too_many_arguments)]
    fn artifact(
        &self,
        principal: &Principal,
        run: &Run,
        kind: &str,
        datasets: Vec<String>,
        payload: serde_json::Value,
        row_count: u64,
        truncated: bool,
    ) -> Result<Artifact> {
        let bytes = serde_json::to_vec(&payload)?;
        if bytes.len() > MAX_ARTIFACT_BYTES {
            return Err(KeystoneError::Invalid("artifact byte budget".into()));
        }
        Ok(Artifact {
            id: ulid::Ulid::new().to_string(),
            investigation_id: run.investigation_id.clone(),
            node_id: run.node_id.clone(),
            run_id: run.id.clone(),
            tenant_id: principal.tenant_id.clone(),
            owner_id: principal.owner_id.clone(),
            schema_version: SCHEMA_VERSION,
            kind: kind.into(),
            datasets,
            scope: run.scope.clone(),
            executed_sql: None,
            result_hash: hash_bytes(&bytes),
            fetched_at: chrono::Utc::now().to_rfc3339(),
            expires_at: None,
            row_count,
            byte_count: bytes.len() as u64,
            payload,
            truncated,
        })
    }
    fn checkpoint(
        &self,
        principal: &Principal,
        run: &Run,
        mutation: impl FnOnce(&mut RepositoryState) -> Result<()>,
    ) -> Result<()> {
        self.repository
            .transact_execution(principal, &run.id, |state| {
                if state
                    .runs
                    .get(&run.id)
                    .is_none_or(|run| run.status.is_terminal())
                {
                    return Err(KeystoneError::Conflict);
                }
                mutation(state)?;
                Ok(json!({}))
            })?;
        Ok(())
    }

    pub fn cancel(&self, principal: &Principal, run_id: &str) -> Result<Run> {
        let snapshot = self.repository.snapshot()?;
        let run = snapshot.runs.get(run_id).ok_or(KeystoneError::NotFound)?;
        snapshot
            .investigations
            .get(&run.investigation_id)
            .ok_or(KeystoneError::NotFound)?
            .authorize(principal)?;
        {
            let active = self.active.lock().map_err(|_| KeystoneError::Conflict)?;
            if let Some(entry) = active.get(&(run.investigation_id.clone(), run.node_id.clone()))
                && entry.run_id == run_id
            {
                entry.cancel.cancel();
                if entry.executing {
                    // Its execution records the terminal once its nested work has
                    // unwound, within a bounded grace; this request never waits.
                    return Ok(run.clone());
                }
            }
        }
        // Never claimed: no nested work exists, so record the terminal now.
        self.finish(principal, run_id, RunStatus::Cancelled, None, "cancelled")
    }

    fn current(&self, grant: &RunGrant, scope: &ScopeVersion) -> Result<()> {
        if grant.expires_at <= chrono::Utc::now().timestamp() {
            return Err(KeystoneError::Forbidden);
        }
        self.authorizer
            .authorize(grant, scope)
            .map_err(|_| KeystoneError::Forbidden)
    }
    fn context_current(
        &self,
        state: &RepositoryState,
        grant: &RunGrant,
        context: &super::context::PinnedContext,
    ) -> Result<()> {
        context.verify()?;
        self.current(grant, &context.manifest.scope)?;
        if let Some(parent) = &context.manifest.parent_export {
            self.current(grant, &parent.scope)?;
        }
        for evidence in &context.manifest.evidence {
            self.evidence_current(state, grant, evidence)?;
        }
        Ok(())
    }
    fn validate_node_pin(
        &self,
        state: &RepositoryState,
        node: &Node,
        request: &StartRun,
        pinned: &super::context::PinnedContext,
    ) -> Result<()> {
        pinned.verify()?;
        let manifest = &pinned.manifest;
        if node.context_manifest_id.as_ref() != Some(&manifest.id)
            || manifest.investigation_id != node.investigation_id
            || manifest.node_id != node.id
            || manifest.node_version != node.version
            || manifest.prompt != node.prompt
            || manifest.scope != node.scope
            || manifest.direct_parent != node.parent
            || manifest.context_policy != CONTEXT_POLICY
            || manifest
                .evidence
                .iter()
                .map(|e| e.id.clone())
                .collect::<Vec<_>>()
                != request.selected_evidence_ids
        {
            return Err(KeystoneError::Conflict);
        }
        let required_review = manifest
            .parent_export
            .as_ref()
            .is_some_and(|parent| !parent.scope.same_bounds(&manifest.scope));
        if required_review != request.scope_change_reviewed {
            return Err(KeystoneError::Conflict);
        }
        match (&node.parent, &manifest.parent_export) {
            (None, None) => {}
            (Some(reference), Some(parent)) => {
                let committed = state
                    .exports
                    .get(&format!("{}-v{}", reference.node_id, reference.version))
                    .ok_or(KeystoneError::NotFound)?;
                let mut selected = committed.clone();
                selected.evidence_ids = parent.evidence_ids.clone();
                if &selected != parent
                    || parent.evidence_ids != request.selected_evidence_ids
                    || parent
                        .evidence_ids
                        .iter()
                        .any(|id| !committed.evidence_ids.contains(id))
                {
                    return Err(KeystoneError::Conflict);
                }
            }
            _ => return Err(KeystoneError::Conflict),
        }
        self.context_current(state, &request.grant, pinned)
    }
    fn evidence_current(
        &self,
        state: &RepositoryState,
        grant: &RunGrant,
        evidence: &Evidence,
    ) -> Result<()> {
        grant
            .principal
            .authorize(&evidence.tenant_id, &evidence.owner_id)?;
        if state.evidence.get(&evidence.id) != Some(evidence) {
            return Err(KeystoneError::Forbidden);
        }
        let artifact = state
            .artifacts
            .get(&evidence.artifact_id)
            .ok_or(KeystoneError::NotFound)?;
        if artifact_expired(artifact) {
            return Err(KeystoneError::Forbidden);
        }
        self.current(grant, &artifact.scope)
    }
    fn mark_running(&self, principal: &Principal, run: &Run) -> Result<bool> {
        let value = self
            .repository
            .transact_execution(principal, &run.id, |state| {
                let current = state.runs.get_mut(&run.id).ok_or(KeystoneError::NotFound)?;
                if current.status.is_terminal() {
                    return Ok(json!(false));
                }
                if current.status != RunStatus::Running {
                    current.status = RunStatus::Running;
                    current.updated_at = chrono::Utc::now().to_rfc3339();
                    let current = current.clone();
                    append_event(state, &current, "running", "execution_started");
                }
                Ok(json!(true))
            })?;
        Ok(value == json!(true))
    }
    fn finish(
        &self,
        principal: &Principal,
        run_id: &str,
        status: RunStatus,
        answer: Option<String>,
        reason: &str,
    ) -> Result<Run> {
        let result = self
            .repository
            .transact_execution(principal, run_id, |state| {
                let current = state.runs.get_mut(run_id).ok_or(KeystoneError::NotFound)?;
                if current.status.is_terminal() {
                    return Ok(serde_json::to_value(current)?);
                }
                let investigation_id = current.investigation_id.clone();
                current.status = status;
                current.answer = answer.clone();
                current.updated_at = chrono::Utc::now().to_rfc3339();
                let current = current.clone();
                if status == RunStatus::Completed {
                    let node = state.node(&current.node_id, current.prompt_version)?;
                    let export = ParentExport::from_completed(
                        &state.investigations[&investigation_id],
                        node,
                        &current,
                        state
                            .evidence
                            .values()
                            .filter(|e| e.run_id == current.id && e.node_id == current.node_id)
                            .map(|e| e.id.clone())
                            .collect(),
                    )?;
                    // The first committed export of a node version is immutable;
                    // New completed attempts require a new node version.
                    state.exports.entry(node.version_key()).or_insert(export);
                }
                for tool in state
                    .tools
                    .values_mut()
                    .filter(|t| t.run_id == run_id && t.status == "running")
                {
                    tool.status = match status {
                        RunStatus::Cancelled => "cancelled",
                        RunStatus::Interrupted => "interrupted",
                        _ => "failed",
                    }
                    .into();
                    tool.ended_at = Some(current.updated_at.clone());
                }
                append_event(
                    state,
                    &current,
                    match status {
                        RunStatus::Completed => "completed",
                        RunStatus::Cancelled => "cancelled",
                        RunStatus::Interrupted => "interrupted",
                        _ => "failed",
                    },
                    reason,
                );
                Ok(serde_json::to_value(current)?)
            })
            .and_then(|value| serde_json::from_value::<Run>(value).map_err(KeystoneError::from));
        if let Ok(run) = &result {
            let mut active = self.active.lock().map_err(|_| KeystoneError::Conflict)?;
            let key = (run.investigation_id.clone(), run.node_id.clone());
            // A claimed entry stays until its `AdmissionClaim` is dropped.
            if active
                .get(&key)
                .is_some_and(|entry| entry.run_id == run.id && !entry.executing)
            {
                active.remove(&key);
            }
        }
        result
    }
}

/// Retain a prefix of returned rows, without editing individual row fields. The
/// full returned count and exact retained bytes make truncation explicit. This
/// does not claim deterministic sample membership or a scan-cost budget.
fn bounded_sample(
    result: serde_json::Value,
    dataset: &str,
    scope: &ScopeVersion,
    limit: u16,
    budget: usize,
) -> Result<(serde_json::Value, u64, bool)> {
    let invalid = || KeystoneError::Invalid("invalid scoped sample result".into());
    if result["dataset"] != dataset
        || result["start"] != scope.absolute_start
        || result["end"] != scope.absolute_end
    {
        return Err(invalid());
    }
    let rows = result["rows"].as_array().ok_or_else(invalid)?;
    let returned = result["rowCount"].as_u64().ok_or_else(invalid)?;
    if returned != rows.len() as u64
        || returned > u64::from(limit)
        || rows.iter().any(|row| !row.is_object())
    {
        return Err(invalid());
    }
    let mut sample = json!({"dataset":dataset,"start":scope.absolute_start,"end":scope.absolute_end,
        "requestedRows":limit,"returnedRows":returned,"retainedRows":0,"rows":[],"truncated":false,
        "sampleLimitReached":returned==u64::from(limit),"coverage":"bounded_sample_only"});
    let mut retained = 0;
    for row in rows {
        sample["rows"]
            .as_array_mut()
            .ok_or_else(invalid)?
            .push(row.clone());
        sample["retainedRows"] = json!(retained + 1);
        if serde_json::to_vec(&sample)?.len().saturating_add(8) > budget {
            sample["rows"].as_array_mut().ok_or_else(invalid)?.pop();
            sample["retainedRows"] = json!(retained);
            break;
        }
        retained += 1;
    }
    let truncated = retained < returned;
    sample["truncated"] = json!(truncated);
    if serde_json::to_vec(&sample)?.len() > budget {
        return Err(KeystoneError::Invalid(
            "sample metadata exceeds context budget".into(),
        ));
    }
    Ok((sample, retained, truncated))
}

fn append_event(state: &mut RepositoryState, run: &Run, kind: &str, reason: &str) {
    let events = state.events.entry(run.id.clone()).or_default();
    events.push(Event {
        run_id: run.id.clone(),
        node_id: run.node_id.clone(),
        sequence: events.len() as u64 + 1,
        timestamp: chrono::Utc::now().to_rfc3339(),
        schema_version: SCHEMA_VERSION,
        kind: kind.into(),
        payload: json!({"reason":reason}),
    });
}
struct ExecutionGuard<'a> {
    coordinator: &'a Coordinator,
    principal: Principal,
    run_id: String,
    cancel: CancellationToken,
}
impl Drop for ExecutionGuard<'_> {
    fn drop(&mut self) {
        self.cancel.cancel();
        let _ = self.coordinator.finish(
            &self.principal,
            &self.run_id,
            RunStatus::Interrupted,
            None,
            "local_execution_dropped",
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keystone::{
        providers::{ModelProposal, ProviderError},
        tools::{ToolError, UnavailableExecutor},
    };
    use async_trait::async_trait;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    struct Auth(Arc<AtomicBool>);
    impl GrantAuthorizer for Auth {
        fn authorize(&self, _: &RunGrant, _: &ScopeVersion) -> std::result::Result<(), ToolError> {
            if self.0.load(Ordering::SeqCst) {
                Ok(())
            } else {
                Err(ToolError::Unauthorized)
            }
        }
    }
    struct Probe {
        calls: AtomicUsize,
        live: Arc<AtomicUsize>,
        outgoing: Mutex<Vec<String>>,
        answer: Mutex<String>,
        blocked: AtomicBool,
        release: CancellationToken,
        revoke: Option<Arc<AtomicBool>>,
    }
    impl Probe {
        fn new() -> Self {
            Self {
                calls: AtomicUsize::new(0),
                live: Arc::new(AtomicUsize::new(0)),
                outgoing: Mutex::new(vec![]),
                answer: Mutex::new("own answer".into()),
                blocked: AtomicBool::new(false),
                release: CancellationToken::new(),
                revoke: None,
            }
        }
    }
    struct LiveGuard(Arc<AtomicUsize>);
    impl Drop for LiveGuard {
        fn drop(&mut self) {
            self.0.fetch_sub(1, Ordering::SeqCst);
        }
    }
    #[async_trait]
    impl ModelProvider for Probe {
        async fn propose(
            &self,
            context: &FrozenProviderContext,
        ) -> std::result::Result<ModelProposal, ProviderError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.live.fetch_add(1, Ordering::SeqCst);
            let _live = LiveGuard(self.live.clone());
            self.outgoing
                .lock()
                .unwrap()
                .push(context.serialized().into());
            if self.blocked.load(Ordering::SeqCst) {
                self.release.cancelled().await;
            }
            if let Some(revoke) = &self.revoke {
                revoke.store(false, Ordering::SeqCst);
            }
            Ok(ModelProposal {
                explanation: self.answer.lock().unwrap().clone(),
            })
        }
    }
    fn setup() -> (
        tempfile::TempDir,
        Arc<NativeRepository>,
        Principal,
        Node,
        StartRun,
    ) {
        let directory = tempfile::tempdir().unwrap();
        let repo = Arc::new(NativeRepository::open(directory.path()).unwrap());
        let (principal, inv, node) = crate::keystone::context::tests::fixture();
        repo.create(
            &principal,
            inv,
            node.clone(),
            IdempotencyRequest {
                key: "create".into(),
                fingerprint: "create-fixture".into(),
            },
        )
        .unwrap();
        let request = StartRun {
            principal: principal.clone(),
            grant: RunGrant {
                principal: principal.clone(),
                credential_id: "synthetic-credential-reference".into(),
                expires_at: chrono::Utc::now().timestamp() + 3600,
            },
            authorization_revision: "auth-v1".into(),
            investigation_id: "inv1".into(),
            node_id: node.id.clone(),
            node_version: 1,
            expected_revision: 0,
            idempotency_key: "start-P".into(),
            selected_evidence_ids: vec![],
            scope_change_reviewed: false,
            provider_config_revision: 1,
        };
        (directory, repo, principal, node, request)
    }
    fn engine(
        repo: Arc<NativeRepository>,
        probe: Arc<Probe>,
        allowed: Arc<AtomicBool>,
    ) -> Coordinator {
        Coordinator::new(
            repo,
            probe,
            Arc::new(Auth(allowed)),
            Arc::new(UnavailableExecutor),
        )
    }
    fn latest_request(
        repo: &NativeRepository,
        base: &StartRun,
        node: &Node,
        key: &str,
    ) -> StartRun {
        let mut request = base.clone();
        request.node_id = node.id.clone();
        request.node_version = node.version;
        request.idempotency_key = key.into();
        request.expected_revision =
            repo.snapshot().unwrap().investigations[&node.investigation_id].semantic_revision;
        request
    }
    fn child(
        repo: &NativeRepository,
        principal: &Principal,
        parent: &Node,
        id: &str,
        prompt: &str,
    ) -> Node {
        let mut node = parent.clone();
        node.id = id.into();
        node.parent = Some(ParentReference {
            node_id: parent.id.clone(),
            version: parent.version,
        });
        node.prompt = prompt.into();
        node.selected_run_id = None;
        node.context_manifest_id = None;
        let revision =
            repo.snapshot().unwrap().investigations[&node.investigation_id].semantic_revision;
        repo.transact(
            principal,
            &node.investigation_id,
            revision,
            RevisionKind::Semantic,
            None,
            |state| {
                state.nodes.insert(node.version_key(), node.clone());
                Ok(json!({}))
            },
        )
        .unwrap();
        node
    }
    fn terminal_count(repo: &NativeRepository, id: &str) -> usize {
        repo.snapshot().unwrap().events[id]
            .iter()
            .filter(|event| {
                matches!(
                    event.kind.as_str(),
                    "completed" | "cancelled" | "failed" | "interrupted"
                )
            })
            .count()
    }

    #[tokio::test]
    async fn actual_outgoing_context_excludes_sibling_and_recursive_ancestor() {
        let (_dir, repo, principal, p, base) = setup();
        let probe = Arc::new(Probe::new());
        let coordinator = engine(repo.clone(), probe.clone(), Arc::new(AtomicBool::new(true)));
        let p_run = coordinator.begin(&base).unwrap();
        coordinator.execute(&principal, &p_run.id).await.unwrap();
        let a = child(&repo, &principal, &p, "A", "A own prompt");
        let b = child(&repo, &principal, &p, "B", "sibling_B_sentinel");
        let b_run = coordinator
            .begin(&latest_request(&repo, &base, &b, "start-B"))
            .unwrap();
        coordinator.execute(&principal, &b_run.id).await.unwrap();
        *probe.answer.lock().unwrap() = "A own answer".into();
        let a_run = coordinator
            .begin(&latest_request(&repo, &base, &a, "start-A"))
            .unwrap();
        coordinator.execute(&principal, &a_run.id).await.unwrap();
        let c = child(&repo, &principal, &a, "C", "C own prompt");
        let c_run = coordinator
            .begin(&latest_request(&repo, &base, &c, "start-C"))
            .unwrap();
        coordinator.execute(&principal, &c_run.id).await.unwrap();
        let outgoing = probe.outgoing.lock().unwrap();
        let c_package = outgoing.last().unwrap();
        assert!(c_package.contains("A own prompt"));
        assert!(c_package.contains("A own answer"));
        assert!(!c_package.contains("hidden_P_sentinel"));
        assert!(!c_package.contains("sibling_B_sentinel"));
        assert!(c_package.contains("2026-09-01T00:00:00Z"));
        assert!(c_package.contains("2026-10-01T00:00:00Z"));
        assert!(!c_package.contains("synthetic-credential-reference"));
        for excluded in ["tenantId", "ownerId", "approvedBy", "tenant1", "owner1"] {
            assert!(
                !c_package.contains(excluded),
                "outbound identity leak: {excluded}"
            );
        }
        assert_eq!(
            c_package,
            std::str::from_utf8(
                &repo.snapshot().unwrap().contexts[&c_run.context_manifest_id].bytes
            )
            .unwrap()
        );
        assert_eq!(repo.snapshot().unwrap().runs.len(), 4);
    }

    #[tokio::test]
    async fn same_node_conflicts_replay_survives_restart_without_dispatch() {
        let (dir, repo, principal, p, base) = setup();
        let probe = Arc::new(Probe::new());
        let coordinator = engine(repo.clone(), probe.clone(), Arc::new(AtomicBool::new(true)));
        let run = coordinator.begin(&base).unwrap();
        assert_eq!(coordinator.begin(&base).unwrap().id, run.id);
        let another = latest_request(&repo, &base, &p, "explicit-new-attempt");
        assert!(matches!(
            coordinator.begin(&another),
            Err(KeystoneError::Conflict)
        ));
        drop(coordinator);
        drop(repo);
        let reopened = Arc::new(NativeRepository::open(dir.path()).unwrap());
        let coordinator = engine(
            reopened.clone(),
            probe.clone(),
            Arc::new(AtomicBool::new(true)),
        );
        let mut refreshed = base.clone();
        refreshed.grant.expires_at += 300;
        refreshed.authorization_revision = "refreshed-auth-v2".into();
        let replay = coordinator.begin(&refreshed).unwrap();
        assert_eq!(replay.id, run.id);
        assert_eq!(replay.status, RunStatus::Interrupted);
        assert_eq!(
            coordinator
                .execute(&principal, &run.id)
                .await
                .unwrap()
                .status,
            RunStatus::Interrupted
        );
        assert_eq!(probe.calls.load(Ordering::SeqCst), 0);
        assert_eq!(terminal_count(&reopened, &run.id), 1);
    }

    #[tokio::test]
    async fn revocation_before_dispatch_and_after_step_suppresses_answer() {
        for during in [false, true] {
            let (_dir, repo, principal, _p, base) = setup();
            let allowed = Arc::new(AtomicBool::new(true));
            let mut probe = Probe::new();
            if during {
                probe.revoke = Some(allowed.clone());
            }
            let probe = Arc::new(probe);
            let coordinator = engine(repo.clone(), probe.clone(), allowed.clone());
            let run = coordinator.begin(&base).unwrap();
            if !during {
                allowed.store(false, Ordering::SeqCst);
            }
            let result = coordinator.execute(&principal, &run.id).await.unwrap();
            assert_eq!(result.status, RunStatus::Failed);
            assert!(result.answer.is_none());
            assert_eq!(probe.calls.load(Ordering::SeqCst), usize::from(during));
            assert_eq!(terminal_count(&repo, &run.id), 1);
            assert!(repo.snapshot().unwrap().exports.is_empty());
        }
        let (_dir, repo, _principal, _p, mut base) = setup();
        let probe = Arc::new(Probe::new());
        let coordinator = engine(repo, probe.clone(), Arc::new(AtomicBool::new(true)));
        base.principal.owner_id = "different-principal".into();
        assert!(matches!(
            coordinator.begin(&base),
            Err(KeystoneError::Forbidden)
        ));
        base.principal = base.grant.principal.clone();
        base.grant.expires_at = 0;
        assert!(matches!(
            coordinator.begin(&base),
            Err(KeystoneError::Forbidden)
        ));
        assert_eq!(probe.calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn completion_cancel_race_has_one_terminal_and_drops_nested_future() {
        let (_dir, repo, principal, _p, base) = setup();
        let probe = Arc::new(Probe::new());
        probe.blocked.store(true, Ordering::SeqCst);
        let coordinator = engine(repo.clone(), probe.clone(), Arc::new(AtomicBool::new(true)));
        let run = coordinator.begin(&base).unwrap();
        let stop = async {
            while probe.live.load(Ordering::SeqCst) == 0 {
                tokio::task::yield_now().await;
            }
            probe.release.cancel();
            coordinator.cancel(&principal, &run.id).unwrap();
        };
        let (result, ()) = tokio::join!(coordinator.execute(&principal, &run.id), stop);
        assert!(result.unwrap().status.is_terminal());
        assert_eq!(terminal_count(&repo, &run.id), 1);
        assert_eq!(probe.live.load(Ordering::SeqCst), 0);
        assert_eq!(coordinator.permits.available_permits(), 4);
        let again = coordinator.cancel(&principal, &run.id).unwrap();
        assert!(again.status.is_terminal());
        assert_eq!(terminal_count(&repo, &run.id), 1);
        assert!(coordinator.active.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn rejected_duplicate_or_foreign_execute_never_terminates_owned_run() {
        let (_dir, repo, principal, _p, base) = setup();
        let probe = Arc::new(Probe::new());
        probe.blocked.store(true, Ordering::SeqCst);
        let coordinator = engine(repo.clone(), probe.clone(), Arc::new(AtomicBool::new(true)));
        let run = coordinator.begin(&base).unwrap();
        let mut owned = Box::pin(coordinator.execute(&principal, &run.id));
        while probe.live.load(Ordering::SeqCst) == 0 {
            tokio::select! {biased; _=&mut owned=>panic!("blocked provider unexpectedly finished"), _=tokio::task::yield_now()=>{}}
        }
        assert!(matches!(
            coordinator.execute(&principal, &run.id).await,
            Err(KeystoneError::Conflict)
        ));
        let mut foreign = principal.clone();
        foreign.owner_id = "different-principal".into();
        assert!(coordinator.execute(&foreign, &run.id).await.is_err());
        let state = repo.snapshot().unwrap();
        assert_eq!(state.runs[&run.id].status, RunStatus::Running);
        assert_eq!(terminal_count(&repo, &run.id), 0);
        assert!(coordinator.run_uses_grant(&run.id, &base.grant.credential_id));
        probe.release.cancel();
        assert_eq!(owned.await.unwrap().status, RunStatus::Completed);
        assert_eq!(terminal_count(&repo, &run.id), 1);
        assert!(coordinator.active.lock().unwrap().is_empty());
        assert_eq!(coordinator.permits.available_permits(), 4);
    }

    #[tokio::test]
    async fn global_four_allows_siblings_and_cancellation_releases_reservations() {
        let (_dir, repo, principal, p, base) = setup();
        let probe = Arc::new(Probe::new());
        let coordinator = engine(repo.clone(), probe.clone(), Arc::new(AtomicBool::new(true)));
        let parent = coordinator.begin(&base).unwrap();
        coordinator.execute(&principal, &parent.id).await.unwrap();
        probe.blocked.store(true, Ordering::SeqCst);
        let mut runs = vec![];
        for i in 0..5 {
            let node = child(
                &repo,
                &principal,
                &p,
                &format!("child{i}"),
                "own child prompt",
            );
            runs.push(
                coordinator
                    .begin(&latest_request(
                        &repo,
                        &base,
                        &node,
                        &format!("start-child{i}"),
                    ))
                    .unwrap(),
            );
        }
        let stop = async {
            while probe.live.load(Ordering::SeqCst) < 4 {
                tokio::task::yield_now().await;
            }
            assert_eq!(probe.live.load(Ordering::SeqCst), 4);
            assert_eq!(coordinator.permits.available_permits(), 0);
            for run in &runs {
                coordinator.cancel(&principal, &run.id).unwrap();
            }
        };
        let (a, b, c, d, e, ()) = tokio::join!(
            coordinator.execute(&principal, &runs[0].id),
            coordinator.execute(&principal, &runs[1].id),
            coordinator.execute(&principal, &runs[2].id),
            coordinator.execute(&principal, &runs[3].id),
            coordinator.execute(&principal, &runs[4].id),
            stop
        );
        for result in [a, b, c, d, e] {
            assert_eq!(result.unwrap().status, RunStatus::Cancelled);
        }
        assert_eq!(probe.live.load(Ordering::SeqCst), 0);
        assert_eq!(coordinator.permits.available_permits(), 4);
        assert!(coordinator.active.lock().unwrap().is_empty());
        for run in runs {
            assert_eq!(terminal_count(&repo, &run.id), 1);
        }
    }

    #[tokio::test(start_paused = true)]
    async fn deadline_and_future_drop_release_bounded_work() {
        let (_dir, repo, principal, p, base) = setup();
        let probe = Arc::new(Probe::new());
        probe.blocked.store(true, Ordering::SeqCst);
        let mut coordinator = engine(repo.clone(), probe.clone(), Arc::new(AtomicBool::new(true)));
        coordinator.deadline = Duration::from_secs(1);
        let run = coordinator.begin(&base).unwrap();
        assert_eq!(
            coordinator
                .execute(&principal, &run.id)
                .await
                .unwrap()
                .status,
            RunStatus::Failed
        );
        assert_eq!(probe.live.load(Ordering::SeqCst), 0);
        assert_eq!(coordinator.permits.available_permits(), 4);
        let retry = coordinator
            .begin(&latest_request(&repo, &base, &p, "explicit-retry"))
            .unwrap();
        assert_eq!(retry.attempt, 2);
        let mut call = Box::pin(coordinator.execute(&principal, &retry.id));
        tokio::select! {biased; _=&mut call=>panic!("pending provider unexpectedly completed"), _=tokio::task::yield_now()=>{}}
        drop(call);
        assert_eq!(probe.live.load(Ordering::SeqCst), 0);
        assert_eq!(coordinator.permits.available_permits(), 4);
        assert_eq!(
            repo.snapshot().unwrap().runs[&retry.id].status,
            RunStatus::Interrupted
        );
        assert_eq!(terminal_count(&repo, &retry.id), 1);
    }

    #[tokio::test]
    async fn explicit_attempt_preserves_committed_parent_export() {
        let (_dir, repo, principal, p, base) = setup();
        let probe = Arc::new(Probe::new());
        let coordinator = engine(repo.clone(), probe.clone(), Arc::new(AtomicBool::new(true)));
        let first = coordinator.begin(&base).unwrap();
        coordinator.execute(&principal, &first.id).await.unwrap();
        let original = repo.snapshot().unwrap().exports[&p.version_key()].clone();
        *probe.answer.lock().unwrap() = "new attempt answer".into();
        assert!(matches!(
            coordinator.begin(&latest_request(&repo, &base, &p, "new-explicit-attempt")),
            Err(KeystoneError::Conflict)
        ));
        let mut new_version = p.clone();
        new_version.version = 2;
        new_version.prompt = "new immutable version".into();
        new_version.selected_run_id = None;
        new_version.context_manifest_id = None;
        let revision =
            repo.snapshot().unwrap().investigations[&p.investigation_id].semantic_revision;
        repo.transact(
            &principal,
            &p.investigation_id,
            revision,
            RevisionKind::Semantic,
            None,
            |state| {
                state
                    .nodes
                    .insert(new_version.version_key(), new_version.clone());
                Ok(json!({}))
            },
        )
        .unwrap();
        let retry = coordinator
            .begin(&latest_request(
                &repo,
                &base,
                &new_version,
                "new-explicit-version",
            ))
            .unwrap();
        assert_eq!(retry.attempt, 2);
        assert_eq!(
            coordinator
                .execute(&principal, &retry.id)
                .await
                .unwrap()
                .status,
            RunStatus::Completed
        );
        assert_eq!(repo.snapshot().unwrap().exports[&p.version_key()], original);
    }

    #[tokio::test]
    async fn accepted_run_reuses_preview_pin_and_rejects_changed_selection_or_review() {
        let (_dir, repo, principal, p, base) = setup();
        let probe = Arc::new(Probe::new());
        let coordinator = engine(repo.clone(), probe.clone(), Arc::new(AtomicBool::new(true)));
        let root = coordinator.begin(&base).unwrap();
        coordinator.execute(&principal, &root.id).await.unwrap();
        let mut node = p.clone();
        node.id = "preview-child".into();
        node.parent = Some(ParentReference {
            node_id: p.id.clone(),
            version: p.version,
        });
        node.prompt = "previewed prompt".into();
        node.selected_run_id = None;
        node.context_manifest_id = None;
        let snapshot = repo.snapshot().unwrap();
        let preview = build_context_authorized(
            &principal,
            &snapshot.investigations[&p.investigation_id],
            &node,
            Some(&snapshot.exports[&p.version_key()]),
            &[],
            false,
            |_| true,
            |_| true,
        )
        .unwrap();
        node.context_manifest_id = Some(preview.manifest.id.clone());
        repo.transact(
            &principal,
            &p.investigation_id,
            snapshot.investigations[&p.investigation_id].semantic_revision,
            RevisionKind::Semantic,
            None,
            |state| {
                state
                    .contexts
                    .insert(preview.manifest.id.clone(), preview.clone());
                state.nodes.insert(node.version_key(), node.clone());
                Ok(json!({}))
            },
        )
        .unwrap();
        let count = repo.snapshot().unwrap().contexts.len();
        let request = latest_request(&repo, &base, &node, "start-preview");
        let mut selection = request.clone();
        selection.selected_evidence_ids = vec!["unpreviewed-evidence".into()];
        assert!(matches!(
            coordinator.begin(&selection),
            Err(KeystoneError::Conflict)
        ));
        let mut review = request.clone();
        review.scope_change_reviewed = true;
        assert!(matches!(
            coordinator.begin(&review),
            Err(KeystoneError::Conflict)
        ));
        let run = coordinator.begin(&request).unwrap();
        assert_eq!(run.context_manifest_id, preview.manifest.id);
        assert_eq!(run.context_hash, preview.hash);
        assert_eq!(repo.snapshot().unwrap().contexts.len(), count);
        assert_eq!(
            repo.snapshot().unwrap().contexts[&run.context_manifest_id],
            preview
        );
        assert_eq!(
            repo.snapshot()
                .unwrap()
                .node(&node.id, node.version)
                .unwrap()
                .context_manifest_id
                .as_ref(),
            Some(&run.context_manifest_id)
        );
        coordinator.execute(&principal, &run.id).await.unwrap();
        assert_eq!(
            probe.outgoing.lock().unwrap().last().unwrap().as_bytes(),
            preview.bytes
        );
    }
    struct ScopedReads {
        repo: Arc<NativeRepository>,
        calls: AtomicUsize,
        grants: Mutex<Vec<Principal>>,
        operations: Mutex<Vec<ReadOperation>>,
        live: Arc<AtomicUsize>,
        blocked: bool,
        fail: bool,
        row_bytes: usize,
        revoke: Option<Arc<AtomicBool>>,
    }
    impl ScopedReads {
        fn new(repo: Arc<NativeRepository>) -> Self {
            Self {
                repo,
                calls: AtomicUsize::new(0),
                grants: Mutex::new(vec![]),
                operations: Mutex::new(vec![]),
                live: Arc::new(AtomicUsize::new(0)),
                blocked: false,
                fail: false,
                row_bytes: 0,
                revoke: None,
            }
        }
    }
    #[async_trait]
    impl ReadExecutor for ScopedReads {
        async fn execute(
            &self,
            grant: &RunGrant,
            _: &ScopeVersion,
            operation: &ReadOperation,
            _: CancellationToken,
        ) -> std::result::Result<serde_json::Value, ToolError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.live.fetch_add(1, Ordering::SeqCst);
            let _guard = LiveGuard(self.live.clone());
            assert!(
                self.repo
                    .snapshot()
                    .unwrap()
                    .tools
                    .values()
                    .any(|t| t.status == "running"
                        && t.arguments == serde_json::to_value(operation).unwrap())
            );
            self.grants.lock().unwrap().push(grant.principal.clone());
            self.operations.lock().unwrap().push(operation.clone());
            if self.blocked {
                std::future::pending::<()>().await;
            }
            if self.fail {
                return Err(ToolError::Execution);
            }
            if let Some(revoke) = &self.revoke {
                revoke.store(false, Ordering::SeqCst);
            }
            match operation {
                ReadOperation::Sample {
                    dataset,
                    start,
                    end,
                    rows,
                } => {
                    assert_eq!(*rows, 25);
                    Ok(
                        json!({"dataset":dataset,"start":start,"end":end,"rowCount":2,"rows":[{"message":"FRESH_AUTHORIZED_TELEMETRY","padding":"x".repeat(self.row_bytes)},{"message":"SECOND_FRESH_ROW"}]}),
                    )
                }
                _ => Err(ToolError::Scope),
            }
        }
    }
    struct VersionedProbe {
        repo: Arc<NativeRepository>,
        probe: Arc<Probe>,
        tenant: String,
        revision: u64,
    }
    #[async_trait]
    impl ModelProvider for VersionedProbe {
        fn request_manifest(&self, context: &FrozenProviderContext) -> Option<serde_json::Value> {
            Some(
                json!({"endpoint":"https://synthetic.invalid/v1/responses", "body":{"model":"synthetic-generation-model", "instructions":"synthetic-system-instructions", "input":context.serialized()}}),
            )
        }
        async fn propose(
            &self,
            _: &FrozenProviderContext,
        ) -> std::result::Result<ModelProposal, ProviderError> {
            panic!("coordinator must pass trusted tenant and pinned provider revision")
        }
        async fn propose_versioned(
            &self,
            tenant: &str,
            revision: u64,
            context: &FrozenProviderContext,
        ) -> std::result::Result<ModelProposal, ProviderError> {
            assert_eq!(tenant, self.tenant);
            assert_eq!(revision, self.revision);
            let state = self.repo.snapshot().unwrap();
            let dispatch = state
                .artifacts
                .values()
                .find(|a| {
                    a.kind == "provider_dispatch_context_v1"
                        && a.payload["providerContextHash"] == context.hash()
                })
                .expect("exact provider bytes committed before dispatch");
            assert_eq!(dispatch.payload["providerContext"], context.serialized());
            assert_eq!(
                dispatch.payload["requestManifest"]["body"]["model"],
                "synthetic-generation-model"
            );
            assert_eq!(
                dispatch.payload["requestManifest"]["body"]["instructions"],
                "synthetic-system-instructions"
            );
            assert_eq!(
                dispatch.payload["requestBodyHash"],
                hash_bytes(
                    &serde_json::to_vec(&dispatch.payload["requestManifest"]["body"]).unwrap()
                )
            );
            assert_eq!(hash_bytes(context.serialized().as_bytes()), context.hash());
            assert!(state.tools.values().any(|t| t.status == "completed"));
            self.probe.propose(context).await
        }
    }
    #[tokio::test]
    async fn scoped_reads_are_durable_pinned_tenant_bound_exportable_and_idempotent() {
        let (_dir, repo, principal, parent, base) = setup();
        let old_probe = Arc::new(Probe::new());
        let text = engine(
            repo.clone(),
            old_probe.clone(),
            Arc::new(AtomicBool::new(true)),
        );
        let oldrun = text.begin(&base).unwrap();
        text.execute(&principal, &oldrun.id).await.unwrap();
        let direct = child(&repo, &principal, &parent, "A", "DIRECT_PARENT_PROMPT");
        *old_probe.answer.lock().unwrap() = "DIRECT_PARENT_ANSWER".into();
        let directrun = text
            .begin(&latest_request(&repo, &base, &direct, "start-A-read-test"))
            .unwrap();
        text.execute(&principal, &directrun.id).await.unwrap();
        let _sibling = child(&repo, &principal, &parent, "B", "SIBLING_SENTINEL");
        let child = child(&repo, &principal, &direct, "C", "CHILD_PROMPT");
        let reads = Arc::new(ScopedReads::new(repo.clone()));
        let probe = Arc::new(Probe::new());
        let routed = Arc::new(VersionedProbe {
            repo: repo.clone(),
            probe: probe.clone(),
            tenant: principal.tenant_id.clone(),
            revision: 1,
        });
        let coordinator = Coordinator::new_with_reads(
            repo.clone(),
            routed,
            Arc::new(Auth(Arc::new(AtomicBool::new(true)))),
            reads.clone(),
        );
        let request = latest_request(&repo, &base, &child, "start-C-read-test");
        let accepted = coordinator.begin(&request).unwrap();
        let pinned = repo.snapshot().unwrap().contexts[&accepted.context_manifest_id].clone();
        let layout_before =
            repo.snapshot().unwrap().investigations[&accepted.investigation_id].layout_revision;
        let completed = coordinator.execute(&principal, &accepted.id).await.unwrap();
        assert_eq!(completed.status, RunStatus::Completed);
        assert_eq!(completed.context_hash, pinned.hash);
        let state = repo.snapshot().unwrap();
        assert_eq!(state.contexts[&accepted.context_manifest_id], pinned);
        assert_eq!(
            state.investigations[&accepted.investigation_id].layout_revision,
            layout_before
        );
        assert_eq!(
            reads.grants.lock().unwrap().as_slice(),
            std::slice::from_ref(&principal)
        );
        let outgoing = probe.outgoing.lock().unwrap()[0].clone();
        for allowed in [
            "DIRECT_PARENT_PROMPT",
            "DIRECT_PARENT_ANSWER",
            "CHILD_PROMPT",
            "FRESH_AUTHORIZED_TELEMETRY",
            "bounded_sample_only",
        ] {
            assert!(outgoing.contains(allowed));
        }
        for forbidden in [
            "hidden_P_sentinel",
            "SIBLING_SENTINEL",
            "tenantId",
            "ownerId",
            "approvedBy",
            "credential",
            "previous_response_id",
            "conversation",
        ] {
            assert!(!outgoing.contains(forbidden), "{forbidden}");
        }
        let export = &state.exports[&child.version_key()];
        assert_eq!(export.evidence_ids.len(), 1);
        let own_evidence = &state.evidence[&export.evidence_ids[0]];
        assert_eq!(own_evidence.node_id, child.id);
        assert!(own_evidence.summary.contains("FRESH_AUTHORIZED_TELEMETRY"));
        let artifact = state.artifacts[&own_evidence.artifact_id].clone();
        assert_eq!(
            artifact.result_hash,
            hash_bytes(&serde_json::to_vec(&artifact.payload).unwrap())
        );
        assert_eq!(artifact.row_count, 2);
        assert_eq!(
            state
                .artifacts
                .values()
                .filter(|a| a.run_id == accepted.id)
                .count(),
            2
        );
        let mut replay = request.clone();
        replay.grant.credential_id = "fresh-replay-grant".into();
        assert_eq!(coordinator.begin(&replay).unwrap().id, accepted.id);
        coordinator.execute(&principal, &accepted.id).await.unwrap();
        assert_eq!(reads.calls.load(Ordering::SeqCst), 1);
        assert_eq!(probe.calls.load(Ordering::SeqCst), 1);
        let revision = state.investigations[&accepted.investigation_id].semantic_revision;
        assert!(
            repo.transact(
                &principal,
                &accepted.investigation_id,
                revision,
                RevisionKind::Semantic,
                None,
                |state| {
                    state.artifacts.get_mut(&artifact.id).unwrap().payload =
                        json!({"mutated":true});
                    Ok(json!({}))
                }
            )
            .is_err()
        );
        let mut grandchild = child.clone();
        grandchild.id = "D".into();
        grandchild.prompt = "SELECTED_EVIDENCE_CHILD".into();
        grandchild.parent = Some(ParentReference {
            node_id: child.id.clone(),
            version: 1,
        });
        grandchild.selected_run_id = None;
        grandchild.context_manifest_id = None;
        let pin = build_context_authorized(
            &principal,
            &state.investigations[&accepted.investigation_id],
            &grandchild,
            Some(export),
            std::slice::from_ref(own_evidence),
            false,
            |_| true,
            |_| true,
        )
        .unwrap();
        assert!(
            String::from_utf8(pin.bytes)
                .unwrap()
                .contains("FRESH_AUTHORIZED_TELEMETRY")
        );
        assert_eq!(terminal_count(&repo, &accepted.id), 1);
    }
    #[tokio::test]
    async fn each_approved_dataset_is_sampled_and_oversized_rows_are_explicitly_omitted() {
        let (_dir, repo, principal, mut node, base) = setup();
        node.version = 2;
        node.scope.datasets = vec!["metrics".into(), "logs".into()];
        repo.transact(
            &principal,
            &node.investigation_id,
            0,
            RevisionKind::Semantic,
            None,
            |state| {
                state.nodes.insert(node.version_key(), node.clone());
                Ok(json!({}))
            },
        )
        .unwrap();
        let mut executor = ScopedReads::new(repo.clone());
        executor.row_bytes = 16_000;
        let reads = Arc::new(executor);
        let probe = Arc::new(Probe::new());
        let coordinator = Coordinator::new_with_reads(
            repo.clone(),
            probe.clone(),
            Arc::new(Auth(Arc::new(AtomicBool::new(true)))),
            reads.clone(),
        );
        let accepted = coordinator
            .begin(&latest_request(&repo, &base, &node, "two-dataset-run"))
            .unwrap();
        assert_eq!(
            coordinator
                .execute(&principal, &accepted.id)
                .await
                .unwrap()
                .status,
            RunStatus::Completed
        );
        let operations = reads.operations.lock().unwrap();
        assert_eq!(operations.len(), 2);
        for (operation, dataset) in operations.iter().zip(["logs", "metrics"]) {
            assert!(
                matches!(operation,ReadOperation::Sample{dataset:actual,start,end,rows:25} if actual==dataset && start==&node.scope.absolute_start && end==&node.scope.absolute_end)
            );
        }
        let state = repo.snapshot().unwrap();
        let samples: Vec<_> = state
            .artifacts
            .values()
            .filter(|a| a.kind == "scoped_sample_v1")
            .collect();
        assert_eq!(samples.len(), 2);
        for artifact in samples {
            assert!(artifact.truncated);
            assert_eq!(artifact.row_count, 0);
            assert_eq!(artifact.payload["returnedRows"], 2);
            assert_eq!(artifact.payload["retainedRows"], 0);
        }
        assert_eq!(state.exports[&node.version_key()].evidence_ids.len(), 2);
        assert!(
            probe.outgoing.lock().unwrap()[0].len() <= super::super::providers::MAX_CONTEXT_BYTES
        );
    }
    #[tokio::test]
    async fn failed_revoked_cancelled_and_dropped_reads_never_dispatch_generation() {
        for scenario in ["failed", "revoked", "cancelled", "dropped"] {
            let (_dir, repo, principal, _, base) = setup();
            let allowed = Arc::new(AtomicBool::new(true));
            let mut executor = ScopedReads::new(repo.clone());
            executor.fail = scenario == "failed";
            executor.blocked = matches!(scenario, "cancelled" | "dropped");
            executor.revoke = (scenario == "revoked").then(|| allowed.clone());
            let reads = Arc::new(executor);
            let probe = Arc::new(Probe::new());
            let coordinator = Coordinator::new_with_reads(
                repo.clone(),
                probe.clone(),
                Arc::new(Auth(allowed)),
                reads.clone(),
            );
            let run = coordinator.begin(&base).unwrap();
            if matches!(scenario, "cancelled" | "dropped") {
                let mut call = Box::pin(coordinator.execute(&principal, &run.id));
                loop {
                    tokio::select! { result=&mut call => panic!("read unexpectedly finished: {result:?}"), _=tokio::task::yield_now()=> { if reads.live.load(Ordering::SeqCst)==1 { break; } } }
                }
                if scenario == "cancelled" {
                    coordinator.cancel(&principal, &run.id).unwrap();
                    assert_eq!(call.await.unwrap().status, RunStatus::Cancelled);
                } else {
                    drop(call);
                    assert_eq!(
                        repo.snapshot().unwrap().runs[&run.id].status,
                        RunStatus::Interrupted
                    );
                }
            } else {
                assert_eq!(
                    coordinator
                        .execute(&principal, &run.id)
                        .await
                        .unwrap()
                        .status,
                    RunStatus::Failed
                );
            }
            assert_eq!(reads.live.load(Ordering::SeqCst), 0);
            assert_eq!(probe.calls.load(Ordering::SeqCst), 0);
            let state = repo.snapshot().unwrap();
            assert!(state.artifacts.is_empty());
            assert!(state.exports.is_empty());
            assert!(state.runs[&run.id].answer.is_none());
            assert!(
                state
                    .tools
                    .values()
                    .all(|t| t.status != "running" && t.ended_at.is_some())
            );
            assert_eq!(terminal_count(&repo, &run.id), 1);
        }
    }
    #[test]
    fn fresh_idempotency_grants_do_not_replace_original_work() {
        let (_dir, repo, _, _, base) = setup();
        let coordinator = engine(
            repo,
            Arc::new(Probe::new()),
            Arc::new(AtomicBool::new(true)),
        );
        let run = coordinator.begin(&base).unwrap();
        assert!(coordinator.run_uses_grant(&run.id, &base.grant.credential_id));
        let mut retry = base.clone();
        retry.grant.credential_id = "another-grant".into();
        assert_eq!(coordinator.begin(&retry).unwrap().id, run.id);
        assert!(!coordinator.run_uses_grant(&run.id, &retry.grant.credential_id));
        assert!(coordinator.run_uses_grant(&run.id, &base.grant.credential_id));
    }
    #[tokio::test]
    async fn revocation_after_fresh_generation_suppresses_answer_and_export() {
        let (_dir, repo, principal, _, base) = setup();
        let allowed = Arc::new(AtomicBool::new(true));
        let mut probe = Probe::new();
        probe.revoke = Some(allowed.clone());
        let probe = Arc::new(probe);
        let coordinator = Coordinator::new_with_reads(
            repo.clone(),
            probe.clone(),
            Arc::new(Auth(allowed)),
            Arc::new(ScopedReads::new(repo.clone())),
        );
        let run = coordinator.begin(&base).unwrap();
        assert_eq!(
            coordinator
                .execute(&principal, &run.id)
                .await
                .unwrap()
                .status,
            RunStatus::Failed
        );
        let state = repo.snapshot().unwrap();
        assert_eq!(probe.calls.load(Ordering::SeqCst), 1);
        assert_eq!(state.artifacts.len(), 2);
        assert!(state.runs[&run.id].answer.is_none());
        assert!(state.exports.is_empty());
        assert_eq!(terminal_count(&repo, &run.id), 1);
    }
    #[test]
    fn unsupported_saved_filters_are_rejected_before_live_run_acceptance() {
        let (_dir, repo, _, mut node, base) = setup();
        node.version = 2;
        node.scope
            .filters
            .insert("unsupported".into(), "value".into());
        repo.transact(
            &base.principal,
            &node.investigation_id,
            0,
            RevisionKind::Semantic,
            None,
            |state| {
                state.nodes.insert(node.version_key(), node.clone());
                Ok(json!({}))
            },
        )
        .unwrap();
        let coordinator = Coordinator::new_with_reads(
            repo.clone(),
            Arc::new(Probe::new()),
            Arc::new(Auth(Arc::new(AtomicBool::new(true)))),
            Arc::new(ScopedReads::new(repo.clone())),
        );
        let request = latest_request(&repo, &base, &node, "filtered-run");
        assert!(matches!(
            coordinator.begin(&request),
            Err(KeystoneError::Invalid(_))
        ));
        assert!(repo.snapshot().unwrap().runs.is_empty());
        assert!(repo.snapshot().unwrap().tools.is_empty());
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn sibling_progress_preserves_user_revisions_and_branch_cas_under_concurrency() {
        let (_dir, repo, principal, parent, base) = setup();
        let initial = engine(
            repo.clone(),
            Arc::new(Probe::new()),
            Arc::new(AtomicBool::new(true)),
        );
        let root = initial.begin(&base).unwrap();
        initial.execute(&principal, &root.id).await.unwrap();
        let a = child(&repo, &principal, &parent, "A", "A prompt");
        let b = child(&repo, &principal, &parent, "B", "B prompt");
        let probe = Arc::new(Probe::new());
        probe.blocked.store(true, Ordering::SeqCst);
        let coordinator = Arc::new(Coordinator::new_with_reads(
            repo.clone(),
            probe.clone(),
            Arc::new(Auth(Arc::new(AtomicBool::new(true)))),
            Arc::new(ScopedReads::new(repo.clone())),
        ));
        let arun = coordinator
            .begin(&latest_request(&repo, &base, &a, "revision-A"))
            .unwrap();
        let brun = coordinator
            .begin(&latest_request(&repo, &base, &b, "revision-B"))
            .unwrap();
        let accepted = repo.snapshot().unwrap();
        assert!(
            repo.transact_execution(&principal, &arun.id, |state| {
                state.runs.get_mut(&brun.id).unwrap().status = RunStatus::Failed;
                Ok(json!({}))
            })
            .is_err()
        );
        assert_eq!(repo.snapshot().unwrap(), accepted);
        let revision = accepted.investigations[&parent.investigation_id].semantic_revision;
        let mut tasks = Vec::new();
        for run in [&arun, &brun] {
            let coordinator = coordinator.clone();
            let principal = principal.clone();
            let id = run.id.clone();
            tasks.push(tokio::spawn(async move {
                coordinator.execute(&principal, &id).await
            }));
        }
        tokio::time::timeout(Duration::from_secs(5), async {
            while probe.live.load(Ordering::SeqCst) != 2 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let progressed = repo.snapshot().unwrap();
        assert!(progressed.generation > accepted.generation);
        assert_eq!(
            progressed.investigations[&parent.investigation_id],
            accepted.investigations[&parent.investigation_id]
        );
        let mut c = parent.clone();
        c.id = "C".into();
        c.prompt = "C new branch".into();
        c.parent = Some(ParentReference {
            node_id: parent.id.clone(),
            version: parent.version,
        });
        c.context_manifest_id = None;
        c.selected_run_id = None;
        repo.transact(
            &principal,
            &parent.investigation_id,
            revision,
            RevisionKind::Semantic,
            None,
            |state| {
                state.nodes.insert(c.version_key(), c.clone());
                Ok(json!({}))
            },
        )
        .expect("read/provider progress must not invalidate branch CAS");
        repo.transact(
            &principal,
            &parent.investigation_id,
            0,
            RevisionKind::Layout,
            None,
            |state| {
                state.layouts.insert(
                    parent.investigation_id.clone(),
                    CanvasLayout {
                        investigation_id: parent.investigation_id.clone(),
                        revision: 0,
                        nodes: BTreeMap::new(),
                    },
                );
                Ok(json!({}))
            },
        )
        .unwrap();
        let after_user_writes = repo.snapshot().unwrap();
        probe.release.cancel();
        for task in tasks {
            assert_eq!(
                tokio::time::timeout(Duration::from_secs(5), task)
                    .await
                    .unwrap()
                    .unwrap()
                    .unwrap()
                    .status,
                RunStatus::Completed
            );
        }
        let finished = repo.snapshot().unwrap();
        assert_eq!(finished.investigations, after_user_writes.investigations);
        assert_eq!(finished.layouts, after_user_writes.layouts);
        for run in [&arun, &brun] {
            assert_eq!(terminal_count(&repo, &run.id), 1);
        }
        assert_eq!(coordinator.permits.available_permits(), 4);
        assert!(coordinator.active.lock().unwrap().is_empty());
        let mut request = latest_request(&repo, &base, &c, "revision-C");
        request.expected_revision = revision + 1;
        let crun = coordinator
            .begin(&request)
            .expect("sibling completion must preserve client's expected semantic revision");
        assert_eq!(
            coordinator
                .execute(&principal, &crun.id)
                .await
                .unwrap()
                .status,
            RunStatus::Completed
        );
    }
    #[test]
    fn terminal_race_and_many_checkpoints_do_not_exhaust_revision_retries() {
        let (_dir, repo, principal, _, base) = setup();
        let coordinator = Arc::new(engine(
            repo.clone(),
            Arc::new(Probe::new()),
            Arc::new(AtomicBool::new(true)),
        ));
        let run = coordinator.begin(&base).unwrap();
        let accepted = repo.snapshot().unwrap();
        let barrier = Arc::new(std::sync::Barrier::new(5));
        let mut workers = Vec::new();
        for worker in 0..4 {
            let coordinator = coordinator.clone();
            let principal = principal.clone();
            let run = run.clone();
            let barrier = barrier.clone();
            workers.push(std::thread::spawn(move || {
                barrier.wait();
                for _ in 0..25 {
                    coordinator.mark_running(&principal, &run).unwrap();
                }
                coordinator
                    .finish(
                        &principal,
                        &run.id,
                        if worker % 2 == 0 {
                            RunStatus::Cancelled
                        } else {
                            RunStatus::Failed
                        },
                        None,
                        "concurrent_terminal",
                    )
                    .unwrap()
            }));
        }
        barrier.wait();
        let results: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect();
        assert!(results.iter().all(|result| result == &results[0]));
        let finished = repo.snapshot().unwrap();
        assert_eq!(finished.investigations, accepted.investigations);
        assert_eq!(terminal_count(&repo, &run.id), 1);
        assert!(coordinator.active.lock().unwrap().is_empty());
        assert_eq!(coordinator.permits.available_permits(), 4);
    }
    #[test]
    fn accepted_capacity_is_shared_per_tenant_and_cancellation_releases_slots() {
        let directory = tempfile::Builder::new()
            .prefix("keystone-fairness-")
            .tempdir_in("/dev/shm")
            .unwrap();
        let repo = Arc::new(NativeRepository::open(directory.path()).unwrap());
        let probe = Arc::new(Probe::new());
        let coordinator = engine(repo.clone(), probe.clone(), Arc::new(AtomicBool::new(true)));
        let prepare = |tenant: &str, owner: &str, index: usize| {
            let (mut principal, mut inv, mut node) = crate::keystone::context::tests::fixture();
            principal.tenant_id = tenant.into();
            principal.owner_id = owner.into();
            inv.id = format!("fairness-investigation-{index}");
            inv.tenant_id = tenant.into();
            inv.owner_id = owner.into();
            inv.root_node_id = format!("fairness-node-{index}");
            node.id = inv.root_node_id.clone();
            node.investigation_id = inv.id.clone();
            node.scope.approved_by = owner.into();
            repo.create(
                &principal,
                inv.clone(),
                node.clone(),
                IdempotencyRequest {
                    key: format!("create-fairness-{index}"),
                    fingerprint: format!("create-fairness-{index}"),
                },
            )
            .unwrap();
            StartRun {
                principal: principal.clone(),
                grant: RunGrant {
                    principal,
                    credential_id: format!("grant-fairness-{index}"),
                    expires_at: chrono::Utc::now().timestamp() + 3600,
                },
                authorization_revision: "auth-v1".into(),
                investigation_id: inv.id,
                node_id: node.id,
                node_version: 1,
                expected_revision: 0,
                idempotency_key: format!("run-fairness-{index}"),
                selected_evidence_ids: vec![],
                scope_change_reviewed: false,
                provider_config_revision: 1,
            }
        };
        let mut accepted = Vec::new();
        for index in 0..8 {
            let request = prepare(
                "tenant-one",
                if index % 2 == 0 { "owner-a" } else { "owner-b" },
                index,
            );
            let run = coordinator.begin(&request).unwrap();
            accepted.push((request, run));
        }
        let first_request = &accepted[0].0;
        let mut same_node = first_request.clone();
        same_node.idempotency_key = "same-node-at-capacity".into();
        assert!(matches!(
            coordinator.begin(&same_node),
            Err(KeystoneError::Conflict)
        ));
        assert_eq!(
            coordinator.begin(first_request).unwrap().id,
            accepted[0].1.id,
            "durable replay must work at capacity"
        );
        let blocked = prepare("tenant-one", "owner-c", 8);
        assert!(matches!(
            coordinator.begin(&blocked),
            Err(KeystoneError::RunCapacity)
        ));
        let other = prepare("tenant-two", "owner-d", 9);
        let other_run = coordinator
            .begin(&other)
            .expect("one tenant must leave queue capacity for another tenant");
        accepted.push((other, other_run));
        assert_eq!(probe.calls.load(Ordering::SeqCst), 0);
        assert_eq!(coordinator.permits.available_permits(), 4);
        coordinator
            .cancel(&accepted[0].0.principal, &accepted[0].1.id)
            .unwrap();
        let replacement = coordinator
            .begin(&blocked)
            .expect("cancellation must release the per-tenant reservation");
        accepted.push((blocked, replacement));
        for index in 10..17 {
            let request = prepare(
                "tenant-two",
                if index < 13 { "owner-d" } else { "owner-e" },
                index,
            );
            let run = coordinator.begin(&request).unwrap();
            accepted.push((request, run));
        }
        assert_eq!(coordinator.active.lock().unwrap().len(), 16);
        let third = prepare("tenant-three", "owner-f", 17);
        assert!(
            matches!(coordinator.begin(&third), Err(KeystoneError::RunCapacity)),
            "global capacity has its own typed error"
        );
        coordinator
            .cancel(&accepted[8].0.principal, &accepted[8].1.id)
            .unwrap();
        let third_run = coordinator
            .begin(&third)
            .expect("cancellation must release the global reservation");
        accepted.push((third, third_run));
        for (request, run) in accepted {
            coordinator.cancel(&request.principal, &run.id).unwrap();
            assert_eq!(terminal_count(&repo, &run.id), 1);
        }
        assert!(coordinator.active.lock().unwrap().is_empty());
        assert_eq!(coordinator.permits.available_permits(), 4);
        assert_eq!(probe.calls.load(Ordering::SeqCst), 0);
    }
    use crate::keystone::query_bridge::test_support::{
        ReadLog, TestQueryRuntime, pending_executor,
    };
    /// Child runs whose scoped reads use the production `ScopedQueryExecutor`
    /// on a test query runtime, over a source that never completes by itself.
    struct ReadHarness {
        _dir: tempfile::TempDir,
        repo: Arc<NativeRepository>,
        principal: Principal,
        base: StartRun,
        nodes: Vec<Node>,
        coordinator: Coordinator,
        runs: Vec<Run>,
        log: ReadLog,
        started: tokio::sync::mpsc::UnboundedReceiver<()>,
        runtime: TestQueryRuntime,
    }
    async fn read_harness(
        count: usize,
        gate: Option<std::sync::mpsc::Receiver<()>>,
    ) -> ReadHarness {
        let (dir, repo, principal, parent, base) = setup();
        let text = engine(
            repo.clone(),
            Arc::new(Probe::new()),
            Arc::new(AtomicBool::new(true)),
        );
        let root = text.begin(&base).unwrap();
        text.execute(&principal, &root.id).await.unwrap();
        let runtime = TestQueryRuntime::new();
        let (executor, log, started) = pending_executor(runtime.handle(), gate);
        let coordinator = Coordinator::new_with_reads(
            repo.clone(),
            Arc::new(Probe::new()),
            Arc::new(Auth(Arc::new(AtomicBool::new(true)))),
            Arc::new(executor),
        );
        let mut nodes = Vec::new();
        let mut runs = Vec::new();
        for i in 0..count {
            let node = child(
                &repo,
                &principal,
                &parent,
                &format!("read{i}"),
                "read prompt",
            );
            let request = latest_request(&repo, &base, &node, &format!("start-read{i}"));
            runs.push(coordinator.begin(&request).unwrap());
            nodes.push(node);
        }
        ReadHarness {
            _dir: dir,
            repo,
            principal,
            base,
            nodes,
            coordinator,
            runs,
            log,
            started,
            runtime,
        }
    }
    fn last_reason(repo: &NativeRepository, id: &str) -> String {
        repo.snapshot().unwrap().events[id].last().unwrap().payload["reason"]
            .as_str()
            .unwrap()
            .into()
    }
    /// Yields until `condition` holds. The real-clock bound is a failure bound,
    /// not a latency assertion, and yielding never lets a paused clock advance.
    async fn settle(what: &str, condition: impl Fn() -> bool) {
        let bound = std::time::Instant::now() + Duration::from_secs(5);
        while !condition() {
            assert!(std::time::Instant::now() < bound, "{what}");
            tokio::task::yield_now().await;
        }
    }
    fn entries(log: &ReadLog, kind: &str) -> usize {
        log.lock().unwrap().iter().filter(|e| **e == kind).count()
    }

    #[tokio::test]
    async fn cancel_drops_the_nested_query_source_before_its_permit_is_reused() {
        let ReadHarness {
            _dir,
            repo,
            principal,
            coordinator,
            runs,
            log,
            mut started,
            runtime,
            ..
        } = read_harness(5, None).await;
        let driver = async {
            for _ in 0..4 {
                started.recv().await.unwrap();
            }
            // Admission and execution are separate bounds: five accepted sibling
            // runs are claimed, four hold execution permits. (The owner's
            // retained-history reserve, not the 16-run admission cap, is what
            // limits this fixture's accepted reading runs.)
            assert_eq!(coordinator.permits.available_permits(), 0);
            assert_eq!(coordinator.active.lock().unwrap().len(), 5);
            assert_eq!(*log.lock().unwrap(), ["start"; 4]);
            // Cancelling a running claimed run only signals it; its execution
            // records the terminal.
            let signalled = coordinator.cancel(&principal, &runs[0].id).unwrap();
            assert_eq!(signalled.status, RunStatus::Running);
            assert_eq!(terminal_count(&repo, &runs[0].id), 0);
            // Run 4 gets run 0's permit only after run 0's source future has
            // been dropped on the query runtime.
            started.recv().await.unwrap();
            assert_eq!(
                *log.lock().unwrap(),
                ["start", "start", "start", "start", "drop", "start"]
            );
            for run in &runs[1..5] {
                coordinator.cancel(&principal, &run.id).unwrap();
            }
        };
        let (results, ()) = tokio::join!(
            futures::future::join_all(
                runs.iter()
                    .map(|run| coordinator.execute(&principal, &run.id))
            ),
            driver
        );
        for (run, result) in runs.iter().zip(results) {
            assert_eq!(result.unwrap().status, RunStatus::Cancelled);
            assert_eq!(terminal_count(&repo, &run.id), 1);
            assert_eq!(last_reason(&repo, &run.id), "cancelled");
        }
        // Each execution awaited its own sources before returning.
        assert_eq!((entries(&log, "start"), entries(&log, "drop")), (5, 5));
        assert_eq!(coordinator.permits.available_permits(), 4);
        assert!(coordinator.active.lock().unwrap().is_empty());
        settle("aborted reads must leave no query task", || {
            runtime.alive_tasks() == 0
        })
        .await;
    }

    #[tokio::test(start_paused = true)]
    async fn deadline_stops_the_nested_read_and_records_the_deadline_outcome() {
        let ReadHarness {
            _dir,
            repo,
            principal,
            mut coordinator,
            runs,
            log,
            runtime,
            ..
        } = read_harness(1, None).await;
        coordinator.deadline = Duration::from_secs(1);
        let done = AtomicBool::new(false);
        let execution = async {
            let result = coordinator.execute(&principal, &runs[0].id).await;
            done.store(true, Ordering::SeqCst);
            result
        };
        let driver = async {
            // Yielding keeps this runtime busy, so the paused clock moves only
            // when advanced here, after the read has started.
            settle("read must start", || entries(&log, "start") == 1).await;
            assert_eq!(terminal_count(&repo, &runs[0].id), 0);
            tokio::time::advance(Duration::from_secs(1)).await;
            settle("execution must finish", || done.load(Ordering::SeqCst)).await;
        };
        let (result, ()) = tokio::join!(execution, driver);
        assert_eq!(result.unwrap().status, RunStatus::Failed);
        assert_eq!(last_reason(&repo, &runs[0].id), "deadline_exceeded");
        assert_eq!(terminal_count(&repo, &runs[0].id), 1);
        // Stopped through the run's own token and unwound before the terminal.
        assert_eq!(*log.lock().unwrap(), ["start", "drop"]);
        assert_eq!(coordinator.permits.available_permits(), 4);
        assert!(coordinator.active.lock().unwrap().is_empty());
        let state = repo.snapshot().unwrap();
        assert!(state.tools.values().all(|t| t.status == "failed"));
        settle("timed-out read must leave no query task", || {
            runtime.alive_tasks() == 0
        })
        .await;
    }

    #[tokio::test]
    async fn unyielding_nested_read_stays_counted_after_a_teardown_pending_terminal() {
        let (release, gate) = std::sync::mpsc::channel();
        let ReadHarness {
            _dir,
            repo,
            principal,
            base,
            nodes,
            mut coordinator,
            runs,
            log,
            mut started,
            runtime,
        } = read_harness(1, Some(gate)).await;
        // The grace is meant to expire: the source blocks its query runtime
        // thread inside one poll until released below.
        coordinator.teardown_grace = Duration::from_millis(20);
        let driver = async {
            started.recv().await.unwrap();
            let signalled = coordinator.cancel(&principal, &runs[0].id).unwrap();
            assert_eq!(signalled.status, RunStatus::Running);
        };
        let (result, ()) = tokio::join!(coordinator.execute(&principal, &runs[0].id), driver);
        assert_eq!(result.unwrap().status, RunStatus::Cancelled);
        assert_eq!(terminal_count(&repo, &runs[0].id), 1);
        assert_eq!(
            last_reason(&repo, &runs[0].id),
            "cancelled_teardown_pending"
        );
        // The blocked task still holds the run's lease: its permit and admission
        // entry stay counted, so an explicit retry of this node must wait.
        assert_eq!(*log.lock().unwrap(), ["start"]);
        assert_eq!(coordinator.permits.available_permits(), 3);
        assert_eq!(coordinator.active.lock().unwrap().len(), 1);
        let retry = latest_request(&repo, &base, &nodes[0], "explicit-retry");
        assert!(matches!(
            coordinator.begin(&retry),
            Err(KeystoneError::Conflict)
        ));
        // A durable replay still resolves to the recorded terminal.
        let replay = latest_request(&repo, &base, &nodes[0], "start-read0");
        assert_eq!(coordinator.begin(&replay).unwrap().id, runs[0].id);
        release.send(()).unwrap();
        settle("unwound read must release its permit and admission", || {
            coordinator.permits.available_permits() == 4
                && coordinator.active.lock().unwrap().is_empty()
        })
        .await;
        assert_eq!(*log.lock().unwrap(), ["start", "drop"]);
        assert_eq!(coordinator.begin(&retry).unwrap().attempt, 2);
        assert_eq!(terminal_count(&repo, &runs[0].id), 1);
        settle("unwound read must leave no query task", || {
            runtime.alive_tasks() == 0
        })
        .await;
    }

    #[test]
    fn progress_events_record_emission_time_instead_of_queued_run_timestamp() {
        let (_, _, node) = crate::keystone::context::tests::fixture();
        let mut run = crate::keystone::context::tests::run(
            &node,
            "timestamp-run",
            RunStatus::Running,
            "answer",
        );
        run.updated_at = "2000-01-01T00:00:00Z".into();
        let mut state = RepositoryState::default();
        let before = chrono::Utc::now();
        append_event(&mut state, &run, "read_completed", "fresh_sample");
        let after = chrono::Utc::now();
        let emitted =
            chrono::DateTime::parse_from_rfc3339(&state.events[&run.id][0].timestamp).unwrap();
        assert!(emitted >= before && emitted <= after);
        assert_ne!(state.events[&run.id][0].timestamp, run.updated_at);
    }
}
