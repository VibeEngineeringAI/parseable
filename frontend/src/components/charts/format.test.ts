import { describe, expect, it } from 'vitest';
import { formatChartValue } from './format';

describe('chart value formatting', () => {
  it.each([
    [NaN, '-'],
    [Infinity, '-'],
    [-Infinity, '-'],
    [0, '0'],
    [-0, '0'],
    [1e9, '1.00e+9'],
    [-1e9, '-1.00e+9'],
    [1234.56, '1235'],
    [1000, '1000'],
    [-1000, '-1000'],
    [1, '1.00'],
    [12.345, '12.35'],
    [0.5, '0.5000'],
    [0.001, '0.0010'],
    [-0.001, '-0.0010'],
    [0.0001234, '1.23e-4'],
  ])('formats %s as %s', (value, expected) => {
    expect(formatChartValue(value)).toBe(expected);
  });
});
