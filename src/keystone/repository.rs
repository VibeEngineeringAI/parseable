//! Local-only, single-coordinator repository. This is deliberately separate from legacy
//! Enterprise `.keystone` bytes and does not claim object-store CAS or distributed leases.
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{
    context::{PinnedContextRecord, hash_bytes},
    domain::*,
};

const MAX_STATE_BYTES: usize = 64 * 1024 * 1024;
const MAX_RECORDS: usize = 10_000;
/// Prototype capacity is bounded rather than pruning durable idempotency or accepted history.
/// Each owner has a fraction of the global budget, so a single owner cannot exhaust it.
pub const MAX_OWNER_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_OWNER_RECORDS: usize = 2_000;
pub const MAX_OWNER_INVESTIGATIONS: usize = 64;
/// Whole synchronous repository operations (scoped clones, validation, serialization and
/// fsyncs) run on at most this many blocking threads per repository, never on async workers.
/// Further callers wait asynchronously, before any of their work has started.
pub const BLOCKING_OPERATIONS: usize = 4;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IdempotencyRecord {
    pub investigation_id: String,
    pub tenant_id: String,
    pub owner_id: String,
    pub key: String,
    pub fingerprint: String,
    pub response: Value,
}
#[derive(Debug, Clone)]
pub struct IdempotencyRequest {
    pub key: String,
    pub fingerprint: String,
}
#[derive(Debug, Clone, Copy)]
pub enum RevisionKind {
    Semantic,
    Layout,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepositoryState {
    pub schema_version: u32,
    pub generation: u64,
    pub investigations: BTreeMap<String, Investigation>,
    pub nodes: BTreeMap<String, Node>,
    pub runs: BTreeMap<String, Run>,
    pub exports: BTreeMap<String, ParentExport>,
    pub contexts: BTreeMap<String, PinnedContextRecord>,
    pub artifacts: BTreeMap<String, Artifact>,
    pub evidence: BTreeMap<String, Evidence>,
    pub events: BTreeMap<String, Vec<Event>>,
    pub tools: BTreeMap<String, ToolInvocation>,
    pub layouts: BTreeMap<String, CanvasLayout>,
    pub idempotency: BTreeMap<String, IdempotencyRecord>,
}
pub type InvestigationSnapshot = RepositoryState;
impl Default for RepositoryState {
    fn default() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            generation: 0,
            investigations: BTreeMap::new(),
            nodes: BTreeMap::new(),
            runs: BTreeMap::new(),
            exports: BTreeMap::new(),
            contexts: BTreeMap::new(),
            artifacts: BTreeMap::new(),
            evidence: BTreeMap::new(),
            events: BTreeMap::new(),
            tools: BTreeMap::new(),
            layouts: BTreeMap::new(),
            idempotency: BTreeMap::new(),
        }
    }
}
impl RepositoryState {
    pub fn node(&self, id: &str, version: u64) -> Result<&Node> {
        self.nodes
            .get(&format!("{id}-v{version}"))
            .ok_or(KeystoneError::NotFound)
    }
    pub fn validate(&self) -> Result<()> {
        if self.schema_version != SCHEMA_VERSION {
            return Err(KeystoneError::Invalid("repository schema".into()));
        }
        if self.investigations.len() > MAX_RECORDS
            || self.nodes.len() > MAX_RECORDS
            || self.runs.len() > MAX_RECORDS
            || self.contexts.len() > MAX_RECORDS
            || self.artifacts.len() > MAX_RECORDS
            || self.evidence.len() > MAX_RECORDS
            || self.idempotency.len() > MAX_RECORDS
            || self.tools.len() > MAX_RECORDS
            || self.exports.len() > MAX_RECORDS
            || self.events.len() > MAX_RECORDS
        {
            return Err(KeystoneError::QuotaExceeded("global record budget".into()));
        }
        for (id, inv) in &self.investigations {
            inv.validate()?;
            if id != &inv.id {
                return Err(KeystoneError::Invalid("investigation key".into()));
            }
            let roots: Vec<_> = self
                .nodes
                .values()
                .filter(|n| n.investigation_id == *id && n.parent.is_none())
                .collect();
            if roots.is_empty() || roots.iter().any(|n| n.id != inv.root_node_id) {
                return Err(KeystoneError::Invalid("root binding".into()));
            }
            if self
                .nodes
                .values()
                .filter(|n| n.investigation_id == *id)
                .count()
                > MAX_NODES
            {
                return Err(KeystoneError::QuotaExceeded(
                    "investigation node budget".into(),
                ));
            }
        }
        for (key, node) in &self.nodes {
            node.validate()?;
            if key != &node.version_key()
                || !self.investigations.contains_key(&node.investigation_id)
            {
                return Err(KeystoneError::Invalid("node key/investigation".into()));
            }
            let mut cursor = node;
            let mut visited = std::collections::BTreeSet::new();
            while let Some(parent) = &cursor.parent {
                if !visited.insert(cursor.id.clone()) {
                    return Err(KeystoneError::Invalid("cycle".into()));
                }
                cursor = self.node(&parent.node_id, parent.version)?;
                if cursor.investigation_id != node.investigation_id {
                    return Err(KeystoneError::Invalid("cross-investigation parent".into()));
                }
            }
            if let Some(selected) = &node.selected_run_id {
                let run = self.runs.get(selected).ok_or(KeystoneError::NotFound)?;
                if run.node_id != node.id
                    || run.prompt_version != node.version
                    || run.investigation_id != node.investigation_id
                {
                    return Err(KeystoneError::Invalid("selected run binding".into()));
                }
            }
            if let Some(context_id) = &node.context_manifest_id {
                let context = self
                    .contexts
                    .get(context_id)
                    .ok_or(KeystoneError::NotFound)?;
                if context.manifest.node_id != node.id
                    || context.manifest.node_version != node.version
                    || context.manifest.investigation_id != node.investigation_id
                {
                    return Err(KeystoneError::Invalid("node context binding".into()));
                }
            }
        }
        let mut active = std::collections::BTreeSet::new();
        for (id, run) in &self.runs {
            validate_id(id)?;
            run.scope.validate()?;
            let node = self.node(&run.node_id, run.prompt_version)?;
            let pinned = self
                .contexts
                .get(&run.context_manifest_id)
                .ok_or(KeystoneError::NotFound)?;
            if id != &run.id
                || run.attempt == 0
                || node.investigation_id != run.investigation_id
                || node.scope != run.scope
                || run.context_hash != pinned.hash
                || pinned.manifest.node_id != run.node_id
                || pinned.manifest.node_version != run.prompt_version
                || pinned.manifest.scope != run.scope
                || node
                    .context_manifest_id
                    .as_ref()
                    .is_some_and(|id| id != &run.context_manifest_id)
            {
                return Err(KeystoneError::Invalid("run bindings".into()));
            }
            if !run.status.is_terminal() && !active.insert((&run.investigation_id, &run.node_id)) {
                return Err(KeystoneError::Conflict);
            }
            if let Some(answer) = &run.answer {
                bounded_text(answer, MAX_ANSWER_BYTES, "answer")?;
            }
            if run.status == RunStatus::Completed && run.answer.is_none() {
                return Err(KeystoneError::Invalid(
                    "completed run missing answer".into(),
                ));
            }
        }
        for (id, context) in &self.contexts {
            validate_id(id)?;
            context.verify()?;
            let manifest = &context.manifest;
            let node = self.node(&manifest.node_id, manifest.node_version)?;
            if manifest.id != *id
                || manifest.schema_version != SCHEMA_VERSION
                || manifest.context_policy != CONTEXT_POLICY
                || manifest.investigation_id != node.investigation_id
                || manifest.prompt != node.prompt
                || manifest.scope != node.scope
                || manifest.direct_parent != node.parent
            {
                return Err(KeystoneError::Invalid("context binding".into()));
            }
            match (&node.parent, &manifest.parent_export) {
                (None, None)
                    if manifest.evidence.is_empty() && manifest.parent_export_hash.is_none() => {}
                (Some(parent), Some(export)) => {
                    let committed = self
                        .exports
                        .get(&format!("{}-v{}", parent.node_id, parent.version))
                        .ok_or(KeystoneError::NotFound)?;
                    let mut selected = committed.clone();
                    selected.evidence_ids = export.evidence_ids.clone();
                    if &selected != export
                        || export
                            .evidence_ids
                            .iter()
                            .any(|id| !committed.evidence_ids.contains(id))
                        || manifest.parent_export_hash
                            != Some(hash_bytes(&serde_json::to_vec(export)?))
                    {
                        return Err(KeystoneError::Invalid("context export binding".into()));
                    }
                    for evidence in &manifest.evidence {
                        if self.evidence.get(&evidence.id) != Some(evidence)
                            || !export.evidence_ids.contains(&evidence.id)
                        {
                            return Err(KeystoneError::Invalid("context evidence binding".into()));
                        }
                    }
                    if manifest.evidence.len() != export.evidence_ids.len() {
                        return Err(KeystoneError::Invalid("context evidence mismatch".into()));
                    }
                }
                _ => return Err(KeystoneError::Invalid("context parent mismatch".into())),
            }
        }
        for (key, export) in &self.exports {
            let node = self.node(&export.node_id, export.node_version)?;
            let inv = self
                .investigations
                .get(&export.investigation_id)
                .ok_or(KeystoneError::NotFound)?;
            let run = self
                .runs
                .get(&export.run_id)
                .ok_or(KeystoneError::NotFound)?;
            let expected =
                ParentExport::from_completed(inv, node, run, export.evidence_ids.clone())?;
            if key != &node.version_key() || export != &expected {
                return Err(KeystoneError::Invalid("invalid parent export".into()));
            }
            for id in &export.evidence_ids {
                let evidence = self.evidence.get(id).ok_or(KeystoneError::NotFound)?;
                if evidence.node_id != node.id || evidence.run_id != run.id {
                    return Err(KeystoneError::Invalid("export evidence producer".into()));
                }
            }
        }
        for (id, artifact) in &self.artifacts {
            validate_id(id)?;
            let inv = self
                .investigations
                .get(&artifact.investigation_id)
                .ok_or(KeystoneError::NotFound)?;
            let run = self
                .runs
                .get(&artifact.run_id)
                .ok_or(KeystoneError::NotFound)?;
            validate_dependencies(&artifact.datasets, &artifact.scope)?;
            if id != &artifact.id
                || artifact.tenant_id != inv.tenant_id
                || artifact.owner_id != inv.owner_id
                || artifact.schema_version != SCHEMA_VERSION
                || run.investigation_id != inv.id
                || run.node_id != artifact.node_id
                || run.scope != artifact.scope
                || artifact.byte_count > MAX_ARTIFACT_BYTES as u64
                || serde_json::to_vec(&artifact.payload)?.len() > MAX_ARTIFACT_BYTES
                || artifact.result_hash != hash_bytes(&serde_json::to_vec(&artifact.payload)?)
            {
                return Err(KeystoneError::Invalid(
                    "artifact binding/byte budget/hash".into(),
                ));
            }
            if let Some(sql) = &artifact.executed_sql {
                bounded_text(sql, MAX_PROMPT_BYTES, "SQL")?;
            }
            if let Some(expiry) = &artifact.expires_at {
                chrono::DateTime::parse_from_rfc3339(expiry)
                    .map_err(|_| KeystoneError::Invalid("artifact expiry".into()))?;
            }
        }
        for (id, evidence) in &self.evidence {
            validate_id(id)?;
            bounded_text(&evidence.summary, 8192, "evidence summary")?;
            let artifact = self
                .artifacts
                .get(&evidence.artifact_id)
                .ok_or(KeystoneError::NotFound)?;
            if id != &evidence.id
                || evidence.investigation_id != artifact.investigation_id
                || evidence.run_id != artifact.run_id
                || evidence.node_id != artifact.node_id
                || evidence.tenant_id != artifact.tenant_id
                || evidence.owner_id != artifact.owner_id
                || evidence.datasets != artifact.datasets
            {
                return Err(KeystoneError::Invalid("evidence binding".into()));
            }
        }
        for (run_id, events) in &self.events {
            let run = self.runs.get(run_id).ok_or(KeystoneError::NotFound)?;
            if events.len() > 10_000 {
                return Err(KeystoneError::QuotaExceeded("run event budget".into()));
            }
            for (index, event) in events.iter().enumerate() {
                if event.run_id != *run_id
                    || event.node_id != run.node_id
                    || event.sequence != index as u64 + 1
                    || event.schema_version != SCHEMA_VERSION
                    || serde_json::to_vec(&event.payload)?.len() > 64 * 1024
                {
                    return Err(KeystoneError::Invalid("event sequence/binding".into()));
                }
            }
        }
        for (id, tool) in &self.tools {
            validate_id(id)?;
            let run = self.runs.get(&tool.run_id).ok_or(KeystoneError::NotFound)?;
            if id != &tool.id
                || tool.scope != run.scope
                || tool.attempt == 0
                || serde_json::to_vec(&tool.arguments)?.len() > 64 * 1024
                || tool
                    .artifact_ids
                    .iter()
                    .any(|id| self.artifacts.get(id).is_none_or(|a| a.run_id != run.id))
            {
                return Err(KeystoneError::Invalid("tool invocation binding".into()));
            }
        }
        for (id, layout) in &self.layouts {
            let inv = self.investigations.get(id).ok_or(KeystoneError::NotFound)?;
            if id != &layout.investigation_id
                || layout.revision != inv.layout_revision
                || layout.nodes.len() > MAX_NODES
            {
                return Err(KeystoneError::Invalid("layout binding".into()));
            }
            for (id, geometry) in &layout.nodes {
                geometry.validate()?;
                if !self
                    .nodes
                    .values()
                    .any(|n| n.id == *id && n.investigation_id == inv.id)
                {
                    return Err(KeystoneError::Invalid("layout unknown node".into()));
                }
            }
        }
        for record in self.idempotency.values() {
            validate_id(&record.key)?;
            bounded_text(&record.fingerprint, 256, "idempotency fingerprint")?;
            let inv = self
                .investigations
                .get(&record.investigation_id)
                .ok_or(KeystoneError::NotFound)?;
            if record.tenant_id != inv.tenant_id
                || record.owner_id != inv.owner_id
                || serde_json::to_vec(&record.response)?.len() > MAX_ARTIFACT_BYTES
            {
                return Err(KeystoneError::Invalid("idempotency binding".into()));
            }
        }
        self.validate_owner_capacity()?;
        self.validate_global_capacity()?;
        Ok(())
    }
    fn validate_owner_capacity(&self) -> Result<()> {
        let mut usage: BTreeMap<(&str, &str), (usize, usize, usize)> = BTreeMap::new();
        for inv in self.investigations.values() {
            usage.entry((&inv.tenant_id, &inv.owner_id)).or_default().2 += 1;
        }
        let mut account =
            |investigation_id: &str, record_count: usize, byte_count: usize| -> Result<()> {
                let inv = self
                    .investigations
                    .get(investigation_id)
                    .ok_or(KeystoneError::NotFound)?;
                let current = usage.entry((&inv.tenant_id, &inv.owner_id)).or_default();
                current.0 = current.0.saturating_add(record_count);
                current.1 = current.1.saturating_add(byte_count);
                if current.0 > MAX_OWNER_RECORDS
                    || current.1 > MAX_OWNER_BYTES
                    || current.2 > MAX_OWNER_INVESTIGATIONS
                {
                    return Err(KeystoneError::QuotaExceeded(
                        "owner retained-history capacity".into(),
                    ));
                }
                Ok(())
            };
        macro_rules! account_map {
            ($map:ident) => {
                for record in self.$map.values() {
                    account(
                        &record.investigation_id,
                        1,
                        serde_json::to_vec(record)?.len(),
                    )?;
                }
            };
        }
        for inv in self.investigations.values() {
            account(&inv.id, 1, serde_json::to_vec(inv)?.len())?;
        }
        account_map!(nodes);
        account_map!(runs);
        account_map!(exports);
        account_map!(artifacts);
        account_map!(evidence);
        account_map!(layouts);
        account_map!(idempotency);
        for context in self.contexts.values() {
            account(
                &context.manifest.investigation_id,
                1,
                serde_json::to_vec(context)?.len(),
            )?;
        }
        for (run_id, events) in &self.events {
            let run = self.runs.get(run_id).ok_or(KeystoneError::NotFound)?;
            account(
                &run.investigation_id,
                events.len(),
                serde_json::to_vec(events)?.len(),
            )?;
        }
        for tool in self.tools.values() {
            let run = self.runs.get(&tool.run_id).ok_or(KeystoneError::NotFound)?;
            account(&run.investigation_id, 1, serde_json::to_vec(tool)?.len())?;
        }
        // Accepted work owns reserved terminal/restart capacity until it becomes terminal.
        // Other writes cannot consume the space needed for an answer, its immutable export
        // and a terminal event. JSON strings can expand sixfold when escaped.
        for run in self.runs.values().filter(|run| !run.status.is_terminal()) {
            account(
                &run.investigation_id,
                3,
                self.terminal_reservation_bytes(run)?,
            )?;
        }
        Ok(())
    }
    fn terminal_reservation_bytes(&self, run: &Run) -> Result<usize> {
        let node = self.node(&run.node_id, run.prompt_version)?;
        Ok(12 * MAX_ANSWER_BYTES
            + 64 * 1024
            + 16 * 1024
            + 64 * 131
            + serde_json::to_vec(&node.scope)?.len()
            + serde_json::to_vec(&node.prompt)?.len())
    }
    fn validate_global_capacity(&self) -> Result<()> {
        let active: Vec<_> = self
            .runs
            .values()
            .filter(|run| !run.status.is_terminal())
            .collect();
        let reserved_bytes = active.iter().try_fold(0usize, |total, run| {
            Ok::<_, KeystoneError>(total.saturating_add(self.terminal_reservation_bytes(run)?))
        })?;
        let records = self.investigations.len()
            + self.nodes.len()
            + self.runs.len()
            + self.exports.len()
            + self.contexts.len()
            + self.artifacts.len()
            + self.evidence.len()
            + self.tools.len()
            + self.layouts.len()
            + self.idempotency.len()
            + self.events.values().map(Vec::len).sum::<usize>();
        if records.saturating_add(active.len() * 3) > MAX_RECORDS
            || serde_json::to_vec(self)?
                .len()
                .saturating_add(reserved_bytes)
                > MAX_STATE_BYTES
        {
            return Err(KeystoneError::QuotaExceeded(
                "global retained-history capacity including accepted-run reserves".into(),
            ));
        }
        Ok(())
    }
    fn retain_investigation(&mut self, id: &str) {
        self.investigations.retain(|key, _| key == id);
        self.nodes.retain(|_, r| r.investigation_id == id);
        self.runs.retain(|_, r| r.investigation_id == id);
        self.exports.retain(|_, r| r.investigation_id == id);
        self.contexts
            .retain(|_, r| r.manifest.investigation_id == id);
        self.artifacts.retain(|_, r| r.investigation_id == id);
        self.evidence.retain(|_, r| r.investigation_id == id);
        self.events.retain(|run, _| self.runs.contains_key(run));
        self.tools.retain(|_, r| self.runs.contains_key(&r.run_id));
        self.layouts.retain(|key, _| key == id);
        self.idempotency.retain(|_, r| r.investigation_id == id);
    }
    /// Equivalent to `clone()` + `retain_investigation(id)` without cloning other
    /// investigations' records. The internal idempotency ledger is never copied.
    fn clone_investigation(&self, id: &str) -> Self {
        let runs: BTreeMap<_, _> = self
            .runs
            .iter()
            .filter(|(_, r)| r.investigation_id == id)
            .map(|(k, r)| (k.clone(), r.clone()))
            .collect();
        Self {
            schema_version: self.schema_version,
            generation: self.generation,
            investigations: self
                .investigations
                .get_key_value(id)
                .map(|(k, r)| (k.clone(), r.clone()))
                .into_iter()
                .collect(),
            nodes: self
                .nodes
                .iter()
                .filter(|(_, r)| r.investigation_id == id)
                .map(|(k, r)| (k.clone(), r.clone()))
                .collect(),
            exports: self
                .exports
                .iter()
                .filter(|(_, r)| r.investigation_id == id)
                .map(|(k, r)| (k.clone(), r.clone()))
                .collect(),
            contexts: self
                .contexts
                .iter()
                .filter(|(_, r)| r.manifest.investigation_id == id)
                .map(|(k, r)| (k.clone(), r.clone()))
                .collect(),
            artifacts: self
                .artifacts
                .iter()
                .filter(|(_, r)| r.investigation_id == id)
                .map(|(k, r)| (k.clone(), r.clone()))
                .collect(),
            evidence: self
                .evidence
                .iter()
                .filter(|(_, r)| r.investigation_id == id)
                .map(|(k, r)| (k.clone(), r.clone()))
                .collect(),
            events: runs
                .keys()
                .filter_map(|run| self.events.get_key_value(run))
                .map(|(k, r)| (k.clone(), r.clone()))
                .collect(),
            tools: self
                .tools
                .iter()
                .filter(|(_, r)| runs.contains_key(&r.run_id))
                .map(|(k, r)| (k.clone(), r.clone()))
                .collect(),
            layouts: self
                .layouts
                .get_key_value(id)
                .map(|(k, r)| (k.clone(), r.clone()))
                .into_iter()
                .collect(),
            idempotency: BTreeMap::new(),
            runs,
        }
    }
}
fn validate_dependencies(datasets: &[String], scope: &ScopeVersion) -> Result<()> {
    if datasets.is_empty()
        || datasets.len() > 32
        || datasets.iter().any(|d| !scope.datasets.contains(d))
    {
        return Err(KeystoneError::Invalid(
            "artifact datasets outside scope".into(),
        ));
    }
    Ok(())
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CommitManifest {
    schema_version: u32,
    generation: u64,
    object_hash: String,
    #[serde(default)]
    previous_object_hash: Option<String>,
}
struct RepositoryInner {
    state: RepositoryState,
    poisoned: bool,
}
pub struct NativeRepository {
    directory: PathBuf,
    _coordinator_lock: File,
    inner: Mutex<RepositoryInner>,
    /// Mirrors `RepositoryInner::poisoned` so health checks never wait behind a commit.
    unusable: AtomicBool,
    /// Admission to `blocking`; a permit is held by a started job until it returns.
    lane: Arc<tokio::sync::Semaphore>,
    #[cfg(test)]
    fault: std::sync::atomic::AtomicU8,
    #[cfg(test)]
    gate: Mutex<Option<CommitGate>>,
}
/// Owner-scoped list extraction: one investigation and the dataset names its nodes and
/// evidence depend on.
pub struct OwnedSummary {
    pub investigation: Investigation,
    pub datasets: BTreeSet<String>,
    /// The lowest node version key and its scope, used as a metadata preparation template.
    pub first_node: Option<(String, ScopeVersion)>,
}
/// Holds the next durable commit after its object is written and before its manifest.
#[cfg(test)]
struct CommitGate {
    entered: tokio::sync::oneshot::Sender<()>,
    release: std::sync::mpsc::Receiver<()>,
}
impl NativeRepository {
    pub fn open(root: impl AsRef<Path>) -> Result<Self> {
        let directory = root.as_ref().join(".keystone_native").join("v1");
        fs::create_dir_all(root.as_ref())?;
        for path in [
            root.as_ref().join(".keystone_native"),
            directory.clone(),
            directory.join("objects"),
        ] {
            reject_symlink(&path)?;
            fs::create_dir_all(&path)?;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(
                root.as_ref().join(".keystone_native"),
                fs::Permissions::from_mode(0o700),
            )?;
        }
        let lock_path = directory.join("coordinator.lock");
        reject_symlink(&lock_path)?;
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(lock_path)?;
        lock.try_lock()
            .map_err(|_| KeystoneError::CoordinatorLocked)?;
        let manifest_path = directory.join("manifest.json");
        let state = if manifest_path.exists() {
            let manifest: CommitManifest =
                serde_json::from_slice(&read_bounded(&manifest_path, 4096)?)?;
            if manifest.schema_version != SCHEMA_VERSION
                || manifest.object_hash.len() != 64
                || !manifest.object_hash.bytes().all(|b| b.is_ascii_hexdigit())
            {
                return Err(KeystoneError::Invalid("commit manifest".into()));
            }
            let bytes = read_bounded(
                &directory
                    .join("objects")
                    .join(format!("{}.json", manifest.object_hash)),
                MAX_STATE_BYTES,
            )?;
            if hash_bytes(&bytes) != manifest.object_hash {
                return Err(KeystoneError::Invalid("committed object checksum".into()));
            }
            let state: RepositoryState = serde_json::from_slice(&bytes)?;
            if state.generation != manifest.generation {
                return Err(KeystoneError::Invalid("manifest generation".into()));
            }
            state.validate()?;
            state
        } else {
            RepositoryState::default()
        };
        let repo = Self {
            directory,
            _coordinator_lock: lock,
            inner: Mutex::new(RepositoryInner {
                state,
                poisoned: false,
            }),
            unusable: AtomicBool::new(false),
            lane: Arc::new(tokio::sync::Semaphore::new(BLOCKING_OPERATIONS)),
            #[cfg(test)]
            fault: std::sync::atomic::AtomicU8::new(0),
            #[cfg(test)]
            gate: Mutex::new(None),
        };
        repo.collect_obsolete_objects()?;
        repo.interrupt_unfinished()?;
        Ok(repo)
    }
    /// Lock-free, so readiness checks on async workers never wait behind a commit.
    pub fn health(&self) -> Result<()> {
        if self.inner.is_poisoned() {
            return Err(KeystoneError::Unavailable(
                "repository mutex poisoned".into(),
            ));
        }
        if self.unusable.load(Ordering::Acquire) {
            return Err(KeystoneError::Unavailable(
                "reopen after commit failure".into(),
            ));
        }
        Ok(())
    }
    /// Run one whole synchronous repository operation on a bounded blocking thread.
    /// Waiting for capacity is cancellable and has no effect. Once started, the job keeps
    /// its permit and runs to completion even if the caller is dropped, so a durable commit
    /// is never abandoned midway and memory still changes only after it succeeds.
    pub async fn blocking<T, E>(
        self: &Arc<Self>,
        job: impl FnOnce(&NativeRepository) -> std::result::Result<T, E> + Send + 'static,
    ) -> std::result::Result<T, E>
    where
        T: Send + 'static,
        E: From<KeystoneError> + Send + 'static,
    {
        let permit = self
            .lane
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| KeystoneError::Unavailable("repository workers closed".into()))?;
        let repository = self.clone();
        tokio::task::spawn_blocking(move || {
            let result = job(&repository);
            // Release this handle before the capacity it was admitted under.
            drop(repository);
            drop(permit);
            result
        })
        .await
        .unwrap_or_else(|_| {
            Err(KeystoneError::Unavailable("repository worker failed".into()).into())
        })
    }
    /// Copies only `principal`'s own investigations and the dataset names they depend on,
    /// in investigation id order. Callers apply dataset authorization after release.
    pub fn owned_summaries(&self, principal: &Principal) -> Result<Vec<OwnedSummary>> {
        let inner = self
            .inner
            .lock()
            .map_err(|_| KeystoneError::Unavailable("repository mutex poisoned".into()))?;
        check_usable(&inner)?;
        let state = &inner.state;
        let mut owned: BTreeMap<&str, OwnedSummary> = state
            .investigations
            .values()
            .filter(|investigation| investigation.authorize(principal).is_ok())
            .map(|investigation| {
                (
                    investigation.id.as_str(),
                    OwnedSummary {
                        investigation: investigation.clone(),
                        datasets: BTreeSet::new(),
                        first_node: None,
                    },
                )
            })
            .collect();
        for (key, node) in &state.nodes {
            if let Some(summary) = owned.get_mut(node.investigation_id.as_str()) {
                summary.datasets.extend(node.scope.datasets.iter().cloned());
                summary
                    .first_node
                    .get_or_insert_with(|| (key.clone(), node.scope.clone()));
            }
        }
        for evidence in state.evidence.values() {
            if let Some(summary) = owned.get_mut(evidence.investigation_id.as_str()) {
                summary.datasets.extend(evidence.datasets.iter().cloned());
            }
        }
        Ok(owned.into_values().collect())
    }
    pub fn snapshot(&self) -> Result<RepositoryState> {
        let inner = self
            .inner
            .lock()
            .map_err(|_| KeystoneError::Unavailable("repository mutex poisoned".into()))?;
        if inner.poisoned {
            return Err(KeystoneError::Unavailable(
                "reopen after commit failure".into(),
            ));
        }
        Ok(inner.state.clone())
    }
    pub fn read(
        &self,
        principal: &Principal,
        id: &str,
        mut can_read_dataset: impl FnMut(&str) -> bool,
    ) -> Result<InvestigationSnapshot> {
        // Authorize ownership under the mutex, then copy only this investigation's records so
        // per-second event polls do not clone other tenants' state. Dataset checks run after
        // release, as they did against the full snapshot.
        let mut state = {
            let inner = self
                .inner
                .lock()
                .map_err(|_| KeystoneError::Unavailable("repository mutex poisoned".into()))?;
            check_usable(&inner)?;
            inner
                .state
                .investigations
                .get(id)
                .ok_or(KeystoneError::NotFound)?
                .authorize(principal)?;
            inner.state.clone_investigation(id)
        };
        for node in state.nodes.values() {
            for dataset in &node.scope.datasets {
                if !can_read_dataset(dataset) {
                    return Err(KeystoneError::Forbidden);
                }
            }
        }
        // Expired artifact payloads are never returned. Metadata and immutable historical contexts
        // remain internal; a caller cannot inherit expired evidence into a new run.
        let expired: Vec<_> = state
            .artifacts
            .iter()
            .filter(|(_, artifact)| artifact_expired(artifact))
            .map(|(id, _)| id.clone())
            .collect();
        for id in expired {
            state.artifacts.remove(&id);
            state.evidence.retain(|_, e| e.artifact_id != id);
        }
        for evidence in state.evidence.values() {
            for dataset in &evidence.datasets {
                if !can_read_dataset(dataset) {
                    return Err(KeystoneError::Forbidden);
                }
            }
        }
        // Frozen contexts contain evidence summaries which also require retention checks.
        state.contexts.retain(|_, context| {
            context
                .manifest
                .evidence
                .iter()
                .all(|e| state.evidence.contains_key(&e.id))
        });
        state.exports.retain(|_, export| {
            export
                .evidence_ids
                .iter()
                .all(|id| state.evidence.contains_key(id))
        });
        // Responses may contain frozen context or result previews. This durable replay ledger is
        // internal state, never an investigation response or a bypass around artifact retention.
        state.idempotency.clear();
        Ok(state)
    }
    pub fn authorize_evidence(
        &self,
        principal: &Principal,
        evidence: &Evidence,
        mut can_read_dataset: impl FnMut(&str) -> bool,
    ) -> Result<()> {
        let state = self.snapshot()?;
        let committed = state
            .evidence
            .get(&evidence.id)
            .ok_or(KeystoneError::NotFound)?;
        if committed != evidence {
            return Err(KeystoneError::Forbidden);
        }
        principal.authorize(&evidence.tenant_id, &evidence.owner_id)?;
        let artifact = state
            .artifacts
            .get(&evidence.artifact_id)
            .ok_or(KeystoneError::NotFound)?;
        if artifact_expired(artifact) || evidence.datasets.iter().any(|d| !can_read_dataset(d)) {
            return Err(KeystoneError::Forbidden);
        }
        Ok(())
    }
    pub fn create(
        &self,
        principal: &Principal,
        investigation: Investigation,
        node: Node,
        idempotency: IdempotencyRequest,
    ) -> Result<Investigation> {
        principal.validate()?;
        investigation.authorize(principal)?;
        investigation.validate()?;
        node.validate()?;
        if node.parent.is_some()
            || node.id != investigation.root_node_id
            || node.investigation_id != investigation.id
            || investigation.semantic_revision != 0
            || investigation.layout_revision != 0
            || node.scope.approved_by != principal.owner_id
        {
            return Err(KeystoneError::Invalid(
                "invalid create root/revision".into(),
            ));
        }
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| KeystoneError::Unavailable("repository mutex poisoned".into()))?;
        check_usable(&inner)?;
        let key = idempotency_key(principal, &idempotency.key)?;
        if let Some(record) = inner.state.idempotency.get(&key) {
            if record.fingerprint != idempotency.fingerprint {
                return Err(KeystoneError::Conflict);
            }
            return Ok(serde_json::from_value(record.response.clone())?);
        }
        if inner.state.investigations.contains_key(&investigation.id)
            || inner.state.nodes.contains_key(&node.version_key())
        {
            return Err(KeystoneError::Conflict);
        }
        let mut next = inner.state.clone();
        next.investigations
            .insert(investigation.id.clone(), investigation.clone());
        next.nodes.insert(node.version_key(), node);
        next.idempotency.insert(
            key,
            IdempotencyRecord {
                investigation_id: investigation.id.clone(),
                tenant_id: principal.tenant_id.clone(),
                owner_id: principal.owner_id.clone(),
                key: idempotency.key,
                fingerprint: idempotency.fingerprint,
                response: serde_json::to_value(&investigation)?,
            },
        );
        self.publish(&mut inner, next)?;
        Ok(investigation)
    }
    pub fn transact(
        &self,
        principal: &Principal,
        investigation_id: &str,
        expected_revision: u64,
        kind: RevisionKind,
        idempotency: Option<IdempotencyRequest>,
        mutation: impl FnOnce(&mut RepositoryState) -> Result<Value>,
    ) -> Result<Value> {
        principal.validate()?;
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| KeystoneError::Unavailable("repository mutex poisoned".into()))?;
        check_usable(&inner)?;
        let inv = inner
            .state
            .investigations
            .get(investigation_id)
            .ok_or(KeystoneError::NotFound)?;
        inv.authorize(principal)?;
        if let Some(request) = &idempotency {
            let key = idempotency_key(principal, &request.key)?;
            if let Some(record) = inner.state.idempotency.get(&key) {
                if record.investigation_id != investigation_id
                    || record.fingerprint != request.fingerprint
                {
                    return Err(KeystoneError::Conflict);
                }
                return Ok(record.response.clone());
            }
        }
        let revision = match kind {
            RevisionKind::Semantic => inv.semantic_revision,
            RevisionKind::Layout => inv.layout_revision,
        };
        if revision != expected_revision {
            return Err(KeystoneError::Conflict);
        }
        let mut next = inner.state.clone();
        let response = mutation(&mut next)?;
        validate_transition(&inner.state, &next, investigation_id, kind)?;
        let inv = next
            .investigations
            .get_mut(investigation_id)
            .ok_or(KeystoneError::NotFound)?;
        match kind {
            RevisionKind::Semantic => {
                inv.semantic_revision = revision
                    .checked_add(1)
                    .ok_or_else(|| KeystoneError::Invalid("revision overflow".into()))?
            }
            RevisionKind::Layout => {
                inv.layout_revision = revision
                    .checked_add(1)
                    .ok_or_else(|| KeystoneError::Invalid("revision overflow".into()))?;
                if let Some(layout) = next.layouts.get_mut(investigation_id) {
                    layout.revision = inv.layout_revision;
                }
            }
        }
        inv.updated_at = chrono::Utc::now().to_rfc3339();
        if let Some(request) = idempotency {
            let key = idempotency_key(principal, &request.key)?;
            next.idempotency.insert(
                key,
                IdempotencyRecord {
                    investigation_id: investigation_id.into(),
                    tenant_id: principal.tenant_id.clone(),
                    owner_id: principal.owner_id.clone(),
                    key: request.key,
                    fingerprint: request.fingerprint,
                    response: response.clone(),
                },
            );
        }
        self.publish(&mut inner, next)?;
        Ok(response)
    }

    /// Coordinator-only progress transaction. The repository mutex supplies the
    /// execution ordering; global `generation` advances on durable publication.
    /// User semantic/layout revisions and graph records are preserved exactly.
    pub(super) fn transact_execution(
        &self,
        principal: &Principal,
        run_id: &str,
        mutation: impl FnOnce(&mut RepositoryState) -> Result<Value>,
    ) -> Result<Value> {
        principal.validate()?;
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| KeystoneError::Unavailable("repository mutex poisoned".into()))?;
        check_usable(&inner)?;
        let run = inner
            .state
            .runs
            .get(run_id)
            .ok_or(KeystoneError::NotFound)?;
        let investigation_id = run.investigation_id.clone();
        inner
            .state
            .investigations
            .get(&investigation_id)
            .ok_or(KeystoneError::NotFound)?
            .authorize(principal)?;
        let mut next = inner.state.clone();
        let response = mutation(&mut next)?;
        validate_execution_transition(&inner.state, &next, run_id)?;
        // Terminal replays do not create additional commits or terminal events.
        if next != inner.state {
            self.publish(&mut inner, next)?;
        }
        Ok(response)
    }

    fn publish(&self, inner: &mut RepositoryInner, mut next: RepositoryState) -> Result<()> {
        next.generation = inner
            .state
            .generation
            .checked_add(1)
            .ok_or_else(|| KeystoneError::Invalid("generation overflow".into()))?;
        next.validate()?;
        if let Err(error) = self.write_commit(&next) {
            inner.poisoned = true;
            self.unusable.store(true, Ordering::Release);
            return Err(error);
        }
        inner.state = next;
        Ok(())
    }
    fn write_commit(&self, state: &RepositoryState) -> Result<()> {
        let bytes = serde_json::to_vec(state)?;
        if bytes.len() > MAX_STATE_BYTES {
            return Err(KeystoneError::QuotaExceeded(
                "global retained-history byte capacity".into(),
            ));
        }
        let hash = hash_bytes(&bytes);
        let object = self.directory.join("objects").join(format!("{hash}.json"));
        if object.exists() {
            if read_bounded(&object, MAX_STATE_BYTES)? != bytes {
                return Err(KeystoneError::Invalid("immutable object collision".into()));
            }
        } else {
            atomic_write(&object, &bytes)?;
        }
        #[cfg(test)]
        self.inject_fault(1)?;
        #[cfg(test)]
        self.wait_at_gate();
        let previous_object_hash = self
            .read_commit_manifest()?
            .map(|manifest| manifest.object_hash);
        let manifest = serde_json::to_vec(&CommitManifest {
            schema_version: SCHEMA_VERSION,
            generation: state.generation,
            object_hash: hash,
            previous_object_hash,
        })?;
        #[cfg(test)]
        self.inject_fault(2)?;
        atomic_write(&self.directory.join("manifest.json"), &manifest)?;
        #[cfg(test)]
        self.inject_fault(3)?;
        self.collect_obsolete_objects()?;
        Ok(())
    }
    fn read_commit_manifest(&self) -> Result<Option<CommitManifest>> {
        let path = self.directory.join("manifest.json");
        if !path.exists() {
            return Ok(None);
        }
        let manifest: CommitManifest = serde_json::from_slice(&read_bounded(&path, 4096)?)?;
        if manifest.schema_version != SCHEMA_VERSION
            || !is_object_hash(&manifest.object_hash)
            || manifest
                .previous_object_hash
                .as_ref()
                .is_some_and(|hash| !is_object_hash(hash))
        {
            return Err(KeystoneError::Invalid("commit manifest".into()));
        }
        Ok(Some(manifest))
    }
    /// Called only while holding the OS coordinator lock, after the durable manifest is known.
    /// Full-state objects contain all committed history; retaining current+previous snapshots
    /// permits reclamation without pruning evidence, events or the idempotency ledger.
    fn collect_obsolete_objects(&self) -> Result<()> {
        let manifest = self.read_commit_manifest()?;
        let objects = self.directory.join("objects");
        let mut changed = false;
        for entry in fs::read_dir(&objects)? {
            let entry = entry?;
            if !entry.file_type()?.is_file() {
                continue;
            }
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            if is_owned_pending_name(name) {
                fs::remove_file(entry.path())?;
                changed = true;
                continue;
            }
            let Some(hash) = name.strip_suffix(".json") else {
                continue;
            };
            if !is_object_hash(hash) {
                continue;
            }
            let retained = manifest.as_ref().is_some_and(|manifest| {
                hash == manifest.object_hash
                    || manifest.previous_object_hash.as_deref() == Some(hash)
            });
            if !retained {
                fs::remove_file(entry.path())?;
                changed = true;
            }
        }
        if changed {
            File::open(objects)?.sync_all()?;
        }
        let mut pending_changed = false;
        for entry in fs::read_dir(&self.directory)? {
            let entry = entry?;
            if entry.file_type()?.is_file()
                && entry
                    .file_name()
                    .to_str()
                    .is_some_and(is_owned_pending_name)
            {
                fs::remove_file(entry.path())?;
                pending_changed = true;
            }
        }
        if pending_changed {
            File::open(&self.directory)?.sync_all()?;
        }
        Ok(())
    }
    fn interrupt_unfinished(&self) -> Result<()> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| KeystoneError::Unavailable("repository mutex poisoned".into()))?;
        let mut next = inner.state.clone();
        let mut affected = std::collections::BTreeSet::new();
        for run in next.runs.values_mut().filter(|r| !r.status.is_terminal()) {
            run.status = RunStatus::Interrupted;
            run.updated_at = chrono::Utc::now().to_rfc3339();
            affected.insert(run.investigation_id.clone());
            for tool in next
                .tools
                .values_mut()
                .filter(|tool| tool.run_id == run.id && tool.status == "running")
            {
                tool.status = "interrupted".into();
                tool.ended_at = Some(run.updated_at.clone());
            }
            let events = next.events.entry(run.id.clone()).or_default();
            events.push(Event {
                run_id: run.id.clone(),
                node_id: run.node_id.clone(),
                sequence: events.len() as u64 + 1,
                timestamp: run.updated_at.clone(),
                schema_version: SCHEMA_VERSION,
                kind: "interrupted".into(),
                payload: serde_json::json!({"reason":"coordinator_restart"}),
            });
        }
        if !affected.is_empty() {
            self.publish(&mut inner, next)?;
        }
        Ok(())
    }
    #[cfg(test)]
    fn inject_fault(&self, point: u8) -> Result<()> {
        use std::sync::atomic::Ordering;
        if self
            .fault
            .compare_exchange(point, 0, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
        {
            return Err(KeystoneError::Io(std::io::Error::other(
                "injected commit fault",
            )));
        }
        Ok(())
    }
    /// Gate the next durable commit: `entered` fires once its immutable object is written,
    /// and the commit (holding the repository mutex) then waits for `release`.
    #[cfg(test)]
    pub(super) fn gate_next_commit(
        &self,
    ) -> (
        tokio::sync::oneshot::Receiver<()>,
        std::sync::mpsc::Sender<()>,
    ) {
        let (entered, entered_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release) = std::sync::mpsc::channel();
        *self.gate.lock().unwrap() = Some(CommitGate { entered, release });
        (entered_rx, release_tx)
    }
    #[cfg(test)]
    fn wait_at_gate(&self) {
        let gate = self.gate.lock().unwrap().take();
        if let Some(gate) = gate {
            let _ = gate.entered.send(());
            let _ = gate.release.recv();
        }
    }
    /// Resolves once every started blocking job has returned.
    #[cfg(test)]
    pub(super) async fn drain_blocking(&self) {
        let _all = self
            .lane
            .acquire_many(BLOCKING_OPERATIONS as u32)
            .await
            .unwrap();
    }
}
fn check_usable(inner: &RepositoryInner) -> Result<()> {
    if inner.poisoned {
        return Err(KeystoneError::Unavailable(
            "reopen after commit failure".into(),
        ));
    }
    Ok(())
}
fn is_object_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
fn is_owned_pending_name(value: &str) -> bool {
    let Some(token) = value
        .strip_prefix('.')
        .and_then(|value| value.strip_suffix(".pending"))
    else {
        return false;
    };
    token.len() == 26
        && token
            .parse::<ulid::Ulid>()
            .is_ok_and(|id| id.to_string() == token)
}

