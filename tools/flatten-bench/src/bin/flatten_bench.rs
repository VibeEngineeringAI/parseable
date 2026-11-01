//! Baseline (547c5118 source) vs current (working tree source) flattening benchmark.
//!
//! Run with `cargo run --release --bin flatten_bench` from tools/flatten-bench.
//! Env: FLATTEN_BENCH_SAMPLES (default 31), FLATTEN_BENCH_WARMUP (default 5),
//! FLATTEN_BENCH_SAMPLE_NS (target time per sample, default 2_000_000).
//!
//! Method: inputs are built once (no parsing is timed). Every baseline input is checked
//! ONCE to expand to <= 1000 rows (`BaselineInput::check`) before any baseline call and
//! outside every timed/counted region; timed baseline calls take the checked input and do
//! no extra walk. For the consuming entry point each sample pre-clones a batch of inputs
//! outside the timer, then times flattening plus dropping the output and the consumed
//! input, identically for both sides; borrowed APIs reuse one input and drop the output
//! inside the timer. Baseline and current samples alternate (AB, BA, ...) on the same
//! thread with identical inputs. Allocation stats come from one separate counted call per
//! implementation, never from timed ones; see `fmt_alloc` for what each number means.
//! Rejection cases run only against the current code.

use std::hint::black_box;
use std::time::Instant;

use flatten_bench::alloc_counter::{AllocStats, CountingAlloc, measure};
use flatten_bench::api::{
    BaselineInput, FlattenLimits, baseline_convert_checked, baseline_generic_checked,
    current_convert, current_generic, current_pipeline_charge, ordered,
};
use flatten_bench::fixtures::{self, Case, accepted_cases};
use serde_json::Value;

#[global_allocator]
static ALLOC: CountingAlloc = CountingAlloc;

const DEFAULT: FlattenLimits = FlattenLimits::DEFAULT;

struct Config {
    samples: usize,
    warmup: usize,
    sample_ns: u128,
}

fn env_or(name: &str, default: u128) -> u128 {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

fn loadavg() -> String {
    std::fs::read_to_string("/proc/loadavg")
        .map(|s| s.trim().to_owned())
        .unwrap_or_else(|_| "n/a".into())
}

/// An implementation under test: `Owned` consumes a pre-cloned input per call (the
/// ingestion entry point), `Borrowed` reads the same input every call.
/// `T` is `BaselineInput` for the baseline (so it can only ever see checked inputs) and
/// `Value` for the current code.
enum Imp<'a, T> {
    Owned(&'a dyn Fn(T) -> usize),
    Borrowed(&'a dyn Fn(&T) -> usize),
}

impl<T> Clone for Imp<'_, T> {
    fn clone(&self) -> Self {
        *self
    }
}
impl<T> Copy for Imp<'_, T> {}

impl<T: Clone> Imp<'_, T> {
    /// One counted call, with any input clone made before counting starts
    fn alloc_stats(self, input: &T) -> AllocStats {
        match self {
            Imp::Owned(f) => {
                let input = input.clone();
                measure(move || f(input)).1
            }
            Imp::Borrowed(f) => measure(|| f(input)).1,
        }
    }
}

/// Runs `imp` `batch` times and returns the mean ns per call. Clones are made before the
/// timer starts; the timed region is the call, including dropping its output and, for
/// `Owned`, the consumed input.
fn time_batch<T: Clone>(input: &T, batch: usize, checksum: &mut u64, imp: Imp<T>) -> f64 {
    match imp {
        Imp::Owned(f) => {
            let mut inputs: Vec<T> = (0..batch).map(|_| input.clone()).collect();
            let start = Instant::now();
            // `drain` keeps the Vec buffer itself alive, so only per-call work is timed
            for input in inputs.drain(..) {
                *checksum = checksum.wrapping_add(black_box(f(black_box(input))) as u64);
            }
            let ns = start.elapsed().as_nanos() as f64 / batch as f64;
            drop(inputs);
            ns
        }
        Imp::Borrowed(f) => {
            let start = Instant::now();
            for _ in 0..batch {
                *checksum = checksum.wrapping_add(black_box(f(black_box(input))) as u64);
            }
            start.elapsed().as_nanos() as f64 / batch as f64
        }
    }
}

/// Batch size giving about `sample_ns` per sample, capped so the pre-cloned inputs stay
/// around 256 MiB of serialized size at most.
fn batch_size(cfg: &Config, input: &Value, one_ns: f64) -> usize {
    let input_bytes = serde_json::to_vec(input).unwrap().len().max(1);
    let memory_cap = ((256 << 20) / input_bytes).max(1);
    ((cfg.sample_ns as f64 / one_ns.max(1.0)) as usize).clamp(1, 2000.min(memory_cap))
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    let idx = ((sorted.len() - 1) as f64 * p).round() as usize;
    sorted[idx]
}

