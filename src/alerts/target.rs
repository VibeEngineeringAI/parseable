/*
 * Parseable Server (C) 2022 - 2025 Parseable, Inc.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 */

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};

use async_trait::async_trait;
use base64::Engine;
use chrono::Utc;
use http::header::AUTHORIZATION;
use itertools::Itertools;
use once_cell::sync::Lazy;
use serde_json::{Value, json};
use tokio::sync::RwLock;
use tracing::{error, trace};
use ulid::Ulid;
use url::Url;

use super::{
    ALERTS,
    outbound_http_policy::{self, AlertTargetKind},
};
use crate::{
    alerts::{AlertError, AlertState, Context, alert_traits::CallableTarget},
    metastore::metastore_traits::MetastoreObject,
    parseable::{DEFAULT_TENANT, PARSEABLE},
    storage::object_storage::target_json_path,
};

/// Bound diagnostics and remove URL-bearing details before storage or API output.
/// Historic reqwest messages can include credentials in paths, query strings or userinfo.
pub fn safe_runtime_error(error: &str) -> String {
    let lower = error.to_ascii_lowercase();
    if lower.contains("http://") || lower.contains("https://") {
        return "Request failed (URL details redacted)".into();
    }
    error.chars().take(1024).collect()
}

fn safe_delivery_error(error: reqwest::Error) -> String {
    safe_runtime_error(&error.without_url().to_string())
}

pub static TARGETS: Lazy<TargetConfigs> = Lazy::new(|| TargetConfigs {
    target_configs: RwLock::new(HashMap::new()),
});

#[derive(Debug)]
pub struct TargetConfigs {
    pub target_configs: RwLock<HashMap<String, HashMap<Ulid, Target>>>,
}

impl TargetConfigs {
    /// Loads alerts from disk, blocks
    pub async fn load(&self) -> anyhow::Result<()> {
        let targets = PARSEABLE.metastore.get_targets().await?;
        let mut map = self.target_configs.write().await;
        for (tenant_id, targets) in targets {
            let inner = targets
                .into_iter()
                .map(|mut t| {
                    t.tenant = Some(tenant_id.clone());
                    (t.id, t)
                })
                .collect();
            map.insert(tenant_id, inner);
        }

        Ok(())
    }

    pub async fn update(&self, target: Target) -> Result<(), AlertError> {
        PARSEABLE
            .metastore
            .put_target(&target, &target.tenant)
            .await?;
        let mut map = self.target_configs.write().await;
        let tenant_id = target.tenant.as_deref().unwrap_or(DEFAULT_TENANT);
        map.entry(tenant_id.to_owned())
            .or_default()
            .insert(target.id, target);
        // map.insert(target.id, target.clone());
        Ok(())
    }

    pub async fn list(&self, tenant_id: &Option<String>) -> Result<Vec<Target>, AlertError> {
        let tenant_id = tenant_id.as_deref().unwrap_or(DEFAULT_TENANT);
        let targets = if let Some(targets) = self.target_configs.read().await.get(tenant_id) {
            targets.values().cloned().collect_vec()
        } else {
            vec![]
        };
        Ok(targets)
    }

    pub async fn get_target_by_id(
        &self,
        target_id: &Ulid,
        tenant_id: &Option<String>,
    ) -> Result<Target, AlertError> {
        let tenant_id = tenant_id.as_deref().unwrap_or(DEFAULT_TENANT);
        let target = if let Some(targets) = self.target_configs.read().await.get(tenant_id) {
            targets
                .get(target_id)
                .ok_or(AlertError::InvalidTargetID(target_id.to_string()))
                .cloned()?
        } else {
            return Err(AlertError::InvalidTargetID(target_id.to_string()));
        };

        Ok(target)
    }

