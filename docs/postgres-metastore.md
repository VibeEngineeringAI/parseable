# PostgreSQL document metastore

Opt in using `--metastore-postgres-url` / `P_METASTORE_POSTGRES_URL` on any
storage subcommand. No setting is required for the default object-store backend.
For an isolated local PostgreSQL, for example:

```
P_METASTORE_POSTGRES_URL='postgresql://user:password@127.0.0.1:55432/parseable?sslmode=disable' \
P_BUILD_NO_UI=1 target/debug/parseable s3-store
```

Keep the URL in a secret. Options Debug output redacts it. All participants
(standalone, ingest, query and prism) must select the same backend/database.
Neither startup nor runtime falls back to bucket metadata after selecting SQL.
Builds use runtime queries and need no `DATABASE_URL` or live database.

| Option suffix (also `P_METASTORE_POSTGRES_<SUFFIX>`) | Default |
| --- | --- |
| URL | unset; object-store metadata |
| POOL_SIZE | 16 connections per process |
| CONNECT_TIMEOUT_MS | 5000; also bounds pool wait/create/recycle |
| STATEMENT_TIMEOUT_MS | 10000; also bounds SQL lock waits |
| ID | unset; optionally pin the backend UUID |
| CA | unset; optionally trust only a PEM CA bundle |

CLI spellings use `--metastore-postgres-` plus lowercase hyphenated suffix.
TLS defaults to required with certificate and hostname verification against
webpki roots. URL `sslmode=disable` explicitly opts out. `prefer` and `allow` are
upgraded to required, so TLS cannot silently downgrade. Client certificates are
not implemented in this slice.

## Pairing and migrations

The first initialization creates a UUID and records the configured storage
endpoint/bucket identity. After committing SQL and releasing its connection, it
conditionally creates `.parseable/postgres-metastore-id` in that bucket. Existing
markers must contain the database UUID. Concurrent starts use a transactional
PostgreSQL advisory lock and atomic bucket creation. Partial initialization is
retryable, with no metadata service admitted until both checks succeed.
A preexisting marker paired to another database fails startup. A database bound
to another bucket/endpoint also fails. `ID` can pin an expected existing UUID.
Endpoint aliases are intentionally conservative: changing an endpoint spelling
requires an explicit operator pairing migration, even for the same bucket.
Never delete the marker to bypass a mismatch. Back up the database and marker
together; restoring a fresh empty database is not a metadata recovery procedure.
The marker is identity protection, not fencing against old binaries.

`parseable_backend` records singleton UUID, bucket identity, schema and protocol
version. Embedded migrations `001_documents.sql` and `002_review_fixes.sql` are forward-only, transactional,
and serialized across starting nodes. Unknown versions fail closed.
`parseable_documents` stores `(tenant, key)` primary keys, an advisory `kind`,
faithful BYTEA bodies, BIGINT version, and creation/update timestamps. Keys retain
object-store path spelling including tenant prefixes. The default tenant uses
an empty tenant column, exactly as root bucket paths do. Versions come from a
backend-wide sequence, avoiding delete/recreate ABA; gaps are expected. Atomic
INSERT/UPDATE/DELETE preconditions implement dashboard versions.

The documents table and broad `document` kind are interim. Manifests remain
compressed documents, with existing whole-document read/modify/write behavior.
This is not atomic catalog publication, retention, compaction, reader pinning or
multi-document transactions. Future normalized catalog tables can coexist with
the document keyspace without changing existing document versions.

## Compatibility and data plane

The implementations share the existing metastore path/encoding/behavior code.
SQL primitive operations preserve raw bytes and sort keys with C collation.
Not-found GETs use the existing NoSuchKey error; optional getters retain their
existing conversions. Default filesystem behavior is retained for object-store
metastore. SQL listing always uses its document inventory, including local-store
standalone. Local filesystem multitenancy is still unsupported product policy.

Existing ambiguous behavior is retained: default alert-state listing uses the
literal `DEFAULT_TENANT` directory although state writes use root paths; global
outbound-policy maps use the empty-string default key unlike other maps; manifest
inventory completion order is unspecified. SQL directory enumeration returns
immediate child names; S3's current `list_dirs_relative` flattens ancestor path
components as well, an apparent implementation accident that does not define
useful directory semantics. SQL cannot see externally written bucket metadata.

Parquet, local staging/WAL, hot-tier data and object-store discovery remain in
the data plane. Lifecycle routing is included in this branch. Existing buckets need a separate
import before opting in. Do not switch a populated deployment in place.

