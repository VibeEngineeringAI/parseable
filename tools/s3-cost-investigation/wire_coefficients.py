#!/usr/bin/env python3
"""Convert physical trace summaries into unpriced per-cold-object coefficients."""
import json
from pathlib import Path


def coefficients(summary):
    rows = {item["key"]: item for item in summary}
    result = []
    for case in ("small", "large", "xlarge"):
        base = rows[f"{case}-2097152.parquet"]
        for hint in (65536, 524288, 2097152):
            row = rows[f"{case}-{hint}.parquet"]
            result.append(dict(case=case, hint_bytes=hint,
                               physical_gets=row["attempts"]["GET"],
                               setup_heads=row["attempts"]["HEAD"],
                               response_body_bytes=row["response_body_bytes"],
                               avoided_bytes_vs_2MiB=base["response_body_bytes"]-row["response_body_bytes"],
                               extra_gets_vs_2MiB=row["attempts"]["GET"]-base["attempts"]["GET"]))
    return result


if __name__ == "__main__":
    root = Path(__file__).resolve().parents[1]
    print(json.dumps(coefficients(json.loads((root/"s3-wire-bench/evidence/summary.json").read_text())), indent=2))
