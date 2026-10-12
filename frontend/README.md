# Parseable frontend

An editable React/TypeScript frontend and composable UI library informed by the Prism v3.2.4 component/selector research. This is a new implementation, not the original Prism source or a feature-complete replacement. No Stripe, billing, checkout, subscription, Clerk, paid upgrade prompts, or payment collection are included. Backend authorization remains authoritative.

## Run

Requires Node 22.12+ and npm. From this directory:

```sh
npm ci
npm run dev
```

Open http://127.0.0.1:5173. The app starts in **live server** mode. Sign in with a native Parseable username/password or choose **Sign in with SSO** for the server’s configured OAuth provider. Missing or expired sessions return to login and preserve the intended local route. Passwords are not persisted.

**Explore demo data** is available in development. Production builds hide demo controls and ignore stored demo selections unless built with `VITE_ENABLE_DEMO=true npm run build`. Demo selection lasts for the browser tab and remains visibly labeled. The component gallery stays available at `/components`; the app and Storybook browser-test configurations explicitly enable their sample workspace where needed.

Development requests to `/api` and `/prometheus` proxy to `http://127.0.0.1:8000`. Set a different target when starting Vite:

```sh
PARSEABLE_PROXY_TARGET=http://127.0.0.1:8080 npm run dev
```

The proxy preserves the browser Host so the backend can validate the same-origin login redirect. Configure the backend OAuth callback for the frontend origin (for example `http://127.0.0.1:5173/api/v1/o/code`) and allow that origin where required. Do not put credentials in the proxy URL. `/oidc-not-configured` explains missing provider setup and offers native login. A 403 stays a permission error; it never substitutes demo results.

## Build and embed in Parseable

Parseable serves this frontend at `/`, and links to its old `/next/` mount redirect (307) to the same path there. Its old asset URLs return 404, so a tab left open across the switch fails to load a chunk, as after any deploy, instead of starting a second copy of the app. `P_UI_ROOT=classic` puts the classic Prism UI back at `/` for one release and mounts this frontend **beside** it at `/next/`. Both share one origin, so one sign-in (native or OIDC) works in both, and each page has a **Compare in classic UI** link that opens the equivalent Prism page in a new tab. Classic links also open here: `src/lib/classicUi.ts` maps every route in Prism's router, so a moved page redirects (for example `/alerts/create` to `/alerts/new`), a Prism-only page says so, a Logs link keeps its time range and `=`/`!=` filters, a Metrics link keeps its time range, and both name anything they could not carry over. Alerts now has native navigation under Observe.

Release builds use **Node 24**. `npm run build` loads assets relative to the `<base href="/">` in `index.html`, and the server points that base at the mount, so the same build serves `/` and `/next/`. The Rust build refuses an `index.html` without it. From this directory:

```sh
npm ci && npm run build
cd ..
NEXT_ASSETS_PATH="$PWD/frontend/dist" cargo build --release
```

On PowerShell, set `$env:NEXT_ASSETS_PATH = (Resolve-Path frontend/dist).Path` from the repository root before running `cargo build --release`.

All Parseable Dockerfiles build the frontend in a Node 24 stage and set `NEXT_ASSETS_PATH`. The build/release workflows also build it before Rust, including Windows, macOS, and Kafka variants. Cross receives `NEXT_ASSETS_PATH` through `Cross.toml`; its absolute path stays inside the mounted workspace. Without `NEXT_ASSETS_PATH`, the classic UI serves `/` whatever `P_UI_ROOT` says, and nothing is mounted at `/next`. The build script tracks changes to the assets and environment variable. Point it at `frontend/dist`, not the source directory or Storybook output.

The classic UI is still embedded for `P_UI_ROOT=classic`: plain Cargo builds download the Prism ZIP pinned in `Cargo.toml` and apply the community overlay, and `/api/v1/about` reports its version. `LOCAL_ASSETS_PATH` still replaces it as before.

