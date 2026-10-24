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

use std::{
    collections::{HashMap, HashSet},
    fs::{self, File, OpenOptions},
    io::BufWriter,
    path::{Path, PathBuf},
    sync::Arc,
};

use arrow_array::RecordBatch;
use arrow_ipc::{
    CompressionType,
    writer::{IpcWriteOptions, StreamWriter},
};
use arrow_schema::Schema;
use arrow_select::concat::concat_batches;
use chrono::{DateTime, Utc};
use itertools::Itertools;
use once_cell::sync::Lazy;
use rand::distributions::{Alphanumeric, DistString};
use tracing::error;
use ulid::Ulid;

use crate::{
    parseable::{ARROW_FILE_EXTENSION, PART_FILE_EXTENSION},
    utils::{arrow::batch_adapter::BatchAdapter, time::TimeRange},
};

use super::StagingError;

const ENABLE_MEMORY_STAGING_VAR: &str = "ENABLE_MEMORY_STAGING";
pub static ENABLE_MEMORY_STAGING: Lazy<bool> = Lazy::new(|| {
    if let Ok(var) = std::env::var(ENABLE_MEMORY_STAGING_VAR)
        && let Ok(var) = var.parse::<bool>()
    {
        var
    } else {
        true
    }
});

const ONE_PARQUET_PER_ARROW_VAR: &str = "ONE_PARQUET_PER_ARROW";
static ONE_PARQUET_PER_ARROW: Lazy<bool> = Lazy::new(|| {
    if let Ok(var) = std::env::var(ONE_PARQUET_PER_ARROW_VAR)
        && let Ok(var) = var.parse::<bool>()
    {
        var
    } else {
        false
    }
});

// #[derive(Default)]
pub struct Writer {
    pub mem: Option<MemWriter<4096>>,
    pub disk: HashMap<String, DiskWriter>,
}

impl Default for Writer {
    fn default() -> Self {
        let mem = if *ENABLE_MEMORY_STAGING {
            Some(MemWriter::default())
        } else {
            None
        };
        Self {
            mem,
            disk: HashMap::default(),
        }
    }
}

impl Writer {
    /// Appends a batch to the writer for its schema/minute file.
    pub fn push_disk(
        &mut self,
        filename: String,
        rb: &RecordBatch,
        file_path: PathBuf,
        range: TimeRange,
    ) -> Result<(), StagingError> {
        self.push_disk_ref(&filename, rb, file_path, range)
    }

    #[cfg_attr(feature = "hotpath", hotpath::measure)]
    pub(crate) fn push_disk_ref(
        &mut self,
        filename: &str,
        rb: &RecordBatch,
        file_path: PathBuf,
        range: TimeRange,
    ) -> Result<(), StagingError> {
        match self.disk.get_mut(filename) {
            Some(writer) => writer.write(rb),
            None => {
                if let Some(parent) = file_path.parent() {
                    fs::create_dir_all(parent)?;
                }
                let mut writer = DiskWriter::try_new(file_path, rb.schema().as_ref(), range)?;
                writer.write(rb)?;
                self.disk.insert(filename.to_owned(), writer);
                Ok(())
            }
        }
    }

    /// Detaches completed disk writers and evicts their memory segments.
    /// Forced flushes also detach current writers; ownerless memory always expires.
    pub fn take_flushable_disk(&mut self, forced: bool) -> HashMap<String, DiskWriter> {
        self.take_flushable_disk_at(forced, Utc::now())
    }

    pub(crate) fn take_flushable_disk_at(
        &mut self,
        forced: bool,
        now: DateTime<Utc>,
    ) -> HashMap<String, DiskWriter> {
        let flushable_disk = self.split_flushable_disk(forced, now);
        self.compact_memory();
        flushable_disk
    }

    /// Detaches like `take_flushable_disk_at`, but keeps each detached writer's
    /// rows queryable as pending memory keyed by its part path. The caller must
    /// seal the writers and follow their files with `MemWriter::rekey_pending`
    /// until their rows are published in Parquet or discarded.
    pub(crate) fn detach_flushable_disk_at(
        &mut self,
        forced: bool,
        now: DateTime<Utc>,
    ) -> Vec<DiskWriter> {
        let flushable_disk = self.split_flushable_disk(forced, now);
        if let Some(mem) = self.mem.as_mut() {
            for (filename, writer) in &flushable_disk {
                if let Some(segment) = mem.segments.remove(filename) {
                    mem.pending
                        .entry(writer.path.clone())
                        .or_default()
                        .push(segment);
                }
            }
        }
        self.compact_memory();
        flushable_disk.into_values().collect()
    }

    /// Part files still owned by attached disk writers.
    pub(crate) fn active_part_paths(&self) -> HashSet<PathBuf> {
        self.disk
            .values()
            .map(|writer| writer.path().to_path_buf())
            .collect()
    }

    fn split_flushable_disk(
        &mut self,
        forced: bool,
        now: DateTime<Utc>,
    ) -> HashMap<String, DiskWriter> {
        let mut flushable_disk = HashMap::new();
        let old_disk = std::mem::take(&mut self.disk);
        for (filename, writer) in old_disk {
            if !forced && writer.range.contains(now) {
                self.disk.insert(filename, writer);
            } else {
                flushable_disk.insert(filename, writer);
            }
        }
        flushable_disk
    }

    fn compact_memory(&mut self) {
        if let Some(mem) = self.mem.as_mut() {
            // Use the selected writer keys, not a second clock/range check.
            // Query-only segments have no disk owner and expire at each flush.
            mem.clear_unsegmented();
            mem.segments
                .retain(|filename, _| self.disk.contains_key(filename));
            if mem.segments.is_empty() {
                // clear/retain alone keep the burst's bucket allocation alive.
                mem.segments = HashMap::new();
            } else if mem.segments.capacity()
                > mem.segments.len().saturating_mul(2).saturating_add(16)
            {
                // Rehash only sparse maps; move segment owners without copying Arrow data.
                mem.segments.shrink_to_fit();
            }
        }
    }
}

/// A detached part whose IPC stream is finished but not yet renamed.
pub(crate) struct SealedPart {
    pub(crate) part: PathBuf,
    pub(crate) arrow: PathBuf,
}

pub struct DiskWriter {
    inner: StreamWriter<BufWriter<File>>,
    path: PathBuf,
    range: TimeRange,
    // Set once `seal` has taken over finishing and renaming from Drop.
    sealed: bool,
}

