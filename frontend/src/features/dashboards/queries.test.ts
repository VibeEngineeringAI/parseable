import { expect, it, vi } from 'vitest';
import { createLimiter, type QueryLimiter } from '../../lib/concurrency';
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
    promqlQuery: vi.fn().mockResolvedValue({ resultType: 'vector', result: [] }),
    promqlQueryRange: vi.fn().mockResolvedValue({ resultType: 'matrix', result: [] }),
  }) as unknown as ParseableClient;

it.each(tiles)('sends unknown dollar tokens unchanged in a $tileType tile', async (tile) => {
  const client = mockClient();
  await loadTile(client, tile, variables, { host: 'node-a' }, bounds, createLimiter(4), signal);
  if (tile.tileType === 'code')
    expect(client.query).toHaveBeenCalledWith(
      { sql: sql.replace('$host', 'node-a'), ...bounds },
      expect.any(AbortSignal),
    );
  else
    expect(client.promqlQueryRange).toHaveBeenCalledWith(
      expect.objectContaining({ query: promql.replace('$host', 'node-a'), stream: 'metrics' }),
      expect.any(AbortSignal),
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

const run: QueryLimiter = (operation) => operation();
const statTile = (sparkline: boolean, type = 'instant'): DashboardTile => ({
  tile_id: 'stat',
  tileType: 'promql',
  chartType: 'query-value',
  chartQuery: ['up', 'process_cpu_seconds_total'],
  promqlQueryType: [type, 'range'],
  promqlStep: '15s',
  dbName: 'metrics',
  config: { layout: { sparkline } },
});

it.each(['instant', 'range', 'both'])(
  'requests range and instant for only query zero with a sparkline, regardless of stored %s mode',
  async (type) => {
    const client = mockClient();
    const result = await loadTile(client, statTile(true, type), [], {}, bounds, run, signal);
    expect(client.promqlQueryRange).toHaveBeenCalledExactlyOnceWith(
      {
        stream: 'metrics',
        query: 'up',
        start: Date.parse(bounds.startTime) / 1000,
        end: Date.parse(bounds.endTime) / 1000,
        step: '15s',
      },
      expect.any(AbortSignal),
    );
    expect(client.promqlQuery).toHaveBeenCalledTimes(2);
    for (const [index, query] of ['up', 'process_cpu_seconds_total'].entries())
      expect(client.promqlQuery).toHaveBeenNthCalledWith(
        index + 1,
        { stream: 'metrics', query, time: Date.parse(bounds.endTime) / 1000 },
        expect.any(AbortSignal),
      );
    expect(result.promql?.[0]).toMatchObject({
      id: 'A',
      range: { resultType: 'matrix', result: [] },
      instant: { resultType: 'vector', result: [] },
    });
    expect(result.promql?.[1]?.range).toBeUndefined();
    expect(result.promql?.[1]?.instant).toEqual({ resultType: 'vector', result: [] });
  },
);

it.each(['instant', 'range', 'both'])(
  'keeps query values instant-only without a sparkline even with stored %s mode',
  async (type) => {
    const client = mockClient();
    await loadTile(client, statTile(false, type), [], {}, bounds, run, signal);
    expect(client.promqlQueryRange).not.toHaveBeenCalled();
    expect(client.promqlQuery).toHaveBeenCalledTimes(2);
  },
);

it.each([
  ['line', 'instant', 0, 1],
  ['line', 'range', 1, 0],
  ['line', 'both', 1, 1],
  ['gauge', 'both', 0, 1],
] as const)(
  'leaves %s requests unchanged in %s mode with sparkline stored',
  async (chartType, type, ranges, instants) => {
    const client = mockClient();
    const tile = { ...statTile(true), chartType, chartQuery: ['up'], promqlQueryType: [type] };
    await loadTile(client, tile, [], {}, bounds, run, signal);
    expect(client.promqlQueryRange).toHaveBeenCalledTimes(ranges);
    expect(client.promqlQuery).toHaveBeenCalledTimes(instants);
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
        expect.any(AbortSignal),
      );
    else
      expect(client.promqlQueryRange).toHaveBeenCalledWith(
        expect.objectContaining({ query: promql.replace('$host', '$host $other') }),
        expect.any(AbortSignal),
      );
  },
);

it.each(tiles)('forwards cancellation to all dispatched $tileType requests', async (tile) => {
  const controller = new AbortController();
  const signals: AbortSignal[] = [];
  const pending = vi.fn(
    (_request: unknown, requestSignal: AbortSignal) =>
      new Promise((_resolve, reject) => {
        signals.push(requestSignal);
        requestSignal.addEventListener('abort', () => reject(requestSignal.reason), { once: true });
      }),
  );
  const client = {
    ...mockClient(),
    query: pending,
    promqlQuery: pending,
    promqlQueryRange: pending,
  } as unknown as ParseableClient;
  const operation = loadTile(
    client,
    tile,
    variables,
    { host: 'node-a' },
    bounds,
    createLimiter(4),
    controller.signal,
  );
  const reason = new Error('Selection changed');
  const rejected = expect(operation).rejects.toBe(reason);
  await vi.waitFor(() => expect(signals.length).toBeGreaterThan(0));
  controller.abort(reason);
  await rejected;
  expect(signals.every((signal) => signal.aborted && signal.reason === reason)).toBe(true);
});