/// Permission check for list summaries/capabilities without cloning the whole repository.
pub fn authorize_investigation_snapshot(
    state: &RepositoryState,
    principal: &Principal,
    investigation_id: &str,
    mut can_read_dataset: impl FnMut(&str) -> bool,
) -> Result<()> {
    state
        .investigations
        .get(investigation_id)
        .ok_or(KeystoneError::NotFound)?
        .authorize(principal)?;
    for node in state
        .nodes
        .values()
        .filter(|node| node.investigation_id == investigation_id)
    {
        for dataset in &node.scope.datasets {
            if !can_read_dataset(dataset) {
                return Err(KeystoneError::Forbidden);
            }
        }
    }
    for evidence in state
        .evidence
        .values()
        .filter(|evidence| evidence.investigation_id == investigation_id)
    {
        for dataset in &evidence.datasets {
            if !can_read_dataset(dataset) {
                return Err(KeystoneError::Forbidden);
            }
        }
    }
    Ok(())
}
fn idempotency_key(principal: &Principal, key: &str) -> Result<String> {
    validate_id(key)?;
    Ok(hash_bytes(&serde_json::to_vec(&(
        principal.tenant_id.as_str(),
        principal.owner_id.as_str(),
        key,
    ))?))
}
pub fn artifact_expired(artifact: &Artifact) -> bool {
    artifact.expires_at.as_ref().is_some_and(|expiry| {
        chrono::DateTime::parse_from_rfc3339(expiry)
            .map_or(true, |expiry| expiry <= chrono::Utc::now())
    })
}

