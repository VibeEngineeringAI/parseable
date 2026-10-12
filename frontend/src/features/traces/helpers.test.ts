import { describe, expect, it } from 'vitest';
import { ApiError } from '../../lib/apiError';
import type { DatasetInfo, ParseableClient, TraceDetailRecord } from '../../lib/types';
import {
  buildWaterfall,
  discoverTraceDatasets,
  formatDuration,
  isTraceDataset,
  normalizeTraceId,
  spanRecordQuery,
  timestampNanoseconds,
} from './helpers';
import { recordedEvents } from './SpanDetail';
import { storyTraceDetail, STORY_SPAN_IDS } from './fixtures';

describe('trace timing and hierarchy', () => {
  it('parses timezone-less Arrow timestamps as UTC and preserves all nine decimal places', () => {
    const timestamp = '2026-10-12T10:20:00.012345678';
    expect(timestampNanoseconds(timestamp)).toBe(timestampNanoseconds(`${timestamp}Z`));
    expect(timestampNanoseconds(timestamp)).toBe(
      timestampNanoseconds('2026-10-12T05:20:00.012345678-05:00'),
    );
    expect(
      timestampNanoseconds('2026-10-12T10:20:00.012345679')! - timestampNanoseconds(timestamp)!,
    ).toBe(1n);
    expect(timestampNanoseconds('not-a-date')).toBeUndefined();
  });
  it('lays out spans from timestamp strings even when numeric epoch fields are identical', () => {
    const { rows, totalMs } = buildWaterfall(storyTraceDetail.records);
    expect(
      rows.find(({ span }) => span.span_span_id === STORY_SPAN_IDS.checkout)?.offsetMs,
    ).toBeCloseTo(12.345678, 6);
    expect(
      rows.find(({ span }) => span.span_span_id === STORY_SPAN_IDS.database)?.offsetMs,
    ).toBeCloseTo(21.345679, 6);
    expect(totalMs).toBe(240);
  });
  it('renders parent before child, deterministic siblings and orphan roots regardless of API ordering', () => {
    const expected = [
      STORY_SPAN_IDS.root,
      STORY_SPAN_IDS.checkout,
      STORY_SPAN_IDS.database,
      STORY_SPAN_IDS.inventory,
      STORY_SPAN_IDS.orphan,
    ];
    expect(
      buildWaterfall([...storyTraceDetail.records].reverse()).rows.map(
        ({ span }) => span.span_span_id,
      ),
    ).toEqual(expected);
    expect(buildWaterfall(storyTraceDetail.records).rows.map(({ depth }) => depth)).toEqual([
      0, 1, 2, 1, 0,
    ]);
  });
  it('handles duplicate detail records, zero duration, invalid timing and cycles without losing spans', () => {
    const records = storyTraceDetail.records
      .slice(0, 2)
      .map((span, index, all) => ({ ...span, span_parent_span_id: all[1 - index].span_span_id }));
    const invalid: TraceDetailRecord = {
      ...storyTraceDetail.records[2],
      span_start_time_unix_nano: 'invalid',
      span_duration_ns: -1,
    };
    const result = buildWaterfall([...records, records[0], invalid]);
    expect(result.rows).toHaveLength(3);
    expect(result.rows.find(({ span }) => span === invalid)?.timingAvailable).toBe(false);
    expect(buildWaterfall([{ ...records[0], span_duration_ns: 0 }]).totalMs).toBe(0);
    expect(buildWaterfall([])).toEqual({ rows: [], totalMs: 0 });
  });
  it.each([
    [0, '0 ms'],
    [0.000001, '1 ns'],
    [0.5, '500 µs'],
    [12.345678, '12.3 ms'],
    [1500, '1.5 s'],
    [NaN, '—'],
  ])('formats %s ms as %s', (value, label) => expect(formatDuration(value as number)).toBe(label));
});

