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
    path::PathBuf,
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
    utils::{arrow::adapt_batch, time::TimeRange},
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
        let mut flushable_disk = HashMap::new();
        let old_disk = std::mem::take(&mut self.disk);
        for (filename, writer) in old_disk {
            if !forced && writer.range.contains(now) {
                self.disk.insert(filename, writer);
            } else {
                flushable_disk.insert(filename, writer);
            }
        }

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
        flushable_disk
    }
}

pub struct DiskWriter {
    inner: StreamWriter<BufWriter<File>>,
    path: PathBuf,
    range: TimeRange,
}

impl DiskWriter {
    /// Try to create a file to stream arrows into
    pub fn try_new(
        path: impl Into<PathBuf>,
        schema: &Schema,
        range: TimeRange,
    ) -> Result<Self, StagingError> {
        let mut path = path.into();

        // a rudimentary way to ensure one parquet per arrow file
        if *ONE_PARQUET_PER_ARROW {
            path.set_extension(Ulid::new().to_string());
            path.add_extension(ARROW_FILE_EXTENSION);
        }
        path.add_extension(PART_FILE_EXTENSION);

        let file = OpenOptions::new()
            .write(true)
            .truncate(true)
            .create(true)
            .open(&path)?;
        let inner = StreamWriter::try_new_with_options(
            BufWriter::new(file),
            schema,
            IpcWriteOptions::default()
                .try_with_compression(Some(CompressionType::LZ4_FRAME))
                .unwrap(),
        )?;

        Ok(Self { inner, path, range })
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
        if let Err(err) = self.inner.finish() {
            error!("Couldn't finish arrow file {:?}, error = {err}", self.path);
            return;
        }

        // `.arrows.part` becomes `.arrows` while preserving a per-file ULID.
        let mut arrow_path = self.path.with_extension("");
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

        if let Err(err) = std::fs::rename(&self.path, &arrow_path) {
            error!("Couldn't rename file {:?}, error = {err}", self.path);
        }
        tracing::info!("flushing {:?} due to drop", self.path);
    }
}

/// Structure to keep recordbatches in memory.
///
/// Any new schema is updated in the schema map.
/// Recordbatches are pushed to mutable buffer first and then concated together and pushed to read buffer
#[derive(Debug)]
pub struct MemWriter<const N: usize> {
    // Private file-owned buffers preserve the existing public MemWriter shape.
    // Stream query callers use recordbatch_cloned to read every segment.
    segments: HashMap<String, MemWriter<N>>,
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

        if let Some(record) = self.mutable_buffer.push(rb) {
            let record = concat_records(&Arc::new(self.schema.clone()), &record)?;
            self.read_buffer.push(record);
        }
        Ok(())
    }

    pub fn clear(&mut self) {
        self.segments = HashMap::new();
        self.clear_unsegmented();
    }

    fn clear_unsegmented(&mut self) {
        self.schema = Schema::empty();
        self.schema_map.clear();
        self.read_buffer.clear();
        self.mutable_buffer.inner.clear();
    }

    pub fn recordbatch_cloned(
        &self,
        schema: &Arc<Schema>,
    ) -> Result<Vec<RecordBatch>, StagingError> {
        let mut read_buffer = self.read_buffer.clone();
        if !self.mutable_buffer.inner.is_empty() {
            let rb = concat_records(schema, &self.mutable_buffer.inner)?;
            read_buffer.push(rb)
        }

        let mut batches = read_buffer
            .into_iter()
            .map(|rb| adapt_batch(schema.clone(), &rb))
            .collect::<Vec<_>>();
        for segment in self.segments.values() {
            batches.extend(segment.recordbatch_cloned(schema)?);
        }
        Ok(batches)
    }
}

fn concat_records(
    schema: &Arc<Schema>,
    record: &[RecordBatch],
) -> Result<RecordBatch, StagingError> {
    let records = record
        .iter()
        .map(|x| adapt_batch(schema.clone(), x))
        .collect_vec();
    Ok(concat_batches(schema, records.iter())?)
}

#[derive(Debug, Default)]
pub struct MutableBuffer<const N: usize> {
    pub inner: Vec<RecordBatch>,
}

impl<const N: usize> MutableBuffer<N> {
    fn push(&mut self, rb: &RecordBatch) -> Option<Vec<RecordBatch>> {
        if self.inner.len() + rb.num_rows() >= N {
            let left = N - self.inner.len();
            let right = rb.num_rows() - left;
            let left_slice = rb.slice(0, left);
            let right_slice = if left < rb.num_rows() {
                Some(rb.slice(left, right))
            } else {
                None
            };
            self.inner.push(left_slice);
            // take all records
            let src = Vec::with_capacity(self.inner.len());
            let inner = std::mem::replace(&mut self.inner, src);

            if let Some(right_slice) = right_slice {
                self.inner.push(right_slice);
            }

            Some(inner)
        } else {
            self.inner.push(rb.clone());
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{fs::File, sync::Arc};

    use arrow_array::{Int32Array, RecordBatch};
    use arrow_ipc::reader::StreamReader;
    use arrow_schema::{DataType, Field, Schema};
    use chrono::Utc;
    use temp_dir::TempDir;

    use crate::{OBJECT_STORE_DATA_GRANULARITY, utils::time::TimeRange};

    use super::{DiskWriter, MemWriter, Writer};

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
