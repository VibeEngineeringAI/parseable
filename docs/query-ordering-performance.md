# Query ordering correctness and measured cost

Parquet sorting metadata is a declaration, not proof that the physical rows are
sorted. Parseable can persist request batches in a different order from their
timestamps. If a reader advertises that data as timestamp-ordered, DataFusion can
omit a required sort and return an incorrect `ORDER BY` result.

The reader fix stops advertising this unverified order on manifest, hot-tier
and legacy listing scans. The listing reader retains statistics and pruning
but suppresses both ordering-inference entry points. It does not certify
existing files or make their footer declarations trustworthy.

## Reproduction

The retained public-HTTP reproduction ingested 120,000 rows through eight
concurrent producers, persisted them, then queried the same unchanged data with
the baseline and corrected reader:

```sql
SELECT id, value, p_timestamp FROM pub_concurrent
ORDER BY p_timestamp DESC NULLS LAST
```

The original reader returned the complete row population with eight strict
timestamp ascents, up to 2 milliseconds. The corrected reader returned the same
IDs, values and timestamps in descending order. The comparison permits arbitrary
ordering of equal timestamps; this is not a tie-order failure. The tested LIMIT
controls passed in both readers, which does not establish that trusting footer
ordering is safe for other LIMIT queries.

## Completed application comparison

The 2026-10-21 campaign used three ordinary-release application binaries on
mini-pc-03, one attempt, concurrency one, three counterbalanced blocks and
forward/reverse case order. It completed 18 fresh server lifetimes, 90 cells and
84,600 timed requests. The total HTTP record count was 86,544. All native exits
were zero, all response oracles passed, and independent closure confirmed no
owned processes, cgroups, listeners or locks remained.

| Arm | Source |
| --- | --- |
| A | Tree-equivalent to `5015557ee39112c4eec0f3a784e2453f1b869765`; embedded commit metadata is `56790e66` |
| B | Reader fix at `35988060d465aa74030990988e4ad0295d936d4e` |
| C | B plus the selective null-fill serializer; no typed timestamp TopK change |

All three builds used Rust 1.96, the ordinary release profile and Jemalloc. A and
B were retained builds; C was built later with the dependency graph checked
against B. Code layout and build-history effects are not independently isolated.
The shared ceiling was four CPUs, 12 GiB memory and no swap. The host clock and
query time bounds stayed in a stable staging-window regime.

These are descriptive results from three blocks on one host, not significance
tests or production capacity estimates. Blocks and lifetimes are the replication
units; individual requests are not independent experiment replications.

### Server process CPU per query

Ranges below are the three observed block ratios, not confidence intervals.
Positive values mean more CPU. H is a sorted 20,000-row file returning the top
10,000 rows; W is a wide projection with unique field names and in-schema nulls.

| Query | B versus A | C versus A | C versus B |
| --- | ---: | ---: | ---: |
| H, default `sendNull=false` | +49.3% to +49.7% | +49.3% to +51.2% | -0.3% to +1.1% |
| H, `sendNull=true` | +43.4% to +44.7% | +36.3% to +37.2% | -5.2% to -4.9% |
| W, `sendNull=true` | +0.2% to +0.5% | -10.8% to -10.2% | -11.3% to -10.6% |
| Filtered aggregate | Near noise | Near noise | Near noise |
| Full ordered result, no LIMIT | Excluded: A is wrong | Excluded: A is wrong | -0.3% to +3.3%; unresolved |

The dense-query plan difference is intentional: A advertises an ordered scan
and pushes down LIMIT; B and C retain a TopK sort. These comparisons have the
same query and response bytes, not the same plan. B and C plans match for every
cell. W and the aggregate have matching plans across all three arms.

The serializer saves CPU on the null-filled dense response and wide response.
It does not offset the largest dense-query regression on the default response
path. On the four-cell request mix that excludes the incorrect A no-LIMIT
result, B used 20.2–20.4% more total CPU than A; C used 14.8–15.6% more. C
recovered 22.8–27.5% of B's extra cost. Those weights come from the test protocol,
not a production workload. No ratios from earlier campaigns were multiplied or
pooled into these results.

### Latency, correctness and memory

C versus B median latency fell 3.9–4.3% for H with null filling and 9.5–10.2%
for W. C on H default remained about 45–46% above A. No-LIMIT p95 varied strongly
with run order; its C/B ratios ranged from 0.87 to 1.32.

All 600 timed A no-LIMIT responses had eight ordering ascents. All 1,200 timed
B/C no-LIMIT responses were correctly ordered. A's wrong-result timings are
excluded from every ratio. H, W and aggregate output bytes match across arms.

No application memory advantage or parity is established. Kernel burst peaks
include page cache and retained allocator state, and case order shifted memory
within an arm by up to approximately 38 MiB. Sampled RSS and lifetime high-water
marks do not establish per-query allocation peaks. Exact allocation parity in
the isolated serializer harness is a separate result, not an application RSS
guarantee.

## Scope and follow-up

The campaign measured B at `35988060`, before any subsequent legacy-listing
repair. It does not measure the legacy ListingTable path, object-store or
distributed deployment capacity, ingestion throughput, or every SQL shape.
The serializer is a separate optional change, not a prerequisite for correct
ordering and not a blanket no-regression claim.

A future ordered-scan fast path needs trustworthy evidence about the full
physical sequence, including batch, row-group and file boundaries. One possible
design is write-time verification plus a versioned certificate, with conservative
sorting for existing and uncertified files. That design is unimplemented and
unmeasured; existing footer flags, min/max, or LIMIT presence are insufficient.

## Evidence anchors

The R191 campaign and independent R192 raw audit reproduce all 90 cell summaries
and all block ratios to floating-point rounding. The earlier R181 campaign is
incomplete and is not pooled. R192 corrected a labeling defect: H comparisons
against A have different plans by design, despite the reducer's generic
`plan_bytes_query_match` label. This does not change the numbers above.

Retained local evidence directory:
`pr-qualification-20261019/pr48-combined-stable-execute-r191/`.

| Artifact | SHA-256 |
| --- | --- |
| `SUMMARY.json` | `ede2740427251a5378d8d5503ae5e524fc506600d8819e1e0420b2a671289f6d` |
| `HANDOFF.json` | `5c7f1693bfe2b815e7fe1d8356db13b97e39bcd4e579c315059763555e807c15` |
| `INDEPENDENT-CLOSURE.json.gz` | `05a35062905ba087d7d57f9aeeb490b8dbad84c9b0bc9c6c1544e101f8895ae0` |

These hashes identify retained private artifacts, not public downloads. The
repository regression tests provide reviewable correctness coverage without
depending on that archive. This report does not qualify either change for
automatic adoption or merge.
