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

use crate::{
    connectors::common::processor::Processor,
    event::{
        USER_AGENT_KEY, commit_ingested_schemas,
        format::{EventFormat, LogSourceEntry, json},
    },
    handlers::TelemetryType,
    metadata::SchemaVersion,
    parseable::PARSEABLE,
    storage::StreamType,
    utils::json::flatten::validate_custom_partition,
};
use arrow_schema::Field;
use async_trait::async_trait;
use chrono::Utc;
use futures_util::StreamExt;
use rdkafka::consumer::{CommitMode, Consumer};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;
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
    let events = build_events(&records, &stream_name, &tenant_id, &meta)?;
    if meta.custom_partition.is_some() && !events.is_empty() {
        // Custom-partitioned chunks yield one event per record, all built
        // against the same schema snapshot. As in the HTTP per-record path,
        // commit the union of their schemas before staging any of them, so a
        // conflict between records rejects the chunk instead of staging only
        // the events processed before it.
        let stream = PARSEABLE.get_stream(&stream_name, &tenant_id)?;
        let schemas: Vec<_> = events
            .iter()
            .map(|event| (event.rb.schema(), event.is_first_event))
            .collect();
        let committed =
            commit_ingested_schemas(&stream_name, &stream.metadata, &schemas, usize::MAX)?;
        if committed && !stream.get_static_schema_flag() {
            stream.stage_schema_file(stream.get_schema().as_ref().clone())?;
        }
    }
    for event in events {
        event.process_without_field_limit()?;
    }

    Ok(())
}

/// Builds events without accessing stream state, keeping partition values and
/// payload sizes attached to their individual records for custom partitions.
fn build_events(
    records: &[ConsumerRecord],
    stream_name: &str,
    tenant_id: &Option<String>,
    meta: &StreamMeta,
) -> anyhow::Result<Vec<crate::event::Event>> {
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

    for record in records.iter().filter_map(|r| r.payload.as_ref()) {
        total_payload_size += record.len() as u64;
        let value = match serde_json::from_slice::<Value>(record) {
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
            match into_event(value, record.len() as u64) {
                Ok(event) => events.push(event),
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
    if meta.custom_partition.is_none() && !json_vec.is_empty() {
        events.push(into_event(Value::Array(json_vec), total_payload_size)?);
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
    fn custom_partition_builds_one_event_per_valid_record() {
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
                event.custom_partition_values,
                HashMap::from([
                    ("region".to_owned(), region.to_owned()),
                    ("status".to_owned(), status.to_owned()),
                ])
            );
            assert_eq!(event.rb.num_rows(), 1);
            assert_eq!(
                event.origin_size,
                records[record_index].payload.as_ref().unwrap().len() as u64
            );
            assert_eq!(event.stream_name, "test");
            assert_eq!(event.tenant_id, tenant_id);
        }
    }

    #[test]
    fn custom_partition_skips_records_that_fail_conversion() {
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
            .map(|event| event.custom_partition_values["region"].as_str())
            .collect();
        assert_eq!(regions, ["west", "north"]);
        for event in &events {
            assert_eq!(event.rb.num_rows(), 1);
            assert!(event.rb.schema().field_with_name("n").is_ok());
        }
    }

    #[test]
    fn custom_partition_skips_invalid_values_and_non_objects() {
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
            events[0].custom_partition_values,
            HashMap::from([("region".to_owned(), "false".to_owned())])
        );
    }

    #[test]
    fn non_partitioned_chunk_builds_single_event() {
        let records = vec![
            record(r#"{"region": "west", "message": "first"}"#),
            record("not json"),
            record(r#"{"message": "second"}"#),
        ];
        let events = build_events(&records, "test", &None, &stream_meta(None)).unwrap();

        assert_eq!(events.len(), 1);
        assert_eq!(events[0].rb.num_rows(), 2);
        assert!(events[0].custom_partition_values.is_empty());
        assert_eq!(
            events[0].origin_size,
            records
                .iter()
                .map(|record| record.payload.as_ref().unwrap().len() as u64)
                .sum::<u64>()
        );
    }

    #[test]
    fn empty_or_invalid_chunks_build_no_events() {
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
