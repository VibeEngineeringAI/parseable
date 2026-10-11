import { describe, expect, it } from 'vitest';
import type { QueryResult } from '../../lib/promqlResults';
import type { DashboardTile } from '../../lib/types';
import areaConfigTypeLine from './__fixtures__/cartesian/area-config-type-line.json';
import barGrouped from './__fixtures__/cartesian/bar-grouped.json';
import horizontalBar from './__fixtures__/cartesian/horizontal-bar.json';
import promqlBar from './__fixtures__/cartesian/promql-bar.json';
import stackedBar from './__fixtures__/cartesian/stacked-bar.json';
import ingestDemoTile from './__fixtures__/ingest-demo-tile.json';
import { cartesianChart, cartesianStyle, promqlCategoryChart } from './cartesian';
import { sqlChart } from './tiles';

const categoryTile = (y: unknown = 'value', groupBy: unknown = []): DashboardTile => ({
  tile_id: 'category',
  chartType: 'bar',
  config: {
    axes: { x: { field: 'category' }, y: { field: y }, groupBy: { field: groupBy } },
  },
});
const queryResult = (id: string, data: Partial<QueryResult> = {}): QueryResult => ({
  id,
  pending: 0,
  errors: [],
  ...data,
});
const t0 = '2026-10-10T10:00:00.000Z',
  t1 = '2026-10-10T10:01:00.000Z';
const times = [Date.parse(t0) / 1000, Date.parse(t1) / 1000];

describe('cartesianStyle', () => {
  it.each([
    ['area config.type line', areaConfigTypeLine, 'line', true, true, false, false],
    ['stacked time bars', stackedBar, 'bar', false, false, true, false],
    ['horizontal bars', horizontalBar, 'bar', false, false, false, true],
    ['grouped bars', barGrouped, 'bar', false, false, false, false],
    ['PromQL bars', promqlBar, 'bar', false, false, false, false],
  ] as const)(
    'reads the %s fixture without rewriting it',
    (_, tile, kind, fill, smooth, stacked, horizontal) => {
      const before = structuredClone(tile);
      expect(cartesianStyle(tile)).toEqual({ kind, fill, smooth, stacked, horizontal });
      expect(tile).toEqual(before);
    },
  );

  it.each([
    ['timeseries', 'line', 'value', 'line', false, false],
    ['timeseries', 'area', 'value', 'line', true, false],
    ['timeseries', 'bar', ['value'], 'bar', false, false],
    ['timeseries', 'bar', ['value', 'other'], 'line', false, false],
    ['timeseries', 'timeseries', 'value', 'line', false, false],
    ['line', 'line', 'value', 'line', false, true],
    ['line', 'area', 'value', 'line', true, true],
    ['line', 'bar', 'value', 'line', false, true],
    ['area', 'line', 'value', 'line', true, true],
    ['area', 'area', 'value', 'line', true, true],
    ['area', 'bar', 'value', 'line', true, true],
    ['bar', 'line', ['value', 'other'], 'bar', false, false],
    ['bar', 'area', 'value', 'bar', false, false],
  ] as const)(
    'dispatches %s with config.type %s and y %j',
    (chartType, type, field, kind, fill, smooth) => {
      expect(
        cartesianStyle({
          tile_id: 'style',
          chartType,
          config: {
            type,
            axes: { y: { field } },
            layout: { stacked: true, barOrientation: 'horizontal' },
          },
        }),
      ).toEqual({ kind, fill, smooth, stacked: kind === 'bar', horizontal: kind === 'bar' });
    },
  );

  it('requires a boolean true to stack bars', () => {
    expect(
      cartesianStyle({
        tile_id: 'style',
        chartType: 'bar',
        config: { layout: { stacked: 'true', barOrientation: 'vertical' } },
      }),
    ).toEqual({ kind: 'bar', fill: false, smooth: false, stacked: false, horizontal: false });
  });
});