    pub async fn delete(
        &self,
        target_id: &Ulid,
        tenant_id: &Option<String>,
    ) -> Result<Target, AlertError> {
        let tenant = tenant_id.as_deref().unwrap_or(DEFAULT_TENANT);
        // ensure that the target is not being used by any alert
        let guard = ALERTS.read().await;
        let alerts = if let Some(alerts) = guard.as_ref() {
            alerts
        } else {
            return Err(AlertError::CustomError("No AlertManager set".into()));
        };

        for alert in alerts.get_all_alerts(tenant_id).await.values() {
            if alert.get_targets().contains(target_id) {
                return Err(AlertError::TargetInUse);
            }
        }
        let target = if let Some(targets) = self.target_configs.write().await.get_mut(tenant) {
            targets
                .remove(target_id)
                .ok_or(AlertError::InvalidTargetID(target_id.to_string()))?
        } else {
            return Err(AlertError::InvalidTargetID(target_id.to_string()));
        };
        PARSEABLE
            .metastore
            .delete_target(&target, tenant_id)
            .await?;
        Ok(target)
    }
}

#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[serde(untagged)]
pub enum Retry {
    Infinite,
    Finite(usize),
}

impl Default for Retry {
    fn default() -> Self {
        Retry::Finite(1)
    }
}

#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
#[serde(try_from = "TargetVerifier")]
pub struct Target {
    pub name: String,
    #[serde(flatten)]
    pub target: TargetType,
    #[serde(default = "Ulid::new")]
    pub id: Ulid,
    pub tenant: Option<String>,
}

impl Target {
    pub async fn validate_outbound_policy(&self) -> Result<(), AlertError> {
        let tenant_id = &self.tenant;
        match &self.target {
            TargetType::Slack(target) => {
                outbound_http_policy::prepare_alert_target(
                    tenant_id,
                    &target.endpoint,
                    AlertTargetKind::Slack,
                    false,
                    None,
                )
                .await?;
            }
            TargetType::Other(target) => {
                outbound_http_policy::prepare_alert_target(
                    tenant_id,
                    &target.endpoint,
                    AlertTargetKind::Webhook,
                    target.skip_tls_check,
                    Some(&target.headers),
                )
                .await?;
            }
            TargetType::AlertManager(target) => {
                let prepared = outbound_http_policy::prepare_alert_target(
                    tenant_id,
                    &target.endpoint,
                    AlertTargetKind::AlertManager,
                    target.skip_tls_check,
                    None,
                )
                .await?;
                if target.auth.is_some() && !prepared.authorization_allowed {
                    return Err(outbound_http_policy::OutboundPolicyError::DeniedHeader(
                        AUTHORIZATION.as_str().to_string(),
                    )
                    .into());
                }
            }
        }

        Ok(())
    }
    pub fn mask(self) -> Value {
        match self.target {
            TargetType::Slack(slack_web_hook) => {
                json!({
                   "name":self.name,
                   "type":"slack",
                   "endpoint":format!("{}://********", slack_web_hook.endpoint.scheme()),
                   "id":self.id
                })
            }
            TargetType::Other(other_web_hook) => {
                let safe_headers: HashMap<String, String> = other_web_hook
                    .headers
                    .into_keys()
                    .map(|k| (k, "********".to_string()))
                    .collect();
                json!({
                    "name":self.name,
                    "type":"webhook",
                    "endpoint": format!("{}://********", other_web_hook.endpoint.scheme()),
                    "headers":safe_headers,
                    "skipTlsCheck":other_web_hook.skip_tls_check,
                    "id":self.id
                })
            }
            TargetType::AlertManager(alert_manager) => {
                let endpoint = format!("{}://********", alert_manager.endpoint.scheme());
                if let Some(auth) = alert_manager.auth {
                    let password = "********";
                    json!({
                        "name":self.name,
                        "type":"webhook",
                        "endpoint":endpoint,
                        "username":auth.username,
                        "password":password,
                        "skipTlsCheck":alert_manager.skip_tls_check,
                        "id":self.id
                    })
                } else {
                    json!({
                        "name":self.name,
                        "type":"webhook",
                        "endpoint":endpoint,
                        "username":Value::Null,
                        "password":Value::Null,
                        "skipTlsCheck":alert_manager.skip_tls_check,
                        "id":self.id
                    })
                }
            }
        }
    }

    pub fn alertmanager(&self) -> Option<&AlertManager> {
        match &self.target {
            TargetType::AlertManager(target) => Some(target),
            _ => None,
        }
    }

