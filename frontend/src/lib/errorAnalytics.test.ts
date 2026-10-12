import { describe, expect, it } from 'vitest';
import {
  buildErrorExplorerSql,
  buildErrorQuery,
  decodeErrorIssue,
  decodeErrorSeries,
  decodeErrorSummary,
  discoverErrorDatasets,
  errorIssueId,
  inspectErrorSchema,
  loadErrorIssues,
  loadErrorOccurrences,
  loadErrorOverview,
  loadErrorSchema,
  loadErrorSeries,
  loadErrorSummary,
  parseErrorIssueId,
  UnsupportedErrorSchema,
  ERROR_BUCKETS,
  type ErrorIssueKey,
  type ErrorQueryKind,
  type ErrorSchema,
} from './errorAnalytics';
import { handleErrorDemoQuery } from './errorAnalyticsDemo';
import { createDemoClient } from './demo';
import { ApiError } from './apiError';
import { apmTransportBounds } from './apm';
import type { DatasetInfo, LogRecord, ParseableClient } from './types';

const bounds = { startTime: '2026-10-12T15:00:12.500Z', endTime: '2026-10-12T16:00:34.250Z' };
const traceInfo: DatasetInfo = { name: 'spans', logSourceFormats: ['otel-traces'] };
const logInfo: DatasetInfo = { name: 'app', logSourceFormats: ['json'] };
const traceFields = [
  'p_timestamp',
  'service.name',
  'span_trace_id',
  'span_span_id',
  'span_status_code',
  'span_status_message',
  'span_name',
  'event_name',
  'event_exception.type',
  'event_exception.message',
  'exception.type',
  'exception.message',
];
const traceSchema = inspectErrorSchema(traceFields, traceInfo);
const logSchema = inspectErrorSchema(
  ['p_timestamp', 'level', 'severity_number', 'service', 'message', 'body', 'trace_id'],
  logInfo,
);
const key: ErrorIssueKey = { service: 'checkout', errorType: null, message: 'boom' };

describe('error schema discovery', () => {
  it('splits gated OTLP event exception fields from direct span attributes', () => {
    expect(traceSchema).toMatchObject({
      source: 'traces',
      timeColumn: 'p_timestamp',
      service: ['service.name'],
      errorType: ['exception.type'],
      message: ['exception.message', 'span_status_message'],
      exception: {
        gate: 'event_name',
        type: ['event_exception.type'],
        message: ['event_exception.message'],
      },
      traceId: 'span_trace_id',
      spanId: 'span_span_id',
      operation: 'span_name',
    });
  });
  it('discovers log severity, message, service and evidence aliases in priority order', () => {
    expect(logSchema).toMatchObject({
      source: 'logs',
      service: ['service'],
      errorType: [],
      message: ['message', 'body'],
      traceId: 'trace_id',
      spanId: null,
      severity: { text: ['level'], number: ['severity_number'] },
    });
  });
  it('explains ineligible datasets instead of fabricating empty analytics', () => {
    const unsupported = (fields: string[], info: DatasetInfo) => {
      try {
        inspectErrorSchema(fields, info);
      } catch (error) {
        expect(error).toBeInstanceOf(UnsupportedErrorSchema);
        return (error as Error).message;
      }
      throw new Error('expected unsupported');
    };
    expect(unsupported([], logInfo)).toMatch(/p_timestamp/);
    expect(unsupported(['p_timestamp', 'message'], logInfo)).toMatch(/no severity field/);
    expect(unsupported(['p_timestamp', 'service.name'], traceInfo)).toMatch(
      /span_trace_id, span_span_id, span_status_code/,
    );
    expect(unsupported(['p_timestamp', 'level'], { ...logInfo, telemetryType: 'metrics' })).toMatch(
      /Metrics/,
    );
    // A custom time partition is authoritative; never fall back to p_timestamp.
    expect(
      unsupported(['p_timestamp', 'level'], { ...logInfo, timePartition: 'event_time' }),
    ).toMatch(/event_time is missing/);
    expect(
      inspectErrorSchema(['event_time', 'level'], { ...logInfo, timePartition: 'event_time' })
        .timeColumn,
    ).toBe('event_time');
  });
});