describe('trace request and payload helpers', () => {
  it('normalizes hex IDs without rewriting nonhex identifiers', () => {
    expect(normalizeTraceId(' 0123456789ABCDEF0123456789ABCDEF ')).toBe(
      '0123456789abcdef0123456789abcdef',
    );
    expect(normalizeTraceId(' customer-ID ')).toBe('customer-ID');
  });
  it('quotes query identifiers and literals and extends equal ingestion bounds in UTC', () => {
    const request = spanRecordQuery(
      'orders"traces',
      { ...storyTraceDetail.records[0], span_trace_id: "id' OR 1=1 --", span_span_id: "span'one" },
      storyTraceDetail,
    );
    expect(request.sql).toContain('FROM "orders""traces"');
    expect(request.sql).toContain("= 'id'' OR 1=1 --'");
    expect(request.sql).toContain("= 'span''one' LIMIT 100");
    expect(request.startTime).toBe('2026-10-12T10:20:00.000Z');
    expect(request.endTime).toBe('2026-10-12T10:21:00.000Z');
    expect(() =>
      spanRecordQuery('traces', storyTraceDetail.records[0], {
        ...storyTraceDetail,
        endTime: 'bad',
      }),
    ).toThrow('Trace time bounds are invalid');
  });
  it('only renders actual event fields and deduplicates repeated event payloads', () => {
    const event = {
      event_name: 'exception',
      event_message: 'timeout',
      event_time_unix_nano: '2026-10-12T10:20:00Z',
      'service.name': 'checkout',
      p_timestamp: '2026-10-12T10:21:00Z',
    };
    expect(
      recordedEvents([
        { event_name: null },
        event,
        { ...event, p_timestamp: '2026-10-12T10:22:00Z' },
        { ...event, event_time_unix_nano: '2026-10-12T10:20:01Z' },
      ]),
    ).toEqual([
      {
        event_name: 'exception',
        event_message: 'timeout',
        event_time_unix_nano: '2026-10-12T10:20:00Z',
      },
      {
        event_name: 'exception',
        event_message: 'timeout',
        event_time_unix_nano: '2026-10-12T10:20:01Z',
      },
    ]);
  });
});

describe('trace dataset discovery', () => {
  const info = (name: string, formats: string[]): DatasetInfo => ({
    name,
    logSourceFormats: formats,
  });
  it('requires the native otel-traces source, regardless of telemetryType or list type', async () => {
    expect(isTraceDataset({ ...info('wrong', []), telemetryType: 'traces' })).toBe(false);
    expect(isTraceDataset(info('mixed', ['json', 'otel-traces']))).toBe(true);
    const client = {
      listDatasets: async () => [
        { name: 'actual', type: 'logs' },
        { name: 'nominal', type: 'traces' },
      ],
      datasetInfo: async (name: string) => info(name, name === 'actual' ? ['otel-traces'] : []),
    } as unknown as ParseableClient;
    expect((await discoverTraceDatasets(client)).datasets.map(({ name }) => name)).toEqual([
      'actual',
    ]);
  });
  it('preserves accessible datasets while reporting failed eligibility probes', async () => {
    const client = {
      listDatasets: async () =>
        ['ok', 'denied', 'gone', 'offline'].map((name) => ({ name, type: 'logs' })),
      datasetInfo: async (name: string) => {
        if (name === 'denied') throw new ApiError('Permission denied', 403);
        if (name === 'gone') throw new ApiError('Not found', 404);
        if (name === 'offline') throw new ApiError('Unavailable', 503);
        return info(name, ['otel-traces']);
      },
    } as unknown as ParseableClient;
    expect(await discoverTraceDatasets(client)).toEqual({
      datasets: [info('ok', ['otel-traces'])],
      unchecked: ['offline'],
    });
  });
  it('propagates cancellation instead of returning a partial discovery', async () => {
    const abort = new AbortController();
    const client = {
      listDatasets: async () => [{ name: 'ok', type: 'traces' }],
      datasetInfo: async () => {
        abort.abort();
        throw new DOMException('Aborted', 'AbortError');
      },
    } as unknown as ParseableClient;
    await expect(discoverTraceDatasets(client, abort.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});
