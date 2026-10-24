# Ingestion performance and compatibility checks

These scripts launch disposable local-store servers on loopback ports. They require two already-built Parseable binaries, Python 3, Linux `/proc`, and `taskset` when CPU affinity is supplied. They do not connect to an existing deployment. Each output directory must be new. Test credentials are local dummy values; telemetry and update checks are disabled.

Build the baseline and candidate with the same Rust toolchain, lockfile, features, allocator, profile and real UI assets. Preserve the baseline executable before building the candidate. Run builds and other experiments before timing; avoid competing activity on the test host.

```sh
python scripts/ingest-performance/compatibility.py --baseline /abs/baseline --candidate /abs/candidate --output /abs/results/compat --cpus 2,4,6,8
python scripts/ingest-performance/run.py --baseline /abs/baseline --candidate /abs/candidate --output /abs/results/burst --pairs 4 --cpus 2,4,6,8
python scripts/ingest-performance/sustained.py --baseline /abs/baseline --candidate /abs/candidate --output /abs/results/sustained --pairs 2 --seconds 300 --requests-per-second 20 --cpus 2,4,6,8
python scripts/ingest-performance/mixed.py --baseline /abs/baseline --candidate /abs/candidate --output /abs/results/mixed --pairs 2 --seconds 75 --requests-per-second 2 --queries-per-second 2 --cpus 2,4,6,8
```

Select available physical cores on your machine, or pass `--cpus ''` to omit affinity. Four Actix and four Rayon workers are used in both arms. The burst runner alternates arm order across pairs; `--smoke` runs a small functional check. Sustained and mixed runners also alternate arm order with `--pairs`; the default remains one pair. The offered load starts at wall-clock minute :05 after warmup, unless phase alignment is disabled; its actual anchored start is recorded. Their fixed offered rates do not measure maximum sustainable capacity. Use separate comparisons against the original baseline and reviewed PR binary to isolate the cost of remediation; optional `--reviewed` adds a third arm but ABC/CBA ordering does not balance the middle arm across positions.

The mixed runner ingests 8,204-row, 127-field scalar requests while querying the same dataset. Its default body is 9,556,551 bytes, checked before starting servers against the 10 MiB HTTP limit. The server adds `p_timestamp`; production queries sort fields and exercise reordered schema adaptation during capture. Each concurrent query must include every request acknowledged before it starts and cannot include requests that start after it finishes; in-flight rows remain allowed. These timestamp bounds are checked after load and saved per query. Exact request/row identity is checked after load, drain and persisted-only restart. Mixed CPU includes ingestion and queries. Query latency is not isolated capture time or lock-hold time.

`--diagnostics` streams bounded 100 ms thread state/wchan/schedstat/fault counters, process I/O, host pressure and swap counters. Both arms receive the same instrumentation. Collection cost, errors, truncation and the byte cap are reported; use matched on/off runs before attributing timing changes to the server. A clean run or an off-CPU sample cannot explain a historical stall. The diagnostic does not enumerate unrelated host processes or identify their I/O. Client lag, workload duration, live payload bytes and sampled staging bytes are bounded; hitting a safety bound invalidates the run rather than demonstrating a performance threshold.

Every timed request must succeed. Request IDs are unique, including warmup requests. Verification checks each request's row count, distinct row IDs and bounds. Burst checks repeat after SIGKILL and restart, polling for eventual query visibility for up to 120 iterations. This tests process-crash recovery, not power-loss durability or immediate recovery readiness.

The sustained runner samples server CPU/RSS and file sizes each second. After load stops, it polls the target dataset’s data-bearing staging files for up to 240 seconds, requires three consecutive empty observations, and verifies rows again. It then kills its server, preserves the old staging directory and starts with empty staging to check rows from the persisted local store. Internal `pstats` work may continue after the target dataset drains. CPU is reported separately for the ACK window and through observed drain (the latter also includes the first verification query). Sampled peak RSS includes verification queries and drain; it is not an ingestion-only peak or allocator high-water mark. Staged file size is not a total in-memory backlog measure.

Burst payloads are prepared before timing and capped at 768 MiB of client payload data. The current app/wide workloads retain about 413/528 MB in the client; reported server RSS excludes the client, kernel page cache and other processes. Request identities add one string field to each row. Payloads, binary hashes, timing phase, configuration and host load are recorded. Short burst results may overlap periodic background work differently; inspect all repetitions rather than a single ratio.

The compatibility corpus compares HTTP status/error responses, schemas, ingestion accounting and logical row multisets. It deliberately ignores generated `p_timestamp` and unspecified SQL result order. Every request's expected status is asserted independently, including intended rejections and raw OTLP cases; `partitiontypes` pins one named inherited 500 with its known one-row partial outcome. Successful setup/readback statuses, row counts and accounting are asserted, and the static case additionally checks schema types, IDs and decoded values. Equal errors cannot satisfy these success checks. Exact non-static content/error bodies still rely on differential comparison. Ordered flattening, exact RecordBatch/schema behavior and failure boundaries are covered separately by the Rust differential tests.

Run the server-free oracle and harness tests with `python3 -B -m unittest discover -s scripts/ingest-performance -p 'test_*.py' -v`. `compatibility-baseline.json` is the real successful normalized transcript from commit `6aaee1d61c261c6b71c0dad30b6bee75ac654cab`. Replay tests reject equal 503s on ingests/readbacks and incorrect static values, schemas, or accounting; a replay pass does not replace live validation on the final binaries.

To render PNG/SVG charts, install matplotlib and numpy in an isolated environment, then:

```sh
python scripts/ingest-performance/plot.py --burst /abs/results/burst --sustained /abs/results/sustained --output /abs/results/figures
```

The local-store results do not establish S3 ingestion capacity. Multipart memory and failure behavior require separate storage probes. Keep exact build provenance and limitations with any reported figures.
