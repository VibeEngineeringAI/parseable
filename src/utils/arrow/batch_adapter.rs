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

use datafusion::arrow::array::ArrayRef;
use datafusion::arrow::array::new_null_array;
use datafusion::arrow::datatypes::Schema;
use datafusion::arrow::record_batch::RecordBatch;

use std::collections::HashSet;
use std::sync::Arc;

// This function takes a new event's record batch and the
// current schema of the log stream. It returns a new record
// with nulls added to the fields that don't exist
// in the record batch (i.e. the event) but are present in the
// log stream schema.
// This is necessary because all the record batches in a log
// stream need to have all the fields.
pub fn adapt_batch(table_schema: Arc<Schema>, batch: &RecordBatch) -> RecordBatch {
    let batch_schema = &*batch.schema();

    // When the batch already has the table's field names in the same order,
    // and those names are unique, the name lookup below would pick column `i`
    // for field `i` and never build a null array. Hand the same columns to the
    // same `try_new` directly, which skips the O(fields²) lookup.
    if has_same_unique_field_names(&table_schema, batch_schema) {
        return RecordBatch::try_new(table_schema, batch.columns().to_vec()).unwrap();
    }

    let batch_cols = batch.columns().to_vec();

    let mut cols: Vec<ArrayRef> = Vec::with_capacity(table_schema.fields().len());
    for table_field in table_schema.fields() {
        if let Some((batch_idx, _)) = batch_schema.column_with_name(table_field.name().as_str()) {
            cols.push(Arc::clone(&batch_cols[batch_idx]));
        } else {
            cols.push(new_null_array(table_field.data_type(), batch.num_rows()))
        }
    }

    RecordBatch::try_new(table_schema, cols).unwrap()
}