impl DiskWriter {
    /// Try to create a file to stream arrows into
    pub fn try_new(
        path: impl Into<PathBuf>,
        schema: &Schema,
        range: TimeRange,
    ) -> Result<Self, StagingError> {
        let base = path.into();
        // ONE_PARQUET_PER_ARROW is a rudimentary way to ensure one parquet per arrow file
        let (file, path) = Self::create_part_file(&base, *ONE_PARQUET_PER_ARROW)?;
        let inner = StreamWriter::try_new_with_options(
            BufWriter::new(file),
            schema,
            IpcWriteOptions::default()
                .try_with_compression(Some(CompressionType::LZ4_FRAME))
                .unwrap(),
        )?;

        Ok(Self {
            inner,
            path,
            range,
            sealed: false,
        })
    }

    /// Exclusively creates a new `.arrows.part` file for `base`.
    ///
    /// Each part is owned by exactly one writer, and pending memory is keyed
    /// by it. A detached writer still owns its part until sealed, a part whose
    /// seal failed awaits startup recovery, and a late event for that writer key
    /// may open a new writer meanwhile. Truncating or sharing such a part would
    /// destroy acknowledged rows and alias their memory, so an occupied name
    /// gets a per-file ULID after `.data`, which keeps the same Parquet group.
    fn create_part_file(base: &Path, unique: bool) -> Result<(File, PathBuf), StagingError> {
        const MAX_ATTEMPTS: usize = 8;
        let mut unique = unique;
        let mut attempt = 0;
        loop {
            let mut path = base.to_path_buf();
            if unique {
                path.set_extension(Ulid::new().to_string());
                path.add_extension(ARROW_FILE_EXTENSION);
            }
            path.add_extension(PART_FILE_EXTENSION);

            match OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(file) => return Ok((file, path)),
                Err(err)
                    if err.kind() == std::io::ErrorKind::AlreadyExists
                        && attempt < MAX_ATTEMPTS =>
                {
                    unique = true;
                    attempt += 1;
                }
                Err(err) => return Err(err.into()),
            }
        }
    }

    /// Finishes the IPC stream and chooses its `.arrows` name without renaming,
    /// so callers can move memory ownership to that name before conversion can
    /// see it. On error the part file is left for startup recovery.
    pub(crate) fn seal(mut self) -> Result<SealedPart, (PathBuf, StagingError)> {
        self.sealed = true;
        let part = std::mem::take(&mut self.path);
        if let Err(err) = self.inner.finish() {
            return Err((part, StagingError::Arrow(err)));
        }
        let arrow = sealed_arrow_path(&part);
        Ok(SealedPart { part, arrow })
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    /// Returns whether this writer belongs to the current time range.
    pub fn is_current(&self) -> bool {
        self.range.contains(Utc::now())
    }

    /// Write a single recordbatch into file
    #[cfg_attr(feature = "hotpath", hotpath::measure)]
    pub fn write(&mut self, rb: &RecordBatch) -> Result<(), StagingError> {
        self.inner.write(rb).map_err(StagingError::Arrow)?;
        // A process crash does not run Drop, so do not leave the tail of an
        // acknowledged record batch only in BufWriter's userspace buffer.
        // The EOS marker can be recovered, but missing batch bytes cannot.
        self.inner.flush().map_err(StagingError::Arrow)?;
        Ok(())
    }
}

impl Drop for DiskWriter {
    /// Write the continuation bytes and mark the file as done, rename to `.data.arrows`
    fn drop(&mut self) {
        if self.sealed {
            return;
        }
        if let Err(err) = self.inner.finish() {
            error!("Couldn't finish arrow file {:?}, error = {err}", self.path);
            return;
        }

        let arrow_path = sealed_arrow_path(&self.path);
        if let Err(err) = std::fs::rename(&self.path, &arrow_path) {
            error!("Couldn't rename file {:?}, error = {err}", self.path);
        }
        tracing::info!("flushing {:?} due to drop", self.path);
    }
}

/// `.arrows.part` becomes `.arrows` while preserving a per-file ULID.
fn sealed_arrow_path(part: &Path) -> PathBuf {
    let mut arrow_path = part.with_extension("");
    // If file exists, append a random string before .date to avoid overwriting
    if arrow_path.exists() {
        let file_name = arrow_path.file_name().unwrap().to_string_lossy();
        let date_pos = file_name
            .find(".date")
            .expect("File name should contain .date");
        let random_suffix = Alphanumeric.sample_string(&mut rand::thread_rng(), 8);
        let new_name = format!("{}{}", random_suffix, &file_name[date_pos..]);
        arrow_path.set_file_name(new_name);
    }
    arrow_path
}

/// Structure to keep recordbatches in memory.
///
/// Any new schema is updated in the schema map.
/// Small recordbatches are coalesced through the mutable buffer. Oversized
/// inputs become bounded single-source read batches, including their tails.
#[derive(Debug)]
pub struct MemWriter<const N: usize> {
    // Private file-owned buffers preserve the existing public MemWriter shape.
    // Stream query callers use recordbatch_cloned to read every segment.
    segments: HashMap<String, MemWriter<N>>,
    // Segments of detached writers, keyed by the current path of the staging
    // file holding their rows: the part, then its `.arrows` name, then its
    // processing-directory name. Released only when that exact file is
    // published in Parquet or discarded, so a reused writer key or a colliding
    // physical name never releases another file's rows. These rows share the
    // ingested Arrow buffers. A failed conversion leaves its sources in a
    // processing directory, retried only at startup, so their rows stay in RAM
    // until then and can exceed the usual one or two minutes of staging; so do
    // rows of parts that could not be sealed. Rows of sources discarded as
    // invalid are released, matching what is persisted.
    pending: HashMap<PathBuf, Vec<MemWriter<N>>>,
    schema: Schema,
    // for checking uniqueness of schema
    schema_map: HashSet<String>,
    pub read_buffer: Vec<RecordBatch>,
    pub mutable_buffer: MutableBuffer<N>,
}

impl<const N: usize> Default for MemWriter<N> {
    fn default() -> Self {
        Self {
            segments: HashMap::new(),
            pending: HashMap::new(),
            schema: Schema::empty(),
            schema_map: HashSet::default(),
            read_buffer: Vec::default(),
            mutable_buffer: MutableBuffer::default(),
        }
    }
}

impl<const N: usize> MemWriter<N> {
    pub(crate) fn push_for_file(
        &mut self,
        filename: &str,
        schema_key: &str,
        rb: &RecordBatch,
    ) -> Result<(), StagingError> {
        if let Some(segment) = self.segments.get_mut(filename) {
            return segment.push(schema_key, rb);
        }
        let mut segment = Self::default();
        segment.push(schema_key, rb)?;
        self.segments.insert(filename.to_owned(), segment);
        Ok(())
    }

