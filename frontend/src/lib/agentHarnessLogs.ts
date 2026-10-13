import { parseEventTimestamp } from '../components/explorer/timestamp';
import type { AgentHarness } from './agentHarnesses';
import type { AgentConversationEntry, AgentRun, AgentSpan } from './agentRuns';
import { AGENT_RECORD_LIMIT } from './agents';
import { ApiError } from './apiError';
import { apmTransportBounds } from './apm';
import { mapConcurrent } from './concurrency';
import { quoteIdentifier, quoteLiteral, timeBounds } from './query';
import type { LogRecord, ParseableClient, QueryRequest } from './types';

// Coding-agent CLIs export prompts, responses and tool results as log records
// stamped with the trace and span they happened in. Joining them by trace ID
// fills the Conversation tab for runs built from the harness's traces.
const LOG_PROFILES: Record<AgentHarness, { signature: string[]; events: string[] }> = {
  codex: {
    signature: ['conversation.id', 'originator'],
    events: ['codex.user_prompt', 'codex.tool_result', 'codex.tool_decision'],
  },
  'claude-code': {
    signature: ['prompt.id', 'event.sequence'],
    events: ['user_prompt', 'assistant_response', 'tool_result', 'tool_decision'],
  },
};
// Claude Code records tool output as an event on the tool span, not as a log.
const CLAUDE_TOOL_OUTPUT = 'tool.output';
const REDACTED = new Set(['[REDACTED]', '<REDACTED>']);

/** The harness whose logs this dataset holds; traces datasets are not logs. */
export function detectHarnessLogs(fields: string[]): AgentHarness | undefined {
  if (fields.includes('span_name') || !fields.includes('trace_id')) return;
  if (!fields.includes('event.name')) return;
  return (Object.keys(LOG_PROFILES) as AgentHarness[]).find((harness) =>
    LOG_PROFILES[harness].signature.every((field) => fields.includes(field)),
  );
}

/** Logs datasets holding this harness's events, skipping datasets that cannot be read. */
export async function discoverHarnessLogs(
  client: ParseableClient,
  harness: AgentHarness,
  signal?: AbortSignal,
) {
  const datasets = await client.listDatasets(signal);
  const matches = await mapConcurrent(datasets, 4, async ({ name }) => {
    signal?.throwIfAborted();
    try {
      return detectHarnessLogs(await client.schema(name, signal)) === harness ? name : undefined;
    } catch (error) {
      if (signal?.aborted || (error instanceof ApiError && error.status === 401)) throw error;
      return undefined;
    }
  });
  return matches.filter((name): name is string => !!name);
}

/** Prefer the logs dataset named like the traces dataset, e.g. codex-traces → codex-logs. */
export function pairedLogsDataset(traces: string, candidates: string[]) {
  const sorted = [...candidates].sort();
  return (
    sorted.find((name) => name === traces.replace(/traces?/i, 'logs')) ??
    sorted.find((name) => name === traces.replace(/traces?/i, 'log')) ??
    sorted[0]
  );
}

/** Conversation log records for the loaded runs' traces. */
export function buildHarnessLogQuery(
  dataset: string,
  harness: AgentHarness,
  traceIds: string[],
  bounds: { startTime: string; endTime: string },
  timeColumn = 'p_timestamp',
): QueryRequest | undefined {
  const ids = [...new Set(traceIds.filter((id) => id.trim()))];
  if (!ids.length) return;
  const exact = timeBounds(bounds);
  const time = quoteIdentifier(timeColumn);
  const events = LOG_PROFILES[harness].events.map(quoteLiteral).join(', ');
  return {
    sql: `SELECT * FROM ${quoteIdentifier(dataset)} WHERE ${time} >= TIMESTAMP ${quoteLiteral(exact.startTime)} AND ${time} < TIMESTAMP ${quoteLiteral(exact.endTime)} AND ${quoteIdentifier('trace_id')} IN (${ids.map(quoteLiteral).join(', ')}) AND ${quoteIdentifier('event.name')} IN (${events}) ORDER BY ${time} ASC LIMIT ${AGENT_RECORD_LIMIT}`,
    ...apmTransportBounds(exact),
  };
}

