import { describe, expect, it } from 'vitest';
import type { DashboardTile } from '../../lib/types';
import {
  appearanceFor,
  applyBinding,
  applyChartChoice,
  applySeriesStyle,
  bindingsFor,
  chartChoice,
  chartChoices,
  chartIssues,
  fieldList,
  gaugeRange,
  gaugeSegments,
  queryValueThemeKeys,
  queryValueThemeOf,
  rescaleSegments,
  seriesStyle,
  setSegmentCount,
  setSegmentMode,
  sparklineOf,
} from './chartPicker';
import { record } from './tiles';

const tile: DashboardTile = {
  tile_id: 'tile',
  chartType: 'bar',
  chartQuery: 'SELECT path, requests FROM logs',
  unknown: { keep: true },
  config: {
    type: 'line',
    colourScheme: 'teal',
    future: [1, 2],
    layout: {
      barOrientation: 'horizontal',
      legendPosition: 'left',
      stacked: true,
      unit: 'ms',
      precision: -1,
      futureKey: { keep: true },
    },
    axes: {
      x: { field: 'path', title: 'Path', display: false },
      y: { field: 'requests', title: 'Requests', display: true, beginAtZero: true },
      groupBy: { field: ['service'], future: true },
      future: 'keep',
    },
    advanced: { tooltip: { mode: 'index' }, future: true },
  },
};
const gauge = (layout: unknown): DashboardTile => ({
  tile_id: 'gauge',
  chartType: 'gauge',
  config: { layout },
});

