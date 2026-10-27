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

use actix_web::{HttpRequest, HttpResponse, Responder, web};

use crate::{
    handlers::http::{
        cluster::{
            sync_password_reset_with_ingestors, sync_user_creation,
            sync_user_deletion_with_ingestors, sync_users_with_roles_with_ingestors,
        },
        modal::utils::rbac_utils::{get_metadata, put_metadata},
        rbac::{RBACError, UPDATE_LOCK},
    },
    parseable::{DEFAULT_TENANT, PARSEABLE},
    rbac::{
        Users,
        map::{read_user_groups, roles, users, write_user_groups},
        role::model::RoleType,
        user::{self, UserType},
    },
    tenants::TENANT_METADATA,
    utils::{get_tenant_id_from_request, get_user_from_request},
    validator,
};

// Handler for POST /api/v1/user/{userid}
// Creates a new user by username if it does not exists
pub async fn post_user(
    req: HttpRequest,
    userid: web::Path<String>,
    body: Option<web::Json<serde_json::Value>>,
) -> Result<impl Responder, RBACError> {
    let username = userid.into_inner();
    let tenant_id = get_tenant_id_from_request(&req)?;
    let caller_userid = get_user_from_request(&req)?;
    validator::user_role_name(&username)?;
    let _guard = UPDATE_LOCK.lock().await;

    let user_roles: HashSet<String> = if let Some(body) = body {
        serde_json::from_value(body.into_inner())?
    } else {
        HashSet::new()
    };

    let mut non_existent_roles = Vec::new();
    for role in &user_roles {
        let tenant = tenant_id.as_deref().unwrap_or(DEFAULT_TENANT);
        let role_exists = roles()
            .get(tenant)
            .map(|tenant_roles| tenant_roles.contains_key(role))
            .unwrap_or(false);
        if !role_exists {
            non_existent_roles.push(role.clone());
        }
    }
    if !non_existent_roles.is_empty() {
        return Err(RBACError::RolesDoNotExist(non_existent_roles));
    }
    // Standalone reads protected users from metadata; the in-memory map is
    // loaded from it and kept in step, and is checked before any storage call.
    if Users.any_role_held_by_protected_user(&user_roles, &tenant_id) {
        return Err(RBACError::ProtectedRole);
    }
    if let Some(tenant_roles) = roles().get(tenant_id.as_deref().unwrap_or(DEFAULT_TENANT))
        && user_roles.iter().any(|name| {
            tenant_roles.get(name).is_some_and(|role| {
                role.role_type() == &RoleType::Internal || role.deny_super_admin()
            })
        })
    {
        return Err(RBACError::ProtectedRole);
    }
    let mut metadata = get_metadata(&tenant_id).await?;
    if Users.contains(&username, &tenant_id)
        || metadata
            .users
            .iter()
            .any(|user| matches!(&user.ty, UserType::Native(basic) if basic.username == username))
    {
        return Err(RBACError::UserExists(username));
    }

    let (mut user, password) = user::User::new_basic(username.clone(), tenant_id.clone(), false);
    // add user roles
    user.roles.clone_from(&user_roles);
    metadata.users.push(user.clone());

    put_metadata(&metadata, &tenant_id).await?;
    // let created_role = user_roles.clone();
    Users.put_user(user.clone());

    best_effort_sync(
        sync_user_creation(&req, user, &None, &tenant_id, &caller_userid).await,
        "Failed to sync user creation to cluster nodes",
    )?;

    Ok(password)
}

