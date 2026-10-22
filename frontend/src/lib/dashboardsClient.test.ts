import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient } from './client';
import classic from '../features/dashboards/__fixtures__/classic.json';
import type { ParseableClient } from './types';
import { checkDashboardConflict, saveDashboardDocument } from '../features/dashboards/helpers';
import { applyTile, dashboardPayload, loadDraft } from '../features/dashboards/draft';
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
  {
    name: 'bodyless favourite update',
    run: (c) => c.setDashboardFavorite('id/with space', true),
    url: `${path}?isFavorite=true`,
    method: 'PUT',
    reply: classic,
  },
  { name: 'delete', run: (c) => c.deleteDashboard('id/with space'), url: path, method: 'DELETE' },
];
afterEach(() => vi.unstubAllGlobals());
describe('dashboard requests', () => {
  it.each(['observed-revision', '"observed-revision"'])(
    'deletes only revision %s using a strong If-Match header',
    async (revision) => {
      const fetch = vi.fn().mockResolvedValue(new Response(''));
      vi.stubGlobal('fetch', fetch);
      await createClient({ mode: 'live' }).deleteDashboard(classic.dashboardId, revision);
      const init = fetch.mock.calls[0][1];
      expect(init.method).toBe('DELETE');
      expect(new Headers(init.headers).get('If-Match')).toBe('"observed-revision"');
      expect(init.body).toBeUndefined();
    },
  );
  it('keeps revision-less legacy deletes and never retries a rejected conditional delete', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(''))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: 'revision_conflict' } }), { status: 412 }),
      );
    vi.stubGlobal('fetch', fetch);
    const client = createClient({ mode: 'live' });
    await client.deleteDashboard(classic.dashboardId);
    expect(new Headers(fetch.mock.calls[0][1].headers).has('If-Match')).toBe(false);
    await expect(client.deleteDashboard(classic.dashboardId, 'stale')).rejects.toMatchObject({
      status: 412,
      message: 'This dashboard changed. Reload and review it before deleting.',
      detail: { error: { code: 'revision_conflict' } },
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each(['server-revision-1', '"server-revision-1"'])(
    'sends revision %s as a strong If-Match ETag and preserves the complete document',
    async (revision) => {
      const body = { ...classic, revision, refreshInterval: 30_000 };
      const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(body)));
      vi.stubGlobal('fetch', fetch);
      await createClient({ mode: 'live' }).updateDashboard(classic.dashboardId, body);
      const init = fetch.mock.calls[0][1];
      expect(new Headers(init.headers).get('If-Match')).toBe('"server-revision-1"');
      expect(JSON.parse(init.body)).toEqual(body);
    },
  );
  it('keeps unconditional legacy requests when a document has no revision', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(classic)));
    vi.stubGlobal('fetch', fetch);
    await createClient({ mode: 'live' }).updateDashboard(classic.dashboardId, classic);
    expect(new Headers(fetch.mock.calls[0][1].headers).has('If-Match')).toBe(false);
  });
  it('shows a 412 conflict and conditions each intentional overwrite on the observed copy', async () => {
    const remote = {
      ...classic,
      revision: 'revision-2',
      title: 'Agent saved',
      future: { kept: true },
    };
    const newer = { ...remote, revision: 'revision-3', title: 'Another concurrent edit' };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('Dashboard changed', { status: 412 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(remote)))
      .mockResolvedValueOnce(new Response('Dashboard changed again', { status: 412 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(newer)))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ...newer, title: 'UI edit', revision: 'revision-4' })),
      );
    vi.stubGlobal('fetch', fetch);
    const client = createClient({ mode: 'live' }),
      signal = new AbortController().signal;
    const first = await saveDashboardDocument(
      client,
      { ...classic, revision: 'revision-1', title: 'UI edit' },
      signal,
    );
    expect(first).toEqual({ conflict: remote });
    const second = await saveDashboardDocument(
      client,
      { ...first.conflict!, title: 'UI edit' },
      signal,
    );
    expect(second).toEqual({ conflict: newer });
    const third = await saveDashboardDocument(
      client,
      { ...second.conflict!, title: 'UI edit' },
      signal,
    );
    expect(third.saved).toMatchObject({
      revision: 'revision-4',
      title: 'UI edit',
      future: { kept: true },
    });
    expect(
      fetch.mock.calls
        .filter(([, init]) => init.method === 'PUT')
        .map(([, init]) => new Headers(init.headers).get('If-Match')),
    ).toEqual(['"revision-1"', '"revision-2"', '"revision-3"']);
  });
  it('loads, edits and saves a complete classic document without narrowing it', async () => {
    const fetch = vi
      .fn()
      .mockImplementation((_url, init) =>
        Promise.resolve(new Response(init?.method === 'PUT' ? init.body : JSON.stringify(classic))),
      );
    vi.stubGlobal('fetch', fetch);
    const client = createClient({ mode: 'live' }),
      loaded = await client.getDashboard(classic.dashboardId);
    const edited = dashboardPayload(
      applyTile(loadDraft(loaded).draft, { ...loaded.tiles![0], title: 'Changed title' }),
      '1h',
      false,
    );
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
