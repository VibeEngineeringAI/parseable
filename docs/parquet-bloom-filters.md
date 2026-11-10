# Parquet bloom filters

Parseable can write bloom filters for selected columns during Arrow-to-Parquet
conversion. Equality lookups on high-cardinality fields such as trace IDs and
request IDs can skip row groups whose min/max statistics span the requested ID
but which do not contain it. A filter can prove absence; a possible match still
requires reading the data. The target false-positive rate is 1%.

## Configuration

| Setting | Default | Meaning |
| --- | --- | --- |
| `P_PARQUET_BLOOM_FILTER_COLUMNS` / `--parquet-bloom-filter-columns` | unset (disabled) | Comma-separated top-level column names, for example `trace_id,request_id`. Spaces around names are ignored. Names are case-sensitive and matched literally: dots do not traverse nested fields, and a struct or list column gets no filter. Columns a stream does not have are ignored. |
| `P_PARQUET_BLOOM_FILTER_POSITION` / `--parquet-bloom-filter-position` | `after-row-group` | `after-row-group` writes each row group's filters right after it. `end` writes them all at the end of the file and holds them in memory until then. |

For example, set this in the server environment before starting Parseable:

```sh
export P_PARQUET_BLOOM_FILTER_COLUMNS=trace_id,request_id
```

Selection applies across streams, except OTel metrics streams. Their existing
`metric_name` filters and `P_DATAFUSION_BLOOM_FILTER_DEFAULT_POSITION` setting
remain independent. Column names must match the merged output schema exactly;
this option does not add columns or change their types.

## Benefits and costs

Equality and `IN` predicates can benefit when most row groups lack the selected
values. Broad scans, negative predicates such as `!=`, and general `LIKE`
patterns cannot use membership filters to prove absence. Casts that transform
stored values should not be assumed to benefit.

Filters add hashing work during conversion, writer memory, and stored bytes for
each selected column in each row group. A filter is sized for
`P_PARQUET_ROW_GROUP_SIZE` distinct values, which is about 512 KiB of memory per
selected column per row group at the default row group size, whatever the
column's real cardinality; short or low-cardinality groups are written as
smaller filters. With `after-row-group` that memory is released as each row
group is written. With `end` it is held for every row group until the file is
closed: 16 columns over 128 row groups would hold about 1 GiB. Select a few
frequently queried ID columns rather than every column.

The current reader fetches each surviving row group's column filter separately,
with either position. On object storage, extra
GET latency can outweigh saved data reads for present IDs, broad ranges, or
queries that reject few groups. Avoid enabling filters for
columns rarely used in selective equality lookups, or when min/max pruning
already eliminates the relevant groups.

## Compatibility

Files remain standard Parquet and are readable by older Parseable versions.
With the columns option unset, the Parquet writer is configured exactly as
before and output files are byte-for-byte the same. Existing OTel metrics
filters keep their previous behavior. Only newly written Parquet files receive
the configured filters, including pending staging files converted after a
restart. Existing Parquet files are not rewritten. Enabling or disabling the
option requires no data migration.

## Measured results

Measured on an 8 vCPU host with 24 million rows in 24 files and 96 row groups,
one million distinct IDs, filters at `end`, and object storage emulated by
MinIO with 25 ms of added latency per request. Timings are medians over
separate server lifetimes with warm caches. They describe this synthetic
dataset, not production capacity.

| Query | Store | Without filters | With filters |
| --- | --- | ---: | ---: |
| ID equality, ID absent | local disk | 60 ms | 11 ms |
| ID equality, ID present | local disk | 53 ms | 26 ms |
| ID equality, ID absent | object storage | 823 ms | 346 ms |
| ID equality, ID present | object storage | 811 ms | 482 ms |
| ID equality inside a one-minute range | object storage | 225 ms | 283 ms |
| `!=` on the ID column | object storage | 835 ms | 1,042 ms |
| No predicate on the ID column | object storage | 443 ms | 447 ms |

The two slower rows are the cost described above. A full-range lookup recorded
50 logical object-store `GET` calls without filters and 138 with them, because
each row group's filter is a separate read. With `after-row-group` the same lookups
recorded 146 `GET` calls and timings were within a few percent (355 ms against 346 ms
for the absent-ID lookup on object storage). With a
narrow time range, min/max statistics already leave little to skip, so the
filter reads are overhead (6 GETs became 10). A `!=` predicate still fetches
the filters but cannot use them.

These counts are the `GET` metric from Parseable's storage wrapper, not the
total number of HTTP requests or billed S3 GETs. A separate `GET_RANGES` call
can issue multiple HTTP range requests after the storage library coalesces
nearby ranges. Those requests and the library's retries are not individually
visible to the wrapper. Use an isolated MinIO server-side trace or S3 request
logs to measure physical requests before estimating request charges. Faster
query times alone do not establish lower S3 costs.

Writing filters added 2.3% to conversion CPU instructions for one column and
4.8% for two. Files grew 6.6% and 13.2%; the test data compresses unusually
well, so the relative growth on real data is likely smaller. A one-million-row
file carried about 131 KB of filters for one column.

The scripts in `scripts/query-performance/bloom-filters/` inspect Parquet
files and time queries against prepared data.