// Handler for DELETE /api/v1/user/{userid}
pub async fn delete_user(
    req: HttpRequest,
    userid: web::Path<String>,
) -> Result<impl Responder, RBACError> {
    let userid = userid.into_inner();
    let tenant_id = get_tenant_id_from_request(&req)?;
    let caller_userid = get_user_from_request(&req)?;
    let tenant = tenant_id.as_deref().unwrap_or(DEFAULT_TENANT);
    let _guard = UPDATE_LOCK.lock().await;
    // fail this request if the user is protected
    if Users.is_protected(&userid, &tenant_id) == Some(true) {
        return Err(RBACError::ProtectedUser);
    }
    // fail this request if the user does not exist
    if !Users.contains(&userid, &tenant_id) {
        return Err(RBACError::UserDoesNotExist);
    };

    // find username by userid, for native users, username is userid, for oauth users, we need to look up
    let username = if let Some(users) = users().get(tenant)
        && let Some(user) = users.get(&userid)
    {
        user.username_by_userid()
    } else {
        return Err(RBACError::UserDoesNotExist);
    };

    // delete from parseable.json first
    let mut metadata = get_metadata(&tenant_id).await?;
    metadata.users.retain(|user| user.userid() != userid);

    // also delete from user groups
    let groups_to_update = remove_user_from_groups(&userid, &tenant_id)?;

    // For each updated group, replace in place if found; otherwise push
    for updated_group in &groups_to_update {
        if let Some(existing) = metadata
            .user_groups
            .iter_mut()
            .find(|ug| ug.name == updated_group.name)
        {
            existing.clone_from(updated_group);
        } else {
            metadata.user_groups.push(updated_group.clone());
        }
    }
    put_metadata(&metadata, &tenant_id).await?;
    apply_user_removal_to_groups(&userid, &tenant_id, &groups_to_update);

    let synced = best_effort_sync(
        sync_user_deletion_with_ingestors(&req, &userid, &tenant_id, &caller_userid).await,
        "Failed to sync user deletion to cluster nodes",
    );

    // update in mem table
    Users.delete_user(&userid, &tenant_id);
    synced?;
    Ok(HttpResponse::Ok().json(format!("deleted user: {username}")))
}

/// Returns copies of the user's groups with the member removed, without storing
/// them. Caller holds `UPDATE_LOCK` and persists them before applying the removal.
pub(crate) fn remove_user_from_groups(
    userid: &str,
    tenant_id: &Option<String>,
) -> Result<Vec<user::UserGroup>, RBACError> {
    let tenant = tenant_id.as_deref().unwrap_or(DEFAULT_TENANT);
    let Some(member_id) = Users
        .get_user(userid, tenant_id)
        .map(|user| match &user.ty {
            UserType::Native(basic) => basic.username.clone(),
            UserType::OAuth(oauth) => oauth.userid.clone(),
            UserType::ApiKey(api_key) => api_key.userid.clone(),
        })
    else {
        return Ok(Vec::new());
    };
    let mut groups_to_update = Vec::new();

    for user_group in Users.get_user_groups(userid, tenant_id) {
        // Removing members refreshes sessions, which comes first in the lock
        // order (see `rbac::map`): update a copy without holding USER_GROUPS.
        let Some(mut ug) = read_user_groups()
            .get(tenant)
            .and_then(|groups| groups.get(&user_group))
            .cloned()
        else {
            continue;
        };
        ug.remove_users_by_user_ids(HashSet::from_iter([member_id.clone()]))?;
        groups_to_update.push(ug);
    }
    Ok(groups_to_update)
}

pub(crate) fn apply_user_removal_to_groups(
    userid: &str,
    tenant_id: &Option<String>,
    groups_to_update: &[user::UserGroup],
) {
    let tenant = tenant_id.as_deref().unwrap_or(DEFAULT_TENANT);
    if let Some(groups) = write_user_groups().get_mut(tenant) {
        for updated_group in groups_to_update {
            if let Some(stored) = groups.get_mut(&updated_group.name) {
                // Preserve any other membership or role changes since the copy was made.
                stored.users.retain(|member| member.userid() != userid);
            }
        }
    }
}

