//! Read-only SQL alert preview. No alert manager, target, state or storage writes.
use once_cell::sync::Lazy;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::Semaphore;

use super::{
    AlertError, AlertQueryType, EvalConfig, Severity,
    alert_structs::{AlertQueryResult, AlertRequest, ThresholdConfig},
    alert_traits::AlertTrait,
    alert_types::ThresholdAlert,
    alerts_utils::{
        alert_execution_headers, evaluate_query_result, execute_alert_query, extract_time_range,
    },
    resolve_alert_output_layout,
};
use crate::{query::QUERY_SESSION, rbac::map::SessionKey, utils::time::TimeRange};

static PREVIEW_SLOTS: Lazy<Semaphore> = Lazy::new(|| Semaphore::new(4));
const MAX_GROUPS: usize = 200;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlertPreviewRequest {
    #[serde(default)]
    pub query_type: AlertQueryType,
    #[serde(default)]
    pub query: String,
    #[serde(default)]
    pub builder_config: Option<Value>,
    pub threshold_config: ThresholdConfig,
    pub eval_config: EvalConfig,
}

pub async fn preview(
    request: AlertPreviewRequest,
    session: &SessionKey,
    tenant: &Option<String>,
) -> Result<Value, AlertError> {
    let _slot = PREVIEW_SLOTS
        .try_acquire()
        .map_err(|_| AlertError::PreviewBusy)?;
    tokio::time::timeout(
        std::time::Duration::from_secs(30),
        execute(request, session, tenant),
    )
    .await
    .map_err(|_| AlertError::PreviewTimeout)?
}

async fn execute(
    request: AlertPreviewRequest,
    session: &SessionKey,
    tenant: &Option<String>,
) -> Result<Value, AlertError> {
    if request.query_type == AlertQueryType::Promql {
        return Err(AlertError::ValidationFailure(
            "SQL alert preview accepts builder or code rules".into(),
        ));
    }
    let rule = AlertRequest {
        severity: Severity::default(),
        title: "Preview".into(),
        query: request.query,
        query_type: request.query_type,
        builder_config: request.builder_config,
        datasets: vec![],
        alert_type: "threshold".into(),
        anomaly_config: None,
        forecast_config: None,
        threshold_config: request.threshold_config,
        notification_config: Default::default(),
        eval_config: request.eval_config,
        targets: vec![],
        tags: None,
        other_fields: None,
    }
    .into(tenant.clone(), session)
    .await?;
    let alert = ThresholdAlert::from(rule.clone());
    alert.validate(session).await?;
    let window = extract_time_range(&rule.eval_config)?;
    let mut state = QUERY_SESSION.get_ctx().state();
    state.config_mut().options_mut().catalog.default_schema =
        tenant.as_deref().unwrap_or("public").to_owned();
    let plan = state.create_logical_plan(&rule.query).await?;
    let layout = resolve_alert_output_layout(&plan)?;
    let dimensions = layout
        .dimension_indices
        .iter()
        .map(|index| plan.schema().field(*index).name().clone())
        .collect::<Vec<_>>();
    let result = execute_alert_query(
        alert_execution_headers(tenant)?,
        &rule.query,
        &window,
        tenant,
    )
    .await?;
    Ok(response(
        &rule,
        result,
        layout.measure_name,
        dimensions,
        &window,
    ))
}

fn response(
    rule: &super::AlertConfig,
    result: AlertQueryResult,
    measure: String,
    dimensions: Vec<String>,
    window: &TimeRange,
) -> Value {
    let mut evaluated = evaluate_query_result(&result, &rule.threshold_config);
    let total = evaluated.len();
    let breached = evaluated.iter().filter(|(_, breached)| *breached).count();
    evaluated.sort_by_key(|(_, breached)| !*breached);
    let groups = evaluated.into_iter().take(MAX_GROUPS).map(|(group, breached)| {
        json!({"labels":group.group_values,"value":group.aggregate_value,"breached":breached})
    }).collect::<Vec<_>>();
    json!({
        "queryType":rule.query_type,"compiledQuery":rule.query,"builderConfig":rule.builder_config,
        "datasets":rule.datasets,"measure":measure,"dimensions":dimensions,
        "window":{"start":window.start,"end":window.end},"threshold":rule.threshold_config,
        "simple":result.is_simple_query,"noData":result.groups.is_empty(),"wouldTrigger":breached > 0,
        "groups":groups,"totalGroups":total,"breachedGroups":breached,"truncated":total > MAX_GROUPS,
    })
}

#[cfg(test)]
mod tests {
    use super::super::{AlertConfig, AlertOperator, alert_structs::GroupResult};
    use super::*;
    use std::collections::HashMap;