describe('cartesianChart categories', () => {
  it('keeps server order and duplicate categories, converts y values and drops null x', () => {
    const rows = [
      { category: 'beta', value: '2.5' },
      { category: 'alpha', value: null },
      { category: 'beta', value: '' },
      { category: 2, value: '  ' },
      { category: '', value: false },
      { category: 'missing' },
      { category: 'invalid', value: 'oops' },
      { category: 'infinite', value: Infinity },
      { category: null, value: 100 },
      { value: 200 },
    ];
    const before = structuredClone(rows);
    expect(cartesianChart(rows, categoryTile())).toEqual({
      categorical: false,
      categories: ['beta', 'alpha', 'beta', '2', '', 'missing', 'invalid', 'infinite'],
      timestamps: [0, 1, 2, 3, 4, 5, 6, 7],
      series: [{ id: 'value', label: 'value', values: [2.5, 0, 0, 0, 0, null, null, null] }],
    });
    expect(rows).toEqual(before);
  });

  it('keeps multiple ungrouped y fields in configured order', () => {
    expect(
      cartesianChart(
        [
          { category: 'b', first: 1, second: '2' },
          { category: 'a', first: null },
        ],
        categoryTile(['second', 'first']),
      ),
    ).toEqual({
      categorical: false,
      categories: ['b', 'a'],
      timestamps: [0, 1],
      series: [
        { id: 'second', label: 'second', values: [2, null] },
        { id: 'first', label: 'first', values: [1, 0] },
      ],
    });
  });

  it('charts the horizontal bar fixture categories', () => {
    expect(
      cartesianChart(
        [
          { level: 'WARN', events: 3 },
          { level: 'INFO', events: 10 },
        ],
        horizontalBar,
      ),
    ).toEqual({
      categorical: false,
      categories: ['WARN', 'INFO'],
      timestamps: [0, 1],
      series: [{ id: 'events', label: 'events', values: [3, 10] }],
    });
  });

  it('pivots the grouped fixture, sums duplicates, sorts strings and fills absent cells', () => {
    const chart = cartesianChart(
      [
        { level: '2', service: ' api ', events: 2 },
        { level: '10', service: 'db', events: 4 },
        { level: '2', service: 'api', events: '3' },
        { level: '1', service: ' ', events: 100 },
        { level: '9', service: null, events: 100 },
        { level: 'ignored', events: 100 },
      ],
      barGrouped,
    );
    expect(chart.categorical).toBe(false);
    expect(chart.categories).toEqual(['10', '2']);
    expect(chart.timestamps).toEqual([0, 1]);
    expect(chart.series.map(({ label, values }) => ({ label, values }))).toEqual([
      { label: 'api', values: [0, 5] },
      { label: 'db', values: [4, 0] },
    ]);
    expect(new Set(chart.series.map(({ id }) => id)).size).toBe(2);
  });

  it('joins trimmed group columns, falls back for null x and names each y field', () => {
    const chart = cartesianChart(
      [
        { category: null, service: ' api ', region: ' us ', requests: '3', errors: null },
        { category: '2', service: 'api', region: 'eu', requests: 4, errors: '' },
        { category: '10', service: 'api', region: 'us', requests: 1 },
        { category: '10', service: 'api', region: 'us', requests: 2, errors: 'bad' },
        { category: 'discard', service: null, region: ' ', requests: 100 },
      ],
      categoryTile(['requests', 'errors'], ['service', 'region']),
    );
    expect(chart.categories).toEqual(['10', '2', 'api | us']);
    expect(chart.series.map(({ label, values }) => ({ label, values }))).toEqual([
      { label: 'api | us | requests', values: [3, 0, 3] },
      { label: 'api | us | errors', values: [0, 0, 0] },
      { label: 'api | eu | requests', values: [0, 4, 0] },
      { label: 'api | eu | errors', values: [0, 0, 0] },
    ]);
    expect(new Set(chart.series.map(({ id }) => id)).size).toBe(4);
  });

  it('keeps a partial group key when a group column is missing', () => {
    expect(
      cartesianChart([{ service: 'api', value: 2 }], categoryTile('value', ['service', 'region'])),
    ).toMatchObject({
      categories: ['api | '],
      series: [{ label: 'api | ', values: [2] }],
    });
  });

  it('uses unique ids even when different group/y combinations have the same label', () => {
    const chart = cartesianChart(
      [
        { category: 'x', group: 'g', value: 1, 'a | value': 2 },
        { category: 'x', group: 'g | a', value: 3, 'a | value': 4 },
      ],
      categoryTile(['value', 'a | value'], ['group']),
    );
    expect(chart.series.map(({ label }) => label)).toEqual([
      'g | value',
      'g | a | value',
      'g | a | value',
      'g | a | a | value',
    ]);
    expect(new Set(chart.series.map(({ id }) => id)).size).toBe(4);
  });

  it.each([
    {},
    { x: { field: '' }, y: { field: 'value' } },
    { x: { field: 'category' } },
    { x: { field: 'category' }, y: { field: '' } },
    { x: { field: 'category' }, y: { field: [] } },
    { x: { field: 'category' }, y: { field: [''] } },
    { x: { field: ['category'] }, y: { field: 'value' } },
  ])('keeps the table fallback for missing or invalid fields: %j', (axes) => {
    expect(
      cartesianChart([{ category: 'a', value: 3 }], { tile_id: 'fallback', config: { axes } }),
    ).toEqual({ categorical: true, timestamps: [], series: [] });
  });

  it('keeps table tiles in the table fallback even with configured fields', () => {
    expect(
      cartesianChart([{ category: 'a', value: 3 }], {
        ...categoryTile(),
        chartType: 'table',
      }),
    ).toEqual({ categorical: true, timestamps: [], series: [] });
  });

  it.each([
    [[{ category: null, value: 3 }, { value: 4 }], categoryTile()],
    [[{ category: 'a', group: ' ', value: 3 }], categoryTile('value', ['group'])],
  ])('returns chartable empty arrays when no categorical rows survive', (rows, tile) => {
    expect(cartesianChart(rows, tile)).toEqual({
      categorical: false,
      categories: [],
      timestamps: [],
      series: [],
    });
  });

  it('keeps the existing shape for an empty SQL result', () => {
    expect(cartesianChart([], categoryTile())).toEqual({
      categorical: false,
      timestamps: [],
      series: [{ id: 'value', label: 'value', values: [] }],
    });
  });
});

