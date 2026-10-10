# Frontend validation and independent review

This record distinguishes the current worktree's completed checks from the supplied earlier research. Original Prism source was not recovered; visual comparisons use actual rendered v3.2.4 assets and an independently implemented frontend. No deployed service or the reference checkout was modified.

## Dashboards validation (2026-10-10)

The required full `npm run check` passed: **898 unit tests in 35 files, 198 app browser tests and 42 Storybook browser tests**. This includes **25 dashboard browser cases** covering demo CRUD, SQL/PromQL tile editing and variables, full-document PUT preservation, conflict Reload/Overwrite, read-only ownership, capability-off and 403 behavior, import/export and local migration, concrete alert handoffs, dirty navigation, stale-response protection, favourite/rename preservation and typed-delete focus, six light/dark axe scans that assert the applied theme, and keyboard actions with no horizontal overflow at 390px. Formatting, TypeScript, the production build and the Storybook build also passed.

Earlier full runs exposed an existing Alerts runtime chart reset when mute crossed a clock second, and timing-sensitive navigation assertions under ten-worker load. The chart now anchors its query end to the dataset/query rather than the entire alert object; its browser test advances the clock to verify that muting retains the plot. The dirty-navigation test awaits each native confirmation before the next navigation. App browsers now use four workers on this shared machine; Storybook still uses ten. The final full run passed without retries. The additional targeted preservation/theme run passed **7/7**, and the metadata helper run passed **6/6**.

The live run used Vite on `http://127.0.0.1:8271`, proxying to the disposable server at `http://127.0.0.1:8030`, and Chromium at `/usr/bin/chromium`. All Playwright invocations used `flock /home/ajs/.cache/parseable-playwright.lock`, checking 5173 and 6006 inside the lock before running. `TMPDIR=/home/ajs/.cache/dash-tmp` kept Chromium temporary files off the small `/tmp` filesystem. No requests were sent to ports 8000, 8011 or 8012.

The final dashboard live suite passed **4/4 in 17.2s**, without retries. It ingested twelve logs and two OTLP gauge series, created a dashboard through the UI with SQL/table and PromQL/timeseries tiles plus dataset and label-values variables, and verified exact stored classic shapes. A hard load at the server's own `/dashboards/<id>` displayed the real log messages and a PromQL canvas with successful nonempty matrix results from that origin. [Classic render capture](parity-screenshots/server-dashboard-classic.png) and [stored dashboard JSON](parity-screenshots/server-dashboard-created.json) record that result. The reverse test POSTed a classic-shaped Report with unknown document, time-range, section, tile and config keys, rendered it in this frontend, changed one tile title and deep-compared the stored document (apart from the changed title and server `modified`).

One earlier live repeat observed an empty SQL response shortly after ingest; the test now exercises manual Refresh and waits for nonempty real SQL and PromQL responses before asserting rendered values. The final run passed. The temporary Vite process was stopped, and port 8271 had no listener afterwards.

Contract surprises were resolved against Rust and the live server: missing dashboards are 400; titles are tenant-wide and case-sensitive; summaries use Chrono Display dates; `limit=0` returns the same full set as an absent limit; tiles use snake_case `tile_id`; custom time ranges use `type:"custom"`. Although `get_dashboard_by_user` permits admin lookup, the full-body update has a second strict owner check. A second reader user created a dashboard; admin PUT returned 400 `Cannot perform this operation: Dashboard does not exist or you do not have permission to access it`, while admin DELETE succeeded. The UI reflects that distinction. Cleanup in `afterAll` passed for all created dashboards, both datasets, the user and its role.

The scope deliberately excludes AI, Enterprise/pricing, templates/CDN, Report creation, sections UI, drag/resize, present mode, PNG download and auto-refresh. Stored Report/section/unsupported chart data is preserved. The shared chart renders area/bar as a line while retaining their stored types. No cross-browser run, deployment, embedded `/next` rebuild or pixel-parity claim is included.

