//! Cross-module assertions against the bytes sent to fixture providers.
use super::{
    context::{
        build_context,
        tests::{fixture, run},
    },
    domain::*,
    providers::{
        FrozenProviderContext, ProviderKind,
        decisions::{DecisionCodec, DecisionQuestion, DecisionRequest, QuestionKind},
    },
};

#[test]
fn decision_requests_contain_direct_export_only_and_are_immutable() {
    let (principal, investigation, p) = fixture();
    let p_export = ParentExport::from_completed(
        &investigation,
        &p,
        &run(&p, "runP", RunStatus::Completed, "P exported answer"),
        vec![],
    )
    .unwrap();
    let mut a = p.clone();
    a.id = "A".into();
    a.prompt = "A own prompt".into();
    a.parent = Some(ParentReference {
        node_id: p.id.clone(),
        version: 1,
    });
    let _a_input = build_context(
        &principal,
        &investigation,
        &a,
        Some(&p_export),
        &[],
        false,
        |_| true,
    )
    .unwrap();
    let mut b = a.clone();
    b.id = "B".into();
    b.prompt = "SIBLING_B_PRIVATE_SENTINEL".into();
    let mut disconnected = b.clone();
    disconnected.id = "disconnected".into();
    disconnected.prompt = "DISCONNECTED_SENTINEL".into();
    let mut a_export = ParentExport::from_completed(
        &investigation,
        &a,
        &run(
            &a,
            "runA",
            RunStatus::Completed,
            "A explicitly restates an upstream fact",
        ),
        vec![],
    )
    .unwrap();
    let mut c = a.clone();
    c.id = "C".into();
    c.prompt = "C own question".into();
    c.parent = Some(ParentReference {
        node_id: "A".into(),
        version: 1,
    });
    let pinned = build_context(
        &principal,
        &investigation,
        &c,
        Some(&a_export),
        &[],
        false,
        |_| true,
    )
    .unwrap();
    let old_bytes = pinned.bytes.clone();
    let provider_package: serde_json::Value = serde_json::from_slice(&old_bytes).unwrap();
    fn assert_no_identity(value: &serde_json::Value) {
        match value {
            serde_json::Value::Object(object) => {
                for (key, value) in object {
                    assert!(
                        ![
                            "tenantId",
                            "ownerId",
                            "approvedBy",
                            "principalId",
                            "grant",
                            "contextManifestId",
                            "investigationId",
                            "runId",
                            "nodeId"
                        ]
                        .contains(&key.as_str()),
                        "outbound metadata: {key}"
                    );
                    assert_no_identity(value);
                }
            }
            serde_json::Value::Array(values) => {
                for value in values {
                    assert_no_identity(value);
                }
            }
            _ => {}
        }
    }
    assert_no_identity(&provider_package);
    a_export.answer = "LATER_PARENT_EDIT_SENTINEL".into();
    a_export.node_version = 2;
    for kind in [ProviderKind::Jev, ProviderKind::OpenAiDecisions] {
        let request = DecisionRequest {
            context: FrozenProviderContext::try_from(&pinned).unwrap(),
            questions: vec![DecisionQuestion {
                id: "urgent".into(),
                instructions: "Does the supplied evidence indicate urgency?".into(),
                kind: QuestionKind::Predicate,
            }],
            rubric_version: "rubric1".into(),
        };
        let outgoing =
            serde_json::to_string(&DecisionCodec(kind).request_body(&request).unwrap()).unwrap();
        for excluded in [
            &p.prompt,
            &b.prompt,
            &disconnected.prompt,
            &a_export.answer,
            "OTHER_TENANT_SENTINEL",
            "previous_response_id",
            "conversation",
            &principal.tenant_id,
            &principal.owner_id,
        ] {
            assert!(!outgoing.contains(excluded), "unexpected input: {excluded}");
        }
        assert!(outgoing.contains("A own prompt"));
        assert!(outgoing.contains("A explicitly restates an upstream fact"));
        assert!(outgoing.contains("C own question"));
        assert_eq!(request.context.serialized().as_bytes(), old_bytes);
    }
    assert_eq!(pinned.manifest.scope, p.scope);
    assert_eq!(pinned.manifest.direct_parent.unwrap().version, 1);
}
