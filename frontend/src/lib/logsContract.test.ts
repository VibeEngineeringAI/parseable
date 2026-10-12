import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, createClient } from './client';
import { createDemoClient, createDemoRecords } from './demo';
import { demoLogContext, logContextResponse, savedLogView } from './logsContract';
import type { LogContextRequest, SavedLogView } from './logsContract';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const body: SavedLogView = {
  filter_name: 'Production errors',
  stream_name: 'application_logs',
  query: {
    filter_type: 'sql',
    filter_query: 'SELECT * FROM application_logs',
    filter_builder: null,
  },
  time_filter: { from: 'now-15m', to: 'now' },
  custom: { pinned: true },
  version: 'v2',
  tenant_id: null,
};
const now = Date.parse('2026-10-12T10:15:42.123Z');
const rows = createDemoRecords(now);
const contextRequest: LogContextRequest = {
  dataset: 'application_logs',
  pTimestamp: String(rows[50].p_timestamp),
  message: String(rows[50].message),
  contextWindow: '15m',
  pageSize: 10,
};
const context = () => demoLogContext(contextRequest, rows, now);

describe('saved view HTTP contract', () => {
  it('uses array GET, JSON POST/PUT and bodyless DELETE, preserving metadata', async () => {
    const saved = { ...body, filter_id: 'server-id', extra: ['retained'] };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json([saved]))
      .mockResolvedValueOnce(json(saved))
      .mockResolvedValueOnce(json(saved))
      .mockResolvedValueOnce(new Response(null));
    vi.stubGlobal('fetch', fetch);
    const client = createClient({ mode: 'live' }),
      signal = new AbortController().signal;
    expect(await client.listLogViews(signal)).toEqual([saved]);
    expect(await client.createLogView(body)).toEqual(saved);
    expect(await client.updateLogView('id /?#', saved)).toEqual(saved);
    await client.deleteLogView('id /?#');
    expect(fetch.mock.calls[0]).toEqual(['/api/v1/filters', { signal, credentials: 'include' }]);
    for (const [index, method, payload] of [
      [1, 'POST', body],
      [2, 'PUT', saved],
    ] as const) {
      const [url, init] = fetch.mock.calls[index];
      expect(url).toBe(index === 1 ? '/api/v1/filters' : '/api/v1/filters/id%20%2F%3F%23');
      expect(init).toMatchObject({
        method,
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      });
      expect(JSON.parse(init.body)).toEqual(payload);
    }
    expect(fetch.mock.calls[3]).toEqual([
      '/api/v1/filters/id%20%2F%3F%23',
      { method: 'DELETE', credentials: 'include' },
    ]);
  });
  it.each([
    {},
    { filters: [] },
    [null],
    [{ ...body, query: { filter_type: 'unknown' } }],
    [{ ...body, query: { filter_type: ['sql'] } }],
  ])('rejects malformed lists %j', async (value) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(value)));
    await expect(createClient({ mode: 'live' }).listLogViews()).rejects.toMatchObject({
      status: 502,
    });
  });
  it.each(['create', 'update'] as const)('validates %s responses', async (method) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(json({ ...body, time_filter: { from: 5, to: 'now' } })),
    );
    const client = createClient({ mode: 'live' });
    await expect(
      method === 'create' ? client.createLogView(body) : client.updateLogView('id', body),
    ).rejects.toBeInstanceOf(ApiError);
  });
  it('validates nested builder rules without losing opaque metadata', () => {
    const builder = {
      id: 'root',
      combinator: 'or',
      rules: [
        {
          id: 'group',
          combinator: 'and',
          rules: [{ id: 'rule', field: 'message', operator: 'ilike', value: '%fail%' }],
        },
      ],
    };
    expect(
      savedLogView({ ...body, query: { filter_type: 'filter', filter_builder: builder } }),
    ).toBe(true);
    expect(
      savedLogView({
        ...body,
        query: {
          filter_type: 'filter',
          filter_builder: { ...builder, rules: [{ rules: [null] }] },
        },
      }),
    ).toBe(false);
  });
});

describe('context HTTP contract', () => {
  it('forwards camelCase request, conditions, cookie auth, signal, and continuation payloads', async () => {
    const response = context();
    const fetch = vi.fn().mockResolvedValue(json(response));
    vi.stubGlobal('fetch', fetch);
    const signal = new AbortController().signal;
    const request = {
      ...contextRequest,
      conditions: {
        operator: 'and' as const,
        conditionConfig: [
          { column: 'level', operator: '=' as const, value: 'ERROR', type: 'string' },
        ],
      },
    };
    expect(await createClient({ mode: 'live' }).logContext(request, signal)).toEqual(response);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('/api/v1/query/context');
    expect(init).toMatchObject({
      method: 'POST',
      credentials: 'include',
      signal,
      headers: { 'Content-Type': 'application/json' },
    });
    expect(JSON.parse(init.body)).toEqual(request);
    expect(response.queries.previous?.reverseRecords).toBe(true);
    expect(response.queries.next?.reverseRecords).toBe(false);
  });
  it.each([
    { scope: 'dataset' },
    { anchorIndex: -1 },
    { anchorIndex: 10 },
    { anchorIndex: 1.5 },
    { limit: 0 },
    { limit: 501 },
    { duplicateAnchorCount: 0 },
    { anchoredDuplicate: 'last' },
    { records: [null] },
    { records: [{}] },
    { records: [] },
    { contextStartTime: 'invalid' },
    { queries: {} },
    { queries: { previous: { query: 'SELECT *' }, next: null } },
    { queries: { previous: null, next: { ...context().queries.next, reverseRecords: 'false' } } },
  ])('rejects malformed context %j', async (patch) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ ...context(), ...patch })));
    await expect(createClient({ mode: 'live' }).logContext(contextRequest)).rejects.toMatchObject({
      status: 502,
    });
  });
  it('rejects non-JSON success, preserves error responses and abort failures', async () => {
    const abort = new DOMException('Aborted', 'AbortError');
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('not json'))
      .mockResolvedValueOnce(new Response('Anchor missing', { status: 400 }))
      .mockRejectedValueOnce(abort);
    vi.stubGlobal('fetch', fetch);
    const client = createClient({ mode: 'live' });
    await expect(client.logContext(contextRequest)).rejects.toMatchObject({ status: 502 });
    await expect(client.logContext(contextRequest)).rejects.toMatchObject({
      status: 400,
      message: 'Anchor missing',
    });
    await expect(client.logContext(contextRequest)).rejects.toBe(abort);
  });
});