/// Restrict internal publication to one already accepted run. Removing its owned
/// execution records from both snapshots must leave precisely identical state.
fn validate_execution_transition(
    old: &RepositoryState,
    new: &RepositoryState,
    run_id: &str,
) -> Result<()> {
    let run = old.runs.get(run_id).ok_or(KeystoneError::NotFound)?;
    if old.runs.keys().ne(new.runs.keys()) {
        return Err(KeystoneError::Invalid(
            "execution cannot admit or remove runs".into(),
        ));
    }
    validate_transition(old, new, &run.investigation_id, RevisionKind::Semantic)?;
    fn without_execution(mut state: RepositoryState, run_id: &str) -> RepositoryState {
        state.runs.remove(run_id);
        state.exports.retain(|_, record| record.run_id != run_id);
        state.artifacts.retain(|_, record| record.run_id != run_id);
        state.evidence.retain(|_, record| record.run_id != run_id);
        state.events.remove(run_id);
        state.tools.retain(|_, record| record.run_id != run_id);
        state
    }
    if without_execution(old.clone(), run_id) != without_execution(new.clone(), run_id) {
        return Err(KeystoneError::Invalid(
            "execution changed graph, user revisions, or another run".into(),
        ));
    }
    // Once terminal, even new run-owned records must not appear on replay.
    if run.status.is_terminal() && old != new {
        return Err(KeystoneError::Invalid(
            "terminal execution is immutable".into(),
        ));
    }
    Ok(())
}

