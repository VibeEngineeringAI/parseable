# OIDC roles and smoke testing

Parseable requests the scopes in `P_OIDC_SCOPE`. For Pocket ID group role mapping, include `groups`, for example:

```sh
P_OIDC_SCOPE='openid profile email groups'
```

The `groups` claim contains each group's machine name. Create a Parseable role with the exact same name to grant it to an OIDC user. Role grants are reconciled from validated ID-token groups during sign-in and token refresh. Parseable tracks provider grants separately from roles an administrator assigns by hand, so a provider group removal removes only that provider grant. An administrator cannot remove a provider-only grant directly; change the user's group at the provider. If an administrator separately assigns the same role, that manual grant remains after the group is removed.

The configured default role applies when an OAuth user has no provider or manual grants. It must name an existing user role. Internal roles such as `super-admin` cannot be used as the default. Clearing the default removes default grants from existing OAuth users, persists the change, and invalidates their sessions.

## Sign out from an error screen

Application initialization errors retain the account avatar and its Logout menu.
Route errors, the root error boundary, No access, and 404 pages also provide an
account icon with Sign out when the full account interface is unavailable. Route
recovery stays inside the error panel so it does not obscure the normal avatar.

The fallback invalidates the Parseable session and returns to `/login` without
following the provider's logout page. Choose Login with OAuth to obtain fresh
group claims. If sign-out fails, the menu displays the failure and allows retry.
Refresh tabs opened before deployment to load these controls. This recovery UI
does not change role grants or Pocket ID group membership.

## Isolated integration smoke test

Build Parseable before running the smoke test. The test starts its own Parseable `local-store` subprocess and a local mock OIDC issuer, each on temporary ports. It uses new temporary data and staging directories and fixed, test-only client credentials. It never reads the shell's Parseable/OIDC variables, `.env` files, or an existing Parseable data directory. It needs Python 3 and the OpenSSL CLI. The generated RSA private key and the entire temporary runtime are deleted on exit.

```sh
PARSEABLE_BIN=/absolute/path/to/parseable \
  python3 scripts/test-oidc.py
```

The check performs an authorization-code login through Parseable's login redirect and callback. Its mock issuer serves discovery and JWKS, signs ID tokens with a temporary RS256 key, and uses single-use rotating refresh tokens. It creates a disposable stream and verifies that a group-mapped Reader can access it. After group removal, two concurrent requests share one refresh and both lose access. The check also rejects unknown and internal defaults, protects provider-only grants from manual removal, preserves overlapping manual grants, handles a missing groups claim, applies and clears the default role, fails closed when refresh omits its signed ID token, and verifies that logout or default-role removal during a blocked refresh cannot recreate the session.

Do not point this test at the production server or a real Pocket ID instance; `PARSEABLE_BIN` must name a local executable. The process is stopped and its temporary data is removed whether the check passes or fails.

## Optional Pocket ID fixture

For a manual check against a dedicated Pocket ID test instance:

1. Use the existing test OIDC client or create a disposable one. Set its callback URL to `http://<parseable-host>:<port>/api/v1/o/code`, and request the `groups` scope from Parseable. Make sure the client still allows the test user to sign in after the role group is removed. If Pocket ID restricts the client to allowed groups, leave access unrestricted for this test or keep the test user in a second allowed group.
2. In Pocket ID, open **Administration → User Groups** and create a group with machine name `parseable-oidc-test-readers`. In **Administration → Users**, create a dedicated test account and add it to this group. Complete sign-in setup for that account, such as registering its passkey.
3. In Parseable, create a role named exactly `parseable-oidc-test-readers`. Sign in using the dedicated test account and confirm the role appears in the user's direct roles.
4. Remove the test account from the Pocket ID group. On the next Parseable authorization refresh, the provider grant should disappear while any separately assigned manual roles remain. Active sessions revalidate at most every five minutes, and sooner when the provider access or ID token expires.

Pocket ID documents that `groups` is an optional scope, that its value is an array of machine group names, and that group membership controls those values in the ID token and userinfo response: [Scopes and claims](https://pocket-id.org/docs/guides/scopes-and-claims), [User management](https://pocket-id.org/docs/setup/user-management). Use a separate test client and test account, and avoid modifying a production user's group membership for this check.

## Authorization lifecycle and migration

The supported, advertised deployment for the OIDC administration UI is standalone
(`Mode::All`). Distributed synchronization has not been verified by this change.
The group view explains existing exact-name role mappings; it does not provision
Pocket ID groups or enable Enterprise native-group CRUD.

New OAuth identities use a Parseable ID derived from the validated issuer and
subject. ID-token and userinfo subjects must agree. Native users are never linked
by matching email, display name, or subject. Legacy OAuth records without an
issuer binding are matched only by an exact stored subject; ambiguous matches
fail authentication. Their old flat role sets and local-group membership have no
trusted provenance, so first verified migration resets them and applies current
provider/default grants. Review existing accounts before rollout and explicitly
regrant intended manual access after migration. Changing legacy user IDs also
requires reviewing resources that refer to their former IDs; automatic migration
of dashboard or alert ownership is not part of this change.

`GET /api/v1/user/{userid}/role` includes an `oidc` object for OAuth users with
issuer, observed groups, manual/provider roles, configured fallback and legacy
status. It never includes bearer credentials. The configured fallback is
inactive when manual or provider roles supply access. Role removal through the
manual-role API only removes manual grants; it cannot override a matching
provider grant. The role inspector shows this distinction.

The five-minute revalidation bound applies to active cookie-authenticated
requests. Providers that cannot return a fresh signed ID token during refresh
require a new sign-in. Dormant users and background jobs do not poll the identity
provider; a stored role set is not a promise of continuous provider membership.
The existing callback state/nonce design was not redesigned here and requires a
separate OIDC protocol-hardening review. The built-in `reader` privilege includes
dashboard/filter writes; it is not a strict read-only UI role.
