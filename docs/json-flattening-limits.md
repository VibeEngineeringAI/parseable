# JSON flattening limits

Generic flattening turns every nested array of an event into rows: an event becomes one row
for each combination of the values of its arrays. Sibling arrays multiply, so
`{"a": [0..999], "b": [0..999], "c": [0..999]}`, about 11 KiB of JSON, would expand into
10^9 rows. Three limits cap that expansion.

Parseable checks each event against the limits before it builds the rows of that event: it
counts the rows and bytes the event expands into without building them. When an event would
go over a limit, the whole request is rejected with `400 Bad Request`. None of its events
are stored, and none of its fields are added to the dataset schema. Events that came before
it in the same request may already have been expanded in memory by then, within the
limits, and are dropped with the rest: in a dataset with a custom or time partition, and
for Kinesis and OTEL, the events of a request are expanded one after the other. An
endpoint that creates the dataset on first use, such as `/api/v1/ingest`, does that before
it flattens the request, so a rejected request can still leave a new, empty dataset.

| Environment variable              | Flag                              | Default              | Limit                                                     |
| --------------------------------- | --------------------------------- | -------------------- | --------------------------------------------------------- |
| `P_MAX_FLATTEN_ROWS_PER_EVENT`    | `--max-flatten-rows-per-event`    | `1000`               | Rows a single event may expand into                       |
| `P_MAX_FLATTEN_ROWS_PER_REQUEST`  | `--max-flatten-rows-per-request`  | `10000`              | Rows all events of one request may expand into together   |
| `P_MAX_FLATTEN_BYTES_PER_REQUEST` | `--max-flatten-bytes-per-request` | `67108864` (64 MiB)  | Bytes all those rows may add up to, measured as compact JSON |

Each value must be a positive integer. A limit cannot be set to zero or switched off.