Changed files are grouped here; implementation responsibilities are detailed in [the component map](component-map.md#server-backed-dashboards).

| Area                          | Added or changed files                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dashboard screens and helpers | `src/features/dashboards/`: list/detail containers, tile and variable editors/renderers, conflict and import dialogs, ownership, time range, queries, interpolation, handoffs, import/export, local migration, styles, classic fixture and unit tests; the old storage helpers now only read local dashboards or explicitly remove confirmed local copies |
| Contracts and adapters        | `src/lib/types.ts`, `client.ts`, `dashboardsContract.ts`, `demoDashboards.ts`, `demo.ts`, `ids.ts`, `sha256.ts`, `concurrency.ts`, `promqlMetadata.ts`, `query.ts`, `classicUi.ts` and their tests, plus capability literals in existing Team/PromQL client tests                                                                                         |
| Routing and shared controls   | `src/app/App.tsx`, `OverviewPage.tsx`, `src/components/explorer/TimeRangePicker.tsx`, `src/components/ui/ActionsMenu.tsx`                                                                                                                                                                                                                                 |
| Existing feature integration  | `src/features/alerts/AlertForm.tsx`, `PromqlRuntime.tsx`, `shared.tsx`, `src/features/metrics/MetricsPage.tsx`                                                                                                                                                                                                                                            |
| Browser validation            | `e2e/dashboards.spec.ts`, `e2e-live/dashboards.spec.ts`, `e2e/app.spec.ts`, `e2e/alerts.spec.ts`, `playwright.config.ts`                                                                                                                                                                                                                                  |
| Documentation and evidence    | `README.md`, `docs/api-contracts.md`, `component-map.md`, `prism-parity.md`, `validation-review.md`, `wiki-drafts/prism-frontend-parity.md`, `parity-screenshots/server-dashboard-classic.png`, `parity-screenshots/server-dashboard-created.json`                                                                                                        |

Commands from `frontend/` (start the live Vite process in another terminal and stop it afterwards):

```sh
npm run format
flock /home/ajs/.cache/parseable-playwright.lock bash -c '
  while [ -n "$(ss -H -ltn "( sport = :5173 or sport = :6006 )")" ]; do
    ss -ltn "( sport = :5173 or sport = :6006 )"
    sleep 5
  done
  ss -ltn "( sport = :5173 or sport = :6006 )"
  export TMPDIR=/home/ajs/.cache/dash-tmp
  export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
  export PARSEABLE_PROXY_TARGET=http://127.0.0.1:8030
  npm run check
'

PARSEABLE_PROXY_TARGET=http://127.0.0.1:8030 \
  npx vite --host 127.0.0.1 --port 8271 --strictPort

flock /home/ajs/.cache/parseable-playwright.lock bash -c '
  while [ -n "$(ss -H -ltn "( sport = :5173 or sport = :6006 )")" ]; do
    ss -ltn "( sport = :5173 or sport = :6006 )"
    sleep 5
  done
  ss -ltn "( sport = :5173 or sport = :6006 )"
  export TMPDIR=/home/ajs/.cache/dash-tmp
  export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
  export PARSEABLE_LIVE_URL=http://127.0.0.1:8271 PARSEABLE_LIVE_BASE=
  export PARSEABLE_LIVE_SERVER_URL=http://127.0.0.1:8030
  export PARSEABLE_LIVE_USERNAME=admin PARSEABLE_LIVE_PASSWORD=admin
  npx playwright test -c playwright.live.config.ts e2e-live/dashboards.spec.ts
'
```

## Alerts validation (2026-10-09)

This section records the frontend fixes and completed checks for the four supplied Opus reviews.

| Check                             | Actual result                                                                   | Scope                                                                                                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run format`                  | Passed                                                                          | Source, browser/live tests, stories and frontend docs                                                                                                          |
| Required `npm run check`          | **800 unit tests (22 files), 172 app browser tests, 42 Storybook tests passed** | Formatting, TypeScript, production build, Vitest, demo/mocked HTTP app tests, Storybook build and browser tests                                                |
| Alerts app browser suite          | **61 passed** in the full check                                                 | CRUD, routing, SQL handoff, duplicate validation, duration round-trips, tags, validation, focus, announcements, runtime tables, preview and chart preservation |
| Repeated dark accessibility tests | **60/60 passed in 50.2s**, zero failures or retries                             | Alerts **50/50** across five views and Metrics **10/10**, with `--repeat-each=10 --workers=6`                                                                  |
| Rust duration compatibility       | **93 parser-oracle cases passed: 59 accepted, 34 rejected**                     | Fixture generated with the actual Cargo.lock dependency, humantime 2.3.0; aliases, compound/fractional units, precision and overflow boundaries                |
| Alerts accessibility and layout   | Passed                                                                          | Ten desktop light/dark axe scans; keyboard scrolling and axe for runtime, delivery and preview tables at 390px; Tags/Actions geometry at 1024px                |
| Isolated components               | Included in the **42 Storybook tests** above                                    | ArrowUp wrap-around, disabled menu exposure, open-menu dark axe, threshold-story light/dark axe, threshold canvas strokes and uPlot identity/value changes     |
| Alerts live suite via Vite        | **3 passed in 11.4s**                                                           | Native admin session at `http://127.0.0.1:8270`, proxying to the disposable server on port 8010                                                                |
| Live cleanup and seeded inventory | Verified; Vite stopped                                                          | Before/after inventories retain three seeded alerts, two targets and three datasets; the suite's unique fixtures are gone                                      |

The regression coverage verifies these review fixes:

- Dark axe scans assert the applied theme, emulate reduced motion, disable CSS animation/transition motion for the snapshot and await all remaining `document.getAnimations()` promises. The same setup covers Alerts, Metrics, Team and app scans. Earlier attempts exposed CodeMirror's infinite caret animation and residual 0.01ms transitions that could stall; the final full check and repeated run passed without retries.
- Runtime instances, deliveries and preview tables expose named, focusable scroll regions. Named action IDs keep Disable/Enable and Mute/Unmute focused after toggling and remove positional/label coupling.
- Runtime chart data and references are memoized. Equivalent threshold and range values preserve the uPlot instance; changed values update it.
- Duplicate navigation state is validated with the alerts contract guard. Builder alerts do not offer Duplicate, and invalid or builder source state displays an explanation. Trailing-slash routes resolve correctly, and both `queryBuilderType=sql` and `code` select SQL.
- Tag rows have stable IDs, blank tags are omitted from requests, and nonblank tags preserve whitespace, commas and duplicates. Adding/removing tags and target headers moves focus to a sensible control. Theme changes preserve an untouched edit draft.
- Evaluation-window and hold-duration validation matches humantime aliases, including `10mins`, `2hrs` and `30secs`. Existing accepted durations can be saved unchanged.
- Disabled Create/Save controls have immediately visible field errors, including an invalid prefilled query. Runtime/state badges use human labels. Preview numbers are rounded for display with the raw values in titles.
- Persistent live regions announce list/detail actions, target creation and preview completion. Tags wrap within their column at 1024px without being covered by Actions.
- List-menu tests assert mute and unmute results; chart/card loops first assert a positive state. The live delete-focus assertion accepts search when the table becomes empty. The accessibility smoke loop includes `with-thresholds`.

The existing permission/session, held-save, dirty-form, reader/capability, cancellation and deletion-focus regressions also passed. Permission errors retain the session and draft; genuine session expiry still recovers.

The live spec creates a unique `alerts_live_*` OTLP dataset with two gauge series (3.25 and 7.5), a webhook target and a PromQL rule. It compares preview values with the API, verifies evaluation through a successful PUT and a strictly newer runtime timestamp, checks mute/unmute and disable/enable, then edits hold duration and performs typed deletion. Cleanup touches only these unique fixtures. Authenticated before/after inventories matched: the three seeded alerts, `ops-slack`, `ops-webhook`, `pstats`, `shots_logs` and `shots_metrics` remain. Port 8270 had no listener after Vite was stopped.

No fresh screenshot inspection, contract-probe sweep, embedded-server validation, cross-browser check or classic-UI pixel comparison was performed in this follow-up. Shared collection/mutation hook extraction, badge-colour/sort-header deduplication and lib-to-feature import cleanup remain deferred.

Commands from `frontend`:

```sh
npm run format

TMPDIR=/home/ajs/.cache/alerts-tmp \
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium \
PARSEABLE_PROXY_TARGET=http://127.0.0.1:8010 npm run check

TMPDIR=/home/ajs/.cache/alerts-tmp \
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium \
PARSEABLE_PROXY_TARGET=http://127.0.0.1:8010 \
npx playwright test e2e/alerts.spec.ts e2e/metrics.spec.ts \
  --grep 'passes axe in dark|accessible light/dark results' \
  --repeat-each=10 --workers=6

PARSEABLE_PROXY_TARGET=http://127.0.0.1:8010 \
npx vite --host 127.0.0.1 --port 8270

TMPDIR=/home/ajs/.cache/alerts-tmp \
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium \
PARSEABLE_LIVE_URL=http://127.0.0.1:8270 PARSEABLE_LIVE_BASE= \
PARSEABLE_LIVE_USERNAME=admin PARSEABLE_LIVE_PASSWORD=admin \
npx playwright test -c playwright.live.config.ts e2e-live/alerts.spec.ts
```

## Metrics explorer validation (2026-10-09)

| Check                  | Actual result                                            | Scope                                                                                                                                                                                                                                             |
| ---------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run check`        | **487 unit, 107 app browser, 33 Storybook tests passed** | Format, TypeScript, build, Vitest, Playwright (demo and mocked HTTP, including axe), Storybook story tests                                                                                                                                        |
| Live suite via Vite    | **14 passed, 3 opt-in OIDC skips**                       | `server.spec.ts`, `team.spec.ts` and `metrics.spec.ts` at `http://127.0.0.1:8370` (`PARSEABLE_LIVE_BASE=`), proxying to a disposable v3.2.5 local-store server with `P_PROMQL_MAX_INGEST_DELAY=0`                                                 |
| Embedded `/next` build | **14 passed, 3 opt-in OIDC skips**                       | Rust rebuilt with `NEXT_ASSETS_PATH` set to a snapshot of the checked `dist`; `PARSEABLE_LIVE_URL=http://127.0.0.1:8360` with the default `/next` base                                                                                            |
| Contract probe         | Matched                                                  | PromQL routes answer at `/prometheus/api/v1/*`; `/api/v1/prometheus/*` returns 404. Quoted dotted metric and label names (`{"a.b", "service.name"="x"}`, `by ("service.name")`) parse in `@prometheus-io/lezer-promql` and evaluate on the server |
| Mobile                 | No horizontal overflow at 390x844                        | Live data, range query                                                                                                                                                                                                                            |

The metrics live spec ingests a gauge and a cumulative counter with two `host` values into a fresh `metrics_live_*` dataset through `POST /v1/metrics`. It checks the label browser, then compares the gauge and `sum by (host) (rate(...[5m]))` results with the API response, checks that `topk` shows the verbatim 422 message, and deletes the dataset. Vite proxies `/v1` so ingestion works through the dev server.

Run Playwright with `TMPDIR` on a disk-backed directory when `/tmp` is a small tmpfs. Chromium leaves `.org.chromium.Chromium.*` scratch directories behind, and they filled a per-user `/tmp` quota during this validation. With `/tmp` full, both the server's staging writes and Chromium fail with `ERR_INSUFFICIENT_RESOURCES`.

## Team page validation (2026-10-08)

| Check                                             | Actual result                                                                                          | Scope                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Default check                                     | `npm run check` passed: **152 unit tests (9 files), 69 app browser tests, 14 Storybook browser tests** | Formatting, TypeScript, production build and Storybook build in the same command. Team browser tests use demo data and mocked HTTP; the run followed the root-admin and empty-state fixes                                                                                                                          |
| Worktree Rust build                               | `cargo build --locked --bin parseable` passed (incremental, 22s)                                       | Debug local-store executable with OIDC configured against the mock provider                                                                                                                                                                                                                                        |
| API contract probe                                | `curl` against the disposable server matched the client                                                | `POST /user/{name}` returned a 32-character `text/plain` password; unknown roles returned JSON `non_existent_roles`; `PUT /role/default` took a JSON string; deleting the default role returned the expected 400; API-key create returned the full key, and the list returned `****` plus the last four characters |
| Live suite                                        | **12 passed, 2 opt-in OIDC skips in 37.1s**                                                            | `server.spec.ts` plus the six `team.spec.ts` tests against the real backend through Vite on port 8270 (`PARSEABLE_LIVE_BASE=`). The server had a pre-existing default OIDC role, and the suite restored it                                                                                                         |
| Live SSO                                          | **1 passed** with `PARSEABLE_LIVE_OIDC=true`                                                           | Created a real OAuth user whose only role came from the provider group                                                                                                                                                                                                                                             |
| Embedded `/next` build                            | **6 passed in 19.2s** (`e2e-live/team.spec.ts`)                                                        | Rust rebuilt with `NEXT_ASSETS_PATH` pointing at a snapshot of the checked `dist`; `PARSEABLE_LIVE_URL=http://127.0.0.1:8250` with the default `/next` base                                                                                                                                                        |
| Embedded `/next` full live suite, after the fixes | **12 passed, 1 failed, 1 skipped**                                                                     | All `server.spec.ts` and `team.spec.ts` cases passed at `http://127.0.0.1:8250/next` except SSO. Its mock-provider logout returned to `8250` while the fixture callback origin is `8270`; the SSO case passed again at `8270`                                                                                      |
| OAuth role sources                                | Remove stayed disabled, with "This role has no manual grant to remove…"                                | Real provenance from `GET /user/{id}/role` (`legacy: false`, provider role only, no manual roles)                                                                                                                                                                                                                  |

Commands, from `frontend`, with the backend, the mock provider and Vite started as described below:

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npm run check
PARSEABLE_LIVE_URL=http://127.0.0.1:8270 PARSEABLE_LIVE_BASE= \
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npm run test:live
PARSEABLE_LIVE_OIDC=true PARSEABLE_LIVE_URL=http://127.0.0.1:8270 PARSEABLE_LIVE_BASE= \
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npm run test:live -- --grep SSO
```

The first live run failed one assertion. The test expected HTTP 401 for the old password after a reset, but the backend answers any invalid Basic credentials with 403; only missing credentials get 401. The assertion now expects 403. A later run showed that the suite's default-role restore sent the role name as text, not JSON. It was corrected before the passing run above.

Not verified: enterprise user groups and SaaS invites (out of scope), and the distributed query server's user and role paths.

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

Cross-browser behavior, production deployment, real-provider interoperability, provider membership/refresh revocation, complete accessibility conformance and every original Prism interaction are not covered. The 2026-10-07 baseline used browser-local dashboards. Subsequent dated sections record Team, Metrics, Alerts and server-backed Dashboards; saved views, traces and remaining feature areas are still outside scope. Wide-schema virtualization, arbitrary timezones and exact pixel equality remain parity gaps.

## Files and test coverage added in this iteration

| Area                        | Principal files                                                                                                                                                                                                                   | Change                                                                                                                                                                |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication and shell    | `src/app/{App,AppProvider,Sidebar,ConnectionDialog,LoginPage,LoginForm}.tsx`, `src/lib/{auth,client,config,demo,types}.ts`, `src/styles/auth-shell.css`                                                                           | Standalone login, safe SSO/document navigation, missing-provider recovery, session/identity handling, production demo gate and measured shell layout                  |
| Logs and shared explorer    | `src/features/logs/{LogsPage,FieldSidebar,FilterBar}.tsx`, `src/components/explorer/{ColumnPicker,DataTable,TimeRangePicker,RecordSheet,LogHistogram,QueryState}.tsx`, `src/components/explorer/timestamp.ts`, `src/lib/query.ts` | Compact summary results, columns/sort/wrap/export, edit/clear filters, absolute UTC ranges, event actions, explicit auth states and timezone-less backend UTC parsing |
| Existing route presentation | `src/features/sql/SqlPage.tsx`, `src/features/datasets/DatasetsPage.tsx`, `src/features/dashboards/DashboardsPage.tsx`, `src/styles/global.css`                                                                                   | SQL explorer/empty live editor/results controls, inventory table and historical browser-local dashboard layout refinements                                            |
| Unit coverage               | `src/lib/{auth,client,query}.test.ts`, `src/components/explorer/timestamp.test.ts`                                                                                                                                                | Safe return paths, cookies/identity/auth request contracts, query bounds and backend timestamp handling; existing dashboard storage coverage retained                 |
| App browser coverage        | `e2e/auth.spec.ts`, `e2e/explorer-parity.spec.ts`, `e2e/app.spec.ts`, `playwright.config.ts`                                                                                                                                      | Six auth and five explorer parity cases added; existing flows updated and regression coverage retained                                                                |
| Real-server coverage        | `e2e-live/server.spec.ts`, `playwright.live.config.ts`, `e2e-live/fixtures/{mock-oidc,prism-proxy}.mjs`, `package.json`                                                                                                           | Opt-in live tests, protocol fixture, original-asset proxy and `test:live`; excluded from default check                                                                |
| Team administration         | `src/features/team/*`, `src/components/ui/{Pagination,TypedConfirmDialog}.tsx`, `src/lib/{client,demo,teamContract,types}.ts`, `e2e/team.spec.ts`, `e2e-live/team.spec.ts`                                                        | 26 demo/mocked browser cases, client/demo/helper unit tests and six self-cleaning real-server cases                                                                   |
| Documentation/evidence      | `README.md`, `docs/{api-contracts,component-map,component-design-review,prism-parity,validation-review}.md`, `docs/parity-screenshots/`, `docs/wiki-drafts/prism-frontend-parity.md`                                              | Current contracts, actionable comparison, completed checks, final screenshots and local unpublished wiki draft                                                        |

The README build/embed section and unrelated packaging/Rust/Docker/CI changes belong to concurrent work and were preserved. The final full check preceded only documentation and live-suite assertion adjustments; application source was unchanged afterward. No Rust authorization changes, external publishing, commits or deployed-service changes were made for this frontend iteration.

A final review run initially assumed the restricted reader would receive HTTP 403 for another stream's schema. The real backend returned HTTP 200 instead. This is metadata visibility, not proof of event-query access, and the frontend does not change existing backend privileges. The acceptance assertion was corrected to use an administrative resource rather than treating globally visible metadata as a denial boundary. After this correction the final live run passed 7 tests with the one expected missing-provider skip, as recorded above.

## Alerts cleanup validation (2026-10-10)

Results from `fix/frontend-alerts-cleanup`, run in Chromium (`/usr/bin/chromium`) under the shared Playwright lock.

- `npm run format` then `npm run check` passed: format check, `tsc` build, 819 unit tests in 24 files, 173 browser tests and 42 Storybook tests.
- The Alerts 390px no-overflow test now also asserts, for the Alerts list and Targets tables, that the row actions button is visible, inside the 390px viewport with the table scrolled to its left edge, not covered, and opens its menu without scrolling. Before the sticky Actions column was kept on mobile, the same assertions failed (button at x = 535px).
- Pristine Alert and Target forms show no errors. Blurring a field or attempting to submit reveals them, focuses the first invalid control and keeps `aria-invalid`/`aria-describedby` in step; Create and Save stay enabled for validation errors and are disabled only while saving or loading.
- Numbers share `formatChartValue` (trailing zeros dropped): preview table, PromQL runtime instances, thresholds, chart axis, tooltip and threshold labels. The Metrics results table delegates to it, so `2.50` now reads `2.5` there too.
- The PromQL editor story flake was a click on a completion list that CodeMirror had disabled while re-querying. It is fixed in the test by waiting for the live list. `story-tests/metrics-components.spec.ts` passed 720 of 720 with `--repeat-each=30 --workers=4`, and the editor tests passed 280 of 280 with `--repeat-each=40 --workers=8` under about 10 busy-loop CPU burners.
- The "detail, preview and target sheet have padded cards..." flake (`.uplot` lost its `data-retained` marker after Unmute, 4 to 5 of 15 runs, also on `origin/main`) was a test race, not a product bug. The runtime chart's window ends at the current second and moves forward when the alert reloads, which rebuilds the plot with the new range. In 12 serial runs the marker was lost exactly when the mocked `query_range` saw two different `end` values. The test now pins the clock with `page.clock.setFixedTime`, and passed 30 of 30 with `--repeat-each=30 --workers=4`.
- `InlineError` was identical in Alerts and Team (only the attribute order differed) and now lives in `src/components/ui/InlineError.tsx`, exported from the UI index.
- The final `npm run check` passed with 819 unit tests, 173 browser tests and 42 Storybook tests. An earlier full run had one unrelated failure in `e2e/app.spec.ts` "native login switches from demo to live" while the machine was at load average 36. That test then passed 20 of 20 in isolation and the check passed on rerun.
