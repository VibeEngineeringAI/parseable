/*
 * Parseable Server (C) 2022 - 2025 Parseable, Inc.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 */

use std::collections::BTreeMap;
use std::num::NonZeroU32;
use std::sync::Mutex;

use chrono::{DateTime, Duration, Utc};
use serde_json::map::Map;
use serde_json::value::Value;

use thiserror::Error;

use crate::parseable::PARSEABLE;

// Global variable to track the first timestamp encountered during validation
static REFERENCE_TIMESTAMP: Mutex<Option<DateTime<Utc>>> = Mutex::new(None);

#[derive(Error, Debug)]
pub enum JsonFlattenError {
    #[error("Cannot flatten this JSON")]
    CannotFlatten,
    #[error("Ingestion failed as field {0} is not part of the log")]
    FieldNotPartOfLog(String),
    #[error("Ingestion failed as field {0} is empty or 'null'")]
    FieldEmptyOrNull(String),
    #[error("Ingestion failed as field {0} is an object")]
    FieldIsObject(String),
    #[error("Ingestion failed as field {0} is an array")]
    FieldIsArray(String),
    #[error("Ingestion failed as field {0} contains a period in the value")]
    FieldContainsPeriod(String),
    #[error("Ingestion failed as field {0} is not a string")]
    FieldNotString(String),
    #[error("Field {0} is not in the correct datetime format")]
    InvalidDatetimeFormat(String),
    #[error("Field {0} value '{2}' is more than {1} days old")]
    TimestampTooOld(String, i64, DateTime<Utc>),
    #[error(
        "Field {0} timestamp '{2}' is more than {1} hours older than reference timestamp '{3}'"
    )]
    TimestampTooOldRelative(String, i64, DateTime<Utc>, DateTime<Utc>),
    #[error("Expected object in array of objects")]
    ExpectedObjectInArray,
    #[error("Found non-object element while flattening array of objects")]
    NonObjectInArray,
}

// Recursively flattens JSON objects and arrays, e.g. with the separator `.`, starting from the TOP
// `{"key": "value", "nested_key": {"key":"value"}}` becomes `{"key": "value", "nested_key.key": "value"}`
#[cfg_attr(feature = "hotpath", hotpath::measure)]
pub fn flatten(
    nested_value: &mut Value,
    separator: &str,
    time_partition: Option<&String>,
    time_partition_limit: Option<NonZeroU32>,
    custom_partition: Option<&String>,
    validation_required: bool,
) -> Result<(), JsonFlattenError> {
    match nested_value {
        Value::Object(nested_dict) => {
            if validation_required {
                validate_time_partition(nested_dict, time_partition, time_partition_limit)?;
                validate_custom_partition(nested_dict, custom_partition)?;
            }
            // Rebuilding a map without nested objects or arrays of objects re-inserts every
            // key unchanged and in the same order, so skip it.
            if !object_needs_flattening(nested_dict) {
                return Ok(());
            }
            let original = std::mem::take(nested_dict);
            let mut map = Map::with_capacity(original.len());
            flatten_object(&mut map, None, original, separator)?;
            *nested_dict = map;
        }
        Value::Array(arr) => {
            for nested_value in arr {
                // Recursively flatten each element, ONLY in the TOP array
                flatten(
                    nested_value,
                    separator,
                    time_partition,
                    time_partition_limit,
                    custom_partition,
                    validation_required,
                )?;
            }
        }
        _ => return Err(JsonFlattenError::CannotFlatten),
    }

    Ok(())
}

// Validates the presence and content of custom partition fields, that it is
// not null, empty, an object , an array, or contain a `.` when serialized
pub fn validate_custom_partition(
    value: &Map<String, Value>,
    custom_partition: Option<&String>,
) -> Result<(), JsonFlattenError> {
    let Some(custom_partition) = custom_partition else {
        return Ok(());
    };
    let custom_partition_list = custom_partition.split(',').collect::<Vec<&str>>();

    for field in custom_partition_list {
        let trimmed_field = field.trim();
        let Some(field_value) = value.get(trimmed_field) else {
            return Err(JsonFlattenError::FieldNotPartOfLog(
                trimmed_field.to_owned(),
            ));
        };

        // The field should not be null, empty, an object, an array or contain a `.` in the value
        match field_value {
            Value::Null => {
                return Err(JsonFlattenError::FieldEmptyOrNull(trimmed_field.to_owned()));
            }
            Value::String(s) if s.is_empty() => {
                return Err(JsonFlattenError::FieldEmptyOrNull(trimmed_field.to_owned()));
            }
            Value::Object(_) => {
                return Err(JsonFlattenError::FieldIsObject(trimmed_field.to_owned()));
            }
            Value::Array(_) => {
                return Err(JsonFlattenError::FieldIsArray(trimmed_field.to_owned()));
            }
            Value::String(s) if s.contains('.') => {
                return Err(JsonFlattenError::FieldContainsPeriod(
                    trimmed_field.to_owned(),
                ));
            }
            Value::Number(n) if n.is_f64() => {
                return Err(JsonFlattenError::FieldContainsPeriod(
                    trimmed_field.to_owned(),
                ));
            }
            _ => {}
        }
    }

    Ok(())
}

