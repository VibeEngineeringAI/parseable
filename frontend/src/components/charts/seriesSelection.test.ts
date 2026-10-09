import { describe, expect, it } from 'vitest';
import {
  OVERFLOW_SLOT,
  PALETTE_SIZE,
  assignSeriesSlots,
  rankSeries,
  selectTopSeries,
  type SelectableSeries,
} from './seriesSelection';

const make = (id: string, values: (number | null)[], label = id): SelectableSeries => ({
  id,
  label,
  values,
});

describe('top series selection', () => {
  it('keeps the series with the highest peak, not the first alphabetically', () => {
    const series = ['a', 'b', 'c', 'd'].map((id, index) => make(id, [1, index * 10, 2]));
    expect(selectTopSeries(series, 2).map((entry) => entry.id)).toEqual(['c', 'd']);
  });

  it('returns the kept series in their incoming order', () => {
    const series = [make('a', [1]), make('b', [9]), make('c', [5]), make('d', [7])];
    expect(selectTopSeries(series, 3).map((entry) => entry.id)).toEqual(['b', 'c', 'd']);
  });

  it('ranks by the maximum finite value, ignoring nulls and non-finite samples', () => {
    const series = [
      make('spike', [1, Infinity, NaN]),
      make('gaps', [null, 4, null]),
      make('negative', [-3, -1]),
    ];
    expect(rankSeries(series).map((entry) => entry.id)).toEqual(['gaps', 'spike', 'negative']);
  });

  it('ranks series with no finite value last', () => {
    const series = [make('empty', [null, NaN]), make('low', [-100]), make('none', [])];
    expect(rankSeries(series).map((entry) => entry.id)).toEqual(['low', 'empty', 'none']);
  });

  it('breaks ties by label then id so the selection is deterministic', () => {
    const series = [make('3', [5], 'b'), make('2', [5], 'a'), make('1', [5], 'a')];
    expect(rankSeries(series).map((entry) => entry.id)).toEqual(['1', '2', '3']);
    expect(rankSeries([...series].reverse()).map((entry) => entry.id)).toEqual(['1', '2', '3']);
    expect(selectTopSeries(series, 2).map((entry) => entry.id)).toEqual(['2', '1']);
  });

  it('returns everything when the limit is not exceeded', () => {
    const series = [make('b', [1]), make('a', [2])];
    expect(selectTopSeries(series, 5)).toEqual(series);
  });
});

describe('series colour slots', () => {
  const ids = (count: number, prefix = 's') =>
    Array.from({ length: count }, (_, i) => `${prefix}${i}`);

  it('hands out distinct palette slots in rank order, then the overflow slot', () => {
    const { slots } = assignSeriesSlots(new Map(), ids(10));
    expect([...slots.values()]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, OVERFLOW_SLOT, OVERFLOW_SLOT]);
    expect(PALETTE_SIZE).toBe(8);
  });

  it('keeps colours when a series appears or disappears between runs', () => {
    const first = assignSeriesSlots(new Map(), ['a', 'b', 'c']);
    const withNew = assignSeriesSlots(first.history, ['new', 'a', 'b', 'c']);
    expect(['a', 'b', 'c'].map((id) => withNew.slots.get(id))).toEqual([0, 1, 2]);
    expect(withNew.slots.get('new')).toBe(3);
    const dropped = assignSeriesSlots(withNew.history, ['a', 'c']);
    expect([dropped.slots.get('a'), dropped.slots.get('c')]).toEqual([0, 2]);
  });

  it('does not depend on how many series another query returned', () => {
    const queryA = ['A:1', 'A:2', 'A:3'];
    const before = assignSeriesSlots(new Map(), [...queryA, 'B:1', 'B:2']);
    const after = assignSeriesSlots(before.history, ['A:1', 'B:1', 'B:2']);
    expect(after.slots.get('B:1')).toBe(before.slots.get('B:1'));
    expect(after.slots.get('B:2')).toBe(before.slots.get('B:2'));
  });

  it('restores a returning id to its colour when its slot is still free', () => {
    const first = assignSeriesSlots(new Map(), ['a', 'b']);
    const gone = assignSeriesSlots(first.history, ['b']);
    const back = assignSeriesSlots(gone.history, ['a', 'b']);
    expect(back.slots.get('a')).toBe(0);
    expect(back.slots.get('b')).toBe(1);
  });

  it('never gives two drawn series the same palette slot, even when a slot was reused', () => {
    const first = assignSeriesSlots(new Map(), ['a', 'b']);
    const reused = assignSeriesSlots(first.history, ['b', 'c']);
    expect(reused.slots.get('c')).toBe(0);
    const back = assignSeriesSlots(reused.history, ['a', 'b', 'c']);
    const palette = [...back.slots.values()].filter((slot) => slot < PALETTE_SIZE);
    expect(new Set(palette).size).toBe(palette.length);
    expect(back.slots.get('b')).toBe(1);
    expect(back.slots.get('c')).toBe(0);
  });

  it('keeps existing colours when more series are revealed', () => {
    const top = assignSeriesSlots(new Map(), ids(8));
    const all = assignSeriesSlots(top.history, [...ids(8), 'extra']);
    for (const id of ids(8)) expect(all.slots.get(id)).toBe(top.slots.get(id));
    expect(all.slots.get('extra')).toBe(OVERFLOW_SLOT);
  });

  it('does not mutate the history it is given', () => {
    const history = new Map([['a', 3]]);
    assignSeriesSlots(history, ['a', 'b']);
    expect([...history]).toEqual([['a', 3]]);
  });
});
