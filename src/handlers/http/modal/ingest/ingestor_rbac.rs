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

use std::collections::HashSet;

use actix_web::{HttpRequest, HttpResponse, http::StatusCode, web};

use crate::{
    handlers::http::{
        modal::utils::rbac_utils::get_metadata,
        rbac::{RBACError, UPDATE_LOCK},
    },
    parseable::DEFAULT_TENANT,
    rbac::{Users, map::write_user_groups, user::User as ParseableUser},
    storage::{self, StorageMetadata},
    utils::get_tenant_id_from_request,
};

// Every sender commits the user change to storage before syncing it, but syncs
// fan out in parallel and can arrive after later changes were committed, so the
// body may be stale. Every receiver therefore installs the
// user as storage holds it rather than replaying the request. Holding the lock
// across read and install means a later sync always reads state at least as new
// as an earlier one, and repeated syncs are harmless.

// Handler for POST /api/v1/user/{userid}/sync
// Installs the user as storage holds it, or removes it if storage has none
pub async fn post_user(
    req: HttpRequest,
    userid: web::Path<String>,
    body: Option<web::Json<serde_json::Value>>,
) -> Result<HttpResponse, RBACError> {
    let username = userid.into_inner();

    if let Some(body) = body {
        let user: ParseableUser = serde_json::from_value(body.into_inner())?;
        let req_tenant_id = get_tenant_id_from_request(&req);
        let req_tenant = req_tenant_id.as_deref().unwrap_or(DEFAULT_TENANT);
        if req_tenant.ne(DEFAULT_TENANT)
            && (req_tenant.ne(user.tenant.as_deref().unwrap_or(DEFAULT_TENANT)))
        {
            return Err(RBACError::Anyhow(anyhow::Error::msg(
                "non super-admin user trying to create user for another tenant",
            )));
        }
        sync_stored_user(&username, &user.tenant).await?;
    }

    Ok(HttpResponse::Ok().status(StatusCode::OK).finish())
}

// Handler for DELETE /api/v1/user/delete/{userid}
pub async fn delete_user(
    req: HttpRequest,
    userid: web::Path<String>,
) -> Result<HttpResponse, RBACError> {
    let userid = userid.into_inner();
    let tenant_id = get_tenant_id_from_request(&req);
    sync_stored_user(&userid, &tenant_id).await?;
    Ok(HttpResponse::Ok().status(StatusCode::OK).finish())
}

// Handler PATCH /user/{userid}/role/sync/add => install the user's stored roles
// The body is still parsed so the route accepts what older queriers send.
pub async fn add_roles_to_user(
    req: HttpRequest,
    userid: web::Path<String>,
    _roles_to_add: web::Json<HashSet<String>>,
) -> Result<HttpResponse, RBACError> {
    let userid = userid.into_inner();
    let tenant_id = get_tenant_id_from_request(&req);
    sync_stored_user(&userid, &tenant_id).await?;
    Ok(HttpResponse::Ok().status(StatusCode::OK).finish())
}

// Handler PATCH /user/{userid}/role/sync/remove => install the user's stored roles
// The body is still parsed so the route accepts what older queriers send.
pub async fn remove_roles_from_user(
    req: HttpRequest,
    userid: web::Path<String>,
    _roles_to_remove: web::Json<HashSet<String>>,
) -> Result<HttpResponse, RBACError> {
    let userid = userid.into_inner();
    let tenant_id = get_tenant_id_from_request(&req);
    sync_stored_user(&userid, &tenant_id).await?;
    Ok(HttpResponse::Ok().status(StatusCode::OK).finish())
}

// Handler for POST /api/v1/user/{userid}/generate-new-password/sync
// Installs the user, and so its new password hash, as storage holds it
pub async fn post_gen_password(
    req: HttpRequest,
    userid: web::Path<String>,
) -> Result<HttpResponse, RBACError> {
    let username = userid.into_inner();
    let tenant_id = get_tenant_id_from_request(&req);
    sync_stored_user(&username, &tenant_id).await?;
    Ok(HttpResponse::Ok().status(StatusCode::OK).finish())
}

/// Reads the tenant's metadata from storage, installs `userid` as stored there
/// and writes the metadata to staging.
async fn sync_stored_user(userid: &str, tenant_id: &Option<String>) -> Result<(), RBACError> {
    let _guard = UPDATE_LOCK.lock().await;
    let metadata = get_metadata(tenant_id).await?;
    apply_stored_user(&metadata.users, userid, tenant_id);
    put_staging(&metadata, tenant_id);
    Ok(())
}

