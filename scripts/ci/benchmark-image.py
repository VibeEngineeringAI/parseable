#!/usr/bin/env python3
"""Derive a benchmark Dockerfile without changing the production Dockerfile."""
import argparse
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args()
source = Path("Dockerfile.debug").read_text()
marker = "FROM docker.io/rust:1.96.0-bookworm AS builder\n"
assert source.count(marker) == 1, "Review benchmark toolchain injection"
source = source.replace(marker, marker + "\nARG CARGO_PROFILE_DEV_DEBUG=2\nENV CARGO_PROFILE_DEV_DEBUG=$CARGO_PROFILE_DEV_DEBUG\n", 1)
marker = "COPY resources ./resources\nRUN cargo build\n"
assert source.count(marker) == 1, "Review benchmark source compilation boundary"
# Force the source compilation RUN to execute on every repetition. Dependencies
# keep their cache; a same-revision fully cached no-op is not a compile benchmark.
source = source.replace(marker, "COPY resources ./resources\nARG SOURCE_REBUILD\nRUN echo \"source rebuild: $SOURCE_REBUILD\" && cargo build\n", 1)
args.output.write_text(source)
