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

//! Kafka custom-partition streams accept one JSON object per record, with all
//! configured partition fields present and valid. Arrays, non-objects, invalid
//! JSON/partition values, conversion failures, and conflicting field types are
//! skipped with the record's topic, partition, offset, and tenant in the warning.
//! Schemas are accumulated in record order and published as one union; only
//! conflicting records are skipped, without adding any of their fields.
//!
//! Offsets are committed after processing, including when records are skipped or
//! processing fails. Storage is not atomic across the chunk: a later store error
//! can leave earlier records stored while the rest are dropped (tracked separately).

use crate::{
    LOCK_EXPECT,
    connectors::common::processor::Processor,
    event::{
        Event, USER_AGENT_KEY,
        error::EventError,
        format::{EventFormat, LogSourceEntry, json},
    },
    handlers::TelemetryType,
    metadata::{LogStreamMetadata, SchemaVersion},
    parseable::{PARSEABLE, StagingError},
    storage::StreamType,
    utils::json::flatten::validate_custom_partition,
};
use arrow_schema::{ArrowError, Field, Schema};
use async_trait::async_trait;
use chrono::Utc;
use futures_util::StreamExt;
use rdkafka::consumer::{CommitMode, Consumer};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use tokio_stream::wrappers::ReceiverStream;
use tracing::{debug, error, warn};

use super::{ConsumerRecord, StreamConsumer, TopicPartition, config::BufferConfig};

#[derive(Default, Debug, Clone)]
pub struct ParseableSinkProcessor;

impl ParseableSinkProcessor {
    /// Ensures the destination stream exists and fetches the metadata needed
    /// to build an event from a chunk. Stays on the (small, I/O-focused)
    /// kafka tokio runtime since it does async catalog/metadata lookups.
    async fn prepare_stream(
        &self,
        stream_name: &str,
        tenant_id: &Option<String>,
    ) -> anyhow::Result<StreamMeta> {
        let log_source_entry = LogSourceEntry::default();
        PARSEABLE
            .create_stream_if_not_exists(
                stream_name,
                StreamType::UserDefined,
                None,
                vec![log_source_entry],
                TelemetryType::default(),
                tenant_id,
                vec![],
                vec![],
            )
            .await?;

        let stream = PARSEABLE.get_stream(stream_name, tenant_id)?;
        Ok(StreamMeta {
            schema: stream.get_schema_raw(),
            time_partition: stream.get_time_partition(),
            custom_partition: stream.get_custom_partition(),
            static_schema_flag: stream.get_static_schema_flag(),
            schema_version: stream.get_schema_version(),
            infer_timestamp: stream.get_infer_timestamp(),
        })
    }
}

struct StreamMeta {
    schema: HashMap<String, Arc<Field>>,
    time_partition: Option<String>,
    custom_partition: Option<String>,
    static_schema_flag: bool,
    schema_version: SchemaVersion,
    infer_timestamp: bool,
}

/// JSON parse + Arrow record-batch encode for a chunk of records. CPU-bound,
/// so it must run off the kafka connector's dedicated tokio runtime (sized to
/// `partition_listener_concurrency`, default 2 — shared by every partition's
/// poll/commit/recv), same reasoning as the rayon offload used for otel and
/// prometheus remote-write ingestion.
fn build_and_process_event(
    records: Vec<ConsumerRecord>,
    stream_name: String,
    tenant_id: Option<String>,
    meta: StreamMeta,
) -> anyhow::Result<()> {
    // Offsets are committed whether or not the chunk is ingested and the
    // producer gets no rejection signal, so the dataset field limit is not
    // enforced here: rejecting would silently drop the whole chunk.
    let mut events = build_events(&records, &stream_name, &tenant_id, &meta)?;
    if meta.custom_partition.is_some() && !events.is_empty() {
        // Select schemas in source order, then stage the accepted union once.
        let stream = PARSEABLE.get_stream(&stream_name, &tenant_id)?;
        let (accepted, committed) = commit_compatible_events(&stream.metadata, events)?;
        events = accepted;
        finish_schema_commit(&mut events, committed, || {
            if !stream.get_static_schema_flag() {
                stream.stage_schema_file(stream.get_schema().as_ref().clone())?;
            }
            Ok(())
        })?;
    }
    for event in events {
        event.event.process_without_field_limit()?;
    }

    Ok(())
}

