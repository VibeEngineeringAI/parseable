import { spanTiming } from './agentRuns';
import { quoteIdentifier, quoteLiteral } from './query';
import type { LogRecord } from './types';

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

// Coding-agent CLIs export OTLP with their own attribute names. A harness profile
// recognizes that telemetry and adds the GenAI span fields the Agents view reads.
// Recorded values are never replaced, and absent values stay absent.
export type AgentHarness = 'codex' | 'claude-code';

type HarnessProfile = {
  label: string;
  // Any of these fields identifies the harness in a dataset schema.
  signature: string[];
  // The span that represents one agent run (a user turn).
  runSpan: string;
};

export const AGENT_HARNESSES: Record<AgentHarness, HarnessProfile> = {
  codex: {
    label: 'Codex',
    signature: ['codex.turn.token_usage.input_tokens', 'codex.turn.phase'],
    runSpan: 'session_task.turn',
  },
  'claude-code': {
    label: 'Claude Code',
    signature: ['interaction.sequence', 'llm_request.context'],
    runSpan: 'claude_code.interaction',
  },
};

// Codex traces a turn with hundreds of internal spans. Only these, plus spans
// carrying a tool name, describe the run; the others would exhaust the record limit.
const CODEX_MODEL_CALL = 'try_run_sampling_request';
const CODEX_STREAM = 'receiving_stream';
const CODEX_RESPONSE = 'handle_responses';
const CODEX_SPANS = [AGENT_HARNESSES.codex.runSpan, CODEX_MODEL_CALL, CODEX_STREAM];

/** The harnesses whose telemetry a dataset holds; one dataset may hold several. */
export function detectAgentHarnesses(fields: string[]): AgentHarness[] {
  if (!fields.includes('span_name')) return [];
  return (Object.keys(AGENT_HARNESSES) as AgentHarness[]).filter((harness) =>
    AGENT_HARNESSES[harness].signature.some((field) => fields.includes(field)),
  );
}

/** SQL selecting the spans that start a run of this harness. */
export function harnessRunPredicate(harness: AgentHarness) {
  return `${quoteIdentifier('span_name')} = ${quoteLiteral(AGENT_HARNESSES[harness].runSpan)}`;
}

/**
 * SQL keeping the run-relevant spans of a harness; other services' rows, and spans
 * already carrying GenAI fields, are untouched.
 */
export function harnessRowPredicate(harness: AgentHarness, fields: string[]) {
  if (harness !== 'codex' || !fields.includes('service.name')) return;
  const name = `COALESCE(${quoteIdentifier('span_name')}, '')`;
  const kept = [`${name} IN (${CODEX_SPANS.map(quoteLiteral).join(', ')})`];
  if (fields.includes('gen_ai.usage.input_tokens'))
    kept.push(
      `(${name} = ${quoteLiteral(CODEX_RESPONSE)} AND ${quoteIdentifier('gen_ai.usage.input_tokens')} IS NOT NULL)`,
    );
  for (const field of ['tool_name', ...AGENT_FIELDS])
    if (fields.includes(field)) kept.push(`${quoteIdentifier(field)} IS NOT NULL`);
  return `NOT (COALESCE(${quoteIdentifier('service.name')}, '') LIKE 'codex%' AND NOT (${kept.join(' OR ')}))`;
}

const recorded = new WeakMap<LogRecord, { row: LogRecord; harness?: AgentHarness }>();
const mapped = new WeakSet<LogRecord>();

/** The fields a record was stored with, before any harness mapping. */
export function recordedFields(row: LogRecord): LogRecord {
  return recorded.get(row)?.row ?? row;
}
/** The harness whose native names were mapped onto this record, if any. */
export function mappedHarness(row: LogRecord): AgentHarness | undefined {
  return mapped.has(row) ? recorded.get(row)?.harness : undefined;
}
/** Note that a field was derived for, or the parent rewritten on, a copied record. */
function markMapped(row: LogRecord) {
  if (recorded.has(row)) mapped.add(row);
}

