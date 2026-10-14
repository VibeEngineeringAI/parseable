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

use std::collections::HashMap;

use itertools::Itertools;
use parquet::file::{
    metadata::{RowGroupMetaData, SortingColumn},
    reader::FileReader,
    statistics::Statistics,
};

use crate::metastore::metastore_traits::MetastoreObject;

use super::column::Column;

#[derive(
    Debug,
    Default,
    Clone,
    Copy,
    PartialEq,
    Eq,
    serde_repr::Serialize_repr,
    serde_repr::Deserialize_repr,
)]
#[repr(u8)]
pub enum SortOrder {
    AscNullsFirst = 0,
    AscNullsLast,
    DescNullsLast,
    #[default]
    DescNullsFirst,
}

pub type SortInfo = (String, SortOrder);
pub const CURRENT_MANIFEST_VERSION: &str = "v1";

/// Leading bytes of a zstd frame, used to tell a compressed manifest from a
/// plain JSON one. Manifests written before compression was introduced are
/// still read as-is, and the file name is identical either way, so this is the
/// only thing distinguishing the two encodings.
const ZSTD_MAGIC: [u8; 4] = [0x28, 0xB5, 0x2F, 0xFD];

/// Compression level for manifests. Manifest JSON repeats the same column names
/// across thousands of file entries, so it compresses roughly 15-25x even at
/// this cheap level; higher levels cost write time for very little extra.
const ZSTD_LEVEL: i32 = 3;

/// Cap on manifests being decoded at once by [`decode_manifest_blocking`].
///
/// Decoding is CPU bound, so there is nothing to gain past the core count, and
/// each in-flight decode holds a fully decompressed manifest in memory — which
/// is two orders of magnitude larger than the compressed form.
static DECODE_PERMITS: std::sync::LazyLock<std::sync::Arc<tokio::sync::Semaphore>> =
    std::sync::LazyLock::new(|| std::sync::Arc::new(tokio::sync::Semaphore::new(num_cpus::get())));

#[derive(Debug, thiserror::Error)]
pub enum ManifestCodecError {
    #[error("manifest decode cancelled")]
    Cancelled,

    #[error("manifest exceeds the query decode budget")]
    BudgetExceeded,

    #[error("failed to compress manifest: {0}")]
    Compress(std::io::Error),

    #[error("manifest decode task failed: {0}")]
    Join(#[from] tokio::task::JoinError),

    #[error("failed to decompress manifest: {0}")]
    Decompress(std::io::Error),

    #[error("failed to serialize manifest: {0}")]
    Serialize(serde_json::Error),

    #[error("failed to parse manifest: {0}")]
    Parse(serde_json::Error),
}

/// Encode a manifest for storage. This and [`decode_manifest`] are the only
/// places manifest bytes are produced or interpreted; going around them would
/// write a manifest nothing else can read.
pub fn encode_manifest(manifest: &Manifest) -> Result<bytes::Bytes, ManifestCodecError> {
    let json = serde_json::to_vec(manifest).map_err(ManifestCodecError::Serialize)?;
    let compressed =
        zstd::encode_all(json.as_slice(), ZSTD_LEVEL).map_err(ManifestCodecError::Compress)?;
    Ok(bytes::Bytes::from(compressed))
}

/// Decode a manifest, accepting both the compressed and the plain JSON form.
///
/// Existing manifests are never rewritten, so uncompressed ones stay readable
/// indefinitely rather than being migrated.
pub fn decode_manifest(bytes: &[u8]) -> Result<Manifest, ManifestCodecError> {
    if bytes.starts_with(&ZSTD_MAGIC) {
        let json = zstd::decode_all(bytes).map_err(ManifestCodecError::Decompress)?;
        serde_json::from_slice(&json).map_err(ManifestCodecError::Parse)
    } else {
        serde_json::from_slice(bytes).map_err(ManifestCodecError::Parse)
    }
}

/// Optional query-local policy. It is captured before dispatching to the blocking
/// pool; no HTTP objects, credentials or task-local state enter the worker.
/// Limits count cumulative decoded JSON bytes across all manifests in this query.
/// They bound serialized input, not every allocation in the parsed object graph.
pub struct ManifestDecodeBudget {
    max_compressed_bytes: usize,
    max_decoded_bytes: usize,
    decoded_bytes: std::sync::atomic::AtomicUsize,
    exceeded: std::sync::atomic::AtomicBool,
    permits: std::sync::Arc<tokio::sync::Semaphore>,
    #[cfg(test)]
    test_hook: Option<std::sync::Arc<DecodeTestHook>>,
}

tokio::task_local! {
    static MANIFEST_DECODE_BUDGET: std::sync::Arc<ManifestDecodeBudget>;
}

impl ManifestDecodeBudget {
    pub fn new(max_compressed_bytes: usize, max_decoded_bytes: usize) -> std::sync::Arc<Self> {
        std::sync::Arc::new(Self {
            max_compressed_bytes,
            max_decoded_bytes,
            decoded_bytes: std::sync::atomic::AtomicUsize::new(0),
            exceeded: std::sync::atomic::AtomicBool::new(false),
            permits: std::sync::Arc::new(tokio::sync::Semaphore::new(2)),
            #[cfg(test)]
            test_hook: None,
        })
    }
    pub async fn scope<T>(
        self: std::sync::Arc<Self>,
        future: impl std::future::Future<Output = T>,
    ) -> T {
        MANIFEST_DECODE_BUDGET.scope(self, future).await
    }
    fn charge(&self, bytes: usize) -> std::io::Result<()> {
        use std::sync::atomic::Ordering;
        self.decoded_bytes
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
                current
                    .checked_add(bytes)
                    .filter(|total| *total <= self.max_decoded_bytes)
            })
            .map_err(|_| {
                self.exceeded.store(true, Ordering::Release);
                std::io::Error::other("manifest decode budget exceeded")
            })?;
        Ok(())
    }
}

