# Compatible query read caching

This implements a conservative read optimization against d6a155f2. It preserves
bucket paths and formats, and adds no required configuration or TTL.

## Storage and freshness findings

`upload_single_parquet_file` uses unconditional multipart upload, followed by a
size check and manifest publication. Staging conversion normally incorporates a
ULID (`src/parseable/staging/writer.rs`). Crash recovery retries the preserved
file; it is not evidence of different bytes at the same path. Uploads are
unconditional, however, so any writer with bucket access can overwrite a path.
The storage API does not enforce immutable parquet objects. Retention also
deletes them. A pathname and manifest size alone therefore aren't a safe cache
identity. The metadata conditional-write API doesn't make parquet uploads, stream
snapshots or manifests immutable; those writers still use ordinary writes.

`stream.json` embeds the snapshot. Manifests are updated under existing paths.
Query and Prism nodes must see other processes' updates. Standalone mode alone
isn't an enforceable guarantee that another process won't write the same bucket.
A process-local write-through metadata cache would miss those writes. An ordinary
in-flight fetch started before a new query is likewise insufficient for strict
next-query freshness. A TTL knowingly changes that contract. None is introduced.

PR #130's resident-stream and schema-refresh behavior is preserved. This patch
changes the scan's snapshot ordering without restoring per-query stream reloads:
lease staging before the first settings/snapshot GET. If remote settings show
that staging is needed when resident settings predicted otherwise, lease it and
fetch a fresh snapshot. Upload publishes before staging is unlinked, so either
the lease or remote manifest retains the file. Historical scans don't need leases. A speculative capture error is held until
remote settings confirm staging is needed; otherwise it is discarded.

## Small parquet files

DataFusion 55 already has `CachedParquetFileReaderFactory`, a byte-limited file
metadata cache, and a metadata-size hint. Query runtime creation and ParquetFormat
factory installation matter: ParquetFormat replaces a factory supplied earlier
on ParquetSource. The patch installs its reader after that step and retains the
original factory for larger files, preserving its options and metadata cache.

For a manifest file size at most 256 KiB, a reader fetches the complete object in
one bounded GET. It holds those bytes for its lifetime; metadata, page indexes,
and column reads then use slices of the same body. On a subsequent request, a
conditional GET validates the cached ETag. A 304 reuses the bytes without a body;
a changed object replaces them. A 404/error invalidates the entry and propagates.
Absent or weak (`W/`) ETags mean no cross-request body reuse. Growth past the limit uses the original
reader with the newly observed size. The bounded probe prevents an unexpected
large replacement from being read into memory in full.

Keys use the process's singleton storage-provider identity, object-store URL, and full object path,
including tenant prefixes. Per-query object-store clients differ, so their pointer
identity would prevent cross-query hits. The configured provider lives for the
process lifetime. Each query execution attaches a fresh `RequestView` to its DataFusion session
configuration. Every installed scan shares it. Per-file asynchronous cells coalesce
concurrent metadata, bloom-filter and decoder opens. Validated bodies stay referenced
until the request finishes; they are not evicted by a second, smaller LRU. New
requests never inherit the view. The keyed linked-list LRU performs lookup, promotion, and removal in O(1),
without holding its mutex across I/O. Storage defaults to 64 MiB and 4,096 entries. Active readers
can retain evicted bodies; as with existing scan buffers, their memory also depends
on query concurrency. This limit is a cache residency limit, not a process RSS cap.

Stream/tenant removal and retention need no cached catalog invalidation because
catalog objects aren't cached across requests. They stop selecting deleted files.
Direct reads of a removed file validate and fail; bytes left unreferenced in the
cache are reclaimed by bounded eviction. Recreating the same path validates its
new ETag. There is no negative cache to hide newly uploaded files.

This retains one network validation per selected small file per request. Avoiding
that last round trip requires a stronger immutable/versioned publication contract.
Whole-body reads trade extra cold bytes for fewer round trips; the limit keeps
that trade confined to small objects. Large-file metadata behavior is unchanged.

## Other read costs

Dataset discovery retains its existing storage-based membership checks, now with
up to 16 metadata-prefix LISTs in flight. It makes the same number of LIST calls.
In-memory membership could hide streams created/deleted by other nodes.

