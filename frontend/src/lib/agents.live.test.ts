import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseEventTimestamp } from '../components/explorer/timestamp';
import { apmTransportBounds } from './apm';
import { buildAgentRunQuery } from './agents';
import { buildAgentRuns } from './agentRuns';
import type { LogRecord, QueryRequest } from './types';

// Opt in against a disposable loopback Parseable server; never a production dataset.
// PARSEABLE_AGENTS_LIVE_URL=http://127.0.0.1:8393 npx vitest run src/lib/agents.live.test.ts
// Reference validation uses quay.io/parseablehq/parseable:v3.2.4, not rebuilt Rust.
const origin = process.env.PARSEABLE_AGENTS_LIVE_URL?.replace(/\/$/, '');
const username = process.env.PARSEABLE_AGENTS_LIVE_USERNAME ?? 'fixture';
const password = process.env.PARSEABLE_AGENTS_LIVE_PASSWORD ?? 'fixture-throwaway';
const headers = {
  authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
  'content-type': 'application/json',
};
const dataset = `agents_live_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
const successTrace = randomUUID().replaceAll('-', '');
const failureTrace = randomUUID().replaceAll('-', '');
const incompleteTrace = randomUUID().replaceAll('-', '');
const unrelatedTrace = randomUUID().replaceAll('-', '');
const spanId = (id: number) => id.toString(16).padStart(16, '0');
const attribute = (key: string, value: string) => ({ key, value: { stringValue: value } });
const integer = (key: string, value: number) => ({ key, value: { intValue: String(value) } });
let attemptedIngest = false;
let fields: string[];
let bounds: { startTime: string; endTime: string };
let wideBounds: { startTime: string; endTime: string };

async function api(path: string, method: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: { ...headers, ...(path === '/v1/traces' ? { 'X-P-Stream': dataset } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok)
    throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  const text = await response.text();
  return text ? JSON.parse(text) : undefined;
}

async function query(request: QueryRequest): Promise<LogRecord[]> {
  return (await api('/api/v1/query', 'POST', {
    query: request.sql,
    startTime: request.startTime,
    endTime: request.endTime,
    sendNull: true,
  })) as LogRecord[];
}

function envelope(spans: unknown[]) {
  return {
    resourceSpans: [
      {
        resource: { attributes: [attribute('service.name', 'agents-live-regression')] },
        scopeSpans: [{ scope: { name: 'agents-live-regression' }, spans }],
      },
    ],
  };
}

describe.skipIf(!origin)('Agents runs on a real Parseable/DataFusion server', () => {
  beforeAll(async () => {
    const url = new URL(origin!);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
      throw new Error('The agents live suite requires a disposable loopback server.');
    const now = Date.now();
    const nanos = (offset: number) => String(BigInt(now + offset) * 1_000_000n);
    const span = (
      traceId: string,
      id: number,
      parent: number | undefined,
      offset: number,
      duration: number,
      extra: Record<string, unknown> = {},
    ) => ({
      traceId,
      spanId: spanId(id),
      ...(parent === undefined ? {} : { parentSpanId: spanId(parent) }),
      name: `operation-${id}`,
      kind: 2,
      startTimeUnixNano: nanos(offset),
      endTimeUnixNano: nanos(offset + duration),
      status: { code: 1 },
      ...extra,
    });
    attemptedIngest = true;
    await api(
      '/v1/traces',
      'POST',
      envelope([
        span(successTrace, 11, undefined, -2000, 1500, {
          name: 'Support assistant',
          attributes: [
            attribute('gen_ai.agent.name', 'Support assistant'),
            attribute('gen_ai.operation.name', 'invoke_agent'),
            integer('gen_ai.usage.input_tokens', 120),
            integer('gen_ai.usage.output_tokens', 30),
          ],
        }),
        span(successTrace, 12, 11, -1900, 700, {
          name: 'chat example-model',
          // OTel's normal UNSET status with a valid end still represents completion.
          status: { code: 0 },
          attributes: [
            attribute('gen_ai.operation.name', 'chat'),
            attribute('gen_ai.request.model', 'example-model'),
            integer('gen_ai.usage.input_tokens', 120),
            integer('gen_ai.usage.output_tokens', 30),
            attribute(
              'gen_ai.input.messages',
              JSON.stringify([{ role: 'user', content: 'Hello' }]),
            ),
            attribute(
              'gen_ai.output.messages',
              JSON.stringify([{ role: 'assistant', content: 'Hi' }]),
            ),
          ],
          events: [
            {
              name: 'gen_ai.user.message',
              timeUnixNano: nanos(-1850),
              attributes: [attribute('role', 'user'), attribute('content', 'Hello')],
            },
            {
              name: 'gen_ai.assistant.message',
              timeUnixNano: nanos(-1250),
              attributes: [attribute('role', 'assistant'), attribute('content', 'Hi')],
            },
          ],
          links: [{ traceId: unrelatedTrace, spanId: spanId(99) }],
        }),
        span(successTrace, 13, 11, -1100, 300, {
          name: 'search_documents',
          // A tool failure recovered by the completed root remains inspectable.
          status: { code: 2, message: 'Recovered document timeout' },
          attributes: [
            attribute('gen_ai.operation.name', 'execute_tool'),
            attribute('gen_ai.tool.name', 'search_documents'),
          ],
          events: [
            {
              name: 'exception',
              timeUnixNano: nanos(-900),
              attributes: [
                attribute('exception.type', 'TimeoutError'),
                attribute('exception.message', 'Recovered document timeout'),
              ],
            },
          ],
        }),
        // This child has no GenAI attributes. The trace-seeded outer query must retain it.
        span(successTrace, 14, 13, -1050, 100, {
          name: 'GET /documents',
          attributes: [attribute('http.request.method', 'GET')],
        }),
        span(failureTrace, 21, undefined, -1500, 600, {
          name: 'Failed assistant',
          status: { code: 2, message: 'Unrecoverable upstream error' },
          attributes: [
            attribute('gen_ai.agent.name', 'Failed assistant'),
            attribute('gen_ai.operation.name', 'invoke_agent'),
          ],
        }),
        span(incompleteTrace, 31, undefined, -1000, 0, {
          name: 'Incomplete assistant',
          endTimeUnixNano: '0',
          status: undefined,
          attributes: [
            attribute('gen_ai.agent.name', 'Incomplete assistant'),
            attribute('gen_ai.operation.name', 'invoke_agent'),
          ],
        }),
        // Missing model/usage/content/status are represented by absent telemetry.
        span(incompleteTrace, 32, 31, -900, 100, {
          name: 'Uninstrumented call',
          status: undefined,
        }),
        // A generic span from a separate trace must not appear just because it shares the dataset.
        span(unrelatedTrace, 99, undefined, -500, 100, { name: 'Unrelated HTTP request' }),
      ]),
    );
    wideBounds = apmTransportBounds({
      startTime: new Date(now - 60_000).toISOString(),
      endTime: new Date(now + 120_000).toISOString(),
    });
    let firstRows: LogRecord[] = [];
    await vi.waitFor(
      async () => {
        firstRows = await query({ ...wideBounds, sql: `SELECT * FROM "${dataset}"` });
        expect(firstRows).toHaveLength(10);
      },
      { timeout: 30_000, interval: 500 },
    );
    const times = firstRows.map((row) => parseEventTimestamp(row.p_timestamp));
    expect(times.every(Number.isFinite)).toBe(true);
    const last = Math.max(...times);
    // End strictly inside the persisted ingestion minute; the backend's transport
    // floor would omit these records without the generated expanded envelope.
    bounds = {
      startTime: new Date(Math.min(...times) - 5000).toISOString(),
      endTime: new Date(last + 1).toISOString(),
    };
    expect(Math.floor(Date.parse(bounds.endTime) / 60000)).toBe(Math.floor(last / 60000));
    const schema = (await api(`/api/v1/logstream/${dataset}/schema`, 'GET')) as {
      fields: { name: string }[];
    };
    fields = schema.fields.map((field) => field.name);
    // Add one later child to an already-seeded trace. The exact outer time
    // predicate must exclude it although the transport envelope includes it.
    await api(
      '/v1/traces',
      'POST',
      envelope([
        span(successTrace, 15, 11, -500, 100, { name: 'Late child outside selected range' }),
      ]),
    );
    await vi.waitFor(
      async () => {
        const lateRows = await query({
          ...wideBounds,
          sql: `SELECT p_timestamp FROM "${dataset}" WHERE span_span_id = '${spanId(15)}'`,
        });
        expect(lateRows).toHaveLength(1);
        expect(parseEventTimestamp(lateRows[0].p_timestamp)).toBeGreaterThanOrEqual(
          Date.parse(bounds.endTime),
        );
      },
      { timeout: 30_000, interval: 500 },
    );
  }, 60_000);

  afterAll(async () => {
    if (!attemptedIngest) return;
    const response = await fetch(`${origin}/api/v1/logstream/${dataset}`, {
      method: 'DELETE',
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    expect(response.ok || response.status === 404, await response.text()).toBe(true);
  });

  it('executes the actual bounded SQL, retaining untagged children and excluding unrelated traces', async () => {
    const rows = await query(buildAgentRunQuery(dataset, fields, bounds));
    expect(rows).toHaveLength(9);
    expect(new Set(rows.map((row) => row.span_trace_id))).toEqual(
      new Set([successTrace, failureTrace, incompleteTrace]),
    );
    const generic = rows.find((row) => row.span_span_id === spanId(14));
    expect(generic?.span_name).toBe('GET /documents');
    expect(generic?.['gen_ai.operation.name'] ?? null).toBeNull();
    expect(rows.some((row) => row.span_span_id === spanId(15))).toBe(false);
  });

  it('groups real flattened event/link rows once and preserves completion, failures, and missing telemetry', async () => {
    const runs = buildAgentRuns(
      await query(buildAgentRunQuery(dataset, fields, bounds)),
      'p_timestamp',
      { bounds },
    );
    expect(runs).toHaveLength(3);
    const successful = runs.find((run) => run.traceId === successTrace)!;
    const failed = runs.find((run) => run.traceId === failureTrace)!;
    const incomplete = runs.find((run) => run.traceId === incompleteTrace)!;
    expect(successful).toMatchObject({
      name: 'Support assistant',
      status: 'success',
      durationMs: 1500,
      inputTokens: 120,
      outputTokens: 30,
      models: ['example-model'],
    });
    expect(successful.spans).toHaveLength(4);
    expect(successful.roots).toHaveLength(1);
    expect(successful.roots[0].children).toHaveLength(2);
    const model = successful.spans.find((entry) => entry.kind === 'model')!;
    expect(model.rows).toHaveLength(3);
    expect(model.status).toBe('success');
    expect(
      model.conversation.filter((entry) => entry.label === 'gen_ai.input.messages'),
    ).toHaveLength(1);
    expect(
      model.conversation.filter((entry) => entry.label === 'gen_ai.output.messages'),
    ).toHaveLength(1);
    expect(
      model.conversation.some(
        (entry) => entry.label.includes('gen_ai.user.message') && entry.value === 'Hello',
      ),
    ).toBe(true);
    expect(successful.warnings).toContain(
      'Child spans reported errors; captured errors remain available in run details.',
    );
    expect(successful.spans.find((entry) => entry.kind === 'tool')?.errors).toContain(
      'Recovered document timeout',
    );
    expect(failed.status).toBe('failed');
    expect(failed.spans[0].errors).toContain('Unrecoverable upstream error');
    expect(incomplete.status).toBe('incomplete');
    expect(incomplete.durationMs).toBeUndefined();
    expect(incomplete.models).toEqual([]);
    expect(incomplete.inputTokens).toBeUndefined();
    expect(incomplete.outputTokens).toBeUndefined();
  });

  it('enforces exact half-open sub-minute bounds instead of the wider transport minute', async () => {
    const request = buildAgentRunQuery(dataset, fields, bounds);
    expect(Date.parse(request.endTime)).toBeGreaterThan(Date.parse(bounds.endTime));
    const later = {
      startTime: bounds.endTime,
      endTime: new Date(Date.parse(bounds.endTime) + 1).toISOString(),
    };
    expect(await query(buildAgentRunQuery(dataset, fields, later))).toEqual([]);
    // Wider bounds prove the late row exists and shares a selected trace, while
    // the generated exact outer predicate excluded it from the earlier query.
    const wideRows = await query(buildAgentRunQuery(dataset, fields, wideBounds));
    expect(wideRows.some((row) => row.span_span_id === spanId(15))).toBe(true);
  });
});