describe('error SQL contract', () => {
  const build = (kind: ErrorQueryKind, extra: object = {}, schema = traceSchema) =>
    buildErrorQuery({
      dataset: 'spans',
      schema,
      bounds,
      kind,
      ...(kind === 'occurrences' ? { issue: key } : {}),
      ...extra,
    });
  it('deduplicates spans before aggregating and enforces exact bounds inside minute transport bounds', () => {
    for (const kind of ['summary', 'series', 'issues', 'occurrences'] as const) {
      const request = build(kind);
      expect(request.startTime).toBe('2026-10-12T15:00:00.000Z');
      expect(request.endTime).toBe('2026-10-12T16:01:00.000Z');
      expect(request.sql).toMatch(/^\/\* parseable-errors:/);
      expect(request.sql).toContain(`"p_timestamp" >= TIMESTAMP '2026-10-12T15:00:12.500Z'`);
      expect(request.sql).toContain(`"p_timestamp" < TIMESTAMP '2026-10-12T16:00:34.250Z'`);
      expect(request.sql).toContain(
        `CASE WHEN TRY_CAST("span_status_code" AS DOUBLE) = 2 THEN 1 ELSE 0 END AS is_error`,
      );
      expect(request.sql).toContain(
        'MAX(is_error) OVER (PARTITION BY service, trace_id, span_id) AS is_error',
      );
      expect(request.sql).toContain('WHERE representative = 1 AND is_error = 1');
      expect(request.sql).not.toMatch(/LIMIT \d+\s*\)/); // no sampling inside the CTE
    }
  });
  it('gates only event fields and takes type and message together from one representative row per span', () => {
    const { sql } = build('summary');
    expect(sql).toContain(
      `CASE WHEN "event_name" = 'exception' THEN NULLIF(CAST("event_exception.type" AS VARCHAR), '') END AS exception_type`,
    );
    expect(sql).toContain(
      `COALESCE(NULLIF(CAST("exception.message" AS VARCHAR), ''), NULLIF(CAST("span_status_message" AS VARCHAR), '')) AS direct_message`,
    );
    expect(sql).toContain(
      'ROW_NUMBER() OVER (PARTITION BY service, trace_id, span_id ORDER BY is_exception DESC, error_type ASC NULLS LAST, message ASC NULLS LAST) AS representative',
    );
    // Independent per-field MAX would pair one event's type with another's message.
    expect(sql).not.toMatch(/MAX\((error_type|message|exception_\w+|direct_\w+)\)/);
  });
  it('classifies log errors by any severity field without dedup', () => {
    const { sql } = build('summary', {}, logSchema);
    expect(sql).toContain(`UPPER(TRIM(CAST("level" AS VARCHAR))) IN ('ERROR', 'ERROR2'`);
    expect(sql).toContain(`OR TRY_CAST("level" AS DOUBLE) IN (50, 60)`);
    expect(sql).toContain(
      `OR TRY_CAST("severity_number" AS DOUBLE) IN (17, 18, 19, 20, 21, 22, 23, 24)`,
    );
    // Numeric level codes are read from `level` only, never other text aliases.
    const severity = inspectErrorSchema(['p_timestamp', 'severity', 'message'], logInfo);
    expect(build('summary', {}, severity).sql).not.toContain('IN (50, 60)');
    expect(sql).not.toContain('GROUP BY "service.name"');
  });
  it('orders issue pages with stable tie-breakers and asks for one extra row', () => {
    const orders = {
      frequency: '"occurrences" DESC, "lastSeen" DESC',
      latest: '"lastSeen" DESC, "occurrences" DESC',
      first: '"firstSeen" DESC, "occurrences" DESC',
    };
    for (const [sort, order] of Object.entries(orders))
      expect(build('issues', { sort, offset: 50 }).sql).toContain(
        `ORDER BY ${order}, service ASC NULLS FIRST, error_type ASC NULLS FIRST, message ASC NULLS FIRST LIMIT 26 OFFSET 50`,
      );
    expect(build('occurrences', { limit: 10 }).sql).toContain(
      'ORDER BY at DESC, trace_id ASC NULLS LAST, span_id ASC NULLS LAST, operation ASC NULLS LAST LIMIT 11 OFFSET 0',
    );
  });
  it('uses at most 48 full-range buckets', () => {
    expect(build('series').sql).toContain(
      `DATE_BIN(INTERVAL '75454 milliseconds', at, TIMESTAMP '2026-10-12T15:00:12.500Z')`,
    );
    expect(decodeErrorSeries([], bounds)).toHaveLength(ERROR_BUCKETS);
  });
  it('keeps NULL identity distinct from literal placeholders in the issue predicate', () => {
    const { sql } = build('occurrences', {
      issue: { service: 'checkout', errorType: null, message: '(none)' },
    });
    expect(sql).toContain(
      `WHERE service = 'checkout' AND error_type IS NULL AND message = '(none)'`,
    );
    expect(parseErrorIssueId(errorIssueId(key))).toEqual(key);
    expect(errorIssueId({ ...key, errorType: 'null' })).not.toBe(errorIssueId(key));
    expect(parseErrorIssueId('["a",1,null]')).toBeUndefined();
    expect(parseErrorIssueId('nope')).toBeUndefined();
  });
  it('quotes hostile identifiers and literals', () => {
    const schema: ErrorSchema = {
      ...logSchema,
      service: [`svc"; DROP TABLE x; --`],
      timeColumn: 'p_timestamp',
    };
    const request = buildErrorQuery({
      dataset: `logs" WHERE 1=1 --`,
      schema,
      bounds,
      kind: 'occurrences',
      issue: { service: `it's'; --`, errorType: null, message: null },
    });
    expect(request.sql).toContain(`FROM "logs"" WHERE 1=1 --"`);
    expect(request.sql).toContain(`CAST("svc""; DROP TABLE x; --" AS VARCHAR)`);
    expect(request.sql).toContain(`service = 'it''s''; --'`);
    expect(() =>
      buildErrorQuery({
        dataset: 'a',
        schema,
        bounds,
        kind: 'occurrences',
        issue: { ...key, message: 'x\0' },
      }),
    ).toThrow(/null characters/);
    expect(() =>
      buildErrorQuery({
        dataset: 'a',
        schema: { ...schema, timeColumn: 'a\0' },
        bounds,
        kind: 'summary',
      }),
    ).toThrow();
  });
  it('rejects invalid options', () => {
    expect(() => build('occurrences', { issue: undefined })).toThrow(/Select an error issue/);
    expect(() => build('issues', { limit: 26 })).toThrow(/between 1 and 25/);
    expect(() => build('issues', { offset: -1 })).toThrow(/nonnegative/);
    expect(() => build('issues', { sort: 'random' })).toThrow(/sort/);
    expect(() => build('summary', { offset: 0 })).toThrow(/Pagination/);
    expect(() => build('issues', { issue: key })).toThrow(/issue filter/);
    expect(() => build('summary', { issue: { ...key, message: '' } })).toThrow();
    expect(() =>
      buildErrorQuery({ dataset: 'a', schema: traceSchema, kind: 'summary' } as never),
    ).toThrow(/time range/);
    expect(() =>
      buildErrorQuery({
        dataset: 'a',
        schema: traceSchema,
        ...bounds,
        startTime: bounds.endTime,
        kind: 'summary',
      }),
    ).toThrow(/Invalid time range/);
  });
  it('builds marked raw-record explorer SQL with the same predicates as the aggregates', () => {
    const sql = buildErrorExplorerSql({ dataset: 'app', schema: logSchema, bounds, issue: key });
    expect(sql).toMatch(/^\/\* parseable-errors:/);
    expect(sql).toBe(
      buildErrorQuery({ dataset: 'app', schema: logSchema, bounds, kind: 'explore', issue: key })
        .sql,
    );
    expect(sql).toContain(
      `SELECT * FROM "app" WHERE "p_timestamp" >= TIMESTAMP '2026-10-12T15:00:12.500Z' AND "p_timestamp" < TIMESTAMP '2026-10-12T16:00:34.250Z' AND (UPPER(TRIM(CAST("level" AS VARCHAR))) IN (`,
    );
    expect(sql).toContain(
      ` AND NULLIF(CAST("service" AS VARCHAR), '') = 'checkout' AND CAST(NULL AS VARCHAR) IS NULL AND COALESCE(NULLIF(CAST("message" AS VARCHAR), ''), NULLIF(CAST("body" AS VARCHAR), '')) = 'boom' ORDER BY "p_timestamp" DESC LIMIT 100`,
    );
    const target = { dataset: 'app', schema: logSchema, bounds, issue: key };
    expect(buildErrorExplorerSql(target, 10_000)).toMatch(/LIMIT 10000$/);
    expect(() => buildErrorExplorerSql(target, 10_001)).toThrow(/between 1 and 10000/);
    expect(() => buildErrorExplorerSql(target, 0)).toThrow(/between 1 and 10000/);
    expect(() => buildErrorQuery({ ...target, kind: 'explore', issue: undefined })).toThrow(
      /Select an error issue/,
    );
    expect(() => buildErrorQuery({ ...target, kind: 'explore', offset: 0 })).toThrow(/Pagination/);
    expect(() => buildErrorExplorerSql({ ...target, schema: traceSchema })).toThrow(/log datasets/);
  });
});

