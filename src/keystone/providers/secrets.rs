//! AES-GCM encrypted immutable credential versions. Master keys are deployment inputs,
//! supplied by the runtime and never persisted by this backend.
use super::destination::DestinationBinding;
use super::{ProviderError, destination::ValidatedDestination};
use aes_gcm::{
    Aes256Gcm, KeyInit, Nonce,
    aead::{Aead, AeadCore, OsRng, Payload},
};
use async_trait::async_trait;
use std::{
    collections::BTreeSet,
    fmt,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use zeroize::{Zeroize, Zeroizing};

#[derive(Clone, PartialEq, Eq)]
pub struct SecretReference(pub String);

impl fmt::Debug for SecretReference {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SecretReference([REDACTED])")
    }
}

pub struct ProviderSecret(Zeroizing<Vec<u8>>);

impl fmt::Debug for ProviderSecret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ProviderSecret([REDACTED])")
    }
}

impl ProviderSecret {
    pub fn new(bytes: Vec<u8>) -> Result<Self, ProviderError> {
        let bytes = Zeroizing::new(bytes);
        if !(8..=4096).contains(&bytes.len()) || !bytes.iter().all(|b| b.is_ascii_graphic()) {
            return Err(ProviderError::BindingInvalid);
        }
        Ok(Self(bytes))
    }
    /// Kept crate-private so no settings/HTTP DTO can expose a provider key.
    #[allow(dead_code)]
    pub(super) fn bytes(&self) -> &[u8] {
        &self.0
    }
}

#[async_trait]
pub trait SecretStore: Send + Sync {
    /// Returns a new immutable version. Rotating credentials must revoke the prior
    /// reference explicitly; references never resolve to a silently replaced key.
    async fn put(
        &self,
        _tenant: &str,
        _destination: &ValidatedDestination,
        _secret: ProviderSecret,
    ) -> Result<SecretReference, ProviderError> {
        Err(ProviderError::SecretStoreUnavailable)
    }
    async fn delete(
        &self,
        _tenant: &str,
        _reference: &SecretReference,
        _destination: &ValidatedDestination,
    ) -> Result<(), ProviderError> {
        Err(ProviderError::SecretStoreUnavailable)
    }
    /// Removes a version the caller's authoritative record has just superseded,
    /// WITHOUT decrypting it: a policy revision or destination change makes the old
    /// binding unverifiable, and the caller already proved ownership by holding it.
    async fn retire(
        &self,
        _tenant: &str,
        _reference: &SecretReference,
    ) -> Result<(), ProviderError> {
        Err(ProviderError::SecretStoreUnavailable)
    }
    /// Secure backends must enforce tenant identity, reference/version and exact
    /// destination binding BEFORE releasing bytes. Never cache plaintext in config.
    async fn resolve(
        &self,
        tenant: &str,
        reference: &SecretReference,
        destination: &ValidatedDestination,
    ) -> Result<ProviderSecret, ProviderError>;
}

#[derive(Default)]
pub struct UnavailableSecretStore;

#[async_trait]
impl SecretStore for UnavailableSecretStore {
    async fn resolve(
        &self,
        _: &str,
        _: &SecretReference,
        _: &ValidatedDestination,
    ) -> Result<ProviderSecret, ProviderError> {
        Err(ProviderError::SecretStoreUnavailable)
    }
}

/// Trusted local directory administrator, single process, bounded files. This is
/// encryption at rest, not a KMS, multi-host service or rollback-resistant vault.
/// The caller owns master-key provisioning/rotation; no raw key file is created.
pub struct EncryptedFileSecretStore {
    inner: Arc<StoreFiles>,
    /// One permit: file I/O runs off the async runtime, and a caller dropped while
    /// waiting detaches at most one in-flight operation, which keeps the permit
    /// until it finishes. Waiting callers queue here, not on blocking threads.
    io: Arc<tokio::sync::Semaphore>,
}
struct StoreFiles {
    directory: PathBuf,
    master_key: Zeroizing<[u8; 32]>,
    _lock: File,
    mutation: Mutex<()>,
    /// Cleared by the first write; `sweep` is only sound before any.
    pristine: AtomicBool,
}
impl fmt::Debug for EncryptedFileSecretStore {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("EncryptedFileSecretStore([REDACTED])")
    }
}

/// Counts only; residue names are never reported or logged.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct SweepReport {
    /// Unreferenced versions moved into `QUARANTINE`, never deleted.
    pub quarantined: usize,
    /// Referenced versions moved back out of `QUARANTINE`.
    pub restored: usize,
    /// Unreferenced versions left in place because quarantine is full or unusable.
    pub retained: usize,
    /// Never-published staging files removed.
    pub staging: usize,
    /// The directory held more entries than one sweep inspects.
    pub truncated: bool,
}

/// Subdirectory of the store holding sealed versions that the authoritative
/// manifest stopped referencing. A manifest is operator-owned and may be stale
/// (e.g. restored from backup), so unreferenced versions are never destroyed at
/// startup: they are moved here byte-for-byte under their original names, and
/// moved back automatically by any later startup whose manifest references them
/// again. Nothing here is read, decrypted or deleted by the backend; removal is
/// an explicit operator action once no manifest worth restoring references it.
pub const QUARANTINE: &str = "quarantine";
/// Bounds quarantine like the live directory, so it can never grow without limit.
/// When full, unreferenced versions stay in place (still never deleted) and
/// count against the live directory's entry cap until an operator intervenes.
const QUARANTINE_CAPACITY: usize = 1024;
/// One sweep inspects at most this many live-directory entries. The live
/// directory is capped at 1025 entries by `put`; anything beyond is foreign.
const SWEEP_SCAN_LIMIT: usize = 2048;

