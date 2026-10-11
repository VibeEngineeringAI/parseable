import { describe, expect, it } from 'vitest';
import {
  barSlotSize,
  categoryBounds,
  formatNumericTicks,
  groupedBarLayout,
  hexToRgba,
  paddedValueBounds,
  stackValues,
  thinCategoryTicks,
  timeBarBounds,
  truncateCategoryLabel,
} from './cartesianData';

describe('Cartesian bounds', () => {
  it('starts nonnegative data at zero with five percent upper padding', () => {
    expect(paddedValueBounds(2, 10)).toEqual([0, 10.4]);
    expect(paddedValueBounds(0, 0)).toEqual([0, 1]);
    expect(paddedValueBounds(5, 5)).toEqual([0, 6]);
    expect(paddedValueBounds(100, 100)).toEqual([0, 105]);
  });

  it('pads both ends of signed and constant negative data', () => {
    expect(paddedValueBounds(-4, 6)).toEqual([-4.5, 6.5]);
    expect(paddedValueBounds(-40, -40)).toEqual([-42, -38]);
    expect(paddedValueBounds(-10, -5)).toEqual([-10.25, -4.75]);
    expect(paddedValueBounds(-10, -5, true)).toEqual([-10.25, 0]);
    expect(paddedValueBounds(-4, 6, true)).toEqual([-4.5, 6.5]);
  });

  it('keeps a usable range when every series is hidden', () => {
    expect(paddedValueBounds(Infinity, -Infinity, true)).toEqual([0, 1]);
    expect(paddedValueBounds(NaN, NaN)).toEqual([0, 1]);
  });

  it('reserves half a slot at each end of categorical bars', () => {
    expect(categoryBounds(4, true)).toEqual([-0.5, 3.5]);
    expect(categoryBounds(4, false)).toEqual([0, 3]);
    expect(categoryBounds(1, true)).toEqual([-0.5, 0.5]);
    expect(categoryBounds(1, false)).toEqual([-0.5, 0.5]);
    expect(categoryBounds(0, true)).toEqual([-0.5, 0.5]);
  });

  it('uses the smallest time interval without collapsing unequal time gaps', () => {
    const timestamps = [1000, 1060, 1240];
    expect(barSlotSize(timestamps)).toBe(60);
    expect(timeBarBounds(timestamps)).toEqual([970, 1270]);
    expect(barSlotSize(timestamps, true)).toBe(1);
    expect(timeBarBounds([1000])).toEqual([970, 1030]);
    expect(barSlotSize([1000, 1000, 1060])).toBe(60);
  });
});

describe('bar stacks', () => {
  const values = [
    [2, -3, 4, null, NaN],
    [5, -2, -1, 7, Infinity],
    [-1, 4, 2, 1, 3],
  ];

  it('accumulates positive and negative values independently, leaving gaps', () => {
    expect(stackValues(values, [true, true, true])).toEqual([
      [2, -3, 4, null, null],
      [7, -5, -1, 7, null],
      [-1, 4, 6, 8, 3],
    ]);
  });

  it('excludes hidden series from both stack totals', () => {
    expect(stackValues(values, [true, false, true])).toEqual([
      [2, -3, 4, null, null],
      [null, null, null, null, null],
      [-1, 4, 6, 1, 3],
    ]);
    expect(stackValues(values, [false, false, false])).toEqual(
      values.map(() => [null, null, null, null, null]),
    );
  });

  it('keeps real values for inspection and never mutates incoming data', () => {
    const original = values.map((samples) => [...samples]);
    const stacked = stackValues(values, [true, true, true]);
    stacked[0][0] = 100;
    expect(values).toEqual(original);
    expect(stackValues([[0, 2], [3]], [true, true])).toEqual([
      [0, 2],
      [3, null],
    ]);
    expect(stackValues([], [])).toEqual([]);
  });
});

