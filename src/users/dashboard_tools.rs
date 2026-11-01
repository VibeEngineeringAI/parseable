// SPDX-License-Identifier: AGPL-3.0-or-later
//! Dashboard tools are thin authenticated adapters over the same service as REST.
use super::{
    dashboard_patch::{self, DashboardPatchRequest},
    dashboard_service::{self, DashboardMutation},
};
use crate::{
    handlers::http::{
        middleware,
        users::dashboards::{self, DashboardError},
    },
    rbac::{Response, Users, role::Action},
    tool_catalog::ToolSpec,
    utils::actix::extract_session_key_from_req,
};
use actix_web::{HttpRequest, ResponseError, web};
use serde_json::{Value, json};

#[derive(Clone, Copy, Debug, Default)]
pub struct DashboardToolPolicy {
    pub writes_enabled: bool,
}
pub fn writes_enabled(req: &HttpRequest) -> bool {
    req.app_data::<web::Data<DashboardToolPolicy>>()
        .is_some_and(|policy| policy.writes_enabled)
}

fn schema(properties: Value, required: &[&str]) -> Value {
    json!({"type":"object","properties":properties,"required":required,"additionalProperties":false})
}
fn string(description: &str) -> Value {
    json!({"type":"string","minLength":1,"maxLength":512,"description":description})
}
fn tool(
    name: &'static str,
    title: &'static str,
    description: &'static str,
    properties: Value,
    required: &[&str],
) -> ToolSpec {
    ToolSpec::new(name, title, description, schema(properties, required))
}
fn operations() -> Value {
    static OPERATION_SCHEMA: std::sync::LazyLock<Value> =
        std::sync::LazyLock::new(dashboard_patch::operation_item_schema);
    json!({"type":"array","minItems":1,"maxItems":256,"items":&*OPERATION_SCHEMA,"description":"Atomic Parseable operations addressed by stable tile, section and variable identifiers."})
}

pub fn read_specs() -> Vec<ToolSpec> {
    vec![
        tool(
            "get_dashboard_capabilities",
            "Get dashboard capabilities",
            "Discover dashboard configuration, patch operations, chart styles, limits, and effective caller permissions.",
            json!({}),
            &[],
        ),
        tool(
            "validate_dashboard",
            "Validate dashboard configuration",
            "Validate a complete configuration without writing or running SQL, PromQL, variables or dataset probes.",
            json!({"document":{"type":"object"}}),
            &["document"],
        ),
        tool(
            "preview_dashboard_changes",
            "Preview dashboard changes",
            "Apply proposed changes to the current revision without saving or executing queries; returns the candidate, validation and exact diff.",
            json!({"dashboardId":string("Dashboard ULID."),"revision":string("Revision returned by get_dashboard."),"operations":operations()}),
            &["dashboardId", "revision", "operations"],
        ),
        tool(
            "run_dashboard_queries",
            "Run dashboard queries",
            "Explicitly execute selected dashboard tiles with bounded query concurrency, time and results. This never saves configuration.",
            json!({"dashboardId":string("Saved dashboard ID; or provide document."),"document":{"type":"object"},"operations":operations(),"revision":string("Source revision for proposed operations."),"tileIds":{"type":"array","maxItems":32,"items":{"type":"string"}},"startTime":string("RFC3339 inclusive start time."),"endTime":string("RFC3339 exclusive end time."),"variables":{"type":"object"},"rowLimit":{"type":"integer","minimum":1,"maximum":500}}),
            &["startTime", "endTime"],
        ),
    ]
}

