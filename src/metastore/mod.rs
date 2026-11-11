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

use actix_web::http::StatusCode;
use serde::Serialize;

use crate::storage::ObjectStorageError;

pub mod metastore_traits;
pub mod metastores;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MetastoreErrorDetail {
    pub operation: String,
    pub message: String,
    pub stream_name: Option<String>,
    pub file_path: Option<String>,
    pub timestamp: Option<chrono::DateTime<chrono::Utc>>,
    pub metadata: std::collections::HashMap<String, String>,
    pub status_code: u16,
}

#[derive(Debug, thiserror::Error)]
pub enum MetastoreError {
    #[error("ObjectStorageError: {0}")]
    ObjectStorageError(#[from] ObjectStorageError),

    #[error("JSON parsing error: {0}")]
    JsonParseError(#[from] serde_json::Error),

    #[error("Manifest encoding error: {0}")]
    ManifestCodecError(#[from] crate::catalog::manifest::ManifestCodecError),

    #[error("JSON schema validation error: {message}")]
    JsonSchemaError { message: String },

    #[error("Invalid JSON structure: expected {expected}, found {found}")]
    InvalidJsonStructure { expected: String, found: String },

    #[error("Missing required JSON field: {field}")]
    MissingJsonField { field: String },

    #[error("Invalid JSON value for field '{field}': {reason}")]
    InvalidJsonValue { field: String, reason: String },

    #[error("{self:?}")]
    Error {
        status_code: StatusCode,
        message: String,
        flow: String,
    },
}

impl MetastoreError {
    /// Preserve provider errors at pre-existing ObjectStorage call sites.
    pub(crate) fn into_storage_error(self) -> ObjectStorageError {
        match self {
            Self::ObjectStorageError(error) => error,
            error => ObjectStorageError::MetastoreError(Box::new(error.to_detail())),
        }
    }

    pub fn to_detail(&self) -> MetastoreErrorDetail {
        match self {
            MetastoreError::Error {
                status_code,
                message,
                flow,
            } => MetastoreErrorDetail {
                operation: flow.clone(),
                message: message.clone(),
                stream_name: None,
                file_path: None,
                timestamp: Some(chrono::Utc::now()),
                metadata: std::collections::HashMap::new(),
                status_code: status_code.as_u16(),
            },
            MetastoreError::ObjectStorageError(e) => MetastoreErrorDetail {
                operation: "ObjectStorageError".to_string(),
                message: e.to_string(),
                stream_name: None,
                file_path: None,
                timestamp: Some(chrono::Utc::now()),
                metadata: std::collections::HashMap::new(),
                status_code: 500,
            },
            MetastoreError::JsonParseError(e) => MetastoreErrorDetail {
                operation: "JsonParseError".to_string(),
                message: e.to_string(),
                stream_name: None,
                file_path: None,
                timestamp: Some(chrono::Utc::now()),
                metadata: std::collections::HashMap::new(),
                status_code: 400,
            },
            MetastoreError::ManifestCodecError(e) => MetastoreErrorDetail {
                operation: "ManifestCodecError".to_string(),
                message: e.to_string(),
                stream_name: None,
                file_path: None,
                timestamp: Some(chrono::Utc::now()),
                metadata: std::collections::HashMap::new(),
                status_code: 500,
            },
            MetastoreError::JsonSchemaError { message } => MetastoreErrorDetail {
                operation: "JsonSchemaError".to_string(),
                message: message.clone(),
                stream_name: None,
                file_path: None,
                timestamp: Some(chrono::Utc::now()),
                metadata: std::collections::HashMap::new(),
                status_code: 400,
            },
            MetastoreError::InvalidJsonStructure { expected, found } => MetastoreErrorDetail {
                operation: "InvalidJsonStructure".to_string(),
                message: format!("Expected {}, found {}", expected, found),
                stream_name: None,
                file_path: None,
                timestamp: Some(chrono::Utc::now()),
                metadata: [
                    ("expected".to_string(), expected.clone()),
                    ("found".to_string(), found.clone()),
                ]
                .into_iter()
                .collect(),
                status_code: 400,
            },
            MetastoreError::MissingJsonField { field } => MetastoreErrorDetail {
                operation: "MissingJsonField".to_string(),
                message: format!("Missing required field: {}", field),
                stream_name: None,
                file_path: None,
                timestamp: Some(chrono::Utc::now()),
                metadata: [("field".to_string(), field.clone())].into_iter().collect(),
                status_code: 400,
            },
            MetastoreError::InvalidJsonValue { field, reason } => MetastoreErrorDetail {
                operation: "InvalidJsonValue".to_string(),
                message: format!("Invalid value for field '{}': {}", field, reason),
                stream_name: None,
                file_path: None,
                timestamp: Some(chrono::Utc::now()),
                metadata: [
                    ("field".to_string(), field.clone()),
                    ("reason".to_string(), reason.clone()),
                ]
                .into_iter()
                .collect(),
                status_code: 400,
            },
        }
    }

    pub fn status_code(&self) -> StatusCode {
        match self {
            MetastoreError::ObjectStorageError(..) => StatusCode::INTERNAL_SERVER_ERROR,
            MetastoreError::JsonParseError(..) => StatusCode::INTERNAL_SERVER_ERROR,
            MetastoreError::ManifestCodecError(..) => StatusCode::INTERNAL_SERVER_ERROR,
            MetastoreError::JsonSchemaError { .. } => StatusCode::INTERNAL_SERVER_ERROR,
            MetastoreError::InvalidJsonStructure { .. } => StatusCode::INTERNAL_SERVER_ERROR,
            MetastoreError::MissingJsonField { .. } => StatusCode::INTERNAL_SERVER_ERROR,
            MetastoreError::InvalidJsonValue { .. } => StatusCode::INTERNAL_SERVER_ERROR,
            MetastoreError::Error { status_code, .. } => *status_code,
        }
    }
}

#[cfg(test)]
mod boundary_tests {
    use std::path::Path;

    // Deliberately conservative: applications cannot issue any raw object PUT,
    // regardless of whether the key is a literal, a constant, or computed.
    // Provider adapters implement the primitives; only the metastore may use
    // them for metadata. The one multipart publisher uploads Parquet data.
    fn violations(path: &str, source: &str) -> Vec<String> {
        if matches!(
            path,
            "storage/s3.rs"
                | "storage/gcs.rs"
                | "storage/azure_blob.rs"
                | "storage/localfs.rs"
                | "metastore/metastores/object_store_metastore.rs"
        ) {
            return vec![];
        }
        let production = source.split("#[cfg(test)]").next().unwrap();
        let compact: String = production.chars().filter(|c| !c.is_whitespace()).collect();
        let mut errors = Vec::new();
        for operation in [
            ".put_object(",
            ".upload_file(",
            ".put_metadata_conditional(",
            ".delete_metadata_conditional(",
        ] {
            if compact.contains(operation) {
                errors.push(format!(
                    "{path}: raw {operation} must enter through Metastore"
                ));
            }
        }
        for (operation, allowed_path) in [
            (".delete_object(", "storage/object_storage.rs"),
            (".delete_prefix(", ""),
        ] {
            let count = compact.matches(operation).count();
            if count != usize::from(path == allowed_path) {
                errors.push(format!("{path}: unexpected raw {operation} ({count})"));
            }
        }
        let multipart = compact.matches(".upload_multipart(").count();
        let allowed = usize::from(path == "storage/object_storage.rs");
        if multipart != allowed {
            errors.push(format!(
                "{path}: unexpected multipart publisher ({multipart})"
            ));
        }
        errors
    }

    fn inspect(root: &Path, path: &Path, errors: &mut Vec<String>) {
        for entry in std::fs::read_dir(path).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                inspect(root, &path, errors);
            } else if path.extension().is_some_and(|ext| ext == "rs") {
                let relative = path.strip_prefix(root).unwrap().to_str().unwrap();
                errors.extend(violations(
                    relative,
                    &std::fs::read_to_string(&path).unwrap(),
                ));
            }
        }
    }

    #[test]
    fn metadata_writes_enter_through_metastore() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut errors = Vec::new();
        inspect(&root, &root, &mut errors);
        assert!(errors.is_empty(), "{}", errors.join("\n"));
    }

    #[test]
    fn guard_rejects_literal_and_computed_metadata_writes() {
        for source in [
            "store.put_object(stream_json_path(name, tenant), bytes, tenant).await",
            "store\n . put_object (path, bytes, tenant).await",
            "store.put_metadata_conditional(path, bytes, condition, tenant).await",
            "store.upload_file(key, local, tenant).await",
        ] {
            assert!(!violations("application.rs", source).is_empty());
        }
        assert!(
            violations(
                "application.rs",
                "#[cfg(test)] mod tests { store.put_object(path); }"
            )
            .is_empty()
        );
        assert!(
            violations(
                "metastore/metastores/object_store_metastore.rs",
                "store.put_object(path)"
            )
            .is_empty()
        );
    }
}
