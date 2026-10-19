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

use crate::{handlers::http::query::QueryError, utils::arrow::record_batches_to_json};
use arrow_json::writer::{EncoderOptions, NullableEncoder, make_encoder};
use arrow_schema::{DataType, FieldRef};
use datafusion::arrow::record_batch::RecordBatch;
use itertools::Itertools;
use serde::de::{DeserializeSeed, MapAccess, SeqAccess, Visitor};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::fmt;
use tracing::info;

pub struct QueryResponse {
    pub records: Vec<RecordBatch>,
    pub fields: Vec<String>,
    pub fill_null: bool,
    pub with_fields: bool,
}

impl QueryResponse {
    /// Avoid per-row Value allocations for compatible schemas. Flat rows retain
    /// serde's scalar conversions and null filling through a streaming visitor;
    /// complex schemas keep the original conversion path.
    pub fn to_json_bytes(&self) -> Result<Vec<u8>, QueryError> {
        if self.fill_null
            || self
                .records
                .iter()
                .any(|batch| !can_write_json_directly(batch.schema().fields()))
        {
            if self
                .records
                .iter()
                .all(|batch| can_transcode_flat_json(batch.schema().fields()))
            {
                return self.to_flat_json_bytes();
            }
            return Ok(serde_json::to_vec(&self.to_json()?)?);
        }

        info!("{}", "Returning query results");
        let mut bytes = Vec::new();
        if self.with_fields {
            bytes.extend_from_slice(b"{\"fields\":");
            serde_json::to_writer(&mut bytes, &self.fields)?;
            bytes.extend_from_slice(b",\"records\":");
        }
        {
            let mut writer = arrow_json::ArrayWriter::new(&mut bytes);
            for batch in &self.records {
                writer.write(batch).map_err(anyhow::Error::from)?;
            }
            writer.finish().map_err(anyhow::Error::from)?;
        }
        if self.with_fields {
            bytes.push(b'}');
        }
        Ok(bytes)
    }

    /// Keep serde's existing scalar conversions while writing rows without
    /// allocating a Value tree or owned map keys and strings for each record.
    fn to_flat_json_bytes(&self) -> Result<Vec<u8>, QueryError> {
        info!("{}", "Returning query results");
        match self.write_flat_records()? {
            Some(bytes) => Ok(bytes),
            // The document transcode turns any unparsable scalar into an empty
            // record list; rerun it so failures keep exactly that result.
            None => self.transcode_arrow_json(),
        }
    }

    /// Encode rows with Arrow's own JSON value encoders instead of parsing an
    /// intermediate Arrow JSON document. Arrow writes strings with serde's
    /// escaping and integers and booleans in canonical form, which are the
    /// bytes the transcode reproduced. Floats and timestamps still pass, one
    /// value at a time, through the same serde scalar conversion. Returns None
    /// when such a value does not parse.
    fn write_flat_records(&self) -> Result<Option<Vec<u8>>, QueryError> {
        let fields = if self.fill_null {
            self.fields.as_slice()
        } else {
            &[]
        };
        let mut field_indices = HashMap::with_capacity(fields.len());
        for (index, field) in fields.iter().enumerate() {
            field_indices.entry(field.as_str()).or_insert(index);
        }
        let mut seen_fields = vec![false; fields.len()];
        let mut bytes = Vec::new();
        if self.with_fields {
            bytes.extend_from_slice(b"{\"fields\":");
            serde_json::to_writer(&mut bytes, &self.fields)?;
            bytes.extend_from_slice(b",\"records\":");
        }
        bytes.push(b'[');
        let mut first_row = true;
        let options = EncoderOptions::default();
        let mut scalar = Vec::new();
        for batch in &self.records {
            // Arrow's writer skips empty batches before creating encoders.
            if batch.num_rows() == 0 {
                continue;
            }
            let schema = batch.schema();
            let mut columns = schema
                .fields()
                .iter()
                .zip(batch.columns())
                .map(|(field, array)| {
                    let mut key = Vec::with_capacity(field.name().len() + 3);
                    serde_json::to_writer(&mut key, field.name())?;
                    key.push(b':');
                    Ok::<_, QueryError>(FlatColumn {
                        key,
                        index: field_indices.get(field.name().as_str()).copied(),
                        transcode: !is_canonical_json_scalar(field.data_type()),
                        encoder: make_encoder(field, array.as_ref(), &options)
                            .map_err(anyhow::Error::from)?,
                    })
                })
                .collect::<Result<Vec<_>, _>>()?;
            for row in 0..batch.num_rows() {
                if !first_row {
                    bytes.push(b',');
                }
                first_row = false;
                bytes.push(b'{');
                seen_fields.fill(false);
                let mut first_field = true;
                for column in &mut columns {
                    // Arrow elides null values unless explicit nulls are enabled.
                    if column.encoder.is_null(row) {
                        continue;
                    }
                    if !first_field {
                        bytes.push(b',');
                    }
                    first_field = false;
                    bytes.extend_from_slice(&column.key);
                    if let Some(index) = column.index {
                        seen_fields[index] = true;
                    }
                    if column.transcode {
                        scalar.clear();
                        column.encoder.encode(row, &mut scalar);
                        let mut deserializer = serde_json::Deserializer::from_slice(&scalar);
                        let parsed = FlatScalarSeed { bytes: &mut bytes }
                            .deserialize(&mut deserializer)
                            .and_then(|()| deserializer.end());
                        if parsed.is_err() {
                            return Ok(None);
                        }
                    } else {
                        column.encoder.encode(row, &mut bytes);
                    }
                }
                for field in fields {
                    let index = field_indices[field.as_str()];
                    if !seen_fields[index] {
                        write_flat_key::<serde_json::Error>(&mut bytes, field, &mut first_field)?;
                        bytes.extend_from_slice(b"null");
                        seen_fields[index] = true;
                    }
                }
                bytes.push(b'}');
            }
        }
        bytes.push(b']');
        if self.with_fields {
            bytes.push(b'}');
        }
        // The old transcode reserved about the response size up front; don't
        // keep a mostly unused doubled buffer alive while it is sent.
        if bytes.capacity() - bytes.len() > bytes.len() / 4 {
            bytes.shrink_to_fit();
        }
        Ok(Some(bytes))
    }