impl EncryptedFileSecretStore {
    #[cfg(test)]
    fn path(&self, reference: &SecretReference) -> Result<PathBuf, ProviderError> {
        self.inner.path(reference)
    }
    /// Reconciles crash residue with the caller's authoritative record, under the
    /// exclusive directory lock, so no other process can have work pending here.
    /// `manifest` names that record file in this directory and `live` must be
    /// every reference it holds. Refused once this handle has written anything.
    /// - `.{id}.sealing` and `{manifest stem}.{id}.pending` were never published
    ///   (both are renamed into place last) and are always removed.
    /// - `{id}.sealed` that the manifest does not reference is moved, never
    ///   deleted, into `QUARANTINE` (see there), only when the manifest exists as
    ///   a regular file. Without a manifest nothing is authoritative.
    /// - Each referenced id missing here but present in `QUARANTINE` is moved back.
    /// - Unknown names, links, directories and non-canonical ids are never touched,
    ///   and an existing name is never replaced.
    pub fn sweep(
        &self,
        manifest: &str,
        live: &BTreeSet<String>,
    ) -> Result<SweepReport, ProviderError> {
        let files = &self.inner;
        let _guard = files.mutation.lock().map_err(storage_error)?;
        if !files.pristine.swap(false, Ordering::SeqCst) {
            return Err(ProviderError::SecretStoreUnavailable);
        }
        let stem = manifest
            .strip_suffix(".json")
            .filter(|stem| {
                !stem.is_empty() && stem.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
            })
            .ok_or(ProviderError::SecretStoreUnavailable)?;
        let authoritative = fs::symlink_metadata(files.directory.join(manifest))
            .map(|metadata| metadata.is_file())
            .unwrap_or(false);
        let mut report = SweepReport::default();
        if authoritative {
            report.restored = files.restore_referenced(live)?;
        }
        // Opened lazily on the first unreferenced version; `None` inside means
        // quarantine is unusable and every such version is retained in place.
        let mut quarantine: Option<Option<Quarantine>> = None;
        let mut entries = fs::read_dir(&files.directory).map_err(storage_error)?;
        for entry in entries.by_ref().take(SWEEP_SCAN_LIMIT) {
            let entry = entry.map_err(storage_error)?;
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            let staging = name
                .strip_prefix('.')
                .and_then(|n| n.strip_suffix(".sealing"))
                .or_else(|| {
                    name.strip_prefix(stem)
                        .and_then(|n| n.strip_prefix('.'))
                        .and_then(|n| n.strip_suffix(".pending"))
                })
                .is_some_and(canonical_id);
            let unreferenced = authoritative
                && name
                    .strip_suffix(".sealed")
                    .is_some_and(|id| canonical_id(id) && !live.contains(id));
            if !(staging || unreferenced) {
                continue;
            }
            // Never follow, move or remove links, directories or devices.
            if !fs::symlink_metadata(entry.path())
                .map_err(storage_error)?
                .file_type()
                .is_file()
            {
                continue;
            }
            if staging {
                fs::remove_file(entry.path()).map_err(storage_error)?;
                report.staging += 1;
                continue;
            }
            match quarantine.get_or_insert_with(|| files.quarantine()) {
                Some(Quarantine { directory, free }) if *free > 0 => {
                    let target = directory.join(&name);
                    if !absent(&target)? {
                        report.retained += 1;
                        continue;
                    }
                    fs::rename(entry.path(), target).map_err(storage_error)?;
                    *free -= 1;
                    report.quarantined += 1;
                }
                _ => report.retained += 1,
            }
        }
        report.truncated = entries.next().is_some();
        if report.quarantined > 0 {
            // Each rename changed both directories; make both durable.
            sync_directory(&files.directory.join(QUARANTINE))?;
        }
        if report.quarantined > 0 || report.restored > 0 || report.staging > 0 {
            sync_directory(&files.directory)?;
        }
        Ok(report)
    }
    /// File I/O and fsync never run on async runtime threads. See `io`.
    async fn blocking<T: Send + 'static>(
        &self,
        operation: impl FnOnce(&StoreFiles) -> Result<T, ProviderError> + Send + 'static,
    ) -> Result<T, ProviderError> {
        let permit = self
            .io
            .clone()
            .acquire_owned()
            .await
            .map_err(storage_error)?;
        let files = self.inner.clone();
        tokio::task::spawn_blocking(move || {
            let result = files
                .mutation
                .lock()
                .map_err(storage_error)
                .and_then(|_guard| operation(&files));
            // Release the files before the permit: a permit holder sees no work in flight.
            drop(files);
            drop(permit);
            result
        })
        .await
        .map_err(storage_error)?
    }
}
struct Quarantine {
    directory: PathBuf,
    free: usize,
}
impl StoreFiles {
    /// The quarantine directory, created owner-only on first use. `None` when it
    /// is a link or not a directory, or cannot be inspected: never followed.
    fn quarantine(&self) -> Option<Quarantine> {
        let directory = self.directory.join(QUARANTINE);
        match fs::symlink_metadata(&directory) {
            Ok(metadata) if metadata.file_type().is_dir() => {}
            Ok(_) => return None,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let mut builder = fs::DirBuilder::new();
                #[cfg(unix)]
                {
                    use std::os::unix::fs::DirBuilderExt;
                    builder.mode(0o700);
                }
                builder.create(&directory).ok()?;
            }
            Err(_) => return None,
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).ok()?;
        }
        let used = fs::read_dir(&directory)
            .ok()?
            .take(QUARANTINE_CAPACITY + 1)
            .count();
        Some(Quarantine {
            free: QUARANTINE_CAPACITY.saturating_sub(used),
            directory,
        })
    }
    /// Moves each referenced version missing from the live directory back out of
    /// quarantine. Bounded by `live`, never replaces an existing live name.
    fn restore_referenced(&self, live: &BTreeSet<String>) -> Result<usize, ProviderError> {
        let quarantine = self.directory.join(QUARANTINE);
        match fs::symlink_metadata(&quarantine) {
            Ok(metadata) if metadata.file_type().is_dir() => {}
            _ => return Ok(0),
        }
        let mut restored = 0;
        for id in live.iter().filter(|id| canonical_id(id)) {
            let name = format!("{id}.sealed");
            let (held, target) = (quarantine.join(&name), self.directory.join(&name));
            let is_file = match fs::symlink_metadata(&held) {
                Ok(metadata) => metadata.file_type().is_file(),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
                Err(error) => return Err(storage_error(error)),
            };
            if is_file && absent(&target)? {
                fs::rename(&held, &target).map_err(storage_error)?;
                restored += 1;
            }
        }
        if restored > 0 {
            sync_directory(&quarantine)?;
        }
        Ok(restored)
    }
}
fn absent(path: &Path) -> Result<bool, ProviderError> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(false),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Err(error) => Err(storage_error(error)),
    }
}
fn canonical_id(id: &str) -> bool {
    uuid::Uuid::parse_str(id).is_ok_and(|parsed| parsed.to_string() == id)
}
fn sync_directory(directory: &Path) -> Result<(), ProviderError> {
    File::open(directory)
        .and_then(|file| file.sync_all())
        .map_err(storage_error)
}
impl EncryptedFileSecretStore {
    pub fn open(
        directory: impl AsRef<Path>,
        mut master_key: [u8; 32],
    ) -> Result<Self, ProviderError> {
        let key = Zeroizing::new(master_key);
        master_key.zeroize();
        if key.iter().all(|b| *b == 0) {
            return Err(ProviderError::SecretStoreUnavailable);
        }
        let directory = directory.as_ref().to_path_buf();
        if directory.exists()
            && fs::symlink_metadata(&directory)
                .map_err(storage_error)?
                .file_type()
                .is_symlink()
        {
            return Err(ProviderError::SecretStoreUnavailable);
        }
        fs::create_dir_all(&directory).map_err(storage_error)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
                .map_err(storage_error)?;
        }
        let path = directory.join("secret-store.lock");
        reject_link(&path)?;
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let lock = options.open(path).map_err(storage_error)?;
        lock.try_lock().map_err(storage_error)?;
        Ok(Self {
            inner: Arc::new(StoreFiles {
                directory,
                master_key: key,
                _lock: lock,
                mutation: Mutex::new(()),
                pristine: AtomicBool::new(true),
            }),
            io: Arc::new(tokio::sync::Semaphore::new(1)),
        })
    }
}
impl StoreFiles {
    fn path(&self, reference: &SecretReference) -> Result<PathBuf, ProviderError> {
        let id = uuid::Uuid::parse_str(&reference.0).map_err(|_| ProviderError::BindingInvalid)?;
        if id.to_string() != reference.0 {
            return Err(ProviderError::BindingInvalid);
        }
        Ok(self.directory.join(format!("{}.sealed", reference.0)))
    }
    fn cipher(&self) -> Result<Aes256Gcm, ProviderError> {
        Aes256Gcm::new_from_slice(self.master_key.as_ref())
            .map_err(|_| ProviderError::SecretStoreUnavailable)
    }
    fn resolve_sync(
        &self,
        tenant: &str,
        reference: &SecretReference,
        destination: &ValidatedDestination,
    ) -> Result<ProviderSecret, ProviderError> {
        let aad = binding_aad(tenant, reference, destination.binding())?;
        let path = self.path(reference)?;
        reject_link(&path)?;
        let file = File::open(path).map_err(|_| ProviderError::BindingInvalid)?;
        if !file.metadata().map_err(storage_error)?.is_file() {
            return Err(ProviderError::SecretStoreUnavailable);
        }
        let mut bytes = Vec::new();
        file.take(4141)
            .read_to_end(&mut bytes)
            .map_err(storage_error)?;
        if bytes.len() < 37 || bytes.len() > 4140 || &bytes[..8] != b"KEYSEC01" {
            return Err(ProviderError::BindingInvalid);
        }
        let plaintext = self
            .cipher()?
            .decrypt(
                Nonce::from_slice(&bytes[8..20]),
                Payload {
                    msg: &bytes[20..],
                    aad: &aad,
                },
            )
            .map_err(|_| ProviderError::BindingInvalid)?;
        ProviderSecret::new(plaintext)
    }
}
fn storage_error(_: impl fmt::Display) -> ProviderError {
    ProviderError::SecretStoreUnavailable
}
fn reject_link(path: &Path) -> Result<(), ProviderError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err(ProviderError::SecretStoreUnavailable)
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(storage_error(error)),
    }
}
fn binding_aad(
    tenant: &str,
    reference: &SecretReference,
    binding: &DestinationBinding,
) -> Result<Vec<u8>, ProviderError> {
    if tenant.is_empty() || tenant.len() > 256 {
        return Err(ProviderError::BindingInvalid);
    }
    serde_json::to_vec(&("keystone-secret-v1", tenant, &reference.0, binding))
        .map_err(storage_error)
}
impl StoreFiles {
    /// Ciphertext is staged under a hidden name, synced, then renamed into place,
    /// so a crash leaves either nothing, sweepable staging, or a complete version.
    fn put_sync(
        &self,
        tenant: &str,
        destination: &ValidatedDestination,
        secret: ProviderSecret,
    ) -> Result<SecretReference, ProviderError> {
        self.pristine.store(false, Ordering::SeqCst);
        if fs::read_dir(&self.directory)
            .map_err(storage_error)?
            .take(1026)
            .count()
            >= 1025
        {
            return Err(ProviderError::SecretStoreUnavailable);
        }
        let reference = SecretReference(uuid::Uuid::new_v4().to_string());
        let aad = binding_aad(tenant, &reference, destination.binding())?;
        let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
        let encrypted = self
            .cipher()?
            .encrypt(
                &nonce,
                Payload {
                    msg: secret.bytes(),
                    aad: &aad,
                },
            )
            .map_err(storage_error)?;
        drop(secret);
        let path = self.path(&reference)?;
        let staging = self.directory.join(format!(".{}.sealing", reference.0));
        // Fresh v4 ids under the exclusive lock; a pre-existing name is never replaced.
        if fs::symlink_metadata(&path).is_ok() {
            return Err(ProviderError::SecretStoreUnavailable);
        }
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut published = false;
        let result = (|| {
            let mut file = options.open(&staging).map_err(storage_error)?;
            file.write_all(b"KEYSEC01").map_err(storage_error)?;
            file.write_all(&nonce).map_err(storage_error)?;
            file.write_all(&encrypted).map_err(storage_error)?;
            file.sync_all().map_err(storage_error)?;
            fs::rename(&staging, &path).map_err(storage_error)?;
            published = true;
            sync_directory(&self.directory)?;
            Ok(reference.clone())
        })();
        if result.is_err() {
            // Unreferenced by the caller on error, so removal is always safe.
            let _ = fs::remove_file(if published { &path } else { &staging });
        }
        result
    }
    fn delete_sync(
        &self,
        tenant: &str,
        reference: &SecretReference,
        destination: &ValidatedDestination,
    ) -> Result<(), ProviderError> {
        self.pristine.store(false, Ordering::SeqCst);
        self.resolve_sync(tenant, reference, destination)?;
        fs::remove_file(self.path(reference)?).map_err(storage_error)?;
        sync_directory(&self.directory)
    }
    fn retire_sync(&self, reference: &SecretReference) -> Result<(), ProviderError> {
        self.pristine.store(false, Ordering::SeqCst);
        let path = self.path(reference)?;
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.file_type().is_file() => {}
            Ok(_) => return Err(ProviderError::SecretStoreUnavailable),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(storage_error(error)),
        }
        fs::remove_file(path).map_err(storage_error)?;
        sync_directory(&self.directory)
    }
}
#[async_trait]
impl SecretStore for EncryptedFileSecretStore {
    async fn put(
        &self,
        tenant: &str,
        destination: &ValidatedDestination,
        secret: ProviderSecret,
    ) -> Result<SecretReference, ProviderError> {
        let (tenant, destination) = (tenant.to_owned(), destination.clone());
        self.blocking(move |files| files.put_sync(&tenant, &destination, secret))
            .await
    }
    async fn resolve(
        &self,
        tenant: &str,
        reference: &SecretReference,
        destination: &ValidatedDestination,
    ) -> Result<ProviderSecret, ProviderError> {
        let (tenant, reference, destination) =
            (tenant.to_owned(), reference.clone(), destination.clone());
        self.blocking(move |files| files.resolve_sync(&tenant, &reference, &destination))
            .await
    }
    async fn delete(
        &self,
        tenant: &str,
        reference: &SecretReference,
        destination: &ValidatedDestination,
    ) -> Result<(), ProviderError> {
        let (tenant, reference, destination) =
            (tenant.to_owned(), reference.clone(), destination.clone());
        self.blocking(move |files| files.delete_sync(&tenant, &reference, &destination))
            .await
    }
    async fn retire(
        &self,
        _tenant: &str,
        reference: &SecretReference,
    ) -> Result<(), ProviderError> {
        let reference = reference.clone();
        self.blocking(move |files| files.retire_sync(&reference))
            .await
    }
}