// Handler PATCH /user/{userid}/role/add => Add roles to a user
pub async fn add_roles_to_user(
    req: HttpRequest,
    userid: web::Path<String>,
    roles_to_add: web::Json<HashSet<String>>,
) -> Result<String, RBACError> {
    let userid = userid.into_inner();
    let roles_to_add = roles_to_add.into_inner();
    let tenant_id = get_tenant_id_from_request(&req)?;
    let _guard = UPDATE_LOCK.lock().await;
    let caller_userid = get_user_from_request(&req)?;
    if !Users.contains(&userid, &tenant_id) {
        return Err(RBACError::UserDoesNotExist);
    };

    // Protected checks come before the existence check, as in the standalone handler.
    if Users.is_protected(&userid, &tenant_id) == Some(true) {
        return Err(RBACError::ProtectedUser);
    }

    if Users.any_role_held_by_protected_user(&roles_to_add, &tenant_id) {
        return Err(RBACError::ProtectedRole);
    }

    let tenant = tenant_id.as_deref().unwrap_or(DEFAULT_TENANT);
    // find username by userid, for native users, username is userid, for oauth users, we need to look up
    let username = if let Some(users) = users().get(tenant)
        && let Some(user) = users.get(&userid)
    {
        user.username_by_userid()
    } else {
        return Err(RBACError::UserDoesNotExist);
    };

    if let Some(tenant_roles) = roles().get(tenant)
        && roles_to_add.iter().any(|name| {
            tenant_roles.get(name).is_some_and(|role| {
                role.role_type() == &RoleType::Internal || role.deny_super_admin()
            })
        })
    {
        return Err(RBACError::ProtectedRole);
    }

    let mut non_existent_roles = Vec::new();

    // check if the role exists
    roles_to_add.iter().for_each(|r| {
        if let Some(tenant_roles) = roles().get(tenant)
            && tenant_roles.get(r).is_none()
        {
            non_existent_roles.push(r.clone());
        }
    });

    if !non_existent_roles.is_empty() {
        return Err(RBACError::RolesDoNotExist(non_existent_roles));
    }

    // update parseable.json first
    let mut metadata = get_metadata(&tenant_id).await?;
    if let Some(user) = metadata
        .users
        .iter_mut()
        .find(|user| user.userid() == userid)
    {
        let mut manual = user.manual_roles();
        manual.extend(roles_to_add.clone());
        user.set_manual_roles(manual);
    } else {
        // should be unreachable given state is always consistent
        return Err(RBACError::UserDoesNotExist);
    }

    put_metadata(&metadata, &tenant_id).await?;

    // sync to other nodes before updating in-memory (which invalidates sessions)
    let synced = best_effort_sync(
        sync_users_with_roles_with_ingestors(
            &req,
            &userid,
            &roles_to_add,
            "add",
            &tenant_id,
            &caller_userid,
        )
        .await,
        "Failed to sync role addition to cluster nodes",
    );

    // update in mem table (this invalidates the user's session)
    Users.add_roles(&userid.clone(), roles_to_add.clone(), &tenant_id);
    synced?;

    Ok(format!("Roles updated successfully for {username}"))
}