describe('cartesianChart time data and sqlChart explicit groups', () => {
  it('keeps the time chart shape and ascending order for the area fixture', () => {
    const rows = [
      { time_bucket: t1, events: 2 },
      { time_bucket: t0, events: 1 },
    ];
    const chart = cartesianChart(rows, areaConfigTypeLine);
    expect(chart).toEqual(sqlChart(rows, areaConfigTypeLine));
    expect(chart).toEqual({
      categorical: false,
      timestamps: times,
      series: [{ id: 'events', label: 'events', values: [1, 2] }],
    });
    expect(chart).not.toHaveProperty('categories');
  });

  it('sums explicit time groups in the stacked fixture and ignores heuristic columns', () => {
    const rows = [
      { time_bucket: t1, service: 'api', note: 'first', events: 5 },
      { time_bucket: t0, service: 'db', note: 'second', events: 2 },
      { time_bucket: t1, service: 'api', note: 'second', events: 3 },
      { time_bucket: t0, service: 'api', note: 'first', events: 4 },
    ];
    const before = structuredClone(rows);
    const chart = sqlChart(rows, stackedBar);
    expect(cartesianChart(rows, stackedBar)).toEqual(chart);
    expect(chart.timestamps).toEqual(times);
    expect(chart.series.map(({ label, values }) => ({ label, values }))).toEqual([
      { label: 'api', values: [4, 8] },
      { label: 'db', values: [2, null] },
    ]);
    expect(chart).not.toHaveProperty('categories');
    expect(rows).toEqual(before);
  });

  it('sums every configured y field and ignores group fields absent from all rows', () => {
    const chart = sqlChart(
      [
        { time: t0, service: 'api', hits: 1, errors: 2 },
        { time: t0, service: 'api', hits: 2, errors: 3 },
        { time: t1, service: 'api', hits: 4, errors: 6 },
      ],
      {
        tile_id: 'time',
        config: {
          axes: {
            x: { field: 'time' },
            y: { field: ['hits', 'errors'] },
            groupBy: { field: ['service', 'missing'] },
          },
        },
      },
    );
    expect(chart.series).toEqual([
      { id: '["hits","api"]', label: 'hits: api', values: [3, 4] },
      { id: '["errors","api"]', label: 'errors: api', values: [5, 6] },
    ]);
  });

  it('honours explicit groups even when timestamps are distinct and cardinality exceeds 20', () => {
    const rows = Array.from({ length: 22 }, (_, index) => ({
      time: new Date(Date.parse(t0) + index * 60_000).toISOString(),
      service: `service-${index}`,
      value: index,
    }));
    const chart = sqlChart(rows, {
      tile_id: 'time',
      config: { axes: { groupBy: { field: ['service'] } } },
    });
    expect(chart.series.map(({ label }) => label)).toEqual(rows.map((row) => row.service));
    expect(chart.series[1].values[1]).toBe(1);
    expect(chart.series[1].values[0]).toBeNull();
  });

  it('keeps declared builder groups ahead of config groups and preserves their duplicate behavior', () => {
    const chart = sqlChart(
      [
        { time_bucket: t0, severity_text: 'INFO', note: 'a', COUNT_severity_number: 2 },
        { time_bucket: t0, severity_text: 'INFO', note: 'b', COUNT_severity_number: 3 },
      ],
      {
        ...ingestDemoTile,
        config: {
          ...ingestDemoTile.config,
          axes: { ...ingestDemoTile.config.axes, groupBy: { field: ['note'] } },
        },
      },
    );
    expect(chart.series.map(({ label, values }) => ({ label, values }))).toEqual([
      { label: 'INFO', values: [3] },
    ]);
  });

  it('uses config groups when an object query has no declared builder groups', () => {
    const chart = sqlChart(
      [
        { time: t0, service: 'api', value: 2 },
        { time: t0, service: 'api', value: 3 },
      ],
      {
        tile_id: 'time',
        chartQuery: { query: 'SELECT time, service, value FROM logs' },
        config: { axes: { groupBy: { field: ['service'] } } },
      },
    );
    expect(chart.series.map(({ label, values }) => ({ label, values }))).toEqual([
      { label: 'api', values: [5] },
    ]);
  });
});

