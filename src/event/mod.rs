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
*
*/

pub mod format;

use arrow_array::RecordBatch;
use arrow_schema::{ArrowError, Field, Fields, Schema, SchemaRef};
use itertools::Itertools;
use std::collections::HashSet;
use std::sync::{Arc, RwLock};

use tracing::{info_span, instrument};

use self::error::EventError;
use crate::{
    LOCK_EXPECT,
    handlers::TelemetryType,
    metadata::{LogStreamMetadata, update_stats},
    metrics::{increment_events_ingested_by_date, increment_events_ingested_size_by_date},
    parseable::{DEFAULT_TENANT, PARSEABLE, StagingError, StreamNotFound},
    storage::StreamType,
    tenants::TenantNotFound,
};
use chrono::NaiveDateTime;
use std::collections::HashMap;

pub const DEFAULT_TIMESTAMP_KEY: &str = "p_timestamp";
pub const USER_AGENT_KEY: &str = "p_user_agent";
pub const SOURCE_IP_KEY: &str = "p_src_ip";
pub const FORMAT_KEY: &str = "p_format";
pub const FORMAT_VERIFY_KEY: &str = "p_format_verified";

#[derive(Clone)]
pub struct Event {
    pub stream_name: String,
    pub rb: RecordBatch,
    pub origin_format: &'static str,
    pub origin_size: u64,
    pub is_first_event: bool,
    pub parsed_timestamp: NaiveDateTime,
    pub time_partition: Option<String>,
    pub custom_partition_values: HashMap<String, String>,
    pub stream_type: StreamType,
    pub telemetry_type: TelemetryType,
    pub tenant_id: Option<String>,
}

// Events holds the schema related to a each event for a single log stream
impl Event {
    #[instrument(
        name = "event_process",
        level = "info",
        skip_all,
        fields(
            stream_name = %self.stream_name,
            num_rows = self.rb.num_rows(),
            is_first_event = self.is_first_event
        )
    )]
    #[cfg_attr(feature = "hotpath", hotpath::measure)]
    pub fn process(self) -> Result<(), EventError> {
        let mut key = get_schema_key(&self.rb.schema().fields);
        if self.time_partition.is_some() {
            let parsed_timestamp_to_min = self.parsed_timestamp.format("%Y%m%dT%H%M").to_string();
            key.push_str(&parsed_timestamp_to_min);
        }

        if !self.custom_partition_values.is_empty() {
            for (k, v) in self.custom_partition_values.iter().sorted_by_key(|v| v.0) {
                key.push_str(&format!("&{k}={v}"));
            }
        }

        let stream = PARSEABLE.get_or_create_stream(&self.stream_name, &self.tenant_id);

        // User ingestion is held to the configured field limit; internal
        // streams have fixed schemas and are exempt.
        let schema_committed = if self.stream_type == StreamType::UserDefined {
            commit_ingested_schema(
                &self.stream_name,
                &stream.metadata,
                &self.rb.schema(),
                PARSEABLE.options.dataset_fields_allowed_limit,
                self.is_first_event,
            )?
        } else if self.is_first_event {
            commit_schema(&self.stream_name, self.rb.schema(), &self.tenant_id)?;
            true
        } else {
            false
        };
        if schema_committed && !stream.get_static_schema_flag() {
            stream.stage_schema_file(stream.get_schema().as_ref().clone())?;
        }

        stream.push(
            &key,
            &self.rb,
            self.parsed_timestamp,
            &self.custom_partition_values,
            self.stream_type,
        )?;

        let tenant = self.tenant_id.as_deref().unwrap_or(DEFAULT_TENANT);
        update_stats(
            &self.stream_name,
            self.origin_format,
            self.origin_size,
            self.rb.num_rows(),
            self.parsed_timestamp.date(),
            tenant,
        );

        // Track billing metrics for event ingestion
        let date_string = self.parsed_timestamp.date().to_string();
        increment_events_ingested_by_date(self.rb.num_rows() as u64, &date_string, tenant);
        increment_events_ingested_size_by_date(
            self.origin_size,
            &date_string,
            self.telemetry_type,
            tenant,
        );

        crate::livetail::LIVETAIL.process(&self.stream_name, &self.rb);

        Ok(())
    }

    pub fn process_unchecked(&self) -> Result<(), EventError> {
        let key = get_schema_key(&self.rb.schema().fields);

        PARSEABLE
            .get_or_create_stream(&self.stream_name, &self.tenant_id)
            .push(
                &key,
                &self.rb,
                self.parsed_timestamp,
                &self.custom_partition_values,
                self.stream_type,
            )?;

        Ok(())
    }
}

