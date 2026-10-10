import { describe, expect, it } from 'vitest';
import classic from '../features/dashboards/__fixtures__/classic.json';
import { dashboard, dashboardSummary, dashboardVariable, tile, ulid } from './dashboardsContract';
describe('dashboard wire guards', () => {
  it('accepts all classic tiles and extras without normalizing or stripping anything', () => {
    const copy = structuredClone(classic);
    expect(dashboard(copy)).toBe(true);
    expect(copy).toEqual(classic);
    expect(copy.tiles.every(tile)).toBe(true);
  });
  it.each(['not-an-id', '8ZZZZZZZZZZZZZZZZZZZZZZZZZ', '01JZ8Y3KQ4V9M2X7T5R1B6N0EI', null])(
    'rejects invalid ID %s',
    (id) => {
      expect(ulid(id)).toBe(false);
      expect(dashboard({ ...classic, dashboardId: id })).toBe(false);
    },
  );
  it('allows unknown tile kinds, query shapes and future variable definitions', () => {
    expect(
      tile({
        tile_id: classic.tiles[0].tile_id,
        tileType: 'future',
        chartQuery: { anything: true },
      }),
    ).toBe(true);
    expect(dashboard({ ...classic, tiles: [], variables: [{ type: 'future' }] })).toBe(true);
    expect(dashboard({ ...classic, tiles: null })).toBe(true);
  });
  it('validates known metadata and required snake-case tile IDs', () => {
    expect(dashboard({ ...classic, tiles: [{ tileId: classic.tiles[0].tile_id }] })).toBe(false);
    expect(dashboardSummary({ ...classic, tags: 'x' })).toBe(false);
    expect(dashboardSummary({ ...classic, isFavorite: 'true' })).toBe(false);
    expect(dashboard({ ...classic, tiles: {} })).toBe(false);
  });
  it.each(['promql', 'promql_query', 'sql', 'list', 'text', 'dataset'])(
    'accepts %s variables',
    (type) => {
      expect(dashboardVariable({ name: 'v', label: 'Variable', type })).toBe(true);
    },
  );
});
