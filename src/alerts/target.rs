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
use tracing::{error, trace, warn};
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

const MAX_RUNTIME_ERROR_CHARS: usize = 1024;
const REDACTED_URL_ERROR: &str = "Request failed (URL details redacted)";
const INVALID_TARGET_CONFIGURATION: &str = "invalid alert target configuration";

/// Bound diagnostics and remove URL-bearing details before storage or API output.
/// Historic reqwest messages can include credentials in paths, query strings or userinfo.
pub fn safe_runtime_error(error: &str) -> String {
    if contains_http_url(error) {
        return REDACTED_URL_ERROR.into();
    }
    error.chars().take(MAX_RUNTIME_ERROR_CHARS).collect()
}

/// Whether `safe_runtime_error` would change `error`, so clean diagnostics are not reallocated.
pub(super) fn runtime_error_needs_redaction(error: &str) -> bool {
    contains_http_url(error)
        || (error.len() > MAX_RUNTIME_ERROR_CHARS
            && error.chars().nth(MAX_RUNTIME_ERROR_CHARS).is_some())
}

// Case-insensitive `http://` or `https://` marker, without allocating a lowercase copy.
fn contains_http_url(error: &str) -> bool {
    let bytes = error.as_bytes();
    error.match_indices("://").any(|(index, _)| {
        let ends_with = |scheme: &[u8]| {
            index >= scheme.len() && bytes[index - scheme.len()..index].eq_ignore_ascii_case(scheme)
        };
        ends_with(b"http") || ends_with(b"https")
    })
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

/// Serialized in full so stored targets keep their credentials. Deserialization goes
/// through `TargetVerifier`, see the `Deserialize` impl below.
#[derive(Debug, serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
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
                if alert_manager.auth.is_some() {
                    json!({
                        "name":self.name,
                        "type":"webhook",
                        "endpoint":endpoint,
                        "username":"********",
                        "password":"********",
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
                .map_err(|e| e.sanitized_message().to_string())?;
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
                .map_err(|e| e.sanitized_message().to_string())?;
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

        let sleep_and_check_if_call =
            move |timeout_state: Arc<Mutex<TimeoutState>>, current_state: AlertState| async move {
                tokio::time::sleep(Duration::from_secs(timeout * 60)).await;

                let mut state = timeout_state.lock().unwrap();

                if current_state == AlertState::Triggered {
                    state.awaiting_resolve = true;
                    true
                } else {
                    state.timed_out = false;
                    false
                }
            };

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

            match retry {
                Retry::Infinite => loop {
                    let current_state = if let Ok(state) =
                        alerts.get_state(alert_id, &tenant_id).await
                    {
                        state
                    } else {
                        *state.lock().unwrap() = TimeoutState::default();
                        warn!(
                            "Unable to fetch state for given alert_id- {alert_id}, stopping target notifs"
                        );
                        return;
                    };

                    let should_call =
                        sleep_and_check_if_call(Arc::clone(&state), current_state).await;
                    if should_call {
                        call_target(target.clone(), tenant_id.clone(), alert_context.clone())
                    }
                },
                Retry::Finite(times) => {
                    for _ in 0..(times - 1) {
                        let current_state = if let Ok(state) =
                            alerts.get_state(alert_id, &tenant_id).await
                        {
                            state
                        } else {
                            *state.lock().unwrap() = TimeoutState::default();
                            warn!(
                                "Unable to fetch state for given alert_id- {alert_id}, stopping target notifs"
                            );
                            return;
                        };

                        let should_call =
                            sleep_and_check_if_call(Arc::clone(&state), current_state).await;
                        if should_call {
                            call_target(target.clone(), tenant_id.clone(), alert_context.clone())
                        }
                    }
                }
            }
            *state.lock().unwrap() = TimeoutState::default();
        });
    }
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

// Serde errors echo rejected values (for example an endpoint string or a header value),
// which may be secrets. Report one generic error to HTTP, tool and stored-target callers.
impl<'de> serde::Deserialize<'de> for Target {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let verifier = <TargetVerifier as serde::Deserialize>::deserialize(deserializer)
            .map_err(|_| <D::Error as serde::de::Error>::custom(INVALID_TARGET_CONFIGURATION))?;
        Target::try_from(verifier)
            .map_err(|_| <D::Error as serde::de::Error>::custom(INVALID_TARGET_CONFIGURATION))
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
                error!(
                    "Slack alert target rejected by outbound policy:{}",
                    err.sanitized_message()
                );
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
            error!(
                "Couldn't make call to webhook, error:{}",
                safe_delivery_error(e)
            )
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
                error!(
                    "Webhook alert target rejected by outbound policy:{}",
                    err.sanitized_message()
                );
                return;
            }
        };
        let request = prepared
            .client
            .post(self.endpoint.clone())
            .headers(prepared.headers);
        if let Err(e) = request.body(alert).send().await {
            error!(
                "Couldn't make call to webhook, error:{}",
                safe_delivery_error(e)
            )
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
        .map_err(|e| e.sanitized_message().to_string())?;
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
                error!(
                    "Alertmanager target rejected by outbound policy:{}",
                    err.sanitized_message()
                );
                return;
            }
        };

        let mut request = prepared.client.post(self.endpoint.clone()).json(&alerts);
        if let Some(Auth { username, password }) = &self.auth {
            // Credentials are only safe when the destination itself is explicitly allowlisted.
            if !prepared.authorization_allowed {
                error!(
                    "Alertmanager credentials blocked by outbound policy: destination is not explicitly allowlisted"
                );
                return;
            }
            let basic_auth_value = "Basic ".to_string()
                + &base64::prelude::BASE64_STANDARD.encode(format!("{username}:{password}"));
            request = request.header(AUTHORIZATION, basic_auth_value);
        }
        if let Err(e) = request.send().await {
            error!(
                "Couldn't make call to alertmanager, error:{}",
                safe_delivery_error(e)
            )
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
    use std::{
        io::{Read, Write},
        net::{TcpListener, TcpStream},
        thread::JoinHandle,
    };

    use super::*;
    use crate::alerts::{
        AlertInfo, DeploymentInfo, NotificationState,
        outbound_http_policy::{ALERT_TARGET_POLICY, AlertTargetPolicyConfig},
    };

    const SECRETS: [&str; 7] = [
        "SECRET-USERINFO",
        "SECRET-PATH-TOKEN",
        "SECRET-QUERY-TOKEN",
        "SECRET-FRAGMENT",
        "SECRET-HEADER-VALUE",
        "SECRET-AM-USER",
        "SECRET-AM-PASSWORD",
    ];

    fn secret_url(host: &str) -> Url {
        format!(
            "http://url-user:SECRET-USERINFO@{host}/hooks/SECRET-PATH-TOKEN?token=SECRET-QUERY-TOKEN#SECRET-FRAGMENT"
        )
        .parse()
        .unwrap()
    }

    fn named(target: TargetType, tenant: &str) -> Target {
        Target {
            name: "redaction-target".into(),
            target,
            id: Ulid::new(),
            tenant: Some(tenant.to_owned()),
        }
    }

    fn webhook(endpoint: Url) -> TargetType {
        TargetType::Other(OtherWebHook {
            endpoint,
            headers: HashMap::from([("X-Api-Key".into(), "SECRET-HEADER-VALUE".into())]),
            skip_tls_check: false,
        })
    }

    fn alertmanager(endpoint: Url, with_auth: bool) -> TargetType {
        TargetType::AlertManager(AlertManager {
            endpoint,
            skip_tls_check: false,
            auth: with_auth.then(|| Auth {
                username: "SECRET-AM-USER".into(),
                password: "SECRET-AM-PASSWORD".into(),
            }),
        })
    }

    fn context() -> Context {
        Context::new(
            AlertInfo::new(
                Ulid::new(),
                "Redaction alert".into(),
                AlertState::Triggered,
                NotificationState::Notify,
                "high".into(),
            ),
            DeploymentInfo::new("instance".into(), Ulid::new(), "standalone".into()),
            NotificationConfig::default(),
            "alert message".into(),
        )
    }

    fn unique_tenant() -> String {
        format!("target-redaction-{}", Ulid::new())
    }

    /// Allow loopback delivery for one tenant only, as an operator allowlist would.
    async fn allow_loopback(tenant: &str) {
        ALERT_TARGET_POLICY.write().await.insert(
            tenant.to_owned(),
            AlertTargetPolicyConfig {
                allow_private: true,
                allowed_cidrs: vec!["127.0.0.1/32".into()],
                ..Default::default()
            },
        );
    }

    async fn remove_policy(tenant: &str) {
        ALERT_TARGET_POLICY.write().await.remove(tenant);
    }

    fn assert_redacted(text: &str, port: Option<u16>) {
        for secret in SECRETS {
            assert!(!text.contains(secret), "{secret} leaked in: {text}");
        }
        assert!(!text.contains("127.0.0.1"), "host leaked in: {text}");
        assert!(!text.contains("203.0.113.10"), "host leaked in: {text}");
        assert!(!text.contains("url-user"), "userinfo leaked in: {text}");
        if let Some(port) = port {
            assert!(
                !text.contains(&format!(":{port}")),
                "port leaked in: {text}"
            );
        }
    }

    /// Serve one request with `status` from a local loopback listener and
    /// return the raw request so callers can check what was delivered.
    fn serve_once(status: &'static str) -> (u16, JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let request = read_request(&mut stream);
            write!(
                stream,
                "HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            )
            .unwrap();
            request
        });
        (port, handle)
    }

    fn read_request(stream: &mut TcpStream) -> String {
        let mut data = Vec::new();
        let mut buf = [0u8; 4096];
        loop {
            let read = stream.read(&mut buf).unwrap_or(0);
            if read == 0 {
                break;
            }
            data.extend_from_slice(&buf[..read]);
            let Some(end) = data.windows(4).position(|w| w == b"\r\n\r\n") else {
                continue;
            };
            let head = String::from_utf8_lossy(&data[..end]).to_ascii_lowercase();
            let body_len = head
                .lines()
                .find_map(|line| line.strip_prefix("content-length:"))
                .and_then(|len| len.trim().parse::<usize>().ok())
                .unwrap_or(0);
            if data.len() >= end + 4 + body_len {
                break;
            }
        }
        String::from_utf8_lossy(&data).into_owned()
    }

    /// A loopback port with nothing listening, so connecting fails locally.
    fn refused_port() -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.local_addr().unwrap().port()
    }

    #[derive(Clone, Default)]
    struct CapturedLogs(Arc<Mutex<Vec<u8>>>);

    impl Write for CapturedLogs {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    /// Run `future` with a thread-local subscriber that records this crate's
    /// alert logs, so the actual formatted log lines can be checked.
    async fn capture_alert_logs(future: impl std::future::Future<Output = ()>) -> String {
        let logs = CapturedLogs::default();
        let writer = logs.clone();
        let subscriber = tracing_subscriber::fmt()
            .with_env_filter(tracing_subscriber::EnvFilter::new(
                "parseable::alerts=trace",
            ))
            .with_writer(move || writer.clone())
            .with_ansi(false)
            .finish();
        let _guard = tracing::subscriber::set_default(subscriber);
        future.await;
        String::from_utf8(logs.0.lock().unwrap().clone()).unwrap()
    }

    #[test]
    fn diagnostics_redact_url_secrets_and_bound_non_url_errors() {
        for error in [
            "request failed for https://user:secret@host/path",
            "HTTP://host/private-token",
            "hTtPs://host/path?token=secret#fragment",
            "error sending request for url (http://10.0.0.1:9093/api/v2/alerts)",
            "échec: https://hôte.example/路径?jeton=秘密",
            "first http://a.example/one then HTTPS://b.example/two",
            "prefixhttps://glued.example/token",
        ] {
            assert_eq!(safe_runtime_error(error), REDACTED_URL_ERROR, "{error}");
        }
        // A URL beyond the length cap is still redacted rather than truncated away.
        let late_url = format!("{}https://host/late-token", "x".repeat(3000));
        assert_eq!(safe_runtime_error(&late_url), REDACTED_URL_ERROR);

        for clean in [
            "Notification delivery timed out",
            "HTTP status server error (500 Internal Server Error)",
            "error sending request",
            "ftp://not-an-http-target",
            "Alert owner's dataset permission has been revoked",
        ] {
            assert_eq!(safe_runtime_error(clean), clean);
        }

        assert_eq!(safe_runtime_error(&"x".repeat(5000)).len(), 1024);
        let unicode = safe_runtime_error(&"é".repeat(5000));
        assert_eq!(unicode.chars().count(), 1024);
        assert_eq!(unicode.len(), 2048);
        assert_eq!(safe_runtime_error(&"x".repeat(1024)).len(), 1024);
    }

    #[test]
    fn diagnostics_redaction_is_idempotent_and_detects_needed_changes() {
        let long = "é".repeat(1500);
        let at_cap = "x".repeat(1024);
        let multibyte_at_cap = "é".repeat(1024);
        for error in [
            "https://user:secret@host/path",
            "Notification delivery timed out",
            long.as_str(),
            at_cap.as_str(),
            multibyte_at_cap.as_str(),
            "",
        ] {
            let once = safe_runtime_error(error);
            assert_eq!(safe_runtime_error(&once), once);
            assert!(!runtime_error_needs_redaction(&once));
            assert_eq!(
                runtime_error_needs_redaction(error),
                once != error,
                "{error}"
            );
        }
    }

    #[test]
    fn masked_targets_hide_urls_headers_and_credentials() {
        let tenant = unique_tenant();
        let slack = named(
            TargetType::Slack(SlackWebHook {
                endpoint: "https://hooks.slack.com/services/SECRET-PATH-TOKEN"
                    .parse()
                    .unwrap(),
            }),
            &tenant,
        );
        let id = slack.id;
        assert_eq!(
            slack.mask(),
            json!({"name":"redaction-target","type":"slack","endpoint":"https://********","id":id})
        );

        let other = named(webhook(secret_url("127.0.0.1:8080")), &tenant);
        let id = other.id;
        assert_eq!(
            other.mask(),
            json!({
                "name":"redaction-target","type":"webhook","endpoint":"http://********",
                "headers":{"X-Api-Key":"********"},"skipTlsCheck":false,"id":id
            })
        );

        let with_auth = named(alertmanager(secret_url("127.0.0.1:9093"), true), &tenant);
        let id = with_auth.id;
        assert_eq!(
            with_auth.mask(),
            json!({
                "name":"redaction-target","type":"webhook","endpoint":"http://********",
                "username":"********","password":"********","skipTlsCheck":false,"id":id
            })
        );

        let without_auth = named(alertmanager(secret_url("127.0.0.1:9093"), false), &tenant);
        let id = without_auth.id;
        assert_eq!(
            without_auth.mask(),
            json!({
                "name":"redaction-target","type":"webhook","endpoint":"http://********",
                "username":null,"password":null,"skipTlsCheck":false,"id":id
            })
        );
    }

    #[test]
    fn storage_serialization_keeps_credentials_and_round_trips() {
        let tenant = unique_tenant();
        for target in [
            named(
                TargetType::Slack(SlackWebHook {
                    endpoint: "https://hooks.slack.com/services/SECRET-PATH-TOKEN"
                        .parse()
                        .unwrap(),
                }),
                &tenant,
            ),
            named(webhook(secret_url("127.0.0.1:8080")), &tenant),
            named(alertmanager(secret_url("127.0.0.1:9093"), true), &tenant),
            named(alertmanager(secret_url("127.0.0.1:9093"), false), &tenant),
        ] {
            let stored = serde_json::to_string(&target).unwrap();
            assert!(stored.contains("SECRET-PATH-TOKEN"));
            if matches!(target.target, TargetType::Other(_)) {
                assert!(stored.contains("SECRET-HEADER-VALUE"));
            }
            if target.alertmanager().is_some_and(|am| am.auth.is_some()) {
                assert!(stored.contains("SECRET-AM-USER"));
                assert!(stored.contains("SECRET-AM-PASSWORD"));
            }
            let restored: Target = serde_json::from_str(&stored).unwrap();
            assert_eq!(restored.name, target.name);
            assert_eq!(restored.id, target.id);
            assert_eq!(restored.target, target.target);
        }
    }

    #[test]
    fn valid_target_requests_still_deserialize_through_the_verifier() {
        let id = Ulid::new();
        let target: Target = serde_json::from_value(json!({
            "name":"am","type":"alertManager","endpoint":"https://am.example/api/v2/alerts",
            "username":"user","password":"pass","skipTlsCheck":true,
            "notificationConfig":{"interval":5,"times":2},"id":id,"tenantId":"tenant-a"
        }))
        .unwrap();
        assert_eq!(target.id, id);
        assert_eq!(target.tenant.as_deref(), Some("tenant-a"));
        let am = target.alertmanager().unwrap();
        assert!(am.skip_tls_check);
        assert_eq!(
            am.auth,
            Some(Auth {
                username: "user".into(),
                password: "pass".into()
            })
        );

        let generated: Target = serde_json::from_value(json!({
            "name":"hook","type":"webhook","endpoint":"https://hook.example/x"
        }))
        .unwrap();
        assert!(matches!(generated.target, TargetType::Other(ref hook) if hook.headers.is_empty()));
    }

    #[test]
    fn invalid_secret_bearing_targets_report_generic_errors() {
        let cases = [
            json!({"name":"t","type":"webhook","endpoint":"not a url SECRET-ENDPOINT-VALUE"}),
            json!({"name":"t","type":"webhook","endpoint":"https://h.example","headers":{"X-Api-Key":424242}}),
            json!({"name":"t","type":"webhook","endpoint":"https://h.example","skipTlsCheck":"SECRET-BOOL-VALUE"}),
            json!({"name":"t","type":"alertManager","endpoint":"https://h.example","username":"SECRET-AUTH-USER","password":"SECRET-AUTH-PASSWORD","notificationConfig":{"interval":"SECRET-AUTH-INTERVAL"}}),
            json!({"name":"t","type":"SECRET-TYPE-VALUE","endpoint":"https://h.example"}),
            json!({"name":"t","type":"slack","endpoint":"https://hooks.slack.com/x","id":"SECRET-ID-VALUE"}),
        ];
        for case in cases {
            for error in [
                serde_json::from_value::<Target>(case.clone())
                    .unwrap_err()
                    .to_string(),
                serde_json::from_str::<Target>(&case.to_string())
                    .unwrap_err()
                    .to_string(),
            ] {
                assert!(error.starts_with(INVALID_TARGET_CONFIGURATION), "{error}");
                for secret in [
                    "SECRET-ENDPOINT-VALUE",
                    "424242",
                    "SECRET-BOOL-VALUE",
                    "SECRET-AUTH-USER",
                    "SECRET-AUTH-PASSWORD",
                    "SECRET-AUTH-INTERVAL",
                    "SECRET-TYPE-VALUE",
                    "SECRET-ID-VALUE",
                ] {
                    assert!(!error.contains(secret), "{secret} leaked in: {error}");
                }
            }
        }
    }

    #[tokio::test]
    async fn webhook_delivery_status_and_transport_errors_hide_urls() {
        let tenant = unique_tenant();
        allow_loopback(&tenant).await;

        let (port, server) = serve_once("500 Internal Server Error");
        let target = named(webhook(secret_url(&format!("127.0.0.1:{port}"))), &tenant);
        let status = target
            .deliver_promql(&target.tenant, "message", &[])
            .await
            .unwrap_err();
        let request = server.join().unwrap().to_ascii_lowercase();
        assert!(request.contains("x-api-key: secret-header-value"));
        assert!(status.contains("500"), "{status}");
        assert_redacted(&status, Some(port));

        let port = refused_port();
        let target = named(webhook(secret_url(&format!("127.0.0.1:{port}"))), &tenant);
        let transport = target
            .deliver_promql(&target.tenant, "message", &[])
            .await
            .unwrap_err();
        assert!(transport.contains("error sending request"), "{transport}");
        assert_redacted(&transport, Some(port));

        remove_policy(&tenant).await;
    }

    #[tokio::test]
    async fn alertmanager_delivery_status_and_transport_errors_hide_urls() {
        let tenant = unique_tenant();
        allow_loopback(&tenant).await;
        let alerts = [json!({"labels":{"alertname":"x"}})];

        let (port, server) = serve_once("503 Service Unavailable");
        let target = named(
            alertmanager(secret_url(&format!("127.0.0.1:{port}")), true),
            &tenant,
        );
        let status = target
            .deliver_promql(&target.tenant, "message", &alerts)
            .await
            .unwrap_err();
        let request = server.join().unwrap().to_ascii_lowercase();
        let credentials =
            base64::prelude::BASE64_STANDARD.encode("SECRET-AM-USER:SECRET-AM-PASSWORD");
        assert!(
            request.contains(&format!("authorization: basic {credentials}").to_ascii_lowercase())
        );
        assert!(status.contains("503"), "{status}");
        assert_redacted(&status, Some(port));

        let port = refused_port();
        let target = named(
            alertmanager(secret_url(&format!("127.0.0.1:{port}")), true),
            &tenant,
        );
        let transport = target
            .alertmanager()
            .unwrap()
            .post_promql(&target.tenant, &alerts)
            .await
            .unwrap_err();
        assert!(transport.contains("error sending request"), "{transport}");
        assert_redacted(&transport, Some(port));

        remove_policy(&tenant).await;
    }

    #[tokio::test]
    async fn delivery_policy_errors_use_sanitized_messages() {
        let tenant = unique_tenant();
        ALERT_TARGET_POLICY.write().await.insert(
            tenant.clone(),
            AlertTargetPolicyConfig {
                denied_domains: vec!["secret-denied.example".into()],
                ..Default::default()
            },
        );
        let denied = named(webhook(secret_url("secret-denied.example")), &tenant);
        let error = denied
            .deliver_promql(&denied.tenant, "message", &[])
            .await
            .unwrap_err();
        assert_eq!(error, "Target domain is denied by outbound policy");

        // Slack hosts are pinned before any DNS lookup, so this makes no request.
        let slack = named(
            TargetType::Slack(SlackWebHook {
                endpoint: "https://secret-slack-host.example/services/SECRET-PATH-TOKEN"
                    .parse()
                    .unwrap(),
            }),
            &tenant,
        );
        let error = slack
            .deliver_promql(&slack.tenant, "message", &[])
            .await
            .unwrap_err();
        assert_eq!(error, "Slack target host is invalid");

        // A public, non-allowlisted address may receive alerts but not credentials.
        let blocked = named(alertmanager(secret_url("203.0.113.10"), true), &tenant);
        let error = blocked
            .deliver_promql(&blocked.tenant, "message", &[])
            .await
            .unwrap_err();
        assert_eq!(error, "Target credentials blocked by outbound policy");

        remove_policy(&tenant).await;
    }

    #[tokio::test]
    async fn legacy_delivery_logs_hide_urls_and_credentials() {
        let tenant = unique_tenant();
        allow_loopback(&tenant).await;
        let tenant_id = Some(tenant.clone());
        let webhook_port = refused_port();
        let alertmanager_port = refused_port();

        let logs = capture_alert_logs(async {
            webhook(secret_url(&format!("127.0.0.1:{webhook_port}")))
                .call(&tenant_id, &context())
                .await;
            alertmanager(secret_url(&format!("127.0.0.1:{alertmanager_port}")), true)
                .call(&tenant_id, &context())
                .await;
            // No request is sent: credentials are blocked before delivery.
            alertmanager(secret_url("203.0.113.10"), true)
                .call(&tenant_id, &context())
                .await;
            TargetType::Slack(SlackWebHook {
                endpoint: "https://secret-slack-host.example/services/SECRET-PATH-TOKEN"
                    .parse()
                    .unwrap(),
            })
            .call(&tenant_id, &context())
            .await;
        })
        .await;

        assert!(logs.contains("Couldn't make call to webhook"), "{logs}");
        assert!(
            logs.contains("Couldn't make call to alertmanager"),
            "{logs}"
        );
        assert!(
            logs.contains("Alertmanager credentials blocked by outbound policy"),
            "{logs}"
        );
        assert!(logs.contains("Slack target host is invalid"), "{logs}");
        assert!(!logs.contains("secret-slack-host"), "{logs}");
        assert_redacted(&logs, Some(webhook_port));
        assert_redacted(&logs, Some(alertmanager_port));

        remove_policy(&tenant).await;
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