describe('chart choices', () => {
  it('offers the classic picker order and Bubble', () => {
    expect(chartChoices.map(({ label }) => label)).toEqual([
      'Timeseries',
      'Line',
      'Bar',
      'Stacked bar',
      'Area',
      'Pie',
      'Donut',
      'Query value',
      'Gauge',
      'Table',
      'Bubble',
    ]);
  });
  it.each(chartChoices)('round-trips $label without rewriting unrelated keys', ({ value }) => {
    const before = structuredClone(tile);
    const edits = applyChartChoice(tile, value);
    const next = { ...tile, ...edits };
    expect(chartChoice(next)).toBe(value);
    expect(Object.keys(edits)).toEqual(['chartType', 'config']);
    expect(next).toMatchObject({
      tile_id: tile.tile_id,
      chartQuery: tile.chartQuery,
      unknown: tile.unknown,
      config: {
        colourScheme: 'teal',
        future: [1, 2],
        axes: record(tile.config).axes,
        advanced: record(tile.config).advanced,
        layout: {
          legendPosition: 'left',
          unit: 'ms',
          precision: -1,
          futureKey: { keep: true },
        },
      },
    });
    expect(tile).toEqual(before);
  });
  it('reads the stacked-bar fixture shape as a picker variant', () => {
    const stacked: DashboardTile = {
      tile_id: '01M4P9D3M0XMMP4F8P3DPMB0HV',
      chartType: 'timeseries',
      config: {
        type: 'bar',
        colourScheme: 'teal',
        layout: { stacked: true, legendPosition: 'top' },
        axes: {
          x: { field: 'time_bucket' },
          y: { field: 'requests' },
          groupBy: { field: ['service'] },
        },
      },
    };
    expect(chartChoice(stacked)).toBe('stacked-bar');
    expect(chartChoice({ ...stacked, chartType: 'bar' })).toBe('bar');
    expect(chartChoice({ ...stacked, config: { type: 'line', layout: { stacked: true } } })).toBe(
      'timeseries',
    );
    expect(chartChoice({ ...stacked, config: { type: 'bar', layout: { stacked: 'true' } } })).toBe(
      'timeseries',
    );
  });
  it('defaults a missing type and leaves invalid stored types for the preserved option', () => {
    expect(chartChoice({ tile_id: 'missing' })).toBe('timeseries');
    for (const chartType of ['future-chart', '', 'stacked-bar', null, 7])
      expect(chartChoice({ tile_id: 'unknown', chartType })).toBeUndefined();
  });
  it.each(chartChoices)('writes $value with the classic picker keys', ({ value }) => {
    const config = record(applyChartChoice(tile, value).config);
    const layout = record(config.layout);
    expect(config.type).toBe(
      value === 'stacked-bar' ? 'bar' : value === 'timeseries' ? 'line' : value,
    );
    expect(layout.stacked).toBe(value === 'stacked-bar');
    expect(layout.barOrientation).toBe(
      value === 'bar' || value === 'stacked-bar' ? 'horizontal' : undefined,
    );
  });
  it.each(['line', 'bar', 'area', 'timeseries', 'pie', '', undefined])(
    'selecting Timeseries handles config.type %s',
    (type) => {
      const source = { tile_id: 'x', chartType: 'pie', config: { type } };
      expect(record(applyChartChoice(source, 'timeseries').config).type).toBe(
        type === 'bar' || type === 'area' ? type : 'line',
      );
    },
  );
  it('enables a sparkline only when choosing Query value, keeping an existing setting on other choices', () => {
    for (const { value } of chartChoices) {
      const layout = record(record(applyChartChoice({ tile_id: 'x' }, value).config).layout);
      expect(layout.sparkline).toBe(value === 'query-value' ? true : undefined);
      const source = { tile_id: 'x', config: { layout: { sparkline: false } } };
      expect(record(record(applyChartChoice(source, value).config).layout).sparkline).toBe(
        value === 'query-value',
      );
    }
  });
  it.each(['emerald', 'future-theme'])(
    'keeps the stored theme %s and sparkline through Query value round trips',
    (queryValueTheme) => {
      const config = record(tile.config);
      const source = {
        ...tile,
        config: {
          ...config,
          layout: { ...record(config.layout), queryValueTheme, sparkline: false },
        },
      };
      const before = structuredClone(source);
      const selected = { ...source, ...applyChartChoice(source, 'query-value') };
      expect(record(record(selected.config).layout)).toMatchObject({
        queryValueTheme,
        sparkline: true,
      });
      for (const { value } of chartChoices.filter(({ value }) => value !== 'query-value')) {
        const switched = { ...selected, ...applyChartChoice(selected, value) };
        expect(record(record(switched.config).layout)).toMatchObject({
          queryValueTheme,
          sparkline: true,
        });
        const restored = { ...switched, ...applyChartChoice(switched, 'query-value') };
        expect(record(record(restored.config).layout)).toMatchObject({
          queryValueTheme,
          sparkline: true,
        });
      }
      expect(source).toEqual(before);
    },
  );
  it('creates only the config keys needed for a pick', () => {
    expect(applyChartChoice({ tile_id: 'x' }, 'pie')).toEqual({
      chartType: 'pie',
      config: { type: 'pie', layout: { stacked: false } },
    });
    expect(applyChartChoice({ tile_id: 'x' }, 'stacked-bar')).toEqual({
      chartType: 'timeseries',
      config: { type: 'bar', layout: { stacked: true } },
    });
  });
  it.each(['line', 'bar', 'area'] as const)(
    'changing series style to %s clears bar variants and preserves siblings',
    (style) => {
      const next = { ...tile, ...applySeriesStyle(tile, style) };
      const config = record(next.config),
        layout = record(config.layout);
      expect(seriesStyle(next)).toBe(style);
      expect(layout).not.toHaveProperty('stacked');
      expect(layout).not.toHaveProperty('barOrientation');
      expect(layout).toMatchObject({ futureKey: { keep: true }, precision: -1, unit: 'ms' });
      expect(config.axes).toEqual(record(tile.config).axes);
      expect(config.advanced).toEqual(record(tile.config).advanced);
      expect(next.chartType).toBe('bar');
      expect(record(record(tile.config).layout).stacked).toBe(true);
      expect(applySeriesStyle({ tile_id: 'x' }, style)).toEqual({ config: { type: style } });
    },
  );
  it('reads each series style and defaults unsupported styles to Line', () => {
    for (const type of ['line', 'bar', 'area', 'timeseries', 'pie', null])
      expect(seriesStyle({ tile_id: 'x', chartType: 'timeseries', config: { type } })).toBe(
        type === 'bar' || type === 'area' ? type : 'line',
      );
  });
});

