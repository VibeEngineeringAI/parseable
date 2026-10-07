# Community PromQL API

Parseable exposes a read-only PromQL API for OTLP metrics without an Enterprise license. It queries one existing OTLP metrics dataset per request. The SQL API remains available at `/api/v1/query`.

## Endpoints

The Prometheus-compatible query endpoints are:

```text
GET|POST /prometheus/api/v1/query
GET|POST /prometheus/api/v1/query_range
```

Both endpoints require an OTLP metrics dataset selected by `X-P-Stream` or the `stream` parameter, plus normal authentication and the `Query` permission for that dataset. If both dataset selectors are supplied they must match. Requests are evaluated only against the selected dataset. GET parameters use the URL query string. POST requests must use `Content-Type: application/x-www-form-urlencoded` and place the same parameters in the body.

Instant queries require `query`; `time` is optional and defaults to the current time. Range queries require `query`, `start`, `end`, and `step`. Timestamps accept Unix seconds or RFC3339. `start` and `end` are inclusive. `step` accepts a Prometheus duration such as `15s` or a number of seconds. `timeout` is optional and capped at 30 seconds. Times and steps preserve millisecond precision.

Responses follow the Prometheus JSON envelope. Instant selectors return a vector with `metric` labels and a `[unix_seconds, "value"]` sample. Range queries return a matrix with `metric` labels and a `values` array. Errors include `status: "error"`, `errorType`, and `error`; invalid parameters or PromQL syntax are HTTP 400, unsupported PromQL and evaluation errors are HTTP 422, and timeouts or unavailable query capacity are HTTP 503.

For example, with a metrics dataset named `service_metrics`:

```sh
curl -u admin:admin \
  -H 'X-P-Stream: service_metrics' \
  --get --data-urlencode 'query=http_requests_total{job="checkout"}' \
  http://localhost:8000/prometheus/api/v1/query
```

A client that uses these query endpoints can use `/prometheus` as its API base path and send `X-P-Stream` with each request or place `stream` in the request parameters. Credentials need a role with `Query` access to the selected dataset. The endpoints work through local or externally routed server URLs as long as the route prefix and custom header reach Parseable. The metric-name and label-discovery endpoints are `/prometheus/api/v1/labels` and `/prometheus/api/v1/label/{name}/values`; they accept the selected `stream`, optional `start`/`end`, repeated `match[]` selectors and `limit`. Discovery is limited to gauges and cumulative sums. Remote read/write and build-info endpoints are not implemented, and full Grafana integration has not been verified.

## PromQL dashboard tiles

Saved dashboard tiles keep their query and selected dataset in the dashboard JSON. A PromQL range tile can store `tileType: "promql"`, `dbName` (the metrics dataset), `chartQuery: ["expression"]`, and `promqlQueryType: ["range"]`. On each refresh, the client evaluates the expression with the visible dashboard time range and a chosen step, then renders `data.result` when `data.resultType` is `matrix`. The tile can call `query_range` directly; metric and label discovery only powers query-builder suggestions. PromQL dashboard capability is exposed separately from license plan metadata, so community builds can enable those tiles without presenting the deployment as Enterprise.

## Supported PromQL

The initial evaluator supports metric selectors and `=`, `!=`, `=~`, and `!~` label matchers. Missing labels compare as empty strings, and regex matchers are anchored as in Prometheus. Regex support is a RE2-compatible subset; unsupported character-class set operations and non-RE2 flags return errors. It supports numeric literals, `time()`, `scalar()`, `vector()`, unary minus, scalar/vector arithmetic (`+`, `-`, `*`, `/`, `%`, `^`, `atan2`), comparisons (including `bool`), and one-to-one vector matching with `on` or `ignoring`.

Supported aggregations are `sum`, `avg`, `count`, `min`, `max`, `group`, `stdvar`, and `stddev`, with `by` and `without`. Supported functions are `rate`, `increase`, `delta`, `irate`, `idelta`, `sum_over_time`, `avg_over_time`, `count_over_time`, `min_over_time`, `max_over_time`, `last_over_time`, `present_over_time`, `changes`, `resets`, `abs`, `ceil`, `floor`, `sqrt`, `exp`, `ln`, `log2`, `log10`, and `timestamp`. Range selectors are supported in instant expressions and these range functions. Query range evaluates scalar or vector expressions at each inclusive step.

Only OTLP gauges and cumulative sums are queryable. Histograms, exponential histograms, summaries, delta sums, and no-recorded-value/staleness markers are rejected with an evaluation error.