The S3 pool idle timeout remains 15 seconds. The code constructs clients when
creating query runtimes; a timeout change alone does not establish useful reuse
across dashboard refreshes. No TLS handshake benefit has been measured here.

## Reproduction

Build locally with `PATH=$HOME/.cargo/bin:$PATH`, `P_BUILD_NO_UI=1`, and
`CARGO_BUILD_JOBS=4`. Run one Cargo command at a time:

```
cargo test --lib query::small_file_cache -- --nocapture
P_CACHE_TEST_MINIO_ENDPOINT=http://127.0.0.1:18390 cargo test --lib query::small_file_cache -- --ignored --nocapture
cargo test --lib snapshot_capture_tests
cargo test --lib next_metadata_read_sees_external_writer_changes
cargo test --lib staging_lease
cargo clippy --all-targets
```

The measurement uses MetricLayer and StorageMetricWindow, hence the same
`parseable_storage_request_response_time_count` samples exposed by `/api/v1/metrics`.
It generates 60 one-minute parquet files, opens a fresh DataFusion query session
for each run, compares returned rows, and evaluates a PromQL rate range expression
from the scanned samples. It isolates parquet I/O: HTTP handlers, schema refresh,
`stream.json` and manifest reads are outside the measurement. Do not interpret
its table as a reproduction of the supplied live-instance endpoint totals.

## Measured MinIO results

Local MinIO, 60 files containing 28,800 samples over one hour, 894,420 bytes total.
Both runs returned identical results; these are the repeated run's metric deltas.
The PromQL case scans samples and evaluates `sum(rate(requests{job="api"}[5m]))`
over a range with 60-second steps. These are historical results from the original plain-Parquet fixture. The fixture
now uses production metrics writer properties, pushes filters to Parquet, and forces
byte-range repartitioning; see the request regression below for HTTP results.

| Parquet workload | Before GET | Before GET_RANGES | After GET | After GET_RANGES | Calls before → after |
| --- | ---: | ---: | ---: | ---: | ---: |
| COUNT(*) | 0 | 60 | 60 | 0 | 60 → 60 |
| Filtered GROUP BY | 1 | 180 | 60 | 0 | 181 → 60 |
| PromQL scan + range evaluation | 60 | 240 | 60 | 0 | 300 → 60 |

COUNT's file-request count is unchanged. Its usual standalone catalog preamble
loses one stream.json GET through the capture-order change, but that reduction is
code-derived, not included in this measured table. Dataset discovery also keeps
its LIST count while allowing concurrent probes. No local wall-time claim is made.

The MetricLayer byte counter now counts successful response body chunks and
successful multi-range result lengths, rather than requested range lengths.
304 responses have their own `not_modified_requests` delta and do not count as
failures or transferred bytes. Query `bytes_scanned` continues to count data
ranges only; footer/page-index loading does not add to this billing-style total.

## Configuration and admission

`--small-file-cache-enabled` / `P_SMALL_FILE_CACHE_ENABLED` defaults to `true`.
Setting it to `false` skips reader installation at `parquet_scan_plan`, retaining
the original DataFusion reader and its request pattern.
`--small-file-cache-size` / `P_SMALL_FILE_CACHE_SIZE` defaults to `67108864` bytes
(64 MiB); zero also disables installation. The process cache entry cap stays at 4,096. The request view retains admitted
files until completion (including streaming completion); its references can outlive
process-LRU residency, just as active readers can. These are residency limits, not RSS
limits. No new required configuration or dependency was added.

A scan whose selected small-file manifest sizes exceed the configured byte limit,
or whose small-file count exceeds 4,096, bypasses installation entirely. It cannot
cycle through and evict the useful process working set. This conservative policy
uses manifest predictions; unexpectedly changed sizes are still validated.
Large-file reads retain the original reader. If metadata reading fails and HEAD
confirms the manifest size changed, the reader is rebuilt using the current size;
this covers shrinkage under a stale large manifest without adding requests to
successful large-file reads. A non-partial answer to the bounded cache probe
invalidates residency and falls back to the original reader after HEAD.

## Test boundaries