describe('grouped bar layout', () => {
  it('allocates 80 percent of each category with 90 percent bar widths', () => {
    const layout = groupedBarLayout([true, true, true]);
    const width = (0.8 / 3) * 0.9;
    expect(layout.map((bar) => bar!.width)).toEqual([width, width, width]);
    expect(layout[0]!.offset).toBeCloseTo(-0.8 / 3);
    expect(layout[1]!.offset).toBeCloseTo(0);
    expect(layout[2]!.offset).toBeCloseTo(0.8 / 3);
    expect(layout[0]!.offset - width / 2).toBeGreaterThan(-0.4);
    expect(layout[2]!.offset + width / 2).toBeLessThan(0.4);
  });

  it('reclaims hidden slots and centres the remaining single bar', () => {
    const layout = groupedBarLayout([true, false, true]);
    expect(layout[0]!.offset).toBeCloseTo(-0.2);
    expect(layout[1]).toBeNull();
    expect(layout[2]!.offset).toBeCloseTo(0.2);
    expect(layout[0]!.width).toBeCloseTo(0.36);
    expect(groupedBarLayout([false, true, false])).toEqual([
      null,
      { offset: 0, width: 0.8 * 0.9 },
      null,
    ]);
    expect(groupedBarLayout([false, false])).toEqual([null, null]);
  });

  it('puts all stacked series in the same slot', () => {
    expect(groupedBarLayout([true, false, true], true)).toEqual([
      { offset: 0, width: 0.8 * 0.9 },
      null,
      { offset: 0, width: 0.8 * 0.9 },
    ]);
  });
});

describe('hex alpha', () => {
  it('converts full and short hex colours to the requested alpha', () => {
    expect(hexToRgba('#2a78d6', 0.1)).toBe('rgba(42, 120, 214, 0.1)');
    expect(hexToRgba('#AbC', 0.1)).toBe('rgba(170, 187, 204, 0.1)');
    expect(hexToRgba('#aabbccff', 0.1)).toBe('rgba(170, 187, 204, 0.1)');
    expect(hexToRgba('#abcf', 0.1)).toBe('rgba(170, 187, 204, 0.1)');
  });

  it('clamps alpha and leaves non-hex colour tokens intact', () => {
    expect(hexToRgba('#000', -1)).toBe('rgba(0, 0, 0, 0)');
    expect(hexToRgba('#fff', 2)).toBe('rgba(255, 255, 255, 1)');
    expect(hexToRgba('var(--chart-series-1)', 0.1)).toBe('var(--chart-series-1)');
  });
});

describe('category ticks', () => {
  it('limits ticks to eight integer indices, including both ends', () => {
    const ticks = thinCategoryTicks(30, 1200, 30);
    expect(ticks).toHaveLength(8);
    expect(ticks[0]).toBe(0);
    expect(ticks.at(-1)).toBe(29);
    expect(ticks.every(Number.isInteger)).toBe(true);
    expect(new Set(ticks).size).toBe(ticks.length);
    expect(thinCategoryTicks(4, 1200, 30)).toEqual([0, 1, 2, 3]);
  });

  it('thins according to label width with sixteen pixels of padding', () => {
    expect(thinCategoryTicks(20, 360, 104)).toEqual([0, 10, 19]);
    expect(thinCategoryTicks(20, 360, 164)).toEqual([0, 19]);
    expect(thinCategoryTicks(20, 0, 104)).toEqual([0]);
    expect(thinCategoryTicks(1, 360, 104)).toEqual([0]);
    expect(thinCategoryTicks(0, 360, 104)).toEqual([]);
  });

  it('truncates to the measured width without splitting Unicode characters', () => {
    const measure = (text: string) => [...text].length * 6;
    expect(truncateCategoryLabel('payments-api', 42, measure)).toBe('paymen…');
    expect(truncateCategoryLabel('api', 42, measure)).toBe('api');
    expect(truncateCategoryLabel('😀😀😀', 12, measure)).toBe('😀…');
    expect(truncateCategoryLabel('api', 6, measure)).toBe('…');
    expect(truncateCategoryLabel('api', 0, measure)).toBe('');
  });
});

it('blanks adjacent numeric ticks that format to the same label', () => {
  expect(formatNumericTicks([0, 0.1, 0.2, 1, 1.1, 2], (value) => value.toFixed(0))).toEqual([
    '0',
    '',
    '',
    '1',
    '',
    '2',
  ]);
  expect(formatNumericTicks([0, 1, 0], String)).toEqual(['0', '1', '0']);
});
