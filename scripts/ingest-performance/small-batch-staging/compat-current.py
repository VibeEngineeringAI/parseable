#!/usr/bin/env python3
"""Run the unchanged compatibility corpus with its stale OTLP timestamp refreshed.

The corpus queries the last hour but pins an October 23, 2026 OTLP timestamp.
Select a single timestamp before either arm, preserving differential values.
All CLI arguments and assertions come from the original script.
"""
import pathlib
import sys
import time

script = pathlib.Path(__file__).resolve().parents[1] / 'compatibility.py'
source = script.read_text()
assert source.count("timestamp='1792780200000000000'") == 1
source = source.replace("timestamp='1792780200000000000'", f"timestamp='{time.time_ns()}'")
sys.path.insert(0, str(script.parent))
exec(compile(source, str(script), 'exec'), {'__name__': '__main__', '__file__': str(script)})
