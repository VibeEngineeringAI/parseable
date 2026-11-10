#!/usr/bin/env python3
"""Report medians from the raw, warmup-excluded Rust measurements."""
import json
from html import escape
from pathlib import Path
import statistics
import sys

rows = [json.loads(line) for line in Path(sys.argv[1]).read_text().splitlines()]
environments = [r for r in rows if r['type'] == 'environment']
assert len(environments) == 1, 'expected one environment record'
environment = environments[0]
repeats = environment['repeats']
assert 1 <= repeats <= 9, 'invalid measured round count'
all_samples = [r for r in rows if r['type'] == 'sample']
assert len(all_samples) == 6 * (repeats + 1), 'incomplete or duplicate sample records'
print('| Dataset | Codec | File bytes | Write wall / CPU ms | Full read wall / CPU ms | Project read wall / CPU ms |')
print('|---|---|---:|---:|---:|---:|')
for dataset in ('app', 'wide', 'otel'):
    for codec in ('lz4_raw', 'zstd'):
        samples = [r for r in rows if r['type'] == 'sample' and r['dataset'] == dataset
                   and r['codec'] == codec and not r['warmup']]
        assert sorted(r['round'] for r in samples) == list(range(1, repeats + 1)), 'missing or duplicate measured rounds'
        warmups = [r for r in all_samples if r['dataset'] == dataset and r['codec'] == codec and r['warmup']]
        assert len(warmups) == 1 and warmups[0]['round'] == 0, 'expected one warmup per arm'
        assert all(r['rows'] == environment['rows'] for r in samples), 'fixture row count differs'
        sizes = {r['file_bytes'] for r in samples}
        assert len(sizes) == 1, 'unexpected nondeterministic size'
        med = lambda key: statistics.median(r[key] for r in samples)
        pair = lambda prefix: f'{med(prefix + "_wall_ms"):.2f} / {med(prefix + "_cpu_ms"):.2f}'
        print(f'| {dataset} | {codec} | {sizes.pop():,} | {pair("write")} | {pair("read")} | {pair("project")} |')

if len(sys.argv) == 3:
    # Optional self-contained report; the raw JSONL remains the source of truth.
    panels = []
    for metric, label in [('file_bytes', 'Closed file bytes'), ('write_cpu_ms', 'Conversion CPU'),
                          ('read_wall_ms', 'Full read time')]:
        ratios = {}
        for dataset in ('app', 'wide', 'otel'):
            values = {}
            for codec in ('lz4_raw', 'zstd'):
                samples = [r for r in rows if r.get('dataset') == dataset and r.get('codec') == codec and not r['warmup']]
                values[codec] = statistics.median(r[metric] for r in samples)
            ratios[dataset] = values['zstd'] / values['lz4_raw'] * 100
        scale = 95 / max(100, *ratios.values())
        bars = []
        for dataset, ratio in ratios.items():
            bars.append(f'<div class="group">{dataset}<div class="track"><div class="lz4" style="width:{100 * scale:.2f}%">LZ4_RAW 100</div></div><div class="track"><div class="zstd" style="width:{ratio * scale:.2f}%">ZSTD {ratio:.1f}</div></div></div>')
        panels.append(f'<section><strong>{label}</strong>{"".join(bars)}</section>')
    Path(sys.argv[2]).write_text('''<!doctype html><meta charset="utf-8"><style>
    :root{color-scheme:light dark}
    body {font:14px var(--font-sans,system-ui);color:var(--foreground,CanvasText);margin:0}
    .panels{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:24px}
    .group{margin:16px 0}.track{height:22px;margin:4px 0;background:var(--secondary,ButtonFace);border-radius:4px}
    .track>div{height:22px;line-height:22px;box-sizing:border-box;padding-left:8px;white-space:nowrap;border-radius:4px;font-size:11px}
    .lz4{background:var(--chart-1,#4169a1);color:var(--primary-foreground,#fff)}
    .zstd{background:var(--chart-2,#267060);color:var(--primary-foreground,#fff)}
    p{color:var(--muted-foreground,GrayText);font-size:12px}
    @media(max-width:600px){.panels{grid-template-columns:1fr}}
    </style><div class="panels">''' + ''.join(panels) + '''</div>
    <p>LZ4_RAW = 100 within each fixture. Synthetic log fixtures; medians exclude warmup.
    ''' + f'Arrow Rust {escape(str(environment["arrow"]))} / Parquet Rust {escape(str(environment["parquet"]))}. '
    + 'Lower is better. Local warm-cache experiment.</p>')