pub fn get_schema_key(fields: &[Arc<Field>]) -> String {
    // Fields must be sorted
    let mut hasher = xxhash_rust::xxh3::Xxh3::new();
    for field in fields.iter().sorted_by_key(|v| v.name()) {
        hasher.update(field.name().as_bytes());
    }
    let hash = hasher.digest();
    format!("{hash:x}")
}

pub fn commit_schema(
    stream_name: &str,
    schema: Arc<Schema>,
    tenant_id: &Option<String>,
) -> Result<(), StagingError> {
    let _span = info_span!("commit_schema", stream_name).entered();
    let mut stream_metadata = PARSEABLE.streams.write().expect("lock poisoned");
    let tenant_id = tenant_id.as_deref().unwrap_or(DEFAULT_TENANT);
    let map = &mut stream_metadata
        .get_mut(tenant_id)
        .ok_or_else(|| TenantNotFound(tenant_id.to_owned()))?
        .get_mut(stream_name)
        .ok_or_else(|| StreamNotFound(stream_name.to_string()))?
        .metadata
        .write()
        .expect(LOCK_EXPECT)
        .schema;
    merge_into_schema(map, &schema)?;
    Ok(())
}

/// Checks an ingested event against the stream's field limit and commits its
/// schema to the stream's in-memory schema when needed.
///
/// The event is rejected if the stream's fields together with the event's
/// would exceed `limit`, which includes streams already over the limit. A first
/// event's schema is merged in. Any other event on a dynamic schema has its
/// missing fields, such as new header fields, added without merging the rest.
/// The final count and commit happen under one write lock on the stream
/// metadata, so concurrent events cannot each pass the check and together
/// exceed the limit; events adding nothing only take a read lock. Startup and
/// query-time schema refreshes use `commit_schema`, which has no limit.
///
/// Returns whether the schema was committed.
pub(crate) fn commit_ingested_schema(
    stream_name: &str,
    metadata: &RwLock<LogStreamMetadata>,
    schema: &Schema,
    limit: usize,
    is_first_event: bool,
) -> Result<bool, EventError> {
    {
        let metadata = metadata.read().expect(LOCK_EXPECT);
        let new_fields = new_field_names(&metadata.schema, [schema]).len();
        check_field_limit(stream_name, metadata.schema.len() + new_fields, limit)?;
        if !is_first_event && (new_fields == 0 || metadata.static_schema_flag) {
            return Ok(false);
        }
    }

    let _span = info_span!("commit_ingested_schema", stream_name).entered();
    let mut metadata = metadata.write().expect(LOCK_EXPECT);
    let new_fields = new_field_names(&metadata.schema, [schema]).len();
    check_field_limit(stream_name, metadata.schema.len() + new_fields, limit)?;
    if is_first_event {
        merge_into_schema(&mut metadata.schema, schema).map_err(StagingError::from)?;
    } else {
        // Only add the missing fields: a header field sharing a name with a
        // typed stream field was never merged and must not fail the event.
        for field in schema.fields() {
            if !metadata.schema.contains_key(field.name()) {
                metadata.schema.insert(field.name().clone(), field.clone());
            }
        }
    }
    Ok(true)
}