struct StopDecodeOnDrop {
    cancelled: std::sync::Arc<std::sync::atomic::AtomicBool>,
    abort: Option<tokio::task::AbortHandle>,
}
impl Drop for StopDecodeOnDrop {
    fn drop(&mut self) {
        self.cancelled
            .store(true, std::sync::atomic::Ordering::Release);
        // Abort queued work; a running worker observes the cancellation flag.
        if let Some(abort) = &self.abort {
            abort.abort();
        }
    }
}

const DECODE_CHECK_BYTES: usize = 16 * 1024;
struct CheckedDecodeRead<R> {
    inner: R,
    cancelled: std::sync::Arc<std::sync::atomic::AtomicBool>,
    budget: Option<std::sync::Arc<ManifestDecodeBudget>>,
}
impl<R: std::io::Read> std::io::Read for CheckedDecodeRead<R> {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        use std::sync::atomic::Ordering;
        if self.cancelled.load(Ordering::Acquire) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::ConnectionAborted,
                "manifest decode cancelled",
            ));
        }
        if self
            .budget
            .as_ref()
            .is_some_and(|budget| budget.exceeded.load(Ordering::Acquire))
        {
            return Err(std::io::Error::other("manifest decode budget exceeded"));
        }
        let count = out.len().min(DECODE_CHECK_BYTES);
        let bytes = self.inner.read(&mut out[..count])?;
        if self.cancelled.load(Ordering::Acquire) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::ConnectionAborted,
                "manifest decode cancelled",
            ));
        }
        if let Some(budget) = &self.budget {
            budget.charge(bytes)?;
        }
        Ok(bytes)
    }
}

fn parse_checked_manifest<R: std::io::Read>(
    reader: R,
    cancelled: std::sync::Arc<std::sync::atomic::AtomicBool>,
    budget: std::sync::Arc<ManifestDecodeBudget>,
    compressed: bool,
) -> Result<Manifest, ManifestCodecError> {
    use std::sync::atomic::Ordering;
    let checked = CheckedDecodeRead {
        inner: reader,
        cancelled: cancelled.clone(),
        budget: Some(budget.clone()),
    };
    // Serde checks cancellation while parsing too: every refill passes through
    // the checked reader. There is no intermediate decompressed Vec allocation.
    let result = serde_json::from_reader(std::io::BufReader::with_capacity(
        DECODE_CHECK_BYTES,
        checked,
    ));
    if cancelled.load(Ordering::Acquire) {
        return Err(ManifestCodecError::Cancelled);
    }
    if budget.exceeded.load(Ordering::Acquire) {
        return Err(ManifestCodecError::BudgetExceeded);
    }
    match result {
        Err(error) if compressed && error.is_io() => {
            Err(ManifestCodecError::Decompress(std::io::Error::other(error)))
        }
        Err(error) => Err(ManifestCodecError::Parse(error)),
        Ok(manifest) => Ok(manifest),
    }
}

