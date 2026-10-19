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

use chrono::{DateTime, Utc};
use once_cell::sync::Lazy;
use relative_path::RelativePathBuf;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ulid::Ulid;

use crate::{
    handlers::http::users::{DASHBOARDS_DIR, USERS_ROOT_DIR, dashboards::DashboardError},
    metastore::metastore_traits::MetastoreObject,
    parseable::PARSEABLE,
};

pub static DASHBOARDS: Lazy<Dashboards> = Lazy::new(Dashboards::default);
pub const CURRENT_DASHBOARD_VERSION: &str = "v1";

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq, Default)]
/// type of dashboard
/// Dashboard is the default type
/// Report is a type of dashboard that is used for reporting
pub enum DashboardType {
    /// Dashboard is the default type
    #[default]
    Dashboard,
    /// Report is a type of dashboard that is used for reporting
    Report,
}

#[derive(Debug, Serialize, Deserialize, Default, Clone)]
pub struct Tile {
    pub tile_id: Ulid,
    /// all other fields are variable and can be added as needed
    #[serde(flatten)]
    pub other_fields: Option<serde_json::Map<String, Value>>,
}
#[derive(Debug, Serialize, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Dashboard {
    pub version: Option<String>,
    pub title: String,
    /// Default dataset for new tiles; existing tiles retain their own queries.
    #[serde(
        default,
        deserialize_with = "deserialize_dataset",
        skip_serializing_if = "Option::is_none"
    )]
    pub dataset: Option<String>,
    pub author: Option<String>,
    pub dashboard_id: Option<Ulid>,
    pub created: Option<DateTime<Utc>>,
    pub modified: Option<DateTime<Utc>>,
    pub tags: Option<Vec<String>>,
    pub is_favorite: Option<bool>, // whether the dashboard is marked as favorite, default is false
    dashboard_type: Option<DashboardType>,
    pub tiles: Option<Vec<Tile>>,
    pub tenant_id: Option<String>,
    /// all other fields are variable and can be added as needed
    #[serde(flatten)]
    pub other_fields: Option<serde_json::Map<String, Value>>,
}

// Dataset was previously an arbitrary flattened field. Ignore unsupported legacy
// shapes instead of dropping the entire dashboard when loading stored documents.
fn deserialize_dataset<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    let value = Value::deserialize(deserializer)?;
    Ok(value
        .as_str()
        .map(str::trim)
        .filter(|dataset| !dataset.is_empty())
        .map(str::to_owned))
}

impl MetastoreObject for Dashboard {
    fn get_object_path(&self) -> String {
        let root = self.tenant_id.as_deref().unwrap_or("");
        RelativePathBuf::from_iter([
            root,
            USERS_ROOT_DIR,
            self.author.as_ref().unwrap(),
            DASHBOARDS_DIR,
            &format!("{}.json", self.dashboard_id.unwrap()),
        ])
        .to_string()
    }

    fn get_object_id(&self) -> String {
        self.dashboard_id.unwrap().to_string()
    }
}

impl Dashboard {
    /// set metadata for the dashboard
    /// add author, dashboard_id, version, modified, and dashboard_type
    /// if dashboard_id is None, generate a new one
    pub fn set_metadata(&mut self, user_id: &str, dashboard_id: Option<Ulid>) {
        self.author = Some(user_id.to_string());
        self.dashboard_id = dashboard_id.or_else(|| Some(Ulid::new()));
        self.version = Some(CURRENT_DASHBOARD_VERSION.to_string());
        self.modified = Some(Utc::now());
        if self.dashboard_type.is_none() {
            self.dashboard_type = Some(DashboardType::Dashboard);
        }
        if self.tiles.is_none() {
            self.tiles = Some(Vec::new());
        }

        // if is_favorite is None, set it to false, else set it to the current value
        self.is_favorite = self.is_favorite.or(Some(false));
    }

