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
        self.metadata_with_lock_mode(path, true, operation).await
    }

    async fn metadata_with_lock_mode<T: Send + 'static>(
        &self,
        path: &RelativePath,
        exclusive: bool,
        operation: impl FnOnce(&Path, &mut std::fs::File) -> Result<T, ConditionalMetadataError>
        + Send
        + 'static,
    ) -> Result<T, ConditionalMetadataError> {
        let lock_path = self.metadata_lock_path(path);
        let path = self.checked_metadata_path(path)?;
        tokio::task::spawn_blocking(move || {
            let parent = path
                .parent()
                .ok_or_else(|| ObjectStorageError::Custom("metadata path has no parent".into()))?;
            if exclusive {
                std::fs::create_dir_all(parent).map_err(ObjectStorageError::from)?;
            }
            std::fs::create_dir_all(lock_path.parent().expect("private lock directory"))
                .map_err(ObjectStorageError::from)?;
            let mut lock = std::fs::OpenOptions::new()
                .create(true)
                .truncate(false)
                .read(true)
                .write(true)
                .open(&lock_path)
                .map_err(ObjectStorageError::from)?;
            if exclusive {
                lock.lock().map_err(ObjectStorageError::from)?;
                // Persist the private directory and lock entry before allowing a
                // mutation. Another opener may have created either entry but not
                // synced it yet. Never replace or remove this lock inode.
                sync_metadata_parent(&lock_path)?;
                sync_metadata_parent(lock_path.parent().expect("private lock directory"))?;
            } else {
                lock.lock_shared().map_err(ObjectStorageError::from)?;
            }
            // The lock is released even if operation returns an error or panics.
            operation(&path, &mut lock)
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
        // Open/create the same stable lock even for a missing object: an absent
        // lockfile fallback could mix a new generation with old content.
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
            let current = read_local_metadata(path, lock)?;
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
            Ok(read_local_metadata(path, lock)?
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
            if read_local_metadata(path, lock)?
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

    if ignore_dirs.contains(&dir_name.as_str()) {
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

    if ignore_dirs.contains(&dir_name.as_str()) {
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
    if entry.file_name() == METADATA_LOCK_DIRECTORY {
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
    lock: &mut std::fs::File,
) -> Result<Option<VersionedMetadata>, ConditionalMetadataError> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let generation = read_metadata_generation(lock)?;
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
    // all repeat. The caller holds the same lock across generation/content reads.
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
    #[cfg(unix)]
    std::fs::File::open(path.parent().expect("metadata parent"))?.sync_all()?;
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

    #[tokio::test]
    async fn empty_legacy_lock_migrates_and_interrupted_mutation_only_invalidates_version() {
        let directory = tempfile::tempdir().unwrap();
        let storage = LocalFS::new(directory.path().to_path_buf());
        let path = RelativePath::new(".users/owner/dashboards/migration.json");
        let object_path = storage.path_in_root(path);
        std::fs::create_dir_all(object_path.parent().unwrap()).unwrap();
        std::fs::write(&object_path, b"old content").unwrap();
        // No lock exists yet; versioned reads must create/open the stable lock.
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
                let read = read_local_metadata(path, lock)?.unwrap();
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
