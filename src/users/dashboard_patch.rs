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

//! Pure, ID-addressed dashboard patching and structural configuration validation.
//!
//! Nothing here performs I/O, executes queries or probes datasets. Patches operate on the
//! stored wire document (`serde_json::Value`) so unknown and legacy fields survive untouched.
//! Layout semantics mirror `frontend/src/features/dashboards/layout.ts` and `sections.ts`.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value, json};
use ulid::Ulid;

use super::dashboards::Dashboard;

pub const MAX_OPERATIONS: usize = 256;
pub const MAX_DOCUMENT_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_TILES: usize = 500;
pub const MAX_SECTIONS: usize = 100;
pub const MAX_VARIABLES: usize = 100;
pub const MAX_POINTER_TOKENS: usize = 32;
pub const MAX_ID_BYTES: usize = 128;
pub const GRID_COLUMNS: i64 = 12;
pub const MAX_TILE_ROW: i64 = 100_000;
/// Editor/renderer bound for new or changed heights; taller legacy heights are grandfathered and
/// still occupy their full stored height during collision handling.
pub const MAX_TILE_HEIGHT: i64 = 24;
/// Server-internal storage metadata. It is never patchable and must be hidden from clients.
pub const INTERNAL_METADATA_KEY: &str = "_parseableDashboard";

const DEFAULT_TILE_W: i64 = 6;
const DEFAULT_TILE_H: i64 = 4;
/// Stands in for the frontend's `Infinity` height bound while keeping sums overflow-free.
const UNBOUNDED: i64 = i64::MAX / 4;

const SERVER_OWNED: &[&str] = &[
    "dashboardId",
    "author",
    "created",
    "modified",
    "version",
    "tenantId",
    "revision",
    INTERNAL_METADATA_KEY,
];
const ENTITY_COLLECTIONS: &[&str] = &["tiles", "sections", "variables"];
const TILE_TYPES: &[&str] = &["code", "builder", "promql"];
const CHART_TYPES: &[&str] = &[
    "timeseries",
    "line",
    "area",
    "bar",
    "table",
    "query-value",
    "pie",
    "donut",
    "gauge",
    "bubble",
];
const SERIES_STYLES: &[&str] = &["line", "bar", "area"];
const COLOUR_SCHEMES: &[&str] = &[
    "classic",
    "agentObservability",
    "parseableBlue",
    "blue",
    "teal",
    "green",
    "purple",
    "red",
    "orange",
    "yellow",
    "gray",
    "greenYellowRed",
    "redYellowGreen",
];
const LEGEND_POSITIONS: &[&str] = &["top", "bottom", "left", "right"];
const BAR_ORIENTATIONS: &[&str] = &["vertical", "horizontal"];
const QUERY_VALUE_THEMES: &[&str] = &[
    "blue", "brown", "emerald", "fuchsia", "grey", "orange", "pink", "purple", "red", "yellow",
];
const PERCENT_FILLS: &[&str] = &["horizontal", "vertical", "diagonal", "none"];
const QUERY_MODES: &[&str] = &["range", "instant", "both"];
const VARIABLE_TYPES: &[&str] = &["promql", "promql_query", "sql", "list", "text", "dataset"];
const LABEL_FILTER_OPERATORS: &[&str] = &["=", "!=", "=~", "!~"];
const TIME_RANGE_PRESETS: &[&str] = &["10m", "30m", "1h", "5h", "1d", "3d"];
const TIME_RANGE_TYPES: &[&str] = &["fixed", "custom"];
const REFRESH_INTERVALS: &[u64] = &[0, 15_000, 30_000, 60_000, 300_000];
const DASHBOARD_TYPES: &[&str] = &["Dashboard", "Report"];
/// Variable fields whose `$name` tokens are rewritten by `renameVariable`.
const VARIABLE_SOURCES: &[&str] = &["sqlQuery", "promqlQuery", "promqlQueryDataset", "dataset"];

/// Body of a dashboard PATCH request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DashboardPatchRequest {
    pub operations: Vec<DashboardOperation>,
    #[serde(default)]
    pub dry_run: bool,
    /// Expected stored revision. Opaque to the engine; the service compares it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<String>,
}

/// The entity a generic operation addresses. Paths are relative to the selected object.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum PatchTarget {
    Dashboard,
    Tile { id: String },
    Section { id: String },
    Variable { name: String },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "op",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum DashboardOperation {
    /// RFC 6902 `add` at an RFC 6901 pointer relative to `target`; an empty path adds the entity.
    Add {
        target: PatchTarget,
        #[serde(default)]
        path: String,
        value: Value,
    },
    /// RFC 6902 `replace`; the location must exist. An empty path replaces an entity's content
    /// while keeping its identity (and its layout when the value has none).
    Replace {
        target: PatchTarget,
        #[serde(default)]
        path: String,
        value: Value,
    },
    /// RFC 6902 `remove`; the location must exist. An empty path removes the entity.
    Remove {
        target: PatchTarget,
        #[serde(default)]
        path: String,
    },
    /// Move and/or resize a tile with the frontend's collision and compaction rules.
    /// `sectionId`: absent keeps the section, `null` or `""` unsections, a string moves.
    PlaceTile {
        tile_id: String,
        #[serde(
            default,
            deserialize_with = "double_option",
            skip_serializing_if = "Option::is_none"
        )]
        section_id: Option<Option<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        layout: Option<LayoutEdits>,
    },
    /// Rename a variable and rewrite `$from`/`${from}` references.
    RenameVariable { from: String, to: String },
    /// An exact permutation of the dashboard's addressable section ids.
    ReorderSections { section_ids: Vec<String> },
    /// Remove a section with an explicit disposition for its tiles.
    RemoveSection {
        section_id: String,
        tiles: TileDisposition,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LayoutEdits {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub x: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub y: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub w: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub h: Option<i64>,
}

impl LayoutEdits {
    fn is_empty(&self) -> bool {
        self.x.is_none() && self.y.is_none() && self.w.is_none() && self.h.is_none()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "mode",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum TileDisposition {
    /// Append the tiles below the unsectioned grid.
    Unsection,
    /// Delete the section's tiles.
    Delete,
    /// Append the tiles below another existing section's tiles.
    Move { section_id: String },
}

fn double_option<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(deserializer).map(Some)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PatchErrorCode {
    TooManyOperations,
    InvalidBase,
    InvalidTarget,
    TargetNotFound,
    AmbiguousTarget,
    TargetExists,
    InvalidPointer,
    PathNotFound,
    ProtectedPath,
    InvalidValue,
    InvalidOperation,
    NameConflict,
    LimitExceeded,
    DocumentTooLarge,
}

/// A rejected operation. No part of the batch applies.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchError {
    pub code: PatchErrorCode,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_index: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<PatchTarget>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

impl PatchError {
    fn new(code: PatchErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            operation_index: None,
            target: None,
            path: None,
        }
    }

    fn target(mut self, target: PatchTarget) -> Self {
        self.target = Some(target);
        self
    }

    fn path(mut self, path: impl Into<String>) -> Self {
        self.path = Some(path.into());
        self
    }

    fn locate(mut self, index: usize, operation: &DashboardOperation) -> Self {
        self.operation_index = Some(index);
        if self.target.is_none() {
            self.target = Some(operation_target(operation));
        }
        if self.path.is_none() {
            if let DashboardOperation::Add { path, .. }
            | DashboardOperation::Replace { path, .. }
            | DashboardOperation::Remove { path, .. } = operation
            {
                self.path = Some(path.clone());
            }
        }
        self
    }
}

impl std::fmt::Display for PatchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.operation_index {
            Some(index) => write!(f, "operation {index}: {}", self.message),
            None => f.write_str(&self.message),
        }
    }
}

impl std::error::Error for PatchError {}

fn operation_target(operation: &DashboardOperation) -> PatchTarget {
    match operation {
        DashboardOperation::Add { target, .. }
        | DashboardOperation::Replace { target, .. }
        | DashboardOperation::Remove { target, .. } => target.clone(),
        DashboardOperation::PlaceTile { tile_id, .. } => PatchTarget::Tile {
            id: tile_id.clone(),
        },
        DashboardOperation::RenameVariable { from, .. } => {
            PatchTarget::Variable { name: from.clone() }
        }
        DashboardOperation::ReorderSections { .. } => PatchTarget::Dashboard,
        DashboardOperation::RemoveSection { section_id, .. } => PatchTarget::Section {
            id: section_id.clone(),
        },
    }
}

/// A fresh tile id for tool layers that want the server to mint one. Never called while
/// applying a patch, so dry runs and applies of the same batch are identical.
pub fn generate_tile_id() -> String {
    Ulid::new().to_string()
}

/// Remove server-internal storage metadata before a document leaves the server.
pub fn strip_internal_metadata(document: &mut Value) {
    if let Some(root) = document.as_object_mut() {
        root.remove(INTERNAL_METADATA_KEY);
    }
}

/// Apply every operation to a copy of `base`, or none of them. Final-state validation is
/// separate: callers must run [`validate_dashboard`] on the result before persisting it.
pub fn apply_patch(base: &Value, operations: &[DashboardOperation]) -> Result<Value, PatchError> {
    if operations.len() > MAX_OPERATIONS {
        return Err(PatchError::new(
            PatchErrorCode::TooManyOperations,
            format!("a patch may contain at most {MAX_OPERATIONS} operations"),
        ));
    }
    if !base.is_object() {
        return Err(PatchError::new(
            PatchErrorCode::InvalidBase,
            "the stored dashboard is not a JSON object",
        ));
    }
    let mut document = base.clone();
    for (index, operation) in operations.iter().enumerate() {
        apply_operation(&mut document, operation)
            .map_err(|error| error.locate(index, operation))?;
    }
    check_growth(base, &document)?;
    Ok(document)
}

fn check_growth(base: &Value, candidate: &Value) -> Result<(), PatchError> {
    let count = |document: &Value, key: &str| {
        document
            .get(key)
            .and_then(Value::as_array)
            .map_or(0, Vec::len)
    };
    for (key, limit) in [
        ("tiles", MAX_TILES),
        ("sections", MAX_SECTIONS),
        ("variables", MAX_VARIABLES),
    ] {
        let after = count(candidate, key);
        if after > limit && after > count(base, key) {
            return Err(PatchError::new(
                PatchErrorCode::LimitExceeded,
                format!("a dashboard may contain at most {limit} {key}"),
            )
            .target(PatchTarget::Dashboard)
            .path(format!("/{key}")));
        }
    }
    let size = json_len(candidate);
    if size > MAX_DOCUMENT_BYTES && size > json_len(base) {
        return Err(PatchError::new(
            PatchErrorCode::DocumentTooLarge,
            format!("the patched dashboard would exceed {MAX_DOCUMENT_BYTES} bytes"),
        )
        .target(PatchTarget::Dashboard));
    }
    Ok(())
}

fn json_len(value: &Value) -> usize {
    struct Counter(usize);
    impl std::io::Write for Counter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0 += bytes.len();
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut counter = Counter(0);
    // Serializing a Value into an infallible writer cannot fail.
    let _ = serde_json::to_writer(&mut counter, value);
    counter.0
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Edit {
    Add,
    Replace,
    Remove,
}

fn apply_operation(document: &mut Value, operation: &DashboardOperation) -> Result<(), PatchError> {
    match operation {
        DashboardOperation::Add {
            target,
            path,
            value,
        } => apply_generic(document, Edit::Add, target, path, Some(value)),
        DashboardOperation::Replace {
            target,
            path,
            value,
        } => apply_generic(document, Edit::Replace, target, path, Some(value)),
        DashboardOperation::Remove { target, path } => {
            apply_generic(document, Edit::Remove, target, path, None)
        }
        DashboardOperation::PlaceTile {
            tile_id,
            section_id,
            layout,
        } => place_tile(document, tile_id, section_id.as_ref(), layout.as_ref()),
        DashboardOperation::RenameVariable { from, to } => rename_variable(document, from, to),
        DashboardOperation::ReorderSections { section_ids } => {
            reorder_sections(document, section_ids)
        }
        DashboardOperation::RemoveSection { section_id, tiles } => {
            remove_section(document, section_id, tiles)
        }
    }
}

fn root_mut(document: &mut Value) -> Result<&mut Map<String, Value>, PatchError> {
    document.as_object_mut().ok_or_else(|| {
        PatchError::new(
            PatchErrorCode::InvalidBase,
            "the stored dashboard is not a JSON object",
        )
    })
}

// ---------------------------------------------------------------------------------------------
// JSON Pointer
// ---------------------------------------------------------------------------------------------

fn parse_pointer(path: &str) -> Result<Vec<String>, PatchError> {
    if path.is_empty() {
        return Ok(Vec::new());
    }
    let Some(rest) = path.strip_prefix('/') else {
        return Err(PatchError::new(
            PatchErrorCode::InvalidPointer,
            "a path must be empty or a JSON Pointer starting with '/'",
        ));
    };
    let mut tokens = Vec::new();
    for raw in rest.split('/') {
        if tokens.len() == MAX_POINTER_TOKENS {
            return Err(PatchError::new(
                PatchErrorCode::InvalidPointer,
                format!("a path may have at most {MAX_POINTER_TOKENS} segments"),
            ));
        }
        let mut token = String::with_capacity(raw.len());
        let mut chars = raw.chars();
        while let Some(c) = chars.next() {
            if c != '~' {
                token.push(c);
                continue;
            }
            match chars.next() {
                Some('0') => token.push('~'),
                Some('1') => token.push('/'),
                _ => {
                    return Err(PatchError::new(
                        PatchErrorCode::InvalidPointer,
                        "'~' in a JSON Pointer must be followed by '0' or '1'",
                    ));
                }
            }
        }
        tokens.push(token);
    }
    Ok(tokens)
}

fn escape_token(token: &str) -> String {
    token.replace('~', "~0").replace('/', "~1")
}

fn join(prefix: &str, key: &str) -> String {
    format!("{prefix}/{}", escape_token(key))
}

/// Case-, underscore- and hyphen-insensitive key, so `tenant_id` or `TileId` cannot slip past
/// a protected name.
fn fold(key: &str) -> String {
    key.chars()
        .filter(|c| *c != '_' && *c != '-')
        .flat_map(char::to_lowercase)
        .collect()
}

fn array_index(token: &str) -> Option<usize> {
    let valid = !token.is_empty()
        && token.bytes().all(|b| b.is_ascii_digit())
        && (token == "0" || !token.starts_with('0'));
    if valid { token.parse().ok() } else { None }
}

fn path_not_found(message: impl Into<String>) -> PatchError {
    PatchError::new(PatchErrorCode::PathNotFound, message)
}

fn apply_pointer(
    root: &mut Value,
    tokens: &[String],
    edit: Edit,
    value: Option<&Value>,
) -> Result<(), PatchError> {
    let Some((last, parents)) = tokens.split_last() else {
        return Err(PatchError::new(
            PatchErrorCode::InvalidPointer,
            "an empty path is not valid here",
        ));
    };
    let mut current = root;
    for token in parents {
        current = match current {
            Value::Object(map) => map.get_mut(token.as_str()),
            Value::Array(items) => array_index(token).and_then(|index| items.get_mut(index)),
            _ => None,
        }
        .ok_or_else(|| path_not_found(format!("`{token}` does not exist")))?;
    }
    let value = || value.cloned().unwrap_or(Value::Null);
    match current {
        Value::Object(map) => match edit {
            Edit::Add => {
                map.insert(last.clone(), value());
            }
            Edit::Replace => match map.get_mut(last.as_str()) {
                Some(slot) => *slot = value(),
                None => return Err(path_not_found(format!("`{last}` does not exist"))),
            },
            Edit::Remove => {
                if map.remove(last.as_str()).is_none() {
                    return Err(path_not_found(format!("`{last}` does not exist")));
                }
            }
        },
        Value::Array(items) => {
            let len = items.len();
            let index = if edit == Edit::Add && last == "-" {
                Some(len)
            } else {
                array_index(last)
                    .filter(|index| *index < len || (edit == Edit::Add && *index == len))
            };
            let Some(index) = index else {
                return Err(path_not_found(format!(
                    "array index `{last}` is out of bounds"
                )));
            };
            match edit {
                Edit::Add => items.insert(index, value()),
                Edit::Replace => items[index] = value(),
                Edit::Remove => {
                    items.remove(index);
                }
            }
        }
        _ => {
            return Err(path_not_found(
                "the parent of the final path segment is not an object or array",
            ));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Entity lookup
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Copy)]
enum Slot {
    Absent,
    Null,
    Present,
}

fn take_array(root: &mut Map<String, Value>, key: &str) -> Result<(Vec<Value>, Slot), PatchError> {
    match root.get_mut(key) {
        None => Ok((Vec::new(), Slot::Absent)),
        Some(Value::Null) => Ok((Vec::new(), Slot::Null)),
        Some(Value::Array(items)) => Ok((std::mem::take(items), Slot::Present)),
        Some(_) => Err(PatchError::new(
            PatchErrorCode::InvalidBase,
            format!("`{key}` is not an array"),
        )
        .target(PatchTarget::Dashboard)
        .path(format!("/{key}"))),
    }
}

fn restore_array(root: &mut Map<String, Value>, key: &str, items: Vec<Value>, slot: Slot) {
    match slot {
        Slot::Present => {
            if let Some(stored) = root.get_mut(key) {
                *stored = Value::Array(items);
            }
        }
        Slot::Null | Slot::Absent if !items.is_empty() => {
            root.insert(key.to_owned(), Value::Array(items));
        }
        Slot::Null | Slot::Absent => {}
    }
}

/// Runs `f` with the tiles taken out of the document and the sections borrowed from it.
fn with_tiles<R>(
    root: &mut Map<String, Value>,
    f: impl FnOnce(&mut Vec<Value>, &[Value]) -> Result<R, PatchError>,
) -> Result<R, PatchError> {
    let (mut tiles, slot) = take_array(root, "tiles")?;
    let sections: &[Value] = root
        .get("sections")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let result = f(&mut tiles, sections);
    restore_array(root, "tiles", tiles, slot);
    result
}

fn array_mut<'a>(
    root: &'a mut Map<String, Value>,
    key: &str,
) -> Result<&'a mut Vec<Value>, PatchError> {
    match root.get_mut(key) {
        Some(Value::Array(items)) => Ok(items),
        _ => Err(PatchError::new(
            PatchErrorCode::TargetNotFound,
            format!("the dashboard has no {key}"),
        )),
    }
}

fn unique_position(
    mut positions: impl Iterator<Item = usize>,
    describe: impl FnOnce() -> String,
) -> Result<Option<usize>, PatchError> {
    let first = positions.next();
    if first.is_some() && positions.next().is_some() {
        return Err(PatchError::new(
            PatchErrorCode::AmbiguousTarget,
            format!("{} matches more than one stored entry", describe()),
        ));
    }
    Ok(first)
}

fn tile_ulid(tile: &Value) -> Option<Ulid> {
    tile.get("tile_id")?
        .as_str()
        .and_then(|id| Ulid::from_string(id).ok())
}

fn tile_target(id: &str) -> Result<Ulid, PatchError> {
    let ulid = Ulid::from_string(id).map_err(|_| {
        PatchError::new(
            PatchErrorCode::InvalidTarget,
            format!("tile id `{id}` is not a valid ULID"),
        )
    })?;
    if ulid.is_nil() {
        return Err(PatchError::new(
            PatchErrorCode::InvalidTarget,
            "the nil ULID cannot identify a tile",
        ));
    }
    Ok(ulid)
}

fn find_tile(tiles: &[Value], id: Ulid) -> Result<Option<usize>, PatchError> {
    unique_position(
        tiles
            .iter()
            .enumerate()
            .filter(|(_, tile)| tile_ulid(tile) == Some(id))
            .map(|(index, _)| index),
        || format!("tile `{id}`"),
    )
}

fn require_tile(tiles: &[Value], id: Ulid) -> Result<usize, PatchError> {
    find_tile(tiles, id)?.ok_or_else(|| {
        PatchError::new(
            PatchErrorCode::TargetNotFound,
            format!("tile `{id}` does not exist"),
        )
    })
}

