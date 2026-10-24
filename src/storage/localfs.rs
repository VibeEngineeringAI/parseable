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

use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::Arc,
};

use async_trait::async_trait;
use bytes::Bytes;
use chrono::Utc;
use datafusion::{datasource::listing::ListingTableUrl, execution::runtime_env::RuntimeEnvBuilder};
use fs_extra::file::CopyOptions;
use futures::{TryStreamExt, stream::FuturesUnordered};
use object_store::{ListResult, ObjectMeta, buffered::BufReader};
use relative_path::{RelativePath, RelativePathBuf};
use tokio::{
    fs::{self, DirEntry, OpenOptions},
    io::AsyncReadExt,
};
use tokio_stream::wrappers::ReadDirStream;

use crate::{
    handlers::http::users::USERS_ROOT_DIR,
    metrics::{
        increment_files_scanned_in_object_store_calls_by_date, increment_object_store_calls_by_date,
    },
    option::validation,
    parseable::{DEFAULT_TENANT, LogStream},
    storage::SETTINGS_ROOT_DIRECTORY,
};

use super::object_storage::{
    ConditionalMetadataError, MetadataVersion, MetadataWriteCondition, VersionedMetadata,
};

use super::{
    ALERTS_ROOT_DIRECTORY, ObjectStorage, ObjectStorageError, ObjectStorageProvider,
    PARSEABLE_ROOT_DIRECTORY, STREAM_METADATA_FILE_NAME, STREAM_ROOT_DIRECTORY,
    TOMBSTONE_ROOT_DIRECTORY,
};

#[derive(Debug, Clone, clap::Args)]
#[command(
    name = "Local filesystem config",
    about = "Start Parseable with a drive as storage",
    help_template = "\
{about-section}
{all-args}
"
)]
pub struct FSConfig {
    #[arg(
        env = "P_FS_DIR",
        value_name = "filesystem path",
        default_value = "./data",
        value_parser = validation::canonicalize_path
    )]
    pub root: PathBuf,
}

impl ObjectStorageProvider for FSConfig {
    fn name(&self) -> &'static str {
        "drive"
    }

    fn get_datafusion_runtime(&self) -> RuntimeEnvBuilder {
        RuntimeEnvBuilder::new()
    }

    fn construct_client(&self) -> Arc<dyn ObjectStorage> {
        Arc::new(LocalFS::new(self.root.clone()))
    }

    fn get_endpoint(&self) -> String {
        self.root.to_str().unwrap().to_string()
    }
}

const METADATA_LOCK_DIRECTORY: &str = ".parseable-metadata-locks";

fn is_upload_temp(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with(UPLOAD_TEMP_PREFIX))
}

fn is_dashboard_metadata(path: &RelativePath) -> bool {
    let normalized = path.normalize();
    let parts = normalized.as_str().split('/').collect::<Vec<_>>();
    let Some(users) = parts.iter().position(|part| *part == USERS_ROOT_DIR) else {
        return false;
    };
    matches!(
        parts.get(users + 1),
        Some(&".dashboard-locations" | &".dashboard-titles")
    ) || parts.get(users + 2) == Some(&"dashboards")
}

#[derive(Debug)]
pub struct LocalFS {
    // absolute path of the data directory
    root: PathBuf,
}

impl LocalFS {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn path_in_root(&self, path: &RelativePath) -> PathBuf {
        path.to_path(&self.root)
    }

    fn checked_metadata_path(&self, path: &RelativePath) -> Result<PathBuf, ObjectStorageError> {
        if path.as_str().starts_with('/')
            || path
                .components()
                .any(|part| matches!(part, relative_path::Component::ParentDir))
        {
            return Err(ObjectStorageError::PathTraversal {
                attempted: self.path_in_root(path),
                root: self.root.clone(),
            });
        }
        Ok(self.path_in_root(path))
    }

    pub(crate) fn metadata_lock_path(&self, path: &RelativePath) -> PathBuf {
        use sha2::{Digest, Sha256};
        let normalized = path.normalize();
        self.root.join(METADATA_LOCK_DIRECTORY).join(format!(
            "{}.lock",
            hex::encode(Sha256::digest(normalized.as_str().as_bytes()))
        ))
    }

    /// Stable private lock files coordinate independent instances/processes.
    /// Never unlink them: replacing a lock inode permits two writers.
    async fn metadata_with_lock<T: Send + 'static>(
        &self,
        path: &RelativePath,
        operation: impl FnOnce(&Path, &mut std::fs::File) -> Result<T, ConditionalMetadataError>
        + Send
        + 'static,
    ) -> Result<T, ConditionalMetadataError> {
        self.metadata_with_lock_mode(path, true, move |path, lock| {
            operation(path, lock.expect("exclusive metadata lock"))
        })
        .await
    }

    async fn metadata_with_lock_mode<T: Send + 'static>(
        &self,
        path: &RelativePath,
        exclusive: bool,
        operation: impl FnOnce(&Path, Option<&mut std::fs::File>) -> Result<T, ConditionalMetadataError>
        + Send
        + 'static,
    ) -> Result<T, ConditionalMetadataError> {
        let lock_path = self.metadata_lock_path(path);
        let path = self.checked_metadata_path(path)?;
        let root = self.root.clone();
        tokio::task::spawn_blocking(move || {
            let parent = path
                .parent()
                .ok_or_else(|| ObjectStorageError::Custom("metadata path has no parent".into()))?;
            if exclusive {
                std::fs::create_dir_all(parent).map_err(ObjectStorageError::from)?;
                std::fs::create_dir_all(lock_path.parent().expect("private lock directory"))
                    .map_err(ObjectStorageError::from)?;
            }
            let mut options = std::fs::OpenOptions::new();
            options.read(true);
            if exclusive {
                options.create(true).truncate(false).write(true);
            }
            let mut lock = match options.open(&lock_path) {
                Ok(lock) => lock,
                Err(error) if !exclusive && error.kind() == std::io::ErrorKind::NotFound => {
                    return operation(&path, None);
                }
                Err(error) => return Err(ObjectStorageError::from(error).into()),
            };
            if exclusive {
                lock.lock().map_err(ObjectStorageError::from)?;
                if read_metadata_generation(&mut lock)? == [0; 16] {
                    // Persist both entries BEFORE the first nonzero generation.
                    // Another opener may have created them without syncing. A
                    // valid nonzero generation proves this initialization ran.
                    sync_metadata_parent(&lock_path)?;
                    sync_metadata_parent(lock_path.parent().expect("private lock directory"))?;
                }
                // create_dir_all above, or a concurrent opener, may have just
                // created any directory up to root without syncing its entry.
                // Neither an existing parent nor a nonzero generation proves
                // durability (prefix deletes keep locks), so sync the chain
                // under the lock before acknowledging. The parent itself is
                // synced by the mutation.
                for directory in parent
                    .ancestors()
                    .skip(1)
                    .take_while(|directory| directory.starts_with(&root))
                {
                    sync_directory(directory)?;
                }
            } else {
                lock.lock_shared().map_err(ObjectStorageError::from)?;
            }
            // The lock is released even if operation returns an error or panics.
            operation(&path, Some(&mut lock))
        })
        .await
        .map_err(ObjectStorageError::from)?
    }
}

#[async_trait]
impl ObjectStorage for LocalFS {
    async fn parallel_chunked_download(
        &self,
        path: &RelativePath,
        _tenant_id: &Option<String>,
        write_path: PathBuf,
    ) -> Result<(), ObjectStorageError> {
        let src = self.path_in_root(path);
        let partial = super::partial_path(&write_path)?;
        if let Some(parent) = partial.parent() {
            fs::create_dir_all(parent).await?;
        }
        match fs::copy(&src, &partial).await {
            Ok(_) => {
                fs::rename(&partial, &write_path).await?;
                Ok(())
            }
            Err(e) => {
                let _ = fs::remove_file(&partial).await;
                Err(e.into())
            }
        }
    }

    async fn upload_multipart(
        &self,
        key: &RelativePath,
        path: &Path,
        tenant_id: &Option<String>,
    ) -> Result<(), ObjectStorageError> {
        let mut file = OpenOptions::new().read(true).open(path).await?;
        if !is_dashboard_metadata(key) {
            let to_path = self.path_in_root(key);
            match copy_into_new_file(file, &to_path).await? {
                None => {
                    let tenant_str = tenant_id.as_deref().unwrap_or(DEFAULT_TENANT);
                    increment_files_scanned_in_object_store_calls_by_date(
                        "PUT",
                        1,
                        &Utc::now().date_naive().to_string(),
                        tenant_str,
                    );
                    increment_object_store_calls_by_date(
                        "PUT",
                        &Utc::now().date_naive().to_string(),
                        tenant_str,
                    );
                    return Ok(());
                }
                Some(source) => file = source,
            }
        }
        let mut data = Vec::new();
        file.read_to_end(&mut data).await?;
        self.put_object(key, data.into(), tenant_id).await
    }

    async fn get_buffered_reader(
        &self,
        _path: &RelativePath,
        _tenant_id: &Option<String>,
    ) -> Result<BufReader, ObjectStorageError> {
        Err(ObjectStorageError::UnhandledError(Box::new(
            std::io::Error::new(
                std::io::ErrorKind::Unsupported,
                "Buffered reader not implemented for LocalFS yet",
            ),
        )))
    }

    async fn head(
        &self,
        path: &RelativePath,
        _tenant_id: &Option<String>,
    ) -> Result<ObjectMeta, ObjectStorageError> {
        let file_path = self.path_in_root(path);

        // Check if file exists and get metadata
        match fs::metadata(&file_path).await {
            Ok(metadata) => {
                // Convert the relative path to object store path format
                let location = object_store::path::Path::from(path.as_str());

                // Create ObjectMeta with file information
                let object_meta = ObjectMeta {
                    location,
                    last_modified: metadata
                        .modified()
                        .map_err(ObjectStorageError::IoError)?
                        .into(),
                    size: metadata.len(),
                    e_tag: None,
                    version: None,
                };

                Ok(object_meta)
            }
            Err(e) => Err(ObjectStorageError::IoError(e)),
        }
    }

    async fn get_metadata_versioned(
        &self,
        path: &RelativePath,
        _tenant_id: &Option<String>,
    ) -> Result<Option<VersionedMetadata>, ConditionalMetadataError> {
        // Reads never create locks. Without one, pin generation zero before
        // reading content: a concurrent first writer durably rotates away from
        // zero before mutation, so this read can only cause a false conflict.
        self.metadata_with_lock_mode(path, false, read_local_metadata)
            .await
    }

    async fn put_metadata_conditional(
        &self,
        path: &RelativePath,
        bytes: Bytes,
        condition: MetadataWriteCondition,
        _tenant_id: &Option<String>,
    ) -> Result<MetadataVersion, ConditionalMetadataError> {
        self.metadata_with_lock(path, move |path, lock| {
            let current = read_local_metadata(path, Some(lock))?;
            match condition {
                MetadataWriteCondition::Create if current.is_some() => {
                    return Err(ConditionalMetadataError::Conflict);
                }
                MetadataWriteCondition::Update(expected)
                    if current.as_ref().map(|entry| &entry.version) != Some(&expected) =>
                {
                    return Err(ConditionalMetadataError::Conflict);
                }
                _ => {}
            }
            rotate_metadata_generation(lock)?;
            atomic_metadata_write(path, &bytes)?;
            Ok(read_local_metadata(path, Some(lock))?
                .expect("just wrote metadata under exclusive lock")
                .version)
        })
        .await
    }

    async fn delete_metadata_conditional(
        &self,
        path: &RelativePath,
        version: MetadataVersion,
        _tenant_id: &Option<String>,
    ) -> Result<(), ConditionalMetadataError> {
        self.metadata_with_lock(path, move |path, lock| {
            if read_local_metadata(path, Some(lock))?
                .as_ref()
                .map(|entry| &entry.version)
                != Some(&version)
            {
                return Err(ConditionalMetadataError::Conflict);
            }
            rotate_metadata_generation(lock)?;
            std::fs::remove_file(path).map_err(ObjectStorageError::from)?;
            sync_metadata_parent(path)?;
            Ok(())
        })
        .await
    }