/// Checks that the stream's fields together with every schema in `schemas`
/// stay within `limit`, counting each new field name once.
///
/// Lets a request that yields several events reject before processing any of
/// them. It does not reserve room: `commit_ingested_schema` still enforces the
/// limit as each event is processed.
pub(crate) fn check_ingested_schemas(
    stream_name: &str,
    metadata: &RwLock<LogStreamMetadata>,
    schemas: &[SchemaRef],
    limit: usize,
) -> Result<(), EventError> {
    let metadata = metadata.read().expect(LOCK_EXPECT);
    let new_fields =
        new_field_names(&metadata.schema, schemas.iter().map(|schema| &**schema)).len();
    check_field_limit(stream_name, metadata.schema.len() + new_fields, limit)
}

/// Names of the fields in `schemas` that `current` lacks, without duplicates.
fn new_field_names<'a>(
    current: &HashMap<String, Arc<Field>>,
    schemas: impl IntoIterator<Item = &'a Schema>,
) -> HashSet<&'a str> {
    schemas
        .into_iter()
        .flat_map(|schema| schema.fields().iter())
        .map(|field| field.name().as_str())
        .filter(|name| !current.contains_key(*name))
        .collect()
}

fn check_field_limit(stream_name: &str, total: usize, limit: usize) -> Result<(), EventError> {
    if total > limit {
        return Err(EventError::FieldsCountLimitExceeded(
            stream_name.to_owned(),
            total,
            limit,
        ));
    }
    Ok(())
}

fn merge_into_schema(
    map: &mut HashMap<String, Arc<Field>>,
    schema: &Schema,
) -> Result<(), ArrowError> {
    let current_schema = Schema::new(map.values().cloned().collect::<Fields>());
    let schema = Schema::try_merge(vec![current_schema, schema.clone()])?;
    map.clear();
    map.extend(schema.fields.iter().map(|f| (f.name().clone(), f.clone())));
    Ok(())
}

pub mod error {

    use crate::{parseable::StagingError, storage::ObjectStorageError};

    #[derive(Debug, thiserror::Error)]
    pub enum EventError {
        #[error("Staging Failed: {0}")]
        Staging(#[from] StagingError),
        #[error("ObjectStorage Error: {0}")]
        ObjectStorage(#[from] ObjectStorageError),
        #[error(
            "Failed to ingest events in dataset {0}. Total number of fields {1} exceeds the permissible limit of {2}."
        )]
        FieldsCountLimitExceeded(String, usize, usize),
    }
}

#[cfg(test)]
mod tests {
    use std::{
        collections::HashMap,
        fmt::Debug,
        sync::{Arc, Barrier, RwLock},
        thread,
    };

    use arrow_schema::{DataType, Field, Schema, SchemaRef, TimeUnit};
    use chrono::Utc;
    use serde_json::{Value, json};

    use super::{
        DEFAULT_TIMESTAMP_KEY, check_ingested_schemas, commit_ingested_schema, error::EventError,
        merge_into_schema,
    };
    use crate::{
        event::format::{EventFormat, json},
        metadata::{LogStreamMetadata, SchemaVersion},
    };

    const STREAM: &str = "logs";

    fn p_timestamp() -> Field {
        Field::new(
            DEFAULT_TIMESTAMP_KEY,
            DataType::Timestamp(TimeUnit::Millisecond, None),
            true,
        )
    }

    fn utf8_fields(prefix: &str, count: usize) -> Vec<Field> {
        (0..count)
            .map(|i| Field::new(format!("{prefix}{i}"), DataType::Utf8, true))
            .collect()
    }

    fn metadata(fields: Vec<Field>) -> RwLock<LogStreamMetadata> {
        RwLock::new(LogStreamMetadata {
            schema: fields
                .into_iter()
                .map(|field| (field.name().clone(), Arc::new(field)))
                .collect(),
            ..Default::default()
        })
    }

    fn field_names(metadata: &RwLock<LogStreamMetadata>) -> Vec<String> {
        let mut names: Vec<_> = metadata.read().unwrap().schema.keys().cloned().collect();
        names.sort();
        names
    }

    /// A record with a string value for each of the given keys.
    fn record(prefix: &str, count: usize) -> Value {
        Value::Object(
            (0..count)
                .map(|i| (format!("{prefix}{i}"), json!("v")))
                .collect(),
        )
    }