Metric names and attribute names retain their stored OTLP spelling; they are not automatically translated to Prometheus naming conventions or suffixed with `_total`. For a metric with dots in its name, use a selector such as `{__name__="system.cpu.time"}`. Samples are evaluated at millisecond precision; identical duplicates are deduplicated and conflicting values at the same millisecond are rejected.

The evaluator rejects unsupported optional API parameters instead of ignoring them. PromQL features outside the subset above include `offset`, `@`, subqueries, string expressions, OR label matchers, set operators, `group_left`/`group_right`, vector-matching fill modifiers, and functions or aggregations not listed above. This is a bounded implementation: query text is limited to 4 KiB, request parameters to 16 KiB, ranges and selector history to 31 days, and each range to 11,000 steps. A query can read at most 250,000 input rows (64 MiB) and return 10,000 series and 250,000 output samples. Up to 32 PromQL HTTP requests may be admitted at once, with four query evaluations running at a time; waiting requests count against the 30-second deadline, and a full request queue returns HTTP 503. The timeout defaults to 30 seconds and cannot be raised above 30 seconds. A default five-minute lookback is used for instant selectors.

Streams partitioned by ingestion time may require a scan across their full lifetime to include delayed or backfilled samples. For that reason, PromQL currently supports datasets without time partitioning or partitioned by `time_unix_nano`; narrow queries to metric names and time ranges when possible.

Evaluation also has a 20-million-unit work budget that charges label bytes and matcher work as well as sample processing. Exceeding a limit returns an error rather than partial query results. Storage limits apply before label filtering, so a highly selective label matcher can still require a shorter time range in a large dataset.

Native community PromQL threshold alerts are available in All/Query modes. They evaluate an instant vector against a separate threshold, track each label set independently, persist hold timers and firing state, and deliver transition notifications through existing targets. See [PromQL alerts](promql-alerts.md) for configuration, missing-data behavior and verification. No additional service is required. MCP integrations and full Prometheus rule-file compatibility remain outside the current scope; alert expressions use the same supported subset listed above.

## End-to-end smoke check

With a local Parseable server running, the standard-library smoke script sends OTLP metrics to `/v1/metrics`, waits for them to become queryable, checks instant and range responses and label filtering, then checks malformed-query and unauthenticated-request errors:

```sh
P_ADDR=127.0.0.1:8000 P_USERNAME=admin P_PASSWORD=admin \
  python3 scripts/test-promql.py
```

The script creates a uniquely named metrics dataset and leaves it in place. It backfills deterministic, millisecond-aligned samples, sends a cumulative counter reset, and checks concrete `rate`, `increase`, and `resets` values along with malformed-query, evaluation, invalid-step, and unauthenticated error responses. Override `PARSEABLE_URL`, `P_USERNAME`, or `P_PASSWORD` for another instance or account.

The dashboard smoke script exercises the dashboard client request shape and cleans up its uniquely named allowed and denied metrics datasets, saved dashboard, and temporary restricted test account/role when it exits. It checks instant and range queries using the `stream` parameter, form-encoded range POST, conflicting stream selection, missing authentication, label discovery, dashboard tile create/edit/read/delete, metadata/query authorization for an allowed and denied dataset, and eight concurrent short-range panel queries using a quoted `__name__` selector for a dotted OTLP metric. The account needs `Ingest`, `Query`, dashboard create/delete, `DeleteStream`, and permission to create/delete users and roles:

```sh
P_ADDR=127.0.0.1:8000 P_USERNAME=admin P_PASSWORD=admin \
  python3 scripts/test-promql-dashboard.py
```

## Evaluator checks

Run the focused Rust tests with the project's Rust/CMake toolchain:

```sh
cargo test --locked --lib promql
```

The matching reference cases run against official Prometheus rather than this evaluator:

```sh
docker run --rm --entrypoint /bin/promtool \
  -v "$PWD/src/promql:/fixtures:ro" prom/prometheus:v3.15.0 \
  test rules /fixtures/promtool.yml
```

These cases cover reset correction/extrapolation, selection boundaries, label matching, nested timestamps, and numeric aggregation edge cases. They verify the listed examples, not complete PromQL conformance. Prometheus is only used for this optional reference test; it is not a runtime dependency.

Protocol references: [Prometheus HTTP API](https://prometheus.io/docs/prometheus/latest/querying/api/), [PromQL basics](https://prometheus.io/docs/prometheus/latest/querying/basics/), and [OTLP JSON encoding](https://opentelemetry.io/docs/specs/otlp/#json-protobuf-encoding). OTLP JSON enum values must be numeric, so cumulative sums use `aggregationTemporality: 2`.