fn decode_manifest_checked(
    bytes: bytes::Bytes,
    cancelled: std::sync::Arc<std::sync::atomic::AtomicBool>,
    budget: std::sync::Arc<ManifestDecodeBudget>,
) -> Result<Manifest, ManifestCodecError> {
    #[cfg(test)]
    record_decode_dispatch(&bytes, DecodePath::Checked);
    #[cfg(test)]
    if let Some(hook) = budget.test_hook.as_ref() {
        hook.entered.send(()).unwrap();
        hook.resume.lock().unwrap().recv().unwrap();
    }
    if bytes.starts_with(&ZSTD_MAGIC) {
        let input = CheckedDecodeRead {
            inner: std::io::Cursor::new(bytes),
            cancelled: cancelled.clone(),
            budget: None,
        };
        let input = std::io::BufReader::with_capacity(DECODE_CHECK_BYTES, input);
        let mut decoder = zstd::stream::read::Decoder::with_buffer(input)
            .map_err(ManifestCodecError::Decompress)?;
        decoder
            .window_log_max(23) // at most 8 MiB
            .map_err(ManifestCodecError::Decompress)?;
        parse_checked_manifest(decoder, cancelled, budget, true)
    } else {
        parse_checked_manifest(std::io::Cursor::new(bytes), cancelled, budget, false)
    }
}

/// Decode a manifest on the blocking pool.
///
/// Decompressing and parsing a manifest is hundreds of milliseconds of pure
/// CPU. Run inline on an async task it serialises against every other decode
/// that task drives — callers fetch manifests with `buffered(..)`, which gives
/// concurrent I/O but polls all those futures from one task, so the decodes
/// queue up behind each other and each pending GET appears to take longer and
/// longer. Handing the work to the blocking pool lets them actually run in
/// parallel.
///
/// Without a query budget in scope this is the classic path: the in-memory
/// [`decode_manifest`], unchanged. Only a budgeted (Keystone) caller pays for
/// the streaming checked decoder, which bounds encoded input, cumulative JSON
/// bytes, decoder windows and concurrent workers, and stops cooperatively when
/// the caller drops.
pub async fn decode_manifest_blocking(bytes: bytes::Bytes) -> Result<Manifest, ManifestCodecError> {
    let Ok(budget) = MANIFEST_DECODE_BUDGET.try_with(std::sync::Arc::clone) else {
        // Owned permit moved into the task: dropping this future cancels the await
        // but not the blocking work, so the permit has to outlive it to keep
        // detached decodes counted.
        let permit = DECODE_PERMITS
            .clone()
            .acquire_owned()
            .await
            .expect("decode semaphore is never closed");
        return tokio::task::spawn_blocking(move || {
            let _permit = permit;
            #[cfg(test)]
            record_decode_dispatch(&bytes, DecodePath::Classic);
            decode_manifest(&bytes)
        })
        .await?;
    };
    if bytes.len() > budget.max_compressed_bytes {
        return Err(ManifestCodecError::BudgetExceeded);
    }
    let cancelled = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let mut stop = StopDecodeOnDrop {
        cancelled: cancelled.clone(),
        abort: None,
    };
    // Acquire query-local permits first, so a query cannot monopolize the
    // process-wide permits with futures waiting for its own two worker slots.
    let local_permit = budget
        .permits
        .clone()
        .acquire_owned()
        .await
        .expect("decode semaphore is never closed");
    let permit = DECODE_PERMITS
        .clone()
        .acquire_owned()
        .await
        .expect("decode semaphore is never closed");
    let task = tokio::task::spawn_blocking(move || {
        // Both permits and the budget live until the real worker exits, even
        // if its caller has cancelled and released its coordinator reservation.
        let _permit = permit;
        let _local_permit = local_permit;
        decode_manifest_checked(bytes, cancelled, budget)
    });
    stop.abort = Some(task.abort_handle());
    task.await?
}