describe('appearance controls', () => {
  it.each([
    ['timeseries', true, 'basic', false, false, true, false, false, false, true, false, false],
    ['line', true, 'basic', false, false, false, false, false, false, true, false, false],
    ['bar', true, 'basic', false, true, false, false, false, false, true, false, false],
    ['stacked-bar', true, 'basic', false, true, false, false, false, false, true, false, false],
    ['area', true, 'basic', false, false, false, false, false, false, true, false, false],
    ['pie', true, 'full', true, false, false, false, false, false, false, false, false],
    ['donut', true, 'full', true, false, false, false, false, false, false, false, false],
    ['query-value', false, 'none', false, false, false, false, false, true, false, true, true],
    ['gauge', false, 'none', false, false, false, true, true, true, false, false, false],
    ['table', true, 'basic', false, false, false, false, false, false, true, false, false],
    ['bubble', true, 'basic', false, false, false, false, false, false, true, false, false],
    [undefined, false, 'none', false, false, false, false, false, false, false, false, false],
  ] as const)(
    'shows the controls for %s',
    (
      choice,
      colourScheme,
      legend,
      label,
      orientation,
      seriesStyle,
      range,
      segments,
      humanize,
      axisTitles,
      queryValueTheme,
      sparkline,
    ) => {
      expect(appearanceFor(choice)).toEqual({
        colourScheme,
        legend,
        label,
        orientation,
        seriesStyle,
        range,
        segments,
        humanize,
        axisTitles,
        queryValueTheme,
        sparkline,
      });
    },
  );
});

describe('query-value configuration', () => {
  it('offers the ten theme keys in the classic order', () => {
    expect(queryValueThemeKeys).toEqual([
      'blue',
      'brown',
      'emerald',
      'fuchsia',
      'grey',
      'orange',
      'pink',
      'purple',
      'red',
      'yellow',
    ]);
  });
  it.each(queryValueThemeKeys)('reads the stored %s theme key', (queryValueTheme) => {
    expect(queryValueThemeOf({ queryValueTheme })).toBe(queryValueTheme);
  });
  it('defaults missing and unknown themes to Blue without rewriting stored values', () => {
    for (const layout of [
      undefined,
      null,
      {},
      { queryValueTheme: 'future-theme' },
      { queryValueTheme: '#3563E9' },
      { queryValueTheme: 'Blue' },
      { queryValueTheme: '' },
      { queryValueTheme: null },
      { queryValueTheme: 1 },
    ]) {
      const before = structuredClone(layout);
      expect(queryValueThemeOf(layout)).toBe('blue');
      expect(layout).toEqual(before);
    }
  });
  it('enables the spark chart only for a stored boolean true', () => {
    expect(sparklineOf({ sparkline: true })).toBe(true);
    for (const sparkline of [false, undefined, null, 'true', 'enabled', 1, [], {}])
      expect(sparklineOf({ sparkline })).toBe(false);
    expect(sparklineOf({})).toBe(false);
    expect(sparklineOf(undefined)).toBe(false);
    expect(sparklineOf(null)).toBe(false);
  });
});