    /// Write Arrow's JSON document, then transcode it. This was the flat path
    /// before typed row writing and still defines its failure behavior.
    fn transcode_arrow_json(&self) -> Result<Vec<u8>, QueryError> {
        let mut writer = arrow_json::ArrayWriter::new(Vec::new());
        for batch in &self.records {
            writer.write(batch).map_err(anyhow::Error::from)?;
        }
        writer.finish().map_err(anyhow::Error::from)?;
        let json = writer.into_inner();

        self.transcode_flat_records(&json)
    }

    fn transcode_flat_records(&self, json: &[u8]) -> Result<Vec<u8>, QueryError> {
        let fields = if self.fill_null {
            self.fields.as_slice()
        } else {
            &[]
        };
        let mut field_indices = HashMap::with_capacity(fields.len());
        for (index, field) in fields.iter().enumerate() {
            field_indices.entry(field.as_str()).or_insert(index);
        }
        let mut state = FlatJsonState {
            bytes: Vec::new(),
            fields,
            field_indices,
            seen_fields: vec![false; fields.len()],
        };
        if self.with_fields {
            state.bytes.extend_from_slice(b"{\"fields\":");
            serde_json::to_writer(&mut state.bytes, &self.fields)?;
            state.bytes.extend_from_slice(b",\"records\":");
        }
        let records_start = state.bytes.len();
        state.bytes.reserve(json.len());
        let mut deserializer = serde_json::Deserializer::from_slice(json);
        let parsed = FlatRowsSeed { state: &mut state }
            .deserialize(&mut deserializer)
            .and_then(|()| deserializer.end());
        if parsed.is_err() {
            // record_batches_to_json has always returned an empty record list
            // if Arrow's generated JSON cannot be parsed, even after good rows.
            state.bytes.truncate(records_start);
            state.bytes.extend_from_slice(b"[]");
        }
        if self.with_fields {
            state.bytes.push(b'}');
        }
        Ok(state.bytes)
    }

    pub fn to_json(&self) -> Result<Value, QueryError> {
        info!("{}", "Returning query results");
        let mut json_records = record_batches_to_json(&self.records)?;

        if self.fill_null {
            for map in &mut json_records {
                for field in &self.fields {
                    if !map.contains_key(field) {
                        map.insert(field.clone(), Value::Null);
                    }
                }
            }
        }
        let values = json_records.into_iter().map(Value::Object).collect_vec();

        let response = if self.with_fields {
            json!({
                "fields": self.fields,
                "records": values,
            })
        } else {
            Value::Array(values)
        };

        Ok(response)
    }
}

fn can_transcode_flat_json(fields: &[FieldRef]) -> bool {
    // Tested with serde_json preserve_order and without arbitrary_precision or
    // float_roundtrip. This visitor relies on scalar callbacks and insertion
    // order; exact-byte differential tests guard future feature changes.
    let mut names = HashSet::with_capacity(fields.len());
    fields.iter().all(|field| {
        names.insert(field.name())
            && matches!(
                field.data_type(),
                DataType::Null
                    | DataType::Boolean
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
                    | DataType::LargeUtf8
                    | DataType::Utf8View
                    | DataType::Timestamp(_, None)
            )
    })
}

struct FlatColumn<'a> {
    key: Vec<u8>,
    index: Option<usize>,
    transcode: bool,
    encoder: NullableEncoder<'a>,
}

/// Whether Arrow's JSON encoding of a non-null value is already the exact
/// output of parsing it with serde_json and writing it back. Floats can change
/// in that round trip, and timestamps come from a display formatter that does
/// not escape its text, so other types keep the serde conversion.
fn is_canonical_json_scalar(data_type: &DataType) -> bool {
    matches!(
        data_type,
        DataType::Null
            | DataType::Boolean
            | DataType::Int8
            | DataType::Int16
            | DataType::Int32
            | DataType::Int64
            | DataType::UInt8
            | DataType::UInt16
            | DataType::UInt32
            | DataType::UInt64
            | DataType::Utf8
            | DataType::LargeUtf8
            | DataType::Utf8View
    )
}