These limits are new, and they reject some requests that earlier versions accepted,
including batches of small events without any arrays. Read
[Upgrading](#upgrading-requests-that-are-now-rejected) before you upgrade.

The byte limit counts the size of the expanded rows as compact JSON, including keys,
quotes, escapes and delimiters. It also counts what is copied into every row afterwards:
Kinesis request metadata and OTEL body key prefixes (see below). It is not a measure of the
memory a request uses. It is independent of `P_MAX_EVENT_PAYLOAD_SIZE` (10 MiB by default,
at most 100 MiB), which limits the size of the request body as it is received: a request
within one of them can be over the other.

After generic flattening, every row is flattened structurally: nested objects become fields
named after the keys on their path, joined with `_`. A parent's name is repeated in every
field below it, so `{"<128 character name>": {"f0": 0, ..., "f31": 31}, "r": [0, 1, 2, 3]}`
expands into 4 rows of about 400 bytes, but each of them structurally flattened takes about
4.4 KiB. Every event is therefore charged the larger of the two: the compact JSON of its
generic rows, or of those rows structurally flattened. Both are computed in one pass over
the event, before any row or field name of it is built. The structurally flattened size
counts every scalar as a field of its own, even when its joined name collides with another
field (for example `{"a_b": 1, "a": {"b": 2}}`, where one `a_b` overwrites the other), so
with such collisions it is an overestimate. Empty objects add no field.

## What counts as an event

The limits apply only where generic flattening runs. There, every event takes at least one
row, including an event without arrays, which generic flattening leaves as it is:

- **JSON and custom sources** (`/api/v1/ingest`, `/api/v1/logstream/{name}`) on datasets using
  schema version V1. Every object in the request body is one event, after any nested
  top-level arrays are spliced in, so a batch (a top-level array) of 10,001 objects takes at
  least 10,001 rows. Bodies nested deeper than `P_MAX_FLATTEN_LEVEL` skip generic
  flattening, so these limits do not apply to them.
- **Kinesis**: every decoded `data` record is one event, even when it holds a JSON array.
  Each of its rows also gets the request's `requestId` and `timestamp`, so their compact
  JSON size, with keys and delimiters, is counted once per row, on top of the larger of the
  generic and structurally flattened sizes. It is counted in full even for rows that
  already have these fields. A record nested deeper than `P_MAX_FLATTEN_LEVEL` is ingested
  as it is, and not counted.
- **OTEL logs**: a log record whose body (or a body field) is a string holding a JSON object
  has that object flattened. All flattened bodies of one log record together are one event,
  of at least one row per flattened body. A log record without such a body takes no rows.
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
to them. Internal dataset statistics are bounded differently, see
[below](#internal-dataset-statistics-pstats).

## Upgrading: requests that are now rejected

Earlier versions flattened every event without a limit. With the defaults, these requests
are now rejected:

- **More than 10,000 events in one request.** Every event counts toward
  `P_MAX_FLATTEN_ROWS_PER_REQUEST`, including an event without arrays. A JSON batch of
  10,001 `{"a":1}` events is about 80 KB, far below the 10 MiB default of
  `P_MAX_EVENT_PAYLOAD_SIZE`, and it is rejected. So is a Kinesis request of more than
  10,000 records, an OTEL logs request of more than 10,000 log records with JSON object
  bodies, and schema detection of more than 10,000 events. Shippers that batch by size or
  by time, rather than by a number of events, can send such requests.
- **More than 1,000 values in an array of one event.** An event such as `{"items": [...]}`
  with 1,001 items expands into 1,001 rows, over `P_MAX_FLATTEN_ROWS_PER_EVENT`. That
  includes an event that wraps its records in an array, like `{"records": [...]}`, and a
  Kinesis record that decodes to an array of more than 1,000 objects. The elements of a
  top-level array in a request body are events of their own, so this limit does not apply
  to a top-level array (the limit per request does).
- **Rows over 64 MiB in one request.** For a JSON batch of events without arrays or nested
  objects, the rows take about the size of the batch without whitespace. With the 10 MiB
  default of `P_MAX_EVENT_PAYLOAD_SIZE`, such batches stay well below
  `P_MAX_FLATTEN_BYTES_PER_REQUEST`; they can reach it once `P_MAX_EVENT_PAYLOAD_SIZE` is
  raised close to or above 64 MiB. Nested arrays, and parent names repeated in the
  structurally flattened field names, make the rows larger than the request.

Nothing is truncated: a request over a limit is rejected whole, with a `400` that names the
limit, and no part of it is stored. Many shippers treat a `400` as permanent and drop the
batch instead of retrying it, so compare these limits with your largest requests before you
upgrade, and look for these errors afterwards.

To migrate, do one of these:

- Configure each shipper to send at most 10,000 events per request (Kinesis records, or
  OTEL log records with JSON object bodies), and to send each record as an event of its own
  (an element of a top-level array, or a Kinesis record of its own) instead of wrapping
  many of them in the array of one event.
- Raise the limits to fit your largest requests. `P_MAX_FLATTEN_ROWS_PER_REQUEST` must be at
  least the number of events in a request, plus the rows their arrays add.
  `P_MAX_FLATTEN_ROWS_PER_EVENT` must be at least the length of the longest array of one
  event (the product of the lengths, for sibling arrays). The request size limit and the
  byte limit are independent. Raising `P_MAX_EVENT_PAYLOAD_SIZE`, which can go up to
  100 MiB, lets larger requests in, but the rows they expand into are still held to
  `P_MAX_FLATTEN_BYTES_PER_REQUEST` (64 MiB by default) and to the row limits, so raise
  those too for larger flat batches. Higher limits let a request use more memory.

## Internal dataset statistics (`pstats`)

Parseable computes statistics for every parquet file it uploads (unless
`P_COLLECT_DATASET_STATS` is off) and ingests them into the internal `pstats` dataset, one
row for every distinct value of every field (up to `P_MAX_FIELD_STATISTICS` per field), and
one row for a field without distinct values. These rows are not generically flattened.
They are built straight from the statistics, with the fields and values that flattening
gave them before, one row at a time, and each row is ingested before the next is built. So
the row limits do not apply, and the statistics of a file are ingested in full however many
rows they take.

The byte limit applies to each row on its own. A row is measured before it is built. A row
larger than `P_MAX_FLATTEN_BYTES_PER_REQUEST` as compact JSON, which takes a distinct value
or a field name of about that size, is skipped with a warning that names the stream, the
file and the field (cut to 128 characters), but no value. The other rows of the file are
still ingested. A failure to compute or ingest the statistics of a file is logged as a
warning, with the stream, the tenant and the file.

## When a request is rejected

The error message names the limit that was exceeded and its value. To get under the limit,
reduce the number or length of the nested arrays in each event, or split the batch into
smaller requests. You can also raise the limit, see
[Upgrading](#upgrading-requests-that-are-now-rejected).

`tools/flatten-bench/http_smoke.py` checks these responses against a built server binary,
including flat batches at and just over the rows per request.
