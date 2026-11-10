# Independent S3 operating-cost investigation

Baseline: `24c4acca5d1bac4518f6019d21f823d1bc2ce196` (PR137 already merged).
This directory contains offline evidence and tools, not a runtime optimization.
See RESULTS.md for measured decisions and limitations. No production credentials,
paid cloud resources, lifecycle changes or runtime defaults are needed.

## Cost accounting

`python3 cost_model.py deployment.json` compares complete monthly resource vectors.
Every rate and quantity must be supplied explicitly, including zero. There are no
embedded live prices. Rates must use one currency, region, period and GB convention.
The output separates storage, requests, retrieval, paid transfer, NAT, KMS,
compute, memory, local disk and other costs, ranks monthly net savings, and reports
one-time rewrite expense and break-even. Tiered pricing, discounts, minimum sizes
and durations must be incorporated into billable quantities/effective rates first.
For heterogeneous storage classes or network paths, aggregate separately priced
subvectors outside the tool; do not multiply all bytes by the highest rate.

Input structure (all keys in `cost_model.UNITS` required in rates and quantities):

```python
from cost_model import UNITS
template = {
    'rates': dict.fromkeys(UNITS, None),
    'baseline': dict.fromkeys(UNITS, None),
    'candidates': [{'name': 'candidate', 'quantities': dict.fromkeys(UNITS, None),
                    'one_time_cost': 0}],
}
```

Null placeholders intentionally fail: unknown costs must not silently become zero.
GET/HEAD, PUT/COPY/POST and LIST quantities use thousands of **billable** requests;
KMS uses ten-thousands. Trace all physical attempts, then classify chargeability
using provider status rules. A logical `GET_RANGES` can coalesce to fewer GETs or
retry to more attempts. HTTP response payload bytes exclude headers/TLS and are
not automatically billable transfer or NAT bytes.

For steady daily baseline new-write bytes `D`, retained for `R` days and measured
candidate byte ratio `r`, eventual storage reduction is `D*R*(1-r)`. At `t` days
after changing only new writes it is `D*min(t,R)*(1-r)`; integrate that quantity
over the billing month for GB-month. Existing retained objects do not shrink.
Variable ingestion/retention requires cohort summation instead. Writer CPU delta
is `(candidate CPU seconds - baseline CPU seconds) * monthly fixture equivalents / 3600`.
Add query decoding, memory and cache-fill costs separately. CPU savings on a fixed
instance affect the bill only when they avoid capacity or allow downsizing.
Do not add a separate memory/CPU rate to a bundled instance bill twice.

For a smaller footer hint, net saving per cold object is:
`avoided billable bytes * applicable byte rates - extra billable GETs * GET rate`
minus extra CPU/latency capacity cost. Apply cold fraction and large-footer mix;
do not apply the result to warm metadata hits. For hot tier, count full-object fill,
refills and local disk, then subtract only physically avoided remote reads.

## Offline object inventory

`python3 inventory.py export.jsonl` consumes newline-delimited records such as
`{"size": 16384, "kind": "parquet"}`. Export current data, mutable metadata,
noncurrent versions and incomplete parts separately; preserve partition/stream
grouping upstream when computing compaction opportunities. It emits no keys.
The 128 KiB minimum-byte result is a hypothetical class control, not a claim
about S3 Standard. Small files alone do not prove that compaction is safe or pays.
An authorized S3 Inventory export avoids making one HEAD per object.

## Reproduction and bounds

Run wire instructions in ../s3-wire-bench and writer/README.md separately. Use
dedicated directories beneath `$HOME/.cache` and a dedicated `TMPDIR`; do not use
shared `/tmp/claude-1000` or remove another session's files. Preserve run manifests,
feature audit, toolchain, input/output hashes and full traces with results.

Validate calculator arithmetic and input rejection with:
`python3 -m unittest discover -s tools/s3-cost-investigation -p 'test_*.py' -v`.
Its tests use arbitrary unit rates, not AWS price estimates.
