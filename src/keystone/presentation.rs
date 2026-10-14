//! Browser projections of authorized native records. No graph context is assembled here.
use super::{domain::*, repository::RepositoryState};
use serde_json::{Value, json};

fn utc(value: &str) -> String {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|v| {
            v.to_utc()
                .to_rfc3339_opts(chrono::SecondsFormat::AutoSi, true)
        })
        .unwrap_or_else(|_| value.into())
}
pub fn scope(scope: &ScopeVersion) -> Value {
    json!({"id":scope.id,"datasets":scope.datasets,"start":utc(&scope.absolute_start),
        "end":utc(&scope.absolute_end),"timezone":scope.timezone,
        "filters":scope.filters.iter().map(|(k,v)|format!("{k}={v}")).collect::<Vec<_>>()})
}

fn run_status(status: RunStatus, events: &[Event]) -> &'static str {
    match status {
        RunStatus::Queued => "queued",
        RunStatus::Running => events
            .iter()
            .rev()
            .find_map(|event| match event.kind.as_str() {
                "provider_context_pinned" => Some("composing"),
                "read_started" | "read_completed" => Some("querying"),
                "running" => Some("resolving_scope"),
                _ => None,
            })
            .unwrap_or("resolving_scope"),
        RunStatus::Completed => "completed",
        RunStatus::Partial => "partial",
        RunStatus::Failed => "failed",
        RunStatus::Cancelled => "cancelled",
        RunStatus::Interrupted => "interrupted",
    }
}

pub fn node(snapshot: &RepositoryState, investigation: &Investigation, node: &Node) -> Value {
    let run = node
        .selected_run_id
        .as_ref()
        .and_then(|id| snapshot.runs.get(id));
    let parent = node
        .parent
        .as_ref()
        .and_then(|p| snapshot.nodes.get(&format!("{}-v{}", p.node_id, p.version)));
    let status = run.map_or("draft", |r| {
        run_status(
            r.status,
            snapshot.events.get(&r.id).map(Vec::as_slice).unwrap_or(&[]),
        )
    });
    json!({"id":node.id,"kind":"question","intent":if node.parent.is_none(){"root"}else{node.branch_intent.as_deref().unwrap_or("follow_up")},
        "parentId":node.parent.as_ref().map(|p|&p.node_id),"parentVersion":node.parent.as_ref().map(|p|p.version),
        "version":node.version,"title":node.prompt.chars().take(96).collect::<String>(),"prompt":node.prompt,
        "answer":run.and_then(|r|r.answer.as_ref()),"status":status,"scope":scope(&node.scope),
        "scopeChanged":parent.is_some_and(|p|!p.scope.same_bounds(&node.scope)),
        "evidenceCount":snapshot.evidence.values().filter(|e|e.node_id==node.id && Some(&e.run_id)==node.selected_run_id.as_ref()).count(),
        "contextHash":run.map(|r|&r.context_hash),"createdAt":utc(run.map_or(&investigation.created_at,|r|&r.created_at)),
        "runId":run.map(|r|&r.id)})
}

pub fn graph(snapshot: &RepositoryState, id: &str) -> Result<Value> {
    let investigation = snapshot
        .investigations
        .get(id)
        .ok_or(KeystoneError::NotFound)?;
    let mut latest = std::collections::BTreeMap::<&str, &Node>::new();
    for n in snapshot.nodes.values().filter(|n| n.investigation_id == id) {
        if latest
            .get(n.id.as_str())
            .is_none_or(|old| old.version < n.version)
        {
            latest.insert(&n.id, n);
        }
    }
    Ok(
        json!({"schemaVersion":1,"investigationId":id,"title":investigation.title,
        "semanticRevision":investigation.semantic_revision,"rootNodeId":investigation.root_node_id,
        "nodes":latest.values().map(|n|node(snapshot,investigation,n)).collect::<Vec<_>>()}),
    )
}

pub fn layout(snapshot: &RepositoryState, id: &str) -> Result<Value> {
    let investigation = snapshot
        .investigations
        .get(id)
        .ok_or(KeystoneError::NotFound)?;
    Ok(
        json!({"schemaVersion":1,"investigationId":id,"layoutRevision":investigation.layout_revision,
        "nodes":snapshot.layouts.get(id).map(|l|l.nodes.clone()).unwrap_or_default()}),
    )
}