`repeated_sixty_file_queries` and `http_mutations_and_faults` require a real HTTP
S3-compatible endpoint in `P_CACHE_TEST_MINIO_ENDPOINT`, bucket
`cache-measurement`, credentials `minioadmin` / `minioadmin`. They are explicitly marked ignored, so a normal library run visibly reports
them as skipped with the HTTP requirement. Run them with `--ignored --nocapture`;
explicit execution without an endpoint fails instead of silently passing. The other cache,
storage metric, snapshot ordering, and bounded LIST tests need no HTTP service.
The HTTP mutation test additionally uses Python 3's standard-library fault proxy
on an ephemeral loopback port; the child is killed and waited on at test exit.
It covers exact parquet query rows after overwrite, deletion/recreation, growth
and shrinkage with current/stale sizes, 503 validation, interrupted bodies, weak
and missing ETags, and a 200 response to the bounded cache probe. The measurement
test compares original and cached query rows and `bytes_scanned`, cold and warm,
checks actual storage bytes and warm 304s, and checks evaluated PromQL values.
It does not exercise Azure/GCS emulators or the live dashboard service.

## Previous fix validation (plain fixture, 2026-11-10)

Real MinIO HTTP on isolated loopback ports, plus the Python response fault proxy:
all six cache tests passed, including both explicitly enabled HTTP tests. The full
library suite passed: 1,385 passed, six ignored (including the two HTTP tests run
separately). The 60-file fixture again contained 894,420 bytes. Every cold cached
scan counted exactly that many storage body bytes; every warm cached scan counted
zero, with 60 not-modified outcomes and no storage failures. Billing-style
`bytes_scanned` matched the original reader for every query, cold and warm.
PromQL returned 55 evaluated points at 60-second intervals, each with rate 8.

| Workload | Original reader GET / GET_RANGES | Reviewed cache (recorded) | Fixed cache cold | Fixed cache warm | Disabled cache GET / GET_RANGES |
| --- | ---: | ---: | ---: | ---: | ---: |
| COUNT(*) | 0 / 60 | 60 / 0 | 60 / 0 | 60 / 0 | 0 / 60 |
| Filtered GROUP BY | 1 / 180 | 60 / 0 | 60 / 0 | 60 / 0 | 1 / 180 |
| PromQL scan + range evaluation | 60 / 240 | 60 / 0 | 60 / 0 | 60 / 0 | 60 / 240 |

The reviewed-cache column is the prior design document's measurement; the
original, fixed, and disabled columns were measured again during this fix. The
fixes add no round trips to these query shapes. Stale-size recovery and a store
rejecting the bounded probe can require fallback requests, as described above.

Final plain `cargo clippy --all-targets` passed with existing warnings only
(21 library-test warnings and the existing staging API compatibility warning).
No warnings point to changed code. The temporary MinIO container and its volumes
were removed; the live side-by-side service, configuration, and bucket were not
used. No push or PR was performed.


## Request validation regression (2026-11-10)

The original measurement missed concurrent opens: its 894,420-byte working set
was below DataFusion's default 1 MiB `repartition_file_min_size`. Its table also
reported unsupported filter pushdown and wrote no bloom filters. Production
`Query::create_session_state` enables repartitioning and work stealing, with a
CPU-derived partition count. DataFusion `FileGroupPartitioner::repartition_evenly_by_size`
checks the **total** scan size against 1 MiB and splits files at byte boundaries.
Several readers can therefore open one tiny file concurrently. In the old
`load_for_scan`, every reader checked an empty view, released its mutex, and
started its own validation before any reader populated the view. A 304 still
requires network I/O, so even warm bodies raced. The old 8 MiB view could also
evict earlier validations on larger requests.

The instrumented baseline showed two or three `CACHE_LOAD`s per file with the
**same** view pointer and distinct `FileRange`s. DataFusion's
`RowGroupsPrunedParquetOpen::load_bloom_filters` also constructs a replacement reader
for decoding; this reader shares the view and is no longer a source of extra
validations. No second physical query execution was needed to reproduce the
problem. `resolve_stream_names` parses SQL for table discovery, and `into_query`
plans it afterward; that discovery does not execute Parquet scans.

`Query::execute` now clones the catalog session state and supplies a new
`RequestView` extension. `parquet_scan_plan` passes that view to each installed
reader factory. An async cell per provider/URL/path serializes first loads and
retains success or failure for the execution. The process ETag LRU is unchanged:
a later HTTP request starts an empty view and must issue its own conditional GET.
The request view intentionally retains bodies; an 8 MiB eviction policy cannot
promise at most one validation for a later reader of the same request.