fn validate_transition(
    old: &RepositoryState,
    new: &RepositoryState,
    id: &str,
    kind: RevisionKind,
) -> Result<()> {
    let mut outside_old = old.clone();
    let mut outside_new = new.clone();
    outside_old.retain_investigation(id);
    outside_new.retain_investigation(id);
    let mut expected = old.clone();
    expected.investigations.retain(|key, _| key != id);
    expected.nodes.retain(|_, r| r.investigation_id != id);
    expected.runs.retain(|_, r| r.investigation_id != id);
    expected.exports.retain(|_, r| r.investigation_id != id);
    expected
        .contexts
        .retain(|_, r| r.manifest.investigation_id != id);
    expected.artifacts.retain(|_, r| r.investigation_id != id);
    expected.evidence.retain(|_, r| r.investigation_id != id);
    expected
        .events
        .retain(|run, _| expected.runs.contains_key(run));
    expected
        .tools
        .retain(|_, r| expected.runs.contains_key(&r.run_id));
    expected.layouts.remove(id);
    expected.idempotency.retain(|_, r| r.investigation_id != id);
    let mut actual = new.clone();
    actual.investigations.retain(|key, _| key != id);
    actual.nodes.retain(|_, r| r.investigation_id != id);
    actual.runs.retain(|_, r| r.investigation_id != id);
    actual.exports.retain(|_, r| r.investigation_id != id);
    actual
        .contexts
        .retain(|_, r| r.manifest.investigation_id != id);
    actual.artifacts.retain(|_, r| r.investigation_id != id);
    actual.evidence.retain(|_, r| r.investigation_id != id);
    actual.events.retain(|run, _| actual.runs.contains_key(run));
    actual
        .tools
        .retain(|_, r| actual.runs.contains_key(&r.run_id));
    actual.layouts.remove(id);
    actual.idempotency.retain(|_, r| r.investigation_id != id);
    if actual != expected {
        return Err(KeystoneError::Forbidden);
    }
    let inv_old = old.investigations.get(id).ok_or(KeystoneError::NotFound)?;
    let inv_new = new.investigations.get(id).ok_or(KeystoneError::NotFound)?;
    if inv_old.id != inv_new.id
        || inv_old.tenant_id != inv_new.tenant_id
        || inv_old.owner_id != inv_new.owner_id
        || inv_old.root_node_id != inv_new.root_node_id
        || inv_old.semantic_revision != inv_new.semantic_revision
        || inv_old.layout_revision != inv_new.layout_revision
    {
        return Err(KeystoneError::Invalid(
            "immutable investigation identity/revisions".into(),
        ));
    }
    if matches!(kind, RevisionKind::Layout) {
        outside_old.layouts.clear();
        outside_new.layouts.clear();
        if outside_old != outside_new {
            return Err(KeystoneError::Invalid(
                "layout mutation changed semantic records".into(),
            ));
        }
    }
    if matches!(kind, RevisionKind::Semantic) && old.layouts != new.layouts {
        return Err(KeystoneError::Invalid(
            "semantic mutation changed layout".into(),
        ));
    }
    for (key, node) in &old.nodes {
        let new_node = new
            .nodes
            .get(key)
            .ok_or_else(|| KeystoneError::Invalid("immutable node removed".into()))?;
        let mut expected = node.clone();
        expected.selected_run_id = new_node.selected_run_id.clone();
        if node.context_manifest_id.is_none() {
            expected.context_manifest_id = new_node.context_manifest_id.clone();
        }
        if &expected != new_node {
            return Err(KeystoneError::Invalid(
                "executed node version changed; create a new version".into(),
            ));
        }
    }
    macro_rules! immutable {
        ($field:ident) => {
            for (key, value) in &old.$field {
                if new.$field.get(key) != Some(value) {
                    return Err(KeystoneError::Invalid(
                        concat!("immutable ", stringify!($field), " changed").into(),
                    ));
                }
            }
        };
    }
    immutable!(exports);
    immutable!(contexts);
    immutable!(artifacts);
    immutable!(evidence);
    immutable!(idempotency);
    for (id, tool) in &old.tools {
        let next = new
            .tools
            .get(id)
            .ok_or_else(|| KeystoneError::Invalid("tool invocation removed".into()))?;
        let mut expected = tool.clone();
        expected.status = next.status.clone();
        expected.ended_at = next.ended_at.clone();
        expected.artifact_ids = next.artifact_ids.clone();
        if &expected != next || (tool.status != "running" && tool != next) {
            return Err(KeystoneError::Invalid(
                "immutable tool binding/terminal state".into(),
            ));
        }
    }
    for (id, run) in &old.runs {
        let next = new
            .runs
            .get(id)
            .ok_or_else(|| KeystoneError::Invalid("run removed".into()))?;
        let mut expected = run.clone();
        expected.status = next.status;
        expected.answer = next.answer.clone();
        expected.updated_at = next.updated_at.clone();
        if &expected != next
            || (run.status.is_terminal() && run != next)
            || (run.status == RunStatus::Running && next.status == RunStatus::Queued)
        {
            return Err(KeystoneError::Invalid(
                "immutable run binding/terminal state".into(),
            ));
        }
    }
    for (id, events) in &old.events {
        if new
            .events
            .get(id)
            .is_none_or(|next| !next.starts_with(events))
        {
            return Err(KeystoneError::Invalid("committed events changed".into()));
        }
    }
    Ok(())
}
fn reject_symlink(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => {
            Err(KeystoneError::Invalid("symlink in native storage".into()))
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}
fn read_bounded(path: &Path, max: usize) -> Result<Vec<u8>> {
    reject_symlink(path)?;
    let file = File::open(path)?;
    if file.metadata()?.len() > max as u64 {
        return Err(KeystoneError::Invalid("oversized stored object".into()));
    }
    let mut bytes = Vec::new();
    file.take(max as u64 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > max {
        return Err(KeystoneError::Invalid("oversized stored object".into()));
    }
    Ok(bytes)
}
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    reject_symlink(path)?;
    let directory = path
        .parent()
        .ok_or_else(|| KeystoneError::Invalid("missing storage directory".into()))?;
    let temp = directory.join(format!(".{}.pending", ulid::Ulid::new()));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temp)?;
    let result = (|| -> Result<()> {
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&temp, path)?;
        File::open(directory)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keystone::context::{
        build_context,
        tests::{fixture, run},
    };

    fn directory() -> tempfile::TempDir {
        tempfile::Builder::new()
            .prefix("keystone-repo-")
            .tempdir_in("/dev/shm")
            .unwrap()
    }
    fn object_count(root: &Path) -> usize {
        fs::read_dir(root.join(".keystone_native/v1/objects"))
            .unwrap()
            .filter_map(|entry| {
                let entry = entry.ok()?;
                let name = entry.file_name();
                let hash = name.to_str()?.strip_suffix(".json")?;
                (entry.file_type().ok()?.is_file() && is_object_hash(hash)).then_some(())
            })
            .count()
    }
    fn create(repo: &NativeRepository) -> (Principal, Investigation, Node) {
        let (principal, inv, node) = fixture();
        repo.create(
            &principal,
            inv.clone(),
            node.clone(),
            IdempotencyRequest {
                key: "create1".into(),
                fingerprint: "same-create".into(),
            },
        )
        .unwrap();
        (principal, inv, node)
    }
    fn add_run(
        repo: &NativeRepository,
        principal: &Principal,
        inv: &Investigation,
        node: &Node,
        status: RunStatus,
    ) -> String {
        let context = build_context(principal, inv, node, None, &[], false, |_| true).unwrap();
        let mut run = run(node, "run1", status, "completed answer");
        run.context_manifest_id = context.manifest.id.clone();
        run.context_hash = context.hash.clone();
        if !status.is_terminal() {
            run.answer = None;
        }
        repo.transact(
            principal,
            &inv.id,
            0,
            RevisionKind::Semantic,
            Some(IdempotencyRequest {
                key: "start1".into(),
                fingerprint: "same-start".into(),
            }),
            |state| {
                state.contexts.insert(context.manifest.id.clone(), context);
                state.runs.insert(run.id.clone(), run.clone());
                if status == RunStatus::Completed {
                    state.exports.insert(
                        node.version_key(),
                        ParentExport::from_completed(inv, node, &run, vec![])?,
                    );
                }
                Ok(serde_json::json!({"runId":run.id}))
            },
        )
        .unwrap();
        "run1".into()
    }
    #[test]
    fn exclusive_coordinator_and_durable_create_idempotency() {
        let dir = directory();
        let repo = NativeRepository::open(dir.path()).unwrap();
        assert!(matches!(
            NativeRepository::open(dir.path()),
            Err(KeystoneError::CoordinatorLocked)
        ));
        let (principal, inv, node) = create(&repo);
        let generation = repo.snapshot().unwrap().generation;
        let replay = repo
            .create(
                &principal,
                inv.clone(),
                node.clone(),
                IdempotencyRequest {
                    key: "create1".into(),
                    fingerprint: "same-create".into(),
                },
            )
            .unwrap();
        assert_eq!(replay, inv);
        assert_eq!(generation, repo.snapshot().unwrap().generation);
        assert!(
            repo.create(
                &principal,
                inv.clone(),
                node.clone(),
                IdempotencyRequest {
                    key: "create1".into(),
                    fingerprint: "different".into()
                }
            )
            .is_err()
        );
        drop(repo);
        let repo = NativeRepository::open(dir.path()).unwrap();
        assert_eq!(repo.snapshot().unwrap().investigations.len(), 1);
        let replay = repo
            .create(
                &principal,
                inv.clone(),
                node,
                IdempotencyRequest {
                    key: "create1".into(),
                    fingerprint: "same-create".into(),
                },
            )
            .unwrap();
        assert_eq!(replay, inv);
        let mut denied = principal.clone();
        denied.tenant_id = "otherTenant".into();
        assert!(repo.read(&denied, &inv.id, |_| true).is_err());
        denied = principal.clone();
        denied.owner_id = "otherOwner".into();
        assert!(repo.read(&denied, &inv.id, |_| true).is_err());
        assert!(repo.read(&principal, &inv.id, |_| false).is_err());
    }
    #[test]
    fn restart_interrupts_without_rerunning_and_replays_accepted_idempotency() {
        let dir = directory();
        let repo = NativeRepository::open(dir.path()).unwrap();
        let (principal, inv, node) = create(&repo);
        let run_id = add_run(&repo, &principal, &inv, &node, RunStatus::Queued);
        let accepted_investigation = repo.snapshot().unwrap().investigations[&inv.id].clone();
        drop(repo);
        let repo = NativeRepository::open(dir.path()).unwrap();
        let state = repo.snapshot().unwrap();
        assert_eq!(state.runs[&run_id].status, RunStatus::Interrupted);
        assert_eq!(state.investigations[&inv.id], accepted_investigation);
        assert_eq!(state.events[&run_id][0].kind, "interrupted");
        assert_eq!(state.events[&run_id][0].sequence, 1);
        let response = repo
            .transact(
                &principal,
                &inv.id,
                0,
                RevisionKind::Semantic,
                Some(IdempotencyRequest {
                    key: "start1".into(),
                    fingerprint: "same-start".into(),
                }),
                |_| panic!("accepted request must never run again"),
            )
            .unwrap();
        assert_eq!(response, serde_json::json!({"runId":run_id}));
        assert_eq!(repo.snapshot().unwrap().runs.len(), 1);
        let generation = repo.snapshot().unwrap().generation;
        drop(repo);
        let repo = NativeRepository::open(dir.path()).unwrap();
        assert_eq!(repo.snapshot().unwrap().generation, generation);
    }
    #[test]
    fn faults_before_manifest_leave_old_commit_and_after_manifest_reopen_new_commit() {
        for point in [1, 2, 3] {
            let dir = directory();
            let repo = NativeRepository::open(dir.path()).unwrap();
            let (principal, inv, _) = create(&repo);
            repo.fault.store(point, std::sync::atomic::Ordering::SeqCst);
            assert!(
                repo.transact(
                    &principal,
                    &inv.id,
                    0,
                    RevisionKind::Semantic,
                    Some(IdempotencyRequest {
                        key: "rename1".into(),
                        fingerprint: "rename".into()
                    }),
                    |state| {
                        state.investigations.get_mut(&inv.id).unwrap().title = "new title".into();
                        Ok(Value::String("renamed".into()))
                    }
                )
                .is_err()
            );
            assert!(repo.snapshot().is_err());
            drop(repo);
            let repo = NativeRepository::open(dir.path()).unwrap();
            let state = repo.snapshot().unwrap();
            assert!(
                object_count(dir.path()) <= 2,
                "reopen must collect commit-fault orphan snapshots"
            );
            assert_eq!(
                state.investigations[&inv.id].title,
                if point == 3 { "new title" } else { "incident" }
            );
            assert_eq!(
                state.investigations[&inv.id].semantic_revision,
                if point == 3 { 1 } else { 0 }
            );
            if point == 3 {
                let replay = repo
                    .transact(
                        &principal,
                        &inv.id,
                        0,
                        RevisionKind::Semantic,
                        Some(IdempotencyRequest {
                            key: "rename1".into(),
                            fingerprint: "rename".into(),
                        }),
                        |_| panic!("committed idempotency lost"),
                    )
                    .unwrap();
                assert_eq!(replay, Value::String("renamed".into()));
            }
        }
    }
    #[test]
    fn layout_revision_is_independent_and_context_versions_are_immutable() {
        let dir = directory();
        let repo = NativeRepository::open(dir.path()).unwrap();
        let (principal, inv, node) = create(&repo);
        add_run(&repo, &principal, &inv, &node, RunStatus::Completed);
        let before = repo.snapshot().unwrap();
        let context = before.contexts.values().next().unwrap().clone();
        repo.transact(
            &principal,
            &inv.id,
            0,
            RevisionKind::Layout,
            None,
            |state| {
                state.layouts.insert(
                    inv.id.clone(),
                    CanvasLayout {
                        investigation_id: inv.id.clone(),
                        revision: 0,
                        nodes: BTreeMap::from([(
                            node.id.clone(),
                            NodeGeometry {
                                x: 25.0,
                                y: 40.0,
                                width: 400.0,
                                height: 200.0,
                                pinned: true,
                                collapsed: None,
                                expanded_height: None,
                            },
                        )]),
                    },
                );
                Ok(Value::Null)
            },
        )
        .unwrap();
        let state = repo.snapshot().unwrap();
        assert_eq!(state.investigations[&inv.id].semantic_revision, 1);
        assert_eq!(state.investigations[&inv.id].layout_revision, 1);
        assert_eq!(state.contexts.values().next().unwrap(), &context);
        assert!(
            repo.transact(&principal, &inv.id, 0, RevisionKind::Layout, None, |_| Ok(
                Value::Null
            ))
            .is_err()
        );
        assert!(
            repo.transact(
                &principal,
                &inv.id,
                1,
                RevisionKind::Semantic,
                None,
                |state| {
                    state.nodes.get_mut(&node.version_key()).unwrap().prompt =
                        "edited prompt".into();
                    Ok(Value::Null)
                }
            )
            .is_err()
        );
        assert!(
            repo.transact(
                &principal,
                &inv.id,
                1,
                RevisionKind::Semantic,
                None,
                |state| {
                    state.contexts.values_mut().next().unwrap().manifest.prompt = "tampered".into();
                    Ok(Value::Null)
                }
            )
            .is_err()
        );
        repo.transact(
            &principal,
            &inv.id,
            1,
            RevisionKind::Semantic,
            None,
            |state| {
                let mut version = node.clone();
                version.version = 2;
                version.prompt = "new immutable version".into();
                state.nodes.insert(version.version_key(), version);
                Ok(Value::Null)
            },
        )
        .unwrap();
        assert_eq!(
            repo.snapshot().unwrap().contexts.values().next().unwrap(),
            &context
        );
    }
    #[test]
    fn separate_siblings_can_run_but_same_node_cannot_have_two_active_attempts() {
        let dir = directory();
        let repo = NativeRepository::open(dir.path()).unwrap();
        let (principal, inv, p) = create(&repo);
        add_run(&repo, &principal, &inv, &p, RunStatus::Completed);
        repo.transact(
            &principal,
            &inv.id,
            1,
            RevisionKind::Semantic,
            None,
            |state| {
                let parent = state.exports[&p.version_key()].clone();
                for id in ["A", "B"] {
                    let mut child = p.clone();
                    child.id = id.into();
                    child.parent = Some(ParentReference {
                        node_id: p.id.clone(),
                        version: 1,
                    });
                    child.prompt = format!("{id} prompt");
                    let context =
                        build_context(&principal, &inv, &child, Some(&parent), &[], false, |_| {
                            true
                        })?;
                    let mut run = run(&child, &format!("run{id}"), RunStatus::Queued, "");
                    run.answer = None;
                    run.context_manifest_id = context.manifest.id.clone();
                    run.context_hash = context.hash.clone();
                    state.nodes.insert(child.version_key(), child);
                    state.contexts.insert(context.manifest.id.clone(), context);
                    state.runs.insert(run.id.clone(), run);
                }
                Ok(Value::Null)
            },
        )
        .unwrap();
        assert_eq!(
            repo.snapshot()
                .unwrap()
                .runs
                .values()
                .filter(|r| !r.status.is_terminal())
                .count(),
            2
        );
        assert!(
            repo.transact(
                &principal,
                &inv.id,
                2,
                RevisionKind::Semantic,
                None,
                |state| {
                    let mut duplicate = state.runs["runA"].clone();
                    duplicate.id = "runA2".into();
                    duplicate.attempt = 2;
                    state.runs.insert(duplicate.id.clone(), duplicate);
                    Ok(Value::Null)
                }
            )
            .is_err()
        );
    }
    #[test]
    fn expired_evidence_and_internal_idempotency_are_never_read_or_inherited() {
        let dir = directory();
        let repo = NativeRepository::open(dir.path()).unwrap();
        let (principal, inv, node) = create(&repo);
        add_run(&repo, &principal, &inv, &node, RunStatus::Completed);
        let payload = serde_json::json!({"rows":[{"secret":"expired_raw_sentinel"}]});
        let artifact = Artifact {
            id: "artifact1".into(),
            investigation_id: inv.id.clone(),
            node_id: node.id.clone(),
            run_id: "run1".into(),
            tenant_id: principal.tenant_id.clone(),
            owner_id: principal.owner_id.clone(),
            schema_version: SCHEMA_VERSION,
            kind: "table".into(),
            datasets: node.scope.datasets.clone(),
            scope: node.scope.clone(),
            executed_sql: Some("SELECT 1".into()),
            result_hash: hash_bytes(&serde_json::to_vec(&payload).unwrap()),
            payload,
            expires_at: Some("2020-01-01T00:00:00Z".into()),
            fetched_at: "2019-01-01T00:00:00Z".into(),
            row_count: 1,
            byte_count: 64,
            truncated: false,
        };
        let evidence = Evidence {
            id: "e1".into(),
            artifact_id: artifact.id.clone(),
            investigation_id: inv.id.clone(),
            node_id: node.id.clone(),
            run_id: "run1".into(),
            tenant_id: principal.tenant_id.clone(),
            owner_id: principal.owner_id.clone(),
            datasets: node.scope.datasets.clone(),
            summary: "expired evidence".into(),
        };
        repo.transact(
            &principal,
            &inv.id,
            1,
            RevisionKind::Semantic,
            Some(IdempotencyRequest {
                key: "artifact1".into(),
                fingerprint: "result".into(),
            }),
            |state| {
                state.artifacts.insert(artifact.id.clone(), artifact);
                state.evidence.insert(evidence.id.clone(), evidence.clone());
                Ok(serde_json::json!({"rows":"expired_raw_sentinel"}))
            },
        )
        .unwrap();
        assert!(
            repo.authorize_evidence(&principal, &evidence, |_| true)
                .is_err()
        );
        let visible = repo.read(&principal, &inv.id, |_| true).unwrap();
        assert!(visible.artifacts.is_empty());
        assert!(visible.evidence.is_empty());
        assert!(visible.idempotency.is_empty());
        assert!(
            !serde_json::to_string(&visible)
                .unwrap()
                .contains("expired_raw_sentinel")
        );
    }
    #[test]
    fn corrupt_manifest_and_unsafe_dataset_or_symlink_are_rejected() {
        let (_, _, mut node) = fixture();
        for dataset in ["_internal", "other.logs", "../logs", "logs\"", ""] {
            node.scope.datasets = vec![dataset.into()];
            assert!(node.scope.validate().is_err());
        }
        let dir = directory();
        let repo = NativeRepository::open(dir.path()).unwrap();
        create(&repo);
        drop(repo);
        fs::write(
            dir.path().join(".keystone_native/v1/manifest.json"),
            b"{\"schemaVersion\":1,\"generation\":1,\"objectHash\":\"../../secret\"}",
        )
        .unwrap();
        assert!(NativeRepository::open(dir.path()).is_err());
        #[cfg(unix)]
        {
            let dir = directory();
            std::os::unix::fs::symlink("/dev/shm", dir.path().join(".keystone_native")).unwrap();
            assert!(NativeRepository::open(dir.path()).is_err());
        }
    }

    #[test]
    fn snapshot_collection_keeps_current_previous_and_only_safe_hash_files() {
        let dir = directory();
        let repo = NativeRepository::open(dir.path()).unwrap();
        let (principal, investigation, _) = create(&repo);
        for revision in 0..20 {
            repo.transact(
                &principal,
                &investigation.id,
                revision,
                RevisionKind::Semantic,
                None,
                |state| {
                    state
                        .investigations
                        .get_mut(&investigation.id)
                        .unwrap()
                        .title = format!("version {revision}");
                    Ok(Value::Null)
                },
            )
            .unwrap();
            assert!(object_count(dir.path()) <= 2);
        }
        let objects = dir.path().join(".keystone_native/v1/objects");
        let orphan = objects.join(format!("{}.json", "0".repeat(64)));
        let unknown = objects.join("administrator-file.json");
        let owned_pending = objects.join(format!(".{}.pending", ulid::Ulid::new()));
        let pending_manifest = dir
            .path()
            .join(".keystone_native/v1")
            .join(format!(".{}.pending", ulid::Ulid::new()));
        let unknown_pending = objects.join(".not-a-valid-ulid.pending");
        fs::write(&orphan, b"uncommitted orphan snapshot").unwrap();
        fs::write(&unknown, b"not a native hash object").unwrap();
        fs::write(&owned_pending, vec![b'x'; 64 * 1024]).unwrap();
        fs::write(&pending_manifest, b"unpublished manifest").unwrap();
        fs::write(&unknown_pending, b"not a generated temporary name").unwrap();
        #[cfg(unix)]
        let symlink_pending = {
            let path = objects.join(format!(".{}.pending", ulid::Ulid::new()));
            std::os::unix::fs::symlink(&unknown, &path).unwrap();
            path
        };
        drop(repo);
        let repo = NativeRepository::open(dir.path()).unwrap();
        assert!(!orphan.exists());
        assert!(unknown.exists(), "cleanup must not touch unknown files");
        assert!(!owned_pending.exists());
        assert!(!pending_manifest.exists());
        assert!(
            unknown_pending.exists(),
            "pending cleanup must use exact generated names"
        );
        #[cfg(unix)]
        assert!(
            symlink_pending
                .symlink_metadata()
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert_eq!(object_count(dir.path()), 2);
        let manifest = repo.read_commit_manifest().unwrap().unwrap();
        assert!(
            objects
                .join(format!("{}.json", manifest.object_hash))
                .exists()
        );
        assert!(
            objects
                .join(format!("{}.json", manifest.previous_object_hash.unwrap()))
                .exists()
        );
        assert_eq!(
            repo.snapshot().unwrap().investigations[&investigation.id].title,
            "version 19"
        );
    }

    #[test]
    fn owner_record_and_byte_quotas_reject_without_poisoning_or_pruning_replay() {
        let dir = directory();
        let repo = NativeRepository::open(dir.path()).unwrap();
        let (principal, investigation, _) = create(&repo);
        let initial = repo.snapshot().unwrap();
        let oversized_records = repo.transact(
            &principal,
            &investigation.id,
            0,
            RevisionKind::Semantic,
            None,
            |state| {
                for index in 0..MAX_OWNER_RECORDS {
                    let key = format!("retained{index}");
                    state.idempotency.insert(
                        idempotency_key(&principal, &key)?,
                        IdempotencyRecord {
                            investigation_id: investigation.id.clone(),
                            tenant_id: principal.tenant_id.clone(),
                            owner_id: principal.owner_id.clone(),
                            key,
                            fingerprint: "retained-fingerprint".into(),
                            response: Value::Null,
                        },
                    );
                }
                Ok(Value::Null)
            },
        );
        assert!(matches!(
            oversized_records,
            Err(KeystoneError::QuotaExceeded(_))
        ));
        repo.health().unwrap();
        assert_eq!(repo.snapshot().unwrap(), initial);
        let oversized_bytes = repo.transact(
            &principal,
            &investigation.id,
            0,
            RevisionKind::Semantic,
            None,
            |state| {
                for index in 0..8 {
                    let key = format!("large{index}");
                    state.idempotency.insert(
                        idempotency_key(&principal, &key)?,
                        IdempotencyRecord {
                            investigation_id: investigation.id.clone(),
                            tenant_id: principal.tenant_id.clone(),
                            owner_id: principal.owner_id.clone(),
                            key,
                            fingerprint: "retained-fingerprint".into(),
                            response: Value::String("x".repeat(MAX_ARTIFACT_BYTES - 2)),
                        },
                    );
                }
                Ok(Value::Null)
            },
        );
        assert!(matches!(
            oversized_bytes,
            Err(KeystoneError::QuotaExceeded(_))
        ));
        repo.health().unwrap();
        assert_eq!(repo.snapshot().unwrap(), initial);
        assert_eq!(
            repo.snapshot().unwrap().idempotency.len(),
            1,
            "capacity rejection cannot prune durable acceptance"
        );
    }

    #[test]
    fn one_owners_investigation_quota_preserves_another_owners_capacity() {
        let dir = directory();
        let repo = NativeRepository::open(dir.path()).unwrap();
        let (principal, template, root) = fixture();
        for index in 0..MAX_OWNER_INVESTIGATIONS {
            let mut investigation = template.clone();
            investigation.id = format!("inv{index}");
            investigation.root_node_id = format!("root{index}");
            let mut node = root.clone();
            node.id = investigation.root_node_id.clone();
            node.investigation_id = investigation.id.clone();
            repo.create(
                &principal,
                investigation,
                node,
                IdempotencyRequest {
                    key: format!("create{index}"),
                    fingerprint: format!("fingerprint{index}"),
                },
            )
            .unwrap();
        }
        let mut rejected = template.clone();
        rejected.id = "exceedsOwner".into();
        rejected.root_node_id = "exceedsRoot".into();
        let mut node = root.clone();
        node.id = rejected.root_node_id.clone();
        node.investigation_id = rejected.id.clone();
        assert!(matches!(
            repo.create(
                &principal,
                rejected.clone(),
                node.clone(),
                IdempotencyRequest {
                    key: "exceeded".into(),
                    fingerprint: "capacity".into()
                }
            ),
            Err(KeystoneError::QuotaExceeded(_))
        ));
        let other = Principal {
            tenant_id: principal.tenant_id.clone(),
            owner_id: "secondOwner".into(),
        };
        rejected.owner_id = other.owner_id.clone();
        node.scope.approved_by = other.owner_id.clone();
        repo.create(
            &other,
            rejected,
            node,
            IdempotencyRequest {
                key: "ownCapacity".into(),
                fingerprint: "other-owner-create".into(),
            },
        )
        .unwrap();
        repo.health().unwrap();
        assert_eq!(
            repo.snapshot().unwrap().investigations.len(),
            MAX_OWNER_INVESTIGATIONS + 1
        );
        assert_eq!(object_count(dir.path()), 2);
    }

    #[test]
    fn initial_node_context_can_be_pinned_once_and_never_rebound() {
        let dir = directory();
        let repo = NativeRepository::open(dir.path()).unwrap();
        let (principal, investigation, node) = create(&repo);
        let first = build_context(&principal, &investigation, &node, None, &[], false, |_| {
            true
        })
        .unwrap();
        let second = build_context(&principal, &investigation, &node, None, &[], false, |_| {
            true
        })
        .unwrap();
        repo.transact(
            &principal,
            &investigation.id,
            0,
            RevisionKind::Semantic,
            None,
            |state| {
                state
                    .nodes
                    .get_mut(&node.version_key())
                    .unwrap()
                    .context_manifest_id = Some(first.manifest.id.clone());
                state
                    .contexts
                    .insert(first.manifest.id.clone(), first.clone());
                Ok(Value::Null)
            },
        )
        .unwrap();
        assert!(
            repo.transact(
                &principal,
                &investigation.id,
                1,
                RevisionKind::Semantic,
                None,
                |state| {
                    state
                        .nodes
                        .get_mut(&node.version_key())
                        .unwrap()
                        .context_manifest_id = Some(second.manifest.id.clone());
                    state
                        .contexts
                        .insert(second.manifest.id.clone(), second.clone());
                    Ok(Value::Null)
                }
            )
            .is_err()
        );
        assert_eq!(
            repo.snapshot().unwrap().nodes[&node.version_key()].context_manifest_id,
            Some(first.manifest.id)
        );
    }

    #[test]
    fn poisoned_mutex_and_failed_commit_have_typed_unavailable_health() {
        let dir = directory();
        let repo = NativeRepository::open(dir.path()).unwrap();
        let (principal, investigation, _) = create(&repo);
        repo.fault.store(1, std::sync::atomic::Ordering::SeqCst);
        assert!(
            repo.transact(
                &principal,
                &investigation.id,
                0,
                RevisionKind::Semantic,
                None,
                |_| Ok(Value::Null)
            )
            .is_err()
        );
        assert!(matches!(repo.health(), Err(KeystoneError::Unavailable(_))));
        assert!(matches!(
            repo.snapshot(),
            Err(KeystoneError::Unavailable(_))
        ));
        assert!(matches!(
            repo.read(&principal, &investigation.id, |_| true),
            Err(KeystoneError::Unavailable(_))
        ));
        drop(repo);
        let repo = NativeRepository::open(dir.path()).unwrap();
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = repo.inner.lock().unwrap();
            panic!("deliberate mutex poison");
        }));
        assert!(matches!(repo.health(), Err(KeystoneError::Unavailable(_))));
        assert!(matches!(
            repo.snapshot(),
            Err(KeystoneError::Unavailable(_))
        ));
        assert!(matches!(
            repo.read(&principal, &investigation.id, |_| true),
            Err(KeystoneError::Unavailable(_))
        ));
    }

    #[test]
    fn accepted_run_reserves_record_capacity_for_terminal_and_restart_events() {
        for terminal in [true, false] {
            let dir = directory();
            let repo = NativeRepository::open(dir.path()).unwrap();
            let (principal, investigation, node) = create(&repo);
            add_run(&repo, &principal, &investigation, &node, RunStatus::Queued);
            // Six retained records plus three reserved records were accepted by add_run.
            repo.transact(
                &principal,
                &investigation.id,
                1,
                RevisionKind::Semantic,
                None,
                |state| {
                    for index in 0..MAX_OWNER_RECORDS - 9 {
                        let key = format!("fill{index}");
                        state.idempotency.insert(
                            idempotency_key(&principal, &key)?,
                            IdempotencyRecord {
                                investigation_id: investigation.id.clone(),
                                tenant_id: principal.tenant_id.clone(),
                                owner_id: principal.owner_id.clone(),
                                key,
                                fingerprint: "durable-replay".into(),
                                response: Value::Null,
                            },
                        );
                    }
                    Ok(Value::Null)
                },
            )
            .unwrap();
            assert!(matches!(
                repo.transact(
                    &principal,
                    &investigation.id,
                    2,
                    RevisionKind::Semantic,
                    Some(IdempotencyRequest {
                        key: "noReserveTheft".into(),
                        fingerprint: "blocked".into()
                    }),
                    |_| Ok(Value::Null)
                ),
                Err(KeystoneError::QuotaExceeded(_))
            ));
            if terminal {
                repo.transact(
                    &principal,
                    &investigation.id,
                    2,
                    RevisionKind::Semantic,
                    None,
                    |state| {
                        let run = state.runs.get_mut("run1").unwrap();
                        run.status = RunStatus::Completed;
                        run.answer = Some("\u{0001}".repeat(MAX_ANSWER_BYTES));
                        let run = run.clone();
                        state.exports.insert(
                            node.version_key(),
                            ParentExport::from_completed(&investigation, &node, &run, vec![])?,
                        );
                        state.events.entry(run.id.clone()).or_default().push(Event {
                            run_id: run.id,
                            node_id: node.id.clone(),
                            sequence: 1,
                            timestamp: run.updated_at,
                            schema_version: SCHEMA_VERSION,
                            kind: "completed".into(),
                            payload: Value::Null,
                        });
                        Ok(Value::Null)
                    },
                )
                .unwrap();
                assert_eq!(
                    repo.snapshot().unwrap().runs["run1"].status,
                    RunStatus::Completed
                );
            } else {
                drop(repo);
                let repo = NativeRepository::open(dir.path()).unwrap();
                assert_eq!(
                    repo.snapshot().unwrap().runs["run1"].status,
                    RunStatus::Interrupted
                );
                assert_eq!(repo.snapshot().unwrap().events["run1"].len(), 1);
            }
        }
    }

    #[test]
    fn accepted_run_reserves_byte_capacity_for_maximum_escaped_answer_and_export() {
        let dir = directory();
        let repo = NativeRepository::open(dir.path()).unwrap();
        let (principal, investigation, node) = create(&repo);
        add_run(&repo, &principal, &investigation, &node, RunStatus::Queued);
        let record = |key: String| IdempotencyRecord {
            investigation_id: investigation.id.clone(),
            tenant_id: principal.tenant_id.clone(),
            owner_id: principal.owner_id.clone(),
            key,
            fingerprint: "retained-data".into(),
            response: Value::String("x".repeat(MAX_ARTIFACT_BYTES - 2)),
        };
        repo.transact(
            &principal,
            &investigation.id,
            1,
            RevisionKind::Semantic,
            None,
            |state| {
                for index in 0..6 {
                    let key = format!("byteFill{index}");
                    state
                        .idempotency
                        .insert(idempotency_key(&principal, &key)?, record(key));
                }
                Ok(Value::Null)
            },
        )
        .unwrap();
        assert!(matches!(
            repo.transact(
                &principal,
                &investigation.id,
                2,
                RevisionKind::Semantic,
                None,
                |state| {
                    let key = "stealReservedBytes".to_owned();
                    state
                        .idempotency
                        .insert(idempotency_key(&principal, &key)?, record(key));
                    Ok(Value::Null)
                }
            ),
            Err(KeystoneError::QuotaExceeded(_))
        ));
        repo.transact(
            &principal,
            &investigation.id,
            2,
            RevisionKind::Semantic,
            None,
            |state| {
                let run = state.runs.get_mut("run1").unwrap();
                run.status = RunStatus::Completed;
                run.answer = Some("\u{0001}".repeat(MAX_ANSWER_BYTES));
                let run = run.clone();
                state.exports.insert(
                    node.version_key(),
                    ParentExport::from_completed(&investigation, &node, &run, vec![])?,
                );
                state.events.entry(run.id.clone()).or_default().push(Event {
                    run_id: run.id,
                    node_id: node.id.clone(),
                    sequence: 1,
                    timestamp: run.updated_at,
                    schema_version: SCHEMA_VERSION,
                    kind: "completed".into(),
                    payload: Value::String("event".into()),
                });
                Ok(Value::Null)
            },
        )
        .unwrap();
        assert_eq!(
            repo.snapshot().unwrap().runs["run1"].status,
            RunStatus::Completed
        );
        repo.health().unwrap();
    }
    #[test]
    fn execution_transaction_cannot_change_graph_revisions_bindings_or_terminal_records() {
        let dir = directory();
        let repo = NativeRepository::open(dir.path()).unwrap();
        let (principal, inv, node) = create(&repo);
        let run = add_run(&repo, &principal, &inv, &node, RunStatus::Queued);
        let accepted = repo.snapshot().unwrap();
        for mutation in 0..5 {
            let result = repo.transact_execution(&principal, &run, |state| {
                match mutation {
                    0 => {
                        state.investigations.get_mut(&inv.id).unwrap().title =
                            "changed graph".into()
                    }
                    1 => {
                        state
                            .investigations
                            .get_mut(&inv.id)
                            .unwrap()
                            .semantic_revision += 1
                    }
                    2 => {
                        state
                            .nodes
                            .get_mut(&node.version_key())
                            .unwrap()
                            .selected_run_id = Some(run.clone())
                    }
                    3 => {
                        state.runs.remove(&run);
                    }
                    _ => {
                        state.runs.get_mut(&run).unwrap().context_hash =
                            "changed context binding".into()
                    }
                }
                Ok(Value::Null)
            });
            assert!(result.is_err());
            assert_eq!(repo.snapshot().unwrap(), accepted);
        }
        repo.transact_execution(&principal, &run, |state| {
            state.runs.get_mut(&run).unwrap().status = RunStatus::Cancelled;
            Ok(Value::Null)
        })
        .unwrap();
        let terminal = repo.snapshot().unwrap();
        assert_eq!(terminal.investigations, accepted.investigations);
        let result = repo.transact_execution(&principal, &run, |state| {
            state.events.entry(run.clone()).or_default().push(Event {
                run_id: run.clone(),
                node_id: node.id.clone(),
                sequence: 1,
                timestamp: chrono::Utc::now().to_rfc3339(),
                schema_version: SCHEMA_VERSION,
                kind: "late_event".into(),
                payload: Value::Null,
            });
            Ok(Value::Null)
        });
        assert!(result.is_err());
        assert_eq!(repo.snapshot().unwrap(), terminal);
        repo.transact_execution(&principal, &run, |_| Ok(Value::Null))
            .unwrap();
        assert_eq!(repo.snapshot().unwrap().generation, terminal.generation);
    }

    /// One investigation with a record in every per-investigation collection, each carrying a
    /// `{tag}_*_sentinel` so cross-investigation leakage is visible in serialized reads.
    fn seed_investigation(
        repo: &NativeRepository,
        principal: &Principal,
        investigation_id: &str,
        tag: &str,
    ) -> Investigation {
        let (_, mut inv, mut node) = fixture();
        inv.id = investigation_id.into();
        inv.tenant_id = principal.tenant_id.clone();
        inv.owner_id = principal.owner_id.clone();
        inv.root_node_id = format!("{tag}Root");
        node.id = inv.root_node_id.clone();
        node.investigation_id = inv.id.clone();
        node.scope.approved_by = principal.owner_id.clone();
        node.prompt = format!("{tag}_prompt_sentinel");
        repo.create(
            principal,
            inv.clone(),
            node.clone(),
            IdempotencyRequest {
                key: format!("create{tag}"),
                fingerprint: "create".into(),
            },
        )
        .unwrap();
        let context = build_context(principal, &inv, &node, None, &[], false, |_| true).unwrap();
        let run_id = format!("{tag}Run");
        let mut completed = run(
            &node,
            &run_id,
            RunStatus::Completed,
            &format!("{tag}_answer_sentinel"),
        );
        completed.context_manifest_id = context.manifest.id.clone();
        completed.context_hash = context.hash.clone();
        repo.transact(
            principal,
            &inv.id,
            0,
            RevisionKind::Semantic,
            Some(IdempotencyRequest {
                key: format!("start{tag}"),
                fingerprint: "start".into(),
            }),
            |state| {
                state.contexts.insert(context.manifest.id.clone(), context);
                state.runs.insert(run_id.clone(), completed.clone());
                state.exports.insert(
                    node.version_key(),
                    ParentExport::from_completed(&inv, &node, &completed, vec![])?,
                );
                state.events.entry(run_id.clone()).or_default().push(Event {
                    run_id: run_id.clone(),
                    node_id: node.id.clone(),
                    sequence: 1,
                    timestamp: completed.updated_at.clone(),
                    schema_version: SCHEMA_VERSION,
                    kind: "completed".into(),
                    payload: serde_json::json!({"tag": format!("{tag}_event_sentinel")}),
                });
                Ok(serde_json::json!({"replay": format!("{tag}_replay_sentinel")}))
            },
        )
        .unwrap();
        let payload = serde_json::json!({"rows":[{"value": format!("{tag}_payload_sentinel")}]});
        let artifact = Artifact {
            id: format!("{tag}Artifact"),
            investigation_id: inv.id.clone(),
            node_id: node.id.clone(),
            run_id: run_id.clone(),
            tenant_id: principal.tenant_id.clone(),
            owner_id: principal.owner_id.clone(),
            schema_version: SCHEMA_VERSION,
            kind: "table".into(),
            datasets: node.scope.datasets.clone(),
            scope: node.scope.clone(),
            executed_sql: Some("SELECT 1".into()),
            result_hash: hash_bytes(&serde_json::to_vec(&payload).unwrap()),
            payload,
            expires_at: None,
            fetched_at: "2026-10-01T00:00:00Z".into(),
            row_count: 1,
            byte_count: 64,
            truncated: false,
        };
        let evidence = Evidence {
            id: format!("{tag}Evidence"),
            artifact_id: artifact.id.clone(),
            investigation_id: inv.id.clone(),
            node_id: node.id.clone(),
            run_id: run_id.clone(),
            tenant_id: principal.tenant_id.clone(),
            owner_id: principal.owner_id.clone(),
            datasets: node.scope.datasets.clone(),
            summary: format!("{tag}_summary_sentinel"),
        };
        let tool = ToolInvocation {
            id: format!("{tag}Tool"),
            provider_call_id: format!("{tag}Call"),
            run_id: run_id.clone(),
            name: "read".into(),
            schema_version: SCHEMA_VERSION,
            arguments: serde_json::json!({"tag": format!("{tag}_tool_sentinel")}),
            scope: node.scope.clone(),
            started_at: "2026-10-01T00:00:00Z".into(),
            ended_at: Some("2026-10-01T00:00:01Z".into()),
            status: "completed".into(),
            attempt: 1,
            execution_id: None,
            artifact_ids: vec![artifact.id.clone()],
        };
        repo.transact(
            principal,
            &inv.id,
            1,
            RevisionKind::Semantic,
            None,
            |state| {
                state.artifacts.insert(artifact.id.clone(), artifact);
                state.evidence.insert(evidence.id.clone(), evidence);
                state.tools.insert(tool.id.clone(), tool);
                Ok(Value::Null)
            },
        )
        .unwrap();
        inv
    }

    #[test]
    fn read_copies_only_the_requested_authorized_investigation() {
        let dir = directory();
        let repo = NativeRepository::open(dir.path()).unwrap();
        let owner = Principal {
            tenant_id: "tenant1".into(),
            owner_id: "owner1".into(),
        };
        let same_tenant = Principal {
            tenant_id: "tenant1".into(),
            owner_id: "owner2".into(),
        };
        let other_tenant = Principal {
            tenant_id: "tenant2".into(),
            owner_id: "owner1".into(),
        };
        let target = seed_investigation(&repo, &owner, "invTarget", "target");
        seed_investigation(&repo, &owner, "invSibling", "sibling");
        seed_investigation(&repo, &same_tenant, "invNeighbour", "neighbour");
        seed_investigation(&repo, &other_tenant, "invForeign", "foreign");
        let full = repo.snapshot().unwrap();
        assert_eq!(full.investigations.len(), 4);
        assert_eq!(full.tools.len(), 4);
        assert_eq!(full.events.len(), 4);

        // The scoped copy equals the previous clone-then-retain result for every investigation,
        // except for the internal idempotency ledger, which `read` always cleared.
        let legacy = |id: &str| {
            let mut state = full.clone();
            state.retain_investigation(id);
            state.idempotency.clear();
            state
        };
        for id in full.investigations.keys() {
            assert_eq!(full.clone_investigation(id), legacy(id));
        }

        let visible = repo.read(&owner, &target.id, |_| true).unwrap();
        assert_eq!(visible, legacy(&target.id));
        assert_eq!(visible.generation, full.generation);
        assert_eq!(
            visible.investigations.keys().collect::<Vec<_>>(),
            vec![&target.id]
        );
        for len in [
            visible.nodes.len(),
            visible.runs.len(),
            visible.contexts.len(),
            visible.exports.len(),
            visible.artifacts.len(),
            visible.evidence.len(),
            visible.events.len(),
            visible.tools.len(),
        ] {
            assert_eq!(len, 1);
        }
        assert_eq!(visible.events["targetRun"].len(), 1);
        assert!(visible.idempotency.is_empty());
        let serialized = serde_json::to_string(&visible).unwrap();
        for suffix in ["prompt", "answer", "event", "payload", "summary", "tool"] {
            assert!(serialized.contains(&format!("target_{suffix}_sentinel")));
        }
        assert!(!serialized.contains("_replay_sentinel"));
        // Bare words such as "sibling" occur in context instructions, so match seeded markers.
        for (tag, id) in [
            ("sibling", "invSibling"),
            ("neighbour", "invNeighbour"),
            ("foreign", "invForeign"),
        ] {
            for marker in [
                format!("{tag}_"),
                format!("{tag}Root"),
                format!("{tag}Run"),
                id.to_string(),
            ] {
                assert!(
                    !serialized.contains(&marker),
                    "{marker} leaked into scoped read"
                );
            }
        }

        // Ownership is still checked before any record is copied; outcomes are unchanged.
        assert!(matches!(
            repo.read(&same_tenant, &target.id, |_| true),
            Err(KeystoneError::Forbidden)
        ));
        assert!(matches!(
            repo.read(&other_tenant, &target.id, |_| true),
            Err(KeystoneError::Forbidden)
        ));
        assert!(matches!(
            repo.read(&owner, "invMissing", |_| true),
            Err(KeystoneError::NotFound)
        ));
        // Current dataset RBAC applies to the scoped records.
        assert!(matches!(
            repo.read(&owner, &target.id, |_| false),
            Err(KeystoneError::Forbidden)
        ));
        let neighbour = repo.read(&same_tenant, "invNeighbour", |_| true).unwrap();
        assert_eq!(neighbour, legacy("invNeighbour"));
        let neighbour = serde_json::to_string(&neighbour).unwrap();
        for marker in ["target_", "targetRoot", "targetRun", "invTarget"] {
            assert!(
                !neighbour.contains(marker),
                "{marker} leaked into scoped read"
            );
        }
        assert_eq!(repo.snapshot().unwrap(), full);
    }

    #[test]
    fn owned_summaries_copy_only_the_callers_investigations_and_dependencies() {
        let dir = directory();
        let repo = NativeRepository::open(dir.path()).unwrap();
        let owner = Principal {
            tenant_id: "tenant1".into(),
            owner_id: "owner1".into(),
        };
        let neighbour = Principal {
            tenant_id: "tenant1".into(),
            owner_id: "owner2".into(),
        };
        let foreign = Principal {
            tenant_id: "tenant2".into(),
            owner_id: "owner1".into(),
        };
        seed_investigation(&repo, &owner, "invB", "second");
        seed_investigation(&repo, &owner, "invA", "first");
        seed_investigation(&repo, &neighbour, "invN", "neighbour");
        seed_investigation(&repo, &foreign, "invF", "foreign");
        let full = repo.snapshot().unwrap();
        let summaries = repo.owned_summaries(&owner).unwrap();
        // Exactly the investigations the full-snapshot filter authorized, in id order.
        let expected: Vec<_> = full
            .investigations
            .values()
            .filter(|i| i.authorize(&owner).is_ok())
            .cloned()
            .collect();
        assert_eq!(
            summaries
                .iter()
                .map(|s| s.investigation.clone())
                .collect::<Vec<_>>(),
            expected
        );
        for summary in &summaries {
            let id = &summary.investigation.id;
            let datasets: BTreeSet<_> = full
                .nodes
                .values()
                .filter(|n| &n.investigation_id == id)
                .flat_map(|n| n.scope.datasets.iter().cloned())
                .chain(
                    full.evidence
                        .values()
                        .filter(|e| &e.investigation_id == id)
                        .flat_map(|e| e.datasets.iter().cloned()),
                )
                .collect();
            assert_eq!(summary.datasets, datasets);
            let first = full
                .nodes
                .iter()
                .find(|(_, n)| &n.investigation_id == id)
                .map(|(key, n)| (key.clone(), n.scope.clone()));
            assert_eq!(summary.first_node, first);
        }
        assert!(repo.owned_summaries(&neighbour).unwrap().len() == 1);
        assert!(
            repo.owned_summaries(&Principal {
                tenant_id: "tenant3".into(),
                owner_id: "owner1".into(),
            })
            .unwrap()
            .is_empty()
        );
        assert_eq!(repo.snapshot().unwrap(), full);
    }

    #[tokio::test]
    async fn blocking_lane_bounds_started_jobs_and_finishes_started_work_after_callers_drop() {
        use std::sync::{Condvar, atomic::AtomicUsize};
        let dir = directory();
        let repo = Arc::new(NativeRepository::open(dir.path()).unwrap());
        let started = Arc::new(AtomicUsize::new(0));
        let finished = Arc::new(Mutex::new(BTreeSet::new()));
        let open = Arc::new((Mutex::new(false), Condvar::new()));
        let (entered_tx, mut entered) = tokio::sync::mpsc::unbounded_channel();
        let total = BLOCKING_OPERATIONS + 2;
        let mut callers = Vec::new();
        for index in 0..total {
            let repo = repo.clone();
            let (started, finished, open, entered_tx) = (
                started.clone(),
                finished.clone(),
                open.clone(),
                entered_tx.clone(),
            );
            callers.push(tokio::spawn(async move {
                repo.blocking(move |repo| {
                    started.fetch_add(1, Ordering::SeqCst);
                    entered_tx.send(index).unwrap();
                    let (lock, ready) = &*open;
                    let mut opened = lock.lock().unwrap();
                    while !*opened {
                        opened = ready.wait(opened).unwrap();
                    }
                    // Each job still holds a working repository handle.
                    repo.health()?;
                    finished.lock().unwrap().insert(index);
                    Ok::<_, KeystoneError>(index)
                })
                .await
            }));
        }
        let mut running = BTreeSet::new();
        for _ in 0..BLOCKING_OPERATIONS {
            running.insert(entered.recv().await.unwrap());
        }
        // Every permit is held by a job that cannot return, so no further job can start.
        assert_eq!(started.load(Ordering::SeqCst), BLOCKING_OPERATIONS);
        assert!(entered.try_recv().is_err());
        // Dropping a started caller detaches its job; dropping a queued caller cancels it
        // before any work.
        let dropped_running = *running.first().unwrap();
        let dropped_queued = (0..total).find(|i| !running.contains(i)).unwrap();
        callers[dropped_running].abort();
        callers[dropped_queued].abort();
        let (lock, ready) = &*open;
        *lock.lock().unwrap() = true;
        ready.notify_all();
        for (index, caller) in callers.into_iter().enumerate() {
            match caller.await {
                Ok(result) => assert_eq!(result.unwrap(), index),
                Err(error) => {
                    assert!(error.is_cancelled());
                    assert!(index == dropped_running || index == dropped_queued);
                }
            }
        }
        repo.drain_blocking().await;
        let finished = finished.lock().unwrap().clone();
        assert_eq!(
            finished,
            (0..total).filter(|i| *i != dropped_queued).collect()
        );
        assert_eq!(started.load(Ordering::SeqCst), total - 1);
    }
}
