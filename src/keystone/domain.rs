//! Native Keystone records. IDs identify immutable versions, never provider conversations.
use std::collections::{BTreeMap, BTreeSet};

use chrono::DateTime;
use serde::{Deserialize, Serialize};

pub const SCHEMA_VERSION: u32 = 1;
pub const MAX_PROMPT_BYTES: usize = 16 * 1024;
pub const MAX_ANSWER_BYTES: usize = 128 * 1024;
pub const MAX_ARTIFACT_BYTES: usize = 1024 * 1024;
pub const MAX_NODES: usize = 1_000;
pub const CONTEXT_POLICY: &str = "direct_parent_v1";

#[derive(Debug, thiserror::Error)]
pub enum KeystoneError {
    #[error("Keystone run capacity reached")]
    RunCapacity,
    #[error("invalid Keystone record: {0}")]
    Invalid(String),
    #[error("permission denied")]
    Forbidden,
    #[error("record not found")]
    NotFound,
    #[error("revision or idempotency conflict")]
    Conflict,
    #[error("another Keystone coordinator holds the storage lock")]
    CoordinatorLocked,
    #[error("Keystone storage unavailable: {0}")]
    Unavailable(String),
    #[error("Keystone capacity exceeded: {0}")]
    QuotaExceeded(String),
    #[error("Keystone storage error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Keystone serialization error: {0}")]
    Json(#[from] serde_json::Error),
}
pub type Result<T> = std::result::Result<T, KeystoneError>;

pub fn validate_id(id: &str) -> Result<()> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err(KeystoneError::Invalid(
            "unsafe or oversized identifier".into(),
        ));
    }
    Ok(())
}
pub fn bounded_text(value: &str, max: usize, field: &str) -> Result<()> {
    if value.is_empty() || value.len() > max || value.contains('\0') {
        return Err(KeystoneError::Invalid(format!("invalid {field}")));
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Principal {
    pub tenant_id: String,
    pub owner_id: String,
}
impl Principal {
    pub fn validate(&self) -> Result<()> {
        validate_id(&self.tenant_id)?;
        bounded_text(&self.owner_id, 256, "owner")
    }
    pub fn authorize(&self, tenant: &str, owner: &str) -> Result<()> {
        if self.tenant_id != tenant || self.owner_id != owner {
            return Err(KeystoneError::Forbidden);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScopeVersion {
    pub id: String,
    pub datasets: Vec<String>,
    pub absolute_start: String,
    pub absolute_end: String,
    pub timezone: String,
    pub filters: BTreeMap<String, String>,
    pub approved_by: String,
}
impl ScopeVersion {
    pub fn validate(&self) -> Result<()> {
        validate_id(&self.id)?;
        if self.datasets.is_empty() || self.datasets.len() > 32 {
            return Err(KeystoneError::Invalid("dataset count".into()));
        }
        let mut unique = BTreeSet::new();
        for dataset in &self.datasets {
            bounded_text(dataset, 128, "dataset")?;
            if dataset.starts_with('_')
                || !dataset
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            {
                return Err(KeystoneError::Invalid(
                    "qualified, internal or unsafe dataset".into(),
                ));
            }
            if !unique.insert(dataset) {
                return Err(KeystoneError::Invalid("duplicate dataset".into()));
            }
        }
        bounded_text(&self.absolute_start, 64, "scope start")?;
        bounded_text(&self.absolute_end, 64, "scope end")?;
        let start = DateTime::parse_from_rfc3339(&self.absolute_start)
            .map_err(|_| KeystoneError::Invalid("start must be absolute RFC3339".into()))?;
        let end = DateTime::parse_from_rfc3339(&self.absolute_end)
            .map_err(|_| KeystoneError::Invalid("end must be absolute RFC3339".into()))?;
        if start >= end {
            return Err(KeystoneError::Invalid("empty time range".into()));
        }
        bounded_text(&self.timezone, 128, "timezone")?;
        bounded_text(&self.approved_by, 256, "scope approver")?;
        if self.filters.len() > 32 {
            return Err(KeystoneError::Invalid("filter count".into()));
        }
        for (key, value) in &self.filters {
            bounded_text(key, 128, "filter name")?;
            bounded_text(value, 2048, "filter value")?;
        }
        Ok(())
    }
    /// Approval changes identity/version; only this comparison decides whether review is required.
    pub fn same_bounds(&self, other: &Self) -> bool {
        self.datasets == other.datasets
            && self.absolute_start == other.absolute_start
            && self.absolute_end == other.absolute_end
            && self.timezone == other.timezone
            && self.filters == other.filters
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Investigation {
    pub id: String,
    pub schema_version: u32,
    pub tenant_id: String,
    pub owner_id: String,
    pub title: String,
    pub root_node_id: String,
    pub semantic_revision: u64,
    pub layout_revision: u64,
    pub created_at: String,
    pub updated_at: String,
    pub archived: bool,
}
impl Investigation {
    pub fn authorize(&self, principal: &Principal) -> Result<()> {
        principal.authorize(&self.tenant_id, &self.owner_id)
    }
    pub fn validate(&self) -> Result<()> {
        validate_id(&self.id)?;
        validate_id(&self.root_node_id)?;
        validate_id(&self.tenant_id)?;
        bounded_text(&self.owner_id, 256, "owner")?;
        bounded_text(&self.title, 256, "title")?;
        if self.schema_version != SCHEMA_VERSION {
            return Err(KeystoneError::Invalid("schema version".into()));
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ParentReference {
    pub node_id: String,
    pub version: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Node {
    pub id: String,
    pub investigation_id: String,
    pub version: u64,
    pub parent: Option<ParentReference>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch_intent: Option<String>,
    pub prompt: String,
    pub scope: ScopeVersion,
    pub selected_run_id: Option<String>,
    #[serde(default)]
    pub context_manifest_id: Option<String>,
}
pub type InvestigationNode = Node;
impl Node {
    pub fn version_key(&self) -> String {
        format!("{}-v{}", self.id, self.version)
    }
    pub fn validate(&self) -> Result<()> {
        validate_id(&self.id)?;
        validate_id(&self.investigation_id)?;
        if self.version == 0 {
            return Err(KeystoneError::Invalid("zero node version".into()));
        }
        bounded_text(&self.prompt, MAX_PROMPT_BYTES, "prompt")?;
        if self
            .branch_intent
            .as_deref()
            .is_some_and(|v| !matches!(v, "follow_up" | "explore"))
        {
            return Err(KeystoneError::Invalid("branch intent".into()));
        }
        self.scope.validate()?;
        if let Some(parent) = &self.parent {
            validate_id(&parent.node_id)?;
            if parent.node_id == self.id || parent.version == 0 {
                return Err(KeystoneError::Invalid("invalid parent".into()));
            }
        }
        if let Some(run) = &self.selected_run_id {
            validate_id(run)?;
        }
        if let Some(context) = &self.context_manifest_id {
            validate_id(context)?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Queued,
    Running,
    Completed,
    Partial,
    Cancelled,
    Failed,
    Interrupted,
}
impl RunStatus {
    pub fn is_terminal(self) -> bool {
        !matches!(self, Self::Queued | Self::Running)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Run {
    pub id: String,
    pub node_id: String,
    pub investigation_id: String,
    pub attempt: u32,
    pub prompt_version: u64,
    pub scope: ScopeVersion,
    pub context_manifest_id: String,
    pub context_hash: String,
    pub provider_config_revision: u64,
    pub status: RunStatus,
    pub answer: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub grant: Option<GrantIdentity>,
}

/// Durable attribution only. Live authorization is resolved again; credentials are never stored.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GrantIdentity {
    pub principal_id: String,
    pub authorization_revision: String,
}

/// An export contains the parent's own output only. No input context or ancestry field exists.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ParentExport {
    pub node_id: String,
    pub node_version: u64,
    pub investigation_id: String,
    pub tenant_id: String,
    pub owner_id: String,
    pub run_id: String,
    pub status: RunStatus,
    pub prompt: String,
    pub answer: String,
    pub scope: ScopeVersion,
    pub evidence_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Artifact {
    pub id: String,
    pub investigation_id: String,
    pub node_id: String,
    pub run_id: String,
    pub tenant_id: String,
    pub owner_id: String,
    pub schema_version: u32,
    pub kind: String,
    pub datasets: Vec<String>,
    pub scope: ScopeVersion,
    pub executed_sql: Option<String>,
    pub payload: serde_json::Value,
    pub result_hash: String,
    pub fetched_at: String,
    pub expires_at: Option<String>,
    pub row_count: u64,
    pub byte_count: u64,
    pub truncated: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Evidence {
    pub id: String,
    pub artifact_id: String,
    pub investigation_id: String,
    pub node_id: String,
    pub run_id: String,
    pub tenant_id: String,
    pub owner_id: String,
    pub datasets: Vec<String>,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolInvocation {
    pub id: String,
    pub provider_call_id: String,
    pub run_id: String,
    pub name: String,
    pub schema_version: u32,
    pub arguments: serde_json::Value,
    pub scope: ScopeVersion,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub status: String,
    pub attempt: u32,
    pub execution_id: Option<String>,
    pub artifact_ids: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Event {
    pub run_id: String,
    pub node_id: String,
    pub sequence: u64,
    pub timestamp: String,
    pub schema_version: u32,
    pub kind: String,
    pub payload: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextManifest {
    pub id: String,
    pub schema_version: u32,
    pub context_policy: String,
    pub investigation_id: String,
    pub node_id: String,
    pub node_version: u64,
    pub prompt: String,
    pub scope: ScopeVersion,
    pub direct_parent: Option<ParentReference>,
    pub parent_export: Option<ParentExport>,
    pub parent_export_hash: Option<String>,
    pub evidence: Vec<Evidence>,
    pub omitted_fields: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeGeometry {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub pinned: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collapsed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expanded_height: Option<f64>,
}
impl NodeGeometry {
    pub fn validate(&self) -> Result<()> {
        if ![self.x, self.y, self.width, self.height]
            .into_iter()
            .all(f64::is_finite)
            || self.x.abs() > 1_000_000.0
            || self.y.abs() > 1_000_000.0
            || !(100.0..=4096.0).contains(&self.width)
            || !(80.0..=4096.0).contains(&self.height)
            || self
                .expanded_height
                .is_some_and(|height| !height.is_finite() || !(80.0..=4096.0).contains(&height))
        {
            return Err(KeystoneError::Invalid("invalid layout geometry".into()));
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanvasLayout {
    pub investigation_id: String,
    pub revision: u64,
    pub nodes: BTreeMap<String, NodeGeometry>,
}