struct Summary {
    median: f64,
    p95: f64,
}

fn summarize(mut samples: Vec<f64>) -> Summary {
    samples.sort_by(f64::total_cmp);
    Summary {
        median: percentile(&samples, 0.5),
        p95: percentile(&samples, 0.95),
    }
}

fn fmt_ns(ns: f64) -> String {
    if ns >= 1e6 {
        format!("{:.3}ms", ns / 1e6)
    } else if ns >= 1e3 {
        format!("{:.2}us", ns / 1e3)
    } else {
        format!("{ns:.0}ns")
    }
}

/// All numbers are for one call, measured on this thread only, in requested bytes (not RSS):
/// `allocs` alloc+realloc calls; `alloc_bytes` cumulative bytes requested (not live);
/// `peak_delta` highest live bytes above the level at call start, i.e. extra memory the
/// call needed on top of its input (freeing a consumed input during the call offsets it,
/// so it is not an absolute peak); `net_delta` live bytes at the end minus at the start
/// (negative when the call freed its consumed input and dropped its output).
fn fmt_alloc(stats: AllocStats) -> String {
    format!(
        "allocs={} alloc_bytes={} peak_delta={} net_delta={}",
        stats.count, stats.total_bytes, stats.peak_bytes, stats.net_bytes
    )
}

/// Times two implementations on the same input with alternating order.
fn compare(
    cfg: &Config,
    label: &str,
    base_input: &BaselineInput,
    input: &Value,
    base: Imp<BaselineInput>,
    cur: Imp<Value>,
    checksum: &mut u64,
) {
    debug_assert!(base_input.value() == input);
    // Calibrate a batch size so one sample takes about `sample_ns`
    let one = time_batch(base_input, 1, checksum, base).max(time_batch(input, 1, checksum, cur));
    let batch = batch_size(cfg, input, one);

    for _ in 0..cfg.warmup {
        time_batch(base_input, batch, checksum, base);
        time_batch(input, batch, checksum, cur);
    }
    let (mut b, mut c) = (Vec::new(), Vec::new());
    for i in 0..cfg.samples {
        if i % 2 == 0 {
            b.push(time_batch(base_input, batch, checksum, base));
            c.push(time_batch(input, batch, checksum, cur));
        } else {
            c.push(time_batch(input, batch, checksum, cur));
            b.push(time_batch(base_input, batch, checksum, base));
        }
    }
    let (bs, cs) = (summarize(b), summarize(c));

    let base_alloc = base.alloc_stats(base_input);
    let cur_alloc = cur.alloc_stats(input);

    println!(
        "{label:<44} batch={batch:<5} base median={:>10} p95={:>10} | cur median={:>10} p95={:>10} | cur/base={:.3}",
        fmt_ns(bs.median),
        fmt_ns(bs.p95),
        fmt_ns(cs.median),
        fmt_ns(cs.p95),
        cs.median / bs.median,
    );
    println!(
        "{:<44} base {} | cur {}",
        "",
        fmt_alloc(base_alloc),
        fmt_alloc(cur_alloc),
    );
}

/// Times only the current implementation (rejections and preflight).
fn time_current(cfg: &Config, label: &str, input: &Value, cur: Imp<Value>, checksum: &mut u64) {
    let one = time_batch(input, 1, checksum, cur);
    let batch = batch_size(cfg, input, one);
    for _ in 0..cfg.warmup {
        time_batch(input, batch, checksum, cur);
    }
    let samples = (0..cfg.samples)
        .map(|_| time_batch(input, batch, checksum, cur))
        .collect();
    let s = summarize(samples);
    let alloc = cur.alloc_stats(input);
    println!(
        "{label:<44} batch={batch:<5} cur median={:>10} p95={:>10} | {}",
        fmt_ns(s.median),
        fmt_ns(s.p95),
        fmt_alloc(alloc)
    );
}