describe('error result decoding', () => {
  it('decodes summaries strictly', () => {
    expect(
      decodeErrorSummary([{ occurrences: 0, issues: 0, firstSeen: null, lastSeen: null }]),
    ).toEqual({ occurrences: 0, issues: 0, firstSeen: null, lastSeen: null });
    expect(
      decodeErrorSummary([
        {
          occurrences: '3',
          issues: 2,
          firstSeen: '2026-10-12T15:01:00',
          lastSeen: '2026-10-12T15:02:00',
        },
      ]),
    ).toMatchObject({ occurrences: 3, issues: 2 });
    for (const malformed of [
      {},
      [],
      [{ occurrences: 1, issues: 2, firstSeen: 't', lastSeen: 't' }],
      [{ occurrences: -1, issues: 0 }],
      [{ occurrences: 1.5, issues: 1 }],
      [{ occurrences: 2, issues: 0 }],
      [{ occurrences: 1, issues: 1, firstSeen: 'yesterday', lastSeen: '2026-10-12T15:02:00Z' }],
      [
        {
          occurrences: 1,
          issues: 1,
          firstSeen: '2026-10-12T16:00:00Z',
          lastSeen: '2026-10-12T15:00:00Z',
        },
      ],
      [{ occurrences: 0, issues: 0, firstSeen: '2026-10-12T15:00:00Z', lastSeen: null }],
    ])
      expect(() => decodeErrorSummary(malformed)).toThrow(/Malformed error analytics result/);
  });
  it('preserves null keys and rejects empty or non-string keys', () => {
    const row = {
      service: null,
      errorType: null,
      message: '(none)',
      occurrences: 2,
      firstSeen: '2026-10-12T15:01:00Z',
      lastSeen: '2026-10-12T15:01:00Z',
    };
    expect(decodeErrorIssue(row)).toMatchObject({
      service: null,
      errorType: null,
      message: '(none)',
    });
    expect(() => decodeErrorIssue({ ...row, service: '' })).toThrow(/service/);
    expect(() => decodeErrorIssue({ ...row, message: 5 })).toThrow(/message/);
    expect(() => decodeErrorIssue({ ...row, occurrences: 0 })).toThrow(/occurrences/);
  });
  it('fills series densely and rejects misaligned or duplicate buckets', () => {
    const series = decodeErrorSeries(
      [{ bucket: '2026-10-12T15:01:27.954', occurrences: 4 }],
      bounds,
    );
    expect(series[1]).toEqual({ bucket: '2026-10-12T15:01:27.954Z', occurrences: 4 });
    expect(series.reduce((sum, item) => sum + item.occurrences, 0)).toBe(4);
    expect(() =>
      decodeErrorSeries([{ bucket: '2026-10-12T15:01:00Z', occurrences: 1 }], bounds),
    ).toThrow(/bucket/);
    expect(() =>
      decodeErrorSeries(
        [
          { bucket: bounds.startTime, occurrences: 1 },
          { bucket: bounds.startTime, occurrences: 1 },
        ],
        bounds,
      ),
    ).toThrow(/bucket/);
  });
  it('rejects oversize and duplicate issue pages', async () => {
    const row = {
      service: 'a',
      errorType: null,
      message: null,
      occurrences: 1,
      firstSeen: bounds.startTime,
      lastSeen: bounds.startTime,
    };
    const client = (rows: unknown) => ({ query: async () => rows as LogRecord[] });
    const target = { dataset: 'app', schema: logSchema, bounds, limit: 1 };
    await expect(loadErrorIssues(client([row, row, row]), target)).rejects.toThrow(/page/);
    await expect(loadErrorIssues(client([row, row]), { ...target, limit: 2 })).rejects.toThrow(
      /identity/,
    );
    await expect(
      loadErrorIssues(client([row, { ...row, service: 'b' }]), target),
    ).resolves.toMatchObject({
      rows: [{ service: 'a' }],
      hasMore: true,
    });
    await expect(loadErrorIssues(client('nope'), target)).rejects.toThrow(/rows/);
  });
});

