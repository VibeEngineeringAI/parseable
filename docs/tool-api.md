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

The response includes an `ETag` and
`Cache-Control: private, max-age=300, must-revalidate`. A request with a
matching `If-None-Match` receives `304 Not Modified`.

The catalog is edition-specific:

- OSS returns externally callable OSS read tools.
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

`arguments` must satisfy the tool's `inputSchema`. The external registry
currently exposes only read-only and expensive-read tools. Mutation and
external-side-effect tools remain unavailable until Parseable supports a
server-verifiable confirmation flow bound to the session, tool, and arguments.

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