// Validates time partitioning constraints, checking if a timestamp is a string
// that can be parsed as datetime within the configured time limit
pub fn validate_time_partition(
    value: &Map<String, Value>,
    time_partition: Option<&String>,
    time_partition_limit: Option<NonZeroU32>,
) -> Result<(), JsonFlattenError> {
    let Some(partition_key) = time_partition else {
        return Ok(());
    };

    let limit_days = time_partition_limit.map_or(30, |days| days.get() as i64);

    let Some(timestamp_value) = value.get(partition_key) else {
        return Err(JsonFlattenError::FieldNotPartOfLog(
            partition_key.to_owned(),
        ));
    };

    let Value::String(timestamp_str) = timestamp_value else {
        return Err(JsonFlattenError::FieldNotString(partition_key.to_owned()));
    };
    let Ok(parsed_timestamp) = timestamp_str.parse::<DateTime<Utc>>() else {
        return Err(JsonFlattenError::InvalidDatetimeFormat(
            partition_key.to_owned(),
        ));
    };

    // Access the global reference timestamp and handle poisoning
    let mut reference_timestamp = REFERENCE_TIMESTAMP
        .lock()
        .unwrap_or_else(|p| p.into_inner());

    match *reference_timestamp {
        None => {
            // First timestamp encountered - validate against cutoff date
            let cutoff_ts = Utc::now() - Duration::days(limit_days);
            if parsed_timestamp >= cutoff_ts {
                // Set the reference timestamp
                *reference_timestamp = Some(parsed_timestamp);
                Ok(())
            } else {
                Err(JsonFlattenError::TimestampTooOld(
                    partition_key.to_owned(),
                    limit_days,
                    parsed_timestamp,
                ))
            }
        }
        Some(ref_timestamp) => {
            // Subsequent timestamps - validate they're not more than configured hours older than reference
            let max_age_hours = PARSEABLE.options.event_max_chunk_age as i64;
            let max_age_before_ref = ref_timestamp - Duration::hours(max_age_hours);
            if parsed_timestamp >= max_age_before_ref {
                Ok(())
            } else {
                Err(JsonFlattenError::TimestampTooOldRelative(
                    partition_key.to_owned(),
                    max_age_hours,
                    parsed_timestamp,
                    ref_timestamp,
                ))
            }
        }
    }
}

// Returns true when `flatten_object` would change the map, i.e. it has a nested object
// (including an empty one, which is dropped) or an array containing an object
fn object_needs_flattening(map: &Map<String, Value>) -> bool {
    map.values().any(|value| match value {
        Value::Object(_) => true,
        Value::Array(arr) => arr.iter().any(Value::is_object),
        _ => false,
    })
}

// Flattens a nested JSON Object/Map into another target Map
fn flatten_object(
    output_map: &mut Map<String, Value>,
    parent_key: Option<&str>,
    nested_map: Map<String, Value>,
    separator: &str,
) -> Result<(), JsonFlattenError> {
    for (key, mut value) in nested_map {
        let new_key = match parent_key {
            Some(parent) => format!("{parent}{separator}{key}"),
            None => key,
        };

        match &mut value {
            Value::Object(obj) => {
                let obj = std::mem::take(obj);
                flatten_object(output_map, Some(&new_key), obj, separator)?;
            }
            Value::Array(arr) if arr.iter().any(Value::is_object) => {
                flatten_array_objects(output_map, &new_key, arr, separator)?;
            }
            _ => {
                output_map.insert(new_key, value);
            }
        }
    }
    Ok(())
}

// Flattens a nested JSON Array into the parent Map
pub fn flatten_array_objects(
    output_map: &mut Map<String, Value>,
    parent_key: &str,
    arr: &mut [Value],
    separator: &str,
) -> Result<(), JsonFlattenError> {
    let mut columns: BTreeMap<String, Vec<Value>> = BTreeMap::new();

    for (index, value) in arr.iter_mut().enumerate() {
        match value {
            Value::Object(nested_object) => {
                let mut output_map = Map::new();
                let nested_object = std::mem::take(nested_object);
                flatten_object(&mut output_map, Some(parent_key), nested_object, separator)?;
                for (key, value) in output_map {
                    let column = columns
                        .entry(key)
                        .or_insert_with(|| vec![Value::Null; index]);
                    column.push(value);
                }
            }
            Value::Null => {
                for column in columns.values_mut() {
                    column.push(Value::Null);
                }
            }
            _ => return Err(JsonFlattenError::NonObjectInArray),
        }

        // Ensure all columns are extended with null values if they weren't updated in this iteration
        let max_len = index + 1;
        for column in columns.values_mut() {
            while column.len() < max_len {
                column.push(Value::Null);
            }
        }
    }

    // Update the main map with new keys and their corresponding arrays
    for (key, values) in columns {
        output_map.insert(key, Value::Array(values));
    }

    Ok(())
}

