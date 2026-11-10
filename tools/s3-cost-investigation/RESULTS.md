# Independent investigation results — 2026-11-10

Baseline is main at `24c4acca5d1bac4518f6019d21f823d1bc2ce196`.
PR137 was benchmark/documentation only: its merge reduced no production S3
usage. This follow-up also leaves production defaults and runtime unchanged.
Two focused gpt-6.1-sol agents independently investigated wire efficiency and
writer efficiency; coordinator reviewed paths, challenged feature/profile
alignment and combined the unpriced operating-cost model.

## Physical baseline and candidate decisions

Actual loopback HTTP traces use object_store 0.13.2, Parquet 59.2.0 and the
DataFusion 55 metadata fetch algorithm, including optional page indexes. These
are physical HTTP attempts and payload sizes, not logical storage counters or
an AWS billing measurement. There is one explicit setup HEAD per metadata case;
DataFusion may already know file size from manifests and need no such HEAD.

| Fixture footer including trailer | 64 KiB hint: GETs / bytes | 512 KiB hint: GETs / bytes | Current 2 MiB hint: GETs / bytes |
| --- | ---: | ---: | ---: |
| 1,603 B | 1 / 65,536 | 1 / 524,288 | 1 / 2,097,152 |
| 1,100,162 B | 3 / 1,740,827 | 3 / 2,199,579 | 1 / 2,097,152 |
| 3,280,963 B | 3 / 5,073,628 | 3 / 5,532,380 | 3 / 7,105,244 |

Footer byte counts alone cannot predict index fetches or fallback overlap.
The middle 512 KiB case is dominated by 2 MiB on both bytes and request count.
The 64 KiB candidate saves 2,031,616 payload bytes on the smallest and largest
fixtures with unchanged GET counts; on the middle fixture it saves only 356,325
bytes and adds two GETs. Keep the default: actual footer mix, cold rate, paid-byte
path and full-query latency are needed to establish the winning policy.

