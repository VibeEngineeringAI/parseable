# JSON flattening limits

Generic flattening turns every nested array of an event into rows: an event becomes one row
for each combination of the values of its arrays. Sibling arrays multiply, so
`{"a": [0..999], "b": [0..999], "c": [0..999]}`, about 11 KiB of JSON, would expand into
10^9 rows. Three limits cap that expansion. Parseable checks them before it builds any row,
and rejects the whole request with `400 Bad Request` when one is exceeded. Nothing from a
rejected request is ingested.

| Environment variable              | Flag                              | Default              | Limit                                                     |
| --------------------------------- | --------------------------------- | -------------------- | --------------------------------------------------------- |
| `P_MAX_FLATTEN_ROWS_PER_EVENT`    | `--max-flatten-rows-per-event`    | `1000`               | Rows a single event may expand into                       |
| `P_MAX_FLATTEN_ROWS_PER_REQUEST`  | `--max-flatten-rows-per-request`  | `10000`              | Rows all events of one request may expand into together   |
| `P_MAX_FLATTEN_BYTES_PER_REQUEST` | `--max-flatten-bytes-per-request` | `67108864` (64 MiB)  | Bytes all those rows may add up to, measured as compact JSON |

Each value must be a positive integer. A limit cannot be set to zero or switched off.

The byte limit counts the size of the expanded rows as compact JSON, including keys,
quotes, escapes and delimiters. It also counts what is copied into every row afterwards:
Kinesis request metadata and OTEL body key prefixes (see below). It is not a measure of the
memory a request uses.

After generic flattening, every row is flattened structurally: nested objects become fields
named after the keys on their path, joined with `_`. A parent's name is repeated in every
field below it, so `{"<128 character name>": {"f0": 0, ..., "f31": 31}, "r": [0, 1, 2, 3]}`
expands into 4 rows of about 400 bytes, but each of them structurally flattened takes about
4.4 KiB. Every event is therefore charged the larger of the two: the compact JSON of its
generic rows, or of those rows structurally flattened. Both are computed in one pass over
the event, before any row or field name is built. The structurally flattened size counts
every scalar as a field of its own, even when its joined name collides with another field
(for example `{"a_b": 1, "a": {"b": 2}}`, where one `a_b` overwrites the other), so with
such collisions it is an overestimate. Empty objects add no field.

## What counts as an event

The limits apply only where generic flattening runs:

- **JSON and custom sources** (`/api/v1/ingest`, `/api/v1/logstream/{name}`) on datasets using
  schema version V1. Every object in the request body is one event, after any nested
  top-level arrays are spliced in. Bodies nested deeper than `P_MAX_FLATTEN_LEVEL` skip
  generic flattening, so these limits do not apply to them.
- **Kinesis**: every decoded `data` record is one event, even when it holds a JSON array.
  Each of its rows also gets the request's `requestId` and `timestamp`, so their compact
  JSON size, with keys and delimiters, is counted once per row, on top of the larger of the
  generic and structurally flattened sizes. It is counted in full even for rows that
  already have these fields.
- **OTEL logs**: a log record whose body (or a body field) is a string holding a JSON object
  has that object flattened. All flattened bodies of one log record together are one event.
  This counts every intermediate row, even though the rows end up merged into the single
  log record. Each top-level field of a flattened body is renamed to `{body key}_{field}`
  before the merge, so the body key, with its escapes and the `_`, is counted again for
  every such field in every row. Structurally flattening the record afterwards repeats the
  body key in the name of every field nested below those too, `{body key}_{field}_{name}`.
  A body is charged the larger of its generic rows with the renamed top-level fields, or
  of its structurally flattened rows with the body key in every field name. This counts
  the rows of a body as if they were all kept, though only the last value of each field
  ends up in the record.
- **Schema detection** (`/api/v1/logstream/schema/detect`) counts the request body the same
  way as JSON ingestion, structurally flattened rows included.

Every request has a budget of its own. All events of a request share that budget, across
custom partition elements, Kinesis records, and OTEL resources and scopes. OTEL metrics and
traces, Kafka, and V0 datasets do not use generic flattening, so these limits do not apply
to them.

Internal dataset statistics (`pstats`) use the configured byte limit. Their row limits come
from the size of the stats payload, which is the field count times `P_MAX_FIELD_STATISTICS`.

## When a request is rejected

The error message names the limit that was exceeded and its value. To get under the limit,
reduce the number or length of the nested arrays in each event, or split the batch into
smaller requests. You can also raise the limit.

`tools/flatten-bench/http_smoke.py` checks these responses against a built server binary.