/// Recursively flattens a JSON value.
/// - If the value is an array, it flattens all elements of the array.
/// - If the value is an object, it flattens all nested objects and arrays.
/// - If the JSON value is heavily nested (with more than 4 levels of hierarchy), returns error
/// - Otherwise, it returns the value itself in a vector.
///
/// Examples:
/// 1. `{"a": 1}` ~> `[{"a": 1}]`
/// 2. `[{"a": 1}, {"b": 2}]` ~> `[{"a": 1}, {"b": 2}]`
/// 3. `[{"a": [{"b": 1}, {"c": 2}]}]` ~> `[{"a": {"b": 1)}}, {"a": {"c": 2)}}]`
/// 4. `{"a": [{"b": 1}, {"c": 2}], "d": {"e": 4}}` ~> `[{"a": {"b":1}, "d": {"e":4}}, {"a": {"c":2}, "d": {"e":4}}]`
/// 5. `{"a":{"b":{"c":{"d":{"e":["a","b"]}}}}}` ~> returns error - heavily nested, cannot flatten this JSON
pub fn generic_flattening(value: &Value) -> Result<Vec<Value>, JsonFlattenError> {
    generic_flattening_inner(value, false)
}

fn generic_flattening_inner(
    value: &Value,
    normalize_empty_array: bool,
) -> Result<Vec<Value>, JsonFlattenError> {
    match value {
        // Without arrays the fold below rebuilds an exact copy of the object
        Value::Object(map) if !map_contains_array(map) => Ok(vec![value.clone()]),
        Value::Array(arr) if arr.is_empty() && normalize_empty_array => Ok(vec![Value::Null]),
        Value::Array(arr) => Ok(arr
            .iter()
            .flat_map(|flatten_item| {
                generic_flattening_inner(flatten_item, normalize_empty_array).unwrap_or_default()
            })
            .collect()),
        Value::Object(map) => {
            let results = map
                .iter()
                .fold(vec![Map::new()], |results, (key, val)| match val {
                    Value::Array(arr) => {
                        if arr.is_empty() {
                            // Generic flattening expands non-empty arrays into scalar rows.
                            // Keep empty arrays consistent with that representation: they
                            // contain no concrete value and must not create `List(Null)`
                            // schema fields.
                            results
                                .into_iter()
                                .map(|mut result| {
                                    result.insert(key.clone(), Value::Null);
                                    result
                                })
                                .collect()
                        } else {
                            arr.iter()
                                .flat_map(|flatten_item| {
                                    generic_flattening_inner(flatten_item, true).unwrap_or_default()
                                })
                                .flat_map(|flattened_item| {
                                    results.iter().map(move |result| {
                                        let mut new_obj = result.clone();
                                        new_obj.insert(key.clone(), flattened_item.clone());
                                        new_obj
                                    })
                                })
                                .collect()
                        }
                    }
                    Value::Object(_) => generic_flattening(val)
                        .unwrap_or_default()
                        .iter()
                        .flat_map(|nested_result| {
                            results.iter().map(move |result| {
                                let mut new_obj = result.clone();
                                new_obj.insert(key.clone(), nested_result.clone());
                                new_obj
                            })
                        })
                        .collect(),
                    _ => results
                        .into_iter()
                        .map(|mut result| {
                            result.insert(key.clone(), val.clone());
                            result
                        })
                        .collect(),
                });

            Ok(results.into_iter().map(Value::Object).collect())
        }
        _ => Ok(vec![value.clone()]),
    }
}

// Returns true if any value nested anywhere below this map is an array
pub(crate) fn map_contains_array(map: &Map<String, Value>) -> bool {
    map.values().any(|value| match value {
        Value::Array(_) => true,
        Value::Object(nested) => map_contains_array(nested),
        _ => false,
    })
}

/// Returns `Ok` with the result of `convert_to_array(generic_flattening(&value)?)` when
/// generic flattening would leave every record unchanged, consuming `value` instead of
/// cloning it. That holds for an object, or an array of objects, with no arrays nested
/// anywhere inside. Returns `Err` with `value` untouched for every other shape, which
/// must take the generic path (arrays expand into rows, nested top-level arrays are
/// spliced, empty arrays become null and non-objects are errors).
pub fn generic_flattening_noop(value: Value) -> Result<Value, Value> {
    match value {
        Value::Object(map) if !map_contains_array(&map) => {
            Ok(Value::Array(vec![Value::Object(map)]))
        }
        Value::Array(arr)
            if arr.iter().all(|item| match item {
                Value::Object(map) => !map_contains_array(map),
                _ => false,
            }) =>
        {
            Ok(Value::Array(arr))
        }
        other => Err(other),
    }
}

/// recursively checks the level of nesting for the serde Value
/// if Value has more than configured `P_MAX_FLATTEN_LEVEL` levels of hierarchy, returns true
/// example - if `P_MAX_FLATTEN_LEVEL` is 4, and the JSON is
/// 1. `{"a":{"b":{"c":{"d":{"e":["a","b"]}}}}}` ~> returns true
/// 2. `{"a": [{"b": 1}, {"c": 2}], "d": {"e": 4}}` ~> returns false
pub fn has_more_than_max_allowed_levels(value: &Value, current_level: usize) -> bool {
    if current_level > PARSEABLE.options.event_flatten_level {
        return true;
    }
    match value {
        Value::Array(arr) => arr
            .iter()
            .any(|item| has_more_than_max_allowed_levels(item, current_level)),
        Value::Object(map) => map
            .values()
            .any(|val| has_more_than_max_allowed_levels(val, current_level + 1)),
        _ => false,
    }
}

// Converts a Vector of values into a `Value::Array`, as long as all of them are objects
pub fn convert_to_array(flattened: Vec<Value>) -> Result<Value, JsonFlattenError> {
    if flattened.iter().any(|item| !item.is_object()) {
        return Err(JsonFlattenError::ExpectedObjectInArray);
    }

    Ok(Value::Array(flattened))
}