fn section_id(section: &Value) -> Option<&str> {
    section
        .get("sectionId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
}

fn section_target(id: &str) -> Result<(), PatchError> {
    if id.is_empty() || id.len() > MAX_ID_BYTES {
        return Err(PatchError::new(
            PatchErrorCode::InvalidTarget,
            format!("a section id must be 1 to {MAX_ID_BYTES} bytes"),
        ));
    }
    Ok(())
}

fn find_section(sections: &[Value], id: &str) -> Result<Option<usize>, PatchError> {
    unique_position(
        sections
            .iter()
            .enumerate()
            .filter(|(_, section)| section_id(section) == Some(id))
            .map(|(index, _)| index),
        || format!("section `{id}`"),
    )
}

fn has_section(sections: &[Value], id: &str) -> bool {
    sections
        .iter()
        .any(|section| section_id(section) == Some(id))
}

fn is_variable_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_ID_BYTES
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

fn variable_name(variable: &Value) -> Option<&str> {
    variable.get("name").and_then(Value::as_str)
}

fn variable_target(name: &str) -> Result<(), PatchError> {
    if !is_variable_name(name) {
        return Err(PatchError::new(
            PatchErrorCode::InvalidTarget,
            format!("variable name `{name}` must match ^\\w+$ (at most {MAX_ID_BYTES} bytes)"),
        ));
    }
    Ok(())
}

fn find_variable(variables: &[Value], name: &str) -> Result<Option<usize>, PatchError> {
    unique_position(
        variables
            .iter()
            .enumerate()
            .filter(|(_, variable)| variable_name(variable) == Some(name))
            .map(|(index, _)| index),
        || format!("variable `{name}`"),
    )
}

fn protected(message: impl Into<String>) -> PatchError {
    PatchError::new(PatchErrorCode::ProtectedPath, message)
}

fn guard_identity(token: &str, identity: &str) -> Result<(), PatchError> {
    if fold(token) == fold(identity) {
        return Err(protected(format!(
            "`{identity}` identifies the entity and cannot be patched"
        )));
    }
    Ok(())
}

/// An added or replacing entity value: an object whose identity, if present, matches the target.
fn entity_value(
    value: Option<&Value>,
    identity: &str,
    matches: impl Fn(&Value) -> bool,
    canonical: &str,
) -> Result<Map<String, Value>, PatchError> {
    let Some(Value::Object(map)) = value else {
        return Err(PatchError::new(
            PatchErrorCode::InvalidValue,
            "an entity value must be a JSON object",
        ));
    };
    for (key, field) in map {
        if fold(key) == fold(identity) && (key != identity || !matches(field)) {
            return Err(PatchError::new(
                PatchErrorCode::InvalidValue,
                format!("`{key}` in the value conflicts with the target identity"),
            ));
        }
    }
    let mut map = map.clone();
    map.insert(identity.to_owned(), Value::String(canonical.to_owned()));
    Ok(map)
}

fn not_found(what: String) -> PatchError {
    PatchError::new(
        PatchErrorCode::TargetNotFound,
        format!("{what} does not exist"),
    )
}

fn exists(what: String) -> PatchError {
    PatchError::new(
        PatchErrorCode::TargetExists,
        format!("{what} already exists"),
    )
}

// ---------------------------------------------------------------------------------------------
// Generic add / replace / remove
// ---------------------------------------------------------------------------------------------

fn apply_generic(
    document: &mut Value,
    edit: Edit,
    target: &PatchTarget,
    path: &str,
    value: Option<&Value>,
) -> Result<(), PatchError> {
    let tokens = parse_pointer(path)?;
    match target {
        PatchTarget::Dashboard => {
            let Some(first) = tokens.first() else {
                return Err(protected(
                    "the dashboard root cannot be added, replaced or removed; address fields or entities",
                ));
            };
            let folded = fold(first);
            if SERVER_OWNED.iter().any(|key| fold(key) == folded) {
                return Err(protected(format!("`{first}` is server-owned")));
            }
            if ENTITY_COLLECTIONS.iter().any(|key| fold(key) == folded) {
                return Err(protected(format!(
                    "`{first}` entries must be addressed with tile, section or variable targets"
                )));
            }
            apply_pointer(document, &tokens, edit, value)
        }
        PatchTarget::Tile { id } => {
            let id = tile_target(id)?;
            let root = root_mut(document)?;
            if tokens.is_empty() {
                return tile_entity(root, edit, id, value);
            }
            guard_identity(&tokens[0], "tile_id")?;
            let tiles = array_mut(root, "tiles")?;
            let index = require_tile(tiles, id)?;
            apply_pointer(&mut tiles[index], &tokens, edit, value)
        }
        PatchTarget::Section { id } => {
            section_target(id)?;
            let root = root_mut(document)?;
            if tokens.is_empty() {
                return section_entity(root, edit, id, value);
            }
            guard_identity(&tokens[0], "sectionId")?;
            let sections = array_mut(root, "sections")?;
            let index =
                find_section(sections, id)?.ok_or_else(|| not_found(format!("section `{id}`")))?;
            apply_pointer(&mut sections[index], &tokens, edit, value)
        }
        PatchTarget::Variable { name } => {
            variable_target(name)?;
            let root = root_mut(document)?;
            if tokens.is_empty() {
                return variable_entity(root, edit, name, value);
            }
            guard_identity(&tokens[0], "name")?;
            let variables = array_mut(root, "variables")?;
            let index = find_variable(variables, name)?
                .ok_or_else(|| not_found(format!("variable `{name}`")))?;
            apply_pointer(&mut variables[index], &tokens, edit, value)
        }
    }
}

/// Tile add/remove follow the frontend's applyTile/removeTile: the affected section compacts.
fn tile_entity(
    root: &mut Map<String, Value>,
    edit: Edit,
    id: Ulid,
    value: Option<&Value>,
) -> Result<(), PatchError> {
    let canonical = id.to_string();
    let matches =
        |field: &Value| field.as_str().and_then(|s| Ulid::from_string(s).ok()) == Some(id);
    with_tiles(root, |tiles, sections| {
        let found = find_tile(tiles, id)?;
        match edit {
            Edit::Add => {
                if found.is_some() {
                    return Err(exists(format!("tile `{id}`")));
                }
                let mut tile = Value::Object(entity_value(value, "tile_id", matches, &canonical)?);
                fill_new_layout(tiles, sections, &mut tile);
                tiles.push(tile);
                let added = tiles.len() - 1;
                compact_section(tiles, sections, added);
            }
            Edit::Replace => {
                let index = found.ok_or_else(|| not_found(format!("tile `{id}`")))?;
                let mut tile = entity_value(value, "tile_id", matches, &canonical)?;
                if !tile.contains_key("layout") {
                    if let Some(layout) = tiles[index].get("layout") {
                        tile.insert("layout".to_owned(), layout.clone());
                    }
                }
                tiles[index] = Value::Object(tile);
            }
            Edit::Remove => {
                let index = found.ok_or_else(|| not_found(format!("tile `{id}`")))?;
                let groups = section_groups(tiles, sections);
                let neighbour = members_of(&groups, index)
                    .iter()
                    .copied()
                    .find(|member| *member != index);
                tiles.remove(index);
                if let Some(neighbour) = neighbour {
                    let neighbour = if neighbour > index {
                        neighbour - 1
                    } else {
                        neighbour
                    };
                    compact_section(tiles, sections, neighbour);
                }
            }
        }
        Ok(())
    })
}

/// Missing layout fields get the frontend's newTile/appendLayout defaults.
fn fill_new_layout(tiles: &[Value], sections: &[Value], tile: &mut Value) {
    let section = tile
        .get("sectionId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    let Some(tile) = tile.as_object_mut() else {
        return;
    };
    let layout = tile
        .entry("layout")
        .or_insert_with(|| Value::Object(Map::new()));
    let Value::Object(layout) = layout else {
        return;
    };
    let missing =
        |layout: &Map<String, Value>, key: &str| layout.get(key).is_none_or(Value::is_null);
    if missing(layout, "w") {
        layout.insert("w".to_owned(), DEFAULT_TILE_W.into());
    }
    if missing(layout, "h") {
        layout.insert("h".to_owned(), DEFAULT_TILE_H.into());
    }
    if missing(layout, "x") {
        layout.insert("x".to_owned(), 0.into());
    }
    if missing(layout, "y") {
        let groups = section_groups(tiles, sections);
        let peers = &group_for(&groups, &section).members;
        layout.insert("y".to_owned(), append_y(tiles, peers).into());
    }
}

fn section_entity(
    root: &mut Map<String, Value>,
    edit: Edit,
    id: &str,
    value: Option<&Value>,
) -> Result<(), PatchError> {
    if edit == Edit::Remove {
        let referenced = root
            .get("tiles")
            .and_then(Value::as_array)
            .map_or(0, |tiles| {
                tiles
                    .iter()
                    .filter(|tile| tile.get("sectionId").and_then(Value::as_str) == Some(id))
                    .count()
            });
        if referenced > 0 {
            return Err(PatchError::new(
                PatchErrorCode::InvalidOperation,
                format!(
                    "section `{id}` contains {referenced} tiles; use removeSection with an explicit tile disposition"
                ),
            ));
        }
    }
    let (mut sections, slot) = take_array(root, "sections")?;
    let result = (|| {
        let found = find_section(&sections, id)?;
        let matches = |field: &Value| field.as_str() == Some(id);
        match edit {
            Edit::Add => {
                if found.is_some() {
                    return Err(exists(format!("section `{id}`")));
                }
                sections.push(Value::Object(entity_value(
                    value,
                    "sectionId",
                    matches,
                    id,
                )?));
            }
            Edit::Replace => {
                let index = found.ok_or_else(|| not_found(format!("section `{id}`")))?;
                sections[index] = Value::Object(entity_value(value, "sectionId", matches, id)?);
            }
            Edit::Remove => {
                let index = found.ok_or_else(|| not_found(format!("section `{id}`")))?;
                sections.remove(index);
            }
        }
        Ok(())
    })();
    restore_array(root, "sections", sections, slot);
    result
}

fn variable_entity(
    root: &mut Map<String, Value>,
    edit: Edit,
    name: &str,
    value: Option<&Value>,
) -> Result<(), PatchError> {
    let (mut variables, slot) = take_array(root, "variables")?;
    let result = (|| {
        let found = find_variable(&variables, name)?;
        let matches = |field: &Value| field.as_str() == Some(name);
        match edit {
            Edit::Add => {
                if found.is_some() {
                    return Err(exists(format!("variable `{name}`")));
                }
                variables.push(Value::Object(entity_value(value, "name", matches, name)?));
            }
            Edit::Replace => {
                let index = found.ok_or_else(|| not_found(format!("variable `{name}`")))?;
                variables[index] = Value::Object(entity_value(value, "name", matches, name)?);
            }
            Edit::Remove => {
                let index = found.ok_or_else(|| not_found(format!("variable `{name}`")))?;
                variables.remove(index);
            }
        }
        Ok(())
    })();
    restore_array(root, "variables", variables, slot);
    result
}

// ---------------------------------------------------------------------------------------------
// Layout (ports of frontend layout.ts; positions are indices into the tiles array)
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Rect {
    x: i64,
    y: i64,
    w: i64,
    h: i64,
}

impl Rect {
    fn overlaps(&self, other: &Rect) -> bool {
        self.x < other.x + other.w
            && self.x + self.w > other.x
            && self.y < other.y + other.h
            && self.y + self.h > other.y
    }
}

#[derive(Debug, Clone, Copy, Default)]
struct RawLayout {
    x: Option<f64>,
    y: Option<f64>,
    w: Option<f64>,
    h: Option<f64>,
}

impl RawLayout {
    fn of(tile: &Value) -> Self {
        let number = |key: &str| layout_number(tile, key);
        Self {
            x: number("x"),
            y: number("y"),
            w: number("w"),
            h: number("h"),
        }
    }

    fn from_rect(rect: Rect) -> Self {
        Self {
            x: Some(rect.x as f64),
            y: Some(rect.y as f64),
            w: Some(rect.w as f64),
            h: Some(rect.h as f64),
        }
    }
}

fn layout_number(tile: &Value, key: &str) -> Option<f64> {
    tile.get("layout")?.get(key)?.as_f64()
}

/// The frontend's `integer`: floor, then clamp; non-numbers take the fallback.
fn clamp_int(value: Option<f64>, fallback: i64, min: i64, max: i64) -> i64 {
    match value {
        Some(value) => value.floor().max(min as f64).min(max as f64) as i64,
        None => fallback,
    }
}

fn resolved(items: &[(usize, RawLayout)]) -> Vec<(usize, Rect)> {
    let mut bottom = items
        .iter()
        .filter_map(|(_, layout)| {
            layout.y.map(|y| {
                clamp_int(Some(y), 0, 0, MAX_TILE_ROW).saturating_add(clamp_int(
                    layout.h,
                    DEFAULT_TILE_H,
                    1,
                    UNBOUNDED,
                ))
            })
        })
        .fold(0, i64::max);
    let mut rows: Vec<(usize, Rect)> = items
        .iter()
        .map(|&(index, layout)| {
            let w = clamp_int(layout.w, DEFAULT_TILE_W, 1, GRID_COLUMNS);
            let h = clamp_int(layout.h, DEFAULT_TILE_H, 1, UNBOUNDED);
            let y = match layout.y {
                Some(y) => clamp_int(Some(y), 0, 0, MAX_TILE_ROW),
                None => {
                    let y = bottom;
                    bottom = bottom.saturating_add(h);
                    y
                }
            };
            let x = clamp_int(layout.x, 0, 0, GRID_COLUMNS - w);
            (index, Rect { x, y, w, h })
        })
        .collect();
    rows.sort_by_key(|(_, rect)| (rect.y, rect.x));
    rows
}

/// RGL vertical compaction: push collisions down in reading order, then raise each item until
/// it touches a blocker.
fn compact(items: &[(usize, RawLayout)]) -> Vec<(usize, Rect)> {
    let mut placed: Vec<(usize, Rect)> = Vec::with_capacity(items.len());
    for (index, mut rect) in resolved(items) {
        while let Some(&(_, blocker)) = placed.iter().find(|(_, other)| rect.overlaps(other)) {
            rect.y = blocker.y + blocker.h;
        }
        rect.y = placed.iter().fold(0, |y, (_, other)| {
            if other.y + other.h <= rect.y
                && rect.x < other.x + other.w
                && rect.x + rect.w > other.x
            {
                y.max(other.y + other.h)
            } else {
                y
            }
        });
        placed.push((index, rect));
    }
    placed.sort_by_key(|(_, rect)| (rect.y, rect.x));
    placed
}

struct Group {
    id: String,
    members: Vec<usize>,
}

/// Classic grouping: the unsectioned grid (id "") first, then each first-seen section id;
/// tiles naming an unknown section join the unsectioned grid.
fn section_groups(tiles: &[Value], sections: &[Value]) -> Vec<Group> {
    let mut groups = vec![Group {
        id: String::new(),
        members: Vec::new(),
    }];
    let mut by_id: HashMap<&str, usize> = HashMap::new();
    for id in sections.iter().filter_map(section_id) {
        if !by_id.contains_key(id) {
            by_id.insert(id, groups.len());
            groups.push(Group {
                id: id.to_owned(),
                members: Vec::new(),
            });
        }
    }
    for (index, tile) in tiles.iter().enumerate() {
        let group = tile
            .get("sectionId")
            .and_then(Value::as_str)
            .and_then(|id| by_id.get(id).copied())
            .unwrap_or(0);
        groups[group].members.push(index);
    }
    groups
}

fn members_of(groups: &[Group], index: usize) -> &[usize] {
    groups
        .iter()
        .find(|group| group.members.contains(&index))
        .map_or(&[], |group| group.members.as_slice())
}

fn group_for<'a>(groups: &'a [Group], id: &str) -> &'a Group {
    groups
        .iter()
        .skip(1)
        .find(|group| group.id == id)
        .unwrap_or(&groups[0])
}

fn layout_items(tiles: &[Value], members: &[usize]) -> Vec<(usize, RawLayout)> {
    members
        .iter()
        .map(|&index| (index, RawLayout::of(&tiles[index])))
        .collect()
}

fn append_y(tiles: &[Value], members: &[usize]) -> i64 {
    resolved(&layout_items(tiles, members))
        .iter()
        .map(|(_, rect)| rect.y.saturating_add(rect.h))
        .max()
        .unwrap_or(0)
}

