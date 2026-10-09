# Frontend validation and independent review

This record distinguishes the current worktree's completed checks from the supplied earlier research. Original Prism source was not recovered; visual comparisons use actual rendered v3.2.4 assets and an independently implemented frontend. No deployed service or the reference checkout was modified.

## Completed current validation (2026-10-07)

| Check                                  | Actual result                                                                                      | Scope                                                                                                                                 |
| -------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Worktree Rust build                    | `cargo build --locked --bin parseable` passed; final crate rebuild 46s after dependencies compiled | Real local-store executable, using a stable editable asset snapshot. `--help` and `local-store --help` also passed                    |
| Live backend                           | Port 8250 liveness returned 200; synthetic logs ingested into `frontend_smoke`                     | Disposable storage under `/tmp/astra-item2-data`; no deployed data                                                                    |
| Independent final live Playwright pass | **7 passed, 1 expected skip in 20.1s**                                                             | Final current code: native/session/logs/SQL/schema plus mock OIDC and administrative API denial; missing-provider test ran separately |
| Authenticated original Prism capture   | Four original routes rendered with no captured JavaScript page errors                              | Logs, initial SQL, datasets and empty server-dashboard listing, native fixture account; 1440 × 1000                                   |
| Final implementation capture           | Login and four supported routes refreshed after layout refinements; mobile login/Logs at 390 × 844 | Real native session, no API mocking; original/editable screenshots composed side by side                                              |

The final OIDC-configured live command was:

```sh
cd frontend
npm_config_cache=/tmp/astra-item2-npm \
TMPDIR=/tmp/astra-item2-tmp \
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium \
PARSEABLE_LIVE_URL=http://127.0.0.1:8270 \
PARSEABLE_LIVE_OIDC=true \
npm run test:live
```

Assertions verified backend invalidation by reusing the old native session cookie and receiving HTTP 401. A missing browser session and a server-invalidated session both returned to login, retained the intended dataset route and recovered after sign-in. The log test used ingested values, applied an exact ERROR filter, opened details using Enter and checked Escape focus restoration. SQL ran on DataFusion and a missing-table query produced a real error with stale results removed. The dataset sheet showed Arrow-schema fields and navigated back to logs.

The final OIDC case also confirmed that the restricted user received HTTP 403 from the administrative `/api/v1/roles` endpoint. This is live API permission evidence; the permission-denied UI itself is covered by the mocked browser regression. The OIDC case navigated through the visible local provider on port 8251, waited for the real `/api/v1/o/code` browser callback, verified “Smoke SSO User” and accessible data, signed out, and re-entered SSO successfully with stale-cookie handling. This validates the configured local mock protocol round trip, not Pocket ID or another real provider. The mock uses discovery, JWKS and RS256 ID tokens; it is a loopback fixture, not a production identity service.

The provider-free backend case separately passed **1/1 in 2.6s** after the same disposable server restarted without `P_OIDC_*` configuration:

```sh
npm_config_cache=/tmp/astra-item2-npm TMPDIR=/tmp/astra-item2-tmp \
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium \
PARSEABLE_LIVE_URL=http://127.0.0.1:8270 PARSEABLE_LIVE_NO_OIDC=true \
npm run test:live -- --grep 'unconfigured OIDC'
```

The full default check passed with **36 unit tests (5 files), 33 app browser tests, and 14 Storybook browser tests**. Formatting, TypeScript, production Vite build and Storybook build passed in the same command. App browser tests completed in 18.0s and Storybook tests in 5.7s, using system Chromium and the configured ten workers. Browser execution was serialized across agents.

```sh
npm_config_cache=/tmp/astra-item2-npm TMPDIR=/tmp/astra-item2-tmp \
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npm run check
```

An initial check stopped with two test failures: an inexact Password locator also matched the newly named visibility button, and Chromium normalized zero-second `datetime-local` values so a fixture fill was rejected. Exact label matching and canonical minute-only fixture strings fixed those test assumptions. The complete command passed on rerun. Non-fatal Storybook chunk-size/deprecation warnings remain; there were no build or test failures in the final run.

## Reproduce the disposable live environment

The following values are public local fixture values, not deployment credentials. Reserve the listed loopback ports before starting processes. Stop the fixture processes afterward.

Build from the repository root. The successful session isolated Cargo/cache/temp output and used a snapshot of built assets so a concurrent frontend build could not delete Rust include files:

