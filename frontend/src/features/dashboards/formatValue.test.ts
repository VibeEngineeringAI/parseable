import { describe, expect, it } from 'vitest';
import { formatValue, valueFormat, type ValueFormat } from './formatValue';

describe('valueFormat', () => {
  it('reads trimmed units and the display settings without mutating the layout', () => {
    const layout = { unit: '  ms\t', precision: 3.9, humanize: true, other: 'keep' };
    expect(valueFormat(layout)).toEqual({ unit: 'ms', precision: 3, humanize: true });
    expect(layout).toEqual({ unit: '  ms\t', precision: 3.9, humanize: true, other: 'keep' });
    expect(valueFormat({})).toEqual({ unit: '', precision: undefined, humanize: false });
    expect(valueFormat({ unit: ' \t ' }).unit).toBe('');
  });

  it.each([
    [-100, -1],
    [-1, -1],
    [-0.1, -1],
    [0, 0],
    [1.9, 1],
    [20, 20],
    [20.9, 20],
    [100, 20],
    [NaN, undefined],
    [Infinity, undefined],
    [-Infinity, undefined],
    [undefined, undefined],
    [null, undefined],
    ['2', undefined],
    [true, undefined],
    [{}, undefined],
  ])('floors and clamps numeric precision %s to %s', (precision, expected) => {
    expect(valueFormat({ precision }).precision).toBe(expected);
  });

  it.each([undefined, null, 12, true, {}])('ignores non-string unit %s', (unit) => {
    expect(valueFormat({ unit }).unit).toBe('');
  });

  it.each([true, false, undefined, null, 1, 'true', [], {}])(
    'enables humanize only for the boolean true, given %s',
    (humanize) => {
      expect(valueFormat({ humanize }).humanize).toBe(humanize === true);
    },
  );
});

describe('formatValue without a unit', () => {
  it.each([
    [0, '0'],
    [-0, '0'],
    [12, '12'],
    [12.34, '12.3'],
    [1000, '1K'],
    [1536, '1.5K'],
    [-1536, '-1.5K'],
    [999.95, '1K'],
    [999_950, '1M'],
    [-999_950, '-1M'],
    [999_999, '1M'],
    [2_500_000, '2.5M'],
    [999_950_000, '1B'],
    [2_500_000_000, '2.5B'],
    [999_950_000_000, '1T'],
    [2_500_000_000_000, '2.5T'],
    [1e15, '1000T'],
    [100, '100'],
  ])('compacts %s to %s and ignores humanize', (value, expected) => {
    expect(formatValue(value)).toBe(expected);
    expect(formatValue(value, { humanize: true })).toBe(expected);
    expect(formatValue(value, { humanize: false })).toBe(expected);
  });

  it.each([undefined, 0, -1])('keeps the one-decimal default at precision %s', (precision) => {
    expect(formatValue(12.34, { precision })).toBe('12.3');
    expect(formatValue(1536, { precision })).toBe('1.5K');
  });

  it('raises the maximum decimals for explicit positive precision and still trims zeros', () => {
    expect(formatValue(12.34, { precision: 1 })).toBe('12.3');
    expect(formatValue(12.34, { precision: 2 })).toBe('12.34');
    expect(formatValue(1536, { precision: 3 })).toBe('1.536K');
    expect(formatValue(2_500_000, { precision: 3 })).toBe('2.5M');
    expect(formatValue(12, { precision: 20 })).toBe('12');
    expect(formatValue(999_950, { precision: 2 })).toBe('999.95K');
    expect(formatValue(999_995, { precision: 2 })).toBe('1M');
  });
});

describe('formatValue with a unit and humanize off', () => {
  const cases: [number, ValueFormat, string][] = [
    [0, { unit: 'events' }, '0 events'],
    [12.34, { unit: 'events' }, '12 events'],
    [1234.5, { unit: 'events', precision: 0 }, '1,235 events'],
    [-1234.5, { unit: 'ms', precision: 0 }, '-1,235 ms'],
    [1234.56, { unit: 'ms', precision: 2 }, '1,234.56 ms'],
    [12, { unit: 'ms', precision: 3 }, '12.000 ms'],
    [1234.567, { unit: 'events', precision: -1 }, '1,234.57 events'],
    [12.5, { unit: 'events', precision: -1 }, '12.5 events'],
    [12, { unit: 'events', precision: -1 }, '12 events'],
    [75, { unit: '%', precision: 0 }, '75 %'],
    [75, { unit: 'ms', precision: 0 }, '75 ms'],
    [100, { unit: 'events', precision: 0 }, '100 events'],
    [1500, { unit: 'KB' }, '1,500 KB'],
    [60, { unit: 's' }, '60 s'],
    [2, { unit: 'week' }, '2 week'],
  ];
  it.each(cases)('formats %s using %j as %s', (value, format, expected) => {
    expect(formatValue(value, format)).toBe(expected);
    expect(formatValue(value, { ...format, humanize: false })).toBe(expected);
  });

  it.each(['$', '€', '₹', '£', '¥', 'CN¥', 'C$', 'A$', 'CHF', 'S$', 'د.إ', 'R$'])(
    'prefixes currency %s, with the minus before the symbol',
    (unit) => {
      expect(formatValue(-1234.56, { unit })).toBe(`-${unit}1,235`);
      expect(formatValue(1234.56, { unit, precision: 0 })).toBe(`${unit}1,235`);
      expect(formatValue(-1234.56, { unit, precision: 2 })).toBe(`-${unit}1,234.56`);
      expect(formatValue(1234.5, { unit, precision: -1 })).toBe(`${unit}1,234.5`);
      expect(formatValue(1234, { unit, precision: -1 })).toBe(`${unit}1,234`);
    },
  );
});

