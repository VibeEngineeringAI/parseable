# flatten-bench results: generic flattening limits vs 547c5118

Three back-to-back runs of the benchmark (`/tmp/flatten-row-cap-benchmark-r{6,7,8}.log`) on
the current sources, which count structurally flattened rows in the byte budget. Runs on
earlier revisions are not reported here.

## What was measured

| | |
|---|---|
| Baseline | `547c5118583b8e3884a2b6920c3b5a0ffa675f87`, `src/utils/json/flatten.rs` blob `55b4b9d4cb33e5cfa1fd29cf0ce440b3c90af666`, extracted with `git show` (not the `#[cfg(test)] legacy` module) |
| Current | Sources measured on `fix/flatten-row-cap` before publishing the commit, identified by sha256: `src/utils/json/flatten.rs` `b8a5008aa30722f0f6e1261f185a76ca95ae422e93aff271d7870d5eba020a99`, `src/utils/json/mod.rs` `d9346345fb670395e14a72e3a6cf64c9a1d632f6649aae73033e7e7fac0b47ba` |
| Toolchain | Rust 1.96.0 (`ac68faa20`), release profile, `debug_assertions=false` |
| Sampling | 31 samples, 5 warmup, ~2 ms per sample, baseline/current alternated AB/BA on one thread |
| Timed region | the call plus dropping its output (and, for the consuming entry point, its input). JSON parsing and input clones are outside it. Baseline inputs are checked to be <= 1000 rows once, before and outside any timed or counted region |
| Correctness | accepted outputs asserted identical (order-sensitive) to the baseline before timing |
| Host | a shared developer machine with other work running. The 1-minute loadavg was 3.3 to 4.6 during the runs (printed in each log). Each ratio below is a median, listed for all three runs, so small differences are noise |

Limits are the defaults: 1000 rows per event, 10 000 rows per request, and 64 MiB
(67 108 864 bytes) per request. Each event is charged the larger of its generic
intermediate rows and its structurally flattened output rows, both as compact JSON
(repeated keys, values, escapes and delimiters included), plus Kinesis metadata and OTEL
body-key prefixes on those routes. Taking the larger of the two over-counts when
structural flattening merges colliding field names, so the charge errs high. It does not
measure RSS.

## Ingestion entry point (`convert_array_to_object`, V1 JSON, includes the no-op fast paths)

cur/base median ratio for runs r6 / r7 / r8 (below 1 means the new code is faster):

| case | rows | cur/base | notes |
|---|---:|---|---|
| flat_single | 1 | 1.368 / 1.430 / 1.434 | about +165 to 198 ns per event (433–457 ns to 614–655 ns) |
| flat_batch_1000_noop | 1000 | 1.452 / 1.453 / 1.414 | +41–45%, about 133–137 µs per 1000 events (295–322 µs to 428–455 µs) |
| nested_no_arrays_200 | 200 | 1.109 / 1.083 / 1.109 | +8–11% |
| moderate_array_100 | 100 | 0.948 / 0.972 / 0.965 | 3–5% faster. alloc bytes 644 640 → 555 450 (−14%), allocs 4324 → 3524 |
| product_10x10x10 | 1000 | 0.990 / 0.999 / 0.985 | within noise, so no speedup is claimed |
| partitioned_batch_50x4 | 200 | 0.988 / 0.994 / 0.991 | within noise, so no speedup is claimed. alloc bytes 1 244 166 → 1 170 966 (−6%), allocs 6857 → 6057 |

Allocation counts are identical for the flat and nested no-array cases. Peak memory does not
regress on the array cases: `peak_delta` is 270 834 → 269 942 for moderate_array_100,
2 382 594 → 2 382 592 for product_10x10x10, and 197 971 → 197 605 for
partitioned_batch_50x4. For a consuming call, `peak_delta` is offset by freeing the input;
the borrowed section below has no such offset and shows the same or lower peaks.

## `generic_flattening` only (bounded vs unbounded, no no-op fast path)

| case | cur/base r6 / r7 / r8 |
|---|---|
| flat_single | 1.380 / 1.348 / 1.372 |
| flat_batch_1000_noop | 1.269 / 1.315 / 1.269 |
| nested_no_arrays_200 | 1.250 / 1.227 / 1.248 |
| moderate_array_100 | 0.927 / 0.926 / 0.926 |
| product_10x10x10 | 1.003 / 0.999 / 0.983 |
| partitioned_batch_50x4 | 0.974 / 0.992 / 0.988 |

Preflight alone (`charge_flatten_pipeline`, generic and structural bytes, on a fresh budget
per event, current only) makes 0 allocations for every case. Medians over the three runs:
flat_single 249–254 ns, flat_batch_1000 184–188 µs, nested_no_arrays_200 48.6–49.7 µs,
moderate_array_100 6.7 µs, product 438–442 ns, partitions 9.6–9.8 µs. The entry point's
flat overhead (about 135 µs per 1000 events) is lower than the standalone flat preflight
because array-free events are checked and charged in the same walk that would otherwise
detect the no-op.

## Rejections (current only; the baseline is never run on these inputs)

