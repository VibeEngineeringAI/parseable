# Standard Parquet codec A/B

This standalone harness measures the existing `lz4_raw` and `zstd` options without
building Parseable. It changes no defaults or production behavior. Results and
compatibility limits are in [RESULTS.md](RESULTS.md).

## Reproduce on Linux

Run from the repository root. Use a new output directory for each run. The harness
refuses to reuse an existing directory. It accepts 100–300,000 rows, 1–9 measured
rounds, and 1–262,144 rows per row group. Disk and memory depend on those limits;
the total is also limited to 128 row groups per file, preventing tiny row groups
from creating millions of column chunks. Invalid runs are rejected before output
creation. The recorded run uses under 1 GiB of artifacts, including its
standalone build.
No server, credentials, S3 requests, container image, or experimental index is needed.

```sh
export PATH="$HOME/.cargo/bin:$PATH"
export CARGO_TARGET_DIR="$HOME/.cache/parseable-compression-bench-target"
export TMPDIR="$HOME/.cache/parseable-compression-tmp"
mkdir -p "$TMPDIR"
CARGO_BUILD_JOBS=2 timeout 600 cargo build --release --locked \
  --manifest-path tools/compression-bench/Cargo.toml
OUT="$HOME/.cache/parseable-codec-measurement-1"
timeout 180 "$CARGO_TARGET_DIR/release/compression-bench" \
  "$OUT" 270000 5 262144 > "$OUT.jsonl"
python3 tools/compression-bench/summarize.py "$OUT.jsonl"
# Optional independent older reader, isolated from system Python:
UV_CACHE_DIR="$HOME/.cache/parseable-compression-uv" uv venv --python 3.12 \
  "$HOME/.cache/parseable-compression-reader"
UV_CACHE_DIR="$HOME/.cache/parseable-compression-uv" uv pip install \
  --python "$HOME/.cache/parseable-compression-reader/bin/python" pyarrow==18.1.0
"$HOME/.cache/parseable-compression-reader/bin/python" \
  tools/compression-bench/verify_reader.py "$OUT" > "$OUT-reader.jsonl"
"$HOME/.cache/parseable-compression-reader/bin/python" \
  tools/compression-bench/inspect_columns.py "$OUT" > "$OUT-columns.json"
```

Use a quiet host and record `rustc -Vv`, `uname -a`, CPU model, affinity and load.
The committed lockfile inherits every shared dependency version from the root
lockfile at `36c3978acf3aa559a7e8ea7032fdc0abb6ea6f2a` (including Arrow/Parquet
59.2.0, zstd 0.13.3 / zstd-sys 2.0.16+zstd.1.5.7, lz4_flex 0.14.0).
Recheck that alignment when production dependencies change.
The direct `zstd` dependency matches the server's codec feature unification;
version equality alone is insufficient. The checked Linux feature sets and
commands are recorded in `evidence/codec-features.json`.
The evidence manifest records the producing harness revision and source hashes;
the Python reader record includes its Python version.

## Method

Three deterministic synthetic shapes approximate ordinary application logs (8
columns), sparse flattened wide logs (56 columns), and flattened OTel-like logs
(14 columns). They include repeated low-cardinality labels and bodies, unique
request IDs, floats, booleans, millisecond timestamps, nanosecond integer time,
Unicode, null values and an entirely null column. Wide attributes are 80% null.
They are illustrative shapes, not sampled customer traffic. OTel-like records
are logs, not the special OTel metrics conversion path.

The timestamp fixture deliberately repeats each millisecond three times and
has a 1% null tail. Production `p_timestamp` is non-null and constant within
each ingested batch, so this fixture has much higher timestamp cardinality.
OTel-like trace/span IDs are descriptive prefixes plus sequential zero-padded
counters, not random hexadecimal IDs. The multiplicative request-ID generator
is deterministic too. These structured inputs can favor compression, and the
recorded percentages must not be generalized to real trace traffic. Strings
are short; long-message statistics truncation is not exercised.

Each fixture is generated once and saved as Arrow IPC in 8,192-row batches. Both
codecs read exactly that file with the same schema, row order, batch boundaries,
row-group size and writer properties. `ZstdLevel::default()` is level 1 in this
Parquet version (the existing CLI mapping); no custom compression level is used.
The writer mirrors `Stream::parquet_writer_props` for ordinary unclustered logs:
262,144-row groups in the measured run, delta-binary fallback encoding configured
for `p_timestamp`, and descending/nulls-last time sort metadata. Other properties use the same
Parquet 59.2.0 defaults: Parquet 1.0 writer, dictionary encoding enabled, 1 MiB
page/dictionary limits, 20,000-row page limit, 1,024-row write batches and page
statistics. No optional bloom filters, custom partitions, clustering or new
indexes are enabled. The harness mirrors these few properties rather than
compiling `streams.rs`; it must be checked against production after changes.
Dictionary encoding takes precedence while its dictionary fits. In these
fixtures `p_timestamp` uses `PLAIN`, `RLE` and `RLE_DICTIONARY` instead of
`DELTA_BINARY_PACKED`; configuring the fallback does not force its use.