    fn rule() -> AlertConfig {
        serde_json::from_value(json!({
            "version":"v2","id":ulid::Ulid::new(),"severity":"high","title":"Preview",
            "queryType":"code","query":"SELECT COUNT(*) FROM logs","datasets":["logs"],"alertType":"threshold",
            "thresholdConfig":{"operator":">","value":10.0},
            "evalConfig":{"rollingWindow":{"evalStart":"5m","evalEnd":"now","evalFrequency":1}},
            "targets":[],"notificationState":"notify","notificationConfig":{"interval":1},"created":chrono::Utc::now()
        })).unwrap()
    }
    fn group(service: &str, value: f64) -> GroupResult {
        GroupResult {
            group_values: HashMap::from([("service".into(), service.into())]),
            aggregate_value: value,
        }
    }

    #[test]
    fn preview_shares_execution_thresholds_for_groups_and_no_rows() {
        let mut rule = rule();
        let window = extract_time_range(&rule.eval_config).unwrap();
        let result = AlertQueryResult {
            groups: vec![group("quiet", 2.0), group("api", 12.0)],
            is_simple_query: false,
        };
        let executed = evaluate_query_result(&result, &rule.threshold_config);
        let preview = response(
            &rule,
            result,
            "count".into(),
            vec!["service".into()],
            &window,
        );
        assert_eq!(executed.iter().filter(|(_, breached)| *breached).count(), 1);
        assert_eq!(preview["wouldTrigger"], true);
        assert_eq!(preview["groups"][0]["labels"]["service"], "api");
        assert_eq!(preview["groups"][0]["value"], 12.0);
        assert_eq!(preview["breachedGroups"], 1);
        rule.threshold_config = ThresholdConfig {
            operator: AlertOperator::LessThan,
            value: 1.0,
        };
        let empty = AlertQueryResult {
            groups: vec![],
            is_simple_query: true,
        };
        let preview = response(&rule, empty, "count".into(), vec![], &window);
        assert_eq!(preview["noData"], true);
        assert_eq!(preview["wouldTrigger"], true);
        assert_eq!(preview["groups"][0]["value"], 0.0);
        let normalized_null = AlertQueryResult {
            groups: vec![group("", 0.0)],
            is_simple_query: true,
        };
        let preview = response(&rule, normalized_null, "count".into(), vec![], &window);
        assert_eq!(preview["noData"], false);
        assert_eq!(preview["wouldTrigger"], true);
        let empty_grouped = AlertQueryResult {
            groups: vec![],
            is_simple_query: false,
        };
        let preview = response(
            &rule,
            empty_grouped,
            "count".into(),
            vec!["service".into()],
            &window,
        );
        assert_eq!(preview["wouldTrigger"], false);
        assert_eq!(preview["groups"], json!([]));
    }

    #[test]
    fn preview_caps_only_output_and_counts_all_breached_groups() {
        let rule = rule();
        let result = AlertQueryResult {
            groups: (0..240)
                .map(|index| {
                    group(
                        &format!("service-{index}"),
                        if index % 2 == 0 { 12.0 } else { 0.0 },
                    )
                })
                .collect(),
            is_simple_query: false,
        };
        let preview = response(
            &rule,
            result,
            "count".into(),
            vec!["service".into()],
            &extract_time_range(&rule.eval_config).unwrap(),
        );
        assert_eq!(preview["groups"].as_array().unwrap().len(), 200);
        assert_eq!(preview["totalGroups"], 240);
        assert_eq!(preview["breachedGroups"], 120);
        assert_eq!(preview["truncated"], true);
        assert!(
            preview["groups"]
                .as_array()
                .unwrap()
                .iter()
                .take(120)
                .all(|group| group["breached"] == true)
        );
    }

    #[tokio::test]
    async fn preview_busy_limit_rejects_before_query_or_manager_access() {
        let permits = (0..4)
            .map(|_| PREVIEW_SLOTS.try_acquire().unwrap())
            .collect::<Vec<_>>();
        let request: AlertPreviewRequest = serde_json::from_value(json!({"queryType":"code","query":"SELECT COUNT(*) FROM logs","thresholdConfig":{"operator":">","value":10},"evalConfig":{"rollingWindow":{"evalStart":"5m","evalEnd":"now","evalFrequency":1}}})).unwrap();
        let error = preview(request, &SessionKey::SessionId(ulid::Ulid::new()), &None)
            .await
            .unwrap_err();
        assert!(matches!(error, AlertError::PreviewBusy));
        drop(permits);
    }
}