| input | entry-point median r6 / r7 / r8 |
|---|---|
| hostile_cube_1000^3 (10^9 rows) | 22.9 / 22.7 / 22.6 µs |
| deep_product_nested_arrays (~1M rows) | 15.6 / 14.2 / 15.7 µs |
| deep_product_nested_objects (10^6 rows) | 2.6 / 2.4 / 2.5 µs |
| large_repeated_string (600 rows, over 64 MiB) | 20.0 / 20.1 / 19.5 µs |
| escaped_repeated_string (500 rows, over 64 MiB after escaping) | 62.8 / 58.7 / 62.5 µs |
| just_over_event_limit (1001 rows) | 9.6 / 10.0 / 7.5 µs |

- **Memory:** every rejection at the entry point allocates exactly once, 112 bytes (the
  `anyhow` error), with `peak_delta=0`. In `/tmp/flatten-row-cap-harness-tests-r5.log` the
  core paths (preflight, per-event `charge`, `pipeline charge`, and bounded
  `generic_flattening`) report 0 allocations, 0 bytes and `peak_delta=0` for every hostile
  input, and `core charge, remaining rows/bytes insufficient` reports the same for a request
  budget whose remainder is too small. For an event whose generic rows fit but whose
  structurally flattened field names do not (a 128-character parent copied into 32 field
  names over 4 rows), `structural preflight, long parent` and `structural charge, long
  parent` report 0 allocations, and the entry point rejects it with 1 allocation of 112
  bytes and `peak_delta=0` (2 allocations, 184 bytes, `peak_delta=72` with a partition
  field). `tests/alloc_limits.rs` asserts these. They are measured by the counting
  allocator, not as full-process RSS.
- **Time:** these times include freeing the consumed input. They grow with the input's size
  and with how much of it is walked before the limit trips, not with the rows the input would
  expand to. They are not constant across inputs.
- **Before this change:** the baseline would materialize all of the rows: 10^9 for the cube,
  and more than 64 MiB of rows for the string cases.

## Verification

Results for the sources identified by the hashes above:

| check | result |
|---|---|
| focused server unit tests (`utils::json`, `otel::logs`, `handlers::http::kinesis`, `option::flatten_limit_tests`, `storage::field_stats` flatten-limit tests, `handlers::http::ingest` flatten test), one invocation | 104 pass (`/tmp/flatten-row-cap-focused-tests-r3.log`) |
| allocation/harness tests (`tools/flatten-bench`, release) | 13 pass (`/tmp/flatten-row-cap-harness-tests-r5.log`) |
| HTTP smoke test against a freshly built `parseable` binary | 67/67 pass (`/tmp/flatten-row-cap-http-smoke-r3.log`) |
| `cargo clippy --all-targets --offline` | Pass, with existing unrelated warnings (`/tmp/flatten-row-cap-clippy-r3.log`) |
| `cargo fmt --all -- --check` | Pass (`/tmp/flatten-row-cap-fmt-final.log`) |
| Final Sol 6.1 core and integration reviews | No actionable findings; the escaped-parent HTTP coverage suggestion is included in the passing smoke run |

The HTTP smoke test checks that late failures leave no schema sentinel and do not change the
event count, covers OTEL prefix and Kinesis metadata attack inputs, rejects events whose long
or quote-escaped parent names only exceed the byte limit once structurally flattened (on the
JSON, logstream, custom partition and Kinesis routes), and verifies environment flag
precedence.

```sh
cargo test --lib --offline -- --test-threads=1 utils::json otel::logs handlers::http::kinesis \
  option::flatten_limit_tests storage::field_stats::tests::stats_payload_flatten_limits_are_bounded \
  storage::field_stats::tests::widest_stats_payload_fits_its_flatten_limits \
  handlers::http::ingest::tests::flatten
cargo test --release --manifest-path tools/flatten-bench/Cargo.toml --offline -- --nocapture
cargo build --bin parseable --offline
python3 tools/flatten-bench/http_smoke.py target/debug/parseable
```

## Interpretation

- **Remaining cost:** flat and nested inputs without arrays are 8–45% slower (about 0.13 µs
  per flat event in a batch, 0.17–0.20 µs for a single event). This is the price of the
  added safety: the event has to be walked to count its generic and structural rows and
  bytes before anything is built. The fast paths still return the input
  unchanged without copying it, and allocation counts are unchanged.
- **Inputs with arrays:** these break even or improve slightly, with fewer and smaller
  allocations. Only moderate_array_100 is measurably faster; product_10x10x10 and
  partitioned_batch_50x4 are within noise.
- **Limits:** none of the optimizations relax them. A limit that would be exceeded is
  rejected before any row is built.
- **Scope:** these are microbenchmarks of the flattening code only, not end-to-end ingestion
  throughput. Parsing, Arrow conversion, and I/O are not included.

## Reproduce

Run from the repository root. The repository must have the baseline commit available
(`git cat-file -e 547c5118`), because `build.rs` extracts it with `git show`.

```sh
export PATH=$HOME/.cargo/bin:$PATH P_BUILD_NO_UI=1 CARGO_BUILD_JOBS=4
sha256sum src/utils/json/flatten.rs src/utils/json/mod.rs; rustc -V
RUST_LIB_BACKTRACE=0 cargo test --release --manifest-path tools/flatten-bench/Cargo.toml -- --nocapture
for r in 1 2 3; do
  cargo run --release --manifest-path tools/flatten-bench/Cargo.toml --bin flatten_bench \
    | tee /tmp/flatten-bench-run$r.log
done
```

Run on an otherwise quiet machine with no parallel cargo builds. Compare the medians across
runs, and record the loadavg lines. The printed checksum adds up output row counts over
batches whose sizes are calibrated at run time, so it is expected to differ between runs.