    /// create a summary of the dashboard
    /// used for listing dashboards
    pub fn to_summary(&self) -> serde_json::Map<String, serde_json::Value> {
        let mut map = serde_json::Map::new();

        map.insert(
            "title".to_string(),
            serde_json::Value::String(self.title.clone()),
        );

        if let Some(dataset) = &self.dataset {
            map.insert("dataset".to_string(), Value::String(dataset.clone()));
        }

        if let Some(author) = &self.author {
            map.insert(
                "author".to_string(),
                serde_json::Value::String(author.to_string()),
            );
        }

        if let Some(created) = &self.created {
            map.insert(
                "created".to_string(),
                serde_json::Value::String(created.to_string()),
            );
        }

        if let Some(modified) = &self.modified {
            map.insert(
                "modified".to_string(),
                serde_json::Value::String(modified.to_string()),
            );
        }

        if let Some(dashboard_id) = &self.dashboard_id {
            map.insert(
                "dashboardId".to_string(),
                serde_json::Value::String(dashboard_id.to_string()),
            );
        }

        if let Some(tags) = &self.tags {
            map.insert(
                "tags".to_string(),
                serde_json::Value::Array(
                    tags.iter()
                        .map(|tag| serde_json::Value::String(tag.clone()))
                        .collect(),
                ),
            );
        }

        map.insert(
            "isFavorite".to_string(),
            serde_json::Value::Bool(self.is_favorite.unwrap_or(false)),
        );

        if let Some(revision) = self
            .other_fields
            .as_ref()
            .and_then(|fields| fields.get("revision"))
        {
            map.insert("revision".into(), revision.clone());
        }
        map
    }
}

/// Validate the dashboard ID
/// Check if the dashboard ID is a valid ULID
/// If the dashboard ID is not valid, return an error
pub fn validate_dashboard_id(dashboard_id: String) -> Result<Ulid, DashboardError> {
    Ulid::from_string(&dashboard_id)
        .map_err(|_| DashboardError::Metadata("Invalid dashboard ID format - must be a valid ULID"))
}

/// Compatibility facade. Authoritative state and all writes live in the shared
/// dashboard service; no in-memory snapshot is used to authorize or persist.
#[derive(Default, Debug)]
pub struct Dashboards;

impl Dashboards {
    pub async fn load(&self) -> anyhow::Result<()> {
        // Keep the startup connectivity check without retaining a stale copy of
        // documents that other query nodes/agents can subsequently modify.
        PARSEABLE.metastore.get_dashboards().await?;
        Ok(())
    }

    pub async fn create(
        &self,
        user_id: &str,
        dashboard: &mut Dashboard,
        tenant_id: &Option<String>,
    ) -> Result<(), DashboardError> {
        let actor = super::dashboard_service::DashboardActor {
            user_id: user_id.to_owned(),
            is_admin: false,
        };
        let result = super::dashboard_service::create_json(
            &actor,
            tenant_id,
            serde_json::to_value(&*dashboard)?,
            &Default::default(),
        )
        .await?;
        *dashboard = serde_json::from_value(result["dashboard"].clone())?;
        Ok(())
    }

    pub async fn update(
        &self,
        user_id: &str,
        dashboard_id: Ulid,
        dashboard: &mut Dashboard,
        tenant_id: &Option<String>,
    ) -> Result<(), DashboardError> {
        let actor = super::dashboard_service::DashboardActor {
            user_id: user_id.to_owned(),
            is_admin: false,
        };
        let document = serde_json::to_value(&*dashboard)?;
        let options = super::dashboard_service::DashboardWriteOptions {
            expected_revision: document
                .get("revision")
                .and_then(Value::as_str)
                .map(str::to_owned),
            ..Default::default()
        };
        let result = super::dashboard_service::mutate_json(
            &actor,
            dashboard_id,
            tenant_id,
            super::dashboard_service::DashboardMutation::Replace(document),
            &options,
        )
        .await?;
        *dashboard = serde_json::from_value(result["dashboard"].clone())?;
        Ok(())
    }

    pub async fn delete_dashboard(
        &self,
        user_id: &str,
        dashboard_id: Ulid,
        is_admin: bool,
        tenant_id: &Option<String>,
    ) -> Result<(), DashboardError> {
        let actor = super::dashboard_service::DashboardActor {
            user_id: user_id.to_owned(),
            is_admin,
        };
        super::dashboard_service::delete_json(&actor, dashboard_id, tenant_id, &Default::default())
            .await
    }

