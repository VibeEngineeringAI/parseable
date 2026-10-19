# Agent-driven dashboards

Dashboard editing runs inside the existing Parseable server. REST, the native
frontend, and external tool calls use the same authoritative write service.
Configuration validation and change preview never execute queries.

## Agent workflow

1. Discover `get_dashboard_capabilities`, available datasets, and their schemas.
2. Create a dashboard using `create_dashboard` and a caller-generated stable
   `idempotencyKey`. The result contains the dashboard ID and opaque revision.
3. Build a batch of configuration changes using stable tile IDs, section IDs,
   and variable names. Keep those identities across retries.
4. Call `preview_dashboard_changes` with the observed revision. Inspect its
   candidate document, validation report, and diff, including layout changes.
5. Call `update_dashboard` with that revision, operations, and a new stable
   idempotency key. On a revision conflict, fetch the current dashboard and
   reconsider the intended edits before retrying. Never silently overwrite.
6. Explicitly call `run_dashboard_queries` with selected tiles, time bounds, and
   variable values. Query results do not change the saved configuration.
7. Read the dashboard back to verify the accepted revision and configuration.

An agent can create and edit SQL, visual-builder, and multi-query PromQL tiles,
chart styles, sections, variables, layouts, and saved time/refresh defaults.
The dashboard's `dataset` is the default for newly authored tiles. It does not
rewrite existing SQL or switch every tile's own `dbName`.

## External tool policy

The canonical registry and executor remain at:

- `GET /api/prism/v1/llm/tools/list`
- `POST /api/prism/v1/llm/tools/call`

Set `P_DASHBOARD_AGENT_WRITES=true` (or `--dashboard-agent-writes=true`) to enable
the four external dashboard mutation tools: `create_dashboard`,
`update_dashboard`, `save_tile`, and `delete_dashboard`. This is an explicit
operator standing policy. Normal dashboard RBAC, tenant suspension, and
owner/administrator checks still apply to every call. A grant to create or edit
dashboards does not grant dataset query access. No alert or notification mutation
is enabled by this setting.

The tool transport authenticates the session/API key independently of the chosen
tool. Catalog discovery retains its existing `Query` authorization and suspension
gate. Dashboard configuration calls do not require `Query`. Explicit query
execution requires `Query` and access to every referenced dataset; saved dashboard
execution also requires `GetDashboard`. Credentials and API keys keep their
existing scope, expiry and revocation behavior.

`get_dashboard_capabilities`, `validate_dashboard`, `preview_dashboard_changes`,
and `run_dashboard_queries` are available as separately described tools. Discovery
includes effect annotations and dashboard output schemas. Completed tool failures
retain MCP's HTTP 200 + `isError: true` shape and include machine-readable error
code/status/details under `structuredContent.error`.

The external MCP adapter remains a client of this registry. A current adapter
that forwards registry tools and calls can discover these tools from the server;
REST endpoint additions alone do not become tools.

## REST endpoints

| Method | Path | Behavior |
| --- | --- | --- |
| GET | `/api/v1/dashboards/capabilities` | Supported configuration, patch operations and limits |
| POST | `/api/v1/dashboards/validate` | Validate a complete raw dashboard document without saving |
| POST | `/api/v1/dashboards` | Create a raw dashboard document; optional `Idempotency-Key` |
| GET | `/api/v1/dashboards` | Fresh summaries; optional `query`, `tags`, `after`, `limit` |
| GET | `/api/v1/dashboards/{id}` | Authoritative document, JSON `revision`, and quoted `ETag` |
| PATCH | `/api/v1/dashboards/{id}` | Atomic ID-addressed batch; requires observed revision |
| POST | `/api/v1/dashboards/{id}/validate` | The same batch as a dry run |
| PUT | `/api/v1/dashboards/{id}` | Full replacement; optional header or body revision for legacy unkeyed PUT |
| PUT | `/api/v1/dashboards/{id}/add_tile` | Add one raw tile using shared delta semantics |
| DELETE | `/api/v1/dashboards/{id}` | Conditional logical deletion |
| POST | `/api/v1/dashboards/preview` | Explicit bounded query execution without saving |

REST returns a dashboard document for existing create/GET/PUT/add-tile routes.
PATCH and change preview return `{dashboard, revision, validation, diff}`;
replays add `replayed` and `appliedRevision`. `validation` contains `valid`,
`errors`, and `warnings`. Errors identify the operation/entity/field where
possible. The tool list response uses `dashboards` and `nextCursor` so agents can
page through larger tenants; pass that cursor as `after`.

## Patch format

This is a Parseable patch envelope with RFC 6901 field pointers, not the RFC 6902
JSON Patch media type. Collection targets use stable identities rather than array
indices. Unknown legacy fields retain their values.

```http
PATCH /api/v1/dashboards/01ARZ3NDEKTSV4RRFFQ69G5FAV
If-Match: "<revision-returned-by-GET>"
Idempotency-Key: agent-layout-change-01
Content-Type: application/json
```

