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
and column reads then use slices of the same body. On a subsequent scan, a
conditional GET validates the cached ETag. A 304 reuses the bytes without a body;
a changed object replaces them. A 404/error invalidates the entry and propagates.
Absent or weak (`W/`) ETags mean no cross-scan body reuse. Growth past the limit uses the original
reader with the newly observed size. The bounded probe prevents an unexpected
large replacement from being read into memory in full.

Keys use the process's singleton storage-provider identity, object-store URL, and full object path,
including tenant prefixes. Per-query object-store clients differ, so their pointer
identity would prevent cross-query hits. The configured provider lives for the
process lifetime. A physical scan also has an 8 MiB LRU view shared between
DataFusion metadata and data readers, avoiding a second validation of the same
body within that scan. New scans never inherit that view. The keyed linked-list LRU performs lookup, promotion, and removal in O(1),
without holding its mutex across I/O. Storage defaults to 64 MiB and 4,096 entries. Active readers
can retain evicted bodies; as with existing scan buffers, their memory also depends
on query concurrency. This limit is a cache residency limit, not a process RSS cap.

Stream/tenant removal and retention need no cached catalog invalidation because
catalog objects aren't cached across requests. They stop selecting deleted files.
Direct reads of a removed file validate and fail; bytes left unreferenced in the
cache are reclaimed by bounded eviction. Recreating the same path validates its
new ETag. There is no negative cache to hide newly uploaded files.

This deliberately retains one network validation per small file per scan while
the bounded scan view retains it; eviction or concurrent first opens can require
additional validations. Avoiding
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
over a range with 60-second steps. The fixture is intentionally narrower than a
real OTLP dataset, and excludes endpoint/catalog overhead as described above.

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
(64 MiB); zero also disables installation. The per-scan view stays at 8 MiB and
the process cache entry cap stays at 4,096. These are residency limits, not RSS
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

## Fix validation (2026-11-10)

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