fn main() {
    let cfg = Config {
        samples: env_or("FLATTEN_BENCH_SAMPLES", 31) as usize,
        warmup: env_or("FLATTEN_BENCH_WARMUP", 5) as usize,
        sample_ns: env_or("FLATTEN_BENCH_SAMPLE_NS", 2_000_000),
    };
    println!(
        "baseline commit {} (flatten.rs blob {})",
        flatten_bench::BASELINE_COMMIT,
        flatten_bench::BASELINE_FLATTEN_BLOB
    );
    println!(
        "samples={} warmup={} sample_target={}ns debug_assertions={}",
        cfg.samples,
        cfg.warmup,
        cfg.sample_ns,
        cfg!(debug_assertions)
    );
    println!("loadavg at start: {}", loadavg());
    if cfg!(debug_assertions) {
        println!("WARNING: not a release build; numbers are meaningless");
    }

    let mut checksum = 0u64;
    let cases: Vec<Case> = accepted_cases();
    // The one safety check per fixture, before any baseline call and outside all timing
    let checked: Vec<BaselineInput> = cases
        .iter()
        .map(|case| BaselineInput::check(case.body.clone()))
        .collect();

    println!(
        "\n== convert_array_to_object (ingestion entry, V1 Json, includes no-op fast paths) =="
    );
    for (case, checked) in cases.iter().zip(&checked) {
        let partition = case.custom_partition.clone();
        let base_rows = baseline_convert_checked(checked.clone(), partition.as_ref()).unwrap();
        let cur_rows = current_convert(case.body.clone(), partition.as_ref(), DEFAULT).unwrap();
        assert_eq!(
            ordered(&base_rows),
            ordered(&cur_rows),
            "{} output differs",
            case.name
        );
        let rows: usize = cur_rows
            .iter()
            .map(|v| v.as_array().map_or(1, Vec::len))
            .sum();
        let p = partition.clone();
        let base = move |v: BaselineInput| {
            let out = baseline_convert_checked(v, p.as_ref()).unwrap();
            let n = out.len();
            drop(black_box(out));
            n
        };
        let p = partition.clone();
        let cur = move |v: Value| {
            let out = current_convert(v, p.as_ref(), DEFAULT).unwrap();
            let n = out.len();
            drop(black_box(out));
            n
        };
        compare(
            &cfg,
            &format!("{} ({} rows, outputs equal)", case.name, rows),
            checked,
            &case.body,
            Imp::Owned(&base),
            Imp::Owned(&cur),
            &mut checksum,
        );
    }

    println!(
        "\n== generic_flattening only (bounded vs unbounded expansion, no no-op fast path) =="
    );
    for (case, checked) in cases.iter().zip(&checked) {
        let base_rows = baseline_generic_checked(checked);
        let cur_rows = current_generic(&case.body, DEFAULT).unwrap();
        assert_eq!(
            ordered(&base_rows),
            ordered(&cur_rows),
            "{} output differs",
            case.name
        );
        let base = |v: &BaselineInput| {
            let out = baseline_generic_checked(v);
            let n = out.len();
            drop(black_box(out));
            n
        };
        let cur = |v: &Value| {
            let out = current_generic(v, DEFAULT).unwrap();
            let n = out.len();
            drop(black_box(out));
            n
        };
        compare(
            &cfg,
            &format!("{} ({} rows, outputs equal)", case.name, cur_rows.len()),
            checked,
            &case.body,
            Imp::Borrowed(&base),
            Imp::Borrowed(&cur),
            &mut checksum,
        );
    }

    println!(
        "\n== preflight only, current: charge_flatten_pipeline (generic + structural bytes) on a fresh budget, per event as the entry point charges =="
    );
    for case in &cases {
        let cost = |v: &Value| match current_pipeline_charge(v, DEFAULT) {
            Ok(c) => c.rows ^ c.bytes,
            Err(_) => 0,
        };
        time_current(
            &cfg,
            case.name,
            &case.body,
            Imp::Borrowed(&cost),
            &mut checksum,
        );
    }

    println!("\n== rejections, current only (baseline would expand these unbounded) ==");
    let rejections: Vec<(&str, Value)> = vec![
        ("hostile_cube_1000^3", fixtures::hostile_cube()),
        (
            "deep_product_nested_arrays",
            fixtures::deep_product_nested_arrays(),
        ),
        (
            "deep_product_nested_objects",
            fixtures::deep_product_nested_objects(),
        ),
        (
            "large_repeated_string (600 rows)",
            fixtures::large_repeated_string(),
        ),
        (
            "escaped_repeated_string (500 rows)",
            fixtures::escaped_repeated_string(),
        ),
        ("just_over_event_limit", fixtures::just_over_event_limit()),
    ];
    for (name, input) in &rejections {
        let reject = |v: Value| {
            let err = current_convert(v, None, DEFAULT).expect_err("must be rejected");
            drop(black_box(err));
            1
        };
        time_current(&cfg, name, input, Imp::Owned(&reject), &mut checksum);
    }

    println!("\nloadavg at end: {}", loadavg());
    println!("checksum {checksum}");
}