pub fn write_specs() -> Vec<ToolSpec> {
    vec![
        tool(
            "create_dashboard",
            "Create dashboard",
            "Create a configured dashboard. Requires the server dashboard-agent-write policy, normal dashboard RBAC and an idempotency key.",
            json!({"dashboard":{"type":"object"},"idempotencyKey":string("Unique retry key, bound to principal, tenant and arguments.")}),
            &["dashboard", "idempotencyKey"],
        ),
        tool(
            "update_dashboard",
            "Update dashboard",
            "Atomically apply an ID-addressed patch or full replacement against an observed revision. Use preview_dashboard_changes for a dry run.",
            json!({"dashboardId":string("Dashboard ULID."),"revision":string("Observed revision."),"operations":operations(),"replacement":{"type":"object"},"idempotencyKey":string("Unique retry key.")}),
            &["dashboardId", "revision", "idempotencyKey"],
        ),
        tool(
            "save_tile",
            "Add dashboard tile",
            "Add one fully configured tile using its stable tile_id, conditional on the observed dashboard revision.",
            json!({"dashboardId":string("Dashboard ULID."),"revision":string("Observed revision."),"tile":{"type":"object"},"idempotencyKey":string("Unique retry key.")}),
            &["dashboardId", "revision", "tile", "idempotencyKey"],
        ),
        tool(
            "delete_dashboard",
            "Delete dashboard",
            "Conditionally delete a dashboard. Requires delete permission and ownership or administrator access.",
            json!({"dashboardId":string("Dashboard ULID."),"revision":string("Observed revision."),"idempotencyKey":string("Unique retry key.")}),
            &["dashboardId", "revision", "idempotencyKey"],
        ),
    ]
}

pub fn is_dashboard_tool(name: &str) -> bool {
    matches!(
        name,
        "list_dashboards"
            | "get_dashboard"
            | "list_dashboard_tags"
            | "get_dashboard_capabilities"
            | "validate_dashboard"
            | "preview_dashboard_changes"
            | "run_dashboard_queries"
            | "create_dashboard"
            | "update_dashboard"
            | "save_tile"
            | "delete_dashboard"
    )
}
pub fn is_write(name: &str) -> bool {
    matches!(
        name,
        "create_dashboard" | "update_dashboard" | "save_tile" | "delete_dashboard"
    )
}
pub fn required_action(name: &str) -> Action {
    match name {
        "list_dashboards" | "list_dashboard_tags" => Action::ListDashboard,
        "get_dashboard" | "get_dashboard_capabilities" => Action::GetDashboard,
        "delete_dashboard" => Action::DeleteDashboard,
        "run_dashboard_queries" => Action::Query,
        _ => Action::CreateDashboard,
    }
}

pub fn authorize(req: &HttpRequest, name: &str) -> Result<(), DashboardError> {
    let key = extract_session_key_from_req(req).map_err(|_| {
        DashboardError::api(
            401,
            "UNAUTHENTICATED",
            "Valid authentication is required",
            json!({}),
        )
    })?;
    let action = required_action(name);
    let tenant = crate::utils::get_tenant_id_from_request(req).map_err(|error| {
        DashboardError::api(400, "INVALID_HEADER", error.to_string(), json!({}))
    })?;
    if let Response::Suspended(message) =
        middleware::check_suspension_for_tenant(tenant.as_deref(), action)
    {
        return Err(DashboardError::api(403, "SUSPENDED", message, json!({})));
    }
    if Users.authorize(key, action, None, None) != Response::Authorized {
        return Err(DashboardError::api(
            403,
            "FORBIDDEN",
            "Dashboard tool permission denied",
            json!({"action":format!("{action:?}")}),
        ));
    }
    if is_write(name) && !writes_enabled(req) {
        return Err(DashboardError::api(
            403,
            "AGENT_WRITES_DISABLED",
            "External dashboard writes require P_DASHBOARD_AGENT_WRITES=true",
            json!({}),
        ));
    }
    Ok(())
}
fn required<'a>(args: &'a Value, key: &str) -> Result<&'a str, DashboardError> {
    args.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            DashboardError::api(
                400,
                "INVALID_ARGUMENT",
                format!("{key} is required"),
                json!({"path":key}),
            )
        })
}

