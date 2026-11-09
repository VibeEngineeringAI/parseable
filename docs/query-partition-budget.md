# Opt-in query partition budget

`P_DATAFUSION_QUERY_PARTITION_BUDGET` (CLI `--query-partition-budget`)
optionally shares a planning-time parallelism target across active queries.
It is **unset by default**. The existing `4 * num_cpus` default and
`P_DATAFUSION_TARGET_PARTITIONS` / `--target-partitions` continue to select
fixed parallelism when the budget is unset.

When explicitly enabled, a newly executing query takes this snapshot:

```
target = min(target_partitions,
             max(min_query_partitions, floor(query_partition_budget / active_queries), 1))
```

`active_queries` includes the new query, across all tenants and callers of the
shared `query::execute` implementation. `P_DATAFUSION_MIN_QUERY_PARTITIONS`
(`--min-query-partitions`, default 1) supplies the floor. Both new settings must
be positive. An explicit target-partitions override always remains the ceiling;
the opt-in policy can lower it, and cannot raise it even when the floor is higher.
Unset the budget to restore fixed parallelism without changing that override.
`P_EXECUTION_BATCH_SIZE` is an existing independent deployment knob; it is not
changed by this policy.

This is an advisory budget, **not a hard cap or admission control**. Existing
queries keep their physical plans. Queries can therefore have different targets,
and their total parallelism can exceed the budget. There is no queuing,
rejection, fairness guarantee, tenant quota, resizing or new overload response.
A query is counted from execution planning through collection, or through its
stream and outstanding partition workers. RAII releases the count on errors,
timeouts, caller abort, completion and early stream drop. SQL parsing and the
memory-pressure gate before execution are outside this count. The existing
streaming timeout still covers planning/stream construction, not the entire
response lifetime; this change does not extend that contract.

The per-query state clones the current session state and changes only its
partition setting. It shares the existing RuntimeEnv, memory pool, object stores,
disk manager, metadata cache and tenant catalogs; UDFs, session extensions and
physical optimizer rules are retained. The global session config is not mutated.
Planning uses the same setting for local, hot-tier, remote and mixed sources.
The initial rollout deliberately does not guess storage locality: hot-tier files
can be rerouted or mixed with remote and staging data after planning begins.
Choose the floor for the deployment's remote latency; a small floor can hurt
single remote queries and mixed workloads. The earlier standalone experiment's
local P8 and remote P32 observations are hypotheses for qualification, not defaults.
Example experimental settings on the measured eight-CPU machine were budget 32,
floor 8; neither value is recommended universally.

The policy touches no HTTP, OTLP, Flight, Arrow IPC or gRPC request/response type,
auth logic, status mapping or storage format. EXPLAIN physical plan partition
counts and execution metrics can differ when the policy is enabled. Query result
order without ORDER BY and streaming batch boundaries remain unspecified. The
plain HTTP count shortcut is unchanged and bypasses this policy; it must not be used as an exact
partial-boundary-count oracle. Enterprise distributed execution and plugins that
construct their own execution contexts need separate qualification. This checkout
exposes an Arrow Flight service on `P_FLIGHT_PORT`; `P_QUERY_GRPC_PORT` is metadata
and configuration here, with no separately registered query service found.

## Execution entry-point audit

Audit of this checkout (base `c48c2f7a`): the separate session states below
are not separate scan executors. No additional production DataFusion scan entry
point was found outside `Query::execute`. Counting planning twice would lower
parallelism unnecessarily during dashboard and alert fan-out.

