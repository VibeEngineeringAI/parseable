#!/usr/bin/env python3
"""Offline monthly cost comparison. Prices are supplied, never inferred.

Input: {rates: {unit: price}, baseline: {unit: quantity}, candidates:
[{name: str, quantities: {unit: quantity}, one_time_cost: number}]}.
Each candidate is a COMPLETE alternative monthly vector, not a delta.
Use consistent currency, region, billing period and GB convention throughout.
"""
import argparse
import json
import math

UNITS = (
    "storage_gb_month", "get_head_1000", "put_copy_post_1000", "list_1000",
    "retrieval_gb", "paid_transfer_gb", "nat_processing_gb", "nat_hours",
    "kms_10000", "compute_vcpu_hours", "memory_gb_hours", "local_disk_gb_month",
    "other_monthly",
)


def vector(value):
    if set(value) != set(UNITS):
        raise ValueError(f"Expected exactly these units: {UNITS}")
    for key, number in value.items():
        if isinstance(number, bool) or not isinstance(number, (int, float)) or not math.isfinite(number) or number < 0:
            raise ValueError(f"{key} must be finite and nonnegative")
    return value


def compare(document):
    rates = vector(document["rates"])
    def cost(quantities):
        return {key: number * rates[key] for key, number in vector(quantities).items()}
    baseline = cost(document["baseline"])
    results = []
    for candidate in document["candidates"]:
        components = cost(candidate["quantities"])
        saving = sum(baseline.values()) - sum(components.values())
        once = candidate.get("one_time_cost", 0)
        if isinstance(once, bool) or not isinstance(once, (int, float)) or not math.isfinite(once) or once < 0:
            raise ValueError("one_time_cost must be finite and nonnegative")
        results.append(dict(name=candidate["name"], monthly_cost=sum(components.values()),
                            monthly_saving=saving, first_month_saving=saving-once,
                            break_even_months=once/saving if saving > 0 else None,
                            components=components))
    return dict(baseline_components=baseline, baseline_monthly_cost=sum(baseline.values()),
                candidates=sorted(results, key=lambda x: x["monthly_saving"], reverse=True))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input")
    args = parser.parse_args()
    with open(args.input) as source:
        print(json.dumps(compare(json.load(source)), indent=2, allow_nan=False))