/// Verbatim copies of the flattening functions before the no-op fast paths, kept as a
/// differential oracle for tests.
#[cfg(test)]
pub(crate) mod legacy {
    use std::collections::BTreeMap;

    use serde_json::{Map, Value};

    use super::{JsonFlattenError, validate_custom_partition};

    // Time partition validation depends on global state, so the oracle only covers custom
    // partitions; the fast path runs after both validations and does not change them.
    pub fn flatten(
        nested_value: &mut Value,
        separator: &str,
        custom_partition: Option<&String>,
        validation_required: bool,
    ) -> Result<(), JsonFlattenError> {
        match nested_value {
            Value::Object(nested_dict) => {
                if validation_required {
                    validate_custom_partition(nested_dict, custom_partition)?;
                }
                let original = std::mem::take(nested_dict);
                let mut map = Map::with_capacity(original.len());
                flatten_object(&mut map, None, original, separator)?;
                *nested_dict = map;
            }
            Value::Array(arr) => {
                for nested_value in arr {
                    flatten(
                        nested_value,
                        separator,
                        custom_partition,
                        validation_required,
                    )?;
                }
            }
            _ => return Err(JsonFlattenError::CannotFlatten),
        }

        Ok(())
    }

    fn flatten_object(
        output_map: &mut Map<String, Value>,
        parent_key: Option<&str>,
        nested_map: Map<String, Value>,
        separator: &str,
    ) -> Result<(), JsonFlattenError> {
        for (key, mut value) in nested_map {
            let new_key = match parent_key {
                Some(parent) => format!("{parent}{separator}{key}"),
                None => key,
            };

            match &mut value {
                Value::Object(obj) => {
                    let obj = std::mem::take(obj);
                    flatten_object(output_map, Some(&new_key), obj, separator)?;
                }
                Value::Array(arr) if arr.iter().any(Value::is_object) => {
                    flatten_array_objects(output_map, &new_key, arr, separator)?;
                }
                _ => {
                    output_map.insert(new_key, value);
                }
            }
        }
        Ok(())
    }

    fn flatten_array_objects(
        output_map: &mut Map<String, Value>,
        parent_key: &str,
        arr: &mut [Value],
        separator: &str,
    ) -> Result<(), JsonFlattenError> {
        let mut columns: BTreeMap<String, Vec<Value>> = BTreeMap::new();

        for (index, value) in arr.iter_mut().enumerate() {
            match value {
                Value::Object(nested_object) => {
                    let mut output_map = Map::new();
                    let nested_object = std::mem::take(nested_object);
                    flatten_object(&mut output_map, Some(parent_key), nested_object, separator)?;
                    for (key, value) in output_map {
                        let column = columns
                            .entry(key)
                            .or_insert_with(|| vec![Value::Null; index]);
                        column.push(value);
                    }
                }
                Value::Null => {
                    for column in columns.values_mut() {
                        column.push(Value::Null);
                    }
                }
                _ => return Err(JsonFlattenError::NonObjectInArray),
            }

            let max_len = index + 1;
            for column in columns.values_mut() {
                while column.len() < max_len {
                    column.push(Value::Null);
                }
            }
        }

        for (key, values) in columns {
            output_map.insert(key, Value::Array(values));
        }

        Ok(())
    }

    pub fn generic_flattening(value: &Value) -> Result<Vec<Value>, JsonFlattenError> {
        generic_flattening_inner(value, false)
    }

    fn generic_flattening_inner(
        value: &Value,
        normalize_empty_array: bool,
    ) -> Result<Vec<Value>, JsonFlattenError> {
        match value {
            Value::Array(arr) if arr.is_empty() && normalize_empty_array => Ok(vec![Value::Null]),
            Value::Array(arr) => Ok(arr
                .iter()
                .flat_map(|flatten_item| {
                    generic_flattening_inner(flatten_item, normalize_empty_array)
                        .unwrap_or_default()
                })
                .collect()),
            Value::Object(map) => {
                let results = map
                    .iter()
                    .fold(vec![Map::new()], |results, (key, val)| match val {
                        Value::Array(arr) => {
                            if arr.is_empty() {
                                results
                                    .into_iter()
                                    .map(|mut result| {
                                        result.insert(key.clone(), Value::Null);
                                        result
                                    })
                                    .collect()
                            } else {
                                arr.iter()
                                    .flat_map(|flatten_item| {
                                        generic_flattening_inner(flatten_item, true)
                                            .unwrap_or_default()
                                    })
                                    .flat_map(|flattened_item| {
                                        results.iter().map(move |result| {
                                            let mut new_obj = result.clone();
                                            new_obj.insert(key.clone(), flattened_item.clone());
                                            new_obj
                                        })
                                    })
                                    .collect()
                            }
                        }
                        Value::Object(_) => generic_flattening(val)
                            .unwrap_or_default()
                            .iter()
                            .flat_map(|nested_result| {
                                results.iter().map(move |result| {
                                    let mut new_obj = result.clone();
                                    new_obj.insert(key.clone(), nested_result.clone());
                                    new_obj
                                })
                            })
                            .collect(),
                        _ => results
                            .into_iter()
                            .map(|mut result| {
                                result.insert(key.clone(), val.clone());
                                result
                            })
                            .collect(),
                    });

                Ok(results.into_iter().map(Value::Object).collect())
            }
            _ => Ok(vec![value.clone()]),
        }
    }
}