describe('demo log contracts', () => {
  it('keeps saved views per client in memory and returns isolated copies', async () => {
    vi.stubGlobal('fetch', vi.fn());
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => {
        throw new Error('No storage');
      }),
      setItem: vi.fn(() => {
        throw new Error('No storage');
      }),
    });
    const client = createDemoClient(),
      other = createDemoClient();
    const saved = await client.createLogView(body);
    expect(saved.filter_id).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    expect(await other.listLogViews()).toEqual([]);
    saved.custom = 'mutated';
    expect((await client.listLogViews())[0].custom).toEqual({ pinned: true });
    const updated = await client.updateLogView(saved.filter_id!, {
      ...body,
      filter_name: 'Updated',
      filter_id: 'ignored',
    });
    expect(updated.filter_id).toBe(saved.filter_id);
    expect(updated.custom).toEqual(body.custom);
    await client.deleteLogView(saved.filter_id!);
    expect(await client.listLogViews()).toEqual([]);
    await expect(client.deleteLogView('missing')).rejects.toMatchObject({ status: 400 });
  });
  it('uses existing sample records, nearest neighbors, balanced pages, and cancellation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now + 1000);
    const client = createDemoClient();
    const response = await client.logContext(contextRequest);
    expect(response.records).toEqual(rows.slice(45, 55));
    expect(response.anchorIndex).toBe(5);
    expect(response.duplicateAnchorCount).toBe(1);
    expect(logContextResponse(response)).toBe(true);
    const controller = new AbortController();
    controller.abort();
    await expect(client.logContext(contextRequest, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    await expect(client.listLogViews(controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
  it('balances at dataset edges, caps page size and respects exclusive upper bounds', () => {
    expect(
      demoLogContext(
        {
          ...contextRequest,
          pTimestamp: String(rows[0].p_timestamp),
          message: String(rows[0].message),
        },
        rows,
      ).records,
    ).toEqual(rows.slice(0, 10));
    const last = demoLogContext(
      {
        ...contextRequest,
        pTimestamp: String(rows[99].p_timestamp),
        message: String(rows[99].message),
      },
      rows,
    );
    expect(last.anchorIndex).toBe(9);
    expect(last.records).toEqual(rows.slice(90));
    expect(demoLogContext({ ...contextRequest, pageSize: 999 }, rows).limit).toBe(500);
    expect(demoLogContext({ ...contextRequest, pageSize: 1 }, rows).records).toEqual([rows[50]]);
    expect(() =>
      demoLogContext(
        {
          ...contextRequest,
          contextWindow: undefined,
          contextStartTime: String(rows[99].p_timestamp),
          contextEndTime: contextRequest.pTimestamp,
        },
        rows,
      ),
    ).toThrow('within the context bounds');
  });
  it('anchors the first duplicate and sorts timestamp ties by the match field', () => {
    const records = [
      { p_timestamp: '2026-10-12T10:15:00Z', message: 'z' },
      { p_timestamp: '2026-10-12T10:15:00Z', message: 'anchor', copy: 1 },
      { p_timestamp: '2026-10-12T10:15:00Z', message: 'a' },
      { p_timestamp: '2026-10-12T10:15:00Z', message: 'anchor', copy: 2 },
    ];
    const response = demoLogContext(
      {
        dataset: 'logs',
        pTimestamp: records[0].p_timestamp,
        message: 'anchor',
        contextWindow: '1m',
        pageSize: 4,
      },
      records,
    );
    expect(response.anchorIndex).toBe(1);
    expect(response.duplicateAnchorCount).toBe(2);
    expect(response.records.map((row) => row.message)).toEqual(['a', 'anchor', 'anchor', 'z']);
    expect(response.records[response.anchorIndex].copy).toBe(1);
    expect(response.queries.previous?.query).toContain('"message" <');
    expect(response.queries.next?.query).toContain('"message" >');
  });
  it.each([
    { message: 'missing' },
    { message: undefined },
    { body: 'unsupported' },
    { pTimestamp: 'bad time' },
    { pTimestamp: 'now' },
    { pTimestamp: '5' },
    { pageSize: 0 },
    { pageSize: 1.5 },
    { contextWindow: '0m' },
    { contextWindow: 'bad' },
    { contextStartTime: 'now-15m' },
    { contextWindow: undefined, contextStartTime: 'now-15m' },
    {
      conditions: {
        conditionConfig: [{ column: 'level', operator: '=' as const, value: 'ERROR' }],
      },
    },
  ])('rejects missing/unsupported anchors and invalid requests %j', (patch) => {
    expect(() => demoLogContext({ ...contextRequest, ...patch }, rows, now)).toThrow(ApiError);
  });
  it('rejects missing and unsupported sample datasets', async () => {
    const client = createDemoClient();
    for (const dataset of ['missing', 'demo_metrics'])
      await expect(client.logContext({ ...contextRequest, dataset })).rejects.toMatchObject({
        status: 400,
      });
  });
});
