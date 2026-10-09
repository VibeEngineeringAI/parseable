import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient, promqlErrorType } from './client';
import type { ParseableClient } from './types';

afterEach(() => vi.unstubAllGlobals());
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const success = (data: unknown, warnings?: unknown) =>
  json({ status: 'success', data, ...(warnings === undefined ? {} : { warnings }) });
const vector = {
  resultType: 'vector',
  result: [{ metric: { __name__: 'cpu', host: 'a' }, value: [1700000000.123, '2.5'] }],
};
const matrix = {
  resultType: 'matrix',
  result: [
    {
      metric: { host: 'a' },
      values: [
        [1700000000.123, 'NaN'],
        [1700000015, '+Inf'],
        [1700000030, '-Inf'],
      ],
    },
  ],
};
const request = { stream: 'metrics / production', query: '{"system.cpu.load_average.1m"}' };
const range = { ...request, start: 1700000000.1234, end: 1700000015.9876, step: '15s' };
const calls: Array<{
  name: string;
  run: (client: ParseableClient, signal?: AbortSignal) => Promise<unknown>;
}> = [
  { name: 'instant', run: (client, signal) => client.promqlQuery(request, signal) },
  { name: 'range', run: (client, signal) => client.promqlQueryRange(range, signal) },
  {
    name: 'labels',
    run: (client, signal) => client.promqlLabels({ stream: request.stream }, signal),
  },
  {
    name: 'values',
    run: (client, signal) =>
      client.promqlLabelValues('service.name', { stream: request.stream }, signal),
  },
];