An import tool needs the original tenant and exact path key, original bytes
(including compressed manifest bytes), a validated kind, and object-store mode
and owner naming context. It should allocate fresh native versions, validate
schemas/JSON and cross-document manifest references, quiesce old writers, and
pair/verify the bucket UUID before admission. Upstream ETags cannot be reused as
SQL versions. Offline import/export is described below; normalized file catalog conversion is
separate work.

## Validation

Use `PATH=$HOME/.cargo/bin:$PATH P_BUILD_NO_UI=1 CARGO_BUILD_JOBS=4` and keep
`target` in the checkout. Run one Cargo compilation at a time.

```
cargo test --lib contract_tests -- --nocapture
P_TEST_POSTGRES_URL='postgresql://postgres:password@127.0.0.1:55432/test?sslmode=disable' \
  cargo test --lib contract_tests -- --nocapture
cargo build
python3 scripts/postgres-metastore-smoke.py
cargo clippy --all-targets
```

Use an empty disposable database for the SQL contract. With no test URL the SQL
test reports a skip and succeeds. The smoke script creates PostgreSQL 17 Alpine (including a verified TLS run)
and MinIO containers on randomly selected spare ports, isolated buckets and
staging, and removes its containers in `finally`. It runs stream creation,
ingestion, upload, retention configuration/startup execution, dashboard creation,
restart, query/ingest cold loading, repeated queries, deletion/recreation and
dependency outages in both modes. A separate SQL database exercises a self-signed
CA through `P_METASTORE_POSTGRES_CA`; an unrelated CA must reject startup. `.postgres-smoke/results.json` records key inventory, SQL rows and
storage metric deltas (background storage activity can contribute to deltas).

## Lifecycle and metadata boundary

All active mutable shared metadata operations now enter `Metastore`, including
health probes, cold stream discovery, stream/partition deletion and tenant
startup discovery. The companion audit is in [metastore-boundary-audit.md](metastore-boundary-audit.md).
The shared document layer retains encodings and existing CRUD behavior; the
seven lifecycle methods are supplied by each backend.

* `stream_exists`: SQL inventory of canonical/ingestor stream JSON under the
  tenant's stream prefix; no bucket metadata lookup.
* `is_stream_deleting`: durable SQL `.stream/.deleting` document, visible across
  processes and restarts, checked before lazy loading.
* `delete_stream`: commit the SQL marker, delete the bucket data prefix, then
  delete all stream rows (including the marker) in one SQL statement. Before
  data deletion a crash leaves hidden metadata and recoverable data; afterwards
  it leaves hidden metadata with missing data. Retrying completes either case.
  Once complete, recreation starts without old schemas/manifests/settings.
* `delete_stream_partition`: the caller first publishes snapshot removal, then
  the backend deletes partition data, then SQL rows under that date prefix.
  A crash can leave unreferenced data or unreferenced manifest rows; retry
  removes them. No snapshot ever gets republished here.
* `list_tenant_candidates`: union of nonempty SQL tenant columns and nonhidden
  root bucket prefixes. SQL-only tenants are retained when their deployment
  metadata validates; data-only/invalid candidates follow existing startup
  cleanup, deleting both data and rows. With multitenancy disabled these are
  physical candidates only; cloud object stores remain the supported product
  configuration for multitenancy.
* `check_health`: checks SQL `SELECT 1` and reads the bucket pairing marker on
  every probe. Readiness returns 503 if either fails. Liveness retains its
  process/shutdown semantics. Pool waits/connects and SQL statements are bounded
  by the configured timeouts; there is no metadata fallback.
* `read_latency`: elapsed combined SQL and bucket probe, labeled as such in the
  banner; probe errors are logged. It is not a standalone SQL latency measure.

The bucket's only metadata object in PostgreSQL mode is the immutable pairing
id `.parseable/postgres-metastore-id`. Its read is an intentional health probe.
LocalFS conditional marker creation additionally uses a private filesystem lock
file; this is local coordination, not a second metadata authority.
Parquet reads/writes, date/hour/minute discovery for bounds and retention,
legacy file listing, hot-tier planning and physical occupancy remain bucket
operations. Dormant tombstone/legacy provider helpers remain unused by
application code. Staging/WAL and hot-tier local recovery files remain local.
No other active metadata bypass was found in the combined inventories.

Deletion markers reject new stream metadata writes in PostgreSQL mode; deletion does not fully fence concurrent writers. Existing whole-document read/modify/
write races, retention/publication races and check-then-load races remain.
Automatic resumption of interrupted deletion is not implemented: retry the
operation. Semantic catalog APIs, atomic publication, reader pins, compaction,
conditional writes beyond dashboards remain future work.

## Driver cost