struct FlatJsonState<'f> {
    bytes: Vec<u8>,
    fields: &'f [String],
    field_indices: HashMap<&'f str, usize>,
    seen_fields: Vec<bool>,
}

struct FlatRowsSeed<'s, 'f> {
    state: &'s mut FlatJsonState<'f>,
}

impl<'de> DeserializeSeed<'de> for FlatRowsSeed<'_, '_> {
    type Value = ();

    fn deserialize<D: serde::Deserializer<'de>>(self, deserializer: D) -> Result<(), D::Error> {
        deserializer.deserialize_seq(self)
    }
}

impl<'de> Visitor<'de> for FlatRowsSeed<'_, '_> {
    type Value = ();

    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.write_str("an array of flat row objects")
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut rows: A) -> Result<(), A::Error> {
        self.state.bytes.push(b'[');
        let mut first = true;
        while rows
            .next_element_seed(FlatRowSeed {
                state: &mut *self.state,
                first,
            })?
            .is_some()
        {
            first = false;
        }
        self.state.bytes.push(b']');
        Ok(())
    }
}

struct FlatRowSeed<'s, 'f> {
    state: &'s mut FlatJsonState<'f>,
    first: bool,
}

impl<'de> DeserializeSeed<'de> for FlatRowSeed<'_, '_> {
    type Value = ();

    fn deserialize<D: serde::Deserializer<'de>>(self, deserializer: D) -> Result<(), D::Error> {
        deserializer.deserialize_map(self)
    }
}

impl<'de> Visitor<'de> for FlatRowSeed<'_, '_> {
    type Value = ();

    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.write_str("a flat row object")
    }

    fn visit_map<A: MapAccess<'de>>(self, mut row: A) -> Result<(), A::Error> {
        if !self.first {
            self.state.bytes.push(b',');
        }
        self.state.bytes.push(b'{');
        self.state.seen_fields.fill(false);
        let mut first_field = true;
        while row
            .next_key_seed(FlatKeySeed {
                state: &mut *self.state,
                first: &mut first_field,
            })?
            .is_some()
        {
            row.next_value_seed(FlatScalarSeed {
                bytes: &mut self.state.bytes,
            })?;
        }
        for field in self.state.fields {
            let index = self.state.field_indices[field.as_str()];
            if !self.state.seen_fields[index] {
                write_flat_key::<A::Error>(&mut self.state.bytes, field, &mut first_field)?;
                self.state.bytes.extend_from_slice(b"null");
                self.state.seen_fields[index] = true;
            }
        }
        self.state.bytes.push(b'}');
        Ok(())
    }
}

fn write_flat_key<E: serde::de::Error>(
    bytes: &mut Vec<u8>,
    key: &str,
    first: &mut bool,
) -> Result<(), E> {
    if !*first {
        bytes.push(b',');
    }
    *first = false;
    serde_json::to_writer(&mut *bytes, key).map_err(E::custom)?;
    bytes.push(b':');
    Ok(())
}

struct FlatKeySeed<'s, 'f> {
    state: &'s mut FlatJsonState<'f>,
    first: &'s mut bool,
}

impl FlatKeySeed<'_, '_> {
    fn write<E: serde::de::Error>(self, key: &str) -> Result<(), E> {
        write_flat_key::<E>(&mut self.state.bytes, key, self.first)?;
        if let Some(index) = self.state.field_indices.get(key) {
            self.state.seen_fields[*index] = true;
        }
        Ok(())
    }
}

impl<'de> DeserializeSeed<'de> for FlatKeySeed<'_, '_> {
    type Value = ();

    fn deserialize<D: serde::Deserializer<'de>>(self, deserializer: D) -> Result<(), D::Error> {
        deserializer.deserialize_str(self)
    }
}

impl<'de> Visitor<'de> for FlatKeySeed<'_, '_> {
    type Value = ();

    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.write_str("an object key")
    }

    fn visit_borrowed_str<E: serde::de::Error>(self, key: &'de str) -> Result<(), E> {
        self.write(key)
    }

    fn visit_str<E: serde::de::Error>(self, key: &str) -> Result<(), E> {
        self.write(key)
    }
}

struct FlatScalarSeed<'s> {
    bytes: &'s mut Vec<u8>,
}

impl FlatScalarSeed<'_> {
    fn write<E: serde::de::Error, T: serde::Serialize + ?Sized>(self, value: &T) -> Result<(), E> {
        serde_json::to_writer(self.bytes, value).map_err(E::custom)
    }
}

