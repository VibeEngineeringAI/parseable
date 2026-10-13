import { detectAgentHarnesses, harnessRowPredicate, harnessRunPredicate } from './agentHarnesses';
import { ApiError } from './apiError';
import { apmTransportBounds } from './apm';
import { mapConcurrent } from './concurrency';
import { paramsRange, quoteIdentifier, quoteLiteral, timeBounds } from './query';
import type { LogRecord, ParseableClient, QueryRequest, TimeRange } from './types';

// Classic agents uses Enterprise /api/prism/v1/agent-observability APIs.
// Community can inspect the same flattened telemetry through its SQL endpoint.
export const AGENT_FIELDS = [
  'gen_ai.agent.name',
  'gen_ai.agent.id',
  'gen_ai.operation.name',
  'gen_ai.request.model',
  'gen_ai.response.model',
  'gen_ai.tool.name',
] as const;
export const AGENT_RECORD_LIMIT = 1000;
export const AGENT_RUN_LIMIT = 100;
export function isAgentSchema(fields: string[]) {
  return (
    AGENT_FIELDS.some((field) => fields.includes(field)) || detectAgentHarnesses(fields).length > 0
  );
}
export function agentsPath(dataset?: string) {
  return dataset ? `/agents/${encodeURIComponent(dataset)}` : '/agents';
}
export async function discoverAgentDatasets(client: ParseableClient, signal?: AbortSignal) {
  const datasets = await client.listDatasets(signal);
  const inspected = await mapConcurrent(datasets, 4, async (dataset) => {
    signal?.throwIfAborted();
    try {
      return {
        name: dataset.name,
        compatible: isAgentSchema(await client.schema(dataset.name, signal)),
      };
    } catch (error) {
      if (signal?.aborted || (error instanceof ApiError && error.status === 401)) throw error;
      if (error instanceof ApiError && [403, 404].includes(error.status))
        return { name: dataset.name, compatible: false };
      return {
        name: dataset.name,
        compatible: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
  return {
    datasets: inspected.filter((entry) => entry.compatible),
    unchecked: inspected.filter((entry) => entry.error),
  };
}
export function buildAgentRunQuery(
  dataset: string,
  fields: string[],
  bounds: { startTime: string; endTime: string },
  timeColumn = 'p_timestamp',
): QueryRequest {
  if (!isAgentSchema(fields))
    throw new Error(
      'This dataset has no recognized GenAI agent, model, operation, or tool fields.',
    );
  if (!fields.includes(timeColumn))
    throw new Error(`Dataset schema is missing the time field ${timeColumn}.`);
  const harnesses = detectAgentHarnesses(fields);
  const agentPredicate = [
    ...AGENT_FIELDS.filter((field) => fields.includes(field)).map(
      (field) => `${quoteIdentifier(field)} IS NOT NULL`,
    ),
    ...harnesses.map(harnessRunPredicate),
  ].join(' OR ');
  const rowPredicate = harnesses
    .map((harness) => harnessRowPredicate(harness, fields, AGENT_FIELDS))
    .filter(Boolean)
    .join(' AND ');
  const traceField = ['span_trace_id', 'trace_id'].find((field) => fields.includes(field));
  const table = quoteIdentifier(dataset);
  const time = quoteIdentifier(timeColumn);
  const exactBounds = timeBounds(bounds);
  const timePredicate = `${time} >= TIMESTAMP ${quoteLiteral(exactBounds.startTime)} AND ${time} < TIMESTAMP ${quoteLiteral(exactBounds.endTime)}`;
  const trace = traceField && quoteIdentifier(traceField);
  // Time bounds are injected into every table scan, including subqueries, by the
  // SQL endpoint. Seed recent GenAI traces, then keep their untagged child spans.
  const predicate = trace
    ? `${trace} IN (SELECT ${trace} FROM ${table} WHERE ${timePredicate} AND (${agentPredicate}) AND ${trace} IS NOT NULL AND ${trace} <> '' GROUP BY ${trace} ORDER BY MAX(${time}) DESC LIMIT ${AGENT_RUN_LIMIT}) OR ((${trace} IS NULL OR ${trace} = '') AND (${agentPredicate}))`
    : agentPredicate;
  return {
    sql: `SELECT * FROM ${table} WHERE ${timePredicate} AND (${predicate})${rowPredicate ? ` AND ${rowPredicate}` : ''} ORDER BY ${time} DESC LIMIT ${AGENT_RECORD_LIMIT}`,
    ...apmTransportBounds(exactBounds),
  };
}
export const buildAgentQuery = buildAgentRunQuery;
export function agentText(row: LogRecord, ...fields: string[]) {
  for (const field of fields) {
    const value = row[field];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '—';
}
export const agentDemoFields = [
  'p_timestamp',
  ...AGENT_FIELDS,
  'span_trace_id',
  'span_span_id',
  'span_parent_span_id',
  'span_name',
  'span_status_code',
  'span_status_message',
  'span_start_time_unix_nano',
  'span_end_time_unix_nano',
  'span_end_time_unix_nano_epoch',
  'span_duration_ns',
  'gen_ai.usage.input_tokens',
  'gen_ai.usage.output_tokens',
  'gen_ai.input.messages',
  'gen_ai.output.messages',
  'event_name',
  'event_exception.message',
];
export function agentDemoRows(now = Date.now()): LogRecord[] {
  const span = (
    trace: number,
    id: number,
    parent: number | undefined,
    offset: number,
    duration: number | undefined,
    fields: LogRecord,
  ): LogRecord => ({
    p_timestamp: new Date(now - trace * 60000 + offset).toISOString(),
    span_trace_id: String(trace).padStart(32, '0'),
    span_span_id: String(id).padStart(16, '0'),
    span_parent_span_id: parent === undefined ? '' : String(parent).padStart(16, '0'),
    span_start_time_unix_nano: new Date(now - trace * 60000 + offset).toISOString(),
    ...(duration === undefined
      ? { span_end_time_unix_nano_epoch: 0 }
      : {
          span_end_time_unix_nano: new Date(now - trace * 60000 + offset + duration).toISOString(),
          span_duration_ns: duration * 1e6,
          span_status_code: 1,
        }),
    ...fields,
  });
  const model = span(1, 12, 11, 100, 1000, {
    span_name: 'chat example-model',
    'gen_ai.operation.name': 'chat',
    'gen_ai.request.model': 'example-model',
    'gen_ai.usage.input_tokens': 240,
    'gen_ai.usage.output_tokens': 80,
    'gen_ai.input.messages': [
      { role: 'user', parts: [{ type: 'text', content: 'How do I reset my password?' }] },
    ],
    'gen_ai.output.messages': [
      {
        role: 'assistant',
        parts: [{ type: 'text', content: 'Use the password reset link on the sign-in page.' }],
      },
    ],
  });
  return [
    span(1, 11, undefined, 0, 1500, {
      span_name: 'Support assistant',
      'gen_ai.agent.name': 'Support assistant',
      'gen_ai.operation.name': 'invoke_agent',
    }),
    model,
    {
      ...model,
      event_name: 'gen_ai.client.inference.operation.details',
      event_time_unix_nano: model.span_end_time_unix_nano,
    },
    span(1, 13, 11, 1100, 200, {
      span_name: 'search_documents',
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': 'search_documents',
      'gen_ai.tool.call.arguments': { query: 'password reset' },
      'gen_ai.tool.call.result': { matches: 2 },
    }),
    span(1, 14, 13, 1150, 100, { span_name: 'GET /documents', 'http.request.method': 'GET' }),
    span(2, 21, undefined, 0, 800, {
      span_name: 'Research assistant',
      'gen_ai.agent.name': 'Research assistant',
      'gen_ai.operation.name': 'invoke_agent',
      span_status_code: 2,
      span_status_message: 'Document service timed out',
    }),
    span(2, 22, 21, 100, 600, {
      span_name: 'search_documents',
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': 'search_documents',
      span_status_code: 2,
      event_name: 'exception',
      'event_exception.message': 'Document service timed out',
    }),
    span(3, 31, undefined, 0, undefined, {
      span_name: 'Draft assistant',
      'gen_ai.agent.name': 'Draft assistant',
      'gen_ai.operation.name': 'invoke_agent',
    }),
    span(3, 32, 31, 100, undefined, {
      span_name: 'chat example-model',
      'gen_ai.operation.name': 'chat',
      'gen_ai.request.model': 'example-model',
      'gen_ai.input.messages': [{ role: 'user', content: 'Draft a welcome email.' }],
    }),
  ];
}

export function agentRangeFromParams(params: URLSearchParams): TimeRange {
  const preset = params.get('range');
  if (preset) {
    try {
      timeBounds(preset as TimeRange);
      return preset as TimeRange;
    } catch {
      /* Ignore unsupported presets. */
    }
  }
  return paramsRange(params);
}
export function agentBoundsFromParams(params: URLSearchParams) {
  if (params.get('start') && params.get('end')) {
    try {
      return timeBounds({ startTime: params.get('start')!, endTime: params.get('end')! });
    } catch {
      /* Use a valid preset instead. */
    }
  }
  return timeBounds(agentRangeFromParams(params));
}
