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

Development requests to `/api` proxy to `http://127.0.0.1:8000`. Set a different target when starting Vite:

```sh
PARSEABLE_PROXY_TARGET=http://127.0.0.1:8080 npm run dev
```

The proxy preserves the browser Host so the backend can validate the same-origin login redirect. Configure the backend OAuth callback for the frontend origin (for example `http://127.0.0.1:5173/api/v1/o/code`) and allow that origin where required. Do not put credentials in the proxy URL. `/oidc-not-configured` explains missing provider setup and offers native login. A 403 stays a permission error; it never substitutes demo results.

## Build and embed in Parseable

While this frontend reaches parity, Parseable serves it **beside** the classic Prism UI: Prism stays at `/` and this frontend is mounted at `/next/`. Both share one origin, so one sign-in (native or OIDC) works in both. Each page has a **Compare in classic UI** link that opens the equivalent Prism page in a new tab, and a **Classic UI** sidebar group links to features not built here yet (alerts, users, roles).

Release builds use **Node 24**. `npm run build` targets the `/next/` base path. From this directory:

```sh
npm ci && npm run build
cd ..
NEXT_ASSETS_PATH="$PWD/frontend/dist" cargo build --release
```

On PowerShell, set `$env:NEXT_ASSETS_PATH = (Resolve-Path frontend/dist).Path` from the repository root before running `cargo build --release`.

All Parseable Dockerfiles build the frontend in a Node 24 stage and set `NEXT_ASSETS_PATH`. The build/release workflows also build it before Rust, including Windows, macOS, and Kafka variants. Cross receives `NEXT_ASSETS_PATH` through `Cross.toml`; its absolute path stays inside the mounted workspace. Without `NEXT_ASSETS_PATH`, nothing is mounted at `/next`. The build script tracks changes to the assets and environment variable. Point it at `frontend/dist`, not the source directory or Storybook output.

The classic UI at `/` is unchanged: plain Cargo builds download the Prism ZIP pinned in `Cargo.toml` and apply the community overlay, and `/api/v1/about` reports its version. `LOCAL_ASSETS_PATH` still replaces the root UI as before.

When this frontend replaces Prism, remove `--base=/next/` from the build script, serve it at `/` via `LOCAL_ASSETS_PATH` (or a hosted ZIP pinned in `Cargo.toml`), and remove the `/next` mount, the community overlay, and the classic UI links.

To package the already-built `dist/` (from this directory):

```sh
npm run package
```

This creates `build.zip` with a top-level `dist/` directory, including `dist/index.html`, and `build.zip.sha1`. The script prints the ZIP's SHA-1 and writes the same checksum in `sha1sum -c` format. It uses sorted entries, fixed timestamps and permissions, and no extra package dependencies; identical assets produce identical ZIP bytes with the same Node/zlib version. The frontend CI uploads both files as the `parseable-frontend` artifact, and the release workflow attaches both to the GitHub release. The ZIP contains the `/next/`-based build until the switch above.

`npm run preview` previews the production assets at `http://127.0.0.1:4173/next/`. It has no API proxy; use demo mode, or use `npm run dev`/the embedded server for API calls.

## Working features

- Compact workspace shell, collapsible navigation, light/dark theme, server-preferred signed-in identity, and logout. Standalone two-panel login includes password visibility and the administrator-contact password-reset dialog.
- Logs: dataset selection, preset/absolute UTC time ranges, message search, exact field filters, searchable fields and columns, bounded event distribution, sortable/wrappable paginated results, JSON/CSV export, event details, include/exclude/copy actions, and handoff to SQL.
- SQL: dataset explorer, CodeMirror editor, Ctrl/Cmd+Enter execution, time range, query errors, shared sortable/wrappable results, column selection, and JSON/CSV export.
- Datasets: search, schema inspection, explorer navigation.
- Dashboards: create, persist/reload, and confirm deletion of browser-local event-volume tiles; demo and live definitions use separate storage keys. These are not synced to the server and do not yet support arbitrary layouts or queries.
- Component gallery at `/components`, plus eight isolated Storybook stories.

The default log query reads at most 100 rows, sorted by `p_timestamp`. Message search assumes a `message` field. The histogram represents returned rows, not total stream volume. Demo SQL intentionally supports only a small SELECT subset and rejects unsupported syntax. Full SQL requires a server.

Metrics, traces, APM, alerts, team administration, ingestion setup, saved queries, server dashboards, virtualized tables, and original Prism pixel parity are future iterations. No unusable paid-feature navigation or upgrade controls are exposed.

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
npm run test:stories    # Build Storybook and test isolated component interactions
npm run format:check
```

To use an installed Chromium, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium`. The default app suite uses isolated contexts, sample data and mocked HTTP. The separate live suite is opt-in and writes a small synthetic dataset (and an OIDC test reader role when enabled) to the explicitly supplied server:

```sh
PARSEABLE_LIVE_URL=http://127.0.0.1:8270 \
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium \
npm run test:live
```

Set `PARSEABLE_LIVE_USERNAME`, `PARSEABLE_LIVE_PASSWORD` and `PARSEABLE_LIVE_DATASET` for a disposable server; defaults are `frontend-smoke`, `local-smoke-password` and `frontend_smoke`. Omitting `PARSEABLE_LIVE_URL` skips the live tests. Add `PARSEABLE_LIVE_OIDC=true` only with the local fixture provider configured, or `PARSEABLE_LIVE_NO_OIDC=true` with a provider-free server to exercise the real missing-provider route. `npm run check` excludes this suite. The completed default check passed 36 unit, 33 app browser and 14 Storybook browser tests. The final live run passed seven tests with the provider-free case skipped; that case passed separately. See [the live runbook and recorded results](docs/validation-review.md) for setup, exact commands, scope and limitations.