fn set_layout(tile: &mut Value, fields: impl IntoIterator<Item = (&'static str, Value)>) {
    let Some(tile) = tile.as_object_mut() else {
        return;
    };
    let layout = tile.entry("layout").or_insert(Value::Null);
    if !layout.is_object() {
        *layout = Value::Object(Map::new());
    }
    if let Value::Object(layout) = layout {
        for (key, value) in fields {
            layout.insert(key.to_owned(), value);
        }
    }
}

fn set_section_id(tile: &mut Value, section: Option<&str>) {
    if let Some(tile) = tile.as_object_mut() {
        match section {
            Some(id) => {
                tile.insert("sectionId".to_owned(), Value::String(id.to_owned()));
            }
            None => {
                tile.remove("sectionId");
            }
        }
    }
}

/// Compaction changes rows only; untouched columns, sizes and extras are never normalized.
fn write_positions(tiles: &mut [Value], positions: &[(usize, Rect)]) {
    for &(index, rect) in positions {
        if layout_number(&tiles[index], "y") != Some(rect.y as f64) {
            set_layout(&mut tiles[index], [("y", Value::from(rect.y))]);
        }
    }
}

fn compact_section(tiles: &mut [Value], sections: &[Value], index: usize) {
    let groups = section_groups(tiles, sections);
    let positions = compact(&layout_items(tiles, members_of(&groups, index)));
    write_positions(tiles, &positions);
}

fn check_range(key: &str, value: Option<i64>, min: i64, max: i64) -> Result<(), PatchError> {
    match value {
        Some(value) if value < min || value > max => Err(PatchError::new(
            PatchErrorCode::InvalidValue,
            format!("layout `{key}` must be between {min} and {max}"),
        )
        .path(format!("/layout/{key}"))),
        _ => Ok(()),
    }
}

/// Port of updateTileLayout within the tile's section: the edited tile takes priority at its
/// destination, collisions move down and the result compacts.
fn update_tile_layout(
    tiles: &mut [Value],
    sections: &[Value],
    index: usize,
    edits: &LayoutEdits,
) -> Result<(), PatchError> {
    let groups = section_groups(tiles, sections);
    let members = members_of(&groups, index).to_vec();
    let items = layout_items(tiles, &members);
    let active = compact(&items)
        .into_iter()
        .find(|(member, _)| *member == index)
        .map(|(_, rect)| rect)
        .unwrap_or(Rect {
            x: 0,
            y: 0,
            w: DEFAULT_TILE_W,
            h: DEFAULT_TILE_H,
        });
    check_range("w", edits.w, 1, GRID_COLUMNS)?;
    check_range("h", edits.h, 1, MAX_TILE_HEIGHT)?;
    check_range("y", edits.y, 0, MAX_TILE_ROW)?;
    let w = edits.w.unwrap_or(active.w);
    check_range("x", edits.x, 0, GRID_COLUMNS - w)?;
    let target = Rect {
        x: edits.x.unwrap_or(active.x.min(GRID_COLUMNS - w)),
        y: edits.y.unwrap_or(active.y),
        w,
        h: edits.h.unwrap_or(active.h),
    };
    let differs = |edit: Option<i64>, current: i64| matches!(edit, Some(value) if value != current);
    // A zero-distance gesture must not normalize the document.
    if !(differs(edits.x, active.x)
        || differs(edits.y, active.y)
        || differs(edits.w, active.w)
        || differs(edits.h, active.h))
    {
        return Ok(());
    }
    let mut placed = vec![(index, target)];
    let others: Vec<(usize, RawLayout)> = items
        .iter()
        .copied()
        .filter(|(member, _)| *member != index)
        .collect();
    for (member, mut rect) in compact(&others) {
        while let Some(&(_, blocker)) = placed.iter().find(|(_, other)| rect.overlaps(other)) {
            rect.y = blocker.y + blocker.h;
        }
        placed.push((member, rect));
    }
    let normalized: HashMap<usize, Rect> = compact(
        &placed
            .iter()
            .map(|&(member, rect)| (member, RawLayout::from_rect(rect)))
            .collect::<Vec<_>>(),
    )
    .into_iter()
    .collect();
    for &member in &members {
        let rect = normalized[&member];
        if member != index {
            if layout_number(&tiles[member], "y") != Some(rect.y as f64) {
                set_layout(&mut tiles[member], [("y", Value::from(rect.y))]);
            }
            continue;
        }
        let mut patch = vec![("y", Value::from(rect.y))];
        if edits.x.is_some() || (edits.w.is_some() && target.x != active.x) {
            patch.push(("x", Value::from(rect.x)));
        }
        if edits.w.is_some() {
            patch.push(("w", Value::from(rect.w)));
        }
        if edits.h.is_some() {
            patch.push(("h", Value::from(rect.h)));
        }
        set_layout(&mut tiles[member], patch);
    }
    Ok(())
}

/// Port of relocateTile plus applyTile's compaction of the section the tile left.
fn relocate_tile(tiles: &mut [Value], sections: &[Value], index: usize, destination: Option<&str>) {
    let neighbour = {
        let groups = section_groups(tiles, sections);
        members_of(&groups, index)
            .iter()
            .copied()
            .find(|member| *member != index)
    };
    set_section_id(&mut tiles[index], destination);
    let groups = section_groups(tiles, sections);
    let peers: Vec<usize> = group_for(&groups, destination.unwrap_or(""))
        .members
        .iter()
        .copied()
        .filter(|member| *member != index)
        .collect();
    let y = append_y(tiles, &peers);
    let stored = |key: &str, fallback: i64| {
        tiles[index]
            .get("layout")
            .and_then(|layout| layout.get(key))
            .filter(|value| !value.is_null())
            .cloned()
            .unwrap_or_else(|| fallback.into())
    };
    let (w, h) = (stored("w", DEFAULT_TILE_W), stored("h", DEFAULT_TILE_H));
    set_layout(
        &mut tiles[index],
        [
            ("x", Value::from(0)),
            ("y", Value::from(y)),
            ("w", w),
            ("h", h),
        ],
    );
    compact_section(tiles, sections, index);
    if let Some(neighbour) = neighbour {
        compact_section(tiles, sections, neighbour);
    }
}

fn place_tile(
    document: &mut Value,
    tile_id: &str,
    section: Option<&Option<String>>,
    edits: Option<&LayoutEdits>,
) -> Result<(), PatchError> {
    let id = tile_target(tile_id)?;
    let root = root_mut(document)?;
    with_tiles(root, |tiles, sections| {
        let index = require_tile(tiles, id)?;
        let mut relocated = false;
        if let Some(section) = section {
            let destination = section.as_deref().filter(|id| !id.is_empty());
            if let Some(destination) = destination {
                if !has_section(sections, destination) {
                    return Err(not_found(format!("section `{destination}`")).target(
                        PatchTarget::Section {
                            id: destination.to_owned(),
                        },
                    ));
                }
            }
            let current = tiles[index]
                .get("sectionId")
                .and_then(Value::as_str)
                .unwrap_or("");
            if current != destination.unwrap_or("") {
                relocate_tile(tiles, sections, index, destination);
                relocated = true;
            }
        }
        match edits.filter(|edits| !edits.is_empty()) {
            Some(edits) => update_tile_layout(tiles, sections, index, edits)?,
            None if !relocated => compact_section(tiles, sections, index),
            None => {}
        }
        Ok(())
    })
}

// ---------------------------------------------------------------------------------------------
// Sections and variables
// ---------------------------------------------------------------------------------------------

fn reorder_sections(document: &mut Value, ids: &[String]) -> Result<(), PatchError> {
    let root = root_mut(document)?;
    let sections = match root.get_mut("sections") {
        Some(Value::Array(sections)) => sections,
        None | Some(Value::Null) if ids.is_empty() => return Ok(()),
        _ => return Err(not_found("a sections array".to_owned()).target(PatchTarget::Dashboard)),
    };
    // Later duplicates and malformed entries are not addressable and keep their slots.
    let mut seen = HashSet::new();
    let mut slots = Vec::new();
    for (index, section) in sections.iter().enumerate() {
        if let Some(id) = section_id(section) {
            if seen.insert(id.to_owned()) {
                slots.push(index);
            }
        }
    }
    let mut requested = HashSet::new();
    for id in ids {
        if !seen.contains(id) {
            return Err(not_found(format!("section `{id}`"))
                .target(PatchTarget::Section { id: id.clone() }));
        }
        if !requested.insert(id) {
            return Err(PatchError::new(
                PatchErrorCode::InvalidOperation,
                format!("section `{id}` is listed more than once"),
            ));
        }
    }
    if ids.len() != slots.len() {
        return Err(PatchError::new(
            PatchErrorCode::InvalidOperation,
            format!(
                "sectionIds must list all {} sections exactly once; got {}",
                slots.len(),
                ids.len()
            ),
        ));
    }
    let mut by_id: HashMap<String, Value> = slots
        .iter()
        .map(|&slot| {
            let section = std::mem::take(&mut sections[slot]);
            (section_id(&section).unwrap_or_default().to_owned(), section)
        })
        .collect();
    for (&slot, id) in slots.iter().zip(ids) {
        sections[slot] = by_id.remove(id).unwrap_or_default();
    }
    Ok(())
}

/// Port of sections.ts removeSection, plus explicit delete and move dispositions.
fn remove_section(
    document: &mut Value,
    id: &str,
    disposition: &TileDisposition,
) -> Result<(), PatchError> {
    section_target(id)?;
    let root = root_mut(document)?;
    let sections: &[Value] = root
        .get("sections")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    if !has_section(sections, id) {
        return Err(not_found(format!("section `{id}`")));
    }
    let destination = match disposition {
        TileDisposition::Move { section_id } => {
            if section_id == id {
                return Err(PatchError::new(
                    PatchErrorCode::InvalidOperation,
                    "tiles cannot move into the section being removed",
                ));
            }
            if !has_section(sections, section_id) {
                return Err(not_found(format!("section `{section_id}`")).target(
                    PatchTarget::Section {
                        id: section_id.clone(),
                    },
                ));
            }
            Some(section_id.as_str())
        }
        _ => None,
    };
    with_tiles(root, |tiles, sections| {
        let in_section = |tile: &Value| tile.get("sectionId").and_then(Value::as_str) == Some(id);
        if *disposition == TileDisposition::Delete {
            tiles.retain(|tile| !in_section(tile));
            return Ok(());
        }
        let groups = section_groups(tiles, sections);
        let mut members = group_for(&groups, destination.unwrap_or(""))
            .members
            .clone();
        for index in 0..tiles.len() {
            if !in_section(&tiles[index]) {
                continue;
            }
            let size = |key: &str, fallback: i64| {
                tiles[index]
                    .get("layout")
                    .and_then(|layout| layout.get(key))
                    .filter(|value| value.is_number())
                    .cloned()
                    .unwrap_or_else(|| fallback.into())
            };
            let (w, h) = (size("w", DEFAULT_TILE_W), size("h", DEFAULT_TILE_H));
            let y = append_y(tiles, &members);
            set_section_id(&mut tiles[index], destination);
            set_layout(
                &mut tiles[index],
                [
                    ("x", Value::from(0)),
                    ("y", Value::from(y)),
                    ("w", w),
                    ("h", h),
                ],
            );
            members.push(index);
        }
        Ok(())
    })?;
    if let Some(Value::Array(sections)) = root.get_mut("sections") {
        sections.retain(|section| section_id(section) != Some(id));
    }
    Ok(())
}

/// Byte ranges of the names in `$name` and `${name}` tokens (JS `\$\{?(\w+)\}?`).
fn token_spans(text: &str) -> Vec<(usize, usize)> {
    let bytes = text.as_bytes();
    let mut spans = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'$' {
            let start = if bytes.get(i + 1) == Some(&b'{') {
                i + 2
            } else {
                i + 1
            };
            let mut end = start;
            while end < bytes.len() && (bytes[end].is_ascii_alphanumeric() || bytes[end] == b'_') {
                end += 1;
            }
            if end > start {
                spans.push((start, end));
                i = end;
                continue;
            }
        }
        i += 1;
    }
    spans
}

fn referenced_names(text: &str) -> impl Iterator<Item = &str> {
    token_spans(text)
        .into_iter()
        .map(move |(start, end)| &text[start..end])
}

fn rename_tokens(text: &str, from: &str, to: &str) -> Option<String> {
    let spans: Vec<_> = token_spans(text)
        .into_iter()
        .filter(|&(start, end)| &text[start..end] == from)
        .collect();
    if spans.is_empty() {
        return None;
    }
    let mut renamed = String::with_capacity(text.len() + spans.len() * to.len());
    let mut last = 0;
    for (start, end) in spans {
        renamed.push_str(&text[last..start]);
        renamed.push_str(to);
        last = end;
    }
    renamed.push_str(&text[last..]);
    Some(renamed)
}

fn rename_value(value: &mut Value, from: &str, to: &str) {
    match value {
        Value::String(text) => {
            if let Some(renamed) = rename_tokens(text, from, to) {
                *text = renamed;
            }
        }
        Value::Array(items) => items
            .iter_mut()
            .for_each(|item| rename_value(item, from, to)),
        Value::Object(map) => map
            .values_mut()
            .for_each(|item| rename_value(item, from, to)),
        _ => {}
    }
}

fn rename_variable(document: &mut Value, from: &str, to: &str) -> Result<(), PatchError> {
    variable_target(from)?;
    if !is_variable_name(to) {
        return Err(PatchError::new(
            PatchErrorCode::InvalidValue,
            format!("variable name `{to}` must match ^\\w+$ (at most {MAX_ID_BYTES} bytes)"),
        ));
    }
    let root = root_mut(document)?;
    {
        let variables =
            array_mut(root, "variables").map_err(|_| not_found(format!("variable `{from}`")))?;
        let index = find_variable(variables, from)?
            .ok_or_else(|| not_found(format!("variable `{from}`")))?;
        if from == to {
            return Ok(());
        }
        if variables
            .iter()
            .any(|variable| variable_name(variable) == Some(to))
        {
            return Err(PatchError::new(
                PatchErrorCode::NameConflict,
                format!("a variable named `{to}` already exists"),
            )
            .target(PatchTarget::Variable {
                name: to.to_owned(),
            }));
        }
        for (position, variable) in variables.iter_mut().enumerate() {
            let Some(variable) = variable.as_object_mut() else {
                continue;
            };
            if position == index {
                variable.insert("name".to_owned(), Value::String(to.to_owned()));
                continue;
            }
            for key in VARIABLE_SOURCES {
                if let Some(Value::String(text)) = variable.get_mut(*key) {
                    if let Some(renamed) = rename_tokens(text, from, to) {
                        *text = renamed;
                    }
                }
            }
            if let Some(Value::Array(filters)) = variable.get_mut("labelFilters") {
                for filter in filters {
                    if let Some(Value::String(text)) = filter.get_mut("value") {
                        if let Some(renamed) = rename_tokens(text, from, to) {
                            *text = renamed;
                        }
                    }
                }
            }
        }
    }
    if let Some(Value::Array(tiles)) = root.get_mut("tiles") {
        for tile in tiles.iter_mut().filter_map(Value::as_object_mut) {
            for key in ["chartQuery", "dbName"] {
                if let Some(value) = tile.get_mut(key) {
                    rename_value(value, from, to);
                }
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

/// One structural problem in a dashboard document. `path` is relative to `target`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationIssue {
    pub code: String,
    pub message: String,
    pub target: PatchTarget,
    pub path: String,
    /// The same defect, at the same value, was already present in the base document.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub legacy: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationReport {
    pub valid: bool,
    pub errors: Vec<ValidationIssue>,
    pub warnings: Vec<ValidationIssue>,
}

struct Finding {
    issue: ValidationIssue,
    /// Advisory findings are always warnings.
    advisory: bool,
    /// The offending value(s); a legacy defect matches only when this is unchanged.
    detail: String,
}

type FindingKey = (String, PatchTarget, String, String);

impl Finding {
    fn key(&self) -> FindingKey {
        (
            self.issue.code.clone(),
            self.issue.target.clone(),
            self.issue.path.clone(),
            self.detail.clone(),
        )
    }
}

/// Structural validation of a final candidate. Executes no queries and probes no datasets.
///
/// With a `base`, a defect already present in the base at the same target, path and value is
/// reported as a legacy warning, so untouched legacy content never blocks unrelated edits while
/// new or changed defects are errors. Unknown fields are preserved and not validated.
pub fn validate_dashboard(candidate: &Value, base: Option<&Value>) -> ValidationReport {
    // Growth past the limits is rejected before any per-entity work, bounding validation cost.
    let mut limits = Checker::default();
    check_limits(&mut limits, candidate, base);
    if !limits.findings.is_empty() {
        let errors: Vec<ValidationIssue> = limits
            .findings
            .into_iter()
            .map(|finding| finding.issue)
            .collect();
        return ValidationReport {
            valid: false,
            errors,
            warnings: Vec::new(),
        };
    }
    let mut findings = check_document(candidate);
    if let Some(base) = base {
        // A multiset: each base occurrence grandfathers one candidate occurrence, so adding
        // another copy of a legacy defect (such as a third duplicate id) is still an error.
        let mut legacy: HashMap<FindingKey, usize> = HashMap::new();
        for finding in check_document(base)
            .iter()
            .filter(|finding| !finding.advisory)
        {
            *legacy.entry(finding.key()).or_default() += 1;
        }
        for finding in findings.iter_mut().filter(|finding| !finding.advisory) {
            if let Some(remaining) = legacy.get_mut(&finding.key()).filter(|count| **count > 0) {
                *remaining -= 1;
                finding.issue.legacy = true;
            }
        }
    }
    let mut checker = Checker { findings };
    check_reserved(&mut checker, candidate, base);
    if let Some(base) = base {
        check_removed_variables(&mut checker, candidate, base);
    }
    let mut report = ValidationReport::default();
    for finding in checker.findings {
        if finding.advisory || finding.issue.legacy {
            report.warnings.push(finding.issue);
        } else {
            report.errors.push(finding.issue);
        }
    }
    report.valid = report.errors.is_empty();
    report
}

#[derive(Clone, Copy)]
enum Shape {
    String,
    Bool,
    Number,
    PositiveNumber,
    Strings,
    StringOrStrings,
}

impl Shape {
    fn accepts(self, value: &Value) -> bool {
        match self {
            Shape::String => value.is_string(),
            Shape::Bool => value.is_boolean(),
            Shape::Number => value.is_number(),
            Shape::PositiveNumber => value.as_f64().is_some_and(|number| number > 0.0),
            Shape::Strings => value
                .as_array()
                .is_some_and(|items| items.iter().all(Value::is_string)),
            Shape::StringOrStrings => value.is_string() || Shape::Strings.accepts(value),
        }
    }

    fn describe(self) -> &'static str {
        match self {
            Shape::String => "a string",
            Shape::Bool => "a boolean",
            Shape::Number => "a number",
            Shape::PositiveNumber => "a positive number",
            Shape::Strings => "an array of strings",
            Shape::StringOrStrings => "a string or an array of strings",
        }
    }
}

fn detail(value: Option<&Value>) -> String {
    value.map(Value::to_string).unwrap_or_default()
}

fn present(map: &Map<String, Value>, key: &str) -> Option<Value> {
    map.get(key).filter(|value| !value.is_null()).cloned()
}

#[derive(Default)]
struct Checker {
    findings: Vec<Finding>,
}

impl Checker {
    fn report(
        &mut self,
        advisory: bool,
        code: &str,
        target: &PatchTarget,
        path: impl Into<String>,
        detail: String,
        message: impl Into<String>,
    ) {
        self.findings.push(Finding {
            issue: ValidationIssue {
                code: code.to_owned(),
                message: message.into(),
                target: target.clone(),
                path: path.into(),
                legacy: false,
            },
            advisory,
            detail,
        });
    }

    fn error(
        &mut self,
        code: &str,
        target: &PatchTarget,
        path: impl Into<String>,
        detail: String,
        message: impl Into<String>,
    ) {
        self.report(false, code, target, path, detail, message);
    }

    fn advise(
        &mut self,
        code: &str,
        target: &PatchTarget,
        path: impl Into<String>,
        detail: String,
        message: impl Into<String>,
    ) {
        self.report(true, code, target, path, detail, message);
    }

    /// Null and absent are always accepted for optional fields.
    fn field(
        &mut self,
        target: &PatchTarget,
        prefix: &str,
        map: &Map<String, Value>,
        key: &str,
        shape: Shape,
    ) {
        if let Some(value) = map.get(key).filter(|value| !value.is_null()) {
            if !shape.accepts(value) {
                self.error(
                    "invalid_field_type",
                    target,
                    join(prefix, key),
                    value.to_string(),
                    format!("`{key}` must be {}", shape.describe()),
                );
            }
        }
    }

    fn one_of(
        &mut self,
        code: &str,
        target: &PatchTarget,
        prefix: &str,
        map: &Map<String, Value>,
        key: &str,
        allowed: &[&str],
    ) {
        if let Some(value) = map.get(key).filter(|value| !value.is_null()) {
            if !value.as_str().is_some_and(|value| allowed.contains(&value)) {
                self.error(
                    code,
                    target,
                    join(prefix, key),
                    value.to_string(),
                    format!("`{key}` must be one of: {}", allowed.join(", ")),
                );
            }
        }
    }

    fn object<'a>(
        &mut self,
        target: &PatchTarget,
        prefix: &str,
        map: &'a Map<String, Value>,
        key: &str,
    ) -> Option<&'a Map<String, Value>> {
        match map.get(key) {
            None | Some(Value::Null) => None,
            Some(Value::Object(object)) => Some(object),
            Some(other) => {
                self.error(
                    "invalid_field_type",
                    target,
                    join(prefix, key),
                    other.to_string(),
                    format!("`{key}` must be an object"),
                );
                None
            }
        }
    }
}

fn check_document(document: &Value) -> Vec<Finding> {
    let mut c = Checker::default();
    let d = PatchTarget::Dashboard;
    let Some(root) = document.as_object() else {
        c.error(
            "invalid_document",
            &d,
            "",
            String::new(),
            "a dashboard must be a JSON object",
        );
        return c.findings;
    };
    if let Err(error) = Dashboard::deserialize(document) {
        c.error(
            "incompatible_document",
            &d,
            "",
            String::new(),
            format!("the document does not match the stored dashboard shape: {error}"),
        );
    }
    match root.get("title") {
        Some(Value::String(title)) if !title.trim().is_empty() => {}
        Some(Value::String(_)) => c.error(
            "empty_title",
            &d,
            "/title",
            String::new(),
            "`title` must not be blank",
        ),
        other => c.error(
            "invalid_field_type",
            &d,
            "/title",
            detail(other),
            "`title` must be a string",
        ),
    }
    c.field(&d, "", root, "tags", Shape::Strings);
    c.field(&d, "", root, "isFavorite", Shape::Bool);
    c.field(&d, "", root, "description", Shape::String);
    c.field(&d, "", root, "dataset", Shape::String);
    c.one_of(
        "invalid_field_value",
        &d,
        "",
        root,
        "dashboardType",
        DASHBOARD_TYPES,
    );
    check_time_range(&mut c, root);
    if let Some(value) = root.get("refreshInterval").filter(|value| !value.is_null()) {
        if !value
            .as_u64()
            .is_some_and(|ms| REFRESH_INTERVALS.contains(&ms))
        {
            c.error(
                "invalid_refresh_interval",
                &d,
                "/refreshInterval",
                value.to_string(),
                "`refreshInterval` must be one of 0, 15000, 30000, 60000 or 300000 milliseconds",
            );
        }
    }
    let sections = collection(&mut c, root, "sections");
    let variables = collection(&mut c, root, "variables");
    let tiles = collection(&mut c, root, "tiles");
    let section_ids = check_sections(&mut c, sections);
    check_variables(&mut c, variables);
    check_tiles(&mut c, tiles, &section_ids);
    c.findings
}

