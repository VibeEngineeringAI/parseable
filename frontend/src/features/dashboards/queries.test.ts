import { expect, it, vi } from 'vitest';
import { createLimiter } from '../../lib/concurrency';
import type { DashboardTile, DashboardVariable, ParseableClient } from '../../lib/types';
import { loadTile } from './queries';
import type { VariableValues } from './variables';

const bounds = { startTime: '2026-10-10T00:00:00Z', endTime: '2026-10-10T01:00:00Z' };
const signal = new AbortController().signal;
const variables: DashboardVariable[] = [{ name: 'host', label: 'Host', type: 'text' }];
const sql = "SELECT '$ $1 $unknown ${missing} $__interval', '$host' FROM logs";
const promql = 'label_replace(up{host="$host"}, "copy", "$1", "host", "(.*)$") + $__interval';
const tiles: DashboardTile[] = [
  { tile_id: 'sql', tileType: 'code', chartQuery: sql, dbName: ['logs'] },
  { tile_id: 'promql', tileType: 'promql', chartQuery: [promql], dbName: 'metrics' },
];
const mockClient = () =>
  ({
    query: vi.fn().mockResolvedValue([{ events: 12 }]),
    promqlQueryRange: vi.fn().mockResolvedValue({ resultType: 'matrix', result: [] }),
  }) as unknown as ParseableClient;

it.each(tiles)('sends unknown dollar tokens unchanged in a $tileType tile', async (tile) => {
  const client = mockClient();
  await loadTile(client, tile, variables, { host: 'node-a' }, bounds, createLimiter(4), signal);
  if (tile.tileType === 'code')
    expect(client.query).toHaveBeenCalledWith(
      { sql: sql.replace('$host', 'node-a'), ...bounds },
      signal,
    );
  else
    expect(client.promqlQueryRange).toHaveBeenCalledWith(
      expect.objectContaining({ query: promql.replace('$host', 'node-a'), stream: 'metrics' }),
      signal,
    );
});
it.each(tiles)(
  'still blocks missing values of defined variables in a $tileType tile',
  async (tile) => {
    const client = mockClient();
    for (const values of [{}, { host: [] }] as VariableValues[])
      await expect(
        loadTile(client, tile, variables, values, bounds, createLimiter(4), signal),
      ).rejects.toThrow('Select values for all query variables.');
    expect(client.query).not.toHaveBeenCalled();
    expect(client.promqlQueryRange).not.toHaveBeenCalled();
  },
);
it.each(tiles)(
  'does not interpret tokens inside a selected value again in a $tileType tile',
  async (tile) => {
    const client = mockClient();
    await loadTile(
      client,
      tile,
      variables,
      { host: '$host $other' },
      bounds,
      createLimiter(4),
      signal,
    );
    if (tile.tileType === 'code')
      expect(client.query).toHaveBeenCalledWith(
        { sql: sql.replace('$host', '$host $other'), ...bounds },
        signal,
      );
    else
      expect(client.promqlQueryRange).toHaveBeenCalledWith(
        expect.objectContaining({ query: promql.replace('$host', '$host $other') }),
        signal,
      );
  },
);
