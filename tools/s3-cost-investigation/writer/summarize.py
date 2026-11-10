"""Compare independent dictionary arms; timing differences are descriptive."""
import hashlib,json,statistics,sys
from pathlib import Path
import pyarrow.ipc as ipc
import pyarrow.parquet as pq
import pyarrow.compute as pc
base=Path(sys.argv[1]); result={'arms':{},'same_inputs':{},'semantic_comparison':{}}
for arm in ('dictionary','delta'):
 records=[json.loads(line) for line in (base/f'{arm}.jsonl').read_text().splitlines()]
 result['arms'][arm]={}
 for kind in ('app','wide','otel'):
  d=base/arm; source=ipc.open_file(d/f'{kind}.arrow').read_all()
  for codec in ('lz4_raw','zstd'):
   p=d/f'{kind}-{codec}.parquet'; actual=pq.read_table(p); m=pq.ParquetFile(p).metadata
   assert actual.equals(source) and actual.schema.equals(source.schema,check_metadata=True)
   selected='event_time' if kind=='otel' else 'p_timestamp'; idx=source.schema.get_field_index(selected)
   stats=[]; offset=0; conservative_string_bounds=0
   for r in range(m.num_row_groups):
    g=m.row_group(r); group=source.slice(offset,g.num_rows)
    for c in range(g.num_columns):
     st=g.column(c).statistics; a=group.column(c)
     assert st.null_count==a.null_count
     if a.null_count<len(a):
      bounds=pc.min_max(a).as_py()
      if isinstance(bounds['min'], str):
       assert st.min <= bounds['min'] and st.max >= bounds['max']
       conservative_string_bounds += int(st.min != bounds['min'] or st.max != bounds['max'])
      else: assert st.min==bounds['min'] and st.max==bounds['max']
     stats.append((c,st.null_count,st.min,st.max))
    offset+=g.num_rows
   samples=[r for r in records if r.get('dataset')==kind and r.get('codec')==codec and not r['warmup']]
   assert len(samples)==3
   med={k:statistics.median(s[k] for s in samples) for k in ('write_cpu_ms','write_wall_ms','read_cpu_ms','read_wall_ms','project_cpu_ms')}
   key=f'{kind}/{codec}'
   result['arms'][arm][key]={'conservative_string_bound_chunks':conservative_string_bounds,'file_bytes':p.stat().st_size,'footer_bytes':m.serialized_size,'row_groups':m.num_row_groups,'rows':m.num_rows,'selected_time':selected,'selected_time_bytes':sum(m.row_group(r).column(idx).total_compressed_size for r in range(m.num_row_groups)),'selected_time_encodings':[m.row_group(r).column(idx).encodings for r in range(m.num_row_groups)],'median':med}
   if arm=='dictionary': result['semantic_comparison'][key]=stats
   else:
    assert stats==result['semantic_comparison'][key]; result['semantic_comparison'][key]='schema, values, nulls, timestamps, row-group statistics: PASS'
 for kind in ('app','wide','otel'):
  digest=hashlib.sha256((base/arm/f'{kind}.arrow').read_bytes()).hexdigest()
  if arm=='dictionary': result['same_inputs'][kind]=digest
  else: assert result['same_inputs'][kind]==digest
print(json.dumps(result,indent=2))
