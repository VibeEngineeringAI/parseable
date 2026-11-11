# Mutable metadata boundary audit

Baseline: origin/main `d6a155f2`. Scope: stage 0 seams only. No PostgreSQL
implementation, transactions, caching, serialization changes, or race fixes.

A site below is a logical operation in a named symbol (several expressions in
one operation count once). Grouped backend implementations count once per row,
not once per provider. A includes reviewed operations already using the trait;
these are called out so an apparent ObjectStorage helper is not mistaken for a
remaining bypass. Test fixture writes are excluded from production counts.

## Inventory

Paths in the table are relative to `src/`.

| File / symbol | Class | Objects or meaning; disposition |
| --- | --- | --- |
| `parseable/mod.rs::create_stream_and_schema_from_storage`, deletion check | A | `.tombstones/<tenant>/<stream>/.tombstone` HEAD; now `Metastore::is_stream_deleting`. |
| `parseable/mod.rs::create_stream_and_schema_from_storage`, existence check | A | `.stream/*stream.json` discovery; now `Metastore::stream_exists`. Preserves LocalFS's canonical-only predicate and cloud's ingestor acceptance. |
| `parseable/mod.rs::load_tenants`, discovery | A | Root directory candidates standing for tenants; moved unchanged to `list_tenant_candidates`. Includes unrecognized directories for historical cleanup. |
| `parseable/mod.rs::load_tenants`, invalid directory cleanup | A | Whole tenant prefix, including any metadata; now existing `delete_tenant`. Same path and tenant metrics context (`None`). |
| `handlers/http/logstream.rs::delete` | A | Stream prefix, metadata and data together; now `Metastore::delete_stream`, which delegates to the identical provider operation. |
| `handlers/http/modal/query/querier_logstream.rs::delete` | A | Same deletion operation; same reroute. |
| `handlers/http/health_check.rs::readiness_internal` | A | Provider HEAD of `.parseable.json` (LocalFS has its own check); now `check_health`, preserving the provider implementation. |
| `banner.rs::storage_info` | A | Timed `.parseable.json` GET, including timing failed GETs; now `read_latency`, preserving the existing probe. |
| `storage/object_storage.rs::create_stream` | A | Schema then stream JSON; already calls `put_schema` then `put_stream_json`; unchanged. |
| `storage/object_storage.rs::update_time_partition_limit_in_stream` | A | Stream JSON read/overwrite through trait already; unchanged. |
| `storage/object_storage.rs::update_custom_partition_in_stream` | A | Same, custom partition; unchanged. |
| `storage/object_storage.rs::update_log_source_in_stream` | A | Same, log sources; unchanged. |
| `storage/object_storage.rs::update_dataset_tags_and_labels_in_stream` | A | Same, dataset tags/labels; unchanged. |
| `storage/object_storage.rs::update_first_event_in_stream` | A | Same, persisted first event timestamp; unchanged. |
| `storage/object_storage.rs::put_stats` | A | Same, whole stats replacement; unchanged. |
| `storage/object_storage.rs::put_retention` | A | Same, retention configuration; unchanged. |
| `storage/object_storage.rs::upsert_stream_metadata` | A | Mode-specific stream JSON or fallback base read then mode write; already trait. Retains even the original return of base bytes after writing modified config. |
| `storage/object_storage.rs::put_snapshot` | A | Upsert then snapshot replacement via trait; unchanged. |
| `storage/object_storage.rs::create_stream_from_querier` | A | Base stream JSON read, stats/snapshot reset, mode-specific write; already trait. |
| `storage/object_storage.rs::create_stream_from_ingestor` | A | Enumerate ingestor JSONs, merge sources/tags/labels, publish; already trait. |
| `storage/object_storage.rs::create_schema_from_metastore` | A | `fetch_schema` then `put_schema`; already trait. |
| `storage/object_storage.rs::get_log_source_from_storage` | A | Merge source descriptions from all stream JSONs; already trait. |
| `storage/object_storage.rs::commit_schema_to_storage` / `process_schema_files` | A | Schema read/merge/write then memory update and staging cleanup; already trait. No reordering. |
| `storage/store_metadata.rs::resolve_parseable_metadata` / `put_remote_metadata` | A | `.parseable.json`, RBAC, deployment and tenant configuration; already `get/put_parseable_metadata`. |
| `catalog/mod.rs::update_snapshot`, `handle_existing_partition`, `finalize_snapshot_update`, `remove_manifest_from_snapshot` | A | Stream snapshot, manifest reads/writes and stats; already trait (including `put_snapshot` helper). |
| `handlers/http/logstream.rs::{put_stream_hot_tier,delete_stream_hot_tier,get_stream_hot_tier_internal}` | A | Shared hot-tier enablement/config reads and whole stream JSON writes already use trait; local cache config is C below. |
| `storage/retention.rs::action::delete` metadata publication | A | Remove snapshot references and update deleted stats/first event through trait-backed helpers; unchanged. |
| `handlers/http/modal/mod.rs` node registration and HTTP modal node management | A | Node registry JSON; already `put/get/delete_node_metadata`; unchanged. |
| `migration/mod.rs::{run_migration,migration_stream,fetch_or_create_stream_metadata,migrate_stream_metadata,setup_logstream_metadata,put_remote_metadata}` | A | Discover streams, migrate JSON versions, publish schema/stream/deployment metadata; already trait, including helper calls. Retained this policy for all live migration reads/writes. Pure transforms in `metadata_migration.rs` and `stream_metadata_migration.rs` have no storage access. |
| `metastore/metastores/object_store_metastore.rs::{refresh_schema,get_all_schemas}` and `storage/object_storage.rs::schema_objects`, `storage/localfs.rs::schema_objects` | A | Schema enumeration/canonical union publication; raw storage only inside backend implementation/adapters. No application calls to `schema_objects`. |
| `storage/{s3,gcs,azure_blob,localfs}.rs::{stream_exists,list_streams,list_old_streams,get_ingestor_meta_file_paths,try_delete_node_meta,check}` and `object_storage.rs::{stream_exists,get_latency}` | A | Physical metadata predicates, node file enumeration/deletion and diagnostic probes. Provider primitives remain for backend use; active application calls now enter the trait. Legacy unused primitives noted below. |
| `metastore/metastores/object_store_metastore.rs` remaining metadata CRUD | A | Keystones, conversations, alerts, alert history, MTTR, LLM config, targets, outbound policy, dashboards (including conditional tombstones), chats, filters, schemas, manifests, deployment/tenant and node records. All raw object operations are backend implementation details already. |
| `storage/object_storage.rs::{upload_single_parquet_file,validate_uploaded_parquet_file}` | B | Multipart Parquet write, HEAD length validation, failed-upload object cleanup; data durability/size, not catalog authority. Left unchanged. |
| `storage/object_storage.rs::{get_first_and_latest_event_from_storage,extract_timestamp_for_date}` | B | Date/hour/minute directory scans implicitly stand for first/latest event timestamps with minute rounding. Future catalog bounds must preserve rounding. |
| `storage/object_storage.rs::{update_storage_metrics,upload_files_from_staging}` | B | Physical Parquet sizes/date names and publication pipeline. Metrics implicitly stand for ingestion/storage totals; metadata publication already enters trait. |
| `storage/retention.rs::action::delete` partition deletion | A | Mixed daily data/manifest prefix deletion now enters `delete_stream_partition`; the backend performs exactly the original prefix DELETE after snapshot publication, with the same concurrent per-date tasks. |
| `storage/retention.rs::action::delete` date listing | B | Directory names imply retention candidates; remains on storage. A future catalog/GC design must select catalog-native partitions instead. |
| `query/listing_table_builder.rs::ListingTableBuilder::populate_via_listing` | B | Partition prefixes imply legacy file membership; unchanged. |
| `query/stream_schema_provider.rs::{scan,legacy_listing_table,parquet_scan_plan}` | B | Legacy directory-derived membership and Parquet execution; modern metadata fetches already trait. File untouched, as requested. |
| `hottier.rs` download/planning and `hottier/planner.rs::build_work` | B | Remote Parquet fetches and directory-derived minute buckets imply cache work/time ranges; manifests already trait. |
| `parseable/mod.rs::validate_storage` root directory occupancy probe | B | Physical nonempty-store detection (even arbitrary nonmetadata directories affect startup). Metadata existence and stream listing already trait. Kept physical occupancy check; replacing it with catalog listing changes stale-storage detection. |
| `storage/{s3,gcs,azure_blob,localfs}.rs::{list_dates,list_hours,list_minutes,list_dirs_relative,delete_prefix}` | B | Data layout primitives, tenant scoping, metrics, retries and provider errors. Kept as physical adapters; metadata consumers confined to metastore. |
| `storage/field_stats.rs::calculate_field_stats` | B | Derived field statistics ingested as stream data, not a mutable JSON authority; file-derived timestamp remains. |
| `storage/store_metadata.rs::{get_staging_metadata,put_staging_metadata}` | C | Staging `.parseable.json` describes local deployment association; filesystem only, retained. |
| `migration/mod.rs::{get_staging_metadata,put_staging_metadata}` | C | Local migration staging copy; retained. |
| `parseable/streams.rs` schema staging, stream staging metadata and WAL | C | Local ingestion recovery state and schema files; retained. Shared schema commit already trait. |
| `hottier.rs::{read_hot_tier_config,put_hot_tier,delete_hot_tier}` and `hottier/local_state.rs` | C | Local `.hot_tier.json`, cache manifests/runtime state and local filesystem operations; retained. Shared hot-tier enablement/config in stream JSON already trait. |
| `storage/object_storage.rs::list_tombstoned_streams` and unused legacy provider discovery/node helpers | D | No production callers of tombstone discovery, `list_old_streams`, `get_ingestor_meta_file_paths`, or `try_delete_node_meta` outside backend/adapters. Retain dormant compatibility APIs and fixture tests. A future deletion recovery/legacy-layout import feature must expose semantic metastore methods before using them. |

