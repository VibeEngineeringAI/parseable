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

//! Opt-in severity clustering for log Parquet row groups.
//!
//! When `P_LOG_SEVERITY_CLUSTER_COLUMN` is set, the log conversion path
//! buffers exactly one row group of rows (the same rows the unclustered
//! writer would have placed in that row group), computes a stable order by
//! `(cluster column ASC NULLS LAST, time column DESC NULLS LAST)` and writes
//! the rows in that order, gathered in small batches from the buffer. Row-group membership, and therefore row-group time ranges,
//! are unchanged; only the order of rows inside each row group differs.
//! Pages of a selective severity value then become contiguous, which lets
//! Parquet page indexes and late materialization skip most projected pages.
//!
//! Clustered files declare no `sorting_columns`: per-row-group order is not
//! a file-level timestamp order, and Parseable never trusts footer ordering.

use std::{fs::File, sync::Arc, time::Duration, time::Instant};

use arrow::{
    compute::{concat, interleave},
    row::{RowConverter, SortField},
};
use arrow_array::{Array, ArrayRef, RecordBatch};
use arrow_schema::{ArrowError, DataType, Schema, SortOptions};
use parquet::{arrow::ArrowWriter, errors::ParquetError, file::properties::WriterProperties};
use rayon::{
    iter::{IntoParallelIterator, ParallelIterator},
    slice::ParallelSliceMut,
};

use crate::{
    event::{DEFAULT_TIMESTAMP_KEY, format::LogSource},
    handlers::TelemetryType,
    parseable::staging::StagingError,
    storage::StreamType,
};

/// Column positions in the merged conversion schema used to cluster one file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct LogClusterKey {
    pub(super) cluster_idx: usize,
    pub(super) time_idx: Option<usize>,
}

/// Why a configured clustering column was not applied to a conversion output.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum LogClusterSkip {
    /// No column configured: the default, existing behaviour.
    Disabled,
    /// Metrics, traces, internal or other non-log streams.
    NotApplicable,
    /// The merged schema of this output does not contain the column.
    MissingColumn,
    /// The column exists with a type that clustering does not support.
    UnsupportedType(DataType),
}

/// True for stream kinds whose Parquet layout clustering may change.
pub(super) fn stream_is_applicable(
    stream_type: StreamType,
    telemetry_type: TelemetryType,
    log_sources: impl IntoIterator<Item = LogSource>,
) -> bool {
    if stream_type != StreamType::UserDefined || telemetry_type != TelemetryType::Logs {
        return false;
    }
    // A logs-typed stream that has ever received metric, trace or internal
    // payloads keeps the existing writer (metrics have their own sort).
    !log_sources.into_iter().any(|source| {
        matches!(
            source,
            LogSource::OtelMetrics | LogSource::OtelTraces | LogSource::Pmeta
        )
    })
}

/// Types whose physical order is cheap to compute and meaningful for
/// equality predicates: strings (including dictionary/view encodings)
/// and integers such as OTel `severity_number`.
fn is_supported_cluster_type(data_type: &DataType) -> bool {
    match data_type {
        DataType::Utf8 | DataType::LargeUtf8 | DataType::Utf8View => true,
        DataType::Int8
        | DataType::Int16
        | DataType::Int32
        | DataType::Int64
        | DataType::UInt8
        | DataType::UInt16
        | DataType::UInt32
        | DataType::UInt64 => true,
        DataType::Dictionary(_, value) => {
            matches!(
                value.as_ref(),
                DataType::Utf8 | DataType::LargeUtf8 | DataType::Utf8View
            )
        }
        _ => false,
    }
}

