import { describe, expect, it } from 'vitest';
import type { DashboardTile, LogRecord } from '../../lib/types';
import fixture from './__fixtures__/bubble.json';
import { bubbleChart, bubbleRadius } from './bubble';

const tile = (axes: Record<string, unknown> = {}, colourScheme = 'classic'): DashboardTile => ({
  tile_id: 'bubble',
  chartType: 'bubble',
  config: {
    colourScheme,
    axes: { x: { field: 'x' }, y: { field: 'y' }, ...axes },
  },
});
const seconds = Date.UTC(2026, 9, 10, 10) / 1000;

describe('bubble radius', () => {
  it('uses square root scaling with a zero baseline', () => {
    expect([0, 25, 100].map((size) => bubbleRadius(size, 100))).toEqual([4, 11, 18]);
    expect(bubbleRadius(400, 100)).toBe(18);
  });
  it('clamps negative and non-finite sizes and defaults without a positive finite maximum', () => {
    for (const size of [-1, NaN, Infinity, -Infinity]) expect(bubbleRadius(size, 100)).toBe(4);
    for (const max of [0, -1, NaN, Infinity, -Infinity]) expect(bubbleRadius(100, max)).toBe(11);
  });
});

describe('bubble chart', () => {
  it('renders the stored two-column fixture at a constant radius without changing it', () => {
    const rows = [
      { duration_ms: 12, payload_bytes: 400 },
      { duration_ms: 4, payload_bytes: 100 },
    ];
    const before = structuredClone({ rows, fixture });
    const chart = bubbleChart(rows, fixture);
    expect(chart).toEqual({
      points: [
        { x: 12, y: 400, radius: 11, groupId: 'all' },
        { x: 4, y: 100, radius: 11, groupId: 'all' },
      ],
      groups: [{ id: 'all', label: 'payload_bytes', colour: '#3B82F6' }],
      xIsTime: false,
      xField: 'duration_ms',
      yField: 'payload_bytes',
      truncated: false,
      totalRows: 2,
    });
    expect({ rows, fixture }).toEqual(before);
  });
  it('keeps point order and groups in first valid appearance order with the tile palette', () => {
    const rows = [
      { x: null, y: 1, group: 'ignored' },
      { x: 3, y: 4, group: 'west' },
      { x: 1, y: 2, group: 'east' },
      { x: 2, y: 3, group: 'west' },
      { x: 4, y: 5, group: null },
      { x: 5, y: 6, group: '' },
      { x: 6, y: 7, group: { service: 'api' } },
      { x: 7, y: 8, group: { service: 'api' } },
      { x: 8, y: 9, group: ' ' },
    ];
    const chart = bubbleChart(rows, tile({ groupBy: { field: 'group' } }, 'teal'));
    expect(chart.points.map(({ x }) => x)).toEqual([3, 1, 2, 4, 5, 6, 7, 8]);
    expect(chart.groups.map(({ label }) => label)).toEqual([
      'west',
      'east',
      '(empty)',
      '(empty)',
      '{"service":"api"}',
      ' ',
    ]);
    expect(chart.groups.map(({ colour }) => colour)).toEqual([
      '#00A896',
      '#33B9AB',
      '#66CBC0',
      '#99DCD5',
      '#CCEEEA',
      '#008678',
    ]);
    expect(chart.points.map(({ groupId }) => groupId)).toEqual(
      [0, 1, 0, 2, 3, 4, 4, 5].map((index) => chart.groups[index].id),
    );
    expect(chart.groupField).toBe('group');
    expect(chart.totalRows).toBe(8);
  });
  it('gives identically labelled values of different types distinct stable group ids', () => {
    const values = [1, '1', true, 'true', { id: 1 }, '{"id":1}', null, '', undefined];
    const rows = values.map((group, x) => ({ x, y: 1, group }));
    const config = tile({ groupBy: { field: 'group' } });
    const chart = bubbleChart(rows, config);
    expect(chart.groups.map(({ label }) => label)).toEqual([
      '1',
      '1',
      'true',
      'true',
      '{"id":1}',
      '{"id":1}',
      '(empty)',
      '(empty)',
      '(empty)',
    ]);
    expect(new Set(chart.groups.map(({ id }) => id)).size).toBe(values.length);
    expect(bubbleChart([...rows].reverse(), config).points.map(({ groupId }) => groupId)).toEqual(
      chart.points.map(({ groupId }) => groupId).reverse(),
    );
  });
  it('cycles palette colours in group order', () => {
    const rows = Array.from({ length: 9 }, (_, group) => ({ x: group, y: 1, group }));
    const chart = bubbleChart(rows, tile({ groupBy: { field: 'group' } }, 'teal'));
    expect(chart.groups[0].colour).toBe('#00A896');
    expect(chart.groups[7].colour).toBe('#00221E');
    expect(chart.groups[8].colour).toBe('#00A896');
  });
  it('reads only the first groupBy array entry', () => {
    const rows = [
      { x: 0, y: 1, group: 'a', other: 'one' },
      { x: 1, y: 2, group: 'a', other: 'two' },
      { x: 2, y: 3, group: 'b', other: 'three' },
    ];
    const chart = bubbleChart(rows, tile({ groupBy: { field: ['group', 'other'] } }));
    expect(chart.groupField).toBe('group');
    expect(chart.groups.map(({ label }) => label)).toEqual(['a', 'b']);
  });
  it('leaves grouping absent for empty or nonexistent first bindings', () => {
    const rows = [
      { x: 0, y: 1, group: 'a' },
      { x: 1, y: 2, group: 'b' },
    ];
    for (const field of [undefined, '', [], [''], ['', 'group'], 'missing', ['missing', 'group']]) {
      const chart = bubbleChart(rows, tile({ groupBy: { field } }));
      expect(chart).not.toHaveProperty('groupField');
      expect(chart.groups).toEqual([{ id: 'all', label: 'y', colour: '#3B82F6' }]);
      expect(chart.points.map(({ groupId }) => groupId)).toEqual(['all', 'all']);
    }
  });
  it('parses ISO and Arrow timestamps on an unnamed x column as Unix seconds, skipping nulls', () => {
    const chart = bubbleChart(
      [
        { observed: '2026-10-10T10:01:00Z', y: 3 },
        { observed: null, y: 100 },
        { observed: '2026-10-10T10:00:00.000', y: 4 },
        { y: 100 },
        { observed: '2026-10-10T12:30:00+02:00', y: 5 },
      ],
      tile({ x: { field: 'observed' } }),
    );
    expect(chart.xIsTime).toBe(true);
    expect(chart.points.map(({ x }) => x)).toEqual([seconds + 60, seconds, seconds + 1800]);
    expect(chart.totalRows).toBe(3);
  });
  it.each(['p_timestamp', 'time', 'ts', 'event_time', 'created_at'])(
    'parses numeric epoch seconds and milliseconds on %s',
    (field) => {
      const chart = bubbleChart(
        [
          { [field]: seconds * 1000, y: 1 },
          { [field]: null, y: 100 },
          { [field]: seconds + 60, y: 2 },
        ],
        tile({ x: { field } }),
      );
      expect(chart.xIsTime).toBe(true);
      expect(chart.points.map(({ x }) => x)).toEqual([seconds, seconds + 60]);
    },
  );
  it('keeps epoch-looking numbers on an ordinary column numeric', () => {
    const chart = bubbleChart(
      [
        { x: seconds * 1000, y: 1 },
        { x: seconds, y: 2 },
      ],
      tile(),
    );
    expect(chart.xIsTime).toBe(false);
    expect(chart.points.map(({ x }) => x)).toEqual([seconds * 1000, seconds]);
  });
  it('keeps numeric strings numeric even on a named time column', () => {
    const chart = bubbleChart(
      [
        { ts: String(seconds * 1000), y: 1 },
        { ts: '12.5', y: ' 4 ' },
      ],
      tile({ x: { field: 'ts' } }),
    );
    expect(chart.xIsTime).toBe(false);
    expect(chart.points.map(({ x, y }) => [x, y])).toEqual([
      [seconds * 1000, 1],
      [12.5, 4],
    ]);
  });
  it('requires every non-null x value to be time and mixed types to have a time name', () => {
    const rows = [
      { x: '2026-10-10T10:00:00Z', y: 1 },
      { x: seconds, y: 2 },
    ];
    const numeric = bubbleChart(rows, tile());
    expect(numeric.xIsTime).toBe(false);
    expect(numeric.points.map(({ x }) => x)).toEqual([seconds]);
    const temporal = bubbleChart(
      rows.map(({ x, y }) => ({ ts: x, y })),
      tile({ x: { field: 'ts' } }),
    );
    expect(temporal.xIsTime).toBe(true);
    expect(temporal.points.map(({ x }) => x)).toEqual([seconds, seconds]);
    const invalid = bubbleChart(
      [
        { ts: '2026-10-10T10:00:00Z', y: 1 },
        { ts: 'invalid', y: 2 },
      ],
      tile({ x: { field: 'ts' } }),
    );
    expect(invalid.xIsTime).toBe(false);
    expect(invalid.points).toEqual([]);
  });
  it('rejects invalid, null and non-finite x/y without coercing empty values or containers', () => {
    const invalid = [
      null,
      undefined,
      '',
      ' \t ',
      true,
      false,
      [],
      [1],
      {},
      NaN,
      Infinity,
      -Infinity,
      'NaN',
      'Infinity',
      'invalid',
    ];
    const rows = [
      ...invalid.map((x) => ({ x, y: 1 })),
      { x: 3, y: 4 },
      ...invalid.map((y) => ({ x: 1, y })),
      { x: '12.5', y: ' 0x10 ' },
    ];
    const chart = bubbleChart(rows, tile());
    expect(chart.points.map(({ x, y }) => [x, y])).toEqual([
      [3, 4],
      [12.5, 16],
    ]);
    expect(chart.totalRows).toBe(2);
    expect(chart.truncated).toBe(false);
  });
  it('accepts Number-coercible numeric strings', () => {
    const values = ['12.5', ' 0x10 ', '1e2', '-.5', '+5.5', '0b10', '0o10', '.5', '5.'];
    const chart = bubbleChart(
      values.map((value) => ({ x: value, y: value })),
      tile(),
    );
    expect(chart.points.map(({ x, y }) => [x, y])).toEqual([
      [12.5, 12.5],
      [16, 16],
      [100, 100],
      [-0.5, -0.5],
      [5.5, 5.5],
      [2, 2],
      [8, 8],
      [0.5, 0.5],
      [5, 5],
    ]);
    for (const value of values) {
      const single = bubbleChart([{ x: value, y: value }], tile());
      expect(single.xIsTime).toBe(false);
      expect(single.points[0]).toMatchObject({ x: Number(value), y: Number(value) });
    }
  });
  it('normalises negative, missing, blank and non-finite sizes to zero without dropping points', () => {
    const invalid = [
      -2,
      '-2',
      NaN,
      Infinity,
      -Infinity,
      undefined,
      null,
      '',
      ' \t ',
      false,
      [],
      {},
      'NaN',
      'Infinity',
      'invalid',
    ];
    const rows: LogRecord[] = [
      { x: 0, y: 1 },
      ...invalid.map((size, index) => ({ x: index + 1, y: 1, size })),
      { x: 20, y: 1, size: '25' },
      { x: 21, y: 1, size: 100 },
    ];
    const chart = bubbleChart(rows, tile({ size: { field: 'size' } }));
    expect(chart.sizeField).toBe('size');
    expect(chart.totalRows).toBe(rows.length);
    expect(chart.points.slice(0, -2).every(({ size, radius }) => size === 0 && radius === 4)).toBe(
      true,
    );
    expect(chart.points.slice(-2).map(({ size, radius }) => [size, radius])).toEqual([
      [25, 11],
      [100, 18],
    ]);
  });
  it('uses square root scaling over valid points with a zero baseline', () => {
    const chart = bubbleChart(
      [
        { x: 0, y: 1, size: 0 },
        { x: 1, y: 2, size: 25 },
        { x: null, y: 3, size: 10000 },
        { x: 2, y: 3, size: 100 },
      ],
      tile({ size: { field: 'size' } }),
    );
    expect(chart.points.map(({ radius }) => radius)).toEqual([4, 11, 18]);
  });
  it('uses radius 11 for equal or zero sizes and for only one valid point', () => {
    for (const sizes of [[25, 25], [0, 0], [-1, -2], [NaN, undefined], [100]]) {
      const chart = bubbleChart(
        sizes.map((size, x) => ({ x, y: 1, size })),
        tile({ size: { field: 'size' } }),
      );
      expect(chart.points.map(({ radius }) => radius)).toEqual(sizes.map(() => 11));
    }
    const chart = bubbleChart(
      [
        { x: 0, y: 1, size: 25 },
        { x: null, y: 1, size: 100 },
      ],
      tile({ size: { field: 'size' } }),
    );
    expect(chart.points.map(({ radius }) => radius)).toEqual([11]);
  });
  it('resolves empty axes from the union of row keys in first appearance order', () => {
    const chart = bubbleChart(
      [
        { label: 'api', width: null },
        { label: 'worker', width: '12.5', amount: ' 7 ', weight: '0x10', later: 99 },
      ],
      { tile_id: 'bubble', config: { axes: {} } },
    );
    expect(chart).toMatchObject({
      xField: 'width',
      yField: 'amount',
      sizeField: 'weight',
      totalRows: 1,
    });
    expect(chart.points).toEqual([{ x: 12.5, y: 7, size: 16, radius: 11, groupId: 'all' }]);
  });
  it('uses the first eligible x column even when a timestamp appears later', () => {
    const chart = bubbleChart([{ measure: 1, seen_at: '2026-10-10T10:00:00Z', count: 2 }], {
      tile_id: 'bubble',
    });
    expect(chart).toMatchObject({ xField: 'measure', yField: 'count', xIsTime: false });
    expect(chart).not.toHaveProperty('sizeField');
  });
  it('can fall back to a timestamp x column and ignores nonnumeric candidates', () => {
    const chart = bubbleChart(
      [
        {
          label: 'api',
          observed: '2026-10-10T10:00:00Z',
          blank: '',
          flag: true,
          list: [1],
          y: '2',
        },
      ],
      tile({ x: { field: '' }, y: { field: [] } }),
    );
    expect(chart).toMatchObject({ xField: 'observed', yField: 'y', xIsTime: true });
    expect(chart.points[0]).toMatchObject({ x: seconds, y: 2, radius: 11 });
  });
  it('does not choose null, whitespace, containers or non-finite numbers as numeric fallbacks', () => {
    const chart = bubbleChart(
      [
        {
          blank: '',
          whitespace: ' \t ',
          nil: null,
          flag: true,
          list: [2],
          object: { n: 3 },
          inf: Infinity,
          nan: NaN,
          x: '0b10',
          y: '1e2',
        },
      ],
      { tile_id: 'bubble' },
    );
    expect(chart).toMatchObject({ xField: 'x', yField: 'y', totalRows: 1 });
    expect(chart.points[0]).toMatchObject({ x: 2, y: 100, radius: 11 });
    expect(chart).not.toHaveProperty('sizeField');
  });
  it('falls back from nonexistent configured fields and leaves nonexistent grouping absent', () => {
    const chart = bubbleChart(
      [{ amount: 1, total: 2, weight: 16 }],
      tile({
        x: { field: 'missing-x' },
        y: { field: ['missing-y', 'weight'] },
        size: { field: 'missing-size' },
        groupBy: { field: 'missing-group' },
      }),
    );
    expect(chart).toMatchObject({
      xField: 'amount',
      yField: 'total',
      sizeField: 'weight',
      totalRows: 1,
    });
    expect(chart).not.toHaveProperty('groupField');
  });
  it('finds fallback size only after the resolved nonfirst y column, excluding x', () => {
    const rows = [{ before: 16, chosen: 7, x: 2, weight: 9 }];
    const chart = bubbleChart(rows, tile({ y: { field: 'chosen' }, size: { field: '' } }));
    expect(chart).toMatchObject({ xField: 'x', yField: 'chosen', sizeField: 'weight' });
    expect(chart.points[0]).toMatchObject({ x: 2, y: 7, size: 9, radius: 11 });
    const noSize = bubbleChart([{ before: 16, x: 1, y: 2 }], tile());
    expect(noSize).not.toHaveProperty('sizeField');
    expect(noSize.points[0]).not.toHaveProperty('size');
    expect(noSize.points[0].radius).toBe(11);
  });
  it('reads only the first y array entry and falls back when it is empty', () => {
    const rows = [{ x: 1, first: 2, chosen: 3, weight: 4 }];
    const selected = bubbleChart(rows, tile({ y: { field: ['chosen', 'first'] } }));
    expect(selected).toMatchObject({ yField: 'chosen', sizeField: 'weight' });
    expect(selected.points[0].y).toBe(3);
    for (const field of ['', [], [''], ['', 'chosen']]) {
      const chart = bubbleChart(rows, tile({ y: { field } }));
      expect(chart).toMatchObject({ yField: 'first', sizeField: 'chosen' });
      expect(chart.points[0].y).toBe(2);
    }
  });
  it('reads the first entry of array bindings for x and size, like the editor', () => {
    const chart = bubbleChart(
      [{ first: 1, x: 2, y: 3, weight: 4, size: 5 }],
      tile({ x: { field: ['x'] }, size: { field: ['size'] } }),
    );
    expect(chart).toMatchObject({ xField: 'x', yField: 'y', sizeField: 'size' });
    expect(chart.points[0]).toMatchObject({ x: 2, y: 3, size: 5 });
  });
  it('caps after filtering, counts all valid rows and normalises only rendered sizes and groups', () => {
    const rows = [
      ...Array.from({ length: 50 }, () => ({ x: null, y: 1, size: 1e9, group: 'invalid' })),
      ...Array.from({ length: 2000 }, (_, x) => ({
        x,
        y: x,
        size: x === 0 ? 0 : x === 1999 ? 100 : 25,
        group: x % 2 ? 'second' : 'first',
      })),
      { x: 2000, y: 2000, size: 1e12, group: 'beyond' },
      { x: 2001, y: null, size: 1e12, group: 'invalid' },
      { x: 2002, y: 2002, size: 50, group: 'beyond' },
    ];
    const chart = bubbleChart(rows, tile({ size: { field: 'size' }, groupBy: { field: 'group' } }));
    expect(chart.points).toHaveLength(2000);
    expect(chart.totalRows).toBe(2002);
    expect(chart.truncated).toBe(true);
    expect(chart.points[0]).toMatchObject({ x: 0, radius: 4 });
    expect(chart.points[1]).toMatchObject({ x: 1, radius: 11 });
    expect(chart.points.at(-1)).toMatchObject({ x: 1999, radius: 18 });
    expect(chart.groups.map(({ label }) => label)).toEqual(['first', 'second']);
  });
  it('does not mark exactly 2000 valid rows truncated even with additional invalid rows', () => {
    const chart = bubbleChart(
      [...Array.from({ length: 2000 }, (_, x) => ({ x, y: 1 })), { x: null, y: 1 }],
      tile(),
    );
    expect(chart.points).toHaveLength(2000);
    expect(chart.totalRows).toBe(2000);
    expect(chart.truncated).toBe(false);
  });
  it('returns typed empty data for empty or entirely unchartable rows', () => {
    expect(bubbleChart([], tile())).toEqual({
      points: [],
      groups: [],
      xIsTime: false,
      xField: '',
      yField: '',
      truncated: false,
      totalRows: 0,
    });
    const chart = bubbleChart([{ x: null, y: 1 }, { y: 2 }], tile());
    expect(chart).toMatchObject({
      points: [],
      groups: [],
      xIsTime: false,
      xField: 'x',
      yField: 'y',
      truncated: false,
      totalRows: 0,
    });
  });
});