Counts: **33 A, 10 B, 4 C, 1 D** logical operation groups. Nine application
call sites changed; the other A groups already persisted through the trait or
implement its physical adapter.

## Contract additions

Existing methods and signatures are unchanged. PostgreSQL must implement:

```rust
async fn check_health(&self, tenant_id: &Option<String>) -> Result<(), MetastoreError>;
async fn read_latency(&self, tenant_id: &Option<String>) -> std::time::Duration;
async fn stream_exists(&self, stream_name: &str, tenant_id: &Option<String>) -> Result<bool, MetastoreError>;
async fn is_stream_deleting(&self, stream_name: &str, tenant_id: &Option<String>) -> Result<bool, MetastoreError>;
async fn delete_stream(&self, stream_name: &str, tenant_id: &Option<String>) -> Result<(), MetastoreError>;
async fn delete_stream_partition(&self, stream_name: &str, date: &str, tenant_id: &Option<String>) -> Result<(), MetastoreError>;
async fn list_tenant_candidates(&self) -> Result<Vec<String>, MetastoreError>;
```

`delete_stream` and `delete_stream_partition` include physical deletion: PostgreSQL must orchestrate catalog
and data cleanup, just as existing `delete_tenant` already includes both. This
seam introduces no transaction or new deletion protocol. `list_tenant_candidates`
preserves invalid candidates for cleanup; another backend may return only its
registered tenants. The legacy deletion-marker check remains separate from
existence, in the same order. It does not introduce marker publication.