/// Which decoder a blocking worker ran, keyed by the address of its input
/// buffer so parallel tests holding their own `Bytes` never see each other.
#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DecodePath {
    Classic,
    Checked,
}
#[cfg(test)]
static DECODE_DISPATCH: std::sync::Mutex<Vec<(usize, DecodePath)>> =
    std::sync::Mutex::new(Vec::new());
#[cfg(test)]
fn record_decode_dispatch(bytes: &[u8], path: DecodePath) {
    DECODE_DISPATCH
        .lock()
        .unwrap()
        .push((bytes.as_ptr() as usize, path));
}

#[cfg(test)]
struct DecodeTestHook {
    entered: std::sync::mpsc::Sender<()>,
    resume: std::sync::Mutex<std::sync::mpsc::Receiver<()>>,
}

/// An entry in a manifest which points to a single file.
/// Additionally, it is meant to store the statistics for the file it
/// points to. Used for pruning file at planning level.
#[derive(Debug, Default, Clone, serde::Serialize, serde::Deserialize)]
pub struct File {
    pub file_path: String,
    pub num_rows: u64,
    pub file_size: u64,
    pub ingestion_size: u64,
    pub columns: Vec<Column>,
    pub sort_order_id: Vec<SortInfo>,
}

/// A manifest file composed of multiple file entries.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Manifest {
    pub version: String,
    pub files: Vec<File>,
}

impl Default for Manifest {
    fn default() -> Self {
        Self {
            version: CURRENT_MANIFEST_VERSION.to_string(),
            files: Vec::default(),
        }
    }
}

impl Manifest {
    pub fn apply_change(&mut self, change: File) {
        if let Some(pos) = self
            .files
            .iter()
            .position(|file| file.file_path == change.file_path)
        {
            self.files[pos] = change
        } else {
            self.files.push(change)
        }
    }
}

impl MetastoreObject for Manifest {
    fn get_object_path(&self) -> String {
        unimplemented!()
    }

    fn get_object_id(&self) -> String {
        unimplemented!()
    }
}

pub fn create_from_parquet_file(
    object_store_path: String,
    fs_file_path: &std::path::Path,
) -> anyhow::Result<File> {
    let mut manifest_file = File {
        file_path: object_store_path,
        ..File::default()
    };

    let file = std::fs::File::open(fs_file_path)?;
    manifest_file.file_size = file.metadata()?.len();

    let file = parquet::file::serialized_reader::SerializedFileReader::new(file)?;
    let file_meta = file.metadata().file_metadata();
    let row_groups = file.metadata().row_groups();

    manifest_file.num_rows = file_meta.num_rows() as u64;
    manifest_file.ingestion_size = row_groups
        .iter()
        .fold(0, |acc, x| acc + x.total_byte_size() as u64);

    let columns = column_statistics(row_groups);
    manifest_file.columns = columns.into_values().collect();
    let mut sort_orders = sort_order(row_groups);
    if let Some(last_sort_order) = sort_orders.pop()
        && sort_orders
            .into_iter()
            .all(|sort_order| sort_order == last_sort_order)
    {
        manifest_file.sort_order_id = last_sort_order;
    }

    Ok(manifest_file)
}

fn sort_order(
    row_groups: &[parquet::file::metadata::RowGroupMetaData],
) -> Vec<Vec<(String, SortOrder)>> {
    let mut sort_orders = Vec::new();
    for row_group in row_groups {
        let sort_order = row_group.sorting_columns().unwrap();
        let sort_order = sort_order
            .iter()
            .map(|sort_order| {
                let SortingColumn {
                    column_idx,
                    descending,
                    nulls_first,
                } = sort_order;
                let col = row_group
                    .column(*column_idx as usize)
                    .column_descr()
                    .path()
                    .string();
                let sort_info = match (descending, nulls_first) {
                    (true, true) => SortOrder::DescNullsFirst,
                    (true, false) => SortOrder::DescNullsLast,
                    (false, true) => SortOrder::AscNullsFirst,
                    (false, false) => SortOrder::AscNullsLast,
                };

                (col, sort_info)
            })
            .collect_vec();

        sort_orders.push(sort_order);
    }
    sort_orders
}

