import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient } from './client';
import type { DatasetHotTier, DatasetRetention, DatasetStats, ParseableClient } from './types';

afterEach(() => vi.unstubAllGlobals());
const json = (value: unknown) => new Response(JSON.stringify(value));
const path = '/api/v1/logstream/logs%20%2F%20staging';
const retention: DatasetRetention = [
  { description: 'Thirty days', action: 'delete', duration: '30d' },
];
const stats: DatasetStats = {
  stream: 'logs / staging',
  time: '2026-10-11T12:00:00Z',
  ingestion: {
    count: 7,
    size: 1000,
    format: 'json',
    lifetime_count: 10,
    lifetime_size: 2000,
    deleted_count: 3,
    deleted_size: 1000,
  },
  storage: { size: 500, format: 'parquet', lifetime_size: 1000, deleted_size: 500 },
};
const hotTier: DatasetHotTier = {
  version: 'v2',
  size: '10737418240 Bytes',
  used_size: '1024 Bytes',
  available_size: '10737417216 Bytes',
  oldest_date_time_entry: '2026-10-10T00:00:00',
};
type Case = {
  name: string;
  run: (client: ParseableClient, signal?: AbortSignal) => Promise<unknown>;
  suffix?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  reply?: unknown;
};
const cases: Case[] = [
  {
    name: 'create dataset',
    run: (c) =>
      c.createDataset('logs / staging', {
        telemetryType: 'traces',
        customPartition: 'service',
      }),
    method: 'PUT',
    headers: {
      'X-P-Telemetry-Type': 'traces',
      'X-P-Custom-Partition': 'service',
    },
  },
  { name: 'delete dataset', run: (c) => c.deleteDataset('logs / staging'), method: 'DELETE' },
  {
    name: 'stats',
    run: (c, s) => c.datasetStats('logs / staging', s),
    suffix: '/stats',
    reply: stats,
  },
  {
    name: 'retention',
    run: (c, s) => c.datasetRetention('logs / staging', s),
    suffix: '/retention',
    reply: retention,
  },
  {
    name: 'set retention',
    run: (c) => c.setDatasetRetention('logs / staging', retention),
    suffix: '/retention',
    method: 'PUT',
    body: retention,
  },
  {
    name: 'clear retention',
    run: (c) => c.setDatasetRetention('logs / staging', []),
    suffix: '/retention',
    method: 'PUT',
    body: [],
  },
  {
    name: 'hot tier',
    run: (c, s) => c.datasetHotTier('logs / staging', s),
    suffix: '/hottier',
    reply: hotTier,
  },
  {
    name: 'set hot tier',
    run: (c) => c.setDatasetHotTier('logs / staging', '10737418240 Bytes'),
    suffix: '/hottier',
    method: 'PUT',
    body: { size: '10737418240 Bytes' },
  },
  {
    name: 'clear hot tier',
    run: (c) => c.clearDatasetHotTier('logs / staging'),
    suffix: '/hottier',
    method: 'DELETE',
  },
  {
    name: 'info',
    run: (c, s) => c.datasetInfo('logs / staging', s),
    suffix: '/info',
    reply: {
      createdAt: '2026-10-11T00:00:00Z',
      firstEventAt: '2026-10-11T00:00:01Z',
      latestEventAt: '2026-10-11T00:00:02Z',
      timePartition: 'timestamp',
      timePartitionLimit: '7',
      customPartition: 'service',
      streamType: 'user',
      telemetryType: 'logs',
      staticSchemaFlag: 'true',
      hotTierEnabled: true,
      logSource: [{ log_source_format: 'json' }],
    },
  },
];