    pub async fn get_dashboard(
        &self,
        dashboard_id: Ulid,
        tenant_id: &Option<String>,
    ) -> Option<Dashboard> {
        match super::dashboard_service::get_json(dashboard_id, tenant_id).await {
            Ok(document) => serde_json::from_value(document).ok(),
            Err(error) => {
                tracing::debug!(%error,"Dashboard compatibility lookup failed");
                None
            }
        }
    }

    pub async fn get_dashboard_by_user(
        &self,
        dashboard_id: Ulid,
        user_id: &str,
        is_admin: bool,
        tenant_id: &Option<String>,
    ) -> Option<Dashboard> {
        self.get_dashboard(dashboard_id, tenant_id)
            .await
            .filter(|dashboard| is_admin || dashboard.author.as_deref() == Some(user_id))
    }

    pub async fn list_dashboards(
        &self,
        limit: usize,
        tenant_id: &Option<String>,
    ) -> Vec<Dashboard> {
        let mut dashboards = match super::dashboard_service::list_json(tenant_id).await {
            Ok(documents) => documents
                .into_iter()
                .filter_map(|document| serde_json::from_value(document).ok())
                .collect::<Vec<Dashboard>>(),
            Err(error) => {
                tracing::warn!(%error,"Dashboard compatibility listing failed");
                Vec::new()
            }
        };
        dashboards.sort_by_key(|dashboard| std::cmp::Reverse(dashboard.modified));
        if limit > 0 {
            dashboards.truncate(limit);
        }
        dashboards
    }

    pub async fn list_tags(&self, tenant_id: &Option<String>) -> Vec<String> {
        let mut tags = self
            .list_dashboards(0, tenant_id)
            .await
            .into_iter()
            .filter_map(|dashboard| dashboard.tags)
            .flatten()
            .collect::<Vec<_>>();
        tags.sort();
        tags.dedup();
        tags
    }

    pub async fn list_dashboards_by_tags(
        &self,
        tags: Vec<String>,
        tenant_id: &Option<String>,
    ) -> Vec<Dashboard> {
        self.list_dashboards(0, tenant_id)
            .await
            .into_iter()
            .filter(|dashboard| {
                dashboard
                    .tags
                    .as_ref()
                    .is_some_and(|stored| stored.iter().any(|tag| tags.contains(tag)))
            })
            .collect()
    }

    pub async fn delete_tenant(&self, tenant_id: &str) {
        super::dashboard_service::forget_tenant(tenant_id);
    }
}

#[cfg(test)]
mod tests {
    use super::Dashboard;
    use serde_json::json;

    #[test]
    fn dataset_survives_metadata_and_storage_round_trip() {
        let mut dashboard: Dashboard = serde_json::from_value(json!({
            "title": "Application health",
            "dataset": "application_logs",
            "customSetting": { "enabled": true }
        }))
        .unwrap();
        dashboard.set_metadata("owner", None);

        let stored = serde_json::to_vec(&dashboard).unwrap();
        let loaded: Dashboard = serde_json::from_slice(&stored).unwrap();
        assert_eq!(loaded.dataset.as_deref(), Some("application_logs"));
        assert_eq!(loaded.to_summary()["dataset"], "application_logs");
        assert_eq!(
            serde_json::to_value(&loaded).unwrap()["customSetting"],
            json!({ "enabled": true })
        );
    }

    #[test]
    fn legacy_and_unbound_dashboards_need_no_dataset() {
        for document in [
            json!({ "title": "Legacy dashboard" }),
            json!({ "title": "Unbound dashboard", "dataset": null }),
            json!({ "title": "Blank dataset", "dataset": "  " }),
            json!({ "title": "Legacy number", "dataset": 5 }),
            json!({ "title": "Legacy object", "dataset": { "name": "logs" } }),
            json!({ "title": "Legacy array", "dataset": ["logs"] }),
        ] {
            let dashboard: Dashboard = serde_json::from_value(document).unwrap();
            assert!(dashboard.dataset.is_none());
            assert!(!dashboard.to_summary().contains_key("dataset"));
            assert!(
                serde_json::to_value(&dashboard)
                    .unwrap()
                    .get("dataset")
                    .is_none()
            );
        }
    }
}
