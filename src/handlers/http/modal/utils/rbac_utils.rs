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

use std::{future::Future, io};

use crate::{
    parseable::PARSEABLE,
    storage::{self, ObjectStorageError, StorageMetadata},
};

pub async fn get_metadata(
    tenant_id: &Option<String>,
) -> Result<crate::storage::StorageMetadata, ObjectStorageError> {
    let metadata = PARSEABLE
        .metastore
        .get_parseable_metadata(tenant_id)
        .await
        .map_err(|e| ObjectStorageError::MetastoreError(Box::new(e.to_detail())))?
        .ok_or_else(|| ObjectStorageError::Custom("parseable metadata not initialized".into()))?;
    Ok(serde_json::from_slice::<StorageMetadata>(&metadata)?)
}

/// Persist authoritative metadata and refresh its best-effort local staging copy.
/// Success lets callers publish the committed change to live RBAC state.
pub async fn put_metadata(
    metadata: &StorageMetadata,
    tenant_id: &Option<String>,
) -> Result<(), ObjectStorageError> {
    put_metadata_with_writers(
        storage::put_remote_metadata(metadata, tenant_id),
        || storage::put_staging_metadata(metadata, tenant_id),
        tenant_id,
    )
    .await
}

async fn put_metadata_with_writers(
    remote_write: impl Future<Output = Result<(), ObjectStorageError>>,
    staging_write: impl FnOnce() -> io::Result<()>,
    tenant_id: &Option<String>,
) -> Result<(), ObjectStorageError> {
    remote_write.await?;
    // A staging failure cannot undo the durable commit. Returning an error here
    // would leave callers' live authorization state behind the source of truth.
    if let Err(error) = staging_write() {
        tracing::error!(
            error = %error,
            tenant_id = ?tenant_id,
            "Failed to refresh staging metadata after durable metadata write"
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use super::*;

    #[tokio::test]
    async fn staging_failure_after_durable_success_returns_success() {
        let durable_written = Cell::new(false);
        let staging_attempted = Cell::new(false);
        let result = put_metadata_with_writers(
            async {
                durable_written.set(true);
                Ok(())
            },
            || {
                assert!(
                    durable_written.get(),
                    "durable metadata must be written first"
                );
                staging_attempted.set(true);
                Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "staging is read-only",
                ))
            },
            &None,
        )
        .await;

        assert!(staging_attempted.get());
        assert!(
            result.is_ok(),
            "callers must publish durable changes to live authorization: {result:?}"
        );
    }

    #[tokio::test]
    async fn durable_failure_is_returned_without_attempting_staging() {
        let result = put_metadata_with_writers(
            async { Err(ObjectStorageError::Custom("durable write failed".into())) },
            || panic!("staging must not be changed after a failed durable write"),
            &None,
        )
        .await;

        assert!(
            matches!(result, Err(ObjectStorageError::Custom(message)) if message == "durable write failed")
        );
    }

    #[tokio::test]
    async fn successful_writes_run_durable_before_staging() {
        let durable_written = Cell::new(false);
        let staging_written = Cell::new(false);
        let result = put_metadata_with_writers(
            async {
                durable_written.set(true);
                Ok(())
            },
            || {
                assert!(durable_written.get());
                staging_written.set(true);
                Ok(())
            },
            &None,
        )
        .await;

        assert!(result.is_ok());
        assert!(staging_written.get());
    }
}