impl<'de> DeserializeSeed<'de> for FlatScalarSeed<'_> {
    type Value = ();

    fn deserialize<D: serde::Deserializer<'de>>(self, deserializer: D) -> Result<(), D::Error> {
        deserializer.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for FlatScalarSeed<'_> {
    type Value = ();

    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.write_str("a JSON scalar")
    }

    fn visit_bool<E: serde::de::Error>(self, value: bool) -> Result<(), E> {
        self.write(&value)
    }

    fn visit_i64<E: serde::de::Error>(self, value: i64) -> Result<(), E> {
        self.write(&value)
    }

    fn visit_u64<E: serde::de::Error>(self, value: u64) -> Result<(), E> {
        self.write(&value)
    }

    fn visit_f64<E: serde::de::Error>(self, value: f64) -> Result<(), E> {
        self.write(&value)
    }

    fn visit_borrowed_str<E: serde::de::Error>(self, value: &'de str) -> Result<(), E> {
        self.write(value)
    }

    fn visit_str<E: serde::de::Error>(self, value: &str) -> Result<(), E> {
        self.write(value)
    }

    fn visit_unit<E: serde::de::Error>(self) -> Result<(), E> {
        self.bytes.extend_from_slice(b"null");
        Ok(())
    }
}

fn can_write_json_directly(fields: &[FieldRef]) -> bool {
    can_write_object_directly(fields, 0)
}

fn can_write_object_directly(fields: &[FieldRef], depth: usize) -> bool {
    // Leave room for the result array and optional response wrapper below
    // serde_json's default recursion limit of 128 in the original parse path.
    if depth >= 64 {
        return false;
    }
    let mut names = HashSet::with_capacity(fields.len());
    fields.iter().all(|field| {
        names.insert(field.name()) && can_write_type_directly(field.data_type(), depth + 1)
    })
}