There is one discarded warmup followed by five measured rounds. Codec order
alternates AB/BA. Actual closed file length includes footer and page indexes;
all measured rounds must have identical file sizes. Conversion wall and process
user+system CPU time cover IPC open/decode, writer construction, encoding,
filesystem writes and close, but not fixture generation or correctness checks.
There is no fsync: these are page-cache-backed local writes, not durable S3
uploads. Full and three-column projected read timings cover open, metadata and
complete decoding/materialization; result drops and value checks are outside
the timed read. Correctness verification precedes timed reads, so reads are warm.
These timings do not measure SQL pruning, DataFusion scheduling or S3 latency.
Before each round the previous output is unlinked outside the timed region.
Creating the new output remains timed. The standalone `release` profile uses
the system allocator, whereas the Linux production build uses `release-lto`
with fat LTO, one codegen unit and
jemalloc; absolute timings may differ from the service.

For every file on every round, the Rust reader checks exact Arrow schema and
all rows/values/nulls/timestamps, both full and projected. It also checks every
column chunk's codec against the requested codec, separately from semantic
comparisons. It compares Parquet schema, row-group counts/row counts, sorting
metadata, encodings, row-group
statistics and page column-index statistics across codecs. Byte offsets and
compressed sizes are intentionally excluded from semantic comparisons. The
configured fallback and dictionary setting, expected sort metadata and actual
timestamp dictionary encoding are asserted separately from codec comparisons.
The older independent reader compares full schema (including metadata) and all
values to the input IPC, and validates every row group's min/max and null counts
against the input via Arrow compute. Its warm read samples are supplemental;
reader implementations and versions must not be compared as a controlled A/B.

`inspect_columns.py` records file/footer sizes, actual encodings and compressed
bytes for selected columns; `--columns` selects a different list. The footer
metadata size excludes the trailing eight-byte Parquet footer length/magic and
does not include bloom filters or column/page indexes. It is not a measurement
of bytes fetched by a query.

The summarizer requires the declared number of measured rounds and one warmup
per codec/shape, rejecting missing or duplicate samples before reporting medians.

## Timestamp encoding probes

The main harness retains the production dictionary setting. Separate probe
patches under `evidence/` modify only copies of the standalone harness. Their
base revision and source hashes are recorded in
`timestamp-dictionary-disabled-manifest.json` and `timestamp-batch-manifest.json`.
The dense probe keeps the main fixture and disables the timestamp dictionary.
The batch controls instead make `p_timestamp` non-null and constant within each
IPC batch, testing both dictionary and delta encoding. Results and limitations
are in [RESULTS](RESULTS.md#additional-finding-timestamp-dictionary-selection).

To reproduce the dense probe, run from the repository root with the reader
environment prepared above:

```sh
PROBE_PARENT=$(mktemp -d "$HOME/.cache/parseable-time-probe.XXXXXX")
git archive 28ce491b tools/compression-bench | tar -x -C "$PROBE_PARENT"
patch -d "$PROBE_PARENT/tools/compression-bench" -p1 \
  < tools/compression-bench/evidence/timestamp-dictionary-disabled.patch
CARGO_TARGET_DIR="$PROBE_PARENT/target" TMPDIR="$PROBE_PARENT" \
  CARGO_BUILD_JOBS=2 timeout 600 cargo build --release --locked \
  --manifest-path "$PROBE_PARENT/tools/compression-bench/Cargo.toml"
timeout 180 "$PROBE_PARENT/target/release/compression-bench" \
  "$PROBE_PARENT/data" 270000 5 262144 > "$PROBE_PARENT/codec.jsonl"
"$HOME/.cache/parseable-compression-reader/bin/python" \
  tools/compression-bench/verify_reader.py "$PROBE_PARENT/data"
"$HOME/.cache/parseable-compression-reader/bin/python" \
  tools/compression-bench/inspect_columns.py "$PROBE_PARENT/data"
```

For each batch control use a fresh copy of the same base revision, apply
`timestamp-batch-dictionary.patch` or `timestamp-batch-delta.patch`, and use
three measured rounds. Keep output directories separate. All probe variants
retain the same pinned codec versions/features and local buffered timing method.