describe('Dataset HTTP contracts', () => {
  it.each(cases)('$name uses the server path, method, headers, body and session', async (entry) => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        'reply' in entry ? json(entry.reply) : new Response('Configuration updated'),
      );
    vi.stubGlobal('fetch', fetch);
    const signal = new AbortController().signal;
    const result = await entry.run(createClient({ mode: 'live' }), signal);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(path + (entry.suffix ?? ''));
    expect(init.credentials).toBe('include');
    expect(init.method).toBe(entry.method);
    expect(init.headers).toEqual(
      'body' in entry ? { 'Content-Type': 'application/json' } : entry.headers,
    );
    if ('body' in entry) expect(JSON.parse(init.body)).toEqual(entry.body);
    else expect(init.body).toBeUndefined();
    if (entry.method === undefined) expect(init.signal).toBe(signal);
    if (entry.reply && entry.name !== 'info') expect(result).toEqual(entry.reply);
    if (entry.name === 'info')
      expect(result).toEqual({
        ...(entry.reply as object),
        name: 'logs / staging',
        logSource: undefined,
        logSourceFormats: ['json'],
        staticSchemaFlag: true,
      });
  });
  it.each(['logs', 'metrics', 'traces'] as const)(
    'creates %s without absent advanced headers or a schema body',
    async (telemetryType) => {
      const fetch = vi.fn().mockResolvedValue(new Response('Log stream created'));
      vi.stubGlobal('fetch', fetch);
      await createClient({ mode: 'live' }).createDataset('new_dataset', { telemetryType });
      expect(fetch).toHaveBeenCalledWith('/api/v1/logstream/new_dataset', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'X-P-Telemetry-Type': telemetryType },
      });
    },
  );
  it.each(cases)('$name propagates 403 without triggering session expiry', async (entry) => {
    const onUnauthorized = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('Permission denied', { status: 403 })),
    );
    await expect(entry.run(createClient({ mode: 'live', onUnauthorized }))).rejects.toMatchObject({
      name: 'ApiError',
      status: 403,
      message: 'Permission denied',
    });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
  it.each(cases)('$name preserves server errors and notifies expired sessions', async (entry) => {
    const onUnauthorized = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response('Server rejected configuration', { status: 400 }))
        .mockResolvedValueOnce(new Response('Session expired', { status: 401 })),
    );
    const client = createClient({ mode: 'live', onUnauthorized });
    await expect(entry.run(client)).rejects.toMatchObject({
      status: 400,
      message: 'Server rejected configuration',
    });
    await expect(entry.run(client)).rejects.toMatchObject({
      status: 401,
      message: 'Session expired',
    });
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });
  it('keeps structured error messages', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ message: 'Dataset already exists' }), { status: 400 }),
        ),
    );
    await expect(
      createClient({ mode: 'live' }).createDataset('dataset', { telemetryType: 'logs' }),
    ).rejects.toMatchObject({ message: 'Dataset already exists', status: 400 });
  });
  it('accepts an empty retention array', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json([])));
    expect(await createClient({ mode: 'live' }).datasetRetention('dataset')).toEqual([]);
  });
  it('distinguishes server hot-tier configuration from an unallocated dataset', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response('Hot tier not found for stream dataset', { status: 500 }),
        )
        .mockResolvedValueOnce(
          new Response(
            'Hot tier is not enabled at the server config, cannot enable hot tier for stream dataset',
            { status: 403 },
          ),
        )
        .mockResolvedValueOnce(new Response('Stream not found: dataset', { status: 404 })),
    );
    const client = createClient({ mode: 'live' });
    expect(await client.datasetHotTier('dataset')).toBeNull();
    await expect(client.datasetHotTier('dataset')).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining('not enabled at the server config'),
    });
    await expect(client.datasetHotTier('dataset')).rejects.toMatchObject({ status: 404 });
  });
  const malformedCases: Array<{
    run: (client: ParseableClient) => Promise<unknown>;
    reply: unknown;
  }> = [
    ...[
      null,
      {},
      [],
      { ...stats, time: 'invalid' },
      { ...stats, stream: 1 },
      { ...stats, ingestion: {} },
      { ...stats, ingestion: { ...stats.ingestion, count: -1 } },
      { ...stats, ingestion: { ...stats.ingestion, lifetime_count: '10' } },
      { ...stats, storage: { ...stats.storage, size: 0.5 } },
      { ...stats, storage: { ...stats.storage, format: null } },
    ].map((reply) => ({ run: (c: ParseableClient) => c.datasetStats('dataset'), reply })),
    ...[
      null,
      {},
      [{}],
      [{ ...retention[0], description: 1 }],
      [{ ...retention[0], action: 'archive' }],
      [{ ...retention[0], duration: '0d' }],
      [{ ...retention[0], duration: '36501d' }],
      [{ ...retention[0], duration: '7h' }],
      [{ ...retention[0], duration: '1.5d' }],
      [retention[0], retention[0]],
    ].map((reply) => ({ run: (c: ParseableClient) => c.datasetRetention('dataset'), reply })),
    ...[
      null,
      {},
      { ...hotTier, version: 1 },
      { ...hotTier, size: 10737418240 },
      { ...hotTier, size: '10 GiB' },
      { ...hotTier, used_size: '-1 Bytes' },
      { ...hotTier, available_size: 'NaN Bytes' },
      { ...hotTier, oldest_date_time_entry: 1 },
    ].map((reply) => ({ run: (c: ParseableClient) => c.datasetHotTier('dataset'), reply })),
    ...[
      { createdAt: 1 },
      { timePartition: [] },
      { customPartition: {} },
      { hotTierEnabled: 'true' },
      { staticSchemaFlag: true },
    ].map((reply) => ({ run: (c: ParseableClient) => c.datasetInfo('dataset'), reply })),
  ];
  it.each(malformedCases)('rejects malformed success payload %#', async ({ run, reply }) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(reply)));
    await expect(run(createClient({ mode: 'live' }))).rejects.toMatchObject({
      status: 502,
      message: expect.stringContaining('Unexpected response'),
    });
  });
  it.each(cases.filter((entry) => entry.method === undefined))(
    '$name rejects invalid JSON and preserves cancellation',
    async (entry) => {
      const aborted = new DOMException('Aborted', 'AbortError');
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValueOnce(new Response('invalid JSON')).mockRejectedValueOnce(aborted),
      );
      const client = createClient({ mode: 'live' });
      await expect(entry.run(client)).rejects.toMatchObject({ status: 502 });
      await expect(entry.run(client)).rejects.toBe(aborted);
    },
  );
});