    async fn get_object(
        &self,
        path: &RelativePath,
        tenant_id: &Option<String>,
    ) -> Result<Bytes, ObjectStorageError> {
        let file_path;
        let tenant_str = tenant_id.as_deref().unwrap_or(DEFAULT_TENANT);

        // this is for the `get_manifest()` function because inside a snapshot, we store the absolute path (without `/`) on linux based OS
        // `home/user/.../manifest.json`
        // on windows, the path is stored with the drive letter
        // `D:\\parseable\\data..\\manifest.json`
        // thus, we need to check if the root of localfs is already present in the path
        #[cfg(windows)]
        {
            // in windows the absolute path (self.root) doesn't matter because we store the complete path
            file_path = path.to_path("");
        }
        #[cfg(not(windows))]
        {
            // absolute path (self.root) will always start with `/`
            let root_str = self.root.to_str().unwrap();
            file_path = if path.to_string().contains(&root_str[1..]) && root_str.len() > 1 {
                path.to_path("/")
            } else {
                self.path_in_root(path)
            };
        }

        let file_result = fs::read(file_path).await;
        let res: Result<Bytes, ObjectStorageError> = match file_result {
            Ok(x) => {
                // Record single file accessed successfully
                increment_files_scanned_in_object_store_calls_by_date(
                    "GET",
                    1,
                    &Utc::now().date_naive().to_string(),
                    tenant_str,
                );
                increment_object_store_calls_by_date(
                    "GET",
                    &Utc::now().date_naive().to_string(),
                    tenant_str,
                );
                Ok(x.into())
            }
            Err(e) => {
                if e.kind() == std::io::ErrorKind::NotFound {
                    Err(ObjectStorageError::NoSuchKey(path.to_string()))
                } else {
                    Err(ObjectStorageError::UnhandledError(Box::new(e)))
                }
            }
        };

        res
    }

    /// Local reads have no response body to be severed, so ranging buys
    /// nothing here.
    async fn get_object_ranged(
        &self,
        path: &RelativePath,
        tenant_id: &Option<String>,
    ) -> Result<Bytes, ObjectStorageError> {
        self.get_object(path, tenant_id).await
    }

    async fn get_ingestor_meta_file_paths(
        &self,
        tenant_id: &Option<String>,
    ) -> Result<Vec<RelativePathBuf>, ObjectStorageError> {
        let mut path_arr = vec![];
        let mut files_scanned = 0u64;
        let tenant_str = tenant_id.as_deref().unwrap_or(DEFAULT_TENANT);

        let entries_result = fs::read_dir(&self.root).await;
        let mut entries = match entries_result {
            Ok(entries) => entries,
            Err(err) => {
                return Err(err.into());
            }
        };

        while let Some(entry) = entries.next_entry().await? {
            if is_upload_temp(&entry.path()) {
                continue;
            }
            files_scanned += 1;
            let flag = entry
                .path()
                .file_name()
                .unwrap_or_default()
                .to_str()
                .unwrap_or_default()
                .contains("ingestor");

            if flag {
                path_arr.push(
                    RelativePathBuf::from_path(entry.path().file_name().unwrap())
                        .map_err(ObjectStorageError::PathError)?,
                );
            }
        }

        // Record total files scanned
        increment_files_scanned_in_object_store_calls_by_date(
            "LIST",
            files_scanned,
            &Utc::now().date_naive().to_string(),
            tenant_str,
        );
        increment_object_store_calls_by_date(
            "LIST",
            &Utc::now().date_naive().to_string(),
            tenant_str,
        );
        Ok(path_arr)
    }

    /// currently it is not using the starts_with_pattern
    async fn get_objects(
        &self,
        base_path: Option<&RelativePath>,
        filter_func: Box<dyn Fn(String) -> bool + std::marker::Send + 'static>,
        tenant_id: &Option<String>,
    ) -> Result<Vec<Bytes>, ObjectStorageError> {
        let prefix = if let Some(path) = base_path {
            path.to_path(&self.root)
        } else {
            self.root.clone()
        };
        let tenant_str = tenant_id.as_deref().unwrap_or(DEFAULT_TENANT);

        let entries_result = fs::read_dir(&prefix).await;
        let mut entries = match entries_result {
            Ok(entries) => entries,
            Err(err) => {
                return Err(err.into());
            }
        };

        let mut res = Vec::new();
        let mut files_scanned = 0;
        while let Some(entry) = entries.next_entry().await? {
            if is_upload_temp(&entry.path()) {
                continue;
            }
            let path = entry
                .path()
                .file_name()
                .ok_or(ObjectStorageError::NoSuchKey(
                    "Dir Entry suggests no file present".to_string(),
                ))?
                .to_str()
                .expect("file name is parseable to str")
                .to_owned();

            files_scanned += 1;
            let ingestor_file = filter_func(path);

            if !ingestor_file {
                continue;
            }

            let file_result = fs::read(entry.path()).await;
            match file_result {
                Ok(file) => {
                    // Record total files scanned
                    increment_files_scanned_in_object_store_calls_by_date(
                        "GET",
                        1,
                        &Utc::now().date_naive().to_string(),
                        tenant_str,
                    );
                    increment_object_store_calls_by_date(
                        "GET",
                        &Utc::now().date_naive().to_string(),
                        tenant_str,
                    );
                    res.push(file.into());
                }
                Err(err) => {
                    return Err(err.into());
                }
            }
        }

        increment_files_scanned_in_object_store_calls_by_date(
            "LIST",
            files_scanned as u64,
            &Utc::now().date_naive().to_string(),
            tenant_str,
        );
        increment_object_store_calls_by_date(
            "LIST",
            &Utc::now().date_naive().to_string(),
            tenant_str,
        );

        Ok(res)
    }

