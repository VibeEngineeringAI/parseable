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

use actix_web::{
    HttpRequest, HttpResponse, Responder,
    web::{self, Json},
};

use crate::{
    handlers::http::{
        cluster::{sync_role_delete, sync_role_update},
        modal::utils::rbac_utils::{get_metadata, put_metadata},
        role::RoleError,
    },
    parseable::DEFAULT_TENANT,
    rbac::{
        map::{mut_roles, mut_sessions, read_user_groups, roles, users},
        role::model::{Role, RoleType},
        roles_to_permission,
    },
    utils::{get_tenant_id_from_request, get_user_from_request},
    validator,
};

// Handler for PUT /api/v1/role/{name}
// Creates a new role or update existing one
pub async fn put(
    req: HttpRequest,
    name: web::Path<String>,
    Json(body): Json<Role>,
) -> Result<impl Responder, RoleError> {
    let name = name.into_inner();
    let tenant_id = get_tenant_id_from_request(&req);
    let tenant = tenant_id.as_deref().unwrap_or(DEFAULT_TENANT);
    // extract caller userid early, before any session mutations
    let caller_userid =
        get_user_from_request(&req).map_err(|e| RoleError::Anyhow(anyhow::anyhow!("{e}")))?;
    // validate the role name
    validator::user_role_name(&name).map_err(RoleError::ValidationError)?;

    // if role exists, then it should not be an internal role
    let role = if let Some(tenant_roles) = mut_roles().get_mut(tenant)
        && let Some(role) = tenant_roles.get_mut(&name)
    {
        if role.role_type().eq(&RoleType::Internal) {
            return Err(RoleError::ProtectedRole);
        } else {
            // role exists and is not internal, can proceed with modification
            *role = body;
            role.clone()
        }
    } else {
        body
    };

    if role.deny_super_admin() {
        return Err(RoleError::SuperAdminPrivilege);
    }

    let mut metadata = get_metadata(&tenant_id).await?;
    metadata.roles.insert(name.clone(), role.clone());

    put_metadata(&metadata, &tenant_id).await?;
    mut_roles()
        .entry(tenant.to_owned())
        .or_default()
        .insert(name.clone(), role.clone());

    // refresh the sessions of all users using this role
    // for this, iterate over all user_groups and users and create a hashset of users
    let mut session_refresh_users: HashSet<String> = HashSet::new();
    if let Some(groups) = read_user_groups().get(tenant) {
        for user_group in groups.values() {
            if user_group.roles.contains(&name) {
                session_refresh_users
                    .extend(user_group.users.iter().map(|u| u.userid().to_string()));
            }
        }
    }

    // iterate over all users to see if they have this role
    if let Some(users) = users().get(tenant) {
        for user in users.values() {
            if user.roles.contains(&name) {
                session_refresh_users.insert(user.userid().to_string());
            }
        }
    }

    {
        let mut sessions = mut_sessions();
        for userid in &session_refresh_users {
            if let Some(tenant_users) = users().get(tenant)
                && let Some(user) = tenant_users.get(userid)
            {
                let new_perms = roles_to_permission(user.roles(), tenant);
                sessions.refresh_user_permissions(userid, tenant, &new_perms);
            }
        }
    }

    if let Err(e) = sync_role_update(&req, name.clone(), role, &tenant_id, &caller_userid).await {
        tracing::error!("Failed to sync role update to cluster nodes: {e}");
    }

    Ok(HttpResponse::Ok().finish())
}