/// Over-limit documents may shrink or stay the same size, but never grow (also for full PUTs).
fn check_limits(c: &mut Checker, candidate: &Value, base: Option<&Value>) {
    let count = |document: Option<&Value>, key: &str| {
        document
            .and_then(|document| document.get(key))
            .and_then(Value::as_array)
            .map_or(0, Vec::len)
    };
    for (key, limit) in [
        ("tiles", MAX_TILES),
        ("sections", MAX_SECTIONS),
        ("variables", MAX_VARIABLES),
    ] {
        let after = count(Some(candidate), key);
        if after > limit && after > count(base, key) {
            c.error(
                "limit_exceeded",
                &PatchTarget::Dashboard,
                join("", key),
                after.to_string(),
                format!("a dashboard may contain at most {limit} {key}"),
            );
        }
    }
    let size = json_len(candidate);
    if size > MAX_DOCUMENT_BYTES && base.is_none_or(|base| size > json_len(base)) {
        c.error(
            "document_too_large",
            &PatchTarget::Dashboard,
            "",
            size.to_string(),
            format!("a dashboard may be at most {MAX_DOCUMENT_BYTES} bytes of JSON"),
        );
    }
}

fn collection<'a>(c: &mut Checker, root: &'a Map<String, Value>, key: &str) -> &'a [Value] {
    match root.get(key) {
        None | Some(Value::Null) => &[],
        // Size limits depend on the base and are checked by `check_limits`.
        Some(Value::Array(items)) => items,
        Some(other) => {
            c.error(
                "invalid_collection",
                &PatchTarget::Dashboard,
                join("", key),
                other.to_string(),
                format!("`{key}` must be an array"),
            );
            &[]
        }
    }
}

fn check_time_range(c: &mut Checker, root: &Map<String, Value>) {
    let d = PatchTarget::Dashboard;
    let Some(range) = c.object(&d, "", root, "timeRange") else {
        return;
    };
    let p = "/timeRange";
    for key in ["startTime", "endTime"] {
        if !range.get(key).is_some_and(Value::is_string) {
            c.error(
                "invalid_time_range",
                &d,
                join(p, key),
                detail(range.get(key)),
                format!("`timeRange.{key}` must be a string"),
            );
        }
    }
    c.field(&d, p, range, "label", Shape::String);
    c.field(&d, p, range, "interval", Shape::Number);
    c.field(&d, p, range, "shiftInterval", Shape::Number);
    c.one_of("invalid_time_range", &d, p, range, "type", TIME_RANGE_TYPES);
    let start = range.get("startTime").and_then(Value::as_str);
    match range.get("type").and_then(Value::as_str) {
        Some("fixed") => {
            if start.is_some_and(|start| !TIME_RANGE_PRESETS.contains(&start)) {
                c.advise(
                    "unknown_time_preset",
                    &d,
                    join(p, "startTime"),
                    detail(range.get("startTime")),
                    format!(
                        "fixed ranges the dashboard UI offers are: {}",
                        TIME_RANGE_PRESETS.join(", ")
                    ),
                );
            }
        }
        Some("custom") => {
            // The frontend resolves only endTime "now"; anything else unparseable silently
            // falls back to the last hour, so concrete bounds must parse and be ordered.
            let bound = |key: &str| {
                let text = range.get(key).and_then(Value::as_str)?;
                if key == "endTime" && text == "now" {
                    return Some(None);
                }
                chrono::DateTime::parse_from_rfc3339(text).ok().map(Some)
            };
            let (start, end) = (bound("startTime"), bound("endTime"));
            for (key, parsed) in [("startTime", start), ("endTime", end)] {
                if range.get(key).is_some_and(Value::is_string) && parsed.is_none() {
                    c.error(
                        "invalid_time_range",
                        &d,
                        join(p, key),
                        detail(range.get(key)),
                        if key == "endTime" {
                            "custom `timeRange.endTime` must be an RFC 3339 timestamp or \"now\""
                        } else {
                            "custom `timeRange.startTime` must be an RFC 3339 timestamp"
                        },
                    );
                }
            }
            if let (Some(Some(start)), Some(Some(end))) = (start, end) {
                if start >= end {
                    c.error(
                        "invalid_time_range",
                        &d,
                        join(p, "startTime"),
                        json!([range.get("startTime"), range.get("endTime")]).to_string(),
                        "custom `timeRange.startTime` must be before `endTime`",
                    );
                }
            }
        }
        _ => {}
    }
}

fn check_sections<'a>(c: &mut Checker, sections: &'a [Value]) -> HashSet<&'a str> {
    let mut ids = HashSet::new();
    for (index, section) in sections.iter().enumerate() {
        let at = format!("/sections/{index}");
        let Some(map) = section.as_object() else {
            c.error(
                "invalid_section",
                &PatchTarget::Dashboard,
                at,
                section.to_string(),
                "a section must be an object",
            );
            continue;
        };
        let id = match map.get("sectionId") {
            Some(Value::String(id)) if !id.is_empty() && id.len() <= MAX_ID_BYTES => id.as_str(),
            other => {
                c.error(
                    "invalid_section_id",
                    &PatchTarget::Dashboard,
                    join(&at, "sectionId"),
                    detail(other),
                    format!(
                        "`sectionId` must be a non-empty string of at most {MAX_ID_BYTES} bytes"
                    ),
                );
                continue;
            }
        };
        let target = PatchTarget::Section { id: id.to_owned() };
        if !ids.insert(id) {
            c.error(
                "duplicate_section_id",
                &target,
                "/sectionId",
                id.to_owned(),
                format!("section id `{id}` is used more than once"),
            );
        }
        c.field(&target, "", map, "title", Shape::String);
        c.field(&target, "", map, "collapsed", Shape::Bool);
        c.field(&target, "", map, "isExpanded", Shape::Bool);
    }
    ids
}

/// The text the option loader interpolates, by variable type (variables.ts variableSource).
fn variable_source(variable: &Map<String, Value>) -> String {
    let text = |key: &str| variable.get(key).and_then(Value::as_str).unwrap_or("");
    match variable.get("type").and_then(Value::as_str) {
        Some("sql") => text("sqlQuery").to_owned(),
        Some("promql_query") => format!("{} {}", text("promqlQuery"), text("promqlQueryDataset")),
        Some("promql") => {
            let mut source = text("dataset").to_owned();
            if let Some(filters) = variable.get("labelFilters").and_then(Value::as_array) {
                for value in filters
                    .iter()
                    .filter_map(|filter| filter.get("value")?.as_str())
                {
                    source.push(' ');
                    source.push_str(value);
                }
            }
            source
        }
        _ => String::new(),
    }
}

fn check_variables(c: &mut Checker, variables: &[Value]) {
    let mut names = HashSet::new();
    let mut readable: Vec<(&str, &Map<String, Value>)> = Vec::new();
    for (index, variable) in variables.iter().enumerate() {
        let at = format!("/variables/{index}");
        let Some(map) = variable.as_object() else {
            c.error(
                "invalid_variable",
                &PatchTarget::Dashboard,
                at,
                variable.to_string(),
                "a variable must be an object",
            );
            continue;
        };
        let name = match map.get("name") {
            Some(Value::String(name)) if is_variable_name(name) => name.as_str(),
            other => {
                c.error(
                    "invalid_variable_name",
                    &PatchTarget::Dashboard,
                    join(&at, "name"),
                    detail(other),
                    "variable `name` must match ^\\w+$",
                );
                continue;
            }
        };
        let target = PatchTarget::Variable {
            name: name.to_owned(),
        };
        if !names.insert(name) {
            c.error(
                "duplicate_variable_name",
                &target,
                "/name",
                name.to_owned(),
                format!("variable name `{name}` is used more than once"),
            );
        }
        if !map.get("label").is_some_and(Value::is_string) {
            c.error(
                "invalid_field_type",
                &target,
                "/label",
                detail(map.get("label")),
                "variable `label` must be a string",
            );
        }
        let kind = map.get("type").and_then(Value::as_str);
        let Some(kind) = kind.filter(|kind| VARIABLE_TYPES.contains(kind)) else {
            c.error(
                "unsupported_variable_type",
                &target,
                "/type",
                detail(map.get("type")),
                format!(
                    "variable `type` must be one of: {}",
                    VARIABLE_TYPES.join(", ")
                ),
            );
            continue;
        };
        for key in [
            "dataset",
            "labelName",
            "metric",
            "sqlQuery",
            "promqlQuery",
            "promqlQueryDataset",
            "promqlQueryLabel",
            "defaultValue",
        ] {
            c.field(&target, "", map, key, Shape::String);
        }
        c.field(&target, "", map, "options", Shape::Strings);
        c.field(&target, "", map, "includeAll", Shape::Bool);
        if let Some(filters) = map.get("labelFilters").filter(|value| !value.is_null()) {
            let valid = filters.as_array().is_some_and(|filters| {
                filters.iter().all(|filter| {
                    filter.get("label").is_some_and(Value::is_string)
                        && filter.get("value").is_some_and(Value::is_string)
                        && filter
                            .get("operator")
                            .and_then(Value::as_str)
                            .is_some_and(|op| LABEL_FILTER_OPERATORS.contains(&op))
                })
            });
            if !valid {
                c.error(
                    "invalid_label_filter",
                    &target,
                    "/labelFilters",
                    filters.to_string(),
                    "`labelFilters` must be an array of {label, operator, value} with operator =, !=, =~ or !~",
                );
            }
        }
        let required: &[&str] = match kind {
            "promql" => &["dataset", "labelName"],
            "promql_query" => &["promqlQuery", "promqlQueryDataset"],
            "sql" => &["sqlQuery"],
            _ => &[],
        };
        for key in required {
            if !map
                .get(*key)
                .and_then(Value::as_str)
                .is_some_and(|text| !text.trim().is_empty())
            {
                c.error(
                    "incomplete_variable",
                    &target,
                    join("", key),
                    detail(map.get(*key)),
                    format!("a `{kind}` variable requires a non-blank `{key}`"),
                );
            }
        }
        if kind == "list" {
            let options = map.get("options").and_then(Value::as_array);
            if options.is_none_or(Vec::is_empty) {
                c.error(
                    "incomplete_variable",
                    &target,
                    "/options",
                    detail(map.get("options")),
                    "a `list` variable requires at least one option",
                );
            } else if let (Some(default), Some(options)) = (map.get("defaultValue"), options) {
                if default.is_string() && !options.contains(default) {
                    c.advise(
                        "default_not_in_options",
                        &target,
                        "/defaultValue",
                        default.to_string(),
                        "`defaultValue` is not one of the options; the first option is selected",
                    );
                }
            }
        }
        readable.push((name, map));
    }
    check_variable_cycles(c, &readable);
}

fn check_variable_cycles(c: &mut Checker, readable: &[(&str, &Map<String, Value>)]) {
    let index: HashMap<&str, usize> = readable
        .iter()
        .enumerate()
        .map(|(position, (name, _))| (*name, position))
        .collect();
    let dependencies: Vec<Vec<usize>> = readable
        .iter()
        .map(|(_, variable)| {
            let source = variable_source(variable);
            let mut found: Vec<usize> = referenced_names(&source)
                .filter_map(|name| index.get(name).copied())
                .collect();
            found.sort_unstable();
            found.dedup();
            found
        })
        .collect();
    // Iterative DFS: stored documents can hold arbitrarily long dependency chains.
    // 0 = unvisited, 1 = on the current path, 2 = done.
    let mut state = vec![0u8; readable.len()];
    let mut stack: Vec<(usize, usize)> = Vec::new();
    for start in 0..readable.len() {
        if state[start] != 0 {
            continue;
        }
        state[start] = 1;
        stack.push((start, 0));
        while let Some(top) = stack.last_mut() {
            let (node, cursor) = *top;
            let Some(&next) = dependencies[node].get(cursor) else {
                state[node] = 2;
                stack.pop();
                continue;
            };
            top.1 += 1;
            match state[next] {
                0 => {
                    state[next] = 1;
                    stack.push((next, 0));
                }
                1 => {
                    let name = readable[next].0;
                    c.error(
                        "variable_cycle",
                        &PatchTarget::Variable {
                            name: name.to_owned(),
                        },
                        "",
                        name.to_owned(),
                        format!("variable dependencies contain a cycle at `{name}`"),
                    );
                    // Report each cycle once; the rest of this path is abandoned.
                    for (node, _) in stack.drain(..) {
                        state[node] = 2;
                    }
                }
                _ => {}
            }
        }
    }
}

fn check_tiles(c: &mut Checker, tiles: &[Value], section_ids: &HashSet<&str>) {
    let mut ids = HashSet::new();
    let mut groups: HashMap<&str, Vec<(PatchTarget, Rect)>> = HashMap::new();
    for (index, tile) in tiles.iter().enumerate() {
        let at = format!("/tiles/{index}");
        let Some(map) = tile.as_object() else {
            c.error(
                "invalid_tile",
                &PatchTarget::Dashboard,
                at,
                tile.to_string(),
                "a tile must be an object",
            );
            continue;
        };
        let raw = map.get("tile_id");
        let target = match raw.and_then(Value::as_str).map(Ulid::from_string) {
            Some(Ok(ulid)) if !ulid.is_nil() => {
                let target = PatchTarget::Tile {
                    id: ulid.to_string(),
                };
                if !ids.insert(ulid) {
                    c.error(
                        "duplicate_tile_id",
                        &target,
                        "/tile_id",
                        ulid.to_string(),
                        format!("tile id `{ulid}` is used more than once"),
                    );
                }
                target
            }
            Some(Ok(_)) => {
                let target = PatchTarget::Tile {
                    id: detail(raw).trim_matches('"').to_owned(),
                };
                c.error(
                    "nil_tile_id",
                    &target,
                    "/tile_id",
                    detail(raw),
                    "tile ids must not be the nil ULID",
                );
                target
            }
            _ => {
                c.error(
                    "invalid_tile_id",
                    &PatchTarget::Dashboard,
                    join(&at, "tile_id"),
                    detail(raw),
                    "`tile_id` must be a ULID string",
                );
                continue;
            }
        };
        let section = check_tile(c, &target, map, section_ids);
        if let Some(rect) = check_layout(c, &target, map) {
            groups.entry(section).or_default().push((target, rect));
        }
    }
    // Overlap advice is quadratic; documents over the tile limit are already rejected on growth.
    for members in groups.values().filter(|members| members.len() <= MAX_TILES) {
        for (position, (target, rect)) in members.iter().enumerate() {
            if let Some((other, _)) = members
                .iter()
                .enumerate()
                .find(|(other, (_, candidate))| *other != position && rect.overlaps(candidate))
                .map(|(_, member)| member)
            {
                let other = match other {
                    PatchTarget::Tile { id } => id.clone(),
                    _ => String::new(),
                };
                c.advise(
                    "layout_overlap",
                    target,
                    "/layout",
                    other.clone(),
                    format!(
                        "overlaps tile `{other}`; the dashboard compacts it downward when shown"
                    ),
                );
            }
        }
    }
}

/// Returns the tile's effective section group id.
fn check_tile<'a>(
    c: &mut Checker,
    target: &PatchTarget,
    tile: &'a Map<String, Value>,
    section_ids: &HashSet<&str>,
) -> &'a str {
    c.field(target, "", tile, "title", Shape::String);
    let section = match tile.get("sectionId") {
        None | Some(Value::Null) => "",
        Some(Value::String(id)) if id.is_empty() || section_ids.contains(id.as_str()) => {
            id.as_str()
        }
        Some(Value::String(id)) => {
            c.error(
                "unknown_section",
                target,
                "/sectionId",
                id.clone(),
                format!("section `{id}` does not exist"),
            );
            ""
        }
        Some(other) => {
            c.error(
                "invalid_field_type",
                target,
                "/sectionId",
                other.to_string(),
                "`sectionId` must be a string",
            );
            ""
        }
    };
    let tile_type = match tile.get("tileType") {
        None | Some(Value::Null) => Some("builder"),
        Some(Value::String(kind)) if TILE_TYPES.contains(&kind.as_str()) => Some(kind.as_str()),
        other => {
            c.error(
                "unsupported_tile_type",
                target,
                "/tileType",
                detail(other),
                format!("`tileType` must be one of: {}", TILE_TYPES.join(", ")),
            );
            None
        }
    };
    let chart = match tile.get("chartType") {
        None => Some("timeseries"),
        Some(Value::String(kind)) if CHART_TYPES.contains(&kind.as_str()) => Some(kind.as_str()),
        other => {
            c.error(
                "unsupported_chart_type",
                target,
                "/chartType",
                detail(other),
                format!("`chartType` must be one of: {}", CHART_TYPES.join(", ")),
            );
            None
        }
    };
    if let Some(tile_type) = tile_type {
        check_query(c, target, tile, tile_type, chart);
    }
    check_config(c, target, tile, tile_type, chart);
    section
}

fn check_query(
    c: &mut Checker,
    target: &PatchTarget,
    tile: &Map<String, Value>,
    tile_type: &str,
    chart: Option<&str>,
) {
    let query = tile.get("chartQuery");
    let blank = |text: &str| text.trim().is_empty();
    if tile_type != "promql" {
        match query {
            // {query} / {sql} objects are read as plain SQL by the frontend.
            Some(Value::Object(object))
                if object.get("query").is_some_and(Value::is_string)
                    || object.get("sql").is_some_and(Value::is_string) => {}
            Some(Value::Object(object)) if tile_type == "builder" => {
                check_builder_query(c, target, tile, object, chart);
            }
            None | Some(Value::Null) => c.advise(
                "empty_query",
                target,
                "/chartQuery",
                String::new(),
                "the tile has no SQL query",
            ),
            Some(Value::String(sql)) if blank(sql) => c.advise(
                "empty_query",
                target,
                "/chartQuery",
                String::new(),
                "the tile has no SQL query",
            ),
            Some(Value::String(_)) => {}
            Some(Value::Object(_)) => c.error(
                "legacy_query_shape",
                target,
                "/chartQuery",
                detail(query),
                "code tiles store SQL as a string; builder objects need tileType `builder`",
            ),
            Some(other) => c.error(
                "invalid_query_shape",
                target,
                "/chartQuery",
                other.to_string(),
                "SQL tiles need `chartQuery` as a string",
            ),
        }
        c.field(target, "", tile, "dbName", Shape::StringOrStrings);
        for key in ["promqlQueryType", "promqlStep"] {
            if let Some(value) = present(tile, key) {
                c.advise(
                    "ignored_field",
                    target,
                    join("", key),
                    value.to_string(),
                    format!("`{key}` only applies to PromQL tiles"),
                );
            }
        }
        return;
    }
    let count = match query {
        Some(Value::String(promql)) => {
            if blank(promql) {
                c.advise(
                    "empty_query",
                    target,
                    "/chartQuery",
                    String::new(),
                    "the PromQL query is blank",
                );
            }
            1
        }
        Some(Value::Array(items)) if !items.is_empty() && items.iter().all(Value::is_string) => {
            if items.iter().filter_map(Value::as_str).any(blank) {
                c.advise(
                    "empty_query",
                    target,
                    "/chartQuery",
                    String::new(),
                    "a PromQL query is blank",
                );
            }
            items.len()
        }
        Some(Value::Object(_)) => {
            c.error(
                "legacy_query_shape",
                target,
                "/chartQuery",
                detail(query),
                "object `chartQuery` is a legacy shape; use a string or an array of strings",
            );
            0
        }
        other => {
            c.error(
                "invalid_query_shape",
                target,
                "/chartQuery",
                detail(other),
                "PromQL tiles need `chartQuery` as a string or a non-empty array of strings",
            );
            0
        }
    };
    let mode = |value: &Value| {
        value
            .as_str()
            .is_some_and(|mode| QUERY_MODES.contains(&mode))
    };
    match tile.get("promqlQueryType") {
        None | Some(Value::Null) => {}
        Some(value) if mode(value) => {}
        Some(Value::Array(modes)) if modes.iter().all(mode) => {
            if count > 0 && modes.len() != count {
                c.error(
                    "invalid_query_mode",
                    target,
                    "/promqlQueryType",
                    json!([modes, count]).to_string(),
                    format!(
                        "`promqlQueryType` lists {} modes for {count} queries",
                        modes.len()
                    ),
                );
            }
        }
        Some(other) => c.error(
            "invalid_query_mode",
            target,
            "/promqlQueryType",
            other.to_string(),
            "`promqlQueryType` must be range, instant, both, or an array of those",
        ),
    }
    if let Some(step) = present(tile, "promqlStep") {
        let valid = match &step {
            Value::String(text) => is_duration(text),
            Value::Number(number) => number.as_f64().is_some_and(|seconds| seconds > 0.0),
            _ => false,
        };
        if !valid {
            c.error(
                "invalid_step",
                target,
                "/promqlStep",
                step.to_string(),
                "`promqlStep` must be a duration such as 30s or 5m, or positive seconds",
            );
        }
    }
    let datasets = match tile.get("dbName") {
        Some(Value::String(name)) if !blank(name) => Some(1),
        Some(Value::Array(names))
            if !names.is_empty()
                && names
                    .iter()
                    .all(|name| name.as_str().is_some_and(|name| !blank(name))) =>
        {
            Some(names.len())
        }
        _ => None,
    };
    match datasets {
        None => c.error(
            "missing_dataset",
            target,
            "/dbName",
            detail(tile.get("dbName")),
            "PromQL tiles need `dbName` naming the metrics dataset",
        ),
        Some(count) if count > 1 => c.advise(
            "extra_datasets",
            target,
            "/dbName",
            detail(tile.get("dbName")),
            "only the first dataset is queried by PromQL tiles",
        ),
        Some(_) => {}
    }
}

