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
                status_code: self.status_code().as_u16(),
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
            MetastoreError::ObjectStorageError(ObjectStorageError::MetastoreUnavailable(_)) => {
                StatusCode::SERVICE_UNAVAILABLE
            }
            MetastoreError::ObjectStorageError(ObjectStorageError::StreamDeleting) => {
                StatusCode::CONFLICT
            }
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
                | "metastore/metastores/document_metastore.rs"
                | "metastore/metastores/migration.rs"
                | "metastore/metastores/postgres_documents.rs"
                | "metastore/metastores/postgres_metastore.rs"
        ) {
            return vec![];
        }
        let tokens = production_tokens(source);
        let mut errors = Vec::new();
        let mut functions: Vec<(String, usize)> = Vec::new();
        let mut pending = None;
        let mut depth = 0usize;
        for (i, token) in tokens.iter().enumerate() {
            if token == "fn" {
                pending = tokens.get(i + 1).cloned();
            }
            if token == "{" {
                depth += 1;
                if let Some(name) = pending.take() {
                    functions.push((name, depth));
                }
            } else if token == "}" {
                if functions.last().is_some_and(|(_, d)| *d == depth) {
                    functions.pop();
                }
                depth = depth.saturating_sub(1);
            } else if token == ";" {
                pending = None;
            }
            let function = functions
                .last()
                .map(|(name, _)| name.as_str())
                .unwrap_or("<module>");
            if i > 0 && tokens[i - 1] == "fn" {
                continue;
            }
            if tokens.get(i + 1).map(String::as_str) != Some("(") {
                continue;
            }
            let allowed = path == "storage/object_storage.rs"
                && matches!(
                    (function, token.as_str()),
                    ("upload_single_parquet_file", "upload_multipart")
                        | ("upload_single_parquet_file", "delete_object")
                );
            if !allowed
                && matches!(
                    token.as_str(),
                    "put_object"
                        | "upload_file"
                        | "put_metadata_conditional"
                        | "delete_metadata_conditional"
                        | "delete_object"
                        | "delete_prefix"
                        | "upload_multipart"
                        | "put"
                        | "put_opts"
                        | "put_multipart"
                        | "put_multipart_opts"
                        | "delete"
                        | "delete_stream"
                )
            {
                // Generic raw object_store names need an explicit receiver/type hint;
                // otherwise ordinary HTTP delete handlers would be false positives.
                let generic = matches!(
                    token.as_str(),
                    "put"
                        | "put_opts"
                        | "put_multipart"
                        | "put_multipart_opts"
                        | "delete"
                        | "delete_stream"
                );
                let context = tokens[i.saturating_sub(5)..i].join("");
                if !generic || context.contains("object_store") || context.contains("ObjectStore::")
                {
                    errors.push(format!(
                        "{path}::{function}: raw {token} must enter through Metastore"
                    ));
                }
            }
        }
        errors
    }

    // Lexical policy, not Rust type/provenance analysis: aliases, wrappers,
    // generated macro bodies and unrecognised mutation APIs can evade this.
    // Allowed backend modules and the two named Parquet sites require review.
    fn production_tokens(source: &str) -> Vec<String> {
        // Skip comments and literals before token matching, retaining punctuation.
        let pattern = regex::Regex::new(r####"(?s)//[^\n]*|/\*|(?:br|cr|r)(\#*)"|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])'|[A-Za-z_][A-Za-z_0-9]*|[^\s]"####).unwrap();
        let mut tokens = Vec::new();
        let mut offset = 0;
        while let Some(m) = pattern.find(&source[offset..]) {
            let text = m.as_str();
            let start = offset + m.start();
            offset += m.end();
            if text == "/*" {
                let mut depth = 1;
                while offset < source.len() && depth > 0 {
                    if source[offset..].starts_with("/*") {
                        depth += 1;
                        offset += 2;
                    } else if source[offset..].starts_with("*/") {
                        depth -= 1;
                        offset += 2;
                    } else {
                        offset += source[offset..].chars().next().unwrap().len_utf8();
                    }
                }
            } else if (text.starts_with('r') || text.starts_with("br") || text.starts_with("cr"))
                && text.ends_with('"')
            {
                let closing = format!(
                    "\"{}",
                    "#".repeat(text.bytes().filter(|b| *b == b'#').count())
                );
                offset = source[offset..]
                    .find(&closing)
                    .map(|n| offset + n + closing.len())
                    .unwrap_or(source.len());
            } else if text.starts_with("//") || text.starts_with('"') || text.starts_with('\'') {
                // Literal content cannot contain a production call.
            } else {
                tokens.push(source[start..offset].to_owned());
            }
        }
        let mut production = Vec::new();
        let mut i = 0;
        while i < tokens.len() {
            let cfg = ["#", "[", "cfg", "(", "test", ")", "]", "mod"];
            if tokens[i..]
                .iter()
                .map(String::as_str)
                .take(cfg.len())
                .eq(cfg)
            {
                i += cfg.len();
                while i < tokens.len() && tokens[i] != "{" && tokens[i] != ";" {
                    i += 1;
                }
                if tokens.get(i).map(String::as_str) == Some(";") {
                    i += 1;
                    continue;
                }
                let mut depth = 0;
                while i < tokens.len() {
                    if tokens[i] == "{" {
                        depth += 1;
                    }
                    if tokens[i] == "}" {
                        depth -= 1;
                        if depth == 0 {
                            i += 1;
                            break;
                        }
                    }
                    i += 1;
                }
            } else {
                production.push(tokens[i].clone());
                i += 1;
            }
        }
        production
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
            "ObjectStorage::put_object(store, path, bytes, tenant)",
            "#[cfg(test)] mod tests; fn production() { store.put_object(path); }",
            "#[cfg(test)] mod tests {} fn production() { store.put_object(path); }",
            "object_store::ObjectStore::put(store, path, bytes)",
            "store\n . put_object (path, bytes, tenant).await",
            "store.put_metadata_conditional(path, bytes, condition, tenant).await",
            "store.upload_file(key, local, tenant).await",
        ] {
            assert!(!violations("application.rs", source).is_empty());
        }
        assert!(violations("application.rs", r###"fn ok() { let s = r#"store.put_object(path)"#; /* outer /* nested */ store.put_object(path) */ }"###).is_empty());
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
