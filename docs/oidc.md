# OIDC roles and smoke testing

Parseable requests the scopes in `P_OIDC_SCOPE`. For Pocket ID group role mapping, include `groups`. Also request a refresh token, usually with `offline_access` (see [Session revalidation](#session-revalidation)):

```sh
P_OIDC_SCOPE='openid profile email groups offline_access'
```

The `groups` claim contains each group's machine name. Create a Parseable role with the exact same name to grant it to an OIDC user. Role grants are reconciled from validated ID-token groups during sign-in and token refresh. Parseable tracks provider grants separately from roles an administrator assigns by hand, so a provider group removal removes only that provider grant. An administrator cannot remove a provider-only grant directly; change the user's group at the provider. If an administrator separately assigns the same role, that manual grant remains after the group is removed.

The configured default role applies when an OAuth user has no provider or manual grants. It must name an existing user role. Internal roles such as `super-admin` cannot be used as the default. Changing or clearing the default updates default grants for existing OAuth users and persists the change. Only users whose effective roles change (those without manual or provider grants) have their sessions invalidated; everyone else stays signed in.

## Session revalidation

Active cookie sessions of OAuth users are trusted for at most `P_OIDC_REVALIDATION_INTERVAL` seconds (default `300`, minimum `30`), or less if the provider's access or ID token expires sooner. When that time is up, the next request refreshes the token and reconciles roles from the newly signed ID token's groups.

Revalidation needs a refresh token. Many providers (for example Google, and Auth0 or Okta depending on client settings) issue one only when `offline_access` (or a provider-specific equivalent such as `access_type=offline` in `P_OIDC_QUERY_PARAMS`) is requested. Without a refresh token, users must sign in again every interval, and Parseable logs a warning on the first such sign-in. Add the scope, or raise the interval to trade revocation latency for fewer sign-ins.

If the provider refuses a refresh (for example with `invalid_grant`, a missing ID token, or a changed subject or issuer), all of the user's sessions end. Transient failures, such as network errors, provider 5xx responses, or storage errors, fail only the current request with `503`. The session stays expired, so the next request retries and no request is authorized until a refresh succeeds. Refreshes are serialized per user, so a slow provider response does not delay other users.

## Sign out from an error screen

Application initialization errors retain the account avatar and its Logout menu.
Route errors, the root error boundary, No access, and 404 pages also provide an
account icon with Sign out when the full account interface is unavailable. Route
recovery stays inside the error panel so it does not obscure the normal avatar.

Sign out navigates to the server logout endpoint, which ends the Parseable
session, clears its cookies, and redirects to the provider's end-session
endpoint (when the provider has one) before returning to `/login`. Ending the
provider session lets a user who reached No access sign in as a different
account, or sign in again to obtain fresh group claims. Refresh tabs opened
before deployment to load these controls; older tabs cannot lazy-load the
replaced scripts. This recovery UI
does not change role grants or Pocket ID group membership.

## Isolated integration smoke test

Build Parseable before running the smoke test. The test starts its own Parseable `local-store` subprocess and a local mock OIDC issuer, each on temporary ports. It uses new temporary data and staging directories and fixed, test-only client credentials. It never reads the shell's Parseable/OIDC variables, `.env` files, or an existing Parseable data directory. It needs Python 3 and the OpenSSL CLI. The generated RSA private key and the entire temporary runtime are deleted on exit.

```sh
PARSEABLE_BIN=/absolute/path/to/parseable \
  python3 scripts/test-oidc.py
```

The check performs an authorization-code login through Parseable's login redirect and callback. Its mock issuer serves discovery and JWKS, signs ID tokens with a temporary RS256 key, and uses single-use rotating refresh tokens. It creates a disposable stream and verifies that a group-mapped Reader can access it. After group removal, two concurrent requests share one refresh and both lose access. The check also rejects unknown and internal defaults, protects provider-only grants from manual removal, preserves overlapping manual grants, handles a missing groups claim, applies and clears the default role, fails closed when refresh omits its signed ID token, and verifies that logout or default-role removal during a blocked refresh cannot recreate the session. It also completes a browser-style callback (HTML Accept, redirects not followed). The callback must redirect only when the `oidc_state` cookie matches the token in `state`, and must clear that cookie. Before redeeming the code, it must reject these with 400: a missing or foreign state cookie, a foreign redirect origin (including with forged forwarded headers), a legacy unbound `state`, and a JSON callback without an allowed `Origin`, same-origin Fetch Metadata, or `Referer`. A UI origin listed in `P_ALLOW_ORIGINS` must work both as the redirect target and as the JSON caller.

Do not point this test at the production server or a real Pocket ID instance; `PARSEABLE_BIN` must name a local executable. The process is stopped and its temporary data is removed whether the check passes or fails.

## Optional Pocket ID fixture

For a manual check against a dedicated Pocket ID test instance:

1. Use the existing test OIDC client or create a disposable one. Set its callback URL to `http://<parseable-host>:<port>/api/v1/o/code`, and request the `groups` scope from Parseable. Make sure the client still allows the test user to sign in after the role group is removed. If Pocket ID restricts the client to allowed groups, leave access unrestricted for this test or keep the test user in a second allowed group.
2. In Pocket ID, open **Administration → User Groups** and create a group with machine name `parseable-oidc-test-readers`. In **Administration → Users**, create a dedicated test account and add it to this group. Complete sign-in setup for that account, such as registering its passkey.
3. In Parseable, create a role named exactly `parseable-oidc-test-readers`. Sign in using the dedicated test account and confirm the role appears in the user's direct roles.
4. Remove the test account from the Pocket ID group. On the next Parseable authorization refresh, the provider grant should disappear while any separately assigned manual roles remain. Active sessions revalidate at most every `P_OIDC_REVALIDATION_INTERVAL` seconds (five minutes by default), and sooner when the provider access or ID token expires.

Pocket ID documents that `groups` is an optional scope, that its value is an array of machine group names, and that group membership controls those values in the ID token and userinfo response: [Scopes and claims](https://pocket-id.org/docs/guides/scopes-and-claims), [User management](https://pocket-id.org/docs/setup/user-management). Use a separate test client and test account, and avoid modifying a production user's group membership for this check.

## Authorization lifecycle and migration

The supported, advertised deployment for the OIDC administration UI is standalone
(`Mode::All`). Other modes ignore provider groups and keep only manual and default
grants, because refreshed grants are not synchronized to every node.
The group view explains existing exact-name role mappings; it does not provision
Pocket ID groups or enable Enterprise native-group CRUD.

New OAuth identities use a Parseable ID derived from the validated issuer and
subject. ID-token and userinfo subjects must agree. Native users are never linked
by matching email, display name, or subject. Legacy OAuth records without an
issuer binding are matched only by an exact stored subject; ambiguous matches
fail authentication. Their old flat role sets and local-group membership have no
trusted provenance, so first verified migration resets them and applies current
provider/default grants. Review existing accounts before rollout and explicitly
regrant intended manual access after migration. Before a legacy user signs in,
administrators can still add or revoke any of their roles; such an edit records
the user's resulting role set as manual grants, which survive migration.
Changing legacy user IDs also
requires reviewing resources that refer to their former IDs; automatic migration
of dashboard or alert ownership is not part of this change.

`GET /api/v1/user/{userid}/role` includes an `oidc` object for OAuth users with
issuer, observed groups, manual/provider roles, configured fallback and legacy
status. It never includes bearer credentials. The configured fallback is
inactive when manual or provider roles supply access. Role removal through the
manual-role API only removes manual grants; it cannot override a matching
provider grant. The role inspector shows this distinction.

The revalidation bound applies to active cookie-authenticated requests.
Providers that cannot return a fresh signed ID token during refresh require a
new sign-in. Dormant users and background jobs do not poll the identity
provider; a stored role set is not a promise of continuous provider membership.
A browser login is bound to the browser that started it: `/o/login` sets a
short-lived HttpOnly `oidc_state` cookie and sends its token with the redirect
target in `state`. The callback redeems the code only when the token matches the
cookie and the target's origin is `P_ORIGIN_URI` or listed in
`P_ALLOW_ORIGINS`. When `P_ORIGIN_URI` is unset, the `Host` header and the
scheme Parseable serves stand in for it; forwarded headers are ignored. Unlike
`/o/login`, which checks against the request's own origin, the callback relies
on `P_ORIGIN_URI`, so set it to the exact scheme, host and port browsers use.
For example, an `http://` value behind an HTTPS proxy rejects browser logins
that return to the Parseable UI, unless its origin is in `P_ALLOW_ORIGINS`.
Each browser holds one pending login, so the most recently started tab wins and
others must sign in again. JSON callers (`Accept: application/json` or
`x-p-tenant`) forward the code themselves and are not redirected. If such a
request has an `Origin`, that origin must be allowed. Otherwise
`Sec-Fetch-Site` must be `same-origin`, and only a request without
`Sec-Fetch-Site` may rely on a `Referer` from an allowed origin. Any other JSON
callback is rejected before the code is redeemed.
A host that can set cookies for a parent domain can still plant a login, as it
already can with the `session` cookie. Nonce and per-login PKCE still need a
separate OIDC protocol-hardening review. The built-in `reader` privilege includes
dashboard/filter writes; it is not a strict read-only UI role.
