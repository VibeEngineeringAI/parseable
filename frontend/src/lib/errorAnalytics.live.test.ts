import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  buildErrorExplorerSql,
  loadErrorSchema,
  loadErrorSummary,
  loadErrorSeries,
  loadErrorIssues,
  loadErrorOccurrences,
  type ErrorSchema,
} from './errorAnalytics';
import { apmTransportBounds } from './apm';
import type { DatasetInfo } from './types';

// Explicitly opt in against a disposable Parseable server. Every dataset belongs
// to this run and is removed even when fixture setup or an assertion fails.
// ERRORS_REFERENCE_URL=http://127.0.0.1:8450 npx vitest run src/lib/errorAnalytics.live.test.ts
// Override ERRORS_REFERENCE_USERNAME/PASSWORD for another disposable server.
const origin = process.env.ERRORS_REFERENCE_URL?.replace(/\/$/, '');
const username = process.env.ERRORS_REFERENCE_USERNAME ?? 'fixture';
const password = process.env.ERRORS_REFERENCE_PASSWORD ?? 'fixture-throwaway';
const headers = {
  authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
  'content-type': 'application/json',
};
const suffix = `${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
const logDataset = `errors_logs_${suffix}`;
const traceDataset = `errors_traces_${suffix}`;
const numericDataset = `errors_otlp_logs_${suffix}`;
const levelDataset = `errors_pino_logs_${suffix}`;
const pairDataset = `errors_trace_pairs_${suffix}`;
const datasets = [logDataset, traceDataset, numericDataset, levelDataset, pairDataset];
const attemptedDatasets = new Set<string>();
const escapedService = "checkout's / payments";
const escapedMessage = "can't charge customer '42'";
const escapedType = "Card'Declined";
let bounds: { startTime: string; endTime: string };
const schemas = new Map<string, ErrorSchema>();

async function api(path: string, method: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok)
    throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  const text = await response.text();
  return text ? JSON.parse(text) : undefined;
}

async function query(request: { sql: string; startTime: string; endTime: string }) {
  return (await api('/api/v1/query', 'POST', {
    query: request.sql,
    startTime: request.startTime,
    endTime: request.endTime,
    sendNull: true,
  })) as Record<string, unknown>[];
}

const client = {
  query,
  async schema(dataset: string) {
    const result = (await api(`/api/v1/logstream/${dataset}/schema`, 'GET')) as {
      fields: { name: string }[];
    };
    return result.fields.map((field) => field.name);
  },
  async datasetInfo(dataset: string): Promise<DatasetInfo> {
    const result = (await api(`/api/v1/logstream/${dataset}/info`, 'GET')) as {
      logSource?: { log_source_format: string }[];
      timePartition?: string;
    };
    return {
      name: dataset,
      logSourceFormats: result.logSource?.map((source) => source.log_source_format) ?? [],
      timePartition: result.timePartition,
    };
  },
};

const options = (dataset: string) => ({ dataset, schema: schemas.get(dataset)!, bounds });
const escapedIssue = { service: escapedService, errorType: escapedType, message: escapedMessage };

async function ingest(dataset: string, path: string, body: unknown) {
  attemptedDatasets.add(dataset);
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { ...headers, 'X-P-Stream': dataset },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  expect(response.ok, await response.text()).toBe(true);
}

const attribute = (key: string, value: string) => ({ key, value: { stringValue: value } });
const traceId = 'a'.repeat(32);
const spanId = (id: number) => id.toString(16).padStart(16, '0');

describe.skipIf(!origin)('Errors analytics on a real Parseable server', () => {
  beforeAll(async () => {
    const now = Date.now();
    const common = {
      'service.name': escapedService,
      'exception.type': escapedType,
      message: escapedMessage,
    };
    // Three identical error logs remain three occurrences; logs have no span
    // identity with which to deduplicate them. Different services stay separate.
    const logs: Record<string, unknown>[] = [
      { ...common, level: 'ERROR' },
      { ...common, severity: 'fatal' },
      { ...common, severity_number: 17 },
      { ...common, 'service.name': 'other-service', level: 'error' },
      { level: 'error', message: 'missing service and type' },
      { level: 'info', message: 'ordinary information' },
      { level: 'WARN', message: 'warning is not an error' },
      // More than one page of distinct issues catches accidental LIMIT-before-
      // aggregate bugs and makes the summary independent of the issue page.
      ...Array.from({ length: 27 }, (_, index) => ({
        level: 'ERROR',
        'service.name': 'pagination',
        message: `distinct failure ${String(index).padStart(2, '0')}`,
      })),
    ];
    await ingest(logDataset, '/api/v1/ingest', logs);
    // pino/bunyan numeric levels: error (50) and fatal (60) count; warn (40),
    // info (30) and the fractional 50.9 do not.
    await ingest(
      levelDataset,
      '/api/v1/ingest',
      [50, 60, 40, 30, 50.9].map((level) => ({ level, msg: `pino level ${level}` })),
    );

    const nanos = BigInt(now) * 1_000_000n;
    // A separate actual OTLP log stream checks all eight error/fatal values and
    // the server's flattened body/severity fields. The JSON fixture above also
    // includes a numeric-only row, exercising the query's numeric predicate.
    await ingest(numericDataset, '/v1/logs', {
      resourceLogs: [
        {
          resource: { attributes: [attribute('service.name', 'severity-numbers')] },
          scopeLogs: [
            {
              scope: { name: 'errors-live-regression' },
              logRecords: [
                ...Array.from({ length: 9 }, (_, index) => ({
                  timeUnixNano: String(nanos),
                  severityNumber: 16 + index,
                  severityText: index ? 'ERROR' : 'WARN',
                  body: { stringValue: `OTLP severity ${16 + index}` },
                })),
                // The server derives ERROR/FATAL categories from these bodies,
                // but unspecified severity must not qualify them as errors.
                ...['0 errors found', 'no fatal failures'].map((body) => ({
                  timeUnixNano: String(nanos),
                  severityNumber: 0,
                  body: { stringValue: body },
                })),
              ],
            },
          ],
        },
      ],
    });
    const span = (id: number, error: boolean, events = false) => ({
      traceId,
      spanId: spanId(id),
      name: `operation-${id}`,
      kind: 2,
      startTimeUnixNano: String(nanos - 10_000_000n),
      endTimeUnixNano: String(nanos),
      status: { code: error ? 2 : 1, message: error && !events ? escapedMessage : '' },
      attributes: error && !events ? [attribute('exception.type', escapedType)] : [],
      events: events
        ? [
            {
              timeUnixNano: String(nanos),
              name: 'exception',
              attributes: [
                attribute('exception.type', escapedType),
                attribute('exception.message', escapedMessage),
              ],
            },
            {
              timeUnixNano: String(nanos),
              name: 'exception',
              attributes: [
                attribute('exception.type', escapedType),
                attribute('exception.message', escapedMessage),
              ],
            },
          ]
        : [],
    });
    const envelope = (spans: ReturnType<typeof span>[]) => ({
      resourceSpans: [
        {
          resource: { attributes: [attribute('service.name', escapedService)] },
          scopeSpans: [{ scope: { name: 'errors-live-regression' }, spans }],
        },
      ],
    });
    // The first error carries its type/message only on exception events, expands
    // into event rows and is retried in a second request. The second uses span
    // attributes/status. Both must group together as two distinct error spans.
    await ingest(
      traceDataset,
      '/v1/traces',
      envelope([span(1, true, true), span(2, true), span(3, false)]),
    );
    await ingest(traceDataset, '/v1/traces', envelope([span(1, true, true)]));
    // One erroneous span with two different exception events (plus direct span
    // metadata), sent twice. Its type and message must come from the same event.
    const exceptionEvent = (type: string, message: string) => ({
      timeUnixNano: String(nanos),
      name: 'exception',
      attributes: [attribute('exception.type', type), attribute('exception.message', message)],
    });
    const twoExceptions = {
      ...span(9, true),
      status: { code: 2, message: 'status message' },
      attributes: [attribute('exception.type', 'DirectType')],
      events: [exceptionEvent('A', 'zeta'), exceptionEvent('B', 'alpha')],
    };
    for (let attempt = 0; attempt < 2; attempt++)
      await ingest(pairDataset, '/v1/traces', envelope([twoExceptions]));

    const wideBounds = {
      startTime: new Date(now - 60_000).toISOString(),
      endTime: new Date(now + 120_000).toISOString(),
    };
    for (const dataset of datasets) {
      await vi.waitFor(
        async () => {
          const rows = await query({
            ...wideBounds,
            sql: `SELECT p_timestamp FROM "${dataset}" LIMIT 1`,
          });
          expect(rows, `${dataset} should expose its persisted fixture`).toHaveLength(1);
        },
        { timeout: 30_000, interval: 500 },
      );
    }
    const timestamps = await Promise.all(
      datasets.map(async (dataset) => {
        const rows = await query({
          ...wideBounds,
          sql: `SELECT MIN(p_timestamp) AS first, MAX(p_timestamp) AS last FROM "${dataset}"`,
        });
        const utc = (value: unknown) =>
          Date.parse(`${value}${String(value).endsWith('Z') ? '' : 'Z'}`);
        return [utc(rows[0].first), utc(rows[0].last)];
      }),
    );
    bounds = {
      startTime: new Date(Math.min(...timestamps.map(([first]) => first))).toISOString(),
      endTime: new Date(Math.max(...timestamps.map(([, last]) => last)) + 1).toISOString(),
    };
    for (const dataset of datasets) schemas.set(dataset, await loadErrorSchema(client, dataset));
  }, 60_000);

  it('groups log errors by their exact service, type and message while excluding information and warnings', async () => {
    const summary = await loadErrorSummary(client, options(logDataset));
    expect(summary).toMatchObject({ occurrences: 32, issues: 30 });
    const page = await loadErrorIssues(client, options(logDataset));
    expect(page.rows[0]).toMatchObject({ ...escapedIssue, occurrences: 3 });
    const series = await loadErrorSeries(client, options(logDataset));
    expect(series.reduce((sum, bucket) => sum + bucket.occurrences, 0)).toBe(32);
  });

  it('paginates all thirty issues without changing the full-range summary or repeating a group', async () => {
    const first = await loadErrorIssues(client, options(logDataset));
    const second = await loadErrorIssues(client, { ...options(logDataset), offset: 25 });
    expect(first.rows).toHaveLength(25);
    expect(first.hasMore).toBe(true);
    expect(second.rows).toHaveLength(5);
    expect(second.hasMore).toBe(false);
    const all = [...first.rows, ...second.rows];
    expect(new Set(all.map((issue) => issue.id)).size).toBe(30);
    expect(all.reduce((sum, issue) => sum + issue.occurrences, 0)).toBe(32);
    expect(all).toContainEqual(
      expect.objectContaining({
        service: null,
        errorType: null,
        message: 'missing service and type',
        occurrences: 1,
      }),
    );
    expect(all).toContainEqual(
      expect.objectContaining({
        ...escapedIssue,
        service: 'other-service',
        occurrences: 1,
      }),
    );
  });

  it('executes escaped issue filters for both matching occurrences and matching frequency', async () => {
    const page = await loadErrorOccurrences(client, {
      ...options(logDataset),
      issue: escapedIssue,
    });
    expect(page.rows).toHaveLength(3);
    expect(page.hasMore).toBe(false);
    expect(page.rows.every((row) => row.traceId === null && row.spanId === null)).toBe(true);
    const series = await loadErrorSeries(client, { ...options(logDataset), issue: escapedIssue });
    expect(series.reduce((sum, bucket) => sum + bucket.occurrences, 0)).toBe(3);
    const missing = await loadErrorOccurrences(client, {
      ...options(logDataset),
      issue: { service: null, errorType: null, message: 'missing service and type' },
    });
    expect(missing.rows).toHaveLength(1);
  });

  it('counts each erroneous span once across event fan-out and exporter retries', async () => {
    expect(schemas.get(traceDataset)?.source).toBe('traces');
    expect(await loadErrorSummary(client, options(traceDataset))).toMatchObject({
      occurrences: 2,
      issues: 1,
    });
    const issues = await loadErrorIssues(client, options(traceDataset));
    expect(issues.rows).toHaveLength(1);
    expect(issues.rows[0]).toMatchObject({ ...escapedIssue, occurrences: 2 });
    const occurrences = await loadErrorOccurrences(client, {
      ...options(traceDataset),
      issue: escapedIssue,
    });
    expect(occurrences.rows.map((row) => row.spanId).sort()).toEqual([spanId(1), spanId(2)]);
    expect(occurrences.rows.every((row) => row.traceId === traceId)).toBe(true);
    const series = await loadErrorSeries(client, options(traceDataset));
    expect(series.reduce((sum, bucket) => sum + bucket.occurrences, 0)).toBe(2);
  });

  it('executes the SQL investigation handoff and returns the original matching log fields', async () => {
    const records = await query({
      sql: buildErrorExplorerSql({ ...options(logDataset), issue: escapedIssue }),
      ...apmTransportBounds(bounds),
    });
    expect(records).toHaveLength(3);
    for (const record of records) {
      expect(record).toMatchObject({
        'service.name': escapedService,
        'exception.type': escapedType,
        message: escapedMessage,
      });
      expect(record.p_timestamp).toEqual(expect.any(String));
      expect(record).toHaveProperty('level');
    }
  });

  it('recognizes all OTLP error and fatal severity numbers from 17 through 24', async () => {
    expect(schemas.get(numericDataset)?.source).toBe('logs');
    expect(await loadErrorSummary(client, options(numericDataset))).toMatchObject({
      occurrences: 8,
      issues: 8,
    });
    const issues = await loadErrorIssues(client, options(numericDataset));
    expect(issues.rows.map((issue) => issue.message).sort()).toEqual(
      Array.from({ length: 8 }, (_, index) => `OTLP severity ${17 + index}`),
    );
  });

  it('excludes OTLP body-inferred categories from counts, frequency and SQL investigation', async () => {
    const target = options(numericDataset);
    // Verify the actual ingestion fallback, so this test cannot pass merely
    // because the misleading records were not ingested.
    const stored = await query({
      ...apmTransportBounds(bounds),
      sql: `SELECT body, p_log_category FROM "${numericDataset}" WHERE severity_number = 0 ORDER BY body`,
    });
    expect(stored).toEqual([
      { body: '0 errors found', p_log_category: 'ERROR' },
      { body: 'no fatal failures', p_log_category: 'FATAL' },
    ]);
    expect(await loadErrorSummary(client, target)).toMatchObject({ occurrences: 8, issues: 8 });
    const series = await loadErrorSeries(client, target);
    expect(series.reduce((sum, bucket) => sum + bucket.occurrences, 0)).toBe(8);
    for (const { body } of stored) {
      const issue = { service: 'severity-numbers', errorType: null, message: String(body) };
      expect((await loadErrorOccurrences(client, { ...target, issue })).rows).toEqual([]);
      expect(
        await query({
          sql: buildErrorExplorerSql({ ...target, issue }),
          ...apmTransportBounds(bounds),
        }),
      ).toEqual([]);
    }
  });

  it('keeps a span exception type and message paired across several exception events and a retry', async () => {
    expect(await loadErrorSummary(client, options(pairDataset))).toMatchObject({
      occurrences: 1,
      issues: 1,
    });
    const issues = await loadErrorIssues(client, options(pairDataset));
    expect(issues.rows).toEqual([
      expect.objectContaining({
        service: escapedService,
        errorType: 'A',
        message: 'zeta',
        occurrences: 1,
      }),
    ]);
    const occurrences = await loadErrorOccurrences(client, {
      ...options(pairDataset),
      issue: issues.rows[0],
    });
    expect(occurrences.rows.map((row) => row.spanId)).toEqual([spanId(9)]);
  });

  it('recognizes pino/bunyan numeric error and fatal levels exactly', async () => {
    expect(schemas.get(levelDataset)?.severity.text).toContain('level');
    expect(await loadErrorSummary(client, options(levelDataset))).toMatchObject({
      occurrences: 2,
      issues: 2,
    });
    const issues = await loadErrorIssues(client, options(levelDataset));
    expect(issues.rows.map((issue) => issue.message).sort()).toEqual([
      'pino level 50',
      'pino level 60',
    ]);
  });

  it('honors an exclusive fractional upper bound and returns empty results before fixture ingestion', async () => {
    const before = {
      startTime: new Date(Date.parse(bounds.startTime) - 1).toISOString(),
      endTime: bounds.startTime,
    };
    const request = { ...options(logDataset), bounds: before };
    expect(await loadErrorSummary(client, request)).toMatchObject({ occurrences: 0, issues: 0 });
    expect((await loadErrorIssues(client, request)).rows).toEqual([]);
    expect(
      (await loadErrorSeries(client, request)).every((bucket) => bucket.occurrences === 0),
    ).toBe(true);
    expect((await loadErrorOccurrences(client, { ...request, issue: escapedIssue })).rows).toEqual(
      [],
    );
  });

  afterAll(async () => {
    const failures: string[] = [];
    for (const dataset of attemptedDatasets) {
      try {
        const response = await fetch(`${origin}/api/v1/logstream/${dataset}`, {
          method: 'DELETE',
          headers,
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok && response.status !== 404)
          failures.push(`${dataset}: ${response.status} ${await response.text()}`);
      } catch (error) {
        failures.push(`${dataset}: ${String(error)}`);
      }
    }
    expect(failures, 'Disposable error fixture datasets must be removed').toEqual([]);
  }, 30_000);
});
