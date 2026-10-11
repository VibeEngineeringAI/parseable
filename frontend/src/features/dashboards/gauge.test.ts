import { describe, expect, it } from 'vitest';
import type { QueryResult } from '../../lib/promqlResults';
import type {
  DashboardTile,
  LogRecord,
  PromqlInstantResult,
  PromqlRangeResult,
} from '../../lib/types';
import gauge from './__fixtures__/gauge/gauge.json';
import absolute from './__fixtures__/gauge/gauge-absolute-segments.json';
import promql from './__fixtures__/gauge/promql-gauge.json';
import editor from './__fixtures__/gauge/editor-gauge.json';
import {
  GAUGE_CENTRE,
  GAUGE_TEXT,
  fitGaugeText,
  gaugeColours,
  gaugeFraction,
  gaugeLevel,
  gaugeModel,
  gaugeRange,
  gaugeValue,
} from './gauge';
import { paletteColour, tilePalette } from './palettes';

const tile = (layout: Record<string, unknown>): DashboardTile => ({
  tile_id: 'gauge',
  config: { layout },
});
const query = (
  instant?: PromqlInstantResult,
  range?: PromqlRangeResult,
  id = 'A',
): QueryResult => ({ id, pending: 0, errors: [], instant, range });
const scalar = (value: string): PromqlInstantResult => ({
  resultType: 'scalar',
  result: [1, value],
});
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
        [3, '-Inf'],
      ],
    },
    {
      metric: { host: 'first-finite' },
      values: [
        [1, '12'],
        [2, 'NaN'],
        [3, '42.5'],
        [4, '+Inf'],
        [5, '-Inf'],
      ],
    },
    { metric: { host: 'later' }, values: [[6, '99']] },
  ],
};

describe('gauge ranges and filled fractions', () => {
  it('defaults to 0..100 and reads finite numeric overrides', () => {
    expect(gaugeRange({ tile_id: 'empty' })).toEqual({ min: 0, max: 100 });
    expect(gaugeRange(gauge)).toEqual({ min: 0, max: 100 });
    expect(gaugeRange(absolute)).toEqual({ min: 0, max: 500 });
    expect(gaugeRange(tile({ rangeFrom: -20, rangeTo: 80 }))).toEqual({ min: -20, max: 80 });
    expect(gaugeRange(tile({ rangeFrom: 0, rangeTo: 0 }))).toEqual({ min: 0, max: 0 });
  });

  it.each(['20', null, undefined, {}, NaN, Infinity, -Infinity])(
    'ignores a non-number or non-finite range bound: %s',
    (bound) => {
      expect(gaugeRange(tile({ rangeFrom: bound, rangeTo: bound }))).toEqual({ min: 0, max: 100 });
    },
  );

  it.each([
    [50, 0],
    [100, 0],
    [125, 0.25],
    [200, 1],
    [250, 1],
  ])('clamps %s on 100..200 to fraction %s', (value, fraction) => {
    expect(gaugeFraction(value, { min: 100, max: 200 })).toBe(fraction);
  });

  it.each([10, 5, NaN])('guards a degenerate 10..%s range consistently', (max) => {
    const range = { min: 10, max };
    const segments = { value: [25, 75], isPercent: true };
    for (const value of [5, 10, 11]) {
      expect(() => gaugeFraction(value, range)).not.toThrow();
      expect(gaugeFraction(value, range)).toBe(value > 10 ? 1 : 0);
      expect(gaugeLevel(value, range, segments)).toBe(value > 10 ? 'red' : 'green');
    }
  });

  it('guards a NaN minimum and sanitizes NaN tile bounds before building a model', () => {
    expect(gaugeFraction(50, { min: NaN, max: 100 })).toBe(0);
    expect(gaugeModel(50, tile({ rangeFrom: NaN, rangeTo: NaN }))).toMatchObject({
      min: 0,
      max: 100,
      fraction: 0.5,
      level: 'yellow',
    });
    expect(gaugeModel(11, tile({ rangeFrom: 10, rangeTo: 5 })).fraction).toBe(1);
  });
});