describe('PromQL HTTP requests', () => {
  it.each([
    [
      'instant',
      '/prometheus/api/v1/query',
      { stream: request.stream, query: request.query, time: '1700000000.123' },
    ],
    [
      'range',
      '/prometheus/api/v1/query_range',
      {
        stream: request.stream,
        query: request.query,
        start: '1700000000.123',
        end: '1700000015.988',
        step: '15s',
      },
    ],
  ] as const)('posts %s queries as a form at the server root', async (kind, endpoint, params) => {
    const fetch = vi.fn().mockResolvedValue(success(kind === 'instant' ? vector : matrix));
    vi.stubGlobal('fetch', fetch);
    const client = createClient({ mode: 'live' });
    const signal = new AbortController().signal;
    if (kind === 'instant') await client.promqlQuery({ ...request, time: 1700000000.1234 }, signal);
    else await client.promqlQueryRange(range, signal);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(endpoint);
    expect(init).toMatchObject({
      method: 'POST',
      signal,
      credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    expect(init.body).toBeInstanceOf(URLSearchParams);
    expect(Object.fromEntries(init.body)).toEqual(params);
  });
  it('omits absent time and sends long queries in the body', async () => {
    const fetch = vi.fn().mockResolvedValue(success(vector));
    vi.stubGlobal('fetch', fetch);
    const query = 'cpu{' + 'label="' + 'x'.repeat(3000) + '"}';
    await createClient({ mode: 'live' }).promqlQuery({ ...request, query });
    expect(fetch.mock.calls[0][0]).toBe('/prometheus/api/v1/query');
    expect([...fetch.mock.calls[0][1].body]).toEqual([
      ['stream', request.stream],
      ['query', query],
    ]);
  });
  it.each(['labels', 'values'])(
    'gets %s metadata with repeated match[] and only metadata params',
    async (kind) => {
      const fetch = vi.fn().mockResolvedValue(success(['a']));
      vi.stubGlobal('fetch', fetch);
      const client = createClient({ mode: 'live' });
      const signal = new AbortController().signal;
      const params = {
        stream: request.stream,
        start: 1.0004,
        end: 4.9996,
        match: ['{__name__="cpu"}', '{"process.memory.usage"}'],
        limit: 1000,
      };
      if (kind === 'labels') await client.promqlLabels(params, signal);
      else await client.promqlLabelValues('service.name / region', params, signal);
      const [endpoint, init] = fetch.mock.calls[0];
      const url = new URL(endpoint, 'http://localhost');
      expect(url.pathname).toBe(
        kind === 'labels'
          ? '/prometheus/api/v1/labels'
          : '/prometheus/api/v1/label/service.name%20%2F%20region/values',
      );
      expect([...url.searchParams]).toEqual([
        ['stream', request.stream],
        ['start', '1'],
        ['end', '5'],
        ['limit', '1000'],
        ['match[]', params.match[0]],
        ['match[]', params.match[1]],
      ]);
      expect(init).toEqual({ signal, credentials: 'include' });
    },
  );
  it('omits every optional metadata parameter and preserves limit zero', async () => {
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(success([])));
    vi.stubGlobal('fetch', fetch);
    const client = createClient({ mode: 'live' });
    await client.promqlLabels({ stream: 'cpu' });
    await client.promqlLabelValues('__name__', { stream: 'cpu', limit: 0 });
    expect(fetch.mock.calls[0][0]).toBe('/prometheus/api/v1/labels?stream=cpu');
    expect(fetch.mock.calls[1][0]).toBe(
      '/prometheus/api/v1/label/__name__/values?stream=cpu&limit=0',
    );
  });
});

describe('PromQL response contracts', () => {
  it.each([
    vector,
    matrix,
    { resultType: 'scalar', result: [1700000000, '2'] },
    { resultType: 'string', result: [1700000000, 'hello'] },
    { resultType: 'vector', result: [] },
  ])('accepts instant result %# without changing sample strings', async (data) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(success(data)));
    expect(await createClient({ mode: 'live' }).promqlQuery(request)).toEqual(data);
  });
  it('accepts range matrices and recognizes truncation warnings on metadata', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(success(matrix))
        .mockResolvedValueOnce(
          success(['cpu'], ['metadata results truncated to the requested limit']),
        )
        .mockResolvedValueOnce(success(['host'])),
    );
    const client = createClient({ mode: 'live' });
    expect(await client.promqlQueryRange(range)).toEqual(matrix);
    expect(await client.promqlLabelValues('__name__', { stream: 'cpu' })).toEqual({
      data: ['cpu'],
      truncated: true,
    });
    expect(await client.promqlLabels({ stream: 'cpu' })).toEqual({
      data: ['host'],
      truncated: false,
    });
  });
  it.each([
    null,
    {},
    { status: 'other', data: vector },
    { status: 'success' },
    { status: 'success', data: vector, warnings: [1] },
    {
      status: 'success',
      data: { resultType: 'vector', result: [{ metric: { host: 1 }, value: [1, '2'] }] },
    },
    {
      status: 'success',
      data: { resultType: 'vector', result: [{ metric: [], value: [1, '2'] }] },
    },
    {
      status: 'success',
      data: { resultType: 'vector', result: [{ metric: {}, value: ['1', '2'] }] },
    },
    { status: 'success', data: { resultType: 'vector', result: [{ metric: {}, value: [1, 2] }] } },
    {
      status: 'success',
      data: { resultType: 'matrix', result: [{ metric: {}, values: [[1, '2', 'extra']] }] },
    },
    { status: 'success', data: { resultType: 'scalar', result: [null, '2'] } },
    { status: 'success', data: { resultType: 'string', result: [1] } },
    { status: 'success', data: { resultType: 'histogram', result: [] } },
    { status: 'error', error: 2, errorType: 'execution' },
  ])('rejects malformed instant envelope %# with 502', async (body) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(body)));
    await expect(createClient({ mode: 'live' }).promqlQuery(request)).rejects.toMatchObject({
      status: 502,
    });
  });
  it('rejects non-finite numeric timestamps from valid JSON overflow and invalid JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response('{"status":"success","data":{"resultType":"scalar","result":[1e400,"2"]}}'),
        )
        .mockResolvedValueOnce(new Response('not json')),
    );
    const client = createClient({ mode: 'live' });
    await expect(client.promqlQuery(request)).rejects.toMatchObject({ status: 502 });
    await expect(client.promqlQuery(request)).rejects.toMatchObject({ status: 502 });
  });
  it('rejects a vector range response and non-string metadata', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(success(vector))
        .mockResolvedValueOnce(success(['ok', 1]))
        .mockResolvedValueOnce(success({ data: ['ok'] })),
    );
    const client = createClient({ mode: 'live' });
    await expect(client.promqlQueryRange(range)).rejects.toMatchObject({ status: 502 });
    await expect(client.promqlLabels({ stream: 'cpu' })).rejects.toMatchObject({ status: 502 });
    await expect(client.promqlLabelValues('host', { stream: 'cpu' })).rejects.toMatchObject({
      status: 502,
    });
  });
  it.each(calls)(
    '$name maps JSON forbidden 401 to permission denied without expiring the session',
    async ({ run }) => {
      const onUnauthorized = vi.fn();
      const detail = {
        status: 'error',
        errorType: 'forbidden',
        error: 'No access to this dataset',
      };
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(detail, 401)));
      const error = await run(createClient({ mode: 'live', onUnauthorized })).catch(
        (error) => error,
      );
      expect(error).toMatchObject({ status: 403, message: detail.error, detail });
      expect(promqlErrorType(error)).toBe('forbidden');
      expect(onUnauthorized).not.toHaveBeenCalled();
    },
  );
  it.each(calls)('$name still notifies on a plain-text session 401', async ({ run }) => {
    const onUnauthorized = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('Session expired', { status: 401 })),
    );
    await expect(run(createClient({ mode: 'live', onUnauthorized }))).rejects.toMatchObject({
      status: 401,
      message: 'Session expired',
    });
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });
  it.each([200, 422, 503])('preserves server error and errorType for HTTP %s', async (status) => {
    const detail = {
      status: 'error',
      errorType: 'execution',
      error: 'unsupported PromQL: histogram_quantile',
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(detail, status)));
    const error = await createClient({ mode: 'live' })
      .promqlQuery(request)
      .catch((error) => error);
    expect(error).toMatchObject({
      status: status === 200 ? 422 : status,
      message: detail.error,
      detail,
    });
    expect(promqlErrorType(error)).toBe('execution');
    expect(promqlErrorType(new Error('other'))).toBeUndefined();
  });
  it('does not apply the special forbidden rule to other client routes', async () => {
    const onUnauthorized = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(json({ errorType: 'forbidden', error: 'expired' }, 401)),
    );
    await expect(
      createClient({ mode: 'live', onUnauthorized }).listDatasets(),
    ).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });
  it('forwards abort failures and signals', async () => {
    const error = new DOMException('Aborted', 'AbortError');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(error));
    await expect(
      createClient({ mode: 'live' }).promqlQuery(request, new AbortController().signal),
    ).rejects.toBe(error);
  });
});