fn can_write_type_directly(data_type: &DataType, depth: usize) -> bool {
    if depth >= 64 {
        return false;
    }
    match data_type {
        DataType::Struct(fields) => can_write_object_directly(fields, depth),
        DataType::List(field)
        | DataType::ListView(field)
        | DataType::LargeList(field)
        | DataType::LargeListView(field)
        | DataType::FixedSizeList(field, _) => {
            can_write_type_directly(field.data_type(), depth + 1)
        }
        // Map keys come from the data and may repeat, even with a unique schema.
        DataType::Map(_, _) => false,
        // The old JSON round trip converts high precision decimal literals into
        // serde_json numbers, which can round values outside the integer range.
        DataType::Decimal32(_, _)
        | DataType::Decimal64(_, _)
        | DataType::Decimal128(_, _)
        | DataType::Decimal256(_, _) => false,
        // Preserve the old serde_json parser's floating point conversions.
        DataType::Float16 | DataType::Float32 | DataType::Float64 => false,
        // Arrow can include unescaped timezone quotes in out-of-range display
        // errors. The old parser turns such invalid JSON into an empty result.
        DataType::Timestamp(_, Some(_)) => false,
        DataType::Dictionary(_, values) => can_write_type_directly(values, depth + 1),
        DataType::RunEndEncoded(run_ends, values) => {
            can_write_type_directly(run_ends.data_type(), depth + 1)
                && can_write_type_directly(values.data_type(), depth + 1)
        }
        DataType::Union(fields, _) => fields
            .iter()
            .all(|(_, field)| can_write_type_directly(field.data_type(), depth + 1)),
        _ => true,
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use arrow_array::{
        ArrayRef, BooleanArray, Decimal128Array, Float16Array, Float32Array, Float64Array,
        Int8Array, Int16Array, Int32Array, Int64Array, LargeStringArray, ListArray, NullArray,
        RecordBatch, RecordBatchOptions, StringArray, StringViewArray, StructArray,
        TimestampMicrosecondArray, TimestampMillisecondArray, TimestampNanosecondArray,
        TimestampSecondArray, UInt8Array, UInt16Array, UInt32Array, UInt64Array, types::Int64Type,
    };
    use arrow_schema::{DataType, Field, Schema};

    use super::QueryResponse;

    fn assert_json_equivalent(records: Vec<arrow_array::RecordBatch>, fields: Vec<String>) {
        for fill_null in [false, true] {
            for with_fields in [false, true] {
                let response = QueryResponse {
                    records: records.clone(),
                    fields: fields.clone(),
                    fill_null,
                    with_fields,
                };
                let expected_bytes = serde_json::to_vec(&response.to_json().unwrap()).unwrap();
                let bytes = response.to_json_bytes().unwrap();
                let expected: serde_json::Value = serde_json::from_slice(&expected_bytes).unwrap();
                let actual: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
                assert_eq!(
                    actual, expected,
                    "fill_null={fill_null}, with_fields={with_fields}"
                );
                assert_eq!(bytes, expected_bytes);
            }
        }
    }

    #[test]
    fn json_bytes_preserve_scalar_types_nulls_and_batch_order() {
        let batch = arrow_array::RecordBatch::try_from_iter(vec![
            (
                "text",
                Arc::new(StringArray::from(vec![Some("quote\"\n雪"), None])) as ArrayRef,
            ),
            (
                "integer",
                Arc::new(Int64Array::from(vec![i64::MIN, i64::MAX])) as ArrayRef,
            ),
            (
                "unsigned",
                Arc::new(UInt64Array::from(vec![0, u64::MAX])) as ArrayRef,
            ),
            (
                "flag",
                Arc::new(BooleanArray::from(vec![Some(true), None])) as ArrayRef,
            ),
            (
                "timestamp",
                Arc::new(TimestampMillisecondArray::from(vec![
                    Some(1_700_000_000_123),
                    None,
                ])) as ArrayRef,
            ),
        ])
        .unwrap();
        let fields = batch
            .schema()
            .fields()
            .iter()
            .map(|f| f.name().clone())
            .collect();
        assert_json_equivalent(vec![batch.slice(0, 1), batch.slice(1, 1)], fields);
    }

    #[test]
    fn json_bytes_preserve_decimal_number_conversion() {
        let batch = arrow_array::RecordBatch::try_from_iter(vec![(
            "decimal",
            Arc::new(
                Decimal128Array::from(vec![Some(12345), Some(i128::MAX / 100), None])
                    .with_precision_and_scale(38, 0)
                    .unwrap(),
            ) as ArrayRef,
        )])
        .unwrap();
        assert_json_equivalent(vec![batch], vec!["decimal".into()]);
    }

    #[test]
    fn json_bytes_preserve_nonfinite_and_large_float_conversion() {
        let batch = arrow_array::RecordBatch::try_from_iter(vec![
            ("half", Arc::new(Float16Array::new_null(6)) as ArrayRef),
            (
                "single",
                Arc::new(Float32Array::from(vec![
                    f32::MIN_POSITIVE,
                    f32::MAX,
                    f32::INFINITY,
                    f32::NAN,
                    -0.0,
                    1.2345678,
                ])) as ArrayRef,
            ),
            (
                "double",
                Arc::new(Float64Array::from(vec![
                    f64::MIN_POSITIVE,
                    f64::MAX,
                    f64::INFINITY,
                    f64::NAN,
                    -0.0,
                    1.2345678901234567,
                ])) as ArrayRef,
            ),
        ])
        .unwrap();
        // Separate batches also check each value without another number's parse
        // error hiding its conversion behavior.
        for index in 0..batch.num_rows() {
            assert_json_equivalent(
                vec![batch.slice(index, 1)],
                vec!["half".into(), "single".into(), "double".into()],
            );
        }
    }

    #[test]
    fn flat_json_bytes_match_legacy_float_values_and_escaped_strings() {
        // Cover many exponents and mantissas, including values for which
        // serde's parser does not preserve the input float's original bits.
        let mut bits = 0x9e37_79b9_7f4a_7c15_u64;
        for chunk in 0..32 {
            let mut floats = Vec::new();
            let mut strings = Vec::new();
            for index in 0..32 {
                bits ^= bits << 13;
                bits ^= bits >> 7;
                bits ^= bits << 17;
                // Keep a broad exponent range safely below overflow and above
                // subnormal limits. Extreme values have separate parity tests.
                let exponent = 64 + ((bits >> 52) & 0x7ff) % 1920;
                let finite_bits = (bits & 0x800f_ffff_ffff_ffff) | (exponent << 52);
                floats.push((index % 7 != 0).then(|| f64::from_bits(finite_bits)));
                strings.push(match index % 4 {
                    0 => Some("plain borrowed string"),
                    1 => Some("quote\"\\\n\t雪\u{0000}"),
                    2 => Some(""),
                    _ => None,
                });
            }
            let batch = RecordBatch::try_from_iter(vec![
                (
                    "float \"\\\n雪",
                    Arc::new(Float64Array::from(floats)) as ArrayRef,
                ),
                ("text", Arc::new(StringArray::from(strings)) as ArrayRef),
            ])
            .unwrap();
            let legacy = QueryResponse {
                records: vec![batch.clone()],
                fields: Vec::new(),
                fill_null: false,
                with_fields: false,
            }
            .to_json()
            .unwrap();
            assert_eq!(legacy.as_array().map(Vec::len), Some(32), "chunk {chunk}");
            assert_json_equivalent(
                vec![batch.slice(0, 13), batch.slice(13, 19)],
                vec![
                    "float \"\\\n雪".into(),
                    "text".into(),
                    format!("missing_{chunk}"),
                ],
            );
        }
    }

    #[test]
    fn flat_json_null_fields_append_in_requested_order_without_duplicate_keys() {
        let batch = RecordBatch::try_from_iter(vec![
            (
                "zeta",
                Arc::new(StringArray::from(vec![None, Some("last")])) as ArrayRef,
            ),
            (
                "alpha",
                Arc::new(StringArray::from(vec![Some("first"), None])) as ArrayRef,
            ),
            (
                "escaped\"key",
                Arc::new(StringArray::from(vec![Some("value"), None])) as ArrayRef,
            ),
        ])
        .unwrap();
        assert_json_equivalent(
            vec![batch],
            vec![
                "missing".into(),
                "zeta".into(),
                "alpha".into(),
                "missing".into(),
                "escaped\"key".into(),
            ],
        );
    }

    #[test]
    fn flat_json_parse_errors_discard_all_rows_and_preserve_the_fields_wrapper() {
        for with_fields in [false, true] {
            let response = QueryResponse {
                records: Vec::new(),
                fields: vec!["value".into()],
                fill_null: true,
                with_fields,
            };
            let expected = serde_json::to_vec(&response.to_json().unwrap()).unwrap();
            for invalid in [
                b"[{\"value\":1.25},{\"value\":]".as_slice(),
                b"[{\"value\":1.25}] trailing".as_slice(),
                b"{\"value\":1.25}".as_slice(),
            ] {
                assert_eq!(response.transcode_flat_records(invalid).unwrap(), expected);
            }
        }
    }

    #[test]
    fn json_bytes_preserve_out_of_range_timezone_result() {
        let batch = arrow_array::RecordBatch::try_from_iter(vec![(
            "timestamp",
            Arc::new(TimestampMillisecondArray::from(vec![i64::MAX]).with_timezone("UTC"))
                as ArrayRef,
        )])
        .unwrap();
        let response = QueryResponse {
            records: vec![batch.clone()],
            fields: vec!["timestamp".into()],
            fill_null: false,
            with_fields: false,
        };
        assert_eq!(response.to_json().unwrap(), serde_json::json!([]));
        assert_eq!(response.to_json_bytes().unwrap(), b"[]");
        assert_json_equivalent(vec![batch], vec!["timestamp".into()]);
    }

    #[test]
    fn json_bytes_preserve_nested_json_recursion_limit() {
        let mut nested = Arc::new(StringArray::from(vec!["leaf"])) as ArrayRef;
        for _ in 0..130 {
            nested = Arc::new(StructArray::from(vec![(
                Arc::new(Field::new("child", nested.data_type().clone(), true)),
                nested,
            )]));
        }
        let batch = arrow_array::RecordBatch::try_from_iter(vec![("nested", nested)]).unwrap();
        let response = QueryResponse {
            records: vec![batch.clone()],
            fields: vec!["nested".into()],
            fill_null: false,
            with_fields: false,
        };
        assert_eq!(response.to_json().unwrap(), serde_json::json!([]));
        assert_eq!(response.to_json_bytes().unwrap(), b"[]");
        assert_json_equivalent(vec![batch], vec!["nested".into()]);
    }

    #[test]
    fn json_bytes_preserve_nested_null_behavior() {
        let nested = StructArray::from(vec![(
            Arc::new(Field::new("child", DataType::Utf8, true)),
            Arc::new(StringArray::from(vec![Some("value"), None])) as ArrayRef,
        )]);
        let list = ListArray::from_iter_primitive::<Int64Type, _, _>(vec![
            Some(vec![Some(1), None]),
            None,
        ]);
        let batch = arrow_array::RecordBatch::try_from_iter(vec![
            ("nested", Arc::new(nested) as ArrayRef),
            ("list", Arc::new(list) as ArrayRef),
        ])
        .unwrap();
        assert_json_equivalent(vec![batch.clone()], vec!["nested".into(), "list".into()]);
        // Streaming batches currently pass no field names, including for fill_null=true.
        assert_json_equivalent(vec![batch], Vec::new());
    }

    #[test]
    fn json_bytes_preserve_empty_results_and_duplicate_columns() {
        assert_json_equivalent(Vec::new(), vec!["value".into()]);
        assert_json_equivalent(
            vec![arrow_array::RecordBatch::new_empty(Arc::new(
                Schema::empty(),
            ))],
            Vec::new(),
        );
        let batch = arrow_array::RecordBatch::try_new(
            Arc::new(Schema::new(vec![
                Field::new("same", DataType::Int64, false),
                Field::new("same", DataType::Int64, false),
            ])),
            vec![
                Arc::new(Int64Array::from(vec![1])),
                Arc::new(Int64Array::from(vec![2])),
            ],
        )
        .unwrap();
        assert_json_equivalent(vec![batch], vec!["same".into(), "same".into()]);
    }

    /// Compare the typed writer with the Arrow JSON document transcode it
    /// replaces, and the public response with the original Value conversion.
    fn assert_flat_matches_legacy(records: Vec<RecordBatch>, fields: Vec<String>) {
        for fill_null in [false, true] {
            for with_fields in [false, true] {
                let response = QueryResponse {
                    records: records.clone(),
                    fields: fields.clone(),
                    fill_null,
                    with_fields,
                };
                let context = format!("fill_null={fill_null}, with_fields={with_fields}");
                let legacy = response.transcode_arrow_json().unwrap();
                let typed = response
                    .write_flat_records()
                    .unwrap()
                    .unwrap_or_else(|| panic!("typed writer fell back, {context}"));
                assert_eq!(
                    String::from_utf8_lossy(&typed),
                    String::from_utf8_lossy(&legacy),
                    "{context}"
                );
                assert_eq!(typed, legacy, "{context}");
                assert!(
                    typed.capacity() - typed.len() <= typed.len() / 4,
                    "{context}: capacity {} for {} bytes",
                    typed.capacity(),
                    typed.len()
                );
                let expected = serde_json::to_vec(&response.to_json().unwrap()).unwrap();
                assert_eq!(response.to_json_bytes().unwrap(), expected, "{context}");
            }
        }
    }

    fn next_bits(bits: &mut u64) -> u64 {
        *bits ^= *bits << 13;
        *bits ^= *bits >> 7;
        *bits ^= *bits << 17;
        *bits
    }

    /// The measured wide query: the benchmark's 32 projected fields arrive as
    /// 17 Float64 and 15 Utf8 columns.
    fn wide_fixture_batch(rows: usize, payload: usize, null_every: usize) -> RecordBatch {
        let mut columns: Vec<(String, ArrayRef)> = Vec::new();
        let mixed = |seq: usize| (seq as u64 * 1_103_515_245 + 12_345) & 0x7fff_ffff;
        let number = |name: &str, value: &dyn Fn(usize) -> f64| -> (String, ArrayRef) {
            let values = (0..rows)
                .map(|seq| (null_every == 0 || seq % null_every != 3).then(|| value(seq)))
                .collect::<Vec<_>>();
            (name.into(), Arc::new(Float64Array::from(values)))
        };
        let text = |name: &str, value: &dyn Fn(usize) -> String| -> (String, ArrayRef) {
            let values = (0..rows)
                .map(|seq| (null_every == 0 || seq % null_every != 5).then(|| value(seq)))
                .collect::<Vec<_>>();
            (name.into(), Arc::new(StringArray::from(values)))
        };
        columns.push(number("seq", &|seq| seq as f64));
        columns.push(text("tenant", &|seq| format!("tenant-{:02}", seq % 16)));
        columns.push(text("service", &|seq| format!("service-{:02}", seq % 8)));
        columns.push(number("status", &|seq| {
            if seq % 20 == 0 { 500.0 } else { 200.0 }
        }));
        columns.push(number("duration_ms", &|seq| (mixed(seq) % 10_000) as f64));
        columns.push(number("bytes", &|seq| (128 + mixed(seq) % 65_536) as f64));
        columns.push(number("event_offset_ms", &|seq| (seq * 100) as f64));
        columns.push(text("message", &|seq| {
            format!("request-{:08x} {}", mixed(seq), "x".repeat(payload))
        }));
        for index in 8..32 {
            let name = format!("extra_{index:03}");
            columns.push(if index % 2 == 1 {
                number(&name, &move |seq| (mixed(seq) + index as u64) as f64)
            } else {
                text(&name, &move |seq| {
                    format!("value-{:02}", (mixed(seq) + index as u64) % 97)
                })
            });
        }
        RecordBatch::try_from_iter(columns).unwrap()
    }

    #[test]
    fn typed_flat_writer_matches_legacy_for_wide_fixture() {
        let batch = wide_fixture_batch(300, 64, 7);
        let mut fields = batch
            .schema()
            .fields()
            .iter()
            .map(|field| field.name().clone())
            .collect::<Vec<_>>();
        fields.insert(3, "missing \"\n".into());
        fields.push("seq".into());
        // Empty and sliced batches keep row separators and sizing aligned.
        assert_flat_matches_legacy(
            vec![
                batch.slice(0, 10),
                batch.slice(10, 0),
                batch.slice(10, 200),
                batch.slice(210, 90),
            ],
            fields,
        );
        // Without null values or extra requested fields.
        let dense = wide_fixture_batch(130, 16, 0);
        assert_flat_matches_legacy(vec![dense], Vec::new());
    }

    #[test]
    fn typed_flat_writer_matches_legacy_for_float_bit_patterns() {
        let mut bits = 0x9e37_79b9_7f4a_7c15_u64;
        let mut doubles = vec![
            f64::MAX,
            f64::MIN,
            f64::MIN_POSITIVE,
            f64::from_bits(1),
            f64::from_bits(0x000f_ffff_ffff_ffff),
            f64::EPSILON,
            f64::NAN,
            f64::INFINITY,
            f64::NEG_INFINITY,
            0.0,
            -0.0,
            1.0,
            0.1,
            1e15,
            1e16,
            1e21,
            1e22,
            1e23,
            9_007_199_254_740_993.0,
            -1.5e-300,
        ];
        let mut singles = vec![
            f32::MAX,
            f32::MIN,
            f32::MIN_POSITIVE,
            f32::from_bits(1),
            f32::NAN,
            f32::INFINITY,
            -0.0,
            1.2345678,
            16_777_217.0,
        ];
        for k in 0..64 {
            doubles.push(f64::from_bits(f64::MAX.to_bits() - k));
        }
        while doubles.len() < 4096 {
            let value = f64::from_bits(next_bits(&mut bits));
            doubles.push(value);
            singles.push(f32::from_bits(next_bits(&mut bits) as u32));
        }
        singles.resize(doubles.len(), 0.5);
        let singles = Arc::new(Float32Array::from(singles)) as ArrayRef;
        let halves = arrow::compute::cast(&singles, &DataType::Float16).unwrap();
        let batch = RecordBatch::try_from_iter(vec![
            ("double", Arc::new(Float64Array::from(doubles)) as ArrayRef),
            ("single", singles),
            ("half", halves),
        ])
        .unwrap();
        assert_flat_matches_legacy(
            vec![batch.slice(0, 1000), batch.slice(1000, 3096)],
            vec!["half".into(), "absent".into()],
        );
    }

    #[test]
    fn typed_flat_writer_matches_legacy_for_all_flat_types() {
        let strings = vec![
            Some(""),
            Some("quote\" backslash\\ slash/"),
            Some("\u{0000}\u{0001}\u{0008}\u{0009}\u{000a}\u{000c}\u{000d}\u{001f}\u{007f}"),
            Some("\u{2028}\u{2029} 雪 😀 \u{fffd}"),
            Some("a string longer than twelve bytes for views"),
            None,
            Some("short"),
        ];
        let rows = strings.len();
        let timestamps = vec![
            Some(1_700_000_000_123),
            Some(i64::MAX),
            Some(i64::MIN),
            Some(-1),
            Some(0),
            None,
            Some(253_402_300_800_000),
        ];
        let batch = RecordBatch::try_from_iter(vec![
            ("null", Arc::new(NullArray::new(rows)) as ArrayRef),
            (
                "flag",
                Arc::new(BooleanArray::from(vec![
                    Some(true),
                    Some(false),
                    None,
                    Some(true),
                    Some(false),
                    Some(true),
                    None,
                ])) as ArrayRef,
            ),
            (
                "i8",
                Arc::new(Int8Array::from(vec![i8::MIN, i8::MAX, 0, -1, 1, 2, 3])) as ArrayRef,
            ),
            (
                "i16",
                Arc::new(Int16Array::from(vec![i16::MIN, i16::MAX, 0, -1, 1, 2, 3])) as ArrayRef,
            ),
            (
                "i32",
                Arc::new(Int32Array::from(vec![i32::MIN, i32::MAX, 0, -1, 1, 2, 3])) as ArrayRef,
            ),
            (
                "i64",
                Arc::new(Int64Array::from(vec![
                    Some(i64::MIN),
                    Some(i64::MAX),
                    Some(0),
                    None,
                    Some(-1),
                    Some(1),
                    Some(10),
                ])) as ArrayRef,
            ),
            (
                "u8",
                Arc::new(UInt8Array::from(vec![0, u8::MAX, 1, 2, 3, 4, 5])) as ArrayRef,
            ),
            (
                "u16",
                Arc::new(UInt16Array::from(vec![0, u16::MAX, 1, 2, 3, 4, 5])) as ArrayRef,
            ),
            (
                "u32",
                Arc::new(UInt32Array::from(vec![0, u32::MAX, 1, 2, 3, 4, 5])) as ArrayRef,
            ),
            (
                "u64",
                Arc::new(UInt64Array::from(vec![0, u64::MAX, 1, 2, 3, 4, 5])) as ArrayRef,
            ),
            (
                "utf8",
                Arc::new(StringArray::from(strings.clone())) as ArrayRef,
            ),
            (
                "large \"utf8\"\n",
                Arc::new(LargeStringArray::from(strings.clone())) as ArrayRef,
            ),
            ("view", Arc::new(StringViewArray::from(strings)) as ArrayRef),
            (
                "ts_s",
                Arc::new(TimestampSecondArray::from(timestamps.clone())) as ArrayRef,
            ),
            (
                "ts_ms",
                Arc::new(TimestampMillisecondArray::from(timestamps.clone())) as ArrayRef,
            ),
            (
                "ts_us",
                Arc::new(TimestampMicrosecondArray::from(timestamps.clone())) as ArrayRef,
            ),
            (
                "ts_ns",
                Arc::new(TimestampNanosecondArray::from(timestamps)) as ArrayRef,
            ),
        ])
        .unwrap();
        let fields = vec!["null".into(), "i64".into(), "view".into(), "other".into()];
        assert_flat_matches_legacy(vec![batch.clone()], fields.clone());
        for index in 0..rows {
            assert_flat_matches_legacy(vec![batch.slice(index, 1)], fields.clone());
        }
    }

    #[test]
    fn typed_flat_writer_matches_legacy_for_empty_and_columnless_batches() {
        assert_flat_matches_legacy(Vec::new(), vec!["value".into()]);
        let columnless = RecordBatch::try_new_with_options(
            Arc::new(Schema::empty()),
            Vec::new(),
            &RecordBatchOptions::new().with_row_count(Some(3)),
        )
        .unwrap();
        let empty = RecordBatch::new_empty(Arc::new(Schema::new(vec![Field::new(
            "value",
            DataType::Float64,
            true,
        )])));
        assert_flat_matches_legacy(
            vec![empty.clone(), columnless.clone(), empty],
            vec!["value".into()],
        );
        assert_flat_matches_legacy(vec![columnless], Vec::new());
    }

    #[test]
    fn typed_flat_writer_matches_legacy_for_uneven_row_sizes() {
        // Batches of very different row sizes, in both orders.
        let large = wide_fixture_batch(64, 4096, 0);
        let small = wide_fixture_batch(2000, 0, 3);
        assert_flat_matches_legacy(vec![large.clone(), small.clone()], Vec::new());
        assert_flat_matches_legacy(vec![small, large], vec!["absent".into()]);
    }
}
