# Small-batch staging checks

Small dictionary-free batches (fewer than 100 rows and less than 256 KiB of
Arrow array memory) can skip per-message LZ4 compression. Larger batches and
dictionary schemas retain compression. The output remains a valid Arrow IPC
stream. There is no new configuration flag.

These Python 3 tools use the adjacent repository server/compatibility harnesses,
two already-built Parseable binaries, and Linux `/proc`. Build both binaries
with matching toolchains, lockfiles and release settings before measuring.
Servers are disposable local-store instances using loopback ports and dummy
credentials. Output directories must be new and outside the checkout.

- `benchmark.py`: alternates baseline/candidate order across fresh server
  lifetimes, defaulting to three pairs, 16 clients, 1,024 requests and 1/10/100/1000
  rows per request. Measures wall throughput, latency, process CPU and apparent
  staging bytes; checks each request's row count and distinct row IDs. Payloads
  use the existing harness's synthetic 20-field nested fixture, not the original
  performance workload. Each load starts at minute :03 and fails if it crosses
  conversion; lower `--requests` if needed. No conversion or hardware instruction
  counters are collected. The driver opens a connection for every request, so
  client overhead can limit throughput.
- `summarize.py MEASUREMENTS`: prints median/min/max grouped by batch size,
  clients and arm from the benchmark's JSONL output.
- `compat-current.py`: runs the full shared compatibility corpus after replacing
  its fixed OTLP timestamp with a single fresh timestamp for both arms.
- `compat-delayed.py`: the same full corpus with a 1.1-second pause before each
  inspection to diagnose immediate query visibility boundaries.
- `compat-supported.py`: a partial diagnostic omitting the three valid OTLP
  readback cases, retaining 18 scenarios. It is not a full compatibility pass.

```sh
python3 scripts/ingest-performance/small-batch-staging/benchmark.py --baseline /abs/baseline --candidate /abs/candidate --output /abs/results/small-batch --pairs 3 --clients 16 --requests 1024
python3 scripts/ingest-performance/small-batch-staging/summarize.py /abs/results/small-batch/measurements.jsonl
python3 scripts/ingest-performance/small-batch-staging/compat-current.py --baseline /abs/baseline --candidate /abs/candidate --output /abs/results/compat-current --cpus ''
python3 scripts/ingest-performance/small-batch-staging/compat-delayed.py --baseline /abs/baseline --candidate /abs/candidate --output /abs/results/compat-delayed --cpus ''
python3 scripts/ingest-performance/small-batch-staging/compat-supported.py --baseline /abs/baseline --candidate /abs/candidate --output /abs/results/compat-partial --cpus ''
```

Pass `--cpus` with available cores to pin servers. These checks do not measure
object-storage capacity, persisted recovery, or power-loss durability. Keep
outputs and raw evidence outside the repository. Compatibility wrappers assert
exact source anchors and stop if the shared corpus changes.
