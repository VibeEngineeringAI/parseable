//! Deterministic inputs shared by the benchmark and the allocation tests.
//!
//! Accepted cases expand to at most 1000 rows, so they are safe to run through the
//! unbounded baseline; [`generic_row_upper_bound`] re-checks that before any baseline
//! call. Rejection cases must only ever be passed to the bounded current code.

use serde_json::{Map, Value, json};

/// Configured defaults under test.
pub const EVENT_ROW_LIMIT: u64 = 1000;
pub const REQUEST_ROW_LIMIT: u64 = 10_000;
pub const EXPANDED_BYTES_LIMIT: u64 = 67_108_864;

/// Hard cap for anything handed to the baseline.
pub const BASELINE_MAX_ROWS: u64 = 1000;

pub struct Case {
    pub name: &'static str,
    pub body: Value,
    /// Custom partition field, which routes through the per-element partitioned path
    pub custom_partition: Option<String>,
}

/// Saturating upper bound on the rows generic flattening can produce for `value`:
/// sibling arrays multiply, array elements add, and nesting multiplies through. Used only
/// as a guard against accidentally handing an enormous expansion to the baseline.
pub fn generic_row_upper_bound(value: &Value) -> u64 {
    match value {
        Value::Array(arr) if arr.is_empty() => 1,
        Value::Array(arr) => arr.iter().fold(0u64, |acc, item| {
            acc.saturating_add(generic_row_upper_bound(item))
        }),
        Value::Object(map) => map.values().fold(1u64, |acc, item| {
            acc.saturating_mul(generic_row_upper_bound(item))
        }),
        _ => 1,
    }
}

fn scalars(map: &mut Map<String, Value>, prefix: &str, n: usize, seed: usize) {
    for i in 0..n {
        let value = match (i + seed) % 5 {
            0 => json!(format!("value-{prefix}-{i}-{seed}")),
            1 => json!((i * 7919 + seed) as u64),
            2 => json!(((i + seed) as f64) * 1.25),
            3 => json!((i + seed) % 2 == 0),
            _ => Value::Null,
        };
        map.insert(format!("{prefix}field_{i}"), value);
    }
}

fn flat_object(fields: usize, seed: usize) -> Value {
    let mut map = Map::new();
    map.insert("timestamp".into(), json!("2026-10-26T12:00:00.000Z"));
    map.insert("tenant".into(), json!(format!("t{}", seed % 4)));
    scalars(&mut map, "", fields, seed);
    Value::Object(map)
}

fn nested_object(seed: usize) -> Value {
    let mut map = Map::new();
    map.insert("timestamp".into(), json!("2026-10-26T12:00:00.000Z"));
    scalars(&mut map, "", 4, seed);
    let mut l1 = Map::new();
    scalars(&mut l1, "l1_", 3, seed);
    let mut l2 = Map::new();
    scalars(&mut l2, "l2_", 3, seed);
    let mut l3 = Map::new();
    scalars(&mut l3, "l3_", 3, seed);
    l2.insert("deeper".into(), Value::Object(l3));
    l1.insert("inner".into(), Value::Object(l2));
    map.insert("outer".into(), Value::Object(l1));
    let mut side = Map::new();
    scalars(&mut side, "s_", 2, seed);
    map.insert("side".into(), Value::Object(side));
    Value::Object(map)
}