```json
{
  "operations": [
    {
      "op": "replace",
      "target": {"type": "tile", "id": "01ARZ3NDEKTSV4RRFFQ69G5FAW"},
      "path": "/chartQuery",
      "value": "SELECT COUNT(*) AS requests FROM app_logs"
    },
    {
      "op": "placeTile",
      "tileId": "01ARZ3NDEKTSV4RRFFQ69G5FAW",
      "layout": {"x": 6, "y": 0, "w": 6, "h": 4}
    }
  ]
}
```

Targets are `{type:"dashboard"}`, `{type:"tile",id}`, `{type:"section",id}`,
and `{type:"variable",name}`. For an entity target, an empty pointer adds,
replaces or removes that whole entity while keeping its identity. Paths within
an entity use normal JSON Pointer escaping (`~0`, `~1`). Root replacement through
the dashboard target is rejected. Edit collections using entity targets.

`add` follows JSON Patch member/array insertion semantics; `replace` and `remove`
require an existing value. Named operations handle compound behavior:

- `placeTile`: section-aware movement and deterministic placement/compaction.
- `renameVariable`: rename a definition and rewrite supported references.
- `reorderSections`: an exact permutation of addressable section IDs.
- `removeSection`: explicitly unsection, move, or delete its tiles.

Use capability schemas for exact argument shapes and chart-specific settings.
IDs for added tiles/sections are supplied by the caller and remain stable across
dry run and apply. The capabilities response supplies fresh `generatedIds` for
agents that need tile/section IDs without a local ULID generator. A batch is bounded and validates only its final candidate,
so query language and its dependent fields can change together.

## Validation and runtime separation

Saving checks configuration structure and relationships: title, identities,
section references, variable definitions/dependencies, 12-column layout bounds,
query-mode field shapes, and known chart/style constraints. It does not promise
that datasets, SQL, PromQL, schemas, query results, or future executions are valid.
Existing unsupported legacy defects are reported separately from newly introduced
invalid changes. Unknown extension fields are preserved rather than interpreted
as newly supported renderer features.

Server-owned identity, tenant, owner, creation/modification metadata, revision,
and `_parseableDashboard` internals cannot be patched by an agent. Full
replacements preserve trusted identity and ownership and never accept a tenant
from the request body as a storage location.

Explicit query preview accepts exactly one of `dashboardId` or `document`,
optional proposed operations/source revision/selected `tileIds`, RFC3339
`startTime`/`endTime`, variable selections, and `rowLimit`. It uses the caller's
normal query paths and returns results/errors per tile. SQL builder compilation,
variable substitution, and PromQL instant/range/sparkline selection mirror the
native frontend's supported execution rules.

Runtime bounds: 16 admitted preview requests, 8 global SQL executions, 4 concurrent
tiles per preview, 32 selected tiles, 8 actual PromQL executions per tile, 31-day
range, 30-second total deadline, at most 500 rows, and 1 MiB response. Dataset and
PromQL label-metadata variables require explicit selections in preview. Text,
list, SQL and PromQL-query variables can resolve automatically. A missing saved
default in bounded dynamic options is reported instead of silently substituting
a different selection. Runtime selections do not alter saved defaults.
PromQL preview uses a separate eight-request admission pool and at most two
evaluations, leaving two shared evaluation slots available to normal browser
queries. Timed-out blocking evaluations retain their permits until they finish.

## Concurrency and retries

Every dashboard write uses authoritative object bytes and a storage precondition.
The opaque public revision fingerprints document content and a per-commit nonce;
changes invalidate it even if an older writer preserves internal metadata.
A same-revision race yields one accepted mutation and revision conflicts for the
others. A `412` includes the current revision. Missing required revision is `428`.
Pass a single strong quoted ETag in `If-Match`; raw JSON revisions are accepted
for compatibility. Weak/wildcard/list preconditions are rejected.

Legacy unkeyed REST PUT accepts a full replacement without a revision. The
server captures the authoritative source revision once and commits through the
same conditional storage path; an intervening write returns 412 without retrying
the replacement against newer data. A client body prepared before the request
can still overwrite earlier edits: detecting that intent requires the caller to
send its observed header/body revision. This is an inherent limit of the legacy
unversioned replacement contract. PATCH, keyed mutations and agent tools retain
the explicit revision requirement. Legacy unkeyed favorite/tags/add-tile
operations apply their delta to fresh state, retrying storage contention at most
eight times.

Agent mutation keys are bound to the authenticated principal, tenant, dashboard,
operation and arguments. Creates use a deterministic ID for keyed retries. Recent
mutation receipts are durable and bounded to 64; the create receipt is retained
separately. A replay returns current configuration with
`replayed: true` and the original `appliedRevision`. The original source revision
still prevents accidental reapplication after receipt eviction. Reusing a key
with different arguments is an error. Replaying a create or update after deletion
returns `410 resource_deleted` with its original applied revision; retrying an
already applied delete still succeeds.

The native UI sends its observed revision for saves and deletion confirmations.
If another writer changes the dashboard, the UI keeps the conflict visible and
requires a fresh decision; it does not automatically repeat the deletion.

