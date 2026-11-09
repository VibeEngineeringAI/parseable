# Log severity clustering

Parseable can store log rows with equal severity next to each other inside each
Parquet row group. Selective queries such as `WHERE severity_text = 'ERROR'`
then decode far fewer pages. The feature is experimental and off by default. Representative workload
qualification is required before rollout.

## Configuration

| Setting | Default | Meaning |
| --- | --- | --- |
| `P_LOG_SEVERITY_CLUSTER_COLUMN` / `--log-severity-cluster-column` | unset (disabled) | Name of one top-level column to cluster by, for example `severity_text` (OTel logs) or `level` for JSON logs. |

When unset, the writer is unchanged: the same code path, row order and footer
metadata as before. Blank values and comma lists are rejected at startup.

## What changes when enabled

During Arrow-to-Parquet conversion of a log stream, the writer buffers exactly
the rows of one row group (`P_PARQUET_ROW_GROUP_SIZE`, 262,144 by default). It
stably reorders them by the cluster column ascending, then by the stream's time
column (`p_timestamp` or its time partition) descending, with NULLs last in both
keys. The final row group of a file may be partial and is clustered the same way.

- **Row groups contain the same rows as without clustering.** Their time ranges
  are therefore unchanged and row-group time pruning is unaffected. Inside a
  row group, rows of one severity are contiguous, so page indexes on the
  timestamp column are less selective for queries that do not filter severity.
- **Schema, values, timestamp units, row counts, manifest statistics** (min/max,
  `null_count`), file names, manifests, ingestion acknowledgements and every
  HTTP, OTLP, Flight and gRPC request/response format are unchanged.
- **Footer ordering:** clustered files declare no `sorting_columns`, so their
  manifest `sort_order_id` is empty. They contain no file-level timestamp order,
  and the query engine does not trust footer order claims for any file. Without
  clustering, the existing `p_timestamp DESC` claim is still written.
- **Memory:** clustering holds up to one row group of decoded Arrow rows per
  file being converted, plus one reordered batch of 8,192 rows at a time.
  Rows are gathered from the buffered input in order; neither a concatenated
  copy of the row group nor a full reordered copy is built. The existing
  writer holds one row group of encoded column data. At most two conversions
  run per stream.

## When clustering is skipped

A file is written by the unchanged default writer when any of the following
holds:

- The stream is not a user-defined `logs` stream: internal streams, metrics,
  traces and events are never clustered. Neither is a stream whose log
  sources include OTel metrics, OTel traces or `pmeta`.
- The column is missing from every source of that file.
- The column is not a string (`Utf8`, `LargeUtf8`, `Utf8View`, or a dictionary
  of those) or integer type. A warning names the stream and type.

A source that predates the column is read with NULLs, which cluster last. The
time key is omitted when the time column is missing or not a timestamp.

## Compatibility

Clustered files are ordinary Parquet with the same schema and statistics. A
server with clustering disabled, including one built without the feature (tested
with its base commit), reads them, and enabling or disabling the setting needs
no migration. Files written before it is enabled are not rewritten.
Queries without `ORDER BY` have no specified row order, and their row order can
change, as can the rows chosen by a `LIMIT` without a complete `ORDER BY`.
Floating-point `SUM`/`AVG` results can differ in their last bits, because the
accumulation order follows the physical row order. Queries with a complete
`ORDER BY`, filters, `LIMIT`/`OFFSET`, and integer, string or count aggregates
return the same results.

## Measured cost and benefit

One boat.dev `large` VM (8 vCPU, 16 GiB), 2026-11-08, ordinary `release` builds
of the base commit and this change with the same toolchain and lockfile. The
server was pinned to four CPUs with `s3-store` on a local MinIO. Each arm ingested
the same 3.6 million JSON rows (about 1% `ERROR`, 22 fields), event-time
partitioned, with default 262,144-row groups. Values are medians over three
rotated blocks. Bytes are the server's logical requested ranges
(`parseable_storage_read_bytes_total`), not physical GETs. The run used
`scripts/ingest-performance/clustering_bench.py`.

| Measure | Baseline | Clustering off | Clustering on |
| --- | ---: | ---: | ---: |
| Conversion and upload CPU after acknowledgements | 14.0 s | 14.3 s | 16.7 s |
| Peak RSS during conversion | 1,339 MiB | 1,325 MiB | 1,620 MiB |
| Acknowledged rows per second | 597k | 616k | 567k (range 423k–608k) |
| Stored bytes | 213.5 MiB | 213.6 MiB | 213.6 MiB |
| `ERROR` message groups, whole range: MiB read | 7.24 | 7.25 | 3.68 |
| `ERROR` groups, 10 s event-time window: MiB read | 1.29 | 1.31 | 0.85 |
| `COUNT(*)`, 10 s window, no severity filter: MiB read | 1.02 | 1.02 | 1.18 |
| Recent rows, 10 s window, no severity filter: MiB read | 13.3 | 13.3 | 16.4 |

Clustering runs only in conversion. The acknowledgement path is unchanged, and
the throughput medians fall within the run-to-run spread. Conversion CPU rose
17–19%, and peak memory rose by 280–295 MiB, roughly one row group of
decoded rows plus its reordered copy. Every query passed the documented result
checks (including tolerance for floating-point accumulation order). Latencies on this local store were tens of milliseconds and dominated
by fixed costs, so they show no reliable difference and are not reported as a
gain. Narrow time windows without a severity predicate read more, because each
row group's rows are no longer in time order across severities. This is a small
synthetic matrix, not a capacity or remote-latency qualification.