describe('promqlCategoryChart', () => {
  it('charts instant vector metric names in response order and skips non-finite values', () => {
    const result = queryResult('A', {
      instant: {
        resultType: 'vector',
        result: [
          { metric: { __name__: 'requests', status: '500', service: 'api' }, value: [2, '3.5'] },
          { metric: { __name__: 'requests', status: '200' }, value: [2, '0'] },
          ...['NaN', '+Inf', '-Inf', 'oops', ' '].map((value) => ({
            metric: { status: value },
            value: [2, value] as [number, string],
          })),
        ],
      },
    });
    const before = structuredClone(result);
    expect(promqlCategoryChart([result])).toEqual({
      categorical: false,
      categories: ['requests{service="api",status="500"}', 'requests{status="200"}'],
      timestamps: [0, 1],
      series: [{ id: 'value', label: 'value', values: [3.5, 0] }],
    });
    expect(result).toEqual(before);
  });

  it('prefixes categories for multiple queries and keeps duplicate metric names', () => {
    const instant = {
      resultType: 'vector' as const,
      result: [{ metric: { host: 'api' }, value: [2, '5'] as [number, string] }],
    };
    expect(
      promqlCategoryChart([queryResult('A', { instant }), queryResult('B', { instant })]),
    ).toEqual({
      categorical: false,
      categories: ['A: {host="api"}', 'B: {host="api"}'],
      timestamps: [0, 1],
      series: [{ id: 'value', label: 'value', values: [5, 5] }],
    });
  });

  it('charts a scalar instant as one scalar category', () => {
    expect(
      promqlCategoryChart([
        queryResult('A', { instant: { resultType: 'scalar', result: [2, '-1.25'] } }),
      ]),
    ).toEqual({
      categorical: false,
      categories: ['scalar'],
      timestamps: [0],
      series: [{ id: 'value', label: 'value', values: [-1.25] }],
    });
  });

  it.each(['empty', 'non-finite'] as const)('returns an empty chart for an %s vector', (kind) => {
    expect(
      promqlCategoryChart([
        queryResult('A', {
          instant: {
            resultType: 'vector',
            result: kind === 'empty' ? [] : [{ metric: {}, value: [2, 'NaN'] }],
          },
        }),
      ]),
    ).toEqual({
      categorical: false,
      categories: [],
      timestamps: [],
      series: [{ id: 'value', label: 'value', values: [] }],
    });
  });

  it('leaves range data, including a range from another query, on the time path', () => {
    const range = queryResult('A', { range: { resultType: 'matrix', result: [] } });
    const instant = queryResult('B', {
      instant: { resultType: 'vector', result: [{ metric: {}, value: [2, '5'] }] },
    });
    expect(promqlCategoryChart([range])).toBeUndefined();
    expect(promqlCategoryChart([range, instant])).toBeUndefined();
    expect(promqlCategoryChart([{ ...instant, range: range.range }])).toBeUndefined();
  });

  it('returns undefined without instant vectors or scalars', () => {
    expect(promqlCategoryChart([])).toBeUndefined();
    expect(promqlCategoryChart([queryResult('A')])).toBeUndefined();
    expect(
      promqlCategoryChart([
        queryResult('A', { instant: { resultType: 'matrix', result: [] } }),
        queryResult('B', { instant: { resultType: 'string', result: [2, 'hello'] } }),
      ]),
    ).toBeUndefined();
  });
});