// Handler PATCH /user/{userid}/role/remove => Remove roles from a user
pub async fn remove_roles_from_user(
    req: HttpRequest,
    userid: web::Path<String>,
    roles_to_remove: web::Json<HashSet<String>>,
) -> Result<impl Responder, RBACError> {
    let userid = userid.into_inner();
    let roles_to_remove = roles_to_remove.into_inner();
    let tenant_id = get_tenant_id_from_request(&req)?;
    let caller_userid = get_user_from_request(&req)?;
    let tenant = tenant_id.as_deref().unwrap_or(DEFAULT_TENANT);
    let _guard = UPDATE_LOCK.lock().await;

    if !Users.contains(&userid, &tenant_id) {
        return Err(RBACError::UserDoesNotExist);
    };

    // fail this request if the user is protected
    if Users.is_protected(&userid, &tenant_id) == Some(true) {
        return Err(RBACError::ProtectedUser);
    }

    // find username by userid, for native users, username is userid, for oauth users, we need to look up
    let username = if let Some(users) = users().get(tenant)
        && let Some(user) = users.get(&userid)
    {
        user.username_by_userid()
    } else {
        return Err(RBACError::UserDoesNotExist);
    };

    let mut non_existent_roles = Vec::new();

    // check if the role exists
    roles_to_remove.iter().for_each(|r| {
        if let Some(tenant_roles) = roles().get(tenant_id.as_deref().unwrap_or(DEFAULT_TENANT))
            && tenant_roles.get(r).is_none()
        {
            non_existent_roles.push(r.clone());
        }
    });

    if !non_existent_roles.is_empty() {
        return Err(RBACError::RolesDoNotExist(non_existent_roles));
    }

    // check for role not present with user
    let user_roles: HashSet<String> = HashSet::from_iter(Users.get_role(&userid, &tenant_id));
    let roles_not_with_user: HashSet<String> =
        HashSet::from_iter(roles_to_remove.difference(&user_roles).cloned());
    if !roles_not_with_user.is_empty() {
        return Err(RBACError::RolesNotAssigned(Vec::from_iter(
            roles_not_with_user,
        )));
    }

    // In multi-tenant, prevent removing the admin role from the tenant owner
    if PARSEABLE.options.is_multi_tenant()
        && roles_to_remove.contains("admin")
        && let Some(tid) = tenant_id.as_deref()
    {
        let is_owner = TENANT_METADATA
            .get_tenant_meta(tid)
            .and_then(|meta| meta.owner)
            .map(|owner| owner == userid)
            .unwrap_or(false);
        if is_owner {
            return Err(RBACError::InvalidDeletionRequest(
                "Cannot remove the admin role from the tenant owner".to_string(),
            ));
        }
    }

    // update parseable.json first
    let mut metadata = get_metadata(&tenant_id).await?;
    if let Some(user) = metadata
        .users
        .iter_mut()
        .find(|user| user.userid() == userid)
    {
        let manual = user.manual_roles();
        if !roles_to_remove.is_subset(&manual) {
            return Err(RBACError::RolesManagedByOidc);
        }
        user.set_manual_roles(HashSet::from_iter(
            manual.difference(&roles_to_remove).cloned(),
        ));
    } else {
        // should be unreachable given state is always consistent
        return Err(RBACError::UserDoesNotExist);
    }

    put_metadata(&metadata, &tenant_id).await?;

    // sync to other nodes before updating in-memory (which invalidates sessions)
    let synced = best_effort_sync(
        sync_users_with_roles_with_ingestors(
            &req,
            &userid,
            &roles_to_remove,
            "remove",
            &tenant_id,
            &caller_userid,
        )
        .await,
        "Failed to sync role removal to cluster nodes",
    );

    // update in mem table (this invalidates the user's session)
    Users.remove_roles(&userid.clone(), roles_to_remove.clone(), &tenant_id);
    synced?;

    Ok(HttpResponse::Ok().json(format!("Roles updated successfully for {username}")))
}

// Handler for POST /api/v1/user/{userid}/generate-new-password
// Resets password for the user to a newly generated one and returns it
pub async fn post_gen_password(
    req: HttpRequest,
    userid: web::Path<String>,
) -> Result<impl Responder, RBACError> {
    let userid = userid.into_inner();
    let mut new_password = String::default();
    let mut new_hash = String::default();
    let tenant_id = get_tenant_id_from_request(&req)?;
    let caller_userid = get_user_from_request(&req)?;
    if Users.is_protected(&userid, &tenant_id) == Some(true) {
        return Err(RBACError::ProtectedUser);
    }
    let _guard = UPDATE_LOCK.lock().await;
    let mut metadata = get_metadata(&tenant_id).await?;

    let user::PassCode { password, hash } = user::Basic::gen_new_password();
    new_password.clone_from(&password);
    new_hash.clone_from(&hash);
    if let Some(user) = metadata
        .users
        .iter_mut()
        .filter_map(|user| match user.ty {
            user::UserType::Native(ref mut user) => Some(user),
            _ => None,
        })
        .find(|user| user.username == userid)
    {
        user.password_hash.clone_from(&hash);
    } else {
        return Err(RBACError::UserDoesNotExist);
    }
    put_metadata(&metadata, &tenant_id).await?;
    Users.change_password_hash(&userid, &new_hash, &tenant_id);

    best_effort_sync(
        sync_password_reset_with_ingestors(req, &userid, &caller_userid).await,
        "Failed to sync password reset to cluster nodes",
    )?;

    Ok(new_password)
}