struct RecordEvent<'a> {
    event: Event,
    // For the non-custom-partition batch path this identifies its first record.
    record: &'a ConsumerRecord,
}

fn record_span(record: &ConsumerRecord) -> tracing::Span {
    tracing::warn_span!(
        "kafka_record",
        topic = %record.topic,
        partition = record.partition,
        offset = record.offset,
        tenant = record.tenant_id.as_deref(),
    )
}

/// Checks only this record's fields, buffering changes until every field is
/// compatible. Rejection never mutates the accumulator, even if a new field
/// precedes the conflicting field. Work is proportional to the record's schema,
/// rather than to all fields accumulated from preceding records.
fn merge_record_schema(
    accumulated: &mut HashMap<String, Arc<Field>>,
    schema: &Schema,
    is_first_event: bool,
) -> Result<bool, ArrowError> {
    let mut updates = Vec::new();
    for field in schema.fields() {
        match accumulated.get(field.name()) {
            Some(current) if is_first_event && current != field => {
                let mut merged = current.as_ref().clone();
                merged.try_merge(field)?;
                updates.push(Arc::new(merged));
            }
            None => updates.push(field.clone()),
            _ => {}
        }
    }
    let changed = is_first_event || !updates.is_empty();
    for field in updates {
        accumulated.insert(field.name().clone(), field);
    }
    Ok(changed)
}

/// Selects compatible records in source order under one metadata lock. Clone
/// the stored index once and publish the accepted union once, including when
/// some records conflict. Static schemas retain their existing no-growth rule.
fn commit_compatible_events<'a>(
    metadata: &RwLock<LogStreamMetadata>,
    events: Vec<RecordEvent<'a>>,
) -> Result<(Vec<RecordEvent<'a>>, bool), EventError> {
    let mut metadata = metadata.write().expect(LOCK_EXPECT);
    if metadata.static_schema_flag {
        return Ok((events, false));
    }
    let mut accumulated = metadata.schema.clone();
    let mut accepted = Vec::with_capacity(events.len());
    let mut committed = false;
    for event in events {
        match merge_record_schema(
            &mut accumulated,
            &event.event.rb.schema(),
            event.event.is_first_event,
        ) {
            Ok(changed) => {
                committed |= changed;
                accepted.push(event);
            }
            Err(err @ ArrowError::SchemaError(_)) => {
                let _span = record_span(event.record).entered();
                warn!(error = %err, "Skipping Kafka record with conflicting schema");
            }
            Err(err) => return Err(StagingError::from(err).into()),
        }
    }
    if committed {
        metadata.schema = accumulated;
    }
    Ok((accepted, committed))
}

