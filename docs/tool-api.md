# Parseable tool REST API

Parseable owns the canonical tool catalog and execution semantics. External MCP
servers adapt these REST endpoints to MCP `tools/list` and `tools/call`.

Both endpoints require normal Parseable authentication. Tool execution also
applies the RBAC action required by the selected tool and any referenced
dataset or resource.

## List tools

```http
GET /api/prism/v1/llm/tools/list
```

Response:

```json
{
  "tools": [
    {
      "name": "get_dataset_schema",
      "title": "Get dataset schema",
      "description": "Get the full Arrow JSON schema by default, or request format=compact for tab-separated column names and types.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "dataset": { "type": "string", "minLength": 1 },
          "format": { "type": "string", "enum": ["json", "compact"], "default": "json" }
        },
        "required": ["dataset"],
        "additionalProperties": false
      }
    }
  ]
}
```

A listed `inputSchema` never has a root-level `oneOf`, `anyOf` or `allOf`,
because several LLM tool APIs reject tool input schemas with root combinators.
Where the catalog schema has one, the server still enforces it when the tool is
called, and the affected property descriptions state the constraint.

The response includes an `ETag` and
`Cache-Control: private, max-age=300, must-revalidate`. A request with a
matching `If-None-Match` receives `304 Not Modified`.

The catalog is edition-specific:

- OSS returns externally callable OSS read tools and explicitly enabled dashboard write tools.
- Enterprise returns OSS read tools plus Enterprise read tools.
- Parseable Cloud uses the Enterprise server catalog and exposes the tools
  enabled by that deployment.

## Call a tool

```http
POST /api/prism/v1/llm/tools/call
Content-Type: application/json
```

Request:

```json
{
  "name": "get_dataset_schema",
  "arguments": { "dataset": "application-logs" }
}
```

`arguments` must satisfy the tool's `inputSchema`. The external registry exposes read-only and expensive-read tools by default.
Dashboard mutation tools can be enabled with `P_DASHBOARD_AGENT_WRITES=true`;
normal dashboard RBAC, tenant and owner/admin policy, revisions and idempotency
still apply. This explicit standing operator policy applies only to dashboard
writes. Other mutation/external-side-effect tools remain unavailable until
Parseable supports their server-verifiable confirmation flows. See
[Agent-driven dashboards](dashboard-agent-api.md) for the full contract.

Successful and failed executions use the MCP `CallToolResult` shape:

```json
{
  "content": [
    { "type": "text", "text": "{\"fields\":[...]}" }
  ],
  "structuredContent": {
    "result": { "fields": [] }
  },
  "isError": false
}
```

Tool failures set `isError` to `true`, include a text error content item, and
put the message under `structuredContent.error.message`. A completed tool call
returns HTTP 200 even when the tool reports `isError: true`, matching MCP
`tools/call` semantics. REST status codes distinguish failures that prevent a
call from starting, such as malformed input, authentication, or an unknown
tool.

The REST API is not itself an MCP transport. An MCP adapter maps the registry
response to `tools/list`, forwards calls to this endpoint, and returns the
`CallToolResult` from Parseable through MCP `tools/call`.

## Schema output compatibility

`get_dataset_schema` preserves the full Arrow schema object in
`structuredContent.result` when `format` is omitted or `"json"`. Existing JSON
consumers do not need to change. Set `"format": "compact"` to receive a string
with a `name\ttype` header and one tab-separated row per field. Compact output
escapes tabs, newlines, carriage returns and backslashes and omits metadata and
top-level nullability; it is for inspection, not Arrow schema interchange.
The HTTP schema endpoint likewise defaults to JSON and accepts `?format=compact`.

## Error tools

`list_log_errors` and `list_trace_errors` each require `dataset`, `startTime`,
and `endTime`; `limit` defaults to 50 and is bounded to 1–500. They enforce query
permissions and require logs and traces telemetry, respectively.
The log tool applies exact, half-open time bounds (start inclusive, end exclusive)
to the dataset's configured time partition, or `p_timestamp` by default; `lastSeen`
uses the same timestamp column. Subminute ranges retain their full precision.

`list_log_errors` classifies records by explicit severity, following the native
Errors page's policy. It checks every available `level`, `log_level`, `severity`,
`severity_text` and `severity_description` column using case-insensitive, trimmed
severity names, plus OTel `severity_number` codes 17–24. Pino/Bunyan codes 50 and
60 are accepted only in `level`. Invalid numeric text and fractional codes do
not fail the query or count as valid severities. A dataset without a supported
severity column produces an actionable tool error; message substrings,
`p_log_category` and the presence of exception metadata do not independently
classify records as errors.

The log tool groups by service and error type, returns a sample message, count
and last-seen value, and coalesces supported aliases per row. Its `total` is the
number of returned groups, not an unbounded count of all matching groups. The
native Errors page additionally separates issues by message, so its grouping
and pagination are not identical to this summary tool.

## SQL tool limits

`query_sql`, `explain_query` and other tools that run SQL internally parse the
statement with DataFusion's SQL parser and accept exactly one `SELECT` or `WITH`
query. A trailing semicolon or trailing comments are allowed, but a semicolon
followed by a comment passes validation and then fails when the query runs.
The outermost projection must name at most 10 explicit columns, and `*` and
`table.*` are rejected there. The same limit applies to each branch of a
top-level set operation such as `UNION` and to a parenthesized outer query.
Projections inside CTE definitions, derived tables and subqueries are not
checked. Casts to `INT64`, `UINT64` or `FLOAT64` anywhere in the statement are
rejected with a hint to use `BIGINT` or `DOUBLE`. The statement is wrapped with
an outer `LIMIT 500`, except in `get_trace_activity`, whose generated SQL carries
its own limit (see below). `sample_events`
returns at most 10 columns, choosing common observability fields such as
`p_timestamp`, `service.name`, `severity_text`, `body` and `trace_id` before
other fields.

