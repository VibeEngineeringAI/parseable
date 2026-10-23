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
 *
 */

#![allow(deprecated)]

use anyhow::anyhow;
use arrow_array::RecordBatch;
use arrow_json::reader::{ReaderBuilder, infer_json_schema_from_iterator};
use arrow_schema::{DataType, Field, Fields, Schema};
use chrono::{DateTime, NaiveDate, NaiveDateTime, Utc};
use datafusion::arrow::util::bit_util::round_upto_multiple_of_64;
use itertools::Itertools;
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};
use tracing::{error, info_span};

use super::EventFormat;
use super::{detect_schema_conflicts, rename_conflicting_fields_in_json};
use crate::{
    handlers::TelemetryType, metadata::SchemaVersion, storage::StreamType, utils::arrow::get_field,
};

pub struct Event {
    pub json: Value,
    pub p_timestamp: DateTime<Utc>,
}

impl Event {
    pub fn new(json: Value, p_timestamp: DateTime<Utc>) -> Self {
        Self { json, p_timestamp }
    }
}

impl EventFormat for Event {
    type Data = Vec<Value>;

    /// Returns the time at ingestion, i.e. the `p_timestamp` value
    fn get_p_timestamp(&self) -> DateTime<Utc> {
        self.p_timestamp
    }

    // convert the incoming json to a vector of json values
    // also extract the arrow schema, tags and metadata from the incoming json
    #[cfg_attr(feature = "hotpath", hotpath::measure)]
    fn to_data(
        self,
        schema: &HashMap<String, Arc<Field>>,
        time_partition: Option<&String>,
        schema_version: SchemaVersion,
        static_schema_flag: bool,
        infer_timestamp: bool,
    ) -> Result<(Self::Data, Vec<Arc<Field>>, bool), anyhow::Error> {
        let stream_schema = schema;

        // incoming event may be a single json or a json array
        // but Data (type defined above) is a vector of json values
        // hence we need to convert the incoming event to a vector of json values
        let value_arr = match self.json {
            Value::Array(arr) => arr,
            value @ Value::Object(_) => vec![value],
            _ => unreachable!("flatten would have failed beforehand"),
        };

        // Common case: every key is already in the stream schema with a scalar
        // value the existing checks accept as-is. The result is then the one the
        // full path below would produce, without inferring a schema for the batch.
        if let Some(schema) = known_scalar_schema(
            &value_arr,
            stream_schema,
            schema_version,
            static_schema_flag,
        ) {
            return Ok((value_arr, schema, false));
        }

        to_data_full(
            value_arr,
            stream_schema,
            time_partition,
            schema_version,
            static_schema_flag,
            infer_timestamp,
        )
    }

    // Convert the Data type (defined above) to arrow record batch
    fn decode(data: Self::Data, schema: Arc<Schema>) -> Result<RecordBatch, anyhow::Error> {
        let _span = info_span!("json_to_recordbatch", record_count = data.len()).entered();
        let array_capacity = round_upto_multiple_of_64(data.len());
        let mut reader = ReaderBuilder::new(schema)
            .with_batch_size(array_capacity)
            .with_coerce_primitive(false)
            .build_decoder()?;

        reader.serialize(&data)?;
        match reader.flush() {
            Ok(Some(recordbatch)) => Ok(recordbatch),
            Err(err) => Err(anyhow!("Failed to create recordbatch due to {:?}", err)),
            Ok(None) => unreachable!("all records are added to one rb"),
        }
    }

    /// Converts a JSON event into a Parseable Event
    fn into_event(
        self,
        stream_name: String,
        origin_size: u64,
        storage_schema: &HashMap<String, Arc<Field>>,
        static_schema_flag: bool,
        custom_partitions: Option<&String>,
        time_partition: Option<&String>,
        schema_version: SchemaVersion,
        stream_type: StreamType,
        p_custom_fields: &HashMap<String, String>,
        telemetry_type: TelemetryType,
        tenant_id: &Option<String>,
        infer_timestamp: bool,
    ) -> Result<super::Event, anyhow::Error> {
        let custom_partition_values = match custom_partitions.as_ref() {
            Some(custom_partition) => {
                let custom_partitions = custom_partition.split(',').collect_vec();
                extract_custom_partition_values(&self.json, &custom_partitions)
            }
            None => HashMap::new(),
        };

        let parsed_timestamp = match time_partition {
            Some(time_partition) => extract_and_parse_time(&self.json, time_partition)?,
            _ => self.p_timestamp.naive_utc(),
        };

        let (rb, is_first_event) = self.into_recordbatch(
            storage_schema,
            static_schema_flag,
            time_partition,
            schema_version,
            p_custom_fields,
            infer_timestamp,
        )?;

        Ok(super::Event {
            rb,
            stream_name,
            origin_format: "json",
            origin_size,
            is_first_event,
            parsed_timestamp,
            time_partition: None,
            custom_partition_values,
            stream_type,
            telemetry_type,
            tenant_id: tenant_id.to_owned(),
        })
    }
}