    /// The schema and first-event flag ingestion derives for `json` against
    /// the stream's current schema, including the generated `p_` and header
    /// fields.
    fn event_schema(
        metadata: &RwLock<LogStreamMetadata>,
        json: Value,
        headers: &[(&str, &str)],
    ) -> (SchemaRef, bool) {
        let stream_schema = metadata.read().unwrap().schema.clone();
        let static_schema_flag = metadata.read().unwrap().static_schema_flag;
        let headers: HashMap<String, String> = headers
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        let (rb, is_first_event) = json::Event::new(json, Utc::now())
            .into_recordbatch(
                &stream_schema,
                static_schema_flag,
                None,
                SchemaVersion::V1,
                &headers,
                false,
            )
            .unwrap();
        (rb.schema(), is_first_event)
    }

    /// Commits `json` as ingestion would, returning whether the schema changed.
    fn ingest(
        metadata: &RwLock<LogStreamMetadata>,
        json: Value,
        headers: &[(&str, &str)],
        limit: usize,
    ) -> Result<bool, EventError> {
        let (schema, is_first_event) = event_schema(metadata, json, headers);
        commit_ingested_schema(STREAM, metadata, &schema, limit, is_first_event)
    }

    fn assert_limit_error<T: Debug>(result: Result<T, EventError>, total: usize, limit: usize) {
        match result {
            Err(EventError::FieldsCountLimitExceeded(name, t, l)) => {
                assert_eq!((name.as_str(), t, l), (STREAM, total, limit));
            }
            other => panic!("expected a field limit error, got {other:?}"),
        }
    }

    #[test]
    fn accepts_event_reaching_exactly_the_limit() {
        // 9 fields plus the generated p_timestamp
        let stream = metadata(vec![]);
        assert!(ingest(&stream, record("f", 9), &[], 10).unwrap());
        assert_eq!(field_names(&stream).len(), 10);
        assert!(field_names(&stream).contains(&DEFAULT_TIMESTAMP_KEY.to_owned()));

        // Known fields at exactly the limit keep being accepted
        assert!(!ingest(&stream, record("f", 9), &[], 10).unwrap());
        assert_eq!(field_names(&stream).len(), 10);
    }

    #[test]
    fn rejects_event_one_field_over_the_limit() {
        let stream = metadata(vec![]);
        assert_limit_error(ingest(&stream, record("f", 9), &[], 9), 10, 9);
        assert!(field_names(&stream).is_empty());
    }

    #[test]
    fn rejects_huge_single_event_on_empty_stream() {
        let stream = metadata(vec![]);
        assert_limit_error(ingest(&stream, record("f", 1500), &[], 1000), 1501, 1000);
        assert!(field_names(&stream).is_empty());
    }

    #[test]
    fn rejects_disjoint_batches_once_they_add_up_past_the_limit() {
        let stream = metadata(vec![]);
        // p_timestamp + 3 + 3 + 3 = 10
        for prefix in ["a", "b", "c"] {
            assert!(ingest(&stream, record(prefix, 3), &[], 10).unwrap());
        }
        let before = field_names(&stream);
        assert_eq!(before.len(), 10);

        assert_limit_error(ingest(&stream, record("d", 3), &[], 10), 13, 10);
        assert_eq!(field_names(&stream), before);
    }

    #[test]
    fn counts_existing_and_repeated_fields_once() {
        let mut fields = utf8_fields("f", 5);
        fields.push(p_timestamp());
        let stream = metadata(fields);
        // Overlaps the stream on f0..f4 and p_timestamp; only f5..f8 are new
        assert!(ingest(&stream, record("f", 9), &[], 10).unwrap());
        assert_eq!(field_names(&stream).len(), 10);

        // The same names repeated across schemas count once
        let schema: SchemaRef = Arc::new(Schema::new(utf8_fields("g", 3)));
        let schemas = [schema.clone(), schema.clone(), schema];
        let stream = metadata(vec![p_timestamp()]);
        check_ingested_schemas(STREAM, &stream, &schemas, 4).unwrap();
        assert_limit_error(check_ingested_schemas(STREAM, &stream, &schemas, 3), 4, 3);
    }

