# Writer evidence, November 10, 2026

Keep the existing LZ4_RAW and timestamp-dictionary defaults. The supported Zstd
option remains a candidate for workload-specific evaluation; no runtime change
is justified by these standalone controls. New-write settings do not shrink
retained objects. PR137 itself changed no runtime setting.

100,000 rows per shape, one default-size partial row group, warmup plus three
measured alternating codec rounds, sequential dictionary arms, fat LTO and
feature-matched jemalloc. Shared i9-13900HK host, rustc 1.96.0. Full environment,
source/artifact hashes and exact sizes are in `manifest.json`; raw rounds are
`dictionary.jsonl` and `delta.jsonl`. `feature-audit.json` records exact matching
versions **and features** for codec and allocator crates. Fixtures and timing
boundaries/limits are in README.

| Shape | LZ4_RAW bytes | Zstd bytes | Byte reduction | Write CPU ms LZ4 / Zstd | Full-read CPU ms LZ4 / Zstd |
|---|---:|---:|---:|---:|---:|
| Variable ingestion batches, random IDs, long messages | 33,977,942 | 17,152,334 | 49.52% | 55.429 / 93.177 | 19.268 / 28.858 |
| 8,192-row ingestion batches, sparse wide control | 42,850,469 | 21,406,812 | 50.04% | 186.474 / 233.887 | 41.283 / 64.514 |
| Random trace/span IDs, dense user event time | 40,583,413 | 20,702,905 | 48.99% | 92.025 / 137.105 | 25.625 / 41.038 |

These are complete closed object lengths. Zstd conversion CPU rose 68.10%,
25.43% and 48.99%; full decode CPU rose 49.77%, 56.27% and 60.15%. This is a
materially different conversion tradeoff from PR137's structured inputs. These
percentages are not forecasts for actual customer traffic. The added measured
write CPU is about 2.2–2.3 CPU-seconds per decimal GB of new object bytes avoided;
query decoding CPU must be priced separately for actual access frequency and
projection/pruning. No transfer, physical requests or service throughput were
measured by this writer probe.

Turning off the dictionary only on the selected time-partition column produced:

| Selected timestamp | Codec | Timestamp chunk bytes dictionary / delta | Whole-file byte change |
|---|---|---:|---:|
| Variable ingestion batches, `p_timestamp` | LZ4_RAW | 520 / 552 | +20 |
| Variable ingestion batches, `p_timestamp` | Zstd | 483 / 457 | -38 |
| Constant 8,192-row batches, `p_timestamp` | LZ4_RAW | 275 / 369 | +86 |
| Constant 8,192-row batches, `p_timestamp` | Zstd | 310 / 372 | +54 |
| Dense user partition, `event_time` | LZ4_RAW | 604,284 / 4,021 | -600,281 |
| Dense user partition, `event_time` | Zstd | 298,588 / 1,425 | -297,181 |

The user-partition improvement is 1.48% / 1.44% of the full object, despite the
large timestamp-column improvement. This supports evaluating a conditional
policy on dense user timestamps; it does not support a global dictionary change.
The batch controls show negligible whole-file differences and slight growth.

All 48 main writer rounds passed Rust59.2.0 exact schema/value/null/timestamp,
codec, actual selected-time encoding, sorting metadata and required page-index
checks. Arrow C++18.1.0 independently checked all 12 final files against IPC and
compared identical source hashes and row-group statistics across dictionary
arms. Long-message row-group string bounds are truncated conservatively by the
normal writer (64 bytes in this run): independent checks require containment,
not false equality with the untruncated source extremum. Nonstring bounds are
exact; actual values are exact in every column. A separate 1,000-row Rust smoke
run with 137-row groups passed all shapes/codecs, exercising eight groups and
partial batches. It is not included in timing comparisons.

LZ4/Zstd footer metadata lengths were 1,973/1,972 bytes (app),
14,621/14,620 (wide), 3,962/3,959 (user-time). Those are footer lengths, not
physical fetched bytes. Files here are synthetic fixture inventory, not evidence
about customer small-file frequency. No production inventory or compaction
saving is asserted. The main run has only one partial default-size row group;
the smoke checks multiple groups but does not establish full-size multi-group
performance.

No Parseable service/downgrade target, SQL differential query, concurrent
retention/ingestion, recovery or tenant-authorization test ran. Preserve defaults
and rollback paths. A next runtime PR would require captured ingestion/time
cardinality distributions, actual query frequency/CPU budgets, service-level
read/query tests including the deployment's older supported binary, and a
positive parameterized storage/request/transfer/compute cost result. No default,
codec support or publication/HEAD validation was changed in this investigation.