One logical three-range read became two physical GETs returning 6,144 bytes
for 3,072 requested bytes: existing coalescing already trades bytes for requests.
One logical read with an injected 503 produced two GET attempts. Do not bill
both as successful GETs: [AWS does not charge bucket owners for service 5xx
responses](https://docs.aws.amazon.com/AmazonS3/latest/userguide/ErrorCodeBilling.html).
The 4,096 B PUT control made one PUT and one validating HEAD; retain production
HEAD-before-publication semantics. A single LIST control is also traced.
See [raw traces and reproducible harness](../s3-wire-bench/README.md).

Warm control explicitly reuses immutable metadata with zero I/O; it does **not**
measure DataFusion cache hit rate, eviction or concurrent misses. Production
already has a shared DataFusion metadata cache (50 MiB default), range coalescing,
request-scoped historical planning reuse and an optional hot tier. No additional
cache is justified by this experiment. Shared mutable manifest caching cannot
be made fresh by invalidating only on this node. Tenant/path/version identity,
authorization and retention visibility remain requirements for any future reuse.

## Parameterized ranking

The writer probe matches root codec **and allocator features**, fat-LTO production
release profile and jemalloc, with 100,000 rows/shape, one warmup and three measured
AB/BA codec rounds. Fixtures use high-entropy hex IDs, long messages, 80%-sparse
wide columns and actual IPC batch boundaries of controlled sizes 1/32/256/8192;
these distributions are synthetic, not sampled production data.

| Shape (default dictionary) | LZ4_RAW → Zstd file bytes | Storage reduction | Write CPU ms | Full-read CPU ms |
| --- | ---: | ---: | ---: | ---: |
| App | 33,977,942 → 17,152,334 | 49.52% | 55.429 → 93.177 | 19.268 → 28.858 |
| Sparse wide | 42,850,469 → 21,406,812 | 50.04% | 186.474 → 233.887 | 41.283 → 64.514 |
| OTel with dense user time | 40,583,413 → 20,702,905 | 48.99% | 92.025 → 137.105 | 25.625 → 41.038 |

Disabling dictionary only on the selected timestamp changes whole-file LZ4/Zstd
bytes by +20/−38 for variable ingestion batches, +86/+54 for the 8192-row batch
control, and −600,281/−297,181 (1.48%/1.44%) for dense user `event_time`.
The user-time arm retains the ingestion timestamp dictionary. Encoding-arm timings
are descriptive; codec order is alternated within each arm. Selected-column savings
are not whole-file savings. New-write storage savings must ramp with retention;
no retained object changes. The standalone local timings are not SQL or service
capacity measurements. See [writer reproduction](writer/README.md),
[raw medians and fixture inventory](writer/summary.json) and exact feature audit.

The coordinator independently reran the wire experiment (exact trace equality)
and the twelve-file Arrow C++ verification (exact summary equality). Rust 59.2.0
checks each round's schema, values, nulls, timestamps, codec, encodings, sort and
statistics; Arrow C++18.1.0 independently checks schemas/values and row-group
bounds. Long strings use valid conservative truncated bounds, rather than exact
full-string extrema; comparisons check containment and matching statistics across
arms. These checks do not establish older-service query/rollback compatibility.

There is no honest deployment-wide dollar ranking without bills, workload
volumes and marginal rates. The actionable ranking is conditional:

| Candidate | Measured leverage / decision | Missing gate before runtime change |
| --- | --- | --- |
| 1. Existing Zstd option for storage-heavy deployments | Largest measured whole-file saving: 49–50%, with 25–68% extra writer CPU and slower full decoding. Candidate affects new writes only. | Workload weighting, ingest headroom, query decoding, supported older-service rollback. |
| 2. Smaller footer hint for paid-transfer-heavy cold scans | Strong byte reduction on some cold fixtures; 512 KiB regresses middle control. Keep 2 MiB default. | Actual cold/footer distribution, end-to-end selective ID/time/latest/aggregation query latency and billable-byte path. |
| 3. Selected-time dictionary for dense user-time streams | About 1.5% whole-file saving on dense control; batch-constant controls regress slightly. No global disable. | Workload-specific benefit, full service user-time partition and downgrade coverage. |
| Cache/hot-tier capacity | Existing mechanisms avoid duplicate implementation. No hit-rate claim. | Measure saved physical reads against fills/refills, RAM/local disk and authorization/freshness behavior. |
| NAT path / Bucket Keys / orphan bytes | Valid deployment mechanisms, not established costs in this environment. | Read-only deployment inventory and policy constraints; see DEPLOYMENT.md. |
| Compaction / storage class changes | No production small-file/access-age inventory; not justified. | Catalog-safe publication, concurrent retention/read/recovery design and measured rewrite cost. |

For `N` cold metadata loads/month, effective paid-byte price `b` per GB with
`G` bytes/GB and GET price `g` per individual request, a 64 KiB hint's measured
monthly gross saving for fixture weights `s,m,l` (sum one) is:

`N * ((2031616*(s+l) + 356325*m) * b/G - 2*m*g)`.

Subtract added compute/capacity cost; add only separately applicable retrieval
and NAT byte terms. If bytes are free, any nonzero middle-fixture fraction adds
request expense. HTTP body bytes are an approximation for a paid-byte term only
after confirming its billing basis; NAT transport bytes include other overhead.
`wire_coefficients.py` regenerates machine-readable coefficients from traces.
`cost_model.py` ranks complete monthly resource vectors using supplied rates and
reports storage/requests/retrieval/transfer/NAT/KMS/compute/memory/disk separately.
It includes rewrite cost and break-even; tests exercise a case with storage and
transfer savings offset by extra requests/CPU. No live prices are embedded.

For example, each monthly 100,000-row equivalent of the app fixture avoids
16,825,608 stored bytes per retained copy and adds 0.037748 writer CPU seconds;
each full decode adds 0.009590 CPU seconds. Weight storage by the retained cohorts
and reads by their actual frequency before pricing. This is a measured cost
coefficient, not a deployment saving forecast. Rewriting retained data would
also incur read/write requests, compute, potential paid transfer and temporary
duplicate storage; this investigation does not propose that rewrite.

## Correctness and completion boundary

No runtime code was modified, so API/UI/CLI behavior, manifests, tenant isolation,
accounting, upload validation and recovery paths remain at the merged baseline.
Experiments test standard Parquet compatibility within their documented bounds;
they do not establish whole-service query equivalence or supported older-service
rollback. Neither codecs nor timestamp policy should change defaults on this evidence.

Next runtime work is concrete: replay the measured representative shapes through
a current and supported older service, compare full/selective SQL results and
ingest/query CPU, then evaluate the provided net-cost equation at the deployed
workload mix. For footer work, collect existing metadata-cache hit/miss/eviction
and footer/index sizes before choosing a policy. For compaction, first run the
offline inventory on a real export grouped by stream and partition. No merge,
deployment, paid-resource startup or infrastructure/lifecycle change was made.
