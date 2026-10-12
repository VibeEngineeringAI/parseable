import { ApiError } from './apiError';
import { mapConcurrent } from './concurrency';
import { paramsRange, quoteIdentifier, timeBounds } from './query';
import type { LogRecord, ParseableClient, QueryRequest, TimeRange } from './types';

// Classic agents uses Enterprise /api/prism/v1/agent-observability APIs.
// Community can inspect the same flattened telemetry through its SQL endpoint.
export const AGENT_FIELDS = [
  'gen_ai.agent.name',
  'gen_ai.agent.id',
  'gen_ai.operation.name',
  'gen_ai.request.model',
  'gen_ai.tool.name',
] as const;
export const AGENT_RECORD_LIMIT = 100;
export function isAgentSchema(fields: string[]) {
  return AGENT_FIELDS.some((field) => fields.includes(field));
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
export function buildAgentQuery(
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
  return {
    sql: `SELECT * FROM ${quoteIdentifier(dataset)} WHERE ${AGENT_FIELDS.filter((field) =>
      fields.includes(field),
    )
      .map((field) => `${quoteIdentifier(field)} IS NOT NULL`)
      .join(' OR ')} ORDER BY ${quoteIdentifier(timeColumn)} DESC LIMIT ${AGENT_RECORD_LIMIT}`,
    ...timeBounds(bounds),
  };
}
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
  'span_status_code',
  'span_duration_ns',
  'gen_ai.usage.input_tokens',
  'gen_ai.usage.output_tokens',
];
export function agentDemoRows(now = Date.now()): LogRecord[] {
  return ['Support assistant', 'Research assistant', 'Support assistant'].map((name, index) => ({
    p_timestamp: new Date(now - (index + 1) * 60000).toISOString(),
    'gen_ai.agent.name': name,
    'gen_ai.operation.name': index === 2 ? 'execute_tool' : 'invoke_agent',
    'gen_ai.request.model': 'example-model',
    'gen_ai.tool.name': index === 2 ? 'search_documents' : undefined,
    span_trace_id: String(index + 1).padStart(32, '0'),
    span_span_id: String(index + 1).padStart(16, '0'),
    span_status_code: index === 1 ? 2 : 1,
    span_duration_ns: 1240000000,
    'gen_ai.usage.input_tokens': 240,
    'gen_ai.usage.output_tokens': 80,
  }));
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
