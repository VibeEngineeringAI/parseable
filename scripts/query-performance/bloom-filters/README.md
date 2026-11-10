# Parquet bloom filter checks

These tools inspect prepared Parquet data and an idle local Parseable server.
They do not build binaries, generate ingestion data, start servers, configure
storage latency, or reproduce a complete benchmark. Keep outputs outside the
checkout. Use matching data, binaries, query ranges and configuration when
comparing arms; repeat with separate server lifetimes and alternate arm order.

- `footer.py DIRECTORY`: recursively reports row groups, encodings, bloom bytes,
  and a sample `trace_id` and timestamp. Requires `pyarrow>=26` and `fastparquet`;
  input must contain `trace_id` and `p_timestamp`.
- `verify.py BASELINE UNSET`: compares SHA-256 for all Parquet files at matching
  relative paths. Fails for empty input, missing files, or differing bytes. Both
  directories must come from identical conversion input and settings apart from
  the candidate's unset bloom option.
- `queries.py PORT PID PRESENT_ID OUTPUT START END`: measures query latency,
  Linux process CPU and storage request counts, retaining responses and EXPLAIN
  ANALYZE. Requires the `applogs` stream, `trace_id`, `service`, `level`, and
  `p_timestamp`, with a known present ID. Set `PRESENT_TIME` to its SQL timestamp.
  Choose an absent ID absent from your fixture (the script uses a fixed value).
  Set `P_USERNAME`/`P_PASSWORD` if credentials differ from `admin:admin`.
  `BLOOM_QUERY_REPS` defaults to 7. Explicit RFC3339 bounds should cover persisted
  data; relative ranges can exclude the current minute. CPU requires Linux
  `/proc`; keep the server idle apart from this script.
- `summarize.py RUN...`: prints median/min/max of matching query outputs from
  repeated runs of one arm. Do not combine baseline and candidate runs.

Install optional inspection dependencies in a virtual environment:

```sh
python3 -m venv /abs/tools/bloom-venv
/abs/tools/bloom-venv/bin/pip install 'pyarrow>=26' fastparquet
/abs/tools/bloom-venv/bin/python scripts/query-performance/bloom-filters/footer.py /abs/data/applogs
python3 scripts/query-performance/bloom-filters/verify.py /abs/baseline/applogs /abs/unset/applogs
PRESENT_TIME='2026-11-01 12:00:00' python3 scripts/query-performance/bloom-filters/queries.py 8000 1234 PRESENT_ID /abs/results/run1.json 2026-11-01T00:00:00Z 2026-11-02T00:00:00Z
python3 scripts/query-performance/bloom-filters/summarize.py /abs/results/run1.json /abs/results/run2.json
```

Query outputs are descriptive measurements, not correctness oracles. The stored
response excerpt may be truncated. Check complete results separately before
claiming compatibility. Changing filter position does not merge object-store
filter reads. See `docs/parquet-bloom-filters.md` for costs and measured results.