/// Forwarding a change to the other nodes is best effort: a node or network
/// failure is logged and the local change still succeeds. A `HeaderBuild`
/// error means a node's forwarding headers could not be built; it retains its
/// status: 400 for a malformed client header, a generic 500 for a stored or
/// generated value. Callers apply the local in-memory change first.
fn best_effort_sync(result: Result<(), RBACError>, context: &str) -> Result<(), RBACError> {
    match result {
        Ok(()) => Ok(()),
        Err(e @ RBACError::HeaderBuild(_)) => Err(e),
        Err(e) => {
            tracing::error!("{context}: {e}");
            Ok(())
        }
    }
}

#[cfg(test)]
mod role_escalation {
    // Removing a protected check lets the handler reach `get_metadata`, which
    // initialises PARSEABLE and parses the test binary's args. Clap then exits
    // the process with code 2 (`unrecognized subcommand`); that symptom means a
    // check was removed.
    use std::collections::HashMap;

    use actix_web::{HttpMessage, ResponseError, http::StatusCode, test::TestRequest};
    use chrono::TimeDelta;
    use parking_lot::RwLock;
    use ulid::Ulid;

    use super::*;
    use crate::{
        handlers::TENANT_ID,
        rbac::{
            map::{
                ROLES, SESSIONS, SessionKey, Sessions, TEST_SERIAL, USER_GROUPS, USERS, UserGroups,
                Users as UserMap, mut_roles, mut_users,
            },
            role::model::{DefaultPrivilege, Role},
            user::{Basic, User},
        },
    };

    fn tenant_request(role: Role) -> (String, String, HttpRequest) {
        USERS.get_or_init(|| RwLock::new(UserMap::default()));
        SESSIONS.get_or_init(|| RwLock::new(Sessions::default()));
        USER_GROUPS.get_or_init(|| RwLock::new(UserGroups::default()));
        ROLES.get_or_init(|| RwLock::new(HashMap::new()));
        let tenant = format!("querier-user-{}", Ulid::new());
        mut_roles().insert(
            tenant.clone(),
            HashMap::from([
                ("elevated".to_owned(), role),
                (
                    "admin".to_owned(),
                    Role::create_user_role(vec![DefaultPrivilege::Admin]),
                ),
            ]),
        );
        let caller = User {
            ty: UserType::Native(Basic {
                username: format!("admin-{}", Ulid::new()),
                password_hash: String::new(),
                email: None,
            }),
            roles: HashSet::from(["admin".to_owned()]),
            user_groups: HashSet::new(),
            tenant: Some(tenant.clone()),
            protected: false,
        };
        mut_users().insert(caller.clone());
        let session = SessionKey::SessionId(Ulid::new());
        Users.new_session(&caller, session.clone(), TimeDelta::minutes(5));
        let req = TestRequest::default()
            .insert_header((TENANT_ID, tenant.as_str()))
            .to_http_request();
        req.extensions_mut().insert(session);
        (tenant, caller.userid().to_owned(), req)
    }

    async fn rejects_creation(role: Role) {
        let (tenant, _, req) = tenant_request(role);
        let body = web::Json(serde_json::json!(["elevated"]));
        let Err(err) = post_user(req, web::Path::from("new-user".to_owned()), Some(body)).await
        else {
            panic!("protected role assignment must be rejected before storage");
        };
        assert!(matches!(err, RBACError::ProtectedRole), "{err:?}");
        assert_eq!(err.status_code(), StatusCode::BAD_REQUEST);
        assert!(!Users.contains("new-user", &Some(tenant)));
    }

