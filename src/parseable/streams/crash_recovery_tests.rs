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

use super::conversion_journal::journal_path;
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
    boundary: Boundary,
}

#[derive(Clone, Copy, Debug, Default)]
enum Boundary {
    PartSynced,
    JournalInstalled,
    #[default]
    AfterPublish,
    SourcesRetired,
}

fn arm_boundary(stream: &Stream, boundary: Boundary) {
    *stream.conversion_hook.lock().unwrap() = Some(Arc::new(move |phase| {
        let hit = matches!(
            (boundary, phase),
            (Boundary::PartSynced, ConversionPhase::PartSynced)
                | (
                    Boundary::JournalInstalled,
                    ConversionPhase::JournalInstalled
                )
                | (Boundary::AfterPublish, ConversionPhase::AfterPublish)
                | (Boundary::SourcesRetired, ConversionPhase::SourcesRetired)
        );
        if hit {
            panic!("{CRASH}");
        }
    }));
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
    fixture_named(dir, case, NAME)
}

fn fixture_named(dir: &TempDir, case: Case, name: &str) -> StreamRef {
    let stream = Stream::new(
        Arc::new(Options {
            local_staging_path: dir.path().to_path_buf(),
            row_group_size: 1048576,
            ..Default::default()
        }),
        name,
        LogStreamMetadata::default(),
        None,
        &None,
    );
    stream.writer.lock().unwrap().mem = Some(Default::default());
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
    if remove.is_empty() {
        arm_boundary(stream, Boundary::AfterPublish);
    } else {
        *stream.conversion_hook.lock().unwrap() = Some(Arc::new(move |phase| {
            if let ConversionPhase::SourceRemoved { source, ordinal } = phase {
                assert_eq!(ordinal, 0);
                assert!(remove.iter().any(|path| path == source));
                panic!("{CRASH}");
            }
        }));
    }
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
    if let Some(index) = case.removed_source {
        // Drive the actual unlink loop in both logical source directions.
        sources.swap(0, index);
    }
    arm_crash(stream, remove.clone());
    if case.removed_source.is_none() {
        arm_boundary(stream, case.boundary);
    }
    assert_injected_crash(|| {
        stream
            .convert_arrow_group(output.clone(), sources.clone(), None, None, &None)
            .unwrap();
    });
    let before_publish = matches!(
        case.boundary,
        Boundary::PartSynced | Boundary::JournalInstalled
    );
    let encoded = if before_publish {
        parquet_part_path(&output)
    } else {
        output.clone()
    };
    assert_eq!(read_all(&[encoded]).pairs, expected_pairs(case.mixed));
    assert_eq!(parquet_part_path(&output).exists(), before_publish);
    assert_eq!(
        journal_path(&output).exists(),
        !matches!(case.boundary, Boundary::PartSynced)
    );
    for path in &sources {
        assert_eq!(
            path.exists(),
            !remove.contains(path) && !matches!(case.boundary, Boundary::SourcesRetired)
        );
    }
    assert_eq!(
        stream.inprocess_arrow_files().len(),
        if matches!(case.boundary, Boundary::SourcesRetired) {
            0
        } else {
            2 - remove.len()
        }
    );
    drop(claim);
    output
}