Once the rollback release has passed, retiring Prism removes the classic embed, the community overlay, `P_UI_ROOT`, the `/next` redirect and the classic UI links (phase D of the switch-over plan).

To package the already-built `dist/` (from this directory):

```sh
npm run package
```

This creates `build.zip` with a top-level `dist/` directory, including `dist/index.html`, and `build.zip.sha1`. The script prints the ZIP's SHA-1 and writes the same checksum in `sha1sum -c` format. It uses sorted entries, fixed timestamps and permissions, and no extra package dependencies; identical assets produce identical ZIP bytes with the same Node/zlib version. The frontend CI uploads both files as the `parseable-frontend` artifact, and the release workflow attaches both to the GitHub release. The ZIP contains the same base-relative build.

`npm run preview` previews the production assets at `http://127.0.0.1:4173/`. It has no API proxy; use demo mode, or use `npm run dev`/the embedded server for API calls.

## Working features

- Compact workspace shell, collapsible navigation, light/dark theme, server-preferred signed-in identity, and logout. Standalone two-panel login includes password visibility and the administrator-contact password-reset dialog.
- Logs: dataset selection, preset/absolute time ranges with UTC/local/IANA timezone selection, message search, grouped AND/OR field filters, server-backed histogram totals, server saved views, reproducible copy links, surrounding-log context, searchable fields and columns, virtualized large/wide results, JSON/CSV export, event details, include/exclude/copy actions, and handoff to SQL.
- SQL: named query tabs with independent execution/cancellation and Undo close, CodeMirror editor and Ctrl/Cmd+Enter shortcut, per-tab time ranges, dataset/schema explorer and multi-dataset query generation, Results/Chart switching, shared dashboard chart configuration and Add to Dashboard, browser-local saved queries and drafts, resizable panels, sortable/wrappable results, column selection, and JSON/CSV export.
- Metrics: OTLP metrics dataset discovery, PromQL editor and label browser, up to five queries, Range/Instant/Both execution, automatic or explicit step, time range and refresh, line chart with legend, sortable instant and range-summary tables, JSON/CSV export, dataset history, and shareable URLs. PromQL availability follows the server capability.
- Alerts: searchable, sortable lists with tag filters and 25-row pagination; PromQL and SQL threshold creation/editing, query previews without notifications, hold duration, runtime instances and delivery errors, evaluate/enable/mute/duplicate/delete actions, and Slack/Webhook/Alertmanager targets with masked secrets. PromQL creation requires explicit server capability; existing builder rules are read-only.
- Datasets: search, create logs/metrics/traces with an optional custom partition, manage information and ingestion/storage statistics, inspect schema, explore, set/clear retention, configure/disable hot tier when the server enables it, and delete with typed name confirmation. Time partitions cannot be set at creation. Static schema upload, tags/labels, existing partition editing and index management are not supported.
- Dashboards: server-backed lists and detail routes, search/tags/favourites/sort/pagination, ownership, full-document saves with conflict resolution, SQL and PromQL tiles, six variable types, URL time ranges and selections, classic import/export, and explicit migration of old browser-local dashboards. Demo dashboards use independent in-memory state per client.
- Team: native users and one-time passwords, role and privilege management, default OIDC role configuration, provider group mappings and role provenance, and API key creation/copy/deletion. Search and 25-row pagination apply to every tab; authorization stays with the backend.
- Component gallery at `/components`, plus isolated Storybook stories for UI, PromQL and chart components.

