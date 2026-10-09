export type SelectableSeries = { id: string; label: string; values: (number | null)[] };

/** Slots 0-7 map to the palette; every series beyond that shares the neutral overflow slot. */
export const PALETTE_SIZE = 8;
export const OVERFLOW_SLOT = PALETTE_SIZE;

const HISTORY_LIMIT = 512;

function peak(values: readonly (number | null)[]): number {
  let max = -Infinity;
  for (const value of values)
    if (value != null && Number.isFinite(value) && value > max) max = value;
  return max;
}

/** Series ordered from most to least prominent: highest peak first, label/id break ties,
 * and series without any finite sample rank last. */
export function rankSeries<T extends SelectableSeries>(series: readonly T[]): T[] {
  return series
    .map((entry) => ({ entry, peak: peak(entry.values) }))
    .sort((a, b) => {
      if (a.peak !== b.peak)
        return a.peak === -Infinity ? 1 : b.peak === -Infinity ? -1 : b.peak - a.peak;
      return (
        a.entry.label.localeCompare(b.entry.label) ||
        (a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0)
      );
    })
    .map(({ entry }) => entry);
}

/** The `limit` series with the highest peak value, returned in their incoming (stable) order. */
export function selectTopSeries<T extends SelectableSeries>(
  series: readonly T[],
  limit: number,
): T[] {
  if (series.length <= limit) return [...series];
  const keep = new Set(rankSeries(series).slice(0, limit));
  return series.filter((entry) => keep.has(entry));
}

/**
 * Colour slots keyed by series id. `history` remembers earlier assignments so an id keeps its
 * colour while it stays in the drawn set and when it returns later. `ranked` lists the ids to
 * colour from most to least prominent: the most prominent unassigned ids get the free palette
 * slots (lowest first) and the rest fall back to the neutral overflow slot.
 * Returns the slot of every id in `ranked` and an updated history (the input is not mutated).
 */
export function assignSeriesSlots(
  history: ReadonlyMap<string, number>,
  ranked: readonly string[],
): { slots: Map<string, number>; history: Map<string, number> } {
  const slots = new Map<string, number>();
  const taken = new Set<number>();
  // When a returning id's old slot was reused, the more recently assigned id keeps it.
  const recency = new Map([...history.keys()].map((id, index) => [id, index]));
  const known = ranked
    .filter((id) => recency.has(id))
    .sort((left, right) => recency.get(right)! - recency.get(left)!);
  for (const id of known) {
    const previous = history.get(id)!;
    if (previous === OVERFLOW_SLOT || taken.has(previous)) continue;
    slots.set(id, previous);
    taken.add(previous);
  }
  let next = 0;
  for (const id of ranked) {
    if (slots.has(id)) continue;
    while (next < PALETTE_SIZE && taken.has(next)) next++;
    if (next < PALETTE_SIZE) {
      slots.set(id, next);
      taken.add(next);
    } else slots.set(id, OVERFLOW_SLOT);
  }
  const nextHistory = new Map(history);
  for (const [id, slot] of slots) {
    nextHistory.delete(id);
    nextHistory.set(id, slot);
  }
  while (nextHistory.size > HISTORY_LIMIT) nextHistory.delete(nextHistory.keys().next().value!);
  return { slots, history: nextHistory };
}