fn observe(case: Case, control: bool) -> Snapshot {
    let dir = TempDir::new().unwrap();
    let remote = dir.path().join("fake-remote");
    fs::create_dir(&remote).unwrap();
    let stream = fixture(&dir, case);
    let options = Arc::clone(&stream.options);
    let mut original_output = None;
    if control {
        stream.prepare_parquet(false, true, &None).unwrap();
        assert_eq!(snapshot(&stream, &remote).pairs, expected_pairs(case.mixed));
    } else {
        let output = crash_initial(&stream, case);
        original_output = Some(output.clone());
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
        arm_boundary(&restarted, case.boundary);
        assert_injected_crash(|| {
            restarted
                .prepare_startup_sync(None)
                .unwrap()
                .execute()
                .unwrap()
        });
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
        if case.mixed {
            let staged = Schema::try_merge(restarted.get_schemas_if_present().unwrap()).unwrap();
            assert!(
                staged.field_with_name("added").is_ok(),
                "evolved field must survive source retirement"
            );
        }
        let current = snapshot(&restarted, &remote);
        if !control
            && matches!(
                case.boundary,
                Boundary::JournalInstalled | Boundary::SourcesRetired
            )
        {
            let original = original_output.as_ref().unwrap();
            let expected = if case.uploaded {
                remote.join(original.file_name().unwrap())
            } else {
                original.clone()
            };
            assert_eq!(
                current.parquet_sha256.keys().cloned().collect::<Vec<_>>(),
                vec![expected],
                "journal recovery must preserve ORIGINAL output identity"
            );
        }
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
fn all_sources_survive() {
    exactly_once(Case::default());
}

#[test]
fn first_source_removed() {
    exactly_once(Case {
        removed_source: Some(0),
        ..Case::default()
    });
}

#[test]
fn second_source_removed() {
    exactly_once(Case {
        removed_source: Some(1),
        ..Case::default()
    });
}

#[test]
fn multiple_dirs_all_survive() {
    exactly_once(Case {
        multiple_dirs: true,
        ..Case::default()
    });
}

#[test]
fn multiple_dirs_first_source_removed() {
    exactly_once(Case {
        multiple_dirs: true,
        removed_source: Some(0),
        ..Case::default()
    });
}

#[test]
fn multiple_dirs_second_source_removed() {
    exactly_once(Case {
        multiple_dirs: true,
        removed_source: Some(1),
        ..Case::default()
    });
}

#[test]
fn recovery_crashes_again() {
    exactly_once(Case {
        crash_again: true,
        ..Case::default()
    });
}

#[test]
fn uploaded_all_survive() {
    exactly_once(Case {
        uploaded: true,
        ..Case::default()
    });
}

#[test]
fn uploaded_first_source_removed() {
    exactly_once(Case {
        uploaded: true,
        removed_source: Some(0),
        ..Case::default()
    });
}

#[test]
fn uploaded_second_source_removed() {
    exactly_once(Case {
        uploaded: true,
        removed_source: Some(1),
        ..Case::default()
    });
}

#[test]
fn mixed_schema_all_survive() {
    exactly_once(Case {
        mixed: true,
        ..Case::default()
    });
}

#[test]
fn mixed_schema_first_source_removed() {
    exactly_once(Case {
        mixed: true,
        removed_source: Some(0),
        ..Case::default()
    });
}

#[test]
fn mixed_schema_second_source_removed() {
    exactly_once(Case {
        mixed: true,
        removed_source: Some(1),
        ..Case::default()
    });
}

#[test]
fn before_journal_discards_uncommitted_part() {
    exactly_once(Case {
        boundary: Boundary::PartSynced,
        ..Case::default()
    });
}

#[test]
fn journal_installed_recovers_original_output_and_repeated_interruption() {
    exactly_once(Case {
        boundary: Boundary::JournalInstalled,
        crash_again: true,
        ..Case::default()
    });
}

#[test]
fn sources_retired_collects_journal_after_repeated_interruption() {
    exactly_once(Case {
        boundary: Boundary::SourcesRetired,
        crash_again: true,
        ..Case::default()
    });
}

fn clear_hook(stream: &Stream) {
    *stream.conversion_hook.lock().unwrap() = None;
}

fn capture_pairs(stream: &Stream) -> (Vec<Pair>, Vec<Pair>) {
    let (memory, disk) = stream
        .capture_staging(&Arc::new(schema(true)), |dir| {
            read_all(&listed_parquet(dir)).pairs
        })
        .unwrap();
    let mut memory = memory.iter().flat_map(batch_pairs).collect::<Vec<_>>();
    memory.sort();
    (memory, disk)
}

#[test]
fn init_flush_resolves_journal_before_orphan_part_cleanup() {
    let dir = TempDir::new().unwrap();
    let case = Case {
        boundary: Boundary::JournalInstalled,
        ..Case::default()
    };
    let stream = fixture(&dir, case);
    let output = crash_initial(&stream, case);
    let options = Arc::clone(&stream.options);
    drop(stream);
    let restarted = fresh(options);
    restarted.flush_and_convert(true, false, &None).unwrap();
    assert_eq!(listed_parquet(&restarted.data_path), vec![output]);
    assert_eq!(
        read_all(&restarted.parquet_files()).pairs,
        expected_pairs(false)
    );
    assert!(restarted.inprocess_arrow_files().is_empty());
}

#[test]
fn orphan_cleanup_preserves_even_zero_length_journaled_part() {
    let dir = TempDir::new().unwrap();
    let case = Case {
        boundary: Boundary::JournalInstalled,
        ..Case::default()
    };
    let stream = fixture(&dir, case);
    let output = crash_initial(&stream, case);
    clear_hook(&stream);
    let part = parquet_part_path(&output);
    fs::write(&part, []).unwrap();
    stream.recover_orphan_part_files();
    assert!(part.exists());
    assert!(stream.resolve_conversion_journals(&None).is_err());
    assert!(journal_path(&output).exists());
    assert_eq!(stream.inprocess_arrow_files().len(), 2);
    assert!(
        stream
            .arrow_files_grouped_exclude_time(SystemTime::now(), 1, true, false)
            .is_empty()
    );
}

#[test]
fn schema_failure_keeps_sources_and_memory_and_periodic_retry_succeeds() {
    use super::conversion_journal::JournalFault;
    let dir = TempDir::new().unwrap();
    let stream = fixture(
        &dir,
        Case {
            mixed: true,
            ..Case::default()
        },
    );
    *stream.journal_fault.lock().unwrap() = Some(JournalFault::Schema);
    assert!(stream.prepare_parquet(false, true, &None).is_err());
    assert!(stream.parquet_files().is_empty());
    assert_eq!(stream.inprocess_arrow_files().len(), 2);
    assert!(
        !fs::read_dir(&stream.data_path)
            .unwrap()
            .flatten()
            .any(|e| e.path().extension().is_some_and(|e| e == "sources"))
    );
    assert_eq!(capture_pairs(&stream), (expected_pairs(true), vec![]));
    stream.prepare_parquet(false, true, &None).unwrap();
    assert_eq!(capture_pairs(&stream), (vec![], expected_pairs(true)));
    assert!(
        Schema::try_merge(stream.get_schemas_if_present().unwrap())
            .unwrap()
            .field_with_name("added")
            .is_ok()
    );
}

#[test]
fn unlink_failure_reserves_sources_at_restart_and_periodic_retry_finishes() {
    use super::conversion_journal::JournalFault;
    let dir = TempDir::new().unwrap();
    let stream = fixture(&dir, Case::default());
    *stream.journal_fault.lock().unwrap() = Some(JournalFault::SourceUnlink);
    assert!(stream.prepare_parquet(false, true, &None).is_err());
    let original = read_all(&stream.parquet_files());
    assert_eq!(capture_pairs(&stream), (vec![], expected_pairs(false)));
    let options = Arc::clone(&stream.options);
    drop(stream);
    let restarted = fresh(options);
    *restarted.journal_fault.lock().unwrap() = Some(JournalFault::SourceUnlink);
    assert!(restarted.prepare_startup_sync(None).is_err());
    assert!(
        restarted
            .arrow_files_grouped_exclude_time(SystemTime::now(), 1, true, false)
            .is_empty()
    );
    assert_eq!(restarted.inprocess_arrow_files().len(), 2);
    restarted.prepare_parquet(false, false, &None).unwrap();
    assert!(restarted.inprocess_arrow_files().is_empty());
    assert_eq!(read_all(&restarted.parquet_files()), original);
}

#[test]
fn journal_removal_failure_allows_upload_and_empty_stream_runtime_retry() {
    use super::conversion_journal::JournalFault;
    let dir = TempDir::new().unwrap();
    let stream = fixture(&dir, Case::default());
    *stream.journal_fault.lock().unwrap() = Some(JournalFault::JournalRemoval);
    assert!(stream.prepare_parquet(false, true, &None).is_err());
    assert!(stream.inprocess_arrow_files().is_empty());
    let outputs = stream.parquet_files();
    assert_eq!(
        outputs.len(),
        1,
        "lingering journal must not hide upload eligibility"
    );
    let journal = journal_path(&outputs[0]);
    assert!(journal.exists());
    let remote = dir.path().join("remote.parquet");
    fs::copy(&outputs[0], &remote).unwrap();
    fs::remove_file(&outputs[0]).unwrap();
    // No Arrow and no local P: only prepare_parquet can own this retry.
    stream.prepare_parquet(false, false, &None).unwrap();
    assert!(!journal.exists());
    assert!(stream.parquet_files().is_empty());
    assert_eq!(read_all(&[remote]).pairs, expected_pairs(false));
}

fn edit_journal(path: &Path, edit: impl FnOnce(&mut serde_json::Value)) {
    let mut value: serde_json::Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    edit(&mut value);
    let mut journal: ConversionJournal = serde_json::from_value(value).unwrap();
    journal.resign_for_test();
    fs::write(path, serde_json::to_vec(&journal).unwrap()).unwrap();
}

#[test]
fn invalid_inventory_blocks_all_regrouping_and_repair_reopens_stream() {
    let subscriber = tracing_subscriber::fmt()
        .with_test_writer()
        .with_max_level(tracing::Level::WARN)
        .finish();
    let _logging = tracing::subscriber::set_default(subscriber);
    for bad in [
        "truncated",
        "checksum",
        "version",
        "stream",
        "relative",
        "absolute",
        "duplicate",
        "conflict",
        "oversized",
        "symlink",
    ] {
        let dir = TempDir::new().unwrap();
        let case = Case {
            boundary: Boundary::JournalInstalled,
            ..Case::default()
        };
        let stream = fixture(&dir, case);
        let output = crash_initial(&stream, case);
        clear_hook(&stream);
        let journal = journal_path(&output);
        let original = fs::read(&journal).unwrap();
        let spare = stream.data_path.join("processing_spare");
        fs::create_dir(&spare).unwrap();
        let extra_journal = stream.data_path.join("other.parquet.sources");
        match bad {
            "truncated" => fs::write(&journal, b"{").unwrap(),
            "checksum" => {
                let mut bytes = original.clone();
                let index = bytes.iter().position(|b| *b == b'1').unwrap();
                bytes[index] = b'2';
                fs::write(&journal, bytes).unwrap();
            }
            "version" => edit_journal(&journal, |v| v["record"]["version"] = 99.into()),
            "stream" => edit_journal(&journal, |v| v["record"]["stream"] = "other".into()),
            "relative" => edit_journal(&journal, |v| {
                v["record"]["sources"][0]["path"] = "../outside.arrows".into()
            }),
            "absolute" => edit_journal(&journal, |v| {
                v["record"]["sources"][0]["path"] = "/tmp/outside.arrows".into()
            }),
            "duplicate" => edit_journal(&journal, |v| {
                v["record"]["sources"][1] = v["record"]["sources"][0].clone();
            }),
            "conflict" => {
                fs::copy(&journal, &extra_journal).unwrap();
                edit_journal(&extra_journal, |v| {
                    v["record"]["output"] = "other.parquet".into()
                });
            }
            "oversized" => fs::write(&journal, vec![b' '; 4 * 1024 * 1024 + 1]).unwrap(),
            "symlink" => {
                fs::remove_file(&journal).unwrap();
                std::os::unix::fs::symlink(dir.path().join("missing"), &journal).unwrap();
            }
            _ => unreachable!(),
        }
        assert!(stream.resolve_conversion_journals(&None).is_err(), "{bad}");
        assert!(
            stream
                .arrow_files_grouped_exclude_time(SystemTime::now(), 1, true, false)
                .is_empty(),
            "{bad}"
        );
        assert!(lock_conversion_claims(&stream.conversion_claims).journals_blocked);
        let mut gated_claim = ConversionClaim::new(&stream.conversion_claims);
        assert!(
            stream
                .claim_unowned_inprocess_dirs(&mut gated_claim)
                .is_empty(),
            "invalid journal must gate even unrelated processing_spare: {bad}"
        );
        assert_eq!(stream.inprocess_arrow_files().len(), 2);
        assert!(parquet_part_path(&output).exists());
        assert!(stream.parquet_files().is_empty());
        stream.recover_orphan_part_files();
        assert!(parquet_part_path(&output).exists());
        // An independent stream's recovery/conversion remains available.
        let other = fixture_named(&dir, Case::default(), "issue95-unaffected");
        other.prepare_parquet(false, true, &None).unwrap();
        assert_eq!(
            read_all(&other.parquet_files()).pairs,
            expected_pairs(false)
        );
        if bad == "conflict" {
            fs::remove_file(extra_journal).unwrap();
        }
        if bad == "symlink" {
            fs::remove_file(&journal).unwrap();
        }
        fs::write(&journal, original).unwrap();
        stream.resolve_conversion_journals(&None).unwrap();
        assert!(!lock_conversion_claims(&stream.conversion_claims).journals_blocked);
        let mut reopened_claim = ConversionClaim::new(&stream.conversion_claims);
        assert_eq!(
            stream.claim_unowned_inprocess_dirs(&mut reopened_claim),
            vec![spare]
        );
        assert_eq!(listed_parquet(&stream.data_path), vec![output]);
        assert_eq!(
            read_all(&stream.parquet_files()).pairs,
            expected_pairs(false)
        );
    }
}

#[test]
fn source_size_mismatch_retains_journal_and_directory_reservation() {
    let dir = TempDir::new().unwrap();
    let stream = fixture(&dir, Case::default());
    let output = crash_initial(&stream, Case::default());
    clear_hook(&stream);
    let source = stream.inprocess_arrow_files().pop().unwrap();
    let original = fs::read(&source).unwrap();
    fs::write(&source, b"replacement of different size").unwrap();
    assert!(stream.resolve_conversion_journals(&None).is_err());
    assert!(journal_path(&output).exists());
    assert!(source.exists());
    assert!(source.parent().unwrap().exists());
    assert!(!lock_conversion_claims(&stream.conversion_claims).journals_blocked);
    assert!(
        stream
            .arrow_files_grouped_exclude_time(SystemTime::now(), 1, true, false)
            .is_empty()
    );
    fs::write(source, original).unwrap();
    stream.resolve_conversion_journals(&None).unwrap();
    assert_eq!(
        read_all(&stream.parquet_files()).pairs,
        expected_pairs(false)
    );
}

#[test]
fn unjournaled_legacy_processing_sources_still_replay_possible_duplicates() {
    let dir = TempDir::new().unwrap();
    let stream = fixture(&dir, Case::default());
    let output = crash_initial(&stream, Case::default());
    // Model pre-journal staging: lineage cannot be reconstructed automatically.
    fs::remove_file(journal_path(&output)).unwrap();
    clear_hook(&stream);
    stream
        .prepare_startup_sync(None)
        .unwrap()
        .execute()
        .unwrap();
    let mut duplicated = expected_pairs(false);
    duplicated.extend(expected_pairs(false));
    duplicated.sort();
    assert_eq!(read_all(&stream.parquet_files()).pairs, duplicated);
}

#[test]
fn live_conversion_journal_is_skipped_by_resolver_and_init_grouping() {
    use std::sync::mpsc::channel;
    use std::time::Duration;
    let dir = TempDir::new().unwrap();
    let stream = fixture(&dir, Case::default());
    let (paused_tx, paused_rx) = channel();
    let (resume_tx, resume_rx) = channel();
    let resume_rx = Mutex::new(resume_rx);
    *stream.conversion_hook.lock().unwrap() = Some(Arc::new(move |phase| {
        if matches!(phase, ConversionPhase::JournalInstalled) {
            paused_tx.send(()).unwrap();
            resume_rx
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(20))
                .unwrap();
        }
    }));
    let converter = {
        let stream = Arc::clone(&stream);
        std::thread::spawn(move || stream.prepare_parquet(false, true, &None))
    };
    paused_rx.recv_timeout(Duration::from_secs(20)).unwrap();
    stream.resolve_conversion_journals(&None).unwrap();
    assert!(
        stream
            .arrow_files_grouped_exclude_time(SystemTime::now(), 1, true, false)
            .is_empty()
    );
    assert_eq!(capture_pairs(&stream), (expected_pairs(false), vec![]));
    assert_eq!(stream.inprocess_arrow_files().len(), 2);
    resume_tx.send(()).unwrap();
    converter.join().unwrap().unwrap();
    assert_eq!(capture_pairs(&stream), (vec![], expected_pairs(false)));
}

#[test]
fn query_capture_sees_memory_xor_parquet_during_conversion_and_resolver_publication() {
    use std::sync::mpsc::{TryRecvError, channel};
    use std::time::Duration;
    for resolver in [false, true] {
        let dir = TempDir::new().unwrap();
        let stream = fixture(&dir, Case::default());
        if resolver {
            crash_initial(
                &stream,
                Case {
                    boundary: Boundary::JournalInstalled,
                    ..Case::default()
                },
            );
            clear_hook(&stream);
        }
        assert_eq!(capture_pairs(&stream), (expected_pairs(false), vec![]));
        let (paused_tx, paused_rx) = channel();
        let (resume_tx, resume_rx) = channel();
        let resume_rx = Mutex::new(resume_rx);
        let weak = Arc::downgrade(&stream);
        *stream.conversion_hook.lock().unwrap() = Some(Arc::new(move |phase| {
            let hit = if resolver {
                matches!(phase, ConversionPhase::Published)
            } else {
                matches!(phase, ConversionPhase::AfterPublish)
            };
            if hit {
                assert_eq!(
                    weak.upgrade().unwrap().publication.try_read().is_err(),
                    resolver
                );
                paused_tx.send(()).unwrap();
                resume_rx
                    .lock()
                    .unwrap()
                    .recv_timeout(Duration::from_secs(20))
                    .unwrap();
            }
        }));
        let worker = {
            let stream = Arc::clone(&stream);
            std::thread::spawn(move || {
                if resolver {
                    stream.resolve_conversion_journals(&None)
                } else {
                    stream.prepare_parquet(false, true, &None)
                }
            })
        };
        paused_rx.recv_timeout(Duration::from_secs(20)).unwrap();
        let (captured_tx, captured_rx) = channel();
        let (started_tx, started_rx) = channel();
        let query = {
            let stream = Arc::clone(&stream);
            std::thread::spawn(move || {
                assert_eq!(stream.publication.try_read().is_err(), resolver);
                started_tx.send(()).unwrap();
                captured_tx.send(capture_pairs(&stream)).unwrap();
            })
        };
        started_rx.recv_timeout(Duration::from_secs(20)).unwrap();
        if resolver {
            assert!(matches!(captured_rx.try_recv(), Err(TryRecvError::Empty)));
            resume_tx.send(()).unwrap();
            assert_eq!(
                captured_rx.recv_timeout(Duration::from_secs(20)).unwrap(),
                (vec![], expected_pairs(false))
            );
        } else {
            assert_eq!(
                captured_rx.recv_timeout(Duration::from_secs(20)).unwrap(),
                (vec![], expected_pairs(false))
            );
            resume_tx.send(()).unwrap();
        }
        query.join().unwrap();
        worker.join().unwrap().unwrap();
        assert_eq!(
            read_all(&stream.parquet_files()).pairs,
            expected_pairs(false)
        );
    }
}

#[test]
fn resolver_interrupted_after_each_remaining_unlink_keeps_exact_values() {
    for removed_source in [0, 1] {
        let dir = TempDir::new().unwrap();
        let remote = dir.path().join("remote");
        fs::create_dir(&remote).unwrap();
        let case = Case {
            removed_source: Some(removed_source),
            multiple_dirs: true,
            mixed: true,
            ..Case::default()
        };
        let stream = fixture(&dir, case);
        let output = crash_initial(&stream, case);
        let options = Arc::clone(&stream.options);
        drop(stream);
        let restarted = fresh(Arc::clone(&options));
        *restarted.conversion_hook.lock().unwrap() = Some(Arc::new(|phase| {
            if let ConversionPhase::SourceRemoved { ordinal, .. } = phase {
                assert_eq!(ordinal, 1);
                panic!("{CRASH}");
            }
        }));
        assert_injected_crash(|| {
            restarted
                .prepare_startup_sync(None)
                .unwrap()
                .execute()
                .unwrap()
        });
        assert!(restarted.inprocess_arrow_files().is_empty());
        assert!(journal_path(&output).exists());
        drop(restarted);
        let mut previous = None;
        for _ in 0..3 {
            let restarted = fresh(Arc::clone(&options));
            restarted
                .prepare_startup_sync(None)
                .unwrap()
                .execute()
                .unwrap();
            let current = snapshot(&restarted, &remote);
            assert_eq!(
                current.pairs,
                expected_pairs(true),
                "FINAL_ISSUE95_EXACTLY_ONCE_VALUES_NULLS"
            );
            assert_eq!(
                current.parquet_sha256.keys().cloned().collect::<Vec<_>>(),
                vec![output.clone()]
            );
            if let Some(previous) = previous {
                assert_eq!(current, previous);
            }
            previous = Some(current);
        }
    }
}

#[test]
fn publication_collision_retains_original_part_journal_and_pending_memory() {
    let dir = TempDir::new().unwrap();
    let case = Case {
        boundary: Boundary::JournalInstalled,
        ..Case::default()
    };
    let stream = fixture(&dir, case);
    let output = crash_initial(&stream, case);
    clear_hook(&stream);
    let part = parquet_part_path(&output);
    let original = fs::read(&part).unwrap();
    fs::write(&output, b"unrelated existing output").unwrap();
    assert!(stream.resolve_conversion_journals(&None).is_err());
    assert_eq!(fs::read(&part).unwrap(), original);
    assert_eq!(fs::read(&output).unwrap(), b"unrelated existing output");
    assert!(journal_path(&output).exists());
    assert_eq!(stream.inprocess_arrow_files().len(), 2);
    assert_eq!(
        stream
            .recordbatches_cloned(&Arc::new(schema(false)))
            .unwrap()
            .iter()
            .flat_map(batch_pairs)
            .collect::<Vec<_>>()
            .len(),
        4
    );
    fs::remove_file(&output).unwrap();
    stream.resolve_conversion_journals(&None).unwrap();
    assert_eq!(capture_pairs(&stream), (vec![], expected_pairs(false)));
}

#[test]
fn poisoned_publication_never_discards_journaled_part() {
    let dir = TempDir::new().unwrap();
    let stream = fixture(&dir, Case::default());
    assert!(
        catch_unwind(AssertUnwindSafe(|| {
            let _guard = stream.publication.write().unwrap();
            panic!("poison publication for test");
        }))
        .is_err()
    );
    assert!(stream.prepare_parquet(false, true, &None).is_err());
    assert!(stream.parquet_files().is_empty());
    let parts: Vec<_> = fs::read_dir(&stream.data_path)
        .unwrap()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.to_string_lossy().ends_with(".parquet.part"))
        .collect();
    assert_eq!(parts.len(), 1);
    assert!(journal_path(&parts[0].with_extension("")).exists());
    assert_eq!(read_all(&parts).pairs, expected_pairs(false));
    assert_eq!(stream.inprocess_arrow_files().len(), 2);
    assert!(
        stream
            .capture_staging(&Arc::new(schema(false)), |_| ())
            .is_err()
    );
    assert_eq!(
        stream
            .recordbatches_cloned(&Arc::new(schema(false)))
            .unwrap()
            .iter()
            .map(RecordBatch::num_rows)
            .sum::<usize>(),
        4
    );
    let options = Arc::clone(&stream.options);
    drop(stream);
    let restarted = fresh(options);
    restarted
        .prepare_startup_sync(None)
        .unwrap()
        .execute()
        .unwrap();
    assert_eq!(
        read_all(&restarted.parquet_files()).pairs,
        expected_pairs(false)
    );
}