describe('error dataset discovery', () => {
  const fields: Record<string, string[]> = {
    logs: ['p_timestamp', 'level', 'message'],
    traces: traceFields,
    plain: ['p_timestamp', 'message'],
    metrics: ['p_timestamp', 'level'],
  };
  const client = (failures: Record<string, unknown> = {}) => ({
    listDatasets: async () =>
      ['traces', 'logs', 'plain', 'metrics', 'denied', 'flaky', 'gone'].map((name) => ({
        name,
        type: 'logs' as const,
      })),
    datasetInfo: async (name: string): Promise<DatasetInfo> => {
      if (name in failures) throw failures[name];
      return {
        name,
        logSourceFormats: [name === 'traces' ? 'otel-traces' : 'json'],
        telemetryType: name === 'metrics' ? 'metrics' : 'logs',
      };
    },
    schema: async (name: string) => fields[name] ?? [],
  });
  it('trusts dataset info over listed type and separates transient failures', async () => {
    const result = await discoverErrorDatasets(
      client({
        denied: new ApiError('no', 403),
        gone: new ApiError('no', 404),
        flaky: new Error('Network unavailable'),
      }),
    );
    expect(result.datasets.map((item) => [item.name, item.source])).toEqual([
      ['logs', 'logs'],
      ['traces', 'traces'],
    ]);
    expect(result.unchecked).toEqual(['flaky']);
  });
  it('propagates authentication failures and aborts', async () => {
    await expect(
      discoverErrorDatasets(client({ flaky: new ApiError('login', 401) })),
    ).rejects.toThrow('login');
    const controller = new AbortController();
    controller.abort();
    await expect(discoverErrorDatasets(client(), controller.signal)).rejects.toThrow();
  });
});

