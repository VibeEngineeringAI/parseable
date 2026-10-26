# flatten-bench

Measured results against 547c5118 are in [RESULTS.md](RESULTS.md).

Standalone harness for the generic flattening limits in `src/utils/json`. It compiles the
production sources unmodified, so it measures the real code without building the server
(own `[workspace]`, depends only on serde/serde_json/chrono/thiserror/anyhow/tracing):

- `current_json`: the working tree's `src/utils/json/{mod,flatten,strict}.rs`, included by path.
- `baseline_json`: the same files at `547c5118` (the merge-base, including its no-op fast
  paths), extracted byte for byte with `git show` by `build.rs` into `OUT_DIR`. Override
  with `FLATTEN_BENCH_BASELINE_REV=<rev>`. This is NOT the `#[cfg(test)] legacy` module in
  flatten.rs, which predates those fast paths; `[lib] test = false` keeps production
  `#[cfg(test)]` code out entirely. The bench prints the revision and flatten.rs blob id.

`src/lib.rs` stubs the few server items those files use (`crate::cli`, `PARSEABLE`,
`LogSource`, `SchemaVersion`); `stub_defaults_match_server` checks the stubbed
`DEFAULT_MAX_FLATTEN_*` against `src/cli.rs`. `src/api.rs` is the only file that names
production signatures.

## Run

```sh
export PATH=$HOME/.cargo/bin:$PATH
cd tools/flatten-bench
RUST_LIB_BACKTRACE=0 CARGO_BUILD_JOBS=4 cargo test --release -- --nocapture
cargo run --release --bin flatten_bench | tee /tmp/flatten-bench-$(git rev-parse --short HEAD)-$(date +%s).log
```

Settings: `FLATTEN_BENCH_SAMPLES` (31), `FLATTEN_BENCH_WARMUP` (5),
`FLATTEN_BENCH_SAMPLE_NS` (2_000_000 ns per sample). For a reproducible report, record
`git rev-parse HEAD`, `git diff --stat -- src/utils/json`, `rustc -V`, and the loadavg
lines the bench prints; run on a quiet machine (no parallel cargo builds) 2-3 times and
compare medians, since same-host noise is often larger than small deltas.

## What is timed

- Parsing is never timed: inputs are built once as `serde_json::Value`.
- Baseline safety: every accepted fixture is checked ONCE (`BaselineInput::check`, a
  saturating row upper bound <= 1000) before any baseline call and outside every timed or
  counted region. Timed baseline calls take the checked `BaselineInput` and do no extra
  walk; the current side does only its real preflight. Hostile inputs are never given to
  the baseline. `baseline_convert`/`baseline_generic` re-check per call and are for tests only.
- Consuming entry point (`convert_array_to_object`): each sample pre-clones `batch` inputs
  outside the timer; the timer covers the call plus dropping its output and the consumed
  input, the same for both sides. Borrowed APIs reuse one input; output drop is timed.
- Baseline/current samples alternate AB, BA, ... on one thread; median and p95 per call.
  Outputs are asserted identical (order-sensitive) before timing. A checksum is printed and
  results go through `black_box`.
- Sections: entry point; `generic_flattening` only (bounded vs unbounded; the current side
  also contains the rewritten expansion); preflight only (`charge_flatten_pipeline`, which
  counts generic and structurally flattened bytes, on a fresh budget, per event like the
  entry point); rejections (current only).

## Allocation numbers

From one separate counted call per implementation (never the timed ones), on the calling
thread only, in requested bytes (not RSS): `allocs` alloc/realloc calls, `alloc_bytes`
cumulative bytes requested, `peak_delta` highest live bytes above the level at call start,
`net_delta` live bytes at the end minus the start. `peak_delta` is a delta, not an absolute
peak: for consuming calls, freeing the input during the call lowers it. The borrowed
`generic_flattening` section shows the extra memory without that offset.

## HTTP smoke test

`http_smoke.py` (Python 3 standard library only) starts a built server binary with
`local-store` on an ephemeral 127.0.0.1 port, in a temporary directory, with small flatten
caps (rows per event and bytes from the environment, rows per request from the CLI flag,
overriding a different environment value). It checks accepted requests at the limits and
`400` rejections over them, with unchanged event counts and schemas, for JSON (on
`/api/v1/ingest` and `/api/v1/logstream/{name}`), a known log format, custom partitions,
Kinesis, OTEL JSON logs and schema detection, including events whose long or quote-escaped
parent names only exceed the byte limit once structural flattening repeats them in every
field name.

```
P_BUILD_NO_UI=1 cargo build --bin parseable
python3 tools/flatten-bench/http_smoke.py target/debug/parseable
```
