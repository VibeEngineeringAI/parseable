//! Allocation bounds for rejected expansions, and preflight/actual agreement for accepted
//! ones, against the working tree's `src/utils/json` sources.
//!
//! Inputs are built before counting starts; only allocations made by the test's own
//! thread while a guard is armed are counted. Run with RUST_LIB_BACKTRACE=0 so anyhow
//! does not capture (and allocate) a backtrace for the rejected requests.

use flatten_bench::alloc_counter::{AllocStats, CountingAlloc, measure};
use flatten_bench::api::{
    FlattenBudget, FlattenCost, FlattenLimits, JsonFlattenError, UNLIMITED, baseline_generic,
    current_charge, current_convert, current_convert_with, current_cost, current_generic,
    current_pipeline_charge, current_pipeline_cost, current_structural, ordered,
};
use flatten_bench::fixtures::{self, accepted_cases, generic_row_upper_bound};
use serde_json::{Value, json};

#[global_allocator]
static ALLOC: CountingAlloc = CountingAlloc;

const MAX_REJECT_BYTES: u64 = 64 * 1024;
const DEFAULT: FlattenLimits = FlattenLimits::DEFAULT;

fn report(label: &str, stats: AllocStats) {
    eprintln!(
        "{label}: allocs={} alloc_bytes={} peak_delta={} net_delta={}",
        stats.count, stats.total_bytes, stats.peak_bytes, stats.net_bytes
    );
}

fn assert_small(label: &str, stats: AllocStats) {
    report(label, stats);
    assert!(
        stats.total_bytes < MAX_REJECT_BYTES,
        "{label} allocated {} bytes while rejecting",
        stats.total_bytes
    );
}

/// The core (non-anyhow) rejection paths build nothing at all: not even the error.
fn assert_zero(label: &str, stats: AllocStats) {
    report(label, stats);
    assert_eq!(
        (stats.count, stats.total_bytes, stats.peak_bytes),
        (0, 0, 0),
        "{label} allocated while rejecting"
    );
}

fn limit_error(err: &anyhow::Error) -> &JsonFlattenError {
    let err = err
        .downcast_ref::<JsonFlattenError>()
        .unwrap_or_else(|| panic!("expected a JsonFlattenError, got {err:#}"));
    assert!(err.is_limit_exceeded(), "expected a limit error, got {err}");
    err
}

fn hostile_inputs() -> Vec<(&'static str, Value)> {
    vec![
        ("hostile_cube_1000^3", fixtures::hostile_cube()),
        (
            "deep_product_nested_arrays",
            fixtures::deep_product_nested_arrays(),
        ),
        (
            "deep_product_nested_objects",
            fixtures::deep_product_nested_objects(),
        ),
        ("large_repeated_string", fixtures::large_repeated_string()),
        (
            "escaped_repeated_string",
            fixtures::escaped_repeated_string(),
        ),
        ("just_over_event_limit", fixtures::just_over_event_limit()),
    ]
}

#[test]
fn preflight_rejects_without_allocating() {
    for (name, input) in hostile_inputs() {
        let (result, stats) = measure(|| current_cost(&input, &DEFAULT));
        assert!(
            matches!(&result, Err(err) if err.is_limit_exceeded()),
            "{name}: {result:?}"
        );
        assert_zero(&format!("preflight {name}"), stats);

        // Per-event charging on a fresh request budget, as the entry point does it
        let (result, stats) = measure(|| current_charge(&input, DEFAULT));
        assert!(
            matches!(&result, Err(err) if err.is_limit_exceeded()),
            "{name}: {result:?}"
        );
        assert_zero(&format!("charge {name}"), stats);

        let (result, stats) = measure(|| current_pipeline_charge(&input, DEFAULT));
        assert!(
            matches!(&result, Err(err) if err.is_limit_exceeded()),
            "{name}: {result:?}"
        );
        assert_zero(&format!("pipeline charge {name}"), stats);
    }
}

#[test]
fn bounded_generic_flattening_rejects_cheaply() {
    for (name, input) in hostile_inputs() {
        let mut budget = FlattenBudget::new(DEFAULT);
        let (result, stats) = measure(|| {
            let result =
                flatten_bench::current_json::flatten::generic_flattening(&input, &mut budget);
            result.map(|rows| rows.len())
        });
        assert!(
            matches!(&result, Err(err) if err.is_limit_exceeded()),
            "{name}: {result:?}"
        );
        assert_zero(&format!("generic_flattening {name}"), stats);
        assert_eq!(budget.used(), FlattenCost::default(), "{name}");
    }
}