    #[test]
    fn counts_generated_header_and_typed_sibling_fields() {
        let stream = metadata(vec![
            p_timestamp(),
            Field::new("count", DataType::Int64, true),
        ]);
        let json = json!({"count": "not a number", "msg": "hello"});
        let headers = [("p_user_agent", "curl"), ("env", "prod")];

        let (schema, is_first_event) = event_schema(&stream, json, &headers);
        assert!(is_first_event);
        let names: Vec<_> = schema.fields().iter().map(|f| f.name().as_str()).collect();
        let sibling = names
            .iter()
            .find(|name| name.starts_with("count_"))
            .unwrap_or_else(|| panic!("no typed sibling for count in {names:?}"));
        assert!(!names.contains(&"count"), "{names:?}");
        // p_timestamp and count already exist; the sibling, msg and both
        // header fields are new
        let new_fields = [*sibling, "msg", "p_user_agent", "env"];
        assert!(
            new_fields.iter().all(|name| names.contains(name)),
            "{names:?}"
        );
        assert_eq!(names.len(), 5, "{names:?}");

        assert_limit_error(
            commit_ingested_schema(STREAM, &stream, &schema, 5, is_first_event),
            6,
            5,
        );
        assert_eq!(field_names(&stream).len(), 2);

        assert!(commit_ingested_schema(STREAM, &stream, &schema, 6, is_first_event).unwrap());
        assert_eq!(field_names(&stream).len(), 6);
        // The original field keeps its type
        assert_eq!(
            stream.read().unwrap().schema["count"].data_type(),
            &DataType::Int64
        );
    }

    #[test]
    fn known_schema_event_counts_and_keeps_new_header_fields() {
        let stream = metadata(vec![p_timestamp(), Field::new("msg", DataType::Utf8, true)]);
        let json = json!({"msg": "hello"});
        let headers = [("env", "prod")];

        let (_, is_first_event) = event_schema(&stream, json.clone(), &headers);
        assert!(
            !is_first_event,
            "a known-schema event should not be a first event"
        );

        assert_limit_error(ingest(&stream, json.clone(), &headers, 2), 3, 2);
        assert_eq!(field_names(&stream).len(), 2);

        assert!(ingest(&stream, json.clone(), &headers, 3).unwrap());
        assert!(field_names(&stream).contains(&"env".to_owned()));

        // Nothing new the second time, so nothing is committed
        assert!(!ingest(&stream, json, &headers, 3).unwrap());
    }

    #[test]
    fn known_schema_event_only_adds_missing_fields() {
        // A header named like a typed stream field is not merged with it
        let stream = metadata(vec![
            p_timestamp(),
            Field::new("level", DataType::Int64, true),
        ]);
        let schema = Schema::new(vec![
            p_timestamp(),
            Field::new("level", DataType::Utf8, true),
            Field::new("env", DataType::Utf8, true),
        ]);

        assert!(commit_ingested_schema(STREAM, &stream, &schema, 10, false).unwrap());
        let stream = stream.read().unwrap();
        assert_eq!(stream.schema["level"].data_type(), &DataType::Int64);
        assert_eq!(stream.schema["env"].data_type(), &DataType::Utf8);
    }

    #[test]
    fn static_schema_known_event_is_counted_but_not_committed() {
        let stream = metadata(vec![p_timestamp(), Field::new("msg", DataType::Utf8, true)]);
        stream.write().unwrap().static_schema_flag = true;
        let json = json!({"msg": "hello"});
        let headers = [("env", "prod")];

        assert_limit_error(ingest(&stream, json.clone(), &headers, 2), 3, 2);
        assert!(!ingest(&stream, json, &headers, 3).unwrap());
        assert_eq!(field_names(&stream).len(), 2);
    }

