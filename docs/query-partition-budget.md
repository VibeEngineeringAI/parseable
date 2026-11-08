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
