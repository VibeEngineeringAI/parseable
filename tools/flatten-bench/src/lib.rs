//! Compiles the production JSON flattening sources twice, unmodified:
//!
//! - `current_json`: the working tree's `src/utils/json/mod.rs` (and its `flatten`/`strict`
//!   children), included by path.
//! - `baseline_json`: the same files at the baseline revision, extracted by `build.rs`.
//!
//! Both resolve `crate::parseable::PARSEABLE`, `crate::event::format::LogSource` and
//! `crate::metadata::SchemaVersion` to the stubs below, which mirror the server's types
//! and CLI defaults closely enough for the flattening paths and nothing more.

#![allow(dead_code, unused_imports, clippy::all)]

pub mod alloc_counter;
pub mod api;
pub mod fixtures;

#[path = "../../../src/utils/json/mod.rs"]
pub mod current_json;

include!(concat!(env!("OUT_DIR"), "/baseline_modules.rs"));

/// Revision and blob the baseline copy was extracted from.
pub const BASELINE_COMMIT: &str = env!("FLATTEN_BENCH_BASELINE_COMMIT");
pub const BASELINE_FLATTEN_BLOB: &str = env!("FLATTEN_BENCH_BASELINE_FLATTEN_BLOB");

/// Subset of `crate::cli` read by `src/utils/json`.
pub mod cli {
    pub const DEFAULT_MAX_FLATTEN_ROWS_PER_EVENT: usize = 1000;
    pub const DEFAULT_MAX_FLATTEN_ROWS_PER_REQUEST: usize = 10_000;
    pub const DEFAULT_MAX_FLATTEN_BYTES_PER_REQUEST: usize = 64 * 1024 * 1024;

    /// Fields of `crate::cli::Options` read by `src/utils/json`, with the CLI defaults.
    pub struct Options {
        pub event_flatten_level: usize,
        pub event_max_chunk_age: u64,
        pub max_flatten_rows_per_event: usize,
        pub max_flatten_rows_per_request: usize,
        pub max_flatten_bytes_per_request: usize,
    }
}

pub mod parseable {
    use crate::cli::*;

    pub struct Parseable {
        pub options: Options,
    }

    pub static PARSEABLE: Parseable = Parseable {
        options: Options {
            event_flatten_level: 10,
            event_max_chunk_age: 1,
            max_flatten_rows_per_event: DEFAULT_MAX_FLATTEN_ROWS_PER_EVENT,
            max_flatten_rows_per_request: DEFAULT_MAX_FLATTEN_ROWS_PER_REQUEST,
            max_flatten_bytes_per_request: DEFAULT_MAX_FLATTEN_BYTES_PER_REQUEST,
        },
    };
}

pub mod event {
    pub mod format {
        /// Mirror of `crate::event::format::LogSource` (serde attributes omitted).
        #[derive(Default, Debug, Clone, PartialEq, Eq, Hash)]
        pub enum LogSource {
            Kinesis,
            OtelLogs,
            OtelMetrics,
            OtelTraces,
            Pmeta,
            #[default]
            Json,
            Custom(String),
        }
    }
}

pub mod metadata {
    /// Mirror of `crate::metadata::SchemaVersion`.
    #[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
    #[non_exhaustive]
    pub enum SchemaVersion {
        #[default]
        V0,
        V1,
    }
}