/// Deterministic generator of varied JSON shapes for differential tests.
#[cfg(test)]
pub(crate) mod shapes {
    use serde_json::{Map, Value, json};

    pub struct Gen(u64);

    // Keys chosen so that nested keys collide after flattening with `_`
    const KEYS: &[&str] = &["a", "b", "a_b", "b_a", "a_b_a", "c", "", "_", "a.b"];

    impl Gen {
        pub fn new(seed: u64) -> Self {
            Self(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1)
        }

        pub fn next(&mut self, n: u64) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0 % n
        }

        pub fn scalar(&mut self) -> Value {
            match self.next(8) {
                0 => Value::Null,
                1 => json!(true),
                2 => json!(-3),
                3 => json!(1.5),
                4 => json!(""),
                5 => json!("x.y"),
                6 => json!(u64::MAX),
                _ => json!("v"),
            }
        }

        // `arrays` controls how likely arrays are, so that both the array-free fast path
        // and the generic path get exercised
        pub fn value(&mut self, depth: u32, arrays: u64) -> Value {
            if depth == 0 {
                return self.scalar();
            }
            let roll = self.next(10);
            if roll < 4 {
                self.scalar()
            } else if roll < 7 || self.next(10) >= arrays {
                self.object(depth - 1, arrays)
            } else {
                let len = self.next(4);
                let mut arr = Vec::new();
                for _ in 0..len {
                    arr.push(match self.next(5) {
                        0 => Value::Null,
                        1 => self.scalar(),
                        2 => Value::Array(vec![]),
                        _ => self.object(depth - 1, arrays),
                    });
                }
                if self.next(3) == 0 {
                    // Homogeneous arrays of objects, the case flatten turns into columns
                    arr.retain(|v| v.is_object() || v.is_null());
                }
                Value::Array(arr)
            }
        }

        pub fn object(&mut self, depth: u32, arrays: u64) -> Value {
            let len = self.next(5);
            let mut map = Map::new();
            for _ in 0..len {
                let key = KEYS[self.next(KEYS.len() as u64) as usize];
                map.insert(key.to_owned(), self.value(depth, arrays));
            }
            Value::Object(map)
        }

        pub fn body(&mut self, arrays: u64) -> Value {
            match self.next(6) {
                0 => {
                    let len = self.next(4);
                    let mut arr = Vec::new();
                    for _ in 0..len {
                        arr.push(match self.next(8) {
                            0 => self.value(3, arrays),
                            _ => self.object(3, arrays),
                        });
                    }
                    Value::Array(arr)
                }
                1 => self.value(4, arrays),
                _ => self.object(4, arrays),
            }
        }
    }

    pub fn fixtures() -> Vec<Value> {
        vec![
            json!({}),
            json!([]),
            json!([{}]),
            json!([[]]),
            json!([[{"a": 1}], {"b": 2}]),
            json!([1]),
            json!(1),
            json!(null),
            json!("s"),
            json!({"a": 1, "b": "x", "c": null, "d": true, "e": 1.5}),
            json!({"a": {}}),
            json!({"a": {"b": {}}, "c": 1}),
            json!({"a": {"b": {"c": {"d": 1}}}}),
            json!({"a_b": 1, "a": {"b": 2}}),
            json!({"a": {"b": 2}, "a_b": 1}),
            json!({"a": {"b_c": 1}, "a_b": {"c": 2}}),
            json!({"a_b": 0, "a": [{"b": 1}, {"b": 2}]}),
            json!({"a": [{"b": 1}, {"b": 2}], "a_b": 0}),
            json!({"a": []}),
            json!({"a": [[]]}),
            json!({"a": [null]}),
            json!({"a": [1, 2], "b": [3, 4]}),
            json!({"a": [{"b": 1}, 2]}),
            json!({"a": [{"b": []}]}),
            json!({"a": [{}, {}]}),
            json!({"a": {"b": [1, {"c": 2}]}}),
            json!({"a": {"b": [{"c": [{"d": 1}]}]}}),
            json!([{"a": 1}, {"a": {"b": 2}}, {"a_b": 3, "a": {"b": 4}}]),
            json!([{"a": 1}, {"b": [1, 2]}]),
            json!([{"a": 1}, 2]),
            json!([{"a": 1}, null]),
        ]
    }
}

#[cfg(test)]
mod tests {
    use crate::utils::json::flatten::{flatten_array_objects, generic_flattening};

    use super::{JsonFlattenError, flatten};
    use serde_json::{Map, Value, json};

    // Serialization keeps key order, which `==` on maps may ignore
    fn ordered(result: Result<Vec<Value>, JsonFlattenError>) -> Result<String, String> {
        result
            .map(|values| serde_json::to_string(&values).unwrap())
            .map_err(|err| err.to_string())
    }

    fn flatten_ordered(
        mut value: Value,
        separator: &str,
        custom_partition: Option<&String>,
        validation_required: bool,
        legacy: bool,
    ) -> Result<String, String> {
        let result = if legacy {
            super::legacy::flatten(&mut value, separator, custom_partition, validation_required)
        } else {
            flatten(
                &mut value,
                separator,
                None,
                None,
                custom_partition,
                validation_required,
            )
        };
        result
            .map(|()| serde_json::to_string(&value).unwrap())
            .map_err(|err| format!("{err:?}"))
    }

