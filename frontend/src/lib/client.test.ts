import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, createClient } from './client';

afterEach(() => vi.unstubAllGlobals());
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

describe('live HTTP contract', () => {
  it('uses backend endpoints, cookie credentials, abort signal and Arrow field names', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json([{ name: 'api_logs' }]))
      .mockResolvedValueOnce(
        json({ fields: [{ name: 'p_timestamp' }, { name: 'message' }], metadata: {} }),
      );
    vi.stubGlobal('fetch', fetch);
    const signal = new AbortController().signal;
    const client = createClient({ mode: 'live' });
    expect(await client.listDatasets(signal)).toEqual([{ name: 'api_logs', type: 'logs' }]);
    expect(await client.schema('logs / staging', signal)).toEqual(['p_timestamp', 'message']);
    expect(fetch).toHaveBeenNthCalledWith(1, '/api/v1/logstream', {
      signal,
      credentials: 'include',
    });
    expect(fetch).toHaveBeenNthCalledWith(2, '/api/v1/logstream/logs%20%2F%20staging/schema', {
      signal,
      credentials: 'include',
    });
  });
  it('translates query request into the Rust camelCase contract', async () => {
    const fetch = vi.fn().mockResolvedValue(json([{ message: 'ok', optional: null }]));
    vi.stubGlobal('fetch', fetch);
    const result = await createClient({ mode: 'live' }).query({
      sql: 'SELECT * FROM logs',
      startTime: 'start',
      endTime: 'end',
    });
    expect(result).toEqual([{ message: 'ok', optional: null }]);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('/api/v1/query');
    expect(init.credentials).toBe('include');
    expect(JSON.parse(init.body)).toEqual({
      query: 'SELECT * FROM logs',
      startTime: 'start',
      endTime: 'end',
      sendNull: true,
    });
  });
  it('preserves HTTP status and human readable error bodies', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('Permission denied', { status: 403 })),
    );
    await expect(createClient({ mode: 'live' }).listDatasets()).rejects.toMatchObject({
      name: 'ApiError',
      status: 403,
      message: 'Permission denied',
    });
  });
  it('rejects malformed success responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ records: [] })));
    await expect(
      createClient({ mode: 'live' }).query({ sql: 'select', startTime: '', endTime: '' }),
    ).rejects.toBeInstanceOf(ApiError);
  });
  it('exchanges Basic credentials, then verifies cookie auth without retaining a password', async () => {
    vi.stubGlobal('window', { location: { origin: 'http://localhost:5173' } });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('app'))
      .mockResolvedValueOnce(json([]));
    vi.stubGlobal('fetch', fetch);
    await createClient({ mode: 'live' }).login('admin', 'secret');
    expect(fetch.mock.calls[0][0]).toBe(
      '/api/v1/o/login?redirect=http%3A%2F%2Flocalhost%3A5173%2F',
    );
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe(`Basic ${btoa('admin:secret')}`);
    expect(fetch.mock.calls[1]).toEqual(['/api/v1/logstream', { credentials: 'include' }]);
  });
  it('forwards network and abort failures', async () => {
    const error = new DOMException('Aborted', 'AbortError');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(error));
    await expect(createClient({ mode: 'live' }).listDatasets()).rejects.toBe(error);
  });
});

describe('demo contract', () => {
  it('requires no network and honors cancellation', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const client = createClient({ mode: 'demo' });
    expect(await client.listDatasets()).toHaveLength(3);
    expect(await client.schema('application_logs')).toContain('message');
    const controller = new AbortController();
    controller.abort();
    await expect(client.listDatasets(controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('session and navigation contracts', () => {
  it('prefers the authorized user API identity over cookie display hints', async () => {
    vi.stubGlobal('document', { cookie: 'username=Old%20Name; user_id=team%2Freader' });
    const fetch = vi.fn().mockResolvedValue(
      json({
        id: 'team/reader',
        username: 'Current Name',
        method: 'oauth',
        email: 'reader@example.test',
      }),
    );
    vi.stubGlobal('fetch', fetch);
    const identity = await createClient({ mode: 'live' }).identity();
    expect(identity).toEqual({
      id: 'team/reader',
      username: 'Current Name',
      method: 'oauth',
      email: 'reader@example.test',
      source: 'server',
    });
    expect(fetch).toHaveBeenCalledWith('/api/v1/users/team%2Freader', {
      signal: undefined,
      credentials: 'include',
    });
  });
  it.each([403, 404, 503])(
    'falls back to display cookies when the identity API returns %s',
    async (status) => {
      vi.stubGlobal('document', { cookie: 'username=Reader; user_id=reader' });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Unavailable', { status })));
      expect(await createClient({ mode: 'live' }).identity()).toEqual({
        id: 'reader',
        username: 'Reader',
        source: 'cookie',
      });
    },
  );
  it('does not trust a stale identity cookie after the server returns 401', async () => {
    vi.stubGlobal('document', { cookie: 'username=Reader; user_id=reader' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Expired', { status: 401 })));
    const onUnauthorized = vi.fn();
    await expect(createClient({ mode: 'live', onUnauthorized }).identity()).rejects.toMatchObject({
      status: 401,
    });
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });
  it('notifies session expiry for query requests, but preserves permission errors', async () => {
    const onUnauthorized = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response('Expired', { status: 401 }))
        .mockResolvedValueOnce(new Response('Forbidden', { status: 403 })),
    );
    const client = createClient({ mode: 'live', onUnauthorized });
    await expect(
      client.query({ sql: 'SELECT 1', startTime: '', endTime: '' }),
    ).rejects.toMatchObject({ status: 401 });
    await expect(client.schema('logs')).rejects.toMatchObject({ status: 403 });
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });
  it('accepts a cookie-authenticated login with restricted stream-list permissions', async () => {
    vi.stubGlobal('window', { location: { origin: 'https://logs.example.test' } });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('app'))
      .mockResolvedValueOnce(new Response('Forbidden', { status: 403 }));
    vi.stubGlobal('fetch', fetch);
    await createClient({ mode: 'live' }).login(
      'reader',
      'secret',
      '/sql-editor?dataset=logs#query',
    );
    const url = new URL(fetch.mock.calls[0][0], 'https://logs.example.test');
    expect(url.searchParams.get('redirect')).toBe(
      'https://logs.example.test/sql-editor?dataset=logs#query',
    );
  });
  it('navigates the browser through logout so provider redirects can complete', async () => {
    const assign = vi.fn();
    const fetch = vi.fn();
    vi.stubGlobal('window', { location: { origin: 'https://logs.example.test', assign } });
    vi.stubGlobal('fetch', fetch);
    await createClient({ mode: 'live' }).logout();
    expect(assign).toHaveBeenCalledWith(
      '/api/v1/o/logout?redirect=https%3A%2F%2Flogs.example.test%2Flogin',
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects production demo clients unless the build explicitly enables sample data', async () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('VITE_ENABLE_DEMO', 'false');
    vi.resetModules();
    const { createClient: productionClient } = await import('./client');
    const fetch = vi.fn().mockResolvedValue(json([{ name: 'real_logs' }]));
    vi.stubGlobal('fetch', fetch);
    expect(await productionClient({ mode: 'demo' }).listDatasets()).toEqual([
      { name: 'real_logs', type: 'logs' },
    ]);
    expect(fetch).toHaveBeenCalledOnce();
    vi.unstubAllEnvs();
    vi.resetModules();
  });
});
