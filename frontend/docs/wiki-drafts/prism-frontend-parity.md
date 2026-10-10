# Editable frontend: authentication and Prism parity iteration

Draft for review only. This file has not been published to the wiki or any external service.

The editable React/TypeScript frontend now more closely matches pinned Prism v3.2.4 in its supported shell, login, logs, SQL, datasets and dashboard surfaces. This is an independent implementation built around small shared controls and route-owned state; no minified Prism implementation was copied. Backend authorization remains authoritative. Payment, billing, Stripe, subscriptions, checkout and Clerk are excluded.

## Evidence and scope

[Prism parity evidence and prioritized gaps](../prism-parity.md) records the supplied archive identity, screenshots, observed login DOM, static feature labels/selectors, and actionable gaps. Prior research rendered only the unauthenticated original login, visibility toggle and password-reset information dialog. Static reachability does not establish a feature's availability, and the prior implementation screenshots are not original Prism screenshots.

The supplied OIDC wiki pages describe a separate checkout and deployed service. Their successful tests must not be attributed to this worktree. In particular, this worktree's Rust logout handler removes the local session and can redirect OAuth users to the configured identity provider logout URL. Documentation must follow the current handler and validated client behavior rather than assuming the previous deployment's logout overlay.

## Implementation and validation

Completed implementation and test results are recorded in [validation-review.md](../validation-review.md). [API contracts](../api-contracts.md) describe the requests made by the client and separate native login, OAuth navigation, session identity and query behavior. Planned or in-progress checks are not acceptance results.

Open parity work includes features outside the current route scope, richer SQL visualization/query tabs, dashboard sections/drag/resize and additional chart renderers, saved views, server-wide log counts, log context, dataset management and wide-schema virtualization. Dashboards now use the server in live mode and per-client memory in demo; legacy local copies are an explicit import source.

## Completed acceptance in this worktree

The worktree-built Rust server ran with disposable local storage and synthetic logs. The final live run passed seven browser tests with one expected provider-free-case skip, including native session invalidation/recovery, logs/filter/detail, DataFusion SQL success/error, Arrow schema and the full local mock OIDC callback round trip. A separate provider-free backend test passed through the real `/oidc-not-configured` redirect and native recovery. A no-URL invocation skipped all eight live tests. Production builds with demo disabled/enabled passed separate browser checks for opt-in behavior, stale selection handling and gallery availability. The complete default check passed: 36 unit, 33 app browser and 14 Storybook browser tests, formatting, TypeScript and both frontend/Storybook builds.

Authenticated original Prism and final editable screenshots now cover login, Logs, SQL, datasets and dashboards, with composed comparisons under `frontend/docs/parity-screenshots/`. Measurements drove the 48px global header, 192px navigation, 240px Logs field panel, compact summary rows and split login layout. These historical captures predate server-backed dashboards. The frontend retains UTC-only absolute-time editing and bounded returned-row histograms on Logs. These observations and tests establish the supported workflows, not pixel equality, real-provider compatibility or complete product parity.

## Server-backed dashboards (2026-10-10)

The dashboard wire contract now matches classic: SQL strings with dataset arrays, PromQL query/type arrays with one dataset string, six variable definitions, classic time ranges and `tile_id` ULIDs. Saves retain complete documents and unknown fields, compare fresh `modified` values and offer Reload or Overwrite. Ownership is SHA-256 of the user ID; even admins cannot update another owner's dashboard, though they can delete it. Selected variables and viewing ranges are shareable through the URL.

Classic import/export, browser-local migration, query/alert/explore handoffs and SQL/PromQL table/stat/timeseries tiles are implemented. Sections render in their stored order with independent grids, and section definitions and unsupported renderer data survive unchanged. Import and Duplicate preserve Report type and can create Report copies; the Create form makes Dashboard documents. Visual builder authoring, section authoring/reordering/collapsing, AI/templates/Enterprise surfaces, drag/resize, present/PNG and auto-refresh remain outside this phase. Relative ranges retain their anchor until the range changes or Refresh, matching classic. Per-item local-import progress and per-account attribution remain follow-ups. See the dated [validation results](../validation-review.md#dashboards-validation-2026-10-10) for the actual default and live checks.
