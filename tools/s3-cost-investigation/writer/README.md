# Production-profile writer probe (independent follow-up)

This adds evidence only. It does not change runtime code, defaults, schemas,
codec options, manifests, object publication, accounting or retention. PR137 is
complete; its harness is the starting implementation, copied into isolated scratch.

Fixtures remain deterministic synthetic controls, **not production samples**.
They replace structured request/trace/span IDs with uniform SplitMix64-generated
hex strings, use 128-byte high-entropy message payloads (2,048 bytes every tenth
row), retain Unicode/null/all-null/80%-sparse-wide columns, and use non-null
batch-constant ingestion times. App/OTel ingestion batch sizes cycle through
1, 32, 256 and 8,192; wide is the 8,192-row constant-batch control. The OTel-shaped
fixture adds a descending millisecond `event_time` column with gaps every 97 rows,
and selects it as the user time partition. These sizes/distributions are chosen
controls; actual ingestion batch/time distributions were not supplied. The user
partition is mirrored in writer properties, not exercised through the service's
routing/schema/sorting/catalog path. Long messages exercise ordinary Parquet
statistics behavior; they do not prove SQL pruning or Parseable service behavior.

IPC input slices use the same varied sizes as ingestion-timestamp groups, so
actual writer input batch boundaries follow these chosen distributions. They
are synthetic controls, not a replay of captured service ingestion batches.

The two arms retain the current dictionary or disable it **only on the selected
time partition**. Both retain DELTA_BINARY_PACKED fallback and all other settings.
The user-time arm retains the ingestion timestamp's dictionary. LZ4_RAW and the
existing Zstd level 1 are alternated AB/BA within each arm, with one discarded
warmup and three measured rounds. The dictionary arms run separately: their CPU
difference is descriptive, not a controlled encoding speedup estimate.

The probe uses production `release-lto` (fat LTO, one codegen unit) and Linux
jemalloc with exactly the root codec and allocator versions/features. It is
still a standalone writer/reader, not a service CPU benchmark. Timings include
IPC decoding, writer setup, encode, buffered filesystem writes and close. They
exclude fixture generation, verification and fsync. Timed reads are warm local
Arrow reads, not DataFusion/S3 queries. The shared host is unpinned.

Reproduce from the repository root, with a **new** scratch path:

```sh
export PATH="$HOME/.cargo/bin:$PATH"
SCRATCH="$HOME/.cache/parseable-s3-writer-NEW"
python3 tools/s3-cost-investigation/writer/prepare.py "$SCRATCH"
export TMPDIR="$SCRATCH/tmp" CARGO_TARGET_DIR="$SCRATCH/target"
mkdir -p "$TMPDIR"
CARGO_BUILD_JOBS=2 timeout 600 cargo build --locked --profile release-lto \
  --manifest-path "$SCRATCH/harness/Cargo.toml"
timeout 180 "$CARGO_TARGET_DIR/release-lto/compression-bench" \
  "$SCRATCH/dictionary" 100000 3 262144 > "$SCRATCH/dictionary.jsonl"
PROBE_DELTA=1 timeout 180 "$CARGO_TARGET_DIR/release-lto/compression-bench" \
  "$SCRATCH/delta" 100000 3 262144 > "$SCRATCH/delta.jsonl"
# Existing isolated Arrow C++ 18.1.0 reader, or create it using PR137 README:
"$HOME/.cache/parseable-compression-reader/bin/python" \
  tools/s3-cost-investigation/writer/summarize.py "$SCRATCH" > "$SCRATCH/summary.json"
```

Every Rust round checks schema/values/nulls/timestamps, codec, declared sorting,
selected timestamp encoding, row-group and required page-index statistics across
codecs. The summary independently uses Arrow C++ 18.1.0 to check all values,
schemas and row-group null/min/max statistics in all twelve files (exact bounds
for nonstrings; conservative containment for truncated strings), and compares
row-group statistics and identical IPC hashes across dictionary arms. Older
Parseable-service rollback, concurrent ingestion/retention, SQL queries, recovery
and tenant authorization are **not covered**. No supported older service target
was supplied. Existing defaults stay in place.

No production S3 inventory was supplied. The generated file sizes/footers/groups
in `summary.json` are fixture inventory only. Production compaction cannot be
ranked from it. The current writer already groups staged Arrow files by minute
and splits groups above MAX_ARROW_FILES_PER_PARQUET (default 512); staged-file
counts therefore do not establish physical S3 object counts. Obtain a real
stream/partition/age object-size distribution before designing compaction.

Measured findings are in [RESULTS.md](RESULTS.md). The recorded investigation
scratch, including builds, initial discarded overlapping timing runs and final
sequential runs, used 1.8 GiB. The discarded runs are not summarized or committed.

Regenerate hashes with `python3 tools/s3-cost-investigation/writer/manifest.py "$SCRATCH"`.
The feature audit used `cargo tree --locked --offline -e normal,build --prefix none
-f "{p} {f}"` separately against root Cargo.toml and the prepared harness, comparing
`lz4_flex`, `zstd`, `zstd-safe`, `zstd-sys`, `tikv-jemallocator`, and `tikv-jemalloc-sys`.