    fn corpus() -> Vec<Value> {
        let mut values = super::shapes::fixtures();
        for arrays in [0, 3, 10] {
            let mut generator = super::shapes::Gen::new(arrays + 1);
            for _ in 0..1500 {
                values.push(generator.body(arrays));
            }
        }
        values
    }

    #[test]
    fn generic_flattening_matches_legacy() {
        for value in corpus() {
            assert_eq!(
                ordered(generic_flattening(&value)),
                ordered(super::legacy::generic_flattening(&value)),
                "input: {value}"
            );
        }
    }

    #[test]
    fn generic_flattening_noop_matches_legacy() {
        let mut fast = 0;
        for value in corpus() {
            let expected = super::legacy::generic_flattening(&value)
                .and_then(super::convert_to_array)
                .map(|v| serde_json::to_string(&v).unwrap());
            match super::generic_flattening_noop(value.clone()) {
                Ok(result) => {
                    fast += 1;
                    assert_eq!(
                        Ok(serde_json::to_string(&result).unwrap()),
                        expected.map_err(|e| e.to_string()),
                        "input: {value}"
                    );
                }
                Err(returned) => assert_eq!(returned, value),
            }
        }
        assert!(fast > 1000, "fast path exercised only {fast} times");
    }

    #[test]
    fn flatten_matches_legacy() {
        let partitions =
            [None, Some("a"), Some("a, b"), Some("a_b"), Some("c")].map(|p| p.map(str::to_owned));
        let mut unchanged = 0;
        for value in corpus() {
            // Exercise flatten on both raw bodies and generic flattening output
            let mut inputs = vec![value.clone()];
            if let Ok(rows) = super::legacy::generic_flattening(&value) {
                inputs.push(Value::Array(rows));
            }
            for input in inputs {
                for separator in ["_", "."] {
                    for partition in &partitions {
                        for validation_required in [false, true] {
                            let result = flatten_ordered(
                                input.clone(),
                                separator,
                                partition.as_ref(),
                                validation_required,
                                false,
                            );
                            assert_eq!(
                                result,
                                flatten_ordered(
                                    input.clone(),
                                    separator,
                                    partition.as_ref(),
                                    validation_required,
                                    true,
                                ),
                                "input: {input} separator: {separator} partition: {partition:?}"
                            );
                            if result == Ok(serde_json::to_string(&input).unwrap()) {
                                unchanged += 1;
                            }
                        }
                    }
                }
            }
        }
        assert!(
            unchanged > 1000,
            "no-op flatten exercised only {unchanged} times"
        );
    }

    #[test]
    fn flatten_preserves_collision_order() {
        // The later key wins, at the position where the key was first inserted (with the
        // `preserve_order` map that the server builds with)
        let preserves_order =
            json!({"b": 0, "a": 0}).as_object().unwrap().keys().next() == Some(&"b".to_owned());
        for (input, expected) in [
            (
                json!({"a_b": 1, "a": {"b": 2}, "c": 3}),
                json!({"a_b": 2, "c": 3}),
            ),
            (json!({"a": {"b": 2}, "a_b": 1}), json!({"a_b": 1})),
        ] {
            let mut obj = input.clone();
            flatten(&mut obj, "_", None, None, None, false).unwrap();
            if preserves_order {
                assert_eq!(obj, expected);
            }
            assert_eq!(
                Ok(serde_json::to_string(&obj).unwrap()),
                flatten_ordered(input, "_", None, false, true)
            );
        }
    }

    #[test]
    fn flatten_drops_nested_empty_object() {
        let mut obj = json!({"a": {}, "b": {"c": {}}, "d": 1});
        flatten(&mut obj, "_", None, None, None, false).unwrap();
        assert_eq!(obj, json!({"d": 1}));
    }

    #[test]
    fn flatten_flat_object_still_validates() {
        let mut obj = json!({"a": "x.y", "b": 1});
        assert!(matches!(
            flatten(&mut obj, "_", None, None, Some(&"a".to_owned()), true),
            Err(JsonFlattenError::FieldContainsPeriod(_))
        ));
        let mut obj = json!({"b": 1});
        assert!(matches!(
            flatten(&mut obj, "_", None, None, Some(&"a".to_owned()), true),
            Err(JsonFlattenError::FieldNotPartOfLog(_))
        ));
        let mut obj = json!(1);
        assert!(matches!(
            flatten(&mut obj, "_", None, None, None, false),
            Err(JsonFlattenError::CannotFlatten)
        ));
    }

    #[test]
    fn generic_flattening_noop_rejects_expanding_shapes() {
        for value in [
            json!({"a": []}),
            json!({"a": {"b": [1]}}),
            json!([[{"a": 1}]]),
            json!([{"a": 1}, 1]),
            json!(1),
            json!(null),
        ] {
            assert_eq!(super::generic_flattening_noop(value.clone()), Err(value));
        }
        assert_eq!(
            super::generic_flattening_noop(json!({"a": {"b": {}}})),
            Ok(json!([{"a": {"b": {}}}]))
        );
        assert_eq!(super::generic_flattening_noop(json!([])), Ok(json!([])));
    }