#[test]
fn unreadable_footer_retains_journal_and_all_sources() {
    let dir = TempDir::new().unwrap();
    let case = Case {
        boundary: Boundary::JournalInstalled,
        ..Case::default()
    };
    let stream = fixture(&dir, case);
    let output = crash_initial(&stream, case);
    clear_hook(&stream);
    let part = parquet_part_path(&output);
    let original = fs::read(&part).unwrap();
    let mut corrupted = original.clone();
    let len = corrupted.len();
    corrupted[len - 4..].fill(0);
    fs::write(&part, corrupted).unwrap();
    assert!(stream.resolve_conversion_journals(&None).is_err());
    assert!(part.exists());
    assert!(journal_path(&output).exists());
    assert_eq!(stream.inprocess_arrow_files().len(), 2);
    fs::write(&part, original).unwrap();
    stream.resolve_conversion_journals(&None).unwrap();
    assert_eq!(
        read_all(&stream.parquet_files()).pairs,
        expected_pairs(false)
    );
}

#[test]
fn empty_source_directories_remain_reserved_until_journal_collection() {
    use super::conversion_journal::JournalFault;
    let dir = TempDir::new().unwrap();
    let stream = fixture(&dir, Case::default());
    let now = SystemTime::now();
    let (claim, mut groups) = stream.claim_conversion_groups(now, 4242, false, true);
    let (output, sources) = groups.pop().unwrap();
    let parent = sources[0].parent().unwrap().to_path_buf();
    assert_eq!(parent, Stream::inprocess_folder(&stream.data_path, 4242));
    *stream.journal_fault.lock().unwrap() = Some(JournalFault::JournalRemoval);
    assert!(
        stream
            .convert_arrow_group(output.clone(), sources, None, None, &None)
            .is_err()
    );
    drop(claim);
    assert!(parent.is_dir());
    assert_eq!(fs::read_dir(&parent).unwrap().count(), 0);
    // Even if external housekeeping removed the empty directory, a surviving
    // journal prevents a runtime conversion from taking the same path.
    fs::remove_dir(&parent).unwrap();
    let mut new_claim = ConversionClaim::new(&stream.conversion_claims);
    let new_dir = stream
        .claim_new_inprocess_folder(&mut new_claim, 4242)
        .unwrap();
    assert_ne!(new_dir, parent);
    fs::create_dir(&parent).unwrap();
    stream.prepare_parquet(false, false, &None).unwrap();
    assert!(!journal_path(&output).exists());
    assert!(!parent.exists());
}

#[test]
fn static_schema_conversion_preserves_no_staging_policy() {
    let dir = TempDir::new().unwrap();
    let stream = fixture(&dir, Case::default());
    stream.metadata.write().unwrap().static_schema_flag = true;
    for file in stream.schema_files() {
        fs::remove_file(file).unwrap();
    }
    stream.prepare_parquet(false, true, &None).unwrap();
    assert!(stream.schema_files().is_empty());
    assert_eq!(
        read_all(&stream.parquet_files()).pairs,
        expected_pairs(false)
    );
}