function present(value: unknown) {
  return value !== undefined && value !== null && value !== '';
}
function assign(row: LogRecord, field: string, value: unknown) {
  if (!present(value) || present(row[field])) return;
  row[field] = value;
  markMapped(row);
}
function count(value: unknown) {
  if (!present(value)) return;
  const result = Number(value);
  return Number.isSafeInteger(result) && result >= 0 ? result : undefined;
}
function id(row: LogRecord, field: string) {
  const value = row[field];
  return typeof value === 'string' && value.trim() && !/^0+$/.test(value.trim())
    ? value.trim()
    : undefined;
}
const traceOf = (row: LogRecord) => id(row, 'span_trace_id') ?? id(row, 'trace_id');
const spanOf = (row: LogRecord) => id(row, 'span_span_id') ?? id(row, 'span_id');
const parentOf = (row: LogRecord) => id(row, 'span_parent_span_id') ?? id(row, 'parent_span_id');
// Rewrite whichever parent fields the record has, since readers fall back between them.
function setParent(row: LogRecord, value: string) {
  const fields = ['span_parent_span_id', 'parent_span_id'].filter((field) => field in row);
  for (const field of fields.length ? fields : ['span_parent_span_id']) row[field] = value;
  markMapped(row);
}

function mapClaudeCode(row: LogRecord) {
  switch (row.span_name) {
    case AGENT_HARNESSES['claude-code'].runSpan:
      assign(row, 'gen_ai.agent.name', AGENT_HARNESSES['claude-code'].label);
      assign(row, 'gen_ai.operation.name', 'invoke_agent');
      break;
    case 'claude_code.llm_request': {
      assign(row, 'gen_ai.operation.name', 'chat');
      assign(row, 'gen_ai.request.model', row.model);
      // Anthropic reports cache reads and writes separately from input_tokens, which
      // must be reported. An absent cache count is zero; a malformed one leaves input unknown.
      const input = ['input_tokens', 'cache_read_tokens', 'cache_creation_tokens'].map(
        (field, index) => (index && !present(row[field]) ? 0 : count(row[field])),
      );
      if (input.every((value): value is number => value !== undefined))
        assign(
          row,
          'gen_ai.usage.input_tokens',
          input.reduce((a, b) => a + b),
        );
      assign(row, 'gen_ai.usage.output_tokens', count(row.output_tokens));
      break;
    }
    case 'claude_code.tool':
      assign(row, 'gen_ai.operation.name', 'execute_tool');
      assign(row, 'gen_ai.tool.name', row.tool_name);
      assign(row, 'gen_ai.tool.call.id', row.tool_use_id);
      break;
  }
}

