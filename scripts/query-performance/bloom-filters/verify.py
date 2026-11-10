"""Compare whole-file SHA-256 for matching relative Parquet paths in two trees."""
import argparse
import hashlib
import json
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('baseline', type=Path)
parser.add_argument('unset', type=Path)
args = parser.parse_args()
def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(8 * 1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()

def inventory(root):
    return {str(p.relative_to(root)): digest(p) for p in sorted(root.rglob('*.parquet'))}
a, b = inventory(args.baseline), inventory(args.unset)
print(json.dumps({'baseline': a, 'unset': b, 'equal': bool(a) and a == b}, indent=2))
if not a or a != b:
    raise SystemExit('Parquet file paths or hashes differ (or no files found)')
