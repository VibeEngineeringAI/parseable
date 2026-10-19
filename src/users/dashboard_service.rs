/*
 * Parseable Server (C) 2022 - 2026 Parseable, Inc.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

//! Authoritative dashboard reads and atomic, conditional mutations shared by
//! HTTP, tools and compatibility entry points. No cache lock spans storage I/O.

use std::{collections::HashMap, sync::Arc};

use bytes::Bytes;
use chrono::Utc;
use dashmap::DashMap;
use once_cell::sync::Lazy;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use ulid::Ulid;

use crate::{
    handlers::http::users::{DASHBOARDS_DIR, USERS_ROOT_DIR, dashboards::DashboardError},
    metastore::metastore_traits::{
        ConditionalMetadataError, MetadataVersion, MetadataWriteCondition, Metastore,
        VersionedMetadata,
    },
    parseable::PARSEABLE,
};

use super::{
    dashboard_patch::{DashboardOperation, apply_patch, validate_dashboard},
    dashboards::CURRENT_DASHBOARD_VERSION,
};

const INTERNAL: &str = "_parseableDashboard";
const RECEIPT_LIMIT: usize = 64;

#[derive(Debug, Clone)]
pub struct DashboardActor {
    /// Already hashed using the same identity mapping as existing dashboards.
    pub user_id: String,
    pub is_admin: bool,
}

#[derive(Debug, Clone, Default)]
pub struct DashboardWriteOptions {
    pub expected_revision: Option<String>,
    pub idempotency_key: Option<String>,
    pub dry_run: bool,
}

#[derive(Debug)]
pub enum DashboardMutation {
    Replace(Value),
    Metadata(HashMap<String, String>),
    AddTile(Value),
    Patch(Vec<DashboardOperation>),
}

#[derive(Debug, Clone)]
pub struct DashboardService {
    metastore: Arc<dyn Metastore>,
    /// Immutable owner locators can safely be cached across revisions/deletion.
    owners: Arc<DashMap<(String, Ulid), String>>,
    legacy: Arc<DashMap<String, Arc<LegacyTenant>>>,
}

#[derive(Debug, Default)]
struct LegacyTenant {
    initialized: tokio::sync::OnceCell<()>,
    titles: DashMap<String, Ulid>,
}

static SERVICE: Lazy<DashboardService> =
    Lazy::new(|| DashboardService::new(PARSEABLE.metastore.clone()));

pub async fn create_json(
    actor: &DashboardActor,
    tenant: &Option<String>,
    document: Value,
    options: &DashboardWriteOptions,
) -> Result<Value, DashboardError> {
    SERVICE.create_json(actor, tenant, document, options).await
}
pub async fn mutate_json(
    actor: &DashboardActor,
    id: Ulid,
    tenant: &Option<String>,
    mutation: DashboardMutation,
    options: &DashboardWriteOptions,
) -> Result<Value, DashboardError> {
    SERVICE
        .mutate_json(actor, id, tenant, mutation, options)
        .await
}
pub async fn mutate_legacy_json(
    actor: &DashboardActor,
    id: Ulid,
    tenant: &Option<String>,
    mutation: DashboardMutation,
    options: &DashboardWriteOptions,
) -> Result<Value, DashboardError> {
    SERVICE
        .mutate_legacy_json(actor, id, tenant, mutation, options)
        .await
}
pub async fn get_json(id: Ulid, tenant: &Option<String>) -> Result<Value, DashboardError> {
    SERVICE.get_json(id, tenant).await
}
pub async fn delete_json(
    actor: &DashboardActor,
    id: Ulid,
    tenant: &Option<String>,
    options: &DashboardWriteOptions,
) -> Result<(), DashboardError> {
    SERVICE.delete_json(actor, id, tenant, options).await
}
pub async fn list_json(tenant: &Option<String>) -> Result<Vec<Value>, DashboardError> {
    SERVICE.list_json(tenant).await
}

pub(crate) fn forget_tenant(tenant: &str) {
    SERVICE.owners.retain(|(key, _), _| key != tenant);
    SERVICE.legacy.remove(tenant);
}

struct StoredDashboard {
    path: String,
    document: Value,
    version: MetadataVersion,
    revision: String,
}

struct TitleClaim {
    path: String,
    version: MetadataVersion,
    document: Value,
    /// Only the operation that acquired a pending claim may roll it back.
    acquired: bool,
}

impl DashboardService {
    pub fn new(metastore: Arc<dyn Metastore>) -> Self {
        Self {
            metastore,
            owners: Arc::new(DashMap::new()),
            legacy: Arc::new(DashMap::new()),
        }
    }

    async fn read(
        &self,
        path: &str,
        tenant: &Option<String>,
    ) -> Result<Option<(Value, MetadataVersion)>, DashboardError> {
        self.metastore
            .get_dashboard_versioned(path, tenant)
            .await
            .map_err(storage_error)?
            .map(|VersionedMetadata { bytes, version }| {
                Ok((serde_json::from_slice(&bytes)?, version))
            })
            .transpose()
    }

    async fn write(
        &self,
        path: &str,
        document: &Value,
        condition: MetadataWriteCondition,
        tenant: &Option<String>,
    ) -> Result<MetadataVersion, DashboardError> {
        self.metastore
            .put_dashboard_conditional(
                path,
                Bytes::from(serde_json::to_vec(document)?),
                condition,
                tenant,
            )
            .await
            .map_err(storage_error)
    }

    /// Confirm the commit nonce after EVERY conditional-write error: provider
    /// transport retries can report a precondition failure after committing.
    async fn commit_document(
        &self,
        path: &str,
        document: &Value,
        condition: MetadataWriteCondition,
        tenant: &Option<String>,
        fence_create: bool,
    ) -> Result<(), DashboardError> {
        let nonce = document
            .pointer("/_parseableDashboard/revision")
            .and_then(Value::as_str)
            .ok_or_else(|| corrupt("commit nonce"))?;
        let error = match self.write(path, document, condition.clone(), tenant).await {
            Ok(_) => return Ok(()),
            Err(error) => error,
        };
        let current = self.read(path, tenant).await?;
        if current
            .as_ref()
            .is_some_and(|(current, _)| has_nonce(current, nonce))
        {
            return Ok(());
        }
        let fence = match (&condition, current.as_ref()) {
            (MetadataWriteCondition::Create, None) if fence_create => {
                let mut fence = compact_tombstone(document);
                // An unaccepted unkeyed create gets no applied receipt.
                fence[INTERNAL] = json!({"revision":Ulid::new().to_string(),"tombstone":true,"createReceipt":null,"receipts":[]});
                Some((fence, MetadataWriteCondition::Create))
            }
            (MetadataWriteCondition::Update(source), Some((current, version)))
                if source == version =>
            {
                let mut fence = current.clone();
                advance_nonce(&mut fence);
                Some((fence, MetadataWriteCondition::Update(version.clone())))
            }
            _ => None,
        };
        if let Some((fence, condition)) = fence {
            // Conditional fencing either prevents the original from landing,
            // or loses to it. Reread even when the fencing request also errors.
            let _ = self.write(path, &fence, condition, tenant).await;
            if self
                .read(path, tenant)
                .await?
                .as_ref()
                .is_some_and(|(current, _)| has_nonce(current, nonce))
            {
                return Ok(());
            }
        }
        Err(error)
    }

    async fn settle_failed_claim(&self, claim: &TitleClaim, tenant: &Option<String>) {
        let Some(id) = claim
            .document
            .get("dashboardId")
            .and_then(Value::as_str)
            .and_then(|id| Ulid::from_string(id).ok())
        else {
            return;
        };
        let current = match self.stored(id, tenant).await {
            Ok(stored) => Some(stored),
            Err(error) if is_not_found(&error) => None,
            Err(error) => {
                tracing::warn!(%error,"Could not reconcile dashboard title after uncertain write");
                return;
            }
        };
        if current.as_ref().is_some_and(|stored| {
            !deleted(&stored.document)
                && stored.document.get("title") == claim.document.get("title")
        }) {
            // Another edit may already have advanced our commit nonce. Its
            // current live title remains reserved regardless of nonce mismatch.
            self.activate_claim(
                TitleClaim {
                    path: claim.path.clone(),
                    version: claim.version.clone(),
                    document: claim.document.clone(),
                    acquired: false,
                },
                tenant,
            )
            .await;
        } else if pending_source_obsolete(&claim.document, current.as_ref()) {
            self.release_owned_title(
                TitleClaim {
                    path: claim.path.clone(),
                    version: claim.version.clone(),
                    document: claim.document.clone(),
                    acquired: false,
                },
                tenant,
            )
            .await;
        }
    }

    async fn bootstrap_legacy(
        &self,
        tenant: &Option<String>,
    ) -> Result<Arc<LegacyTenant>, DashboardError> {
        let state = self
            .legacy
            .entry(tenant.as_deref().unwrap_or("").to_owned())
            .or_default()
            .clone();
        state
            .initialized
            .get_or_try_init(|| async {
                for bytes in self.metastore.get_tenant_dashboards(tenant).await? {
                    let Ok(document) = serde_json::from_slice::<Value>(&bytes) else {
                        continue;
                    };
                    let Some(id) = document
                        .get("dashboardId")
                        .and_then(Value::as_str)
                        .and_then(|id| Ulid::from_string(id).ok())
                    else {
                        continue;
                    };
                    let Some(owner) = document.get("author").and_then(Value::as_str) else {
                        continue;
                    };
                    validate_scope(tenant, Some(owner))?;
                    self.owners
                        .entry((tenant.as_deref().unwrap_or("").to_owned(), id))
                        .or_insert_with(|| owner.to_owned());
                    if !deleted(&document)
                        && let Some(title) = document.get("title").and_then(Value::as_str)
                    {
                        state.titles.entry(title.to_owned()).or_insert(id);
                    }
                }
                Ok::<(), DashboardError>(())
            })
            .await?;
        Ok(state)
    }

    async fn legacy_title(
        &self,
        title: &str,
        tenant: &Option<String>,
    ) -> Result<Option<Ulid>, DashboardError> {
        let state = self.bootstrap_legacy(tenant).await?;
        let Some(id) = state.titles.get(title).map(|entry| *entry.value()) else {
            return Ok(None);
        };
        // The bootstrap is a candidate index, never authority: another node
        // may have renamed or deleted this legacy document since initialization.
        match self.stored(id, tenant).await {
            Ok(stored)
                if !deleted(&stored.document)
                    && stored.document.get("title").and_then(Value::as_str) == Some(title) =>
            {
                Ok(Some(id))
            }
            Ok(_) => {
                state.titles.remove_if(title, |_, existing| *existing == id);
                Ok(None)
            }
            Err(error) if is_not_found(&error) => {
                state.titles.remove_if(title, |_, existing| *existing == id);
                Ok(None)
            }
            Err(error) => Err(error),
        }
    }

    async fn owner(&self, id: Ulid, tenant: &Option<String>) -> Result<String, DashboardError> {
        validate_scope(tenant, None)?;
        let key = (tenant.as_deref().unwrap_or("").to_owned(), id);
        if let Some(owner) = self.owners.get(&key) {
            return Ok(owner.clone());
        }
        let locator_path = locator_path(tenant, id);
        if let Some((locator, _)) = self.read(&locator_path, tenant).await? {
            let owner = locator
                .get("owner")
                .and_then(Value::as_str)
                .ok_or_else(|| corrupt("dashboard owner locator"))?
                .to_owned();
            validate_scope(tenant, Some(&owner))?;
            if locator.get("dashboardId").and_then(Value::as_str) != Some(id.to_string().as_str()) {
                return Err(corrupt("dashboard owner locator ID"));
            }
            self.owners.insert(key, owner.clone());
            return Ok(owner);
        }
        // A negative result only skips repeated legacy scans. Every uncached
        // ID still checks its canonical locator above, so new remote creations
        // remain visible after this tenant's one-time bootstrap.
        self.bootstrap_legacy(tenant).await?;
        if let Some(owner) = self.owners.get(&key) {
            return Ok(owner.clone());
        }
        Err(not_found())
    }

    async fn install_locator(
        &self,
        id: Ulid,
        owner: &str,
        tenant: &Option<String>,
    ) -> Result<String, DashboardError> {
        let path = locator_path(tenant, id);
        let locator = json!({"dashboardId":id.to_string(),"owner":owner});
        match self
            .write(&path, &locator, MetadataWriteCondition::Create, tenant)
            .await
        {
            Ok(_) => {}
            Err(error) if is_conflict(&error) => {
                let (existing, _) = self
                    .read(&path, tenant)
                    .await?
                    .ok_or_else(|| corrupt("missing dashboard locator after conflict"))?;
                if existing != locator {
                    return Err(api(
                        409,
                        "dashboard_id_conflict",
                        "Dashboard ID belongs to another owner",
                        json!({}),
                    ));
                }
            }
            Err(error) => return Err(error),
        }
        self.owners.insert(
            (tenant.as_deref().unwrap_or("").to_owned(), id),
            owner.to_owned(),
        );
        Ok(owner.to_owned())
    }

    async fn stored(
        &self,
        id: Ulid,
        tenant: &Option<String>,
    ) -> Result<StoredDashboard, DashboardError> {
        let owner = self.owner(id, tenant).await?;
        let path = dashboard_path(tenant, &owner, id);
        let (mut document, version) = self.read(&path, tenant).await?.ok_or_else(not_found)?;
        if !document.is_object() {
            return Err(corrupt("dashboard document"));
        }
        // A caller never controls storage identity via fields in an update body.
        document["author"] = json!(owner);
        document["dashboardId"] = json!(id.to_string());
        document["tenantId"] = json!(tenant);
        let revision = revision(&document);
        Ok(StoredDashboard {
            path,
            document,
            version,
            revision,
        })
    }

    pub async fn get_json(
        &self,
        id: Ulid,
        tenant: &Option<String>,
    ) -> Result<Value, DashboardError> {
        let stored = self.stored(id, tenant).await?;
        if deleted(&stored.document) {
            return Err(not_found());
        }
        Ok(public_document(&stored.document, &stored.revision))
    }

    pub async fn list_json(&self, tenant: &Option<String>) -> Result<Vec<Value>, DashboardError> {
        validate_scope(tenant, None)?;
        let mut documents = Vec::new();
        for bytes in self.metastore.get_tenant_dashboards(tenant).await? {
            let Ok(mut document) = serde_json::from_slice::<Value>(&bytes) else {
                tracing::warn!("Skipping malformed dashboard JSON in listing");
                continue;
            };
            if deleted(&document) {
                continue;
            }
            // Listings need no extra per-object GET for new service documents.
            // Legacy documents are fetched once to expose an authoritative token.
            let current_revision = document
                .pointer("/_parseableDashboard/revision")
                .and_then(Value::as_str)
                .map(|_| {
                    let mut normalized = document.clone();
                    normalized["tenantId"] = json!(tenant);
                    revision(&normalized)
                });
            if let Some(current_revision) = current_revision {
                document["tenantId"] = json!(tenant);
                documents.push(public_document(&document, &current_revision));
            } else if let Some(id) = document
                .get("dashboardId")
                .and_then(Value::as_str)
                .and_then(|id| Ulid::from_string(id).ok())
            {
                match self.get_json(id, tenant).await {
                    Ok(document) => documents.push(document),
                    Err(error) if is_not_found(&error) => {}
                    Err(error) => return Err(error),
                }
            }
        }
        documents.sort_by(|a, b| {
            b.get("modified")
                .and_then(Value::as_str)
                .cmp(&a.get("modified").and_then(Value::as_str))
        });
        Ok(documents)
    }

    pub async fn create_json(
        &self,
        actor: &DashboardActor,
        tenant: &Option<String>,
        document: Value,
        options: &DashboardWriteOptions,
    ) -> Result<Value, DashboardError> {
        if options.dry_run {
            return self
                .create_json_inner(actor, tenant, document, options)
                .await;
        }
        // Dropping a request's JoinHandle detaches its commit task. Once a
        // title is reserved, routine HTTP cancellation cannot strand it.
        let service = self.clone();
        let actor = actor.clone();
        let tenant = tenant.clone();
        let options = options.clone();
        tokio::spawn(async move {
            service
                .create_json_inner(&actor, &tenant, document, &options)
                .await
        })
        .await
        .map_err(|error| {
            api(
                500,
                "dashboard_commit_failed",
                &format!("Dashboard commit task failed: {error}"),
                json!({}),
            )
        })?
    }

    async fn create_json_inner(
        &self,
        actor: &DashboardActor,
        tenant: &Option<String>,
        mut document: Value,
        options: &DashboardWriteOptions,
    ) -> Result<Value, DashboardError> {
        validate_scope(tenant, Some(&actor.user_id))?;
        validate_options(options)?;
        require_object(&document)?;
        reject_internal(&document)?;
        let request_hash = fingerprint(&json!({"operation":"create","document":document}));
        let id = if let Some(key) = &options.idempotency_key {
            let digest = Sha256::digest(serde_json::to_vec(&json!([tenant, actor.user_id, key]))?);
            Ulid::from_bytes(digest[..16].try_into().expect("SHA256 prefix"))
        } else {
            Ulid::new()
        };
        let path = dashboard_path(tenant, &actor.user_id, id);
        if options.idempotency_key.is_some()
            && let Some((existing, _version)) = self.read(&path, tenant).await?
        {
            let revision = revision(&existing);
            if let Some(result) =
                replay(&existing, &revision, actor, options, &request_hash, false)?
            {
                return Ok(result);
            }
            return Err(api(
                409,
                "idempotency_conflict",
                "Create idempotency key is already used",
                json!({"dashboardId":id.to_string()}),
            ));
        }
        let now = Utc::now().to_rfc3339();
        document["dashboardId"] = json!(id.to_string());
        document["author"] = json!(actor.user_id);
        document["tenantId"] = json!(tenant);
        document["created"] = json!(now);
        document["modified"] = json!(now);
        document["version"] = json!(CURRENT_DASHBOARD_VERSION);
        let object = document.as_object_mut().expect("object checked");
        object.remove("revision");
        for (key, default) in [
            ("tiles", json!([])),
            ("dashboardType", json!("Dashboard")),
            ("isFavorite", json!(false)),
        ] {
            if object.get(key).is_none_or(Value::is_null) {
                object.insert(key.to_owned(), default);
            }
        }
        let validation = validate_candidate(&document, None)?;
        let next_revision = Ulid::new().to_string();
        let diff = document_diff(&json!({}), &document);
        let title = title(&document)?.to_owned();
        if options.dry_run {
            self.check_title_available(&title, id, tenant).await?;
            let next_revision = revision_with_nonce(&document, Some(&next_revision));
            return Ok(
                json!({"dashboard":public_document(&document,&next_revision),"revision":next_revision,"validation":validation,"diff":diff,"dryRun":true,"titleAvailability":{"checked":true,"reserved":false,"mayConflictAtCommit":true}}),
            );
        }
        let claim = self
            .claim_title(&title, id, None, actor, options, &request_hash, tenant)
            .await?;
        if let Err(error) = self.install_locator(id, &actor.user_id, tenant).await {
            self.release_claim(&claim, tenant).await;
            return Err(error);
        }
        stamp(
            &mut document,
            &next_revision,
            false,
            actor,
            options,
            &request_hash,
            true,
        );
        let next_revision = revision(&document);
        match self
            .commit_document(
                &path,
                &document,
                MetadataWriteCondition::Create,
                tenant,
                options.idempotency_key.is_none(),
            )
            .await
        {
            Ok(_) => {
                self.activate_claim(claim, tenant).await;
            }
            Err(error) => {
                self.settle_failed_claim(&claim, tenant).await;
                if is_conflict(&error)
                    && let Some((existing, _version)) = self.read(&path, tenant).await?
                {
                    let revision = revision(&existing);
                    if let Some(result) =
                        replay(&existing, &revision, actor, options, &request_hash, false)?
                    {
                        return Ok(result);
                    }
                }
                return Err(error);
            }
        }
        Ok(
            json!({"dashboard":public_document(&document,&next_revision),"revision":next_revision,"validation":validation,"diff":diff}),
        )
    }

    /// Legacy PUT may omit a revision. Capture a source version once and use
    /// the normal CAS path; never retry a full replacement against newer data.
    /// PATCH/tools retain their explicit revision requirement.
    pub async fn mutate_legacy_json(
        &self,
        actor: &DashboardActor,
        id: Ulid,
        tenant: &Option<String>,
        mutation: DashboardMutation,
        options: &DashboardWriteOptions,
    ) -> Result<Value, DashboardError> {
        let mut options = options.clone();
        if let DashboardMutation::Replace(document) = &mutation
            && options.expected_revision.is_none()
            && document.get("revision").and_then(Value::as_str).is_none()
            && options.idempotency_key.is_none()
        {
            let base = self.stored(id, tenant).await?;
            authorize(actor, &base.document)?;
            if deleted(&base.document) {
                return Err(not_found());
            }
            options.expected_revision = Some(base.revision);
        }
        self.mutate_json(actor, id, tenant, mutation, &options)
            .await
    }

    pub async fn mutate_json(
        &self,
        actor: &DashboardActor,
        id: Ulid,
        tenant: &Option<String>,
        mutation: DashboardMutation,
        options: &DashboardWriteOptions,
    ) -> Result<Value, DashboardError> {
        if options.dry_run {
            return self
                .mutate_json_inner(actor, id, tenant, mutation, options)
                .await;
        }
        // Dropping a request's JoinHandle detaches its commit task. Once a
        // title is reserved, routine HTTP cancellation cannot strand it.
        let service = self.clone();
        let actor = actor.clone();
        let tenant = tenant.clone();
        let options = options.clone();
        tokio::spawn(async move {
            service
                .mutate_json_inner(&actor, id, &tenant, mutation, &options)
                .await
        })
        .await
        .map_err(|error| {
            api(
                500,
                "dashboard_commit_failed",
                &format!("Dashboard commit task failed: {error}"),
                json!({}),
            )
        })?
    }

    async fn mutate_json_inner(
        &self,
        actor: &DashboardActor,
        id: Ulid,
        tenant: &Option<String>,
        mutation: DashboardMutation,
        options: &DashboardWriteOptions,
    ) -> Result<Value, DashboardError> {
        let retry_delta = options.expected_revision.is_none()
            && options.idempotency_key.is_none()
            && matches!(
                &mutation,
                DashboardMutation::Metadata(_) | DashboardMutation::AddTile(_)
            );
        for attempt in 0..8 {
            let result = self
                .mutate_once(actor, id, tenant, &mutation, options)
                .await;
            if retry_delta
                && attempt < 7
                && matches!(
                    &result,
                    Err(DashboardError::Api {
                        code: "revision_conflict" | "title_reservation_pending",
                        ..
                    })
                )
            {
                tokio::task::yield_now().await;
                continue;
            }
            return result;
        }
        unreachable!("bounded mutation retry always returns")
    }

    async fn mutate_once(
        &self,
        actor: &DashboardActor,
        id: Ulid,
        tenant: &Option<String>,
        mutation: &DashboardMutation,
        options: &DashboardWriteOptions,
    ) -> Result<Value, DashboardError> {
        let mut effective_options = options.clone();
        if let DashboardMutation::Replace(document) = mutation
            && effective_options.expected_revision.is_none()
        {
            effective_options.expected_revision = document
                .get("revision")
                .and_then(Value::as_str)
                .map(str::to_owned);
        }
        let options = &effective_options;
        validate_scope(tenant, Some(&actor.user_id))?;
        validate_options(options)?;
        let base = self.stored(id, tenant).await?;
        authorize(actor, &base.document)?;
        let request_hash = fingerprint(&mutation_request(mutation)?);
        if let Some(result) = replay(
            &base.document,
            &base.revision,
            actor,
            options,
            &request_hash,
            false,
        )? {
            return Ok(result);
        }
        if deleted(&base.document) {
            return Err(not_found());
        }
        if (matches!(
            mutation,
            DashboardMutation::Patch(_) | DashboardMutation::Replace(_)
        ) || options.idempotency_key.is_some())
            && options.expected_revision.is_none()
        {
            return Err(api(
                428,
                "revision_required",
                "Dashboard replacements, patches and keyed mutations require an expected revision",
                json!({"currentRevision":base.revision}),
            ));
        }
        check_revision(options, &base.revision)?;
        let mut candidate = match &mutation {
            DashboardMutation::Replace(document) => {
                require_object(document)?;
                reject_internal(document)?;
                document.clone()
            }
            DashboardMutation::Metadata(metadata) => apply_metadata(&base.document, metadata)?,
            DashboardMutation::AddTile(tile) => add_tile(&base.document, tile)?,
            DashboardMutation::Patch(operations) => {
                apply_patch_candidate(&base.document, operations)?
            }
        };
        require_object(&candidate)?;
        // Metadata is restored from the authoritative object, including owner
        // when an administrator changes someone else's dashboard.
        for field in ["author", "dashboardId", "tenantId", "created", "version"] {
            if let Some(value) = base.document.get(field) {
                candidate[field] = value.clone();
            }
        }
        candidate
            .as_object_mut()
            .expect("object checked")
            .remove("revision");
        if let Some(internal) = base.document.get(INTERNAL) {
            candidate[INTERNAL] = internal.clone();
        }
        candidate["modified"] = json!(Utc::now().to_rfc3339());
        let validation = validate_candidate(&candidate, Some(&base.document))?;
        let diff = document_diff(
            &public_document(&base.document, &base.revision),
            &public_document(&candidate, &base.revision),
        );
        let next_revision = Ulid::new().to_string();
        let old_title = title(&base.document)?.to_owned();
        let next_title = title(&candidate)?.to_owned();
        if options.dry_run {
            if old_title != next_title {
                self.check_title_available(&next_title, id, tenant).await?;
            }
            return Ok(
                json!({"dashboard":public_document(&candidate,&base.revision),"revision":base.revision,"validation":validation,"diff":diff,"dryRun":true,"titleAvailability":{"checked":old_title!=next_title,"reserved":false,"mayConflictAtCommit":true}}),
            );
        }
        // A verified service document already owns its unchanged title. Hot
        // tile/config updates need one authoritative GET plus one conditional
        // PUT, without an extra title-index request on every agent operation.
        let claim = if old_title == next_title
            && base
                .document
                .pointer("/_parseableDashboard/contentRevision")
                .and_then(Value::as_str)
                == Some(base.revision.as_str())
        {
            None
        } else {
            Some(
                self.claim_title(
                    &next_title,
                    id,
                    Some(&base),
                    actor,
                    options,
                    &request_hash,
                    tenant,
                )
                .await?,
            )
        };
        let previous_claim = if old_title != next_title {
            self.read_title_claim(&old_title, id, tenant).await?
        } else {
            None
        };
        stamp(
            &mut candidate,
            &next_revision,
            false,
            actor,
            options,
            &request_hash,
            false,
        );
        let next_revision = revision(&candidate);
        match self
            .commit_document(
                &base.path,
                &candidate,
                MetadataWriteCondition::Update(base.version.clone()),
                tenant,
                false,
            )
            .await
        {
            Ok(_) => {}
            Err(error) => {
                if let Some(claim) = &claim {
                    self.settle_failed_claim(claim, tenant).await;
                }
                if is_conflict(&error) {
                    let latest = self.stored(id, tenant).await?;
                    if let Some(result) = replay(
                        &latest.document,
                        &latest.revision,
                        actor,
                        options,
                        &request_hash,
                        false,
                    )? {
                        return Ok(result);
                    }
                    return Err(conflict(&latest.revision));
                }
                return Err(error);
            }
        }
        if let Some(claim) = claim {
            self.activate_claim(claim, tenant).await;
        }
        if let Some(previous) = previous_claim {
            self.release_owned_title(previous, tenant).await;
        }
        Ok(
            json!({"dashboard":public_document(&candidate,&next_revision),"revision":next_revision,"validation":validation,"diff":diff}),
        )
    }

    pub async fn delete_json(
        &self,
        actor: &DashboardActor,
        id: Ulid,
        tenant: &Option<String>,
        options: &DashboardWriteOptions,
    ) -> Result<(), DashboardError> {
        if options.dry_run {
            return self.delete_json_inner(actor, id, tenant, options).await;
        }
        // Dropping a request's JoinHandle detaches its commit task. Once a
        // title is reserved, routine HTTP cancellation cannot strand it.
        let service = self.clone();
        let actor = actor.clone();
        let tenant = tenant.clone();
        let options = options.clone();
        tokio::spawn(async move {
            service
                .delete_json_inner(&actor, id, &tenant, &options)
                .await
        })
        .await
        .map_err(|error| {
            api(
                500,
                "dashboard_commit_failed",
                &format!("Dashboard commit task failed: {error}"),
                json!({}),
            )
        })?
    }

    async fn delete_json_inner(
        &self,
        actor: &DashboardActor,
        id: Ulid,
        tenant: &Option<String>,
        options: &DashboardWriteOptions,
    ) -> Result<(), DashboardError> {
        validate_scope(tenant, Some(&actor.user_id))?;
        validate_options(options)?;
        let base = self.stored(id, tenant).await?;
        authorize(actor, &base.document)?;
        let request_hash = fingerprint(&json!({"operation":"delete"}));
        if replay(
            &base.document,
            &base.revision,
            actor,
            options,
            &request_hash,
            true,
        )?
        .is_some()
        {
            return Ok(());
        }
        if options.idempotency_key.is_some() && options.expected_revision.is_none() {
            return Err(api(
                428,
                "revision_required",
                "Keyed dashboard deletion requires an expected revision",
                json!({"currentRevision":base.revision}),
            ));
        }
        if deleted(&base.document) {
            if options.expected_revision.is_none() {
                return Ok(());
            }
            return Err(conflict(&base.revision));
        }
        check_revision(options, &base.revision)?;
        if options.dry_run {
            return Ok(());
        }
        let title_claim = self
            .read_title_claim(title(&base.document)?, id, tenant)
            .await?;
        let mut tombstone = compact_tombstone(&base.document);
        let next_revision = Ulid::new().to_string();
        tombstone["modified"] = json!(Utc::now().to_rfc3339());
        stamp(
            &mut tombstone,
            &next_revision,
            true,
            actor,
            options,
            &request_hash,
            false,
        );
        match self
            .commit_document(
                &base.path,
                &tombstone,
                MetadataWriteCondition::Update(base.version),
                tenant,
                false,
            )
            .await
        {
            Ok(_) => {}
            Err(error) if is_conflict(&error) => {
                let latest = self.stored(id, tenant).await?;
                if replay(
                    &latest.document,
                    &latest.revision,
                    actor,
                    options,
                    &request_hash,
                    true,
                )?
                .is_some()
                {
                    return Ok(());
                }
                return Err(conflict(&latest.revision));
            }
            Err(error) => return Err(error),
        }
        if let Some(claim) = title_claim {
            self.release_owned_title(claim, tenant).await;
        }
        Ok(())
    }

    async fn check_title_available(
        &self,
        title: &str,
        id: Ulid,
        tenant: &Option<String>,
    ) -> Result<(), DashboardError> {
        if let Some((claim, _)) = self.read(&title_path(tenant, title), tenant).await? {
            match claim.get("state").and_then(Value::as_str) {
                Some("active" | "pending") => {
                    let claimant = claim
                        .get("dashboardId")
                        .and_then(Value::as_str)
                        .and_then(|id| Ulid::from_string(id).ok())
                        .ok_or_else(|| corrupt("title reservation owner"))?;
                    let current = match self.stored(claimant, tenant).await {
                        Ok(stored) => Some(stored),
                        Err(error) if is_not_found(&error) => None,
                        Err(error) => return Err(error),
                    };
                    if claimant != id {
                        if current.as_ref().is_some_and(|stored| {
                            !deleted(&stored.document)
                                && stored.document.get("title").and_then(Value::as_str)
                                    == Some(title)
                        }) {
                            return Err(api(
                                409,
                                "title_conflict",
                                "Dashboard title must be unique",
                                json!({"title":title}),
                            ));
                        }
                        if claim["state"] == "pending"
                            && !pending_source_obsolete(&claim, current.as_ref())
                        {
                            return Err(api(
                                409,
                                "title_reservation_pending",
                                "Dashboard title has an unfinished reservation whose source can still commit",
                                json!({"title":title}),
                            ));
                        }
                    }
                }
                Some("released") => {}
                _ => return Err(corrupt("title reservation state")),
            }
        }
        if self
            .legacy_title(title, tenant)
            .await?
            .is_some_and(|legacy_id| legacy_id != id)
        {
            return Err(api(
                409,
                "title_conflict",
                "Dashboard title must be unique",
                json!({"title":title}),
            ));
        }
        Ok(())
    }

    async fn read_title_claim(
        &self,
        title: &str,
        id: Ulid,
        tenant: &Option<String>,
    ) -> Result<Option<TitleClaim>, DashboardError> {
        let path = title_path(tenant, title);
        Ok(self
            .read(&path, tenant)
            .await?
            .filter(|(claim, _)| {
                claim.get("dashboardId").and_then(Value::as_str) == Some(id.to_string().as_str())
                    && claim.get("state").and_then(Value::as_str) != Some("released")
            })
            .map(|(document, version)| TitleClaim {
                path,
                document,
                version,
                acquired: false,
            }))
    }

    #[allow(clippy::too_many_arguments)]
    async fn claim_title(
        &self,
        title: &str,
        id: Ulid,
        base: Option<&StoredDashboard>,
        actor: &DashboardActor,
        options: &DashboardWriteOptions,
        request_hash: &str,
        tenant: &Option<String>,
    ) -> Result<TitleClaim, DashboardError> {
        let path = title_path(tenant, title);
        let operation = match &options.idempotency_key {
            Some(key) => fingerprint(&json!([actor.user_id, key, request_hash])),
            None => Ulid::new().to_string(),
        };
        // This exact object-storage version fences every in-flight attempt
        // sharing the reservation. A changed source proves its conditional
        // document write can never commit and permits safe orphan recovery.
        let source_version = base.map(|stored| metadata_version_json(&stored.version));
        let proposed = json!({"dashboardId":id.to_string(),"title":title,"state":"pending","operation":operation,"sourceVersion":source_version,"sourceRevision":base.map(|stored|stored.revision.as_str())});
        for _ in 0..8 {
            let existing = self.read(&path, tenant).await?;
            if let Some((claim, version)) = &existing {
                let state = claim.get("state").and_then(Value::as_str);
                let claimant = claim
                    .get("dashboardId")
                    .and_then(Value::as_str)
                    .and_then(|id| Ulid::from_string(id).ok());
                if state == Some("pending") {
                    if let Some(claimant) = claimant {
                        let current = match self.stored(claimant, tenant).await {
                            Ok(stored) => Some(stored),
                            Err(error) if is_not_found(&error) => None,
                            Err(error) => return Err(error),
                        };
                        if current.as_ref().is_some_and(|stored| {
                            !deleted(&stored.document)
                                && stored.document.get("title").and_then(Value::as_str)
                                    == Some(title)
                        }) {
                            // The dashboard itself proves a successful commit,
                            // even if its writer crashed before activation.
                            let mut active = claim.clone();
                            active["state"] = json!("active");
                            match self
                                .write(
                                    &path,
                                    &active,
                                    MetadataWriteCondition::Update(version.clone()),
                                    tenant,
                                )
                                .await
                            {
                                Ok(_) => continue,
                                Err(error) if is_conflict(&error) => continue,
                                Err(error) => return Err(error),
                            }
                        }
                        let source_obsolete = pending_source_obsolete(claim, current.as_ref());
                        if source_obsolete {
                            // CAS of this reservation prevents an old cleanup
                            // from releasing a retry rebound to a newer source.
                            match self
                                .write(
                                    &path,
                                    &json!({"state":"released"}),
                                    MetadataWriteCondition::Update(version.clone()),
                                    tenant,
                                )
                                .await
                            {
                                Ok(_) => continue,
                                Err(error) if is_conflict(&error) => continue,
                                Err(error) => return Err(error),
                            }
                        }
                        if claimant == id
                            && claim.get("operation") == proposed.get("operation")
                            && claim.get("sourceVersion") == proposed.get("sourceVersion")
                        {
                            // Matching retries share the same source CAS. At
                            // most one can commit; neither rolls back the other.
                            return Ok(TitleClaim {
                                path,
                                version: version.clone(),
                                document: claim.clone(),
                                acquired: options.idempotency_key.is_none(),
                            });
                        }
                    }
                    return Err(api(
                        409,
                        "title_reservation_pending",
                        "Dashboard title has an unfinished reservation whose source can still commit; retry the original request with its original idempotency key",
                        json!({"title":title,"dashboardId":claimant.map(|id|id.to_string())}),
                    ));
                }
                if state == Some("active") {
                    if claimant == Some(id)
                        && base.is_some_and(|stored| {
                            stored.document.get("title").and_then(Value::as_str) == Some(title)
                        })
                    {
                        return Ok(TitleClaim {
                            path,
                            version: version.clone(),
                            document: claim.clone(),
                            acquired: false,
                        });
                    }
                    let claimant = claimant.ok_or_else(|| corrupt("title reservation owner"))?;
                    match self.stored(claimant, tenant).await {
                        Ok(stored)
                            if !deleted(&stored.document)
                                && stored.document.get("title").and_then(Value::as_str)
                                    == Some(title) =>
                        {
                            return Err(api(
                                409,
                                "title_conflict",
                                "Dashboard title must be unique",
                                json!({"title":title}),
                            ));
                        }
                        Ok(_) => {}
                        Err(error) if is_not_found(&error) => {}
                        Err(error) => return Err(error),
                    }
                } else if state != Some("released") {
                    return Err(corrupt("title reservation state"));
                }
            }
            // Released and stale-active reservations still need the same
            // authoritative legacy check as an absent reservation.
            if self
                .legacy_title(title, tenant)
                .await?
                .is_some_and(|legacy_id| legacy_id != id)
            {
                return Err(api(
                    409,
                    "title_conflict",
                    "Dashboard title must be unique",
                    json!({"title":title}),
                ));
            }
            let condition = existing
                .map(|(_, version)| MetadataWriteCondition::Update(version))
                .unwrap_or(MetadataWriteCondition::Create);
            match self.write(&path, &proposed, condition, tenant).await {
                Ok(version) => {
                    return Ok(TitleClaim {
                        path,
                        version,
                        document: proposed,
                        acquired: options.idempotency_key.is_none(),
                    });
                }
                Err(error) => {
                    if let Some((ours, version)) = self.read(&path, tenant).await?
                        && ours.get("dashboardId") == proposed.get("dashboardId")
                        && ours.get("operation") == proposed.get("operation")
                        && ours.get("sourceVersion") == proposed.get("sourceVersion")
                        && matches!(
                            ours.get("state").and_then(Value::as_str),
                            Some("pending" | "active")
                        )
                    {
                        let acquired =
                            options.idempotency_key.is_none() && ours["state"] == "pending";
                        return Ok(TitleClaim {
                            path,
                            version,
                            document: ours,
                            acquired,
                        });
                    }
                    if is_conflict(&error) {
                        continue;
                    }
                    return Err(error);
                }
            }
        }
        Err(api(
            409,
            "title_contention",
            "Dashboard title changed repeatedly; retry with the same idempotency key",
            json!({"title":title}),
        ))
    }

    async fn activate_claim(&self, mut claim: TitleClaim, tenant: &Option<String>) {
        if claim.document.get("state").and_then(Value::as_str) == Some("active") {
            return;
        }
        claim.document["state"] = json!("active");
        // A failed activation retains the pending claim. Its committed dashboard
        // allows a subsequent claim/read to safely recover it.
        if let Err(error) = self
            .write(
                &claim.path,
                &claim.document,
                MetadataWriteCondition::Update(claim.version),
                tenant,
            )
            .await
            && !is_conflict(&error)
        {
            tracing::warn!(%error,"Dashboard saved; title reservation activation needs recovery");
        }
    }

    async fn release_claim(&self, claim: &TitleClaim, tenant: &Option<String>) {
        if claim.acquired {
            let released = json!({"state":"released"});
            if let Err(error) = self
                .write(
                    &claim.path,
                    &released,
                    MetadataWriteCondition::Update(claim.version.clone()),
                    tenant,
                )
                .await
                && !is_conflict(&error)
            {
                tracing::warn!(%error,"Dashboard title rollback needs recovery");
            }
        }
    }

    async fn release_owned_title(&self, claim: TitleClaim, tenant: &Option<String>) {
        // Exact reservation version prevents an old rename/delete cleanup from
        // releasing a newer rename-back claim on this same dashboard ID.
        let released = json!({"state":"released"});
        if let Err(error) = self
            .write(
                &claim.path,
                &released,
                MetadataWriteCondition::Update(claim.version),
                tenant,
            )
            .await
            && !is_conflict(&error)
        {
            tracing::warn!(%error,"Dashboard saved; obsolete title cleanup needs recovery");
        }
    }
}

fn api(status: u16, code: &'static str, message: &str, details: Value) -> DashboardError {
    DashboardError::api(status, code, message, details)
}
fn not_found() -> DashboardError {
    api(
        404,
        "dashboard_not_found",
        "Dashboard does not exist",
        json!({}),
    )
}
fn corrupt(what: &str) -> DashboardError {
    api(
        500,
        "dashboard_metadata_invalid",
        &format!("Invalid {what}"),
        json!({}),
    )
}
fn conflict(current: &str) -> DashboardError {
    api(
        412,
        "revision_conflict",
        "Dashboard changed; reload and retry",
        json!({"currentRevision":current}),
    )
}
fn is_conflict(error: &DashboardError) -> bool {
    matches!(
        error,
        DashboardError::Api {
            code: "storage_conflict",
            ..
        }
    )
}
fn is_not_found(error: &DashboardError) -> bool {
    matches!(error, DashboardError::Api { status: 404, .. })
}
fn storage_error(error: ConditionalMetadataError) -> DashboardError {
    match error {
        ConditionalMetadataError::Conflict => api(
            409,
            "storage_conflict",
            "Dashboard storage precondition failed",
            json!({}),
        ),
        ConditionalMetadataError::Unsupported(message) => {
            api(501, "conditional_storage_unsupported", &message, json!({}))
        }
        ConditionalMetadataError::Storage(error) => DashboardError::ObjectStorage(error),
    }
}
fn validate_scope(tenant: &Option<String>, owner: Option<&str>) -> Result<(), DashboardError> {
    for value in tenant.iter().map(String::as_str).chain(owner) {
        if value.is_empty() || value == "." || value == ".." || value.contains(['/', '\\', '\0']) {
            return Err(api(
                400,
                "invalid_dashboard_scope",
                "Invalid dashboard tenant or owner",
                json!({}),
            ));
        }
    }
    Ok(())
}
fn validate_options(options: &DashboardWriteOptions) -> Result<(), DashboardError> {
    if let Some(expected) = options.expected_revision.as_deref() {
        normalize_revision(expected)?;
    }

    if options
        .idempotency_key
        .as_ref()
        .is_some_and(|key| key.is_empty() || key.len() > 256)
    {
        return Err(api(
            400,
            "invalid_idempotency_key",
            "Idempotency key must contain 1 to 256 bytes",
            json!({}),
        ));
    }
    Ok(())
}
fn require_object(value: &Value) -> Result<(), DashboardError> {
    if !value.is_object() {
        return Err(api(
            400,
            "invalid_dashboard",
            "Dashboard must be an object",
            json!({}),
        ));
    }
    Ok(())
}
fn reject_internal(value: &Value) -> Result<(), DashboardError> {
    if value.as_object().is_some_and(|object| {
        object.keys().any(|key| {
            key.chars()
                .filter(|ch| *ch != '_' && *ch != '-')
                .flat_map(char::to_lowercase)
                .collect::<String>()
                == "parseabledashboard"
        })
    }) {
        return Err(api(
            400,
            "protected_dashboard_metadata",
            "Internal dashboard metadata cannot be supplied",
            json!({}),
        ));
    }
    Ok(())
}
fn scope_path(tenant: &Option<String>, suffix: &str) -> String {
    match tenant {
        Some(tenant) => format!("{tenant}/{USERS_ROOT_DIR}/{suffix}"),
        None => format!("{USERS_ROOT_DIR}/{suffix}"),
    }
}
fn dashboard_path(tenant: &Option<String>, owner: &str, id: Ulid) -> String {
    scope_path(tenant, &format!("{owner}/{DASHBOARDS_DIR}/{id}.json"))
}
fn locator_path(tenant: &Option<String>, id: Ulid) -> String {
    scope_path(tenant, &format!(".dashboard-locations/{id}.json"))
}
fn title_path(tenant: &Option<String>, title: &str) -> String {
    scope_path(
        tenant,
        &format!(".dashboard-titles/{}.json", fingerprint(&json!(title))),
    )
}
fn has_nonce(document: &Value, nonce: &str) -> bool {
    document
        .pointer("/_parseableDashboard/revision")
        .and_then(Value::as_str)
        == Some(nonce)
}
fn advance_nonce(document: &mut Value) {
    let nonce = Ulid::new().to_string();
    let content_revision = revision_with_nonce(document, Some(&nonce));
    if !document.get(INTERNAL).is_some_and(Value::is_object) {
        document[INTERNAL] = json!({});
    }
    document[INTERNAL]["revision"] = json!(nonce);
    document[INTERNAL]["contentRevision"] = json!(content_revision);
}

fn pending_source_obsolete(claim: &Value, current: Option<&StoredDashboard>) -> bool {
    current.is_some_and(|stored| deleted(&stored.document))
        || match claim.get("sourceVersion") {
            Some(Value::Null) => current.is_some(),
            Some(source) => {
                current
                    .map(|stored| metadata_version_json(&stored.version))
                    .as_ref()
                    != Some(source)
            }
            None => false,
        }
}

fn metadata_version_json(version: &MetadataVersion) -> Value {
    json!({"eTag":version.e_tag,"version":version.version})
}

fn fingerprint(value: &Value) -> String {
    // serde_json maps are ordered in this build. Explicit recursion also keeps
    // hashes stable if the preserve_order feature is enabled by another crate.
    fn canonical(value: &Value) -> Value {
        match value {
            Value::Object(object) => {
                let sorted: std::collections::BTreeMap<_, _> = object
                    .iter()
                    .map(|(key, value)| (key.clone(), canonical(value)))
                    .collect();
                serde_json::to_value(sorted).expect("JSON map serializes")
            }
            Value::Array(values) => Value::Array(values.iter().map(canonical).collect()),
            value => value.clone(),
        }
    }
    hex::encode(Sha256::digest(
        serde_json::to_vec(&canonical(value)).expect("JSON value serializes"),
    ))
}
fn revision(document: &Value) -> String {
    revision_with_nonce(
        document,
        document
            .pointer("/_parseableDashboard/revision")
            .and_then(Value::as_str),
    )
}
fn revision_with_nonce(document: &Value, nonce: Option<&str>) -> String {
    let mut content = document.clone();
    if let Some(object) = content.as_object_mut() {
        object.remove(INTERNAL);
        object.remove("revision");
    }
    // Hash the actual public content too: an older/external node can preserve
    // our nonce while changing a layout, and must still invalidate If-Match.
    fingerprint(&json!({"document":content,"nonce":nonce}))
}

fn public_document(document: &Value, revision: &str) -> Value {
    let mut public = document.clone();
    if let Some(object) = public.as_object_mut() {
        object.remove(INTERNAL);
        object.insert("revision".into(), json!(revision));
    }
    public
}
fn deleted(document: &Value) -> bool {
    document
        .pointer("/_parseableDashboard/tombstone")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}
fn title(document: &Value) -> Result<&str, DashboardError> {
    document
        .get("title")
        .and_then(Value::as_str)
        .filter(|title| !title.trim().is_empty())
        .ok_or_else(|| {
            api(
                400,
                "invalid_title",
                "Dashboard title must be a nonempty string",
                json!({}),
            )
        })
}
fn authorize(actor: &DashboardActor, document: &Value) -> Result<(), DashboardError> {
    if !actor.is_admin && document.get("author").and_then(Value::as_str) != Some(&actor.user_id) {
        return Err(api(
            403,
            "dashboard_forbidden",
            "Dashboard can only be changed by its owner or an administrator",
            json!({}),
        ));
    }
    Ok(())
}
/// Accept exactly one strong HTTP ETag, or the raw hexadecimal token returned
/// in legacy JSON bodies. ETag lists, weak validators and wildcards do not
/// identify one observed dashboard version and are rejected before replay/I/O.
fn normalize_revision(expected: &str) -> Result<&str, DashboardError> {
    let expected = expected.trim();
    if expected.starts_with('"') && expected.ends_with('"') && expected.len() >= 2 {
        let token = &expected[1..expected.len() - 1];
        if token
            .bytes()
            .all(|byte| byte == 0x21 || (0x23..=0x7e).contains(&byte))
        {
            return Ok(token);
        }
    } else if expected.len() == 64 && expected.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Ok(expected);
    }
    Err(api(
        400,
        "invalid_dashboard_revision",
        "Expected exactly one strong quoted ETag or raw dashboard revision hash",
        json!({}),
    ))
}
fn check_revision(options: &DashboardWriteOptions, actual: &str) -> Result<(), DashboardError> {
    if let Some(expected) = options.expected_revision.as_deref()
        && normalize_revision(expected)? != actual
    {
        return Err(conflict(actual));
    }
    Ok(())
}

fn receipt_key(actor: &DashboardActor, key: &str) -> String {
    fingerprint(&json!([actor.user_id, key]))
}
fn replay(
    document: &Value,
    current_revision: &str,
    actor: &DashboardActor,
    options: &DashboardWriteOptions,
    request_hash: &str,
    deleted_ok: bool,
) -> Result<Option<Value>, DashboardError> {
    let Some(key) = &options.idempotency_key else {
        return Ok(None);
    };
    let key = receipt_key(actor, key);
    let create = document
        .pointer("/_parseableDashboard/createReceipt")
        .filter(|receipt| !receipt.is_null());
    let recent = document
        .pointer("/_parseableDashboard/receipts")
        .and_then(Value::as_array);
    for receipt in create.into_iter().chain(recent.into_iter().flatten()) {
        if receipt.get("key").and_then(Value::as_str) != Some(&key) {
            continue;
        }
        if receipt.get("requestHash").and_then(Value::as_str) != Some(request_hash) {
            return Err(api(
                409,
                "idempotency_conflict",
                "Idempotency key was already used for different arguments",
                json!({}),
            ));
        }
        if deleted(document) {
            let details = json!({"dashboardId":document.get("dashboardId"),"revision":current_revision,"appliedRevision":receipt.get("revision"),"replayed":true,"deleted":true});
            if !deleted_ok {
                return Err(api(
                    410,
                    "resource_deleted",
                    "The original operation was applied, but its dashboard has since been deleted",
                    details,
                ));
            }
            return Ok(Some(details));
        }
        return Ok(Some(
            json!({"dashboard":public_document(document,current_revision),"revision":current_revision,"appliedRevision":receipt.get("revision"),"replayed":true,"validation":{"valid":true,"errors":[],"warnings":[]},"diff":[]}),
        ));
    }
    Ok(None)
}
fn stamp(
    document: &mut Value,
    next_revision: &str,
    tombstone: bool,
    actor: &DashboardActor,
    options: &DashboardWriteOptions,
    request_hash: &str,
    create: bool,
) {
    let applied_revision = revision_with_nonce(document, Some(next_revision));
    let mut create_receipt = document
        .pointer("/_parseableDashboard/createReceipt")
        .cloned()
        .unwrap_or(Value::Null);
    let mut receipts = document
        .pointer("/_parseableDashboard/receipts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if let Some(key) = &options.idempotency_key {
        let receipt = json!({"key":receipt_key(actor,key),"requestHash":request_hash,"revision":applied_revision});
        if create {
            create_receipt = receipt;
        } else {
            receipts.push(receipt);
            if receipts.len() > RECEIPT_LIMIT {
                receipts.drain(..receipts.len() - RECEIPT_LIMIT);
            }
        }
    }
    document[INTERNAL] = json!({"revision":next_revision,"contentRevision":applied_revision,"tombstone":tombstone,"createReceipt":create_receipt,"receipts":receipts});
}
fn compact_tombstone(base: &Value) -> Value {
    let mut compact = serde_json::Map::new();
    for field in [
        "author",
        "dashboardId",
        "tenantId",
        "title",
        "version",
        "created",
        "modified",
        INTERNAL,
    ] {
        if let Some(value) = base.get(field) {
            compact.insert(field.to_owned(), value.clone());
        }
    }
    Value::Object(compact)
}

fn mutation_request(mutation: &DashboardMutation) -> Result<Value, DashboardError> {
    Ok(match mutation {
        DashboardMutation::Replace(value) => json!({"operation":"replace","document":value}),
        DashboardMutation::Metadata(metadata) => {
            json!({"operation":"metadata","metadata":metadata})
        }
        DashboardMutation::AddTile(tile) => json!({"operation":"addTile","tile":tile}),
        DashboardMutation::Patch(operations) => {
            json!({"operation":"patch","operations":serde_json::to_value(operations)?})
        }
    })
}
fn apply_metadata(
    base: &Value,
    metadata: &HashMap<String, String>,
) -> Result<Value, DashboardError> {
    let mut candidate = base.clone();
    for (key, value) in metadata {
        match key.as_str() {
            "isFavorite" => {
                candidate["isFavorite"] = json!(match value.as_str() {
                    "true" => true,
                    "false" => false,
                    _ =>
                        return Err(api(
                            400,
                            "invalid_favorite",
                            "isFavorite must be true or false",
                            json!({})
                        )),
                });
            }
            "tags" => {
                candidate["tags"] = json!(
                    value
                        .split(',')
                        .map(str::trim)
                        .filter(|tag| !tag.is_empty())
                        .collect::<Vec<_>>()
                );
            }
            "renameTo" => {
                candidate["title"] = json!(value.trim());
            }
            _ => {
                return Err(api(
                    400,
                    "invalid_metadata_field",
                    "Unsupported dashboard metadata parameter",
                    json!({"field":key}),
                ));
            }
        }
    }
    Ok(candidate)
}
fn add_tile(base: &Value, tile: &Value) -> Result<Value, DashboardError> {
    require_object(tile)?;
    let id = tile
        .get("tile_id")
        .and_then(Value::as_str)
        .filter(|id| Ulid::from_string(id).is_ok())
        .ok_or_else(|| {
            api(
                400,
                "invalid_tile_id",
                "Tile ID must be a valid ULID",
                json!({}),
            )
        })?;
    let mut candidate = base.clone();
    if candidate.get("tiles").is_none_or(Value::is_null) {
        candidate["tiles"] = json!([]);
    }
    let tiles = candidate
        .get_mut("tiles")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| {
            api(
                400,
                "invalid_tiles",
                "Dashboard tiles must be an array",
                json!({}),
            )
        })?;
    if tiles
        .iter()
        .any(|tile| tile.get("tile_id").and_then(Value::as_str) == Some(id))
    {
        return Err(api(
            409,
            "tile_conflict",
            "Tile already exists",
            json!({"tileId":id}),
        ));
    }
    tiles.push(tile.clone());
    Ok(candidate)
}
fn apply_patch_candidate(
    base: &Value,
    operations: &[DashboardOperation],
) -> Result<Value, DashboardError> {
    apply_patch(base, operations).map_err(|error| {
        api(
            400,
            "invalid_dashboard_patch",
            &error.to_string(),
            serde_json::to_value(&error).unwrap_or(Value::Null),
        )
    })
}
fn validate_candidate(candidate: &Value, base: Option<&Value>) -> Result<Value, DashboardError> {
    let report = validate_dashboard(candidate, base);
    let value = serde_json::to_value(&report)?;
    if !report.valid {
        return Err(api(
            422,
            "dashboard_validation_failed",
            "Dashboard configuration is invalid",
            value,
        ));
    }
    Ok(value)
}
fn document_diff(base: &Value, candidate: &Value) -> Value {
    fn walk(base: &Value, candidate: &Value, path: &str, changes: &mut Vec<Value>) {
        if base == candidate {
            return;
        }
        if let (Some(left), Some(right)) = (base.as_object(), candidate.as_object()) {
            let keys: std::collections::BTreeSet<_> = left.keys().chain(right.keys()).collect();
            for key in keys {
                let pointer = format!("{path}/{}", key.replace('~', "~0").replace('/', "~1"));
                match (left.get(key), right.get(key)) {
                    (Some(before), Some(after)) => walk(before, after, &pointer, changes),
                    (None, Some(after)) => {
                        changes.push(json!({"op":"add","path":pointer,"value":after}))
                    }
                    (Some(before), None) => {
                        changes.push(json!({"op":"remove","path":pointer,"previous":before}))
                    }
                    _ => {}
                }
            }
        } else {
            changes.push(json!({"op":"replace","path":path,"previous":base,"value":candidate}));
        }
    }
    let mut changes = Vec::new();
    walk(base, candidate, "", &mut changes);
    json!(changes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        metastore::metastores::object_store_metastore::ObjectStoreMetastore, storage::LocalFS,
    };

    use crate::{
        parseable::LogStream,
        storage::{ObjectStorage, ObjectStorageError},
    };
    use datafusion::datasource::listing::ListingTableUrl;
    use object_store::{ListResult, ObjectMeta, buffered::BufReader};
    use relative_path::{RelativePath, RelativePathBuf};
    use std::{
        collections::HashSet,
        path::{Path, PathBuf},
        sync::atomic::{AtomicBool, AtomicUsize, Ordering},
    };

    /// Pause one node immediately before its conditional document write while
    /// a second independent node can continue to read/write the shared store.
    #[derive(Debug, Clone, Copy)]
    enum FaultKind {
        BeforeStorage,
        AfterConflict,
        AfterStorage,
        AfterConcurrentEdit,
    }
    #[derive(Debug)]
    struct WriteFault {
        path_contains: String,
        kind: FaultKind,
    }

    #[derive(Debug)]
    struct PausedStorage {
        inner: LocalFS,
        pause_path: String,
        armed: AtomicBool,
        scans: AtomicUsize,
        fault: std::sync::Mutex<Option<WriteFault>>,
        entered: tokio::sync::Notify,
        released: tokio::sync::Notify,
    }
    impl PausedStorage {
        fn new(root: &Path, pause_path: String) -> Self {
            Self {
                inner: LocalFS::new(root.to_path_buf()),
                pause_path,
                armed: AtomicBool::new(true),
                scans: AtomicUsize::new(0),
                fault: Default::default(),
                entered: Default::default(),
                released: Default::default(),
            }
        }
    }
    #[async_trait::async_trait]
    impl ObjectStorage for PausedStorage {
        async fn get_metadata_versioned(
            &self,
            path: &RelativePath,
            tenant: &Option<String>,
        ) -> Result<Option<VersionedMetadata>, ConditionalMetadataError> {
            self.inner.get_metadata_versioned(path, tenant).await
        }
        async fn put_metadata_conditional(
            &self,
            path: &RelativePath,
            bytes: Bytes,
            condition: MetadataWriteCondition,
            tenant: &Option<String>,
        ) -> Result<MetadataVersion, ConditionalMetadataError> {
            if (path.as_str() == self.pause_path
                || (self.pause_path.is_empty() && path.as_str().contains("/dashboards/")))
                && self.armed.swap(false, Ordering::SeqCst)
            {
                self.entered.notify_one();
                self.released.notified().await;
            }
            let fault = {
                let mut armed = self.fault.lock().unwrap();
                if armed
                    .as_ref()
                    .is_some_and(|fault| path.as_str().contains(&fault.path_contains))
                {
                    armed.take()
                } else {
                    None
                }
            };
            if matches!(
                fault.as_ref().map(|fault| fault.kind),
                Some(FaultKind::BeforeStorage)
            ) {
                return Err(ObjectStorageError::Custom(
                    "injected precommit transport error".into(),
                )
                .into());
            }
            let version = self
                .inner
                .put_metadata_conditional(path, bytes, condition, tenant)
                .await?;
            if let Some(fault) = fault {
                if matches!(fault.kind, FaultKind::AfterConcurrentEdit) {
                    let current = self
                        .inner
                        .get_metadata_versioned(path, tenant)
                        .await?
                        .unwrap();
                    let mut document: Value = serde_json::from_slice(&current.bytes).unwrap();
                    document["anotherWriterChangedThis"] = json!(true);
                    advance_nonce(&mut document);
                    self.inner
                        .put_metadata_conditional(
                            path,
                            Bytes::from(serde_json::to_vec(&document).unwrap()),
                            MetadataWriteCondition::Update(current.version),
                            tenant,
                        )
                        .await?;
                }
                return Err(match fault.kind {
                    FaultKind::AfterConflict => ConditionalMetadataError::Conflict,
                    _ => ObjectStorageError::Custom("injected postcommit transport error".into())
                        .into(),
                });
            }
            Ok(version)
        }
        async fn get_buffered_reader(
            &self,
            path: &RelativePath,
            tenant_id: &Option<String>,
        ) -> Result<BufReader, ObjectStorageError> {
            self.inner.get_buffered_reader(path, tenant_id).await
        }
        async fn head(
            &self,
            path: &RelativePath,
            tenant_id: &Option<String>,
        ) -> Result<ObjectMeta, ObjectStorageError> {
            self.inner.head(path, tenant_id).await
        }
        async fn parallel_chunked_download(
            &self,
            path: &RelativePath,
            tenant_id: &Option<String>,
            write_path: PathBuf,
        ) -> Result<(), ObjectStorageError> {
            self.inner
                .parallel_chunked_download(path, tenant_id, write_path)
                .await
        }
        async fn get_object(
            &self,
            path: &RelativePath,
            tenant_id: &Option<String>,
        ) -> Result<Bytes, ObjectStorageError> {
            self.inner.get_object(path, tenant_id).await
        }
        async fn get_object_ranged(
            &self,
            path: &RelativePath,
            tenant_id: &Option<String>,
        ) -> Result<Bytes, ObjectStorageError> {
            self.inner.get_object_ranged(path, tenant_id).await
        }
        async fn get_objects(
            &self,
            base_path: Option<&RelativePath>,
            filter_fun: Box<dyn Fn(String) -> bool + Send>,
            tenant_id: &Option<String>,
        ) -> Result<Vec<Bytes>, ObjectStorageError> {
            self.scans.fetch_add(1, Ordering::SeqCst);
            self.inner
                .get_objects(base_path, filter_fun, tenant_id)
                .await
        }
        async fn upload_multipart(
            &self,
            key: &RelativePath,
            path: &Path,
            tenant_id: &Option<String>,
        ) -> Result<(), ObjectStorageError> {
            self.inner.upload_multipart(key, path, tenant_id).await
        }
        async fn put_object(
            &self,
            path: &RelativePath,
            resource: Bytes,
            tenant_id: &Option<String>,
        ) -> Result<(), ObjectStorageError> {
            self.inner.put_object(path, resource, tenant_id).await
        }
        async fn delete_prefix(
            &self,
            path: &RelativePath,
            tenant_id: &Option<String>,
        ) -> Result<(), ObjectStorageError> {
            self.inner.delete_prefix(path, tenant_id).await
        }
        async fn check(&self, tenant_id: &Option<String>) -> Result<(), ObjectStorageError> {
            self.inner.check(tenant_id).await
        }
        async fn delete_stream(
            &self,
            stream_name: &str,
            tenant_id: &Option<String>,
        ) -> Result<(), ObjectStorageError> {
            self.inner.delete_stream(stream_name, tenant_id).await
        }
        async fn list_streams(&self) -> Result<HashSet<LogStream>, ObjectStorageError> {
            self.inner.list_streams().await
        }
        async fn list_old_streams(&self) -> Result<HashSet<LogStream>, ObjectStorageError> {
            self.inner.list_old_streams().await
        }
        async fn list_dirs(
            &self,
            tenant_id: &Option<String>,
        ) -> Result<Vec<String>, ObjectStorageError> {
            self.inner.list_dirs(tenant_id).await
        }
        async fn list_dirs_relative(
            &self,
            relative_path: &RelativePath,
            tenant_id: &Option<String>,
        ) -> Result<Vec<String>, ObjectStorageError> {
            self.inner
                .list_dirs_relative(relative_path, tenant_id)
                .await
        }
        async fn list_dates(
            &self,
            stream_name: &str,
            tenant_id: &Option<String>,
        ) -> Result<Vec<String>, ObjectStorageError> {
            self.inner.list_dates(stream_name, tenant_id).await
        }
        async fn list_hours(
            &self,
            stream_name: &str,
            date: &str,
            tenant_id: &Option<String>,
        ) -> Result<Vec<String>, ObjectStorageError> {
            self.inner.list_hours(stream_name, date, tenant_id).await
        }
        async fn list_minutes(
            &self,
            stream_name: &str,
            date: &str,
            hour: &str,
            tenant_id: &Option<String>,
        ) -> Result<Vec<String>, ObjectStorageError> {
            self.inner
                .list_minutes(stream_name, date, hour, tenant_id)
                .await
        }
        async fn upload_file(
            &self,
            key: &str,
            path: &Path,
            tenant_id: &Option<String>,
        ) -> Result<(), ObjectStorageError> {
            self.inner.upload_file(key, path, tenant_id).await
        }
        async fn delete_object(
            &self,
            path: &RelativePath,
            tenant_id: &Option<String>,
        ) -> Result<(), ObjectStorageError> {
            self.inner.delete_object(path, tenant_id).await
        }
        async fn get_ingestor_meta_file_paths(
            &self,
            tenant_id: &Option<String>,
        ) -> Result<Vec<RelativePathBuf>, ObjectStorageError> {
            self.inner.get_ingestor_meta_file_paths(tenant_id).await
        }
        async fn try_delete_node_meta(
            &self,
            node_filename: String,
            tenant_id: &Option<String>,
        ) -> Result<(), ObjectStorageError> {
            self.inner
                .try_delete_node_meta(node_filename, tenant_id)
                .await
        }
        fn query_prefixes(&self, prefixes: Vec<String>) -> Vec<ListingTableUrl> {
            self.inner.query_prefixes(prefixes)
        }
        fn absolute_url(&self, prefix: &RelativePath) -> object_store::path::Path {
            self.inner.absolute_url(prefix)
        }
        fn store_url(&self) -> url::Url {
            self.inner.store_url()
        }
        async fn list_with_delimiter(
            &self,
            prefix: Option<object_store::path::Path>,
        ) -> Result<ListResult, ObjectStorageError> {
            self.inner.list_with_delimiter(prefix).await
        }
        fn get_bucket_name(&self) -> String {
            self.inner.get_bucket_name()
        }
    }

    fn actor() -> DashboardActor {
        DashboardActor {
            user_id: "owner-hash".into(),
            is_admin: false,
        }
    }
    fn services(root: &std::path::Path) -> (Arc<DashboardService>, Arc<DashboardService>) {
        let make = || {
            Arc::new(DashboardService::new(Arc::new(ObjectStoreMetastore {
                storage: Arc::new(LocalFS::new(root.to_path_buf())),
            })))
        };
        (make(), make())
    }
    fn options(revision: &str, key: Option<&str>) -> DashboardWriteOptions {
        DashboardWriteOptions {
            expected_revision: Some(revision.into()),
            idempotency_key: key.map(str::to_owned),
            dry_run: false,
        }
    }
    fn id(result: &Value) -> Ulid {
        Ulid::from_string(result["dashboard"]["dashboardId"].as_str().unwrap()).unwrap()
    }
    fn revision_of(result: &Value) -> &str {
        result["revision"].as_str().unwrap()
    }
    fn metadata(value: bool) -> DashboardMutation {
        DashboardMutation::Metadata(HashMap::from([("isFavorite".into(), value.to_string())]))
    }
    fn operation(path: &str, value: Value) -> DashboardOperation {
        serde_json::from_value(
            json!({"op":"add","target":{"type":"dashboard"},"path":path,"value":value}),
        )
        .unwrap()
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn legacy_replacement_without_revision_uses_cas_and_cannot_lose_a_concurrent_edit() {
        let directory = tempfile::tempdir().unwrap();
        let (first, second) = services(directory.path());
        let owner = actor();
        let created = first
            .create_json(
                &owner,
                &None,
                json!({"title":"Legacy PUT"}),
                &Default::default(),
            )
            .await
            .unwrap();
        let id = id(&created);
        let paused = Arc::new(PausedStorage::new(
            directory.path(),
            dashboard_path(&None, &owner.user_id, id),
        ));
        let legacy = DashboardService::new(Arc::new(ObjectStoreMetastore {
            storage: paused.clone(),
        }));
        let caller = tokio::spawn({
            let owner = owner.clone();
            async move {
                legacy
                    .mutate_legacy_json(
                        &owner,
                        id,
                        &None,
                        DashboardMutation::Replace(json!({"title":"Legacy PUT","legacy":true})),
                        &Default::default(),
                    )
                    .await
            }
        });
        tokio::time::timeout(std::time::Duration::from_secs(2), paused.entered.notified())
            .await
            .unwrap();
        second
            .mutate_json(&owner, id, &None, metadata(true), &Default::default())
            .await
            .unwrap();
        paused.released.notify_one();
        assert!(matches!(
            caller.await.unwrap(),
            Err(DashboardError::Api { status: 412, .. })
        ));
        let current = first.get_json(id, &None).await.unwrap();
        assert_eq!(current["isFavorite"], true);
        assert!(current.get("legacy").is_none());
        let result = first
            .mutate_legacy_json(
                &owner,
                id,
                &None,
                DashboardMutation::Replace(json!({"title":"Legacy PUT","legacy":true})),
                &Default::default(),
            )
            .await
            .unwrap();
        assert_eq!(result["dashboard"]["legacy"], true);
    }

    #[tokio::test]
    async fn listing_skips_corrupt_json_and_invalid_legacy_shapes() {
        let directory = tempfile::tempdir().unwrap();
        let (first, _) = services(directory.path());
        let owner = actor();
        first
            .create_json(
                &owner,
                &None,
                json!({"title":"Valid","tags":["healthy"]}),
                &Default::default(),
            )
            .await
            .unwrap();
        let storage = LocalFS::new(directory.path().to_path_buf());
        for bytes in ["{", "[]", "{\"title\":1}"] {
            let path = dashboard_path(&None, &owner.user_id, Ulid::new());
            storage
                .put_object(RelativePath::new(&path), Bytes::from(bytes), &None)
                .await
                .unwrap();
        }
        let rows = first.list_json(&None).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["tags"], json!(["healthy"]));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn independent_nodes_same_revision_have_exactly_one_winner() {
        let directory = tempfile::tempdir().unwrap();
        let (first, second) = services(directory.path());
        let owner = actor();
        let tenant = Some("tenant".into());
        let created = first
            .create_json(
                &owner,
                &tenant,
                json!({"title":"Concurrent"}),
                &Default::default(),
            )
            .await
            .unwrap();
        let id = id(&created);
        let observed = revision_of(&created).to_owned();
        let barrier = Arc::new(tokio::sync::Barrier::new(24));
        let mut tasks = tokio::task::JoinSet::new();
        for index in 0..24 {
            let service = if index % 2 == 0 {
                first.clone()
            } else {
                second.clone()
            };
            let owner = owner.clone();
            let tenant = tenant.clone();
            let observed = observed.clone();
            let barrier = barrier.clone();
            tasks.spawn(async move {
                barrier.wait().await;
                service
                    .mutate_json(
                        &owner,
                        id,
                        &tenant,
                        metadata(index % 2 == 0),
                        &options(&observed, None),
                    )
                    .await
            });
        }
        let mut wins = 0;
        while let Some(result) = tasks.join_next().await {
            match result.unwrap() {
                Ok(_) => wins += 1,
                Err(DashboardError::Api { status: 412, .. }) => {}
                Err(error) => panic!("unexpected error: {error}"),
            }
        }
        assert_eq!(wins, 1);
        assert_ne!(
            first.get_json(id, &tenant).await.unwrap()["revision"],
            observed
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn agents_retry_disjoint_changes_without_losing_fields() {
        let directory = tempfile::tempdir().unwrap();
        let (first, second) = services(directory.path());
        let owner = actor();
        let created = first
            .create_json(
                &owner,
                &None,
                json!({"title":"Merge","opaque":{"nested":[1,2,3]}}),
                &Default::default(),
            )
            .await
            .unwrap();
        let id = id(&created);
        let mut tasks = tokio::task::JoinSet::new();
        for index in 0..8 {
            let service = if index % 2 == 0 {
                first.clone()
            } else {
                second.clone()
            };
            let owner = owner.clone();
            tasks.spawn(async move {
                for _ in 0..8 {
                    let current = service.get_json(id, &None).await.unwrap();
                    let key = format!("agent-{index}");
                    let mutation = DashboardMutation::Patch(vec![operation(
                        &format!("/agent{index}"),
                        json!(index),
                    )]);
                    match service
                        .mutate_json(
                            &owner,
                            id,
                            &None,
                            mutation,
                            &options(current["revision"].as_str().unwrap(), Some(&key)),
                        )
                        .await
                    {
                        Ok(_) => return,
                        Err(DashboardError::Api { status: 412, .. }) => {
                            tokio::task::yield_now().await
                        }
                        Err(error) => panic!("unexpected retry error: {error}"),
                    }
                }
                panic!("exhausted bounded retries");
            });
        }
        while let Some(result) = tasks.join_next().await {
            result.unwrap();
        }
        let final_document = second.get_json(id, &None).await.unwrap();
        for index in 0..8 {
            assert_eq!(final_document[format!("agent{index}")], json!(index));
        }
        assert_eq!(final_document["opaque"], json!({"nested":[1,2,3]}));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn legacy_delta_adds_rebase_without_losing_tiles() {
        let directory = tempfile::tempdir().unwrap();
        let (first, second) = services(directory.path());
        let owner = actor();
        let created = first
            .create_json(&owner, &None, json!({"title":"Tiles"}), &Default::default())
            .await
            .unwrap();
        let id = id(&created);
        let mut tasks = tokio::task::JoinSet::new();
        for index in 0..8 {
            let service = if index % 2 == 0 {
                first.clone()
            } else {
                second.clone()
            };
            let owner = owner.clone();
            tasks.spawn(async move {
                let tile=json!({"tile_id":Ulid::new().to_string(),"name":format!("Tile {index}"),"tileType":"code","chartType":"table","chartQuery":"SELECT 1","dbName":"logs"});
                service.mutate_json(&owner,id,&None,DashboardMutation::AddTile(tile),&Default::default()).await.unwrap();
            });
        }
        while let Some(result) = tasks.join_next().await {
            result.unwrap();
        }
        assert_eq!(
            second.get_json(id, &None).await.unwrap()["tiles"]
                .as_array()
                .unwrap()
                .len(),
            8
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn tombstone_and_patch_cannot_both_commit_from_one_revision() {
        let directory = tempfile::tempdir().unwrap();
        let (first, second) = services(directory.path());
        let owner = actor();
        let created = first
            .create_json(
                &owner,
                &None,
                json!({"title":"Delete race"}),
                &Default::default(),
            )
            .await
            .unwrap();
        let id = id(&created);
        let opts = options(revision_of(&created), None);
        let (removed, changed) = tokio::join!(
            first.delete_json(&owner, id, &None, &opts),
            second.mutate_json(
                &owner,
                id,
                &None,
                DashboardMutation::Patch(vec![operation("/extra", json!(true))]),
                &opts
            )
        );
        assert_eq!(
            usize::from(removed.is_ok()) + usize::from(changed.is_ok()),
            1
        );
        if removed.is_ok() {
            assert!(matches!(
                second.get_json(id, &None).await,
                Err(DashboardError::Api { status: 404, .. })
            ));
            assert!(second.list_json(&None).await.unwrap().is_empty());
            second
                .create_json(
                    &owner,
                    &None,
                    json!({"title":"Delete race"}),
                    &Default::default(),
                )
                .await
                .unwrap();
        } else {
            assert_eq!(second.get_json(id, &None).await.unwrap()["extra"], true);
        }
    }

    #[tokio::test]
    async fn owner_tenant_extensions_and_full_replacement_revision_are_enforced() {
        let directory = tempfile::tempdir().unwrap();
        let (first, second) = services(directory.path());
        let owner = actor();
        let tenant = Some("trusted".into());
        let created=first.create_json(&owner,&tenant,json!({"title":"Ownership","author":"forged","tenantId":"other","custom":{"unknown":[1,null,{"x":true}]}}),&Default::default()).await.unwrap();
        let id = id(&created);
        assert_eq!(created["dashboard"]["author"], owner.user_id);
        assert_eq!(created["dashboard"]["tenantId"], "trusted");
        assert!(matches!(
            second.get_json(id, &Some("other".into())).await,
            Err(DashboardError::Api { status: 404, .. })
        ));
        let intruder = DashboardActor {
            user_id: "intruder".into(),
            is_admin: false,
        };
        assert!(matches!(
            second
                .mutate_json(&intruder, id, &tenant, metadata(true), &Default::default())
                .await,
            Err(DashboardError::Api { status: 403, .. })
        ));
        assert!(matches!(
            first
                .mutate_json(
                    &owner,
                    id,
                    &tenant,
                    DashboardMutation::Replace(json!({"title":"Blind"})),
                    &Default::default()
                )
                .await,
            Err(DashboardError::Api { status: 428, .. })
        ));
        let admin = DashboardActor {
            user_id: "admin".into(),
            is_admin: true,
        };
        let mut replacement = created["dashboard"].clone();
        replacement["author"] = json!("admin");
        replacement["tenantId"] = json!("forged");
        replacement["title"] = json!("Admin rename");
        let changed = second
            .mutate_json(
                &admin,
                id,
                &tenant,
                DashboardMutation::Replace(replacement),
                &Default::default(),
            )
            .await
            .unwrap();
        assert_eq!(changed["dashboard"]["author"], owner.user_id);
        assert_eq!(changed["dashboard"]["tenantId"], "trusted");
        assert_eq!(
            changed["dashboard"]["custom"],
            created["dashboard"]["custom"]
        );
        assert!(changed["dashboard"].get(INTERNAL).is_none());
        assert_eq!(second.list_json(&tenant).await.unwrap().len(), 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn durable_create_and_mutation_receipts_replay_across_nodes() {
        let directory = tempfile::tempdir().unwrap();
        let (first, second) = services(directory.path());
        let owner = actor();
        let create_options = DashboardWriteOptions {
            idempotency_key: Some("create-once".into()),
            ..Default::default()
        };
        let (one, two) = tokio::join!(
            first.create_json(&owner, &None, json!({"title":"Once"}), &create_options),
            second.create_json(&owner, &None, json!({"title":"Once"}), &create_options)
        );
        let one = one.unwrap();
        let two = two.unwrap();
        assert_eq!(id(&one), id(&two));
        assert_eq!(one["revision"], two["revision"]);
        assert_eq!(second.list_json(&None).await.unwrap().len(), 1);
        let id = id(&one);
        let opts = options(revision_of(&one), Some("favorite-once"));
        let changed = first
            .mutate_json(&owner, id, &None, metadata(true), &opts)
            .await
            .unwrap();
        let replayed = second
            .mutate_json(&owner, id, &None, metadata(true), &opts)
            .await
            .unwrap();
        assert_eq!(changed["revision"], replayed["revision"]);
        assert_eq!(replayed["replayed"], true);
        assert_eq!(replayed["appliedRevision"], changed["revision"]);
        assert!(matches!(
            second
                .mutate_json(&owner, id, &None, metadata(false), &opts)
                .await,
            Err(DashboardError::Api {
                status: 409,
                code: "idempotency_conflict",
                ..
            })
        ));
        // Eviction never replays the old request against a newer base.
        for index in 0..=RECEIPT_LIMIT {
            let current = first.get_json(id, &None).await.unwrap();
            let key = format!("receipt-{index}");
            first
                .mutate_json(
                    &owner,
                    id,
                    &None,
                    metadata(index % 2 == 0),
                    &options(current["revision"].as_str().unwrap(), Some(&key)),
                )
                .await
                .unwrap();
        }
        assert!(matches!(
            second
                .mutate_json(&owner, id, &None, metadata(true), &opts)
                .await,
            Err(DashboardError::Api { status: 412, .. })
        ));
        let stored = first.stored(id, &None).await.unwrap();
        assert_eq!(
            stored.document[INTERNAL]["receipts"]
                .as_array()
                .unwrap()
                .len(),
            RECEIPT_LIMIT
        );
    }

    #[tokio::test]
    async fn pending_title_claim_recovers_only_original_idempotent_operation() {
        let directory = tempfile::tempdir().unwrap();
        let (first, second) = services(directory.path());
        let owner = actor();
        let request = json!({"title":"Interrupted"});
        let opts = DashboardWriteOptions {
            idempotency_key: Some("original-create".into()),
            ..Default::default()
        };
        let digest = Sha256::digest(
            serde_json::to_vec(&json!([Value::Null, owner.user_id, "original-create"])).unwrap(),
        );
        let planned_id = Ulid::from_bytes(digest[..16].try_into().unwrap());
        let request_hash = fingerprint(&json!({"operation":"create","document":request}));
        first
            .claim_title(
                "Interrupted",
                planned_id,
                None,
                &owner,
                &opts,
                &request_hash,
                &None,
            )
            .await
            .unwrap();
        assert!(matches!(
            second
                .create_json(&owner, &None, request.clone(), &Default::default())
                .await,
            Err(DashboardError::Api {
                code: "title_reservation_pending",
                ..
            })
        ));
        let recovered = second
            .create_json(&owner, &None, request, &opts)
            .await
            .unwrap();
        assert_eq!(id(&recovered), planned_id);
        assert!(matches!(
            first
                .create_json(
                    &owner,
                    &None,
                    json!({"title":"Interrupted"}),
                    &Default::default()
                )
                .await,
            Err(DashboardError::Api {
                code: "title_conflict",
                ..
            })
        ));
    }

    #[tokio::test]
    async fn dry_run_invalid_batches_and_reserved_fields_never_persist() {
        let directory = tempfile::tempdir().unwrap();
        let (first, second) = services(directory.path());
        let owner = actor();
        let created = first
            .create_json(
                &owner,
                &None,
                json!({"title":"Preview","extra":"before"}),
                &Default::default(),
            )
            .await
            .unwrap();
        let id = id(&created);
        let preview = DashboardWriteOptions {
            dry_run: true,
            ..options(revision_of(&created), None)
        };
        let changed = first
            .mutate_json(
                &owner,
                id,
                &None,
                DashboardMutation::Patch(vec![operation("/extra", json!("after"))]),
                &preview,
            )
            .await
            .unwrap();
        assert_eq!(changed["dashboard"]["extra"], "after");
        assert_eq!(second.get_json(id, &None).await.unwrap()["extra"], "before");
        assert!(
            first
                .mutate_json(
                    &owner,
                    id,
                    &None,
                    DashboardMutation::Patch(vec![
                        operation("/extra", json!("after")),
                        operation("/author", json!("attacker"))
                    ]),
                    &options(revision_of(&created), None)
                )
                .await
                .is_err()
        );
        assert_eq!(second.get_json(id, &None).await.unwrap()["extra"], "before");
        assert!(
            first
                .create_json(
                    &owner,
                    &None,
                    json!({"title":"Hidden",INTERNAL:{"tombstone":false}}),
                    &Default::default()
                )
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn preserved_nonce_cannot_hide_an_external_content_change() {
        let directory = tempfile::tempdir().unwrap();
        let (first, second) = services(directory.path());
        let owner = actor();
        let created = first
            .create_json(
                &owner,
                &None,
                json!({"title":"External","layoutExtra":{"x":1}}),
                &Default::default(),
            )
            .await
            .unwrap();
        let id = id(&created);
        let stored = first.stored(id, &None).await.unwrap();
        let nonce = stored.document[INTERNAL]["revision"].clone();
        let mut external = stored.document;
        external["layoutExtra"]["x"] = json!(9);
        let storage = LocalFS::new(directory.path().to_path_buf());
        crate::storage::ObjectStorage::put_object(
            &storage,
            relative_path::RelativePath::new(&stored.path),
            Bytes::from(serde_json::to_vec(&external).unwrap()),
            &None,
        )
        .await
        .unwrap();
        let current = second.get_json(id, &None).await.unwrap();
        assert_ne!(current["revision"], created["revision"]);
        assert_eq!(external[INTERNAL]["revision"], nonce);
        assert_eq!(
            second.list_json(&None).await.unwrap()[0]["revision"],
            current["revision"]
        );
        assert!(matches!(
            first
                .mutate_json(
                    &owner,
                    id,
                    &None,
                    metadata(true),
                    &options(revision_of(&created), None)
                )
                .await,
            Err(DashboardError::Api { status: 412, .. })
        ));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_blocked_dashboard_writer_does_not_block_other_dashboards() {
        let directory = tempfile::tempdir().unwrap();
        let (first, second) = services(directory.path());
        let owner = actor();
        let a = first
            .create_json(&owner, &None, json!({"title":"Held"}), &Default::default())
            .await
            .unwrap();
        let b = second
            .create_json(&owner, &None, json!({"title":"Free"}), &Default::default())
            .await
            .unwrap();
        let a_id = id(&a);
        let b_id = id(&b);
        let lock_path = LocalFS::new(directory.path().to_path_buf()).metadata_lock_path(
            RelativePath::new(&dashboard_path(&None, &owner.user_id, a_id)),
        );
        let lock = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(lock_path)
            .unwrap();
        lock.lock().unwrap();
        let blocked = tokio::spawn({
            let first = first.clone();
            let owner = owner.clone();
            async move {
                first
                    .mutate_json(&owner, a_id, &None, metadata(true), &Default::default())
                    .await
            }
        });
        let independent = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            second.mutate_json(&owner, b_id, &None, metadata(true), &Default::default()),
        )
        .await;
        drop(lock);
        blocked.await.unwrap().unwrap();
        independent
            .expect("different dashboard was blocked by shared state")
            .unwrap();
    }

    #[tokio::test]
    async fn quoted_etags_and_body_revisions_work_but_malformed_validators_fail() {
        let directory = tempfile::tempdir().unwrap();
        let (first, second) = services(directory.path());
        let owner = actor();
        let created = first
            .create_json(
                &owner,
                &None,
                json!({"title":"Quoted"}),
                &Default::default(),
            )
            .await
            .unwrap();
        let id = id(&created);
        let quoted = format!("\"{}\"", revision_of(&created));
        let changed = first
            .mutate_json(&owner, id, &None, metadata(true), &options(&quoted, None))
            .await
            .unwrap();
        assert!(matches!(
            second
                .mutate_json(&owner, id, &None, metadata(false), &options(&quoted, None))
                .await,
            Err(DashboardError::Api { status: 412, .. })
        ));
        let mut body = changed["dashboard"].clone();
        body["revision"] = json!(format!("\"{}\"", revision_of(&changed)));
        body["custom"] = json!(true);
        let replaced = second
            .mutate_json(
                &owner,
                id,
                &None,
                DashboardMutation::Replace(body),
                &Default::default(),
            )
            .await
            .unwrap();
        assert_eq!(replaced["dashboard"]["custom"], true);
        let current = revision_of(&replaced);
        for malformed in [
            format!("W/\"{current}\""),
            "*".into(),
            format!("\"{current}\", \"other\""),
            format!("\"{current}"),
            format!("{current}\""),
            format!("\"bad\nvalue\""),
            "not-a-hash".into(),
        ] {
            assert!(
                matches!(
                    second
                        .mutate_json(
                            &owner,
                            id,
                            &None,
                            metadata(false),
                            &options(&malformed, None)
                        )
                        .await,
                    Err(DashboardError::Api {
                        status: 400,
                        code: "invalid_dashboard_revision",
                        ..
                    })
                ),
                "accepted malformed validator {malformed:?}"
            );
            let mut body = replaced["dashboard"].clone();
            body["revision"] = json!(malformed);
            assert!(matches!(
                second
                    .mutate_json(
                        &owner,
                        id,
                        &None,
                        DashboardMutation::Replace(body),
                        &Default::default()
                    )
                    .await,
                Err(DashboardError::Api { status: 400, .. })
            ));
        }
        assert!(matches!(
            second
                .mutate_json(
                    &owner,
                    id,
                    &None,
                    metadata(false),
                    &options("\"syntactically-valid-but-stale\"", None)
                )
                .await,
            Err(DashboardError::Api { status: 412, .. })
        ));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn obsolete_pending_rename_is_reclaimed_after_delete_or_other_source_change() {
        for delete in [true, false] {
            let directory = tempfile::tempdir().unwrap();
            let (first, second) = services(directory.path());
            let owner = actor();
            let created = first
                .create_json(
                    &owner,
                    &None,
                    json!({"title":"Source X"}),
                    &Default::default(),
                )
                .await
                .unwrap();
            let source_id = id(&created);
            let paused = Arc::new(PausedStorage::new(
                directory.path(),
                dashboard_path(&None, &owner.user_id, source_id),
            ));
            let renaming = Arc::new(DashboardService::new(Arc::new(ObjectStoreMetastore {
                storage: paused.clone(),
            })));
            let task = tokio::spawn({
                let renaming = renaming.clone();
                let owner = owner.clone();
                let observed = revision_of(&created).to_owned();
                async move {
                    renaming
                        .mutate_json(
                            &owner,
                            source_id,
                            &None,
                            DashboardMutation::Metadata(HashMap::from([(
                                "renameTo".into(),
                                "Target Y".into(),
                            )])),
                            &options(&observed, Some("paused-rename")),
                        )
                        .await
                }
            });
            tokio::time::timeout(std::time::Duration::from_secs(2), paused.entered.notified())
                .await
                .expect("rename did not reach storage barrier");
            let reservation = first
                .read(&title_path(&None, "Target Y"), &None)
                .await
                .unwrap()
                .unwrap()
                .0;
            assert_eq!(reservation["state"], "pending");
            assert!(reservation["sourceVersion"].is_object());
            if delete {
                second
                    .delete_json(
                        &owner,
                        source_id,
                        &None,
                        &options(revision_of(&created), None),
                    )
                    .await
                    .unwrap();
            } else {
                second
                    .mutate_json(
                        &owner,
                        source_id,
                        &None,
                        metadata(true),
                        &options(revision_of(&created), None),
                    )
                    .await
                    .unwrap();
            }
            // Reclaim before the original writer resumes: its exact source CAS
            // is already impossible, so no lease or writer timeout is needed.
            let replacement = second
                .create_json(
                    &owner,
                    &None,
                    json!({"title":"Target Y"}),
                    &DashboardWriteOptions {
                        idempotency_key: Some("replacement-create".into()),
                        ..Default::default()
                    },
                )
                .await;
            paused.released.notify_one();
            let lost = task.await.unwrap();
            assert!(matches!(lost, Err(DashboardError::Api { status: 412, .. })));
            let replacement = replacement.unwrap();
            assert_ne!(id(&replacement), source_id);
            assert_eq!(
                first.get_json(id(&replacement), &None).await.unwrap()["title"],
                "Target Y"
            );
            if delete {
                assert!(matches!(
                    first.get_json(source_id, &None).await,
                    Err(DashboardError::Api { status: 404, .. })
                ));
            } else {
                let source = first.get_json(source_id, &None).await.unwrap();
                assert_eq!(source["title"], "Source X");
                assert_eq!(source["isFavorite"], true);
            }
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn pending_rename_is_not_stolen_while_its_source_can_still_commit() {
        let directory = tempfile::tempdir().unwrap();
        let (first, second) = services(directory.path());
        let owner = actor();
        let created = first
            .create_json(
                &owner,
                &None,
                json!({"title":"Live X"}),
                &Default::default(),
            )
            .await
            .unwrap();
        let source_id = id(&created);
        let paused = Arc::new(PausedStorage::new(
            directory.path(),
            dashboard_path(&None, &owner.user_id, source_id),
        ));
        let renaming = Arc::new(DashboardService::new(Arc::new(ObjectStoreMetastore {
            storage: paused.clone(),
        })));
        let task = tokio::spawn({
            let owner = owner.clone();
            let observed = revision_of(&created).to_owned();
            async move {
                renaming
                    .mutate_json(
                        &owner,
                        source_id,
                        &None,
                        DashboardMutation::Metadata(HashMap::from([(
                            "renameTo".into(),
                            "Live Y".into(),
                        )])),
                        &options(&observed, Some("live-rename")),
                    )
                    .await
            }
        });
        tokio::time::timeout(std::time::Duration::from_secs(2), paused.entered.notified())
            .await
            .unwrap();
        let competing = second
            .create_json(
                &owner,
                &None,
                json!({"title":"Live Y"}),
                &Default::default(),
            )
            .await;
        paused.released.notify_one();
        let changed = task.await.unwrap().unwrap();
        assert!(matches!(
            competing,
            Err(DashboardError::Api {
                code: "title_reservation_pending",
                ..
            })
        ));
        assert_eq!(changed["dashboard"]["title"], "Live Y");
        assert_eq!(
            first.get_json(source_id, &None).await.unwrap()["title"],
            "Live Y"
        );
    }

    async fn wait_for_active_title(service: &DashboardService, title: &str) -> Value {
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            loop {
                if let Some((claim, _)) = service
                    .read(&title_path(&None, title), &None)
                    .await
                    .unwrap()
                {
                    if claim["state"] == "active" {
                        return claim;
                    }
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("detached commit did not activate title")
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn cancelling_unkeyed_create_or_rename_does_not_cancel_commit() {
        let directory = tempfile::tempdir().unwrap();
        let (observer, _) = services(directory.path());
        let owner = actor();
        let paused = Arc::new(PausedStorage::new(directory.path(), String::new()));
        let service = Arc::new(DashboardService::new(Arc::new(ObjectStoreMetastore {
            storage: paused.clone(),
        })));
        let caller = tokio::spawn({
            let service = service.clone();
            let owner = owner.clone();
            async move {
                service
                    .create_json(
                        &owner,
                        &None,
                        json!({"title":"Cancelled create"}),
                        &Default::default(),
                    )
                    .await
            }
        });
        tokio::time::timeout(std::time::Duration::from_secs(2), paused.entered.notified())
            .await
            .unwrap();
        caller.abort();
        assert!(caller.await.unwrap_err().is_cancelled());
        paused.released.notify_one();
        let claim = wait_for_active_title(&observer, "Cancelled create").await;
        let created_id = Ulid::from_string(claim["dashboardId"].as_str().unwrap()).unwrap();
        let created = observer.get_json(created_id, &None).await.unwrap();
        assert!(matches!(
            observer
                .create_json(
                    &owner,
                    &None,
                    json!({"title":"Cancelled create"}),
                    &Default::default()
                )
                .await,
            Err(DashboardError::Api {
                code: "title_conflict",
                ..
            })
        ));
        let paused = Arc::new(PausedStorage::new(
            directory.path(),
            dashboard_path(&None, &owner.user_id, created_id),
        ));
        let service = Arc::new(DashboardService::new(Arc::new(ObjectStoreMetastore {
            storage: paused.clone(),
        })));
        let caller = tokio::spawn({
            let owner = owner.clone();
            let observed = created["revision"].as_str().unwrap().to_owned();
            async move {
                service
                    .mutate_json(
                        &owner,
                        created_id,
                        &None,
                        DashboardMutation::Metadata(HashMap::from([(
                            "renameTo".into(),
                            "Cancelled rename".into(),
                        )])),
                        &options(&observed, None),
                    )
                    .await
            }
        });
        tokio::time::timeout(std::time::Duration::from_secs(2), paused.entered.notified())
            .await
            .unwrap();
        caller.abort();
        assert!(caller.await.unwrap_err().is_cancelled());
        paused.released.notify_one();
        wait_for_active_title(&observer, "Cancelled rename").await;
        assert_eq!(
            observer.get_json(created_id, &None).await.unwrap()["title"],
            "Cancelled rename"
        );
        observer
            .create_json(
                &owner,
                &None,
                json!({"title":"Cancelled create"}),
                &Default::default(),
            )
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn legacy_bootstrap_scans_once_and_does_not_hide_new_remote_locators() {
        let directory = tempfile::tempdir().unwrap();
        let owner = actor();
        let legacy_id = Ulid::new();
        let local = LocalFS::new(directory.path().to_path_buf());
        let legacy = json!({"dashboardId":legacy_id.to_string(),"author":owner.user_id,"title":"Legacy title","tiles":[],"opaque":{"preserve":true}});
        local
            .put_object(
                RelativePath::new(&dashboard_path(&None, &owner.user_id, legacy_id)),
                Bytes::from(serde_json::to_vec(&legacy).unwrap()),
                &None,
            )
            .await
            .unwrap();
        let counted = Arc::new(PausedStorage::new(directory.path(), "never-match".into()));
        counted.armed.store(false, Ordering::SeqCst);
        let service = DashboardService::new(Arc::new(ObjectStoreMetastore {
            storage: counted.clone(),
        }));
        let (_, remote) = services(directory.path());
        let create_key = "remote-after-negative";
        let digest = Sha256::digest(
            serde_json::to_vec(&json!([Value::Null, owner.user_id, create_key])).unwrap(),
        );
        let future_id = Ulid::from_bytes(digest[..16].try_into().unwrap());
        assert!(matches!(
            service.get_json(future_id, &None).await,
            Err(DashboardError::Api { status: 404, .. })
        ));
        let baseline = counted.scans.load(Ordering::SeqCst);
        assert!(baseline > 0);
        for _ in 0..8 {
            assert!(service.get_json(Ulid::new(), &None).await.is_err());
        }
        for index in 0..4 {
            service
                .create_json(
                    &owner,
                    &None,
                    json!({"title":format!("New title {index}")}),
                    &Default::default(),
                )
                .await
                .unwrap();
        }
        assert_eq!(counted.scans.load(Ordering::SeqCst), baseline);
        remote
            .create_json(
                &owner,
                &None,
                json!({"title":"Remote new"}),
                &DashboardWriteOptions {
                    idempotency_key: Some(create_key.into()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(
            service.get_json(future_id, &None).await.unwrap()["title"],
            "Remote new"
        );
        let observed = remote.get_json(legacy_id, &None).await.unwrap();
        remote
            .mutate_json(
                &owner,
                legacy_id,
                &None,
                DashboardMutation::Metadata(HashMap::from([(
                    "renameTo".into(),
                    "Legacy moved".into(),
                )])),
                &options(observed["revision"].as_str().unwrap(), None),
            )
            .await
            .unwrap();
        // Stale bootstrap title must be checked against the remote rename.
        service
            .create_json(
                &owner,
                &None,
                json!({"title":"Legacy title"}),
                &Default::default(),
            )
            .await
            .unwrap();
        assert_eq!(counted.scans.load(Ordering::SeqCst), baseline);
    }

    #[tokio::test]
    async fn create_receipt_survives_recent_ring_eviction_and_deleted_replays_are_explicit() {
        let directory = tempfile::tempdir().unwrap();
        let (first, second) = services(directory.path());
        let owner = actor();
        let create_options = DashboardWriteOptions {
            idempotency_key: Some("permanent-create".into()),
            ..Default::default()
        };
        let request =
            json!({"title":"Persistent create","heavyExtension":{"queries":vec!["payload";128]}});
        let created = first
            .create_json(&owner, &None, request.clone(), &create_options)
            .await
            .unwrap();
        let dashboard_id = id(&created);
        for index in 0..=RECEIPT_LIMIT {
            let current = first.get_json(dashboard_id, &None).await.unwrap();
            let key = format!("evict-{index}");
            first
                .mutate_json(
                    &owner,
                    dashboard_id,
                    &None,
                    metadata(index % 2 == 0),
                    &options(current["revision"].as_str().unwrap(), Some(&key)),
                )
                .await
                .unwrap();
        }
        let replayed = second
            .create_json(&owner, &None, request.clone(), &create_options)
            .await
            .unwrap();
        assert_eq!(id(&replayed), dashboard_id);
        assert_eq!(replayed["replayed"], true);
        assert_eq!(replayed["appliedRevision"], created["revision"]);
        let before = first.get_json(dashboard_id, &None).await.unwrap();
        let update_options = options(
            before["revision"].as_str().unwrap(),
            Some("update-before-delete"),
        );
        let updated = first
            .mutate_json(&owner, dashboard_id, &None, metadata(true), &update_options)
            .await
            .unwrap();
        let delete_options = options(revision_of(&updated), Some("delete-once"));
        second
            .delete_json(&owner, dashboard_id, &None, &delete_options)
            .await
            .unwrap();
        second
            .delete_json(&owner, dashboard_id, &None, &delete_options)
            .await
            .unwrap();
        for replay in [
            first
                .create_json(&owner, &None, request, &create_options)
                .await,
            first
                .mutate_json(&owner, dashboard_id, &None, metadata(true), &update_options)
                .await,
        ] {
            match replay {
                Err(DashboardError::Api {
                    status: 410,
                    code: "resource_deleted",
                    details,
                    ..
                }) => {
                    assert_eq!(details["dashboardId"], dashboard_id.to_string());
                    assert!(details["appliedRevision"].is_string());
                }
                other => panic!("expected explicit deleted replay, got {other:?}"),
            }
        }
        let stored = first.stored(dashboard_id, &None).await.unwrap();
        assert!(stored.document.get("heavyExtension").is_none());
        assert!(stored.document.get("tiles").is_none());
        assert!(stored.document[INTERNAL]["createReceipt"].is_object());
    }

    #[tokio::test]
    async fn dry_run_checks_title_without_writing_reservations() {
        let directory = tempfile::tempdir().unwrap();
        let (first, second) = services(directory.path());
        let owner = actor();
        let existing = first
            .create_json(&owner, &None, json!({"title":"Taken"}), &Default::default())
            .await
            .unwrap();
        let other = first
            .create_json(&owner, &None, json!({"title":"Other"}), &Default::default())
            .await
            .unwrap();
        let other_id = id(&other);
        let preview = DashboardWriteOptions {
            dry_run: true,
            ..Default::default()
        };
        assert!(matches!(
            second
                .create_json(&owner, &None, json!({"title":"Taken"}), &preview)
                .await,
            Err(DashboardError::Api {
                code: "title_conflict",
                ..
            })
        ));
        let rename_preview = DashboardWriteOptions {
            dry_run: true,
            ..options(revision_of(&other), None)
        };
        assert!(matches!(
            second
                .mutate_json(
                    &owner,
                    other_id,
                    &None,
                    DashboardMutation::Metadata(HashMap::from([(
                        "renameTo".into(),
                        "Taken".into()
                    )])),
                    &rename_preview
                )
                .await,
            Err(DashboardError::Api {
                code: "title_conflict",
                ..
            })
        ));
        let available = second
            .create_json(
                &owner,
                &None,
                json!({"title":"Available preview"}),
                &preview,
            )
            .await
            .unwrap();
        assert_eq!(available["titleAvailability"]["reserved"], false);
        assert_eq!(available["titleAvailability"]["mayConflictAtCommit"], true);
        assert!(
            first
                .read(&title_path(&None, "Available preview"), &None)
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(first.list_json(&None).await.unwrap().len(), 2);
        assert_eq!(
            first.get_json(id(&existing), &None).await.unwrap()["title"],
            "Taken"
        );
    }

    fn fault_service(
        root: &Path,
        target: &str,
        kind: FaultKind,
    ) -> (DashboardService, Arc<PausedStorage>) {
        let storage = Arc::new(PausedStorage::new(root, "never-match".into()));
        *storage.fault.lock().unwrap() = Some(WriteFault {
            path_contains: target.into(),
            kind,
        });
        (
            DashboardService::new(Arc::new(ObjectStoreMetastore {
                storage: storage.clone(),
            })),
            storage,
        )
    }

    #[tokio::test]
    async fn committed_documents_and_title_claims_survive_transport_conflict_or_error() {
        for fault in [FaultKind::AfterConflict, FaultKind::AfterStorage] {
            for target in ["/dashboards/", "/.dashboard-titles/"] {
                let directory = tempfile::tempdir().unwrap();
                let owner = actor();
                let (service, _) = fault_service(directory.path(), target, fault);
                let created = service
                    .create_json(
                        &owner,
                        &None,
                        json!({"title":"Committed create"}),
                        &Default::default(),
                    )
                    .await
                    .unwrap();
                assert_eq!(
                    service.get_json(id(&created), &None).await.unwrap()["title"],
                    "Committed create"
                );
                assert!(matches!(
                    service
                        .create_json(
                            &owner,
                            &None,
                            json!({"title":"Committed create"}),
                            &Default::default()
                        )
                        .await,
                    Err(DashboardError::Api {
                        code: "title_conflict",
                        ..
                    })
                ));
            }
            for operation in ["rename", "delete"] {
                let directory = tempfile::tempdir().unwrap();
                let (plain, observer) = services(directory.path());
                let owner = actor();
                let created = plain
                    .create_json(
                        &owner,
                        &None,
                        json!({"title":"Committed source"}),
                        &Default::default(),
                    )
                    .await
                    .unwrap();
                let dashboard_id = id(&created);
                let (faulty, _) = fault_service(directory.path(), "/dashboards/", fault);
                if operation == "rename" {
                    let changed = faulty
                        .mutate_json(
                            &owner,
                            dashboard_id,
                            &None,
                            DashboardMutation::Metadata(HashMap::from([(
                                "renameTo".into(),
                                "Committed target".into(),
                            )])),
                            &options(revision_of(&created), None),
                        )
                        .await
                        .unwrap();
                    assert_eq!(changed["dashboard"]["title"], "Committed target");
                    assert!(matches!(
                        observer
                            .create_json(
                                &owner,
                                &None,
                                json!({"title":"Committed target"}),
                                &Default::default()
                            )
                            .await,
                        Err(DashboardError::Api {
                            code: "title_conflict",
                            ..
                        })
                    ));
                    observer
                        .create_json(
                            &owner,
                            &None,
                            json!({"title":"Committed source"}),
                            &Default::default(),
                        )
                        .await
                        .unwrap();
                } else {
                    faulty
                        .delete_json(
                            &owner,
                            dashboard_id,
                            &None,
                            &options(revision_of(&created), None),
                        )
                        .await
                        .unwrap();
                    assert!(matches!(
                        observer.get_json(dashboard_id, &None).await,
                        Err(DashboardError::Api { status: 404, .. })
                    ));
                    observer
                        .create_json(
                            &owner,
                            &None,
                            json!({"title":"Committed source"}),
                            &Default::default(),
                        )
                        .await
                        .unwrap();
                }
            }
        }
    }

    #[tokio::test]
    async fn failed_unkeyed_create_is_fenced_and_keyed_create_remains_retryable() {
        for keyed in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let owner = actor();
            let (service, _) =
                fault_service(directory.path(), "/dashboards/", FaultKind::BeforeStorage);
            let request = json!({"title":"Transient create"});
            let opts = DashboardWriteOptions {
                idempotency_key: keyed.then(|| "recoverable-create".into()),
                ..Default::default()
            };
            assert!(
                service
                    .create_json(&owner, &None, request.clone(), &opts)
                    .await
                    .is_err()
            );
            let claim = service
                .read(&title_path(&None, "Transient create"), &None)
                .await
                .unwrap()
                .unwrap()
                .0;
            assert_eq!(claim["state"], if keyed { "pending" } else { "released" });
            let recovered = service
                .create_json(&owner, &None, request, &opts)
                .await
                .unwrap();
            assert_eq!(recovered["dashboard"]["title"], "Transient create");
            assert_eq!(service.list_json(&None).await.unwrap().len(), 1);
        }
    }

    #[tokio::test]
    async fn uncertain_rename_is_fenced_without_losing_source_content() {
        let directory = tempfile::tempdir().unwrap();
        let (plain, observer) = services(directory.path());
        let owner = actor();
        let created = plain
            .create_json(
                &owner,
                &None,
                json!({"title":"Stable old","opaque":{"preserve":[1,2,3]}}),
                &Default::default(),
            )
            .await
            .unwrap();
        let dashboard_id = id(&created);
        let (faulty, _) = fault_service(directory.path(), "/dashboards/", FaultKind::BeforeStorage);
        let rename = || {
            DashboardMutation::Metadata(HashMap::from([("renameTo".into(), "Retry target".into())]))
        };
        assert!(
            faulty
                .mutate_json(
                    &owner,
                    dashboard_id,
                    &None,
                    rename(),
                    &options(revision_of(&created), None)
                )
                .await
                .is_err()
        );
        let current = observer.get_json(dashboard_id, &None).await.unwrap();
        assert_eq!(current["title"], "Stable old");
        assert_eq!(current["opaque"], created["dashboard"]["opaque"]);
        assert_ne!(current["revision"], created["revision"]);
        let recovered = faulty
            .mutate_json(
                &owner,
                dashboard_id,
                &None,
                rename(),
                &options(current["revision"].as_str().unwrap(), None),
            )
            .await
            .unwrap();
        assert_eq!(recovered["dashboard"]["title"], "Retry target");
    }

    #[tokio::test]
    async fn later_concurrent_edit_cannot_make_error_cleanup_release_committed_title() {
        for rename in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let (plain, observer) = services(directory.path());
            let owner = actor();
            let (faulty, _) = fault_service(
                directory.path(),
                "/dashboards/",
                FaultKind::AfterConcurrentEdit,
            );
            let final_title = if rename {
                "Advanced target"
            } else {
                "Advanced create"
            };
            if rename {
                let created = plain
                    .create_json(
                        &owner,
                        &None,
                        json!({"title":"Advanced source"}),
                        &Default::default(),
                    )
                    .await
                    .unwrap();
                assert!(
                    faulty
                        .mutate_json(
                            &owner,
                            id(&created),
                            &None,
                            DashboardMutation::Metadata(HashMap::from([(
                                "renameTo".into(),
                                final_title.into()
                            )])),
                            &options(revision_of(&created), None)
                        )
                        .await
                        .is_err()
                );
            } else {
                assert!(
                    faulty
                        .create_json(
                            &owner,
                            &None,
                            json!({"title":final_title}),
                            &Default::default()
                        )
                        .await
                        .is_err()
                );
            }
            assert!(matches!(
                observer
                    .create_json(
                        &owner,
                        &None,
                        json!({"title":final_title}),
                        &Default::default()
                    )
                    .await,
                Err(DashboardError::Api {
                    code: "title_conflict",
                    ..
                })
            ));
            let listed = observer.list_json(&None).await.unwrap();
            assert_eq!(listed.len(), 1);
            assert_eq!(listed[0]["title"], final_title);
            assert_eq!(listed[0]["anotherWriterChangedThis"], true);
        }
    }

    #[tokio::test]
    async fn released_or_stale_reservations_still_check_legacy_title_authoritatively() {
        for state in ["released", "active"] {
            let directory = tempfile::tempdir().unwrap();
            let (service, _) = services(directory.path());
            let owner = actor();
            let legacy_id = Ulid::new();
            let storage = LocalFS::new(directory.path().to_path_buf());
            let legacy = json!({"title":"Legacy reserved","dashboardId":legacy_id.to_string(),"author":owner.user_id,"tiles":[]});
            storage
                .put_object(
                    RelativePath::new(&dashboard_path(&None, &owner.user_id, legacy_id)),
                    Bytes::from(serde_json::to_vec(&legacy).unwrap()),
                    &None,
                )
                .await
                .unwrap();
            service.write(&title_path(&None,"Legacy reserved"),&json!({"state":state,"dashboardId":Ulid::new().to_string(),"title":"Legacy reserved"}),MetadataWriteCondition::Create,&None).await.unwrap();
            assert!(matches!(
                service
                    .create_json(
                        &owner,
                        &None,
                        json!({"title":"Legacy reserved"}),
                        &Default::default()
                    )
                    .await,
                Err(DashboardError::Api {
                    code: "title_conflict",
                    ..
                })
            ));
        }
    }
}