/// Converts records into the data and event schema to decode, inferring
/// types and renaming conflicting fields to typed siblings where needed.
fn to_data_full(
    value_arr: Vec<Value>,
    stream_schema: &HashMap<String, Arc<Field>>,
    time_partition: Option<&String>,
    schema_version: SchemaVersion,
    static_schema_flag: bool,
    infer_timestamp: bool,
) -> Result<(Vec<Value>, super::EventSchema, bool), anyhow::Error> {
    // Rename JSON keys starting with '@' to '_' to match the schema
    // Reject event if renaming would cause a key collision
    let value_arr = rename_json_keys(value_arr)?;

    // First, infer raw schema from incoming event to detect type conflicts
    // IMPORTANT: Detect conflicts BEFORE update_field_type_in_schema, because
    // update_field_type_in_schema may override types (e.g., force Utf8 to Timestamp
    // if existing schema has Timestamp), which would hide the actual conflict.
    let raw_inferred_schema = {
        let _span = info_span!("infer_json_schema", record_count = value_arr.len()).entered();
        infer_json_schema_from_iterator(value_arr.iter().map(Ok))
            .map_err(|err| anyhow!("Could not infer schema for this event due to err {:?}", err))?
    };

    let value_arr = if static_schema_flag {
        value_arr
    } else {
        // Detect schema conflicts using raw inferred schema vs existing stream schema
        // Pass the actual values and schema_version to check if values can be coerced to existing types
        let conflicts = detect_schema_conflicts(
            &raw_inferred_schema,
            stream_schema,
            &value_arr,
            schema_version,
        );

        // If there are conflicts, rename the fields in JSON values
        let value_arr = if !conflicts.is_empty() {
            rename_conflicting_fields_in_json(value_arr, &conflicts, stream_schema, schema_version)
        } else {
            value_arr
        };

        // Per-record fallback: catches batches with mixed JSON types for the
        // same field, which the batch-level detect_schema_conflicts misses
        // because arrow's inference picks one winning type (string over bool).
        // Internally short-circuits when this can't apply (single-record
        // batches, or no field-name collision at the same type).
        super::rename_per_record_type_mismatches(
            value_arr,
            &raw_inferred_schema,
            stream_schema,
            schema_version,
        )
    };

    // collect all the keys from all the json objects in the request body
    let fields =
        collect_keys(value_arr.iter()).expect("fields can be collected from array of objects");

    let mut is_first = false;
    let res = {
        let _span = info_span!("derive_arrow_schema").entered();
        derive_arrow_schema(stream_schema, fields)
    };
    let (value_arr, schema) = match res {
        Ok(schema) => (value_arr, schema),
        Err(_) => {
            let mut infer_schema = infer_json_schema_from_iterator(value_arr.iter().map(Ok))
                .map_err(|err| {
                    anyhow!("Could not infer schema for this event due to err {:?}", err)
                })?;
            let new_infer_schema = super::update_field_type_in_schema(
                Arc::new(infer_schema),
                Some(stream_schema),
                time_partition,
                Some(&value_arr),
                schema_version,
                infer_timestamp,
            );
            infer_schema = Schema::new(new_infer_schema.fields().clone());
            Schema::try_merge(vec![
                Schema::new(stream_schema.values().cloned().collect::<Fields>()),
                infer_schema.clone(),
            ])
            .map_err(|err| {
                anyhow!(
                    "Could not merge schema of this event with that of the existing stream. {:?}",
                    err
                )
            })?;
            is_first = true;
            let schema: Vec<Arc<Field>> = infer_schema
                .fields
                .iter()
                .filter(|field| !field.data_type().is_null())
                .cloned()
                .sorted_by(|a, b| a.name().cmp(b.name()))
                .collect();
            (value_arr, schema)
        }
    };

    if let Some(mismatch) = value_arr
        .iter()
        .find_map(|value| fields_mismatch(&schema, value, schema_version, static_schema_flag))
    {
        return Err(anyhow!(
            "Could not process this event due to mismatch in datatype: {mismatch}"
        ));
    }

    Ok((value_arr, schema, is_first))
}

/// Returns the event schema for `values` when `to_data_full` would keep every
/// record unchanged and derive the schema from the stream's existing fields.
///
/// That holds when every record is an object with no `@` keys, every key
/// (including null-valued ones) is a stream field of a scalar type, and every
/// non-null value is a scalar that passes both the conflict check (skipped for
/// static schemas, as in `to_data_full`) and `valid_type`. Conflicts and
/// per-record renames then find nothing, `derive_arrow_schema` succeeds and
/// `fields_mismatch` passes. Anything else returns `None` so the caller takes
/// the full path. Values are still decoded by arrow afterwards.
fn known_scalar_schema(
    values: &[Value],
    stream_schema: &HashMap<String, Arc<Field>>,
    schema_version: SchemaVersion,
    static_schema_flag: bool,
) -> Option<Vec<Arc<Field>>> {
    if values.is_empty() {
        return None;
    }
    for value in values {
        for (name, val) in value.as_object()? {
            if name.starts_with('@') {
                return None;
            }
            let field = stream_schema.get(name)?;
            if field.name() != name || !is_known_scalar_type(field.data_type()) {
                return None;
            }
            match val {
                Value::Null => {}
                Value::Array(_) | Value::Object(_) => return None,
                val => {
                    if !static_schema_flag
                        && !super::value_compatible_with_type(
                            val,
                            field.data_type(),
                            schema_version,
                        )
                    {
                        return None;
                    }
                    if !valid_type(field, val, schema_version, static_schema_flag) {
                        return None;
                    }
                }
            }
        }
    }
    let _span = info_span!("derive_arrow_schema").entered();
    let fields = collect_keys(values.iter()).ok()?;
    derive_arrow_schema(stream_schema, fields).ok()
}