// True when both schemas list the same field names in the same order and no
// name repeats. Types, nullability and metadata are not compared here; the
// caller's `try_new` checks the columns against the table schema exactly as the
// name-lookup path would.
fn has_same_unique_field_names(table_schema: &Schema, batch_schema: &Schema) -> bool {
    let table_fields = table_schema.fields();
    let batch_fields = batch_schema.fields();
    if table_fields.len() != batch_fields.len() {
        return false;
    }
    let same_names = table_fields
        .iter()
        .zip(batch_fields.iter())
        .all(|(t, b)| Arc::ptr_eq(t, b) || t.name() == b.name());
    if !same_names {
        return false;
    }
    // A repeated name makes the lookup path resolve every copy to its first
    // column, so leave that case to it.
    let mut seen = HashSet::with_capacity(table_fields.len());
    table_fields.iter().all(|f| seen.insert(f.name().as_str()))
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::panic::{AssertUnwindSafe, catch_unwind};

    use datafusion::arrow::array::{Array, Int32Array, Int64Array, StringArray};
    use datafusion::arrow::datatypes::{DataType, Field};
    use datafusion::arrow::record_batch::RecordBatchOptions;

    use super::*;

    // Verbatim copy of adapt_batch before the fast path, used as the oracle.
    fn legacy_adapt_batch(table_schema: Arc<Schema>, batch: &RecordBatch) -> RecordBatch {
        let batch_schema = &*batch.schema();
        let batch_cols = batch.columns().to_vec();

        let mut cols: Vec<ArrayRef> = Vec::with_capacity(table_schema.fields().len());
        for table_field in table_schema.fields() {
            if let Some((batch_idx, _)) = batch_schema.column_with_name(table_field.name().as_str())
            {
                cols.push(Arc::clone(&batch_cols[batch_idx]));
            } else {
                cols.push(new_null_array(table_field.data_type(), batch.num_rows()))
            }
        }

        RecordBatch::try_new(table_schema, cols).unwrap()
    }

    fn run(
        f: fn(Arc<Schema>, &RecordBatch) -> RecordBatch,
        schema: &Arc<Schema>,
        batch: &RecordBatch,
    ) -> Option<RecordBatch> {
        catch_unwind(AssertUnwindSafe(|| f(schema.clone(), batch))).ok()
    }

    // Both versions must panic together, or return the same Arc'd schema, the
    // same row count, and columns that are the same allocation exactly where
    // the legacy output reused an input column (equal by value otherwise).
    fn assert_matches_legacy(schema: &Arc<Schema>, batch: &RecordBatch) -> Option<RecordBatch> {
        let new = run(adapt_batch, schema, batch);
        let old = run(legacy_adapt_batch, schema, batch);
        let (new, old) = match (new, old) {
            (None, None) => return None,
            (Some(new), Some(old)) => (new, old),
            (new, old) => panic!(
                "panic mismatch: new ok={} legacy ok={}",
                new.is_some(),
                old.is_some()
            ),
        };
        assert!(Arc::ptr_eq(&new.schema(), schema));
        assert!(Arc::ptr_eq(&old.schema(), schema));
        assert_eq!(new.num_rows(), old.num_rows());
        assert_eq!(new.num_columns(), old.num_columns());
        for (n, o) in new.columns().iter().zip(old.columns()) {
            let old_reused = batch.columns().iter().any(|c| Arc::ptr_eq(c, o));
            if old_reused {
                assert!(
                    Arc::ptr_eq(n, o),
                    "legacy reused a column the new path did not"
                );
            } else {
                assert_eq!(n.as_ref(), o.as_ref());
                assert_eq!(n.null_count(), n.len());
            }
        }
        Some(new)
    }

    fn int_field(name: &str, nullable: bool) -> Field {
        Field::new(name, DataType::Int32, nullable)
    }

    fn int_col(values: &[Option<i32>]) -> ArrayRef {
        Arc::new(Int32Array::from(values.to_vec()))
    }

    fn batch_of(fields: Vec<Field>, cols: Vec<ArrayRef>) -> RecordBatch {
        RecordBatch::try_new(Arc::new(Schema::new(fields)), cols).unwrap()
    }

    #[test]
    fn same_schema_arc_reuses_columns_and_schema() {
        let schema = Arc::new(Schema::new(vec![
            int_field("a", true),
            int_field("b", true),
        ]));
        let batch = RecordBatch::try_new(
            schema.clone(),
            vec![int_col(&[Some(1), None]), int_col(&[Some(3), Some(4)])],
        )
        .unwrap();

        let out = assert_matches_legacy(&schema, &batch).unwrap();
        for (o, i) in out.columns().iter().zip(batch.columns()) {
            assert!(Arc::ptr_eq(o, i));
            assert_eq!(
                o.to_data().buffers()[0].as_ptr(),
                i.to_data().buffers()[0].as_ptr()
            );
        }
        assert_eq!(out, batch);
    }

    #[test]
    fn equal_schema_value_returns_table_schema_arc() {
        let fields = vec![int_field("a", true), int_field("b", false)];
        let table = Arc::new(Schema::new(fields.clone()));
        let batch = batch_of(fields, vec![int_col(&[Some(1)]), int_col(&[Some(2)])]);
        assert!(!Arc::ptr_eq(&batch.schema(), &table));

        let out = assert_matches_legacy(&table, &batch).unwrap();
        assert!(Arc::ptr_eq(&out.schema(), &table));
        assert!(Arc::ptr_eq(out.column(0), batch.column(0)));
        assert!(Arc::ptr_eq(out.column(1), batch.column(1)));
    }

    #[test]
    fn metadata_and_nullability_differences_take_table_schema() {
        let mut field_meta = HashMap::new();
        field_meta.insert("k".to_string(), "v".to_string());
        let mut schema_meta = HashMap::new();
        schema_meta.insert("s".to_string(), "t".to_string());
        let table = Arc::new(Schema::new_with_metadata(
            vec![
                int_field("a", true).with_metadata(field_meta),
                int_field("b", true),
            ],
            schema_meta,
        ));
        // Same names, different field metadata, schema metadata and nullability.
        let batch = batch_of(
            vec![int_field("a", false), int_field("b", true)],
            vec![int_col(&[Some(1)]), int_col(&[None])],
        );
        assert_ne!(*batch.schema(), *table);

        let out = assert_matches_legacy(&table, &batch).unwrap();
        assert_eq!(out.schema().metadata(), table.metadata());
        assert_eq!(out.schema().field(0).metadata(), table.field(0).metadata());
    }

    #[test]
    fn non_nullable_table_field_with_nulls_still_panics() {
        let table = Arc::new(Schema::new(vec![int_field("a", false)]));
        let batch = batch_of(vec![int_field("a", true)], vec![int_col(&[None])]);
        assert!(assert_matches_legacy(&table, &batch).is_none());
    }

    #[test]
    fn type_mismatch_with_same_names_still_panics() {
        let table = Arc::new(Schema::new(vec![Field::new("a", DataType::Int64, true)]));
        let batch = batch_of(vec![int_field("a", true)], vec![int_col(&[Some(1)])]);
        assert!(assert_matches_legacy(&table, &batch).is_none());
    }

    #[test]
    fn zero_columns_still_panics() {
        let schema = Arc::new(Schema::empty());
        let batch = RecordBatch::try_new_with_options(
            schema.clone(),
            vec![],
            &RecordBatchOptions::new().with_row_count(Some(3)),
        )
        .unwrap();
        assert!(assert_matches_legacy(&schema, &batch).is_none());
    }

    #[test]
    fn zero_rows_same_schema() {
        let schema = Arc::new(Schema::new(vec![int_field("a", true)]));
        let batch = RecordBatch::new_empty(schema.clone());
        let out = assert_matches_legacy(&schema, &batch).unwrap();
        assert_eq!(out.num_rows(), 0);
        assert!(Arc::ptr_eq(out.column(0), batch.column(0)));
    }

    #[test]
    fn reordered_and_missing_fields_fall_back() {
        let table = Arc::new(Schema::new(vec![
            int_field("a", true),
            Field::new("s", DataType::Utf8, true),
            int_field("b", true),
        ]));
        let reordered = batch_of(
            vec![
                int_field("b", true),
                Field::new("s", DataType::Utf8, true),
                int_field("a", true),
            ],
            vec![
                int_col(&[Some(2)]),
                Arc::new(StringArray::from(vec!["x"])),
                int_col(&[Some(1)]),
            ],
        );
        let out = assert_matches_legacy(&table, &reordered).unwrap();
        assert!(Arc::ptr_eq(out.column(0), reordered.column(2)));
        assert!(Arc::ptr_eq(out.column(2), reordered.column(0)));

        let missing = batch_of(vec![int_field("b", true)], vec![int_col(&[Some(2), None])]);
        let out = assert_matches_legacy(&table, &missing).unwrap();
        assert_eq!(out.column(0).null_count(), 2);
        assert_eq!(out.column(1).null_count(), 2);
        assert!(Arc::ptr_eq(out.column(2), missing.column(0)));
    }

    #[test]
    fn duplicate_names_use_first_column_like_legacy() {
        let fields = vec![int_field("a", true), int_field("a", true)];
        let table = Arc::new(Schema::new(fields.clone()));
        let batch = batch_of(fields, vec![int_col(&[Some(1)]), int_col(&[Some(2)])]);

        let out = assert_matches_legacy(&table, &batch).unwrap();
        assert!(Arc::ptr_eq(out.column(0), batch.column(0)));
        assert!(Arc::ptr_eq(out.column(1), batch.column(0)));
    }

    #[test]
    fn duplicate_names_with_different_types_still_panic() {
        let table = Arc::new(Schema::new(vec![
            int_field("a", true),
            Field::new("a", DataType::Int64, true),
        ]));
        let batch = batch_of(
            vec![int_field("a", true), Field::new("a", DataType::Int64, true)],
            vec![int_col(&[Some(1)]), Arc::new(Int64Array::from(vec![2]))],
        );
        assert!(assert_matches_legacy(&table, &batch).is_none());
    }

    // Random table/batch schema pairs: subsets, reorders, extra fields,
    // duplicate names, type and nullability changes, and metadata.
    #[test]
    fn random_schemas_match_legacy() {
        let mut state = 0x9e37_79b9_7f4a_7c15u64;
        let mut next = move |n: u64| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state % n
        };
        let names = ["a", "b", "c", "d", "e"];
        let field = |name: &str, kind: u64, nullable: bool, meta: bool| {
            let dt = if kind == 0 {
                DataType::Int32
            } else {
                DataType::Int64
            };
            let f = Field::new(name, dt, nullable);
            if meta {
                f.with_metadata(HashMap::from([("m".to_string(), "1".to_string())]))
            } else {
                f
            }
        };

        let mut fast = 0;
        for _ in 0..5000 {
            let rows = next(4) as usize;
            let width = 1 + next(5) as usize;
            let mut table_fields = Vec::new();
            for _ in 0..width {
                let name = names[next(names.len() as u64) as usize];
                table_fields.push(field(name, next(5) / 4, next(4) != 0, next(3) == 0));
            }
            let table = Arc::new(Schema::new(table_fields.clone()));

            let mut batch_fields = match next(3) {
                // Same field list, maybe with a perturbed field.
                0 | 1 => table_fields.clone(),
                // Unrelated field list.
                _ => (0..1 + next(5))
                    .map(|_| {
                        let name = names[next(names.len() as u64) as usize];
                        field(name, next(5) / 4, true, false)
                    })
                    .collect(),
            };
            if next(3) == 0 {
                let i = next(batch_fields.len() as u64) as usize;
                let f = &batch_fields[i];
                batch_fields[i] = match next(4) {
                    0 => field(f.name(), next(2), f.is_nullable(), false),
                    1 => f.clone().with_nullable(!f.is_nullable()),
                    2 => field(names[next(5) as usize], 0, true, false),
                    _ => f.clone().with_metadata(HashMap::new()),
                };
            }
            if next(4) == 0 {
                let i = next(batch_fields.len() as u64) as usize;
                let j = next(batch_fields.len() as u64) as usize;
                batch_fields.swap(i, j);
            }

            let cols: Vec<ArrayRef> = batch_fields
                .iter()
                .map(|f| -> ArrayRef {
                    let with_nulls = f.is_nullable() && next(2) == 0;
                    let v = |i: usize| (!with_nulls || i.is_multiple_of(2)).then_some(i as i32);
                    match f.data_type() {
                        DataType::Int32 => Arc::new(Int32Array::from_iter((0..rows).map(v))),
                        _ => Arc::new(Int64Array::from_iter(
                            (0..rows).map(|i| v(i).map(i64::from)),
                        )),
                    }
                })
                .collect();
            let batch = batch_of(batch_fields, cols);

            if has_same_unique_field_names(&table, &batch.schema()) {
                fast += 1;
            }
            assert_matches_legacy(&table, &batch);
        }
        assert!(fast > 500, "fast path exercised only {fast} times");
    }
}