/// Normal event processing must not merge and stage these schemas again.
/// Clear the inference flag only after the chunk's schema staging succeeds.
fn finish_schema_commit(
    events: &mut [RecordEvent<'_>],
    committed: bool,
    stage: impl FnOnce() -> Result<(), StagingError>,
) -> Result<(), StagingError> {
    if committed {
        stage()?;
    }
    for event in events {
        event.event.is_first_event = false;
    }
    Ok(())
}

/// Builds events without accessing stream state, keeping partition values and
/// payload sizes attached to their individual records for custom partitions.
fn build_events<'a>(
    records: &'a [ConsumerRecord],
    stream_name: &str,
    tenant_id: &Option<String>,
    meta: &StreamMeta,
) -> anyhow::Result<Vec<RecordEvent<'a>>> {
    let mut p_custom_fields = HashMap::new();
    p_custom_fields.insert(USER_AGENT_KEY.to_string(), "kafka".to_string());

    let into_event = |value, origin_size| {
        json::Event::new(value, Utc::now()).into_event(
            stream_name.to_owned(),
            origin_size,
            &meta.schema,
            meta.static_schema_flag,
            meta.custom_partition.as_ref(),
            meta.time_partition.as_ref(),
            meta.schema_version,
            StreamType::UserDefined,
            &p_custom_fields,
            TelemetryType::Logs,
            tenant_id,
            meta.infer_timestamp,
        )
    };

    let mut events = Vec::new();
    let mut json_vec = Vec::with_capacity(records.len());
    let mut total_payload_size = 0u64;

    for record in records {
        let _span = record_span(record).entered();
        let Some(payload) = record.payload.as_ref() else {
            warn!("Skipping Kafka record without a payload");
            continue;
        };
        total_payload_size += payload.len() as u64;
        let value = match serde_json::from_slice::<Value>(payload) {
            Ok(value) => value,
            Err(err) => {
                warn!(error = %err, "Skipping Kafka record with unparsable payload");
                continue;
            }
        };

        if let Some(custom_partition) = &meta.custom_partition {
            let Some(object) = value.as_object() else {
                warn!(
                    custom_partition = %custom_partition,
                    "Skipping Kafka record: custom partition fields require a JSON object"
                );
                continue;
            };
            if let Err(err) = validate_custom_partition(object, Some(custom_partition)) {
                warn!(error = %err, "Skipping Kafka record with invalid custom partition");
                continue;
            }
            // Records are validated and converted individually here, so skip a
            // record that fails conversion instead of dropping the whole chunk.
            match into_event(value, payload.len() as u64) {
                Ok(event) => events.push(RecordEvent { event, record }),
                Err(err) => {
                    warn!(error = %err, "Skipping Kafka record that failed event conversion");
                }
            }
        } else {
            json_vec.push(value);
        }
    }

    // Empty chunks (including chunks with only invalid payloads) are a no-op;
    // Arrow's decoder expects at least one record.
    if meta.custom_partition.is_none()
        && !json_vec.is_empty()
        && let Some(record) = records.first()
    {
        events.push(RecordEvent {
            event: into_event(Value::Array(json_vec), total_payload_size)?,
            record,
        });
    }

    Ok(events)
}

#[async_trait]
impl Processor<Vec<ConsumerRecord>, ()> for ParseableSinkProcessor {
    async fn process(&self, records: Vec<ConsumerRecord>) -> anyhow::Result<()> {
        let len = records.len();
        debug!("Processing {len} records");

        let stream_name = records.first().map(|r| r.topic.clone()).unwrap_or_default();
        let tenant_id = records.first().and_then(|r| r.tenant_id.clone());

        let meta = self.prepare_stream(&stream_name, &tenant_id).await?;

        let (tx, rx) = tokio::sync::oneshot::channel();
        rayon::spawn(move || {
            let res = build_and_process_event(records, stream_name, tenant_id, meta);
            let _ = tx.send(res);
        });
        rx.await??;

        debug!("Processed {len} records");
        Ok(())
    }
}

#[derive(Clone)]
pub struct StreamWorker<P>
where
    P: Processor<Vec<ConsumerRecord>, ()>,
{
    processor: Arc<P>,
    consumer: Arc<StreamConsumer>,
    buffer_config: BufferConfig,
}