| Entry point | Through `query::execute`? | Work and budget participation | Invocation pattern |
| --- | --- | --- | --- |
| `Query::execute` | Yes | Physical planning and `collect_partitioned` or `execute_stream_partitioned`; one lease through collection or stream/workers | Every SQL execution, including concurrent dashboard panels |
| HTTP `get_records_and_fields`, authorized variant, `query_internal` | Yes, except metadata count shortcut | Their own session states parse SQL and set tenant schema; scan execution acquires the lease later | Each query request; structured APIs can fan out into several SQL queries |
| Dashboard runtime, PromQL, traces, query-context APIs and tool SQL | Yes via HTTP query helpers | Generated SQL scans use the same executor; each generated SQL execution receives its own lease | Dashboard refreshes and interactive API/tool requests; a request can fan out |
| HTTP `counts` with conditions (`get_df_sql`) | Yes via `get_records_and_fields` | Histogram SQL scans and aggregates under the budget | Each filtered histogram refresh |
| `CountsRequest::get_bin_density`, HTTP unfiltered counts and plain count shortcut | No | Reads manifest metadata and sums row counts; no DataFusion scan, partitions or lease | Each unfiltered histogram/count refresh; may overlap query panels |
| `Query::get_dataframe` | No | Returns a lazy DataFrame without physical execution; no lease | No callers found in this checkout |
| `alerts_utils::execute_local_query` | Yes | Local alert scans collect under the budget; initial session state only parses SQL | Each configured alert evaluation (`evalFrequency`) |
| `alerts_utils::execute_remote_query` | On receiving server | Local logical planning and HTTP dispatch; receiving query server budgets its execution | Each Prism alert evaluation |
| Alert `get_number_of_agg_exprs`, `get_aggregate_projection` | No | Logical-plan validation/introspection only; no lease | Alert configuration/validation paths |
| Flight `do_get` | Yes | Initial context parses SQL; local collection is budgeted before Flight encoding; ingester RPCs execute on their own servers | Each Flight ticket, possibly with ingester fan-out |
| Flight schema endpoints | No | Schema lookup/IPC encoding only | Client schema discovery |
| `stream_schema_provider` / `listing_table_builder` | Inside executor | Build storage scan plans using the executor's session; not independent scan entry points | During physical planning of queries |
| DataFusion fixtures in test modules | No | Isolated test contexts and scans; no production load | Tests only |

Keep the current boundary rather than adding leases to planning or metadata
operations. Manifest reads and SQL planning can still compete for CPU, memory
and storage I/O; this partition budget does not account for those costs. It is
not a dashboard request concurrency limit. A future caller that collects or
streams `get_dataframe` must use `query_context` and retain its `QueryLease`
through collection, or transfer it into `LeasedQueryStream` (and any detached
workers). Prefer the existing executor. Plugins and enterprise code outside
this checkout can introduce independent executors and remain a known limit.

## Qualification and rollout

This is an experimental tuning surface. The setting remains unset by default.
The focused tests in `src/query/partition_budget/tests.rs` cover bounds, lease
cleanup, retained shared state and independently checked concurrent tenant
queries. Standalone Boat testing passed 118 query tests and 468 application
queries, with HTTP result, error and persisted-restart checks. The separate
combined campaign also exercised successful Flight delivery after applying its
independent metrics fix.

Local workloads sometimes improved, while controlled remote mixed workloads
regressed at concurrency four and eight. Three-block finite-batch measurements
are not sustained capacity or real-cloud qualification. Representative workloads
must establish a repeatable benefit before rollout. CPU-saturating preemption,
enterprise tenant HTTP routing, distributed exchange, hot-tier runtime routing,
spilling and memory-admission capacity remain unqualified.

This change is independent of severity clustering and the Flight metrics fix.
It includes no benchmark output or storage-layout changes.

## Prometheus metrics

The custom registry exposes two process-wide metrics with no labels, matching
this budget's scope across all tenants and streams:

- `parseable_query_partition_budget_active_queries` (gauge): queries currently
  holding a budget lease. Shared lease owners count once; the final owner releases
  the gauge on completion, error, timeout, abort or early drop.
- `parseable_query_partition_budget_target_partitions` (histogram): one observation
  of the chosen target for each budgeted query. Finite buckets are powers of two
  from 1 through 1024; the `+Inf` bucket includes larger explicit targets.

Both metrics are registered only when `P_DATAFUSION_QUERY_PARTITION_BUDGET` is
set, so the default scrape output is unchanged. The unset path performs no metric
updates.
The histogram describes planning decisions, not actual worker utilization; old
queries keep their targets when concurrency changes. The gauge can include
outstanding streaming workers and buffered results until their last lease drops.

Use the gauge to track active budgeted queries. For the mean chosen target over
five minutes, use
`rate(parseable_query_partition_budget_target_partitions_sum[5m]) / rate(parseable_query_partition_budget_target_partitions_count[5m])`.
Use `histogram_quantile(0.5, rate(parseable_query_partition_budget_target_partitions_bucket[5m]))`
for an approximate median. Rising activity with targets moving toward the floor
shows the budget reducing per-query parallelism. A zero observation rate means
no budgeted queries entered during that interval; a disabled budget and an idle
enabled budget both expose zero activity, so check configuration to distinguish them.