describe('data bindings', () => {
  it.each(['timeseries', 'line', 'area', 'bar'] as const)(
    'offers X, multiple Y fields and groups for %s',
    (choice) => {
      expect(bindingsFor(choice)).toEqual({
        x: 'single',
        y: 'multi',
        groupBy: true,
        size: false,
        xLabel: 'X axis (time or category)',
        yLabel: 'Y axis',
      });
    },
  );
  it.each(['pie', 'donut'] as const)('binds %s categories to a single Y column', (choice) => {
    expect(bindingsFor(choice)).toEqual({
      x: false,
      y: 'single',
      groupBy: false,
      size: false,
      xLabel: 'X axis',
      yLabel: 'Category column',
      yHint:
        'Pie and donut charts take the slice labels from this column; the slice size is the first other column returned by the query.',
    });
  });
  it('offers only an explicit value field for scalar charts', () => {
    expect(bindingsFor('gauge')).toEqual({
      x: false,
      y: 'single',
      groupBy: false,
      size: false,
      xLabel: 'X axis',
      yLabel: 'Value column',
      yHint: 'The first row of this column is shown.',
    });
    expect(bindingsFor('query-value')).toEqual({
      x: false,
      y: 'single',
      groupBy: false,
      size: false,
      xLabel: 'X axis',
      yLabel: 'Value column (optional)',
      yHint: 'Defaults to the first numeric column of the last row.',
    });
  });
  it('offers single X/Y fields, size and a series split for Bubble', () => {
    expect(bindingsFor('bubble')).toEqual({
      x: 'single',
      y: 'single',
      groupBy: true,
      groupByMax: 1,
      size: true,
      xLabel: 'X axis',
      yLabel: 'Y axis',
    });
  });
  it('limits stacked bars to one Y column and retains invalid fields for explicit correction', () => {
    expect(bindingsFor('stacked-bar')).toMatchObject({ y: 'multi', yMax: 1, groupBy: true });
    const source = { ...tile, ...applyBinding(tile, 'y', ['requests', 'errors']) };
    const stacked = { ...source, ...applyChartChoice(source, 'stacked-bar') };
    expect(record(record(stacked.config).axes).y).toMatchObject({ field: ['requests', 'errors'] });
    expect(chartIssues(stacked)).toEqual([
      'Stacked bar supports one Y column. Remove extra Y fields and use Group by for series.',
    ]);
    expect(chartIssues({ ...stacked, ...applyBinding(stacked, 'y', ['requests']) })).toEqual([]);
    expect(chartIssues({ ...stacked, tileType: 'promql' })).toEqual([]);
  });
  it('requires correction of extra bubble groups without dropping stored fields', () => {
    const source = { ...tile, ...applyBinding(tile, 'groupBy', ['service', 'region']) };
    const bubble = { ...source, ...applyChartChoice(source, 'bubble') };
    expect(record(record(bubble.config).axes).groupBy).toMatchObject({
      field: ['service', 'region'],
    });
    expect(chartIssues(bubble)).toEqual([
      'Bubble supports one Group by column. Remove extra grouping fields.',
    ]);
    expect(chartIssues({ ...bubble, ...applyBinding(bubble, 'groupBy', ['service']) })).toEqual([]);
  });
  it.each(['table', undefined] as const)('hides bindings for %s', (choice) => {
    expect(bindingsFor(choice)).toEqual({
      x: false,
      y: false,
      groupBy: false,
      size: false,
      xLabel: 'X axis',
      yLabel: 'Y axis',
    });
  });
  it('reads strings and arrays without changing their field names', () => {
    expect(fieldList('requests')).toEqual(['requests']);
    expect(fieldList('')).toEqual([]);
    expect(fieldList(['requests', 'errors'])).toEqual(['requests', 'errors']);
    expect(fieldList(['requests', 4, null])).toEqual(['requests']);
    for (const value of [undefined, null, {}, 4]) expect(fieldList(value)).toEqual([]);
  });
  it.each([
    ['requests', 'requests'],
    [[], ''],
    [['errors'], 'errors'],
    [
      ['requests', 'errors'],
      ['requests', 'errors'],
    ],
  ] as [string | string[], string | string[]][])(
    'stores the classic Y field shape for %j',
    (value, expected) => {
      const before = structuredClone(tile);
      const config = record(applyBinding(tile, 'y', value).config),
        axes = record(config.axes);
      expect(axes.y).toEqual({
        field: expected,
        title: 'Requests',
        display: true,
        beginAtZero: true,
      });
      expect(axes.x).toEqual(record(record(tile.config).axes).x);
      expect(axes.groupBy).toEqual(record(record(tile.config).axes).groupBy);
      expect(axes.future).toBe('keep');
      expect(config.layout).toEqual(record(tile.config).layout);
      expect(config.advanced).toEqual(record(tile.config).advanced);
      expect(tile).toEqual(before);
    },
  );
  it('stores groupBy as an array capped at two fields, keeping sibling keys', () => {
    expect(record(record(applyBinding(tile, 'groupBy', 'host').config).axes).groupBy).toEqual({
      field: ['host'],
      future: true,
    });
    expect(
      record(record(applyBinding(tile, 'groupBy', ['service', 'host', 'zone']).config).axes)
        .groupBy,
    ).toEqual({ field: ['service', 'host'], future: true });
    expect(record(record(applyBinding(tile, 'groupBy', []).config).axes).groupBy).toEqual({
      field: [],
      future: true,
    });
  });
  it('stores X and size as strings without creating a layout or other axes', () => {
    expect(record(record(applyBinding(tile, 'x', ['route', 'ignored']).config).axes).x).toEqual({
      field: 'route',
      title: 'Path',
      display: false,
    });
    expect(applyBinding({ tile_id: 'x' }, 'size', 'count')).toEqual({
      config: { axes: { size: { field: 'count' } } },
    });
    expect(applyBinding({ tile_id: 'x' }, 'x', [])).toEqual({
      config: { axes: { x: { field: '' } } },
    });
  });
});