/// Inputs that every implementation must accept; each expands to <= 1000 rows.
pub fn accepted_cases() -> Vec<Case> {
    let mut cases = Vec::new();

    cases.push(Case {
        name: "flat_single",
        body: flat_object(20, 1),
        custom_partition: None,
    });

    cases.push(Case {
        name: "flat_batch_1000_noop",
        body: Value::Array((0..1000).map(|i| flat_object(12, i)).collect()),
        custom_partition: None,
    });

    cases.push(Case {
        name: "nested_no_arrays_200",
        body: Value::Array((0..200).map(nested_object).collect()),
        custom_partition: None,
    });

    let mut moderate = Map::new();
    scalars(&mut moderate, "", 8, 3);
    moderate.insert(
        "items".into(),
        Value::Array(
            (0..100)
                .map(|i| {
                    let mut item = Map::new();
                    scalars(&mut item, "item_", 5, i);
                    Value::Object(item)
                })
                .collect(),
        ),
    );
    cases.push(Case {
        name: "moderate_array_100",
        body: Value::Object(moderate),
        custom_partition: None,
    });

    let mut product = Map::new();
    scalars(&mut product, "", 6, 5);
    product.insert(
        "a".into(),
        Value::Array((0..10).map(|i| json!(i)).collect()),
    );
    product.insert(
        "b".into(),
        Value::Array(
            (0..10)
                .map(|i| json!({"x": i, "y": format!("y{i}")}))
                .collect(),
        ),
    );
    product.insert(
        "c".into(),
        Value::Array((0..10).map(|i| json!(format!("c{i}"))).collect()),
    );
    cases.push(Case {
        name: "product_10x10x10",
        body: Value::Object(product),
        custom_partition: None,
    });

    cases.push(Case {
        name: "partitioned_batch_50x4",
        body: Value::Array(
            (0..50)
                .map(|i| {
                    let mut obj = flat_object(6, i).as_object().unwrap().clone();
                    obj.insert(
                        "items".into(),
                        Value::Array((0..4).map(|j| json!({"k": j, "v": i * j})).collect()),
                    );
                    Value::Object(obj)
                })
                .collect(),
        ),
        custom_partition: Some("tenant".into()),
    });

    for case in &cases {
        assert!(
            generic_row_upper_bound(&case.body) <= BASELINE_MAX_ROWS,
            "{} exceeds the baseline row cap",
            case.name
        );
    }
    cases
}

fn ints(n: u64) -> Value {
    Value::Array((0..n).map(|i| json!(i)).collect())
}

/// `{"a": [0..1000], "b": [0..1000], "c": [0..1000]}`: 10^9 rows if expanded.
pub fn hostile_cube() -> Value {
    json!({"a": ints(1000), "b": ints(1000), "c": ints(1000)})
}

/// Rows multiply through nesting: 32 elements of `a`, each a 32x32 product, times a
/// sibling `d` of 32, about 1M rows from a ~2K-value input.
pub fn deep_product_nested_arrays() -> Value {
    let inner: Vec<Value> = (0..32)
        .map(|_| json!({"b": ints(32), "c": ints(32)}))
        .collect();
    json!({"a": inner, "d": ints(32)})
}

/// Arrays under nested objects multiply like siblings: 100^3 rows.
pub fn deep_product_nested_objects() -> Value {
    json!({"x": {"y": {"z": ints(100)}}, "w": {"v": ints(100)}, "u": ints(100)})
}

/// Legal row count (600) whose expanded compact JSON exceeds 64 MiB because a 128 KiB
/// string repeats on every row.
pub fn large_repeated_string() -> Value {
    json!({"blob": "x".repeat(128 * 1024), "id": ints(600)})
}

/// Legal row count (500) where the raw string is only ~34 MiB repeated, but escaping each
/// `"` doubles it to ~68 MiB of compact JSON, so only an escape-aware estimate rejects it.
pub fn escaped_repeated_string() -> Value {
    json!({"blob": "\"".repeat(70_000), "id": ints(500)})
}

/// One row over the per-event limit.
pub fn just_over_event_limit() -> Value {
    json!({"a": ints(EVENT_ROW_LIMIT + 1)})
}

/// Limits of the HTTP smoke test, small enough for [`long_parent`] to matter.
pub const SMALL_HTTP_LIMITS: (usize, usize, usize) = (4, 6, 4096);

/// `{parent: {"f0": 0, ..., "f31": 31}, "r": [0, 1, 2, 3]}`: 4 small generic rows, but
/// structural flattening names all 32 fields of each after `parent`. With a 128 character
/// parent the generic rows take ~1.6 KiB and the structurally flattened ones ~17 KiB.
pub fn long_parent(parent: &str) -> Value {
    let fields: Map<String, Value> = (0..32).map(|i| (format!("f{i}"), json!(i))).collect();
    let mut map = Map::new();
    map.insert(parent.to_owned(), Value::Object(fields));
    map.insert("r".to_owned(), ints(4));
    Value::Object(map)
}