To reproduce without waiting hours, the ignored `publish_request_fixture` test
publishes 390 synthetic historical minute partitions using real
`Stream::parquet_writer_props` and `create_from_parquet_file`, including metrics
bloom filters, page indexes and sorted metric names. This is synthetic fixture
publication, not a claim that 390 files were ingested over wall-clock minutes.
The HTTP script ingests an actual OTLP gauge into staging before querying. Files
are approximately 19.7 KB. Run a debug standalone server against this isolated
bucket with `P_CACHE_TRACE=1`, then run
`scripts/performance/request_cache_repro.py`. Set `CACHE_REPRO_REQUESTS` to a
worktree-local JSON path to freeze the exact request ranges for before/after;
set `CACHE_REPRO_ASSERT_ONCE=1` for the regression assertions. It performs two
separate HTTP requests per shape, recording the second request's metric delta
and per-path loads; it asserts one load per file on **both** requests. Set
`CACHE_REPRO_URL` and `CACHE_REPRO_LOG` if using different ports/log paths.
Never point this harness at a production service or bucket.

The 60-file measurement now uses the same writer properties and enables pushed
predicates, work stealing and forced byte-range splits across 32 partitions.
The unit regressions additionally cover concurrent first opens, next-request
overwrite/delete visibility, and late reads after more than 8 MiB of other files.

Measured warm HTTP totals (all GETs, including metadata), isolated MinIO on
18397 and standalone HTTP on 18398. Original requests ended at wall-clock now.
The frozen-range rerun happened later; background OTLP staging uploads added
files and metadata reads, so selected-file counts are shown explicitly.

| Shape | Before calls / files / validations | Fixed same ranges calls / files / validations | Fixed fresh now calls / files / validations |
| --- | ---: | ---: | ---: |
| count_10m | 8 / 6 / 6 | 10 / 7 / 7 | 4 / 1 / 1 |
| count_1h | 136 / 56 / 134 | 60 / 57 / 57 | 50 / 47 / 47 |
| group_1h | 137 / 56 / 135 | 60 / 57 / 57 | 50 / 47 / 47 |
| promql_range_1h | 140 / 61 / 138 | 66 / 63 / 63 | 55 / 52 / 52 |
| label_values_1h | 136 / 56 / 134 | 61 / 58 / 58 | 50 / 47 / 47 |
| count_24h | 472 / 390 / 469 | 395 / 391 / 391 | 397 / 393 / 393 |
| promql_instant | 3 / 1 / 1 | 5 / 2 / 2 | 3 / 0 / 0 |

Every fixed per-file multiplicity was exactly one, on both the first and second
HTTP requests. An instant query with zero remote files was served from staging.
The 24-hour fixture spans two UTC days (three initial metadata reads); background
uploads later changed that overhead: the fixture uses a distinct manifest identity,
so the standalone uploader adds its own hostname-owned manifest alongside it.
This accounts for the extra metadata GET after staging uploads. This synthetic fixture did not reproduce
the live instance's 24-hour statistics shortcut; its 390 historical files were
all opened. The cause/fix is established by per-file loads, independent of that
workload difference.

The revised 60-file fixture contains 579,821 bytes. With forced splitting across
32 partitions, original-reader warm GET / GET_RANGES were 0 / 91 for COUNT,
1 / 211 for GROUP BY, and 120 / 270 for PromQL scan/evaluation. The fixed cache
made exactly 60 GETs for every shape, cold and warm, with 60 warm 304s. It
returned the same rows, evaluated values and billing-style bytes scanned.


Final validation: `cargo test --lib` passed with 1,387 passed, zero failed and
seven ignored. All three cache HTTP tests were explicitly run with
`cargo test --lib query::small_file_cache -- --ignored --nocapture` and passed,
including the production-property index assertions. Both HTTP regression runs
(frozen ranges and fresh now) passed per-request assertions. Plain
`cargo clippy --all-targets` passed with the existing 21 library-test warnings
and staging API compatibility warning; no warnings point to changed code.
The temporary standalone process was stopped and the MinIO container and its
anonymous volume were removed. No live-service settings, data or processes were
changed. No push or PR was performed.
