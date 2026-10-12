import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDemoClient } from './demo';
import { createDemoTraceMethods, createDemoTraceRecords, demoTraceList } from './demoTraces';
import { traceDetailResponse, traceListResponse } from './tracesContract';
import { parseEventTimestamp } from '../components/explorer/timestamp';

const now = Date.UTC(2026, 9, 12, 12);
const request = {
  dataset: 'demo_traces',
  startTime: new Date(now - 3600000).toISOString(),
  endTime: new Date(now).toISOString(),
};
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('demo traces', () => {
  it('uses exact half-open bounds for lists and trace discovery like the native API', async () => {
    const startTime = '2026-10-12T11:00:15.125Z';
    const endTime = '2026-10-12T11:01:45.875Z';
    const template = createDemoTraceRecords(now)[0];
    const rows = [
      ['before', '2026-10-12T11:00:15.124Z'],
      ['start', startTime],
      ['inside', '2026-10-12T11:01:45.874Z'],
      ['end', endTime],
    ].map(([id, time]) => ({
      ...template,
      span_trace_id: id,
      span_span_id: id,
      p_timestamp: time,
    }));
    const client = createDemoTraceMethods(rows, async () => [
      { name: 'demo_traces', type: 'traces' },
    ]);
    const bounds = { dataset: 'demo_traces', startTime, endTime };
    const list = await client.listTraces(bounds);
    expect(list.count).toBe(2);
    expect(list.records.map((row) => row.span_trace_id).sort()).toEqual(['inside', 'start']);
    await expect(client.traceDetail({ ...bounds, traceId: 'inside' })).resolves.toMatchObject({
      records: [expect.objectContaining({ span_trace_id: 'inside' })],
    });
    await expect(client.traceDetail({ ...bounds, traceId: 'end' })).rejects.toMatchObject({
      status: 404,
    });
  });
  it('exposes OTLP schema and matches native deduplicated list, roots and errors', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const client = createDemoClient();
    expect(await client.listDatasets()).toContainEqual({ name: 'demo_traces', type: 'traces' });
    expect(await client.datasetInfo('demo_traces')).toMatchObject({
      logSourceFormats: ['otel-traces'],
    });
    expect(await client.schema('demo_traces')).toContain('span_parent_span_id');
    const spans = await client.listTraces(request);
    expect(traceListResponse(spans)).toBe(true);
    expect(spans.count).toBe(36);
    expect(spans.records[0].total_span_count).toBe(3);
    expect((await client.listTraces({ ...request, options: 'traces' })).count).toBe(12);
    expect((await client.listTraces({ ...request, options: 'errorSpans' })).count).toBe(3);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('filters before trace statistics and paginates after ordering', async () => {
    const client = createDemoClient();
    const all = await client.listTraces({
      ...request,
      sortBy: 'shortestFirst',
      serviceName: 'checkout',
    });
    expect(all.count).toBe(12);
    expect(all.records.every((row) => row.total_span_count === 1)).toBe(true);
    const page = await client.listTraces({
      ...request,
      sortBy: 'shortestFirst',
      serviceName: 'checkout',
      limit: 2,
      offset: 3,
    });
    expect(page.records).toEqual(all.records.slice(3, 5));
    expect(page.count).toBe(12);
    const filtered = await client.listTraces({
      ...request,
      conditions: {
        conditions: {
          operator: 'and',
          conditionConfig: [{ column: 'span_name', operator: '=', value: 'reserve-stock' }],
        },
      },
    });
    expect(filtered.count).toBe(12);
    const empty = await client.listTraces({
      ...request,
      startTime: new Date(now + 1000).toISOString(),
      endTime: new Date(now + 2000).toISOString(),
    });
    expect(empty.count).toBe(0);
  });
  it('returns a hierarchy with event counts, error state and UTC bounds', async () => {
    const client = createDemoClient();
    const list = await client.listTraces({ ...request, options: 'traces' });
    const detail = await client.traceDetail({ ...request, traceId: list.records[0].span_trace_id });
    expect(traceDetailResponse(detail)).toBe(true);
    expect(detail.records).toHaveLength(3);
    expect(detail.records.map((row) => row.level)).toEqual([0, 1, 1]);
    const checkout = detail.records.find((row) => row['service.name'] === 'checkout')!;
    expect(checkout).toMatchObject({ event_count: 1, has_error: true, total_span_count: 3 });
    expect(parseEventTimestamp(checkout.span_start_time_unix_nano)).toBe(now - 60000 + 12);
    const raw = await client.query({
      sql: `SELECT * FROM "demo_traces" WHERE "span_span_id" = '${checkout.span_span_id}' LIMIT 100`,
      startTime: request.startTime,
      endTime: request.endTime,
    });
    expect(raw).toHaveLength(2);
    expect(raw.some((row) => row.event_name === 'exception')).toBe(true);
  });
  it('keeps clients and response records isolated', async () => {
    const a = createDemoClient(),
      b = createDemoClient();
    const first = await a.listTraces(request);
    first.records[0].span_name = 'mutated';
    expect((await a.listTraces(request)).records[0].span_name).not.toBe('mutated');
    await a.deleteDataset('demo_traces');
    await expect(a.listTraces(request)).rejects.toMatchObject({ status: 404 });
    expect((await b.listTraces(request)).count).toBe(36);
  });
  it('honors cancellation, rejects unsupported conditions and distinguishes bad datasets/not found', async () => {
    const client = createDemoClient();
    const controller = new AbortController();
    controller.abort();
    await expect(client.listTraces(request, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    await expect(
      client.listTraces({ ...request, dataset: 'application_logs' }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(client.traceDetail({ ...request, traceId: 'missing' })).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      client.listTraces({
        ...request,
        conditions: {
          conditions: {
            conditionConfig: [{ column: 'span_name', operator: 'ilike', value: 'foo' }],
          },
        },
      }),
    ).rejects.toThrow('Connect to a server');
    for (const limit of [0, 1001, 1.5])
      expect(() => demoTraceList({ ...request, limit }, createDemoTraceRecords(now))).toThrow(
        'limit',
      );
  });
  it('stores explicit ingestion log source metadata for newly created datasets', async () => {
    const client = createDemoClient();
    await client.createDataset('otel_new', { telemetryType: 'traces', logSource: 'otel-traces' });
    expect(await client.datasetInfo('otel_new')).toMatchObject({
      logSourceFormats: ['otel-traces'],
      telemetryType: 'traces',
    });
    expect(await client.listTraces({ ...request, dataset: 'otel_new' })).toMatchObject({
      count: 0,
      records: [],
    });
  });
});
