import { describe, expect, it } from 'vitest';
import classic from './__fixtures__/classic.json';
import {
  appendLayout,
  moveTile,
  promqlQueries,
  resolvedLayouts,
  sqlQuery,
  tileStep,
  tileVariableNames,
} from './tiles';
import type { DashboardTile, DashboardVariable } from '../../lib/types';
const variables: DashboardVariable[] = ['dataset', 'level', 'host', 'zone'].map((name) => ({
  name,
  label: name,
  type: 'text',
}));
const make = (id: string, layout: unknown): DashboardTile => ({
  tile_id: id,
  layout,
  unknown: 'keep',
});
describe('classic tile helpers', () => {
  it('tracks only variables used in the tile query and dataset', () => {
    expect([
      ...tileVariableNames(
        {
          tile_id: 'x',
          tileType: 'code',
          chartQuery: 'SELECT * FROM "$dataset" WHERE level=\'${level}\'',
          dbName: ['$dataset'],
        },
        variables,
      ),
    ]).toEqual(['dataset', 'level']);
    expect([
      ...tileVariableNames(
        {
          tile_id: 'x',
          tileType: 'promql',
          chartQuery: ['up{host="$host"}', 'rate(up{zone="${zone}"}[5m])'],
          dbName: '$dataset',
        },
        variables,
      ),
    ]).toEqual(['host', 'zone', 'dataset']);
    expect([...tileVariableNames(classic.tiles[1], variables)]).toEqual([]);
  });
  it('counts only defined names, leaving replacement groups, SQL literals and built-in tokens alone', () => {
    const promql = {
      tile_id: 'promql',
      tileType: 'promql',
      chartQuery: ['label_replace(up{host="$host"}, "copy", "$1", "host", "(.*)$") + $__interval'],
      dbName: '$dataset',
    };
    const sql = {
      tile_id: 'sql',
      tileType: 'code',
      chartQuery:
        "SELECT '$ $1 $unknown ${missing} $__interval' FROM $dataset WHERE level='$level'",
    };
    expect([...tileVariableNames(promql, variables)]).toEqual(['host', 'dataset']);
    expect([...tileVariableNames(sql, variables)]).toEqual(['dataset', 'level']);
    expect([...tileVariableNames(promql, [])]).toEqual([]);
    expect([...tileVariableNames(sql, [])]).toEqual([]);
    expect([...tileVariableNames(promql, [{ name: '1', label: 'One', type: 'text' }])]).toEqual([
      '1',
    ]);
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
    expect(sqlQuery({ ...tile, chartType: 'timeseries' })).toBe(
      'SELECT DATE_TRUNC(\'minute\', \"p_timestamp\") AS \"time_bucket\", COUNT(*) AS \"COUNT_STAR\" FROM \"logs\" GROUP BY \"time_bucket\" ORDER BY \"time_bucket\" DESC',
    );
    expect(tile).toEqual(original);
  });
});
