#!/usr/bin/env python3
"""Run all 21 original assertions with a fresh OTLP timestamp and delayed reads.

Wait 1.1 seconds before each inspection to diagnose immediate query end-time
boundaries. No expectation, request shape or validation is removed.
"""
import pathlib
import sys
import time

script = pathlib.Path(__file__).resolve().parents[1] / 'compatibility.py'
source = script.read_text()
assert source.count("timestamp='1792780200000000000'") == 1
assert source.count('def inspect(port,stream):') == 1
source = source.replace("timestamp='1792780200000000000'", f"timestamp='{time.time_ns()}'")
source = source.replace('def inspect(port,stream):', 'def inspect(port,stream):\n    import time; time.sleep(1.1)')
sys.path.insert(0, str(script.parent))
exec(compile(source, str(script), 'exec'), {'__name__': '__main__', '__file__': str(script)})