describe('gauge threshold levels', () => {
  it.each([
    [5, 'green'],
    [10, 'green'],
    [10.01, 'yellow'],
    [90, 'yellow'],
    [91, 'red'],
    [150, 'red'],
    [-5, 'green'],
  ] as const)('reads percent fixture value %s as %s', (value, level) => {
    const model = gaugeModel(value, gauge);
    expect(model.level).toBe(level);
    expect(model.colour).toBe(gaugeColours[level]);
    expect(model.value).toBe(value);
  });

  it.each([
    [300, 'green'],
    [301, 'yellow'],
    [450, 'yellow'],
    [451, 'red'],
  ] as const)('reads absolute GB fixture value %s as %s', (value, level) => {
    expect(gaugeModel(value, absolute).level).toBe(level);
  });

  it.each([
    [125, 'green'],
    [126, 'yellow'],
    [175, 'yellow'],
    [176, 'red'],
  ] as const)(
    'normalizes value %s on a non-zero minimum for percent thresholds',
    (value, level) => {
      expect(
        gaugeModel(
          value,
          tile({ rangeFrom: 100, rangeTo: 200, segments: { value: [25, 75], isPercent: true } }),
        ).level,
      ).toBe(level);
    },
  );

  it('compares the unclamped percent quantity beyond either end of the range', () => {
    const segments = { value: [-5, 120], isPercent: true };
    expect(gaugeLevel(-10, { min: 0, max: 100 }, segments)).toBe('green');
    expect(gaugeLevel(130, { min: 0, max: 100 }, segments)).toBe('red');
  });

  it('uses green then red for one threshold, including equality in green', () => {
    const segments = { value: [50], isPercent: false };
    expect(gaugeLevel(25, { min: 0, max: 100 }, segments)).toBe('green');
    expect(gaugeLevel(50, { min: 0, max: 100 }, segments)).toBe('green');
    expect(gaugeLevel(50.01, { min: 0, max: 100 }, segments)).toBe('red');
  });

  it.each([[[]], [[10, 50, 90]]])(
    'uses the first classic palette colour for %s thresholds',
    (value) => {
      const stored = tile({ segments: { value } });
      expect(gaugeModel(60, stored)).toMatchObject({ level: 'neutral', colour: '#3B82F6' });
      expect(gaugeModel(60, stored).colour).toBe(paletteColour(tilePalette(stored), 0));
    },
  );

  it('uses the tile palette for neutral and fixed semantic colours for threshold levels', () => {
    const neutral = {
      ...editor,
      config: { ...editor.config, layout: { segments: { value: [] } } },
    };
    expect(gaugeModel(50, neutral)).toMatchObject({ level: 'neutral', colour: '#00A896' });
    expect(gaugeModel(30, editor)).toMatchObject({ level: 'green', colour: '#10b981' });
    expect(gaugeModel(80, editor)).toMatchObject({ level: 'yellow', colour: '#eab308' });
    expect(gaugeModel(81, editor)).toMatchObject({ level: 'red', colour: '#dc2626' });
  });

  it('sorts thresholds numerically and filters invalid entries without mutating the tile', () => {
    const stored = tile({
      segments: { value: [90, NaN, '10', Infinity, 10, -Infinity, null], isPercent: true },
    });
    const before = structuredClone(stored);
    expect(gaugeModel(10, stored).level).toBe('green');
    expect(gaugeModel(50, stored).level).toBe('yellow');
    expect(gaugeModel(91, stored).level).toBe('red');
    expect(stored).toEqual(before);
    expect(gaugeModel(50, tile({ segments: { value: ['10', NaN] } })).level).toBe('neutral');
  });

  it.each([undefined, null, {}, { value: '10,90', isPercent: true }])(
    'uses min and max as absolute thresholds when segments.value is not an array: %s',
    (segments) => {
      const stored = tile({ rangeFrom: 100, rangeTo: 200, segments });
      expect(gaugeModel(99, stored).level).toBe('green');
      expect(gaugeModel(100, stored).level).toBe('green');
      expect(gaugeModel(101, stored).level).toBe('yellow');
      expect(gaugeModel(200, stored).level).toBe('yellow');
      expect(gaugeModel(201, stored).level).toBe('red');
    },
  );

  it('uses absolute thresholds when isPercent is absent or not exactly true', () => {
    for (const isPercent of [undefined, false, 'true', 1])
      expect(gaugeLevel(125, { min: 100, max: 200 }, { value: [25, 75], isPercent })).toBe('red');
  });
});

describe('gauge SQL values', () => {
  const value = (rows: LogRecord[], stored: DashboardTile = gauge) =>
    gaugeValue(stored, { rows }, rows);

  it('uses the first result row and ignores later rows or the caller fallback rows', () => {
    const rows = [
      { utilization: 42.5, other: 99 },
      { utilization: 90, other: 100 },
    ];
    expect(value(rows)).toBe(42.5);
    expect(gaugeValue(gauge, { rows }, [{ utilization: 7 }])).toBe(42.5);
    expect(value([{ utilization: 'abc' }, { utilization: 90 }])).toBeUndefined();
  });

  it('uses only the first y field in an array', () => {
    const stored = {
      ...gauge,
      config: { axes: { y: { field: ['utilization', 'other'] } } },
    };
    expect(value([{ utilization: 12, other: 99 }], stored)).toBe(12);
    expect(value([{ utilization: 'abc', other: 99 }], stored)).toBeUndefined();
  });

  it.each([null, undefined, '', '   ', '\t\n'])('converts SQL %s to zero', (utilization) => {
    expect(value([{ utilization }])).toBe(0);
  });

  it('converts a missing configured field to zero', () => {
    expect(value([{ other: 99 }])).toBe(0);
  });

  it('accepts numeric strings and rejects non-finite or invalid values', () => {
    expect(value([{ utilization: '42.5' }])).toBe(42.5);
    for (const utilization of ['abc', 'NaN', 'Infinity', NaN, Infinity, -Infinity, {}])
      expect(value([{ utilization }])).toBeUndefined();
  });

  it.each([[''], [[]], [undefined]])(
    'falls back to the last row with an empty y field: %s',
    (field) => {
      const stored = { ...gauge, config: { axes: { y: { field } } } };
      const rows = [
        { note: 'first', amount: 10 },
        { note: 'last', amount: '42.5', other: 99 },
      ];
      expect(value(rows, stored)).toBe(42.5);
      expect(value([{ amount: 'abc' }], stored)).toBeUndefined();
    },
  );

  it('returns no value with no result rows, including native-created tiles', () => {
    expect(value([])).toBeUndefined();
    expect(value([], { tile_id: 'native' })).toBeUndefined();
    expect(gaugeValue(gauge, {}, [])).toBeUndefined();
  });
});

