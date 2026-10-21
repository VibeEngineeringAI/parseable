# Native UI and classic Prism retirement

Parseable now builds and embeds only `frontend/dist` and serves it at `/`.
The build no longer downloads the classic Prism ZIP or applies a compiled-asset
overlay. The release `build.zip` and `build.zip.sha1` artifacts still contain the
native frontend with the same top-level `dist/` layout. Vite emits
`dist/THIRD_PARTY_LICENSES.md` with bundled dependency notices; that file is
embedded and packaged alongside the frontend.

## Build and deployment

1. Build `frontend/` with Node 24: `npm ci && npm run build`.
2. From the repository root set `NEXT_ASSETS_PATH="$PWD/frontend/dist"` for Cargo.
   An absent index, wrong base or missing JavaScript is a build error.
3. Remove `LOCAL_ASSETS_PATH` and `P_UI_ROOT=classic` from deployment configuration.
   They are rejected with migration instructions. `P_UI_ROOT=native` remains valid.
4. Rebuild Docker from this checkout with
   `docker compose -f compose.yaml -f compose.source.yaml up -d --build`.
   Plain `compose.yaml` uses a prebuilt upstream image, so it does not pick up
   source changes. Debug and Kafka Dockerfiles copy native assets before the
   dummy dependency build as well as the actual application build.
5. Confirm `/api/v1/about` reports `native-<server version>` together with the
   expected server commit/build metadata. The UI version no longer identifies
   the retired upstream Prism ZIP.

For backend-only debug development, unset `NEXT_ASSETS_PATH` and set
`P_BUILD_NO_UI=1`. APIs remain available and UI requests return 503 with rebuild
instructions. This explicit opt-out is rejected for release profiles. It cannot
be combined with `NEXT_ASSETS_PATH` and is not used by release or Docker builds.

## Compatibility retained

- `/next` and `/next/<route>?<query>` redirect to root with path and query intact.
  This includes OIDC login return URLs. Redirects are not cached.
- Stale `/next/assets/*` URLs return 404 instead of importing a second copy of
  the application. Root hashed assets are immutable; HTML is revalidated and
  missing hashed assets return 404. SPA deep links, including dotted IDs, work.
- Legacy classic URL/query translation remains in `frontend/src/lib/classicUi.ts`.
  It is compatibility code, not an alternate UI distribution.
- `/api/prism/v1`, `Mode::Prism`, persisted dashboards/filters and authorization
  remain backend contracts. Do not delete them as part of UI retirement.
- Unsupported management capabilities explain their limits without sending
  users to a classic UI that is no longer served.

## Removal and verification scope

The classic archive pin, download/hash/extraction build dependencies, overlay
implementation, overlay scripts/tests, overlay CI job, runtime fallback and
comparison links are removed. Runtime dependencies shared with the server stay.
Native build metadata, build-input validation and backend-only behavior have
focused tests. Server routing tests cover deep links, conditional caching,
missing chunks, rejected paths, `/next` redirects and API precedence when the UI
is disabled. OIDC handlers and their existing tests are preserved.

See [the migration guide](native-ui-migration.md) for server-saved SQL, older
Logs filters, builder-alert conversion and remaining feature gaps. Do not infer
full feature equivalence from a successful native build. Historical comparison
reports and stored classic-format fixtures remain compatibility evidence; live
classic comparisons require an older server version.
