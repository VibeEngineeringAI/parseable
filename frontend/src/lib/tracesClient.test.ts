import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient } from './client';
import { traceListResponse, traceDetailResponse, decodeTraceDetail } from './tracesContract';
import { createDemoTraceRecords, createDemoTraceMethods, demoTraceList } from './demoTraces';
import type { TraceListRequest } from './types';

const now = Date.UTC(2026, 9, 12, 12);
const request: TraceListRequest = {
  dataset: 'traces / staging',
  startTime: new Date(now - 3600000).toISOString(),
  endTime: new Date(now).toISOString(),
  options: 'traces',
  limit: 25,
  offset: 1,
};
const rows = createDemoTraceRecords(now);
const list = demoTraceList(request, rows);
afterEach(() => vi.unstubAllGlobals());

describe('trace transport and response validation', () => {
  it.each([undefined, null])(
    'preserves a trace whose child has no service name (%s)',
    async (service) => {
      const detailRequest = {
        ...request,
        dataset: 'demo_traces',
        traceId: rows[0].span_trace_id as string,
      };
      const detail = await createDemoTraceMethods(rows, async () => [
        { name: 'demo_traces', type: 'traces' },
      ]).traceDetail(detailRequest);
      const reply = {
        ...detail,
        records: detail.records.map((record, index) =>
          index === 1 ? { ...record, 'service.name': service } : record,
        ),
      };
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(reply))));
      const result = await createClient({ mode: 'live' }).traceDetail(detailRequest);
      expect(result.records).toHaveLength(detail.records.length);
      expect(result.records[1]['service.name']).toBe('(unknown service)');
      expect(result.records[1].span_span_id).toBe(detail.records[1].span_span_id);
      expect(
        decodeTraceDetail({ ...reply, records: [{ ...reply.records[1], span_span_id: null }] }),
      ).toBeUndefined();
      expect(
        decodeTraceDetail({ ...reply, records: [{ ...reply.records[1], 'service.name': 123 }] }),
      ).toBeUndefined();
    },
  );
  it('normalizes only verified query permission wrappers without expiring the session', async () => {
    const onUnauthorized = vi.fn();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: 'Query error: Error: User does not have access to stream- traces',
          }),
          { status: 500 },
        ),
      )
      .mockResolvedValueOnce(
        new Response('Error: User does not have access to stream- traces', { status: 400 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Query error: Datafusion Error: SQL failed' }), {
          status: 500,
        }),
      );
    vi.stubGlobal('fetch', fetch);
    const client = createClient({ mode: 'live', onUnauthorized });
    await expect(client.listTraces(request)).rejects.toMatchObject({ status: 403 });
    await expect(
      client.query({
        sql: 'SELECT * FROM traces',
        startTime: request.startTime,
        endTime: request.endTime,
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(client.listTraces(request)).rejects.toMatchObject({ status: 500 });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
  it('still expires a genuine unauthorized trace session', async () => {
    const onUnauthorized = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(new Response('Session expired. Please login again.', { status: 401 })),
    );
    await expect(
      createClient({ mode: 'live', onUnauthorized }).listTraces(request),
    ).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });
  it('includes the chosen OTLP log source in dataset creation', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(''));
    vi.stubGlobal('fetch', fetch);
    await createClient({ mode: 'live' }).createDataset('otel_traces', {
      telemetryType: 'traces',
      logSource: 'otel-traces',
    });
    expect(fetch.mock.calls[0][1]).toMatchObject({
      method: 'PUT',
      headers: { 'X-P-Telemetry-Type': 'traces', 'X-P-Log-Source': 'otel-traces' },
    });
  });
  it('posts the exact native request with cancellation and session credentials', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(list)));
    vi.stubGlobal('fetch', fetch);
    const signal = new AbortController().signal;
    expect(await createClient({ mode: 'live' }).listTraces(request, signal)).toEqual(list);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('/api/prism/v1/services/traces/list');
    expect(init).toMatchObject({
      method: 'POST',
      credentials: 'include',
      signal,
      headers: { 'Content-Type': 'application/json' },
    });
    expect(JSON.parse(init.body)).toEqual(request);
  });
  it('uses the detail endpoint without converting timestamp or epoch fields', async () => {
    const detailRequest = {
      dataset: 'demo_traces',
      traceId: rows[0].span_trace_id as string,
      startTime: request.startTime,
      endTime: request.endTime,
    };
    const fixture = await createDemoTraceMethods(rows, async () => [
      { name: 'demo_traces', type: 'traces' },
    ]).traceDetail(detailRequest);
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture)));
    vi.stubGlobal('fetch', fetch);
    expect(await createClient({ mode: 'live' }).traceDetail(detailRequest)).toEqual(fixture);
    expect(fetch.mock.calls[0][0]).toBe('/api/prism/v1/services/traces/detail');
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(detailRequest);
  });
  it.each([
    {},
    { ...list, count: -1 },
    { ...list, limit: 0 },
    { ...list, offset: 1.5 },
    { ...list, records: [{ ...list.records[0], span_start_time_unix_nano: '2026' }] },
    { ...list, records: [{ ...list.records[0], span_duration_ns: -1 }] },
    { ...list, records: [{ ...list.records[0], error_count: '1' }] },
  ])('rejects a malformed successful response %#', async (reply) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(reply))));
    await expect(createClient({ mode: 'live' }).listTraces(request)).rejects.toMatchObject({
      status: 502,
    });
  });
  it('preserves explicit server errors and does not substitute demo data', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: 'Dataset is not OTLP traces' }), { status: 400 }),
        ),
    );
    await expect(createClient({ mode: 'live' }).listTraces(request)).rejects.toMatchObject({
      status: 400,
      message: 'Dataset is not OTLP traces',
    });
  });
  it('accepts UTC Arrow timestamp text and large nanosecond integers', () => {
    expect(traceListResponse(list)).toBe(true);
    expect(
      traceListResponse({
        ...list,
        records: [
          {
            ...list.records[0],
            span_start_time_unix_nano: '2026-10-12 12:00:00.123456789',
            span_start_time_unix_nano_epoch: 1791806400123456800,
          },
        ],
      }),
    ).toBe(true);
    expect(
      traceDetailResponse({
        startTime: '2026-10-12T12:00:00Z',
        endTime: '2026-10-12T12:00:00Z',
        records: [],
      }),
    ).toBe(true);
    expect(
      traceDetailResponse({
        startTime: '2026-10-12T12:00:01Z',
        endTime: '2026-10-12T12:00:00Z',
        records: [],
      }),
    ).toBe(false);
    expect(
      traceDetailResponse({
        startTime: '2026-10-12T12:00:00Z',
        endTime: '2026-10-12T12:01:00Z',
        records: [{}],
      }),
    ).toBe(false);
  });
});
