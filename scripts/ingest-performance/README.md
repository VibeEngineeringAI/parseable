# Ingestion performance and compatibility checks

These scripts launch disposable local-store servers on loopback ports. They require two already-built Parseable binaries, Python 3, Linux `/proc`, and `taskset` when CPU affinity is supplied. They do not connect to an existing deployment. Each output directory must be new. Test credentials are local dummy values; telemetry and update checks are disabled.

Build the baseline and candidate with the same Rust toolchain, lockfile, features, allocator, profile and real UI assets. Preserve the baseline executable before building the candidate. Run builds and other experiments before timing; avoid competing activity on the test host.

```sh
python scripts/ingest-performance/compatibility.py --baseline /abs/baseline --candidate /abs/candidate --output /abs/results/compat --cpus 2,4,6,8
python scripts/ingest-performance/run.py --baseline /abs/baseline --candidate /abs/candidate --output /abs/results/burst --pairs 4 --cpus 2,4,6,8
python scripts/ingest-performance/sustained.py --baseline /abs/baseline --candidate /abs/candidate --output /abs/results/sustained --seconds 300 --requests-per-second 20 --cpus 2,4,6,8
```

Select available physical cores on your machine, or pass `--cpus ''` to omit affinity. Four Actix and four Rayon workers are used in both arms. The burst runner alternates arm order across pairs; `--smoke` runs a small functional check. The sustained runner makes one baseline/candidate comparison at a fixed offered rate. It does not measure maximum sustainable capacity.

Every timed request must succeed. Request IDs are unique, including warmup requests. Verification checks each request's row count, distinct row IDs and bounds. Burst checks repeat after SIGKILL and restart, polling for eventual query visibility for up to 120 iterations. This tests process-crash recovery, not power-loss durability or immediate recovery readiness.

The sustained runner samples server CPU/RSS and file sizes each second. After load stops, it polls the target dataset’s data-bearing staging files for up to 240 seconds, requires three consecutive empty observations, and verifies rows again. It then kills its server, preserves the old staging directory and starts with empty staging to check rows from the persisted local store. Internal `pstats` work may continue after the target dataset drains. CPU is reported separately for the ACK window and through observed drain (the latter also includes the first verification query). Sampled peak RSS includes verification queries and drain; it is not an ingestion-only peak or allocator high-water mark. Staged file size is not a total in-memory backlog measure.

Burst payloads are prepared before timing and capped at 768 MiB of client payload data. The current app/wide workloads retain about 413/528 MB in the client; reported server RSS excludes the client, kernel page cache and other processes. Request identities add one string field to each row. Payloads, binary hashes, timing phase, configuration and host load are recorded. Short burst results may overlap periodic background work differently; inspect all repetitions rather than a single ratio.

The compatibility corpus compares HTTP status/error responses, schemas, ingestion accounting and logical row multisets. It deliberately ignores generated `p_timestamp` and unspecified SQL result order. Expected-valid setup and readback are asserted. Ordered flattening, exact RecordBatch/schema behavior and failure boundaries are covered separately by the Rust differential tests.

To render PNG/SVG charts, install matplotlib and numpy in an isolated environment, then:

```sh
python scripts/ingest-performance/plot.py --burst /abs/results/burst --sustained /abs/results/sustained --output /abs/results/figures
```

The local-store results do not establish S3 ingestion capacity. Multipart memory and failure behavior require separate storage probes. Keep exact build provenance and limitations with any reported figures.