describe('demo error analytics', () => {
  const demo = createDemoClient();
  const now = Date.now();
  const range = {
    startTime: new Date(now - 3_600_000).toISOString(),
    endTime: new Date(now + 60_000).toISOString(),
  };
  it('deduplicates repeated trace span rows before counting', async () => {
    const schema = await loadErrorSchema(demo, 'demo_traces');
    const target = { dataset: 'demo_traces', schema, bounds: range };
    const { summary, issues, series } = await loadErrorOverview(demo, target);
    expect(summary).toMatchObject({ occurrences: 3, issues: 1 });
    expect(issues.rows).toEqual([
      expect.objectContaining({
        service: 'checkout',
        errorType: null,
        message: 'Payment provider timed out',
        occurrences: 3,
      }),
    ]);
    expect(series.reduce((sum, item) => sum + item.occurrences, 0)).toBe(3);
    const occurrences = await loadErrorOccurrences(demo, { ...target, issue: issues.rows[0] });
    expect(occurrences.rows).toHaveLength(3);
    expect(new Set(occurrences.rows.map((item) => `${item.traceId}/${item.spanId}`)).size).toBe(3);
    expect(occurrences.rows.every((item) => item.operation === 'create-order')).toBe(true);
  });
  it('aggregates log errors from shared records with consistent totals and pages', async () => {
    const schema = await loadErrorSchema(demo, 'application_logs');
    const target = { dataset: 'application_logs', schema, bounds: range };
    const summary = await loadErrorSummary(demo, target);
    expect(summary.occurrences).toBe(8); // every 13th of 100 records is ERROR
    const all = [];
    for (let offset = 0; ; offset += 2) {
      const page = await loadErrorIssues(demo, { ...target, limit: 2, offset, sort: 'latest' });
      all.push(...page.rows);
      if (!page.hasMore) break;
    }
    expect(all).toHaveLength(summary.issues);
    expect(all.reduce((sum, issue) => sum + issue.occurrences, 0)).toBe(summary.occurrences);
    const lastSeen = all.map((issue) => Date.parse(issue.lastSeen));
    expect(lastSeen).toEqual([...lastSeen].sort((a, b) => b - a));
    for (const issue of all) {
      const series = await loadErrorSeries(demo, { ...target, issue });
      expect(series.reduce((sum, item) => sum + item.occurrences, 0)).toBe(issue.occurrences);
      const page = await loadErrorOccurrences(demo, { ...target, issue });
      expect(page.rows).toHaveLength(issue.occurrences);
      expect(page.rows.every((item) => item.spanId === null && item.traceId)).toBe(true);
    }
  });
  it('respects exact range and rejects non-canonical SQL, unknown fields and datasets', async () => {
    const schema = await loadErrorSchema(demo, 'application_logs');
    const empty = {
      startTime: new Date(now + 3_600_000).toISOString(),
      endTime: new Date(now + 7_200_000).toISOString(),
    };
    await expect(
      loadErrorSummary(demo, { dataset: 'application_logs', schema, bounds: empty }),
    ).resolves.toEqual({
      occurrences: 0,
      issues: 0,
      firstSeen: null,
      lastSeen: null,
    });
    const request = buildErrorQuery({
      dataset: 'application_logs',
      schema,
      bounds: range,
      kind: 'summary',
    });
    await expect(demo.query({ ...request, sql: `${request.sql} UNION SELECT 1` })).rejects.toThrow(
      /Unsupported demo error query/,
    );
    await expect(
      demo.query(
        buildErrorQuery({
          dataset: 'application_logs',
          schema: { ...schema, errorType: ['nope'] },
          bounds: range,
          kind: 'summary',
        }),
      ),
    ).rejects.toThrow(/Unknown demo field/);
    await expect(
      demo.query(buildErrorQuery({ dataset: 'missing', schema, bounds: range, kind: 'summary' })),
    ).rejects.toThrow(/Unknown demo dataset/);
  });
  it('runs the explorer SQL for a log issue and rejects modified SQL', async () => {
    const schema = await loadErrorSchema(demo, 'application_logs');
    const issue = {
      service: 'api-gateway',
      errorType: null,
      message: 'Upstream request timed out after 3000ms',
    };
    const sql = buildErrorExplorerSql({
      dataset: 'application_logs',
      schema,
      bounds: range,
      issue,
    });
    const request = { sql, ...apmTransportBounds(range) };
    const records = await demo.query(request);
    // Fixture records 0 and 65 are the api-gateway ERROR rows.
    expect(records).toHaveLength(2);
    expect(records).toEqual([
      expect.objectContaining({
        level: 'ERROR',
        service: 'api-gateway',
        status_code: 504,
        host: 'prod-node-01',
      }),
      expect.objectContaining({
        level: 'ERROR',
        service: 'api-gateway',
        status_code: 504,
        host: 'prod-node-02',
      }),
    ]);
    expect(Date.parse(String(records[0].p_timestamp))).toBeGreaterThan(
      Date.parse(String(records[1].p_timestamp)),
    );
    await expect(
      demo.query({ ...request, sql: sql.replace('LIMIT 100', 'LIMIT 1000') }),
    ).rejects.toThrow(/Unsupported demo error query/);
    await expect(
      demo.query({ ...request, sql: sql.replace(`= 'api-gateway'`, `<> 'api-gateway'`) }),
    ).rejects.toThrow(/Unsupported demo error query/);
    await expect(demo.query({ ...request, startTime: range.startTime })).rejects.toThrow(
      /Unsupported demo error query/,
    );
  });
  it('compares numeric status and severity exactly without truncation', () => {
    const at = '2026-10-12T15:30:00.000Z';
    const logs: LogRecord[] = [17, '24', 24.9, '2.9e1', '18.0', 16.5, ' 17', 'x', null].map(
      (severity_number, index) => ({ p_timestamp: at, severity_number, message: `m${index}` }),
    );
    const numberSchema = inspectErrorSchema(['p_timestamp', 'severity_number', 'message'], logInfo);
    const summary = handleErrorDemoQuery(
      buildErrorQuery({ dataset: 'app', schema: numberSchema, bounds, kind: 'issues' }),
      logs,
    )!;
    // The live engine accepts surrounding whitespace but rejects fractional codes.
    expect(summary.map((row) => row.message).sort()).toEqual(['m0', 'm1', 'm4', 'm6']);
    const spans: LogRecord[] = [2, '2', 2.9, '2.0', 1].map((span_status_code, index) => ({
      p_timestamp: at,
      'service.name': 'svc',
      span_trace_id: 't',
      span_span_id: `s${index}`,
      span_status_code,
    }));
    const statusSchema = inspectErrorSchema(
      ['p_timestamp', 'service.name', 'span_trace_id', 'span_span_id', 'span_status_code'],
      traceInfo,
    );
    expect(
      handleErrorDemoQuery(
        buildErrorQuery({ dataset: 'spans', schema: statusSchema, bounds, kind: 'summary' }),
        spans,
      ),
    ).toEqual([expect.objectContaining({ occurrences: 3, issues: 1 })]);
  });
  it('counts pino/bunyan numeric error and fatal levels exactly, alongside text levels', () => {
    const at = '2026-10-12T15:30:00.000Z';
    const levels = [50, 60, '50', ' 60', 'error', 40, 30, 50.9, 59.5, 70, '50x', null];
    const logs: LogRecord[] = levels.map((level, index) => ({
      p_timestamp: at,
      level,
      msg: `m${index}`,
    }));
    const levelSchema = inspectErrorSchema(['p_timestamp', 'level', 'msg'], logInfo);
    const issues = handleErrorDemoQuery(
      buildErrorQuery({ dataset: 'app', schema: levelSchema, bounds, kind: 'issues' }),
      logs,
    )!;
    // error (50), fatal (60) and the text alias; warn (40), info (30), fractional
    // codes and values above fatal are not errors.
    expect(issues.map((row) => row.message).sort()).toEqual(['m0', 'm1', 'm2', 'm3', 'm4']);
  });
  it('keeps every span exception type and message paired when one span has several exception events', () => {
    const at = '2026-10-12T15:30:00.000Z';
    const row = (extra: LogRecord): LogRecord => ({
      p_timestamp: at,
      'service.name': 'checkout',
      span_trace_id: 't1',
      span_span_id: 's1',
      span_status_code: 2,
      span_status_message: 'status says something else',
      'exception.type': 'DirectType',
      span_name: 'pay',
      event_name: null,
      ...extra,
    });
    const exception = (type: string, message: string) =>
      row({
        event_name: 'exception',
        'event_exception.type': type,
        'event_exception.message': message,
      });
    // Two different exception events, the span row itself, and an exporter retry
    // of all three. Per-field MAX would invent (B, zeta), which no event carried.
    const once = [row({}), exception('A', 'zeta'), exception('B', 'alpha')];
    const run = (kind: ErrorQueryKind) =>
      handleErrorDemoQuery(
        buildErrorQuery({ dataset: 'spans', schema: traceSchema, bounds, kind }),
        [...once, ...once],
      )!;
    expect(run('summary')).toEqual([expect.objectContaining({ occurrences: 1, issues: 1 })]);
    expect(run('issues')).toEqual([
      expect.objectContaining({ errorType: 'A', message: 'zeta', occurrences: 1 }),
    ]);
    // The pick does not depend on row order.
    const reversed = handleErrorDemoQuery(
      buildErrorQuery({ dataset: 'spans', schema: traceSchema, bounds, kind: 'issues' }),
      [...once].reverse(),
    )!;
    expect(reversed).toEqual([expect.objectContaining({ errorType: 'A', message: 'zeta' })]);
    // Without a populated exception event, the direct span metadata is the pair.
    const direct = handleErrorDemoQuery(
      buildErrorQuery({ dataset: 'spans', schema: traceSchema, bounds, kind: 'issues' }),
      [row({}), row({ event_name: 'log', 'event_exception.type': 'Ignored' })],
    )!;
    expect(direct).toEqual([
      expect.objectContaining({
        errorType: 'DirectType',
        message: 'status says something else',
      }),
    ]);
  });
  it('groups an event-only exception and a direct span attribute with the same key', () => {
    const at = '2026-10-12T15:30:00.000Z';
    const span = (id: string, extra: LogRecord): LogRecord => ({
      p_timestamp: at,
      'service.name': 'checkout',
      span_trace_id: `t${id}`,
      span_span_id: `s${id}`,
      span_status_code: 2,
      span_status_message: '',
      span_name: 'pay',
      event_name: null,
      ...extra,
    });
    const rows = [
      span('1', {}),
      span('1', {
        event_name: 'exception',
        'event_exception.type': 'Timeout',
        'event_exception.message': 'gateway',
      }),
      span('1', {
        event_name: 'log',
        'event_exception.type': 'Ignored',
        'event_exception.message': 'ignored',
      }),
      span('2', { 'exception.type': 'Timeout', 'exception.message': 'gateway' }),
      span('3', { span_status_message: 'gateway' }), // NULL type stays its own issue
      span('4', {
        span_status_code: '2',
        'exception.type': '(none)',
        'exception.message': 'gateway',
      }),
      span('5', {
        span_status_code: 1,
        'exception.type': 'Timeout',
        'exception.message': 'gateway',
      }),
    ];
    const run = (kind: ErrorQueryKind) =>
      handleErrorDemoQuery(
        buildErrorQuery({ dataset: 'spans', schema: traceSchema, bounds, kind }),
        rows,
      )!;
    expect(run('summary')).toEqual([expect.objectContaining({ occurrences: 4, issues: 3 })]);
    expect(run('issues')).toEqual([
      expect.objectContaining({
        service: 'checkout',
        errorType: 'Timeout',
        message: 'gateway',
        occurrences: 2,
      }),
      expect.objectContaining({ errorType: null, message: 'gateway', occurrences: 1 }),
      expect.objectContaining({ errorType: '(none)', message: 'gateway', occurrences: 1 }),
    ]);
  });
});

describe('loader wiring', () => {
  it('passes the signal and flat bounds through', async () => {
    const seen: AbortSignal[] = [];
    const signal = new AbortController().signal;
    const client: Pick<ParseableClient, 'query'> = {
      query: async (_request, s) => {
        seen.push(s!);
        return [{ occurrences: 0, issues: 0, firstSeen: null, lastSeen: null }];
      },
    };
    await loadErrorSummary(client, { dataset: 'app', schema: logSchema, ...bounds }, signal);
    expect(seen).toEqual([signal]);
  });
});