## Dataset and time resolution

`list_datasets`, `resolve_dataset` and `discover_datasets` omit internal
datasets.

`resolve_dataset` accepts an optional `telemetryType` (`logs`, `metrics` or
`traces`) and `limit` (1–20, default 5). Its `status` is `resolved`,
`ambiguous`, `not_found` or `error`.

- A `selectedDataset` or `contextDataset` resolves to the visible dataset with
  exactly that (case-sensitive) name. If none has that exact name, it resolves
  to the one visible dataset whose name matches case-insensitively; if several
  do, the result is `ambiguous` with those datasets as `candidates`. If no
  visible dataset matches, the result has `status: "error"`. If the selected
  dataset's telemetry type does not match `telemetryType`, the result is
  `not_found`.
- Otherwise, if exactly one dataset is visible, it resolves to that dataset, or
  returns `not_found` if its telemetry type does not match.
- Otherwise it scores the visible datasets that match `telemetryType` by name
  against `query`, ignoring case: 1000 if the name equals the query, 750 if the
  query contains the name, or 500 if the name contains the query, plus 25 for
  each query term longer than two characters that the name contains, plus 15
  when `telemetryType` is given. It resolves only a unique top score of at least
  500. In every other case it returns `ambiguous` with up to `limit` scored
  `candidates`, or `not_found` if no visible dataset matches `telemetryType`.

It never falls back to an arbitrary dataset.

`discover_datasets` counts events in the requested range for each visible
dataset of the requested telemetry type that the caller can query. It returns
active datasets ordered by event count as `{ name, eventsInRange }`, together
with `selectedDatasets`, `activeDatasetCount`, `truncated` and up to 20
`unavailableDatasets`. If no dataset is active and at least one could not be
counted, the result has `status: "error"` and no datasets.

`resolve_time_range` accepts any IANA `timezone` (default `UTC`), and uses it
for `today` and `yesterday` day boundaries. It also accepts `last <duration>`,
`past <duration>`, `now-<duration>`, `<start> to <end>` and RFC3339 start
times. An unknown timezone is an error.

`sample_events` accepts an explicit `startTime` and `endTime`, which must be
provided together. They take precedence over `minutes`.

## Log context

`get_log_context` uses the same implementation as `POST /api/v1/query/context`.
Arguments must include exactly one of `log`, `body` or `message`, holding the
anchor row's exact value. The catalog schema enforces this with a root `oneOf`,
so calls with none or more than one are rejected with `400`. The listed
`inputSchema` omits that `oneOf` (see [List tools](#list-tools)) and states the
rule in the property descriptions.

Context bounds are either `contextWindow` or both `contextStartTime` and
`contextEndTime`. Giving only one explicit bound, or a window together with an
explicit bound, is an error. If no bounds are given, the tool uses
`contextWindow: "5 minutes"`. A window extends that duration on each side of
`pTimestamp`, and both ends are rounded down to the minute; if they round to the
same minute, the end is one minute after the start. Explicit bounds are used at
millisecond precision without rounding, and `pTimestamp` must be at or after
the start and before the end. `pageSize` is 1–500, default 100.

Returned records keep at most 10 fields per row, preferring `p_timestamp`,
service, severity, message and trace identifiers. The response also includes
the anchor index, scope and the executed queries.

## Trace activity

`get_trace_activity` returns a bucketed span and trace activity series for one
traces dataset:

```json
{
  "name": "get_trace_activity",
  "arguments": {
    "dataset": "otel-traces",
    "startTime": "2026-10-22T00:00:00Z",
    "endTime": "2026-10-22T01:00:00Z",
    "groupBy": ["service.name"],
    "filters": { "span_status_code": 2 },
    "bucketCount": 60
  }
}
```

`dataset`, `startTime` and `endTime` are required. `groupBy` takes up to 5
exact field names. `filters` maps exact field names to JSON scalars: strings,
numbers and booleans test equality, and `null` tests `IS NULL`. `bucketCount`
is 1–100, default 60. It approximates the number of `DATE_BIN` buckets over the
dataset's time partition, or `p_timestamp` if none is configured. The dataset
must have traces telemetry and contain `span_span_id` and `span_trace_id`.
Unknown fields are rejected. `span_count` is `COUNT(DISTINCT span_span_id)` and
`trace_count` is `COUNT(DISTINCT span_trace_id)`, so duplicate span rows are
not double counted. Rows are ordered by bucket, oldest first. The result
contains `query`, `bucketInterval`, `semantics`, up to 500 `rows` and
`truncated`.

`query` is the exact SQL the tool runs; it ends in `LIMIT 501` so the tool can
detect overflow. When more than 500 rows match, the newest buckets are dropped
and `truncated` is `true`; reduce `bucketCount`, `groupBy` or the time range to
get the full series. `query` has no time predicate: the time range comes from
the request's `startTime` and `endTime`, which the query API rounds down to the
minute. To reproduce the result, for example in a dashboard tile, run `query`
through the query API with the same `startTime` and `endTime`.

## Argument schema validation

`inputSchema` is enforced server-side for `type` (a single type or a list of types), `required`,
`additionalProperties`, `enum`, `const`, `minLength`/`maxLength`,
`minimum`/`maximum`, `minItems`/`maxItems`, `items`, `anyOf` and `oneOf`.
`oneOf` passes only when exactly one variant matches. Combinators are checked
in addition to sibling keywords; they do not replace them. Validation uses the
catalog schema, including any root combinators omitted from the listed
`inputSchema`.
