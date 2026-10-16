import { describe, expect, it } from 'vitest';
import { createSqlChartConfig } from './sqlChart';
import { readSavedQueries, saveQuery, sqlStorageScope, type SavedQuery } from './savedQueries';
const item: SavedQuery = {
  id: 'a',
  name: 'Errors',
  sql: 'SELECT 1',
  range: '1h',
  datasets: ['logs'],
  updatedAt: '2026-01-01',
};
describe('saved SQL library', () => {
  it('preserves column order and drops malformed preferences without losing SQL', () => {
    expect(readSavedQueries(JSON.stringify([{ ...item, columns: ['b', 'a'] }]))[0].columns).toEqual(
      ['b', 'a'],
    );
    for (const columns of [[], ['a', 'a'], ['a', 3], 'a']) {
      expect(readSavedQueries(JSON.stringify([{ ...item, columns }]))).toEqual([item]);
    }
  });
  it('isolates server, identity, and demo and avoids an anonymous live library', () => {
    const identity = { id: 'a', username: 'a', source: 'server' as const };
    expect(sqlStorageScope('live')).toBeNull();
    expect(
      new Set([
        sqlStorageScope('demo', identity),
        sqlStorageScope('live', identity, 'server-a'),
        sqlStorageScope('live', identity, 'server-b'),
        sqlStorageScope('live', { ...identity, id: 'b' }, 'server-a'),
      ]).size,
    ).toBe(4);
  });
  it('recovers valid entries while rejecting corruption and duplicate IDs', () => {
    expect(readSavedQueries('{')).toEqual([]);
    expect(
      readSavedQueries(
        JSON.stringify([
          item,
          { ...item, id: 'bad', range: 'forever' },
          item,
          { ...item, id: 'bad2', datasets: [1] },
        ]),
      ),
    ).toEqual([item]);
  });
  it('rejects invalid and reversed absolute dates', () => {
    const bad = [
      { startTime: 'bad', endTime: 'now' },
      { startTime: '2026-01-02', endTime: '2026-01-01' },
      [],
    ];
    expect(
      readSavedQueries(JSON.stringify(bad.map((range, i) => ({ ...item, id: String(i), range })))),
    ).toEqual([]);
  });
  it('opens SQL while discarding corrupt optional chart configurations', () => {
    const chart = createSqlChartConfig();
    for (const invalid of [
      { tile_id: chart.tile_id },
      { ...chart, chartType: 'unknown' },
      { ...chart, config: { axes: [] } },
    ]) {
      expect(readSavedQueries(JSON.stringify([{ ...item, chart: invalid }]))).toEqual([item]);
    }
  });
  it('keeps a draft library association and discards a malformed optional ID', () => {
    expect(readSavedQueries(JSON.stringify([{ ...item, savedId: 'library-id' }]))[0].savedId).toBe(
      'library-id',
    );
    expect(readSavedQueries(JSON.stringify([{ ...item, savedId: 42 }]))[0].savedId).toBeUndefined();
  });
  it('updates by ID and preserves unrelated queries', () => {
    const other = { ...item, id: 'b' };
    expect(saveQuery([item, other], { ...item, name: 'Renamed' })).toEqual([
      { ...item, name: 'Renamed' },
      other,
    ]);
    expect(
      readSavedQueries(
        JSON.stringify([
          {
            ...item,
            range: { startTime: '2026-01-01T00:00:00Z', endTime: '2026-01-02T00:00:00Z' },
            chart: { ...createSqlChartConfig(), tile_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV' },
          },
        ]),
      )[0].chart,
    ).toMatchObject({ tile_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', chartType: 'timeseries' });
  });
});