// Handler for DELETE /api/v1/role/{name}
// Delete existing role
pub async fn delete(
    req: HttpRequest,
    name: web::Path<String>,
) -> Result<impl Responder, RoleError> {
    let name = name.into_inner();
    let tenant_id = get_tenant_id_from_request(&req);
    let tenant = tenant_id.as_deref().unwrap_or(DEFAULT_TENANT);
    // extract caller userid early, before any session mutations
    let caller_userid =
        get_user_from_request(&req).map_err(|e| RoleError::Anyhow(anyhow::anyhow!("{e}")))?;
    if let Some(tenant_roles) = roles().get(tenant)
        && let Some(role) = tenant_roles.get(&name)
        && role.role_type().eq(&RoleType::Internal)
    {
        return Err(RoleError::ProtectedRole);
    }

    // check if the role is being used by any user or group
    let mut metadata = get_metadata(&tenant_id).await?;
    if metadata.users.iter().any(|user| user.roles.contains(&name)) {
        return Err(RoleError::RoleInUse);
    }
    if metadata
        .user_groups
        .iter()
        .any(|user_group| user_group.roles.contains(&name))
    {
        return Err(RoleError::RoleInUse);
    }
    metadata.roles.remove(&name);
    put_metadata(&metadata, &tenant_id).await?;

    mut_roles()
        .entry(tenant.to_owned())
        .or_default()
        .remove(&name);
    // mut_roles().remove(&name);

    // refresh the sessions of all users using this role
    // for this, iterate over all user_groups and users and create a hashset of users
    let mut session_refresh_users: HashSet<String> = HashSet::new();
    if let Some(groups) = read_user_groups().get(tenant) {
        for user_group in groups.values() {
            if user_group.roles.contains(&name) {
                session_refresh_users
                    .extend(user_group.users.iter().map(|u| u.userid().to_string()));
            }
        }
    }

    // iterate over all users to see if they have this role
    if let Some(users) = users().get(tenant) {
        for user in users.values() {
            if user.roles.contains(&name) {
                session_refresh_users.insert(user.userid().to_string());
            }
        }
    }

    {
        let mut sessions = mut_sessions();
        for userid in &session_refresh_users {
            if let Some(tenant_users) = users().get(tenant)
                && let Some(user) = tenant_users.get(userid)
            {
                let new_perms = roles_to_permission(user.roles(), tenant);
                sessions.refresh_user_permissions(userid, tenant, &new_perms);
            }
        }
    }

    if let Err(e) = sync_role_delete(&req, name.clone(), &tenant_id, &caller_userid).await {
        tracing::error!("Failed to sync role deletion to cluster nodes: {e}");
    }

    Ok(HttpResponse::Ok().finish())
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use actix_web::{HttpMessage, ResponseError, http::StatusCode, test::TestRequest};
    use chrono::TimeDelta;
    use parking_lot::RwLock;
    use ulid::Ulid;

    use super::*;
    use crate::{
        handlers::TENANT_ID,
        rbac::{
            Users,
            map::{
                ROLES, SESSIONS, SessionKey, Sessions, USER_GROUPS, USERS, UserGroups,
                Users as UserMap, mut_users,
            },
            role::model::DefaultPrivilege,
            user::{Basic, User, UserType},
        },
    };

    const ROLE: &str = "readers";

    // `rbac::map::init` needs `PARSEABLE`, so tests create the maps directly.
    fn init_auth_maps() {
        USERS.get_or_init(|| RwLock::new(UserMap::default()));
        SESSIONS.get_or_init(|| RwLock::new(Sessions::default()));
        USER_GROUPS.get_or_init(|| RwLock::new(UserGroups::default()));
        ROLES.get_or_init(|| RwLock::new(HashMap::new()));
    }

    fn reader_role() -> Role {
        Role::create_user_role(vec![DefaultPrivilege::Reader { resource: None }])
    }

    /// A fresh tenant holding one ordinary role, and a request from a user with
    /// a live session in that tenant.
    fn tenant_request() -> (String, HttpRequest) {
        init_auth_maps();
        let tenant = format!("querier-role-{}", Ulid::new());
        mut_roles()
            .entry(tenant.clone())
            .or_default()
            .insert(ROLE.to_owned(), reader_role());
        let caller = User {
            ty: UserType::Native(Basic {
                username: format!("caller-{}", Ulid::new()),
                password_hash: String::new(),
                email: None,
            }),
            roles: HashSet::from([ROLE.to_owned()]),
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
        (tenant, req)
    }

    #[tokio::test]
    async fn rejected_super_admin_update_leaves_live_role_unchanged() {
        let (tenant, req) = tenant_request();
        let body = Role::create_user_role(vec![DefaultPrivilege::SuperAdmin]);

        let Err(err) = put(req, web::Path::from(ROLE.to_owned()), Json(body)).await else {
            panic!("SuperAdmin role update must be rejected");
        };
        assert!(matches!(err, RoleError::SuperAdminPrivilege), "{err:?}");
        assert_eq!(err.status_code(), StatusCode::BAD_REQUEST);

        let live = roles().get(&tenant).and_then(|r| r.get(ROLE)).cloned();
        assert_eq!(
            live,
            Some(reader_role()),
            "rejected update must not change the live role"
        );
    }
}