    #[test]
    fn flatten_single_key_string() {
        let mut obj = json!({"key": "value"});
        let expected = obj.clone();
        flatten(&mut obj, "_", None, None, None, false).unwrap();
        assert_eq!(obj, expected);
    }

    #[test]
    fn flatten_single_key_int() {
        let mut obj = json!({"key": 1});
        let expected = obj.clone();
        flatten(&mut obj, "_", None, None, None, false).unwrap();
        assert_eq!(obj, expected);
    }

    #[test]
    fn flatten_multiple_key_value() {
        let mut obj = json!({"key1": 1, "key2": "value2"});
        let expected = obj.clone();
        flatten(&mut obj, "_", None, None, None, false).unwrap();
        assert_eq!(obj, expected);
    }

    #[test]
    fn flatten_nested_single_key_value() {
        let mut obj = json!({"key": "value", "nested_key": {"key":"value"}});
        let expected = json!({"key": "value", "nested_key.key": "value"});
        flatten(&mut obj, ".", None, None, None, false).unwrap();
        assert_eq!(obj, expected);
    }

    #[test]
    fn nested_multiple_key_value() {
        let mut obj = json!({"key": "value", "nested_key": {"key1":"value1", "key2": "value2"}});
        let expected =
            json!({"key": "value", "nested_key.key1": "value1", "nested_key.key2": "value2"});
        flatten(&mut obj, ".", None, None, None, false).unwrap();
        assert_eq!(obj, expected);
    }

    #[test]
    fn nested_key_value_with_array() {
        let mut obj = json!({"key": "value", "nested_key": {"key1":[1,2,3]}});
        let expected = json!({"key": "value", "nested_key.key1": [1,2,3]});
        flatten(&mut obj, ".", None, None, None, false).unwrap();
        assert_eq!(obj, expected);
    }

    #[test]
    fn nested_obj_array() {
        let mut obj = json!({"key": [{"a": "value0"}, {"a": "value1"}]});
        let expected = json!({"key.a": ["value0", "value1"]});
        flatten(&mut obj, ".", None, None, None, false).unwrap();
        assert_eq!(obj, expected);
    }

    #[test]
    fn nested_obj_array_nulls() {
        let mut obj = json!({"key": [{"a": "value0"}, {"a": "value1", "b": "value1"}]});
        let expected = json!({"key.a": ["value0", "value1"], "key.b": [null, "value1"]});
        flatten(&mut obj, ".", None, None, None, false).unwrap();
        assert_eq!(obj, expected);
    }

    #[test]
    fn nested_obj_array_nulls_reversed() {
        let mut obj = json!({"key": [{"a": "value0", "b": "value0"}, {"a": "value1"}]});
        let expected = json!({"key.a": ["value0", "value1"], "key.b": ["value0", null]});
        flatten(&mut obj, ".", None, None, None, false).unwrap();
        assert_eq!(obj, expected);
    }

    #[test]
    fn nested_obj_array_nested_obj() {
        let mut obj = json!({"key": [{"a": {"p": 0}, "b": "value0"}, {"b": "value1"}]});
        let expected = json!({"key.a.p": [0, null], "key.b": ["value0", "value1"]});
        flatten(&mut obj, ".", None, None, None, false).unwrap();
        assert_eq!(obj, expected);
    }

    #[test]
    fn nested_obj_array_nested_obj_array() {
        let mut obj = json!({"key": [{"a": [{"p": "value0", "q": "value0"}, {"p": "value1", "q": null}], "b": "value0"}, {"b": "value1"}]});
        let expected = json!({"key.a.p": [["value0", "value1"], null], "key.a.q": [["value0", null], null], "key.b": ["value0", "value1"]});
        flatten(&mut obj, ".", None, None, None, false).unwrap();
        assert_eq!(obj, expected);
    }

    #[test]
    fn flatten_mixed_object() {
        let mut obj = json!({"a": 42, "arr": ["1", {"key": "2"}, {"key": {"nested": "3"}}]});
        assert!(flatten(&mut obj, ".", None, None, None, false).is_err());
    }

    #[test]
    fn flatten_array_nulls_at_start() {
        let Value::Array(mut arr) = json!([
            null,
            {"p": 2, "q": 2},
            {"q": 3},
        ]) else {
            unreachable!()
        };

        let mut map = Map::new();
        flatten_array_objects(&mut map, "key", &mut arr, ".").unwrap();

        assert_eq!(map.len(), 2);
        assert_eq!(map.get("key.p").unwrap(), &json!([null, 2, null]));
        assert_eq!(map.get("key.q").unwrap(), &json!([null, 2, 3]));
    }

    #[test]
    fn flatten_array_objects_nulls_at_end() {
        let Value::Array(mut arr) = json!([{"a": 1, "b": 1}, {"a": 2}, null]) else {
            unreachable!()
        };

        let mut map = Map::new();
        flatten_array_objects(&mut map, "key", &mut arr, ".").unwrap();

        assert_eq!(map.len(), 2);
        assert_eq!(map.get("key.a").unwrap(), &json!([1, 2, null]));
        assert_eq!(map.get("key.b").unwrap(), &json!([1, null, null]));
    }

