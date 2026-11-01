//! The only place that names production signatures, so an API change is a one-file fix.
//! Baseline calls go through `baseline_json` (547c5118 source), current calls through
//! `current_json` (working tree source). Both use the ingestion configuration the HTTP
//! JSON path uses: schema V1, `LogSource::Json`, no time partition.

use serde_json::Value;

use crate::baseline_json as base;
use crate::current_json as cur;
use crate::event::format::LogSource;
use crate::fixtures::{BASELINE_MAX_ROWS, generic_row_upper_bound};
use crate::metadata::SchemaVersion;

pub use cur::flatten::{FlattenBudget, FlattenCost, FlattenLimits, JsonFlattenError, PipelineCost};

pub const UNLIMITED: FlattenLimits = FlattenLimits {
    max_rows_per_event: usize::MAX,
    max_rows_per_request: usize::MAX,
    max_bytes_per_request: usize::MAX,
};

fn assert_baseline_safe(body: &Value) {
    let bound = generic_row_upper_bound(body);
    assert!(
        bound <= BASELINE_MAX_ROWS,
        "refusing to run the unbounded baseline on an input of up to {bound} rows"
    );
}

/// An input checked once to expand to at most `BASELINE_MAX_ROWS` rows: the only form the
/// unbounded baseline accepts without walking it again. Clones keep the guarantee (same
/// value), so the benchmark checks each fixture once, outside any timed or counted region,
/// and the timed baseline calls do no extra work the current code does not do.
#[derive(Clone)]
pub struct BaselineInput(Value);

impl BaselineInput {
    /// Panics unless `body` is small enough for the unbounded baseline
    pub fn check(body: Value) -> Self {
        assert_baseline_safe(&body);
        Self(body)
    }

    pub fn value(&self) -> &Value {
        &self.0
    }
}

/// Baseline `convert_array_to_object`, the HTTP ingestion entry point, on a prevalidated input.
pub fn baseline_convert_checked(
    input: BaselineInput,
    custom_partition: Option<&String>,
) -> anyhow::Result<Vec<Value>> {
    base::convert_array_to_object(
        input.0,
        None,
        None,
        custom_partition,
        SchemaVersion::V1,
        &LogSource::Json,
    )
}

/// Baseline `generic_flattening` (unbounded) on a prevalidated input.
pub fn baseline_generic_checked(input: &BaselineInput) -> Vec<Value> {
    base::flatten::generic_flattening(&input.0).expect("baseline generic_flattening never errors")
}

/// Guarded convenience wrapper for tests: checks `body` on every call. Never time this.
pub fn baseline_convert(
    body: Value,
    custom_partition: Option<&String>,
) -> anyhow::Result<Vec<Value>> {
    baseline_convert_checked(BaselineInput::check(body), custom_partition)
}

/// Guarded convenience wrapper for tests: checks `value` on every call. Never time this.
pub fn baseline_generic(value: &Value) -> Vec<Value> {
    assert_baseline_safe(value);
    base::flatten::generic_flattening(value).expect("baseline generic_flattening never errors")
}

/// Current `convert_array_to_object` with a fresh per-request budget.
pub fn current_convert(
    body: Value,
    custom_partition: Option<&String>,
    limits: FlattenLimits,
) -> anyhow::Result<Vec<Value>> {
    let mut budget = FlattenBudget::new(limits);
    current_convert_with(body, custom_partition, &mut budget)
}

pub fn current_convert_with(
    body: Value,
    custom_partition: Option<&String>,
    budget: &mut FlattenBudget,
) -> anyhow::Result<Vec<Value>> {
    cur::convert_array_to_object(
        body,
        None,
        None,
        custom_partition,
        SchemaVersion::V1,
        &LogSource::Json,
        budget,
    )
}

pub fn current_generic(
    value: &Value,
    limits: FlattenLimits,
) -> Result<Vec<Value>, JsonFlattenError> {
    cur::flatten::generic_flattening_with_limits(value, limits)
}

/// Generic-only preflight (`charge_generic_flattening`): a fresh request budget charged per
/// event (each element of a top level array is its own event), nothing expanded. The entry
/// point charges [`current_pipeline_charge`] instead.
pub fn current_charge(
    value: &Value,
    limits: FlattenLimits,
) -> Result<FlattenCost, JsonFlattenError> {
    let mut budget = FlattenBudget::new(limits);
    cur::flatten::charge_generic_flattening(value, &mut budget)?;
    Ok(budget.used())
}

/// `generic_flattening_cost`, which takes `value` as ONE event even when it is an array;
/// the entry point instead charges batches per element, see [`current_charge`].
pub fn current_cost(
    value: &Value,
    limits: &FlattenLimits,
) -> Result<FlattenCost, JsonFlattenError> {
    cur::flatten::generic_flattening_cost(value, limits)
}

/// `flatten_pipeline_cost`: generic and structurally flattened bytes of `value` taken as ONE
/// event, like [`current_cost`].
pub fn current_pipeline_cost(
    value: &Value,
    limits: &FlattenLimits,
) -> Result<PipelineCost, JsonFlattenError> {
    cur::flatten::flatten_pipeline_cost(value, limits)
}

/// Preflight exactly as the entry point runs it (`charge_flatten_pipeline`): per event like
/// [`current_charge`], each charged the larger of its generic and structurally flattened bytes.
pub fn current_pipeline_charge(
    value: &Value,
    limits: FlattenLimits,
) -> Result<FlattenCost, JsonFlattenError> {
    let mut budget = FlattenBudget::new(limits);
    cur::flatten::charge_flatten_pipeline(value, &mut budget)?;
    Ok(budget.used())
}

/// Structural flattening the entry point applies to the generic rows: objects get their
/// nested fields joined with `_`, other rows stay as they are.
pub fn current_structural(rows: &[Value]) -> Vec<Value> {
    rows.iter()
        .map(|row| {
            let mut row = row.clone();
            if row.is_object() {
                cur::flatten::flatten(&mut row, "_", None, None, None, false)
                    .expect("generic rows have no arrays");
            }
            row
        })
        .collect()
}

/// Order-sensitive comparison key: serialization keeps map insertion order.
pub fn ordered(values: &[Value]) -> String {
    serde_json::to_string(values).unwrap()
}