    /// Delivery with an observable result for the persisted PromQL notification outbox.
    /// Alertmanager receives `alerts`, which keep the series labels; Slack and
    /// webhook targets receive `message`.
    pub async fn deliver_promql(
        &self,
        tenant: &Option<String>,
        message: &str,
        alerts: &[Value],
    ) -> Result<(), String> {
        let request = match &self.target {
            TargetType::Slack(target) => {
                let prepared = outbound_http_policy::prepare_alert_target(
                    tenant,
                    &target.endpoint,
                    AlertTargetKind::Slack,
                    false,
                    None,
                )
                .await
                .map_err(|e| safe_runtime_error(&e.to_string()))?;
                prepared
                    .client
                    .post(target.endpoint.clone())
                    .json(&serde_json::json!({"text": message}))
            }
            TargetType::Other(target) => {
                let prepared = outbound_http_policy::prepare_alert_target(
                    tenant,
                    &target.endpoint,
                    AlertTargetKind::Webhook,
                    target.skip_tls_check,
                    Some(&target.headers),
                )
                .await
                .map_err(|e| safe_runtime_error(&e.to_string()))?;
                prepared
                    .client
                    .post(target.endpoint.clone())
                    .headers(prepared.headers)
                    .body(message.to_owned())
            }
            TargetType::AlertManager(target) => return target.post_promql(tenant, alerts).await,
        };
        request
            .send()
            .await
            .map_err(safe_delivery_error)?
            .error_for_status()
            .map_err(safe_delivery_error)?;
        Ok(())
    }

    pub fn call(&self, context: Context) {
        trace!("target.call context- {context:?}");
        let timeout = context.notification_config.clone();
        let resolves = context.alert_info.alert_state;
        let mut state = timeout.state.lock().unwrap();
        trace!("target.call state- {state:?}");
        state.alert_state = resolves;

        match resolves {
            AlertState::Triggered => {
                if !state.timed_out {
                    // call once and then start sleeping
                    // reduce repeats by 1
                    call_target(self.target.clone(), self.tenant.clone(), context.clone());
                    // set state
                    state.timed_out = true;
                    state.awaiting_resolve = true;
                    drop(state);
                    self.spawn_timeout_task(&timeout, context.clone());
                }
            }
            alert_state @ AlertState::NotTriggered => {
                state.alert_state = alert_state;
                if state.timed_out {
                    // if in timeout and resolve came in, only process if it's the first one ( awaiting resolve )
                    if state.awaiting_resolve {
                        state.awaiting_resolve = false;
                    } else {
                        // no further resolve will be considered in timeout period
                        return;
                    }
                }

                call_target(self.target.clone(), self.tenant.clone(), context);
            }
            // do not send out any notifs
            // (an eval should not have run!)
            AlertState::Disabled => {}
        }
    }

    fn spawn_timeout_task(&self, target_timeout: &NotificationConfig, alert_context: Context) {
        trace!("repeat-\n{target_timeout:?}");
        let state = Arc::clone(&target_timeout.state);
        let retry = target_timeout.times;
        let timeout = target_timeout.interval;
        let target = self.target.clone();
        let alert_id = alert_context.alert_info.alert_id;
        let tenant_id = self.tenant.clone();

        trace!("Spawning retry task");
        tokio::spawn(async move {
            // Get alerts manager reference once at the start
            let alerts = {
                let guard = ALERTS.read().await;
                if let Some(alerts) = guard.as_ref() {
                    alerts.clone()
                } else {
                    error!("No AlertManager set for alert_id: {alert_id}, stopping timeout task");
                    *state.lock().unwrap() = TimeoutState::default();
                    return;
                }
            }; // Lock released immediately

            let mut remaining = match retry {
                Retry::Infinite => None,
                Retry::Finite(times) => Some(times.saturating_sub(1)),
            };
            while remaining.is_none_or(|count| count > 0) {
                tokio::time::sleep(Duration::from_secs(timeout.saturating_mul(60))).await;
                // Re-read after sleeping: resolution, mute, disable, edits or deletion
                // during the wait must prevent a delayed firing notification.
                let lifecycle = super::promql_alerts::lifecycle(alert_id);
                let _lifecycle = lifecycle.lock().await;
                let Ok(current) = alerts.get_alert_by_id(alert_id, &tenant_id).await else {
                    break;
                };
                let current = current.to_alert_config();
                if !repeat_is_current(&current, &alert_context.notification_config, Utc::now()) {
                    break;
                }
                state.lock().unwrap().awaiting_resolve = true;
                call_target(target.clone(), tenant_id.clone(), alert_context.clone());
                if let Some(count) = remaining.as_mut() {
                    *count -= 1;
                }
            }
            *state.lock().unwrap() = TimeoutState::default();
        });
    }
}

