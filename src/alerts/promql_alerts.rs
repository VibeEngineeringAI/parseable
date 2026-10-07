//! Persisted, per-series threshold state for native PromQL alerts.
use crate::{
    alerts::{
        AlertConfig, AlertError, AlertQueryType, AlertState, NotificationState,
        alert_types::ThresholdAlert, alerts_utils::evaluate_condition, target::TARGETS,
    },
    parseable::{DEFAULT_TENANT, PARSEABLE},
    promql::Labels,
    rbac::{
        Response,
        map::{SessionKey, Sessions, sessions, users},
        role::Action,
        roles_to_permission,
    },
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

pub static LIFECYCLE: tokio::sync::RwLock<()> = tokio::sync::RwLock::const_new(());
const MAX_INSTANCES: usize = 1000;
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Runtime {
    pub health: String,
    pub error: Option<String>,
    pub last_evaluated_at: Option<DateTime<Utc>>,
    pub instances: BTreeMap<String, Instance>,
    #[serde(default)]
    pub deliveries: Vec<Delivery>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Delivery {
    labels: Labels,
    value: f64,
    firing: bool,
    target: ulid::Ulid,
    attempts: u32,
    error: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Instance {
    pub labels: Labels,
    pub state: String,
    pub pending_since: Option<DateTime<Utc>>,
    pub last_seen: DateTime<Utc>,
    pub value: f64,
}

pub fn hold_duration(config: &AlertConfig) -> Result<std::time::Duration, AlertError> {
    if let Some(value) = config
        .other_fields
        .as_ref()
        .and_then(|fields| fields.get("promqlConfig"))
        && (!value.is_object()
            || value
                .get("holdDuration")
                .is_some_and(|duration| !duration.is_string()))
    {
        return Err(AlertError::ValidationFailure(
            "promqlConfig must contain a string holdDuration".into(),
        ));
    }
    let duration = config
        .other_fields
        .as_ref()
        .and_then(|fields| fields.get("promqlConfig"))
        .and_then(|v| v.get("holdDuration"))
        .and_then(|v| v.as_str())
        .unwrap_or("0s");
    let duration = humantime::parse_duration(duration).map_err(|_| {
        AlertError::ValidationFailure(
            "promqlConfig.holdDuration must be a duration such as 5m".into(),
        )
    })?;
    if duration.as_secs() > 30 * 86400 {
        return Err(AlertError::ValidationFailure(
            "Hold duration cannot exceed 30 days".into(),
        ));
    }
    Ok(duration)
}

/// Capture a stable user ID, never a password or expiring browser session.
pub fn capture_identity(config: &mut AlertConfig, session: &SessionKey) -> Result<(), AlertError> {
    let fields = config.other_fields.get_or_insert_with(Default::default);
    fields.remove("promqlRuntime");
    fields.remove("executionIdentity");
    if config.query_type == AlertQueryType::Promql {
        let (user, tenant) = sessions().get_user_and_tenant_id(session).ok_or_else(|| {
            AlertError::ValidationFailure("Unable to identify alert owner".into())
        })?;
        if tenant != config.tenant_id.as_deref().unwrap_or(DEFAULT_TENANT) {
            return Err(AlertError::ValidationFailure(
                "Alert owner tenant mismatch".into(),
            ));
        }
        fields.insert(
            "executionIdentity".into(),
            serde_json::json!({"userId":user,"tenantId":tenant}),
        );
    }
    Ok(())
}

pub(super) fn authorize_execution(config: &AlertConfig) -> Result<(), String> {
    let identity = config
        .other_fields
        .as_ref()
        .and_then(|f| f.get("executionIdentity"))
        .ok_or("Alert execution identity is missing; edit the rule to set its owner")?;
    let owner = identity
        .get("userId")
        .and_then(|v| v.as_str())
        .ok_or("Invalid alert owner")?;
    let tenant = config.tenant_id.as_deref().unwrap_or(DEFAULT_TENANT);
    if identity.get("tenantId").and_then(|v| v.as_str()) != Some(tenant) {
        return Err("Alert owner tenant mismatch".into());
    }
    let user_roles = users()
        .get(tenant)
        .and_then(|u| u.get(owner))
        .map(|u| u.roles())
        .ok_or("Alert owner no longer exists")?;
    let permissions = roles_to_permission(user_roles, tenant);
    let key = SessionKey::SessionId(ulid::Ulid::new());
    let mut auth = Sessions::default();
    auth.track_new(
        owner.to_owned(),
        key.clone(),
        DateTime::<Utc>::MAX_UTC,
        permissions,
        &config.tenant_id,
    );
    let dataset = config.datasets.first().ok_or("Missing alert dataset")?;
    if auth.check_auth(&key, Action::Query, Some(dataset), None) != Some(Response::Authorized) {
        return Err("Alert owner's dataset permission has been revoked".into());
    }
    Ok(())
}

impl Runtime {
    pub fn discontinuity(&mut self, health: &str, error: Option<String>, now: DateTime<Utc>) {
        self.health = health.into();
        self.error = error;
        self.last_evaluated_at = Some(now);
        for instance in self.instances.values_mut() {
            if instance.state == "pending" {
                instance.pending_since = None;
            }
        }
    }
    pub fn observe_transactionally(
        &mut self,
        samples: Vec<(Labels, f64)>,
        config: &AlertConfig,
        now: DateTime<Utc>,
    ) -> Result<Vec<(Labels, f64, bool)>, String> {
        let mut next = self.clone();
        let transitions = next.observe(samples, config, now)?;
        // A newer transition supersedes every older opposite-state notification
        // for that instance, including failed deliveries paused while muted.
        for (labels, _, firing) in &transitions {
            next.deliveries
                .retain(|delivery| delivery.labels != *labels || delivery.firing == *firing);
        }
        let reserved_deliveries = if notifications_allowed(&config.notification_state, now) {
            transitions.len().saturating_mul(config.targets.len())
        } else {
            0
        };
        if next.deliveries.len().saturating_add(reserved_deliveries) > 1000 {
            return Err("PromQL notification outbox is full; resolve failed target deliveries before continuing".into());
        }
        *self = next;
        Ok(transitions)
    }
    pub fn observe(
        &mut self,
        samples: Vec<(Labels, f64)>,
        config: &AlertConfig,
        now: DateTime<Utc>,
    ) -> Result<Vec<(Labels, f64, bool)>, String> {
        if samples.len() > MAX_INSTANCES || samples.iter().any(|(_, v)| !v.is_finite()) {
            return Err(
                "PromQL alert result exceeds instance limit or contains non-finite values".into(),
            );
        }
        let hold = hold_duration(config)
            .map_err(|e| e.to_string())?
            .as_millis() as i64;
        let interval = config.get_eval_frequency().saturating_mul(60) as i64;
        let gap = self.last_evaluated_at.is_none_or(|previous| {
            (now - previous).num_seconds() > interval + interval / 2 || now < previous
        });
        let mut seen = BTreeSet::new();
        let mut transitions = vec![];
        for (labels, value) in samples {
            let key = serde_json::to_string(&labels).map_err(|e| e.to_string())?;
            if !seen.insert(key.clone()) {
                return Err("Duplicate PromQL label set".into());
            }
            if !self.instances.contains_key(&key) && self.instances.len() >= MAX_INSTANCES {
                return Err("PromQL alert instance limit reached".into());
            }
            let entry = self.instances.entry(key).or_insert_with(|| Instance {
                labels: labels.clone(),
                state: "resolved".into(),
                pending_since: None,
                last_seen: now,
                value,
            });
            entry.value = value;
            entry.last_seen = now;
            if evaluate_condition(
                &config.threshold_config.operator,
                value,
                config.threshold_config.value,
            ) {
                if entry.state != "firing" {
                    if gap || entry.pending_since.is_none() {
                        entry.pending_since = Some(now);
                    }
                    entry.state = "pending".into();
                    if (now - entry.pending_since.unwrap()).num_milliseconds() >= hold {
                        entry.state = "firing".into();
                        transitions.push((labels, value, true));
                    }
                }
            } else {
                if entry.state == "firing" {
                    transitions.push((labels, value, false));
                }
                entry.state = "resolved".into();
                entry.pending_since = None;
            }
        }
        let missing = self
            .instances
            .iter()
            .any(|(key, instance)| !seen.contains(key) && instance.state != "resolved");
        for (key, instance) in &mut self.instances {
            if !seen.contains(key) {
                instance.pending_since = None;
            }
        }
        self.instances
            .retain(|key, instance| seen.contains(key) || instance.state == "firing");
        self.health = if seen.is_empty() || missing {
            "noData"
        } else {
            "ok"
        }
        .into();
        self.error = None;
        self.last_evaluated_at = Some(now);
        Ok(transitions)
    }
}

pub(super) fn reset_runtime_for_disable(
    fields: &mut Option<serde_json::Map<String, serde_json::Value>>,
) {
    if let Some(fields) = fields {
        fields.remove("promqlRuntime");
    }
}

fn notifications_allowed(state: &NotificationState, now: DateTime<Utc>) -> bool {
    match state {
        NotificationState::Notify => true,
        NotificationState::Mute(till) => {
            till != "indefinite" && till.parse::<DateTime<Utc>>().is_ok_and(|time| now > time)
        }
    }
}

pub async fn evaluate(config: AlertConfig) -> Result<(), AlertError> {
    if config.state == AlertState::Disabled {
        return Ok(());
    }
    let now = Utc::now();
    let mut runtime: Runtime = config
        .other_fields
        .as_ref()
        .and_then(|f| f.get("promqlRuntime"))
        .map(|v| serde_json::from_value(v.clone()))
        .transpose()?
        .unwrap_or_default();
    let authorized = authorize_execution(&config);
    let may_deliver = authorized.is_ok();
    let result = match authorized {
        Ok(()) => {
            crate::handlers::http::promql::execute_alert_instant(
                &config.datasets[0],
                &config.query,
                &config.tenant_id,
            )
            .await
        }
        Err(error) => Err(error),
    };
    let transitions =
        match result.and_then(|samples| runtime.observe_transactionally(samples, &config, now)) {
            Ok(transitions) => transitions,
            Err(error) => {
                runtime.discontinuity("error", Some(error), now);
                vec![]
            }
        };
    let mut updated = config;
    let previous_state = updated.state;
    updated.state = if runtime.instances.values().any(|i| i.state == "firing") {
        AlertState::Triggered
    } else {
        AlertState::NotTriggered
    };
    if transitions.iter().any(|(_, _, firing)| *firing) {
        updated.last_triggered_at = Some(now);
    }
    let notify = notifications_allowed(&updated.notification_state, now);
    if notify {
        for (labels, value, firing) in transitions {
            for target in &updated.targets {
                runtime.deliveries.push(Delivery {
                    labels: labels.clone(),
                    value,
                    firing,
                    target: *target,
                    attempts: 0,
                    error: None,
                });
            }
        }
    }
    updated
        .other_fields
        .get_or_insert_with(Default::default)
        .insert("promqlRuntime".into(), serde_json::to_value(&runtime)?);
    PARSEABLE
        .metastore
        .put_alert(&updated, &updated.tenant_id)
        .await?;
    let manager = super::get_alert_manager().await;
    manager.update(&ThresholdAlert::from(updated.clone())).await;
    if previous_state != updated.state {
        PARSEABLE
            .metastore
            .put_alert_state(
                &super::AlertStateEntry::new(updated.id, updated.state, updated.tenant_id.clone()),
                &updated.tenant_id,
            )
            .await?;
    }
    if notify && may_deliver {
        // Each evaluation makes at most one delivery attempt per queued transition.
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
        for delivery in runtime
            .deliveries
            .iter_mut()
            .filter(|delivery| delivery.attempts < 3)
            .take(10)
        {
            if tokio::time::Instant::now() >= deadline {
                break;
            }
            if delivery.attempts >= 3 {
                continue;
            }
            let identity = delivery
                .labels
                .iter()
                .map(|(k, v)| format!("{k}={v}"))
                .collect::<Vec<_>>()
                .join(", ");
            let mut context = updated.get_context();
            context.alert_info.alert_name = format!("{} [{}]", updated.title, identity);
            context.alert_info.alert_state = if delivery.firing {
                AlertState::Triggered
            } else {
                AlertState::NotTriggered
            };
            context.message = format!(
                "{}: {}\nValue: {}\nThreshold: {} {}\nQuery: {}",
                context.alert_info.alert_name,
                if delivery.firing {
                    "firing"
                } else {
                    "resolved"
                },
                delivery.value,
                updated.threshold_config.operator,
                updated.threshold_config.value,
                updated.query
            );
            delivery.attempts += 1;
            let target_result = TARGETS
                .get_target_by_id(&delivery.target, &updated.tenant_id)
                .await
                .map_err(|error| error.to_string());
            let result = match target_result {
                Ok(target) => match tokio::time::timeout_at(
                    deadline.min(tokio::time::Instant::now() + std::time::Duration::from_secs(5)),
                    target.deliver_promql(&updated.tenant_id, &context),
                )
                .await
                {
                    Ok(result) => result,
                    Err(_) => Err("Notification delivery timed out".into()),
                },
                Err(error) => Err(error),
            };
            match result {
                Ok(()) => {
                    delivery.attempts = u32::MAX;
                    delivery.error = None;
                }
                Err(error) => delivery.error = Some(error),
            }
        }
        runtime
            .deliveries
            .retain(|delivery| delivery.error.is_some() || delivery.attempts == 0);
        updated
            .other_fields
            .as_mut()
            .unwrap()
            .insert("promqlRuntime".into(), serde_json::to_value(&runtime)?);
        PARSEABLE
            .metastore
            .put_alert(&updated, &updated.tenant_id)
            .await?;
        manager.update(&ThresholdAlert::from(updated)).await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config() -> AlertConfig {
        serde_json::from_value(serde_json::json!({
            "version":"v2","id":ulid::Ulid::new(),"severity":"high","title":"Host load",
            "queryType":"promql","query":"load","datasets":["metrics"],"alertType":"threshold",
            "thresholdConfig":{"operator":">","value":8.0},
            "evalConfig":{"rollingWindow":{"evalStart":"5m","evalEnd":"now","evalFrequency":1}},
            "targets":[],"notificationState":"notify","notificationConfig":{"interval":1},
            "created":Utc::now(),"promqlConfig":{"holdDuration":"5m"}
        }))
        .unwrap()
    }
    fn sample(host: &str, value: f64) -> (Labels, f64) {
        (BTreeMap::from([("host".into(), host.into())]), value)
    }
    #[test]
    fn independent_hosts_hold_and_recover() {
        let config = config();
        let now = Utc::now();
        let mut runtime = Runtime::default();
        assert!(
            runtime
                .observe(vec![sample("a", 9.0), sample("b", 3.0)], &config, now)
                .unwrap()
                .is_empty()
        );
        for minute in 1..5 {
            assert!(
                runtime
                    .observe(
                        vec![sample("a", 9.0), sample("b", 9.0)],
                        &config,
                        now + chrono::Duration::minutes(minute)
                    )
                    .unwrap()
                    .is_empty()
            );
        }
        let fired = runtime
            .observe(
                vec![sample("a", 9.0), sample("b", 9.0)],
                &config,
                now + chrono::Duration::minutes(5),
            )
            .unwrap();
        assert_eq!(fired.len(), 1);
        assert_eq!(fired[0].0["host"], "a");
        assert!(fired[0].2);
        let next = runtime
            .observe(
                vec![sample("a", 2.0), sample("b", 9.0)],
                &config,
                now + chrono::Duration::minutes(6),
            )
            .unwrap();
        assert_eq!(next.len(), 2);
        assert!(!next[0].2);
        assert!(next[1].2);
    }
    #[test]
    fn gaps_and_errors_do_not_recover_firing_or_advance_pending() {
        let mut config = config();
        config.other_fields.as_mut().unwrap().insert(
            "promqlConfig".into(),
            serde_json::json!({"holdDuration":"0s"}),
        );
        let now = Utc::now();
        let mut runtime = Runtime::default();
        assert_eq!(
            runtime
                .observe(vec![sample("a", 9.0)], &config, now)
                .unwrap()
                .len(),
            1
        );
        assert!(
            runtime
                .observe(vec![], &config, now + chrono::Duration::minutes(1))
                .unwrap()
                .is_empty()
        );
        assert_eq!(runtime.health, "noData");
        assert_eq!(runtime.instances.values().next().unwrap().state, "firing");
        runtime.discontinuity(
            "error",
            Some("timeout".into()),
            now + chrono::Duration::minutes(2),
        );
        assert_eq!(runtime.instances.values().next().unwrap().state, "firing");
        let persisted = serde_json::to_string(&runtime).unwrap();
        let restored: Runtime = serde_json::from_str(&persisted).unwrap();
        assert_eq!(restored.health, "error");
        assert_eq!(restored.instances.values().next().unwrap().state, "firing");
    }
    #[test]
    fn pending_restarts_after_missing_sample_or_long_gap() {
        let config = config();
        let now = Utc::now();
        let mut runtime = Runtime::default();
        runtime
            .observe(vec![sample("a", 9.0)], &config, now)
            .unwrap();
        runtime
            .observe(vec![], &config, now + chrono::Duration::minutes(1))
            .unwrap();
        runtime
            .observe(
                vec![sample("a", 9.0)],
                &config,
                now + chrono::Duration::minutes(2),
            )
            .unwrap();
        assert_eq!(
            runtime.instances.values().next().unwrap().pending_since,
            Some(now + chrono::Duration::minutes(2))
        );
        runtime
            .observe(
                vec![sample("a", 9.0)],
                &config,
                now + chrono::Duration::minutes(10),
            )
            .unwrap();
        assert_eq!(
            runtime.instances.values().next().unwrap().pending_since,
            Some(now + chrono::Duration::minutes(10))
        );
        assert!(
            runtime
                .observe(vec![sample("b", f64::NAN)], &config, now)
                .is_err()
        );
    }
    #[test]
    fn duplicate_labels_and_full_outbox_leave_instance_state_unchanged() {
        let mut config = config();
        config.targets.push(ulid::Ulid::new());
        config.other_fields.as_mut().unwrap().insert(
            "promqlConfig".into(),
            serde_json::json!({"holdDuration":"0s"}),
        );
        let mut runtime = Runtime::default();
        let now = Utc::now();
        assert!(
            runtime
                .observe_transactionally(vec![sample("a", 9.0), sample("a", 10.0)], &config, now)
                .is_err()
        );
        assert!(runtime.instances.is_empty());
        runtime.deliveries = (0..1000)
            .map(|_| Delivery {
                labels: Labels::new(),
                value: 1.0,
                firing: true,
                target: config.targets[0],
                attempts: 3,
                error: Some("failed".into()),
            })
            .collect();
        assert!(
            runtime
                .observe_transactionally(vec![sample("a", 9.0)], &config, now)
                .is_err()
        );
        assert!(runtime.instances.is_empty());
        let restored: Runtime =
            serde_json::from_value(serde_json::to_value(&runtime).unwrap()).unwrap();
        assert_eq!(restored.deliveries.len(), 1000);
        assert_eq!(restored.deliveries[0].attempts, 3);
    }
    #[test]
    fn mute_suppresses_delivery_until_expiry() {
        let now = Utc::now();
        assert!(notifications_allowed(&NotificationState::Notify, now));
        assert!(!notifications_allowed(
            &NotificationState::Mute("indefinite".into()),
            now
        ));
        assert!(!notifications_allowed(
            &NotificationState::Mute((now + chrono::Duration::minutes(1)).to_rfc3339()),
            now
        ));
        assert!(notifications_allowed(
            &NotificationState::Mute((now - chrono::Duration::minutes(1)).to_rfc3339()),
            now
        ));
        assert!(!notifications_allowed(
            &NotificationState::Mute("malformed".into()),
            now
        ));
    }
    #[test]
    fn recovery_supersedes_failed_firing_for_only_that_instance() {
        let mut config = config();
        config.other_fields.as_mut().unwrap().insert(
            "promqlConfig".into(),
            serde_json::json!({"holdDuration":"0s"}),
        );
        let now = Utc::now();
        let mut runtime = Runtime::default();
        runtime
            .observe_transactionally(vec![sample("a", 9.0), sample("b", 9.0)], &config, now)
            .unwrap();
        let target = ulid::Ulid::new();
        runtime.deliveries = ["a", "b"]
            .into_iter()
            .map(|host| Delivery {
                labels: sample(host, 9.0).0,
                value: 9.0,
                firing: true,
                target,
                attempts: 1,
                error: Some("target failed".into()),
            })
            .collect();
        // Superseding happens during evaluation even if mute suppresses new delivery.
        config.notification_state = NotificationState::Mute("indefinite".into());
        let recovered = runtime
            .observe_transactionally(
                vec![sample("a", 2.0), sample("b", 9.0)],
                &config,
                now + chrono::Duration::minutes(1),
            )
            .unwrap();
        assert_eq!(recovered.len(), 1);
        assert!(!recovered[0].2);
        assert_eq!(runtime.deliveries.len(), 1);
        assert_eq!(runtime.deliveries[0].labels["host"], "b");
        runtime.deliveries.push(Delivery {
            labels: sample("a", 2.0).0,
            value: 2.0,
            firing: false,
            target,
            attempts: 1,
            error: Some("recovery failed".into()),
        });
        runtime
            .observe_transactionally(
                vec![sample("a", 9.0), sample("b", 9.0)],
                &config,
                now + chrono::Duration::minutes(2),
            )
            .unwrap();
        assert_eq!(runtime.deliveries.len(), 1);
        assert_eq!(runtime.deliveries[0].labels["host"], "b");
    }
    #[test]
    fn muted_new_transition_does_not_reserve_delivery_capacity() {
        let mut config = config();
        config.targets.push(ulid::Ulid::new());
        config.notification_state = NotificationState::Mute("indefinite".into());
        config.other_fields.as_mut().unwrap().insert(
            "promqlConfig".into(),
            serde_json::json!({"holdDuration":"0s"}),
        );
        let mut runtime = Runtime::default();
        runtime.deliveries = (0..1000)
            .map(|_| Delivery {
                labels: Labels::new(),
                value: 1.0,
                firing: true,
                target: config.targets[0],
                attempts: 3,
                error: Some("failed".into()),
            })
            .collect();
        assert_eq!(
            runtime
                .observe_transactionally(vec![sample("a", 9.0)], &config, Utc::now())
                .unwrap()
                .len(),
            1
        );
        assert_eq!(runtime.health, "ok");
        assert_eq!(runtime.deliveries.len(), 1000);
    }
    #[test]
    fn disabling_clears_instances_and_requires_fresh_hold_when_enabled() {
        let mut config = config();
        let now = Utc::now();
        let mut runtime = Runtime::default();
        runtime
            .observe(vec![sample("a", 9.0)], &config, now)
            .unwrap();
        runtime.instances.values_mut().next().unwrap().state = "firing".into();
        config.other_fields.as_mut().unwrap().insert(
            "promqlRuntime".into(),
            serde_json::to_value(&runtime).unwrap(),
        );
        reset_runtime_for_disable(&mut config.other_fields);
        assert!(
            !config
                .other_fields
                .as_ref()
                .unwrap()
                .contains_key("promqlRuntime")
        );
        assert!(
            config
                .other_fields
                .as_ref()
                .unwrap()
                .contains_key("promqlConfig")
        );
        let mut enabled = Runtime::default();
        assert!(
            enabled
                .observe(
                    vec![sample("a", 9.0)],
                    &config,
                    now + chrono::Duration::minutes(1)
                )
                .unwrap()
                .is_empty()
        );
        assert_eq!(enabled.instances.values().next().unwrap().state, "pending");
        assert_eq!(
            enabled.instances.values().next().unwrap().pending_since,
            Some(now + chrono::Duration::minutes(1))
        );
    }
}