/// Selects the first present, supported candidate in one output's merged schema.
/// Startup validation supplies a normalized comma-separated list.
pub(super) fn resolve_cluster_key(
    configured_column: Option<&str>,
    applicable: bool,
    merged_schema: &Schema,
    time_partition: Option<&str>,
) -> Result<LogClusterKey, LogClusterSkip> {
    let Some(column) = configured_column else {
        return Err(LogClusterSkip::Disabled);
    };
    if !applicable {
        return Err(LogClusterSkip::NotApplicable);
    }
    let mut skipped = LogClusterSkip::MissingColumn;
    let mut selected = None;
    for candidate in column.split(',') {
        let Ok(index) = merged_schema.index_of(candidate) else {
            continue;
        };
        let data_type = merged_schema.field(index).data_type();
        if !is_supported_cluster_type(data_type) {
            tracing::warn!(
                column = candidate,
                %data_type,
                "Log severity clustering candidate skipped: unsupported column type"
            );
            skipped = LogClusterSkip::UnsupportedType(data_type.clone());
            continue;
        }
        selected = Some(index);
        break;
    }
    let cluster_idx = selected.ok_or(skipped)?;
    let time_field = time_partition.unwrap_or(DEFAULT_TIMESTAMP_KEY);
    let time_idx = merged_schema
        .index_of(time_field)
        .ok()
        .filter(|idx| *idx != cluster_idx)
        .filter(|idx| {
            matches!(
                merged_schema.field(*idx).data_type(),
                DataType::Timestamp(_, _)
            )
        });
    Ok(LogClusterKey {
        cluster_idx,
        time_idx,
    })
}

/// Rows per reordered batch handed to the Parquet writer. A multiple of the
/// writer's default mini-batch (1,024 rows), so page boundaries match writing
/// the whole reordered row group at once.
pub(super) const CLUSTER_OUTPUT_BATCH_ROWS: usize = 8192;

/// Stable row permutation for `(cluster ASC NULLS LAST, time DESC NULLS LAST)`
/// over the concatenation of `buffer`. Only the (at most two) key columns are
/// concatenated. Returns `None` when the rows are already in that order.
fn cluster_indices(
    buffer: &[RecordBatch],
    rows_len: usize,
    key: LogClusterKey,
) -> Result<Option<Vec<u32>>, ArrowError> {
    if rows_len < 2 {
        return Ok(None);
    }
    if rows_len > u32::MAX as usize {
        return Err(ArrowError::ComputeError(format!(
            "Cannot represent {rows_len} cluster sort indices as UInt32"
        )));
    }
    let key_column = |idx: usize| -> Result<ArrayRef, ArrowError> {
        if let [batch] = buffer {
            return Ok(batch.column(idx).clone());
        }
        let parts: Vec<&dyn Array> = buffer.iter().map(|b| b.column(idx).as_ref()).collect();
        concat(&parts)
    };
    let mut arrays: Vec<ArrayRef> = vec![key_column(key.cluster_idx)?];
    let mut fields = vec![SortField::new_with_options(
        arrays[0].data_type().clone(),
        SortOptions {
            descending: false,
            nulls_first: false,
        },
    )];
    if let Some(time_idx) = key.time_idx {
        let time = key_column(time_idx)?;
        fields.push(SortField::new_with_options(
            time.data_type().clone(),
            SortOptions {
                descending: true,
                nulls_first: false,
            },
        ));
        arrays.push(time);
    }
    let converter = RowConverter::new(fields)?;
    let rows = converter.convert_columns(&arrays)?;
    drop(arrays);
    let mut indices = (0..rows_len as u32).collect::<Vec<_>>();
    // Stable: equal keys keep the converter's input order.
    indices.par_sort_by(|a, b| rows.row(*a as usize).cmp(&rows.row(*b as usize)));
    if indices
        .iter()
        .enumerate()
        .all(|(position, index)| position == *index as usize)
    {
        return Ok(None);
    }
    Ok(Some(indices))
}