```sh
export PATH="$HOME/.cargo/bin:$PATH"
mkdir -p /tmp/astra-item2-assets /tmp/astra-item2-tmp
cp -a frontend/dist/. /tmp/astra-item2-assets/
CARGO_HOME=/tmp/astra-item2-cargo \
CARGO_TARGET_DIR=/tmp/astra-item2-target \
CARGO_PROFILE_DEV_DEBUG=0 CARGO_BUILD_JOBS=6 CARGO_INCREMENTAL=0 \
LOCAL_ASSETS_PATH=/tmp/astra-item2-assets TMPDIR=/tmp/astra-item2-tmp \
cargo build --locked --bin parseable
```

This session copied an available Cargo registry cache into the isolated Cargo home; a fresh environment may download dependencies. The initial build attempt hit a missing generated frontend asset while another build replaced `dist`; the stable snapshot resolved that build-input race without changing Rust.

Start the mock provider from `frontend`:

```sh
node e2e-live/fixtures/mock-oidc.mjs
```

Start the worktree-built backend from the repository root:

```sh
P_ADDR=127.0.0.1:8250 \
P_GRPC_PORT=8252 P_FLIGHT_PORT=8253 P_QUERY_GRPC_PORT=8254 \
P_USERNAME=frontend-smoke P_PASSWORD=local-smoke-password \
P_FS_DIR=/tmp/astra-item2-data/store \
P_STAGING_DIR=/tmp/astra-item2-data/staging \
P_SEND_ANONYMOUS_USAGE_DATA=false P_CHECK_UPDATE=false \
P_ORIGIN_URI=http://127.0.0.1:8270 \
P_ALLOW_ORIGINS=http://127.0.0.1:8260,http://127.0.0.1:8270 \
P_OIDC_CLIENT_ID=frontend-smoke P_OIDC_CLIENT_SECRET=local-fixture-secret \
P_OIDC_ISSUER=http://127.0.0.1:8251 \
RUST_LOG=info TMPDIR=/tmp/astra-item2-tmp \
/tmp/astra-item2-target/debug/parseable local-store
```

Start Vite from `frontend`:

```sh
PARSEABLE_PROXY_TARGET=http://127.0.0.1:8250 npm run dev -- --port 8270
```

The opt-in suite performs its own synthetic ingestion. `PARSEABLE_LIVE_USERNAME`, `PARSEABLE_LIVE_PASSWORD` and `PARSEABLE_LIVE_DATASET` override its defaults. It writes the dataset and, in the OIDC test, a reader role named `frontend-smoke-reader`. A separate invocation with no `PARSEABLE_LIVE_URL` completed successfully with **all 8 tests skipped**, confirming opt-in behavior without the suite ingestion hook. `npm run check` does not run live tests.

For the original UI reference, `node e2e-live/fixtures/prism-proxy.mjs` serves the read-only cached v3.2.4 distribution on port 8260 with SPA fallback and `/api` proxying to 8250. Native authentication was used for this reference because the mock provider callback is configured for port 8270. See [parity evidence](prism-parity.md) for screenshots, measurements and limits.

For the missing-provider case, stop the disposable backend and restart it without the three `P_OIDC_*` variables. Use `PARSEABLE_LIVE_NO_OIDC=true` and the targeted missing-provider test. The targeted case passed as recorded above.

## Component and interaction review

Primitives own appearance and native/Radix semantics. Feature owners handle query/session state; table/chart presentation does not fetch data. Native controls expose labels; icon buttons have accessible names. Dialogs retain focus containment, Escape dismissal and opener focus restoration. Stable atlas hooks identify feature boundaries, while generated IDs remain accessibility relationships.

The shell does not expose dead enterprise navigation. Production sample mode is gated at build time. Authentication errors cannot be converted into demo success; permission denial is separate. Identity display prefers the server's user endpoint, with display-only cookie hints when the profile endpoint is unavailable; 401 and cancellation are never treated as a profile fallback. A stream-list probe still checks the session on local-content routes. Backend authorization remains authoritative. Login and logout navigate through the existing backend protocol and do not import the separate OIDC authorization changes from the reference deployment.

Recovered hooks include `#main-section`, `data-sidebar`, `data-field-node`, `lmt-sidebar-toggle`, filter-pill hooks, `data-dialog-confirm` and stable `data-tile-id`. New CSS and component names are implementation-owned. Pixel parity is not established simply by retaining hooks or passing accessibility tests.

## Remaining validation limits