describe('advanced dataset contracts', () => {
  it('sends static creation format and metadata without Arrow conversion', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('Created'));
    vi.stubGlobal('fetch', fetch);
    const staticSchema = { fields: [{ name: 'service', data_type: 'string' as const }] };
    await createClient({ mode: 'live' }).createDataset('new', {
      telemetryType: 'metrics',
      logSource: 'otel-metrics',
      staticSchema,
      datasetTags: ['apm'],
      datasetLabels: ['production', 'customer-a'],
      inferTimestamp: false,
    });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('/api/v1/logstream/new');
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
      'X-P-Telemetry-Type': 'metrics',
      'X-P-Log-Source': 'otel-metrics',
      'X-P-Static-Schema-Flag': 'true',
      'X-P-Dataset-Tags': 'apm',
      'X-P-Dataset-Labels': 'production,customer-a',
      'X-P-Infer-Timestamp': 'false',
    });
    expect(JSON.parse(init.body)).toEqual(staticSchema);
  });
  it('keeps partition updates independent and removes custom partition by omitting only that header', async () => {
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(new Response('Updated')));
    vi.stubGlobal('fetch', fetch);
    const c = createClient({ mode: 'live' });
    await c.updateDatasetCustomPartition('x', 'service');
    await c.setDatasetTimePartitionLimit('x', 14);
    await c.updateDatasetCustomPartition('x');
    expect(fetch.mock.calls.map(([, init]) => init.headers)).toEqual([
      { 'X-P-Update-Stream': 'true', 'X-P-Custom-Partition': 'service' },
      { 'X-P-Update-Stream': 'true', 'X-P-Time-Partition-Limit': '14d' },
      { 'X-P-Update-Stream': 'true' },
    ]);
  });
  it('retains metadata and typed schema while preserving field-name consumers and abort signal', async () => {
    const arrow = {
      fields: [{ name: 'value', data_type: 'Int64', nullable: false, metadata: { unit: 'count' } }],
    };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        json({ datasetTags: ['apm'], datasetLabels: ['prod'], inferTimestamp: false }),
      )
      .mockResolvedValueOnce(json(arrow))
      .mockResolvedValueOnce(json(arrow));
    vi.stubGlobal('fetch', fetch);
    const c = createClient({ mode: 'live' }),
      signal = new AbortController().signal;
    expect(await c.datasetInfo('x', signal)).toMatchObject({
      datasetTags: ['apm'],
      datasetLabels: ['prod'],
      inferTimestamp: false,
    });
    expect((await c.datasetSchema('x', signal)).fields[0]).toEqual({
      name: 'value',
      dataType: 'Int64',
      nullable: false,
      metadata: { unit: 'count' },
    });
    expect(await c.schema('x', signal)).toEqual(['value']);
    expect(fetch.mock.calls[1][1].signal).toBe(signal);
  });
});

it('reads APM using its accepted creation spelling for consistent inventory search and display', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      json({
        datasetTags: ['a-p-m', 'future-domain'],
        datasetLabels: ['static-schema', 'live-fixture'],
      }),
    ),
  );
  expect(await createClient({ mode: 'live' }).datasetInfo('typed')).toMatchObject({
    datasetTags: ['apm', 'future-domain'],
    datasetLabels: ['static-schema', 'live-fixture'],
  });
});

it.each(
  [['équipe', 'prod'], ['チーム'], ['team\nprod'], ['prod,staging'], [''], ['\tprod']].map(
    (datasetLabels) => ({ datasetLabels }),
  ),
)(
  'rejects unsafe label headers before sending a creation request %#',
  async ({ datasetLabels }) => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(
      createClient({ mode: 'live' }).createDataset('labels', {
        telemetryType: 'logs',
        datasetLabels,
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(fetch).not.toHaveBeenCalled();
  },
);