    async fn put_object(
        &self,
        path: &RelativePath,
        resource: Bytes,
        tenant_id: &Option<String>,
    ) -> Result<(), ObjectStorageError> {
        let tenant_str = tenant_id.as_deref().unwrap_or(DEFAULT_TENANT);
        let res = if is_dashboard_metadata(path) {
            self.metadata_with_lock(path, move |path, lock| {
                rotate_metadata_generation(lock)?;
                atomic_metadata_write(path, &resource)?;
                Ok(())
            })
            .await
            .map_err(local_metadata_error)
        } else {
            let path = self.path_in_root(path);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).await?;
            }
            fs::write(path, resource)
                .await
                .map_err(ObjectStorageError::from)
        };
        if res.is_ok() {
            // Record single file written successfully
            increment_files_scanned_in_object_store_calls_by_date(
                "PUT",
                1,
                &Utc::now().date_naive().to_string(),
                tenant_str,
            );
            increment_object_store_calls_by_date(
                "PUT",
                &Utc::now().date_naive().to_string(),
                tenant_str,
            );
        }

        res
    }

    async fn delete_prefix(
        &self,
        path: &RelativePath,
        tenant_id: &Option<String>,
    ) -> Result<(), ObjectStorageError> {
        let path = self.path_in_root(path);
        let tenant_str = tenant_id.as_deref().unwrap_or(DEFAULT_TENANT);

        let result = tokio::fs::remove_dir_all(path).await;
        if result.is_ok() {
            increment_object_store_calls_by_date(
                "DELETE",
                &Utc::now().date_naive().to_string(),
                tenant_str,
            );
        }
        result?;
        Ok(())
    }

    async fn delete_object(
        &self,
        path: &RelativePath,
        tenant_id: &Option<String>,
    ) -> Result<(), ObjectStorageError> {
        if path
            .components()
            .any(|component| matches!(component, relative_path::Component::ParentDir))
        {
            return Err(ObjectStorageError::PathTraversal {
                attempted: path.to_path(&self.root),
                root: self.root.clone(),
            });
        }

        let tenant_str = tenant_id.as_deref().unwrap_or(DEFAULT_TENANT);
        let result = if is_dashboard_metadata(path) {
            self.metadata_with_lock(path, |path, lock| {
                rotate_metadata_generation(lock)?;
                std::fs::remove_file(path).map_err(ObjectStorageError::from)?;
                sync_metadata_parent(path)?;
                Ok(())
            })
            .await
            .map_err(local_metadata_error)
        } else {
            tokio::fs::remove_file(self.path_in_root(path))
                .await
                .map_err(ObjectStorageError::from)
        };
        if result.is_ok() {
            // Record single file deleted successfully
            increment_files_scanned_in_object_store_calls_by_date(
                "DELETE",
                1,
                &Utc::now().date_naive().to_string(),
                tenant_str,
            );
            increment_object_store_calls_by_date(
                "DELETE",
                &Utc::now().date_naive().to_string(),
                tenant_str,
            );
        }

        result?;
        Ok(())
    }

    async fn check(&self, tenant_id: &Option<String>) -> Result<(), ObjectStorageError> {
        let result = fs::create_dir_all(&self.root).await;
        let tenant_str = tenant_id.as_deref().unwrap_or(DEFAULT_TENANT);
        if result.is_ok() {
            increment_object_store_calls_by_date(
                "HEAD",
                &Utc::now().date_naive().to_string(),
                tenant_str,
            );
        }

        result.map_err(|e| ObjectStorageError::UnhandledError(e.into()))
    }

    async fn delete_stream(
        &self,
        stream_name: &str,
        tenant_id: &Option<String>,
    ) -> Result<(), ObjectStorageError> {
        let path = self.root.join(stream_name);
        let tenant_str = tenant_id.as_deref().unwrap_or(DEFAULT_TENANT);

        let result = fs::remove_dir_all(path).await;
        if result.is_ok() {
            increment_object_store_calls_by_date(
                "DELETE",
                &Utc::now().date_naive().to_string(),
                tenant_str,
            );
        }

        Ok(result?)
    }

    async fn try_delete_node_meta(
        &self,
        node_filename: String,
        tenant_id: &Option<String>,
    ) -> Result<(), ObjectStorageError> {
        let path = self.root.join(node_filename);
        let tenant_str = tenant_id.as_deref().unwrap_or(DEFAULT_TENANT);

        let result = fs::remove_file(path).await;
        if result.is_ok() {
            increment_object_store_calls_by_date(
                "DELETE",
                &Utc::now().date_naive().to_string(),
                tenant_str,
            );
        }

        Ok(result?)
    }

    async fn list_streams(&self) -> Result<HashSet<LogStream>, ObjectStorageError> {
        let ignore_dir = &[
            METADATA_LOCK_DIRECTORY,
            "lost+found",
            DEFAULT_TENANT,
            PARSEABLE_ROOT_DIRECTORY,
            USERS_ROOT_DIR,
            ALERTS_ROOT_DIRECTORY,
            SETTINGS_ROOT_DIRECTORY,
            TOMBSTONE_ROOT_DIRECTORY,
        ];

        let result = fs::read_dir(&self.root).await;
        let directories = match result {
            Ok(read_dir) => {
                increment_object_store_calls_by_date(
                    "LIST",
                    &Utc::now().date_naive().to_string(),
                    DEFAULT_TENANT,
                );
                ReadDirStream::new(read_dir)
            }
            Err(err) => {
                return Err(err.into());
            }
        };

        let entries: Vec<DirEntry> = directories.try_collect().await?;
        let entries = entries
            .into_iter()
            .map(|entry| dir_with_stream(entry, ignore_dir));

        let logstream_dirs: Vec<Option<String>> =
            FuturesUnordered::from_iter(entries).try_collect().await?;

        let logstreams = logstream_dirs.into_iter().flatten().collect();

        Ok(logstreams)
    }

    async fn list_old_streams(&self) -> Result<HashSet<LogStream>, ObjectStorageError> {
        let ignore_dir = &[
            METADATA_LOCK_DIRECTORY,
            "lost+found",
            DEFAULT_TENANT,
            PARSEABLE_ROOT_DIRECTORY,
            ALERTS_ROOT_DIRECTORY,
            SETTINGS_ROOT_DIRECTORY,
            TOMBSTONE_ROOT_DIRECTORY,
        ];

        let result = fs::read_dir(&self.root).await;
        let directories = match result {
            Ok(read_dir) => {
                increment_object_store_calls_by_date(
                    "LIST",
                    &Utc::now().date_naive().to_string(),
                    DEFAULT_TENANT,
                );
                ReadDirStream::new(read_dir)
            }
            Err(err) => {
                return Err(err.into());
            }
        };

        let entries: Vec<DirEntry> = directories.try_collect().await?;
        let entries = entries
            .into_iter()
            .map(|entry| dir_with_old_stream(entry, ignore_dir));

        let logstream_dirs: Vec<Option<String>> =
            FuturesUnordered::from_iter(entries).try_collect().await?;

        let logstreams = logstream_dirs.into_iter().flatten().collect();

        Ok(logstreams)
    }

    async fn list_dirs(
        &self,
        tenant_id: &Option<String>,
    ) -> Result<Vec<String>, ObjectStorageError> {
        let tenant_str = tenant_id.as_deref().unwrap_or(DEFAULT_TENANT);
        let result = fs::read_dir(&self.root).await;
        let read_dir = match result {
            Ok(read_dir) => {
                increment_object_store_calls_by_date(
                    "LIST",
                    &Utc::now().date_naive().to_string(),
                    tenant_str,
                );
                read_dir
            }
            Err(err) => {
                if err.kind() == std::io::ErrorKind::NotFound {
                    return Ok(Vec::new());
                }

                return Err(err.into());
            }
        };

        let dirs = ReadDirStream::new(read_dir)
            .try_collect::<Vec<DirEntry>>()
            .await?
            .into_iter()
            .map(dir_name);

        let dirs = FuturesUnordered::from_iter(dirs)
            .try_collect::<Vec<_>>()
            .await?
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();

        Ok(dirs)
    }

    async fn list_dirs_relative(
        &self,
        relative_path: &RelativePath,
        _tenant_id: &Option<String>,
    ) -> Result<Vec<String>, ObjectStorageError> {
        let root = self.root.join(relative_path.as_str());

        let result = fs::read_dir(root).await;
        let read_dir = match result {
            Ok(read_dir) => read_dir,
            Err(err) => {
                if err.kind() == std::io::ErrorKind::NotFound {
                    return Ok(Vec::new());
                }

                return Err(err.into());
            }
        };

        let dirs = ReadDirStream::new(read_dir)
            .try_collect::<Vec<DirEntry>>()
            .await?
            .into_iter()
            .map(dir_name);

        let dirs = FuturesUnordered::from_iter(dirs)
            .try_collect::<Vec<_>>()
            .await?
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();

        Ok(dirs)
    }

    async fn list_dates(
        &self,
        stream_name: &str,
        tenant_id: &Option<String>,
    ) -> Result<Vec<String>, ObjectStorageError> {
        let path = self.root.join(stream_name);
        let tenant_str = tenant_id.as_deref().unwrap_or(DEFAULT_TENANT);

        let result = fs::read_dir(&path).await;
        let read_dir = match result {
            Ok(read_dir) => {
                increment_object_store_calls_by_date(
                    "LIST",
                    &Utc::now().date_naive().to_string(),
                    tenant_str,
                );
                read_dir
            }
            Err(err) => {
                if err.kind() == std::io::ErrorKind::NotFound {
                    return Ok(Vec::new());
                }

                return Err(err.into());
            }
        };

        let directories = ReadDirStream::new(read_dir);
        let entries: Vec<DirEntry> = directories.try_collect().await?;
        let entries = entries.into_iter().map(dir_name);
        let dates: Vec<_> = FuturesUnordered::from_iter(entries).try_collect().await?;

        Ok(dates.into_iter().flatten().collect())
    }

    async fn list_hours(
        &self,
        stream_name: &str,
        date: &str,
        _tenant_id: &Option<String>,
    ) -> Result<Vec<String>, ObjectStorageError> {
        let path = self.root.join(stream_name).join(date);
        let directories = ReadDirStream::new(fs::read_dir(&path).await?);
        let entries: Vec<DirEntry> = directories.try_collect().await?;
        let entries = entries.into_iter().map(dir_name);
        let hours: Vec<_> = FuturesUnordered::from_iter(entries).try_collect().await?;
        Ok(hours
            .into_iter()
            .flatten()
            .filter(|dir| dir.starts_with("hour="))
            .collect())
    }

    async fn list_minutes(
        &self,
        stream_name: &str,
        date: &str,
        hour: &str,
        _tenant_id: &Option<String>,
    ) -> Result<Vec<String>, ObjectStorageError> {
        let path = self.root.join(stream_name).join(date).join(hour);
        // Propagate any read_dir errors instead of swallowing them
        let directories = ReadDirStream::new(fs::read_dir(&path).await?);
        let entries: Vec<DirEntry> = directories.try_collect().await?;
        let entries = entries.into_iter().map(dir_name);
        let minutes: Vec<_> = FuturesUnordered::from_iter(entries).try_collect().await?;
        // Filter down to only the "minute=" prefixed directories
        Ok(minutes
            .into_iter()
            .flatten()
            .filter(|dir| dir.starts_with("minute="))
            .collect())
    }

    async fn upload_file(
        &self,
        key: &str,
        path: &Path,
        tenant_id: &Option<String>,
    ) -> Result<(), ObjectStorageError> {
        let op = CopyOptions {
            overwrite: true,
            skip_exist: true,
            ..CopyOptions::default()
        };
        let to_path = self.root.join(key);

        let tenant_str = tenant_id.as_deref().unwrap_or(DEFAULT_TENANT);
        if let Some(path) = to_path.parent() {
            fs::create_dir_all(path).await?;
        }

        let result = fs_extra::file::copy(path, to_path, &op);
        match result {
            Ok(_) => {
                increment_object_store_calls_by_date(
                    "PUT",
                    &Utc::now().date_naive().to_string(),
                    tenant_str,
                );
                Ok(())
            }
            Err(err) => Err(err.into()),
        }
    }

    fn absolute_url(&self, prefix: &RelativePath) -> object_store::path::Path {
        object_store::path::Path::parse(
            format!("{}", self.root.join(prefix.as_str()).display())
                .trim_start_matches(std::path::MAIN_SEPARATOR),
        )
        .unwrap()
    }

    fn query_prefixes(&self, prefixes: Vec<String>) -> Vec<ListingTableUrl> {
        prefixes
            .into_iter()
            .filter_map(|prefix| ListingTableUrl::parse(format!("/{prefix}")).ok())
            .collect()
    }

    fn store_url(&self) -> url::Url {
        url::Url::parse("file:///").unwrap()
    }

    async fn list_with_delimiter(
        &self,
        _prefix: Option<object_store::path::Path>,
    ) -> Result<ListResult, ObjectStorageError> {
        Err(ObjectStorageError::UnhandledError(Box::new(
            std::io::Error::new(
                std::io::ErrorKind::Unsupported,
                "list_with_delimiter is not implemented for LocalFS",
            ),
        )))
    }

    fn get_bucket_name(&self) -> String {
        self.root
            .iter()
            .next_back()
            .expect("can be unwrapped without checking as the path is absolute")
            .to_str()
            .expect("valid unicode")
            .to_string()
    }
}

async fn dir_with_old_stream(
    entry: DirEntry,
    ignore_dirs: &[&str],
) -> Result<Option<String>, ObjectStorageError> {
    let dir_name = entry
        .path()
        .file_name()
        .expect("valid path")
        .to_str()
        .expect("valid unicode")
        .to_owned();

    if is_upload_temp(&entry.path()) || ignore_dirs.contains(&dir_name.as_str()) {
        return Ok(None);
    }

    if entry.file_type().await?.is_dir() {
        let path = entry.path();

        // even in ingest mode, we should only look for the global stream metadata file
        let stream_json_path = path.join(STREAM_METADATA_FILE_NAME);

        if stream_json_path.exists() {
            Ok(Some(dir_name))
        } else {
            let err: Box<dyn std::error::Error + Send + Sync + 'static> =
                format!("found {}", entry.path().display()).into();
            Err(ObjectStorageError::UnhandledError(err))
        }
    } else {
        Ok(None)
    }
}

async fn dir_with_stream(
    entry: DirEntry,
    ignore_dirs: &[&str],
) -> Result<Option<String>, ObjectStorageError> {
    let dir_name = entry
        .path()
        .file_name()
        .expect("valid path")
        .to_str()
        .expect("valid unicode")
        .to_owned();

    if is_upload_temp(&entry.path()) || ignore_dirs.contains(&dir_name.as_str()) {
        return Ok(None);
    }

    if entry.file_type().await?.is_dir() {
        let path = entry.path();

        // even in ingest mode, we should only look for the global stream metadata file
        let stream_json_path = path
            .join(STREAM_ROOT_DIRECTORY)
            .join(STREAM_METADATA_FILE_NAME);

        if stream_json_path.exists() {
            Ok(Some(dir_name))
        } else {
            let err: Box<dyn std::error::Error + Send + Sync + 'static> =
                format!("found {}", entry.path().display()).into();
            Err(ObjectStorageError::UnhandledError(err))
        }
    } else {
        Ok(None)
    }
}

async fn dir_name(entry: DirEntry) -> Result<Option<String>, ObjectStorageError> {
    if entry.file_name() == METADATA_LOCK_DIRECTORY || is_upload_temp(&entry.path()) {
        return Ok(None);
    }
    if entry.file_type().await?.is_dir() {
        let dir_name = entry
            .path()
            .file_name()
            .expect("valid path")
            .to_str()
            .expect("valid unicode")
            .to_owned();
        Ok(Some(dir_name))
    } else {
        Ok(None)
    }
}

// BEGIN localfs-copy helper (extracted verbatim by the standalone upload harness)

// Reserved for operation-owned copies. No object suffix (in particular .parquet)
// is retained, so query file discovery cannot mistake these for published data.
const UPLOAD_TEMP_PREFIX: &str = ".parseable-upload-";

/// Streams a regular source into an operation-private, same-directory file and
/// publishes it with a no-replace hard link. Only the private name is cleaned up.
///
/// Existing destinations (including dangling symlinks), setup failures and failed
/// publication use the original buffered read + put_object path. If copying has
/// consumed the source, restore its initial position before returning it. Thus a
/// destination appearing during copying still gets buffered overwrite semantics
/// (including symlink, hard-link and mode behavior). Those overwrites remain
/// non-atomic. Copy failures retain their original error and never unlink to_path.
async fn copy_into_new_file(
    source: fs::File,
    to_path: &Path,
) -> Result<Option<fs::File>, ObjectStorageError> {
    copy_into_new_file_with(
        source,
        to_path,
        std::io::copy,
        |temp, final_path| std::fs::hard_link(temp, final_path),
        |_, _| {},
    )
    .await
}

// Hooks belong to a single invocation, including when its blocking task outlives
// the async waiter. Tests can schedule writers at real ownership boundaries.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum UploadCopyStage {
    TempCreated,
    CopyFailed,
    BeforePublish,
}