impl<P> StreamWorker<P>
where
    P: Processor<Vec<ConsumerRecord>, ()> + Send + Sync + 'static,
{
    pub fn new(processor: Arc<P>, consumer: Arc<StreamConsumer>) -> Self {
        let buffer_config = consumer
            .context()
            .config()
            .consumer()
            .expect("Consumer config is missing")
            .buffer_config();

        Self {
            processor,
            consumer,
            buffer_config,
        }
    }

    pub async fn process_partition(
        &self,
        tp: TopicPartition,
        record_stream: ReceiverStream<ConsumerRecord>,
    ) -> anyhow::Result<()> {
        let chunked_stream = tokio_stream::StreamExt::chunks_timeout(
            record_stream,
            self.buffer_config.buffer_size,
            self.buffer_config.buffer_timeout,
        );

        chunked_stream
            .for_each_concurrent(None, |records| async {
                if let Some(last_record) = records.iter().max_by_key(|r| r.offset) {
                    let tpl = last_record.offset_to_commit().unwrap();
                    let record_count = records.len();

                    if let Err(e) = self.processor.process(records).await {
                        error!(
                            "Failed to process {} records for {:?}; offsets up to {:?} will still be committed and these records are dropped: {:?}",
                            record_count, tp, tpl, e
                        );
                    }

                    //CommitMode::Async race condition.
                    //@see https://github.com/confluentinc/librdkafka/issues/4534
                    //@see https://github.com/confluentinc/librdkafka/issues/4059
                    if let Err(e) = self.consumer.commit(&tpl, CommitMode::Sync) {
                        error!(error = %e, "Failed to commit offsets for {:?}", tpl);
                    } else {
                        debug!("Committed offsets for {:?}", tpl);
                    }
                }
            })
            .await;

        self.processor.post_stream().await?;

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use arrow_schema::DataType;

    // Keep first-use tracing callsite registration in these tests from racing
    // the scoped subscriber used to assert warning fields.
    static TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn stream_meta(custom_partition: Option<&str>) -> StreamMeta {
        StreamMeta {
            schema: HashMap::new(),
            time_partition: None,
            custom_partition: custom_partition.map(str::to_owned),
            static_schema_flag: false,
            schema_version: SchemaVersion::V1,
            infer_timestamp: false,
        }
    }

    fn record(payload: &str) -> ConsumerRecord {
        ConsumerRecord::new(
            Some(payload.as_bytes().to_vec()),
            None,
            "test".to_owned(),
            0,
            0,
            None,
            None,
        )
    }

    #[test]
    fn committed_chunk_stages_once_and_clears_inference_flags() {
        let _guard = TEST_LOCK.lock().unwrap();
        let records = vec![
            record(r#"{"region":"south","n":3,"x":1}"#),
            record(r#"{"region":"south","n":4,"y":"text"}"#),
        ];
        let meta = stream_meta(Some("region"));
        let metadata = RwLock::new(LogStreamMetadata {
            schema: meta.schema.clone(),
            ..Default::default()
        });
        let events = build_events(&records, "test", &None, &meta).unwrap();

        assert_eq!(events.len(), 2);
        assert!(events.iter().all(|event| event.event.is_first_event));
        let (mut events, committed) = commit_compatible_events(&metadata, events).unwrap();
        let mut stages = 0;
        finish_schema_commit(&mut events, committed, || {
            stages += 1;
            Ok(())
        })
        .unwrap();
        assert_eq!(stages, 1);
        assert!(events.iter().all(|event| !event.event.is_first_event));
        let stored = metadata.read().unwrap();
        assert_eq!(stored.schema["x"].data_type(), &DataType::Float64);
        assert_eq!(stored.schema["y"].data_type(), &DataType::Utf8);
        for event in &events {
            for field in event.event.rb.schema().fields() {
                assert_eq!(stored.schema.get(field.name()), Some(field));
            }
        }
    }

    #[test]
    fn staging_failure_leaves_inference_flags_set() {
        let _guard = TEST_LOCK.lock().unwrap();
        let records = vec![record(r#"{"region":"west","n":1}"#)];
        let mut events =
            build_events(&records, "test", &None, &stream_meta(Some("region"))).unwrap();
        let result = finish_schema_commit(&mut events, true, || {
            Err(ArrowError::SchemaError("staging failed".to_owned()).into())
        });
        assert!(result.is_err());
        assert!(events[0].event.is_first_event);
    }

    #[test]
    fn record_schema_conflict_does_not_apply_partial_field_updates() {
        let mut accumulated = HashMap::from([
            (
                "x".to_owned(),
                Arc::new(Field::new("x", DataType::Float64, false)),
            ),
            (
                "nullable".to_owned(),
                Arc::new(Field::new("nullable", DataType::Boolean, false)),
            ),
        ]);
        let before = accumulated.clone();
        let schema = Schema::new(vec![
            Field::new("new_field", DataType::Boolean, true),
            Field::new("nullable", DataType::Boolean, true),
            Field::new("x", DataType::Utf8, true),
        ]);
        assert!(merge_record_schema(&mut accumulated, &schema, true).is_err());
        assert_eq!(accumulated, before);
    }

    #[test]
    fn many_records_accumulate_distinct_fields_including_after_conflicts() {
        let _guard = TEST_LOCK.lock().unwrap();
        for conflict in [false, true] {
            let records: Vec<_> = (0..1_000)
                .map(|i| {
                    let value = if conflict && i % 10 == 1 {
                        "\"bad\""
                    } else {
                        "1"
                    };
                    record(&format!(
                        r#"{{"region":"west","x":{value},"field_{i}":{i}}}"#
                    ))
                })
                .collect();
            let events =
                build_events(&records, "test", &None, &stream_meta(Some("region"))).unwrap();
            let base_fields = events[0].event.rb.schema().fields().len() - 1;
            let metadata = RwLock::new(LogStreamMetadata::default());
            let (accepted, committed) = commit_compatible_events(&metadata, events).unwrap();
            let expected = if conflict { 900 } else { 1_000 };
            assert!(committed);
            assert_eq!(accepted.len(), expected);
            let stored = metadata.read().unwrap();
            assert_eq!(stored.schema.len(), base_fields + expected);
            assert_eq!(stored.schema["x"].data_type(), &DataType::Float64);
            for i in 0..1_000 {
                assert_eq!(
                    stored.schema.contains_key(&format!("field_{i}")),
                    !conflict || i % 10 != 1
                );
            }
        }
    }

    #[test]
    fn static_schema_chunk_keeps_metadata_and_does_not_stage() {
        let _guard = TEST_LOCK.lock().unwrap();
        let records = vec![record(r#"{"region":"west","new_field":1}"#)];
        let events = build_events(&records, "test", &None, &stream_meta(Some("region"))).unwrap();
        let metadata = RwLock::new(LogStreamMetadata {
            static_schema_flag: true,
            ..Default::default()
        });
        let (mut accepted, committed) = commit_compatible_events(&metadata, events).unwrap();
        finish_schema_commit(&mut accepted, committed, || panic!("static schema staged")).unwrap();
        assert_eq!(accepted.len(), 1);
        assert!(!accepted[0].event.is_first_event);
        assert!(metadata.read().unwrap().schema.is_empty());
    }

    #[test]
    fn conflicting_record_keeps_compatible_records_and_only_their_fields() {
        let _guard = TEST_LOCK.lock().unwrap();
        let records = vec![
            record(r#"{"region":"west","n":1,"x":1}"#),
            record(r#"{"region":"east","n":2,"x":"text","rejected_field":true}"#),
            record(r#"{"region":"north","n":3,"x":2,"accepted_field":true}"#),
        ];
        let meta = stream_meta(Some("region"));
        let metadata = RwLock::new(LogStreamMetadata::default());
        let events = build_events(&records, "test", &None, &meta).unwrap();
        let (accepted, committed) = commit_compatible_events(&metadata, events).unwrap();

        assert!(committed);
        assert_eq!(accepted.len(), 2);
        assert!(std::ptr::eq(accepted[0].record, &records[0]));
        assert!(std::ptr::eq(accepted[1].record, &records[2]));
        let stored = metadata.read().unwrap();
        assert_eq!(stored.schema["x"].data_type(), &DataType::Float64);
        assert_eq!(
            stored.schema["accepted_field"].data_type(),
            &DataType::Boolean
        );
        assert!(!stored.schema.contains_key("rejected_field"));
        for accepted in &accepted {
            for field in accepted.event.rb.schema().fields() {
                assert_eq!(stored.schema.get(field.name()), Some(field));
            }
        }
    }

    #[test]
    fn all_conflicting_records_leave_metadata_unchanged() {
        let _guard = TEST_LOCK.lock().unwrap();
        let records = vec![
            record(r#"{"region":"west","x":"bad","rejected_a":1}"#),
            record(r#"{"region":"east","x":true,"rejected_b":2}"#),
        ];
        // A schema snapshot may become stale before commit (another worker can
        // establish x's type); both events build but neither may commit.
        let meta = stream_meta(Some("region"));
        let metadata = RwLock::new(LogStreamMetadata {
            schema: HashMap::from([(
                "x".to_owned(),
                Arc::new(Field::new("x", DataType::Float64, true)),
            )]),
            ..Default::default()
        });
        let before = metadata.read().unwrap().schema.clone();
        let events = build_events(&records, "test", &None, &meta).unwrap();
        assert_eq!(events.len(), 2);
        let (accepted, committed) = commit_compatible_events(&metadata, events).unwrap();

        assert!(accepted.is_empty());
        assert!(!committed);
        assert_eq!(metadata.read().unwrap().schema, before);
    }

    #[test]
    fn skip_warnings_include_source_identity_and_tenant() {
        let _guard = TEST_LOCK.lock().unwrap();
        let mut records = vec![
            record("not json"),
            record(r#"[{"region":"west"}]"#),
            record(r#"{"n":1}"#),
            record(r#"{"region":"west","p_timestamp":"reserved"}"#),
            record(r#"{"region":"west","x":1}"#),
            record(r#"{"region":"east","x":"text"}"#),
            record("null"),
            record(""),
        ];
        records.last_mut().unwrap().payload = None;
        for (offset, record) in records.iter_mut().enumerate() {
            record.partition = 7;
            record.offset = offset as i64 + 100;
            record.tenant_id = Some("test-tenant".to_owned());
        }
        #[derive(Clone)]
        struct LogWriter(Arc<std::sync::Mutex<Vec<u8>>>);
        impl std::io::Write for LogWriter {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(bytes);
                Ok(bytes.len())
            }

            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let output = Arc::new(std::sync::Mutex::new(Vec::new()));
        let writer = LogWriter(output.clone());
        let subscriber = tracing_subscriber::fmt()
            .without_time()
            .with_ansi(false)
            .with_max_level(tracing::Level::WARN)
            .with_writer(move || writer.clone())
            .finish();
        let check = || {
            let meta = stream_meta(Some("region"));
            let events = build_events(&records, "test", &None, &meta).unwrap();
            let metadata = RwLock::new(LogStreamMetadata::default());
            let (accepted, _) = commit_compatible_events(&metadata, events).unwrap();
            assert_eq!(accepted.len(), 1);
        };
        tracing::subscriber::with_default(subscriber, check);
        let output = String::from_utf8(output.lock().unwrap().clone()).unwrap();
        let warnings: Vec<_> = output.lines().collect();
        assert_eq!(warnings.len(), 7, "{output}");
        for (warning, offset) in warnings.iter().zip([100, 101, 102, 103, 106, 107, 105]) {
            for field in [
                "topic=test".to_owned(),
                "partition=7".to_owned(),
                format!("offset={offset}"),
                "tenant=\"test-tenant\"".to_owned(),
                "Skipping Kafka record".to_owned(),
            ] {
                assert!(warning.contains(&field), "missing {field} in {warning}");
            }
        }
        assert!(output.contains("conflicting schema"), "{output}");
    }

    #[test]
    fn custom_partition_builds_one_event_per_valid_record() {
        let _guard = TEST_LOCK.lock().unwrap();
        let records = vec![
            record(r#" {"region": "west", "status": 200} "#),
            record(r#"{"message": "missing region", "status": 200}"#),
            record("not json"),
            record(r#"{"region": "east", "status": 500}"#),
        ];
        let tenant_id = Some("tenant".to_owned());
        let events = build_events(
            &records,
            "test",
            &tenant_id,
            &stream_meta(Some(" region , status ")),
        )
        .unwrap();

        assert_eq!(events.len(), 2);
        for (event, record_index, region, status) in [
            (&events[0], 0, "west", "200"),
            (&events[1], 3, "east", "500"),
        ] {
            assert_eq!(
                event.event.custom_partition_values,
                HashMap::from([
                    ("region".to_owned(), region.to_owned()),
                    ("status".to_owned(), status.to_owned()),
                ])
            );
            assert!(std::ptr::eq(event.record, &records[record_index]));
            assert_eq!(event.event.rb.num_rows(), 1);
            assert_eq!(
                event.event.origin_size,
                records[record_index].payload.as_ref().unwrap().len() as u64
            );
            assert_eq!(event.event.stream_name, "test");
            assert_eq!(event.event.tenant_id, tenant_id);
        }
    }

    #[test]
    fn custom_partition_skips_records_that_fail_conversion() {
        let _guard = TEST_LOCK.lock().unwrap();
        // `p_timestamp` is reserved, so converting that record fails; the
        // valid records around it must still become events.
        let records = vec![
            record(r#"{"region": "west", "n": 1}"#),
            record(r#"{"region": "east", "p_timestamp": "reserved"}"#),
            record(r#"{"region": "north", "n": 2}"#),
        ];
        let events = build_events(&records, "test", &None, &stream_meta(Some("region"))).unwrap();

        let regions: Vec<_> = events
            .iter()
            .map(|event| event.event.custom_partition_values["region"].as_str())
            .collect();
        assert_eq!(regions, ["west", "north"]);
        for event in &events {
            assert_eq!(event.event.rb.num_rows(), 1);
            assert!(event.event.rb.schema().field_with_name("n").is_ok());
        }
    }

    #[test]
    fn custom_partition_skips_invalid_values_and_non_objects() {
        let _guard = TEST_LOCK.lock().unwrap();
        let records = vec![
            record(r#"{"region": null}"#),
            record(r#"{"region": ""}"#),
            record(r#"{"region": {}}"#),
            record(r#"{"region": []}"#),
            record(r#"{"region": "us.west"}"#),
            record(r#"{"region": 1.5}"#),
            record(r#"[{"region": "west"}]"#),
            record("null"),
            record("42"),
            record(r#""west""#),
            record(r#"{"region": false}"#),
        ];
        let events = build_events(&records, "test", &None, &stream_meta(Some("region"))).unwrap();

        assert_eq!(events.len(), 1);
        assert_eq!(
            events[0].event.custom_partition_values,
            HashMap::from([("region".to_owned(), "false".to_owned())])
        );
    }

    #[test]
    fn non_partitioned_chunk_builds_single_event() {
        let _guard = TEST_LOCK.lock().unwrap();
        let records = vec![
            record(r#"{"region": "west", "message": "first"}"#),
            record("not json"),
            record(r#"{"message": "second"}"#),
        ];
        let events = build_events(&records, "test", &None, &stream_meta(None)).unwrap();

        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event.rb.num_rows(), 2);
        assert!(events[0].event.custom_partition_values.is_empty());
        assert_eq!(
            events[0].event.origin_size,
            records
                .iter()
                .map(|record| record.payload.as_ref().unwrap().len() as u64)
                .sum::<u64>()
        );
    }

    #[test]
    fn empty_or_invalid_chunks_build_no_events() {
        let _guard = TEST_LOCK.lock().unwrap();
        let mut missing_payload = record("");
        missing_payload.payload = None;
        let invalid_records = vec![record("not json"), missing_payload];
        for custom_partition in [None, Some("region")] {
            let meta = stream_meta(custom_partition);
            assert!(build_events(&[], "test", &None, &meta).unwrap().is_empty());
            assert!(
                build_events(&invalid_records, "test", &None, &meta)
                    .unwrap()
                    .is_empty()
            );
        }
    }
}
