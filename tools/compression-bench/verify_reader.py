#!/usr/bin/env python3
"""Independent older-reader validation against saved input IPC; no data generation."""
import argparse
import json
import platform
from pathlib import Path
import time
import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.ipc as ipc
import pyarrow.parquet as pq

parser = argparse.ArgumentParser()
parser.add_argument('directory', type=Path)
args = parser.parse_args()
print(json.dumps({'type': 'reader', 'pyarrow': pa.__version__, 'cpp': pa.cpp_version,
                  'python': platform.python_version()}))
for kind in ('app', 'wide', 'otel'):
    with ipc.open_file(args.directory / f'{kind}.arrow') as f:
        expected = f.read_all()
    stats_baseline = None
    for codec in ('lz4_raw', 'zstd'):
        path = args.directory / f'{kind}-{codec}.parquet'
        file = pq.ParquetFile(path)
        actual = pq.read_table(path, use_threads=False)
        assert actual.schema.equals(expected.schema, check_metadata=True)
        assert actual.equals(expected), (kind, codec, 'values/nulls/timestamps')
        assert actual.num_rows == file.metadata.num_rows == expected.num_rows
        stats, offset = [], 0
        for r in range(file.metadata.num_row_groups):
            group = file.metadata.row_group(r)
            values = expected.slice(offset, group.num_rows)
            for c in range(group.num_columns):
                column = group.column(c)
                assert column.compression == {'lz4_raw': 'LZ4', 'zstd': 'ZSTD'}[codec]
                stat = column.statistics
                assert stat is not None, (kind, codec, c)
                array = values.column(c)
                assert stat.null_count == array.null_count
                if array.null_count < len(array):
                    bounds = pc.min_max(array).as_py()
                    assert stat.has_min_max
                    assert stat.min == bounds['min'], (kind, codec, c, 'min')
                    assert stat.max == bounds['max'], (kind, codec, c, 'max')
                else:
                    assert not stat.has_min_max
                stats.append((r, c, stat.physical_type, stat.logical_type.type, stat.num_values,
                              stat.null_count, stat.has_min_max, stat.min, stat.max))
            offset += group.num_rows
        assert offset == expected.num_rows
        if stats_baseline is None:
            stats_baseline = stats
        else:
            assert stats == stats_baseline
        # Warm full and projected reads; equality checks outside timed regions.
        projection = ['p_timestamp', 'severity', 'duration_ms']
        assert pq.read_table(path, columns=projection, use_threads=False).equals(expected.select(projection))
        for trial in range(5):
            for projected in ([False, True] if trial % 2 == 0 else [True, False]):
                cpu = time.process_time_ns()
                start = time.perf_counter_ns()
                result = pq.read_table(path, columns=projection if projected else None, use_threads=False)
                wall_ms = (time.perf_counter_ns() - start) / 1e6
                cpu_ms = (time.process_time_ns() - cpu) / 1e6
                assert result.equals(expected.select(projection) if projected else expected)
                print(json.dumps({'type': 'read_sample', 'dataset': kind, 'codec': codec,
                                  'projection': projected, 'trial': trial,
                                  'wall_ms': wall_ms, 'cpu_ms': cpu_ms}))
        print(json.dumps({'type': 'verified', 'dataset': kind, 'codec': codec,
                          'rows': offset, 'row_groups': file.metadata.num_row_groups,
                          'schema_values_nulls_timestamps_statistics': 'pass'}))