pub fn evidence(snapshot: &RepositoryState, node_id: &str) -> Result<Vec<Value>> {
    let node = snapshot
        .nodes
        .values()
        .filter(|n| n.id == node_id)
        .max_by_key(|n| n.version)
        .ok_or(KeystoneError::NotFound)?;
    snapshot
        .evidence
        .values()
        .filter(|e| e.node_id == node_id && Some(&e.run_id) == node.selected_run_id.as_ref())
        .map(|e| evidence_item(snapshot, e))
        .collect()
}

pub(super) fn evidence_item(snapshot: &RepositoryState, evidence: &Evidence) -> Result<Value> {
    let artifact = snapshot
        .artifacts
        .get(&evidence.artifact_id)
        .ok_or(KeystoneError::NotFound)?;
    let source = artifact
        .payload
        .get("rows")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let columns = source
        .iter()
        .filter_map(Value::as_object)
        .flat_map(|row| row.keys().cloned())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let rows = source
        .iter()
        .map(|row| {
            columns
                .iter()
                .map(|key| match &row[key] {
                    Value::Array(_) | Value::Object(_) => Value::String(row[key].to_string()),
                    value => value.clone(),
                })
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    Ok(
        json!({"id":evidence.id,"nodeId":evidence.node_id,"title":format!("{} · scoped sample",evidence.datasets.join(", ")),
        "sql":artifact.executed_sql.as_deref().unwrap_or(""),"datasets":evidence.datasets,
        "start":utc(&artifact.scope.absolute_start),"end":utc(&artifact.scope.absolute_end),
        "executedAt":utc(&artifact.fetched_at),"status":if rows.is_empty(){"empty"}else{"ok"},
        "rowCount":rows.len(),"truncated":artifact.truncated,"columns":columns,"rows":rows}),
    )
}

pub fn parent_export(snapshot: &RepositoryState, node_id: &str) -> Result<Value> {
    let node = snapshot
        .nodes
        .values()
        .filter(|n| n.id == node_id)
        .max_by_key(|n| n.version)
        .ok_or(KeystoneError::NotFound)?;
    let export = snapshot
        .exports
        .get(&node.version_key())
        .ok_or(KeystoneError::Conflict)?;
    let evidence = export
        .evidence_ids
        .iter()
        .map(|id| {
            snapshot
                .evidence
                .get(id)
                .ok_or(KeystoneError::NotFound)
                .and_then(|e| evidence_item(snapshot, e))
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(
        json!({"contextPolicy":CONTEXT_POLICY,"parentNodeId":node_id,"parentVersion":export.node_version,
        "parentStatus":"completed","prompt":export.prompt,"answer":export.answer,"scope":scope(&export.scope),
        "evidence":evidence,"omitted":["Ancestor transcripts","Sibling branches","Provider conversation history"],
        "truncated":false,"exportHash":super::context::hash_bytes(&serde_json::to_vec(export)?)}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reopened_run_uses_committed_phase_until_terminal() {
        let mut events = Vec::new();
        assert_eq!(run_status(RunStatus::Running, &events), "resolving_scope");
        for (kind, expected) in [
            ("queued", "resolving_scope"),
            ("running", "resolving_scope"),
            ("read_started", "querying"),
            ("read_completed", "querying"),
            ("read_started", "querying"),
            ("read_completed", "querying"),
            ("provider_context_pinned", "composing"),
        ] {
            events.push(Event {
                run_id: "run".into(),
                node_id: "node".into(),
                sequence: events.len() as u64 + 1,
                timestamp: "2026-10-13T12:00:00Z".into(),
                schema_version: 1,
                kind: kind.into(),
                payload: json!({}),
            });
            assert_eq!(run_status(RunStatus::Running, &events), expected);
        }
        for (status, expected) in [
            (RunStatus::Completed, "completed"),
            (RunStatus::Cancelled, "cancelled"),
            (RunStatus::Failed, "failed"),
            (RunStatus::Interrupted, "interrupted"),
            (RunStatus::Partial, "partial"),
        ] {
            assert_eq!(run_status(status, &events), expected);
        }
    }
}