describe('gauge configuration', () => {
  it('reads finite numeric ranges and uses renderer defaults for anything else', () => {
    expect(gaugeRange({ rangeFrom: -20, rangeTo: 0 })).toEqual({ from: -20, to: 0 });
    expect(gaugeRange({ rangeFrom: '10', rangeTo: Infinity })).toEqual({ from: 0, to: 100 });
    expect(gaugeRange({ rangeFrom: NaN, rangeTo: null })).toEqual({ from: 0, to: 100 });
    expect(gaugeRange(undefined)).toEqual({ from: 0, to: 100 });
  });
  it('distinguishes missing segments from explicit empty and invalid segment objects', () => {
    expect(gaugeSegments({ rangeFrom: 10, rangeTo: 200 })).toEqual({
      value: [10, 200],
      isPercent: false,
    });
    expect(gaugeSegments({})).toEqual({ value: [0, 100], isPercent: false });
    expect(gaugeSegments({ segments: { value: [], isPercent: true } })).toEqual({
      value: [],
      isPercent: true,
    });
    expect(gaugeSegments({ segments: { value: [30, 80] } })).toEqual({
      value: [30, 80],
      isPercent: false,
    });
    expect(gaugeSegments({ segments: { value: [10, 50, 90], isPercent: true } })).toEqual({
      value: [10, 50],
      isPercent: true,
    });
    expect(gaugeSegments({ segments: { value: [10, '90'] } })).toEqual({
      value: [],
      isPercent: false,
    });
    expect(gaugeSegments({ segments: null })).toEqual({ value: [], isPercent: false });
    expect(gaugeSegments({ segments: { value: [NaN, Infinity] } }).value).toEqual([NaN, Infinity]);
  });
  it('adds midpoint thresholds using the active range and keeps leading thresholds when shrinking', () => {
    const percent = { rangeFrom: 100, rangeTo: 300, segments: { value: [], isPercent: true } };
    const absolute = { rangeFrom: -10, rangeTo: 91, segments: { value: [], isPercent: false } };
    expect(setSegmentCount(percent, 0)).toEqual({ value: [], isPercent: true });
    expect(setSegmentCount(percent, 1)).toEqual({ value: [50], isPercent: true });
    expect(setSegmentCount(percent, 2)).toEqual({ value: [50, 75], isPercent: true });
    expect(setSegmentCount(absolute, 2)).toEqual({ value: [40, 65], isPercent: false });
    const custom = { ...absolute, segments: { value: [20], isPercent: false } };
    expect(setSegmentCount(custom, 2)).toEqual({ value: [20, 55], isPercent: false });
    const full = { segments: { value: [30, 80], isPercent: true } };
    expect(setSegmentCount(full, 1)).toEqual({ value: [30], isPercent: true });
    expect(setSegmentCount(full, 0)).toEqual({ value: [], isPercent: true });
    expect(full.segments.value).toEqual([30, 80]);
  });
  it('converts thresholds proportionally in both directions and rounds to two decimals', () => {
    const layout = { rangeFrom: -20, rangeTo: 180, segments: { value: [30, 80], isPercent: true } };
    expect(setSegmentMode(layout, false)).toEqual({ value: [40, 140], isPercent: false });
    expect(
      setSegmentMode({ ...layout, segments: { value: [40, 140], isPercent: false } }, true),
    ).toEqual(layout.segments);
    expect(setSegmentMode(layout, true)).toEqual(layout.segments);
    expect(setSegmentMode({ rangeTo: 3, segments: { value: [1, 2] } }, true)).toEqual({
      value: [33.33, 66.67],
      isPercent: true,
    });
    expect(
      setSegmentMode({ rangeTo: 3, segments: { value: [33.33], isPercent: true } }, false),
    ).toEqual({ value: [1], isPercent: false });
    expect(layout.segments.value).toEqual([30, 80]);
  });
  it('rescales only absolute thresholds and tolerates a previously collapsed range', () => {
    const segments = { value: [10, 90], isPercent: false };
    expect(rescaleSegments({ from: 0, to: 100 }, { from: 100, to: 300 }, segments)).toEqual({
      value: [120, 280],
      isPercent: false,
    });
    expect(
      rescaleSegments(
        { from: 0, to: 3 },
        { from: 0, to: 100 },
        { value: [1, 2], isPercent: false },
      ),
    ).toEqual({ value: [33.33, 66.67], isPercent: false });
    expect(rescaleSegments({ from: 0, to: 0 }, { from: 0, to: 100 }, segments)).toEqual(segments);
    const percent = { value: [10, 90], isPercent: true };
    expect(rescaleSegments({ from: 0, to: 100 }, { from: -20, to: 40 }, percent)).toBe(percent);
    expect(segments.value).toEqual([10, 90]);
  });
  it('validates range ordering including equal bounds', () => {
    expect(chartIssues(gauge({ rangeFrom: 100, rangeTo: 100, segments: { value: [] } }))).toEqual([
      'Range from must be below Range to.',
    ]);
    expect(chartIssues(gauge({ rangeFrom: 100, rangeTo: 0, segments: { value: [] } }))).toEqual([
      'Range from must be below Range to.',
    ]);
  });
  it.each([[30, 30], [80, 30], [NaN], [-Infinity], [Infinity]].map((value) => ({ value })))(
    'rejects non-finite or unordered thresholds $value',
    ({ value }) => {
      expect(chartIssues(gauge({ segments: { value, isPercent: true } }))).toContain(
        'Segment thresholds must increase.',
      );
    },
  );
  it('checks percent and absolute thresholds against their bounds', () => {
    expect(chartIssues(gauge({ segments: { value: [-1, 101], isPercent: true } }))).toEqual([
      'Percent thresholds must be between 0 and 100.',
    ]);
    expect(
      chartIssues(gauge({ rangeFrom: 20, rangeTo: 200, segments: { value: [10, 210] } })),
    ).toEqual(['Absolute thresholds must be within the range.']);
    expect(
      chartIssues(
        gauge({ rangeFrom: 20, rangeTo: 200, segments: { value: [0, 100], isPercent: true } }),
      ),
    ).toEqual([]);
    expect(
      chartIssues(gauge({ rangeFrom: 20, rangeTo: 200, segments: { value: [20, 200] } })),
    ).toEqual([]);
  });
  it('accepts the gauge fixture thresholds, empty thresholds and renderer fallback segments', () => {
    expect(
      chartIssues(
        gauge({
          rangeTo: 100,
          segments: { value: [30, 80], isPercent: true },
          precision: 1,
          unit: '%',
        }),
      ),
    ).toEqual([]);
    expect(chartIssues(gauge({ segments: { value: [] } }))).toEqual([]);
    expect(chartIssues(gauge({}))).toEqual([]);
  });
  it.each(chartChoices.filter(({ value }) => value !== 'gauge'))(
    'does not validate hidden gauge settings on $label',
    ({ value }) => {
      expect(
        chartIssues({
          ...gauge({ rangeFrom: 200, rangeTo: 0, segments: { value: [80, 30], isPercent: true } }),
          chartType: value,
        }),
      ).toEqual([]);
    },
  );
});