fn column_statistics(row_groups: &[RowGroupMetaData]) -> HashMap<String, Column> {
    let mut columns: HashMap<String, Column> = HashMap::new();
    for row_group in row_groups {
        for col in row_group.columns() {
            let col_name = col.column_descr().path().string();
            if let Some(entry) = columns.get_mut(&col_name) {
                entry.compressed_size += col.compressed_size() as u64;
                entry.uncompressed_size += col.uncompressed_size() as u64;
                entry.null_count = entry
                    .null_count
                    .zip(col.statistics().and_then(Statistics::null_count_opt))
                    .and_then(|(current, other)| current.checked_add(other));
                if let Some(other) = col.statistics().and_then(|stats| stats.try_into().ok()) {
                    entry.stats = entry.stats.clone().and_then(|this| this.update(other));
                }
            } else {
                columns.insert(
                    col_name.clone(),
                    Column {
                        name: col_name,
                        stats: col.statistics().and_then(|stats| stats.try_into().ok()),
                        null_count: col.statistics().and_then(Statistics::null_count_opt),
                        uncompressed_size: col.uncompressed_size() as u64,
                        compressed_size: col.compressed_size() as u64,
                    },
                );
            }
        }
    }
    columns
}

#[cfg(test)]
mod codec_tests {
    use super::*;

    fn sample_manifest(file_count: usize) -> Manifest {
        let files = (0..file_count)
            .map(|i| File {
                file_path: format!("stream/date=2026-07-29/hour=00/file-{i}.parquet"),
                num_rows: 262_144,
                file_size: 1_048_576,
                ingestion_size: 2_097_152,
                columns: (0..64)
                    .map(|c| Column {
                        name: format!("some_reasonably_long_column_name_{c}"),
                        stats: None,
                        null_count: None,
                        uncompressed_size: 1024,
                        compressed_size: 512,
                    })
                    .collect(),
                sort_order_id: Vec::new(),
            })
            .collect();
        Manifest {
            version: CURRENT_MANIFEST_VERSION.to_string(),
            files,
        }
    }

    #[test]
    fn round_trips() {
        let manifest = sample_manifest(4);
        let decoded = decode_manifest(&encode_manifest(&manifest).unwrap()).unwrap();

        assert_eq!(decoded.version, manifest.version);
        assert_eq!(decoded.files.len(), manifest.files.len());
        assert_eq!(decoded.files[0].file_path, manifest.files[0].file_path);
        assert_eq!(
            decoded.files[0].columns.len(),
            manifest.files[0].columns.len()
        );
    }

    #[test]
    fn encodes_as_zstd() {
        let encoded = encode_manifest(&sample_manifest(1)).unwrap();
        assert!(
            encoded.starts_with(&ZSTD_MAGIC),
            "manifest was not compressed"
        );
    }

    /// Manifests written before compression are never rewritten, so plain JSON
    /// has to stay readable forever.
    #[test]
    fn reads_uncompressed_manifests() {
        let manifest = sample_manifest(3);
        let plain = serde_json::to_vec(&manifest).unwrap();
        assert!(!plain.starts_with(&ZSTD_MAGIC));

        let decoded = decode_manifest(&plain).unwrap();
        assert_eq!(decoded.files.len(), 3);
        assert_eq!(decoded.files[2].file_path, manifest.files[2].file_path);
    }

    /// Guards against the codec silently degrading to a no-op: this shape is
    /// the whole reason compression is worth doing.
    #[test]
    fn compresses_repetitive_manifests_substantially() {
        let manifest = sample_manifest(64);
        let plain_len = serde_json::to_vec(&manifest).unwrap().len();
        let encoded_len = encode_manifest(&manifest).unwrap().len();

        assert!(
            encoded_len * 10 < plain_len,
            "expected >10x compression, got {plain_len} -> {encoded_len}"
        );
    }

    #[test]
    fn rejects_truncated_compressed_input() {
        let encoded = encode_manifest(&sample_manifest(8)).unwrap();
        let truncated = &encoded[..encoded.len() / 2];

        assert!(matches!(
            decode_manifest(truncated),
            Err(ManifestCodecError::Decompress(_))
        ));
    }

