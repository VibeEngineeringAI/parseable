#!/usr/bin/env python3
"""Summarize benchmark.py's measurements.jsonl; standard library only."""
import argparse
import collections
import json
import pathlib
import statistics
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('measurements', type=pathlib.Path)
args = parser.parse_args()
groups = collections.defaultdict(list)
for line in args.measurements.read_text().splitlines():
    row = json.loads(line)
    groups[(row['rows_per_request'], row['clients'], row['arm'])].append(row)
summary = []
for (rows, clients, arm), runs in sorted(groups.items()):
    item = dict(rows=rows, clients=clients, arm=arm, repetitions=len(runs))
    for metric in ['rows_per_s', 'p50_ms', 'p99_ms', 'cpu_per_million', 'staging_bytes_per_row']:
        values = [r[metric] for r in runs]
        item[metric] = dict(median=statistics.median(values), min=min(values), max=max(values))
    summary.append(item)
print(json.dumps(summary, indent=2))