The default log query reads at most 100 rows, with choices up to 10,000. Message search assumes a `message` field. The histogram separately aggregates every matching event through `/query`, using the same captured bounds and predicates as the rows. Its 48 buckets divide elapsed time evenly; they are not calendar-day buckets. AND/OR filters have two levels, at most 12 groups and 50 rules, and support `=`/`!=`; SQL NULL values are excluded by both operators. Saved log views use server `/filters` CRUD, while copy links encode versioned explorer state with fixed absolute bounds. Context uses the existing `/query/context` endpoint with a 101-event bound and requires `p_timestamp` plus a string `message`, `body` or `log`. Large/wide results virtualize rows and columns; sorting and export cover loaded rows only. Wrapped virtual rows show a 96px preview; event details retain the full value. Timezones change display and wall-clock editing while requests retain UTC instants; DST gaps are rejected and repeated times require an earlier/later choice. Demo SQL intentionally supports only a small SELECT subset and rejects unsupported syntax. Full SQL requires a server. SQL multi-dataset generation uses `UNION ALL BY NAME`, fills missing columns with NULL and requires compatible types for common columns, and keeps the 100-row default; demo does not support unions. Incoming query links open or focus a tab while preserving other drafts. Reopening an already-open saved query focuses that tab and preserves its edits. The saved SQL library uses persistent browser local storage, while draft workspaces use session storage independent to each browser tab and survive navigation/reload. Both are scoped to the server and signed-in user (with a separate demo scope); they are not server-synced, and result rows are not persisted. Query handoff parameters are consumed after opening the tab so reloading an edited draft does not reopen the original query. SQL chart previews use the executed query and captured time bounds. Adding a chart to an existing dashboard preserves that dashboard’s time range; a new dashboard starts with the executed range.

Logs implementation keeps persisted settings in `logViewReducer.ts`, with explicit dataset reset, saved-view and classic-link transitions. `logFilters.ts` owns expression limits and additions; adding within a group and narrowing the whole expression remain distinct operations. `logQuery.ts` compiles canonical criteria once for the page's row and histogram queries. Changes to client-only filter IDs or empty groups do not refresh the captured time window. Histogram responses carry their bucket geometry to the renderer. Both table modes use `logTable.tsx` for sorting, labels and cells. `logsContract.ts` validates server payloads; `demoLogs.ts` implements the demo methods separately. Saved-view instants, server timestamps and timezone wall-clock inputs retain separate validators because their accepted formats differ.

Traces, APM, ingestion setup, server-synced SQL saved queries, SQL AI assistance, and original Prism pixel parity are future iterations. No unusable paid-feature navigation or upgrade controls are exposed.

## Components and selectors

```text
src/components/ui/        Native/Radix primitives; no fetching or feature state
src/components/explorer/ Shared table, chart, detail sheet, time picker, query states
src/features/            Small feature components and route orchestration
src/app/                 Shell, navigation, connection, client context
src/lib/                 Typed live client, demo adapter, safe query builder
src/styles/              Semantic theme tokens and application layout
```

Use `components/ui/index.ts` as the library entry. It imports primitive styles; consumers also load `styles/tokens.css`. Components are source-local, not yet published as a separate npm package. Storybook is the isolated development surface:

```sh
npm run storybook
```

The implementation preserves useful recovered hooks (`#main-section`, `data-sidebar`, `sidebar-*` test IDs, `data-field-node`, `lmt-sidebar-toggle`, `add-filter-button`, `data-filter-pill-id`, `data-dialog-confirm`, `data-tile-id`). `.ui-*` and feature classes are new semantic styles; generated Radix IDs must not be hardcoded. See [the component mapping](docs/component-map.md), [API contracts](docs/api-contracts.md), [Prism comparison and remaining gaps](docs/prism-parity.md), and [validation results](docs/validation-review.md).

## Checks

```sh
npx playwright install chromium
npm run check
```

Or run checks separately:

```sh
npm run build          # TypeScript + production bundle
npm test               # Client, escaping, demo query and error contracts
npm run test:ui         # Browser workflows + axe accessibility smoke checks
npm run test:prod       # Production build served at / and /next/ as the server mounts it, including missing page assets after a deploy
npm run test:stories    # Build Storybook and test isolated component interactions
npm run format:check
```

