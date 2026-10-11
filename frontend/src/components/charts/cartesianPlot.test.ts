import { describe, expect, it } from 'vitest';
import type uPlot from 'uplot';
import { cartesianPlot, type PositionedSeries } from './cartesianPlot';

const entries: PositionedSeries[] = [
  { series: { id: 'a', label: 'A', values: [2, -3, null] }, slot: 0 },
  { series: { id: 'b', label: 'B', values: [5, -4, 7] }, slot: 1 },
];
const defaults: Parameters<typeof cartesianPlot>[0] = {
  timestamps: [1000, 1060, 1120],
  entries,
  colors: ['#2563eb', '#f97316'],
  hidden: new Set(),
  highlighted: null,
  kind: 'line',
  fill: false,
  smooth: false,
  stacked: false,
  horizontal: false,
  showXAxis: true,
  paddedBounds: false,
  references: [],
  yAxisSize: 64,
  formatValue: String,
  font: '11px sans-serif',
  grid: '#eee',
  muted: '#777',
  surface: '#fff',
};

function range(scale: uPlot.Scale, min: number, max: number) {
  return (scale.range as uPlot.Range.Function)({} as uPlot, min, max, 'y');
}

describe('Cartesian plot options', () => {
  it('retains the default time axis, straight lines, widths and cursor markers', () => {
    const { data, options } = cartesianPlot(defaults);
    expect(data).toEqual([defaults.timestamps, ...entries.map(({ series }) => series.values)]);
    expect(options.scales).toEqual({ x: { range: undefined } });
    expect(options.series[1]).toEqual({
      label: 'A',
      stroke: '#2563eb',
      width: 1.5,
      show: true,
      spanGaps: false,
      points: { show: false },
    });
    expect(options.axes![1].size).toBe(64);
    expect(options.cursor!.focus).toEqual({ prox: 16 });
    expect(options.cursor!.points!.size).toBe(8);
    expect(options.cursor!.points!.show).toBeUndefined();
    expect(options.axes![0].show).toBeUndefined();
    expect(cartesianPlot({ ...defaults, xMin: 900, xMax: 1200 }).options.scales!.x.range).toEqual([
      900, 1200,
    ]);
  });

  it('fills independent area series with ten percent colour and a one pixel stroke', () => {
    const { data, options } = cartesianPlot({
      ...defaults,
      fill: true,
      smooth: true,
      stacked: true,
    });
    expect(data[1]).toEqual([2, -3, null]);
    expect(data[2]).toEqual([5, -4, 7]);
    expect(options.series[1].fill).toBe('rgba(37, 99, 235, 0.1)');
    expect(options.series[1].width).toBe(1);
    expect(options.series[1].fillTo).toBe(0);
    expect(options.series[1].paths).toBeTypeOf('function');
  });

  it('uses category bounds and hides the category axis when requested', () => {
    const { options } = cartesianPlot({
      ...defaults,
      timestamps: [0, 1, 2],
      categories: ['one', 'two', 'three'],
      kind: 'bar',
      showXAxis: false,
    });
    expect(options.scales!.x.time).toBe(false);
    expect(options.scales!.x.range).toEqual([-0.5, 2.5]);
    expect(options.axes![0].show).toBe(false);
    expect(options.axes![0].rotate).toBe(0);
    expect(options.cursor!.points!.show).toBe(false);
    expect(options.series[1].width).toBe(0);
    expect(options.series[1].fill).toBe('#2563eb');
    expect(options.series[1].paths).toBeTypeOf('function');
  });

  it('puts the first horizontal category at the top and values along the bottom', () => {
    const { options } = cartesianPlot({
      ...defaults,
      kind: 'bar',
      horizontal: true,
      categories: ['one', 'two', 'three'],
      xAxisTitle: 'Service',
    });
    expect(options.scales!.x).toMatchObject({ ori: 1, dir: -1, time: false });
    expect(options.scales!.y).toMatchObject({ ori: 0, dir: 1 });
    expect(options.axes![0]).toMatchObject({ side: 3, label: 'Service' });
    expect(options.axes![1].side).toBe(2);
    expect(options.cursor).toMatchObject({ x: false, y: true });
    expect(
      cartesianPlot({ ...defaults, horizontal: true, kind: 'bar' }).options.scales!.x.ori,
    ).toBeUndefined();
    expect(
      cartesianPlot({ ...defaults, horizontal: true, categories: ['one'] }).options.scales!.x.ori,
    ).toBeUndefined();
  });

  it('draws cumulative bars from the top down and recomputes after hiding a series', () => {
    const settings = {
      ...defaults,
      entries: [...entries].reverse(),
      colors: [...defaults.colors].reverse(),
      kind: 'bar' as const,
      stacked: true,
      paddedBounds: true,
    };
    const { data, options } = cartesianPlot(settings);
    expect(data).toEqual([defaults.timestamps, [7, -7, 7], [2, -3, null]]);
    expect(entries[1].series.values).toEqual([5, -4, 7]);
    expect(options.series[1].stroke).toBe('#f97316');
    expect(range(options.scales!.y, -7, 7)).toEqual([-7.7, 7.7]);
    const hidden = cartesianPlot({ ...settings, hidden: new Set(['a']) });
    expect(hidden.data).toEqual([defaults.timestamps, [5, -4, 7], [null, null, null]]);
    expect(hidden.options.series[2].show).toBe(false);
  });

  it('always includes zero for bars and includes reference values in padded bounds', () => {
    const bars = cartesianPlot({ ...defaults, kind: 'bar' });
    const [min, max] = range(bars.options.scales!.y, -10, -5);
    expect(min).toBeLessThan(-10);
    expect(max).toBeGreaterThanOrEqual(0);
    const padded = cartesianPlot({ ...defaults, paddedBounds: true, references: [{ value: 20 }] });
    expect(range(padded.options.scales!.y, 2, 10)).toEqual([0, 20.9]);
  });

  it('retains the existing reference-line range when all default lines are hidden', () => {
    const { options } = cartesianPlot({ ...defaults, references: [{ value: 6 }] });
    const [min, max] = range(
      options.scales!.y,
      null as unknown as number,
      null as unknown as number,
    );
    expect(min).toBe(0);
    expect(max).toBeGreaterThan(6);
  });
});
