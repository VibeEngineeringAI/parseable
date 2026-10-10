import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient } from './client';
import classic from '../features/dashboards/__fixtures__/classic.json';
import type { ParseableClient } from './types';
import { checkDashboardConflict } from '../features/dashboards/helpers';
import { patchTile } from '../features/dashboards/tiles';
const path = '/api/v1/dashboards/id%2Fwith%20space';
const cases: Array<{
  name: string;
  run: (c: ParseableClient, s: AbortSignal) => Promise<unknown>;
  url: string;
  method?: string;
  body?: unknown;
  reply?: unknown;
  read?: boolean;
}> = [
  {
    name: 'list',
    run: (c, s) => c.listDashboards(s),
    url: '/api/v1/dashboards?limit=0',
    reply: [classic],
    read: true,
  },
  {
    name: 'get',
    run: (c, s) => c.getDashboard('id/with space', s),
    url: path,
    reply: classic,
    read: true,
  },
  {
    name: 'create',
    run: (c) => c.createDashboard(classic),
    url: '/api/v1/dashboards',
    method: 'POST',
    body: classic,
    reply: classic,
  },
  {
    name: 'full-document update',
    run: (c) => c.updateDashboard('id/with space', classic),
    url: path,
    method: 'PUT',
    body: classic,
    reply: classic,
  },
  { name: 'delete', run: (c) => c.deleteDashboard('id/with space'), url: path, method: 'DELETE' },
];
afterEach(() => vi.unstubAllGlobals());
describe('dashboard requests', () => {
  it('loads, edits and saves a complete classic document without narrowing it', async () => {
    const fetch = vi
      .fn()
      .mockImplementation((_url, init) =>
        Promise.resolve(new Response(init?.method === 'PUT' ? init.body : JSON.stringify(classic))),
      );
    vi.stubGlobal('fetch', fetch);
    const client = createClient({ mode: 'live' }),
      loaded = await client.getDashboard(classic.dashboardId);
    const edited = patchTile(loaded, loaded.tiles![0].tile_id, { title: 'Changed title' });
    expect(
      await checkDashboardConflict(client, loaded, new AbortController().signal),
    ).toBeUndefined();
    const saved = await client.updateDashboard(loaded.dashboardId, edited);
    const expected = structuredClone(classic);
    expected.tiles[0].title = 'Changed title';
    expect(saved).toEqual(expected);
    expect(JSON.parse(fetch.mock.calls[2][1].body)).toEqual(expected);
    expect(fetch.mock.calls.map(([, init]) => init?.method ?? 'GET')).toEqual([
      'GET',
      'GET',
      'PUT',
    ]);
  });
  it.each(cases)(
    '$name uses the classic contract, credentials and read abort signals',
    async (entry) => {
      const fetch = vi
        .fn()
        .mockResolvedValue(new Response(entry.reply ? JSON.stringify(entry.reply) : ''));
      vi.stubGlobal('fetch', fetch);
      const signal = new AbortController().signal;
      await entry.run(createClient({ mode: 'live' }), signal);
      const [url, init] = fetch.mock.calls[0];
      expect(url).toBe(entry.url);
      expect(init.credentials).toBe('include');
      expect(init.method ?? 'GET').toBe(entry.method ?? 'GET');
      expect(init.signal).toBe(entry.read ? signal : undefined);
      if (entry.body) expect(JSON.parse(init.body)).toEqual(entry.body);
      else expect(init.body).toBeUndefined();
      expect(fetch).toHaveBeenCalledOnce();
    },
  );
  it.each(cases)(
    '$name preserves 400 and 403 plain-text failures; 401 recovers the session',
    async (entry) => {
      for (const status of [400, 401, 403]) {
        const onUnauthorized = vi.fn();
        vi.stubGlobal(
          'fetch',
          vi
            .fn()
            .mockResolvedValue(
              new Response(
                'Cannot perform this operation: Dashboard does not exist or user is not authorized',
                { status },
              ),
            ),
        );
        await expect(
          entry.run(createClient({ mode: 'live', onUnauthorized }), new AbortController().signal),
        ).rejects.toMatchObject({
          status,
          message:
            'Cannot perform this operation: Dashboard does not exist or user is not authorized',
        });
        expect(onUnauthorized).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
      }
    },
  );
  it.each(cases.filter((c) => c.reply))('$name rejects a malformed success', async (entry) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}')));
    await expect(
      entry.run(createClient({ mode: 'live' }), new AbortController().signal),
    ).rejects.toMatchObject({ status: 502 });
  });
  it.each(['promqlDashboard', 'promqlMetadata'])(
    'requires explicit boolean %s capability',
    async (key) => {
      for (const [value, expected] of [
        [undefined, false],
        [false, false],
        [true, true],
      ] as const) {
        vi.stubGlobal(
          'fetch',
          vi
            .fn()
            .mockResolvedValue(
              new Response(
                JSON.stringify({ license: { plan: 'Enterprise' }, capabilities: { [key]: value } }),
              ),
            ),
        );
        expect(
          (await createClient({ mode: 'live' }).about()).capabilities[
            key as 'promqlDashboard' | 'promqlMetadata'
          ],
        ).toBe(expected);
      }
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValue(new Response(JSON.stringify({ capabilities: { [key]: 'true' } }))),
      );
      await expect(createClient({ mode: 'live' }).about()).rejects.toMatchObject({ status: 502 });
    },
  );
});