#[test]
fn ingestion_entry_point_rejects_cheaply() {
    for (name, input) in hostile_inputs() {
        // The consumed input is freed inside the guard, which only lowers `net`
        let (result, stats) =
            measure(|| current_convert(input, None, DEFAULT).map(|rows| rows.len()));
        let err = result.expect_err(name);
        limit_error(&err);
        // `err` (an anyhow box, 112 bytes today) is allocated inside the guard, so
        // this entry point is held to the 64 KiB bound rather than to zero
        assert_small(&format!("convert_array_to_object {name}"), stats);
    }
}

#[test]
fn expected_error_kinds() {
    let kind = |value: &Value| match current_cost(value, &DEFAULT) {
        Err(JsonFlattenError::RowsPerEventLimitExceeded(_)) => "rows/event",
        Err(JsonFlattenError::BytesPerRequestLimitExceeded(_)) => "bytes/request",
        other => panic!("unexpected {other:?}"),
    };
    assert_eq!(kind(&fixtures::hostile_cube()), "rows/event");
    assert_eq!(kind(&fixtures::deep_product_nested_arrays()), "rows/event");
    assert_eq!(kind(&fixtures::deep_product_nested_objects()), "rows/event");
    assert_eq!(kind(&fixtures::just_over_event_limit()), "rows/event");
    // 600 and 500 rows are legal; only the byte estimate (with escapes) rejects these
    assert_eq!(kind(&fixtures::large_repeated_string()), "bytes/request");
    assert_eq!(kind(&fixtures::escaped_repeated_string()), "bytes/request");
}

#[test]
fn insufficient_remaining_request_budget() {
    let product = accepted_cases()
        .into_iter()
        .find(|case| case.name == "product_10x10x10")
        .unwrap()
        .body;

    // 9_995 rows already used by earlier events of the same request
    let mut budget = FlattenBudget::new(DEFAULT);
    for _ in 0..9 {
        budget
            .charge_event(FlattenCost {
                rows: 1000,
                bytes: 0,
            })
            .unwrap();
    }
    budget
        .charge_event(FlattenCost {
            rows: 995,
            bytes: 0,
        })
        .unwrap();
    let (result, stats) = measure(|| {
        flatten_bench::current_json::flatten::charge_generic_flattening(&product, &mut budget)
    });
    assert!(
        matches!(
            result,
            Err(JsonFlattenError::RowsPerRequestLimitExceeded(_))
        ),
        "{result:?}"
    );
    assert_zero("core charge, remaining rows insufficient", stats);
    let (result, stats) =
        measure(|| current_convert_with(product, None, &mut budget).map(|r| r.len()));
    let err = result.expect_err("1000 rows cannot fit in the remaining 5");
    assert!(
        matches!(
            limit_error(&err),
            JsonFlattenError::RowsPerRequestLimitExceeded(_)
        ),
        "{err:#}"
    );
    assert_small("remaining rows insufficient", stats);
    assert_eq!(budget.used().rows, 9_995, "a failed charge must not commit");

    // Bytes nearly exhausted by earlier events
    let mut budget = FlattenBudget::new(DEFAULT);
    let filler = DEFAULT.max_bytes_per_request - 16;
    budget
        .charge_event(FlattenCost {
            rows: 1,
            bytes: filler,
        })
        .unwrap();
    let small = json!({"message": "this row is longer than sixteen bytes"});
    let (result, stats) = measure(|| {
        flatten_bench::current_json::flatten::charge_generic_flattening(&small, &mut budget)
    });
    assert!(
        matches!(
            result,
            Err(JsonFlattenError::BytesPerRequestLimitExceeded(_))
        ),
        "{result:?}"
    );
    assert_zero("core charge, remaining bytes insufficient", stats);
    let (result, stats) =
        measure(|| current_convert_with(small, None, &mut budget).map(|r| r.len()));
    let err = result.expect_err("row does not fit in the remaining 16 bytes");
    assert!(
        matches!(
            limit_error(&err),
            JsonFlattenError::BytesPerRequestLimitExceeded(_)
        ),
        "{err:#}"
    );
    assert_small("remaining bytes insufficient", stats);
    assert_eq!(budget.used().bytes, filler);
}

