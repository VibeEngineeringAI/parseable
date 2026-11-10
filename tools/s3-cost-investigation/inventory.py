#!/usr/bin/env python3
"""Summarize an OFFLINE JSONL export; never connects to storage.

Each line: {"size": nonnegative integer bytes, "kind": "parquet"|"metadata"|...}.
Use separate exports for current objects, noncurrent versions and incomplete parts.
No object keys or tenant identifiers are emitted. This does not prove compaction safety.
"""
import argparse
import collections
import json


def summarize(records):
    buckets = collections.Counter()
    kinds = collections.defaultdict(lambda: dict(count=0, bytes=0))
    sizes = []
    for item in records:
        size = item["size"]
        if isinstance(size, bool) or not isinstance(size, int) or size < 0:
            raise ValueError("size must be a nonnegative integer byte count")
        sizes.append(size)
        label = next((label for bound, label in [(128*1024, "lt128KiB"), (1024**2, "128KiB_to_1MiB"), (25*1024**2, "1_to_25MiB")] if size < bound), "ge25MiB")
        buckets[label] += 1
        kind = item.get("kind", "unspecified")
        kinds[kind]["count"] += 1
        kinds[kind]["bytes"] += size
    sizes.sort()
    return dict(count=len(sizes), bytes=sum(sizes), bins=dict(buckets), kinds=dict(kinds),
                quantile_bytes={str(p): sizes[min(len(sizes)-1, int((len(sizes)-1)*p))] if sizes else None for p in (0, .5, .9, .99, 1)},
                hypothetical_128KiB_minimum_billable_bytes=sum(max(size, 128*1024) for size in sizes))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("export")
    args = parser.parse_args()
    with open(args.export) as source:
        print(json.dumps(summarize(json.loads(line) for line in source if line.strip()), indent=2))