#[cfg(test)]
pub struct FixtureSecretStore {
    pub tenant: String,
    pub reference: SecretReference,
    pub binding: DestinationBinding,
    pub synthetic_key: Vec<u8>,
}

#[cfg(test)]
#[async_trait]
impl SecretStore for FixtureSecretStore {
    async fn resolve(
        &self,
        tenant: &str,
        reference: &SecretReference,
        destination: &ValidatedDestination,
    ) -> Result<ProviderSecret, ProviderError> {
        if self.tenant != tenant || &self.reference != reference {
            return Err(ProviderError::BindingInvalid);
        }
        destination.check_binding(&self.binding)?;
        ProviderSecret::new(self.synthetic_key.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keystone::providers::{ProviderKind, destination::ApprovedDestination};

    #[tokio::test]
    async fn encrypted_file_versions_bind_tenant_origin_revision_and_survive_restart() {
        let directory = tempfile::Builder::new()
            .prefix("keystone-secrets-")
            .tempdir_in("/dev/shm")
            .unwrap();
        let approved = ApprovedDestination::from_operator_root("https://api.openai.com").unwrap();
        let destination = ValidatedDestination::validate(
            "https://api.openai.com",
            ProviderKind::OpenAiResponses,
            &approved,
            7,
        )
        .unwrap();
        let key = [42u8; 32];
        let store = EncryptedFileSecretStore::open(directory.path(), key).unwrap();
        assert!(EncryptedFileSecretStore::open(directory.path(), key).is_err());
        let reference = store
            .put(
                "tenant",
                &destination,
                ProviderSecret::new(b"SYNTHETIC_SECRET_SENTINEL".to_vec()).unwrap(),
            )
            .await
            .unwrap();
        let replacement = store
            .put(
                "tenant",
                &destination,
                ProviderSecret::new(b"SYNTHETIC_ROTATED_SENTINEL".to_vec()).unwrap(),
            )
            .await
            .unwrap();
        assert_ne!(reference, replacement);
        for entry in fs::read_dir(directory.path()).unwrap() {
            let bytes = fs::read(entry.unwrap().path()).unwrap();
            for forbidden in [
                b"SYNTHETIC_SECRET_SENTINEL".as_slice(),
                b"SYNTHETIC_ROTATED_SENTINEL".as_slice(),
                key.as_slice(),
            ] {
                assert!(
                    !bytes
                        .windows(forbidden.len())
                        .any(|window| window == forbidden)
                );
            }
        }
        drop(store);
        let store = EncryptedFileSecretStore::open(directory.path(), key).unwrap();
        assert_eq!(
            store
                .resolve("tenant", &reference, &destination)
                .await
                .unwrap()
                .bytes(),
            b"SYNTHETIC_SECRET_SENTINEL"
        );
        assert_eq!(
            store
                .resolve("other", &reference, &destination)
                .await
                .unwrap_err(),
            ProviderError::BindingInvalid
        );
        let revised = ValidatedDestination::validate(
            "https://api.openai.com",
            ProviderKind::OpenAiResponses,
            &approved,
            8,
        )
        .unwrap();
        assert_eq!(
            store
                .resolve("tenant", &reference, &revised)
                .await
                .unwrap_err(),
            ProviderError::BindingInvalid
        );
        let alternate = ApprovedDestination::from_operator_root("https://other.example").unwrap();
        let alternate = ValidatedDestination::validate(
            "https://other.example",
            ProviderKind::OpenAiResponses,
            &alternate,
            7,
        )
        .unwrap();
        assert_eq!(
            store
                .resolve("tenant", &reference, &alternate)
                .await
                .unwrap_err(),
            ProviderError::BindingInvalid
        );
        assert!(
            store
                .delete("other", &reference, &destination)
                .await
                .is_err()
        );
        store
            .delete("tenant", &reference, &destination)
            .await
            .unwrap();
        assert!(
            store
                .resolve("tenant", &reference, &destination)
                .await
                .is_err()
        );
        assert!(
            store
                .resolve("tenant", &replacement, &destination)
                .await
                .is_ok()
        );
        let path = store.path(&replacement).unwrap();
        let mut bytes = fs::read(&path).unwrap();
        *bytes.last_mut().unwrap() ^= 1;
        fs::write(&path, bytes).unwrap();
        assert_eq!(
            store
                .resolve("tenant", &replacement, &destination)
                .await
                .unwrap_err(),
            ProviderError::BindingInvalid
        );
        drop(store);
        let wrong_key = EncryptedFileSecretStore::open(directory.path(), [77u8; 32]).unwrap();
        assert!(
            wrong_key
                .resolve("tenant", &replacement, &destination)
                .await
                .is_err()
        );
    }
    #[tokio::test]
    async fn unavailable_fails_closed_and_fixture_is_tenant_bound() {
        let grant = ApprovedDestination::from_operator_root("https://api.typesafe.ai").unwrap();
        let destination =
            ValidatedDestination::validate("https://api.typesafe.ai", ProviderKind::Jev, &grant, 1)
                .unwrap();
        let reference = SecretReference("synthetic-reference".into());
        assert_eq!(
            UnavailableSecretStore
                .resolve("tenant", &reference, &destination)
                .await
                .unwrap_err(),
            ProviderError::SecretStoreUnavailable
        );
        let fixture = FixtureSecretStore {
            tenant: "tenant".into(),
            reference: reference.clone(),
            binding: destination.binding().clone(),
            synthetic_key: b"synthetic-test-only-key".to_vec(),
        };
        let secret = fixture
            .resolve("tenant", &reference, &destination)
            .await
            .unwrap();
        assert_eq!(secret.bytes(), b"synthetic-test-only-key");
        assert!(!format!("{secret:?} {reference:?}").contains("synthetic"));
        assert!(
            fixture
                .resolve("another-tenant", &reference, &destination)
                .await
                .is_err()
        );
    }

    fn fixture_directory() -> tempfile::TempDir {
        tempfile::Builder::new()
            .prefix("keystone-secrets-")
            .tempdir_in("/dev/shm")
            .unwrap()
    }
    fn destination(revision: u64) -> ValidatedDestination {
        let approved = ApprovedDestination::from_operator_root("https://api.openai.com").unwrap();
        ValidatedDestination::validate(
            "https://api.openai.com",
            ProviderKind::OpenAiResponses,
            &approved,
            revision,
        )
        .unwrap()
    }
    fn synthetic() -> ProviderSecret {
        ProviderSecret::new(b"SYNTHETIC_LIFECYCLE_SENTINEL".to_vec()).unwrap()
    }
    fn names(directory: &Path) -> BTreeSet<String> {
        fs::read_dir(directory)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect()
    }
    fn owner_only(path: &Path) {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::symlink_metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn sweep_removes_only_owned_crash_residue_and_never_live_or_unknown_files() {
        let directory = fixture_directory();
        let outside = fixture_directory();
        let key = [9u8; 32];
        let store = EncryptedFileSecretStore::open(directory.path(), key).unwrap();
        let live = store
            .put("tenant", &destination(1), synthetic())
            .await
            .unwrap();
        let orphan = store
            .put("tenant", &destination(1), synthetic())
            .await
            .unwrap();
        // Writes are atomic: only completed, owner-only versions are visible.
        for reference in [&live, &orphan] {
            owner_only(&store.path(reference).unwrap());
        }
        assert!(
            !names(directory.path())
                .iter()
                .any(|n| n.ends_with(".sealing"))
        );
        // A handle that has written can never sweep: its own work may be unpublished.
        assert!(store.sweep("providers.json", &BTreeSet::new()).is_err());
        drop(store);

        let id = || uuid::Uuid::new_v4().to_string();
        let path = |name: String| directory.path().join(name);
        let staging = [
            format!(".{}.sealing", id()),
            format!("providers.{}.pending", id()),
        ];
        // An old-format in-place write torn by a crash, never referenced.
        let torn = format!("{}.sealed", id());
        let unknown = [
            "notes.txt".to_owned(),
            "providers.json.bak".to_owned(),
            format!("{}.sealed.extra", id()),
            format!("{}.sealed", id().to_uppercase()),
            format!("other.{}.pending", id()),
            format!(".{}.sealing", "not-a-uuid"),
        ];
        for name in staging.iter().chain(unknown.iter()).chain([&torn]) {
            fs::write(path(name.clone()), b"KEYSEC01-partial").unwrap();
        }
        let linked = format!("{}.sealed", id());
        let target = outside.path().join("target");
        fs::write(&target, b"outside").unwrap();
        std::os::unix::fs::symlink(&target, path(linked.clone())).unwrap();
        let folder = format!("{}.sealed", id());
        fs::create_dir(path(folder.clone())).unwrap();

        // No authoritative manifest: staging goes, every version stays.
        let store = EncryptedFileSecretStore::open(directory.path(), key).unwrap();
        assert_eq!(
            store.sweep("providers.json", &BTreeSet::new()).unwrap(),
            SweepReport {
                staging: 2,
                ..SweepReport::default()
            }
        );
        assert!(store.path(&orphan).unwrap().is_file());
        assert!(!directory.path().join(QUARANTINE).exists());
        drop(store);

        fs::write(path("providers.json".into()), b"{}").unwrap();
        let store = EncryptedFileSecretStore::open(directory.path(), key).unwrap();
        assert_eq!(
            store
                .sweep("providers.json", &BTreeSet::from([live.0.clone()]))
                .unwrap(),
            SweepReport {
                quarantined: 2,
                ..SweepReport::default()
            }
        );
        let remaining = names(directory.path());
        let mut expected = BTreeSet::from([
            "secret-store.lock".to_owned(),
            "providers.json".to_owned(),
            QUARANTINE.to_owned(),
            format!("{}.sealed", live.0),
            linked,
            folder,
        ]);
        expected.extend(unknown);
        assert_eq!(remaining, expected);
        // Unreferenced versions are moved byte-for-byte, never deleted.
        let quarantine = directory.path().join(QUARANTINE);
        assert_eq!(
            names(&quarantine),
            BTreeSet::from([format!("{}.sealed", orphan.0), torn.clone()])
        );
        assert_eq!(
            fs::read(quarantine.join(&torn)).unwrap(),
            b"KEYSEC01-partial"
        );
        owner_only(&quarantine.join(format!("{}.sealed", orphan.0)));
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::symlink_metadata(&quarantine)
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
        }
        assert_eq!(fs::read(&target).unwrap(), b"outside");
        assert_eq!(
            store
                .resolve("tenant", &live, &destination(1))
                .await
                .unwrap()
                .bytes(),
            b"SYNTHETIC_LIFECYCLE_SENTINEL"
        );
        assert!(
            store
                .resolve("tenant", &orphan, &destination(1))
                .await
                .is_err()
        );
        assert!(store.sweep("providers.json", &BTreeSet::new()).is_err());
        drop(store);
        // A later manifest that references a quarantined version restores it.
        let store = EncryptedFileSecretStore::open(directory.path(), key).unwrap();
        assert_eq!(
            store
                .sweep(
                    "providers.json",
                    &BTreeSet::from([live.0.clone(), orphan.0.clone()])
                )
                .unwrap(),
            SweepReport {
                restored: 1,
                ..SweepReport::default()
            }
        );
        assert!(
            store
                .resolve("tenant", &orphan, &destination(1))
                .await
                .is_ok()
        );
        assert_eq!(names(&quarantine), BTreeSet::from([torn]));
        drop(store);
        let store = EncryptedFileSecretStore::open(directory.path(), key).unwrap();
        for manifest in ["", ".json", "../providers.json", "providers", "a/b.json"] {
            assert!(
                EncryptedFileSecretStore::open(fixture_directory().path(), key)
                    .unwrap()
                    .sweep(manifest, &BTreeSet::new())
                    .is_err(),
                "{manifest}"
            );
        }
        // A referenced but torn version is kept and fails closed instead of panicking.
        let referenced_torn = format!("{}.sealed", id());
        fs::write(path(referenced_torn.clone()), b"KEYSEC01-partial").unwrap();
        let reference = SecretReference(referenced_torn.trim_end_matches(".sealed").into());
        assert_eq!(
            store
                .sweep(
                    "providers.json",
                    &BTreeSet::from([live.0.clone(), orphan.0.clone(), reference.0.clone()])
                )
                .unwrap(),
            SweepReport::default()
        );
        assert_eq!(
            store
                .resolve("tenant", &reference, &destination(1))
                .await
                .unwrap_err(),
            ProviderError::BindingInvalid
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn quarantine_is_bounded_never_follows_links_and_never_replaces_or_deletes() {
        let key = [8u8; 32];
        let sealed = |dir: &Path| -> BTreeSet<String> {
            names(dir)
                .into_iter()
                .filter(|n| n.ends_with(".sealed"))
                .collect()
        };
        async fn seed(dir: &Path, key: [u8; 32], count: usize) -> Vec<SecretReference> {
            let store = EncryptedFileSecretStore::open(dir, key).unwrap();
            let mut refs = vec![];
            for _ in 0..count {
                refs.push(
                    store
                        .put("tenant", &destination(1), synthetic())
                        .await
                        .unwrap(),
                );
            }
            // A syntactically valid but stale manifest that references nothing.
            fs::write(dir.join("providers.json"), b"{}").unwrap();
            refs
        }

        // A linked quarantine is never followed: versions stay where they are.
        let directory = fixture_directory();
        let outside = fixture_directory();
        seed(directory.path(), key, 2).await;
        std::os::unix::fs::symlink(outside.path(), directory.path().join(QUARANTINE)).unwrap();
        let store = EncryptedFileSecretStore::open(directory.path(), key).unwrap();
        assert_eq!(
            store.sweep("providers.json", &BTreeSet::new()).unwrap(),
            SweepReport {
                retained: 2,
                ..SweepReport::default()
            }
        );
        assert_eq!(sealed(directory.path()).len(), 2);
        assert!(names(outside.path()).is_empty());
        drop(store);

        // A full quarantine retains the rest in place; nothing is deleted, and an
        // empty `{}` manifest is idempotent across restarts.
        let directory = fixture_directory();
        let refs_full = seed(directory.path(), key, 2).await;
        let quarantine = directory.path().join(QUARANTINE);
        fs::create_dir(&quarantine).unwrap();
        for n in 0..QUARANTINE_CAPACITY - 1 {
            fs::write(quarantine.join(format!("operator-{n}")), b"").unwrap();
        }
        for expected in [
            SweepReport {
                quarantined: 1,
                retained: 1,
                ..SweepReport::default()
            },
            SweepReport {
                retained: 1,
                ..SweepReport::default()
            },
        ] {
            let store = EncryptedFileSecretStore::open(directory.path(), key).unwrap();
            assert_eq!(
                store.sweep("providers.json", &BTreeSet::new()).unwrap(),
                expected
            );
            drop(store);
        }
        assert_eq!(sealed(directory.path()).len(), 1);
        assert_eq!(sealed(&quarantine).len(), 1);
        assert_eq!(names(&quarantine).len(), QUARANTINE_CAPACITY);
        // Both versions remain recoverable by referencing them again.
        let store = EncryptedFileSecretStore::open(directory.path(), key).unwrap();
        let all: BTreeSet<_> = refs_full.iter().map(|r| r.0.clone()).collect();
        assert_eq!(
            store.sweep("providers.json", &all).unwrap(),
            SweepReport {
                restored: 1,
                ..SweepReport::default()
            }
        );
        for reference in &refs_full {
            assert!(
                store
                    .resolve("tenant", reference, &destination(1))
                    .await
                    .is_ok()
            );
        }
        drop(store);

        // Restore never replaces a live name nor moves a linked held entry.
        let directory = fixture_directory();
        let refs_restore = seed(directory.path(), key, 2).await;
        let quarantine = directory.path().join(QUARANTINE);
        let store = EncryptedFileSecretStore::open(directory.path(), key).unwrap();
        assert_eq!(
            store
                .sweep("providers.json", &BTreeSet::new())
                .unwrap()
                .quarantined,
            2
        );
        drop(store);
        let (kept, linked) = (&refs_restore[0], &refs_restore[1]);
        let kept_name = format!("{}.sealed", kept.0);
        fs::write(directory.path().join(&kept_name), b"operator-placed").unwrap();
        let linked_name = format!("{}.sealed", linked.0);
        let target = outside.path().join("target");
        fs::rename(quarantine.join(&linked_name), &target).unwrap();
        std::os::unix::fs::symlink(&target, quarantine.join(&linked_name)).unwrap();
        let store = EncryptedFileSecretStore::open(directory.path(), key).unwrap();
        let live = BTreeSet::from([kept.0.clone(), linked.0.clone()]);
        assert_eq!(
            store.sweep("providers.json", &live).unwrap(),
            SweepReport::default()
        );
        assert_eq!(
            fs::read(directory.path().join(&kept_name)).unwrap(),
            b"operator-placed"
        );
        assert!(quarantine.join(&kept_name).is_file());
        assert!(quarantine.join(&linked_name).is_symlink());
        assert!(!directory.path().join(&linked_name).exists());
        drop(store);

        // One sweep inspects a bounded number of entries and says so.
        let directory = fixture_directory();
        seed(directory.path(), key, 0).await;
        for n in 0..SWEEP_SCAN_LIMIT {
            fs::write(directory.path().join(format!("filler-{n}")), b"").unwrap();
        }
        let store = EncryptedFileSecretStore::open(directory.path(), key).unwrap();
        assert!(
            store
                .sweep("providers.json", &BTreeSet::new())
                .unwrap()
                .truncated
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn retire_removes_superseded_versions_without_their_binding() {
        let directory = fixture_directory();
        let store = EncryptedFileSecretStore::open(directory.path(), [5u8; 32]).unwrap();
        let old = store
            .put("tenant", &destination(1), synthetic())
            .await
            .unwrap();
        let current = store
            .put("tenant", &destination(2), synthetic())
            .await
            .unwrap();
        // The policy revision changed: verify-then-delete can no longer remove `old`.
        assert!(store.delete("tenant", &old, &destination(2)).await.is_err());
        assert!(store.path(&old).unwrap().is_file());
        store.retire("tenant", &old).await.unwrap();
        assert!(!store.path(&old).unwrap().exists());
        store.retire("tenant", &old).await.unwrap();
        assert!(
            store
                .resolve("tenant", &current, &destination(2))
                .await
                .is_ok()
        );
        for invalid in ["not-a-uuid", "../secret-store.lock", ""] {
            assert_eq!(
                store
                    .retire("tenant", &SecretReference(invalid.into()))
                    .await
                    .unwrap_err(),
                ProviderError::BindingInvalid
            );
        }
        let linked = SecretReference(uuid::Uuid::new_v4().to_string());
        let target = directory.path().join("secret-store.lock");
        std::os::unix::fs::symlink(&target, store.path(&linked).unwrap()).unwrap();
        assert!(store.retire("tenant", &linked).await.is_err());
        assert!(store.path(&linked).unwrap().is_symlink() && target.is_file());
        assert!(UnavailableSecretStore.retire("tenant", &old).await.is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn failed_writes_leave_no_residue_and_no_plaintext() {
        use std::os::unix::fs::PermissionsExt;
        let directory = fixture_directory();
        let store = EncryptedFileSecretStore::open(directory.path(), [3u8; 32]).unwrap();
        let before = names(directory.path());
        fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o500)).unwrap();
        let writable = fs::write(directory.path().join("probe"), b"").is_ok();
        let failed = store.put("tenant", &destination(1), synthetic()).await;
        fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
        if writable {
            // Privileged test runners bypass the mode; nothing to assert then.
            return;
        }
        assert_eq!(failed.unwrap_err(), ProviderError::SecretStoreUnavailable);
        assert_eq!(names(directory.path()), before);
        // The entry cap fails closed before staging anything.
        for n in 0..1024 {
            fs::write(directory.path().join(format!("filler-{n}")), b"").unwrap();
        }
        let before = names(directory.path());
        assert!(
            store
                .put("tenant", &destination(1), synthetic())
                .await
                .is_err()
        );
        assert_eq!(names(directory.path()), before);
        for name in before {
            let bytes = fs::read(directory.path().join(name)).unwrap();
            assert!(
                !bytes
                    .windows(b"SYNTHETIC_LIFECYCLE_SENTINEL".len())
                    .any(|w| w == b"SYNTHETIC_LIFECYCLE_SENTINEL")
            );
        }
    }

    #[tokio::test]
    async fn dropped_callers_detach_at_most_one_bounded_operation() {
        let directory = fixture_directory();
        let store = Arc::new(EncryptedFileSecretStore::open(directory.path(), [4u8; 32]).unwrap());
        let live = store
            .put("tenant", &destination(1), synthetic())
            .await
            .unwrap();
        // Concurrent resolves all complete through the single serialized permit.
        let target = destination(1);
        let reads =
            futures::future::join_all((0..16).map(|_| store.resolve("tenant", &live, &target)))
                .await;
        assert!(reads.iter().all(Result::is_ok));
        // A caller dropped mid-write: the detached write finishes or fails whole,
        // holding the only permit, and never leaves staging behind.
        use futures::FutureExt;
        let _ = store
            .put("tenant", &destination(1), synthetic())
            .now_or_never();
        let permit = store.io.clone().acquire_owned().await.unwrap();
        assert_eq!(store.io.available_permits(), 0);
        drop(permit);
        let sealed: Vec<_> = names(directory.path())
            .into_iter()
            .filter(|n| n.ends_with(".sealed") || n.ends_with(".sealing"))
            .collect();
        assert!(sealed.iter().all(|n| n.ends_with(".sealed")));
        assert_eq!(sealed.len(), 2);
        // Its possibly unpublished version is crash residue the next open sweeps.
        drop(store);
        fs::write(directory.path().join("providers.json"), b"{}").unwrap();
        let store = EncryptedFileSecretStore::open(directory.path(), [4u8; 32]).unwrap();
        let report = store
            .sweep("providers.json", &BTreeSet::from([live.0.clone()]))
            .unwrap();
        assert_eq!(report.quarantined, sealed.len() - 1);
        assert!(
            store
                .resolve("tenant", &live, &destination(1))
                .await
                .is_ok()
        );
    }
}
