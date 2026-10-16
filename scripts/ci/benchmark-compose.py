#!/usr/bin/env python3
"""Write a Compose override for isolated, pinned Quest comparisons."""
import argparse
import json
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--binary", type=Path, required=True)
parser.add_argument("--quest-image", required=True)
parser.add_argument("--minio-image", required=True)
parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args()
for image in (args.quest_image, args.minio_image):
    if "@sha256:" not in image:
        parser.error("Both service images must be digest-pinned")
binary = args.binary.resolve(strict=True)
args.output.write_text(json.dumps({"services": {
    "minio": {"image": args.minio_image},
    "quest": {
        "image": args.quest_image,
        "pull_policy": "if_not_present",
        "volumes": [{"type": "bind", "source": str(binary),
                     "target": "/tests/quest.test", "read_only": True}],
    },
}}, indent=2) + "\n")
