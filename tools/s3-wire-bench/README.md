# Physical S3 request experiment (2026-11-10)

This is a benchmark-only local protocol experiment. No server defaults, storage behavior,
customer credentials, cloud resources, lifecycle rules or retention settings change.
PR137 is completed groundwork; these are independent new measurements.

`run.py` hosts a loopback S3-compatible HTTP fixture (not MinIO or AWS) on an ephemeral
port, runs the pinned Rust SDK client once with a 120-second timeout, and shuts down.
The trace records every HTTP attempt received by this server, including the injected
503 followed by the SDK retry. Counts are physical HTTP requests, not AWS invoices.
Response payload bytes exclude HTTP headers, TLS, TCP/IP and retransmissions; upload
payload bytes are recorded separately. LIST is physically GET but separately marked
`operation=LIST`. Server-side errors need their own billing classification.

## Reproduce

Run from repository root. Set `WIRE_SCRATCH` to a dedicated home-cache directory;
never put build output in `/tmp`. This run used 1.2 GiB including its debug target and
~71 MiB of Parquet fixtures. Source fixtures and traces are bounded; Cargo builds need
additional disk if its dependency cache is empty. Four compiler jobs were used.

```bash
export WIRE_SCRATCH="$HOME/.cache/parseable-s3-wire-20261110"
mkdir -p "$WIRE_SCRATCH/tmp"
export TMPDIR="$WIRE_SCRATCH/tmp"
export CARGO_TARGET_DIR="$WIRE_SCRATCH/target"
cargo build --locked --manifest-path tools/s3-wire-bench/Cargo.toml -j 4
# Use a Python environment with pyarrow==18.1.0; this run reused the existing one.
python tools/s3-wire-bench/run.py \
  --scratch "$WIRE_SCRATCH/fixtures" \
  --binary "$CARGO_TARGET_DIR/debug/s3-wire-bench" \
  --output tools/s3-wire-bench/evidence
```

Parquet 59.2.0 and object_store 0.13.2 match the server's versions. Cargo.lock records
all transitive versions (including Arrow 59.3.2); the benchmark does not encode
production files or measure codec/allocator/production CPU performance. It uses the
debug profile and fixed-seed PyArrow 18.1.0 uncompressed fixtures to isolate metadata
IO. This is not a production latency benchmark.

The cold fetch loop mirrors DataFusion 55.0.0's
`datafusion-datasource-parquet/src/metadata.rs::DFParquetMetadata::fetch_metadata_from_store`
(lines 289–344). Source SHA256:
`1e33328eea576ef409221ddeb25fb93a4b2e5bea7fb3ed10b645f65be9e69e1c`.
It invokes the real Parquet `ParquetMetaDataPushDecoder` and real object_store S3
transport, not a calculated request model. `PageIndexPolicy::Optional` matches
DataFusion's default effective policy when its metadata cache is configured. The
fixtures contain column and offset indexes, and the probe asserts both were loaded.
The small fixture has 2 columns and 1 row group; wide controls have 128 columns and
100/300 row groups. No padded custom footer metadata is used. All decoded metadata,
including statistics and indexes, must compare equal across hints for each fixture.
The harness retains SDK default retry/backoff and client transport settings;
Parseable configures five retries and explicit timeouts/pooling. The injected
single retry fits either budget. This does not measure production retry exhaustion,
connection reuse, TLS, network latency or failure recovery.

## Measurements

Each cold case first issues one explicit HEAD to discover size. That HEAD is reported
in the raw trace but excluded from the GET/byte cells below: Parseable often already
has file size from its manifest, so this is not a claim it HEADs every scan.
Cells are physical GET attempts / response payload bytes. There were no footer retries.