    pub fn push(&mut self, schema_key: &str, rb: &RecordBatch) -> Result<(), StagingError> {
        if !self.schema_map.contains(schema_key) {
            self.schema_map.insert(schema_key.to_owned());
            self.schema = Schema::try_merge([self.schema.clone(), (*rb.schema()).clone()])?;
        }

        let chunks = self.mutable_buffer.push(rb);
        if !chunks.is_empty() {
            // Each chunk holds at most N rows, so no concatenation under the
            // writer lock copies more than N rows. A chunk that is a single
            // slice of `rb` is concatenated without copying.
            let mut adapter = BatchAdapter::new(Arc::new(self.schema.clone()));
            for chunk in chunks {
                let record = concat_records(&mut adapter, &chunk)?;
                self.read_buffer.push(record);
            }
        }
        Ok(())
    }

    /// Moves pending rows to the new path of their staging file.
    pub(crate) fn rekey_pending(&mut self, from: &Path, to: &Path) {
        if let Some(segments) = self.pending.remove(from) {
            self.pending
                .entry(to.to_path_buf())
                .or_default()
                .extend(segments);
        }
    }

    /// Drops pending rows whose staging files were published or discarded.
    pub(crate) fn release_pending(&mut self, paths: &[PathBuf]) {
        if self.pending.is_empty() {
            return;
        }
        for path in paths {
            self.pending.remove(path);
        }
        if self.pending.is_empty() {
            self.pending = HashMap::new();
        }
    }

    pub fn clear(&mut self) {
        self.segments = HashMap::new();
        self.pending = HashMap::new();
        self.clear_unsegmented();
    }

    fn clear_unsegmented(&mut self) {
        self.schema = Schema::empty();
        self.schema_map.clear();
        self.read_buffer.clear();
        self.mutable_buffer.clear();
    }

    pub fn recordbatch_cloned(
        &self,
        schema: &Arc<Schema>,
    ) -> Result<Vec<RecordBatch>, StagingError> {
        let mut adapter = BatchAdapter::new(Arc::clone(schema));
        let mut batches = Vec::new();
        self.append_recordbatches(&mut adapter, &mut batches)?;
        Ok(batches)
    }

    // One bounded last-layout cache covers this capture's attached and pending
    // segments. Borrow stored batches to avoid cloning every ArrayRef before
    // adaptation immediately clones the selected columns again.
    fn append_recordbatches(
        &self,
        adapter: &mut BatchAdapter,
        batches: &mut Vec<RecordBatch>,
    ) -> Result<(), StagingError> {
        let mutable = if self.mutable_buffer.inner.is_empty() {
            None
        } else {
            Some(concat_records(adapter, &self.mutable_buffer.inner)?)
        };
        batches.extend(
            self.read_buffer
                .iter()
                .chain(mutable.iter())
                .map(|rb| adapter.adapt(rb)),
        );
        for segment in self
            .segments
            .values()
            .chain(self.pending.values().flatten())
        {
            segment.append_recordbatches(adapter, batches)?;
        }
        Ok(())
    }
}

fn concat_records(
    adapter: &mut BatchAdapter,
    record: &[RecordBatch],
) -> Result<RecordBatch, StagingError> {
    let records = record.iter().map(|x| adapter.adapt(x)).collect_vec();
    Ok(concat_batches(adapter.schema(), records.iter())?)
}

/// Batches not yet concatenated into the read buffer, holding fewer than `N`
/// rows and fewer than `N` batches between pushes.
#[derive(Debug, Default)]
pub struct MutableBuffer<const N: usize> {
    /// Mutate only through `MutableBuffer` methods, which keep the row count;
    /// a count left by direct mutation is reset once `inner` is empty.
    pub inner: Vec<RecordBatch>,
    rows: usize,
}

impl<const N: usize> MutableBuffer<N> {
    /// Rows held in `inner`.
    pub fn num_rows(&self) -> usize {
        if self.inner.is_empty() { 0 } else { self.rows }
    }

    pub fn clear(&mut self) {
        self.inner.clear();
        self.rows = 0;
    }