/// Clusters one row group's buffered slices and passes the reordered rows to
/// `emit` in order, in batches of at most `output_rows` rows.
///
/// Rows are gathered straight from the buffered slices with `interleave`, so
/// no concatenated copy of the row group and no full reordered copy is held:
/// the extra memory is the buffered input plus one output batch. Rows that
/// are already in cluster order are emitted as the buffered slices.
/// Returns the time spent ordering and gathering rows (excluding `emit`).
pub(super) fn cluster_row_group_into(
    buffer: Vec<RecordBatch>,
    key: LogClusterKey,
    output_rows: usize,
    mut emit: impl FnMut(RecordBatch) -> Result<(), StagingError>,
) -> Result<Duration, StagingError> {
    let started = Instant::now();
    let rows_len: usize = buffer.iter().map(RecordBatch::num_rows).sum();
    let ordered = cluster_indices(&buffer, rows_len, key)?;
    let mut spent = started.elapsed();
    let Some(indices) = ordered else {
        for batch in buffer {
            emit(batch)?;
        }
        return Ok(spent);
    };
    let schema = buffer[0].schema();
    // Start offset of each buffered slice in the concatenated row space.
    let starts: Vec<usize> = buffer
        .iter()
        .scan(0, |next, batch| {
            let start = *next;
            *next += batch.num_rows();
            Some(start)
        })
        .collect();
    let output_rows = output_rows.max(1);
    let mut positions: Vec<(usize, usize)> = Vec::with_capacity(output_rows.min(rows_len));
    for chunk in indices.chunks(output_rows) {
        let chunk_started = Instant::now();
        positions.clear();
        positions.extend(chunk.iter().map(|index| {
            let index = *index as usize;
            let slice = starts.partition_point(|start| *start <= index) - 1;
            (slice, index - starts[slice])
        }));
        let columns: Vec<ArrayRef> = (0..schema.fields().len())
            .into_par_iter()
            .map(|column| {
                let values: Vec<&dyn Array> =
                    buffer.iter().map(|b| b.column(column).as_ref()).collect();
                interleave(&values, &positions)
            })
            .collect::<Result<_, _>>()?;
        let batch = RecordBatch::try_new(schema.clone(), columns)?;
        spent += chunk_started.elapsed();
        emit(batch)?;
    }
    Ok(spent)
}

/// Concatenates one row group's slices and returns them clustered. Test-only
/// convenience over [`cluster_row_group_into`].
#[cfg(test)]
pub(super) fn cluster_row_group(
    schema: &Arc<Schema>,
    buffer: Vec<RecordBatch>,
    key: LogClusterKey,
) -> Result<RecordBatch, StagingError> {
    let mut out = Vec::new();
    cluster_row_group_into(buffer, key, CLUSTER_OUTPUT_BATCH_ROWS, |batch| {
        out.push(batch);
        Ok(())
    })?;
    Ok(arrow::compute::concat_batches(schema, &out)?)
}

#[derive(Debug, Default, Clone, Copy)]
pub(super) struct LogClusterWriteStats {
    pub(super) rows: usize,
    pub(super) row_groups: usize,
    pub(super) cluster_duration: Duration,
}

/// Writes log batches to `file`, clustering each row group of exactly
/// `target_rows` rows (the final group may be partial). Row-group membership
/// matches what `ArrowWriter` would produce for the same input sequence.
pub(super) fn write_clustered_log_parquet(
    file: &mut File,
    records: impl Iterator<Item = Result<RecordBatch, ArrowError>>,
    schema: &Arc<Schema>,
    props: &WriterProperties,
    target_rows: usize,
    key: LogClusterKey,
) -> Result<LogClusterWriteStats, StagingError> {
    if target_rows == 0 {
        return Err(ParquetError::General(
            "Parquet row-group target must be greater than zero".to_string(),
        )
        .into());
    }
    let mut writer = ArrowWriter::try_new(file, schema.clone(), Some(props.clone()))?;
    let mut stats = LogClusterWriteStats::default();
    let mut buffer: Vec<RecordBatch> = Vec::new();
    let mut buffered_rows = 0;

    let emit = |buffer: Vec<RecordBatch>,
                writer: &mut ArrowWriter<&mut File>,
                stats: &mut LogClusterWriteStats|
     -> Result<(), StagingError> {
        let mut rows = 0;
        let spent = cluster_row_group_into(buffer, key, CLUSTER_OUTPUT_BATCH_ROWS, |batch| {
            rows += batch.num_rows();
            writer.write(&batch)?;
            Ok(())
        })?;
        stats.cluster_duration += spent;
        stats.rows += rows;
        stats.row_groups += 1;
        // The batches are exactly one row group; close it explicitly so the
        // group boundary never depends on the writer's own limits.
        writer.flush()?;
        Ok(())
    };

    for record in records {
        let record = record?;
        let record_rows = record.num_rows();
        let mut offset = 0;
        while offset < record_rows {
            let rows = (target_rows - buffered_rows).min(record_rows - offset);
            buffer.push(record.slice(offset, rows));
            buffered_rows += rows;
            offset += rows;
            if buffered_rows == target_rows {
                emit(std::mem::take(&mut buffer), &mut writer, &mut stats)?;
                buffered_rows = 0;
            }
        }
    }
    if buffered_rows > 0 {
        emit(buffer, &mut writer, &mut stats)?;
    }
    writer.close()?;
    Ok(stats)
}