function text(row: LogRecord, ...fields: string[]) {
  for (const field of fields) {
    const value = row[field];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
}
function entry(label: string, value: unknown): AgentConversationEntry[] {
  if (value === undefined || value === null || value === '') return [];
  return [
    {
      label:
        typeof value === 'string' && REDACTED.has(value.trim()) ? `${label} (redacted)` : label,
      value,
    },
  ];
}
function withTool(label: string, row: LogRecord) {
  const tool = text(row, 'tool_name');
  return tool ? `${label} · ${tool}` : label;
}

type Occurrence = {
  time: number;
  sequence: number;
  target?: AgentSpan;
  entries: AgentConversationEntry[];
};

/**
 * Append harness conversation events to the spans they belong to, in the order
 * they happened. Records whose run is not loaded are ignored, never guessed.
 */
export function attachHarnessConversation(
  runs: AgentRun[],
  harness: AgentHarness | undefined,
  logs: LogRecord[] = [],
): AgentRun[] {
  if (!harness) return runs;
  const spans = new Map<string, AgentSpan>();
  const calls = new Map<string, AgentSpan>();
  const requests = new Map<string, AgentSpan>();
  const roots = new Map<string, AgentSpan>();
  for (const run of runs) {
    if (run.traceId)
      roots.set(run.traceId, run.roots.find((span) => span.kind === 'agent') ?? run.roots[0]);
    for (const span of run.spans) {
      if (run.traceId && span.spanId) spans.set(`${run.traceId}/${span.spanId}`, span);
      const call = text(span.row, 'gen_ai.tool.call.id', 'tool_use_id', 'call_id');
      if (span.kind === 'tool' && call) calls.set(call, span);
      const request = text(span.row, 'gen_ai.response.id', 'request_id');
      if (span.kind === 'model' && request) requests.set(request, span);
    }
  }
  const occurrences: Occurrence[] = [];
  const at = (row: LogRecord, ...fields: string[]) => {
    for (const field of fields) {
      const parsed = parseEventTimestamp(row[field]);
      if (Number.isFinite(parsed)) return parsed;
    }
    return Number.POSITIVE_INFINITY;
  };
  for (const row of logs) {
    const trace = text(row, 'trace_id');
    if (!trace || !roots.has(trace)) continue;
    const own = spans.get(`${trace}/${text(row, 'span_id')}`);
    const event = String(row['event.name'] ?? '').replace(/^claude_code\./, '');
    const tool = calls.get(text(row, 'tool_use_id', 'call_id') ?? '');
    let target = own ?? roots.get(trace);
    let entries: AgentConversationEntry[] = [];
    if (event === 'codex.user_prompt' || event === 'user_prompt') {
      entries = entry('User prompt', row.prompt ?? row.prompt_text);
    } else if (event === 'assistant_response') {
      // A response belongs to its model call, which may be a separate trace.
      target = requests.get(text(row, 'request_id') ?? '') ?? target;
      entries = entry('Assistant response', row.response);
    } else if (event === 'codex.tool_result') {
      target = tool ?? target;
      entries = [
        ...entry(withTool('Tool arguments', row), row.arguments),
        ...entry(withTool('Tool output', row), row.output),
      ];
    } else if (event === 'tool_result') {
      target = tool ?? target;
      entries = entry(withTool('Tool input', row), row.tool_input ?? row.tool_parameters);
    } else if (event === 'codex.tool_decision' || event === 'tool_decision') {
      target = tool ?? target;
      const source = text(row, 'source');
      entries = entry(
        withTool('Tool decision', row),
        row.decision === undefined || !source ? row.decision : `${row.decision} (${source})`,
      );
    }
    if (entries.length)
      occurrences.push({
        // Claude Code logs a tool's input when it finishes; order it by the call's start.
        time:
          at(row, 'event.timestamp', 'time_unix_nano', 'p_timestamp') -
          (event === 'tool_result' ? Number(row.duration_ms) || 0 : 0),
        sequence: Number(row['event.sequence'] ?? Number.POSITIVE_INFINITY),
        target,
        entries,
      });
  }
  if (harness === 'claude-code')
    for (const run of runs)
      for (const span of run.spans)
        for (const row of span.rows)
          if (row.event_name === CLAUDE_TOOL_OUTPUT)
            occurrences.push({
              time: at(row, 'event_time_unix_nano', 'p_timestamp'),
              sequence: Number.POSITIVE_INFINITY,
              target: span,
              entries: entry(withTool('Tool output', span.row), row.event_output),
            });
  occurrences.sort((a, b) => a.time - b.time || a.sequence - b.sequence);
  const seen = new Set<string>();
  for (const { target, entries } of occurrences) {
    if (!target) continue;
    for (const item of entries) {
      // Flattened span rows repeat events; keep each recorded value once per span.
      const key = JSON.stringify([target.id, item.label, item.value]);
      if (seen.has(key)) continue;
      seen.add(key);
      target.conversation.push(item);
    }
  }
  return runs;
}