describe('gauge PromQL values', () => {
  const value = (...queries: QueryResult[]) => gaugeValue(promql, { promql: queries }, []);

  it('uses the first finite vector series, skipping NaN and infinity', () => {
    expect(value(query(vector('NaN', '+Inf', '-Inf', '42.5', '99')))).toBe(42.5);
    expect(value(query(vector('NaN', '0', '99')))).toBe(0);
  });

  it('reads scalar results', () => {
    expect(value(query(scalar('42.5')))).toBe(42.5);
  });

  it('uses the last finite sample of the first finite matrix series', () => {
    expect(value(query(matrix))).toBe(42.5);
  });

  it('falls back to range only when the instant result is absent', () => {
    expect(value(query(undefined, matrix))).toBe(42.5);
    expect(value(query(vector('7'), matrix))).toBe(7);
    expect(value(query(vector('NaN'), matrix))).toBeUndefined();
    expect(value(query(vector(), matrix))).toBeUndefined();
  });

  it('takes the last query that yields a value, including zero', () => {
    expect(value(query(scalar('10')), query(undefined, matrix, 'B'))).toBe(42.5);
    expect(value(query(undefined, matrix), query(scalar('17'), undefined, 'B'))).toBe(17);
    expect(value(query(scalar('10')), query(scalar('0'), undefined, 'B'))).toBe(0);
    expect(value(query(scalar('10')), query(vector('NaN'), undefined, 'B'))).toBe(10);
  });

  it('returns no value when none are finite and does not use SQL fallback rows', () => {
    expect(value()).toBeUndefined();
    expect(value(query())).toBeUndefined();
    expect(value(query(vector('NaN', '+Inf', '-Inf')))).toBeUndefined();
    expect(
      value(query({ resultType: 'matrix', result: matrix.result.slice(0, 2) })),
    ).toBeUndefined();
    for (const sample of ['NaN', '+Inf', '-Inf'])
      expect(value(query(scalar(sample)))).toBeUndefined();
    expect(gaugeValue(promql, { promql: [] }, [{ Value: 99 }])).toBeUndefined();
  });

  it('ignores string results even when they contain a numeric string', () => {
    expect(value(query({ resultType: 'string', result: [1, '42.5'] }, matrix))).toBeUndefined();
  });
});

describe('gauge value text fitting', () => {
  it('keeps short text large and shrinks longer formatted text', () => {
    expect(fitGaugeText('5')).toBe(GAUGE_TEXT.maxSize);
    expect(fitGaugeText('5')).toBeGreaterThan(fitGaugeText('12,345.678 GB'));
    expect(fitGaugeText('300.0 GB')).toBe(19.5);
  });

  it('keeps both top corners inside the hole for a formatted GB value', () => {
    const size = fitGaugeText('300.0 GB');
    // Four digits, a decimal point, a space and two letters: 4.24em wide.
    const distance = (fontSize: number) =>
      Math.hypot(
        (4.24 * fontSize) / 2,
        GAUGE_CENTRE.y - GAUGE_TEXT.baseline + GAUGE_TEXT.capHeight * fontSize,
      );
    expect(distance(size)).toBeLessThanOrEqual(GAUGE_TEXT.fitRadius);
    expect(distance(size + GAUGE_TEXT.sizeStep)).toBeGreaterThan(GAUGE_TEXT.fitRadius);
  });

  it('is deterministic and stops at the minimum for extremely long strings', () => {
    const text = '1234567890'.repeat(100);
    expect(fitGaugeText(text)).toBe(GAUGE_TEXT.minSize);
    expect(fitGaugeText(text)).toBe(fitGaugeText(text));
    expect(fitGaugeText('')).toBe(GAUGE_TEXT.maxSize);
  });

  it('shrinks monotonically as characters are appended', () => {
    let previous: number = GAUGE_TEXT.maxSize;
    for (let length = 1; length <= 100; length++) {
      const size = fitGaugeText('1'.repeat(length));
      expect(size).toBeLessThanOrEqual(previous);
      expect(size).toBeGreaterThanOrEqual(GAUGE_TEXT.minSize);
      previous = size;
    }
  });

  it('accounts for narrower punctuation and wider letters', () => {
    expect(fitGaugeText('., :'.repeat(4))).toBeGreaterThan(fitGaugeText('1234'.repeat(4)));
    expect(fitGaugeText('1234'.repeat(4))).toBeGreaterThanOrEqual(fitGaugeText('ABCD'.repeat(4)));
  });
});
