/*
 * Parseable Server (C) 2022 - 2025 Parseable, Inc.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

//! #95 process-crash reproductions, adapted from the handoff's crash recovery,
//! restart matrix, and mixed-schema fixtures. This is not a power-loss test or
//! an HTTP/object-store integration test. Successful pushes form the ID ledger.
//! Each desired oracle runs recovery and two further quiescent restarts before
//! checking multiplicity. No passing duplicate characterization is a health test.

use std::{
    collections::BTreeMap,
    panic::{AssertUnwindSafe, catch_unwind},
};

use arrow_array::{Array, Int32Array, StringArray, TimestampMillisecondArray};
use arrow_schema::{DataType, TimeUnit};
use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;
use sha2::{Digest, Sha256};
use temp_dir::TempDir;

use super::*;

const NAME: &str = "issue95-conversion-recovery";
const IDS: [i32; 4] = [101, 102, 103, 104];
const CRASH: &str = "issue95 injected crash after Parquet publication";
type Pair = (i32, Option<String>);

#[derive(Clone, Copy, Debug, Default)]
struct Case {
    removed_source: Option<usize>,
    multiple_dirs: bool,
    uploaded: bool,
    crash_again: bool,
    mixed: bool,
}

fn expected_pairs(mixed: bool) -> Vec<Pair> {
    IDS.into_iter()
        .map(|id| (id, (mixed && id >= 103).then(|| format!("v{id}"))))
        .collect()
}

fn schema(evolved: bool) -> Schema {
    let mut fields = vec![
        Field::new(
            DEFAULT_TIMESTAMP_KEY,
            DataType::Timestamp(TimeUnit::Millisecond, None),
            false,
        ),
        Field::new("id", DataType::Int32, false),
    ];
    if evolved {
        fields.push(Field::new("added", DataType::Utf8, true));
    }
    Schema::new(fields)
}

fn fresh(options: Arc<Options>) -> StreamRef {
    Stream::new(options, NAME, LogStreamMetadata::default(), None, &None)
}

fn fixture(dir: &TempDir, case: Case) -> StreamRef {
    let stream = fresh(Arc::new(Options {
        local_staging_path: dir.path().to_path_buf(),
        row_group_size: 1048576,
        ..Default::default()
    }));
    stream.stage_schema_file(schema(false)).unwrap();
    let now = DateTime::parse_from_rfc3339("2020-01-02T12:34:30.500Z")
        .unwrap()
        .with_timezone(&Utc);
    for (index, key) in ["schema-a", "schema-b"].into_iter().enumerate() {
        let mut columns: Vec<ArrayRef> = vec![
            Arc::new(TimestampMillisecondArray::from(vec![
                now.timestamp_millis();
                2
            ])),
            Arc::new(Int32Array::from(IDS[index * 2..index * 2 + 2].to_vec())),
        ];
        let evolved = case.mixed && index == 1;
        if evolved {
            columns.push(Arc::new(StringArray::from(vec!["v103", "v104"])));
        }
        let batch = RecordBatch::try_new(Arc::new(schema(evolved)), columns).unwrap();
        stream
            .push(
                key,
                &batch,
                now.naive_utc(),
                &HashMap::new(),
                StreamType::UserDefined,
            )
            .unwrap();
        if case.multiple_dirs {
            stream.flush_with_clock(true, || now).unwrap();
            let sources = stream.arrow_files();
            assert_eq!(sources.len(), 1, "fixture: one source per processing dir");
            let directory = stream
                .data_path
                .join(format!("{INPROCESS_DIR_PREFIX}{}", ['a', 'b'][index]));
            fs::create_dir_all(&directory).unwrap();
            fs::rename(&sources[0], directory.join(sources[0].file_name().unwrap())).unwrap();
        }
    }
    stream.flush_with_clock(true, || now).unwrap();
    assert!(stream.writer.lock().unwrap().disk.is_empty());
    assert_eq!(
        stream.arrow_files().len(),
        if case.multiple_dirs { 0 } else { 2 }
    );
    assert_eq!(
        stream.inprocess_arrow_files().len(),
        if case.multiple_dirs { 2 } else { 0 }
    );
    stream
}

fn batch_pairs(batch: &RecordBatch) -> Vec<Pair> {
    let ids = batch
        .column_by_name("id")
        .unwrap()
        .as_any()
        .downcast_ref::<Int32Array>()
        .unwrap();
    let added = batch
        .column_by_name("added")
        .map(|column| column.as_any().downcast_ref::<StringArray>().unwrap());
    (0..batch.num_rows())
        .map(|row| {
            assert!(!ids.is_null(row), "oracle: NULL id is unaccounted for");
            (
                ids.value(row),
                added
                    .filter(|array| !array.is_null(row))
                    .map(|array| array.value(row).to_owned()),
            )
        })
        .collect()
}

fn source_pairs(path: &Path) -> Vec<Pair> {
    let reader = arrow_ipc::reader::StreamReader::try_new(File::open(path).unwrap(), None).unwrap();
    let mut pairs = reader
        .map(Result::unwrap)
        .flat_map(|batch| batch_pairs(&batch))
        .collect::<Vec<_>>();
    pairs.sort();
    pairs
}

/// Independently enumerate disk, rather than trusting parquet_files(), which
/// validates and silently filters invalid outputs. Every listed file is read.
fn listed_parquet(directory: &Path) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    for entry in fs::read_dir(directory).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            paths.extend(listed_parquet(&path));
        } else if path
            .extension()
            .is_some_and(|extension| extension == "parquet")
        {
            paths.push(path);
        }
    }
    paths.sort();
    paths
}

#[derive(Debug, PartialEq, Eq)]
struct Snapshot {
    pairs: Vec<Pair>,
    parquet_sha256: BTreeMap<PathBuf, String>,
}

fn read_all(paths: &[PathBuf]) -> Snapshot {
    let mut pairs = Vec::new();
    let mut parquet_sha256 = BTreeMap::new();
    for path in paths {
        let file = File::open(path)
            .unwrap_or_else(|error| panic!("oracle: cannot open {path:?}: {error}"));
        let builder = ParquetRecordBatchReaderBuilder::try_new(file)
            .unwrap_or_else(|error| panic!("oracle: invalid listed Parquet {path:?}: {error}"));
        let expected_rows = builder.metadata().file_metadata().num_rows() as usize;
        let mut actual_rows = 0;
        for batch in builder
            .build()
            .unwrap_or_else(|error| panic!("oracle: cannot build reader {path:?}: {error}"))
        {
            let batch =
                batch.unwrap_or_else(|error| panic!("oracle: cannot decode {path:?}: {error}"));
            actual_rows += batch.num_rows();
            pairs.extend(batch_pairs(&batch));
        }
        assert_eq!(
            actual_rows, expected_rows,
            "oracle: unaccounted rows in {path:?}"
        );
        assert!(
            parquet_sha256
                .insert(
                    path.clone(),
                    format!("{:x}", Sha256::digest(fs::read(path).unwrap()))
                )
                .is_none()
        );
    }
    pairs.sort();
    Snapshot {
        pairs,
        parquet_sha256,
    }
}

fn snapshot(stream: &Stream, remote: &Path) -> Snapshot {
    let mut staging = listed_parquet(&stream.data_path);
    let mut selected = stream.parquet_files();
    selected.sort();
    assert_eq!(
        staging, selected,
        "oracle: raw staging listing differs from validated scan"
    );
    staging.extend(listed_parquet(remote));
    let result = read_all(&staging);
    assert_eq!(
        result.parquet_sha256.len(),
        staging.len(),
        "oracle: every listed file must be read"
    );
    result
}

fn assert_injected_crash(action: impl FnOnce()) {
    let panic =
        catch_unwind(AssertUnwindSafe(action)).expect_err("fixture must hit Published crash");
    assert_eq!(
        panic.downcast_ref::<String>().map(String::as_str),
        Some(CRASH),
        "fixture: unexpected setup panic"
    );
}

fn arm_crash(stream: &Stream, remove: Vec<PathBuf>) {
    // Published runs inside the publication lock, before memory release. The
    // old Stream is discarded after unwinding; no poisoned locks are reused.
    // Manual unlink produces the exact process-crash state of partial cleanup.
    // The fix must re-point this hook to its durable publication/retirement
    // boundaries; do not weaken the final row/value/NULL oracle.
    *stream.conversion_hook.lock().unwrap() = Some(Arc::new(move |phase| {
        if let ConversionPhase::Published = phase {
            for path in &remove {
                fs::remove_file(path).unwrap();
            }
            panic!("{CRASH}");
        }
    }));
}

fn crash_initial(stream: &Stream, case: Case) -> PathBuf {
    let now = SystemTime::now();
    let (claim, mut groups) = stream.claim_conversion_groups(
        now,
        minute_from_system_time(now) - 1,
        case.multiple_dirs,
        true,
    );
    assert_eq!(groups.len(), 1, "fixture: one consolidated output");
    let (output, mut sources) = groups.pop().unwrap();
    sources.sort_by_key(|path| source_pairs(path)[0].0);
    assert_eq!(sources.len(), 2);
    for (index, source) in sources.iter().enumerate() {
        assert_eq!(
            source_pairs(source),
            expected_pairs(case.mixed)[index * 2..index * 2 + 2]
        );
    }
    if case.multiple_dirs {
        assert_ne!(sources[0].parent(), sources[1].parent());
    }
    let remove = case
        .removed_source
        .map(|index| vec![sources[index].clone()])
        .unwrap_or_default();
    arm_crash(stream, remove.clone());
    assert_injected_crash(|| {
        stream
            .convert_arrow_group(output.clone(), sources.clone(), None, None, &None)
            .unwrap();
    });
    assert_eq!(
        read_all(std::slice::from_ref(&output)).pairs,
        expected_pairs(case.mixed)
    );
    assert!(!parquet_part_path(&output).exists());
    for path in &sources {
        assert_eq!(path.exists(), !remove.contains(path));
    }
    assert_eq!(stream.inprocess_arrow_files().len(), 2 - remove.len());
    drop(claim);
    output
}

fn observe(case: Case, control: bool) -> Snapshot {
    let dir = TempDir::new().unwrap();
    let remote = dir.path().join("fake-remote");
    fs::create_dir(&remote).unwrap();
    let stream = fixture(&dir, case);
    let options = Arc::clone(&stream.options);
    if control {
        stream.prepare_parquet(false, true, &None).unwrap();
        assert_eq!(snapshot(&stream, &remote).pairs, expected_pairs(case.mixed));
    } else {
        let output = crash_initial(&stream, case);
        if case.uploaded {
            // A durable fake remote object plus local deletion; no real upload,
            // manifest publication, query handoff, or remote schema is modeled.
            let destination = remote.join(output.file_name().unwrap());
            fs::copy(&output, &destination).unwrap();
            fs::remove_file(&output).unwrap();
            assert_eq!(read_all(&[destination]).pairs, expected_pairs(case.mixed));
        }
    }
    drop(stream);

    if case.crash_again {
        let restarted = fresh(Arc::clone(&options));
        arm_crash(&restarted, Vec::new());
        let plan = restarted.prepare_startup_sync(None).unwrap();
        assert_injected_crash(|| plan.execute().unwrap());
        assert_eq!(restarted.inprocess_arrow_files().len(), 2);
        eprintln!(
            "recovery crashed again: {:?}",
            snapshot(&restarted, &remote)
        );
        drop(restarted);
    }

    let mut previous = None;
    // First successful recovery, then TWO additional clean/quiescent restarts.
    for restart in 1..=3 {
        let restarted = fresh(Arc::clone(&options));
        restarted
            .prepare_startup_sync(None)
            .unwrap()
            .execute()
            .unwrap();
        restarted.prepare_parquet(false, true, &None).unwrap();
        assert!(
            restarted.arrow_files().is_empty(),
            "fixture: root sources not drained"
        );
        assert!(
            restarted.inprocess_arrow_files().is_empty(),
            "fixture: processing sources not drained"
        );
        let current = snapshot(&restarted, &remote);
        eprintln!("case={case:?}, clean_restart={restart}: {current:?}");
        if let Some(previous) = &previous {
            assert_eq!(
                &current, previous,
                "quiescent restart changed rows or Parquet bytes/paths"
            );
        }
        previous = Some(current);
        drop(restarted);
    }
    previous.unwrap()
}

#[track_caller]
fn exactly_once(case: Case) {
    let actual = observe(case, false).pairs;
    if case.mixed {
        assert_eq!(
            actual,
            expected_pairs(true),
            "FINAL_ISSUE95_EXACTLY_ONCE_VALUES_NULLS: {case:?}"
        );
    } else {
        let actual_ids = actual
            .into_iter()
            .map(|(id, value)| {
                assert_eq!(value, None, "oracle: unexpected value in ID-only fixture");
                id
            })
            .collect::<Vec<_>>();
        assert_eq!(actual_ids, IDS, "FINAL_ISSUE95_EXACTLY_ONCE_IDS: {case:?}");
    }
}

#[test]
fn completed_cleanup_control() {
    assert_eq!(observe(Case::default(), true).pairs, expected_pairs(false));
}

#[test]
#[ignore = "#95: fails on main; enabled by the fix"]
fn all_sources_survive() {
    exactly_once(Case::default());
}

#[test]
#[ignore = "#95: fails on main; enabled by the fix"]
fn first_source_removed() {
    exactly_once(Case {
        removed_source: Some(0),
        ..Case::default()
    });
}

#[test]
#[ignore = "#95: fails on main; enabled by the fix"]
fn second_source_removed() {
    exactly_once(Case {
        removed_source: Some(1),
        ..Case::default()
    });
}

#[test]
#[ignore = "#95: fails on main; enabled by the fix"]
fn multiple_dirs_all_survive() {
    exactly_once(Case {
        multiple_dirs: true,
        ..Case::default()
    });
}

#[test]
#[ignore = "#95: fails on main; enabled by the fix"]
fn multiple_dirs_first_source_removed() {
    exactly_once(Case {
        multiple_dirs: true,
        removed_source: Some(0),
        ..Case::default()
    });
}

#[test]
#[ignore = "#95: fails on main; enabled by the fix"]
fn multiple_dirs_second_source_removed() {
    exactly_once(Case {
        multiple_dirs: true,
        removed_source: Some(1),
        ..Case::default()
    });
}

#[test]
#[ignore = "#95: fails on main; enabled by the fix"]
fn recovery_crashes_again() {
    exactly_once(Case {
        crash_again: true,
        ..Case::default()
    });
}

#[test]
#[ignore = "#95: fails on main; enabled by the fix"]
fn uploaded_all_survive() {
    exactly_once(Case {
        uploaded: true,
        ..Case::default()
    });
}

#[test]
#[ignore = "#95: fails on main; enabled by the fix"]
fn uploaded_first_source_removed() {
    exactly_once(Case {
        uploaded: true,
        removed_source: Some(0),
        ..Case::default()
    });
}

#[test]
#[ignore = "#95: fails on main; enabled by the fix"]
fn uploaded_second_source_removed() {
    exactly_once(Case {
        uploaded: true,
        removed_source: Some(1),
        ..Case::default()
    });
}

#[test]
#[ignore = "#95: fails on main; enabled by the fix"]
fn mixed_schema_all_survive() {
    exactly_once(Case {
        mixed: true,
        ..Case::default()
    });
}

#[test]
#[ignore = "#95: fails on main; enabled by the fix"]
fn mixed_schema_first_source_removed() {
    exactly_once(Case {
        mixed: true,
        removed_source: Some(0),
        ..Case::default()
    });
}

#[test]
#[ignore = "#95: fails on main; enabled by the fix"]
fn mixed_schema_second_source_removed() {
    exactly_once(Case {
        mixed: true,
        removed_source: Some(1),
        ..Case::default()
    });
}
