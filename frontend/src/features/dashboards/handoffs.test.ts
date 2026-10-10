import { describe, expect, it } from 'vitest';
import classic from './__fixtures__/classic.json';
import { tileHandoffs } from './handoffs';
import { readVariables } from './variables';
const bounds = { startTime: '2026-10-10T00:00:00Z', endTime: '2026-10-10T01:00:00Z' };
describe('tile handoffs', () => {
  it('passes concrete PromQL, dataset and title to alerts and Metrics', () => {
    const links = tileHandoffs(
      classic.tiles[0],
      readVariables(classic.variables),
      { host: 'node-a', metrics_dataset: 'metrics' },
      bounds,
      true,
    );
    const params = new URL(links.alertUrl!, 'https://example.test').searchParams;
    expect(params.get('queryBuilderType')).toBe('promql');
    expect(params.get('dataset')).toBe('metrics');
    expect(params.get('title')).toBe('Host load');
    expect(params.get('alertQuery')).toBe(
      'avg by (host) ({__name__=\"system.cpu.load_average.15m\",host=~\"node-a\"})',
    );
    const explore = new URL(links.exploreUrl!, 'https://example.test');
    expect(explore.pathname).toBe('/metrics/explore/metrics');
    expect(Object.fromEntries(explore.searchParams)).toEqual({
      query: params.get('alertQuery'),
      type: 'range',
      start: bounds.startTime,
      end: bounds.endTime,
    });
  });
  it('disables non-concrete and unavailable PromQL alerts with a reason', () => {
    expect(
      tileHandoffs(
        classic.tiles[0],
        readVariables(classic.variables),
        { host: '.*', metrics_dataset: 'metrics' },
        bounds,
        true,
      ).reason,
    ).toContain('All');
    expect(
      tileHandoffs({ ...classic.tiles[0], chartQuery: ['up', 'up'] }, [], {}, bounds, true)
        .alertUrl,
    ).toBeUndefined();
    expect(tileHandoffs(classic.tiles[0], [], {}, bounds, false).reason).toContain('unavailable');
  });
  it('hands builder SQL to the SQL editor and SQL alert form', () => {
    const links = tileHandoffs(classic.tiles[1], [], {}, bounds, true);
    const params = new URL(links.alertUrl!, 'https://example.test').searchParams;
    expect(params.get('queryBuilderType')).toBe('sql');
    expect(params.get('alertQuery')).toBe(classic.tiles[1].chartQuery);
    const explore = new URL(links.exploreUrl!, 'https://example.test');
    expect(explore.pathname).toBe('/sql-editor');
    expect(Object.fromEntries(explore.searchParams)).toEqual({
      query: classic.tiles[1].chartQuery,
      start: bounds.startTime,
      end: bounds.endTime,
    });
  });
  it('keeps links for queries whose $tokens are not dashboard variables', () => {
    const variables = readVariables(classic.variables);
    const values = { host: 'node-a', metrics_dataset: 'metrics' };
    const tiles = [
      {
        ...classic.tiles[0],
        chartQuery: ['label_replace(up, "host", "$1", "instance", "(.*):.*")'],
      },
      {
        ...classic.tiles[1],
        chartQuery: "SELECT regexp_replace(host, '(\\w+)-\\d+', '$1') FROM \"app-logs\"",
      },
      { ...classic.tiles[1], chartQuery: 'SELECT * FROM "app-logs" WHERE message = \'$1\'' },
    ];
    for (const tile of tiles) {
      const links = tileHandoffs(tile, variables, values, bounds, true);
      expect(links.reason).toBeUndefined();
      expect(links.alertUrl).toBeDefined();
      expect(links.exploreUrl).toBeDefined();
      expect(new URL(links.alertUrl!, 'https://example.test').searchParams.get('alertQuery')).toBe(
        Array.isArray(tile.chartQuery) ? tile.chartQuery[0] : tile.chartQuery,
      );
    }
    expect(tileHandoffs(tiles[2], [], {}, bounds, true).alertUrl).toBeDefined();
  });
  it('disables links when a referenced dashboard variable has no value', () => {
    const links = tileHandoffs(
      classic.tiles[0],
      readVariables(classic.variables),
      { metrics_dataset: 'metrics' },
      bounds,
      true,
    );
    expect(links.reason).toBe('Alerts require one concrete query and dataset.');
    expect(links.alertUrl).toBeUndefined();
    expect(links.exploreUrl).toBeUndefined();
    expect(
      tileHandoffs(
        classic.tiles[0],
        readVariables(classic.variables),
        { host: 'node-a' },
        bounds,
        true,
      ).exploreUrl,
    ).toBeUndefined();
  });
});