    async fn rejects_addition(role: Role) {
        let (tenant, userid, req) = tenant_request(role);
        let Err(err) = add_roles_to_user(
            req,
            web::Path::from(userid.clone()),
            web::Json(HashSet::from(["elevated".to_owned()])),
        )
        .await
        else {
            panic!("protected role assignment must be rejected before storage");
        };
        assert!(matches!(err, RBACError::ProtectedRole), "{err:?}");
        assert_eq!(err.status_code(), StatusCode::BAD_REQUEST);
        assert_eq!(
            Users.get_user(&userid, &Some(tenant)).unwrap().roles,
            HashSet::from(["admin".to_owned()])
        );
    }

    /// Adds a protected user holding `role` to `tenant`.
    fn insert_protected_user(tenant: &str, role: &str) -> String {
        let protected = User {
            ty: UserType::Native(Basic {
                username: format!("protected-{}", Ulid::new()),
                password_hash: String::new(),
                email: None,
            }),
            roles: HashSet::from([role.to_owned()]),
            user_groups: HashSet::new(),
            tenant: Some(tenant.to_owned()),
            protected: true,
        };
        mut_users().insert(protected.clone());
        protected.userid().to_owned()
    }

    fn ordinary_role() -> Role {
        Role::create_user_role(vec![DefaultPrivilege::Reader { resource: None }])
    }

    #[tokio::test]
    async fn post_gen_password_rejects_protected_user_before_storage() {
        let _serial = TEST_SERIAL.lock().await;
        let (tenant, _, req) = tenant_request(ordinary_role());
        let target = insert_protected_user(&tenant, "admin");
        let before = Users.get_user(&target, &Some(tenant.clone())).unwrap();

        let Err(err) = post_gen_password(req, web::Path::from(target.clone())).await else {
            panic!("a protected user's password must not be reset");
        };
        assert!(matches!(err, RBACError::ProtectedUser), "{err:?}");
        assert_eq!(err.status_code(), StatusCode::BAD_REQUEST);
        let after = Users.get_user(&target, &Some(tenant)).unwrap();
        let (UserType::Native(before), UserType::Native(after)) = (before.ty, after.ty) else {
            panic!("the protected user must remain native");
        };
        assert_eq!(after.password_hash, before.password_hash);
    }

    #[tokio::test]
    async fn post_gen_password_waits_for_update_lock_before_storage() {
        let _serial = TEST_SERIAL.lock().await;
        let (_, userid, req) = tenant_request(ordinary_role());
        let _guard = UPDATE_LOCK.lock().await;

        // Cancel at the lock: resuming would initialize PARSEABLE and make clap
        // parse the test arguments. Without the lock before get_metadata, this
        // test exits with code 2 instead of timing out.
        assert!(
            tokio::time::timeout(
                std::time::Duration::from_millis(50),
                post_gen_password(req, web::Path::from(userid)),
            )
            .await
            .is_err(),
            "password generation must wait for UPDATE_LOCK before reading metadata"
        );
    }

    #[tokio::test]
    async fn post_user_rejects_role_held_by_protected_user() {
        // Other modules' tests watch the RBAC map locks; see `map::TEST_SERIAL`.
        let _serial = TEST_SERIAL.lock().await;
        let (tenant, _, req) = tenant_request(ordinary_role());
        insert_protected_user(&tenant, "elevated");
        let body = web::Json(serde_json::json!(["elevated"]));
        let Err(err) = post_user(req, web::Path::from("new-user".to_owned()), Some(body)).await
        else {
            panic!("a protected user's role must be rejected before storage");
        };
        assert!(matches!(err, RBACError::ProtectedRole), "{err:?}");
        assert!(!Users.contains("new-user", &Some(tenant)));
    }

    #[tokio::test]
    async fn add_roles_rejects_role_held_by_protected_user() {
        // Other modules' tests watch the RBAC map locks; see `map::TEST_SERIAL`.
        let _serial = TEST_SERIAL.lock().await;
        let (tenant, userid, req) = tenant_request(ordinary_role());
        insert_protected_user(&tenant, "elevated");
        let Err(err) = add_roles_to_user(
            req,
            web::Path::from(userid.clone()),
            web::Json(HashSet::from(["elevated".to_owned()])),
        )
        .await
        else {
            panic!("a protected user's role must be rejected before storage");
        };
        assert!(matches!(err, RBACError::ProtectedRole), "{err:?}");
        assert_eq!(
            Users.get_user(&userid, &Some(tenant)).unwrap().roles,
            HashSet::from(["admin".to_owned()])
        );
    }

