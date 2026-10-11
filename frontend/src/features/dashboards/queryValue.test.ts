import { describe, expect, it } from 'vitest';
import type { QueryResult } from '../../lib/promqlResults';
import type { DashboardTile, PromqlInstantResult, PromqlRangeResult } from '../../lib/types';
import sql from './__fixtures__/query-value/query-value.json';
import promql from './__fixtures__/query-value/promql-query-value.json';
import editor from './__fixtures__/query-value/editor-query-value.json';
import { cartesianChart, type CartesianChart } from './cartesian';
import {
  fitFontSize,
  queryValueNumber,
  queryValueTheme,
  queryValueThemes,
  sparklineEnabled,
  sparklinePath,
  sparklineValues,
} from './queryValue';

const tile = (layout: Record<string, unknown> = {}): DashboardTile => ({
  ...sql,
  config: { ...sql.config, layout: { ...sql.config.layout, ...layout } },
});
const query = (
  instant?: PromqlInstantResult,
  range?: PromqlRangeResult,
  id = 'A',
): QueryResult => ({ id, pending: 0, errors: [], instant, range });
const vector = (...values: string[]): PromqlInstantResult => ({
  resultType: 'vector',
  result: values.map((value, index) => ({ metric: { host: String(index) }, value: [1, value] })),
});
const matrix: PromqlRangeResult = {
  resultType: 'matrix',
  result: [
    { metric: { host: 'empty' }, values: [] },
    {
      metric: { host: 'invalid' },
      values: [
        [1, 'NaN'],
        [2, '+Inf'],
      ],
    },
    {
      metric: { host: 'first-finite' },
      values: [
        [3, '30'],
        [4, '+Inf'],
        [1, 'NaN'],
        [2, '10'],
        [5, '-Inf'],
      ],
    },
    {
      metric: { host: 'later' },
      values: [
        [1, '80'],
        [2, '90'],
      ],
    },
  ],
};
const emptyChart: CartesianChart = { categorical: false, timestamps: [], series: [] };

const rgb = (hex: string) =>
  [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255);
const luminance = (colour: number[]) => {
  const linear = colour.map((value) =>
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
  );
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
};
const contrast = (a: number[], b: number[]) => {
  const [min, max] = [luminance(a), luminance(b)].sort((a, b) => a - b);
  return (max + 0.05) / (min + 0.05);
};

