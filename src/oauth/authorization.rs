//! Pure OIDC identity and grant reconciliation. Provider groups match role names
//! exactly; they never change Parseable's administratively managed user groups.
use std::collections::{HashMap, HashSet};

use sha2::{Digest, Sha256};

use crate::rbac::{
    role::model::{Role, RoleType},
    user::{OAuthRoleGrants, User, UserType},
};

/// Namespaced IDs prevent one issuer's subject from colliding with another issuer
/// or a native username. Tenant isolation is supplied by the enclosing user map.
pub fn oidc_user_id(issuer: &str, subject: &str) -> String {
    let mut digest = Sha256::new();
    digest.update((issuer.len() as u64).to_be_bytes());
    digest.update(issuer.as_bytes());
    digest.update(subject.as_bytes());
    format!("oidc-{:x}", digest.finalize())
}

pub fn matching_identity(user: &User, issuer: &str, subject: &str) -> bool {
    matches!(&user.ty, UserType::OAuth(oauth)
        if oauth.issuer.as_deref() == Some(issuer)
            && oauth.user_info.sub.as_deref() == Some(subject))
}

pub fn legacy_identity(user: &User, subject: &str) -> bool {
    matches!(&user.ty, UserType::OAuth(oauth)
        if oauth.issuer.is_none() && oauth.user_info.sub.as_deref() == Some(subject))
}

/// Recompute all provider/default grants. Legacy flat roles cannot safely be
/// classified as manual; only an explicit grant recorded in provenance survives.
pub fn reconcile_roles(
    existing_user: Option<&User>,
    groups: &HashSet<String>,
    roles: &HashMap<String, Role>,
    default_role: Option<&str>,
) -> OAuthRoleGrants {
    let valid_role = |name: &str| {
        roles
            .get(name)
            .is_some_and(|role| role.role_type() != &RoleType::Internal && !role.deny_super_admin())
    };
    let manual_roles = existing_user
        .filter(|user| matches!(&user.ty, UserType::OAuth(oauth) if oauth.issuer.is_some()))
        .map(User::manual_roles)
        .unwrap_or_default()
        .into_iter()
        .filter(|role| valid_role(role))
        .collect();
    let provider_roles = groups
        .iter()
        .filter(|group| valid_role(group))
        .cloned()
        .collect();
    let default_role = default_role
        .filter(|role| valid_role(role))
        .map(str::to_owned);
    OAuthRoleGrants {
        observed_groups: groups.clone(),
        manual_roles,
        provider_roles,
        default_role,
    }
}

/// Missing groups means no provider grants. A malformed claim fails closed.
pub fn parse_groups(value: Option<&serde_json::Value>) -> Result<HashSet<String>, anyhow::Error> {
    match value {
        None => Ok(HashSet::new()),
        Some(value) => Ok(serde_json::from_value::<HashSet<String>>(value.clone())
            .map_err(|_| anyhow::anyhow!("OIDC groups claim must be an array of strings"))?),
    }
}