| Footer + 8-byte trailer | 64 KiB hint | 512 KiB hint | Current 2 MiB hint |
|---|---:|---:|---:|
| 1,603 B, 4,298,602 B file | 1 / 65,536 | 1 / 524,288 | 1 / 2,097,152 |
| 1,100,162 B, 17,380,903 B file | 3 / 1,740,827 | 3 / 2,199,579 | 1 / 2,097,152 |
| 3,280,963 B, 52,124,904 B file | 3 / 5,073,628 | 3 / 5,532,380 | 3 / 7,105,244 |

The 64 KiB hint saves 2,031,616 bytes for the small and extra-large controls without
adding a request. For the middle control it saves only 356,325 bytes and adds two
GETs; 512 KiB is worse than 2 MiB in both bytes (+102,427) and requests (+2).
Fallback decoder reads can overlap prefetched bytes; the physical trace, rather than
footer length, is the correct byte baseline. These controls reject a universal
smaller-hint recommendation. With no paid per-byte network component, fewer payload
bytes alone are not S3 cost savings. For the middle control the 64 KiB change pays
only if `356325 * paid_cost_per_byte > 2 * cost_per_GET + incremental_compute_cost`.
Latency remains a separate constraint; localhost timings do not estimate network RTT.

One logical `get_ranges` over three 1 KiB ranges returned 3,072 useful bytes through
two physical GETs totaling 6,144 response bytes: object_store coalesces the first two
nearby ranges, overfetching their gap. One logical `get_range` with an injected 503
made two physical GET attempts, transferring a 69-byte error plus 1,024-byte success.
A single 4,096-byte PUT and its validating HEAD, and one LIST page were also traced.
The entire run produces 35 HTTP attempts: 23 data GET attempts, 1 LIST, 10 HEAD, 1 PUT.

`wire.jsonl` is the source of truth. `summary.json` groups physical methods/statuses
and payload bytes by key. `metadata.jsonl` records decoded index/row-group checks;
`fixtures.json` records bytes, footer sizes, row counts and content hashes.

## Existing behavior and limits

* `src/storage/metrics_layer.rs::get_ranges` counts logical API calls and requested
  bytes before `inner.get_ranges`; it cannot expose physical coalescing, retries or
  all response payloads. Three requested ranges do not imply three S3 requests.
* `src/query/mod.rs` sets a shared DataFusion metadata cache using
  `P_PARQUET_METADATA_CACHE_SIZE` (default 50 MiB) and a 2 MiB metadata hint.
  DataFusion's cached metadata validates size and last-modified time against current
  object metadata. This experiment's warm control is **only immutable Arc metadata
  reuse**, with zero extra IO. It does not measure DataFusion cache hit rate,
  evictions, cache memory or repeated service-query physical requests.
* No new cache is proposed. Never cache mutable manifests using local invalidation
  alone: other nodes publish updates. Tenant/object-store identity, authorization,
  retention visibility and metadata freshness must hold for any future reuse.
* `src/storage/s3.rs::_parallel_download_inner` fills the existing hot tier with a
  HEAD plus `ceil(size / chunk_size)` range GETs (default 8 MiB chunks, concurrency
  16), writing a validated partial file before rename. Warm local data reads can
  avoid S3 payloads, while metadata requests may remain. This is source audit, not
  a measured hot-tier workload. Compare full-file fill bytes, disk and eviction costs
  against repeated selective remote reads before increasing hot-tier capacity.
* The PUT + HEAD fixture illustrates request accounting. It does not execute
  Parseable's publication, multipart or crash-recovery protocol. Keep
  `validate_uploaded_parquet_file` in `src/storage/object_storage.rs` and its
  post-upload remote size validation intact.
* No query results or APIs changed. Full service query workloads, supported older
  Parseable service versions, tenant auth, cross-node manifest updates, retry
  exhaustion, multipart, retention and recovery remain outside this local probe.

Next actionable step: collect footer/index distributions and actual metadata-cache
misses from representative service workloads, then replay them with cold/warm
queries against an isolated S3/MinIO trace. Weight physical GETs and paid bytes with
deployment rates before considering a configurable hint. Keep defaults now.
