"""Summarize query outputs supplied explicitly; requires matching query sets."""
import argparse
import json
import statistics
from pathlib import Path
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('runs', type=Path, nargs='+')
args = parser.parse_args()
runs = [json.loads(p.read_text()) for p in args.runs]
assert all(r.keys() == runs[0].keys() for r in runs), 'query sets differ'
summary = {}
for query in runs[0]:
    summary[query] = {}
    for metric in ['p50_ms', 'cpu_ms', 'GETs', 'GET_RANGES']:
        values = [r[query][metric] for r in runs]
        summary[query][metric] = dict(median=statistics.median(values), min=min(values), max=max(values))
print(json.dumps(summary, indent=2))
