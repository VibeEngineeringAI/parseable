import { describe, expect, it } from 'vitest';
import type { DashboardTile } from '../../lib/types';
import {
  appendSqlTile,
  createSqlChartConfig,
  executedSqlTile,
  readSqlChartConfig,
} from './sqlChart';
import { classicTimeRange } from '../dashboards/timeRange';
import { ulid } from '../../lib/dashboardsContract';

describe('SQL chart dashboard handoff', () => {
  it('restores supported chart documents and rejects malformed saved data', () => {
    const config = createSqlChartConfig();
    expect(readSqlChartConfig(config)).toEqual(config);
    expect(readSqlChartConfig(config)).not.toBe(config);
    expect(readSqlChartConfig({ ...config, chartType: 'unknown' })).toBeUndefined();
    expect(readSqlChartConfig({ ...config, config: null })).toBeUndefined();
    expect(readSqlChartConfig({ ...config, tile_id: 'invalid' })).toBeUndefined();
  });
  it('saves the executed SQL snapshot and copies chart configuration independently', () => {
    const config: DashboardTile = {
      ...createSqlChartConfig(),
      title: '  Count  ',
      chartQuery: 'unexecuted edit',
      dbName: ['logs'],
    };
    const tile = executedSqlTile(config, 'SELECT count(*) FROM logs');
    expect(tile.chartQuery).toBe('SELECT count(*) FROM logs');
    expect(tile.title).toBe('Count');
    expect(tile.tileType).toBe('code');
    expect(ulid(tile.tile_id)).toBe(true);
    expect(tile.tile_id).not.toBe(config.tile_id);
    expect(tile.config).toEqual(config.config);
    expect(tile.config).not.toBe(config.config);
  });
  it('repairs zero and duplicate legacy IDs before appending while preserving opaque fields', () => {
    const config = createSqlChartConfig();
    const originalTiles = [
      { ...config, tile_id: '00000000000000000000000000', extra: { preserved: true } },
      config,
      { ...config, extra: 'duplicate' },
    ];
    const original = {
      dashboardId: 'legacy',
      title: 'Legacy',
      tiles: originalTiles,
      sections: [{ untouched: true }],
      unknown: { retained: true },
    };
    const result = appendSqlTile(original, executedSqlTile(config, 'SELECT 1'));
    const ids = result.tiles!.map((tile) => tile.tile_id);
    expect(new Set(ids).size).toBe(4);
    expect(ids.every((id) => ulid(id) && id !== '00000000000000000000000000')).toBe(true);
    expect(result.tiles![0].extra).toEqual({ preserved: true });
    expect(result.tiles![2].extra).toBe('duplicate');
    expect(result.sections).toBe(original.sections);
    expect(result.unknown).toBe(original.unknown);
    expect(original.tiles).toEqual(originalTiles);
    expect(original.tiles[0].tile_id).toBe('00000000000000000000000000');
  });
  it('appends without dropping document extras or altering existing tiles and range', () => {
    const existing = {
      ...createSqlChartConfig(),
      layout: { x: 0, y: 0, w: 12, h: 8 },
      opaque: { legacy: true },
    };
    const range = classicTimeRange('1h', { custom: true });
    const dashboard = {
      dashboardId: 'dashboard',
      author: 'owner',
      title: 'Existing',
      modified: 'v1',
      tiles: [existing],
      sections: [{ opaque: true }],
      variables: [{ future: true }],
      timeRange: range,
      unknown: { retained: true },
    };
    const result = appendSqlTile(dashboard, executedSqlTile(createSqlChartConfig(), 'SELECT 1'));
    expect({ ...result, tiles: dashboard.tiles }).toEqual(dashboard);
    expect(result.tiles).toHaveLength(2);
    expect(result.tiles![0]).toBe(existing);
    expect(result.timeRange).toBe(range);
    expect(result.tiles![1].layout).toMatchObject({ y: 8, w: 6, h: 4 });
    expect(dashboard.tiles).toHaveLength(1);
  });
});
