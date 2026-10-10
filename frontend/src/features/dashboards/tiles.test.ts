import { describe, expect, it } from 'vitest';
import classic from './__fixtures__/classic.json';
import {
  appendLayout,
  moveTile,
  patchTile,
  promqlQueries,
  resolvedLayouts,
  sqlQuery,
  tileStep,
  tileVariableNames,
} from './tiles';
import type { Dashboard, DashboardTile } from '../../lib/types';
const make = (id: string, layout: unknown): DashboardTile => ({
  tile_id: id,
  layout,
  unknown: 'keep',
});
describe('classic tile helpers', () => {
  it('tracks only variables used in the tile query and dataset', () => {
    expect([
      ...tileVariableNames({
        tile_id: 'x',
        tileType: 'code',
        chartQuery: 'SELECT * FROM "$dataset" WHERE level=\'${level}\'',
        dbName: ['$dataset'],
      }),
    ]).toEqual(['dataset', 'level']);
    expect([
      ...tileVariableNames({
        tile_id: 'x',
        tileType: 'promql',
        chartQuery: ['up{host="$host"}', 'rate(up{zone="${zone}"}[5m])'],
        dbName: '$dataset',
      }),
    ]).toEqual(['host', 'zone', 'dataset']);
    expect([...tileVariableNames(classic.tiles[1])]).toEqual([]);
  });
  it('patches one title without rebuilding any tile or document', () => {
    const result = patchTile(classic, classic.tiles[0].tile_id, { title: 'Edited' });
    const expected = structuredClone(classic);
    expected.tiles[0].title = 'Edited';
    expect(result).toEqual(expected);
    expect(classic.tiles[0].title).toBe('Host load');
  });
  it('orders by y,x and appends null, missing and non-finite y without mutating originals', () => {
    const tiles = [
      make('a', { x: 6, y: 0, w: 6, h: 3 }),
      make('b', { x: 0, y: 0, w: 6, h: 4 }),
      make('c', { x: 0, y: null, w: 4, h: 2 }),
      make('d', {}),
      make('e', { y: Infinity }),
    ];
    const before = structuredClone(tiles),
      resolved = resolvedLayouts(tiles);
    expect(resolved.map((row) => row.tile.tile_id)).toEqual(['b', 'a', 'c', 'd', 'e']);
    expect(resolved.map((row) => row.layout.y)).toEqual([0, 0, 4, 6, 10]);
    expect(appendLayout(tiles)).toEqual({ x: 0, y: 14, w: 6, h: 4 });
    expect(tiles).toEqual(before);
  });
  it('moves earlier and later with finite integer layouts and keeps layout extras', () => {
    const tiles = [
      make('a', { x: 0, y: 0, w: 6, h: 3, static: true }),
      make('b', { x: 6, y: 0, w: 6, h: 3 }),
    ];
    const moved = moveTile(tiles, 'b', -1);
    expect(resolvedLayouts(moved).map((row) => row.tile.tile_id)).toEqual(['b', 'a']);
    expect(moved[0].layout).toMatchObject({ static: true });
    expect(moved[0].unknown).toBe('keep');
    expect(moveTile(tiles, 'a', -1)).toBe(tiles);
    expect(resolvedLayouts(moveTile(moved, 'b', 1)).map((row) => row.tile.tile_id)).toEqual([
      'a',
      'b',
    ]);
  });
  it('reads legacy PromQL query, object chartQuery and steps', () => {
    expect(
      promqlQueries({ tile_id: 'x', promqlQuery: { query: 'up', type: 'instant', step: '30s' } }),
    ).toEqual([{ query: 'up', type: 'instant' }]);
    expect(promqlQueries({ tile_id: 'x', chartQuery: { query: 'up' } })).toEqual([
      { query: 'up', type: 'range' },
    ]);
    expect(promqlQueries(classic.tiles[0])[0].type).toBe('range');
    expect(tileStep({ tile_id: 'x', promqlQuery: { step: '30s' } }, 0, 3600, 'up')).toBe('30s');
    expect(tileStep({ tile_id: 'x' }, 0, 3600, 'up')).toBe('15s');
    expect(tileStep({ tile_id: 'x' }, NaN, NaN, 'up')).toBe('60s');
  });
  it('reads builder SQL and derives a legacy histogram without altering the object', () => {
    expect(sqlQuery(classic.tiles[1])).toBe(classic.tiles[1].chartQuery);
    const tile = {
      tile_id: 'x',
      dbName: ['logs'],
      chartQuery: {
        x: { fields: [{ name: 'p_timestamp', type: 'time' }], granularity: 'minute' },
        y: { fields: [{ name: '*', aggregate: 'COUNT' }] },
      },
    };
    const original = structuredClone(tile);
    expect(sqlQuery(tile)).toContain('date_trunc');
    expect(sqlQuery(tile)).toContain('COUNT(*)');
    expect(tile).toEqual(original);
  });
});