The table above measured the first implementation, which concatenated each
row group and then built a full reordered copy. The writer now gathers rows
from the buffered input in 8,192-row batches. A follow-up run (one boat.dev
`large` VM, 2026-11-09, the same toolchain and lockfile for all binaries, server
pinned to four CPUs, MinIO) ingested 1.5 million rows of a 101-column JSON log
schema with default 262,144-row groups, three rotated blocks per arm:

| Measure (median of three) | Baseline | First implementation | Current |
| --- | ---: | ---: | ---: |
| RSS rise during conversion above RSS at acknowledgement | 0 MiB | 810 MiB | 143 MiB |
| Peak RSS after acknowledgement | 2,127 MiB | 2,919 MiB | 2,424 MiB |

Process CPU varied by up to 40% between whole-server runs of the same binary,
so writer CPU was measured separately: the same 1,048,576-row, 101-column
input with production writer settings (LZ4_RAW, 262,144-row groups), each
variant in its own process, median of five. The default writer receives
staged batches as they were ingested (2,048 rows here).

| Writer | CPU | Peak memory rise |
| --- | ---: | ---: |
| Default, 2,048-row staged batches | 5.58 s | 152 MiB |
| Default, coalesced to 8,192-row batches | 4.02 s | 244 MiB |
| Clustered, current (8,192-row gathers) | 4.54 s | 182 MiB |
| Clustered, first implementation (one batch per group) | 3.09 s | 483 MiB |

Clustering's own ordering and gathering cost about 13% more CPU than a
default writer given the same batch size, but the clustered writer hands
the Parquet encoder larger batches than staging does. Against today's
default path, its writer CPU was therefore lower in this measurement.

The 1.5-million-row fixtures, read by the baseline binary with 25 ms of added storage round-trip
latency (`tc netem`, 24-hour window), returned identical oracle-checked results:

| Query | Concurrency | Unclustered QPS / p50 | Clustered QPS / p50 | Logical MiB per query |
| --- | ---: | ---: | ---: | ---: |
| `ERROR` groups by `body_message` | 1 | 0.95 / 1,055 ms | 0.95 / 1,069 ms | 3.61 → 1.70 |
| `ERROR` groups by `body_message` | 8 | 6.97 / 1,101 ms | 7.29 / 1,056 ms | 3.61 → 1.70 |
| `COUNT(*)` by severity | 1 | 1.04 / 965 ms | 1.09 / 917 ms | 0.48 → 0.03 |
| `COUNT(*)` by severity | 8 | 7.88 / 993 ms | 8.55 / 913 ms | 0.48 → 0.03 |
| 100 most recent rows, all columns | 8 | 1.15 / 6,742 ms | 1.25 / 6,274 ms | 470.6 → 472.1 |

Most of the roughly one-second latency at this window was per-query object
listing and metadata requests, which clustering does not change. Stored bytes
were 0.3–1.1% larger. These are emulated-latency results on a single node, not
real-cloud or blog-scale measurements.

A second fixture of 6 million rows of the same schema, under the same 25 ms
latency, added narrow time windows without a severity filter (medians of three
blocks; every result checked):

| Query | Concurrency | Unclustered QPS | Clustered QPS | Logical MiB per query |
| --- | ---: | ---: | ---: | ---: |
| `ERROR` groups, 24 hours | 8 | 4.02 | 4.21 | 19.5 → 11.0 |
| `COUNT(*)` by severity, 24 hours | 8 | 4.69 | 5.08 | 1.87 → 0.09 |
| 100 most recent rows, 1 s window | 8 | 1.74 | 1.74 | 53.9 → 107.1 |
| `COUNT(*)`, 1 s window | 8 | 18.84 | 21.99 | 0.92 → 1.60 |
| 100 most recent rows, 10 s window | 8 | 1.29 | 1.52 | 418.9 → 289.1 |
| `ERROR` groups, 10 s window | 1 | 2.45 | 2.16 | 6.88 → 3.30 |
| `ERROR` groups, 10 s window | 8 | 16.83 | 15.60 | 6.88 → 3.30 |

A 1 s window without a severity filter read up to twice as many bytes, with
no latency regression measured. The one consistent regression was a
severity filter combined with a narrow time window: 7–12% lower throughput
despite reading half the bytes. Its cause has not been identified.

## Tests

- `src/parseable/streams/log_clustering_tests.rs` compares clustered and default
  writer output for the same pushes, and checks byte-identical output whenever
  clustering is skipped.
- `src/parseable/streams/crash_recovery_tests.rs` runs exactly-once crash and
  restart recovery cases with clustering on.
- `severity_clustered_files_match_oracle` in
  `src/query/stream_schema_provider/ordering_tests.rs` queries both layouts
  through the production manifest scan and compares the results with an
  independently computed answer.
- Separate Boat application campaigns checked HTTP/OTLP compatibility, old/new
  Parquet readability, persisted restart and physical clustering. Benchmark
  harnesses and raw evidence remain on the research branch; this change includes
  only the writer, focused correctness tests and documentation.

This change is independent of partition budgeting and the Flight metrics fix.