To use an installed Chromium, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium`. The default app suite uses isolated contexts, sample data and mocked HTTP. The separate live suite is opt-in and writes a small synthetic dataset (and an OIDC test reader role when enabled) to the explicitly supplied server:

```sh
PARSEABLE_LIVE_URL=http://127.0.0.1:8270 \
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium \
npm run test:live
```

Set `PARSEABLE_LIVE_USERNAME`, `PARSEABLE_LIVE_PASSWORD` and `PARSEABLE_LIVE_DATASET` for a disposable server; defaults are `frontend-smoke`, `local-smoke-password` and `frontend_smoke`. Page paths are at the root, as on a server built with `NEXT_ASSETS_PATH`; set `PARSEABLE_LIVE_BASE=/next` for a server started with `P_UI_ROOT=classic`. API calls always go to the origin root. Omitting `PARSEABLE_LIVE_URL` skips the live tests. Add `PARSEABLE_LIVE_OIDC=true` only with the local fixture provider configured, or `PARSEABLE_LIVE_NO_OIDC=true` with a provider-free server to exercise the real missing-provider route. `npm run check` excludes this suite. The completed default check passed **1263 unit tests in 45 files, 265 app browser tests, 16 production-build browser tests and 47 Storybook browser tests** (2026-10-11). The earlier Alerts validation (2026-10-09) also recorded a **60/60** repeated dark axe run and three passing live tests. The Team live tests create uniquely named users, roles and API keys, remove them afterwards and restore the server's previous default OIDC role. Metrics, Alerts and Dashboards live tests ingest unique OTLP datasets and delete them afterwards. The Datasets live test creates a uniquely named dataset through the UI and deletes it through typed confirmation. See [the live runbook and recorded results](docs/validation-review.md) for setup, exact commands, scope and limitations.

The Alerts live spec (`e2e-live/alerts.spec.ts`) creates a unique OTLP dataset, webhook target and PromQL rule, checks preview values and mutations against the API, and cleans up all three in `afterAll`, including after failures. Run it only against a disposable server. Set `TMPDIR` to a disk-backed directory when `/tmp` is small. The current Alerts checks and counts are recorded in [validation-review.md](docs/validation-review.md).

The Dashboards live spec (`e2e-live/dashboards.spec.ts`) ingests unique logs and OTLP metrics, creates SQL and PromQL tiles with variables through this frontend, verifies their stored classic shapes, and hard-loads the same dashboard on the classic origin. It also renders a literal classic-shaped Report fixture in this frontend, checks unknown-field preservation, and verifies admin ownership rules and `limit=0`. Cleanup removes all test dashboards, datasets, users and roles. The classic origin must be a server started with `P_UI_ROOT=classic`, or the native frontend answers there too. Both origins must point at the same disposable server and use the same hostname to share login cookies across ports (use `127.0.0.1` for both; mixing it with `localhost` fails). The spec checks this before ingesting:

```sh
PARSEABLE_PROXY_TARGET=http://127.0.0.1:8030 npx vite --host 127.0.0.1 --port 8271
# In another terminal, from frontend/:
flock /home/ajs/.cache/parseable-playwright.lock bash -c '
  while [ -n "$(ss -H -ltn "( sport = :5173 or sport = :6006 )")" ]; do sleep 5; done
  ss -ltn "( sport = :5173 or sport = :6006 )"
  TMPDIR=/home/ajs/.cache/dash-tmp \
  PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium \
  PARSEABLE_LIVE_URL=http://127.0.0.1:8271 PARSEABLE_LIVE_BASE= \
  PARSEABLE_LIVE_SERVER_URL=http://127.0.0.1:8030 \
  PARSEABLE_LIVE_USERNAME=admin PARSEABLE_LIVE_PASSWORD=admin \
  npx playwright test -c playwright.live.config.ts e2e-live/dashboards.spec.ts
