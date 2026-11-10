# Latest-row timestamp prefilter

Wide queries that return the newest few rows can spend most of their time
reading older Parquet row groups. The optional latest-row prefilter first reads
only the timestamp and columns needed by the original predicate in a recent
window. If it finds enough rows, their oldest timestamp becomes an inclusive
lower bound on the original query. This lets Parquet prune older row groups.

## Enable the option

Set `P_LATEST_N_PREFILTER=true` on a standalone server. The default is `false`.
The corresponding command-line option is `--latest-n-prefilter true`.

The optimization requires a single stream scan, plain column projections, at
least eight output columns, and one descending sort on the stream's timestamp
column followed by a literal nonzero LIMIT. LIMIT plus OFFSET must be at most
1,000. Joins, aggregates, expressions in the projection or sort, and distributed
query modes bypass it. So does a predicate that contains a subquery of any
form (`IN`, `EXISTS`, `ANY`, `ALL` or scalar) or a function whose result depends
on when it runs, such as `now()` or `random()`:
the probes and the final query run separately and must agree on which rows
match. Nullable timestamps with NULLS FIRST require a predicate
that excludes null timestamps.

```sql
SELECT * FROM applogs
WHERE service = 'checkout'
ORDER BY p_timestamp DESC
LIMIT 100 OFFSET 200
```

The original predicate remains in every probe. The inclusive lower bound retains
all ties at the threshold; the original query still applies its sort, offset,
and limit. Equal timestamps have no additional tie ordering guarantee.

## Work and fallback

The first window spans the smaller of 60 seconds and one tenth of the requested
time range. Up to two further windows grow by a factor of eight, each capped at
one tenth of the range. Total requested probe spans are at most 4/35 of the
requested range. This bounds time spans, not bytes, requests, or predicate CPU.
Minute files, row-group boundaries, and skewed timestamps can dominate the cost.

If no window finds LIMIT plus OFFSET rows, or its threshold is null, the original
query runs without an additional bound. Failed probes therefore add work.
Historical scans share stream settings, the snapshot, and fetched manifests
within that request. Cached metadata is discarded after the request and is not
shared between users or queries. Scans that may include staging bypass this
cache to preserve their staging capture and snapshot refresh sequence.

Parquet footers and predicate data are still read separately by probes and the
final scan. Sparse predicates, missing values inside file statistics bounds,
and ranges ending well after the newest data can regress despite metadata
reuse. Prefer leaving the option disabled for these workloads. Narrow
projections bypass probing because the extra reads can outweigh their savings.
Probe reads contribute to the normal scanned-file and scanned-byte counters.

## Current limits

The option remains experimental and disabled by default. Metadata reuse removes
repeated planning reads on historical ranges; it does not impose a total work
budget or guarantee a maximum fallback regression. Sharing decoded Parquet
metadata or predicate reads, or enforcing a scan budget, requires further work.
Stream metadata read for a probe is reused by the final scan. If retention
deletes a day of data between the two, the final scan can fail on a missing
file where a query without the option would have seen the updated snapshot;
the same failure is possible without the option, in a shorter window, when
retention runs between a query's metadata read and its file reads. Rerun the
query. Concurrent retention and publication need stress coverage before
broader adoption. No file formats, HTTP response shapes, or existing defaults change.
