use std::collections::HashMap;

use serde_json::{Value, json};
use ulid::Ulid;

use super::{
    AlertState, Context,
    target::{NotificationConfig, Target},
};

#[test]
fn webhook_format_round_trips_and_mask_hides_credentials() {
    let mut spec = json!({
        "type": "webhook", "name": "automation", "endpoint": "https://example.test/private",
        "headers": {"Authorization": "Bearer fixture"}
    });
    for format in [None, Some("text"), Some("json")] {
        if let Some(format) = format {
            spec["payloadFormat"] = json!(format);
        }
        let target: Target = serde_json::from_value(spec.clone()).unwrap();
        let stored = serde_json::to_value(&target).unwrap();
        assert_eq!(stored.get("payloadFormat").and_then(Value::as_str), format);
        let loaded: Target = serde_json::from_value(stored).unwrap();
        assert_eq!(loaded.target, target.target);
        let masked = loaded.mask();
        assert_eq!(masked["payloadFormat"], format.unwrap_or("text"));
        assert_eq!(masked["headers"]["Authorization"], "********");
        assert_eq!(masked["endpoint"], "https://********");
    }
    spec["payloadFormat"] = json!("yaml");
    assert!(serde_json::from_value::<Target>(spec).is_err());
}

#[test]
fn prism_form_sets_and_updates_the_canonical_format() {
    let form = json!({
        "type": "webhook", "name": "automation", "endpoint": "https://example.test/hook",
        "headers": { "x-parseable-payload-format": "json", "Authorization": "Bearer fixture" }
    });
    let mut target: Target = serde_json::from_value(form.clone()).unwrap();
    // Deserialization alone (e.g. metastore load) never reinterprets legacy headers.
    assert_eq!(target.clone().mask()["payloadFormat"], "text");
    target.apply_webhook_format(None).unwrap();
    let stored = serde_json::to_value(&target).unwrap();
    assert_eq!(stored["payloadFormat"], "json");
    assert_eq!(
        stored["headers"],
        json!({"Authorization": "Bearer fixture"})
    );

    let mut edit = form;
    edit["headers"]
        .as_object_mut()
        .unwrap()
        .remove("x-parseable-payload-format");
    let mut edited: Target = serde_json::from_value(edit.clone()).unwrap();
    edited.apply_webhook_format(Some(&target)).unwrap();
    assert_eq!(edited.mask()["payloadFormat"], "json");

    edit["headers"]["X-Parseable-Payload-Format"] = json!("text");
    let mut edited: Target = serde_json::from_value(edit).unwrap();
    edited.apply_webhook_format(Some(&target)).unwrap();
    assert_eq!(edited.mask()["payloadFormat"], "text");
}

