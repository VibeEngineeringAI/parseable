"""Prepare isolated PR137-derived probe; invoke with new scratch directory."""
from pathlib import Path
import hashlib,shutil,sys
root=Path(__file__).resolve().parents[3]
out=Path(sys.argv[1]); out.mkdir(exist_ok=False)
base=root/'tools/compression-bench'
expected = {'src/main.rs': '63be76562c94fcef655206c8f1de30e668576767448c4d738e5a7df59b2a192b', 'Cargo.toml': '7981a96ea23b276bf5bae7f4d64b0467a8430c0369511c3b113b800d8c3b9e7c'}
for name, digest in expected.items():
    if hashlib.sha256((base/name).read_bytes()).hexdigest() != digest:
        raise SystemExit(f'PR137 source changed: {name}; re-audit probe replacements')
shutil.copytree(base,out/'harness')
h=out/'harness'; p=h/'Cargo.toml'
s=p.read_text().replace('libc = "0.2"','libc = "0.2"\ntikv-jemallocator = { version = "=0.7.0", features = ["profiling", "stats", "background_threads"] }\ntikv-jemalloc-ctl = { version = "=0.7.0", features = ["stats"] }')
s+='\n[profile.release-lto]\ninherits = "release"\nlto = "fat"\ncodegen-units = 1\n'
p.write_text(s)
shutil.copyfile(Path(__file__).with_name('probe.Cargo.lock'), h/'Cargo.lock')
p=h/'src/main.rs'; s=p.read_text()
s=s.replace('type Result<T>', '#[global_allocator]\nstatic GLOBAL: tikv_jemallocator::Jemalloc = tikv_jemallocator::Jemalloc;\n\n// SplitMix64, deterministic reproducibility, not cryptographic security.\nfn random_word(mut x: u64) -> u64 {\n x = x.wrapping_add(0x9e3779b97f4a7c15);\n x = (x ^ (x >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);\n x = (x ^ (x >> 27)).wrapping_mul(0x94d049bb133111eb);\n x ^ (x >> 31)\n}\nfn noise(i: usize, count: usize) -> String {\n (0..count).map(|k| format!("{:016x}", random_word((i as u64).wrapping_mul(1009).wrapping_add(k as u64)))).collect()\n}\nfn selected(schema: &Schema) -> (&\'static str, usize) {\n if let Ok(i) = schema.index_of("event_time") { ("event_time", i) } else { ("p_timestamp", 0) }\n}\nfn delta() -> bool { std::env::var_os("PROBE_DELTA").is_some() }\ntype Result<T>')
a=s.index('    // Descending timestamps'); b=s.index('    col!(\n        "severity"',a)
s=s[:a]+'''    // Non-null batch ingestion times, monotone within this sorted fixture.
    let cycle = [1usize, 32, 256, 8192];
    let mut times = Vec::with_capacity(n);
    let mut batch = 0;
    while times.len() < n {
        let size = if kind == "wide" {8192} else {cycle[batch % cycle.len()]};
        let count = size.min(n-times.len());
        times.extend(std::iter::repeat_n(Some(1_770_000_000_000i64 - batch as i64), count));
        batch += 1;
    }
    col!("p_timestamp", DataType::Timestamp(TimeUnit::Millisecond, None), TimestampMillisecondArray::from(times));
'''+s[b:]
s=s.replace('Some(format!(\n                        "request {} route /api/{} completed ✓",\n                        i % 1009,\n                        i % 23\n                    ))','Some(format!("request route /api/{} completed ✓ payload={}", i % 23, noise(i, if i % 10 == 0 {128} else {8})))')
s=s.replace('(i as u64).wrapping_mul(0x9e3779b97f4a7c15)','random_word(i as u64)')
s=s.replace('Some(format!("{name}-{:016x}", (i % modulo) as u64))','Some(if name == "trace_id" { noise(i + 300000, 2) } else if name == "span_id" { noise(i + 600000, 1) } else { format!("{name}-{:016x}", (i % modulo) as u64) })')
a=s.index('    RecordBatch::try_new')
s=s[:a]+'''    if kind == "otel" {
      col!("event_time", DataType::Timestamp(TimeUnit::Millisecond, None), TimestampMillisecondArray::from((0..n).map(|i| Some(1_770_000_000_000i64 - i as i64 - (i / 97) as i64)).collect::<Vec<_>>()));
    }
'''+s[a:]
s=s.replace('    let props = WriterProperties::builder()', '    let (time_name, time_idx) = selected(&input.schema());\n    let props = WriterProperties::builder()')
s=s.replace('ColumnPath::new(vec!["p_timestamp".into()]),','ColumnPath::new(vec![time_name.into()]),')
s=s.replace('        .set_sorting_columns(Some(vec![SortingColumn {\n            column_idx: 0,','        .set_column_dictionary_enabled(ColumnPath::new(vec![time_name.into()]), !delta())\n        .set_sorting_columns(Some(vec![SortingColumn {\n            column_idx: time_idx as i32,')
s=s.replace('ColumnPath::new(vec!["p_timestamp".into()]);','ColumnPath::new(vec![time_name.into()]);')
s=s.replace('assert!(props.dictionary_enabled(&time_column));','assert_eq!(props.dictionary_enabled(&time_column), !delta());')
s=s.replace('column_idx: 0,','column_idx: selected(&expected.schema()).1 as i32,')
s=s.replace('let time_column = group.column(0);','let time_column = group.column(selected(&expected.schema()).1);')
s=s.replace('.any(|e| e == Encoding::RLE_DICTIONARY),','.any(|e| e == if delta() {Encoding::DELTA_BINARY_PACKED} else {Encoding::RLE_DICTIONARY}),')
s=s.replace('        for offset in (0..rows).step_by(8192) {\n            writer.write(&batch.slice(offset, (rows - offset).min(8192)))?;\n        }','        let mut offset = 0;\n        let mut ingestion_batch = 0;\n        while offset < rows {\n            let requested = if kind == "wide" {8192} else {[1usize,32,256,8192][ingestion_batch % 4]};\n            let count = (rows - offset).min(requested);\n            writer.write(&batch.slice(offset, count))?;\n            offset += count;\n            ingestion_batch += 1;\n        }')
p.write_text(s)
print(h)