#[test]
fn request_budget_is_shared_across_partitions() {
    // 11 partitioned elements of 1000 rows each: every event is legal, the request is not
    let body = Value::Array(
        (0..11)
            .map(|i| json!({"tenant": format!("t{i}"), "a": (0..1000).collect::<Vec<u32>>()}))
            .collect(),
    );
    let partition = "tenant".to_owned();
    let (result, stats) =
        measure(|| current_convert(body, Some(&partition), DEFAULT).map(|r| r.len()));
    let err = result.expect_err("11_000 rows exceed the 10_000 request limit");
    assert!(
        matches!(
            limit_error(&err),
            JsonFlattenError::RowsPerRequestLimitExceeded(_)
        ),
        "{err:#}"
    );
    // Not asserted: earlier partitions may be materialized before the 11th is charged
    report("partitioned request over limit", stats);
}

/// Small deterministic generator of mixed shapes, bounded far below 1000 rows.
fn generated(seed: u64, count: usize) -> Vec<Value> {
    let mut state = seed | 1;
    let mut next = move |n: u64| {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        state % n
    };
    fn build(next: &mut dyn FnMut(u64) -> u64, depth: u32) -> Value {
        const KEYS: &[&str] = &["a", "b", "a_b", "c", "", "q\"\\\n", "ü"];
        let roll = next(10);
        if depth == 0 || roll < 4 {
            return match next(8) {
                0 => Value::Null,
                1 => json!(true),
                2 => json!(-3),
                3 => json!(1.5e300),
                4 => json!(""),
                5 => json!("esc\"\\\u{1}\t ünï"),
                6 => json!(u64::MAX),
                _ => json!(i64::MIN),
            };
        }
        if roll < 7 {
            let mut map = serde_json::Map::new();
            for _ in 0..next(4) {
                let key = KEYS[next(KEYS.len() as u64) as usize];
                map.insert(key.to_owned(), build(&mut *next, depth - 1));
            }
            Value::Object(map)
        } else {
            let len = next(4);
            let mut arr = Vec::new();
            for _ in 0..len {
                arr.push(build(&mut *next, depth - 1));
            }
            Value::Array(arr)
        }
    }
    (0..count).map(|_| build(&mut next, 5)).collect()
}

#[test]
fn preflight_matches_actual_output() {
    let mut inputs: Vec<Value> = accepted_cases().into_iter().map(|case| case.body).collect();
    inputs.extend(generated(0x5eed, 2000));
    inputs.push(json!([[{"a": 1}], {"b": [1, 2]}, [], 3]));
    let mut checked = 0;
    for input in inputs {
        if generic_row_upper_bound(&input) > 1000 {
            continue;
        }
        let actual = current_generic(&input, UNLIMITED).expect("unlimited");
        let cost = current_cost(&input, &UNLIMITED).expect("unlimited");
        let bytes: usize = actual
            .iter()
            .map(|row| serde_json::to_vec(row).unwrap().len())
            .sum();
        assert_eq!(
            (cost.rows, cost.bytes),
            (actual.len(), bytes),
            "cost mismatch for {input}"
        );
        // The pipeline cost has the same generic part, and covers the structurally
        // flattened rows: exactly, unless joined field names collide
        let pipeline = current_pipeline_cost(&input, &UNLIMITED).expect("unlimited");
        assert_eq!(
            (pipeline.rows, pipeline.generic_bytes),
            (cost.rows, cost.bytes)
        );
        let structural = current_structural(&actual);
        let structural_bytes: usize = structural
            .iter()
            .map(|row| serde_json::to_vec(row).unwrap().len())
            .sum();
        let structural_fields: usize = structural
            .iter()
            .filter_map(Value::as_object)
            .map(|row| row.len())
            .sum();
        if structural_fields == pipeline.structural_fields {
            assert_eq!(pipeline.structural_bytes, structural_bytes, "{input}");
        } else {
            assert!(pipeline.structural_bytes > structural_bytes, "{input}");
        }
        assert!(pipeline.charged().bytes >= bytes.max(structural_bytes));
        // Bounded output is identical to the baseline 547c5118 output
        assert_eq!(
            ordered(&actual),
            ordered(&baseline_generic(&input)),
            "{input}"
        );
        checked += 1;
    }
    eprintln!("checked {checked} inputs");
    assert!(checked > 1000);
}

#[test]
fn accepted_cases_match_baseline_at_entry_point() {
    for case in accepted_cases() {
        let partition = case.custom_partition.as_ref();
        let base = flatten_bench::api::baseline_convert(case.body.clone(), partition).unwrap();
        let cur = current_convert(case.body, partition, DEFAULT).unwrap();
        assert_eq!(ordered(&base), ordered(&cur), "{}", case.name);
    }
}