describe('formatValue with humanize on', () => {
  it.each([
    [0, 'B', '0.0 B'],
    [0.5, 'B', '0.5 B'],
    [0.0005, 'KB', '0.5 B'],
    [1, 'KB', '1.0 KB'],
    [1000, 'B', '1.0 KB'],
    [1500, 'B', '1.5 KB'],
    [1500, 'KB', '1.5 MB'],
    [1500, 'MB', '1.5 GB'],
    [1500, 'GB', '1.5 TB'],
    [-1500, 'KB', '-1.5 MB'],
    [1_234_000, 'GB', '1,234.0 TB'],
    [1500, 'TB', '1,500.0 TB'],
    [1_234_000, 'TB', '1,234,000.0 TB'],
  ])('converts %s %s from its own decimal data scale to %s', (value, unit, expected) => {
    expect(formatValue(value, { unit, humanize: true })).toBe(expected);
  });

  it.each([
    [0, 's', '0.0 ns'],
    [0.5, 'ns', '0.5 ns'],
    [0.0005, 'μs', '0.5 ns'],
    [-0.5, 'ns', '-0.5 ns'],
    [1000, 'ns', '1.0 μs'],
    [1500, 'ns', '1.5 μs'],
    [1500, 'μs', '1.5 ms'],
    [1500, 'µs', '1.5 ms'],
    [1, 'µs', '1.0 μs'],
    [1500, 'ms', '1.5 s'],
    [60, 's', '1.0 min'],
    [90, 's', '1.5 min'],
    [90, 'min', '1.5 h'],
    [36, 'h', '1.5 d'],
    [-90, 'min', '-1.5 h'],
    [1, 'd', '1.0 d'],
    [1, 'week', '7.0 d'],
    [1, 'mo', '30.0 d'],
    [0.5, 'week', '3.5 d'],
    [0.01, 'mo', '7.2 h'],
    [1234, 'd', '1,234.0 d'],
    [1000, 'week', '7,000.0 d'],
  ])('converts %s %s from its own time scale to %s', (value, unit, expected) => {
    expect(formatValue(value, { unit, humanize: true })).toBe(expected);
  });

  it.each(['$', '€', '₹', '£', '¥', 'CN¥', 'C$', 'A$', 'CHF', 'S$', 'د.إ', 'R$'])(
    'prefixes compact currency %s, with fixed decimals and the minus before the symbol',
    (unit) => {
      expect(formatValue(1234, { unit, humanize: true })).toBe(`${unit}1.2K`);
      expect(formatValue(-1234, { unit, humanize: true })).toBe(`-${unit}1.2K`);
      expect(formatValue(12, { unit, humanize: true })).toBe(`${unit}12.0`);
      expect(formatValue(12, { unit, precision: -1, humanize: true })).toBe(`${unit}12.0`);
      expect(formatValue(1234, { unit, precision: 0, humanize: true })).toBe(`${unit}1K`);
      expect(formatValue(12, { unit, precision: 2, humanize: true })).toBe(`${unit}12.00`);
      expect(formatValue(-999_950, { unit, humanize: true })).toBe(`-${unit}1.0M`);
    },
  );

  it.each([
    [1234, 'events', '1.2K events'],
    [75, '%', '75.0 %'],
    [0, 'events', '0.0 events'],
    [-1536, 'events', '-1.5K events'],
    [999_950, 'events', '1.0M events'],
    [999_950_000, 'events', '1.0B events'],
    [999_950_000_000, 'events', '1.0T events'],
    [1e15, 'events', '1000.0T events'],
  ])('compacts %s with other unit %s to %s', (value, unit, expected) => {
    expect(formatValue(value, { unit, humanize: true })).toBe(expected);
  });

  it.each(['KB', 'ms', 'events', '%'])(
    'uses one fixed decimal by default or with precision -1 for %s',
    (unit) => {
      const format = { unit, humanize: true };
      expect(formatValue(12, format)).toBe(`12.0 ${unit}`);
      expect(formatValue(12, { ...format, precision: -1 })).toBe(`12.0 ${unit}`);
      expect(formatValue(12, { ...format, precision: 0 })).toBe(`12 ${unit}`);
      expect(formatValue(12, { ...format, precision: 2 })).toBe(`12.00 ${unit}`);
    },
  );

  it('rounds data and time values at the requested fixed precision', () => {
    expect(formatValue(1536, { unit: 'B', precision: 0, humanize: true })).toBe('2 KB');
    expect(formatValue(1536, { unit: 'B', precision: 2, humanize: true })).toBe('1.54 KB');
    expect(formatValue(1536, { unit: 'ns', precision: 0, humanize: true })).toBe('2 μs');
    expect(formatValue(1536, { unit: 'ns', precision: 2, humanize: true })).toBe('1.54 μs');
    expect(formatValue(999_950, { unit: 'events', precision: 2, humanize: true })).toBe(
      '999.95K events',
    );
  });
});

it.each([NaN, Infinity, -Infinity])('returns String(%s) regardless of the format', (value) => {
  expect(formatValue(value)).toBe(String(value));
  expect(formatValue(value, { unit: '$', precision: 2 })).toBe(String(value));
  expect(formatValue(value, { unit: 'KB', humanize: true })).toBe(String(value));
  expect(formatValue(value, { unit: 's', precision: 0, humanize: true })).toBe(String(value));
});
