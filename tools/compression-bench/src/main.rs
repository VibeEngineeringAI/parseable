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
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <http://www.gnu.org/licenses/>.
 */

//! Bounded codec-only experiment; no server, S3 or catalog dependencies.
use arrow_array::{
    ArrayRef, BooleanArray, Float64Array, Int64Array, RecordBatch, StringArray,
    TimestampMillisecondArray,
};
use arrow_ipc::{reader::FileReader, writer::FileWriter};
use arrow_schema::{DataType, Field, Schema, TimeUnit};
use parquet::{
    arrow::{
        ArrowWriter,
        arrow_reader::{ArrowReaderOptions, ParquetRecordBatchReaderBuilder},
    },
    basic::{Compression, Encoding, ZstdLevel},
    file::{
        metadata::{PageIndexPolicy, SortingColumn},
        properties::WriterProperties,
    },
    schema::types::ColumnPath,
};
use serde_json::{Value, json};
use std::{
    fs::{self, File},
    path::Path,
    sync::Arc,
    time::Instant,
};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
fn cpu_ms() -> f64 {
    // Process CPU includes worker threads. This harness uses a single writer thread.
    unsafe {
        let mut r: libc::rusage = std::mem::zeroed();
        assert_eq!(libc::getrusage(libc::RUSAGE_SELF, &mut r), 0);
        (r.ru_utime.tv_sec + r.ru_stime.tv_sec) as f64 * 1000.0
            + (r.ru_utime.tv_usec + r.ru_stime.tv_usec) as f64 / 1000.0
    }
}
fn measure<T>(f: impl FnOnce() -> Result<T>) -> Result<(T, f64, f64)> {
    let cpu = cpu_ms();
    let start = Instant::now();
    let value = f()?;
    Ok((
        value,
        start.elapsed().as_secs_f64() * 1000.0,
        cpu_ms() - cpu,
    ))
}
fn fixture(kind: &str, n: usize) -> RecordBatch {
    let mut fields = Vec::new();
    let mut cols: Vec<ArrayRef> = Vec::new();
    macro_rules! col {
        ($name:expr, $ty:expr, $array:expr) => {{
            fields.push(Field::new($name, $ty, true));
            cols.push(Arc::new($array));
        }};
    }
    // Descending timestamps, repeated timestamps, then nulls (matches declared sort).
    col!(
        "p_timestamp",
        DataType::Timestamp(TimeUnit::Millisecond, None),
        TimestampMillisecondArray::from(
            (0..n)
                .map(|i| if i >= n - n / 100 {
                    None
                } else {
                    Some(1_770_000_000_000 - (i / 3) as i64)
                })
                .collect::<Vec<_>>()
        )
    );
    col!(
        "severity",
        DataType::Utf8,
        StringArray::from(
            (0..n)
                .map(|i| Some(["INFO", "WARN", "ERROR", "DEBUG"][i % 4]))
                .collect::<Vec<_>>()
        )
    );
    col!(
        "service",
        DataType::Utf8,
        StringArray::from(
            (0..n)
                .map(|i| if i % 17 == 0 {
                    None
                } else {
                    Some(format!("service-{}", i % 29))
                })
                .collect::<Vec<_>>()
        )
    );
    col!(
        "message",
        DataType::Utf8,
        StringArray::from(
            (0..n)
                .map(|i| if i % 31 == 0 {
                    None
                } else {
                    Some(format!(
                        "request {} route /api/{} completed ✓",
                        i % 1009,
                        i % 23
                    ))
                })
                .collect::<Vec<_>>()
        )
    );
    col!(
        "request_id",
        DataType::Utf8,
        StringArray::from(
            (0..n)
                .map(|i| Some(format!(
                    "{:016x}",
                    (i as u64).wrapping_mul(0x9e3779b97f4a7c15)
                )))
                .collect::<Vec<_>>()
        )
    );
    col!(
        "duration_ms",
        DataType::Float64,
        Float64Array::from(
            (0..n)
                .map(|i| if i % 19 == 0 {
                    None
                } else {
                    Some((i % 997) as f64 / 8.0)
                })
                .collect::<Vec<_>>()
        )
    );
    col!(
        "success",
        DataType::Boolean,
        BooleanArray::from(
            (0..n)
                .map(|i| if i % 37 == 0 { None } else { Some(i % 5 != 0) })
                .collect::<Vec<_>>()
        )
    );
    col!(
        "all_null",
        DataType::Utf8,
        StringArray::from(vec![None::<&str>; n])
    );
    if kind == "wide" {
        // 48 extra sparse flattened attributes: 56 columns total.
        for c in 0..48 {
            col!(
                format!("attributes_field_{c:02}"),
                DataType::Utf8,
                StringArray::from(
                    (0..n)
                        .map(|i| if (i + c) % 5 != 0 {
                            None
                        } else {
                            Some(format!("tenant-{}-value-{}", i % 101, (i * 13 + c) % 4093))
                        })
                        .collect::<Vec<_>>()
                )
            );
        }
    }
    if kind == "otel" {
        for (name, modulo) in [
            ("resource_attributes_k8s_pod_name", 211),
            ("resource_attributes_host_name", 37),
            ("scope_name", 7),
            ("trace_id", n),
            ("span_id", n),
        ] {
            col!(
                name,
                DataType::Utf8,
                StringArray::from(
                    (0..n)
                        .map(|i| if i % 43 == 0 {
                            None
                        } else {
                            Some(format!("{name}-{:016x}", (i % modulo) as u64))
                        })
                        .collect::<Vec<_>>()
                )
            );
        }
        col!(
            "observed_time_unix_nano",
            DataType::Int64,
            Int64Array::from(
                (0..n)
                    .map(|i| Some(1_770_000_000_000_000_000i64 + i as i64 * 1001))
                    .collect::<Vec<_>>()
            )
        );
    }
    RecordBatch::try_new(Arc::new(Schema::new(fields)), cols).unwrap()
}
fn convert(ipc: &Path, path: &Path, codec: Compression, rg: usize) -> Result<()> {
    let input = FileReader::try_new(File::open(ipc)?, None)?;
    // Mirrors parquet_writer_props for ordinary unclustered logs: no custom partition,
    // no opt-in bloom filters. All unspecified Parquet 59.2.0 defaults are shared.
    let props = WriterProperties::builder()
        .set_max_row_group_row_count(Some(rg))
        .set_compression(codec)
        .set_column_encoding(
            ColumnPath::new(vec!["p_timestamp".into()]),
            Encoding::DELTA_BINARY_PACKED,
        )
        .set_sorting_columns(Some(vec![SortingColumn {
            column_idx: 0,
            descending: true,
            nulls_first: false,
        }]))
        .build();
    let time_column = ColumnPath::new(vec!["p_timestamp".into()]);
    assert_eq!(
        props.encoding(&time_column),
        Some(Encoding::DELTA_BINARY_PACKED)
    );
    assert!(props.dictionary_enabled(&time_column));
    let mut writer = ArrowWriter::try_new(File::create(path)?, input.schema(), Some(props))?;
    for batch in input {
        writer.write(&batch?)?;
    }
    writer.close()?;
    Ok(())
}
fn read(path: &Path, projection: bool) -> Result<Vec<RecordBatch>> {
    let mut builder = ParquetRecordBatchReaderBuilder::try_new(File::open(path)?)?;
    if projection {
        let mask = parquet::arrow::ProjectionMask::roots(builder.parquet_schema(), [0, 1, 5]);
        builder = builder.with_projection(mask);
    }
    Ok(builder
        .with_batch_size(8192)
        .build()?
        .collect::<std::result::Result<Vec<_>, _>>()?)
}
fn verify(path: &Path, expected: &RecordBatch, codec: Compression) -> Result<Value> {
    for projected in [false, true] {
        let expected = if projected {
            expected.project(&[0, 1, 5])?
        } else {
            expected.clone()
        };
        let mut offset = 0;
        for batch in read(path, projected)? {
            assert_eq!(batch.schema(), expected.schema());
            assert_eq!(
                batch,
                expected.slice(offset, batch.num_rows()),
                "values/nulls/timestamps differ"
            );
            offset += batch.num_rows();
        }
        assert_eq!(offset, expected.num_rows());
    }
    let options = ArrowReaderOptions::new().with_page_index_policy(PageIndexPolicy::Required);
    let builder =
        ParquetRecordBatchReaderBuilder::try_new_with_options(File::open(path)?, options)?;
    let meta = builder.metadata();
    assert_eq!(
        meta.file_metadata().num_rows() as usize,
        expected.num_rows()
    );
    for group in meta.row_groups() {
        assert_eq!(
            group.sorting_columns().map(|columns| columns.as_slice()),
            Some(
                [SortingColumn {
                    column_idx: 0,
                    descending: true,
                    nulls_first: false
                }]
                .as_slice()
            ),
            "unexpected sorting metadata"
        );
        for column in group.columns() {
            assert_eq!(column.compression(), codec, "unexpected column codec");
        }
        let time_column = group.column(0);
        if time_column
            .statistics()
            .and_then(|stats| stats.null_count_opt())
            != Some(group.num_rows() as u64)
        {
            assert!(
                time_column
                    .encodings()
                    .any(|e| e == Encoding::RLE_DICTIONARY),
                "expected dictionary encoding for this bounded timestamp fixture"
            );
        }
    }
    // Deliberately omit codec, offsets and compressed sizes; compare semantic statistics.
    let groups: Vec<_> = meta.row_groups().iter().map(|rg| json!({
        "rows": rg.num_rows(), "sorting": format!("{:?}", rg.sorting_columns()),
        "columns": rg.columns().iter().map(|c| json!({"path": c.column_path().string(), "values": c.num_values(), "encodings": format!("{:?}", c.encodings().collect::<Vec<_>>()), "statistics": format!("{:?}", c.statistics())})).collect::<Vec<_>>()
    })).collect();
    Ok(
        json!({"schema": format!("{:?}", builder.parquet_schema()), "groups": groups, "page_statistics": format!("{:?}", meta.column_index())}),
    )
}
fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().collect();
    if args.len() != 5 {
        return Err("usage: compression-bench OUTPUT_DIR ROWS REPEATS ROW_GROUP_ROWS".into());
    }
    let out = Path::new(&args[1]);
    let rows: usize = args[2].parse()?;
    let repeats: usize = args[3].parse()?;
    let rg: usize = args[4].parse()?;
    if !(100..=300_000).contains(&rows)
        || !(1..=9).contains(&repeats)
        || !(1..=262_144).contains(&rg)
        || rows.div_ceil(rg.max(1)) > 128
    {
        return Err("bounds: rows 100..300000, repeats 1..9, row group 1..262144, at most 128 groups per file".into());
    }
    // Exclusive directory prevents accidentally overwriting another experiment.
    fs::create_dir(out)?;
    println!(
        "{}",
        json!({"type":"environment", "arrow":"59.2.0", "parquet":"59.2.0", "rows":rows, "repeats":repeats, "row_group_rows":rg, "write_output_reuse":"unlink_before_timing", "loadavg":fs::read_to_string("/proc/loadavg")?})
    );
    for kind in ["app", "wide", "otel"] {
        let batch = fixture(kind, rows);
        let ipc = out.join(format!("{kind}.arrow"));
        let mut writer = FileWriter::try_new(File::create(&ipc)?, &batch.schema())?;
        for offset in (0..rows).step_by(8192) {
            writer.write(&batch.slice(offset, (rows - offset).min(8192)))?;
        }
        writer.finish()?;
        drop(writer);
        let codecs = [
            ("lz4_raw", Compression::LZ4_RAW),
            ("zstd", Compression::ZSTD(ZstdLevel::default())),
        ];
        let mut baseline = None;
        // Round zero warms both codecs; alternate AB/BA to reduce order bias.
        for round in 0..=repeats {
            for k in 0..2 {
                let (name, codec) = codecs[if round % 2 == 0 { k } else { 1 - k }];
                let path = out.join(format!("{kind}-{name}.parquet"));
                // Keep replacement of the previous round's file outside timing.
                if path.try_exists()? {
                    fs::remove_file(&path)?;
                }
                let (_, write_wall, write_cpu) = measure(|| convert(&ipc, &path, codec, rg))?;
                let stats = verify(&path, &batch, codec)?;
                if let Some(ref expected) = baseline {
                    assert_eq!(&stats, expected, "codec statistics differ");
                } else {
                    baseline = Some(stats.clone());
                }
                fs::write(
                    out.join(format!("{kind}-statistics.json")),
                    serde_json::to_vec_pretty(&stats)?,
                )?;
                let (full, read_wall, read_cpu) = measure(|| read(&path, false))?;
                assert_eq!(full.iter().map(|b| b.num_rows()).sum::<usize>(), rows);
                drop(full);
                let (projected, proj_wall, proj_cpu) = measure(|| read(&path, true))?;
                assert_eq!(projected.iter().map(|b| b.num_rows()).sum::<usize>(), rows);
                drop(projected);
                println!(
                    "{}",
                    json!({"type":"sample", "dataset":kind, "codec":name, "round":round, "warmup":round==0, "rows":rows, "columns":batch.num_columns(), "ipc_bytes":fs::metadata(&ipc)?.len(), "file_bytes":fs::metadata(&path)?.len(), "write_wall_ms":write_wall,"write_cpu_ms":write_cpu,"read_wall_ms":read_wall,"read_cpu_ms":read_cpu,"project_wall_ms":proj_wall,"project_cpu_ms":proj_cpu})
                );
            }
        }
    }
    Ok(())
}
