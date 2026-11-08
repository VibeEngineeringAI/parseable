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
- **Memory:** clustering holds up to one row group of decoded Arrow rows plus
  a reordered copy per file being converted. The existing writer holds one
  row group of encoded column data. At most two conversions run per stream.

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
