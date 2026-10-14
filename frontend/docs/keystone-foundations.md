# Keystone foundation increment

Branch `feat/keystone-foundations`, based on commit
`bd20b0431ab2e5a50d8e159bb01ae19f72487778`. Native Keystone is opt-in: without the deployment
inputs described below, every Keystone surface reports itself unavailable and nothing is
initialized.

> **Status: merge-readiness fixes implemented and validated.** The frontend CI pipeline and the
> clean backend validation both passed on the final source, subject to the baseline and
> host-toolchain notes in [validation status](#validation-status). This document makes no
> production-readiness claim. Later local runtime and paid-provider observations, with remaining
> readiness findings, are recorded in [native browser validation](keystone-browser-validation.md#live-validation-boundary).

## Implemented backend

`src/keystone` is native Rust, independent of the classic Keystone records.

- Versioned investigation/node/run/scope/export/context/evidence/artifact/event records.
- A child context contains only its direct parent's own prompt, completed answer, approved scope,
  explicitly selected authorized evidence, and the child's prompt. It cannot load ancestor
  transcripts or sibling content. Context bytes, export hash and context hash are immutable. The
  provider projection excludes authorization identity metadata; the internal manifest has a
  separate integrity hash. Branch creation pins the context on the node version, and execution
  reuses that exact package. A root has no inherited package.
- Absolute time bounds remain unchanged unless a scope change is explicitly reviewed.
- Private tenant/owner access and current exact Query/dataset checks. Runtime tenant identity is
  taken from the authenticated session, not request headers. LLM grants and internal-stream
  exceptions do not confer dataset access.
- A local repository uses `.keystone_native/v1`, a process-exclusive file lock, immutable
  SHA-256-addressed JSON objects and a manifest published last. It has durable idempotency,
  distinct semantic/layout revisions, and restart recovery that marks unfinished runs interrupted
  without rerunning them.
- An injectable coordinator allows four simultaneous executions, up to sixteen accepted runs (at
  most eight per tenant across owners), one active run per node, a 120-second deadline, and one
  model step. Completed node versions need a new immutable version to run again. There is no
  autonomous tool loop. Cancellation is described [below](#cancellation-and-teardown).
- An owned read-only facade accepts typed schema/sample operations, never arbitrary SQL, HTTP
  request objects, stored SessionKeys, mutation tools or client graph context. Current grant
  checks happen before dispatch and before publishing results.
- Separate stateless model and advisory decision interfaces. Jev and OpenAI Luna fixture codecs
  preserve native score/confidence/refusal semantics. Destination binding and every-address
  authorization are tested independently of transport.

## Native HTTP surface and gating

All and query server routes register `/api/prism/v1/keystone/native`. Ingest exposes the same
explicit unavailable capability surface; it never initializes the repository. Prism and index
modes are disabled if this scope is mounted by their hosting code.

Storage is enabled only when an operator sets `KEYSTONE_NATIVE_DIRECTORY` on **one designated
coordinator**. See [deployment inputs](#single-coordinator-deployment-inputs). Missing or locked
storage reports unavailable; a failed commit reports degraded storage and requires a
restart/reopen.

| Route suffix                                                                                                                | Implemented behavior                                                                  |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `GET /capabilities`                                                                                                         | JSON readiness and explicit unavailable reasons                                       |
| `GET/POST /investigations`                                                                                                  | Authorized private summaries / idempotent draft creation                              |
| `GET /investigations/{id}`                                                                                                  | Filtered domain snapshot, current dependency checks                                   |
| `POST /investigations/{id}/nodes`                                                                                           | Completed direct-parent branch and pinned context; no execution                       |
| `PUT /investigations/{id}/layout`                                                                                           | Presentation-only save with expected layout revision                                  |
| `POST /investigations/{id}/runs`                                                                                            | Idempotent explicit run; 503 before acceptance if execution/provider is unconfigured  |
| `GET /investigations/{id}/runs/{run}/events?after=N`                                                                        | Authenticated live fetch SSE and committed replay; renewed current-authority observer |
| `POST /investigations/{id}/runs/{run}/cancel`                                                                               | Requests cancellation; a claimed run returns its current status until teardown ends   |
| `PUT /providers/credentials`                                                                                                | Admin-only encrypted credential entry; fails closed without deployment configuration  |
| `GET /ui/capabilities`, `GET /investigations/{id}/graph`, `/presentation`, `/nodes/{node}/export`, `/nodes/{node}/evidence` | Strict browser projections after ownership and current scope authorization            |

The native execution runtime wires current credential grants, real scoped DataFusion samples,
encrypted local credentials and OpenRouter generation. It samples each approved dataset (up to 25
rows each), preserves immutable bounded evidence, then makes one text-generation request. This is
sample-based analysis, not exhaustive statistics or a model-generated SQL/tool loop. The provider
is unconfigured until an administrator stores a destination-bound credential. The generation
request is non-streaming: SSE carries committed progress/evidence events and the completed answer
checkpoint, not incremental tokens from OpenRouter. Provider routing and privacy requirements are
in [provider foundations](keystone-providers.md#openrouter-generation-adapter).

Each query uses a dedicated 32 MiB tracked DataFusion memory pool and disables spilling. That is
not a process-wide memory or cumulative scanned-byte bound. Keystone manifest decoding admits at
most 8 MiB encoded per manifest and 16 MiB decoded cumulatively per read, uses two blocking
workers and an 8 MiB Zstandard window, and checks cancellation while decoding. Worker permits
remain held until the worker actually stops. Wide windows may exceed these limits and fail
closed; a 30-day scope is retained rather than silently narrowed. Unsupported stored filters fail
closed rather than being ignored.

Ordinary (non-Keystone) queries keep the original in-memory manifest decoder. The checked,
budgeted streaming decoder runs only when a Keystone read has a decode budget in scope.

Metadata hydration is read-only against the configured object-store metastore. It validates at
most 64 selected catalog documents, 1 MiB per document and 8 MiB per dataset batch, checks
tombstones and conflicting partition metadata, and installs only an in-memory stream cache entry.
That cache is shared with normal server query paths. No canonical `.stream.json` or schema is
synthesized or published. Unsupported metastore backends fail closed. Local file reads have a
byte cap; cloud catalog reads admit listed sizes and check returned bytes, but the existing cloud
`get_object` still buffers its response. The limits are not a process-wide or strict cloud
transport-memory guarantee.

Native reads capture the validated catalog and preserve the default-tenant root path or the exact
named-tenant/dataset prefix. Older pre-manifest data uses the same tenant-bound prefix, with a
maximum 366-day discovery window and 4,096 prefixes/directory results. Oversized discovery fails
without narrowing the saved scope. Storage metadata, manifest paths and physical file paths still
assume trusted operators/ingestors/bucket writers; they are not a sandbox for compromised storage.

### Request execution and concurrency

HTTP handlers do no repository I/O on their worker threads. Every repository call from a handler
(reads, list, create, layout, branch, run start, cancel, the initial events lookup and each
live-progress poll) runs as a job on a bounded blocking pool of four slots per repository.
Callers wait for a slot before a blocking thread is used, so a waiting request that disconnects
costs nothing. Once a job starts it runs to completion even if its caller disconnects, so a
durable commit is never abandoned halfway.

Accepted runs execute on a dedicated runtime with four `keystone-execution` worker threads, not on
HTTP workers or the query runtime. Starting a run commits the acceptance and dispatches the
execution inside the same job, so a client that disconnects after acceptance cannot leave a run
queued but never started. Retrying with the same idempotency key returns the same run without a
second execution. The readiness check reads a health flag and does not wait behind a commit.

A queued job does not trust the access resolved before it waited. Immediately before its lookup,
projection or commit, each job rechecks the caller's current session or API key and current roles.
The request keeps only the session-derived principal and salted credential digests, never the
request, session key, password or API key, and the binding expires after 180 seconds. An ended or
expired session, a rotated, expired or removed API key, a removed user or a wait longer than 180
seconds returns 401 `authentication_required` before anything is looked up. A role removed during
the wait narrows access, so the dataset is reported as the usual 404 `not_found`. The recheck only
ever narrows the access issued to the request: a role granted during the wait adds nothing. These
rechecks need no execution service or provider, so a storage-only server stays readable. The
recheck runs just before the protected work; revocation is not atomic with writing the response.

Durable commits still hold the repository mutex, and coordinator checkpoints remain synchronous
whole-state commits on those threads. A job can wait on that mutex while a commit is in
progress, and live-progress polls share the four slots with start and cancel. This is a
single-process, single-coordinator design; there is no distributed coordinator.

### Cancellation and teardown

Cancelling a claimed run, or reaching its 120-second deadline, signals the run and returns its
current non-terminal status; the client sees "cancellation requested". The coordinator then waits
for the run's top-level query task to be dropped before it frees the execution permit and
admission slot and records exactly one terminal (Cancelled, or Failed with `deadline_exceeded`).
A queued run that has not been claimed is cancelled immediately.

The wait is bounded by a 10-second grace period. Work blocked inside a single poll cannot be
dropped until it yields. If teardown does not finish in time, the run records
`<reason>_teardown_pending` (for example `cancelled_teardown_pending`) and the stuck task keeps
holding the run's permit and admission slot, so a new attempt on that node is refused until it
unwinds. Durable replay keeps working meanwhile.

The guarantee covers the **top-level** query task and its resource accounting, not every unit of
work it started. DataFusion child tasks, manifest decodes on blocking threads and local file reads
on blocking threads can briefly outlive the top-level task until they reach a cooperative
cancellation point. Each is bounded by its own limits (decode budget, memory pool, file byte cap)
and its result is discarded. A terminal status therefore does not mean that every such resource
has already stopped.

## Full page and reusable UI

The native page lists, creates and reopens private durable investigations. Creation saves a
draft; only **Run question** starts execution. Storage readiness is independent of provider
readiness. The browser adapter maps native DTOs, preserves server export hashes, uses
authenticated fetch SSE with replay, and reports errors instead of simulating success. The demo
workspace retains its explicit capability notice.

The page reads `GET /capabilities` first and gates everything else on it:

- **Readiness.** Storage that is unconfigured, degraded or disabled in this server mode is shown
  with its specific reason (`repository_unconfigured`, `repository_degraded` or `mode_disabled`)
  instead of an empty workspace. Storage readiness is reported separately from provider readiness.
- **Denial.** 401 and 403 responses are treated as denied before the content type is checked,
  including the plain-text responses from the authentication middleware. The response body is
  never read or echoed. HTML or other non-JSON success responses and schema mismatches are
  reported as unreadable, not as denial.
- **Dataset loading.** Datasets are listed only after capabilities are ready and the page gate is
  open. Leaving the page, opening another investigation or reloading capabilities cancels the
  load and discards any late result.
- **Classic fallback.** When the native page is mounted under `/next` beside the classic UI and
  cannot open, it links to the classic investigation (`/keystone/investigation`) or classic
  Keystone index (`/keystone`). When the native UI is served at the root there is no classic UI
  beside it, so no classic link is shown.

Administrators enter the provider key on the investigation list; the page no longer links to the
classic LLM settings.

Cards can be collapsed without changing semantic context. Their expanded dimensions are
preserved; Auto format uses the visible collapsed height. Expanding into another card offers
manual Auto format and never moves the camera automatically. Selected parent evidence is
unchecked by default and only the sources explicitly selected are passed to a child.

Full-page Storybook fixtures explicitly label synthetic storage and mock inference. They are not
production fallbacks. Browser and backend tests use no API key.

See [browser validation](keystone-browser-validation.md) for interaction checks and how to
regenerate artifacts, and [provider foundations](keystone-providers.md) for the exact provider
contracts and source provenance.

## Run navigation and follow-up questions

Queued and active runs have direct links and an activity panel with Queued, Reading data, Writing
answer and Result stages. Links preserve node/run selection on reload and require existing
private-owner authorization. Reconnect resumes recorded events without submitting a new run.
Missing history is marked unknown; there is no invented queue position, ETA, percentage or token
streaming.

A completed selected card exposes **Add follow-up question** near its heading. The composer
focuses the question field and previews the pinned direct parent's prompt, answer, approved scope
and exported evidence. Cancelling restores the launch button's focus. Pending, failed and
cancelled parents remain ineligible: a completed export is required. No sibling or hidden
ancestor context is added.

If event following becomes unavailable, an authorized graph read recovers a completed result
without moving cards or starting inference. Backend graph status reflects committed
query/provider phases. Duplicate or foreign execution attempts cannot interrupt the legitimate
run; failures are logged with sanitized codes, not provider content or credentials. Historical
superseded-run browsing, queue position and provider token streaming are outside this increment.

## Manual Auto format

The component harness includes an explicit **Auto format** action for compact, size-aware branch
placement. It preserves resized card dimensions and pinned positions, and places movable cards
without overlap. Overlapping pinned cards are reported for the user to resolve by unpinning them.

Formatting is a local preview. **Save layout** commits the preview using the layout revision;
**Undo layout** restores the pre-format positions. It does not fit or pan the viewport, rewrite
context, change semantic revision, query telemetry or start inference. Incoming answer events do
not trigger formatting. Ordinary drag/resize saves retain their existing behavior outside the
format preview.

Coordinate limits are checked before changing the preview. Large unpinned layouts can be
translated into the allowed range; impossible layouts or pins that prevent this retain their
current positions and show an actionable message. A later manual edit clears post-save Undo so it
cannot accidentally erase subsequent work.

## Durable storage limits

Storage fault injection covers after object publication, before manifest publication, and after
manifest publication. It does not simulate physical disk loss. The store uses synchronous
whole-state snapshots capped at 64 MiB / 10,000 retained records in total. Each owner is limited
to 64 investigations, 2,000 retained records and 8 MiB of serialized records. Capacity exhaustion
returns 429. Accepted runs reserve bounded record/byte headroom for terminal state and restart
recovery. The manifest retains current and previous snapshot objects; obsolete hash objects and
strictly named pending-write crash files are collected.

Several owners can collectively exhaust the global capacity. Writes validate synchronously.
Reading one investigation copies only that investigation's records, but list requests and commits
still operate on the bounded whole-state snapshot; scalable persistence and request-cost
optimization remain follow-up work. Domain history and durable idempotency are retained:
automatic logical retention, archive/purge and capacity expansion are not implemented. It assumes
a trusted local directory administrator; it does not defend against a malicious same-user
filesystem race.

## Validation

### Validation status

Frontend and backend were validated separately, each on a clean snapshot of the final source. Both
results below are final.

**Frontend: final.** The full CI `npm run check` passed (exit 0) inside the pinned CI Playwright
container, on a clean snapshot of the final frontend source that was confirmed byte-identical to
the working tree before and after the run. Documentation edits made afterwards were checked with
`npm run format:check` only.

| Step                  | Result                                                               |
| --------------------- | -------------------------------------------------------------------- |
| `format:check`, build | Passed                                                               |
| `npm test`            | 2,483 passed, 14 skipped                                             |
| `test:ui`             | 557 passed, 1 flaky, 2 skipped, 0 failed                             |
| `test:prod`           | 24/24 passed                                                         |
| `test:stories`        | 293/293 passed, including the screenshot specs and 60 Keystone cases |

The flaky `test:ui` case is `e2e/apm.spec.ts`: its first attempt failed with
`locator.fill: Malformed value` because a date field already held a later time, and it passed on
CI's automatic retry. This change touches no APM code, and the same test passed in an earlier run
on both this branch and the base commit. It is reported as a flake, not hidden.

Screenshot results count only inside the CI container. On other machines the two screenshot
specs can fail because of local font and rendering differences; no baseline was updated by this
change.

**Backend: final.** Every source file of the snapshot was given a fresh modification time so
Cargo could not reuse build output from older source, and every step recompiled `parseable`.

| Command                                                                                          | Result                                          |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| `cargo fmt --all -- --check`                                                                     | Passed                                          |
| `cargo check --locked --lib --bins`                                                              | Passed                                          |
| `cargo test --locked --lib -- keystone::`                                                        | 136 passed                                      |
| `cargo test --locked --lib -- catalog::manifest keystone:: storage:: query:: rbac:: metastore::` | 254 passed, 1 ignored                           |
| `cargo test --locked --lib`                                                                      | 807 passed, 1 ignored                           |
| `cargo clippy --locked -- -D warnings`                                                           | Passed                                          |
| `cargo clippy --locked --all-targets --keep-going -- -D warnings`                                | 11 errors, the same 11 as the base commit       |
| `cargo hack clippy --verbose --each-feature --no-dev-deps -- -D warnings`                        | All 7 feature runs passed (host settings below) |
| `cargo build --locked --bin parseable`                                                           | Passed, with the native UI embedded             |

The ignored test is a benchmark that is already marked ignored on the base commit.

The all-target Clippy run lints test code, which CI does not. Its 11 errors are in test code
outside this change (`known_schema.rs` 6, `handlers/http/mod.rs` 1, `staging/reader.rs` 3,
`streams.rs` 1), and the base commit produces the same 11 at the same locations. This change adds
no new violation.

The CI feature gate passed only with three host-specific environment settings. No source or
system configuration was changed for it, but it is not a pass of the unmodified host command.
GCC 16 compiles C23 by default, which breaks the vendored cyrus-sasl that the `kafka` feature
builds, so `CFLAGS=-std=gnu17` was set. CMake 3.31.8 was put on `PATH`, and
`CMAKE_POLICY_VERSION_MINIMUM=3.5` stood in for the librdkafka CMake adjustment that CI applies.
Without these settings the `kafka` feature fails in the `sasl2-sys` build script on that host. The
`cargo-hack` 0.6.45 tool was installed in an isolated directory.

The binary was built with the real native frontend build embedded through `NEXT_ASSETS_PATH` and a
local placeholder as the classic UI through `LOCAL_ASSETS_PATH`. The pinned classic bundle was not
downloaded, so the embedded classic UI was not validated.

An independent review of the final authorization, persistence and credential-store changes found
no defects and no merge blockers. Its accepted limitations are listed under
[known limits](#known-limits-and-open-work).

**Retired source harness.** An earlier standalone crate, `tests/keystone-foundations`, compiled
the Keystone source files without DataFusion or UI assets. It defined no tests of its own: every
test it ran is a test in those source files, and all of them (91 in the final source) run in the
main `keystone::` suite, which also covers the grant, runtime, provider runtime, query bridge and
stream loader modules the harness left out. The final source no longer compiled in that crate, CI
never ran it, and an earlier "73 passed" result came from a stale cached binary. The harness has
been removed; the main library suite supersedes it.

### Build-time UI assets

`build.rs` reads two optional environment variables:

- `LOCAL_ASSETS_PATH`: a directory used as the **classic** UI instead of downloading the pinned
  classic bundle from `Cargo.toml` metadata. The directory must exist or the build panics. When
  unset, the build downloads and checksums the pinned classic bundle.
- `NEXT_ASSETS_PATH`: a native frontend build directory (`frontend/dist` after
  `npm run build`) whose `index.html` contains `<base href="/">`. When unset, no native UI is
  embedded. CI sets it to `${{ github.workspace }}/frontend/dist`.

For a **backend-only** compile or test, a placeholder classic directory avoids the download. It is
not a UI and verifies nothing about either frontend:

```sh
placeholder="${TMPDIR:-/tmp}/keystone-classic-placeholder"
mkdir -p "$placeholder"
printf '<!doctype html><title>classic UI placeholder</title>\n' > "$placeholder/index.html"
export LOCAL_ASSETS_PATH="$placeholder"
unset NEXT_ASSETS_PATH
```

For **UI verification** of the native page served by the server, build the frontend first and
embed it, using an absolute path:

```sh
(cd frontend && npm ci && npm run build)
export NEXT_ASSETS_PATH="$PWD/frontend/dist"
```

Leave `LOCAL_ASSETS_PATH` unset (or point it at a real classic build) whenever the classic UI
itself must be checked; the placeholder does not exercise it.

### Validation commands

From the repository root, with the asset variables set as above:

```sh
cargo fmt --check
cargo clippy --locked --lib --bins -- -D warnings
cargo test --locked --lib keystone::
cargo test --locked --lib catalog::manifest
cargo test --locked --lib
cargo check --locked --lib --bins
```

From `frontend`:

```sh
npm ci
npm run format:check
npm run build
npm test
npm run build-storybook
npx playwright test -c playwright.keystone.config.ts
```

### CI gates

- `.github/workflows/frontend.yaml` runs `npm ci && npm run build`, then `npm run check`:
  `format:check` (including `frontend/docs`), build, unit tests, `test:ui`, `test:prod` and
  `test:stories`.
- `.github/workflows/coverage.yaml` builds the frontend, sets `NEXT_ASSETS_PATH`, then runs
  `cargo hack clippy --verbose --each-feature --no-dev-deps -- -D warnings` (library and binary
  targets for each feature, including `kafka`; test code is not linted),
  `cargo hack llvm-cov --no-report nextest`, and the `kafka` feature tests.
- `.github/workflows/build.yaml` builds release targets with the embedded native frontend.
- No workflow runs `cargo fmt --check`; run it locally.

`cargo clippy --all-targets -- -D warnings` also lints test code, which CI does not. On the final
source it reports the same 11 pre-existing test-code errors as the base commit and nothing new
(see [validation status](#validation-status)); the two earlier errors in `src/catalog/manifest.rs`
were fixed. Treat the CI command above as the merge gate.

## Single-coordinator deployment inputs

Native Keystone is disabled unless an operator supplies these inputs. No compose, Helm or default
configuration in this repository sets them.

- `KEYSTONE_NATIVE_DIRECTORY`: persistent private local directory (mode `0700`) on **exactly one
  designated all/query coordinator**.
- `KEYSTONE_SECRET_MASTER_KEY_HEX`: exactly 32 random bytes encoded as 64 hexadecimal characters,
  supplied by deployment secrets. Never put it in the repository, an image, a command argument or
  chat. Preserve it across restarts; losing it makes stored provider credentials unreadable.
  Master-key rotation is not implemented. The value stays in the server's process environment,
  readable by the same user and inherited by child processes.
- `KEYSTONE_PROVIDER_ALLOWED_CIDRS`: explicit comma-separated operator egress CIDRs. Every resolved
  address must be approved; loopback, link-local and metadata addresses remain denied under any
  grant, as do the reserved IPv6 range `::/8` (including IPv4-compatible and IPv4-translated
  forms such as `::ffff:0:7f00:1`) and the discard prefix `100::/64`. IPv4-mapped addresses are
  judged as IPv4. A private address (10/8, 172.16/12, 192.168/16, fc00::/7) is allowed only by a
  grant that lies entirely inside that private block, so catch-all or wider grants never reach a
  private gateway; list its narrow private range explicitly. DNS addresses are revalidated and
  pinned for every request; redirects and environment proxies are disabled. Grant the narrowest
  ranges that cover the provider, not `0.0.0.0/0` or `::/0`.
- `KEYSTONE_GENERATION_MODEL`: optional; defaults to `xiaomi/mimo-v2.6-flash`. Model changes
  require credential rebinding and retain the same output/routing ceilings. The initial API base
  is fixed to `https://openrouter.ai/api/v1`; tenant credential entry cannot change the
  destination.

**Single coordinator.** The repository's file lock only excludes other processes on the same
host and filesystem. It is not distributed fencing or an object-store lease. In a deployment with
several query-mode servers, set `KEYSTONE_NATIVE_DIRECTORY` on one designated server only, route
Keystone traffic to it, and leave the variable unset elsewhere so those servers report Keystone
unavailable. Do not share one directory between hosts over a network filesystem: separate servers
would each hold their own lock and their own view of state.

The provider key is entered using **OpenRouter connection** on the investigation list
(administrators only). The password field is cleared immediately and the value is never persisted
in the browser. Saving a key does not start inference. The form uses an authenticated admin-only
raw-body PUT to `/api/prism/v1/keystone/native/providers/credentials` over the application's
TLS connection. Do not place key bytes in a URL, command argument, log or chat. Responses never
return the key. Credential files are AES-256-GCM encrypted, tenant/reference/destination bound,
mode 0600 under a 0700 directory. This assumes a trusted local administrator and is not a remote
KMS or rollback-proof store. The server copies the request body into framework buffers that are
not zeroized; only the parsed credential value is. That is acceptable only under the trusted-host
model above.

Credential saves use their own bounded grant pool (2 per user, 4 per tenant, 64 in total), so
open live-progress streams cannot block a key save. A save proceeds only with an admin permit that
this server issued to the same principal; peer, cross-tenant or forged permits are refused before
anything is written. Administrator rights are checked before and after the encrypted write, saves
are serialized, and a save whose client disconnects still completes or rolls back as a whole.
Runs and live-progress observers keep their pool of 8 per user, 32 per tenant and 256 in total;
excess subscriptions return an error and can be reopened.

**Credential file recovery.** New credential versions are written to a temporary file and renamed
into place; the credential manifest (`providers.json`) is published last. At startup, under the
store's exclusive lock, unpublished temporary files are removed. A sealed credential file that a
valid manifest does not reference is moved, unchanged and never decrypted, into the credential
directory's `quarantine/` subdirectory (mode 0700) instead of being deleted, because the manifest
may be a stale restore. A later startup whose manifest references it again moves it back, so
restoring the correct `providers.json` and restarting is the whole recovery. A missing, corrupt or
malformed manifest moves nothing. Unknown names, non-canonical names, symlinks and directories
are never touched, and an existing file is never replaced. Quarantine holds at most 1,024 entries
(further unreferenced files stay in place) and one startup inspects at most 2,048 entries. Nothing
is deleted from quarantine automatically; removal is a manual operator action. A superseded
version is retired only when no record in the newly published manifest still references it.

Telemetry artifacts and answers are normal private investigation data, not encrypted credential
records. They currently have no automatic retention/deletion workflow; existing owner/global
limits remain explicit above. Configured query windows do not imply artifact retention periods.

See [local smoke setup](keystone-local-smoke.md) for a single-host recipe.

## Known limits and open work

These limits come from the merge-readiness review and remain after its fixes.

- **Cold catalog checks are strict.** Keystone refuses a dataset when canonical and ingestor
  `stream.json` documents disagree on schema version, custom/time partition, static-schema flag
  or stream type, or when the catalog exceeds 64 documents. Normal queries merge whatever
  snapshots exist. Measure representative long-lived buckets before relaxing anything; tombstone
  and deletion-marker checks must stay in place.
- **Decode and catalog budgets are unmeasured.** The 16 MiB decoded-manifest budget per read and
  the catalog document limits have not been measured against busy production streams. Runs that
  exceed them fail with an explicit budget error rather than narrowing scope.
- **Request cost and contention.** Repository work runs off the HTTP workers, but durable commits
  still hold one repository mutex and are whole-state snapshots, and the four-slot blocking pool
  is shared by start, cancel and live-progress polls (see
  [request execution](#request-execution-and-concurrency)). Every read request checks each
  referenced dataset's deletion marker in the object store.
- **Cancellation scope.** Only the top-level query task is awaited; nested DataFusion, manifest
  decode and local file work can briefly outlive it (see
  [cancellation](#cancellation-and-teardown)). There is no gauge for runs in
  `*_teardown_pending` and no automatic retry experience; both are possible follow-ups.
- **Request authorization.** Queued jobs recheck access just before their protected work, but
  revocation is not atomic with sending the response (see
  [request execution](#request-execution-and-concurrency)). A user without an API key who also
  sends an `x-api-key` or `Bearer` header gets 401 on every Keystone route.
- **Credential store.** Startup cleanup runs only when the store opens, never while the server is
  running. Quarantined files are kept until an operator removes them, and a full quarantine leaves
  unreferenced files counting toward the store's entry cap. Request-body copies of a credential
  are not zeroized.
- **Provider/runtime validation.** One authorized paid MiMo run completed on 2026-10-14 against
  synthetic telemetry in a local runtime. This does not establish future endpoint availability or
  production readiness; billed cost was not exposed. Wrong-master-key readiness and generic
  failure messages remain independently reproduced P2 findings. See
  [live validation boundary](keystone-browser-validation.md#live-validation-boundary).
- Distributed coordinators, broader tools/SQL, sharing, dashboard promotion, retention/archival,
  encrypted-store rotation, real token streaming and advisory-provider activation remain follow-up
  work, not capabilities silently enabled by this increment.
