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

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

/// Reuses name resolution for adjacent batches with the same source layout.
/// The target schema is fixed for this adapter's capture (or bounded push).
/// Only the last layout is retained, independently of the number of batches.
pub(crate) struct BatchAdapter {
    table_schema: Arc<Schema>,
    last_plan: Option<AdaptationPlan>,
    #[cfg(test)]
    plan_builds: usize,
}

struct AdaptationPlan {
    // Retain the Fields allocation whose identity we compare. A naked pointer
    // could otherwise alias a later layout after its allocation was freed.
    source_schema: Arc<Schema>,
    columns: ColumnMapping,
}

enum ColumnMapping {
    Identity,
    Indices(Vec<Option<usize>>),
}

impl BatchAdapter {
    pub(crate) fn new(table_schema: Arc<Schema>) -> Self {
        Self {
            table_schema,
            last_plan: None,
            #[cfg(test)]
            plan_builds: 0,
        }
    }

    pub(crate) fn schema(&self) -> &Arc<Schema> {
        &self.table_schema
    }

    #[cfg(test)]
    pub(crate) fn plan_builds(&self) -> usize {
        self.plan_builds
    }

    pub(crate) fn adapt(&mut self, batch: &RecordBatch) -> RecordBatch {
        let source_schema = batch.schema_ref();
        let same_layout = self.last_plan.as_ref().is_some_and(|plan| {
            // Arrow Fields is an immutable Arc<[FieldRef]>. Schema clones
            // share it, even when their Schema Arcs or metadata differ.
            let previous = plan.source_schema.fields();
            let current = source_schema.fields();
            previous.len() == current.len() && previous.as_ptr() == current.as_ptr()
        });
        if !same_layout {
            #[cfg(test)]
            {
                self.plan_builds += 1;
            }
            let mut first_index = HashMap::with_capacity(source_schema.fields().len());
            for (index, field) in source_schema.fields().iter().enumerate() {
                first_index.entry(field.name().as_str()).or_insert(index);
            }
            let indices: Vec<_> = self
                .table_schema
                .fields()
                .iter()
                .map(|field| first_index.get(field.name().as_str()).copied())
                .collect();
            // Prove positional equivalence from first-occurrence resolution.
            // Schema pointer/value equality alone is insufficient for duplicates.
            let identity = indices.len() == source_schema.fields().len()
                && indices.iter().enumerate().all(|(i, idx)| *idx == Some(i));
            self.last_plan = Some(AdaptationPlan {
                source_schema: Arc::clone(source_schema),
                columns: if identity {
                    ColumnMapping::Identity
                } else {
                    ColumnMapping::Indices(indices)
                },
            });
        }

        let cols = match &self.last_plan.as_ref().unwrap().columns {
            ColumnMapping::Identity => batch.columns().to_vec(),
            ColumnMapping::Indices(indices) => indices
                .iter()
                .zip(self.table_schema.fields())
                .map(|(index, field)| match index {
                    Some(index) => Arc::clone(batch.column(*index)),
                    None => new_null_array(field.data_type(), batch.num_rows()),
                })
                .collect(),
        };
        // Cache only the mapping: every batch still validates its actual arrays
        // and receives fresh typed null arrays sized for its own row count.
        RecordBatch::try_new(Arc::clone(&self.table_schema), cols).unwrap()
    }
}

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

    // Arrow permits duplicate names. Match column_with_name's first occurrence
    // while resolving the source layout once, rather than scanning it for each
    // target field (quadratic work for reordered/wider query schemas).
    let mut first_index = HashMap::with_capacity(batch_schema.fields().len());
    for (index, field) in batch_schema.fields().iter().enumerate() {
        first_index.entry(field.name().as_str()).or_insert(index);
    }

    let mut cols: Vec<ArrayRef> = Vec::with_capacity(table_schema.fields().len());
    for table_field in table_schema.fields() {
        if let Some(&batch_idx) = first_index.get(table_field.name().as_str()) {
            cols.push(Arc::clone(batch.column(batch_idx)));
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

    use datafusion::arrow::array::{
        Array, Int32Array, Int64Array, StringArray, TimestampMillisecondArray,
    };
    use datafusion::arrow::datatypes::{DataType, Field, TimeUnit};
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
        assert_output_matches_legacy(new, schema, batch)
    }

    fn assert_plan_matches_legacy(
        adapter: &mut BatchAdapter,
        batch: &RecordBatch,
    ) -> Option<RecordBatch> {
        let new = catch_unwind(AssertUnwindSafe(|| adapter.adapt(batch))).ok();
        assert_output_matches_legacy(new, adapter.schema(), batch)
    }

    fn assert_output_matches_legacy(
        new: Option<RecordBatch>,
        schema: &Arc<Schema>,
        batch: &RecordBatch,
    ) -> Option<RecordBatch> {
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

    #[test]
    fn reordered_duplicates_and_missing_typed_nulls_match_legacy() {
        // A later duplicate has a different type and must never win the index.
        let batch = batch_of(
            vec![
                int_field("b", true),
                int_field("a", true),
                Field::new("a", DataType::Int64, true),
            ],
            vec![
                int_col(&[Some(20), Some(21)]),
                int_col(&[Some(10), None]),
                Arc::new(Int64Array::from(vec![30, 31])),
            ],
        );
        let table = Arc::new(Schema::new(vec![
            int_field("a", true),
            Field::new(
                "missing",
                DataType::Timestamp(TimeUnit::Millisecond, None),
                true,
            ),
            int_field("b", true),
            int_field("a", true),
        ]));
        assert!(!has_same_unique_field_names(&table, &batch.schema()));
        let out = assert_matches_legacy(&table, &batch).unwrap();
        assert!(Arc::ptr_eq(out.column(0), batch.column(1)));
        assert!(Arc::ptr_eq(out.column(3), batch.column(1)));
        assert_eq!(out.column(1).data_type(), table.field(1).data_type());
        assert_eq!(out.column(1).null_count(), 2);

        let empty = batch.slice(0, 0);
        assert_eq!(assert_matches_legacy(&table, &empty).unwrap().num_rows(), 0);
        let non_nullable = Arc::new(Schema::new(vec![Field::new(
            "missing",
            DataType::Int64,
            false,
        )]));
        assert!(assert_matches_legacy(&non_nullable, &batch).is_none());
    }

    #[test]
    fn planned_layout_reuses_schema_clones_with_fresh_nulls_for_each_rowcount() {
        let source = Arc::new(Schema::new(vec![
            int_field("b", true),
            int_field("a", true),
            Field::new("a", DataType::Int64, true),
        ]));
        let batch = RecordBatch::try_new(
            source.clone(),
            vec![
                int_col(&[Some(20), Some(21), Some(22)]),
                int_col(&[Some(10), None, Some(12)]),
                Arc::new(Int64Array::from(vec![30, 31, 32])),
            ],
        )
        .unwrap();
        let mut table = Schema::new(vec![
            int_field("a", true),
            Field::new(
                "missing",
                DataType::Timestamp(TimeUnit::Millisecond, None),
                true,
            ),
            int_field("b", true),
            int_field("a", true),
        ]);
        table.metadata.insert("target".into(), "kept".into());
        let mut adapter = BatchAdapter::new(Arc::new(table));
        let mut outputs = Vec::new();
        for rows in [3, 0, 1, 2, 3] {
            // Distinct Schema Arc, identical Fields backing allocation. Schema
            // metadata may change without changing the immutable source layout.
            let mut cloned = source.as_ref().clone();
            cloned.metadata.insert("rows".into(), rows.to_string());
            let cloned = Arc::new(cloned);
            assert!(!Arc::ptr_eq(&source, &cloned));
            assert_eq!(source.fields().as_ptr(), cloned.fields().as_ptr());
            let slice = batch.slice(0, rows);
            let input = RecordBatch::try_new(cloned, slice.columns().to_vec()).unwrap();
            let out = assert_plan_matches_legacy(&mut adapter, &input).unwrap();
            for previous in &outputs {
                assert!(!Arc::ptr_eq(out.column(1), previous));
            }
            outputs.push(out.column(1).clone());
            assert_eq!(adapter.plan_builds(), 1);
        }

        // Keeping the last source alive prevents freed-pointer reuse. Replacing
        // it releases that owner, so the cache retains only one source layout.
        let retained = Arc::downgrade(&adapter.last_plan.as_ref().unwrap().source_schema);
        drop(batch);
        drop(source);
        assert_eq!(retained.strong_count(), 1);
        let evolved = batch_of(
            vec![int_field("a", true), int_field("b", true)],
            vec![int_col(&[Some(41)]), int_col(&[Some(42)])],
        );
        assert_plan_matches_legacy(&mut adapter, &evolved).unwrap();
        assert_eq!(adapter.plan_builds(), 2);
        assert!(retained.upgrade().is_none());
    }

    #[test]
    fn planned_layout_changes_and_per_batch_validation_match_legacy() {
        let table = Arc::new(Schema::new(vec![
            int_field("a", true),
            int_field("b", false),
        ]));
        let mut adapter = BatchAdapter::new(table);
        let source = Arc::new(Schema::new(vec![
            int_field("b", true),
            int_field("a", true),
        ]));
        let valid = RecordBatch::try_new(
            source.clone(),
            vec![int_col(&[Some(2)]), int_col(&[Some(1)])],
        )
        .unwrap();
        assert_plan_matches_legacy(&mut adapter, &valid).unwrap();
        let invalid =
            RecordBatch::try_new(source, vec![int_col(&[None]), int_col(&[Some(1)])]).unwrap();
        assert!(assert_plan_matches_legacy(&mut adapter, &invalid).is_none());
        assert_eq!(adapter.plan_builds(), 1);

        // Equal names with a changed type are not a cache identity. Their
        // arrays must reach try_new and panic just as the legacy adapter does.
        let wrong_type = batch_of(
            vec![Field::new("b", DataType::Int64, true), int_field("a", true)],
            vec![Arc::new(Int64Array::from(vec![2])), int_col(&[Some(1)])],
        );
        assert!(assert_plan_matches_legacy(&mut adapter, &wrong_type).is_none());
        assert_eq!(adapter.plan_builds(), 2);
        assert_plan_matches_legacy(&mut adapter, &valid).unwrap();
        assert_eq!(adapter.plan_builds(), 3);

        let reordered = batch_of(
            vec![int_field("a", true), int_field("b", true)],
            vec![int_col(&[Some(11)]), int_col(&[Some(12)])],
        );
        assert_plan_matches_legacy(&mut adapter, &reordered).unwrap();
        assert_eq!(adapter.plan_builds(), 4);
        // Structurally equal schemas with separately allocated Fields safely
        // miss the identity cache; there is no names-only or global cache.
        let separate = batch_of(
            vec![int_field("a", true), int_field("b", true)],
            vec![int_col(&[Some(21)]), int_col(&[Some(22)])],
        );
        assert_plan_matches_legacy(&mut adapter, &separate).unwrap();
        assert_eq!(adapter.plan_builds(), 5);
    }

    #[test]
    fn planned_equal_duplicate_schemas_and_zero_columns_match_legacy() {
        for second_type in [DataType::Int32, DataType::Int64] {
            let schema = Arc::new(Schema::new(vec![
                int_field("a", true),
                Field::new("a", second_type.clone(), true),
            ]));
            let second: ArrayRef = match second_type {
                DataType::Int32 => int_col(&[Some(2)]),
                _ => Arc::new(Int64Array::from(vec![2])),
            };
            let batch =
                RecordBatch::try_new(schema.clone(), vec![int_col(&[Some(1)]), second]).unwrap();
            let mut adapter = BatchAdapter::new(schema);
            for _ in 0..2 {
                assert_plan_matches_legacy(&mut adapter, &batch);
            }
            assert_eq!(adapter.plan_builds(), 1);
        }

        let schema = Arc::new(Schema::empty());
        let mut adapter = BatchAdapter::new(schema.clone());
        for rows in [0, 3, 1] {
            let batch = RecordBatch::try_new_with_options(
                schema.clone(),
                vec![],
                &RecordBatchOptions::new().with_row_count(Some(rows)),
            )
            .unwrap();
            assert!(assert_plan_matches_legacy(&mut adapter, &batch).is_none());
        }
        assert_eq!(adapter.plan_builds(), 1);
    }

    #[test]
    fn wide_sorted_and_permuted_targets_match_legacy() {
        for width in [128, 512] {
            let mut fields = vec![Field::new(
                "p_timestamp",
                DataType::Timestamp(TimeUnit::Millisecond, None),
                true,
            )];
            fields.extend((0..width - 1).map(|i| int_field(&format!("f{i:03}"), true)));
            let mut cols: Vec<ArrayRef> = vec![Arc::new(TimestampMillisecondArray::from(vec![
                Some(1_700_000_000_123),
                None,
                Some(1_700_000_000_125),
            ]))];
            cols.extend((0..width - 1).map(|i| int_col(&[Some(i), None, Some(i + 1)])));
            let batch = batch_of(fields.clone(), cols);
            fields.sort_by(|a, b| a.name().cmp(b.name()));
            // Exercise production sorted order and full permutations, rather
            // than only swapping one pair in an otherwise aligned schema.
            for shift in [0, 1, width as usize / 2, width as usize - 1] {
                let mut target = fields.clone();
                target.rotate_left(shift);
                if shift % 2 == 1 {
                    target.reverse();
                }
                let table = Arc::new(Schema::new(target));
                assert!(!has_same_unique_field_names(&table, &batch.schema()));
                assert_matches_legacy(&table, &batch).unwrap();
                let mut adapter = BatchAdapter::new(table);
                for rows in [3, 0, 1, 3] {
                    assert_plan_matches_legacy(&mut adapter, &batch.slice(0, rows)).unwrap();
                }
                assert_eq!(adapter.plan_builds(), 1);
            }
        }
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
            let mut adapter = BatchAdapter::new(table);
            assert_plan_matches_legacy(&mut adapter, &batch);
            assert_plan_matches_legacy(&mut adapter, &batch.slice(0, 0));
            assert_plan_matches_legacy(&mut adapter, &batch);
            assert_eq!(adapter.plan_builds(), 1);
        }
        assert!(fast > 500, "fast path exercised only {fast} times");
    }
}