pub fn validate_subjects(
    id_subject: &str,
    userinfo_subject: Option<&str>,
) -> Result<(), anyhow::Error> {
    anyhow::ensure!(
        !id_subject.is_empty() && userinfo_subject == Some(id_subject),
        "OIDC ID token and userinfo subjects must match"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rbac::{
        role::model::{DefaultPrivilege, Role},
        user::{OAuthRoleGrants, UserInfo},
    };

    fn user_role() -> Role {
        Role::create_user_role(Vec::new())
    }

    fn user_with_grants(
        issuer: Option<&str>,
        subject: &str,
        manual: &[&str],
        provider: &[&str],
    ) -> User {
        let info = UserInfo {
            sub: Some(subject.to_owned()),
            ..UserInfo::default()
        };
        let grants = OAuthRoleGrants {
            observed_groups: provider.iter().map(|role| (*role).to_owned()).collect(),
            manual_roles: manual.iter().map(|role| (*role).to_owned()).collect(),
            provider_roles: provider.iter().map(|role| (*role).to_owned()).collect(),
            default_role: None,
        };
        let mut user = User::new_oauth(
            oidc_user_id(issuer.unwrap_or("legacy"), subject),
            grants.effective_roles(),
            info,
            None,
            None,
            false,
        );
        let UserType::OAuth(oauth) = &mut user.ty else {
            unreachable!();
        };
        oauth.issuer = issuer.map(str::to_owned);
        oauth.role_grants = Some(grants);
        user
    }

    #[test]
    fn groups_are_missing_empty_or_a_strict_array_of_strings() {
        assert!(parse_groups(None).unwrap().is_empty());
        assert_eq!(
            parse_groups(Some(&serde_json::json!(["readers", "writers", "readers"]))).unwrap(),
            HashSet::from(["readers".to_owned(), "writers".to_owned()])
        );
        assert!(parse_groups(Some(&serde_json::json!("readers"))).is_err());
        assert!(parse_groups(Some(&serde_json::json!(["readers", 7]))).is_err());
    }

    #[test]
    fn subject_must_be_nonempty_and_match_userinfo() {
        assert!(validate_subjects("subject-1", Some("subject-1")).is_ok());
        assert!(validate_subjects("subject-1", Some("subject-2")).is_err());
        assert!(validate_subjects("subject-1", None).is_err());
        assert!(validate_subjects("", Some("")).is_err());
    }

    #[test]
    fn issuer_namespaced_ids_are_stable_and_do_not_collide() {
        let first = oidc_user_id("https://issuer-one.example", "same-subject");
        assert_eq!(
            first,
            oidc_user_id("https://issuer-one.example", "same-subject")
        );
        assert_ne!(
            first,
            oidc_user_id("https://issuer-two.example", "same-subject")
        );
        assert_ne!(
            first,
            oidc_user_id("https://issuer-one.example", "other-subject")
        );

        let user = user_with_grants(Some("https://issuer-one.example"), "same-subject", &[], &[]);
        assert!(matching_identity(
            &user,
            "https://issuer-one.example",
            "same-subject"
        ));
        assert!(!matching_identity(
            &user,
            "https://issuer-two.example",
            "same-subject"
        ));
        assert!(!matching_identity(
            &user,
            "https://issuer-one.example",
            "other-subject"
        ));
    }

    #[test]
    fn exact_multiple_group_names_map_to_user_roles_only() {
        let roles = HashMap::from([
            ("readers".to_owned(), user_role()),
            ("readers-extra".to_owned(), user_role()),
            (
                "internal-role".to_owned(),
                Role::create_internal_role(Vec::new()),
            ),
            (
                "super-role".to_owned(),
                Role::create_user_role(vec![DefaultPrivilege::SuperAdmin]),
            ),
        ]);
        let groups = HashSet::from([
            "readers".to_owned(),
            "readers-extra".to_owned(),
            "reader".to_owned(),
            "internal-role".to_owned(),
            "super-role".to_owned(),
            "unmapped".to_owned(),
        ]);

        let grants = reconcile_roles(None, &groups, &roles, None);
        assert_eq!(
            grants.provider_roles,
            HashSet::from(["readers".to_owned(), "readers-extra".to_owned()])
        );
        assert_eq!(grants.observed_groups, groups);
        assert!(grants.manual_roles.is_empty());
        assert!(grants.default_role.is_none());
    }

    #[test]
    fn refreshed_groups_remove_provider_roles_and_keep_overlapping_manual_grants() {
        let roles = HashMap::from([
            ("shared".to_owned(), user_role()),
            ("old-provider".to_owned(), user_role()),
            ("manual-only".to_owned(), user_role()),
            ("new-provider".to_owned(), user_role()),
        ]);
        let existing = user_with_grants(
            Some("https://issuer.example"),
            "subject",
            &["shared", "manual-only"],
            &["shared", "old-provider"],
        );
        let groups = HashSet::from(["new-provider".to_owned()]);

        let refreshed = reconcile_roles(Some(&existing), &groups, &roles, None);
        assert_eq!(
            refreshed.manual_roles,
            HashSet::from(["shared".to_owned(), "manual-only".to_owned(),])
        );
        assert_eq!(
            refreshed.provider_roles,
            HashSet::from(["new-provider".to_owned()])
        );
        assert!(!refreshed.provider_roles.contains("old-provider"));
        assert_eq!(
            refreshed.effective_roles(),
            HashSet::from([
                "shared".to_owned(),
                "manual-only".to_owned(),
                "new-provider".to_owned(),
            ])
        );
    }

    #[test]
    fn legacy_flat_roles_are_not_assumed_to_be_manual() {
        let roles = HashMap::from([
            ("ambiguous-legacy-role".to_owned(), user_role()),
            ("provider-role".to_owned(), user_role()),
        ]);
        let legacy = user_with_grants(None, "subject", &["ambiguous-legacy-role"], &[]);
        // Legacy records predate reliable provenance; model one by removing it.
        let mut legacy = legacy;
        if let UserType::OAuth(oauth) = &mut legacy.ty {
            oauth.role_grants = None;
        }
        legacy.roles = HashSet::from(["ambiguous-legacy-role".to_owned()]);

        assert!(legacy_identity(&legacy, "subject"));
        assert!(!matching_identity(
            &legacy,
            "https://issuer.example",
            "subject"
        ));
        let reconciled = reconcile_roles(Some(&legacy), &HashSet::new(), &roles, None);
        assert!(reconciled.manual_roles.is_empty());
        assert!(reconciled.provider_roles.is_empty());
        assert!(reconciled.effective_roles().is_empty());
    }
}
