#!/usr/bin/env python3
"""Inspect local fixture footer sizes and selected column chunks; no network IO."""
import argparse
import json
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('directory', type=Path)
parser.add_argument('--columns', nargs='+', default=['p_timestamp', 'request_id', 'trace_id', 'span_id'])
args = parser.parse_args()
paths = sorted(args.directory.glob('*.parquet'))
if not paths:
    parser.error('no Parquet files found')
report = {'pyarrow': pa.__version__, 'cpp': pa.cpp_version, 'files': {}}
for path in paths:
    file = pq.ParquetFile(path)
    columns = {}
    total = 0
    for r in range(file.metadata.num_row_groups):
        group = file.metadata.row_group(r)
        for c in range(group.num_columns):
            column = group.column(c)
            total += column.total_compressed_size
            if column.path_in_schema not in args.columns:
                continue
            entry = columns.setdefault(column.path_in_schema, {
                'compressed_bytes': 0, 'uncompressed_bytes': 0, 'encodings': [], 'codecs': [],
            })
            entry['compressed_bytes'] += column.total_compressed_size
            entry['uncompressed_bytes'] += column.total_uncompressed_size
            entry['encodings'] = sorted(set(entry['encodings']) | set(column.encodings))
            entry['codecs'] = sorted(set(entry['codecs']) | {column.compression})
    size = path.stat().st_size
    for entry in columns.values():
        entry['file_share_percent'] = round(entry['compressed_bytes'] * 100 / size, 4)
    report['files'][path.name] = {
        'file_bytes': size, 'rows': file.metadata.num_rows,
        'row_groups': file.metadata.num_row_groups,
        'footer_metadata_bytes': file.metadata.serialized_size,
        'all_column_compressed_bytes': total, 'columns': columns,
    }
print(json.dumps(report, indent=2))