    #[test]
    fn over_limit_stream_rejects_ingestion_but_stays_recoverable() {
        let mut wide = utf8_fields("f", 19);
        wide.push(p_timestamp());
        let wide_schema = Schema::new(wide);

        // Startup load and query refresh merge without a limit
        let stream = metadata(vec![]);
        merge_into_schema(&mut stream.write().unwrap().schema, &wide_schema).unwrap();
        let before = field_names(&stream);
        assert_eq!(before.len(), 20);

        // Known fields only, on both event paths
        let known = Schema::new(vec![p_timestamp(), Field::new("f0", DataType::Utf8, true)]);
        assert_limit_error(
            commit_ingested_schema(STREAM, &stream, &known, 10, false),
            20,
            10,
        );
        assert_limit_error(
            commit_ingested_schema(STREAM, &stream, &known, 10, true),
            20,
            10,
        );
        // A new field
        assert_limit_error(ingest(&stream, record("g", 1), &[], 10), 21, 10);
        assert_limit_error(
            check_ingested_schemas(STREAM, &stream, &[Arc::new(known)], 10),
            20,
            10,
        );

        assert_eq!(field_names(&stream), before);
    }

    #[test]
    fn whole_request_check_rejects_union_of_events() {
        let stream = metadata(vec![p_timestamp()]);
        let a: SchemaRef = Arc::new(Schema::new(utf8_fields("a", 6)));
        let b: SchemaRef = Arc::new(Schema::new(utf8_fields("b", 6)));

        // Each event fits on its own; together they do not
        check_ingested_schemas(STREAM, &stream, std::slice::from_ref(&a), 12).unwrap();
        check_ingested_schemas(STREAM, &stream, std::slice::from_ref(&b), 12).unwrap();
        assert_limit_error(check_ingested_schemas(STREAM, &stream, &[a, b], 12), 13, 12);
        assert_eq!(field_names(&stream).len(), 1);
    }

    #[test]
    fn rejected_type_conflict_leaves_schema_unmodified() {
        let stream = metadata(vec![p_timestamp(), Field::new("a", DataType::Int64, true)]);
        let before = field_names(&stream);
        let schema = Schema::new(vec![
            Field::new("a", DataType::Utf8, true),
            Field::new("b", DataType::Utf8, true),
        ]);

        let result = commit_ingested_schema(STREAM, &stream, &schema, 10, true);
        assert!(matches!(result, Err(EventError::Staging(_))), "{result:?}");
        assert_eq!(field_names(&stream), before);
    }

    #[test]
    fn concurrent_writers_cannot_exceed_the_limit_together() {
        const WRITERS: usize = 16;
        // Room for exactly 4 writers adding 3 fields each
        const LIMIT: usize = 1 + 3 * 4;

        let stream = metadata(vec![p_timestamp()]);
        let barrier = Barrier::new(WRITERS);
        let results: Vec<_> = thread::scope(|scope| {
            let handles: Vec<_> = (0..WRITERS)
                .map(|writer| {
                    let (stream, barrier) = (&stream, &barrier);
                    scope.spawn(move || {
                        let schema = Schema::new(utf8_fields(&format!("w{writer}_"), 3));
                        barrier.wait();
                        commit_ingested_schema(STREAM, stream, &schema, LIMIT, true)
                    })
                })
                .collect();
            handles.into_iter().map(|h| h.join().unwrap()).collect()
        });

        let accepted = results.iter().filter(|r| r.is_ok()).count();
        assert_eq!(accepted, 4);
        for result in results.into_iter().filter(Result::is_err) {
            assert_limit_error(result, LIMIT + 3, LIMIT);
        }
        assert_eq!(field_names(&stream).len(), LIMIT);
    }

    #[test]
    fn concurrent_writers_of_the_same_fields_all_fit() {
        const WRITERS: usize = 8;
        const LIMIT: usize = 13;

        let stream = metadata(vec![p_timestamp()]);
        let barrier = Barrier::new(WRITERS);
        thread::scope(|scope| {
            for _ in 0..WRITERS {
                let (stream, barrier) = (&stream, &barrier);
                scope.spawn(move || {
                    let schema = Schema::new(utf8_fields("f", LIMIT - 1));
                    barrier.wait();
                    commit_ingested_schema(STREAM, stream, &schema, LIMIT, true).unwrap();
                });
            }
        });
        assert_eq!(field_names(&stream).len(), LIMIT);
    }
}
