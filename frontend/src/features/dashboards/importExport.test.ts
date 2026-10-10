import { describe, expect, it } from 'vitest';
import classic from './__fixtures__/classic.json';
import { exportDashboard, importDashboard } from './importExport';
import { ulid } from '../../lib/dashboardsContract';
describe('classic portable JSON', () => {
  it('exports exactly the classic keys and removes only tile IDs', () => {
    const result = exportDashboard(classic);
    expect(Object.keys(result)).toEqual(['tags', 'variables', 'sections', 'tiles']);
    expect(result.tiles[0]).not.toHaveProperty('tile_id');
    expect(result.tiles[0].unknownTile).toEqual({ keep: true });
    expect(result.variables).toEqual(classic.variables);
  });
  it('imports promql_query, empty tiles, saved timeRange and unknown fields', () => {
    const result = importDashboard(JSON.stringify(classic), 'Imported');
    expect(result.title).toBe('Imported');
    expect(result.variables).toEqual(classic.variables);
    expect(result.timeRange).toEqual(classic.timeRange);
    expect(result.future).toEqual(classic.future);
    expect(result).not.toHaveProperty('tenantId');
    expect(result.dashboardType).toBe('Report');
    expect(result.tiles?.every((tile) => ulid(tile.tile_id))).toBe(true);
    expect(result.tiles?.[0].tile_id).not.toBe(classic.tiles[0].tile_id);
    expect(importDashboard('{"tiles":[],"variables":[]}', 'Empty').tiles).toEqual([]);
  });
  it('fixes null/missing append positions to finite integers and assigns unique IDs', () => {
    const result = importDashboard(
      JSON.stringify({
        tiles: [
          { layout: { x: 0, y: 0, w: 6, h: 3 } },
          { layout: { x: 0, y: null, w: 6, h: 3, future: true } },
          {},
        ],
      }),
      'Append',
    );
    expect(result.tiles?.map((tile) => (tile.layout as { y: number }).y)).toEqual([0, 3, 6]);
    expect(result.tiles?.[1].layout).toMatchObject({ future: true });
    expect(new Set(result.tiles?.map((tile) => tile.tile_id)).size).toBe(3);
  });
  it.each([
    'not json',
    '{}',
    '{"tiles":[null]}',
    '{"tiles":[],"tags":"bad"}',
    '{"tiles":[],"variables":[{"type":"promql_query"}]}',
  ])('rejects invalid imports: %s', (json) =>
    expect(() => importDashboard(json, 'Title')).toThrow(),
  );
});