fn is_known_scalar_type(data_type: &DataType) -> bool {
    matches!(
        data_type,
        DataType::Boolean
            | DataType::Int8
            | DataType::Int16
            | DataType::Int32
            | DataType::Int64
            | DataType::UInt8
            | DataType::UInt16
            | DataType::UInt32
            | DataType::UInt64
            | DataType::Float16
            | DataType::Float32
            | DataType::Float64
            | DataType::Utf8
            | DataType::Date32
            | DataType::Timestamp(_, _)
    )
}

/// Extracts custom partition values from provided JSON object
/// e.g. `json: {"status": 400, "msg": "Hello, World!"}, custom_partition_list: ["status"]` returns `{"status" => 400}`
pub fn extract_custom_partition_values(
    json: &Value,
    custom_partition_list: &[&str],
) -> HashMap<String, String> {
    let mut custom_partition_values: HashMap<String, String> = HashMap::new();
    for custom_partition_field in custom_partition_list {
        let custom_partition_value = json.get(custom_partition_field.trim()).unwrap().to_owned();
        let custom_partition_value = match custom_partition_value {
            e @ Value::Number(_) | e @ Value::Bool(_) => e.to_string(),
            Value::String(s) => s,
            _ => "".to_string(),
        };
        custom_partition_values.insert(
            custom_partition_field.trim().to_string(),
            custom_partition_value,
        );
    }
    custom_partition_values
}

/// Returns the parsed timestamp of deignated time partition from json object
/// e.g. `json: {"timestamp": "2025-05-15T15:30:00Z"}` returns `2025-05-15T15:30:00`
fn extract_and_parse_time(
    json: &Value,
    time_partition: &str,
) -> Result<NaiveDateTime, anyhow::Error> {
    let current_time = json
        .get(time_partition)
        .ok_or_else(|| anyhow!("Missing field for time partition in json: {time_partition}"))?;
    let parsed_time: DateTime<Utc> = serde_json::from_value(current_time.clone())?;

    Ok(parsed_time.naive_utc())
}

// Returns arrow schema with the fields that are present in the request body
// This schema is an input to convert the request body to arrow record batch
fn derive_arrow_schema(
    schema: &HashMap<String, Arc<Field>>,
    fields: Vec<&str>,
) -> Result<Vec<Arc<Field>>, ()> {
    let mut res = Vec::with_capacity(fields.len());
    let fields = fields.into_iter().map(|field_name| schema.get(field_name));
    for field in fields {
        let Some(field) = field else { return Err(()) };
        res.push(field.clone())
    }
    Ok(res)
}

fn collect_keys<'a>(values: impl Iterator<Item = &'a Value>) -> Result<Vec<&'a str>, ()> {
    let mut keys = Vec::new();
    for value in values {
        if let Some(obj) = value.as_object() {
            for key in obj.keys() {
                match keys.binary_search(&key.as_str()) {
                    Ok(_) => (),
                    Err(pos) => {
                        keys.insert(pos, key.as_str());
                    }
                }
            }
        } else {
            return Err(());
        }
    }
    Ok(keys)
}

/// Renames JSON keys to match the schema transformation using normalize_field_name.
/// Returns an error if renaming would cause a key collision.
fn rename_json_keys(values: Vec<Value>) -> Result<Vec<Value>, anyhow::Error> {
    values
        .into_iter()
        .map(|value| {
            if let Value::Object(map) = value {
                if !map.keys().any(|key| key.starts_with('@')) {
                    return Ok(Value::Object(map));
                }

                // Collect original keys to check for collisions
                let original_keys: HashSet<String> = map.keys().cloned().collect();

                // Check for collisions before renaming
                for key in map.keys() {
                    if key.starts_with('@') {
                        let mut normalized_key = key.clone();
                        super::normalize_field_name(&mut normalized_key);
                        if original_keys.contains(&normalized_key) {
                            return Err(anyhow!(
                                "Key collision detected: '{}' and '{}' would both map to '{}'",
                                key,
                                normalized_key,
                                normalized_key
                            ));
                        }
                    }
                }

                let new_map: serde_json::Map<String, Value> = map
                    .into_iter()
                    .map(|(mut key, val)| {
                        if key.starts_with('@') {
                            super::normalize_field_name(&mut key);
                        }
                        (key, val)
                    })
                    .collect();
                Ok(Value::Object(new_map))
            } else {
                Ok(value)
            }
        })
        .collect()
}

/// Returns `Some(reason)` when `body` does not match the target `schema`.
/// `reason` names the offending field and includes the expected vs. actual
/// types so the caller can surface it in the error message.
fn fields_mismatch(
    schema: &[Arc<Field>],
    body: &Value,
    schema_version: SchemaVersion,
    static_schema_flag: bool,
) -> Option<String> {
    for (name, val) in body.as_object().expect("body is of object variant") {
        if val.is_null() {
            continue;
        }
        let Some(field) = get_field(schema, name) else {
            return Some(format!(
                "field '{name}' not present in stream schema (got {})",
                json_value_kind(val)
            ));
        };
        if !valid_type(field, val, schema_version, static_schema_flag) {
            return Some(format!(
                "field '{name}' expected {:?} but got {} value",
                field.data_type(),
                json_value_kind(val),
            ));
        }
    }
    None
}