## Races deliberately preserved

All stream-setting/stats/retention/first-event/snapshot updates read and blindly
replace the entire stream JSON. Schema commit and refresh merge schemas then
unconditionally publish; concurrent writers can lose fields. Manifest updates
and stream snapshot publication are separate unconditional writes; retention
can race ingestion, settings, stream deletion and queries. RBAC/deployment
metadata, alert state/history, filters and node registration have blind
whole-record writes or separate discovery/write/delete sequences. Tenant
validation/cleanup races concurrent tenant creation. Check-then-load and
check-then-delete remain racy. No CAS conversion, locks, retries, cache, or
transaction was added. Dashboard CAS behavior is unchanged.

## Guard and evidence

`metastore::boundary_tests` scans production Rust source before the trailing
`#[cfg(test)]` section. Outside the object-store metastore and four provider
adapters it rejects every raw `put_object`, `upload_file`, conditional PUT and
conditional DELETE, regardless of literal/computed key. It permits exactly one
multipart publisher in `object_storage.rs`, exactly one failed-Parquet DELETE
there, and no raw prefix DELETEs in application code. Tests verify
rejection of computed keys and whitespace-split method calls. This is a
conservative source policy, not runtime provenance or Rust type analysis. It
cannot detect mutations through new APIs, raw object_store clients, macros,
code after the first test section, or changes hidden in allowed adapters. The
existing allowed physical publishers still require review if their arguments
change. It does not prove read routing or transaction safety.