// Rows of other services are kept as they are, but remain visible as parents.
function mapCodex(rows: LogRecord[], isCodex: (row: LogRecord) => boolean) {
  const spans = new Map<string, LogRecord[]>();
  for (const row of rows) {
    const trace = traceOf(row);
    const span = spanOf(row);
    if (trace && span)
      spans.set(`${trace}/${span}`, [...(spans.get(`${trace}/${span}`) ?? []), row]);
  }
  const parent = (row: LogRecord) => {
    const trace = traceOf(row);
    const span = parentOf(row);
    return trace && span ? spans.get(`${trace}/${span}`) : undefined;
  };
  // Stream and response spans only connect a model call to its usage, unless they
  // already describe something themselves.
  const plumbing = (row: LogRecord) =>
    isCodex(row) &&
    (row.span_name === CODEX_STREAM || row.span_name === CODEX_RESPONSE) &&
    !AGENT_FIELDS.some((field) => present(row[field]));
  // Usage is reported on the response handler two levels below its model call.
  for (const row of rows) {
    if (row.span_name !== CODEX_RESPONSE || !plumbing(row)) continue;
    const stream = parent(row)?.find((entry) => entry.span_name === CODEX_STREAM);
    const call = stream && parent(stream);
    if (call?.[0]?.span_name !== CODEX_MODEL_CALL) continue;
    for (const entry of call)
      for (const field of ['gen_ai.usage.input_tokens', 'gen_ai.usage.output_tokens'])
        assign(entry, field, row[field]);
  }
  const runs = new Map<string, { span: string; start: number; end: number }[]>();
  for (const row of rows) {
    const trace = traceOf(row);
    const span = spanOf(row);
    if (row.span_name !== AGENT_HARNESSES.codex.runSpan || !isCodex(row) || !trace || !span)
      continue;
    const { start, durationMs } = spanTiming(row);
    if (start === undefined || durationMs === undefined) continue;
    runs.set(trace, [...(runs.get(trace) ?? []), { span, start, end: start + durationMs }]);
  }
  const kept = rows.filter((row) => !plumbing(row));
  const keptSet = new Set(kept);
  const keptAncestor = (row: LogRecord) => {
    let ancestors = parent(row);
    // Bounded, in case recorded parents form a cycle.
    for (let hops = 0; ancestors?.length && hops < rows.length; hops++) {
      const found = ancestors.find((entry) => keptSet.has(entry));
      if (found) return found;
      ancestors = parent(ancestors[0]);
    }
  };
  for (const row of kept) {
    if (!isCodex(row)) continue;
    if (row.span_name === AGENT_HARNESSES.codex.runSpan) {
      assign(row, 'gen_ai.agent.name', AGENT_HARNESSES.codex.label);
      assign(row, 'gen_ai.operation.name', 'invoke_agent');
      assign(row, 'gen_ai.request.model', row.model);
      assign(row, 'gen_ai.usage.input_tokens', row['codex.turn.token_usage.input_tokens']);
      assign(row, 'gen_ai.usage.output_tokens', row['codex.turn.token_usage.output_tokens']);
    } else if (row.span_name === CODEX_MODEL_CALL) {
      assign(row, 'gen_ai.operation.name', 'chat');
      assign(row, 'gen_ai.request.model', row.model);
    } else if (present(row.tool_name)) {
      assign(row, 'gen_ai.operation.name', 'execute_tool');
      assign(row, 'gen_ai.tool.name', row.tool_name);
      assign(row, 'gen_ai.tool.call.id', row.call_id);
    }
    // Intermediate spans were not loaded. Attach the turn to the top of the tree
    // and its model and tool calls directly to the turn.
    const trace = traceOf(row);
    if (!trace || !parentOf(row) || parent(row)?.some((entry) => keptSet.has(entry))) continue;
    // A loaded but dropped parent leads to the nearest kept ancestor.
    const nearest = keptAncestor(row);
    if (nearest) setParent(row, spanOf(nearest)!);
    else if (row.span_name === AGENT_HARNESSES.codex.runSpan) setParent(row, '');
    else {
      // Only a call that started during exactly one loaded turn is known to belong to it;
      // the calls of an unexported (still running) turn stay detached.
      const { start } = spanTiming(row);
      if (start === undefined) continue;
      const matches = new Set(
        (runs.get(trace) ?? [])
          .filter((run) => start >= run.start && start <= run.end)
          .map((run) => run.span),
      );
      if (matches.size === 1) setParent(row, [...matches][0]);
    }
  }
  return kept;
}

/** Add GenAI fields derived from the native telemetry of the detected harnesses. */
export function mapHarnessRows(harnesses: AgentHarness[], rows: LogRecord[]) {
  if (!harnesses.length) return rows;
  const codex = harnesses.includes('codex');
  const claude = harnesses.includes('claude-code');
  // Codex mapping and filtering apply to Codex services only, as in harnessRowPredicate.
  // Without a service name, a Codex-only dataset is all Codex; a mixed one needs a
  // Codex span name or a Codex tool call (Claude Code tools carry tool_use_id instead).
  const isCodexRow = (row: LogRecord) =>
    codex &&
    (present(row['service.name'])
      ? String(row['service.name']).startsWith('codex')
      : !claude ||
        CODEX_SPANS.includes(String(row.span_name)) ||
        row.span_name === CODEX_RESPONSE ||
        (present(row.tool_name) && present(row.call_id)));
  const copies = rows.map((row) => {
    const copy = { ...row };
    const harness = isCodexRow(row) ? 'codex' : claude ? 'claude-code' : undefined;
    recorded.set(copy, { row, harness });
    return copy;
  });
  if (claude) copies.filter((row) => !isCodexRow(row)).forEach(mapClaudeCode);
  return codex ? mapCodex(copies, isCodexRow) : copies;
}