#[actix_web::test]
async fn webhook_delivers_selected_format_and_revalidates_policy() {
    use crate::alerts::{
        AlertInfo, DeploymentInfo, NotificationState,
        outbound_http_policy::{ALERT_TARGET_POLICY, AlertTargetPolicyConfig},
    };
    use actix_web::{App, HttpRequest, HttpResponse, HttpServer, web};

    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let address = listener.local_addr().unwrap();
    let (tx, mut received) = tokio::sync::mpsc::unbounded_channel();
    let server = HttpServer::new(move || {
        let tx = tx.clone();
        App::new().route(
            "/hook",
            web::post().to(move |req: HttpRequest, body: web::Bytes| {
                let tx = tx.clone();
                async move {
                    tx.send((req.headers().clone(), body)).unwrap();
                    HttpResponse::NoContent().finish()
                }
            }),
        )
    })
    .workers(1)
    .listen(listener)
    .unwrap()
    .run();
    let handle = server.handle();
    actix_web::rt::spawn(server);

    let tenant = Ulid::new().to_string();
    ALERT_TARGET_POLICY.write().await.insert(
        tenant.clone(),
        AlertTargetPolicyConfig {
            allow_private: true,
            allowed_cidrs: vec!["127.0.0.1/32".into()],
            ..Default::default()
        },
    );
    let spec = json!({
        "type": "webhook", "name": "fixture", "endpoint": format!("http://{address}/hook"),
        "headers": { "Authorization": "Bearer local-fixture" }
    });
    let alert_id = Ulid::new();
    let mut context = Context::new(
        AlertInfo::new(
            alert_id,
            "Checkout".into(),
            AlertState::Triggered,
            NotificationState::Notify,
            "High".into(),
        ),
        DeploymentInfo::new("local".into(), Ulid::new(), "all".into()),
        NotificationConfig::default(),
        "Checkout: \"errors\"\nabove threshold".into(),
    );
    context.service = Some("shop".into());
    context.series = vec![HashMap::from([("service.name".into(), "checkout".into())])];
    let tenant_id = Some(tenant.clone());
    for (format, form_control, custom_type, expected_type) in [
        (None, None, None, None),
        (
            None,
            None,
            Some("application/json"),
            Some("application/json"),
        ),
        (Some("text"), None, Some("text/plain"), Some("text/plain")),
        (Some("json"), None, None, Some("application/json")),
        (
            None,
            Some("json"),
            Some("text/plain"),
            Some("application/json"),
        ),
    ] {
        let mut input = spec.clone();
        if let Some(format) = format {
            input["payloadFormat"] = json!(format);
        }
        if let Some(control) = form_control {
            input["headers"]["X-Parseable-Payload-Format"] = json!(control);
        }
        if let Some(custom_type) = custom_type {
            input["headers"]["cOnTeNt-TyPe"] = json!(custom_type);
        }
        let mut target: Target = serde_json::from_value(input).unwrap();
        target.apply_webhook_format(None).unwrap();
        for (state, status, expected_message) in [
            (AlertState::Triggered, "firing", context.message.clone()),
            (
                AlertState::NotTriggered,
                "resolved",
                "Checkout is now `not-triggered` ".into(),
            ),
        ] {
            context.alert_info.alert_state = state;
            target.target.call(&tenant_id, &context).await;
            let (headers, body) = received.try_recv().expect("receiver handled the POST");
            assert_eq!(
                headers.get("authorization").unwrap(),
                "Bearer local-fixture"
            );
            assert!(!headers.contains_key("x-parseable-payload-format"));
            let types: Vec<_> = headers
                .get_all("content-type")
                .map(|v| v.to_str().unwrap())
                .collect();
            assert_eq!(types, expected_type.into_iter().collect::<Vec<_>>());
            if format.or(form_control) == Some("json") {
                assert_eq!(
                    serde_json::from_slice::<Value>(&body).unwrap(),
                    json!({
                        "status": status, "alertId": alert_id, "alertName": "Checkout",
                        "severity": "High", "service": "shop",
                        "series": [{"service.name":"checkout"}], "message": expected_message
                    })
                );
            } else {
                assert_eq!(body.as_ref(), expected_message.as_bytes());
            }
        }
    }

    // A single alert can fan out to both a legacy target and a JSON automation.
    let mut text: Target = serde_json::from_value(spec.clone()).unwrap();
    text.tenant = tenant_id.clone();
    let mut json_spec = spec.clone();
    json_spec["payloadFormat"] = json!("json");
    let mut structured: Target = serde_json::from_value(json_spec).unwrap();
    structured.tenant = tenant_id.clone();
    for (state, status) in [
        (AlertState::Triggered, "firing"),
        (AlertState::NotTriggered, "resolved"),
    ] {
        context.alert_info.alert_state = state;
        text.call(context.clone());
        structured.call(context.clone());
        let mut formats = Vec::new();
        for _ in 0..2 {
            let (headers, body) =
                tokio::time::timeout(std::time::Duration::from_secs(5), received.recv())
                    .await
                    .expect("both alert targets should receive a POST")
                    .unwrap();
            let is_json = headers.contains_key("content-type");
            if is_json {
                assert_eq!(
                    serde_json::from_slice::<Value>(&body).unwrap()["status"],
                    status
                );
            }
            formats.push(is_json);
        }
        formats.sort_unstable();
        assert_eq!(formats, [false, true]);
    }

    // A stored JSON target loses access immediately when the allowlist is removed.
    ALERT_TARGET_POLICY.write().await.remove(&tenant);
    let mut stored = spec;
    stored["payloadFormat"] = json!("json");
    let target: Target = serde_json::from_value(stored).unwrap();
    target.target.call(&tenant_id, &context).await;
    assert!(received.try_recv().is_err());
    handle.stop(true).await;
}