fn repeat_is_current(
    current: &super::AlertConfig,
    original: &NotificationConfig,
    now: chrono::DateTime<Utc>,
) -> bool {
    current.state == AlertState::Triggered
        && super::promql_alerts::notifications_allowed(&current.notification_state, now)
        && Arc::ptr_eq(&current.notification_config.state, &original.state)
}

impl MetastoreObject for Target {
    fn get_object_path(&self) -> String {
        target_json_path(&self.id, &self.tenant).to_string()
    }

    fn get_object_id(&self) -> String {
        self.id.to_string()
    }
}

fn call_target(target: TargetType, tenant_id: Option<String>, context: Context) {
    trace!("Calling target with context- {context:?}");
    tokio::spawn(async move { target.call(&tenant_id, &context).await });
}

#[derive(Debug, serde::Deserialize)]
pub struct NotificationConfigVerifier {
    interval: Option<u64>,
    times: Option<usize>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetVerifier {
    pub name: String,
    #[serde(flatten)]
    pub target: TargetType,
    #[serde(default)]
    pub notification_config: Option<NotificationConfigVerifier>,
    #[serde(default = "Ulid::new")]
    pub id: Ulid,
    pub tenant_id: Option<String>,
}

impl TryFrom<TargetVerifier> for Target {
    type Error = String;