describe('query value themes', () => {
  const light = {
    blue: '#3563E9',
    brown: '#9A3412',
    emerald: '#059669',
    fuchsia: '#A21CAF',
    grey: '#52525B',
    orange: '#EA580C',
    pink: '#DB2777',
    purple: '#6D28D9',
    red: '#DC2626',
    yellow: '#CA8A04',
  };

  it('keeps the ten classic themes in picker order with their exact light colours', () => {
    expect(Object.keys(queryValueThemes)).toEqual(Object.keys(light));
    for (const [key, theme] of Object.entries(queryValueThemes)) {
      expect(theme.light).toBe(light[key as keyof typeof light]);
      expect(theme.label).toBe(key.charAt(0).toUpperCase() + key.slice(1));
      expect(queryValueTheme(tile({ queryValueTheme: key }))).toBe(key);
    }
    expect(queryValueTheme(editor)).toBe('emerald');
    expect(queryValueTheme(promql)).toBe('blue');
  });

  it.each(Object.entries(queryValueThemes))(
    '%s dark colour clears 4.5:1 on the dark surface and its 18% self-tint',
    (_, theme) => {
      const surface = rgb('#1d1f2a');
      const colour = rgb(theme.dark);
      const tint = colour.map((value, index) => value * 0.18 + surface[index] * 0.82);
      expect(contrast(colour, surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(colour, tint)).toBeGreaterThanOrEqual(4.5);
    },
  );

  it('documents the classic large-text exceptions on white, including yellow below 3:1', () => {
    const white = rgb('#ffffff');
    expect(contrast(rgb(queryValueThemes.emerald.light), white)).toBeCloseTo(3.77, 2);
    expect(contrast(rgb(queryValueThemes.orange.light), white)).toBeCloseTo(3.56, 2);
    expect(contrast(rgb(queryValueThemes.yellow.light), white)).toBeCloseTo(2.94, 2);
  });

  it('gives yellow a darker text ink that clears 4.5:1 on white', () => {
    expect(queryValueThemes.yellow.ink).toBe('#A16207');
    expect(contrast(rgb(queryValueThemes.yellow.ink), rgb('#ffffff'))).toBeGreaterThanOrEqual(4.5);
  });

  it.each([undefined, 'unknown', 'gray', 'toString', '__proto__', null, 1])(
    'falls back to blue for an absent or unknown key: %s',
    (queryValueThemeKey) => {
      expect(queryValueTheme(tile({ queryValueTheme: queryValueThemeKey }))).toBe('blue');
    },
  );
});

describe('query value sparklines', () => {
  it('requires a query-value tile with sparkline exactly true', () => {
    expect(sparklineEnabled(sql)).toBe(false);
    expect(sparklineEnabled(editor)).toBe(false);
    expect(sparklineEnabled(promql)).toBe(true);
    for (const sparkline of [false, undefined, 'true', 1, null])
      expect(sparklineEnabled(tile({ sparkline }))).toBe(false);
    expect(sparklineEnabled({ ...tile({ sparkline: true }), chartType: 'line' })).toBe(false);
  });

  it('uses only the first query and its first finite range series, in time order without NaN/Inf', () => {
    const before = structuredClone(matrix);
    const result = { promql: [query(vector('999'), matrix), query(undefined, matrix, 'B')] };
    expect(sparklineValues(promql, result, emptyChart)).toEqual([10, 30]);
    expect(matrix).toEqual(before);
    expect(
      sparklineValues(promql, { promql: [query(), query(undefined, matrix, 'B')] }, emptyChart),
    ).toBeUndefined();
  });

  it('does not seek a later series when the first finite series has fewer than two points', () => {
    const range: PromqlRangeResult = {
      resultType: 'matrix',
      result: [
        {
          metric: {},
          values: [
            [1, 'NaN'],
            [2, '7'],
          ],
        },
        {
          metric: {},
          values: [
            [1, '80'],
            [2, '90'],
          ],
        },
      ],
    };
    expect(
      sparklineValues(promql, { promql: [query(undefined, range)] }, emptyChart),
    ).toBeUndefined();
    expect(
      sparklineValues(
        promql,
        { promql: [query(undefined, { resultType: 'matrix', result: matrix.result.slice(0, 2) })] },
        emptyChart,
      ),
    ).toBeUndefined();
  });

  it('requires a range rather than deriving a trend from instant results', () => {
    expect(
      sparklineValues(promql, { promql: [query(vector('10', '30'))] }, emptyChart),
    ).toBeUndefined();
    expect(sparklineValues(promql, { promql: [] }, emptyChart)).toBeUndefined();
  });

  it('uses the first SQL timestamp series, drops nulls, and leaves other series alone', () => {
    const stored = {
      ...tile({ sparkline: true }),
      config: {
        layout: { sparkline: true },
        axes: { x: { field: 'time' }, y: { field: ['events', 'other'] } },
      },
    };
    const rows = [
      { time: '2026-10-10T00:03:00Z', events: 30, other: 90 },
      { time: '2026-10-10T00:01:00Z', events: 10, other: 80 },
      { time: '2026-10-10T00:02:00Z', events: null, other: 85 },
      { time: '2026-10-10T00:04:00Z', events: Infinity, other: 95 },
    ];
    const chart = cartesianChart(rows, stored);
    expect(sparklineValues(stored, { rows }, chart)).toEqual([10, 30]);
    expect(sparklineValues(stored, {}, emptyChart)).toBeUndefined();
    expect(
      sparklineValues(stored, { rows: rows.slice(0, 1) }, cartesianChart(rows.slice(0, 1), stored)),
    ).toBeUndefined();
  });

  it('does not draw categorical SQL rows, including cartesian category charts', () => {
    const stored = tile({ sparkline: true });
    const rows = [{ events: 10 }, { events: 30 }];
    expect(sparklineValues(stored, { rows }, cartesianChart(rows, stored))).toBeUndefined();
    expect(sparklineValues(stored, { rows }, { ...emptyChart, categorical: true })).toBeUndefined();
  });

  it('does not draw a disabled sparkline with otherwise valid range data', () => {
    expect(
      sparklineValues(sql, { promql: [query(undefined, matrix)] }, emptyChart),
    ).toBeUndefined();
  });
});

describe('query value font fitting', () => {
  it('starts at 100px when both dimensions have room', () => {
    expect(fitFontSize({ measure: (px) => px, width: 200, height: 200 })).toBe(100);
  });

  it('shrinks in steps of four to the largest size within exactly 90% of the width', () => {
    const measure = (px: number) => px * 2;
    const size = fitFontSize({ measure, width: 180, height: 300 });
    expect(size).toBe(80);
    expect(measure(size)).toBeLessThanOrEqual(180 * 0.9);
    expect(measure(size + 4)).toBeGreaterThan(180 * 0.9);
    expect(fitFontSize({ measure: (px) => px, width: 100, height: 300 })).toBe(88);
    expect(fitFontSize({ measure: () => 90, width: 100, height: 300 })).toBe(100);
    expect(fitFontSize({ measure: () => 90.001, width: 100, height: 300 })).toBe(20);
  });

  it('stops at 20px even when the width or height cannot fit the minimum', () => {
    expect(fitFontSize({ measure: (px) => px * 100, width: 100, height: 300 })).toBe(20);
    expect(fitFontSize({ measure: () => 0, width: 0, height: 0 })).toBe(20);
  });

  it('also stays within 70% of the height in four-pixel steps', () => {
    const size = fitFontSize({ measure: (px) => px, width: 1000, height: 100 });
    expect(size).toBe(68);
    expect(size).toBeLessThanOrEqual(100 * 0.7);
    expect(size + 4).toBeGreaterThan(100 * 0.7);
  });
});

describe('query value numbers', () => {
  it('keeps SQL last-row selection and the configured y field', () => {
    const rows = [
      { events: 10, other: 90 },
      { events: '42.5', other: 99 },
    ];
    expect(queryValueNumber(sql, { rows }, rows)).toBe(42.5);
    expect(queryValueNumber(editor, { rows: [{ cpu_pct: 54.56 }] }, [{ cpu_pct: 54.56 }])).toBe(
      54.56,
    );
    expect(queryValueNumber({ tile_id: 'native' }, { rows }, rows)).toBe(42.5);
    expect(queryValueNumber(sql, {}, [])).toBeUndefined();
  });

  it('prefers the instant envelope over range and picks the first finite series', () => {
    const range = {
      ...matrix,
      result: matrix.result.map((series) => ({
        ...series,
        values: series.values.slice().sort(([a], [b]) => a - b),
      })),
    };
    expect(
      queryValueNumber(promql, { promql: [query(vector('NaN', '+Inf', '7', '99'), range)] }, []),
    ).toBe(7);
    expect(queryValueNumber(promql, { promql: [query(vector('NaN'), range)] }, [])).toBeUndefined();
    expect(queryValueNumber(promql, { promql: [query(undefined, range)] }, [])).toBe(30);
  });

  it('uses the last query with a finite value, including zero, even with a first-query trend', () => {
    const queries = [query(vector('7'), matrix), query(vector('NaN', '0', '99'), undefined, 'B')];
    expect(queryValueNumber(promql, { promql: queries }, [])).toBe(0);
    expect(
      queryValueNumber(promql, { promql: [...queries, query(vector('NaN'), undefined, 'C')] }, []),
    ).toBe(0);
    expect(
      queryValueNumber(
        promql,
        { promql: [query({ resultType: 'scalar', result: [1, '12'] })] },
        [],
      ),
    ).toBe(12);
  });

  it('does not use table rows or string results as a fallback for absent PromQL numbers', () => {
    expect(queryValueNumber(promql, { promql: [] }, [{ Value: 99 }])).toBeUndefined();
    expect(
      queryValueNumber(
        promql,
        { promql: [query({ resultType: 'string', result: [1, '12'] }, matrix)] },
        [],
      ),
    ).toBeUndefined();
  });
});

describe('sparkline SVG paths', () => {
  it('normalizes monotone values with inverted y and 8% padding', () => {
    expect(sparklinePath([10, 20, 30])).toEqual({
      line: 'M 0 92 L 50 50 L 100 8',
      area: 'M 0 92 L 50 50 L 100 8 L 100 100 L 0 100 Z',
    });
    expect(sparklinePath([30, 20, 10]).line).toBe('M 0 8 L 50 50 L 100 92');
  });

  it('centres constant series', () => {
    expect(sparklinePath([7, 7, 7]).line).toBe('M 0 50 L 50 50 L 100 50');
  });

  it('handles two points and closes the area against the bottom edge', () => {
    expect(sparklinePath([-5, 5])).toEqual({
      line: 'M 0 92 L 100 8',
      area: 'M 0 92 L 100 8 L 100 100 L 0 100 Z',
    });
  });

  it('is deterministic, keeps at most two decimal places, and ignores shorter paths', () => {
    const values = [0, 1, 2, 7];
    expect(sparklinePath(values).line).toBe('M 0 92 L 33.33 80 L 66.67 68 L 100 8');
    expect(sparklinePath(values)).toEqual(sparklinePath(values));
    expect(sparklinePath([])).toEqual({ line: '', area: '' });
    expect(sparklinePath([7])).toEqual({ line: '', area: '' });
  });
});