const BUILDER_AGGREGATES: &[&str] = &["COUNT", "SUM", "AVG", "MIN", "MAX", "COUNT(DISTINCT)"];
const BUILDER_OPERATORS: &[&str] = &[
    "=",
    "!=",
    "<>",
    "<",
    ">",
    "<=",
    ">=",
    "is null",
    "is not null",
];
const BUILDER_GRAINS: &[&str] = &[
    "second", "minute", "hour", "day", "week", "month", "quarter", "year",
];
const BUILDER_STAR: &[&str] = &["*", "All rows (*)"];

fn builder_fields(axis: Option<&Map<String, Value>>) -> Vec<&Value> {
    axis.and_then(|axis| axis.get("fields"))
        .and_then(Value::as_array)
        .map(|fields| fields.iter().collect())
        .unwrap_or_default()
}

/// Structural checks for the visual builder's object `chartQuery` ({x, y, filters}), matching
/// what frontend legacySql.ts compiles and builder.ts edits. Extra keys are preserved unchecked.
fn check_builder_query(
    c: &mut Checker,
    target: &PatchTarget,
    tile: &Map<String, Value>,
    query: &Map<String, Value>,
    chart: Option<&str>,
) {
    let p = "/chartQuery";
    let fail = |c: &mut Checker, path: String, value: Option<&Value>, message: &str| {
        c.error(
            "invalid_builder_query",
            target,
            path,
            detail(value),
            message,
        );
    };
    let stat = matches!(chart, Some("query-value" | "gauge"));
    let mut axes: [Option<&Map<String, Value>>; 2] = [None, None];
    for (slot, axis) in ["x", "y"].into_iter().enumerate() {
        let at = join(p, axis);
        match query.get(axis) {
            None | Some(Value::Null) => {}
            Some(Value::Object(map)) => axes[slot] = Some(map),
            other => fail(c, at, other, "builder axes must be objects"),
        }
    }
    let [x, y] = axes;
    let fields = builder_fields;
    for (name, axis) in [("x", x), ("y", y)] {
        let Some(axis) = axis else { continue };
        let at = join(p, name);
        match axis.get("fields") {
            None | Some(Value::Null) if name == "x" => {}
            Some(Value::Array(_)) => {}
            other => fail(
                c,
                join(&at, "fields"),
                other,
                "builder `fields` must be an array",
            ),
        }
        if let Some(group) = axis.get("groupBy").filter(|value| !value.is_null()) {
            if !Shape::Strings.accepts(group) {
                fail(
                    c,
                    join(&at, "groupBy"),
                    Some(group),
                    "builder `groupBy` must be an array of column names",
                );
            }
        }
        if let Some(sort) = axis.get("sortBy").filter(|value| !value.is_null()) {
            let field = sort
                .get("field")
                .and_then(Value::as_str)
                .filter(|field| !field.is_empty());
            let direction = sort.get("direction").and_then(Value::as_str);
            if field.is_none() || !matches!(direction, Some("ASC" | "DESC")) {
                fail(
                    c,
                    join(&at, "sortBy"),
                    Some(sort),
                    "builder `sortBy` must be {field, direction: ASC|DESC}",
                );
            }
        }
    }
    if y.is_none() {
        fail(
            c,
            join(p, "y"),
            query.get("y"),
            "builder queries need a `y` axis with aggregate fields",
        );
    }
    for (index, field) in fields(x).into_iter().enumerate() {
        if !field
            .get("name")
            .and_then(Value::as_str)
            .is_some_and(|name| !name.is_empty())
        {
            fail(
                c,
                format!("{p}/x/fields/{index}"),
                Some(field),
                "builder dimensions need a column `name`",
            );
        }
    }
    for (index, field) in fields(y).into_iter().enumerate() {
        let at = format!("{p}/y/fields/{index}");
        let name = field
            .get("name")
            .and_then(Value::as_str)
            .filter(|name| !name.is_empty());
        let aggregate = field
            .get("aggregate")
            .and_then(Value::as_str)
            .map(str::to_uppercase);
        match (name, aggregate.as_deref()) {
            (Some(name), Some(aggregate)) if BUILDER_AGGREGATES.contains(&aggregate) => {
                if BUILDER_STAR.contains(&name) && aggregate != "COUNT" {
                    fail(c, at, Some(field), "only COUNT can aggregate all rows (*)");
                }
            }
            _ => fail(
                c,
                at,
                Some(field),
                "builder measures need a `name` and an aggregate: COUNT, SUM, AVG, MIN, MAX or COUNT(DISTINCT)",
            ),
        }
    }
    if let Some(grain) = x
        .and_then(|x| x.get("granularity"))
        .filter(|value| !value.is_null())
    {
        if !grain
            .as_str()
            .is_some_and(|grain| BUILDER_GRAINS.contains(&grain))
        {
            fail(
                c,
                join(p, "x") + "/granularity",
                Some(grain),
                "unsupported time granularity",
            );
        }
    }
    if chart == Some("timeseries") && fields(x).is_empty() {
        fail(
            c,
            format!("{p}/x/fields"),
            x.and_then(|x| x.get("fields")),
            "timeseries builder queries need a time field first",
        );
    }
    if y.is_some() && fields(y).is_empty() && (stat || fields(x).is_empty()) {
        fail(
            c,
            format!("{p}/y/fields"),
            y.and_then(|y| y.get("fields")),
            if stat {
                "query-value and gauge builder queries need an aggregate measure"
            } else {
                "the builder query selects nothing"
            },
        );
    }
    if !stat {
        if let Some(limit) = y
            .and_then(|y| y.get("limit"))
            .filter(|value| !value.is_null())
        {
            if !limit.as_u64().is_some_and(|limit| limit >= 1) {
                fail(
                    c,
                    format!("{p}/y/limit"),
                    Some(limit),
                    "builder `limit` must be a whole number of at least 1",
                );
            }
        }
    }
    match query.get("filters") {
        None | Some(Value::Null) => {}
        Some(Value::Array(filters)) => {
            for (index, filter) in filters.iter().enumerate() {
                let column = filter
                    .get("column")
                    .and_then(Value::as_str)
                    .filter(|column| !column.is_empty());
                let operator = filter
                    .get("operator")
                    .and_then(Value::as_str)
                    .map(|op| op.trim().to_lowercase());
                let list = filter
                    .get("type")
                    .and_then(Value::as_str)
                    .is_some_and(|kind| kind.starts_with("list"));
                let scalar =
                    |value: &Value| value.is_string() || value.is_number() || value.is_boolean();
                let value_ok = operator.as_deref().is_some_and(|op| op.contains("null"))
                    || match filter.get("value") {
                        Some(Value::Array(values)) => {
                            !values.is_empty() && values.iter().all(scalar)
                        }
                        Some(value) => scalar(value),
                        None => false,
                    };
                if column.is_none()
                    || !operator
                        .as_deref()
                        .is_some_and(|op| BUILDER_OPERATORS.contains(&op))
                    || list
                    || !value_ok
                {
                    fail(
                        c,
                        format!("{p}/filters/{index}"),
                        Some(filter),
                        "builder filters need {column, operator, value} with a comparison or is (not) null operator",
                    );
                }
            }
        }
        other => fail(
            c,
            join(p, "filters"),
            other,
            "builder `filters` must be an array",
        ),
    }
    let dataset = match tile.get("dbName") {
        Some(Value::String(name)) => !name.trim().is_empty(),
        Some(Value::Array(names)) => names
            .first()
            .and_then(Value::as_str)
            .is_some_and(|name| !name.trim().is_empty()),
        _ => false,
    };
    if !dataset {
        c.error(
            "missing_dataset",
            target,
            "/dbName",
            detail(tile.get("dbName")),
            "builder queries need `dbName` naming the dataset",
        );
    }
}

fn is_duration(text: &str) -> bool {
    let mut rest = text;
    let mut any = false;
    while !rest.is_empty() {
        let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 {
            return false;
        }
        rest = &rest[digits..];
        let unit = ["ms", "s", "m", "h", "d", "w", "y"]
            .into_iter()
            .find(|unit| rest.starts_with(unit));
        let Some(unit) = unit else {
            return false;
        };
        rest = &rest[unit.len()..];
        any = true;
    }
    any && !text.bytes().all(|b| b == b'0' || !b.is_ascii_digit())
}

fn check_config(
    c: &mut Checker,
    target: &PatchTarget,
    tile: &Map<String, Value>,
    tile_type: Option<&str>,
    chart: Option<&str>,
) {
    let Some(config) = c.object(target, "", tile, "config") else {
        return;
    };
    let p = "/config";
    let config_type = config.get("type").and_then(Value::as_str);
    c.field(target, p, config, "type", Shape::String);
    if let (Some(config_type), Some(chart)) = (config_type, chart) {
        let consistent = if chart == "timeseries" {
            config_type == "timeseries" || SERIES_STYLES.contains(&config_type)
        } else {
            config_type == chart
        };
        if !consistent {
            c.advise(
                "config_type_mismatch",
                target,
                "/config/type",
                config_type.to_owned(),
                "`config.type` is ignored unless it is the chart type, or a series style (line, bar, area) for timeseries",
            );
        }
    }
    c.one_of(
        "unknown_colour_scheme",
        target,
        p,
        config,
        "colourScheme",
        COLOUR_SCHEMES,
    );
    c.field(target, p, config, "maxDataPoints", Shape::PositiveNumber);
    let layout = c.object(target, p, config, "layout");
    let stacked = chart == Some("timeseries")
        && config_type == Some("bar")
        && layout.and_then(|layout| layout.get("stacked")) == Some(&Value::Bool(true));
    if let Some(layout) = layout {
        check_chart_layout(c, target, layout, chart);
    }
    if let Some(axes) = c.object(target, p, config, "axes") {
        check_axes(c, target, axes, tile_type, chart, stacked);
    }
    if let Some(advanced) = c.object(target, p, config, "advanced") {
        let p = "/config/advanced";
        if let Some(labels) = c.object(target, p, advanced, "dataLabels") {
            c.field(
                target,
                "/config/advanced/dataLabels",
                labels,
                "enabled",
                Shape::Bool,
            );
        }
        if let Some(tooltip) = c.object(target, p, advanced, "tooltip") {
            let p = "/config/advanced/tooltip";
            c.field(target, p, tooltip, "enabled", Shape::Bool);
            c.field(target, p, tooltip, "mode", Shape::String);
            c.field(target, p, tooltip, "intersect", Shape::Bool);
        }
    }
}

/// Display, threshold and conditional colour settings (config.layout).
fn check_chart_layout(
    c: &mut Checker,
    target: &PatchTarget,
    layout: &Map<String, Value>,
    chart: Option<&str>,
) {
    let p = "/config/layout";
    c.one_of(
        "invalid_field_value",
        target,
        p,
        layout,
        "legendPosition",
        LEGEND_POSITIONS,
    );
    if let Some(position @ ("left" | "right")) =
        layout.get("legendPosition").and_then(Value::as_str)
    {
        if !matches!(chart, Some("pie" | "donut")) {
            c.advise(
                "side_legend",
                target,
                "/config/layout/legendPosition",
                position.to_owned(),
                "the editor offers left/right legends only for pie and donut charts",
            );
        }
    }
    for key in ["label", "stacked", "sparkline", "humanize"] {
        c.field(target, p, layout, key, Shape::Bool);
    }
    c.one_of(
        "invalid_field_value",
        target,
        p,
        layout,
        "barOrientation",
        BAR_ORIENTATIONS,
    );
    c.one_of(
        "invalid_field_value",
        target,
        p,
        layout,
        "queryValueTheme",
        QUERY_VALUE_THEMES,
    );
    c.one_of(
        "invalid_field_value",
        target,
        p,
        layout,
        "percentFill",
        PERCENT_FILLS,
    );
    c.field(target, p, layout, "unit", Shape::String);
    c.field(target, p, layout, "rangeFrom", Shape::Number);
    c.field(target, p, layout, "rangeTo", Shape::Number);
    c.field(target, p, layout, "maxDataPoints", Shape::PositiveNumber);
    if let Some(precision) = present(layout, "precision") {
        if !precision
            .as_i64()
            .is_some_and(|value| (-1..=20).contains(&value))
        {
            c.error(
                "invalid_field_value",
                target,
                "/config/layout/precision",
                precision.to_string(),
                "`precision` must be an integer from -1 (precise) to 20",
            );
        }
    }
    let segments = present(layout, "segments");
    let thresholds = segments.as_ref().and_then(|segments| {
        let values = segments.get("value")?.as_array()?;
        let numbers: Option<Vec<f64>> = values.iter().map(Value::as_f64).collect();
        let percent = segments
            .get("isPercent")
            .map_or(Some(false), Value::as_bool)?;
        Some((numbers?, percent))
    });
    if segments.is_some() && thresholds.is_none() {
        c.error(
            "invalid_segments",
            target,
            "/config/layout/segments",
            detail(segments.as_ref()),
            "`segments` must be {value: number[], isPercent: boolean}",
        );
    }
    if chart != Some("gauge") {
        return;
    }
    let number =
        |key: &str, fallback: f64| layout.get(key).and_then(Value::as_f64).unwrap_or(fallback);
    let (from, to) = (number("rangeFrom", 0.0), number("rangeTo", 100.0));
    let gauge = json!([layout.get("rangeFrom"), layout.get("rangeTo"), segments]).to_string();
    if from >= to {
        c.error(
            "invalid_gauge_range",
            target,
            "/config/layout/rangeFrom",
            gauge.clone(),
            "gauge `rangeFrom` must be below `rangeTo`",
        );
    }
    let Some((values, percent)) = thresholds else {
        return;
    };
    if values.windows(2).any(|pair| pair[1] <= pair[0]) {
        c.error(
            "invalid_segments",
            target,
            "/config/layout/segments",
            gauge.clone(),
            "gauge thresholds must increase",
        );
    }
    let (low, high) = if percent { (0.0, 100.0) } else { (from, to) };
    if values.iter().any(|value| *value < low || *value > high) {
        c.error(
            "invalid_segments",
            target,
            "/config/layout/segments",
            gauge.clone(),
            if percent {
                "percent thresholds must be between 0 and 100"
            } else {
                "absolute thresholds must be within the gauge range"
            },
        );
    }
    if values.len() > 2 {
        c.advise(
            "extra_thresholds",
            target,
            "/config/layout/segments",
            gauge,
            "gauges colour green/yellow/red with at most two thresholds; more renders a neutral colour",
        );
    }
}

fn field_count(axis: Option<&Map<String, Value>>) -> usize {
    match axis.and_then(|axis| axis.get("field")) {
        Some(Value::String(field)) if !field.is_empty() => 1,
        Some(Value::Array(fields)) => fields.iter().filter(|field| field.is_string()).count(),
        _ => 0,
    }
}

fn check_axes(
    c: &mut Checker,
    target: &PatchTarget,
    axes: &Map<String, Value>,
    tile_type: Option<&str>,
    chart: Option<&str>,
    stacked: bool,
) {
    let mut bound = HashMap::new();
    for axis in ["x", "y", "size", "groupBy"] {
        let Some(map) = c.object(target, "/config/axes", axes, axis) else {
            continue;
        };
        let p = format!("/config/axes/{axis}");
        c.field(target, &p, map, "field", Shape::StringOrStrings);
        c.field(target, &p, map, "title", Shape::String);
        c.field(target, &p, map, "display", Shape::Bool);
        c.field(target, &p, map, "beginAtZero", Shape::Bool);
        bound.insert(axis, map);
    }
    if tile_type == Some("promql") {
        return;
    }
    let count = |axis: &str| field_count(bound.get(axis).copied());
    let detail_of = |axis: &str| detail(bound.get(axis).and_then(|map| map.get("field")));
    let mut limit = |axis: &str, max: usize, message: &str| {
        if count(axis) > max {
            c.error(
                "invalid_binding",
                target,
                format!("/config/axes/{axis}/field"),
                detail_of(axis),
                message,
            );
        }
    };
    if stacked {
        limit(
            "y",
            1,
            "stacked bar supports one Y column; use groupBy to split series",
        );
    }
    if chart == Some("bubble") {
        limit("y", 1, "bubble charts take one Y column");
        limit("x", 1, "bubble charts take one X column");
        limit("size", 1, "bubble charts take one size column");
        limit("groupBy", 1, "bubble charts support one groupBy column");
    }
    if matches!(chart, Some("pie" | "donut" | "gauge" | "query-value")) {
        limit("y", 1, "this chart reads one value or category column");
    }
    limit("groupBy", 2, "at most two groupBy columns are supported");
}

fn check_layout(c: &mut Checker, target: &PatchTarget, tile: &Map<String, Value>) -> Option<Rect> {
    let layout = match tile.get("layout") {
        None | Some(Value::Null) => {
            c.advise(
                "missing_layout",
                target,
                "/layout",
                String::new(),
                "the tile has no layout and is appended below the grid when shown",
            );
            return None;
        }
        Some(Value::Object(layout)) => layout,
        Some(other) => {
            c.error(
                "invalid_layout",
                target,
                "/layout",
                other.to_string(),
                "`layout` must be an object {x, y, w, h}",
            );
            return None;
        }
    };
    let integer = |key: &str| {
        layout.get(key).and_then(|value| {
            value.as_i64().or_else(|| {
                value
                    .as_f64()
                    .filter(|f| f.fract() == 0.0 && f.abs() < 1e15)
                    .map(|f| f as i64)
            })
        })
    };
    let (x, y, w, h) = (integer("x"), integer("y"), integer("w"), integer("h"));
    let mut valid = true;
    let mut fail = |key: &str, detail: String, message: String| {
        valid = false;
        c.error(
            "invalid_layout",
            target,
            join("/layout", key),
            detail,
            message,
        );
    };
    if !w.is_some_and(|w| (1..=GRID_COLUMNS).contains(&w)) {
        fail(
            "w",
            detail(layout.get("w")),
            format!("`w` must be an integer from 1 to {GRID_COLUMNS}"),
        );
    }
    if !h.is_some_and(|h| (1..=MAX_TILE_HEIGHT).contains(&h)) {
        fail(
            "h",
            detail(layout.get("h")),
            format!("`h` must be an integer from 1 to {MAX_TILE_HEIGHT}"),
        );
    }
    if !y.is_some_and(|y| (0..=MAX_TILE_ROW).contains(&y)) {
        fail(
            "y",
            detail(layout.get("y")),
            format!("`y` must be an integer from 0 to {MAX_TILE_ROW}"),
        );
    }
    let span = w.unwrap_or(1).clamp(1, GRID_COLUMNS);
    if !x.is_some_and(|x| (0..=GRID_COLUMNS - span).contains(&x)) {
        fail(
            "x",
            json!([layout.get("x"), layout.get("w")]).to_string(),
            format!("`x` must be an integer with x + w <= {GRID_COLUMNS}"),
        );
    }
    if !valid {
        // Overlap advice only considers layouts that are already valid.
        return None;
    }
    Some(Rect {
        x: x?,
        y: y?,
        w: w?,
        h: h?,
    })
}