    #[tokio::test]
    async fn add_roles_rejects_protected_target_user() {
        // Other modules' tests watch the RBAC map locks; see `map::TEST_SERIAL`.
        let _serial = TEST_SERIAL.lock().await;
        let (tenant, _, req) = tenant_request(ordinary_role());
        let target = insert_protected_user(&tenant, "admin");
        let Err(err) = add_roles_to_user(
            req,
            web::Path::from(target.clone()),
            web::Json(HashSet::from(["elevated".to_owned()])),
        )
        .await
        else {
            panic!("a protected user must be rejected before storage");
        };
        assert!(matches!(err, RBACError::ProtectedUser), "{err:?}");
        assert_eq!(
            Users.get_user(&target, &Some(tenant)).unwrap().roles,
            HashSet::from(["admin".to_owned()])
        );
    }

    // Like the standalone handler, protected checks run before the existence
    // check, so a request mixing a protected and a missing role is a 400 for
    // the protected one rather than a list of missing roles.
    #[tokio::test]
    async fn add_roles_checks_protected_target_before_missing_roles() {
        // Other modules' tests watch the RBAC map locks; see `map::TEST_SERIAL`.
        let _serial = TEST_SERIAL.lock().await;
        let (tenant, _, req) = tenant_request(ordinary_role());
        let target = insert_protected_user(&tenant, "admin");
        let Err(err) = add_roles_to_user(
            req,
            web::Path::from(target),
            web::Json(HashSet::from(["missing".to_owned()])),
        )
        .await
        else {
            panic!("a protected user must be rejected");
        };
        assert!(matches!(err, RBACError::ProtectedUser), "{err:?}");
    }

    #[tokio::test]
    async fn delete_user_rejects_protected_user() {
        // Other modules' tests watch the RBAC map locks; see `map::TEST_SERIAL`.
        let _serial = TEST_SERIAL.lock().await;
        let (tenant, _, req) = tenant_request(ordinary_role());
        let target = insert_protected_user(&tenant, "admin");
        let Err(err) = delete_user(req, web::Path::from(target.clone())).await else {
            panic!("a protected user must be rejected before storage");
        };
        assert!(matches!(err, RBACError::ProtectedUser), "{err:?}");
        assert!(Users.contains(&target, &Some(tenant)));
    }

    #[tokio::test]
    async fn remove_roles_rejects_protected_user() {
        // Other modules' tests watch the RBAC map locks; see `map::TEST_SERIAL`.
        let _serial = TEST_SERIAL.lock().await;
        let (tenant, _, req) = tenant_request(ordinary_role());
        let target = insert_protected_user(&tenant, "admin");
        let Err(err) = remove_roles_from_user(
            req,
            web::Path::from(target.clone()),
            web::Json(HashSet::from(["admin".to_owned()])),
        )
        .await
        else {
            panic!("a protected user must be rejected before storage");
        };
        assert!(matches!(err, RBACError::ProtectedUser), "{err:?}");
        assert_eq!(
            Users.get_user(&target, &Some(tenant)).unwrap().roles,
            HashSet::from(["admin".to_owned()])
        );
    }

    #[tokio::test]
    async fn add_roles_checks_protected_role_before_missing_roles() {
        // Other modules' tests watch the RBAC map locks; see `map::TEST_SERIAL`.
        let _serial = TEST_SERIAL.lock().await;
        let (_, userid, req) =
            tenant_request(Role::create_internal_role(vec![DefaultPrivilege::Admin]));
        let Err(err) = add_roles_to_user(
            req,
            web::Path::from(userid),
            web::Json(HashSet::from(["elevated".to_owned(), "missing".to_owned()])),
        )
        .await
        else {
            panic!("an internal role must be rejected");
        };
        assert!(matches!(err, RBACError::ProtectedRole), "{err:?}");
    }