fn json_value_kind(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "bool",
        Value::Number(n) if n.is_i64() => "i64",
        Value::Number(n) if n.is_u64() => "u64",
        Value::Number(_) => "f64",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn valid_type(
    field: &Field,
    value: &Value,
    schema_version: SchemaVersion,
    static_schema_flag: bool,
) -> bool {
    match field.data_type() {
        DataType::Boolean => value.is_boolean(),
        DataType::Int8 | DataType::Int16 | DataType::Int32 | DataType::Int64 => {
            validate_int(value, static_schema_flag)
        }
        DataType::UInt8 | DataType::UInt16 | DataType::UInt32 | DataType::UInt64 => value.is_u64(),
        DataType::Float16 | DataType::Float32 => value.is_f64(),
        DataType::Float64 => validate_float(value, schema_version, static_schema_flag),
        DataType::Utf8 => value.is_string(),
        DataType::List(field) => validate_list(field, value, schema_version, static_schema_flag),
        DataType::Struct(fields) => {
            validate_struct(fields, value, schema_version, static_schema_flag)
        }
        DataType::Date32 => {
            if let Value::String(s) = value {
                return NaiveDate::parse_from_str(s, "%Y-%m-%d").is_ok();
            }
            false
        }
        DataType::Timestamp(_, _) => value.is_string() || value.is_number(),
        _ => {
            error!(
                "Unsupported datatype {:?}, value {:?}",
                field.data_type(),
                value
            );
            false
        }
    }
}

fn validate_int(value: &Value, static_schema_flag: bool) -> bool {
    // allow casting string to int for static schema
    if static_schema_flag && let Value::String(s) = value {
        return s.trim().parse::<i64>().is_ok();
    }
    value.is_i64()
}

fn validate_float(value: &Value, schema_version: SchemaVersion, static_schema_flag: bool) -> bool {
    // allow casting string to int for static schema
    if static_schema_flag {
        if let Value::String(s) = value.clone() {
            let trimmed = s.trim();
            return trimmed.parse::<f64>().is_ok() || trimmed.parse::<i64>().is_ok();
        }
        return value.is_number();
    }
    match schema_version {
        SchemaVersion::V1 => value.is_number(),
        _ => value.is_f64(),
    }
}

fn validate_list(
    field: &Field,
    value: &Value,
    schema_version: SchemaVersion,
    static_schema_flag: bool,
) -> bool {
    if let Value::Array(arr) = value {
        for elem in arr {
            if elem.is_null() {
                continue;
            }
            if !valid_type(field, elem, schema_version, static_schema_flag) {
                return false;
            }
        }
    }
    true
}

fn validate_struct(
    fields: &Fields,
    value: &Value,
    schema_version: SchemaVersion,
    static_schema_flag: bool,
) -> bool {
    if let Value::Object(val) = value {
        for (key, value) in val {
            let field = fields.iter().find(|f| f.name() == key);

            if let Some(field) = field {
                if value.is_null() {
                    continue;
                }
                if !valid_type(field, value, schema_version, static_schema_flag) {
                    return false;
                }
            } else {
                return false;
            }
        }
        true
    } else {
        false
    }
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use arrow_array::UInt64Array;
    use serde_json::json;

    use super::*;
    use crate::otel::metrics::SERIES_HASH_COLUMN;

    #[test]
    fn series_hash_is_decoded_as_uint64_without_precision_loss() {
        let hash = u64::MAX;
        let event = Event::new(json!({ "__series_hash_u64": hash }), Utc::now());

        let (data, fields, _) = event
            .to_data(&HashMap::new(), None, SchemaVersion::V1, false, true)
            .unwrap();
        let schema = Arc::new(Schema::new(fields));
        assert_eq!(
            schema
                .field_with_name(SERIES_HASH_COLUMN)
                .unwrap()
                .data_type(),
            &DataType::UInt64
        );

        let batch = Event::decode(data, schema).unwrap();
        let hashes = batch
            .column_by_name(SERIES_HASH_COLUMN)
            .unwrap()
            .as_any()
            .downcast_ref::<UInt64Array>()
            .unwrap();
        assert_eq!(hashes.value(0), hash);
    }

    #[test]
    fn parse_time_parition_from_value() {
        let json = json!({"timestamp": "2025-05-15T15:30:00Z"});
        let parsed = extract_and_parse_time(&json, "timestamp");

        let expected = NaiveDateTime::from_str("2025-05-15T15:30:00").unwrap();
        assert_eq!(parsed.unwrap(), expected);
    }

    #[test]
    fn time_parition_not_in_json() {
        let json = json!({"hello": "world!"});
        let parsed = extract_and_parse_time(&json, "timestamp");

        assert!(parsed.is_err());
    }

    #[test]
    fn time_parition_not_parseable_as_datetime() {
        let json = json!({"timestamp": "not time"});
        let parsed = extract_and_parse_time(&json, "timestamp");

        assert!(parsed.is_err());
    }

    /// Differential tests: `to_data` with the known-schema fast path must give
    /// the same data, event schema, is_first, record batch and errors as the
    /// full path alone.
    mod known_scalar_schema {
        use arrow_schema::TimeUnit;
        use chrono::TimeZone;

        use super::*;

        /// Runs only the full path, through the same `into_recordbatch` as `Event`.
        struct FullPathEvent(Event);

        impl EventFormat for FullPathEvent {
            type Data = Vec<Value>;

            fn get_p_timestamp(&self) -> DateTime<Utc> {
                self.0.p_timestamp
            }

            fn to_data(
                self,
                schema: &HashMap<String, Arc<Field>>,
                time_partition: Option<&String>,
                schema_version: SchemaVersion,
                static_schema_flag: bool,
                infer_timestamp: bool,
            ) -> Result<(Self::Data, Vec<Arc<Field>>, bool), anyhow::Error> {
                let value_arr = match self.0.json {
                    Value::Array(arr) => arr,
                    value => vec![value],
                };
                to_data_full(
                    value_arr,
                    schema,
                    time_partition,
                    schema_version,
                    static_schema_flag,
                    infer_timestamp,
                )
            }

            fn decode(data: Self::Data, schema: Arc<Schema>) -> Result<RecordBatch, anyhow::Error> {
                Event::decode(data, schema)
            }

            fn into_event(
                self,
                _: String,
                _: u64,
                _: &HashMap<String, Arc<Field>>,
                _: bool,
                _: Option<&String>,
                _: Option<&String>,
                _: SchemaVersion,
                _: StreamType,
                _: &HashMap<String, String>,
                _: TelemetryType,
                _: &Option<String>,
                _: bool,
            ) -> Result<super::super::super::Event, anyhow::Error> {
                unimplemented!("only into_recordbatch is compared")
            }
        }

        #[derive(Clone, Copy)]
        struct Options<'a> {
            time_partition: Option<&'a String>,
            schema_version: SchemaVersion,
            static_schema_flag: bool,
            infer_timestamp: bool,
        }

        const ALL_SCHEMA_VERSIONS: [SchemaVersion; 2] = [SchemaVersion::V0, SchemaVersion::V1];

        fn stream_schema() -> HashMap<String, Arc<Field>> {
            let ts = DataType::Timestamp(TimeUnit::Millisecond, None);
            let fields = vec![
                Field::new("a", DataType::Utf8, true),
                Field::new("s", DataType::Utf8, true),
                Field::new("n", DataType::Int64, true),
                Field::new("i8", DataType::Int8, true),
                Field::new("i32", DataType::Int32, true),
                Field::new("u", DataType::UInt64, true),
                Field::new("u8", DataType::UInt8, true),
                Field::new("f", DataType::Float64, true),
                Field::new("f32", DataType::Float32, true),
                Field::new("b", DataType::Boolean, true),
                Field::new("ts", ts.clone(), true),
                Field::new("event_time", DataType::Utf8, true),
                Field::new("d", DataType::Date32, true),
                Field::new(crate::event::DEFAULT_TIMESTAMP_KEY, ts, true),
                Field::new(SERIES_HASH_COLUMN, DataType::UInt64, true),
                Field::new("big", DataType::LargeUtf8, true),
                Field::new(
                    "lst",
                    DataType::List(Arc::new(Field::new("item", DataType::Utf8, true))),
                    true,
                ),
                Field::new(
                    "st",
                    DataType::Struct(vec![Field::new("x", DataType::Utf8, true)].into()),
                    true,
                ),
                // typed siblings the full path may route values into
                Field::new("f_utf8", DataType::Utf8, true),
                Field::new("s_bool", DataType::Boolean, true),
                Field::new("ts_utf8", DataType::Utf8, true),
            ];
            let mut schema: HashMap<String, Arc<Field>> = fields
                .into_iter()
                .map(|field| (field.name().to_owned(), Arc::new(field)))
                .collect();
            // a stored '@' name, which the full path never matches since it
            // renames '@a' to '_a' first
            schema.insert(
                "@a".to_owned(),
                Arc::new(Field::new("@a", DataType::Utf8, true)),
            );
            // key that disagrees with its field name
            schema.insert(
                "alias".to_owned(),
                Arc::new(Field::new("other", DataType::Utf8, true)),
            );
            schema
        }

        fn error_string(err: anyhow::Error) -> String {
            format!("{err:#}")
        }

        /// Asserts the candidate matches the full path; returns whether the
        /// fast path accepted the input.
        fn assert_matches_full_path(
            json: &Value,
            schema: &HashMap<String, Arc<Field>>,
            options: Options,
        ) -> bool {
            let Options {
                time_partition,
                schema_version,
                static_schema_flag,
                infer_timestamp,
            } = options;
            let values = match json {
                Value::Array(arr) => arr.clone(),
                value => vec![value.clone()],
            };
            let fast = known_scalar_schema(&values, schema, schema_version, static_schema_flag);
            let context = format!(
                "input={json} version={schema_version:?} static={static_schema_flag} \
                 time_partition={time_partition:?} infer_timestamp={infer_timestamp}"
            );
            let p_timestamp = Utc.timestamp_millis_opt(1_700_000_000_123).unwrap();

            let candidate = Event::new(json.clone(), p_timestamp)
                .to_data(
                    schema,
                    time_partition,
                    schema_version,
                    static_schema_flag,
                    infer_timestamp,
                )
                .map_err(error_string);
            let full = FullPathEvent(Event::new(json.clone(), p_timestamp))
                .to_data(
                    schema,
                    time_partition,
                    schema_version,
                    static_schema_flag,
                    infer_timestamp,
                )
                .map_err(error_string);
            assert_eq!(candidate, full, "to_data differs: {context}");
            if let (Some(fields), Ok((_, full_fields, is_first))) = (&fast, &full) {
                assert_eq!(fields, full_fields, "{context}");
                assert!(!is_first, "{context}");
            }

            // An empty batch never reaches the decoder in production.
            if values.is_empty() {
                return fast.is_some();
            }
            let p_custom_fields = HashMap::from([("p_user_agent".to_owned(), "ua".to_owned())]);
            let candidate = Event::new(json.clone(), p_timestamp)
                .into_recordbatch(
                    schema,
                    static_schema_flag,
                    time_partition,
                    schema_version,
                    &p_custom_fields,
                    infer_timestamp,
                )
                .map_err(error_string);
            let full = FullPathEvent(Event::new(json.clone(), p_timestamp))
                .into_recordbatch(
                    schema,
                    static_schema_flag,
                    time_partition,
                    schema_version,
                    &p_custom_fields,
                    infer_timestamp,
                )
                .map_err(error_string);
            assert_eq!(candidate, full, "into_recordbatch differs: {context}");
            fast.is_some()
        }

        fn for_all_options(json: &Value, schema: &HashMap<String, Arc<Field>>) -> Vec<bool> {
            let time_partition = "ts".to_owned();
            let mut taken = Vec::new();
            for schema_version in ALL_SCHEMA_VERSIONS {
                for static_schema_flag in [false, true] {
                    for infer_timestamp in [true, false] {
                        for time_partition in [None, Some(&time_partition)] {
                            taken.push(assert_matches_full_path(
                                json,
                                schema,
                                Options {
                                    time_partition,
                                    schema_version,
                                    static_schema_flag,
                                    infer_timestamp,
                                },
                            ));
                        }
                    }
                }
            }
            taken
        }

        fn options(schema_version: SchemaVersion, static_schema_flag: bool) -> Options<'static> {
            Options {
                time_partition: None,
                schema_version,
                static_schema_flag,
                infer_timestamp: true,
            }
        }

        #[test]
        fn known_scalars_take_fast_path() {
            let schema = stream_schema();
            for json in [
                json!({"a": "x", "n": 1, "b": true, "ts": "2024-05-01T10:00:00Z"}),
                json!({"a": "x", "f": 1.5, "u": 18446744073709551615u64}),
                json!([{"a": "x"}, {"n": -3}, {"a": null, "b": false}]),
                json!({"a": null, "n": null}),
                json!({"n": 1, "a": "z"}),
                json!({"i8": 1000, "u8": 300, "i32": 9007199254740993i64}),
                json!({ SERIES_HASH_COLUMN: 18446744073709551615u64 }),
                json!({"ts": "2024-05-01T10:00:00"}),
                json!({"ts": "2024-05-01 10:00:00.123"}),
                json!({"event_time": "2024-05-01T10:00:00Z"}),
            ] {
                for schema_version in ALL_SCHEMA_VERSIONS {
                    for static_schema_flag in [false, true] {
                        assert!(
                            assert_matches_full_path(
                                &json,
                                &schema,
                                options(schema_version, static_schema_flag)
                            ),
                            "expected fast path for {json}"
                        );
                    }
                }
                for_all_options(&json, &schema);
            }
        }

        #[test]
        fn fast_path_derives_present_fields_sorted() {
            let schema = stream_schema();
            let values = vec![json!({"n": 1, "b": true}), json!({"a": null})];
            let fields = known_scalar_schema(&values, &schema, SchemaVersion::V1, false).unwrap();
            let names = fields.iter().map(|f| f.name().as_str()).collect_vec();
            assert_eq!(names, ["a", "b", "n"]);
            assert!(Arc::ptr_eq(&fields[0], &schema["a"]));
        }

        #[test]
        fn shapes_outside_fast_path_fall_back() {
            let schema = stream_schema();
            for json in [
                // unknown fields, even null-valued
                json!({"a": "x", "new": null}),
                json!({"a": "x", "new": 1}),
                json!([{"a": "x"}, {"new": "y"}]),
                // '@' keys, renamed or colliding
                json!({"@a": "x"}),
                json!({"@a": "x", "_a": "y"}),
                json!({"@s": "x", "a": "y"}),
                // nested values and structural or unsupported field types
                json!({"a": {"x": "y"}}),
                json!({"a": ["x"]}),
                json!({"a": []}),
                json!({"lst": ["x"]}),
                json!({"lst": null}),
                json!({"lst": "x"}),
                json!({"st": {"x": "y"}}),
                json!({"st": null}),
                json!({"big": "x"}),
                // map key disagrees with its field name
                json!({"alias": "x"}),
                // non-object records and empty batches
                json!([]),
                json!([1, {"a": "x"}]),
                json!([{"a": "x"}, "y"]),
                // values the full path renames to typed siblings or rejects
                json!({"f": "1.5"}),
                json!({"f": "high"}),
                json!({"f": true}),
                json!({"n": 1.5}),
                json!({"n": "42"}),
                json!({"n": " 42 "}),
                json!({"n": 18446744073709551615u64}),
                json!({"u": -1}),
                json!({"u": 1.0}),
                json!({"f32": 1}),
                json!({"f32": 1.5}),
                json!({"b": "true"}),
                json!({"a": 1}),
                json!({"a": true}),
                json!([{"s": "true"}, {"s": true}]),
                json!([{"f": 1.5}, {"f": "x"}]),
                json!([{"a": "x"}, {"a": 1}]),
                json!({"ts": 1714557600000i64}),
                json!({"ts": "not a time"}),
                json!({"ts": "Wed, 1 May 2024 10:00:00 +0000"}),
                json!({"ts": "2024-05-01"}),
                json!({"ts": "2024-13-01T10:00:00Z"}),
                json!({"d": "2024-05-01"}),
                json!({"d": "2024-5-1x"}),
                json!({"d": 1}),
                // reserved field
                json!({ crate::event::DEFAULT_TIMESTAMP_KEY: "2024-05-01T10:00:00Z" }),
                json!({ crate::event::DEFAULT_TIMESTAMP_KEY: 1 }),
                json!({ SERIES_HASH_COLUMN: -1 }),
            ] {
                for_all_options(&json, &schema);
            }
            // a V0 integer is not compatible with Float64; a V1 integer is
            let json = json!({"f": 1});
            assert!(!assert_matches_full_path(
                &json,
                &schema,
                options(SchemaVersion::V0, false)
            ));
            assert!(assert_matches_full_path(
                &json,
                &schema,
                options(SchemaVersion::V1, false)
            ));
            // static schemas accept parseable strings for numbers and dates
            for json in [
                json!({"f": " 1.5 "}),
                json!({"n": " 42 "}),
                json!({"d": "2024-05-01"}),
            ] {
                assert!(assert_matches_full_path(
                    &json,
                    &schema,
                    options(SchemaVersion::V1, true)
                ));
                assert!(!assert_matches_full_path(
                    &json,
                    &schema,
                    options(SchemaVersion::V1, false)
                ));
            }
        }

        /// Inputs where trusting known keys alone (keep the records, derive the
        /// present fields, is_first = false) differs from the full path.
        #[test]
        fn broad_known_key_shortcut_counterexamples() {
            let schema = stream_schema();
            let naive = |values: &[Value]| {
                let fields = collect_keys(values.iter()).ok()?;
                let fields = derive_arrow_schema(&schema, fields).unwrap_or_default();
                Some((values.to_vec(), fields, false))
            };
            for (json, schema_version, static_schema_flag) in [
                // null-only unknown field: full path infers, drops it, is_first
                (json!({"a": "x", "new": null}), SchemaVersion::V1, false),
                // stored '@a' never matches: the record becomes '_a'
                (json!({"@a": "x"}), SchemaVersion::V1, false),
                // per-record typed sibling for the losing type in a mixed batch
                (json!([{"s": "x"}, {"s": true}]), SchemaVersion::V1, false),
                (json!([{"f": 1.5}, {"f": "x"}]), SchemaVersion::V1, false),
                // integer into Float64 is a conflict in V0, not in V1
                (json!({"f": 1}), SchemaVersion::V0, false),
                // valid_type accepts numbers for timestamps, the conflict check does not
                (json!({"ts": 1714557600000i64}), SchemaVersion::V1, false),
                // chrono parses RFC 2822, Arrow does not
                (
                    json!({"ts": "Wed, 1 May 2024 10:00:00 +0000"}),
                    SchemaVersion::V1,
                    false,
                ),
                // passes the conflict check, rejected by valid_type
                (json!({"f32": 1}), SchemaVersion::V1, false),
                (json!({"n": "42"}), SchemaVersion::V1, false),
                (json!({"f": "1.5"}), SchemaVersion::V1, false),
                // u64 above i64::MAX into Int64
                (
                    json!({"n": 18446744073709551615u64}),
                    SchemaVersion::V1,
                    false,
                ),
            ] {
                let values = match &json {
                    Value::Array(arr) => arr.clone(),
                    value => vec![value.clone()],
                };
                assert!(
                    known_scalar_schema(&values, &schema, schema_version, static_schema_flag)
                        .is_none(),
                    "{json}"
                );
                let full = FullPathEvent(Event::new(json.clone(), Utc::now()))
                    .to_data(&schema, None, schema_version, static_schema_flag, true)
                    .ok();
                assert_ne!(full, naive(&values), "{json}");
                assert_matches_full_path(
                    &json,
                    &schema,
                    options(schema_version, static_schema_flag),
                );
            }
        }

        /// The fast path keeps Arrow decoding, so out-of-range values still fail.
        #[test]
        fn fast_path_keeps_decoder_errors() {
            let schema = stream_schema();
            for json in [json!({"i8": 1000}), json!({"u8": 300})] {
                assert!(assert_matches_full_path(
                    &json,
                    &schema,
                    options(SchemaVersion::V1, false)
                ));
                let err = Event::new(json, Utc::now())
                    .into_recordbatch(
                        &schema,
                        false,
                        None,
                        SchemaVersion::V1,
                        &HashMap::new(),
                        true,
                    )
                    .unwrap_err();
                assert!(
                    err.to_string().contains("Failed to create recordbatch"),
                    "{err}"
                );
            }
        }

        #[test]
        fn empty_and_new_streams_fall_back() {
            for json in [
                json!({"a": "x", "n": 1}),
                json!({"a": null}),
                json!([{"event_time": "2024-05-01T10:00:00Z"}, {"x": true}]),
            ] {
                let taken = for_all_options(&json, &HashMap::new());
                assert!(taken.iter().all(|taken| !taken));
            }
        }

        /// Small deterministic xorshift generator, so failures reproduce.
        struct Rng(u64);

        impl Rng {
            fn next(&mut self) -> u64 {
                self.0 ^= self.0 << 13;
                self.0 ^= self.0 >> 7;
                self.0 ^= self.0 << 17;
                self.0
            }

            fn below(&mut self, n: usize) -> usize {
                (self.next() % n as u64) as usize
            }

            fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
                &items[self.below(items.len())]
            }
        }

        fn generated_value(rng: &mut Rng, field: Option<&Arc<Field>>) -> Value {
            let any = [
                json!(null),
                json!(true),
                json!(0),
                json!(-1),
                json!(u64::MAX),
                json!(1.5),
                json!("x"),
                json!("true"),
                json!(" 7 "),
                json!("1.5"),
                json!("2024-05-01"),
                json!("2024-05-01T10:00:00Z"),
                json!("Wed, 1 May 2024 10:00:00 +0000"),
                json!(["x"]),
                json!({"x": "y"}),
                json!([]),
            ];
            let typed: &[Value] = match field.map(|field| field.data_type()) {
                _ if rng.below(4) == 0 => &any,
                Some(DataType::Boolean) => &[json!(true), json!(false)],
                Some(DataType::Int8 | DataType::Int16 | DataType::Int32 | DataType::Int64) => &[
                    json!(0),
                    json!(-1),
                    json!(127),
                    json!(128),
                    json!(9007199254740993i64),
                    json!(i64::MAX),
                    json!(i64::MIN),
                ],
                Some(DataType::UInt8 | DataType::UInt16 | DataType::UInt32 | DataType::UInt64) => {
                    &[
                        json!(0),
                        json!(255),
                        json!(256),
                        json!(i64::MAX),
                        json!(u64::MAX),
                    ]
                }
                Some(DataType::Float16 | DataType::Float32 | DataType::Float64) => &[
                    json!(0.0),
                    json!(-0.0),
                    json!(1.5),
                    json!(1e300),
                    json!(3),
                    json!(u64::MAX),
                ],
                Some(DataType::Utf8) => &[json!(""), json!("x"), json!("2024-05-01T10:00:00Z")],
                Some(DataType::Date32) => &[json!("2024-05-01"), json!("2024-02-30")],
                Some(DataType::Timestamp(_, _)) => &[
                    json!("2024-05-01T10:00:00Z"),
                    json!("2024-05-01T10:00:00.123+05:30"),
                    json!("2024-05-01T10:00:00"),
                    json!("2024-05-01 10:00:00"),
                    json!("2024-05-01T10:00:00.123456789"),
                    json!("+275760-09-13T00:00:00Z"),
                ],
                _ => &any,
            };
            if rng.below(8) == 0 {
                json!(null)
            } else {
                rng.pick(typed).clone()
            }
        }

        fn generated_record(
            rng: &mut Rng,
            keys: &[&str],
            schema: &HashMap<String, Arc<Field>>,
        ) -> Value {
            let mut map = serde_json::Map::new();
            for _ in 0..=rng.below(4) {
                let key = *rng.pick(keys);
                map.insert(key.to_owned(), generated_value(rng, schema.get(key)));
            }
            Value::Object(map)
        }

        #[test]
        fn generated_batches_match_full_path() {
            let schema = stream_schema();
            let mostly_known = [
                "a",
                "s",
                "n",
                "i8",
                "i32",
                "u",
                "u8",
                "f",
                "f32",
                "b",
                "ts",
                "event_time",
                "d",
                SERIES_HASH_COLUMN,
            ];
            let with_rare = [
                "a",
                "n",
                "f",
                "s",
                "ts",
                "new",
                "@a",
                "_a",
                "lst",
                "alias",
                crate::event::DEFAULT_TIMESTAMP_KEY,
            ];
            let time_partition = "ts".to_owned();
            let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
            let (mut fast, mut full) = (0, 0);
            for case in 0..4000 {
                let keys: &[&str] = if case % 4 == 0 {
                    &with_rare
                } else {
                    &mostly_known
                };
                let len = 1 + rng.below(4);
                let records = (0..len)
                    .map(|_| generated_record(&mut rng, keys, &schema))
                    .collect_vec();
                let json = if len == 1 && rng.below(2) == 0 {
                    records.into_iter().next().unwrap()
                } else {
                    Value::Array(records)
                };
                let options = Options {
                    time_partition: *rng.pick(&[None, Some(&time_partition)]),
                    schema_version: *rng.pick(&ALL_SCHEMA_VERSIONS),
                    static_schema_flag: rng.below(4) == 0,
                    infer_timestamp: rng.below(4) != 0,
                };
                if assert_matches_full_path(&json, &schema, options) {
                    fast += 1;
                } else {
                    full += 1;
                }
            }
            assert!(fast > 800 && full > 800, "fast={fast} full={full}");
        }

        /// Typical application logs: every batch after the first uses the fast path.
        #[test]
        fn stable_stream_reuses_schema_after_first_batch() {
            let batch = |i: i64| {
                json!([
                    {"level": "info", "msg": format!("m{i}"), "latency": 1.25, "status": 200, "ok": true},
                    {"level": "warn", "msg": "w", "latency": 3, "status": null, "ok": false},
                ])
            };
            let mut schema = HashMap::new();
            for i in 0..3 {
                let json = batch(i);
                for schema_version in ALL_SCHEMA_VERSIONS {
                    assert_matches_full_path(&json, &schema, options(schema_version, false));
                }
                let (_, fields, is_first) = Event::new(json, Utc::now())
                    .to_data(&schema, None, SchemaVersion::V1, false, true)
                    .unwrap();
                assert_eq!(is_first, i == 0);
                if i > 0 {
                    assert!(
                        known_scalar_schema(
                            batch(i).as_array().unwrap(),
                            &schema,
                            SchemaVersion::V1,
                            false
                        )
                        .is_some()
                    );
                }
                schema.extend(fields.into_iter().map(|f| (f.name().to_owned(), f)));
            }
        }
    }
}