The driver is `tokio-postgres` with `deadpool-postgres` and
`tokio-postgres-rustls`. The existing repository already uses Tokio and rustls
0.23; this avoids a second TLS stack and compile-time database introspection.
See the [client documentation](https://docs.rs/tokio-postgres/latest/tokio_postgres/)
and [pool documentation](https://docs.rs/deadpool-postgres/latest/deadpool_postgres/).
The lockfile adds 34 package/version entries, including target-specific entries
and resolution changes. The six core PostgreSQL/pool debug rlibs total about
16 MB. The first full debug build on this checkout took 4m17s after `cargo check`
had populated metadata artifacts; that is not an isolated driver compile-time
measurement. The incremental footprint does not justify a backend feature gate
relative to the existing Arrow/DataFusion build.

The shared contract calls every existing trait method against filesystem-backed
object metadata and real PostgreSQL. It covers both tenant namespaces, missing
objects, global getters, schema union/refresh, manifest encoding/listing,
Ingest-only listing and invalid mode selection, filter reconciliation, alert
state/history, node registration, and conditional dashboard create/update/delete.
It also tests concurrent initialization, concurrent create/update winners,
delete/recreate versions, bounded pool exhaustion and statement timeouts.
Filesystem delimiter listing is unsupported and its stream listing rejects
unrelated root metadata directories; these preexisting differences are explicit
expectations. The SQL path uses bucket-style listing semantics. Empty-string and absent
default tenant schema lookups are equivalent. The smoke covers query/ingest cold loading; broader prism and multi-tenant cluster validation remains future work.

## Recorded combined validation

2026-11-11 UTC, PostgreSQL 17 Alpine and MinIO on isolated ephemeral host ports.
No live service or bucket was used. All temporary containers were removed.
Debug build passed. Real PostgreSQL and LocalFS contracts: 2 passed. Full library
suite without a database URL: 1,381 passed, 4 ignored. Integration: 1 passed.
Plain `cargo clippy --all-targets` passed with 21 existing library-test warnings
and no new warnings. Source guard and compatibility fixtures passed unchanged
in meaning. SQL contracts also check physical data before/after injected
deletion failures, retry, tenant isolation, partition deletion, hidden deletion
markers, recreation, and absence of deleted stream rows.

The smoke passed in object-store, PostgreSQL plaintext and verified TLS modes:
create, ingest/upload, retention settings, dashboard, restart as query node
(running startup retention), ingestor publication of a new stream and cold query,
stream deletion/recreation, upload, and query of the new value (7 rather than 42).
Parquet visibility precedes manifest/snapshot publication; the harness permits
that existing pipeline to settle before cold queries. Normal requests have a
30-second client limit; cold/recreated queries allow 90 seconds. Database outage
requests retain the 30-second limit.

Both SQL configurations observed readiness 503 and a failed metadata request
when PostgreSQL stopped (combined probes/requests completed in under 7 ms on
this local run), then successful readiness and queries after recovery. All
three configurations observed readiness 503 when MinIO stopped. TLS used a
self-signed CA through `P_METASTORE_POSTGRES_CA`; an unrelated CA rejected startup.
Future schema versions, wrong pinned UUIDs and unreachable databases also
rejected startup.

Five repeated queries measured the query process's counters after cold loading,
with an ingestor also running:

| Backend | Metadata GETs/query | LIST + LIST_DELIM/query | Parquet GET_RANGES/query | Total/query |
| --- | ---: | ---: | ---: | ---: |
| Object store | 6 | 2 | 1 | 9 |
| PostgreSQL plaintext | 0 | 0 | 1 | 1 |
| PostgreSQL verified TLS | 0 | 0 | 1 | 1 |

These are node-local request counts, not latency or deployment-wide totals;
background activity can contribute. The earlier standalone measurement was 4
versus 1 and used a different topology. Both SQL buckets contained only the
pairing marker and Parquet, including after recreation. Before recreation, the
deleted stream had zero SQL rows. Dashboard, node registry, schema, stream and
manifest documents remained exclusively SQL. Exact inventories, counter deltas,
outage outcomes and test summary are in [the evidence](validation/postgres-metastore-smoke.json).

Remaining risks are unconditional document update races, publication/retention
races and lack of fencing against concurrent writers or resident readers during
deletion. Interrupted deletion requires explicit retry. Automatic recovery/GC,
reader pins, multi-tenant cluster/prism smoke and client-certificate
TLS remain future work.

## Offline migration and rollback

Use this build on **every** node before attempting a transfer. The offline command
shares each storage subcommand's provider configuration and PostgreSQL TLS/pool
options. It does not start HTTP, ingest, retention or background sync services:

```
parseable s3-store --metadata-migration verify --acknowledge-server-stopped
parseable s3-store --metadata-migration import --acknowledge-server-stopped --dry-run
parseable s3-store --metadata-migration import --acknowledge-server-stopped
parseable s3-store --metadata-migration export --acknowledge-server-stopped
```

`local-store`, `blob-store` and `gcs-store` accept the same flags. LocalFS is for
single-tenant use only. Configure `P_METASTORE_POSTGRES_URL` even for verify and
export, together with exactly the original storage endpoint/bucket. Keep the URL
out of shell history. An empty disposable database is required for a first import.
A successful import cannot be applied again to a populated database. An interrupted
import with its matching migration marker can resume, checking every body again.

Single-node procedure:

1. Back up the entire bucket (including hidden keys), the server configuration,
   staging directory and any existing PostgreSQL database. Preserve object versions
   if available. Record the deployed binary version. Test restoration separately.
2. Let uploads finish, then stop the server and disable automatic restarts. Stop
   scripts or other writers too. Supply the original `P_STAGING_DIR`; the command
   rejects `.arrow`, `.arrows`, `.part` and `.parquet` staging buffers. Resolve unsynced
   buffers by restarting the old mode and allowing upload, then stopping again.
3. Set the destination PostgreSQL URL, leaving all storage settings unchanged.
   Run verify; differences and a nonzero exit are expected before first import.
   Save its per-key SHA-256 output. Run import with `--dry-run`, inspect
   the counts per tenant/kind, bytes and recent-write warnings. This creates no
   SQL tables, identity or bucket objects.
4. Run import without dry-run. It validates stream JSON, schemas, compressed and
   plain manifests, and every snapshot manifest reference before publishing SQL.
   It rereads SQL bodies and compares SHA-256 digests, checks the bucket inventory
   for changes, commits the complete SQL inventory, then establishes pairing.
5. Run verify again: require zero differences. Start the server with the same
   PostgreSQL URL. Confirm readiness, stream list, schemas, stats, first/latest
   event bounds, RBAC, alerts, dashboards and filters. Query known time ranges and
   compare row counts/values against saved results before admitting ingest.
6. Keep the original bucket metadata and backups until the rollback window ends.
   PostgreSQL writes do not update those original objects.

Rollback/downgrade:

1. Back up PostgreSQL, the paired bucket, staging and configuration again. Drain
   uploads and stop all writers and automatic restarts as above.
2. Run verify and retain the differences. SQL changes since import normally mean differing bucket objects. Export compares the current bucket against per-key import digests; ordinary SQL changes and deletions require no force flag.
3. Review the differences; export normally to replace imported bodies and remove imported bucket-only metadata. If a bucket writer changed metadata after import, export refuses; after comparing backups explicitly use `--overwrite-bucket-changes-since-import` to accept overwriting that writer’s changes. Parquet is unaffected. Export rereads
   each written body, validates all stream references, then removes pairing.
4. Run verify and require zero differences. Remove the PostgreSQL URL and start
   object-store mode. Repeat readiness, metadata and known-query checks, including
   rows ingested while PostgreSQL was active. Keep the SQL backup. The exported
   database is marked exported and refuses normal SQL startup; reimport into a
   fresh empty database to switch back later.

The shared document layer inventories exact stored keys rather than rebuilding
paths. All hidden document namespaces (deployment/RBAC, users, dashboard bodies,
locators/titles, filters, alerts/state/history, correlations, targets/settings,
node registry, stream JSON and schemas) and date-partition manifests, including
per-ingestor variants and tenant prefixes, are copied without reserialization.
SQL versions are freshly allocated. Unfinished deletion markers are rejected.
Parquet, staging/WAL, hot-tier/cache files and private LocalFS lock files are not
metadata documents and are excluded, as are the pairing and transfer controls.
Inventories retain keys/timestamps only; bodies are read sequentially and SQL
export pages contain at most 32 bodies. Progress/digests go to stdout/stderr;
protect these reports because keys may contain user/tenant identifiers.

Crash recovery:

* Before the durable `.parseable/metastore-migration` marker, failures leave the
  source authoritative and no committed import rows. SQL bootstrap may already
  have committed an empty identity; bucket mode remains available.
* During import, an open SQL transaction rolls back on process death. The marker
  blocks both server modes. Rerun the same import/configuration to restart.
* After import commit but before pairing/cleanup, all SQL rows already exist and
  were verified. Rerunning validates them against the bucket, completes pairing
  and removes the transfer marker. A changed source fails closed.
* During export, the pairing and transfer marker block object-store startup;
  the SQL transfer state also blocks SQL startup, even after pairing removal.
  Rerun export with the same overwrite flag to finish writing and verification.
* After export pairing removal but before marker cleanup, rerun export. Never
  manually remove a transfer marker to force startup.

These controls are **not fencing**. The stopped-server acknowledgement is mandatory
also for verify/dry-run. Recent metadata writes (including registry updates) cause
loud warnings; staging buffers cause refusal. Neither check proves that a remote
writer or resident process is stopped, and a quiet writer can wake at any moment.
The staging check only examines the path supplied to the command. Disable writers
operationally and do not run two migration tools simultaneously. This build refuses
object-store startup on a paired bucket. `P_ALLOW_PAIRED_BUCKET=<pairing-id>` explicitly
bypasses pairing for disaster recovery and can expose stale metadata; it never
bypasses an incomplete transfer. Older binaries cannot recognize either marker;
do not start them until a verified export completes.

### Migration validation evidence

The migration tests passed with PostgreSQL 17 Alpine on an ephemeral host port:
1,384 library tests passed, 4 ignored. The fixture uses a separate disposable
SQL database, checks both default and named tenant document scopes, plain and
compressed manifests, snapshot references, missing/invalid stream documents,
nonempty refusal, committed-import resumption, overwrite refusal, exported SQL
startup refusal and exact byte equality after the round trip. With no
`P_TEST_POSTGRES_URL`, the SQL fixture explicitly skips. Debug build and plain
`cargo clippy --all-targets` passed; Clippy retains the 21 preexisting library-test
warnings and the preexisting staging integration-test warning.

Run `python3 scripts/postgres-metastore-migration-smoke.py` after building. This
sibling of the existing smoke creates its own PostgreSQL 17 and MinIO containers,
three datasets (including custom partitions), uploaded manifests, a user/role,
dashboard, saved filter and alert. It kills import and export after the durable
transfer marker becomes visible, reruns each, checks both server modes reject
an incomplete import, checks nonempty and paired-bucket refusal, compares SQL
queries and metadata, ingests a new SQL-mode row, exports, and checks rollback
queries and metadata. Response ordering and the generated stats response timestamp
are excluded from comparisons; persisted stats and event bounds are compared.
The MinIO scenario passed, including the final metadata comparisons after rollback.
All containers are removed in `finally`; the script uses only spare host ports.

This does not establish production-scale throughput or multi-node fencing.
Legacy objects that the current provider cannot reread because of historical
path/encoding problems fail validation; the command does not guess replacement
keys. Resolve those anomalies with backups before migrating.

## Review fixes and operating changes

An empty or whitespace-only PostgreSQL URL selects object-store mode. Pool and timeout tuning is ignored when that backend is inactive.
When selected, numeric tuning must contain positive integers. The object-store metastore and
bulk storage client retain separate request budgets: sharing them would also
make metadata reads compete with Parquet traffic, altering default-mode request
scheduling. Lifecycle prefix deletes currently use the metadata client's budget.

Migration `002_review_fixes.sql` changes the key column to `COLLATE "C"` and
rebuilds its primary key transactionally under the same startup advisory lock.
On a large database, budget startup time for that rebuild and its exclusive table
lock. Prefix reads and deletes use explicit component-bounded ranges; they do not
require PostgreSQL 15's `starts_with` optimization. Listings are tenant-scoped
and key-only; manifest query planning uses one SQL batch rather than one pooled
connection per manifest. SQL manifest locators are bucket-relative on every
provider; old absolute LocalFS locators are accepted on read. No other SQL
caller uses the provider-absolute locator form. Existing cloud
locators retain their spelling, including percent escapes; SQL delimiter listings
also preserve exact stored keys instead of escaping them a second time. Parquet paths remain provider-specific.

Stream document writes and deletion markers serialize through a database trigger.
While a deletion marker exists, stream creation and schema/stream updates fail
with a distinct deletion-pending error (HTTP 409 on metastore error paths).
Retry DELETE to finish cleanup before recreating. Default object-store mode still
has its existing check/create behavior; interrupted-deletion fencing there is
not changed. This admission rule is not full fencing of Parquet publication or
resident writers. Retention unions bucket dates with SQL dates, so SQL-only
manifest leftovers after physical deletion are discoverable on the next run.
Tenant cleanup excludes root streams, including streams being deleted, and
requires a single tenant path component. Absent, empty and `DEFAULT_TENANT`
tenant identifiers use the same empty SQL tenant column. Stream lifecycle keys
follow the existing root-path normalization.

Every SQL operation, including transaction start/commit, startup migration,
offline transfer and health, has a client deadline of statement timeout + 250 ms.
Canceled/timed-out connections are discarded instead of recycled. Readiness has
an overall deadline of that same duration, including pool acquisition and bucket
probe. TCP keepalive starts after one second with one-second probes and three
retries; TCP user timeout follows statement timeout. Connections target read-write
servers, and connections reporting read-only errors are discarded for failover.
Database failures use a dedicated unavailable error (503 through metastore HTTP
error mapping). URL startup `options` are preserved before timeout options are
appended; timeout settings take precedence. PgBouncer must accept startup
`options` (configure its ignore-startup-parameters policy as appropriate).
The database role needs schema/table/sequence creation and alteration privileges,
plus PL/pgSQL function and trigger creation for migration 002, and normal document
CRUD privileges afterward.

A configured PEM CA bundle **replaces** public webpki trust roots. Supply managed
database private CAs with `P_METASTORE_POSTGRES_CA`; the operating system trust
store is not loaded. An empty CA bundle is rejected at configuration time. CA plus `sslmode=disable` emits a warning and sends plaintext.

Normal startup refuses an existing database identity, including one with zero documents, when the bucket has no pairing marker.
Restore the matching marker from backup. For deliberate recovery only, after
verifying the bucket and database identity, set
`P_METASTORE_POSTGRES_ALLOW_UNPAIRED=true` to allow creation of the missing marker.
This override never permits mismatched identities or incomplete offline transfers.
The import tool's committed-import recovery continues to establish pairing itself
under its durable transfer marker, and migrates schema version 1 to 2. Exported
or incomplete databases still refuse server admission.

Conditional-create lost responses remain ambiguous, as on object storage: a retry
returns conflict. Comparing bytes cannot distinguish another writer that wrote
the same body, so no success is synthesized from body equality.

Reproduce the populated-table plans with
`scripts/postgres-metastore-review-explain.sql` in a disposable database after
applying migrations. Captured PostgreSQL 17 output (200,400 rows, four tenants)
is in [postgres-review-explain.txt](validation/postgres-review-explain.txt).

Default-mode follow-up: bucket tombstones also make lazy loading report an absent
stream, while `ObjectStorage::create_stream` unconditionally writes schema and
stream JSON. Recreation while a tombstone remains is therefore the same admission
gap in object-store mode. It is reported here and intentionally unchanged in this
PostgreSQL production fix. The two new SQL HTTP errors also preserve their status
when stream creation wraps them in a serialized metastore error detail.

### Review validation

The review regression module is separate from the protected existing contracts.
It checks two manifest publications through the returned locator on LocalFS and
an S3-style provider; exact percent-key spelling; overlapping tenant listings;
`DEFAULT_TENANT`; marker/create races including a blocked SQL writer; a 200-key
batch with a two-connection pool; injected failure after physical partition
removal and subsequent SQL cleanup; missing pairing-marker refusal; URL startup
options; read-only connection discard; CA-only trust; and HTTP error propagation.
A TCP proxy stops forwarding without resetting sockets. Four consecutive
readiness calls each return within two seconds with a 300 ms statement timeout,
and a healthy probe succeeds after forwarding resumes.

Full library runs with and without the PostgreSQL test URL each passed 1,389
tests with four ignored. SQL skips are printed in the no-database run. Debug
build and plain `cargo clippy --all-targets` passed; Clippy retains the same 21
library-test warnings and one existing integration-test warning, with no new
warnings. PostgreSQL was `postgres:17-alpine` on a spare port; no live database,
service or bucket was used. The populated collation migration preserved all
200,400 rows; its resulting key collation and query plans are recorded above.

The offline smoke now waits for staging to remain drained before stopping a
writer, and polls published event bounds before capturing the export comparison.
This avoids stopping with an unsynced custom-partition file or comparing a cached
pre-export bound to a freshly loaded rollback bound. It passed interrupted import
and export, SQL-mode query/metadata equality, new ingestion, verified export and
object-store rollback. Existing Rust test modules and expectations are unchanged.
The protected smoke's only expectation change is future schema version 3, restoring
version 2 afterward, because migration 002 makes version 2 supported.

The three-mode smoke passed object-store, verified TLS PostgreSQL and plaintext
PostgreSQL scenarios, including lifecycle, dependency outages, CA rejection and
future-schema/pinned-identity rejection. Raw results are in
[postgres-review-smoke.json](validation/postgres-review-smoke.json).
One complete run passed with the default SQL timeout. The final rebuilt-binary
confirmation used `P_METASTORE_POSTGRES_STATEMENT_TIMEOUT_MS=60000` because this
shared machine produced PostgreSQL filesystem syncs over 25 seconds; an earlier
confirmation correctly returned 503 at the default client deadline. The proxy
blackhole regression retained its 300 ms statement timeout. A first smoke attempt
also exceeded the existing auxiliary-process shutdown wait; a subsequent complete
run passed without changing that protected cleanup logic. All started containers
were removed. Large migrations or slow storage may require increasing the
statement timeout; the readiness/client deadline increases with that setting.


## Hardened offline procedure

**Older binaries ignore pairing and transfer markers and can write stale bucket
metadata. Disable their restart policies and prevent redeployment for the entire
PostgreSQL interval.** Digests detect bucket changes during rollback; they do not
fence writers. Never run these commands against a running deployment.

1. Save binary version, environment and `.parseable.env`, working directory,
   staging, a PostgreSQL `pg_dump`, and all bucket metadata: hidden namespaces,
   every manifest variant, and pairing/transfer markers. Preserve object versions.
2. Record stream list, schemas, RBAC, alerts, targets, dashboards, filters, known
   query results and row counts, plus first/latest timestamps.
3. Drain staging, stop the single server and all other writers, and disable
   restarts. Explicitly set `P_STAGING_DIR` to the server's actual directory.
   The tool loads `.parseable.env` with the server's loader. If buffers can never
   sync, retain a complete staging backup, restore normal mode and repair the
   stream/storage problem. Alternatively move the stranded buffers to a separate
   preserved recovery directory outside staging, accepting that those events
   require later replay; never delete them to satisfy the check.
4. Configure the exact bucket and destination PostgreSQL URL. Run import
   `--dry-run --acknowledge-server-stopped`. Database identity, pin, pairing and
   transfer ownership are checked read-only before inventory. Review counts,
   skipped keys, digests and recent-write warnings.
5. Run import with the same configuration and acknowledgement. Run verify and
   require zero differences and SQL document count equal to the dry-run count.
6. Start PostgreSQL mode. Compare all observations from step 2 before ingest.
   Preserve both backups until rollback closes.

Rollback uses the same backups, drain and stopped-writer steps. Run verify and
save differences, then export with the acknowledgement and **no force flag**.
Imported bucket objects still matching their import digest can be overwritten or
deleted safely. Unknown or changed bucket objects require the narrow
`--overwrite-bucket-changes-since-import` flag after reviewing the risk of losing
bucket-writer metadata. `--migration-force` is rejected with an explanation of its replacement.
After successful export, verify, remove the PostgreSQL URL, start bucket mode
and compare all saved results, including events ingested in PostgreSQL mode.

The command surface remains `--metadata-migration import|verify|export`.
`--abort` is accepted with import or export. Import abort is safe before its SQL
commit; export abort is safe before export state commits. Once irreversible
export writes can have begun, abort refuses and explains that export must finish.
`--allow-dangling-snapshot-references` reports an explicit override during import;
it preserves the existing dangling reference. Without it, missing references
fail validation. Migration modifiers require `--metadata-migration` and cannot
be silently accepted by a normal server start.

| Failure boundary | Recovery command (same settings and stopped-writer acknowledgement) |
| --- | --- |
| Before marker | Retry import/export; original mode remains available |
| Import marker, no SQL commit | Retry import, or import --abort then start bucket mode |
| Import SQL committed | Retry import to establish pairing and clear marker |
| Import paired, marker remains | Retry import |
| Export validation failed before marker | Correct the SQL metadata in PostgreSQL mode, then retry export |
| Export marker, state still ready | Export --abort restores PostgreSQL startup |
| Export state committed / any destination write | Retry export; abort refuses |
| Export pairing removed, marker remains | Retry export to finish verification and marker cleanup |
| Complete export | Start bucket mode; SQL startup refuses exported state |

Default startup performs two marker GETs. Not-found permits normal startup.
Other probe errors identify the marker and ask for retry after bucket access is
restored; they do not write a permanent refusal. A paired bucket requires export
or `P_ALLOW_PAIRED_BUCKET=<exact-pairing-id>`; incomplete transfers cannot be
bypassed.

Inventory lists root/tenant/stream/date directories, skips hour and minute
prefixes, and uses flat paginated listings within hidden metadata prefixes.
Bodies are spooled in the command's working directory and imported transactionally;
the inventory recheck and all remote bucket I/O run outside SQL transactions.
For a single-tenant deployment with S streams, D dates per stream and one
`.stream` metadata page per stream, a walk needs approximately
1 + 2S + SD plus global hidden-metadata pages, rather than
1 + 2S + SD(1 + 24 + 1440). For S=20, D=30, that is about 641 versus
879,041 LIST requests per walk, or 1,282 versus 1,758,082 for two walks,
excluding global metadata pagination. GET costs scale with metadata documents,
not Parquet count. Large hidden namespaces add one request per object-store page.

Four default-backend bugs also present on origin/main are corrected: target
serialization now writes tenantId and accepts legacy tenant on load; alert
listing excludes mttr.json; LocalFS stream listing uses the selected instance;
startup cleanup waits for the entire discovery/validation pass to succeed before
deleting any invalid tenant.


The merged CRUD contract and boundary guard kept their assertions. The smoke's
future-schema test now rejects 3 and restores 2 (migration 002 is supported).
The migration smoke no longer expects ordinary rollback to fail without force;
it interrupts and resumes an unforced export. The migration fixture still
rejects a bucket-writer edit, restores its import baseline, then proves that SQL
edits and SQL deletions export without force.

### Import-tool review disposition

| Finding | Disposition |
| --- | --- |
| B1 inventory cost | Fixed: metadata-only hidden-prefix pages and date-level listing; hour/minute subtrees excluded; source recheck outside SQL transaction. |
| B2 late export validation | Fixed: validate authoritative SQL rows and SQL snapshot references before marker/state/destination writes; abort available before irreversible boundaries. |
| M1 encoding | Fixed: decode one object-store path encoding layer; real MinIO inventory and SQL round trip cover café and auth0\|é. |
| M2 late preflight | Fixed: read-only database, identity, pin and marker checks precede inventory, including dry-run. |
| M3 old binaries | Mitigated as directed: prominent operational prohibition plus import digests; no mutation of metadata older binaries consume. |
| M4 broad force | Fixed: import digests distinguish SQL updates/deletions from bucket-writer changes; normal export requires no force; explicit narrow override handles the latter. |
| M5 staging/env | Fixed: server env-file loader, explicit staging argument/environment, .part refusal, documented repair/quarantine path. |
| m1 skipped/unknown keys | Fixed: skipped-key report/count; unknown hidden namespaces abort; dashboard locations/titles and LocalFS lock artifacts recognized. |
| m2 legacy tenant scope | Fixed: legacy root stream/schema keys use default tenant and are excluded from SQL tenant cleanup candidates. |
| m3 dangling/legacy snapshot | Fixed: explicit reported dangling-reference override; legacy v1–v3 stream references validated without rewriting source bytes. |
| m4 duplicated bootstrap | Fixed: offline tool and server call the same transactional bootstrap and forward migrations. |
| m5 missing abort | Fixed: safe precommit abort commands, with unsafe abort refusal and rerun instructions. |
| m6 startup probes | Documented: two marker GETs; missing permits startup, transient probe failure requests retry and writes no permanent refusal. |
| m7 broad pairing override | Fixed: P_ALLOW_PAIRED_BUCKET must equal the exact pairing id. |
| m8 duplicate validation | Fixed: import validates in pre-pass; second read spools source bytes and verifies SQL digests rather than validating again. |
| m9 writer fencing | Documented limitation: all writers/restarts must remain stopped; markers/digests are not writer fencing. |

The old --migration-force flag is explicitly rejected. Modifier flags require
--metadata-migration; normal help hides them, while invoking migration help shows
them. Keys and digest reports can contain tenant/user identifiers and must be
protected like metadata backups.

The review regression fixture now permits 2 seconds for SQL work and 10 seconds
for database creation, to avoid conflating filesystem setup latency with the
network deadline test. Its proxy blackhole still uses a 300 ms statement timeout,
four probes, and the original under-two-second assertions.

### Hardening validation

The combined implementation was validated locally with disposable PostgreSQL 17
and MinIO, with all task containers removed afterward. Full library runs with
and without the database URL each passed 1,398 tests (seven ignored); SQL tests
print explicit skips without prerequisites. The PostgreSQL contract and startup
cleanup fixtures were then run explicitly and passed, as did the paused-server
deadline test. Focused metastore runs passed 34 tests against LocalFS/PostgreSQL
and MinIO/PostgreSQL; follow-up migration checks cover legacy absolute locators,
both legacy tenant scopes, safe/unsafe aborts, and early pin refusal.

Both end-to-end scripts passed: the main smoke in object-store, PostgreSQL
plaintext and verified TLS modes; offline migration in plaintext and verified
TLS, including interrupted import/export, .part refusal, new SQL-mode ingestion
and unforced object-store rollback. The smoke generated its own
[raw evidence](validation/postgres-metastore-smoke.json).
[Validation commands and recovery results](validation/postgres-hardening-checks.json)
record the other checks. Plain cargo clippy --all-targets and the debug build
passed; Clippy retained 21 existing library-test warnings and one existing
integration-test warning, with no new warnings. The workflow YAML parses; its
hosted GitHub run has not been performed because this work is local and unpushed.

Counts in the inventory chart are a model of request growth, not a throughput
benchmark. No concurrent-writer fencing, automatic resolution of an interrupted
stream deletion, or production-scale throughput claim is made.

Review nits: migration modifiers are scoped in parsing/help and reports document
their identifier privacy risk. Deduplicating the object-safe storage guard and
SQL startup guard adapters is deferred: both enforce the same tested controls,
and consolidating their different error adapters adds no recovery capability.
The required real PostgreSQL/MinIO and injected-boundary coverage is implemented;
hosted CI remains deferred under the no-push constraint.