    fn try_from(value: TargetVerifier) -> Result<Self, Self::Error> {
        let mut timeout = NotificationConfig::default();

        // Default is Infinite in case of alertmanager
        if matches!(value.target, TargetType::AlertManager(_)) {
            timeout.times = Retry::Infinite
        }

        if let Some(notification_config) = value.notification_config {
            let interval = notification_config.interval.map(|ref interval| *interval);

            if let Some(interval) = interval {
                timeout.interval = interval
            }

            if let Some(times) = notification_config.times {
                timeout.times = Retry::Finite(times)
            }
        }

        Ok(Target {
            name: value.name,
            target: value.target,
            id: value.id,
            tenant: value.tenant_id,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(tag = "type")]
#[serde(deny_unknown_fields)]
pub enum TargetType {
    #[serde(rename = "slack")]
    Slack(SlackWebHook),
    #[serde(rename = "webhook")]
    Other(OtherWebHook),
    #[serde(rename = "alertManager")]
    AlertManager(AlertManager),
}

impl TargetType {
    pub async fn call(&self, tenant_id: &Option<String>, payload: &Context) {
        match self {
            TargetType::Slack(target) => target.call(tenant_id, payload).await,
            TargetType::Other(target) => target.call(tenant_id, payload).await,
            TargetType::AlertManager(target) => target.call(tenant_id, payload).await,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SlackWebHook {
    endpoint: Url,
}

#[async_trait]
impl CallableTarget for SlackWebHook {
    async fn call(&self, tenant_id: &Option<String>, payload: &Context) {
        let alert = match payload.alert_info.alert_state {
            AlertState::Triggered => {
                serde_json::json!({ "text": payload.message })
            }
            AlertState::NotTriggered => {
                serde_json::json!({ "text": payload.default_resolved_string() })
            }
            AlertState::Disabled => {
                serde_json::json!({ "text": payload.default_disabled_string() })
            }
        };
        // Revalidate immediately before delivery because stored targets and DNS can change.
        let prepared = match outbound_http_policy::prepare_alert_target(
            tenant_id,
            &self.endpoint,
            AlertTargetKind::Slack,
            false,
            None,
        )
        .await
        {
            Ok(prepared) => prepared,
            Err(err) => {
                error!("Slack alert target rejected by outbound policy:{err}");
                return;
            }
        };
        if let Err(e) = prepared
            .client
            .post(self.endpoint.clone())
            .json(&alert)
            .send()
            .await
        {
            error!("Couldn't make call to webhook, error:{}", e)
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OtherWebHook {
    endpoint: Url,
    #[serde(default)]
    headers: HashMap<String, String>,
    #[serde(default)]
    skip_tls_check: bool,
}

#[async_trait]
impl CallableTarget for OtherWebHook {
    async fn call(&self, tenant_id: &Option<String>, payload: &Context) {
        let alert = match payload.alert_info.alert_state {
            AlertState::Triggered => payload.message.clone(),
            AlertState::NotTriggered => payload.default_resolved_string(),
            AlertState::Disabled => payload.default_disabled_string(),
        };
        let prepared = match outbound_http_policy::prepare_alert_target(
            tenant_id,
            &self.endpoint,
            AlertTargetKind::Webhook,
            self.skip_tls_check,
            Some(&self.headers),
        )
        .await
        {
            Ok(prepared) => prepared,
            Err(err) => {
                error!("Webhook alert target rejected by outbound policy:{err}");
                return;
            }
        };
        let request = prepared
            .client
            .post(self.endpoint.clone())
            .headers(prepared.headers);
        if let Err(e) = request.body(alert).send().await {
            error!("Couldn't make call to webhook, error:{}", e)
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlertManager {
    endpoint: Url,
    #[serde(default)]
    skip_tls_check: bool,
    #[serde(flatten)]
    auth: Option<Auth>,
}

impl AlertManager {
    /// Post a batch of PromQL alerts, each already carrying its labels and `endsAt`.
    pub async fn post_promql(
        &self,
        tenant: &Option<String>,
        alerts: &[Value],
    ) -> Result<(), String> {
        let prepared = outbound_http_policy::prepare_alert_target(
            tenant,
            &self.endpoint,
            AlertTargetKind::AlertManager,
            self.skip_tls_check,
            None,
        )
        .await
        .map_err(|e| safe_runtime_error(&e.to_string()))?;
        let mut request = prepared.client.post(self.endpoint.clone()).json(alerts);
        if let Some(auth) = &self.auth {
            if !prepared.authorization_allowed {
                return Err("Target credentials blocked by outbound policy".into());
            }
            request = request.basic_auth(&auth.username, Some(&auth.password));
        }
        request
            .send()
            .await
            .map_err(safe_delivery_error)?
            .error_for_status()
            .map_err(safe_delivery_error)?;
        Ok(())
    }
}

#[async_trait]
impl CallableTarget for AlertManager {
    async fn call(&self, tenant_id: &Option<String>, payload: &Context) {
        let mut alerts = serde_json::json!([{
          "labels": {
            "alertname": payload.alert_info.alert_name,
            // "stream": payload.stream,
            "deployment_instance": payload.deployment_info.deployment_instance,
            "deployment_id": payload.deployment_info.deployment_id,
            "deployment_mode": payload.deployment_info.deployment_mode
            },
          "annotations": {
            "message": "MESSAGE",
            "reason": "REASON"
          }
        }]);

        let alert = &mut alerts[0];

        // fill in status label accordingly
        match payload.alert_info.alert_state {
            AlertState::Triggered => alert["labels"]["status"] = "triggered".into(),
            AlertState::NotTriggered => {
                alert["labels"]["status"] = "not-triggered".into();
                alert["annotations"]["reason"] =
                    serde_json::Value::String(payload.default_resolved_string());
                alert["endsAt"] = Utc::now()
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
                    .into();
            }
            AlertState::Disabled => alert["labels"]["status"] = "disabled".into(),
        };

        let prepared = match outbound_http_policy::prepare_alert_target(
            tenant_id,
            &self.endpoint,
            AlertTargetKind::AlertManager,
            self.skip_tls_check,
            None,
        )
        .await
        {
            Ok(prepared) => prepared,
            Err(err) => {
                error!("Alertmanager target rejected by outbound policy:{err}");
                return;
            }
        };

        let mut request = prepared.client.post(self.endpoint.clone()).json(&alerts);
        if let Some(Auth { username, password }) = &self.auth {
            // Credentials are only safe when the destination itself is explicitly allowlisted.
            if !prepared.authorization_allowed {
                error!(
                    "Alertmanager credentials blocked by outbound policy for destination:{}",
                    self.endpoint
                );
                return;
            }
            let basic_auth_value = "Basic ".to_string()
                + &base64::prelude::BASE64_STANDARD.encode(format!("{username}:{password}"));
            request = request.header(AUTHORIZATION, basic_auth_value);
        }
        if let Err(e) = request.send().await {
            error!("Couldn't make call to alertmanager, error:{}", e)
        }
    }
}

#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
pub struct NotificationConfig {
    pub interval: u64,
    #[serde(skip)]
    pub times: Retry,
    #[serde(skip)]
    pub state: Arc<Mutex<TimeoutState>>,
}

impl Default for NotificationConfig {
    fn default() -> Self {
        Self {
            interval: 1,
            times: Retry::default(),
            state: Arc::<Mutex<TimeoutState>>::default(),
        }
    }
}

#[derive(Debug, Default, Clone, Copy)]
pub struct TimeoutState {
    pub alert_state: AlertState,
    pub timed_out: bool,
    pub awaiting_resolve: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Auth {
    username: String,
    password: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diagnostics_redact_url_secrets_and_bound_non_url_errors() {
        for url in [
            "https://user:secret@host/path",
            "HTTP://host/private-token",
            "https://host/path?token=secret",
        ] {
            assert_eq!(
                safe_runtime_error(&format!("request failed for {url}")),
                "Request failed (URL details redacted)"
            );
        }
        assert_eq!(
            safe_runtime_error("Notification delivery timed out"),
            "Notification delivery timed out"
        );
        assert_eq!(safe_runtime_error(&"x".repeat(5000)).len(), 1024);
    }

    #[test]
    fn pending_repeat_checks_latest_state_mute_and_rule_identity() {
        let mut config: super::super::AlertConfig = serde_json::from_value(json!({
            "version":"v2","id":Ulid::new(),"severity":"high","title":"Count",
            "queryType":"code","query":"SELECT COUNT(*) FROM logs","datasets":["logs"],"alertType":"threshold",
            "thresholdConfig":{"operator":">","value":8.0},
            "evalConfig":{"rollingWindow":{"evalStart":"5m","evalEnd":"now","evalFrequency":10}},
            "targets":[],"notificationState":"notify","notificationConfig":{"interval":1},"created":Utc::now()
        })).unwrap();
        let original = config.notification_config.clone();
        config.state = AlertState::Triggered;
        assert!(repeat_is_current(&config, &original, Utc::now()));
        for state in [AlertState::NotTriggered, AlertState::Disabled] {
            config.state = state;
            assert!(!repeat_is_current(&config, &original, Utc::now()));
        }
        config.state = AlertState::Triggered;
        config.notification_state = super::super::NotificationState::Mute("indefinite".into());
        assert!(!repeat_is_current(&config, &original, Utc::now()));
        config.notification_state = super::super::NotificationState::Notify;
        config.notification_config = NotificationConfig::default();
        assert!(!repeat_is_current(&config, &original, Utc::now()));
    }

    #[test]
    fn test_masked_target_hides_secrets() {
        let target = Target {
            name: "test-target".into(),
            id: Ulid::new(),
            tenant: None,
            target: TargetType::AlertManager(AlertManager {
                endpoint: "https://internal.corp/api".parse().unwrap(),
                auth: Some(Auth {
                    username: "admin".into(),
                    password: "SuperSecretPassword123".into(),
                }),
                skip_tls_check: false,
            }),
        };

        let masked = target.mask();

        let masked_str = serde_json::to_string(&masked).unwrap();

        // These assertions MUST pass, or the build fails
        assert!(
            !masked_str.contains("SuperSecretPassword123"),
            "Password leaked in masked response!"
        );
        assert!(
            masked_str.contains("********"),
            "Expected redaction marker not found!"
        );
    }
}