'
```

On shared machines, run every Playwright invocation (including `npm run check`, `test:ui`, `test:prod` and `test:stories`) under this lock, checking ports 5173, 4180 and 6006 inside the lock before running. Do not reuse another worktree's server.

### Dashboard refresh

Dashboard views offer **Off / 15s / 30s / 1m / 5m** auto refresh, with Off as the
initial setting. This is a view preference; it does not change the saved dashboard.
The next interval starts after tile and variable queries finish. Manual refresh is
disabled during requests. Hidden tabs pause the timer and resume with a full
interval, without replaying missed ticks.

Rolling dashboard and tile ranges share a fresh time anchor for each refresh;
absolute ranges stay fixed. A failed refresh keeps each tile's last successful
data, chart time bounds, and timestamp visible, with an error and retry action.
The toolbar reports the most recent successful tile update; individual tile
timestamps show when their own data last succeeded. Failed queries are reported
separately, including when other tiles succeed. Changing query inputs clears
unrelated retained data. Queries time out after two minutes and can retry on the
next interval. Automatic updates announce failure and recovery transitions only.

`e2e/dashboard-refresh.spec.ts` covers timers, slow requests, failure/recovery,
visibility, variable queries, range overrides, and concurrent PromQL branches.
`Dashboards/Refresh` provides interactive slow-response, failure, recovery, and
timer stories, covered by `story-tests/dashboard-refresh.spec.ts`.

### Dashboard editing stories and tests

`Dashboards/Editing` renders the production dashboard with a deterministic in-memory
transport. Editable and read-only stories cover tile drag/resize, keyboard movement,
save/reload, Escape/Discard, section creation/rename/reordering/deletion, and transient
versus saved collapse through `story-tests/dashboard-editing.spec.ts`.

`Dashboards/Tile editor` provides visual authoring, stored SQL, legacy missing-type,
typed-filter/limit, and opaque-query examples. `story-tests/dashboard-builder.spec.ts`
checks generated SQL execution, preserved metadata, typed values, validation, ordering,
and chart-type changes against the production editor.

`e2e/dashboard-pointer-reorder.spec.ts` exercises vertical drags across siblings,
cancellation, and keyboard ordering after a committed drag.
`e2e/dashboard-builder-regressions.spec.ts` covers automatic time-bucket plotting,
explicit sort precedence with limited results, and save/reload without rewriting
legacy bindings or opaque metadata. The editing and builder Storybook interaction
tests also cover these regressions in isolation.

`Dashboards/Presentation` exercises the production presentation and PNG-export hooks
with deterministic canvas and SVG fixtures. `story-tests/dashboard-presentation.spec.ts`
checks focus/Escape behavior, retained state, shell isolation, and downloaded PNG pixels
and full scroll dimensions. These tests run with the complete Storybook suite in CI.

### Storybook chart regression tests

`story-tests/tile-chart.spec.ts` exercises real binding controls and `TileChart`: inherited
unsupported bindings, saving/reloading a corrected tile, independent legend toggles for
identical labels, and keyboard/pointer zoom with dashboard versus tile-specific ranges.
`story-tests/chart-visuals.spec.ts` compares chart screenshots in light and dark themes,
including a narrow tile. Baseline PNGs are versioned beside the spec; missing baselines fail.
CI runs these through `npm run check` and uploads image diffs and traces on failure.

Screenshot rendering depends on the OS, browser and fonts (see
[Playwright visual comparisons](https://playwright.dev/docs/test-snapshots)). Use the same
pinned Playwright image as `.github/workflows/frontend.yaml`, with the lockfile's Playwright
version, to reproduce or intentionally update baselines. From the repository root, after
`(cd frontend && npm ci && npm run build-storybook)`, run:

```sh
flock /home/ajs/.cache/parseable-playwright.lock docker run --rm --ipc=host \
  --user "$(id -u):$(id -g)" -e CI=1 \
  -v "$PWD:/work" -w /work/frontend \
  mcr.microsoft.com/playwright:v1.63.0-noble \
  npx playwright test -c playwright.storybook.config.ts --workers=2
```

Use your own lock location on other machines. Container ports are isolated from local dev
servers. To approve an intentional visual change, append `--update-snapshots` and restrict
the run to `chart-visuals.spec.ts`; inspect every changed PNG and rerun without the update
flag before committing. Do not regenerate baselines just to silence a failing comparison.
