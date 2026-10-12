import { describe, expect, it } from 'vitest';
import {
  buildApmQuery,
  apmBoundsFromParams,
  apmRangeFromParams,
  resolveApmRoute,
  apmServicePath,
  formatApmRate,
  discoverApmDatasets,
  inspectApmSchema,
  loadApmInsights,
  loadApmInventory,
  loadApmTopology,
  decodeApmStats,
  apmTracePath,
  type ApmQueryKind,
} from './apm';
import { handleApmDemoQuery } from './apmDemo';
import { createDemoTraceRecords } from './demoTraces';
import { parseEventTimestamp } from '../components/explorer/timestamp';
import type { LogRecord } from './types';
const bounds = {
  startTime: '2026-10-12T15:00:12.500Z',
  endTime: '2026-10-12T16:00:34.250Z',
};
const request = (kind: ApmQueryKind, service = 'checkout') =>
  buildApmQuery({
    ...bounds,
    dataset: 'demo_traces',
    kind,
    service: kind === 'inventory' || kind === 'topology' ? undefined : service,
  });
describe('APM SQL contract', () => {
  it('deduplicates before aggregates and joins and enforces exact ingestion bounds inside expanded transport bounds', () => {
    for (const kind of [
      'inventory',
      'summary',
      'operations',
      'series',
      'spans',
      'topology',
    ] as const) {
      const { sql, startTime, endTime } = request(kind);
      expect(sql).toContain('GROUP BY "service.name", "span_trace_id", "span_span_id"');
      expect(sql.indexOf('GROUP BY "service.name"')).toBeLessThan(sql.lastIndexOf('SELECT'));
      expect(sql.split('GROUP BY "service.name"')[0]).not.toContain('LIMIT');
      expect(sql).toContain(`"p_timestamp" >= TIMESTAMP '${bounds.startTime}'`);
      expect(sql).toContain(`"p_timestamp" < TIMESTAMP '${bounds.endTime}'`);
      expect(startTime).toBe('2026-10-12T15:00:00.000Z');
      expect(endTime).toBe('2026-10-12T16:01:00.000Z');
    }
    expect(request('series').sql).toContain('MIN("p_timestamp") AS ingested_at');
    expect(request('series').sql).toContain("milliseconds', ingested_at");
  });
  it('quotes hostile names and rejects unsupported or excessive limits', () => {
    expect(
      buildApmQuery({
        ...bounds,
        dataset: 'traces"; DROP TABLE x;--',
        service: "checkout';--",
        kind: 'summary',
      }).sql,
    ).toContain('FROM "traces""; DROP TABLE x;--"');
    expect(
      buildApmQuery({
        ...bounds,
        dataset: 'x',
        service: "checkout';--",
        kind: 'summary',
      }).sql,
    ).toContain("\"service.name\" = 'checkout'';--'");
    for (const limit of [0, 201, 1.5, Infinity])
      expect(() => buildApmQuery({ ...bounds, dataset: 'x', kind: 'inventory', limit })).toThrow(
        /limit/,
      );
    expect(() => buildApmQuery({ ...bounds, dataset: 'x', kind: 'summary' })).toThrow(
      'Select an APM service',
    );
    expect(() => buildApmQuery({ ...bounds, dataset: 'x\0', kind: 'inventory' })).toThrow();
  });
  it('groups operations by their displayed name and filters bad start times only from the span list', () => {
    const operations = request('operations').sql;
    expect(operations).toContain("GROUP BY COALESCE(operation, '(unnamed)')");
    expect(operations).not.toContain('GROUP BY operation');
    expect(request('spans').sql).toContain('FROM spans WHERE started_at IS NOT NULL');
    for (const kind of ['inventory', 'summary', 'operations', 'series', 'topology'] as const)
      expect(request(kind).sql).not.toContain('started_at IS NOT NULL');
  });
  it('omits entirely absent optional schema columns', () => {
    const schema = inspectApmSchema([
      'p_timestamp',
      'service.name',
      'span_trace_id',
      'span_span_id',
      'span_name',
      'span_duration_ns',
      'span_start_time_unix_nano',
    ]);
    expect(schema).toEqual({
      status: false,
      parent: false,
      timeColumn: 'p_timestamp',
    });
    const query = buildApmQuery({
      ...bounds,
      dataset: 'x',
      kind: 'inventory',
      schema,
    });
    expect(query.sql).not.toContain('"span_status_code"');
    expect(query.sql).not.toContain('"span_parent_span_id"');
    expect(query.sql).toContain('0 AS is_error');
    expect(() => inspectApmSchema(['service.name'])).toThrow(/required OTLP/);
  });
  it('keeps exact captured bounds and selection in trace navigation', () => {
    const url = new URL(
      apmTracePath('traces / prod', 'checkout & pay', bounds, 'abcdef'),
      'https://example.test',
    );
    expect(url.pathname).toBe('/traces/explore/traces%20%2F%20prod');
    expect(url.searchParams.get('service')).toBe('checkout & pay');
    expect(url.searchParams.get('start')).toBe(bounds.startTime);
    expect(url.searchParams.get('end')).toBe(bounds.endTime);
    expect(url.searchParams.get('traceId')).toBe('abcdef');
  });
});
describe('APM demo aggregate contract', () => {
  const fixture = createDemoTraceRecords(Date.parse(bounds.endTime));
  const client = {
    query: async (query: ReturnType<typeof request>) => handleApmDemoQuery(query, fixture)!,
  };
  it('derives inventory and insights from shared trace fixtures without event duplicates', async () => {
    expect(fixture.length).toBeGreaterThan(36);
    const inventory = await loadApmInventory(client, 'demo_traces', bounds);
    expect(inventory.rows).toHaveLength(3);
    expect(inventory.rows.reduce((sum, row) => sum + row.spanCount, 0)).toBe(36);
    const checkout = inventory.rows.find((row) => row.service === 'checkout')!;
    expect(checkout.spanCount).toBe(12);
    expect(checkout.errorCount).toBe(3);
    expect(checkout.errorRate).toBe(25);
    const insights = await loadApmInsights(client, 'demo_traces', 'checkout', bounds);
    const { service: _, ...stats } = checkout;
    expect(insights.summary).toEqual(stats);
    expect(insights.series.reduce((sum, row) => sum + row.spanCount, 0)).toBe(12);
  });
  it('deduplicates parent edges and excludes ambiguous parent identities', async () => {
    const edges = await loadApmTopology(client, 'demo_traces', bounds);
    expect(edges.rows).toHaveLength(2);
    expect(edges.rows.every((edge) => edge.spanCount === 12)).toBe(true);
    const result = handleApmDemoQuery(request('topology'), [
      ...fixture,
      { ...fixture[0], 'service.name': 'ambiguous-parent' },
    ])!;
    expect(result.every((edge) => edge.spanCount === 11)).toBe(true);
  });
  it('includes delayed spans by ingestion time, treats offsetless time as UTC, excludes exact end', () => {
    const row: LogRecord = {
      'service.name': 'checkout',
      span_trace_id: 'trace',
      span_span_id: 'span',
      span_name: 'delayed',
      span_duration_ns: 42000000,
      span_start_time_unix_nano: '2020-01-01T00:00:00',
      p_timestamp: '2026-10-12T16:00:30.000',
      span_status_code: 2,
    };
    const result = handleApmDemoQuery(request('summary'), [
      row,
      row,
      { ...row, span_span_id: 'outside', p_timestamp: bounds.endTime },
    ])!;
    expect(result[0].spanCount).toBe(1);
    expect(result[0].errorCount).toBe(1);
    expect(
      parseEventTimestamp(handleApmDemoQuery(request('series'), [row, row])![0].bucket),
    ).toBeGreaterThan(Date.parse(bounds.startTime));
    expect(
      handleApmDemoQuery(
        buildApmQuery({
          ...bounds,
          dataset: 'x',
          service: 'checkout',
          kind: 'summary',
          schema: { status: false, parent: false, timeColumn: 'p_timestamp' },
        }),
        [row],
      )![0].errorCount,
    ).toBe(0);
  });
  it('merges null and literal unnamed operations after deduplication and ignores nulls in MAX', async () => {
    const base: LogRecord = {
      'service.name': 'checkout',
      span_trace_id: 'trace',
      span_span_id: 'missing-name',
      span_name: null,
      span_duration_ns: 42000000,
      span_start_time_unix_nano: '2026-10-12T15:30:00Z',
      p_timestamp: '2026-10-12T15:30:00Z',
      span_status_code: 2,
    };
    const rows = [
      base,
      base,
      {
        ...base,
        span_span_id: 'literal-name',
        span_name: '(unnamed)',
        span_status_code: 1,
      },
      { ...base, span_span_id: 'mixed-name', span_status_code: 1 },
      {
        ...base,
        span_span_id: 'mixed-name',
        span_name: '!!!actual',
        span_status_code: 1,
      },
    ];
    const insights = await loadApmInsights(
      { query: async (query) => handleApmDemoQuery(query, rows)! },
      'demo_traces',
      'checkout',
      bounds,
    );
    expect(insights.summary.spanCount).toBe(3);
    expect(insights.operations.rows).toHaveLength(2);
    expect(insights.operations.rows[0]).toMatchObject({
      operation: '(unnamed)',
      spanCount: 2,
      traceCount: 1,
      errorCount: 1,
      errorRate: 50,
      avgMs: 42,
    });
    expect(insights.operations.rows[1]).toMatchObject({
      operation: '!!!actual',
      spanCount: 1,
    });
    expect(insights.spans.rows.find((span) => span.spanId === 'mixed-name')?.operation).toBe(
      '!!!actual',
    );
  });
  it('keeps invalid span starts in aggregates and dependencies without failing service insights', async () => {
    const base: LogRecord = {
      'service.name': 'checkout',
      span_trace_id: 'trace',
      span_span_id: 'parent',
      span_name: 'POST /orders',
      span_duration_ns: 42000000,
      span_start_time_unix_nano: 'not-a-timestamp',
      p_timestamp: '2026-10-12T15:30:00Z',
      span_status_code: 2,
    };
    const rows = [
      base,
      { ...base, span_span_id: 'null-start', span_start_time_unix_nano: null },
      { ...base, span_span_id: 'recovered' },
      {
        ...base,
        span_span_id: 'recovered',
        span_start_time_unix_nano: '2026-10-12T15:30:00Z',
      },
      {
        ...base,
        'service.name': 'payments',
        span_span_id: 'child',
        span_parent_span_id: 'parent',
      },
    ];
    const client = {
      query: async (query: ReturnType<typeof request>) => handleApmDemoQuery(query, rows)!,
    };
    const inventory = await loadApmInventory(client, 'demo_traces', bounds);
    const insights = await loadApmInsights(client, 'demo_traces', 'checkout', bounds);
    const topology = await loadApmTopology(client, 'demo_traces', bounds);
    expect(inventory.rows.find((row) => row.service === 'checkout')?.spanCount).toBe(3);
    expect(insights.summary).toMatchObject({
      spanCount: 3,
      errorCount: 3,
      avgMs: 42,
    });
    expect(insights.operations.rows[0].spanCount).toBe(3);
    expect(insights.series.reduce((sum, row) => sum + row.spanCount, 0)).toBe(3);
    expect(insights.spans.rows).toHaveLength(1);
    expect(insights.spans.rows[0]).toMatchObject({
      spanId: 'recovered',
      startedAt: '2026-10-12T15:30:00Z',
    });
    expect(topology.rows[0]).toMatchObject({
      source: 'checkout',
      target: 'payments',
      spanCount: 1,
    });
  });
  it('reports aggregate truncation while retaining unbounded source aggregation', async () => {
    const rows = Array.from({ length: 201 }, (_, i) => ({
      ...fixture[0],
      'service.name': `service-${i}`,
    }));
    const result = await loadApmInventory(
      { query: async (query) => handleApmDemoQuery(query, rows)! },
      'demo_traces',
      bounds,
    );
    expect(result.rows).toHaveLength(200);
    expect(result.truncated).toBe(true);
  });
  it('rejects malformed responses and mutated demo SQL', () => {
    expect(() => decodeApmStats({ spanCount: 'invalid' })).toThrow(/Malformed/);
    const query = request('inventory');
    expect(() =>
      handleApmDemoQuery({ ...query, sql: query.sql + ' DROP TABLE x' }, fixture),
    ).toThrow('Unsupported demo APM query');
    expect(handleApmDemoQuery({ ...query, sql: 'SELECT * FROM logs' }, fixture)).toBeUndefined();
  });
});
// Opt-in read-only fixture verification. No server startup or mutations.
it.runIf(Boolean(process.env.APM_REFERENCE_URL))(
  'executes every generated query on the Rust fixture server',
  async () => {
    const liveBounds = {
      startTime: '2026-10-12T16:03:51.820Z',
      endTime: '2026-10-12T16:03:51.842Z',
    };
    const query = async (request: ReturnType<typeof buildApmQuery>): Promise<LogRecord[]> => {
      const response = await fetch(`${process.env.APM_REFERENCE_URL}/api/v1/query`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Basic ${btoa('fixture:fixture-throwaway')}`,
        },
        body: JSON.stringify({
          query: request.sql,
          startTime: request.startTime,
          endTime: request.endTime,
          sendNull: true,
        }),
      });
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    };
    const inventory = await loadApmInventory({ query }, 'otel-traces-fixture', liveBounds);
    expect(inventory.rows.reduce((sum, row) => sum + row.spanCount, 0)).toBe(9);
    const insights = await loadApmInsights(
      { query },
      'otel-traces-fixture',
      inventory.rows[0].service,
      liveBounds,
    );
    expect(insights.summary.spanCount).toBe(inventory.rows[0].spanCount);
    expect(insights.series.reduce((sum, row) => sum + row.spanCount, 0)).toBe(
      insights.summary.spanCount,
    );
    await loadApmTopology({ query }, 'otel-traces-fixture', liveBounds);
    await loadApmTopology(
      { query },
      'otel-traces-fixture',
      liveBounds,
      undefined,
      undefined,
      inventory.rows[0].service,
    );
    const empty = await loadApmInsights(
      { query },
      'otel-traces-fixture',
      'service-that-does-not-exist',
      liveBounds,
    );
    expect(empty.summary.spanCount).toBe(0);
    expect(empty.spans.rows).toEqual([]);
  },
  30000,
);

describe('APM URL and dataset metadata regressions', () => {
  it('decodes raw dataset and service path segments exactly once', () => {
    for (const service of ['service/worker', '100% checkout', 'x%2Fy', '%', '/']) {
      expect(resolveApmRoute(apmServicePath('trace%2Farchive', service))).toEqual({
        dataset: 'trace%2Farchive',
        service,
      });
    }
  });
  it('honors preset-only ranges and preserves explicit bounds regardless of preset', () => {
    const now = Date.parse(bounds.endTime);
    const preset = new URLSearchParams('range=24h');
    const result = apmBoundsFromParams(preset, now);
    expect(Date.parse(result.endTime) - Date.parse(result.startTime)).toBe(86400000);
    expect(apmRangeFromParams(preset)).toBe('24h');
    expect(
      apmBoundsFromParams(
        new URLSearchParams({
          ...bounds,
          start: bounds.startTime,
          end: bounds.endTime,
          range: '24h',
        }),
        now,
      ),
    ).toEqual(bounds);
    expect(apmRangeFromParams(new URLSearchParams('range=bogus'))).toBe('1h');
    expect(
      apmRangeFromParams(
        new URLSearchParams({
          start: bounds.startTime,
          end: bounds.endTime,
          range: '24h',
        }),
      ),
    ).toEqual(bounds);
  });
  it('uses safely quoted custom time partitions in precise SQL and demo buckets', () => {
    const schema = { status: true, parent: true, timeColumn: 'observed"at' };
    const query = buildApmQuery({
      ...bounds,
      dataset: 'x',
      kind: 'inventory',
      schema,
    });
    expect(query.sql).toContain('MIN("observed""at") AS ingested_at');
    expect(query.sql).toContain('AND "observed""at" >= TIMESTAMP');
    expect(query.sql).not.toContain('"p_timestamp"');
    const rows = [
      {
        'service.name': 'checkout',
        span_trace_id: 't',
        span_span_id: 's',
        span_name: 'delayed',
        span_duration_ns: 1000000,
        span_start_time_unix_nano: '2020-01-01T00:00:00',
        p_timestamp: '2020-01-01T00:00:00',
        'observed"at': '2026-10-12T15:30:00',
      },
    ];
    expect(handleApmDemoQuery(query, rows)![0].spanCount).toBe(1);
  });
  it('discovers by OTLP source metadata rather than live list type or generic telemetryType', async () => {
    const result = await discoverApmDatasets({
      listDatasets: async () => [
        { name: 'otlp', type: 'logs' },
        { name: 'custom', type: 'traces' },
      ],
      datasetInfo: async (name) => ({
        name,
        telemetryType: 'traces',
        logSourceFormats: name === 'otlp' ? ['otel-traces'] : ['json'],
      }),
      schema: async () => [],
    });
    expect(result.datasets.map((item) => item.name)).toEqual(['otlp']);
  });
  it('formats small positive span rates without claiming zero', () => {
    expect(formatApmRate(0.0001)).toBe('<0.01');
    expect(formatApmRate(0)).toBe('0');
    expect(formatApmRate(0.01)).toBe('0.01');
  });
});