#[test]
fn counter_sees_allocations() {
    let (len, stats) = measure(|| vec![0u8; 100_000].len());
    assert_eq!(len, 100_000);
    assert!(
        stats.total_bytes >= 100_000 && stats.peak_bytes >= 100_000,
        "{stats:?}"
    );
}

/// The harness stubs `crate::cli`; make sure its defaults are the server's, and the
/// approved ones.
#[test]
fn stub_defaults_match_server() {
    let cli = include_str!("../../../src/cli.rs");
    for line in [
        "pub const DEFAULT_MAX_FLATTEN_ROWS_PER_EVENT: usize = 1000;",
        "pub const DEFAULT_MAX_FLATTEN_ROWS_PER_REQUEST: usize = 10_000;",
        "pub const DEFAULT_MAX_FLATTEN_BYTES_PER_REQUEST: usize = 64 * 1024 * 1024;",
    ] {
        assert!(cli.contains(line), "src/cli.rs no longer has `{line}`");
    }
    assert_eq!(
        FlattenLimits::DEFAULT,
        FlattenLimits {
            max_rows_per_event: fixtures::EVENT_ROW_LIMIT as usize,
            max_rows_per_request: fixtures::REQUEST_ROW_LIMIT as usize,
            max_bytes_per_request: fixtures::EXPANDED_BYTES_LIMIT as usize,
        }
    );
}

#[test]
#[should_panic(expected = "refusing to run the unbounded baseline")]
fn baseline_input_check_refuses_hostile_input() {
    // Only walks the input to bound its rows; nothing reaches the baseline
    flatten_bench::api::BaselineInput::check(flatten_bench::fixtures::hostile_cube());
}

#[test]
fn baseline_input_check_accepts_every_benchmark_case() {
    for case in flatten_bench::fixtures::accepted_cases() {
        let checked = flatten_bench::api::BaselineInput::check(case.body.clone());
        assert!(checked.value() == &case.body, "{}", case.name);
    }
}

fn small_limits() -> FlattenLimits {
    let (rows_per_event, rows_per_request, bytes) = fixtures::SMALL_HTTP_LIMITS;
    FlattenLimits {
        max_rows_per_event: rows_per_event,
        max_rows_per_request: rows_per_request,
        max_bytes_per_request: bytes,
    }
}

#[test]
fn structural_field_names_are_rejected_without_expanding() {
    let small = small_limits();
    let input = fixtures::long_parent(&"p".repeat(128));
    // The generic rows alone fit
    assert!(current_cost(&input, &small).is_ok());

    let (result, stats) = measure(|| current_pipeline_cost(&input, &small));
    assert!(
        matches!(
            result,
            Err(JsonFlattenError::BytesPerRequestLimitExceeded(4096))
        ),
        "{result:?}"
    );
    assert_zero("structural preflight, long parent", stats);
    let (result, stats) = measure(|| current_pipeline_charge(&input, small));
    assert!(
        matches!(
            result,
            Err(JsonFlattenError::BytesPerRequestLimitExceeded(4096))
        ),
        "{result:?}"
    );
    assert_zero("structural charge, long parent", stats);

    for partition in [None, Some("r".to_owned())] {
        let input = input.clone();
        let mut budget = FlattenBudget::new(small);
        let (result, stats) = measure(|| {
            current_convert_with(input, partition.as_ref(), &mut budget).map(|rows| rows.len())
        });
        let err = result.expect_err("long parent names exceed 4096 bytes");
        assert!(
            matches!(
                limit_error(&err),
                JsonFlattenError::BytesPerRequestLimitExceeded(4096)
            ),
            "{err:#}"
        );
        // No row was expanded: the structural rows alone would take ~17 KiB
        assert_small(
            &format!("convert_array_to_object long parent, partition {partition:?}"),
            stats,
        );
        assert!(stats.total_bytes < 1024, "{stats:?}");
        assert_eq!(budget.used(), FlattenCost::default());
    }

    // A short parent is accepted, as by the baseline
    let short = fixtures::long_parent("p");
    let cur = current_convert(short.clone(), None, small).unwrap();
    let base = flatten_bench::api::baseline_convert(short, None).unwrap();
    assert_eq!(ordered(&cur), ordered(&base));
}