pub async fn execute(req: &HttpRequest, name: &str, args: &Value) -> Result<Value, DashboardError> {
    authorize(req, name)?;
    let (actor, tenant) = dashboards::actor(req)?;
    let mut options = dashboards::write_options(req)?;
    options.expected_revision = args
        .get("revision")
        .and_then(Value::as_str)
        .map(str::to_owned);
    options.idempotency_key = args
        .get("idempotencyKey")
        .and_then(Value::as_str)
        .map(str::to_owned);
    match name {
        "get_dashboard_capabilities" => {
            let mut result = dashboard_patch::capabilities();
            let key =
                extract_session_key_from_req(req).map_err(|_| DashboardError::Unauthorized)?;
            result["permissions"] = json!({"agentWritesEnabled":writes_enabled(req),"canCreate":Users.authorize(key.clone(),Action::CreateDashboard,None,None)==Response::Authorized,"canDelete":Users.authorize(key,Action::DeleteDashboard,None,None)==Response::Authorized,"ownerRequired":!actor.is_admin});
            result["generatedIds"] = json!({"tileIds":(0..4).map(|_| dashboard_patch::generate_tile_id()).collect::<Vec<_>>(),"sectionIds":(0..2).map(|_| ulid::Ulid::new().to_string()).collect::<Vec<_>>()});
            result["revisionTransport"] =
                json!({"rest":"If-Match","tool":"revision","requiredForAgentUpdates":true});
            Ok(result)
        }
        "validate_dashboard" => Ok(serde_json::to_value(dashboard_patch::validate_dashboard(
            &args["document"],
            None,
        ))?),
        "run_dashboard_queries" => super::dashboard_runtime::preview_value(req, args.clone()).await,
        "create_dashboard" => {
            dashboard_service::create_json(&actor, &tenant, args["dashboard"].clone(), &options)
                .await
        }
        "get_dashboard" => {
            dashboard_service::get_json(
                crate::users::dashboards::validate_dashboard_id(
                    required(args, "dashboardId")?.to_owned(),
                )?,
                &tenant,
            )
            .await
        }
        "list_dashboards" => {
            let rows = dashboards::list_dashboards_internal(0, None, &tenant).await?;
            let query = args
                .get("query")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_lowercase();
            let after = args.get("after").and_then(Value::as_str).unwrap_or("");
            let limit = args
                .get("limit")
                .and_then(Value::as_u64)
                .unwrap_or(100)
                .clamp(1, 500) as usize;
            let mut matching = rows
                .into_iter()
                .filter(|d| {
                    d["dashboardId"].as_str().is_some_and(|id| id > after)
                        && d["title"]
                            .as_str()
                            .unwrap_or("")
                            .to_lowercase()
                            .contains(&query)
                })
                .collect::<Vec<_>>();
            matching.sort_by(|a, b| a["dashboardId"].as_str().cmp(&b["dashboardId"].as_str()));
            let more = matching.len() > limit;
            matching.truncate(limit);
            let next = more.then(|| {
                matching
                    .last()
                    .and_then(|v| v["dashboardId"].as_str())
                    .unwrap_or("")
                    .to_owned()
            });
            Ok(json!({"dashboards":matching,"nextCursor":next}))
        }
        "list_dashboard_tags" => Ok(json!(dashboards::list_tags_internal(&tenant).await?)),
        "preview_dashboard_changes" | "update_dashboard" | "save_tile" | "delete_dashboard" => {
            let id = crate::users::dashboards::validate_dashboard_id(
                required(args, "dashboardId")?.to_owned(),
            )?;
            if options.expected_revision.is_none() {
                return Err(DashboardError::api(
                    428,
                    "REVISION_REQUIRED",
                    "An observed dashboard revision is required",
                    json!({}),
                ));
            }
            if name == "delete_dashboard" {
                dashboard_service::delete_json(&actor, id, &tenant, &options).await?;
                return Ok(json!({"deleted":true,"dashboardId":id.to_string()}));
            }
            let mutation = if name == "save_tile" {
                DashboardMutation::AddTile(args["tile"].clone())
            } else if let Some(operations) = args.get("operations") {
                if args.get("replacement").is_some() {
                    return Err(DashboardError::api(
                        400,
                        "INVALID_ARGUMENT",
                        "Choose operations or replacement",
                        json!({}),
                    ));
                }
                let patch: DashboardPatchRequest =
                    serde_json::from_value(json!({"operations":operations} ))?;
                DashboardMutation::Patch(patch.operations)
            } else {
                DashboardMutation::Replace(args.get("replacement").cloned().ok_or_else(|| {
                    DashboardError::api(
                        400,
                        "INVALID_ARGUMENT",
                        "Provide operations or replacement",
                        json!({}),
                    )
                })?)
            };
            options.dry_run = name == "preview_dashboard_changes";
            dashboard_service::mutate_json(&actor, id, &tenant, mutation, &options).await
        }
        _ => Err(DashboardError::api(
            404,
            "UNKNOWN_TOOL",
            "Unknown dashboard tool",
            json!({}),
        )),
    }
}