Production demo gating passed in a separate Chromium script against production bundles served at ports 8271 (`VITE_ENABLE_DEMO=false`) and 8272 (`VITE_ENABLE_DEMO=true`). The disabled build ignored a preexisting `parseable-mode=demo`, returned missing-session Logs to login, exposed no demo button and still rendered `/components`. The enabled build offered explicit demo entry and retained the selected demo workspace after reload. [Recorded gate assertions](parity-screenshots/production-demo-gate.json) contain the outcomes. These bundles were built immediately before the final live-SQL initial-text adjustment, which does not affect the gate.

The gate builds used `VITE_ENABLE_DEMO=false` or `true`, `npm_config_cache=/tmp/astra-item2-npm`, `TMPDIR=/tmp/astra-item2-tmp`, and `npx vite build --outDir /tmp/astra-item2-production-no-demo` or `/tmp/astra-item2-production-demo`. Final source also passed the default production build in `npm run check`. Final screenshots are linked from [prism-parity.md](prism-parity.md).

Cross-browser behavior, production deployment, real-provider interoperability, provider membership/refresh revocation, complete accessibility conformance and every original Prism interaction are not covered. Dashboards remain browser-local; server-backed dashboards, saved views, metrics, traces, alerts, administration and other excluded feature areas are not implemented. Wide-schema virtualization, arbitrary timezones and exact pixel equality remain parity gaps.

## Files and test coverage added in this iteration

| Area                        | Principal files                                                                                                                                                                                                                   | Change                                                                                                                                                                |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication and shell    | `src/app/{App,AppProvider,Sidebar,ConnectionDialog,LoginPage,LoginForm}.tsx`, `src/lib/{auth,client,config,demo,types}.ts`, `src/styles/auth-shell.css`                                                                           | Standalone login, safe SSO/document navigation, missing-provider recovery, session/identity handling, production demo gate and measured shell layout                  |
| Logs and shared explorer    | `src/features/logs/{LogsPage,FieldSidebar,FilterBar}.tsx`, `src/components/explorer/{ColumnPicker,DataTable,TimeRangePicker,RecordSheet,LogHistogram,QueryState}.tsx`, `src/components/explorer/timestamp.ts`, `src/lib/query.ts` | Compact summary results, columns/sort/wrap/export, edit/clear filters, absolute UTC ranges, event actions, explicit auth states and timezone-less backend UTC parsing |
| Existing route presentation | `src/features/sql/SqlPage.tsx`, `src/features/datasets/DatasetsPage.tsx`, `src/features/dashboards/DashboardsPage.tsx`, `src/styles/global.css`                                                                                   | SQL explorer/empty live editor/results controls, inventory table and local dashboard layout refinements                                                               |
| Unit coverage               | `src/lib/{auth,client,query}.test.ts`, `src/components/explorer/timestamp.test.ts`                                                                                                                                                | Safe return paths, cookies/identity/auth request contracts, query bounds and backend timestamp handling; existing dashboard storage coverage retained                 |
| App browser coverage        | `e2e/auth.spec.ts`, `e2e/explorer-parity.spec.ts`, `e2e/app.spec.ts`, `playwright.config.ts`                                                                                                                                      | Six auth and five explorer parity cases added; existing flows updated and regression coverage retained                                                                |
| Real-server coverage        | `e2e-live/server.spec.ts`, `playwright.live.config.ts`, `e2e-live/fixtures/{mock-oidc,prism-proxy}.mjs`, `package.json`                                                                                                           | Opt-in live tests, protocol fixture, original-asset proxy and `test:live`; excluded from default check                                                                |
| Documentation/evidence      | `README.md`, `docs/{api-contracts,component-map,component-design-review,prism-parity,validation-review}.md`, `docs/parity-screenshots/`, `docs/wiki-drafts/prism-frontend-parity.md`                                              | Current contracts, actionable comparison, completed checks, final screenshots and local unpublished wiki draft                                                        |

The README build/embed section and unrelated packaging/Rust/Docker/CI changes belong to concurrent work and were preserved. The final full check preceded only documentation and live-suite assertion adjustments; application source was unchanged afterward. No Rust authorization changes, external publishing, commits or deployed-service changes were made for this frontend iteration.

A final review run initially assumed the restricted reader would receive HTTP 403 for another stream's schema. The real backend returned HTTP 200 instead. This is metadata visibility, not proof of event-query access, and the frontend does not change existing backend privileges. The acceptance assertion was corrected to use an administrative resource rather than treating globally visible metadata as a denial boundary. After this correction the final live run passed 7 tests with the one expected missing-provider skip, as recorded above.