fn check_reserved(c: &mut Checker, candidate: &Value, base: Option<&Value>) {
    let stored = base.and_then(|base| base.get(INTERNAL_METADATA_KEY));
    if candidate.get(INTERNAL_METADATA_KEY) != stored {
        c.error(
            "reserved_field",
            &PatchTarget::Dashboard,
            join("", INTERNAL_METADATA_KEY),
            String::new(),
            format!("`{INTERNAL_METADATA_KEY}` is server-internal and cannot be set or changed"),
        );
    }
}

fn string_leaves<'a>(value: &'a Value, out: &mut Vec<&'a str>) {
    match value {
        Value::String(text) => out.push(text),
        Value::Array(items) => items.iter().for_each(|item| string_leaves(item, out)),
        Value::Object(map) => map.values().for_each(|item| string_leaves(item, out)),
        _ => {}
    }
}

fn variable_names(document: &Value) -> HashSet<&str> {
    document
        .get("variables")
        .and_then(Value::as_array)
        .map(|variables| variables.iter().filter_map(variable_name).collect())
        .unwrap_or_default()
}

/// A reference to a variable that existed in the base but was removed is a new defect.
fn check_removed_variables(c: &mut Checker, candidate: &Value, base: &Value) {
    let remaining = variable_names(candidate);
    let removed: HashSet<&str> = variable_names(base)
        .into_iter()
        .filter(|name| !remaining.contains(name))
        .collect();
    if removed.is_empty() {
        return;
    }
    let report = |c: &mut Checker, target: PatchTarget, path: String, value: &Value| {
        let mut texts = Vec::new();
        string_leaves(value, &mut texts);
        let mut names: Vec<&str> = texts
            .iter()
            .flat_map(|text| referenced_names(text))
            .filter(|name| removed.contains(name))
            .collect();
        names.sort_unstable();
        names.dedup();
        for name in names {
            c.error(
                "dangling_variable_reference",
                &target,
                path.clone(),
                name.to_owned(),
                format!("references `${name}`, which this change removes"),
            );
        }
    };
    for tile in candidate
        .get("tiles")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(id) = tile_ulid(tile) else {
            continue;
        };
        for key in ["chartQuery", "dbName"] {
            if let Some(value) = tile.get(key) {
                report(
                    c,
                    PatchTarget::Tile { id: id.to_string() },
                    join("", key),
                    value,
                );
            }
        }
    }
    for variable in candidate
        .get("variables")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let (Some(name), Some(map)) = (variable_name(variable), variable.as_object()) else {
            continue;
        };
        let source = Value::String(variable_source(map));
        report(
            c,
            PatchTarget::Variable {
                name: name.to_owned(),
            },
            String::new(),
            &source,
        );
    }
}

// ---------------------------------------------------------------------------------------------
// Capabilities and schema
// ---------------------------------------------------------------------------------------------

/// Discoverable patch contract, limits, enumerations and JSON Schemas. `operationSchema` is the
/// self-contained JSON Schema of a patch request body; `operationItemSchema` is one operation.
pub fn capabilities() -> Value {
    json!({
        "version": 1,
        "patch": patch_capabilities(),
        "operationSchema": operation_schema(),
        "operationItemSchema": operation_item_schema(),
        "limits": {
            "maxOperations": MAX_OPERATIONS,
            "maxDocumentBytes": MAX_DOCUMENT_BYTES,
            "maxTiles": MAX_TILES,
            "maxSections": MAX_SECTIONS,
            "maxVariables": MAX_VARIABLES,
            "maxPointerSegments": MAX_POINTER_TOKENS,
            "maxIdBytes": MAX_ID_BYTES,
            "growth": "limits reject growth; documents already over a limit may shrink or stay the same",
        },
        "layout": {
            "columns": GRID_COLUMNS,
            "maxRow": MAX_TILE_ROW,
            "maxTileHeight": MAX_TILE_HEIGHT,
            "defaultTileSize": { "w": DEFAULT_TILE_W, "h": DEFAULT_TILE_H },
            "rules": layout_rules(),
        },
        "enums": enums(),
        "validation": {
            "structuralOnly": true,
            "executesQueries": false,
            "checksQuerySyntax": false,
            "probesDatasets": false,
            "legacyPolicy": "a defect already present in the stored document at the same target, path and value is a legacy warning; new or changed defects are errors",
            "unknownFields": "unknown and extension fields are preserved verbatim and are not validated",
        },
        "schema": dashboard_schema(),
    })
}

fn patch_capabilities() -> Value {
    json!({
        "atomic": true,
        "finalStateValidation": true,
        "dryRun": "dryRun: true returns the candidate and validation report without saving",
        "pointer": "RFC 6901 JSON Pointer relative to the target object, with RFC 6902 add/replace/remove semantics; '-' appends to arrays",
        "entityPaths": "an empty path adds, replaces (identity kept; tile layout kept when omitted) or removes the target entity",
        "ids": "ids of added entities are supplied by the client: tile ids are non-nil ULIDs, section ids opaque strings, variable names ^\\w+$",
        "operations": ["add", "replace", "remove", "placeTile", "renameVariable", "reorderSections", "removeSection"],
        "targets": ["dashboard", "tile", "section", "variable"],
        "protectedPaths": {
            "dashboard": SERVER_OWNED,
            "dashboardCollections": ENTITY_COLLECTIONS,
            "dashboardRoot": "the empty path on the dashboard target is rejected",
            "tile": ["tile_id"],
            "section": ["sectionId"],
            "variable": ["name"],
            "matching": "case-, underscore- and hyphen-insensitive after pointer unescaping",
        },
        "errorCodes": [
            "too_many_operations", "invalid_base", "invalid_target", "target_not_found",
            "ambiguous_target", "target_exists", "invalid_pointer", "path_not_found",
            "protected_path", "invalid_value", "invalid_operation", "name_conflict",
            "limit_exceeded", "document_too_large",
        ],
    })
}

fn layout_rules() -> Value {
    json!({
        "addTile": "missing layout fields default to x 0, w 6, h 4 and y below the tile's section; the section then compacts",
        "removeTile": "the section the tile left compacts",
        "fieldEdits": "generic edits under /layout or /sectionId are literal; use placeTile for moves and resizes",
        "placeTile": "the edited tile takes its destination, colliding tiles move down and the section compacts vertically; only y is written to other tiles",
        "removeSection": "unsection and move append tiles at x 0 below the destination grid, keeping their sizes",
        "legacy": "stored sizes beyond the editor bounds are never normalized and keep their full height for collisions",
    })
}

fn enums() -> Value {
    json!({
        "tileTypes": TILE_TYPES,
        "chartTypes": CHART_TYPES,
        "stackedBar": "chartType timeseries with config.type bar and config.layout.stacked true",
        "seriesStyles": SERIES_STYLES,
        "colourSchemes": COLOUR_SCHEMES,
        "legendPositions": LEGEND_POSITIONS,
        "barOrientations": BAR_ORIENTATIONS,
        "queryValueThemes": QUERY_VALUE_THEMES,
        "percentFills": PERCENT_FILLS,
        "promqlQueryModes": QUERY_MODES,
        "variableTypes": VARIABLE_TYPES,
        "labelFilterOperators": LABEL_FILTER_OPERATORS,
        "timeRangePresets": TIME_RANGE_PRESETS,
        "timeRangeTypes": TIME_RANGE_TYPES,
        "refreshIntervalsMs": REFRESH_INTERVALS,
        "dashboardTypes": DASHBOARD_TYPES,
    })
}

/// JSON Schema of the patch request body. Self-contained (no `$ref`), with the operation union
/// from [`operation_item_schema`] inlined as `operations.items`.
fn operation_schema() -> Value {
    json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "title": "DashboardPatchRequest",
        "type": "object",
        "additionalProperties": false,
        "required": ["operations"],
        "properties": {
            "operations": {
                "type": "array",
                "maxItems": MAX_OPERATIONS,
                "items": operation_item_schema(),
            },
            "dryRun": { "type": "boolean", "default": false },
            "revision": { "type": "string", "description": "expected current revision" },
        },
    })
}

/// JSON Schema of one [`DashboardOperation`], fully inline (no `$ref`), so tools can embed it as
/// the `items` of an operations array.
pub fn operation_item_schema() -> Value {
    let pointer = json!({
        "type": "string",
        "default": "",
        "description": "JSON Pointer relative to the target; empty addresses the entity",
    });
    let [place, rename, reorder, remove] = semantic_operation_schemas();
    json!({ "oneOf": [
        {
            "type": "object", "additionalProperties": false,
            "required": ["op", "target", "value"],
            "properties": {
                "op": { "enum": ["add", "replace"] },
                "target": target_schema(),
                "path": pointer,
                "value": {},
            },
        },
        {
            "type": "object", "additionalProperties": false,
            "required": ["op", "target"],
            "properties": {
                "op": { "const": "remove" },
                "target": target_schema(),
                "path": pointer,
            },
        },
        place,
        rename,
        reorder,
        remove,
    ]})
}

fn layout_edits_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "description": "omitted fields keep the tile's current value; x + w must not exceed 12",
        "properties": {
            "x": { "type": "integer", "minimum": 0, "maximum": GRID_COLUMNS - 1 },
            "y": { "type": "integer", "minimum": 0, "maximum": MAX_TILE_ROW },
            "w": { "type": "integer", "minimum": 1, "maximum": GRID_COLUMNS },
            "h": { "type": "integer", "minimum": 1, "maximum": MAX_TILE_HEIGHT },
        },
    })
}

fn target_schema() -> Value {
    json!({ "oneOf": [
        {
            "type": "object", "additionalProperties": false, "required": ["type"],
            "properties": { "type": { "const": "dashboard" } },
        },
        {
            "type": "object", "additionalProperties": false, "required": ["type", "id"],
            "properties": {
                "type": { "const": "tile" },
                "id": { "type": "string", "pattern": "^[0-7][0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{25}$" },
            },
        },
        {
            "type": "object", "additionalProperties": false, "required": ["type", "id"],
            "properties": {
                "type": { "const": "section" },
                "id": { "type": "string", "minLength": 1, "maxLength": MAX_ID_BYTES },
            },
        },
        {
            "type": "object", "additionalProperties": false, "required": ["type", "name"],
            "properties": {
                "type": { "const": "variable" },
                "name": { "type": "string", "pattern": "^\\w+$" },
            },
        },
    ]})
}

fn semantic_operation_schemas() -> [Value; 4] {
    [
        json!({
            "type": "object", "additionalProperties": false, "required": ["op", "tileId"],
            "properties": {
                "op": { "const": "placeTile" },
                "tileId": { "type": "string" },
                "sectionId": {
                    "type": ["string", "null"],
                    "description": "absent keeps the section; null or empty unsections; a string moves into that section",
                },
                "layout": layout_edits_schema(),
            },
        }),
        json!({
            "type": "object", "additionalProperties": false, "required": ["op", "from", "to"],
            "properties": {
                "op": { "const": "renameVariable" },
                "from": { "type": "string", "pattern": "^\\w+$" },
                "to": { "type": "string", "pattern": "^\\w+$" },
            },
        }),
        json!({
            "type": "object", "additionalProperties": false, "required": ["op", "sectionIds"],
            "properties": {
                "op": { "const": "reorderSections" },
                "sectionIds": { "type": "array", "items": { "type": "string" }, "uniqueItems": true },
            },
        }),
        json!({
            "type": "object", "additionalProperties": false, "required": ["op", "sectionId", "tiles"],
            "properties": {
                "op": { "const": "removeSection" },
                "sectionId": { "type": "string" },
                "tiles": { "oneOf": [
                    {
                        "type": "object", "additionalProperties": false, "required": ["mode"],
                        "properties": { "mode": { "enum": ["unsection", "delete"] } },
                    },
                    {
                        "type": "object", "additionalProperties": false, "required": ["mode", "sectionId"],
                        "properties": { "mode": { "const": "move" }, "sectionId": { "type": "string" } },
                    },
                ]},
            },
        }),
    ]
}

fn read_only(kind: &str) -> Value {
    json!({ "type": [kind, "null"], "readOnly": true })
}

fn dashboard_schema() -> Value {
    let mut properties = json!({
        "title": { "type": "string", "minLength": 1 },
        "description": { "type": "string" },
        "tags": { "type": ["array", "null"], "items": { "type": "string" } },
        "isFavorite": { "type": ["boolean", "null"] },
        "dashboardType": { "enum": ["Dashboard", "Report", null] },
        "dataset": { "type": ["string", "null"], "description": "default dataset for new tiles" },
        "timeRange": { "$ref": "#/$defs/timeRange" },
        "refreshInterval": { "enum": REFRESH_INTERVALS, "description": "saved auto-refresh default in milliseconds; 0 is off" },
        "variables": { "type": "array", "maxItems": MAX_VARIABLES, "items": { "$ref": "#/$defs/variable" } },
        "sections": { "type": "array", "maxItems": MAX_SECTIONS, "items": { "$ref": "#/$defs/section" } },
        "tiles": { "type": "array", "maxItems": MAX_TILES, "items": { "$ref": "#/$defs/tile" } },
    });
    if let Some(properties) = properties.as_object_mut() {
        for key in [
            "dashboardId",
            "author",
            "created",
            "modified",
            "version",
            "tenantId",
            "revision",
        ] {
            properties.insert(key.to_owned(), read_only("string"));
        }
    }
    json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$ref": "#/$defs/dashboard",
        "$defs": {
            "dashboard": {
                "type": "object",
                "required": ["title"],
                "additionalProperties": true,
                "properties": properties,
            },
            "timeRange": time_range_schema(),
            "section": {
                "type": "object",
                "required": ["sectionId"],
                "additionalProperties": true,
                "properties": {
                    "sectionId": { "type": "string", "minLength": 1, "maxLength": MAX_ID_BYTES },
                    "title": { "type": "string" },
                    "collapsed": { "type": "boolean" },
                },
            },
            "variable": variable_schema(),
            "tile": tile_schema(),
            "tileLayout": {
                "type": "object",
                "required": ["x", "y", "w", "h"],
                "additionalProperties": true,
                "properties": {
                    "x": { "type": "integer", "minimum": 0, "description": "x + w <= 12" },
                    "y": { "type": "integer", "minimum": 0, "maximum": MAX_TILE_ROW },
                    "w": { "type": "integer", "minimum": 1, "maximum": GRID_COLUMNS },
                    "h": { "type": "integer", "minimum": 1, "maximum": MAX_TILE_HEIGHT },
                },
            },
            "tileConfig": tile_config_schema(),
            "chartLayout": chart_layout_schema(),
            "axis": {
                "type": "object",
                "additionalProperties": true,
                "properties": {
                    "field": { "type": ["string", "array"], "items": { "type": "string" } },
                    "title": { "type": "string" },
                    "display": { "type": "boolean" },
                    "beginAtZero": { "type": "boolean" },
                },
            },
        },
    })
}

fn time_range_schema() -> Value {
    json!({
        "type": ["object", "null"],
        "required": ["startTime", "endTime"],
        "additionalProperties": true,
        "properties": {
            "startTime": { "type": "string", "description": "a preset (10m, 30m, 1h, 5h, 1d, 3d) for fixed ranges, RFC 3339 for custom" },
            "endTime": { "type": "string", "description": "'now' for fixed ranges, RFC 3339 for custom" },
            "type": { "enum": TIME_RANGE_TYPES },
            "label": { "type": "string" },
            "interval": { "type": "number", "description": "range length in milliseconds" },
            "shiftInterval": { "type": "number" },
        },
    })
}

fn variable_schema() -> Value {
    json!({
        "type": "object",
        "required": ["name", "label", "type"],
        "additionalProperties": true,
        "description": "promql needs dataset and labelName; promql_query needs promqlQuery and promqlQueryDataset; sql needs sqlQuery; list needs options. Reference variables as $name or ${name}.",
        "properties": {
            "name": { "type": "string", "pattern": "^\\w+$" },
            "label": { "type": "string" },
            "type": { "enum": VARIABLE_TYPES },
            "dataset": { "type": "string" },
            "labelName": { "type": "string" },
            "metric": { "type": "string" },
            "labelFilters": {
                "type": "array",
                "items": {
                    "type": "object",
                    "required": ["label", "operator", "value"],
                    "properties": {
                        "label": { "type": "string" },
                        "operator": { "enum": LABEL_FILTER_OPERATORS },
                        "value": { "type": "string" },
                    },
                },
            },
            "options": { "type": "array", "items": { "type": "string" } },
            "sqlQuery": { "type": "string" },
            "promqlQuery": { "type": "string" },
            "promqlQueryDataset": { "type": "string" },
            "promqlQueryLabel": { "type": "string" },
            "includeAll": { "type": "boolean" },
            "defaultValue": { "type": "string" },
        },
    })
}

fn tile_schema() -> Value {
    json!({
        "type": "object",
        "required": ["tile_id"],
        "additionalProperties": true,
        "description": "code tiles store chartQuery as one SQL string; builder tiles store an SQL string or the visual builder object {x: {fields, groupBy, granularity}, y: {fields: [{name, aggregate}], groupBy, limit, sortBy}, filters: [{column, operator, value}]}; promql tiles store one query string or an array with promqlQueryType per query.",
        "properties": {
            "tile_id": { "type": "string", "description": "non-nil ULID" },
            "title": { "type": "string" },
            "authorMode": { "type": "string" },
            "tileType": { "enum": TILE_TYPES, "default": "builder" },
            "chartType": { "enum": CHART_TYPES, "default": "timeseries" },
            "chartQuery": { "type": ["string", "array", "object"], "items": { "type": "string" } },
            "promqlQueryType": { "oneOf": [
                { "enum": QUERY_MODES },
                { "type": "array", "items": { "enum": QUERY_MODES } },
            ]},
            "promqlStep": { "type": ["string", "number"], "description": "duration such as 30s, or seconds" },
            "dbName": { "type": ["string", "array"], "items": { "type": "string" } },
            "sectionId": { "type": ["string", "null"] },
            "layout": { "$ref": "#/$defs/tileLayout" },
            "config": { "$ref": "#/$defs/tileConfig" },
        },
    })
}

fn tile_config_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": true,
        "properties": {
            "type": { "type": "string", "description": "series style (line, bar, area) for timeseries; otherwise the chart type" },
            "colourScheme": { "enum": COLOUR_SCHEMES },
            "maxDataPoints": { "type": "number", "exclusiveMinimum": 0 },
            "layout": { "$ref": "#/$defs/chartLayout" },
            "axes": {
                "type": "object",
                "additionalProperties": true,
                "properties": {
                    "x": { "$ref": "#/$defs/axis" },
                    "y": { "$ref": "#/$defs/axis" },
                    "size": { "$ref": "#/$defs/axis" },
                    "groupBy": { "$ref": "#/$defs/axis" },
                },
            },
            "advanced": {
                "type": "object",
                "additionalProperties": true,
                "properties": {
                    "dataLabels": { "type": "object", "properties": { "enabled": { "type": "boolean" } } },
                    "tooltip": {
                        "type": "object",
                        "properties": {
                            "enabled": { "type": "boolean" },
                            "mode": { "type": "string" },
                            "intersect": { "type": "boolean" },
                        },
                    },
                },
            },
        },
    })
}