Compatibility evidence: the nine application bypasses now delegate to exactly
the original provider operations. Provider errors are unwrapped again at the
rerouted legacy call sites, preserving HTTP error mapping and error text. JSON encoders, paths, payloads, write modes,
operation order and provider implementations are unchanged. The LocalFS
lifecycle fixture compares discovery and existence against raw provider results,
asserts exact JSON bytes survive probes, verifies the separate tombstone survives
stream prefix deletion, and compares missing-stream deletion errors. A second
fixture verifies partition deletion removes both Parquet and manifests while
preserving adjacent-date and other-tenant bytes. Existing
schema-refresh/manifest/dashboard/provider tests remain in the full library
suite. No live service or bucket was used; no container was started. No
main-versus-branch MinIO object diff was performed, so provider integration parity
is supported by unchanged delegates and unit tests, not an end-to-end claim.

Open follow-up: catalog-native deletion/GC, imported legacy file membership,
first/latest timestamp semantics, and removal or semantic exposure of dormant
legacy APIs need later stages. Backend selection and PostgreSQL implementation
are intentionally outside this change.

Final validation on this branch:

- `P_BUILD_NO_UI=1 CARGO_BUILD_JOBS=4 cargo clippy --all-targets`: exit 0;
  21 existing library-test warnings, none in changed files.
- `P_BUILD_NO_UI=1 CARGO_BUILD_JOBS=4 cargo test --lib`: exit 0;
  **1,379 passed, 0 failed, 4 ignored** (1,383 discovered), 79.65 seconds.
- Both source-guard tests and both LocalFS compatibility fixtures passed.
- `cargo fmt` and `git diff --check` passed. Cargo target remained in this worktree.


## Combined PostgreSQL lifecycle implementation

The original inventory above records the routing branch. In the combined branch,
its seven missing methods are implemented by PostgreSQL as documented in
[postgres-metastore.md](postgres-metastore.md#lifecycle-and-metadata-boundary).
Backend primitives moved to `document_metastore.rs` and `postgres_documents.rs`
are allowed by the source guard. The real MinIO lifecycle smoke supplements
that source policy with bucket key assertions. All A operations now select the
configured backend. B/C/D entries remain data plane, local recovery state or
unused compatibility primitives. No additional active shared metadata bypass
was found. PostgreSQL stream listing suppresses durable deletion markers, and
HTTP DELETE permits explicit retry of such a stream after restart.
