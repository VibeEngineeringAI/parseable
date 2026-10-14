//! The only context builder: neither graph traversal nor provider history is accepted.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::domain::*;

pub const MAX_CONTEXT_BYTES: usize = 128 * 1024;

pub fn hash_bytes(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PinnedContext {
    pub manifest: ContextManifest,
    pub manifest_hash: String,
    pub bytes: Vec<u8>,
    pub hash: String,
}
pub type PinnedContextRecord = PinnedContext;
impl PinnedContext {
    pub fn verify(&self) -> Result<()> {
        if self.bytes.len() > MAX_CONTEXT_BYTES
            || hash_bytes(&self.bytes) != self.hash
            || hash_bytes(&serde_json::to_vec(&self.manifest)?) != self.manifest_hash
            || provider_projection(&self.manifest)? != self.bytes
        {
            return Err(KeystoneError::Invalid("context bytes/hash mismatch".into()));
        }
        Ok(())
    }
}

/// Explicit allowlist for provider-visible data. Internal authorization identities and approval
/// metadata never become provider messages by serializing a domain record wholesale.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderScope<'a> {
    datasets: &'a [String],
    absolute_start: &'a str,
    absolute_end: &'a str,
    timezone: &'a str,
    filters: &'a std::collections::BTreeMap<String, String>,
}
impl<'a> From<&'a ScopeVersion> for ProviderScope<'a> {
    fn from(scope: &'a ScopeVersion) -> Self {
        Self {
            datasets: &scope.datasets,
            absolute_start: &scope.absolute_start,
            absolute_end: &scope.absolute_end,
            timezone: &scope.timezone,
            filters: &scope.filters,
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderParent<'a> {
    prompt: &'a str,
    answer: &'a str,
    scope: ProviderScope<'a>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderEvidence<'a> {
    id: &'a str,
    artifact_id: &'a str,
    datasets: &'a [String],
    summary: &'a str,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderProjection<'a> {
    prompt: &'a str,
    scope: ProviderScope<'a>,
    #[serde(skip_serializing_if = "Option::is_none")]
    parent: Option<ProviderParent<'a>>,
    evidence: Vec<ProviderEvidence<'a>>,
}
fn provider_projection(manifest: &ContextManifest) -> Result<Vec<u8>> {
    Ok(serde_json::to_vec(&ProviderProjection {
        prompt: &manifest.prompt,
        scope: (&manifest.scope).into(),
        parent: manifest
            .parent_export
            .as_ref()
            .map(|parent| ProviderParent {
                prompt: &parent.prompt,
                answer: &parent.answer,
                scope: (&parent.scope).into(),
            }),
        evidence: manifest
            .evidence
            .iter()
            .map(|evidence| ProviderEvidence {
                id: &evidence.id,
                artifact_id: &evidence.artifact_id,
                datasets: &evidence.datasets,
                summary: &evidence.summary,
            })
            .collect(),
    })?)
}

#[cfg(test)]
mod projection_tests {
    use super::tests::{fixture, run};
    use super::*;
    #[test]
    fn provider_projection_omits_internal_identity_and_pins_manifest_separately() {
        let (mut principal, mut investigation, mut parent) = fixture();
        principal.owner_id = "private_owner_sentinel".into();
        principal.tenant_id = "private_tenant_sentinel".into();
        investigation.owner_id = principal.owner_id.clone();
        investigation.tenant_id = principal.tenant_id.clone();
        parent.scope.approved_by = principal.owner_id.clone();
        let export = ParentExport::from_completed(
            &investigation,
            &parent,
            &run(
                &parent,
                "parentRun",
                RunStatus::Completed,
                "own completed answer",
            ),
            vec![],
        )
        .unwrap();
        let mut child = parent.clone();
        child.id = "childNode".into();
        child.prompt = "child own prompt".into();
        child.parent = Some(ParentReference {
            node_id: parent.id.clone(),
            version: 1,
        });
        let context = build_context(
            &principal,
            &investigation,
            &child,
            Some(&export),
            &[],
            false,
            |_| true,
        )
        .unwrap();
        let wire = String::from_utf8(context.bytes.clone()).unwrap();
        for forbidden in [
            "private_owner_sentinel",
            "private_tenant_sentinel",
            "approvedBy",
            "ownerId",
            "tenantId",
            "investigationId",
            "nodeId",
            "runId",
            "scope1",
            "parentRun",
        ] {
            assert!(
                !wire.contains(forbidden),
                "provider metadata leaked: {forbidden}"
            );
        }
        let projection: serde_json::Value = serde_json::from_slice(&context.bytes).unwrap();
        assert_eq!(
            projection
                .as_object()
                .unwrap()
                .keys()
                .cloned()
                .collect::<std::collections::BTreeSet<_>>(),
            std::collections::BTreeSet::from([
                "evidence".to_string(),
                "parent".to_string(),
                "prompt".to_string(),
                "scope".to_string()
            ])
        );
        assert_eq!(projection["parent"]["prompt"], parent.prompt);
        assert_eq!(projection["parent"]["answer"], "own completed answer");
        assert_eq!(
            projection["scope"]["absoluteStart"],
            parent.scope.absolute_start
        );
        context.verify().unwrap();
        let mut changed = context.clone();
        changed.manifest.parent_export.as_mut().unwrap().tenant_id =
            "different_internal_tenant".into();
        assert_eq!(
            provider_projection(&changed.manifest).unwrap(),
            context.bytes
        );
        assert!(
            changed.verify().is_err(),
            "internal manifest must remain independently pinned"
        );
        let mut changed = context;
        changed.bytes[0] = b'[';
        assert!(changed.verify().is_err());
    }
}

impl ParentExport {
    /// Construct from this node's completed output, never from the run's input manifest.
    pub fn from_completed(
        investigation: &Investigation,
        node: &Node,
        run: &Run,
        evidence_ids: Vec<String>,
    ) -> Result<Self> {
        if node.investigation_id != investigation.id
            || run.investigation_id != investigation.id
            || run.node_id != node.id
            || run.prompt_version != node.version
            || run.status != RunStatus::Completed
            || run.scope != node.scope
        {
            return Err(KeystoneError::Invalid(
                "parent export requires matching completed run".into(),
            ));
        }
        let answer = run
            .answer
            .clone()
            .ok_or_else(|| KeystoneError::Invalid("completed parent has no answer".into()))?;
        bounded_text(&answer, MAX_ANSWER_BYTES, "parent answer")?;
        if evidence_ids.len() > 64 {
            return Err(KeystoneError::Invalid(
                "too many export evidence references".into(),
            ));
        }
        for id in &evidence_ids {
            validate_id(id)?;
        }
        Ok(Self {
            node_id: node.id.clone(),
            node_version: node.version,
            investigation_id: investigation.id.clone(),
            tenant_id: investigation.tenant_id.clone(),
            owner_id: investigation.owner_id.clone(),
            run_id: run.id.clone(),
            status: run.status,
            prompt: node.prompt.clone(),
            answer,
            scope: node.scope.clone(),
            evidence_ids,
        })
    }
}

/// A reviewed scope change is explicit; unchanged bounds retain the exact parent's version.
pub fn build_context(
    principal: &Principal,
    investigation: &Investigation,
    node: &Node,
    parent: Option<&ParentExport>,
    selected_evidence: &[Evidence],
    scope_change_reviewed: bool,
    can_read_dataset: impl FnMut(&str) -> bool,
) -> Result<PinnedContext> {
    build_context_authorized(
        principal,
        investigation,
        node,
        parent,
        selected_evidence,
        scope_change_reviewed,
        |_| false,
        can_read_dataset,
    )
}

/// Evidence authorization must validate the immutable artifact, its expiry and current access.
// Each argument is checked independently against the session principal and the
// two authorization callbacks; bundling them would hide which input failed.
#[allow(clippy::too_many_arguments)]
pub fn build_context_authorized(
    principal: &Principal,
    investigation: &Investigation,
    node: &Node,
    parent: Option<&ParentExport>,
    selected_evidence: &[Evidence],
    scope_change_reviewed: bool,
    mut authorize_evidence: impl FnMut(&Evidence) -> bool,
    mut can_read_dataset: impl FnMut(&str) -> bool,
) -> Result<PinnedContext> {
    principal.validate()?;
    investigation.authorize(principal)?;
    node.validate()?;
    if node.investigation_id != investigation.id {
        return Err(KeystoneError::Forbidden);
    }
    if node.scope.approved_by != principal.owner_id {
        return Err(KeystoneError::Forbidden);
    }
    for dataset in &node.scope.datasets {
        if !can_read_dataset(dataset) {
            return Err(KeystoneError::Forbidden);
        }
    }
    if selected_evidence.len() > 64 {
        return Err(KeystoneError::Invalid("too much inherited evidence".into()));
    }
    let (export, export_hash) = match (&node.parent, parent) {
        (None, None) => {
            if !selected_evidence.is_empty() {
                return Err(KeystoneError::Invalid(
                    "root cannot inherit evidence".into(),
                ));
            }
            (None, None)
        }
        (Some(reference), Some(parent)) => {
            principal.authorize(&parent.tenant_id, &parent.owner_id)?;
            if reference.node_id != parent.node_id
                || reference.version != parent.node_version
                || parent.investigation_id != investigation.id
                || parent.status != RunStatus::Completed
            {
                return Err(KeystoneError::Invalid(
                    "parent must be the exact completed direct version".into(),
                ));
            }
            parent.scope.validate()?;
            bounded_text(&parent.prompt, MAX_PROMPT_BYTES, "parent prompt")?;
            bounded_text(&parent.answer, MAX_ANSWER_BYTES, "parent answer")?;
            for dataset in &parent.scope.datasets {
                if !can_read_dataset(dataset) {
                    return Err(KeystoneError::Forbidden);
                }
            }
            if parent.scope.same_bounds(&node.scope) {
                if parent.scope != node.scope {
                    return Err(KeystoneError::Invalid(
                        "unchanged scope must preserve its version".into(),
                    ));
                }
            } else if !scope_change_reviewed {
                return Err(KeystoneError::Invalid(
                    "scope change requires review".into(),
                ));
            }
            let mut inherited = parent.clone();
            // Pin only the explicit authorized selection, not all IDs offered by the export.
            inherited.evidence_ids.clear();
            for evidence in selected_evidence {
                if !authorize_evidence(evidence) {
                    return Err(KeystoneError::Forbidden);
                }
                principal.authorize(&evidence.tenant_id, &evidence.owner_id)?;
                validate_id(&evidence.id)?;
                validate_id(&evidence.artifact_id)?;
                bounded_text(&evidence.summary, 8192, "evidence summary")?;
                if evidence.investigation_id != investigation.id
                    || evidence.node_id != parent.node_id
                    || evidence.run_id != parent.run_id
                    || !parent.evidence_ids.contains(&evidence.id)
                    || inherited.evidence_ids.contains(&evidence.id)
                    || evidence.datasets.is_empty()
                    || evidence.datasets.len() > 32
                {
                    return Err(KeystoneError::Invalid(
                        "evidence is not explicit direct-parent output".into(),
                    ));
                }
                for dataset in &evidence.datasets {
                    if !parent.scope.datasets.contains(dataset) || !can_read_dataset(dataset) {
                        return Err(KeystoneError::Forbidden);
                    }
                }
                inherited.evidence_ids.push(evidence.id.clone());
            }
            let hash = hash_bytes(&serde_json::to_vec(&inherited)?);
            (Some(inherited), Some(hash))
        }
        _ => {
            return Err(KeystoneError::Invalid(
                "missing or unexpected parent export".into(),
            ));
        }
    };
    let manifest = ContextManifest {
        id: ulid::Ulid::new().to_string(),
        schema_version: SCHEMA_VERSION,
        context_policy: CONTEXT_POLICY.into(),
        investigation_id: investigation.id.clone(),
        node_id: node.id.clone(),
        node_version: node.version,
        prompt: node.prompt.clone(),
        scope: node.scope.clone(),
        direct_parent: node.parent.clone(),
        parent_export: export,
        parent_export_hash: export_hash,
        evidence: selected_evidence.to_vec(),
        omitted_fields: vec![
            "parent_input_context".into(),
            "ancestor_transcripts".into(),
            "siblings".into(),
        ],
    };
    let manifest_hash = hash_bytes(&serde_json::to_vec(&manifest)?);
    let bytes = provider_projection(&manifest)?;
    if bytes.len() > MAX_CONTEXT_BYTES {
        return Err(KeystoneError::Invalid("context exceeds byte budget".into()));
    }
    Ok(PinnedContext {
        manifest_hash,
        hash: hash_bytes(&bytes),
        bytes,
        manifest,
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::collections::BTreeMap;
    pub fn fixture() -> (Principal, Investigation, Node) {
        let principal = Principal {
            tenant_id: "tenant1".into(),
            owner_id: "owner1".into(),
        };
        let investigation = Investigation {
            id: "inv1".into(),
            schema_version: 1,
            tenant_id: principal.tenant_id.clone(),
            owner_id: principal.owner_id.clone(),
            title: "incident".into(),
            root_node_id: "P".into(),
            semantic_revision: 0,
            layout_revision: 0,
            created_at: "2026-09-01T00:00:00Z".into(),
            updated_at: "2026-09-01T00:00:00Z".into(),
            archived: false,
        };
        let scope = ScopeVersion {
            id: "scope1".into(),
            datasets: vec!["logs".into()],
            absolute_start: "2026-09-01T00:00:00Z".into(),
            absolute_end: "2026-10-01T00:00:00Z".into(),
            timezone: "UTC".into(),
            filters: BTreeMap::new(),
            approved_by: principal.owner_id.clone(),
        };
        let node = Node {
            id: "P".into(),
            investigation_id: investigation.id.clone(),
            version: 1,
            parent: None,
            branch_intent: None,
            prompt: "hidden_P_sentinel".into(),
            scope,
            selected_run_id: None,
            context_manifest_id: None,
        };
        (principal, investigation, node)
    }
    pub fn run(node: &Node, id: &str, status: RunStatus, answer: &str) -> Run {
        Run {
            id: id.into(),
            node_id: node.id.clone(),
            investigation_id: node.investigation_id.clone(),
            attempt: 1,
            prompt_version: node.version,
            scope: node.scope.clone(),
            context_manifest_id: "context1".into(),
            context_hash: "hash".into(),
            provider_config_revision: 1,
            status,
            answer: Some(answer.into()),
            created_at: "2026-10-01T00:00:00Z".into(),
            updated_at: "2026-10-01T00:00:00Z".into(),
            grant: None,
        }
    }
    #[test]
    fn direct_parent_only_excludes_siblings_and_ancestors_and_retains_30_days() {
        let (principal, inv, p) = fixture();
        let root = build_context(&principal, &inv, &p, None, &[], false, |_| true).unwrap();
        assert!(root.manifest.parent_export.is_none());
        let p_export = ParentExport::from_completed(
            &inv,
            &p,
            &run(&p, "runP", RunStatus::Completed, "P answer"),
            vec![],
        )
        .unwrap();
        let mut a = p.clone();
        a.id = "A".into();
        a.parent = Some(ParentReference {
            node_id: "P".into(),
            version: 1,
        });
        a.prompt = "A own prompt".into();
        let frozen_a =
            build_context(&principal, &inv, &a, Some(&p_export), &[], false, |_| true).unwrap();
        let mut b = a.clone();
        b.id = "B".into();
        b.prompt = "sibling_B_sentinel".into();
        let frozen_b =
            build_context(&principal, &inv, &b, Some(&p_export), &[], false, |_| true).unwrap();
        assert!(
            !String::from_utf8(frozen_a.bytes)
                .unwrap()
                .contains("sibling_B_sentinel")
        );
        assert!(
            !String::from_utf8(frozen_b.bytes)
                .unwrap()
                .contains("A own prompt")
        );
        let a_export = ParentExport::from_completed(
            &inv,
            &a,
            &run(&a, "runA", RunStatus::Completed, "A own answer"),
            vec![],
        )
        .unwrap();
        let mut c = a.clone();
        c.id = "C".into();
        c.prompt = "C own prompt".into();
        c.parent = Some(ParentReference {
            node_id: "A".into(),
            version: 1,
        });
        let frozen_c =
            build_context(&principal, &inv, &c, Some(&a_export), &[], false, |_| true).unwrap();
        assert!(
            !String::from_utf8(frozen_c.bytes.clone())
                .unwrap()
                .contains("hidden_P_sentinel")
        );
        assert_eq!(frozen_c.manifest.scope, p.scope);
        frozen_c.verify().unwrap();
    }
    #[test]
    fn permissions_completion_and_explicit_scope_review_are_required() {
        let (principal, inv, p) = fixture();
        assert!(build_context(&principal, &inv, &p, None, &[], false, |_| false).is_err());
        let mut stranger = principal.clone();
        stranger.owner_id = "other".into();
        assert!(build_context(&stranger, &inv, &p, None, &[], false, |_| true).is_err());
        stranger = principal.clone();
        stranger.tenant_id = "other".into();
        assert!(build_context(&stranger, &inv, &p, None, &[], false, |_| true).is_err());
        assert!(
            ParentExport::from_completed(
                &inv,
                &p,
                &run(&p, "runP", RunStatus::Partial, "partial"),
                vec![]
            )
            .is_err()
        );
        let export = ParentExport::from_completed(
            &inv,
            &p,
            &run(&p, "runP", RunStatus::Completed, "answer"),
            vec![],
        )
        .unwrap();
        let mut child = p.clone();
        child.id = "A".into();
        child.parent = Some(ParentReference {
            node_id: "P".into(),
            version: 1,
        });
        child.scope.id = "scope2".into();
        child.scope.absolute_start = "2026-09-30T00:00:00Z".into();
        assert!(
            build_context(&principal, &inv, &child, Some(&export), &[], false, |_| {
                true
            })
            .is_err()
        );
        build_context(&principal, &inv, &child, Some(&export), &[], true, |_| true).unwrap();
    }
    #[test]
    fn evidence_revocation_and_parent_edits_do_not_change_frozen_bytes() {
        let (principal, inv, p) = fixture();
        let mut export = ParentExport::from_completed(
            &inv,
            &p,
            &run(&p, "runP", RunStatus::Completed, "answer"),
            vec!["e1".into()],
        )
        .unwrap();
        let evidence = Evidence {
            id: "e1".into(),
            artifact_id: "artifact1".into(),
            investigation_id: inv.id.clone(),
            node_id: p.id.clone(),
            run_id: "runP".into(),
            tenant_id: principal.tenant_id.clone(),
            owner_id: principal.owner_id.clone(),
            datasets: vec!["logs".into()],
            summary: "result".into(),
        };
        let mut child = p.clone();
        child.id = "A".into();
        child.parent = Some(ParentReference {
            node_id: "P".into(),
            version: 1,
        });
        let frozen = build_context_authorized(
            &principal,
            &inv,
            &child,
            Some(&export),
            std::slice::from_ref(&evidence),
            false,
            |_| true,
            |_| true,
        )
        .unwrap();
        assert!(
            build_context(
                &principal,
                &inv,
                &child,
                Some(&export),
                &[evidence],
                false,
                |_| false
            )
            .is_err()
        );
        let bytes = frozen.bytes.clone();
        export.answer = "changed parent".into();
        export.node_version = 2;
        assert_eq!(frozen.bytes, bytes);
        frozen.verify().unwrap();
        assert!(
            build_context(&principal, &inv, &child, Some(&export), &[], false, |_| {
                true
            })
            .is_err()
        );
    }
}