fn put_staging(metadata: &StorageMetadata, tenant_id: &Option<String>) {
    if let Err(e) = storage::put_staging_metadata(metadata, tenant_id) {
        tracing::warn!("Failed to write staging metadata after user sync: {e}");
    }
}

/// Makes the live user `userid` match `stored` (the tenant's users in storage),
/// removing it, and its group memberships, if storage no longer has it, and
/// drops the user's sessions.
fn apply_stored_user(stored: &[ParseableUser], userid: &str, tenant_id: &Option<String>) {
    match stored.iter().find(|user| user.userid() == userid) {
        Some(user) => Users.put_user(user.clone()),
        None => {
            Users.delete_user(userid, tenant_id);
            let tenant = tenant_id.as_deref().unwrap_or(DEFAULT_TENANT);
            if let Some(groups) = write_user_groups().get_mut(tenant) {
                for group in groups.values_mut() {
                    group.users.retain(|member| member.userid() != userid);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use chrono::TimeDelta;
    use parking_lot::RwLock;
    use ulid::Ulid;

    use super::*;
    use crate::rbac::{
        map::{
            ROLES, SESSIONS, SessionKey, Sessions, TEST_SERIAL, USER_GROUPS, USERS, UserGroups,
            mut_users, read_user_groups, write_user_groups,
        },
        user::{Basic, GroupUser, UserGroup, UserType},
    };

    // `rbac::map::init` needs `PARSEABLE`, so tests create the maps directly.
    fn init_auth_maps() {
        USERS.get_or_init(|| RwLock::new(crate::rbac::map::Users::default()));
        SESSIONS.get_or_init(|| RwLock::new(Sessions::default()));
        USER_GROUPS.get_or_init(|| RwLock::new(UserGroups::default()));
        ROLES.get_or_init(|| RwLock::new(HashMap::new()));
    }

    fn user(tenant: &Option<String>, userid: &str, roles: &[&str]) -> ParseableUser {
        ParseableUser {
            ty: UserType::Native(Basic {
                username: userid.to_owned(),
                password_hash: String::new(),
                email: None,
            }),
            roles: roles.iter().map(|role| role.to_string()).collect(),
            user_groups: HashSet::new(),
            tenant: tenant.clone(),
            protected: false,
        }
    }

    /// A tenant and user id no other test uses.
    fn fresh() -> (Option<String>, String) {
        (
            Some(format!("ingestor-user-{}", Ulid::new())),
            format!("user-{}", Ulid::new()),
        )
    }

    /// Stores `user` in the live map and tracks a session for it.
    fn live_with_session(user: &ParseableUser) -> SessionKey {
        mut_users().insert(user.clone());
        let key = SessionKey::SessionId(Ulid::new());
        Users.new_session(user, key.clone(), TimeDelta::minutes(5));
        key
    }

    fn live_roles(userid: &str, tenant: &Option<String>) -> Option<HashSet<String>> {
        Users.get_user(userid, tenant).map(|user| user.roles)
    }

    // The querier commits the removal before syncing, so storage no longer
    // holds the revoked role when the sync arrives; it must still be revoked.
    #[tokio::test]
    async fn revoked_role_is_removed_from_live_user_and_sessions_dropped() {
        // Other modules' tests watch the RBAC map locks; see `map::TEST_SERIAL`.
        let _serial = TEST_SERIAL.lock().await;
        init_auth_maps();
        let (tenant, userid) = fresh();
        let session = live_with_session(&user(&tenant, &userid, &["a", "b"]));

        apply_stored_user(&[user(&tenant, &userid, &["a"])], &userid, &tenant);

        assert_eq!(
            live_roles(&userid, &tenant),
            Some(HashSet::from(["a".to_owned()])),
            "live user must hold only the committed roles"
        );
        assert!(
            !Users.session_exists(&session),
            "sessions with revoked permissions must be dropped"
        );
    }

    #[tokio::test]
    async fn granted_role_is_added_to_live_user_and_sessions_dropped() {
        let _serial = TEST_SERIAL.lock().await;
        init_auth_maps();
        let (tenant, userid) = fresh();
        let session = live_with_session(&user(&tenant, &userid, &["a"]));

        apply_stored_user(&[user(&tenant, &userid, &["a", "b"])], &userid, &tenant);

        assert_eq!(
            live_roles(&userid, &tenant),
            Some(HashSet::from(["a".to_owned(), "b".to_owned()]))
        );
        assert!(!Users.session_exists(&session));
    }

    // A repeated or late sync applies the same committed state again.
    #[tokio::test]
    async fn applying_stored_user_twice_is_idempotent() {
        let _serial = TEST_SERIAL.lock().await;
        init_auth_maps();
        let (tenant, userid) = fresh();
        live_with_session(&user(&tenant, &userid, &["a", "b"]));
        let stored = [user(&tenant, &userid, &["a"])];

        apply_stored_user(&stored, &userid, &tenant);
        apply_stored_user(&stored, &userid, &tenant);

        assert_eq!(
            live_roles(&userid, &tenant),
            Some(HashSet::from(["a".to_owned()]))
        );
    }

    // Create then delete: the create's sync arriving after the delete was
    // committed must not resurrect the user.
    #[tokio::test]
    async fn user_deleted_in_storage_is_removed_from_live_map() {
        let _serial = TEST_SERIAL.lock().await;
        init_auth_maps();
        let (tenant, userid) = fresh();
        let session = live_with_session(&user(&tenant, &userid, &["a"]));

        apply_stored_user(&[], &userid, &tenant);

        assert!(!Users.contains(&userid, &tenant), "user must not be live");
        assert!(!Users.session_exists(&session));
    }

    // An ingestor that missed the create sync picks the user up on the next one.
    #[tokio::test]
    async fn user_missing_from_live_map_is_installed() {
        let _serial = TEST_SERIAL.lock().await;
        init_auth_maps();
        let (tenant, userid) = fresh();

        apply_stored_user(&[user(&tenant, &userid, &["a"])], &userid, &tenant);

        assert_eq!(
            live_roles(&userid, &tenant),
            Some(HashSet::from(["a".to_owned()]))
        );
    }

    // Like the querier's user deletion, the live groups must forget the user.
    #[tokio::test]
    async fn deleted_user_is_removed_from_live_groups() {
        // Other modules' tests watch the RBAC map locks; see `map::TEST_SERIAL`.
        let _serial = TEST_SERIAL.lock().await;
        init_auth_maps();
        let (tenant, userid) = fresh();
        let tenant_name = tenant.clone().unwrap();
        live_with_session(&user(&tenant, &userid, &[]));
        let member = |id: &str| GroupUser {
            userid: id.to_owned(),
            username: id.to_owned(),
            method: "native".to_owned(),
            tenant_id: tenant.clone(),
        };
        write_user_groups().insert(
            UserGroup {
                name: "group".to_owned(),
                roles: HashSet::new(),
                users: HashSet::from([member(&userid), member("other")]),
            },
            &tenant_name,
        );

        apply_stored_user(&[], &userid, &tenant);

        let groups = read_user_groups();
        let users = &groups
            .get(&tenant_name)
            .unwrap()
            .get("group")
            .unwrap()
            .users;
        assert_eq!(users, &HashSet::from([member("other")]));
    }

    // API-key revocation goes through the same delete sync. The sender removes
    // the key from storage first, so the sync must drop the live key.
    #[tokio::test]
    async fn deleted_api_key_is_removed_and_stored_key_installed() {
        // Other modules' tests watch the RBAC map locks; see `map::TEST_SERIAL`.
        let _serial = TEST_SERIAL.lock().await;
        init_auth_maps();
        let tenant = Some(format!("ingestor-user-{}", Ulid::new()));
        let key = ParseableUser::new_api_key(
            Ulid::new(),
            "secret".to_owned(),
            "key".to_owned(),
            HashSet::from(["a".to_owned()]),
            "admin".to_owned(),
            tenant.clone(),
        );
        let keyid = key.userid().to_owned();

        apply_stored_user(std::slice::from_ref(&key), &keyid, &tenant);
        assert_eq!(Users.get_user(&keyid, &tenant), Some(key));

        apply_stored_user(&[], &keyid, &tenant);
        assert_eq!(Users.get_user(&keyid, &tenant), None);
    }

    #[tokio::test]
    async fn deleting_a_user_leaves_the_same_userid_in_other_tenants() {
        // Other modules' tests watch the RBAC map locks; see `map::TEST_SERIAL`.
        let _serial = TEST_SERIAL.lock().await;
        init_auth_maps();
        let (tenant, userid) = fresh();
        let (other_tenant, _) = fresh();
        let other = user(&other_tenant, &userid, &["a"]);
        live_with_session(&user(&tenant, &userid, &["a"]));
        live_with_session(&other);

        apply_stored_user(&[], &userid, &tenant);

        assert_eq!(Users.get_user(&userid, &tenant), None);
        assert_eq!(Users.get_user(&userid, &other_tenant), Some(other));
    }
}