fn chart_layout_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": true,
        "description": "Display and conditional styling. Gauges colour green/yellow/red by up to two increasing segment thresholds (percent of range, or absolute within rangeFrom..rangeTo).",
        "properties": {
            "legendPosition": { "enum": LEGEND_POSITIONS },
            "label": { "type": "boolean" },
            "stacked": { "type": "boolean" },
            "barOrientation": { "enum": BAR_ORIENTATIONS },
            "sparkline": { "type": "boolean" },
            "queryValueTheme": { "enum": QUERY_VALUE_THEMES },
            "percentFill": { "enum": PERCENT_FILLS },
            "unit": { "type": "string" },
            "precision": { "type": "integer", "minimum": -1, "maximum": 20 },
            "humanize": { "type": "boolean" },
            "rangeFrom": { "type": "number" },
            "rangeTo": { "type": "number" },
            "segments": {
                "type": "object",
                "properties": {
                    "value": { "type": "array", "items": { "type": "number" } },
                    "isPercent": { "type": "boolean" },
                },
            },
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const CLASSIC: &str =
        include_str!("../../frontend/src/features/dashboards/__fixtures__/classic.json");
    const HOST_LOAD: &str = "01JZ8Y5R7B2K9WQ0X4F6M1T3HD";
    const ERRORS: &str = "01JZ8Y4A0C7H3GQ5P2W9D8S6VF";
    const AI: &str = "01JZ8Y4A0C7H3GQ5P2W9D8S6VG";

    fn classic() -> Value {
        serde_json::from_str(CLASSIC).unwrap()
    }

    fn ops(value: Value) -> Vec<DashboardOperation> {
        serde_json::from_value(value).unwrap()
    }

    fn apply(base: &Value, operations: Value) -> Value {
        apply_patch(base, &ops(operations)).unwrap()
    }

    fn apply_err(base: &Value, operations: Value) -> PatchError {
        apply_patch(base, &ops(operations)).unwrap_err()
    }

    fn id(n: u32) -> String {
        format!("01JZ8Y5R7B2K9WQ0X4F6M{n:05}")
    }

    fn tile(n: u32, x: i64, y: i64, w: i64, h: i64) -> Value {
        json!({ "tile_id": id(n), "layout": { "x": x, "y": y, "w": w, "h": h, "future": true } })
    }

    fn doc(tiles: Vec<Value>) -> Value {
        json!({ "title": "Layout", "tiles": tiles })
    }

    fn tile_ref(id: &str) -> Value {
        json!({ "type": "tile", "id": id })
    }

    fn ys(document: &Value) -> Vec<i64> {
        document["tiles"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tile| tile["layout"]["y"].as_i64().unwrap())
            .collect()
    }

    /// Reading order of the stored layouts.
    fn order(document: &Value) -> Vec<String> {
        let mut tiles: Vec<&Value> = document["tiles"].as_array().unwrap().iter().collect();
        tiles.sort_by_key(|tile| (tile["layout"]["y"].as_i64(), tile["layout"]["x"].as_i64()));
        tiles
            .iter()
            .map(|tile| tile["tile_id"].as_str().unwrap().to_owned())
            .collect()
    }

    fn codes(issues: &[ValidationIssue]) -> Vec<&str> {
        issues.iter().map(|issue| issue.code.as_str()).collect()
    }

    #[test]
    fn request_wire_shape_round_trips_and_rejects_unknown_fields() {
        let request: DashboardPatchRequest = serde_json::from_value(json!({
            "dryRun": true,
            "revision": "abc",
            "operations": [
                { "op": "add", "target": tile_ref(&id(1)), "value": { "title": "t" } },
                { "op": "replace", "target": { "type": "dashboard" }, "path": "/title", "value": "x" },
                { "op": "remove", "target": { "type": "variable", "name": "host" }, "path": "/label" },
                { "op": "placeTile", "tileId": id(1), "sectionId": null, "layout": { "w": 12 } },
                { "op": "renameVariable", "from": "a", "to": "b" },
                { "op": "reorderSections", "sectionIds": ["a", "b"] },
                { "op": "removeSection", "sectionId": "a", "tiles": { "mode": "move", "sectionId": "b" } },
            ],
        }))
        .unwrap();
        assert!(request.dry_run);
        assert_eq!(request.revision.as_deref(), Some("abc"));
        assert_eq!(
            request.operations[0],
            DashboardOperation::Add {
                target: PatchTarget::Tile { id: id(1) },
                path: String::new(),
                value: json!({ "title": "t" }),
            }
        );
        assert_eq!(
            request.operations[3],
            DashboardOperation::PlaceTile {
                tile_id: id(1),
                section_id: Some(None),
                layout: Some(LayoutEdits {
                    w: Some(12),
                    ..LayoutEdits::default()
                }),
            }
        );
        let again: DashboardPatchRequest =
            serde_json::from_value(serde_json::to_value(&request).unwrap()).unwrap();
        assert_eq!(again, request);
        for invalid in [
            json!({ "operations": [], "dryrun": true }),
            json!({ "operations": [{ "op": "removeSection", "sectionId": "a" }] }),
            json!({ "operations": [{ "op": "add", "target": { "type": "dashboard" }, "path": "/a" }] }),
            json!({ "operations": [{ "op": "placeTile", "tileId": id(1), "layout": { "x": 1.5 } }] }),
            json!({ "operations": [{ "op": "merge", "target": { "type": "dashboard" } }] }),
        ] {
            assert!(
                serde_json::from_value::<DashboardPatchRequest>(invalid.clone()).is_err(),
                "{invalid}"
            );
        }
    }

    #[test]
    fn generic_edits_preserve_unknown_fields() {
        let base = classic();
        let candidate = apply(
            &base,
            json!([
                { "op": "replace", "target": tile_ref(HOST_LOAD), "path": "/title", "value": "CPU load" },
                { "op": "add", "target": tile_ref(HOST_LOAD), "path": "/config/layout/unit", "value": "%" },
                { "op": "add", "target": { "type": "dashboard" }, "path": "/refreshInterval", "value": 60000 },
                { "op": "add", "target": { "type": "section", "id": "classic-section" }, "path": "/title", "value": "Hosts" },
            ]),
        );
        let mut expected = base.clone();
        expected["tiles"][0]["title"] = json!("CPU load");
        expected["tiles"][0]["config"]["layout"]["unit"] = json!("%");
        expected["refreshInterval"] = json!(60000);
        expected["sections"][0]["title"] = json!("Hosts");
        assert_eq!(candidate, expected);
        let report = validate_dashboard(&candidate, Some(&base));
        assert!(report.valid, "{report:?}");
    }

    #[test]
    fn missing_locations_fail_with_operation_context() {
        let base = classic();
        let error = apply_err(
            &base,
            json!([
                { "op": "replace", "target": { "type": "dashboard" }, "path": "/title", "value": "Renamed" },
                { "op": "replace", "target": tile_ref(ERRORS), "path": "/config/missing/key", "value": 1 },
            ]),
        );
        assert_eq!(error.code, PatchErrorCode::PathNotFound);
        assert_eq!(error.operation_index, Some(1));
        assert_eq!(
            error.target,
            Some(PatchTarget::Tile {
                id: ERRORS.to_owned()
            })
        );
        assert_eq!(error.path.as_deref(), Some("/config/missing/key"));
        for (operations, code) in [
            (
                json!([{ "op": "remove", "target": tile_ref(ERRORS), "path": "/nope" }]),
                PatchErrorCode::PathNotFound,
            ),
            (
                json!([{ "op": "replace", "target": tile_ref(ERRORS), "path": "/dbName/5", "value": "x" }]),
                PatchErrorCode::PathNotFound,
            ),
            (
                json!([{ "op": "remove", "target": tile_ref(&id(77)) }]),
                PatchErrorCode::TargetNotFound,
            ),
            (
                json!([{ "op": "replace", "target": { "type": "variable", "name": "nope" }, "path": "/label", "value": "x" }]),
                PatchErrorCode::TargetNotFound,
            ),
        ] {
            assert_eq!(apply_err(&base, operations).code, code);
        }
    }

    #[test]
    fn failed_batches_are_atomic_and_invalid_final_states_are_reported() {
        let base = classic();
        let before = base.clone();
        let error = apply_err(
            &base,
            json!([
                { "op": "replace", "target": { "type": "dashboard" }, "path": "/title", "value": "Renamed" },
                { "op": "remove", "target": { "type": "section", "id": "classic-section" } },
            ]),
        );
        assert_eq!(error.code, PatchErrorCode::InvalidOperation);
        assert_eq!(error.operation_index, Some(1));
        assert_eq!(base, before);

        let candidate = apply(
            &base,
            json!([
                { "op": "replace", "target": { "type": "dashboard" }, "path": "/title", "value": "Renamed" },
                { "op": "replace", "target": tile_ref(ERRORS), "path": "/chartType", "value": "sparkle" },
            ]),
        );
        let report = validate_dashboard(&candidate, Some(&base));
        assert!(!report.valid);
        assert_eq!(codes(&report.errors), ["unsupported_chart_type"]);
        assert_eq!(
            report.errors[0].target,
            PatchTarget::Tile {
                id: ERRORS.to_owned()
            }
        );
        assert_eq!(report.errors[0].path, "/chartType");
    }

    #[test]
    fn sql_tile_converts_to_multi_query_promql_in_one_batch() {
        let base = classic();
        let operations = ops(json!([
            { "op": "replace", "target": tile_ref(ERRORS), "path": "/chartQuery", "value": ["sum(rate(http_requests_total[5m]))", "up"] },
            { "op": "add", "target": tile_ref(ERRORS), "path": "/promqlQueryType", "value": ["range", "instant"] },
            { "op": "replace", "target": tile_ref(ERRORS), "path": "/tileType", "value": "promql" },
            { "op": "replace", "target": tile_ref(ERRORS), "path": "/dbName", "value": ["otel-metrics"] },
            { "op": "replace", "target": tile_ref(ERRORS), "path": "/chartType", "value": "timeseries" },
        ]));
        let partial = apply_patch(&base, &operations[..1]).unwrap();
        let report = validate_dashboard(&partial, Some(&base));
        assert!(
            codes(&report.errors).contains(&"invalid_query_shape"),
            "{report:?}"
        );

        let candidate = apply_patch(&base, &operations).unwrap();
        let report = validate_dashboard(&candidate, Some(&base));
        assert!(report.valid, "{report:?}");
        assert_eq!(candidate["tiles"][1]["config"], base["tiles"][1]["config"]);

        let mismatched = apply(
            &candidate,
            json!([{ "op": "replace", "target": tile_ref(ERRORS), "path": "/promqlQueryType", "value": ["range"] }]),
        );
        let report = validate_dashboard(&mismatched, Some(&candidate));
        assert_eq!(codes(&report.errors), ["invalid_query_mode"]);
    }

    #[test]
    fn server_owned_identity_and_internal_paths_are_protected() {
        let mut base = classic();
        base[INTERNAL_METADATA_KEY] = json!({ "version": 3 });
        let dashboard = json!({ "type": "dashboard" });
        let section = json!({ "type": "section", "id": "classic-section" });
        let variable = json!({ "type": "variable", "name": "host" });
        for (target, path) in [
            (&dashboard, ""),
            (&dashboard, "/dashboardId"),
            (&dashboard, "/dashboard_id"),
            (&dashboard, "/Author"),
            (&dashboard, "/tenant-id"),
            (&dashboard, "/revision"),
            (&dashboard, "/created"),
            (&dashboard, "/_parseableDashboard"),
            (&dashboard, "/_PARSEABLE_dashboard/version"),
            (&dashboard, "/tiles/0/title"),
            (&dashboard, "/Variables"),
            (&tile_ref(HOST_LOAD), "/tile_id"),
            (&tile_ref(HOST_LOAD), "/tileId"),
            (&section, "/sectionId"),
            (&variable, "/name"),
        ] {
            for op in ["add", "replace", "remove"] {
                let mut operation = json!({ "op": op, "target": target, "path": path });
                if op != "remove" {
                    operation["value"] = json!("x");
                }
                let error = apply_err(&base, json!([operation]));
                assert_eq!(error.code, PatchErrorCode::ProtectedPath, "{op} {path}");
            }
        }
        for path in ["/tile~2id", "title", "/a~"] {
            let error = apply_err(
                &base,
                json!([{ "op": "add", "target": tile_ref(HOST_LOAD), "path": path, "value": 1 }]),
            );
            assert_eq!(error.code, PatchErrorCode::InvalidPointer, "{path}");
        }
        for value in [
            json!({ "tile_id": id(8) }),
            json!({ "tileId": id(9) }),
            json!("tile"),
        ] {
            let error = apply_err(
                &base,
                json!([{ "op": "add", "target": tile_ref(&id(9)), "value": value }]),
            );
            assert_eq!(error.code, PatchErrorCode::InvalidValue);
        }

        let replaced = apply(
            &base,
            json!([{ "op": "replace", "target": tile_ref(HOST_LOAD), "value": { "title": "New", "tileType": "code", "chartQuery": "SELECT 1" } }]),
        );
        assert_eq!(replaced["tiles"][0]["tile_id"], HOST_LOAD);
        assert_eq!(replaced["tiles"][0]["layout"], base["tiles"][0]["layout"]);
        assert_eq!(replaced[INTERNAL_METADATA_KEY], base[INTERNAL_METADATA_KEY]);
        assert!(validate_dashboard(&replaced, Some(&base)).valid);

        let mut tampered = replaced.clone();
        tampered[INTERNAL_METADATA_KEY] = json!({ "version": 4 });
        let report = validate_dashboard(&tampered, Some(&base));
        assert_eq!(codes(&report.errors), ["reserved_field"]);
        assert!(codes(&validate_dashboard(&base, None).errors).contains(&"reserved_field"));
        strip_internal_metadata(&mut tampered);
        assert!(tampered.get(INTERNAL_METADATA_KEY).is_none());
    }

    #[test]
    fn rename_variable_rewrites_references_and_rejects_collisions() {
        let base = classic();
        let candidate = apply(
            &base,
            json!([{ "op": "renameVariable", "from": "metrics_dataset", "to": "metrics" }]),
        );
        assert_eq!(candidate["variables"][0]["name"], "metrics");
        assert_eq!(candidate["variables"][0]["customVariable"], true);
        assert_eq!(candidate["variables"][1]["dataset"], "$metrics");
        assert_eq!(candidate["variables"][2]["promqlQueryDataset"], "$metrics");
        assert_eq!(candidate["tiles"][0]["dbName"], "$metrics");
        assert!(validate_dashboard(&candidate, Some(&base)).valid);

        let renamed = apply(
            &base,
            json!([{ "op": "renameVariable", "from": "host", "to": "server" }]),
        );
        assert_eq!(
            renamed["tiles"][0]["chartQuery"][0],
            "avg by (host) ({__name__=\"system.cpu.load_average.15m\",host=~\"$server\"})"
        );

        let error = apply_err(
            &base,
            json!([{ "op": "renameVariable", "from": "host", "to": "result" }]),
        );
        assert_eq!(error.code, PatchErrorCode::NameConflict);
        assert_eq!(
            error.target,
            Some(PatchTarget::Variable {
                name: "result".to_owned()
            })
        );
        let error = apply_err(
            &base,
            json!([{ "op": "renameVariable", "from": "nope", "to": "x" }]),
        );
        assert_eq!(error.code, PatchErrorCode::TargetNotFound);
        assert_eq!(
            rename_tokens("${host} $hostname $$host x$host", "host", "h").as_deref(),
            Some("${h} $hostname $$h x$h")
        );

        let removed = apply(
            &base,
            json!([{ "op": "remove", "target": { "type": "variable", "name": "host" } }]),
        );
        let report = validate_dashboard(&removed, Some(&base));
        assert_eq!(codes(&report.errors), ["dangling_variable_reference"]);
        assert_eq!(
            report.errors[0].target,
            PatchTarget::Tile {
                id: HOST_LOAD.to_owned()
            }
        );
    }

    fn mixed() -> Value {
        doc(vec![
            tile(1, 0, 0, 6, 8),
            tile(2, 6, 0, 6, 4),
            tile(3, 6, 4, 6, 4),
            tile(4, 0, 8, 12, 4),
        ])
    }

    fn place(n: u32, layout: Value) -> Value {
        json!([{ "op": "placeTile", "tileId": id(n), "layout": layout }])
    }

    #[test]
    fn layout_matches_frontend_resize_remove_and_drag() {
        let base = mixed();
        assert_eq!(
            ys(&apply(&base, place(2, json!({ "h": 8 })))),
            [0, 0, 8, 12]
        );
        let removed = apply(
            &base,
            json!([{ "op": "remove", "target": tile_ref(&id(2)) }]),
        );
        assert_eq!(ys(&removed), [0, 0, 8]);

        let widened = apply(&base, place(2, json!({ "x": 4, "w": 8 })));
        let rects: Vec<Rect> = widened["tiles"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tile| {
                let n = |key: &str| tile["layout"][key].as_i64().unwrap();
                Rect {
                    x: n("x"),
                    y: n("y"),
                    w: n("w"),
                    h: n("h"),
                }
            })
            .collect();
        for (i, a) in rects.iter().enumerate() {
            for b in &rects[i + 1..] {
                assert!(!a.overlaps(b), "{a:?} {b:?}");
            }
        }

        let source = doc(vec![
            tile(1, 0, 0, 12, 4),
            tile(2, 0, 4, 12, 4),
            tile(3, 0, 8, 12, 4),
        ]);
        assert_eq!(
            order(&apply(&source, place(1, json!({ "x": 0, "y": 4 })))),
            [id(2), id(1), id(3)]
        );
        assert_eq!(
            order(&apply(&source, place(3, json!({ "x": 0, "y": 0 })))),
            [id(3), id(1), id(2)]
        );
        assert_eq!(
            source["tiles"][0]["layout"],
            json!({ "x": 0, "y": 0, "w": 12, "h": 4, "future": true })
        );
    }

    #[test]
    fn resize_preserves_opaque_and_legacy_layout_fields() {
        let mut first = tile(1, 8, 0, 4, 4);
        first["custom"] = json!({ "untouched": true });
        let second = json!({ "tile_id": id(2), "layout": { "x": -7, "y": 0, "w": 8, "h": 30, "future": true } });
        let base = doc(vec![first, second]);
        let candidate = apply(&base, place(1, json!({ "w": 12, "h": 6 })));
        assert_eq!(
            candidate["tiles"][0],
            json!({ "tile_id": id(1), "custom": { "untouched": true }, "layout": { "x": 0, "y": 0, "w": 12, "h": 6, "future": true } })
        );
        assert_eq!(
            candidate["tiles"][1]["layout"],
            json!({ "x": -7, "y": 6, "w": 8, "h": 30, "future": true })
        );
        let report = validate_dashboard(&candidate, Some(&base));
        assert!(report.valid, "{report:?}");
        let legacy: Vec<&str> = report
            .warnings
            .iter()
            .filter(|issue| issue.legacy)
            .map(|issue| issue.path.as_str())
            .collect();
        assert!(
            legacy.contains(&"/layout/x") && legacy.contains(&"/layout/h"),
            "{legacy:?}"
        );

        for (edits, path) in [
            (json!({ "w": 99 }), "/layout/w"),
            (json!({ "h": 25 }), "/layout/h"),
            (json!({ "x": 9, "w": 6 }), "/layout/x"),
            (json!({ "y": -1 }), "/layout/y"),
        ] {
            let error = apply_err(&base, place(1, edits));
            assert_eq!(error.code, PatchErrorCode::InvalidValue);
            assert_eq!(error.path.as_deref(), Some(path));
        }

        let untouched = doc(vec![
            json!({ "tile_id": id(1), "layout": { "x": -2, "y": 12, "w": 6, "h": 4 } }),
        ]);
        assert_eq!(
            apply(&untouched, place(1, json!({ "x": 0, "y": 0 }))),
            untouched
        );
    }

    #[test]
    fn huge_layout_coordinates_are_rejected_without_overflow() {
        for x in [json!(i64::MAX), json!(u64::MAX), json!(-1), json!(7)] {
            let document = doc(vec![
                json!({ "tile_id": id(1), "layout": { "x": x, "y": 0, "w": 6, "h": 4 } }),
            ]);
            let report = validate_dashboard(&document, None);
            assert_eq!(codes(&report.errors), ["invalid_layout"], "{x}");
            assert_eq!(report.errors[0].path, "/layout/x");
        }
    }

    fn sectioned() -> Value {
        json!({
            "title": "Sections",
            "extra": { "preserved": true },
            "sections": [
                { "sectionId": "a", "title": "Alpha", "future": 9 },
                { "opaque": true },
                { "sectionId": "b", "title": "Beta" },
            ],
            "tiles": [
                { "tile_id": id(1), "layout": { "x": 0, "y": 0, "w": 12, "h": 4 } },
                { "tile_id": id(2), "sectionId": "a", "layout": { "x": 0, "y": 0, "w": 6, "h": 4, "future": true } },
                { "tile_id": id(3), "sectionId": "b", "layout": { "x": 0, "y": 0, "w": 6, "h": 4 } },
            ],
        })
    }

    #[test]
    fn sections_move_remove_and_reorder_like_the_frontend() {
        let base = sectioned();
        let moved = apply(
            &base,
            json!([{ "op": "placeTile", "tileId": id(2), "sectionId": "b" }]),
        );
        assert_eq!(
            moved["tiles"][1],
            json!({ "tile_id": id(2), "sectionId": "b", "layout": { "x": 0, "y": 4, "w": 6, "h": 4, "future": true } })
        );
        assert_eq!(moved["tiles"][0], base["tiles"][0]);
        assert_eq!(moved["tiles"][2], base["tiles"][2]);

        let remove =
            |tiles: Value| json!([{ "op": "removeSection", "sectionId": "a", "tiles": tiles }]);
        let unsectioned = apply(&base, remove(json!({ "mode": "unsection" })));
        assert_eq!(
            unsectioned["sections"],
            json!([{ "opaque": true }, { "sectionId": "b", "title": "Beta" }])
        );
        assert_eq!(
            unsectioned["tiles"][1],
            json!({ "tile_id": id(2), "layout": { "x": 0, "y": 4, "w": 6, "h": 4, "future": true } })
        );
        assert_eq!(unsectioned["tiles"][2], base["tiles"][2]);
        assert_eq!(unsectioned["extra"], base["extra"]);

        let mut tall = base.clone();
        tall["tiles"][0]["layout"]["h"] = json!(50);
        assert_eq!(
            apply(&tall, remove(json!({ "mode": "unsection" })))["tiles"][1]["layout"]["y"],
            50
        );

        let relocated = apply(&base, remove(json!({ "mode": "move", "sectionId": "b" })));
        assert_eq!(relocated["tiles"][1]["sectionId"], "b");
        assert_eq!(relocated["tiles"][1]["layout"]["y"], 4);
        let deleted = apply(&base, remove(json!({ "mode": "delete" })));
        assert_eq!(order(&deleted), [id(1), id(3)]);
        assert_eq!(
            apply_err(&base, remove(json!({ "mode": "move", "sectionId": "a" }))).code,
            PatchErrorCode::InvalidOperation
        );
        assert_eq!(
            apply_err(&base, remove(json!({ "mode": "move", "sectionId": "zzz" }))).code,
            PatchErrorCode::TargetNotFound
        );

        let reordered = apply(
            &base,
            json!([{ "op": "reorderSections", "sectionIds": ["b", "a"] }]),
        );
        assert_eq!(
            reordered["sections"],
            json!([{ "sectionId": "b", "title": "Beta" }, { "opaque": true }, { "sectionId": "a", "title": "Alpha", "future": 9 }])
        );
        assert_eq!(
            apply_err(
                &base,
                json!([{ "op": "reorderSections", "sectionIds": ["b"] }])
            )
            .code,
            PatchErrorCode::InvalidOperation
        );
        assert_eq!(
            apply_err(
                &base,
                json!([{ "op": "reorderSections", "sectionIds": ["b", "zzz"] }])
            )
            .code,
            PatchErrorCode::TargetNotFound
        );
        assert_eq!(
            apply_err(
                &base,
                json!([{ "op": "placeTile", "tileId": id(1), "sectionId": "zzz" }])
            )
            .code,
            PatchErrorCode::TargetNotFound
        );
    }

    #[test]
    fn added_entities_get_ids_defaults_and_compaction() {
        let base = doc(vec![tile(1, 0, 0, 6, 4), tile(2, 6, 0, 6, 8)]);
        let candidate = apply(
            &base,
            json!([
                { "op": "add", "target": tile_ref(&id(3)), "value": { "title": "Rows", "tileType": "code", "chartType": "table", "chartQuery": "SELECT 1", "dbName": ["app-logs"] } },
                { "op": "add", "target": { "type": "section", "id": "ops" }, "value": { "title": "Ops" } },
                { "op": "add", "target": { "type": "variable", "name": "env" }, "value": { "label": "Env", "type": "list", "options": ["prod"] } },
            ]),
        );
        assert_eq!(candidate["tiles"][2]["tile_id"], id(3));
        assert_eq!(
            candidate["tiles"][2]["layout"],
            json!({ "x": 0, "y": 4, "w": 6, "h": 4 })
        );
        assert_eq!(
            candidate["sections"],
            json!([{ "sectionId": "ops", "title": "Ops" }])
        );
        assert_eq!(candidate["variables"][0]["name"], "env");
        let report = validate_dashboard(&candidate, Some(&base));
        assert!(report.valid, "{report:?}");

        let add = |target: &str| json!([{ "op": "add", "target": tile_ref(target), "value": {} }]);
        assert_eq!(
            apply_err(&base, add(&id(1))).code,
            PatchErrorCode::TargetExists
        );
        assert_eq!(
            apply_err(&base, add("00000000000000000000000000")).code,
            PatchErrorCode::InvalidTarget
        );
        assert_eq!(
            apply_err(&base, add("not-a-ulid")).code,
            PatchErrorCode::InvalidTarget
        );
    }

    #[test]
    fn untouched_legacy_defects_warn_while_new_ones_fail() {
        let base = classic();
        let fresh = validate_dashboard(&base, None);
        assert_eq!(codes(&fresh.errors), ["unsupported_tile_type"]);
        let unchanged = validate_dashboard(&base, Some(&base));
        assert!(unchanged.valid);
        assert!(
            unchanged
                .warnings
                .iter()
                .any(|issue| issue.legacy && issue.code == "unsupported_tile_type")
        );

        let retitled = apply(
            &base,
            json!([{ "op": "replace", "target": tile_ref(AI), "path": "/title", "value": "Summary" }]),
        );
        assert!(validate_dashboard(&retitled, Some(&base)).valid);
        let changed = apply(
            &base,
            json!([{ "op": "replace", "target": tile_ref(AI), "path": "/tileType", "value": "ai2" }]),
        );
        assert!(!validate_dashboard(&changed, Some(&base)).valid);
    }

    #[test]
    fn legacy_duplicates_are_grandfathered_by_count() {
        let titled = |title: &str| {
            let mut tile = tile(1, 0, 0, 6, 4);
            tile["title"] = json!(title);
            tile
        };
        let base = doc(vec![titled("a"), titled("b")]);
        assert!(validate_dashboard(&base, Some(&base)).valid);
        assert_eq!(
            apply_err(&base, json!([{ "op": "replace", "target": tile_ref(&id(1)), "path": "/title", "value": "c" }])).code,
            PatchErrorCode::AmbiguousTarget
        );
        let grown = doc(vec![titled("a"), titled("b"), titled("c")]);
        let report = validate_dashboard(&grown, Some(&base));
        assert_eq!(codes(&report.errors), ["duplicate_tile_id"]);
        assert_eq!(
            report
                .warnings
                .iter()
                .filter(|issue| issue.code == "duplicate_tile_id")
                .count(),
            1
        );
    }

    #[test]
    fn limits_reject_growth_but_allow_legacy_shrinking() {
        let replace = json!({ "op": "replace", "target": { "type": "dashboard" }, "path": "/title", "value": "x" });
        let error = apply_err(
            &doc(vec![]),
            Value::Array(vec![replace; MAX_OPERATIONS + 1]),
        );
        assert_eq!(error.code, PatchErrorCode::TooManyOperations);

        let many = |count: u32| {
            doc((0..count)
                .map(|n| tile(n, 0, i64::from(n) * 4, 12, 4))
                .collect())
        };
        let base = many(501);
        assert_eq!(
            codes(&validate_dashboard(&many(502), Some(&base)).errors),
            ["limit_exceeded"]
        );
        assert_eq!(
            codes(&validate_dashboard(&many(1000), Some(&base)).errors),
            ["limit_exceeded"]
        );
        assert!(validate_dashboard(&many(501), Some(&base)).valid);
        assert!(validate_dashboard(&many(400), Some(&base)).valid);
        assert_eq!(
            codes(&validate_dashboard(&many(501), None).errors),
            ["limit_exceeded"]
        );
        let error = apply_err(
            &base,
            json!([{ "op": "add", "target": tile_ref(&id(900)), "value": {} }]),
        );
        assert_eq!(error.code, PatchErrorCode::LimitExceeded);

        let small = doc(vec![]);
        let huge = json!([{ "op": "add", "target": tile_ref(&id(1)), "value": { "title": "x".repeat(MAX_DOCUMENT_BYTES) } }]);
        assert_eq!(
            apply_err(&small, huge).code,
            PatchErrorCode::DocumentTooLarge
        );
        let mut oversized = small.clone();
        oversized["description"] = json!("x".repeat(MAX_DOCUMENT_BYTES));
        assert_eq!(
            codes(&validate_dashboard(&oversized, Some(&small)).errors),
            ["document_too_large"]
        );
        assert!(validate_dashboard(&oversized, Some(&oversized)).valid);
    }

    #[test]
    fn long_variable_chains_validate_without_recursion() {
        let chain = |cycle: bool| {
            let count = 20_000;
            let variables: Vec<Value> = (0..count)
                .map(|i| {
                    let next = if cycle && i + 1 == count { 0 } else { i + 1 };
                    json!({ "name": format!("v{i}"), "label": "v", "type": "sql", "sqlQuery": format!("SELECT $v{next}") })
                })
                .collect();
            json!({ "title": "Chain", "variables": variables })
        };
        let cycles = |document: &Value| {
            check_document(document)
                .iter()
                .filter(|finding| finding.issue.code == "variable_cycle")
                .count()
        };
        assert_eq!(cycles(&chain(false)), 0);
        assert_eq!(cycles(&chain(true)), 1);
        let legacy = chain(true);
        assert!(validate_dashboard(&legacy, Some(&legacy)).valid);
        assert_eq!(
            codes(&validate_dashboard(&legacy, None).errors),
            ["limit_exceeded"]
        );

        let small = json!({ "title": "Cycle", "variables": [
            { "name": "a", "label": "a", "type": "sql", "sqlQuery": "SELECT $b" },
            { "name": "b", "label": "b", "type": "sql", "sqlQuery": "SELECT ${a}" },
        ]});
        assert_eq!(
            codes(&validate_dashboard(&small, None).errors),
            ["variable_cycle"]
        );
    }

    fn gauge(layout: Value) -> Value {
        json!({ "title": "Gauge", "tiles": [{
            "tile_id": id(1), "tileType": "code", "chartType": "gauge", "chartQuery": "SELECT 1",
            "dbName": ["logs"], "layout": { "x": 0, "y": 0, "w": 6, "h": 4 },
            "config": { "type": "gauge", "colourScheme": "classic", "layout": layout },
        }]})
    }

    #[test]
    fn styling_thresholds_and_enums_are_validated() {
        let valid = gauge(
            json!({ "rangeFrom": 0, "rangeTo": 200, "segments": { "value": [50, 150], "isPercent": false }, "unit": "ms", "precision": 2 }),
        );
        assert!(
            validate_dashboard(&valid, None).valid,
            "{:?}",
            validate_dashboard(&valid, None)
        );
        for (layout, code) in [
            (
                json!({ "segments": { "value": [150, 50], "isPercent": false }, "rangeTo": 200 }),
                "invalid_segments",
            ),
            (
                json!({ "segments": { "value": [10, 120], "isPercent": true } }),
                "invalid_segments",
            ),
            (
                json!({ "segments": { "value": "high" } }),
                "invalid_segments",
            ),
            (
                json!({ "rangeFrom": 10, "rangeTo": 10 }),
                "invalid_gauge_range",
            ),
            (json!({ "queryValueTheme": "neon" }), "invalid_field_value"),
            (json!({ "percentFill": "radial" }), "invalid_field_value"),
            (json!({ "precision": 40 }), "invalid_field_value"),
        ] {
            let report = validate_dashboard(&gauge(layout.clone()), None);
            assert!(codes(&report.errors).contains(&code), "{layout} {report:?}");
        }
        let mut scheme = valid.clone();
        scheme["tiles"][0]["config"]["colourScheme"] = json!("rainbow");
        assert_eq!(
            codes(&validate_dashboard(&scheme, None).errors),
            ["unknown_colour_scheme"]
        );
    }

    #[test]
    fn time_range_refresh_and_variables_are_validated() {
        let time = |range: Value| json!({ "title": "Time", "timeRange": range });
        assert!(validate_dashboard(&time(json!({ "startTime": "2026-10-01T00:00:00Z", "endTime": "now", "type": "custom" })), None).valid);
        assert!(
            validate_dashboard(
                &time(json!({ "startTime": "1h", "endTime": "now", "type": "fixed" })),
                None
            )
            .valid
        );
        for range in [
            json!({ "startTime": "now", "endTime": "2026-10-01T00:00:00Z", "type": "custom" }),
            json!({ "startTime": "2026-10-02T00:00:00Z", "endTime": "2026-10-01T00:00:00Z", "type": "custom" }),
            json!({ "startTime": "yesterday", "endTime": "now", "type": "custom" }),
            json!({ "startTime": "1h", "type": "fixed" }),
        ] {
            assert_eq!(
                codes(&validate_dashboard(&time(range.clone()), None).errors),
                ["invalid_time_range"],
                "{range}"
            );
        }
        let unusual = validate_dashboard(
            &time(json!({ "startTime": "2w", "endTime": "now", "type": "fixed" })),
            None,
        );
        assert!(unusual.valid && codes(&unusual.warnings).contains(&"unknown_time_preset"));

        assert!(validate_dashboard(&json!({ "title": "R", "refreshInterval": 60000 }), None).valid);
        assert_eq!(
            codes(
                &validate_dashboard(&json!({ "title": "R", "refreshInterval": 1234 }), None).errors
            ),
            ["invalid_refresh_interval"]
        );
        let variables = json!({ "title": "V", "variables": [
            { "name": "a", "label": "A", "type": "promql", "dataset": "metrics" },
            { "name": "b", "label": "B", "type": "radio" },
            { "name": "c", "label": "C", "type": "promql", "dataset": "m", "labelName": "host", "labelFilters": [{ "label": "x", "operator": "~", "value": "y" }] },
        ]});
        assert_eq!(
            codes(&validate_dashboard(&variables, None).errors),
            [
                "incomplete_variable",
                "unsupported_variable_type",
                "invalid_label_filter"
            ]
        );
    }

    #[test]
    fn builder_object_queries_are_supported() {
        let builder = |chart: &str, query: Value| {
            json!({ "title": "Builder", "tiles": [{
                "tile_id": id(1), "tileType": "builder", "chartType": chart, "chartQuery": query,
                "dbName": ["app-logs"], "layout": { "x": 0, "y": 0, "w": 6, "h": 4 },
            }]})
        };
        // frontend newBuilderQuery('timeseries'), plus a filter, sort and an unknown extension
        let query = json!({
            "x": { "fields": [{ "name": "p_timestamp" }], "groupBy": [], "granularity": "hour" },
            "y": { "fields": [{ "name": "*", "aggregate": "COUNT" }, { "name": "latency", "aggregate": "avg" }], "groupBy": ["level"], "limit": 100, "sortBy": { "field": "latency", "direction": "DESC" } },
            "filters": [{ "column": "level", "operator": "=", "value": "error" }, { "column": "host", "operator": "is not null" }],
            "future": { "kept": true },
        });
        let report = validate_dashboard(&builder("timeseries", query.clone()), None);
        assert!(report.valid, "{report:?}");
        let stat = json!({ "x": { "fields": [], "groupBy": [] }, "y": { "fields": [{ "name": "*", "aggregate": "COUNT" }], "groupBy": [], "limit": 100 }, "filters": [] });
        assert!(validate_dashboard(&builder("query-value", stat), None).valid);

        for (chart, broken) in [
            (
                "bar",
                json!({ "x": { "fields": [] }, "y": { "fields": [{ "name": "latency", "aggregate": "MEDIAN" }] } }),
            ),
            (
                "bar",
                json!({ "y": { "fields": [{ "name": "*", "aggregate": "SUM" }] } }),
            ),
            (
                "bar",
                json!({ "y": { "fields": [{ "name": "*", "aggregate": "COUNT" }] }, "filters": [{ "column": "a", "operator": "like", "value": "x" }] }),
            ),
            (
                "bar",
                json!({ "y": { "fields": [{ "name": "*", "aggregate": "COUNT" }], "limit": 0 } }),
            ),
            (
                "timeseries",
                json!({ "x": { "fields": [] }, "y": { "fields": [{ "name": "*", "aggregate": "COUNT" }] } }),
            ),
            (
                "gauge",
                json!({ "x": { "fields": [{ "name": "a" }] }, "y": { "fields": [] } }),
            ),
            ("bar", json!({ "x": { "fields": [] } })),
        ] {
            let report = validate_dashboard(&builder(chart, broken.clone()), None);
            assert_eq!(
                codes(&report.errors),
                ["invalid_builder_query"],
                "{broken} {report:?}"
            );
        }
        let mut no_dataset = builder("bar", query.clone());
        no_dataset["tiles"][0]["dbName"] = json!([]);
        assert_eq!(
            codes(&validate_dashboard(&no_dataset, None).errors),
            ["missing_dataset"]
        );
        let mut code_tile = builder("bar", query);
        code_tile["tiles"][0]["tileType"] = json!("code");
        assert_eq!(
            codes(&validate_dashboard(&code_tile, None).errors),
            ["legacy_query_shape"]
        );
    }

    #[test]
    fn capabilities_publish_inline_schemas_and_enums() {
        let caps = capabilities();
        let operations = caps["patch"]["operations"].as_array().unwrap();
        for op in [
            "add",
            "replace",
            "remove",
            "placeTile",
            "renameVariable",
            "reorderSections",
            "removeSection",
        ] {
            assert!(operations.contains(&json!(op)), "{op}");
        }
        assert_eq!(
            caps["enums"]["chartTypes"].as_array().unwrap().len(),
            CHART_TYPES.len()
        );
        let properties = &caps["schema"]["$defs"]["dashboard"]["properties"];
        for key in [
            "title",
            "timeRange",
            "refreshInterval",
            "variables",
            "sections",
            "tiles",
            "dashboardId",
        ] {
            assert!(properties.get(key).is_some(), "{key}");
        }
        assert!(!caps["operationItemSchema"].to_string().contains("$ref"));
        assert!(!caps["operationSchema"].to_string().contains("$ref"));
        assert_eq!(
            caps["operationSchema"]["properties"]["operations"]["maxItems"],
            MAX_OPERATIONS
        );
        assert_eq!(
            caps["operationItemSchema"]["oneOf"]
                .as_array()
                .unwrap()
                .len(),
            6
        );
    }
}