    #[tokio::test]
    async fn add_roles_checks_protected_user_role_before_missing_roles() {
        // Other modules' tests watch the RBAC map locks; see `map::TEST_SERIAL`.
        let _serial = TEST_SERIAL.lock().await;
        let (tenant, userid, req) = tenant_request(ordinary_role());
        insert_protected_user(&tenant, "elevated");
        let Err(err) = add_roles_to_user(
            req,
            web::Path::from(userid),
            web::Json(HashSet::from(["elevated".to_owned(), "missing".to_owned()])),
        )
        .await
        else {
            panic!("a protected user's role must be rejected");
        };
        assert!(matches!(err, RBACError::ProtectedRole), "{err:?}");
    }

    #[tokio::test]
    async fn post_user_rejects_internal_role() {
        // Other modules' tests watch the RBAC map locks; see `map::TEST_SERIAL`.
        let _serial = TEST_SERIAL.lock().await;
        rejects_creation(Role::create_internal_role(vec![DefaultPrivilege::Admin])).await;
    }

    #[tokio::test]
    async fn post_user_rejects_super_admin_role() {
        // Other modules' tests watch the RBAC map locks; see `map::TEST_SERIAL`.
        let _serial = TEST_SERIAL.lock().await;
        rejects_creation(Role::create_user_role(vec![DefaultPrivilege::SuperAdmin])).await;
    }

    #[tokio::test]
    async fn add_roles_rejects_internal_role() {
        // Other modules' tests watch the RBAC map locks; see `map::TEST_SERIAL`.
        let _serial = TEST_SERIAL.lock().await;
        rejects_addition(Role::create_internal_role(vec![DefaultPrivilege::Admin])).await;
    }

    #[tokio::test]
    async fn add_roles_rejects_super_admin_role() {
        // Other modules' tests watch the RBAC map locks; see `map::TEST_SERIAL`.
        let _serial = TEST_SERIAL.lock().await;
        rejects_addition(Role::create_user_role(vec![DefaultPrivilege::SuperAdmin])).await;
    }
}

#[cfg(test)]
mod sync_policy {
    use actix_web::{ResponseError, body::to_bytes, http::StatusCode};

    use super::*;
    use crate::utils::header_parsing::{HeaderBuildError, ParseHeaderError};

    // a request builder error, so no network is touched
    fn network_error() -> reqwest::Error {
        reqwest::Client::new().get("not a url").build().unwrap_err()
    }

    #[actix_web::test]
    async fn header_build_input_fails_the_request_with_400() {
        let err = best_effort_sync(
            Err(HeaderBuildError::Input(ParseHeaderError::InvalidTenantId).into()),
            "sync",
        )
        .unwrap_err();
        assert!(matches!(
            err,
            RBACError::HeaderBuild(HeaderBuildError::Input(ParseHeaderError::InvalidTenantId))
        ));
        assert_eq!(err.status_code(), StatusCode::BAD_REQUEST);
    }

    #[actix_web::test]
    async fn header_build_internal_fails_the_request_with_generic_500() {
        let err = best_effort_sync(
            Err(HeaderBuildError::Internal("configured username").into()),
            "sync",
        )
        .unwrap_err();
        assert!(matches!(
            err,
            RBACError::HeaderBuild(HeaderBuildError::Internal("configured username"))
        ));
        assert_eq!(err.status_code(), StatusCode::INTERNAL_SERVER_ERROR);
        let body = to_bytes(err.error_response().into_body()).await.unwrap();
        assert_eq!(body, "Failed to build internal request headers");
    }

    #[actix_web::test]
    async fn node_and_network_failures_stay_best_effort() {
        assert!(best_effort_sync(Ok(()), "sync").is_ok());
        assert!(best_effort_sync(Err(RBACError::Network(network_error())), "sync").is_ok());
        assert!(best_effort_sync(Err(anyhow::anyhow!("node info").into()), "sync").is_ok());
    }
}