    /// Appends `rb` and returns chunks in row order, each holding at most `N`
    /// rows. Small inputs coalesce until `N` rows or `N` batches are buffered.
    /// An oversized input flushes earlier fragments separately and emits only
    /// single-source slices, including its tail. None of that parent's slices
    /// may be buffered and copied with a later input while sibling slices keep
    /// the parent allocation alive.
    fn push(&mut self, rb: &RecordBatch) -> Vec<Vec<RecordBatch>> {
        const { assert!(N > 0, "MutableBuffer capacity must be positive") };
        if self.inner.is_empty() {
            self.rows = 0;
        }
        let mut full = Vec::new();
        let total = rb.num_rows();
        if total > N {
            if !self.inner.is_empty() {
                let src = Vec::with_capacity(self.inner.len());
                full.push(std::mem::replace(&mut self.inner, src));
                self.rows = 0;
            }
            for offset in (0..total).step_by(N) {
                full.push(vec![rb.slice(offset, N.min(total - offset))]);
            }
            return full;
        }
        let mut offset = 0;
        loop {
            let len = (N - self.rows).min(total - offset);
            // Keep the caller's arrays when the whole batch fits.
            let part = if len == total {
                rb.clone()
            } else {
                rb.slice(offset, len)
            };
            self.inner.push(part);
            self.rows += len;
            offset += len;
            if self.rows >= N || self.inner.len() >= N {
                let src = Vec::with_capacity(self.inner.len());
                full.push(std::mem::replace(&mut self.inner, src));
                self.rows = 0;
            }
            if offset == total {
                return full;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{collections::HashMap, fs::File, path::PathBuf, sync::Arc};

    use arrow::array::ArrayData;
    use arrow_array::{
        Array, Int32Array, Int64Array, RecordBatch, StringArray, TimestampMillisecondArray,
    };
    use arrow_ipc::reader::StreamReader;
    use arrow_schema::{DataType, Field, Schema};
    use chrono::Utc;
    use temp_dir::TempDir;

    use crate::{
        OBJECT_STORE_DATA_GRANULARITY,
        event::format::{EventFormat, json::Event},
        metadata::SchemaVersion,
        utils::time::TimeRange,
    };

    use super::{DiskWriter, MemWriter, MutableBuffer, Writer};

    fn id_schema() -> Arc<Schema> {
        Arc::new(Schema::new(vec![Field::new("id", DataType::Int32, false)]))
    }

    fn ids_batch(schema: &Arc<Schema>, ids: std::ops::Range<i32>) -> RecordBatch {
        RecordBatch::try_new(
            schema.clone(),
            vec![Arc::new(Int32Array::from_iter_values(ids))],
        )
        .unwrap()
    }

    fn ids_of(batches: &[RecordBatch]) -> Vec<i32> {
        batches
            .iter()
            .flat_map(|rb| {
                rb.column(0)
                    .as_any()
                    .downcast_ref::<Int32Array>()
                    .unwrap()
                    .values()
                    .to_vec()
            })
            .collect()
    }

    fn rows(batches: &[RecordBatch]) -> usize {
        batches.iter().map(RecordBatch::num_rows).sum()
    }

    #[test]
    fn capture_shares_last_layout_plan_across_attached_and_pending_segments() {
        let source = Arc::new(Schema::new(vec![
            Field::new("b", DataType::Int32, true),
            Field::new("a", DataType::Int32, true),
            Field::new("a", DataType::Int64, true),
        ]));
        let batch = RecordBatch::try_new(
            source.clone(),
            vec![
                Arc::new(Int32Array::from(vec![20, 21, 22])),
                Arc::new(Int32Array::from(vec![10, 11, 12])),
                Arc::new(Int64Array::from(vec![30, 31, 32])),
            ],
        )
        .unwrap();
        let query = Arc::new(Schema::new(vec![
            Field::new("a", DataType::Int32, true),
            Field::new("missing", DataType::Utf8, true),
            Field::new("b", DataType::Int32, true),
            Field::new("a", DataType::Int32, true),
        ]));
        let mut mem = MemWriter::<4096>::default();
        mem.read_buffer = vec![batch.slice(0, 0), batch.slice(0, 1)];
        let mut attached = MemWriter::default();
        // Schema clones share Fields even when their Schema Arcs differ.
        attached.read_buffer.push(
            RecordBatch::try_new(Arc::new(source.as_ref().clone()), batch.columns().to_vec())
                .unwrap(),
        );
        mem.segments.insert("attached".to_owned(), attached);
        let mut pending = MemWriter::default();
        pending.read_buffer.push(batch.slice(1, 2));
        mem.pending.insert(PathBuf::from("pending"), vec![pending]);

        let mut adapter = super::BatchAdapter::new(query.clone());
        let mut captured = Vec::new();
        mem.append_recordbatches(&mut adapter, &mut captured)
            .unwrap();
        assert_eq!(adapter.plan_builds(), 1);
        assert_eq!(captured, mem.recordbatch_cloned(&query).unwrap());
        assert_eq!(
            captured
                .iter()
                .map(RecordBatch::num_rows)
                .collect::<Vec<_>>(),
            [0, 1, 3, 2]
        );
        assert_eq!(ids_of(&captured), [10, 10, 11, 12, 11, 12]);
        for out in &captured {
            assert!(Arc::ptr_eq(&out.schema(), &query));
            assert!(Arc::ptr_eq(out.column(0), out.column(3)));
            assert_eq!(out.column(1).data_type(), &DataType::Utf8);
            assert_eq!(out.column(1).null_count(), out.num_rows());
        }
        // A later capture owns a new plan; changed query order must be honored.
        let reversed = Arc::new(Schema::new(vec![
            Field::new("b", DataType::Int32, true),
            Field::new("a", DataType::Int32, true),
        ]));
        assert_eq!(
            ids_of(&mem.recordbatch_cloned(&reversed).unwrap()),
            [20, 20, 21, 22, 21, 22]
        );
    }

    // Count owners, not logical slice lengths: multiple slices/columns can
    // refer to the same allocation. Include validity and nested child buffers.
    fn allocations<'a>(
        batches: impl IntoIterator<Item = &'a RecordBatch>,
    ) -> HashMap<usize, usize> {
        fn visit(data: &ArrayData, result: &mut HashMap<usize, usize>) {
            for buffer in data
                .buffers()
                .iter()
                .chain(data.nulls().map(|n| n.buffer()))
            {
                if buffer.capacity() != 0 {
                    let base = buffer.data_ptr().as_ptr() as usize;
                    if let Some(capacity) = result.insert(base, buffer.capacity()) {
                        assert_eq!(capacity, buffer.capacity());
                    }
                }
            }
            for child in data.child_data() {
                visit(child, result);
            }
        }
        let mut result = HashMap::new();
        for batch in batches {
            for column in batch.columns() {
                visit(&column.to_data(), &mut result);
            }
        }
        result
    }

    /// Pushes batches of `sizes` rows with consecutive ids and checks the
    /// buffer bounds, its row count and that all rows keep their order.
    fn check_row_accounting<const N: usize>(sizes: &[usize]) {
        let schema = id_schema();
        let mut mem = MemWriter::<N>::default();
        let mut next = 0;
        for &size in sizes {
            let end = next + size as i32;
            mem.push("id", &ids_batch(&schema, next..end)).unwrap();
            next = end;
            assert!(mem.mutable_buffer.num_rows() < N);
            assert!(mem.mutable_buffer.inner.len() < N);
            assert_eq!(
                mem.mutable_buffer.num_rows(),
                rows(&mem.mutable_buffer.inner)
            );
            // Oversized inputs may emit a short tail and flush earlier rows.
            assert!(mem.read_buffer.iter().all(|rb| rb.num_rows() <= N));
            assert_eq!(
                rows(&mem.read_buffer) + mem.mutable_buffer.num_rows(),
                next as usize
            );
        }
        let all = mem.recordbatch_cloned(&schema).unwrap();
        assert_eq!(ids_of(&all), (0..next).collect::<Vec<_>>());
    }

    #[test]
    fn mutable_buffer_counts_rows_not_batches() {
        // Prior source: 3,097 pushes of 1,000 rows concatenated 3,097,000 rows.
        let schema = id_schema();
        let mut mem = MemWriter::<4096>::default();
        for i in 0..3097 {
            mem.push("id", &ids_batch(&schema, i * 1000..(i + 1) * 1000))
                .unwrap();
        }
        assert_eq!(mem.read_buffer.len(), 756);
        assert!(mem.read_buffer.iter().all(|rb| rb.num_rows() == 4096));
        assert_eq!(mem.mutable_buffer.num_rows(), 3_097_000 - 756 * 4096);
        let all = mem.recordbatch_cloned(&schema).unwrap();
        assert!(all.iter().all(|rb| rb.num_rows() <= 4096));
        assert_eq!(ids_of(&all), (0..3_097_000).collect::<Vec<_>>());
    }

    #[test]
    fn mutable_buffer_mixed_sizes_preserve_order() {
        check_row_accounting::<16>(&[
            1, 0, 15, 16, 17, 3, 0, 0, 13, 100, 1, 31, 32, 33, 0, 5, 11, 64, 2,
        ]);
        check_row_accounting::<1>(&[0, 1, 3, 0, 2]);
        check_row_accounting::<7>(&(0..60).map(|i| (i * 5) % 11).collect::<Vec<_>>());
    }

    #[test]
    fn mutable_buffer_boundary_shapes_preserve_rows_and_order() {
        for prefix in [0, 1, 1000, 4095] {
            for size in [0, 1, 4095, 4096, 4097, 8191, 8192, 8204, 12286] {
                check_row_accounting::<4096>(&[prefix, size, 0, 1000, 1000, 4096, 8204, 1]);
            }
        }
    }

    #[test]
    fn oversized_batch_is_split_without_copying() {
        let schema = id_schema();
        let mut mem = MemWriter::<16>::default();
        mem.push("id", &ids_batch(&schema, 0..2)).unwrap();
        mem.push("id", &ids_batch(&schema, 2..5)).unwrap();
        let big = ids_batch(&schema, 5..5 + 16 * 10 + 3);
        mem.push("id", &big).unwrap();
        assert_eq!(mem.read_buffer.len(), 12);
        assert_eq!(mem.read_buffer[0].num_rows(), 5);
        assert!(mem.read_buffer[1..11].iter().all(|rb| rb.num_rows() == 16));
        assert_eq!(mem.read_buffer[11].num_rows(), 3);
        // Neither edge of the large input is copied with another input.
        let base = big
            .column(0)
            .as_any()
            .downcast_ref::<Int32Array>()
            .unwrap()
            .values()
            .as_ptr();
        for (i, rb) in mem.read_buffer.iter().enumerate().skip(1) {
            let values = rb.column(0).as_any().downcast_ref::<Int32Array>().unwrap();
            assert_eq!(values.values().as_ptr(), base.wrapping_add((i - 1) * 16));
        }
        assert_eq!(mem.mutable_buffer.num_rows(), 0);
        assert!(mem.mutable_buffer.inner.is_empty());
        // A later small request must not pull that large parent's tail back
        // into coalescing, and small requests must still coalesce together.
        mem.push("id", &ids_batch(&schema, 168..175)).unwrap();
        mem.push("id", &ids_batch(&schema, 175..184)).unwrap();
        assert_eq!(mem.read_buffer.len(), 13);
        assert_eq!(mem.read_buffer[12].num_rows(), 16);
        let all = mem.recordbatch_cloned(&schema).unwrap();
        assert_eq!(ids_of(&all), (0..184).collect::<Vec<_>>());
    }

    #[test]
    fn repeated_8204_primitive_inputs_retain_only_input_allocations() {
        let schema = Arc::new(Schema::new(vec![Field::new("n", DataType::Int64, false)]));
        let mut mem = MemWriter::<4096>::default();
        let mut input_allocations = HashMap::new();
        for push in 0..8 {
            let start = push * 8204;
            let batch = RecordBatch::try_new(
                schema.clone(),
                vec![Arc::new(Int64Array::from_iter_values(start..start + 8204))],
            )
            .unwrap();
            input_allocations.extend(allocations([&batch]));
            mem.push("n", &batch).unwrap();
            drop(batch);
            assert!(mem.mutable_buffer.inner.is_empty());
            assert_eq!(allocations(&mem.read_buffer), input_allocations);
        }
        let captured = mem.recordbatch_cloned(&schema).unwrap();
        assert_eq!(allocations(&captured), input_allocations);
        // The deliberate cost: one 12-row tail per input, alongside two full
        // chunks. The reviewed splitter returned 17 batches for this shape.
        assert_eq!(captured.len(), 24);
        for chunks in captured.chunks_exact(3) {
            assert_eq!(
                chunks.iter().map(RecordBatch::num_rows).collect::<Vec<_>>(),
                [4096, 4096, 12]
            );
        }
        let mut next = 0;
        for batch in captured {
            assert!(Arc::ptr_eq(&batch.schema(), &schema));
            let column = batch
                .column(0)
                .as_any()
                .downcast_ref::<Int64Array>()
                .unwrap();
            for value in column.values() {
                assert_eq!(*value, next);
                next += 1;
            }
        }
        assert_eq!(next, 8 * 8204);
    }

    #[test]
    fn repeated_8204_decoded_inputs_retain_only_input_allocations() {
        let stored = HashMap::from([
            (
                "message".to_owned(),
                Arc::new(Field::new("message", DataType::Utf8, true)),
            ),
            (
                "n".to_owned(),
                Arc::new(Field::new("n", DataType::Int64, true)),
            ),
        ]);
        let timestamp = chrono::DateTime::from_timestamp_millis(1_700_000_000_123).unwrap();
        let mut mem = MemWriter::<4096>::default();
        let mut input_allocations = HashMap::new();
        let mut query_schema = None;
        for push in 0..8 {
            let start = push * 8204;
            let json = serde_json::Value::Array(
                (start..start + 8204)
                    .map(|n| serde_json::json!({
                        "message": if n % 19 == 0 { None } else { Some(format!("message {n:08}")) },
                        "n": n,
                    }))
                    .collect(),
            );
            let (batch, _) = Event::new(json, timestamp)
                .into_recordbatch(
                    &stored,
                    false,
                    None,
                    SchemaVersion::V1,
                    &HashMap::new(),
                    true,
                )
                .unwrap();
            assert_eq!(batch.schema().field(0).name(), "p_timestamp");
            if query_schema.is_none() {
                let mut fields = batch.schema().fields().to_vec();
                fields.sort_by(|a, b| a.name().cmp(b.name()));
                query_schema = Some(Arc::new(Schema::new(fields)));
            }
            input_allocations.extend(allocations([&batch]));
            mem.push("same", &batch).unwrap();
            drop(batch);
            assert!(mem.mutable_buffer.inner.is_empty());
            assert_eq!(allocations(&mem.read_buffer), input_allocations);
        }
        let query_schema = query_schema.unwrap();
        let captured = mem.recordbatch_cloned(&query_schema).unwrap();
        assert_eq!(captured.len(), 24);
        assert_eq!(allocations(&captured), input_allocations);
        let mut next = 0;
        for batch in captured {
            assert!(Arc::ptr_eq(&batch.schema(), &query_schema));
            assert!(batch.num_rows() <= 4096);
            let message = batch
                .column(0)
                .as_any()
                .downcast_ref::<StringArray>()
                .unwrap();
            let ids = batch
                .column(1)
                .as_any()
                .downcast_ref::<Int64Array>()
                .unwrap();
            let time = batch
                .column(2)
                .as_any()
                .downcast_ref::<TimestampMillisecondArray>()
                .unwrap();
            for row in 0..batch.num_rows() {
                assert_eq!(ids.value(row), next);
                assert_eq!(message.is_null(row), next % 19 == 0);
                if message.is_valid(row) {
                    assert_eq!(message.value(row), format!("message {next:08}"));
                }
                assert!(time.is_valid(row));
                assert_eq!(time.value(row), timestamp.timestamp_millis());
                next += 1;
            }
        }
        assert_eq!(next, 8 * 8204);
    }

    #[test]
    fn oversized_pending_snapshot_owns_allocations_until_dropped() {
        let schema = id_schema();
        let mut mem = MemWriter::<4096>::default();
        let batch = ids_batch(&schema, 0..8204);
        // This test guard deliberately keeps one buffer reference so its
        // strong count can prove that staging and snapshot owners are gone.
        let allocation = batch.column(0).to_data().buffers()[0].clone();
        mem.push_for_file("old", "id", &batch).unwrap();
        drop(batch);
        let segment = mem.segments.remove("old").unwrap();
        let part = std::path::PathBuf::from("pending.arrows.part");
        let processing = std::path::PathBuf::from("processing/pending.arrows");
        mem.pending.insert(part.clone(), vec![segment]);
        let snapshot = mem.recordbatch_cloned(&schema).unwrap();
        mem.rekey_pending(&part, &processing);
        mem.release_pending(&[part]);
        assert_eq!(rows(&mem.recordbatch_cloned(&schema).unwrap()), 8204);
        mem.release_pending(&[processing]);
        assert!(mem.recordbatch_cloned(&schema).unwrap().is_empty());
        mem.clear();
        assert!(allocation.strong_count() > 1);
        assert_eq!(ids_of(&snapshot), (0..8204).collect::<Vec<_>>());
        drop(snapshot);
        assert_eq!(allocation.strong_count(), 1);
    }

    #[test]
    fn mutable_buffer_zero_row_batches_are_bounded() {
        let schema = id_schema();
        let empty = ids_batch(&schema, 0..0);
        let mut buffer = MutableBuffer::<4>::default();
        for _ in 0..3 {
            assert!(buffer.push(&empty).is_empty());
        }
        assert_eq!(buffer.num_rows(), 0);
        let full = buffer.push(&empty);
        assert_eq!(full.len(), 1);
        assert_eq!(full[0].len(), 4);
        assert!(buffer.inner.is_empty());

        let mut mem = MemWriter::<4>::default();
        mem.push("id", &empty).unwrap();
        // An empty buffered batch still yields one empty query batch.
        let cloned = mem.recordbatch_cloned(&schema).unwrap();
        assert_eq!(cloned.len(), 1);
        assert_eq!(cloned[0].num_rows(), 0);
        mem.push("id", &ids_batch(&schema, 0..3)).unwrap();
        mem.push("id", &empty).unwrap();
        mem.push("id", &ids_batch(&schema, 3..5)).unwrap();
        assert_eq!(mem.read_buffer.len(), 1);
        assert_eq!(mem.read_buffer[0].num_rows(), 4);
        assert_eq!(mem.mutable_buffer.num_rows(), 1);
        let all = mem.recordbatch_cloned(&schema).unwrap();
        assert_eq!(ids_of(&all), (0..5).collect::<Vec<_>>());
    }

    #[test]
    fn mutable_buffer_split_across_schema_change() {
        let schema = id_schema();
        let extended = Arc::new(Schema::new(vec![
            Field::new("extra", DataType::Int32, true),
            Field::new("id", DataType::Int32, false),
        ]));
        let query_schema = Arc::new(Schema::new(vec![
            Field::new("id", DataType::Int32, false),
            Field::new("extra", DataType::Int32, true),
        ]));
        let mut mem = MemWriter::<4>::default();
        mem.push("id", &ids_batch(&schema, 0..3)).unwrap();
        let wide = RecordBatch::try_new(
            extended,
            vec![
                Arc::new(Int32Array::from_iter_values(103..112)),
                Arc::new(Int32Array::from_iter_values(3..12)),
            ],
        )
        .unwrap();
        mem.push("extended", &wide).unwrap();
        // The older narrow schema needs typed nulls in each bounded chunk.
        mem.push("id", &ids_batch(&schema, 12..21)).unwrap();
        mem.push("id", &ids_batch(&schema, 21..23)).unwrap();
        assert_eq!(mem.read_buffer.len(), 7);
        assert!(mem.read_buffer.iter().all(|rb| rb.num_rows() <= 4));
        assert_eq!(rows(&mem.read_buffer), 21);
        assert_eq!(mem.mutable_buffer.num_rows(), 2);

        let all = mem.recordbatch_cloned(&query_schema).unwrap();
        assert!(all.iter().all(|rb| rb.schema() == query_schema));
        assert_eq!(ids_of(&all), (0..23).collect::<Vec<_>>());
        let extras = all
            .iter()
            .flat_map(|rb| {
                let col = rb.column(1).as_any().downcast_ref::<Int32Array>().unwrap();
                (0..col.len())
                    .map(|i| arrow_array::Array::is_valid(col, i).then(|| col.value(i)))
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>();
        let expected = (0..23)
            .map(|id| (3..12).contains(&id).then_some(id + 100))
            .collect::<Vec<_>>();
        assert_eq!(extras, expected);
    }

    #[test]
    fn mutable_buffer_row_count_resets_on_clear() {
        let schema = id_schema();
        let mut mem = MemWriter::<4096>::default();
        mem.push("id", &ids_batch(&schema, 0..4095)).unwrap();
        mem.clear();
        assert_eq!(mem.mutable_buffer.num_rows(), 0);
        mem.push("id", &ids_batch(&schema, 0..4095)).unwrap();
        assert!(mem.read_buffer.is_empty());

        // Flushing expires ownerless query rows and their count.
        let mut writer = Writer {
            mem: Some(mem),
            disk: Default::default(),
        };
        drop(writer.take_flushable_disk(false));
        let mem = writer.mem.as_mut().unwrap();
        assert!(mem.mutable_buffer.inner.is_empty());
        assert_eq!(mem.mutable_buffer.num_rows(), 0);
        mem.push("id", &ids_batch(&schema, 0..4095)).unwrap();
        assert!(mem.read_buffer.is_empty());
        mem.push("id", &ids_batch(&schema, 4095..4096)).unwrap();
        assert_eq!(mem.read_buffer.len(), 1);
        assert_eq!(mem.read_buffer[0].num_rows(), 4096);

        // A direct clear of the public field cannot leave a stale count.
        mem.push("id", &ids_batch(&schema, 4096..8191)).unwrap();
        mem.mutable_buffer.inner.clear();
        assert_eq!(mem.mutable_buffer.num_rows(), 0);
        mem.push("id", &ids_batch(&schema, 8191..12286)).unwrap();
        assert_eq!(mem.read_buffer.len(), 1);
        assert_eq!(mem.mutable_buffer.num_rows(), 4095);
    }

    #[test]
    fn segments_and_pending_keep_row_accounting() {
        let dir = TempDir::new().unwrap();
        let now = chrono::DateTime::parse_from_rfc3339("2020-01-02T12:34:30.500Z")
            .unwrap()
            .with_timezone(&Utc);
        let current = TimeRange::granularity_range(now, OBJECT_STORE_DATA_GRANULARITY);
        let expired = TimeRange {
            start: current.start - chrono::TimeDelta::minutes(2),
            end: current.start,
        };
        let schema = id_schema();
        let mut writer = Writer {
            mem: Some(MemWriter::default()),
            disk: Default::default(),
        };
        let old = "old.date=2020-01-02.data.arrows";
        let live = "live.date=2020-01-02.data.arrows";
        for (filename, range, ids) in [
            (old, &expired, 0..5000),
            (old, &expired, 5000..14000),
            (live, &current, 20000..20005),
        ] {
            let batch = ids_batch(&schema, ids);
            writer
                .push_disk_ref(filename, &batch, dir.path().join(filename), range.clone())
                .unwrap();
            writer
                .mem
                .as_mut()
                .unwrap()
                .push_for_file(filename, "id", &batch)
                .unwrap();
        }
        let segment = &writer.mem.as_ref().unwrap().segments[old];
        assert_eq!(segment.read_buffer.len(), 5);
        assert!(segment.read_buffer.iter().all(|rb| rb.num_rows() <= 4096));
        assert_eq!(rows(&segment.read_buffer), 14000);
        assert_eq!(segment.mutable_buffer.num_rows(), 0);

        let detached = writer.detach_flushable_disk_at(false, now);
        assert_eq!(detached.len(), 1);
        let part = detached[0].path().to_path_buf();
        let mem = writer.mem.as_mut().unwrap();
        assert!(!mem.segments.contains_key(old));
        // A late event for the detached key starts a fresh segment and count.
        mem.push_for_file(old, "id", &ids_batch(&schema, 14000..14002))
            .unwrap();
        assert_eq!(mem.segments[old].mutable_buffer.num_rows(), 2);
        assert!(mem.segments[old].read_buffer.is_empty());

        let mut ids = ids_of(&mem.recordbatch_cloned(&schema).unwrap());
        assert_eq!(ids.len(), 14000 + 2 + 5);
        ids.sort_unstable();
        let expected = (0..14002).chain(20000..20005).collect::<Vec<_>>();
        assert_eq!(ids, expected);
        // Rows of one pending file stay in order.
        let pending = mem.pending[&part][0].recordbatch_cloned(&schema).unwrap();
        assert_eq!(ids_of(&pending), (0..14000).collect::<Vec<_>>());

        mem.release_pending(std::slice::from_ref(&part));
        assert_eq!(rows(&mem.recordbatch_cloned(&schema).unwrap()), 2 + 5);
        drop(detached);
    }

    #[test]
    fn current_minute_query_visibility_releases_burst_capacity() {
        let dir = TempDir::new().unwrap();
        let now = chrono::DateTime::parse_from_rfc3339("2020-01-02T12:34:30.500Z")
            .unwrap()
            .with_timezone(&Utc);
        let current = TimeRange::granularity_range(now, OBJECT_STORE_DATA_GRANULARITY);
        let expired = TimeRange {
            start: current.start - chrono::TimeDelta::minutes(2),
            end: current.start,
        };
        let schema = Arc::new(Schema::new(vec![Field::new("id", DataType::Int32, false)]));
        let batches = (0..128)
            .map(|id| {
                RecordBatch::try_new(schema.clone(), vec![Arc::new(Int32Array::from(vec![id]))])
                    .unwrap()
            })
            .collect::<Vec<_>>();
        let mut writer = Writer {
            mem: Some(MemWriter::default()),
            disk: Default::default(),
        };
        for (id, batch) in batches.iter().enumerate() {
            let filename = format!("{id}.date=2020-01-02.data.arrows");
            let range = if id < 2 { &current } else { &expired };
            writer
                .push_disk_ref(&filename, batch, dir.path().join(&filename), range.clone())
                .unwrap();
            writer
                .mem
                .as_mut()
                .unwrap()
                .push_for_file(&filename, "id", batch)
                .unwrap();
        }
        let peak_capacity = writer.mem.as_ref().unwrap().segments.capacity();
        assert!(peak_capacity >= 128);
        drop(writer.take_flushable_disk_at(false, now));
        let mem = writer.mem.as_ref().unwrap();
        assert_eq!(mem.segments.len(), 2);
        assert!(mem.segments.capacity() <= 2 * mem.segments.len() + 16);
        assert!(mem.segments.capacity() < peak_capacity);
        for (id, batch) in batches.iter().take(2).enumerate() {
            let key = format!("{id}.date=2020-01-02.data.arrows");
            let retained = &mem.segments[&key].mutable_buffer.inner;
            assert_eq!(retained.len(), 1);
            assert_eq!(retained[0].num_rows(), 1);
            assert!(Arc::ptr_eq(retained[0].column(0), batch.column(0)));
        }
        assert_eq!(
            mem.recordbatch_cloned(&schema)
                .unwrap()
                .iter()
                .map(RecordBatch::num_rows)
                .sum::<usize>(),
            2
        );
        drop(writer.take_flushable_disk_at(false, current.end));
        assert!(writer.disk.is_empty());
        assert_eq!(writer.mem.as_ref().unwrap().segments.capacity(), 0);
        let mem = writer.mem.as_mut().unwrap();
        mem.push_for_file("clear-test", "id", &batches[0]).unwrap();
        assert!(mem.segments.capacity() > 0);
        mem.clear();
        assert_eq!(mem.segments.capacity(), 0);
    }

    #[test]
    fn current_minute_query_visibility_segments_follow_disk_ownership() {
        let dir = TempDir::new().unwrap();
        let now = chrono::DateTime::parse_from_rfc3339("2020-01-02T12:34:30.500Z")
            .unwrap()
            .with_timezone(&Utc);
        let schema = Arc::new(Schema::new(vec![Field::new("id", DataType::Int32, false)]));
        let extended = Arc::new(Schema::new(vec![
            Field::new("extra", DataType::Int32, true),
            Field::new("id", DataType::Int32, false),
        ]));
        let query_schema = Arc::new(Schema::new(vec![
            Field::new("id", DataType::Int32, false),
            Field::new("extra", DataType::Int32, true),
        ]));
        let batch = RecordBatch::try_new(
            schema.clone(),
            vec![Arc::new(Int32Array::from(vec![10, 11]))],
        )
        .unwrap();
        let extended_batch = RecordBatch::try_new(
            extended,
            vec![
                Arc::new(Int32Array::from(vec![99])),
                Arc::new(Int32Array::from(vec![12])),
            ],
        )
        .unwrap();
        let mut writer = Writer {
            mem: Some(MemWriter::default()),
            disk: Default::default(),
        };
        let current_range = TimeRange {
            start: now - chrono::TimeDelta::hours(1),
            end: now + chrono::TimeDelta::hours(1),
        };
        for (name, range, rb, key) in [
            (
                "past",
                TimeRange {
                    start: now - chrono::TimeDelta::hours(3),
                    end: now - chrono::TimeDelta::hours(2),
                },
                &batch,
                "id",
            ),
            ("current-a", current_range.clone(), &batch, "id"),
            ("current-b", current_range, &extended_batch, "extended"),
            (
                "future",
                TimeRange {
                    start: now + chrono::TimeDelta::hours(2),
                    end: now + chrono::TimeDelta::hours(3),
                },
                &batch,
                "id",
            ),
        ] {
            let filename = format!("{name}.date=2020-01-02.data.arrows");
            writer
                .push_disk(filename.clone(), rb, dir.path().join(&filename), range)
                .unwrap();
            writer
                .mem
                .as_mut()
                .unwrap()
                .push_for_file(&filename, key, rb)
                .unwrap();
        }
        // Query-mode user rows have no disk owner and use the public direct buffer.
        writer.mem.as_mut().unwrap().push("id", &batch).unwrap();
        let key = "current-a.date=2020-01-02.data.arrows";
        assert!(
            Arc::ptr_eq(
                writer.mem.as_ref().unwrap().segments[key]
                    .mutable_buffer
                    .inner[0]
                    .column(0),
                batch.column(0)
            ),
            "ingestion must keep the existing Arrow allocation"
        );
        let detached = writer.take_flushable_disk_at(false, now);
        assert_eq!(detached.len(), 2);
        assert_eq!(writer.disk.len(), 2);
        let mem = &writer.mem.as_ref().unwrap().segments;
        assert_eq!(mem.len(), 2);
        eprintln!(
            "memory segment fixed header: {} bytes; filename String header: {} bytes (heap buffers/hash buckets excluded)",
            std::mem::size_of::<super::MemWriter<4096>>(),
            std::mem::size_of::<String>()
        );
        assert!(
            Arc::ptr_eq(mem[key].mutable_buffer.inner[0].column(0), batch.column(0)),
            "flushing must retain the same Arrow allocation"
        );
        let mut ids = Vec::new();
        for segment in mem.values() {
            for rb in segment.recordbatch_cloned(&query_schema).unwrap() {
                assert_eq!(rb.schema(), query_schema);
                ids.extend_from_slice(
                    rb.column(0)
                        .as_any()
                        .downcast_ref::<Int32Array>()
                        .unwrap()
                        .values(),
                );
                let extras = rb.column(1).as_any().downcast_ref::<Int32Array>().unwrap();
                if rb.num_rows() == 1 {
                    assert_eq!(extras.value(0), 99);
                } else {
                    assert_eq!(arrow_array::Array::null_count(extras), 2);
                }
            }
        }
        ids.sort_unstable();
        assert_eq!(ids, vec![10, 11, 12]);
        drop(detached);
        assert!(writer.take_flushable_disk_at(false, now).is_empty());
        assert_eq!(writer.mem.as_ref().unwrap().segments.len(), 2);
        drop(writer.take_flushable_disk_at(true, now));
        assert!(writer.disk.is_empty());
        assert!(writer.mem.as_ref().unwrap().segments.is_empty());
        assert_eq!(writer.mem.as_ref().unwrap().segments.capacity(), 0);
    }

    #[test]
    fn disk_writer_flushes_each_complete_batch_before_drop() {
        let dir = TempDir::new().unwrap();
        let path = dir
            .path()
            .join("schema.date=2026-09-08.hour=11.minute=27.test.data.arrows");
        let schema = Arc::new(Schema::new(vec![Field::new("id", DataType::Int32, false)]));
        let batch = RecordBatch::try_new(
            schema.clone(),
            vec![Arc::new(Int32Array::from(vec![1, 2, 3]))],
        )
        .unwrap();
        let range = TimeRange::granularity_range(Utc::now(), OBJECT_STORE_DATA_GRANULARITY);
        let mut writer = DiskWriter::try_new(path, &schema, range).unwrap();
        assert!(writer.path.to_string_lossy().ends_with(".arrows.part"));

        writer.write(&batch).unwrap();

        // Simulate what another process sees before Drop writes the EOS marker.
        let file = File::open(&writer.path).unwrap();
        let mut reader = StreamReader::try_new(file, None).unwrap();
        let persisted = reader.next().unwrap().unwrap();
        assert_eq!(persisted.num_rows(), 3);
    }

    #[test]
    fn writer_appends_batches_directly_to_one_schema_minute_file() {
        let dir = TempDir::new().unwrap();
        let filename = "schema.date=2026-09-08.hour=11.minute=27.test.data.arrows";
        let path = dir.path().join(filename);
        let schema = Arc::new(Schema::new(vec![Field::new("id", DataType::Int32, false)]));
        let batch =
            RecordBatch::try_new(schema, vec![Arc::new(Int32Array::from(vec![1, 2, 3]))]).unwrap();
        let range = TimeRange::granularity_range(Utc::now(), OBJECT_STORE_DATA_GRANULARITY);
        let mut writer = Writer::default();

        writer
            .push_disk(filename.to_owned(), &batch, path.clone(), range.clone())
            .unwrap();
        writer
            .push_disk(filename.to_owned(), &batch, path, range)
            .unwrap();
        assert_eq!(writer.disk.len(), 1);

        drop(writer.take_flushable_disk(true));
        let arrow_path = std::fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .map(|entry| entry.path())
            .find(|path| path.extension().is_some_and(|ext| ext == "arrows"))
            .unwrap();
        let reader = StreamReader::try_new(File::open(arrow_path).unwrap(), None).unwrap();
        let rows: usize = reader.map(|batch| batch.unwrap().num_rows()).sum();
        assert_eq!(rows, 6);
    }
}
