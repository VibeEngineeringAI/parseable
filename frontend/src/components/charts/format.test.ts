import { describe, expect, it } from 'vitest';
import { formatChartValue } from './format';

describe('chart value formatting', () => {
  it.each([
    [NaN, '-'],
    [Infinity, '-'],
    [-Infinity, '-'],
    [0, '0'],
    [-0, '0'],
    [1e9, '1e+9'],
    [-1e9, '-1e+9'],
    [1.5e9, '1.5e+9'],
    [1234.56, '1235'],
    [1000, '1000'],
    [-1000, '-1000'],
    [1, '1'],
    [2.5, '2.5'],
    [100, '100'],
    [3.75, '3.75'],
    [12.345, '12.35'],
    [0.5, '0.5'],
    [0.85, '0.85'],
    [0.6463, '0.6463'],
    [0.001, '0.001'],
    [-0.001, '-0.001'],
    [0.0001234, '1.23e-4'],
    [0.0001, '1e-4'],
  ])('formats %s as %s', (value, expected) => {
    expect(formatChartValue(value)).toBe(expected);
  });
});
