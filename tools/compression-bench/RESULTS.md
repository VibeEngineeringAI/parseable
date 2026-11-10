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
commands, fixture definitions and timing boundaries. The exact harness revision
and source hashes are in [manifest.json](evidence/manifest.json). Codec feature
sets match the default Linux root build; see [the feature audit](evidence/codec-features.json).

Actual file lengths and medians in milliseconds (wall / process CPU):

| Dataset | Codec | File bytes | Write wall / CPU ms | Full read wall / CPU ms | Project read wall / CPU ms |
|---|---|---:|---:|---:|---:|
| app | lz4_raw | 6,757,933 | 48.60 / 48.39 | 12.18 / 12.15 | 3.05 / 3.03 |
| app | zstd | 3,336,017 | 53.69 / 53.51 | 14.35 / 14.31 | 3.50 / 3.49 |
| wide | lz4_raw | 30,326,212 | 357.98 / 349.79 | 66.75 / 66.45 | 3.20 / 3.18 |
| wide | zstd | 14,306,908 | 399.56 / 391.97 | 96.98 / 96.55 | 3.71 / 3.69 |
| otel | lz4_raw | 11,365,264 | 104.13 / 103.62 | 27.86 / 27.72 | 3.28 / 3.26 |
| otel | zstd | 4,899,785 | 114.73 / 114.20 | 32.64 / 32.45 | 3.70 / 3.69 |

Measured file-byte reductions relative to LZ4_RAW are 50.64% (app), 52.82%
(wide) and 56.89% (OTel-like). These percentages apply only to the generated
fixtures. Median conversion CPU rises by 10.57%, 12.06% and 10.21%, respectively.
The current Rust full-read medians rise from 12.18 to 14.35 ms, 66.75 to 96.98 ms,
and 27.86 to 32.64 ms. Timing variation and shared-host scheduling matter; the
[raw samples](evidence/codec.jsonl) are retained rather than claiming precision
beyond this run. Every measured round produced the same closed file length.
The [chart](evidence/comparison.html) can be regenerated with:

```sh
python3 tools/compression-bench/summarize.py \
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
  Supplemental warm full-read medians (wall / CPU ms):
  app LZ4_RAW 22.08 / 22.61, ZSTD 22.88 / 23.87;
  wide LZ4_RAW 158.16 / 161.79, ZSTD 156.30 / 163.23;
  OTel-like LZ4_RAW 43.86 / 44.88, ZSTD 45.10 / 46.87.
  Its dataset reader has different overhead
  and behavior; these numbers do not constitute an A/B of reader versions.

A separate 100-row smoke run with a 37-row group limit passed both readers,
covering three groups and tiny partial batches; see the committed
[Rust output](evidence/smoke-codec.jsonl) and
[older-reader output](evidence/smoke-reader.jsonl). The main run crosses Arrow input
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

Timed writes include creating a fresh output file. Previous outputs are unlinked
outside the timed region.
The standalone release profile and system allocator differ from production's
`release-lto` profile and jemalloc. Absolute timings may not carry over to the
service; see [Method](README.md#method).

Builds used two jobs and a four-minute timeout; the measured run used a three-minute
timeout and completed normally. Generated main fixtures and files total about
299 MiB; the standalone build additionally uses several hundred MiB. Generated fixtures and build artifacts are
kept outside the repository.

## Review follow-up

The original run timed truncation of each previous output file and did not
match all root Zstd features. Its raw samples and artifact manifest are retained
as `codec-before-review.jsonl`, `pyarrow-before-review.jsonl` and
`manifest-before-review.json`. The table and chart above use the fresh run with
untimed unlink and aligned codec features. All twelve regenerated fixture and
output artifact hashes match the original run; file-byte reductions are unchanged.
Clock differences across these shared-host runs are not a controlled estimate
of either remediation's independent timing effect.

The timestamp values are much more varied than batch-constant production
`p_timestamp`, and the trace/span IDs are structured counters. Those choices
can favor compression and limit extrapolation to production. Dictionary encoding
was actually used for `p_timestamp`; the configured delta encoding is a fallback.
See README Method for the fixture limitations.

## Additional finding: timestamp dictionary selection

The configured delta encoding is bypassed while the timestamp dictionary fits.
The committed [column inspection](evidence/columns.json) confirms actual
`PLAIN`, `RLE`, `RLE_DICTIONARY` encodings, not `DELTA_BINARY_PACKED`. In the app
fixture, the timestamp column is 11.84% of the LZ4_RAW file and 17.47% of the ZSTD
file; the request-ID column is 74.36% and 61.24%. Thus timestamp cardinality is
one influence, not the only source of the codec size difference.

A standalone probe disabled the dictionary only for `p_timestamp`, retaining
the existing delta fallback. A second control used a non-null timestamp that
is constant within each 8,192-row IPC batch. Compressed timestamp-column bytes
and whole-file changes are identical across the three shapes for each case:

| Timestamp fixture | Codec | Timestamp bytes: dictionary | Timestamp bytes: delta | Whole-file change |
|---|---|---:|---:|---:|
| Dense, three rows per millisecond, 1% null | LZ4_RAW | 799,870 | 1,333 | -798,622 bytes |
| Dense, three rows per millisecond, 1% null | ZSTD | 582,946 | 1,035 | -581,994 bytes |
| Non-null, constant per IPC batch | LZ4_RAW | 664 | 917 | +240 bytes |
| Non-null, constant per IPC batch | ZSTD | 735 | 924 | +175 bytes |

The dense probe used warmup plus five measured rounds. Both control arms used
warmup plus three measured rounds, on 270,000 rows per shape. All rounds passed
the current Rust reader, including required page indexes and expected actual
encodings. Arrow C++ 18.1.0 independently verified schema, values, nulls,
timestamps, row counts and row-group statistics in all variants. Input IPC
hashes match across dictionary/delta arms within each fixture. See the
`timestamp-dictionary-disabled*` and `timestamp-batch-*` raw records, column
inspections, source patches and manifests in `evidence/`.

This is evidence for testing column-specific dictionary selection on dense
time columns. It does not support disabling dictionaries globally: the control
is slightly worse, production batch sizes vary, and user time-partition paths
were not run through the service. The dictionary arms were separate runs on a
shared host, not interleaved against each other, so their CPU/time differences
are descriptive and are not claimed as an encoding speedup. No production
writer, default or public file format was changed. Reproduction steps are in
[README](README.md#timestamp-encoding-probes).

The column inspection also records footer metadata lengths. It does not measure
physical S3 requests or prove that a smaller metadata-size hint would save
money. That candidate still requires a cold/warm server-side Range-header
trace, as described in the bloom benchmark README.
