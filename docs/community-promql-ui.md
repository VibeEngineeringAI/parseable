# Community PromQL in Prism

The community server advertises `capabilities.promql`, `capabilities.promqlDashboard`,
`capabilities.promqlMetadata`, and `capabilities.promqlAlerts` in `/api/v1/about`. Prism uses these independent
capabilities for metric exploration, dashboard tile creation/editing/querying, and
PromQL dashboard variables. The server remains licensed as `OSS`; Enterprise AI,
summarization, and unrelated features keep their existing checks.

Prism v3.2.4 is supplied as compiled assets. The public
[parseablehq/console](https://github.com/parseablehq/console) source is an older UI
from May 2025 and does not contain the current PromQL dashboard implementation.
The supplied distribution has no source maps. This change therefore uses a small,
reproducible compatibility overlay over the supplied UI. Its readable capability
selector is `scripts/community-promql-capabilities.js`; the exact edits and input
SHA256 hashes are recorded in `scripts/community-ui-overlay.json`.

Seven modules are changed: the dashboard editor and variable form, the
dashboard tile renderer/actions, metrics chart/explorer capability checks,
the shared alert evaluation form, the create/edit alert query guards, and the alert detail view.
All original Enterprise selectors remain unchanged. An explicit boolean capability
overrides the previous feature check; servers without capability metadata retain
their prior Enterprise behavior. PromQL alert actions use their independent `promqlAlerts` capability.
The v3 overlay adds `promqlConfig.holdDuration` (for example `5m`, default `0s`)
to the native create/edit form alongside its dataset, expression, threshold,
evaluation interval, and target controls. PromQL rules may omit targets for state
tracking only; the form explains that notifications require a target. A separate instant preview displays
series labels, numeric values, and threshold results without sending notifications;
empty vectors show No Data and failed or non-vector queries show an error.
The alert detail view displays persisted evaluation health, errors, and per-series
pending/firing/resolved state from `promqlRuntime`. Failed notification deliveries
show their target, last error, attempt count, and whether retries are pending or exhausted.

Dashboard Create Alert resolves the current dataset and query variables into
explicit selections before opening the native form. The saved rule contains
those concrete values. Multiple queries, multiple datasets, or unresolved
variables keep the action disabled with an actionable explanation.

Editor previews resolve dataset and query variables using the same interpolation
helpers as saved tiles. The resolved dataset and expression are part of the query
cache key; the original variable templates remain in the editor and saved tile.
An unresolved dataset variable produces an actionable message, and preview API
or network failures appear as errors instead of an empty preview.

The existing UI calls `/prometheus/api/v1/query`, `query_range`, `labels`, and
`label/{name}/values` using normal session authentication and a `stream` parameter.
The server validates that parameter using the same dataset authorization as the
`X-P-Stream` header. Backend errors for unsupported PromQL operations remain visible
in the existing query UI; this overlay does not extend the evaluator's subset.

Normal Cargo builds apply the overlay automatically through `build.rs` and
`build_support/community_ui.rs`, then embed the prepared assets in the binary.
This build path needs no Node installation. The standard, debug, and Kafka Docker
builds include the manifest, capability helper, and Rust build support before
compilation. An explicit `LOCAL_ASSETS_PATH` embeds the supplied directory directly;
to use community capabilities with that override, supply an already-prepared UI.

To prepare an independent assets directory manually:

```sh
node scripts/prepare-community-ui.mjs /path/to/stock/dist /path/to/new/dist
node --test scripts/test-community-ui.mjs
```

The preparation tool verifies the original bytes and exact transformation counts
before creating the output. A different Prism release or altered stock module
fails closed and requires review of a new manifest. Source and output directories
must be separate; an existing output directory is never overwritten. The same
manifest can be applied by the Rust build without installing Node.
The standalone Node tool also writes a `community-ui-overlay.json` marker in its
output directory for inspection. The automatic Rust build does not require or
emit that marker; its JavaScript and HTML output matches the Node tool.

Every JavaScript module is emitted only under a fresh filename containing a
12-character overlay identity. The identity is the first 12 hexadecimal characters
of SHA256 over the raw manifest bytes followed by the raw addition source bytes in
manifest order. Static imports, dynamic imports, Vite preload paths, and the HTML
entry reference that complete versioned graph. Changing either the manifest or
helper changes all JavaScript URLs, preventing reuse of a cached stock module.
Original filenames are not shipped, so tabs opened before a deploy must reload.

Verification passed: fifteen Node tests cover capability fallback, disabled capability
precedence, preview errors and unresolved datasets, bundled-name collision handling,
unsupported assets, ambiguous edits, identity framing, and executable static/dynamic
import graphs. Alert coverage includes capability independence, concrete dashboard
inputs, numeric conditions, hold edits preserving native targets, notification-free
preview requests, No Data, unsupported result types, and backend error reporting. Rust and Node preparation produced identical bytes
for all 647 shared output files. Docker COPY ordering and availability of the
build inputs were checked; Docker images were not rebuilt.

The live community service was also checked in the browser over its Tailscale URL.
The metrics Explore builder discovered eight supported metric names in the real
OTLP dataset and plotted `{"system.cpu.load_average.15m"}` over one hour as one
series with the host label. The page loaded the versioned overlay module, and
Summarize remained disabled. Instant results were correctly empty because that
collector's latest sample was older than the five-minute lookback. No existing
datasets or dashboards were modified during this check.

The editor preview was checked on the existing Load Averages tile with the v2
asset graph (`b9b3d6897163`). All three range queries returned HTTP 200 using the
concrete dataset and host value, and explicit Run rendered three line series.
The editor retained `$metrics_dataset` and `$host` in its original templates.
An unsaved `nonexistent_function()` query displayed the backend error inline;
restoring the original query and running again cleared the error and redrew the
chart. No changes to the existing dashboard were saved.

The v3 alert overlay was checked in headless Chromium against the running community
service. A temporary OTLP fixture returned host-a=9 and host-b=3; the numeric
preview showed the first breached and the second within threshold. A targetless
rule saved successfully, displayed independent pending/resolved instances, and
retained hold-duration edits across save/reload. An unsupported function appeared
as an inline preview error; restoring the expression cleared it. All temporary
alert and dataset fixtures were deleted successfully. The existing Mac dashboard's
Uptime action opened the native form with its concrete current dataset and an
interpolated host matcher, preserving the resolved expression in the raw PromQL
editor. That popup was closed without saving; the existing dashboard was unchanged.
No browser page errors occurred during these checks.
