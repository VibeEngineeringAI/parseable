#!/usr/bin/env python3
"""Report medians from the raw, warmup-excluded Rust measurements."""
import json
from pathlib import Path
import statistics
import sys

rows = [json.loads(line) for line in Path(sys.argv[1]).read_text().splitlines()]
print('| Dataset | Codec | File bytes | Write wall / CPU ms | Full read wall / CPU ms | Project read wall / CPU ms |')
print('|---|---|---:|---:|---:|---:|')
for dataset in ('app', 'wide', 'otel'):
    for codec in ('lz4_raw', 'zstd'):
        samples = [r for r in rows if r['type'] == 'sample' and r['dataset'] == dataset
                   and r['codec'] == codec and not r['warmup']]
        assert samples
        sizes = {r['file_bytes'] for r in samples}
        assert len(sizes) == 1, 'unexpected nondeterministic size'
        med = lambda key: statistics.median(r[key] for r in samples)
        pair = lambda prefix: f'{med(prefix + "_wall_ms"):.2f} / {med(prefix + "_cpu_ms"):.2f}'
        print(f'| {dataset} | {codec} | {sizes.pop():,} | {pair("write")} | {pair("read")} | {pair("project")} |')

if len(sys.argv) == 3:
    # Optional self-contained report; the raw JSONL remains the source of truth.
    panels = []
    for metric, label in [('file_bytes', 'Closed file bytes'), ('write_cpu_ms', 'Conversion CPU')]:
        bars = []
        for dataset in ('app', 'wide', 'otel'):
            values = {}
            for codec in ('lz4_raw', 'zstd'):
                samples = [r for r in rows if r.get('dataset') == dataset and r.get('codec') == codec and not r['warmup']]
                values[codec] = statistics.median(r[metric] for r in samples)
            ratio = values['zstd'] / values['lz4_raw'] * 100
            bars.append(f'<div class="group">{dataset}<div class="track"><div class="lz4" style="width:80%">LZ4_RAW 100</div></div><div class="track"><div class="zstd" style="width:{ratio * .8:.2f}%">ZSTD {ratio:.1f}</div></div></div>')
        panels.append(f'<section><strong>{label}</strong>{"".join(bars)}</section>')
    Path(sys.argv[2]).write_text('''<!doctype html><meta charset="utf-8"><style>
    body {font:14px var(--font-sans,system-ui);color:var(--foreground,#ddd);margin:0}
    .panels{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px}
    .group{margin:16px 0}.track{height:22px;margin:4px 0;background:var(--secondary,#333);border-radius:4px}
    .track>div{height:22px;line-height:22px;box-sizing:border-box;padding-left:8px;white-space:nowrap;border-radius:4px}
    .lz4{background:var(--chart-1,#4169a1);color:var(--primary-foreground,#fff)}
    .zstd{background:var(--chart-2,#267060);color:var(--primary-foreground,#fff)}
    p{color:var(--muted-foreground,#aaa);font-size:12px}
    @media(max-width:450px){.panels{grid-template-columns:1fr}}
    </style><div class="panels">''' + ''.join(panels) + '''</div>
    <p>LZ4_RAW = 100 within each fixture. 270,000 synthetic rows; five-round medians.
    Arrow/Parquet Rust 59.2.0. Lower is better. Local warm-cache experiment.</p>''')