describe('metrics capabilities and dataset discovery', () => {
  it.each([
    [{ capabilities: { promql: true }, license: { plan: 'OSS' } }, true],
    [{ capabilities: { promql: false }, license: { plan: 'Enterprise' } }, false],
    [{ license: { plan: 'OSS' } }, false],
    [{ license: { plan: 'Enterprise' } }, true],
    [{}, false],
    [{ license: { plan: 1 } }, false],
  ])('uses explicit capabilities before the license fallback: %j', async (body, promql) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(body)));
    expect((await createClient({ mode: 'live' }).about()).capabilities).toEqual({
      oidcRoleMapping: false,
      oidcRoleSync: false,
      promql,
    });
  });
  it('rejects a non-boolean explicit capability', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ capabilities: { promql: 'yes' } })));
    await expect(createClient({ mode: 'live' }).about()).rejects.toMatchObject({ status: 502 });
  });
  it('reads dataset info using encoded names and supports old telemetry-only info', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        json({
          telemetryType: 'metrics',
          logSource: [{ log_source_format: 'otel-metrics', fields: [] }],
          latestEventAt: '2026-10-09T12:00:00Z',
        }),
      )
      .mockResolvedValueOnce(json({ telemetryType: 'metrics' }));
    vi.stubGlobal('fetch', fetch);
    const signal = new AbortController().signal;
    const client = createClient({ mode: 'live' });
    expect(await client.datasetInfo('metrics / production', signal)).toEqual({
      name: 'metrics / production',
      telemetryType: 'metrics',
      logSourceFormats: ['otel-metrics'],
      latestEventAt: '2026-10-09T12:00:00Z',
    });
    expect(fetch.mock.calls[0]).toEqual([
      '/api/v1/logstream/metrics%20%2F%20production/info',
      { signal, credentials: 'include' },
    ]);
    expect(await client.datasetInfo('old')).toMatchObject({ name: 'old', logSourceFormats: [] });
  });
  it.each([
    null,
    { telemetryType: 1 },
    { logSource: {} },
    { logSource: [{ log_source_format: 1 }] },
    { latestEventAt: 1 },
  ])('rejects malformed dataset info %#', async (body) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(body)));
    await expect(createClient({ mode: 'live' }).datasetInfo('cpu')).rejects.toMatchObject({
      status: 502,
    });
  });
});