pub fn tool_error(error: &DashboardError) -> Value {
    json!({"code":error.detail()["code"],"message":error.to_string(),"status":error.status_code().as_u16(),"details":error.detail()["details"]})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dashboard_write_catalog_is_explicit_and_small() {
        assert_eq!(
            write_specs().iter().map(|t| t.name).collect::<Vec<_>>(),
            vec![
                "create_dashboard",
                "update_dashboard",
                "save_tile",
                "delete_dashboard"
            ]
        );
        assert!(!is_write("create_alert"));
        assert!(read_specs().iter().all(|t| !is_write(t.name)));
    }
    #[test]
    fn mutation_schema_requires_revision_and_retry_identity() {
        for tool in write_specs()
            .into_iter()
            .filter(|t| t.name != "create_dashboard")
        {
            assert!(
                tool.validate_arguments(&json!({"dashboardId":"id","idempotencyKey":"key"}))
                    .is_err()
            );
        }
    }
}

pub fn output_schema(name: &str) -> Option<Value> {
    let string = json!({"type":"string"});
    let document = json!({"type":"object","properties":{"dashboardId":string,"title":{"type":"string"},"revision":{"type":"string"}},"required":["dashboardId","title","revision"],"additionalProperties":true});
    let result = match name {
        "get_dashboard" => document.clone(),
        "create_dashboard" | "update_dashboard" | "save_tile" | "preview_dashboard_changes" => {
            json!({"type":"object","properties":{"dashboard":document,"revision":{"type":"string"},"validation":{"type":"object"},"diff":{"type":"array"},"replayed":{"type":"boolean"}},"required":["dashboard","revision","validation","diff"],"additionalProperties":true})
        }
        "list_dashboards" => {
            json!({"type":"object","properties":{"dashboards":{"type":"array","items":{"type":"object"}},"nextCursor":{"type":["string","null"]}},"required":["dashboards","nextCursor"]})
        }
        "list_dashboard_tags" => json!({"type":"array","items":{"type":"string"}}),
        "validate_dashboard" => {
            json!({"type":"object","properties":{"valid":{"type":"boolean"},"errors":{"type":"array"},"warnings":{"type":"array"}},"required":["valid","errors","warnings"]})
        }
        "delete_dashboard" => {
            json!({"type":"object","properties":{"deleted":{"type":"boolean"},"dashboardId":{"type":"string"}},"required":["deleted","dashboardId"]})
        }
        "run_dashboard_queries" => {
            json!({"type":"object","properties":{"results":{"type":"array","items":{"type":"object"}}},"required":["results"],"additionalProperties":true})
        }
        "get_dashboard_capabilities" => json!({"type":"object","additionalProperties":true}),
        _ => return None,
    };
    Some(
        json!({"type":"object","properties":{"result":result,"error":{"type":"object","properties":{"code":{"type":"string"},"message":{"type":"string"},"status":{"type":"integer"}},"required":["message"]}},"anyOf":[{"required":["result"]},{"required":["error"]}]}),
    )
}

#[cfg(test)]
mod header_error_tests {
    use actix_web::{ResponseError, http::header::HeaderValue, test::TestRequest};

    use super::*;
    use crate::handlers::TENANT_ID;

    #[test]
    fn authorize_rejects_malformed_tenant_with_json_400() {
        let req = TestRequest::default()
            .insert_header(("authorization", "Basic YWxpY2U6cGFzcw=="))
            .insert_header((
                TENANT_ID,
                HeaderValue::from_bytes(b"t\xff").expect("obs-text is a valid header value"),
            ))
            .to_http_request();
        let err = authorize(&req, "list_dashboards").unwrap_err();
        assert_eq!(err.status_code(), actix_web::http::StatusCode::BAD_REQUEST);
        assert_eq!(err.detail()["code"], "INVALID_HEADER");
    }
}