    #[test]
    fn rejects_garbage_input() {
        assert!(matches!(
            decode_manifest(b"not json, not zstd"),
            Err(ManifestCodecError::Parse(_))
        ));
    }
    #[tokio::test]
    async fn query_decode_budget_bounds_compressed_plain_and_cumulative_json() {
        let manifest = sample_manifest(16);
        let plain = serde_json::to_vec(&manifest).unwrap();
        let compressed = encode_manifest(&manifest).unwrap();
        let budget = ManifestDecodeBudget::new(compressed.len() - 1, plain.len());
        assert!(matches!(
            budget
                .scope(decode_manifest_blocking(compressed.clone()))
                .await,
            Err(ManifestCodecError::BudgetExceeded)
        ));
        let budget = ManifestDecodeBudget::new(plain.len(), plain.len() - 1);
        assert!(matches!(
            budget
                .scope(decode_manifest_blocking(compressed.clone()))
                .await,
            Err(ManifestCodecError::BudgetExceeded)
        ));
        let budget = ManifestDecodeBudget::new(plain.len(), plain.len() - 1);
        assert!(matches!(
            budget
                .scope(decode_manifest_blocking(plain.clone().into()))
                .await,
            Err(ManifestCodecError::BudgetExceeded)
        ));
        let budget = ManifestDecodeBudget::new(plain.len(), plain.len() * 2 - 1);
        assert_eq!(
            budget
                .clone()
                .scope(decode_manifest_blocking(compressed.clone()))
                .await
                .unwrap()
                .files
                .len(),
            manifest.files.len()
        );
        assert!(matches!(
            budget
                .clone()
                .scope(decode_manifest_blocking(compressed))
                .await,
            Err(ManifestCodecError::BudgetExceeded)
        ));
        assert!(
            budget
                .decoded_bytes
                .load(std::sync::atomic::Ordering::Acquire)
                < plain.len() * 2
        );
    }
    /// Classic callers have no budget in scope and must keep the original
    /// in-memory decoder; only budgeted calls take the streaming checked one.
    #[tokio::test]
    async fn blocking_decoder_uses_classic_decoder_unless_a_budget_is_in_scope() {
        let manifest = sample_manifest(4);
        for bytes in [
            encode_manifest(&manifest).unwrap(),
            serde_json::to_vec(&manifest).unwrap().into(),
        ] {
            let address = bytes.as_ptr() as usize;
            // `bytes` stays alive, so no other test can record this address
            // after the purge; earlier entries are from freed buffers.
            DECODE_DISPATCH
                .lock()
                .unwrap()
                .retain(|(recorded, _)| *recorded != address);
            let paths = || {
                DECODE_DISPATCH
                    .lock()
                    .unwrap()
                    .iter()
                    .filter(|(recorded, _)| *recorded == address)
                    .map(|(_, path)| *path)
                    .collect::<Vec<_>>()
            };

            assert_eq!(
                decode_manifest_blocking(bytes.clone())
                    .await
                    .unwrap()
                    .files
                    .len(),
                4
            );
            assert_eq!(paths(), [DecodePath::Classic]);

            let budget = ManifestDecodeBudget::new(1024 * 1024, 1024 * 1024);
            assert_eq!(
                budget
                    .scope(decode_manifest_blocking(bytes.clone()))
                    .await
                    .unwrap()
                    .files
                    .len(),
                4
            );
            assert_eq!(paths(), [DecodePath::Classic, DecodePath::Checked]);
        }
    }
    #[tokio::test]
    async fn cancelled_decode_keeps_permit_until_the_real_worker_exits() {
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (resume_tx, resume_rx) = std::sync::mpsc::channel();
        let mut budget = ManifestDecodeBudget::new(1024 * 1024, 1024 * 1024);
        std::sync::Arc::get_mut(&mut budget).unwrap().test_hook =
            Some(std::sync::Arc::new(DecodeTestHook {
                entered: entered_tx,
                resume: std::sync::Mutex::new(resume_rx),
            }));
        let bytes = encode_manifest(&sample_manifest(1)).unwrap();
        let task = tokio::spawn(budget.clone().scope(decode_manifest_blocking(bytes)));
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while entered_rx.try_recv().is_err() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(budget.permits.available_permits(), 1);
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        // The caller is gone but the paused real worker still owns its permit.
        assert_eq!(budget.permits.available_permits(), 1);
        resume_tx.send(()).unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while budget.permits.available_permits() != 2 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("cancelled real decoder must exit and release its permit");
        assert_eq!(
            budget
                .decoded_bytes
                .load(std::sync::atomic::Ordering::Acquire),
            0
        );
    }
    #[tokio::test]
    async fn query_decode_workers_are_limited_to_two_even_when_more_manifests_are_queued() {
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (resume_tx, resume_rx) = std::sync::mpsc::channel();
        let mut budget = ManifestDecodeBudget::new(1024 * 1024, 1024 * 1024);
        std::sync::Arc::get_mut(&mut budget).unwrap().test_hook =
            Some(std::sync::Arc::new(DecodeTestHook {
                entered: entered_tx,
                resume: std::sync::Mutex::new(resume_rx),
            }));
        let bytes = encode_manifest(&sample_manifest(1)).unwrap();
        let mut tasks = Vec::new();
        for _ in 0..3 {
            tasks.push(tokio::spawn(
                budget
                    .clone()
                    .scope(decode_manifest_blocking(bytes.clone())),
            ));
        }
        let mut started = 0;
        let expected_starts = num_cpus::get().min(2);
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while started < expected_starts {
                if entered_rx.try_recv().is_ok() {
                    started += 1;
                } else {
                    tokio::task::yield_now().await;
                }
            }
        })
        .await
        .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while budget.permits.available_permits() != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(entered_rx.try_recv().is_err());
        for task in tasks {
            task.abort();
            let _ = task.await;
        }
        // The third task never entered its worker and has no unaccounted work.
        assert_eq!(budget.permits.available_permits(), 0);
        for _ in 0..expected_starts {
            resume_tx.send(()).unwrap();
        }
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while budget.permits.available_permits() != 2 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }
    #[test]
    fn cancellation_checks_are_nonretryable_and_decode_read_chunks_are_bounded() {
        use std::io::Read;
        let cancelled = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
        let mut reader = CheckedDecodeRead {
            inner: std::io::Cursor::new(vec![0; DECODE_CHECK_BYTES * 2]),
            cancelled: cancelled.clone(),
            budget: None,
        };
        assert_eq!(
            reader.read(&mut [0; 32]).unwrap_err().kind(),
            std::io::ErrorKind::ConnectionAborted
        );
        cancelled.store(false, std::sync::atomic::Ordering::Release);
        assert_eq!(
            reader.read(&mut vec![0; DECODE_CHECK_BYTES * 2]).unwrap(),
            DECODE_CHECK_BYTES
        );
    }
    #[tokio::test]
    async fn query_decoder_rejects_zstd_windows_above_eight_mebibytes() {
        use std::io::Write;
        let manifest = Manifest {
            version: "v".repeat(9 * 1024 * 1024),
            files: Vec::new(),
        };
        let plain = serde_json::to_vec(&manifest).unwrap();
        let mut encoder = zstd::stream::write::Encoder::new(Vec::new(), 1).unwrap();
        encoder.window_log(25).unwrap();
        encoder.include_contentsize(false).unwrap();
        encoder.write_all(&plain).unwrap();
        let compressed = bytes::Bytes::from(encoder.finish().unwrap());
        let budget = ManifestDecodeBudget::new(compressed.len(), plain.len());
        assert!(matches!(
            budget
                .scope(decode_manifest_blocking(compressed.clone()))
                .await,
            Err(ManifestCodecError::Decompress(_))
        ));
        // The window cap is query policy only; classic reads keep zstd's default.
        assert_eq!(
            decode_manifest_blocking(compressed).await.unwrap().version,
            manifest.version
        );
    }
    #[tokio::test]
    async fn simultaneous_decoders_share_one_cumulative_json_limit() {
        let manifest = sample_manifest(16);
        let plain = serde_json::to_vec(&manifest).unwrap();
        let bytes = encode_manifest(&manifest).unwrap();
        let budget = ManifestDecodeBudget::new(bytes.len(), plain.len() * 2 - 1);
        let (one, two) = budget
            .clone()
            .scope(async {
                tokio::join!(
                    decode_manifest_blocking(bytes.clone()),
                    decode_manifest_blocking(bytes)
                )
            })
            .await;
        assert!(
            matches!(one, Err(ManifestCodecError::BudgetExceeded))
                || matches!(two, Err(ManifestCodecError::BudgetExceeded))
        );
        assert!(
            budget
                .decoded_bytes
                .load(std::sync::atomic::Ordering::Acquire)
                < plain.len() * 2
        );
    }
}
