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
    expect(params.get('alertQuery')).not.toContain('$host');
    expect(links.exploreUrl).toContain('/metrics/explore/metrics?');
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
    expect(links.exploreUrl).toContain('/sql-editor?query=');
  });
});