async fn copy_into_new_file_with<C, P, H>(
    source: fs::File,
    to_path: &Path,
    copy: C,
    publish: P,
    mut hook: H,
) -> Result<Option<fs::File>, ObjectStorageError>
where
    C: FnOnce(&mut std::fs::File, &mut std::fs::File) -> std::io::Result<u64> + Send + 'static,
    P: FnOnce(&Path, &Path) -> std::io::Result<()> + Send + 'static,
    H: FnMut(UploadCopyStage, &Path) + Send + 'static,
{
    let mut source = source.into_std().await;
    let to_path = to_path.to_path_buf();
    let copied = tokio::task::spawn_blocking(move || {
        use std::io::{Seek, SeekFrom};

        if !source.metadata().is_ok_and(|meta| meta.is_file()) {
            return Ok(Some(source));
        }
        // symlink_metadata also catches dangling symlinks. Any other lookup
        // error belongs to the buffered path, after it has read the source.
        match std::fs::symlink_metadata(&to_path) {
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            _ => return Ok(Some(source)),
        }
        let Some(parent) = to_path.parent() else {
            return Ok(Some(source));
        };
        if std::fs::create_dir_all(parent).is_err() {
            // Preserve source-read-error priority over parent/setup errors.
            return Ok(Some(source));
        }
        let Ok(position) = source.stream_position() else {
            return Ok(Some(source));
        };
        let Ok(mut temp) = UploadTemp::create(parent, &to_path) else {
            return Ok(Some(source));
        };
        hook(UploadCopyStage::TempCreated, &temp.path);
        if let Err(err) = copy(&mut source, temp.file.as_mut().expect("open copy file")) {
            hook(UploadCopyStage::CopyFailed, &temp.path);
            // Drop closes and removes only this invocation's private name.
            return Err(err);
        }
        // Close before linking/cleanup, including on platforms with restrictive
        // file-sharing rules. std::io::copy writes directly to an unbuffered File.
        drop(temp.file.take());
        hook(UploadCopyStage::BeforePublish, &temp.path);
        if publish(&temp.path, &to_path).is_err() {
            // hard_link does not replace a concurrent destination. Unsupported
            // publication also falls back. A failed rewind must fail the upload,
            // never hand an EOF-positioned source to the buffered writer.
            source.seek(SeekFrom::Start(position))?;
            return Ok(Some(source));
        }
        Ok(None)
    })
    .await??;
    Ok(copied.map(fs::File::from_std))
}

struct UploadTemp {
    path: PathBuf,
    file: Option<std::fs::File>,
}

impl UploadTemp {
    const COLLISION_ATTEMPTS: usize = 16;

    fn create(parent: &Path, final_path: &Path) -> std::io::Result<Self> {
        Self::create_with_name(parent, final_path, || {
            format!("{UPLOAD_TEMP_PREFIX}{}.tmp", uuid::Uuid::new_v4())
        })
    }

    fn create_with_name(
        parent: &Path,
        final_path: &Path,
        mut name: impl FnMut() -> String,
    ) -> std::io::Result<Self> {
        for _ in 0..Self::COLLISION_ATTEMPTS {
            let path = parent.join(name());
            // Even an accidental random-name match must not make the public
            // name operation-owned. Such a match consumes one bounded attempt.
            if path == final_path {
                continue;
            }
            // Default creation mode is 0666 & umask, just like fs::write. The
            // tempfile crate's restrictive mode would change the object mode.
            match std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
            {
                Ok(file) => {
                    return Ok(Self {
                        path,
                        file: Some(file),
                    });
                }
                Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(err) => return Err(err),
            }
        }
        Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "upload temporary name collision limit reached",
        ))
    }
}

impl Drop for UploadTemp {
    fn drop(&mut self) {
        drop(self.file.take());
        // Best effort, also during unwinding. A crash or failed unlink may leave
        // private residue, excluded from listings; never remove a public name.
        let _ = std::fs::remove_file(&self.path);
    }
}

// END localfs-copy helper

impl From<fs_extra::error::Error> for ObjectStorageError {
    fn from(e: fs_extra::error::Error) -> Self {
        ObjectStorageError::UnhandledError(Box::new(e))
    }
}

fn local_metadata_error(error: ConditionalMetadataError) -> ObjectStorageError {
    match error {
        ConditionalMetadataError::Storage(error) => error,
        error => ObjectStorageError::Custom(error.to_string()),
    }
}

// A fixed-size, checksummed record detects partial/torn generation writes. An
// empty lock is the pre-generation format; all nonempty invalid records fail
// closed. In particular, never repair corruption by reviving an older version.
const METADATA_GENERATION_MAGIC: &[u8; 8] = b"PFSVER1\n";
const METADATA_GENERATION_RECORD_LEN: usize = 8 + 16 + 32;

fn read_metadata_generation(lock: &mut std::fs::File) -> Result<[u8; 16], ObjectStorageError> {
    use sha2::{Digest, Sha256};
    use std::io::{Read, Seek, SeekFrom};
    lock.seek(SeekFrom::Start(0))?;
    let mut record = Vec::new();
    lock.take((METADATA_GENERATION_RECORD_LEN + 1) as u64)
        .read_to_end(&mut record)?;
    if record.is_empty() {
        return Ok([0; 16]);
    }
    if record.len() != METADATA_GENERATION_RECORD_LEN
        || &record[..8] != METADATA_GENERATION_MAGIC
        || Sha256::digest(&record[..24])[..] != record[24..]
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "invalid LocalFS metadata generation record",
        )
        .into());
    }
    Ok(record[8..24].try_into().expect("checked generation length"))
}

fn rotate_metadata_generation(lock: &mut std::fs::File) -> Result<(), ObjectStorageError> {
    use sha2::{Digest, Sha256};
    use std::io::{Seek, SeekFrom, Write};
    // Validate before overwriting, including for unconditional legacy writers.
    read_metadata_generation(lock)?;
    let mut record = Vec::with_capacity(METADATA_GENERATION_RECORD_LEN);
    record.extend_from_slice(METADATA_GENERATION_MAGIC);
    record.extend_from_slice(uuid::Uuid::new_v4().as_bytes());
    record.extend_from_slice(&Sha256::digest(&record));
    lock.seek(SeekFrom::Start(0))?;
    // Never truncate: a crash must not turn an existing generation back into
    // the empty legacy format. A partial write fails its checksum on next use.
    lock.write_all(&record)?;
    // Persist BEFORE touching the object. A crash in between only causes a
    // false conflict, never acceptance of a stale precondition.
    lock.sync_all()?;
    Ok(())
}

fn read_local_metadata(
    path: &Path,
    lock: Option<&mut std::fs::File>,
) -> Result<Option<VersionedMetadata>, ConditionalMetadataError> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let generation = match lock {
        Some(lock) => read_metadata_generation(lock)?,
        None => [0; 16],
    };
    let mut file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(ObjectStorageError::from(error).into()),
    };
    let metadata = file.metadata().map_err(ObjectStorageError::from)?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(ObjectStorageError::from)?;
    // The durable generation prevents ABA even when bytes, inode and timestamps
    // all repeat. With an existing lock the caller holds it across both reads;
    // without one, generation zero cannot match a concurrent first mutation.
    let mut digest = Sha256::new();
    digest.update(generation);
    digest.update(&bytes);
    digest.update(format!("{:?}{:?}", metadata.modified(), metadata.created()).as_bytes());
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        digest.update(metadata.dev().to_le_bytes());
        digest.update(metadata.ino().to_le_bytes());
        digest.update(metadata.ctime().to_le_bytes());
        digest.update(metadata.ctime_nsec().to_le_bytes());
    }
    Ok(Some(VersionedMetadata {
        bytes: bytes.into(),
        version: MetadataVersion {
            e_tag: Some(hex::encode(digest.finalize())),
            version: None,
        },
    }))
}

fn sync_metadata_parent(path: &Path) -> Result<(), ObjectStorageError> {
    sync_directory(path.parent().expect("metadata parent"))
}

fn sync_directory(directory: &Path) -> Result<(), ObjectStorageError> {
    #[cfg(unix)]
    std::fs::File::open(directory)?.sync_all()?;
    #[cfg(test)]
    conditional_metadata_tests::record_directory_sync(directory);
    Ok(())
}