    #[test]
    fn flatten_array_objects_nulls_in_middle() {
        let Value::Array(mut arr) = json!([{"a": 1, "b": 1}, null, {"a": 3, "c": 3}]) else {
            unreachable!()
        };

        let mut map = Map::new();
        flatten_array_objects(&mut map, "key", &mut arr, ".").unwrap();

        assert_eq!(map.len(), 3);
        assert_eq!(map.get("key.a").unwrap(), &json!([1, null, 3]));
        assert_eq!(map.get("key.b").unwrap(), &json!([1, null, null]));
        assert_eq!(map.get("key.c").unwrap(), &json!([null, null, 3]));
    }

    #[test]
    fn flatten_array_test() {
        let Value::Array(mut arr) = json!([
            {"p": 1, "q": 1},
            {"r": 2, "q": 2},
            {"p": 3, "r": 3}
        ]) else {
            unreachable!()
        };

        let mut map = Map::new();
        flatten_array_objects(&mut map, "key", &mut arr, ".").unwrap();

        assert_eq!(map.len(), 3);
        assert_eq!(map.get("key.p").unwrap(), &json!([1, null, 3]));
        assert_eq!(map.get("key.q").unwrap(), &json!([1, 2, null]));
        assert_eq!(map.get("key.r").unwrap(), &json!([null, 2, 3]));
    }

    #[test]
    fn flatten_array_nested_test() {
        let Value::Array(mut arr) = json!([
            {"p": 1, "q": [{"x": 1}, {"x": 2}]},
            {"r": 2, "q": [{"x": 1}]},
            {"p": 3, "r": 3}
        ]) else {
            unreachable!()
        };

        let mut map = Map::new();
        flatten_array_objects(&mut map, "key", &mut arr, ".").unwrap();

        assert_eq!(map.len(), 3);
        assert_eq!(map.get("key.p").unwrap(), &json!([1, null, 3]));
        assert_eq!(map.get("key.q.x").unwrap(), &json!([[1, 2], [1], null]));
        assert_eq!(map.get("key.r").unwrap(), &json!([null, 2, 3]));
    }

    #[test]
    fn acceptable_value_custom_parition_test() {
        let mut value = json!({
            "a": 1,
        });
        assert!(flatten(&mut value, "_", None, None, Some(&"a".to_string()), true).is_ok());

        let mut value = json!({
            "a": true,
        });
        assert!(flatten(&mut value, "_", None, None, Some(&"a".to_string()), true).is_ok());

        let mut value = json!({
            "a": "yes",
        });
        assert!(flatten(&mut value, "_", None, None, Some(&"a".to_string()), true).is_ok());

        let mut value = json!({
            "a": -1,
        });
        assert!(flatten(&mut value, "_", None, None, Some(&"a".to_string()), true).is_ok());
    }

    #[test]
    fn unacceptable_value_custom_partition_test() {
        let mut value = json!({
            "a": null,
        });
        matches!(
            flatten(&mut value, "_", None, None, Some(&"a".to_string()), true).unwrap_err(),
            JsonFlattenError::FieldEmptyOrNull(_)
        );

        let mut value = json!({
            "a": "",
        });
        matches!(
            flatten(&mut value, "_", None, None, Some(&"a".to_string()), true).unwrap_err(),
            JsonFlattenError::FieldEmptyOrNull(_)
        );

        let mut value = json!({
            "a": {"b": 1},
        });
        matches!(
            flatten(&mut value, "_", None, None, Some(&"a".to_string()), true).unwrap_err(),
            JsonFlattenError::FieldIsObject(_)
        );

        let mut value = json!({
            "a": ["b", "c"],
        });
        matches!(
            flatten(&mut value, "_", None, None, Some(&"a".to_string()), true).unwrap_err(),
            JsonFlattenError::FieldIsArray(_)
        );

        let mut value = json!({
            "a": "b.c",
        });
        matches!(
            flatten(&mut value, "_", None, None, Some(&"a".to_string()), true).unwrap_err(),
            JsonFlattenError::FieldContainsPeriod(_)
        );

        let mut value = json!({
            "a": 1.0,
        });
        matches!(
            flatten(&mut value, "_", None, None, Some(&"a".to_string()), true).unwrap_err(),
            JsonFlattenError::FieldContainsPeriod(_)
        );
    }

    #[test]
    fn flatten_json() {
        let value = json!({"a":{"b":{"e":["a","b"]}}});
        let expected = vec![json!({"a":{"b":{"e":"a"}}}), json!({"a":{"b":{"e":"b"}}})];
        assert_eq!(generic_flattening(&value).unwrap(), expected);
    }

    #[test]
    fn generic_flattening_treats_empty_array_as_unknown_value() {
        let value = json!({"a":{"b":{"e":[]}}});
        let expected = vec![json!({"a":{"b":{"e":null}}})];

        assert_eq!(generic_flattening(&value).unwrap(), expected);
    }

    #[test]
    fn generic_flattening_treats_empty_nested_array_item_as_unknown_value() {
        let value = json!({"a": [[]]});
        let expected = vec![json!({"a": null})];

        let flattened = generic_flattening(&value).unwrap();
        assert!(flattened.iter().all(Value::is_object));
        assert_eq!(flattened, expected);
    }

    #[test]
    fn generic_flattening_preserves_empty_top_level_array() {
        let value = json!([]);

        assert_eq!(generic_flattening(&value).unwrap(), Vec::<Value>::new());
    }
}
