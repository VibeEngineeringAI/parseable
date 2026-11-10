"""Run with pyarrow + fastparquet; inspect standard Parquet footer metadata."""
import glob, json, sys
import fastparquet
import pyarrow.parquet as pq
files = glob.glob(sys.argv[1] + '/**/*.parquet', recursive=True)
result = {'files': len(files), 'rows': 0, 'bytes': 0, 'row_groups': 0, 'blooms': {}, 'structure': []}
for path in sorted(files):
    f = fastparquet.ParquetFile(path)
    metadata = pq.ParquetFile(path).metadata
    result['rows'] += f.count()
    result['bytes'] += __import__('os').path.getsize(path)
    result['row_groups'] += len(f.row_groups)
    for gi, rg in enumerate(f.row_groups):
        cols = []
        for ci, c in enumerate(rg.columns):
            m = c.meta_data
            name = '.'.join(m.path_in_schema)
            column = metadata.row_group(gi).column(ci)
            length = column.bloom_filter_length
            if length:
                result['blooms'][name] = result['blooms'].get(name, 0) + length
            cols.append({'name': name, 'encodings': m.encodings, 'codec': m.codec, 'bloom_offset': column.bloom_filter_offset, 'bloom_length': length})
        result['structure'].append({'rows': rg.num_rows, 'sorting': str(rg.sorting_columns), 'columns': cols})
if files:
    t = next(pq.ParquetFile(files[0]).iter_batches(batch_size=1, columns=['trace_id', 'p_timestamp'])).to_pylist()[0]
    result['present'] = t['trace_id']
    result['present_time'] = str(t['p_timestamp'])
result['bytes_per_row'] = result['bytes']/max(result['rows'], 1)
print(json.dumps(result, indent=2))
