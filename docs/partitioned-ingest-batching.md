# Partitioned ingest batching

Partitioned ingest batching reduces conversion and staging work for streams with
custom or time partitions. It is disabled by default. Enable it with
`P_PARTITIONED_INGEST_BATCHING=true` or `--partitioned-ingest-batching`.
With the option unset, partitioned requests retain per-record conversion,
staging, accounting and live-tail delivery in input order.

Batching benefits warmed streams: records with only scalar values whose fields
are already in the stream schema can be decoded and staged together by field
set, partition values and minute. A request containing any nested array or object
uses per-record conversion. The first requests to a new stream cannot benefit
until its schema is established. Unpartitioned streams are unaffected.

With batching enabled, query mode and requests with a live-tail subscriber at
request entry retain the original per-record path. The subscriber registry is
keyed by stream name. A subscriber attaching during a grouped request receives
single-row batches in input order after staging; the existing channel overflow
policy still applies.

Batching changes partial-failure behavior. Groups are staged in order of their
first input row. If staging group `b` fails for input `(a,1),(b,2),(a,3)`, the
completed group `a` contains rows 1 and 3, rather than the input prefix left by
per-record staging. Both completed rows are counted in stats and billing and
sent to live tail in input order. Later groups are not attempted. Conversion
and field-limit failures stage no rows. Staging is not transactional: the failing
writer itself can leave data on disk before returning an I/O error; that call
does not report how many rows it persisted. Accounting covers all successfully
completed staging calls, including completed groups beyond the failed input row.
No rows are retried. The request returns the staging error.

Batching also fixes which error a request with several invalid records returns.
With the option on it is always the error of the first invalid record in the
request. Without it, records are converted in parallel and the error can be
that of any invalid record.

Grouping retains a row-position map for ordered accounting, and changes disk IPC
batch boundaries. Staging files remain readable by existing readers. Choose this
option when ingestion work and staging overhead matter and these partial-failure
semantics are acceptable.

An independent measurement on an 8 vCPU host used a warmed custom-partitioned
stream, eight clients sending 1,000-row requests with interleaved partition
values. User-space instructions per row fell from 1,226k to 151k, throughput rose
from about 7,400 to 163,000 rows/s, and staging fell from 6,272 to 220 bytes/row.
Clock measurements on this host are noisy; instruction counts are the primary
work measure. These results describe the warmed scalar workload, not initial
schema creation or nested records.