Deletes write a conditional tombstone because cloud object storage does not offer
conditional deletion through the current storage interface. Tombstoned dashboard
IDs never resurrect. Per-title reservations enforce unique titles without a
network-held global dashboard lock; unrelated dashboards can make progress.
Write commits survive cancellation of the calling request. Interrupted claims
after a process crash resume with the original idempotency key. A pending rename
whose source write is fenced out can be recovered; an interrupted unkeyed create
before document commit can require operator recovery. This limitation is reported
as an explicit reservation conflict, never handled by unsafe lease stealing.
Storage write errors are reconciled against the commit nonce. When an unkeyed
write can be safely fenced, its unused title reservation is released; a later
edit using the committed title keeps that reservation. If storage stays
unavailable during reconciliation, recovery can still require an operator.

All serving/writing nodes must be upgraded before relying on conditional-write
semantics; old binaries or direct object-store writes do not participate in the
protocol. Unsupported conditional storage fails explicitly. Rolling back to old
binaries while tombstones exist is unsupported. Tombstones/locators/title records
are metadata, not a separately deployed service.

Legacy dashboard discovery runs once per tenant and server process, with
singleflight initialization. Unknown IDs still check their canonical locator,
so new dashboards created by another server remain visible. Cached legacy title
candidates are rechecked against authoritative documents. Listing currently
reads all dashboard documents in the tenant, including compact tombstones, before
filtering and pagination; it is not an indexed constant-cost listing operation.
Malformed JSON records are skipped in listings/tags, as in the legacy loader;
storage failures still surface. Default REST listing sorts by modified time
(descending), `limit=0` means all, positive limits have no new cap, `tags` ignores
`limit`, and an empty tags filter is a 400. An explicit `after` parameter opts
into ID-ordered cursor pagination; dashboard tools also use ID order. Existing
REST errors retain their plaintext status/body contracts; PATCH/tool and new
concurrency errors are structured.

Rollout remains blocked until supported S3/MinIO, Azure and GCS configurations
are checked for conditional writes and parent-owned CPU/RAM benchmarks pass.
Mixed old/new serving nodes are unsafe: old nodes may expose tombstones as live
dashboards or overwrite metadata without CAS. Upgrade all nodes together and do
not roll back with tombstones present. No unconditional fallback is implemented
for backends that reject conditional writes.
Dry runs check current title availability without reserving it; concurrent writes
can change that availability before commit.

## Verification

Run pure patch/validation, shared-service concurrency, storage-CAS and runtime
parity tests with the server's Rust test suite. The frontend suite covers quoted
If-Match, conflict/retry/overwrite races, unknown-field preservation, and saved
refresh defaults. The separate `pb-rs` repository has dashboard CLI commands and
mock-server tests.

A disposable real-server smoke is provided:

```sh
PARSEABLE_URL=http://127.0.0.1:9084 \
DASHBOARD_AGENT_REPORT=/path/to/report.json \
python3 scripts/test-dashboard-agent.py
```

Start that server with `P_DASHBOARD_AGENT_WRITES=true`. The smoke creates uniquely
named logs/metrics datasets and an empty dashboard, configures SQL/builder/PromQL
panels through tools, checks dry-run/validation/retry/identity behavior, races 24
same-revision writes, rebases eight concurrent tile additions, renames a variable,
moves a tile, and explicitly executes all three query modes. It cleans up its own
resources and reports observed latency; measurements describe that local run,
not a production throughput guarantee.

### Local verification, 2026-10-17

- Rust library suite: 756 passed, one ignored; server binary built successfully.
- Frontend full suite: 2,418 passed, 14 skipped. After conditional-delete support,
  37 focused tests, two browser regressions and the TypeScript/Vite build passed.
- Rust `pb` suite: 160 passed. All ten dashboard commands also passed a real
  loopback-server lifecycle (22 invocations, 18 assertions), including SQL preview.
- Final-server agent lifecycle: empty dashboard to SQL, visual-builder and PromQL
  panels; expected results were 20 requests, five errors, and metric value 20.
  Dry-run, invalid-batch rollback, retry replay, variable rename, tile movement,
  unknown-field preservation and unchanged configuration after query execution passed.
- Twenty-four concurrent same-revision writes produced one winner and 23 revision
  conflicts. Eight agents explicitly rebased additions and retained all eight.
  Observed local request latency was 16.08 ms median and 21.82 ms maximum for that
  same-revision race. This single disposable run is not a throughput guarantee.
- Live scoped-reader checks allowed own dashboard configuration, refused another
  owner's mutation and denied queries against an ungranted dataset. Disabled-write
  policy hid/refused mutation tools; anonymous and invalid credentials were rejected.

Cloud adapters compile and their shared conditional-write path is tested through
`MetricLayer`/`LimitStore` with an in-memory object store. Live S3, GCS and Azure
services were not exercised in this workspace; verify the target provider's
conditional-write behavior before rollout. No deployment was performed.
