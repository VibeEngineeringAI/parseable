# Compatible query read caching

This implements a conservative read optimization against d6a155f2. It preserves
bucket paths and formats, and adds no required configuration or TTL.

## Storage and freshness findings

`upload_single_parquet_file` uses unconditional multipart upload, followed by a
size check and manifest publication. Staging conversion normally incorporates a
ULID (`src/parseable/staging/writer.rs`), but crash recovery can retry a remote
path. The storage API doesn't enforce immutable parquet objects. Retention also
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
the lease or remote manifest retains the file. Historical scans don't need leases.

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
No ETag means no cross-reader caching. Growth past the limit uses the original
reader with the newly observed size. The bounded probe prevents an unexpected
large replacement from being read into memory in full.

Keys use the process's singleton storage-provider identity and full object path,
including tenant prefixes. Per-query object-store clients differ, so their pointer
identity would prevent cross-query hits. The configured provider lives for the
process lifetime. A physical scan also has an 8 MiB LRU view shared between
DataFusion metadata and data readers, avoiding a second validation of the same
body within that scan. New scans never inherit that view. LRU storage is capped at 64 MiB and 4,096 entries. Active readers
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
P_CACHE_TEST_MINIO_ENDPOINT=http://127.0.0.1:18390 cargo test --lib repeated_sixty_file_queries -- --nocapture
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

The existing MetricLayer byte counter charges requested bounded-range lengths,
including unsuccessful/304 requests. This harness deliberately reports request
counts, not inferred transferred bytes from that counter.

Validation: the full library suite passed (1,382 passed, 4 ignored). The final
MinIO run passed all four cache/measurement tests, including an assertion that
each warm query receives 60 HTTP 304 responses. Fresh-cache and repeated-query
request counts were identical; warm responses carry no parquet body.
Plain `cargo clippy --all-targets` passed with existing warnings only; no warning
points to the changed cache, scan, or metastore code. No full HTTP dashboard
benchmark was performed: catalog, schema-refresh and handler overhead remain an
explicit validation gap. MinIO and in-memory storage were exercised; Azure/GCS
were checked through the shared object_store API and were not emulator-tested.
