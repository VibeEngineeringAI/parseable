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

use std::collections::{HashMap, HashSet};

use actix_web::{
    HttpRequest, HttpResponse, Responder,
    web::{self, Json},
};

use crate::{
    handlers::http::{
        modal::{ingest::SyncRole, utils::rbac_utils::get_metadata},
        rbac::UPDATE_LOCK,
        role::RoleError,
    },
    parseable::DEFAULT_TENANT,
    rbac::{
        map::{mut_roles, mut_sessions, read_user_groups, users},
        role::model::Role,
    },
    storage,
    utils::get_tenant_id_from_request,
};

// Handler for PUT /api/v1/role/{name}
// Creates a new role or update existing one
pub async fn put(
    req: HttpRequest,
    name: web::Path<String>,
    Json(sync_req): Json<SyncRole>,
) -> Result<impl Responder, RoleError> {
    let name = name.into_inner();
    let req_tenant_id = get_tenant_id_from_request(&req);
    let req_tenant = req_tenant_id.as_deref().unwrap_or(DEFAULT_TENANT);
    if req_tenant.ne(DEFAULT_TENANT) && (req_tenant_id.ne(&sync_req.tenant_id)) {
        return Err(RoleError::Anyhow(anyhow::Error::msg(
            "non super-admin user trying to create role for another tenant",
        )));
    }
    let tenant_id = sync_req
        .tenant_id
        .as_deref()
        .unwrap_or(DEFAULT_TENANT)
        .to_owned();
    // The querier sends syncs after releasing its lock, so they can arrive out
    // of order and the body may be stale. Install what storage holds instead;
    // holding the lock across read and install means a later sync always reads
    // state at least as new as an earlier one.
    let _guard = UPDATE_LOCK.lock().await;
    let metadata = get_metadata(&sync_req.tenant_id).await?;
    apply_stored_role(&metadata.roles, &tenant_id, &name);

    if let Err(e) = storage::put_staging_metadata(&metadata, &sync_req.tenant_id) {
        tracing::warn!("Failed to write staging metadata after role sync: {e}");
    }

    Ok(HttpResponse::Ok().finish())
}

/// Makes the live role `name` match `stored` (the tenant's roles in storage),
/// removing it if storage no longer has it, and drops the sessions of every
/// user holding the role.
fn apply_stored_role(stored: &HashMap<String, Role>, tenant_id: &str, name: &str) {
    {
        let mut roles = mut_roles();
        let tenant_roles = roles.entry(tenant_id.to_owned()).or_default();
        match stored.get(name) {
            Some(role) => tenant_roles.insert(name.to_owned(), role.clone()),
            None => tenant_roles.remove(name),
        };
    }

    // refresh the sessions of all users using this role
    // for this, iterate over all user_groups and users and create a hashset of users
    let mut session_refresh_users: HashSet<String> = HashSet::new();
    if let Some(groups) = read_user_groups().get(tenant_id) {
        for user_group in groups.values() {
            if user_group.roles.contains(name) {
                session_refresh_users
                    .extend(user_group.users.iter().map(|u| u.userid().to_string()));
            }
        }
    }

    // iterate over all users to see if they have this role
    if let Some(users) = users().get(tenant_id) {
        for user in users.values() {
            if user.roles.contains(name) {
                session_refresh_users.insert(user.userid().to_string());
            }
        }
    }

    for userid in session_refresh_users {
        mut_sessions().remove_user(&userid, tenant_id);
    }
}

// Handler for DELETE /api/v1/role/{name}
// Deletes the role
pub async fn delete(
    req: HttpRequest,
    name: web::Path<String>,
) -> Result<impl Responder, RoleError> {
    let name = name.into_inner();
    let req_tenant_id = get_tenant_id_from_request(&req);

    let mut metadata = get_metadata(&req_tenant_id).await?;
    metadata.roles.remove(&name);

    let _ = storage::put_staging_metadata(&metadata, &req_tenant_id);
    let tenant_id = req_tenant_id
        .as_deref()
        .unwrap_or(DEFAULT_TENANT)
        .to_owned();
    mut_roles()
        .entry(tenant_id.clone())
        .or_default()
        .remove(&name);

    let mut session_refresh_users: HashSet<String> = HashSet::new();
    if let Some(groups) = read_user_groups().get(&tenant_id) {
        for user_group in groups.values() {
            if user_group.roles.contains(&name) {
                session_refresh_users
                    .extend(user_group.users.iter().map(|u| u.userid().to_string()));
            }
        }
    }

    // iterate over all users to see if they have this role
    if let Some(users) = users().get(&tenant_id) {
        for user in users.values() {
            if user.roles.contains(&name) {
                session_refresh_users.insert(user.userid().to_string());
            }
        }
    }

    for userid in session_refresh_users {
        mut_sessions().remove_user(&userid, &tenant_id);
    }

    Ok(HttpResponse::Ok().finish())
}

#[cfg(test)]
mod tests {
    use parking_lot::RwLock;
    use ulid::Ulid;

    use super::*;
    use crate::rbac::{
        map::{ROLES, SESSIONS, Sessions, TEST_SERIAL, USER_GROUPS, USERS, UserGroups, roles},
        role::model::DefaultPrivilege,
    };

    const ROLE: &str = "writers";

    // `rbac::map::init` needs `PARSEABLE`, so tests create the maps directly.
    fn init_auth_maps() {
        USERS.get_or_init(|| RwLock::new(crate::rbac::map::Users::default()));
        SESSIONS.get_or_init(|| RwLock::new(Sessions::default()));
        USER_GROUPS.get_or_init(|| RwLock::new(UserGroups::default()));
        ROLES.get_or_init(|| RwLock::new(HashMap::new()));
    }

    fn role_a() -> Role {
        Role::create_user_role(vec![DefaultPrivilege::Reader { resource: None }])
    }

    fn role_b() -> Role {
        Role::create_user_role(vec![DefaultPrivilege::Admin])
    }

    fn live_role(tenant: &str) -> Option<Role> {
        roles().get(tenant).and_then(|r| r.get(ROLE)).cloned()
    }

    // The querier sends syncs after releasing its lock, so PUT A's sync can
    // arrive after PUT B was committed. Storage then holds B; the stale body
    // must not overwrite it.
    #[tokio::test]
    async fn stale_sync_body_does_not_override_stored_role() {
        // Other modules' tests watch the RBAC map locks; see `map::TEST_SERIAL`.
        let _serial = TEST_SERIAL.lock().await;
        init_auth_maps();
        let tenant = format!("ingestor-role-{}", Ulid::new());
        let stored = HashMap::from([(ROLE.to_owned(), role_b())]);

        apply_stored_role(&stored, &tenant, ROLE);

        assert_eq!(live_role(&tenant), Some(role_b()), "live role must be B");
    }

    // PUT then DELETE: the PUT's sync arriving after the delete was committed
    // must not resurrect the role.
    #[tokio::test]
    async fn sync_for_role_deleted_in_storage_removes_live_role() {
        // Other modules' tests watch the RBAC map locks; see `map::TEST_SERIAL`.
        let _serial = TEST_SERIAL.lock().await;
        init_auth_maps();
        let tenant = format!("ingestor-role-{}", Ulid::new());
        mut_roles()
            .entry(tenant.clone())
            .or_default()
            .insert(ROLE.to_owned(), role_a());
        apply_stored_role(&HashMap::new(), &tenant, ROLE);

        assert_eq!(live_role(&tenant), None, "deleted role must not be live");
    }
}
