# Codec experiment on 36c3978a

Decision: keep the `lz4_raw` default and all public behavior unchanged. ZSTD at the
existing default level 1 wrote fewer bytes in these fixtures, but used more
conversion CPU and decoded more slowly in the current Rust reader. This is useful
bounded evidence for evaluating the already-supported `P_PARQUET_COMPRESSION_ALGO=zstd`
option on real workloads; it does not establish a universal cost advantage.

## Recorded run

Base: `36c3978acf3aa559a7e8ea7032fdc0abb6ea6f2a`. Linux x86_64, Intel Core
i9-13900HK, rustc 1.96.0 (ac68faa20), LLVM 22.1.2. Affinity 0–19, unpinned,
shared host; initial load average is recorded in the raw output. No S3 access.
One warmup plus five alternating AB/BA measured rounds per shape, 270,000 rows,
262,144-row group limit (two groups, including a 7,856-row final group). Both
codecs consume identical IPC bytes. See [README.md](README.md) for exact settings,
commands, fixture definitions and timing boundaries.

Actual file lengths and medians in milliseconds (wall / process CPU):

| Dataset | Codec | File bytes | Write wall / CPU ms | Full read wall / CPU ms | Project read wall / CPU ms |
|---|---|---:|---:|---:|---:|
| app | lz4_raw | 6,757,933 | 53.05 / 49.30 | 12.06 / 12.01 | 3.09 / 3.03 |
| app | zstd | 3,336,017 | 54.39 / 54.12 | 14.45 / 14.38 | 3.63 / 3.61 |
| wide | lz4_raw | 30,326,212 | 353.71 / 341.62 | 64.09 / 63.84 | 3.22 / 3.19 |
| wide | zstd | 14,306,908 | 385.80 / 384.30 | 93.66 / 93.25 | 3.70 / 3.69 |
| otel | lz4_raw | 11,365,264 | 105.60 / 98.64 | 26.86 / 26.71 | 3.11 / 3.11 |
| otel | zstd | 4,899,785 | 110.39 / 110.00 | 32.26 / 32.10 | 3.69 / 3.68 |

Measured file-byte reductions relative to LZ4_RAW are 50.64% (app), 52.82%
(wide) and 56.89% (OTel-like). These percentages apply only to the generated
fixtures. Median conversion CPU rises by 9.77%, 12.49% and 11.51%, respectively.
The current Rust full-read medians rise from 12.06 to 14.45 ms, 64.09 to 93.66 ms,
and 26.86 to 32.26 ms. Timing variation and shared-host scheduling matter; the
[raw samples](evidence/codec.jsonl) are retained rather than claiming precision
beyond this run. Every measured round produced the same closed file length.
The [chart](evidence/comparison.html) can be regenerated with:

```sh
python tools/compression-bench/summarize.py \
  tools/compression-bench/evidence/codec.jsonl \
  tools/compression-bench/evidence/comparison.html
```

## Readers and correctness

Exact readers tested:

- **parquet Rust 59.2.0 with Arrow Rust 59.2.0**, the server's current dependency
  versions, with all shared transitive versions inherited from root Cargo.lock.
  All six files, on all six rounds, passed exact schema, row count, values,
  nulls and timestamp assertions for full and projected reads. Row-group
  statistics, encodings, sorting metadata and page column-index statistics
  matched across codecs. Reading the page indexes is required, not optional.
- **PyArrow 18.1.0 / Arrow C++ 18.1.0**, Python 3.12.16. This older independent
  reader read both standard codecs, matched full Arrow schema including
  metadata and all values against saved input IPC, and independently validated
  each row group's min/max and null counts for every column. Six verification
  records and 60 read samples are in [the raw output](evidence/pyarrow-18.1.0.jsonl).
  Supplemental warm full-read medians (wall / CPU ms): app LZ4_RAW 23.04 / 24.39,
  ZSTD 21.55 / 22.34; wide 155.97 / 159.95 and 155.86 / 160.43; OTel-like
  43.92 / 45.35 and 45.02 / 46.80. Its dataset reader has different overhead
  and behavior; these numbers do not constitute an A/B of reader versions.

A separate 100-row smoke run with a 37-row group limit passed both readers,
covering three groups and tiny partial batches. The main run crosses Arrow input
batch, data page and row-group boundaries. The all-null column and timestamp
null tail are checked in both runs. Exact IPC/Parquet/statistics artifact sizes
and SHA-256 hashes are recorded in [manifest.json](evidence/manifest.json).
The large generated fixtures are intentionally not committed; regenerate them
with the commands above. Small raw measurement outputs are committed.

## Limits and cost interpretation

This harness mirrors ordinary log writer properties; it does not invoke the
complete production staging conversion, schema merge, sorting pipeline or
DataFusion query engine. No Parseable server executable or older Parseable
release was run. Older-reader coverage is Arrow C++ 18.1.0, **not proof of a
Parseable downgrade**. Actual deployment rollback targets and their enabled
codec libraries still need a service-level read/query check before an operator
changes their setting. There is no evidence here for changing the global default.

The fixtures approximate log shapes but are synthetic and highly structured;
production cardinality, message entropy, sparsity, group sizes and CPU capacity
can produce different tradeoffs. No nested/list/map types, OTel metrics special
writer, timezone-bearing Arrow timestamps, custom partitions or evolving
schemas are covered. No claims are made about those paths. Page statistics were
compared across codecs; only row-group statistics were independently checked
against source values. The harness adds no experimental indexes.

Local reads and writes are warm and buffered, without fsync, remote requests,
SQL predicates, cold caches or concurrent ingestion. The experiment measures
new closed object bytes, not compressed page bytes alone. Lower new-object
bytes can reduce future stored bytes and bytes transferred, but a dollar cost
estimate also needs workload volume, retention, request patterns, CPU and storage
pricing. **Smaller new files do not shrink already retained objects.** There is
no rewrite, compaction, catalog, lifecycle or infrastructure change in this work.

Builds used two jobs and a ten-minute timeout; the measured run used a three-minute
timeout and completed normally. Build target was about 315 MiB; generated main
fixtures and files about 299 MiB. All experiment artifacts reside under the home
cache. An initial C build hit the host's `/tmp` quota; retrying with a dedicated
home-cache TMPDIR succeeded. No unrelated files were removed.

## Candidate PR text

Title: Add bounded standard Parquet compression benchmark and compatibility evidence

Description: Add a standalone codec A/B harness using the server's pinned
Arrow/Parquet dependencies. It compares existing LZ4_RAW and default-level ZSTD
on identical app, sparse wide and flattened OTel-like log rows, recording closed
file bytes, conversion wall/CPU time and full/projected read time. Preserve all
production defaults and public behavior.

Validation: Five measured rounds after warmup on 270,000 rows per fixture;
current Rust reader checks exact schema/values/nulls/timestamps and matching
row-group/page statistics. Older Arrow C++ 18.1.0 independently checks saved
input rows and footer min/max/null counts. Include raw results, hashes,
reproduction steps and explicit service/downgrade and synthetic-workload limits.

No PR created, pushed, merged or deployed as part of this experiment.