fn atomic_metadata_write(path: &Path, bytes: &[u8]) -> Result<(), ObjectStorageError> {
    use std::io::Write;
    let parent = path
        .parent()
        .ok_or_else(|| ObjectStorageError::Custom("metadata path has no parent".into()))?;
    let temporary = parent.join(format!(".metadata-{}.tmp", ulid::Ulid::new()));
    let result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        std::fs::rename(&temporary, path)?;
        sync_metadata_parent(path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

#[cfg(test)]
mod conditional_metadata_tests {
    use super::*;
    use crate::metastore::{
        metastore_traits::Metastore, metastores::object_store_metastore::ObjectStoreMetastore,
    };

    static DIRECTORY_SYNCS: std::sync::Mutex<Vec<PathBuf>> = std::sync::Mutex::new(Vec::new());

    pub(super) fn record_directory_sync(directory: &Path) {
        DIRECTORY_SYNCS
            .lock()
            .unwrap()
            .push(directory.to_path_buf());
    }

    fn take_directory_syncs_under(root: &Path) -> HashSet<PathBuf> {
        let mut syncs = DIRECTORY_SYNCS.lock().unwrap();
        let (taken, kept) = std::mem::take(&mut *syncs)
            .into_iter()
            .partition(|directory| directory.starts_with(root));
        *syncs = kept;
        taken.into_iter().collect()
    }

    fn service(root: &Path) -> Arc<ObjectStoreMetastore> {
        Arc::new(ObjectStoreMetastore {
            storage: Arc::new(LocalFS::new(root.to_path_buf())),
        })
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn independent_metastores_have_one_winner_for_create_and_update() {
        let directory = tempfile::tempdir().unwrap();
        let first = service(directory.path());
        let second = service(directory.path());
        let path = "tenant-a/users/owner/dashboards/shared.json";
        let tenant = Some("tenant-a".to_string());
        let (a, b) = tokio::join!(
            first.put_dashboard_conditional(
                path,
                Bytes::from_static(b"original"),
                MetadataWriteCondition::Create,
                &tenant
            ),
            second.put_dashboard_conditional(
                path,
                Bytes::from_static(b"original"),
                MetadataWriteCondition::Create,
                &tenant
            ),
        );
        assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
        assert!(matches!(
            if a.is_err() { a } else { b },
            Err(ConditionalMetadataError::Conflict)
        ));
        let original = first
            .get_dashboard_versioned(path, &tenant)
            .await
            .unwrap()
            .unwrap();
        let barrier = Arc::new(tokio::sync::Barrier::new(24));
        let mut writes = tokio::task::JoinSet::new();
        for index in 0..24 {
            let current = if index % 2 == 0 {
                first.clone()
            } else {
                second.clone()
            };
            let version = original.version.clone();
            let barrier = barrier.clone();
            let tenant = tenant.clone();
            writes.spawn(async move {
                barrier.wait().await;
                current
                    .put_dashboard_conditional(
                        path,
                        Bytes::from(format!("winner-{index}")),
                        MetadataWriteCondition::Update(version),
                        &tenant,
                    )
                    .await
            });
        }
        let mut winners = 0;
        while let Some(result) = writes.join_next().await {
            match result.unwrap() {
                Ok(_) => winners += 1,
                Err(ConditionalMetadataError::Conflict) => {}
                Err(error) => panic!("unexpected storage error: {error}"),
            }
        }
        assert_eq!(winners, 1);
        let stored = second
            .get_dashboard_versioned(path, &tenant)
            .await
            .unwrap()
            .unwrap();
        assert!(stored.bytes.starts_with(b"winner-"));
        assert_ne!(stored.version, original.version);
        assert!(
            first
                .get_dashboard_versioned(
                    "tenant-b/users/owner/dashboards/shared.json",
                    &Some("tenant-b".into())
                )
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn unrelated_dashboard_does_not_wait_for_held_object_lock() {
        let directory = tempfile::tempdir().unwrap();
        let first = Arc::new(LocalFS::new(directory.path().to_path_buf()));
        let second = LocalFS::new(directory.path().to_path_buf());
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let held = tokio::spawn(async move {
            first
                .metadata_with_lock(RelativePath::new("a.json"), move |_, _| {
                    ready_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                    Ok(())
                })
                .await
        });
        ready_rx.await.unwrap();
        let independent = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            second.put_metadata_conditional(
                RelativePath::new("b.json"),
                Bytes::from_static(b"different dashboard"),
                MetadataWriteCondition::Create,
                &None,
            ),
        )
        .await;
        release_tx.send(()).unwrap();
        held.await.unwrap().unwrap();
        independent
            .expect("another dashboard was blocked by a global lock")
            .unwrap();
    }

    #[tokio::test]
    async fn stale_delete_and_recreated_identical_content_do_not_reuse_version() {
        let directory = tempfile::tempdir().unwrap();
        let first = LocalFS::new(directory.path().to_path_buf());
        let second = LocalFS::new(directory.path().to_path_buf());
        let path = RelativePath::new(".users/owner/dashboards/dashboard.json");
        let bytes = Bytes::from_static(b"same content");
        let original = first
            .put_metadata_conditional(path, bytes.clone(), MetadataWriteCondition::Create, &None)
            .await
            .unwrap();
        // Legacy writes share the same lock and atomically replace the file.
        second
            .put_object(path, Bytes::from_static(b"legacy update"), &None)
            .await
            .unwrap();
        assert!(matches!(
            first
                .delete_metadata_conditional(path, original.clone(), &None)
                .await,
            Err(ConditionalMetadataError::Conflict)
        ));
        second.delete_object(path, &None).await.unwrap();
        let recreated = second
            .put_metadata_conditional(path, bytes, MetadataWriteCondition::Create, &None)
            .await
            .unwrap();
        assert_ne!(original, recreated);
        assert!(matches!(
            first
                .put_metadata_conditional(
                    path,
                    Bytes::from_static(b"stale"),
                    MetadataWriteCondition::Update(original),
                    &None
                )
                .await,
            Err(ConditionalMetadataError::Conflict)
        ));
        second
            .delete_metadata_conditional(path, recreated, &None)
            .await
            .unwrap();
        assert!(
            first
                .get_metadata_versioned(path, &None)
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn tight_identical_recreates_always_reject_stale_update_and_delete() {
        let directory = tempfile::tempdir().unwrap();
        let first = LocalFS::new(directory.path().to_path_buf());
        let second = LocalFS::new(directory.path().to_path_buf());
        let path = RelativePath::new(".users/owner/dashboards/tight.json");
        let bytes = Bytes::from_static(b"identical");
        let mut versions = HashSet::new();
        for _ in 0..200 {
            let old = first
                .put_metadata_conditional(
                    path,
                    bytes.clone(),
                    MetadataWriteCondition::Create,
                    &None,
                )
                .await
                .unwrap();
            assert!(versions.insert(old.e_tag.clone()));
            first
                .delete_metadata_conditional(path, old.clone(), &None)
                .await
                .unwrap();
            let new = second
                .put_metadata_conditional(
                    path,
                    bytes.clone(),
                    MetadataWriteCondition::Create,
                    &None,
                )
                .await
                .unwrap();
            assert_ne!(old, new);
            assert!(versions.insert(new.e_tag.clone()));
            for _ in 0..2 {
                let read = first
                    .get_metadata_versioned(path, &None)
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(read.bytes, bytes);
                assert_eq!(read.version, new);
            }
            assert!(matches!(
                first
                    .put_metadata_conditional(
                        path,
                        bytes.clone(),
                        MetadataWriteCondition::Update(old.clone()),
                        &None
                    )
                    .await,
                Err(ConditionalMetadataError::Conflict)
            ));
            assert!(matches!(
                first.delete_metadata_conditional(path, old, &None).await,
                Err(ConditionalMetadataError::Conflict)
            ));
            second
                .delete_metadata_conditional(path, new, &None)
                .await
                .unwrap();
        }
    }

    #[tokio::test]
    async fn legacy_identical_writes_and_deletes_rotate_generation_without_replacing_lock() {
        let directory = tempfile::tempdir().unwrap();
        let storage = LocalFS::new(directory.path().to_path_buf());
        let path = RelativePath::new(".users/owner/dashboards/legacy.json");
        let bytes = Bytes::from_static(b"identical");
        storage
            .put_object(path, bytes.clone(), &None)
            .await
            .unwrap();
        let lock_path = storage.metadata_lock_path(path);
        let mut original_lock = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&lock_path)
            .unwrap();
        let old_generation = read_metadata_generation(&mut original_lock).unwrap();
        let old = storage
            .get_metadata_versioned(path, &None)
            .await
            .unwrap()
            .unwrap();
        storage
            .put_object(path, bytes.clone(), &None)
            .await
            .unwrap();
        assert_ne!(
            old_generation,
            read_metadata_generation(&mut original_lock).unwrap()
        );
        let updated = storage
            .get_metadata_versioned(path, &None)
            .await
            .unwrap()
            .unwrap();
        assert_ne!(old.version, updated.version);
        storage.delete_object(path, &None).await.unwrap();
        let deleted_generation = read_metadata_generation(&mut original_lock).unwrap();
        storage.put_object(path, bytes, &None).await.unwrap();
        assert_ne!(
            deleted_generation,
            read_metadata_generation(&mut original_lock).unwrap()
        );
        assert!(matches!(
            storage
                .delete_metadata_conditional(path, updated.version, &None)
                .await,
            Err(ConditionalMetadataError::Conflict)
        ));
    }

    fn assert_synced_up_to_root(root: &Path, object: &Path, context: &str) {
        let synced = take_directory_syncs_under(root);
        for ancestor in object
            .parent()
            .unwrap()
            .ancestors()
            .take_while(|ancestor| ancestor.starts_with(root))
        {
            assert!(
                synced.contains(ancestor),
                "{context} did not sync {}",
                ancestor.display()
            );
        }
    }

    async fn create_metadata(storage: &LocalFS, path: &RelativePath) {
        storage
            .put_metadata_conditional(
                path,
                Bytes::from_static(b"{}"),
                MetadataWriteCondition::Create,
                &None,
            )
            .await
            .unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn writes_sync_every_new_directory_entry_up_to_root() {
        let paths = [
            ".users/.dashboard-locations/01ARZ3NDEKTSV4RRFFQ69G5FAV.json",
            ".users/.dashboard-titles/first-title.json",
            ".users/owner/dashboards/01ARZ3NDEKTSV4RRFFQ69G5FAV.json",
            "tenant/.users/.dashboard-titles/first-title.json",
            "tenant/.users/owner/dashboards/01ARZ3NDEKTSV4RRFFQ69G5FAV.json",
        ];
        for scenario in ["absent", "legacy", "unsynced", "concurrent", "recreated"] {
            for path in paths {
                let directory = tempfile::tempdir().unwrap();
                let root = directory.path().to_path_buf();
                let storage = Arc::new(LocalFS::new(root.clone()));
                let path = RelativePath::new(path);
                let object = storage.path_in_root(path);
                match scenario {
                    "absent" => create_metadata(&storage, path).await,
                    "legacy" => storage
                        .put_object(path, Bytes::from_static(b"{}"), &None)
                        .await
                        .unwrap(),
                    // Another opener created the hierarchy without syncing it.
                    "unsynced" => {
                        std::fs::create_dir_all(object.parent().unwrap()).unwrap();
                        std::fs::create_dir_all(root.join(METADATA_LOCK_DIRECTORY)).unwrap();
                        create_metadata(&storage, path).await;
                    }
                    // First writers race to create shared directories.
                    "concurrent" => {
                        let sibling = format!("{}.sibling", path.as_str());
                        let writers = [path.to_relative_path_buf(), sibling.into()].map(|path| {
                            let storage = storage.clone();
                            tokio::spawn(async move { create_metadata(&storage, &path).await })
                        });
                        for writer in writers {
                            writer.await.unwrap();
                        }
                    }
                    // A nonzero lock generation does not prove the hierarchy
                    // still exists: a prefix delete keeps locks but not dirs.
                    _ => {
                        create_metadata(&storage, path).await;
                        let mut lock =
                            std::fs::File::open(storage.metadata_lock_path(path)).unwrap();
                        assert_ne!(read_metadata_generation(&mut lock).unwrap(), [0; 16]);
                        let users = path.as_str().split_once(".users/").unwrap().0;
                        storage
                            .delete_prefix(&RelativePath::new(users).join(".users"), &None)
                            .await
                            .unwrap();
                        take_directory_syncs_under(&root);
                        create_metadata(&storage, path).await;
                    }
                }
                assert_synced_up_to_root(&root, &object, &format!("{scenario} write of {path}"));
            }
        }
    }

    #[tokio::test]
    async fn reading_unknown_ids_and_titles_creates_no_files_or_directories() {
        let directory = tempfile::tempdir().unwrap();
        let paths = [
            ".users/.dashboard-locations/01ARZ3NDEKTSV4RRFFQ69G5FAV.json",
            ".users/.dashboard-titles/unknown-title.json",
            ".users/owner/dashboards/01ARZ3NDEKTSV4RRFFQ69G5FAV.json",
        ];
        let root = directory.path().join("absent-root");
        let storage = LocalFS::new(root.clone());
        for path in paths {
            assert!(
                storage
                    .get_metadata_versioned(RelativePath::new(path), &None)
                    .await
                    .unwrap()
                    .is_none()
            );
        }
        assert!(!root.exists());
        std::fs::create_dir(&root).unwrap();
        for path in paths {
            assert!(
                storage
                    .get_metadata_versioned(RelativePath::new(path), &None)
                    .await
                    .unwrap()
                    .is_none()
            );
        }
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0);
        let locks = root.join(METADATA_LOCK_DIRECTORY);
        std::fs::create_dir(&locks).unwrap();
        for path in paths {
            assert!(
                storage
                    .get_metadata_versioned(RelativePath::new(path), &None)
                    .await
                    .unwrap()
                    .is_none()
            );
        }
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
        assert_eq!(std::fs::read_dir(&locks).unwrap().count(), 0);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn preexisting_readonly_metadata_and_locks_have_stable_versions() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let storage = LocalFS::new(directory.path().to_path_buf());
        let path = RelativePath::new(".users/owner/dashboards/readonly.json");
        let object_path = storage.path_in_root(path);
        std::fs::create_dir_all(object_path.parent().unwrap()).unwrap();
        std::fs::write(&object_path, b"existing").unwrap();
        std::fs::set_permissions(&object_path, std::fs::Permissions::from_mode(0o444)).unwrap();
        let lock_path = storage.metadata_lock_path(path);
        // Exercise no lock, an empty legacy lock, and a durable generation.
        for format in 0..3 {
            if format != 0 {
                std::fs::create_dir_all(lock_path.parent().unwrap()).unwrap();
                let mut lock = std::fs::OpenOptions::new()
                    .create(true)
                    .truncate(false)
                    .read(true)
                    .write(true)
                    .open(&lock_path)
                    .unwrap();
                if format == 2 {
                    rotate_metadata_generation(&mut lock).unwrap();
                }
                std::fs::set_permissions(&lock_path, std::fs::Permissions::from_mode(0o444))
                    .unwrap();
                std::fs::set_permissions(
                    lock_path.parent().unwrap(),
                    std::fs::Permissions::from_mode(0o555),
                )
                .unwrap();
            }
            std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o555))
                .unwrap();
            let first = storage.get_metadata_versioned(path, &None).await;
            let second = storage.get_metadata_versioned(path, &None).await;
            // Restore directory permissions before assertions/TempDir cleanup.
            std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o755))
                .unwrap();
            if format != 0 {
                std::fs::set_permissions(
                    lock_path.parent().unwrap(),
                    std::fs::Permissions::from_mode(0o755),
                )
                .unwrap();
                std::fs::set_permissions(&lock_path, std::fs::Permissions::from_mode(0o644))
                    .unwrap();
            }
            let first = first.unwrap().unwrap();
            let second = second.unwrap().unwrap();
            assert_eq!(first.bytes, b"existing"[..]);
            assert_eq!(first.version, second.version);
            assert_eq!(lock_path.exists(), format != 0);
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn read_without_lock_rejects_stale_version_after_concurrent_first_writer() {
        let directory = tempfile::tempdir().unwrap();
        let reader = LocalFS::new(directory.path().to_path_buf());
        let writer = LocalFS::new(directory.path().to_path_buf());
        let path = RelativePath::new(".users/owner/dashboards/first-writer.json");
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let reading = tokio::spawn(async move {
            reader
                .metadata_with_lock_mode(path, false, move |path, lock| {
                    assert!(lock.is_none());
                    ready_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                    // Force content from the first writer to pair with zero,
                    // never its new generation, after observing no lock.
                    read_local_metadata(path, lock)
                })
                .await
        });
        ready_rx.await.unwrap();
        let written = writer
            .put_metadata_conditional(
                path,
                Bytes::from_static(b"first content"),
                MetadataWriteCondition::Create,
                &None,
            )
            .await;
        release_tx.send(()).unwrap();
        let stale = reading.await.unwrap().unwrap().unwrap();
        let written = written.unwrap();
        assert_eq!(stale.bytes, b"first content"[..]);
        assert_ne!(stale.version, written);
        assert!(matches!(
            writer
                .put_metadata_conditional(
                    path,
                    Bytes::from_static(b"stale update"),
                    MetadataWriteCondition::Update(stale.version.clone()),
                    &None,
                )
                .await,
            Err(ConditionalMetadataError::Conflict)
        ));
        assert!(matches!(
            writer
                .delete_metadata_conditional(path, stale.version, &None)
                .await,
            Err(ConditionalMetadataError::Conflict)
        ));
        let current = writer
            .get_metadata_versioned(path, &None)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(current.version, written);
        assert_eq!(current.bytes, stale.bytes);
    }

    #[tokio::test]
    async fn empty_legacy_lock_migrates_and_interrupted_mutation_only_invalidates_version() {
        let directory = tempfile::tempdir().unwrap();
        let storage = LocalFS::new(directory.path().to_path_buf());
        let path = RelativePath::new(".users/owner/dashboards/migration.json");
        let object_path = storage.path_in_root(path);
        std::fs::create_dir_all(object_path.parent().unwrap()).unwrap();
        std::fs::write(&object_path, b"old content").unwrap();
        // An existing empty lock must still exclude the first mutation.
        let lock_path = storage.metadata_lock_path(path);
        std::fs::create_dir_all(lock_path.parent().unwrap()).unwrap();
        std::fs::File::create(&lock_path).unwrap();
        storage
            .metadata_with_lock_mode(path, false, move |_, lock| {
                let lock = lock.expect("existing empty lock");
                let contender = std::fs::OpenOptions::new()
                    .read(true)
                    .write(true)
                    .open(lock_path)
                    .unwrap();
                assert!(matches!(
                    contender.try_lock(),
                    Err(std::fs::TryLockError::WouldBlock)
                ));
                assert_eq!(read_metadata_generation(lock)?, [0; 16]);
                Ok(())
            })
            .await
            .unwrap();
        let old = storage
            .get_metadata_versioned(path, &None)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            std::fs::metadata(storage.metadata_lock_path(path))
                .unwrap()
                .len(),
            0
        );
        assert_eq!(
            old.version,
            storage
                .get_metadata_versioned(path, &None)
                .await
                .unwrap()
                .unwrap()
                .version
        );
        // Model a crash after the generation fsync but before object mutation.
        storage
            .metadata_with_lock(path, |_, lock| {
                rotate_metadata_generation(lock)?;
                Ok(())
            })
            .await
            .unwrap();
        let current = storage
            .get_metadata_versioned(path, &None)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(old.bytes, current.bytes);
        assert_ne!(old.version, current.version);
        assert!(matches!(
            storage
                .put_metadata_conditional(
                    path,
                    Bytes::from_static(b"stale"),
                    MetadataWriteCondition::Update(old.version),
                    &None
                )
                .await,
            Err(ConditionalMetadataError::Conflict)
        ));
        storage
            .put_metadata_conditional(
                path,
                Bytes::from_static(b"new content"),
                MetadataWriteCondition::Update(current.version),
                &None,
            )
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn partial_or_corrupt_generation_fails_closed_for_read_and_all_writers() {
        let directory = tempfile::tempdir().unwrap();
        let storage = LocalFS::new(directory.path().to_path_buf());
        let path = RelativePath::new(".users/owner/dashboards/corrupt.json");
        let old = storage
            .put_metadata_conditional(
                path,
                Bytes::from_static(b"original"),
                MetadataWriteCondition::Create,
                &None,
            )
            .await
            .unwrap();
        let lock_path = storage.metadata_lock_path(path);
        let valid = std::fs::read(&lock_path).unwrap();
        let mut corrupt = valid.clone();
        corrupt[8] ^= 1;
        let mut oversized = valid.clone();
        oversized.push(0);
        for record in [
            valid[..1].to_vec(),
            valid[..24].to_vec(),
            corrupt,
            oversized,
        ] {
            // Deliberately inject an interrupted/corrupt record with no live operations.
            std::fs::write(&lock_path, &record).unwrap();
            assert!(matches!(
                storage.get_metadata_versioned(path, &None).await,
                Err(ConditionalMetadataError::Storage(_))
            ));
            for condition in [
                MetadataWriteCondition::Create,
                MetadataWriteCondition::Update(old.clone()),
            ] {
                assert!(matches!(
                    storage
                        .put_metadata_conditional(
                            path,
                            Bytes::from_static(b"unsafe"),
                            condition,
                            &None
                        )
                        .await,
                    Err(ConditionalMetadataError::Storage(_))
                ));
            }
            assert!(matches!(
                storage
                    .delete_metadata_conditional(path, old.clone(), &None)
                    .await,
                Err(ConditionalMetadataError::Storage(_))
            ));
            assert!(
                storage
                    .put_object(path, Bytes::from_static(b"unsafe legacy"), &None)
                    .await
                    .is_err()
            );
            assert!(storage.delete_object(path, &None).await.is_err());
            assert_eq!(
                std::fs::read(storage.path_in_root(path)).unwrap(),
                b"original"
            );
            assert_eq!(std::fs::read(&lock_path).unwrap(), record);
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn versioned_read_holds_shared_lock_across_generation_and_content() {
        let directory = tempfile::tempdir().unwrap();
        let storage = LocalFS::new(directory.path().to_path_buf());
        let path = RelativePath::new(".users/owner/dashboards/read.json");
        let old = storage
            .put_metadata_conditional(
                path,
                Bytes::from_static(b"old"),
                MetadataWriteCondition::Create,
                &None,
            )
            .await
            .unwrap();
        let lock_path = storage.metadata_lock_path(path);
        let expected = storage
            .metadata_with_lock_mode(path, false, move |path, lock| {
                // Independent writers cannot rotate the generation between these reads.
                let lock = lock.expect("existing generation lock");
                let contender = std::fs::OpenOptions::new()
                    .read(true)
                    .write(true)
                    .open(lock_path)
                    .unwrap();
                assert!(matches!(
                    contender.try_lock(),
                    Err(std::fs::TryLockError::WouldBlock)
                ));
                let generation = read_metadata_generation(lock)?;
                let read = read_local_metadata(path, Some(lock))?.unwrap();
                assert_eq!(read_metadata_generation(lock)?, generation);
                Ok(read)
            })
            .await
            .unwrap();
        assert_eq!(expected.version, old);
        let actual = storage
            .get_metadata_versioned(path, &None)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(actual.version, expected.version);
        assert_eq!(actual.bytes, expected.bytes);
    }

    #[tokio::test]
    async fn ordinary_objects_avoid_metadata_lock_overhead_and_listing_filters_see_only_content() {
        let directory = tempfile::tempdir().unwrap();
        let storage = LocalFS::new(directory.path().to_path_buf());
        for path in [
            "stream/date=2026-10-17/data.parquet",
            ".schema.json",
            ".ingestor-node.json",
        ] {
            storage
                .put_object(RelativePath::new(path), Bytes::from_static(b"{}"), &None)
                .await
                .unwrap();
        }
        assert!(!directory.path().join(METADATA_LOCK_DIRECTORY).exists());
        let dashboard = RelativePath::new(".users/owner/dashboards/test.json");
        storage
            .put_object(
                dashboard,
                Bytes::from_static(b"{\"title\":\"Example\"}"),
                &None,
            )
            .await
            .unwrap();
        let locks = directory.path().join(METADATA_LOCK_DIRECTORY);
        assert!(locks.is_dir());
        assert!(storage.metadata_lock_path(dashboard).is_file());
        assert_eq!(
            storage.metadata_lock_path(dashboard),
            storage.metadata_lock_path(RelativePath::new("./.users/owner/dashboards/test.json"))
        );
        assert!(
            !directory
                .path()
                .join(".users/owner/dashboards/test.json.metadata.lock")
                .exists()
        );
        for needle in [".schema", ".ingestor"] {
            let needle = needle.to_owned();
            let objects = storage
                .get_objects(None, Box::new(move |name| name.contains(&needle)), &None)
                .await
                .unwrap();
            assert_eq!(objects.len(), 1);
            assert_eq!(objects[0], Bytes::from_static(b"{}"));
        }
        let dashboards = storage
            .get_objects(
                Some(RelativePath::new(".users/owner/dashboards")),
                Box::new(|name| name.ends_with(".json")),
                &None,
            )
            .await
            .unwrap();
        assert_eq!(dashboards.len(), 1);
        assert!(!dashboards[0].is_empty());
        assert!(
            !storage
                .list_dirs(&None)
                .await
                .unwrap()
                .iter()
                .any(|name| name == METADATA_LOCK_DIRECTORY)
        );
        storage.delete_object(dashboard, &None).await.unwrap();
        assert!(storage.metadata_lock_path(dashboard).is_file());
        storage
            .delete_object(
                RelativePath::new("stream/date=2026-10-17/data.parquet"),
                &None,
            )
            .await
            .unwrap();
        assert_eq!(std::fs::read_dir(locks).unwrap().count(), 1);
    }
}

#[cfg(test)]
mod upload_multipart_tests {
    use super::*;

    fn assert_no_upload_temps(directory: &Path) {
        assert!(
            std::fs::read_dir(directory)
                .unwrap()
                .all(|entry| !is_upload_temp(&entry.unwrap().path()))
        );
    }

    async fn finish_fallback(
        root: &Path,
        key: &str,
        fallback: Option<fs::File>,
    ) -> Result<(), ObjectStorageError> {
        if let Some(mut source) = fallback {
            let mut data = Vec::new();
            source.read_to_end(&mut data).await?;
            LocalFS::new(root.to_path_buf())
                .put_object(RelativePath::new(key), data.into(), &None)
                .await?;
        }
        Ok(())
    }

    fn pause_at(
        stage: UploadCopyStage,
    ) -> (
        impl FnMut(UploadCopyStage, &Path) + Send + 'static,
        tokio::sync::oneshot::Receiver<PathBuf>,
        std::sync::mpsc::Sender<()>,
    ) {
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let mut ready_tx = Some(ready_tx);
        let hook = move |current, path: &Path| {
            if current == stage {
                ready_tx.take().unwrap().send(path.to_path_buf()).unwrap();
                release_rx.recv().unwrap();
            }
        };
        (hook, ready_rx, release_tx)
    }

    fn fail_after_partial_copy(
        source: &mut std::fs::File,
        dest: &mut std::fs::File,
    ) -> std::io::Result<u64> {
        use std::io::{Read, Write};

        let mut prefix = [0; 128];
        let len = source.read(&mut prefix)?;
        dest.write_all(&prefix[..len])?;
        Err(std::io::Error::new(
            std::io::ErrorKind::WriteZero,
            "injected copy failure after partial write",
        ))
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn real_source_read_error_keeps_concurrent_commit() {
        let dir = tempfile::tempdir().unwrap();
        let object = dir.path().join("object");
        let baseline = std::fs::read("/proc/self/mem").unwrap_err();
        let (hook, ready, release) = pause_at(UploadCopyStage::CopyFailed);
        let copying = tokio::spawn(async move {
            copy_into_new_file_with(
                fs::File::open("/proc/self/mem").await.unwrap(),
                &object,
                std::io::copy,
                |temp, final_path| std::fs::hard_link(temp, final_path),
                hook,
            )
            .await
        });
        let private = ready.await.unwrap();
        assert!(private.is_file());
        assert!(!dir.path().join("object").exists());
        LocalFS::new(dir.path().to_path_buf())
            .put_object(
                RelativePath::new("object"),
                Bytes::from_static(b"B committed"),
                &None,
            )
            .await
            .unwrap();
        release.send(()).unwrap();
        match copying.await.unwrap().unwrap_err() {
            ObjectStorageError::IoError(err) => {
                assert_eq!(err.raw_os_error(), baseline.raw_os_error())
            }
            other => panic!("unexpected error: {other:?}"),
        }
        assert_eq!(
            std::fs::read(dir.path().join("object")).unwrap(),
            b"B committed"
        );
        assert!(!private.exists());
        assert_no_upload_temps(dir.path());
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn source_read_error_leaves_no_public_object_or_private_copy() {
        let dir = tempfile::tempdir().unwrap();
        let baseline = std::fs::read("/proc/self/mem").unwrap_err();
        for key in ["new/parent/object", "existing-directory"] {
            std::fs::create_dir_all(dir.path().join("existing-directory")).unwrap();
            match upload(dir.path(), key, Path::new("/proc/self/mem"))
                .await
                .unwrap_err()
            {
                ObjectStorageError::IoError(err) => {
                    assert_eq!(err.raw_os_error(), baseline.raw_os_error())
                }
                other => panic!("unexpected error: {other:?}"),
            }
        }
        assert!(!dir.path().join("new/parent/object").exists());
        assert!(dir.path().join("existing-directory").is_dir());
        assert_no_upload_temps(&dir.path().join("new/parent"));
        assert_no_upload_temps(dir.path());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cleanup_failure_keeps_original_copy_error_and_concurrent_object() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source");
        let object = dir.path().join("object");
        std::fs::write(&source, pattern(1024)).unwrap();
        let raced_object = object.clone();
        let result = copy_into_new_file_with(
            fs::File::open(source).await.unwrap(),
            &object,
            fail_after_partial_copy,
            |temp, final_path| std::fs::hard_link(temp, final_path),
            move |stage, temp| {
                if stage == UploadCopyStage::CopyFailed {
                    std::fs::write(&raced_object, b"B committed").unwrap();
                    // Force remove_file to fail without changing process-wide
                    // permissions or limits. The replacement remains private.
                    std::fs::remove_file(temp).unwrap();
                    std::fs::create_dir(temp).unwrap();
                }
            },
        )
        .await;
        match result.unwrap_err() {
            ObjectStorageError::IoError(err) => {
                assert_eq!(err.kind(), std::io::ErrorKind::WriteZero);
                assert_eq!(err.to_string(), "injected copy failure after partial write");
            }
            other => panic!("unexpected error: {other:?}"),
        }
        assert_eq!(std::fs::read(object).unwrap(), b"B committed");
    }

    #[tokio::test]
    async fn copy_error_keeps_concurrent_commit_even_with_same_inode() {
        for same_inode in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let source = dir.path().join("source");
            let object = dir.path().join("object");
            std::fs::write(&source, pattern(1024)).unwrap();
            let (hook, ready, release) = pause_at(UploadCopyStage::CopyFailed);
            let copying = tokio::spawn(async move {
                copy_into_new_file_with(
                    fs::File::open(&source).await.unwrap(),
                    &object,
                    fail_after_partial_copy,
                    |temp, final_path| std::fs::hard_link(temp, final_path),
                    hook,
                )
                .await
            });
            let private = ready.await.unwrap();
            let object = dir.path().join("object");
            if same_inode {
                // Exercise the stronger case: B overwrites A's inode, so an
                // inode-identity check would not justify unlinking the final.
                std::fs::hard_link(&private, &object).unwrap();
            }
            LocalFS::new(dir.path().to_path_buf())
                .put_object(
                    RelativePath::new("object"),
                    Bytes::from_static(b"B committed"),
                    &None,
                )
                .await
                .unwrap();
            if same_inode {
                assert_eq!(std::fs::read(&private).unwrap(), b"B committed");
            }
            release.send(()).unwrap();
            match copying.await.unwrap().unwrap_err() {
                ObjectStorageError::IoError(err) => {
                    assert_eq!(err.kind(), std::io::ErrorKind::WriteZero);
                    assert_eq!(err.to_string(), "injected copy failure after partial write");
                }
                other => panic!("unexpected error: {other:?}"),
            }
            assert_eq!(std::fs::read(object).unwrap(), b"B committed");
            assert!(!private.exists());
            assert_no_upload_temps(dir.path());
        }
    }

    #[tokio::test]
    async fn identical_upload_retry_survives_failed_private_copy() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source");
        let object = dir.path().join("object");
        let data = pattern(64 * 1024 + 5);
        std::fs::write(&source, &data).unwrap();
        let (hook, ready, release) = pause_at(UploadCopyStage::CopyFailed);
        let input = fs::File::open(&source).await.unwrap();
        let copying = tokio::spawn(async move {
            copy_into_new_file_with(
                input,
                &object,
                fail_after_partial_copy,
                |temp, final_path| std::fs::hard_link(temp, final_path),
                hook,
            )
            .await
        });
        ready.await.unwrap();
        upload(dir.path(), "object", &source).await.unwrap();
        release.send(()).unwrap();
        assert!(copying.await.unwrap().is_err());
        assert_eq!(std::fs::read(dir.path().join("object")).unwrap(), data);
        assert_no_upload_temps(dir.path());
    }

    #[tokio::test]
    async fn publication_failure_restores_exact_fallback_bytes_and_position() {
        use tokio::io::AsyncSeekExt;

        for initial_position in [0, 37] {
            let dir = tempfile::tempdir().unwrap();
            let source = dir.path().join("source");
            let object = dir.path().join("object");
            let data = pattern(3 * 1024 * 1024 + 5);
            std::fs::write(&source, &data).unwrap();
            let mut input = fs::File::open(&source).await.unwrap();
            input
                .seek(std::io::SeekFrom::Start(initial_position))
                .await
                .unwrap();
            let fallback = copy_into_new_file_with(
                input,
                &object,
                std::io::copy,
                |_, _| Err(std::io::ErrorKind::Unsupported.into()),
                |_, _| {},
            )
            .await
            .unwrap();
            assert!(fallback.is_some());
            assert!(!object.exists());
            assert_no_upload_temps(dir.path());
            finish_fallback(dir.path(), "object", fallback)
                .await
                .unwrap();
            assert_eq!(
                std::fs::read(&object).unwrap(),
                data[initial_position as usize..]
            );
        }
    }

    #[tokio::test]
    async fn newly_appearing_destination_uses_complete_buffered_fallback() {
        for directory in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let source = dir.path().join("source");
            let object = dir.path().join("object");
            let data = pattern(64 * 1024 + 5);
            std::fs::write(&source, &data).unwrap();
            let raced_object = object.clone();
            let fallback = copy_into_new_file_with(
                fs::File::open(source).await.unwrap(),
                &object,
                std::io::copy,
                |temp, final_path| std::fs::hard_link(temp, final_path),
                move |stage, _| {
                    if stage == UploadCopyStage::BeforePublish {
                        if directory {
                            std::fs::create_dir(&raced_object).unwrap();
                        } else {
                            std::fs::write(&raced_object, b"concurrent old bytes").unwrap();
                        }
                    }
                },
            )
            .await
            .unwrap();
            assert!(fallback.is_some());
            let result = finish_fallback(dir.path(), "object", fallback).await;
            if directory {
                let expected = std::fs::write(&object, &data).unwrap_err();
                match result.unwrap_err() {
                    ObjectStorageError::IoError(actual) => {
                        assert_eq!(actual.kind(), expected.kind())
                    }
                    other => panic!("unexpected error: {other:?}"),
                }
                assert!(object.is_dir());
            } else {
                result.unwrap();
                assert_eq!(std::fs::read(&object).unwrap(), data);
            }
            assert_no_upload_temps(dir.path());
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn newly_appearing_links_keep_alias_mode_and_symlink_type() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};

        for symlink in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let source = dir.path().join("source");
            let target = dir.path().join("target");
            let object = dir.path().join("object");
            std::fs::write(&source, b"complete source bytes").unwrap();
            std::fs::write(&target, b"old").unwrap();
            std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o640)).unwrap();
            let before = std::fs::metadata(&target).unwrap();
            let raced_target = target.clone();
            let raced_object = object.clone();
            let fallback = copy_into_new_file_with(
                fs::File::open(&source).await.unwrap(),
                &object,
                std::io::copy,
                |temp, final_path| std::fs::hard_link(temp, final_path),
                move |stage, _| {
                    if stage == UploadCopyStage::BeforePublish {
                        if symlink {
                            std::os::unix::fs::symlink(&raced_target, &raced_object).unwrap();
                        } else {
                            std::fs::hard_link(&raced_target, &raced_object).unwrap();
                        }
                    }
                },
            )
            .await
            .unwrap();
            assert!(fallback.is_some());
            finish_fallback(dir.path(), "object", fallback)
                .await
                .unwrap();
            let after = std::fs::metadata(&object).unwrap();
            assert_eq!(after.ino(), before.ino());
            assert_eq!(after.permissions().mode(), before.permissions().mode());
            assert_eq!(
                std::fs::symlink_metadata(&object)
                    .unwrap()
                    .file_type()
                    .is_symlink(),
                symlink
            );
            assert_eq!(std::fs::read(&target).unwrap(), b"complete source bytes");
            assert_no_upload_temps(dir.path());
        }
    }

    #[tokio::test]
    async fn private_copy_is_invisible_to_listings_before_publication() {
        let dir = tempfile::tempdir().unwrap();
        let source_dir = tempfile::tempdir().unwrap();
        let source = source_dir.path().join("source");
        std::fs::write(&source, b"private unfinished bytes").unwrap();
        let object = dir.path().join(".ingestor-node.json");
        let (hook, ready, release) = pause_at(UploadCopyStage::BeforePublish);
        let copying = tokio::spawn(async move {
            copy_into_new_file_with(
                fs::File::open(source).await.unwrap(),
                &object,
                std::io::copy,
                |temp, final_path| std::fs::hard_link(temp, final_path),
                hook,
            )
            .await
        });
        let private = ready.await.unwrap();
        assert!(private.is_file());
        assert_ne!(private.extension(), Some(std::ffi::OsStr::new("parquet")));
        let storage = LocalFS::new(dir.path().to_path_buf());
        // A stale private name must stay invisible even if a caller's broad
        // substring filter matches it. Live UUID names contain no key suffix.
        let residue = dir
            .path()
            .join(format!("{UPLOAD_TEMP_PREFIX}ingestor.schema.json"));
        std::fs::write(&residue, b"stale residue").unwrap();
        let private_dir = dir
            .path()
            .join(format!("{UPLOAD_TEMP_PREFIX}stale-directory"));
        std::fs::create_dir_all(private_dir.join(STREAM_ROOT_DIRECTORY)).unwrap();
        std::fs::write(private_dir.join(STREAM_METADATA_FILE_NAME), b"{}").unwrap();
        std::fs::write(
            private_dir
                .join(STREAM_ROOT_DIRECTORY)
                .join(STREAM_METADATA_FILE_NAME),
            b"{}",
        )
        .unwrap();
        for filter in ["", "ingestor", ".schema"] {
            let objects = storage
                .get_objects(None, Box::new(move |name| name.contains(filter)), &None)
                .await
                .unwrap();
            assert!(objects.is_empty());
        }
        assert!(
            storage
                .get_ingestor_meta_file_paths(&None)
                .await
                .unwrap()
                .is_empty()
        );
        assert!(storage.list_dirs(&None).await.unwrap().is_empty());
        assert!(
            storage
                .list_dirs_relative(RelativePath::new(""), &None)
                .await
                .unwrap()
                .is_empty()
        );
        assert!(storage.list_streams().await.unwrap().is_empty());
        assert!(storage.list_old_streams().await.unwrap().is_empty());
        assert!(storage.list_dates("", &None).await.unwrap().is_empty());
        assert!(storage.list_hours("", "", &None).await.unwrap().is_empty());
        assert!(
            storage
                .list_minutes("", "", "", &None)
                .await
                .unwrap()
                .is_empty()
        );
        release.send(()).unwrap();
        assert!(copying.await.unwrap().unwrap().is_none());
        assert!(!private.exists());
        assert_eq!(std::fs::read(&residue).unwrap(), b"stale residue");
        assert_eq!(
            storage
                .get_ingestor_meta_file_paths(&None)
                .await
                .unwrap()
                .len(),
            1
        );
        std::fs::remove_file(residue).unwrap();
        std::fs::remove_dir_all(private_dir).unwrap();
        assert_no_upload_temps(dir.path());
    }

    #[test]
    fn private_name_collision_attempts_are_bounded_and_do_not_remove_other_files() {
        let dir = tempfile::tempdir().unwrap();
        let name = format!("{UPLOAD_TEMP_PREFIX}collision.tmp");
        let path = dir.path().join(&name);
        std::fs::write(&path, b"owned by somebody else").unwrap();
        let mut attempts = 0;
        let result = UploadTemp::create_with_name(dir.path(), &dir.path().join("object"), || {
            attempts += 1;
            name.clone()
        });
        assert!(matches!(result, Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists));
        assert_eq!(attempts, UploadTemp::COLLISION_ATTEMPTS);
        assert_eq!(std::fs::read(path).unwrap(), b"owned by somebody else");
    }

    #[test]
    fn private_name_must_not_equal_the_final_name() {
        let dir = tempfile::tempdir().unwrap();
        let name = format!("{UPLOAD_TEMP_PREFIX}excluded.tmp");
        let object = dir.path().join(&name);
        let result = UploadTemp::create_with_name(dir.path(), &object, || name.clone());
        assert!(matches!(result, Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists));
        assert!(!object.exists());
    }

    #[test]
    fn private_copy_cleanup_runs_during_unwinding() {
        let dir = tempfile::tempdir().unwrap();
        let object = dir.path().join("object");
        std::fs::write(&object, b"B committed").unwrap();
        let result = std::panic::catch_unwind(|| {
            let _temp = UploadTemp::create(dir.path(), &object).unwrap();
            panic!("simulated copy task panic");
        });
        assert!(result.is_err());
        assert_eq!(std::fs::read(object).unwrap(), b"B committed");
        assert_no_upload_temps(dir.path());
    }

    #[tokio::test]
    async fn blocking_copy_owns_cleanup_after_async_waiter_is_cancelled() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source");
        let object = dir.path().join("object");
        std::fs::write(&source, pattern(1024)).unwrap();
        let (hook, ready, release) = pause_at(UploadCopyStage::TempCreated);
        let (finished_tx, finished_rx) = tokio::sync::oneshot::channel();
        // This sender is captured by the blocking closure's publication function.
        // Its drop signals that the entire blocking closure (including its
        // operation-owned temp guard) has finished unwinding after failure.
        struct Finished(Option<tokio::sync::oneshot::Sender<()>>);
        impl Drop for Finished {
            fn drop(&mut self) {
                let _ = self.0.take().unwrap().send(());
            }
        }
        let finished = Finished(Some(finished_tx));
        let copying = tokio::spawn(async move {
            copy_into_new_file_with(
                fs::File::open(source).await.unwrap(),
                &object,
                fail_after_partial_copy,
                move |temp, final_path| {
                    let _keep_finished_alive = &finished;
                    std::fs::hard_link(temp, final_path)
                },
                hook,
            )
            .await
        });
        let private = ready.await.unwrap();
        copying.abort();
        assert!(copying.await.unwrap_err().is_cancelled());
        LocalFS::new(dir.path().to_path_buf())
            .put_object(
                RelativePath::new("object"),
                Bytes::from_static(b"B committed"),
                &None,
            )
            .await
            .unwrap();
        release.send(()).unwrap();
        finished_rx.await.unwrap();
        assert!(!private.exists());
        assert_eq!(
            std::fs::read(dir.path().join("object")).unwrap(),
            b"B committed"
        );
    }

    fn pattern(len: usize) -> Vec<u8> {
        (0..len).map(|i| (i % 251) as u8).collect()
    }

    async fn upload(root: &Path, key: &str, source: &Path) -> Result<(), ObjectStorageError> {
        LocalFS::new(root.to_path_buf())
            .upload_multipart(RelativePath::new(key), source, &None)
            .await
    }

    #[tokio::test]
    async fn new_object_is_streamed_with_exact_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("staging.parquet");
        let data = pattern(3 * 1024 * 1024 + 5);
        std::fs::write(&source, &data).unwrap();
        let root = dir.path().join("store");

        upload(&root, "stream/date=x/file.parquet", &source)
            .await
            .unwrap();

        let object = root.join("stream/date=x/file.parquet");
        assert_eq!(std::fs::read(&object).unwrap(), data);
        assert_eq!(std::fs::read(&source).unwrap(), data);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let written = dir.path().join("written");
            std::fs::write(&written, b"x").unwrap();
            assert_eq!(
                std::fs::metadata(&object).unwrap().permissions().mode(),
                std::fs::metadata(&written).unwrap().permissions().mode()
            );
        }
    }

    #[tokio::test]
    async fn only_new_destinations_are_streamed() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source");
        std::fs::write(&source, b"payload").unwrap();
        let existing = dir.path().join("existing");
        std::fs::write(&existing, b"old").unwrap();

        let open = || fs::File::open(&source);
        let streamed = copy_into_new_file(open().await.unwrap(), &dir.path().join("a/new"))
            .await
            .unwrap();
        assert!(streamed.is_none());
        assert_eq!(std::fs::read(dir.path().join("a/new")).unwrap(), b"payload");

        let fallback = copy_into_new_file(open().await.unwrap(), &existing)
            .await
            .unwrap();
        let mut rest = Vec::new();
        fallback.unwrap().read_to_end(&mut rest).await.unwrap();
        assert_eq!(rest, b"payload");
        assert_eq!(std::fs::read(&existing).unwrap(), b"old");
    }

    #[tokio::test]
    async fn empty_source_creates_empty_object() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("empty");
        std::fs::write(&source, b"").unwrap();

        upload(dir.path(), "out/empty", &source).await.unwrap();

        assert_eq!(std::fs::read(dir.path().join("out/empty")).unwrap(), b"");
    }

    #[tokio::test]
    async fn existing_object_is_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source");
        std::fs::write(&source, b"new").unwrap();
        std::fs::create_dir_all(dir.path().join("out")).unwrap();
        std::fs::write(dir.path().join("out/object"), b"much longer old object").unwrap();

        upload(dir.path(), "out/object", &source).await.unwrap();

        assert_eq!(
            std::fs::read(dir.path().join("out/object")).unwrap(),
            b"new"
        );
    }

    #[tokio::test]
    async fn source_aliasing_destination_keeps_contents() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("same");
        std::fs::write(&source, b"payload").unwrap();

        upload(dir.path(), "same", &source).await.unwrap();

        assert_eq!(std::fs::read(&source).unwrap(), b"payload");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn existing_hardlink_and_mode_are_preserved() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};

        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source");
        let target = dir.path().join("target");
        let object = dir.path().join("object");
        std::fs::write(&source, b"new payload").unwrap();
        std::fs::write(&target, b"old").unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o640)).unwrap();
        std::fs::hard_link(&target, &object).unwrap();
        let before = std::fs::metadata(&object).unwrap();

        upload(dir.path(), "object", &source).await.unwrap();

        let after = std::fs::metadata(&object).unwrap();
        assert_eq!(before.ino(), after.ino());
        assert_eq!(before.permissions().mode(), after.permissions().mode());
        assert_eq!(std::fs::read(&target).unwrap(), b"new payload");
        // An alias of the source must also be fully read before truncation.
        std::fs::remove_file(&object).unwrap();
        std::fs::hard_link(&source, &object).unwrap();
        upload(dir.path(), "object", &source).await.unwrap();
        assert_eq!(std::fs::read(&source).unwrap(), b"new payload");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn readonly_destination_matches_buffered_write_result() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source");
        let object = dir.path().join("object");
        let control = dir.path().join("control");
        std::fs::write(&source, b"new payload").unwrap();
        for path in [&object, &control] {
            std::fs::write(path, b"old").unwrap();
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o444)).unwrap();
        }
        // Also valid under root, where both writes may succeed despite mode.
        let expected = std::fs::write(&control, b"new payload");
        let actual = upload(dir.path(), "object", &source).await;
        match (expected, actual) {
            (Ok(()), Ok(())) => {}
            (Err(expected), Err(ObjectStorageError::IoError(actual))) => {
                assert_eq!(expected.kind(), actual.kind());
            }
            other => panic!("buffered/streaming result mismatch: {other:?}"),
        }
        assert_eq!(
            std::fs::read(&object).unwrap(),
            std::fs::read(&control).unwrap()
        );
        assert_eq!(
            std::fs::metadata(&object).unwrap().permissions().mode() & 0o777,
            0o444
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn destination_symlink_to_source_keeps_contents() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source");
        std::fs::write(&source, b"payload").unwrap();
        std::os::unix::fs::symlink(&source, dir.path().join("link")).unwrap();

        upload(dir.path(), "link", &source).await.unwrap();

        assert_eq!(std::fs::read(&source).unwrap(), b"payload");
        assert!(
            std::fs::symlink_metadata(dir.path().join("link"))
                .unwrap()
                .file_type()
                .is_symlink()
        );
    }

    #[tokio::test]
    async fn directory_destination_fails_and_is_kept() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source");
        std::fs::write(&source, b"payload").unwrap();
        std::fs::create_dir_all(dir.path().join("out/object")).unwrap();

        let err = upload(dir.path(), "out/object", &source).await.unwrap_err();

        assert!(matches!(err, ObjectStorageError::IoError(_)), "{err:?}");
        assert!(dir.path().join("out/object").is_dir());
    }

    #[tokio::test]
    async fn directory_source_fails_before_creating_destination() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source-dir");
        std::fs::create_dir(&source).unwrap();

        let err = upload(dir.path(), "out/object", &source).await.unwrap_err();

        assert!(matches!(err, ObjectStorageError::IoError(_)), "{err:?}");
        assert!(!dir.path().join("out").exists());
    }

    #[tokio::test]
    async fn missing_source_fails_before_creating_destination() {
        let dir = tempfile::tempdir().unwrap();

        let err = upload(dir.path(), "out/object", &dir.path().join("missing"))
            .await
            .unwrap_err();

        match err {
            ObjectStorageError::IoError(err) => {
                assert_eq!(err.kind(), std::io::ErrorKind::NotFound)
            }
            other => panic!("unexpected error {other:?}"),
        }
        assert!(!dir.path().join("out").exists());
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn source_read_error_precedes_invalid_destination_parent() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("blocked"), b"not a directory").unwrap();
        // Linux exposes this as a regular file, but offset zero is unreadable.
        let source = Path::new("/proc/self/mem");
        let baseline = std::fs::read(source).unwrap_err();
        let err = upload(dir.path(), "blocked/object", source)
            .await
            .unwrap_err();
        match err {
            ObjectStorageError::IoError(err) => {
                assert_eq!(err.raw_os_error(), baseline.raw_os_error());
            }
            other => panic!("unexpected error {other:?}"),
        }
        assert_eq!(
            std::fs::read(dir.path().join("blocked")).unwrap(),
            b"not a directory"
        );
    }
}
