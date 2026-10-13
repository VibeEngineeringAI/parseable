import type { LogRecord } from './types';
import { parseEventTimestamp } from '../components/explorer/timestamp';

export type AgentRunStatus = 'success' | 'failed' | 'incomplete';
export type AgentConversationEntry = { label: string; value: unknown };
export type AgentSpan = {
  id: string;
  spanId?: string;
  parentSpanId?: string;
  name: string;
  kind: 'agent' | 'model' | 'tool' | 'span';
  status: AgentRunStatus;
  startTime?: string;
  durationMs?: number;
  model?: string;
  toolName?: string;
  inputTokens?: number;
  outputTokens?: number;
  errors: string[];
  conversation: AgentConversationEntry[];
  row: LogRecord;
  rows: LogRecord[];
  children: AgentSpan[];
};
export type AgentRun = {
  id: string;
  traceId?: string;
  name: string;
  status: AgentRunStatus;
  startTime?: string;
  durationMs?: number;
  models: string[];
  inputTokens?: number;
  outputTokens?: number;
  spans: AgentSpan[];
  roots: AgentSpan[];
  warnings: string[];
};

function text(row: LogRecord, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
}
function identity(row: LogRecord, ...keys: string[]) {
  const value = text(row, ...keys);
  return value && !/^0+$/.test(value) ? value : undefined;
}
function number(value: unknown): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return;
  if (typeof value === 'string' && !value.trim()) return;
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 ? result : undefined;
}
function tokens(row: LogRecord, ...keys: string[]) {
  const suffixes = [
    '',
    '_utf8',
    '_int8',
    '_int16',
    '_int32',
    '_int64',
    '_uint8',
    '_uint16',
    '_uint32',
    '_uint64',
    '_float16',
    '_float32',
    '_float64',
  ];
  for (const key of keys.flatMap((field) => suffixes.map((suffix) => field + suffix))) {
    const value = number(row[key]);
    if (value !== undefined && Number.isSafeInteger(value)) return value;
  }
}
function timestamp(row: LogRecord, field: string): number | undefined {
  const raw = row[field];
  const rawEpoch = row[`${field}_epoch`];
  // OTLP uses zero for an absent timestamp, even if timestamp text was emitted.
  if (rawEpoch !== undefined && (number(rawEpoch) === undefined || Number(rawEpoch) <= 0)) return;
  // The backend's *_unix_nano fields are timestamp strings; *_epoch are nanoseconds.
  if (typeof raw === 'string' && !/^\d+(\.\d+)?$/.test(raw)) {
    const parsed = parseEventTimestamp(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  const epoch = number(rawEpoch ?? raw);
  if (epoch !== undefined && epoch > 0) return epoch / 1e6;
}
/** A span's start and end in epoch milliseconds, and its duration. */
export function spanTiming(row: LogRecord, timeColumn = 'p_timestamp') {
  const start = timestamp(row, 'span_start_time_unix_nano');
  const end = timestamp(row, 'span_end_time_unix_nano');
  const hasEnd =
    row.span_end_time_unix_nano !== undefined || row.span_end_time_unix_nano_epoch !== undefined;
  const duration = number(row.span_duration_ns);
  const durationMs = hasEnd
    ? start !== undefined && end !== undefined && end >= start
      ? duration === undefined
        ? end - start
        : duration / 1e6
      : undefined
    : duration === undefined
      ? undefined
      : duration / 1e6;
  const recordedAt = parseEventTimestamp(row[timeColumn]);
  return {
    start,
    end,
    durationMs,
    startTime: Number.isFinite(start ?? recordedAt)
      ? new Date(start ?? recordedAt).toISOString()
      : undefined,
  };
}
function spanErrors(rows: LogRecord[]) {
  const errors = rows
    .flatMap((row) => [
      text(row, 'error.message', 'exception.message', 'event_exception.message'),
      text(row, 'error.type', 'exception.type', 'event_exception.type'),
      text(row, 'exception.stacktrace', 'event_exception.stacktrace'),
      ['2', 'ERROR', 'STATUS_CODE_ERROR'].includes(
        String(row.span_status_code ?? row.span_status_description).toUpperCase(),
      )
        ? text(row, 'span_status_message')
        : undefined,
      row.event_name === 'exception'
        ? (text(row, 'event_exception.message') ?? 'Exception event captured')
        : undefined,
    ])
    .filter((error): error is string => !!error);
  return [...new Set(errors)];
}
function status(
  rows: LogRecord[],
  durationMs: number | undefined,
  errors: string[],
  ended: boolean,
): AgentRunStatus {
  const codes = rows.map((row) =>
    String(row.span_status_code ?? row.span_status_description ?? '').toUpperCase(),
  );
  if (codes.some((code) => ['2', 'ERROR', 'STATUS_CODE_ERROR'].includes(code))) return 'failed';
  if (
    durationMs !== undefined &&
    codes.some((code) => ['1', 'OK', 'STATUS_CODE_OK'].includes(code))
  )
    return 'success';
  if (errors.length) return 'failed';
  if (
    ended &&
    durationMs !== undefined &&
    codes.some((code) => ['0', 'UNSET', 'STATUS_CODE_UNSET'].includes(code))
  )
    return 'success';
  return 'incomplete';
}
// Prefer the available epoch resolution: backend timestamp text can be reduced
// to milliseconds. Numeric epochs may already have been rounded by Float64.
function eventTimestamp(row: LogRecord): bigint | undefined {
  const field = 'event_time_unix_nano';
  const recordedEpoch = row[`${field}_epoch`];
  if (recordedEpoch !== undefined) {
    if (typeof recordedEpoch === 'string' && /^\d+$/.test(recordedEpoch.trim())) {
      const epoch = BigInt(recordedEpoch.trim());
      return epoch > 0n ? epoch : undefined;
    }
    if (typeof recordedEpoch === 'number' && Number.isInteger(recordedEpoch) && recordedEpoch > 0)
      return BigInt(recordedEpoch);
    // An explicit zero or invalid epoch means the event time is absent.
    return;
  }
  const millis = timestamp(row, field);
  if (millis === undefined) return;
  const raw = row[field];
  if (typeof raw === 'string' && !/^\d+(\.\d+)?$/.test(raw)) {
    const parsed = parseEventTimestamp(raw);
    if (Number.isFinite(parsed)) {
      const fraction = raw.trim().match(/\.(\d+)(?:Z|[+-]\d{2}:?\d{2})?$/i)?.[1] ?? '';
      return BigInt(Math.trunc(parsed)) * 1_000_000n + BigInt(fraction.slice(3, 9).padEnd(6, '0'));
    }
  }
  const epoch = row[`${field}_epoch`] ?? raw;
  if (typeof epoch === 'string' && /^\d+$/.test(epoch.trim())) return BigInt(epoch.trim());
  if (typeof epoch === 'number' && Number.isInteger(epoch)) return BigInt(epoch);
}

function capturedConversation(rows: LogRecord[]) {
  const entries: AgentConversationEntry[] = [];
  const seen = new Set<string>();
  // Unknown event times retain their original slots; only timestamped rows move.
  const timed = rows
    .map((row) => ({ row, time: eventTimestamp(row) }))
    .filter((entry): entry is { row: LogRecord; time: bigint } => entry.time !== undefined)
    .sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  let nextTimed = 0;
  const ordered = rows.map((row) =>
    eventTimestamp(row) === undefined ? row : timed[nextTimed++].row,
  );
  for (const row of ordered) {
    for (const [key, value] of Object.entries(row)) {
      const plain = key.replace(/^event_/, '');
      // Schema conflicts route values to backend datatype siblings. Match their
      // semantic field while keeping the recorded key in labels and signatures.
      const semantic = plain.replace(
        /_(null|bool|u?int(8|16|32|64)|float(16|32|64)|utf8|binary|date|timestamp_(s|ms|us|ns)|time|list|struct|map|unknown)$/,
        '',
      );
      const messageEvent =
        typeof row.event_name === 'string' &&
        /^gen_ai\.(user|assistant|system|tool)\.message$/.test(row.event_name) &&
        /^(content|body|message|role|tool_calls)([._]|$)/.test(semantic) &&
        key.startsWith('event_');
      if (
        !messageEvent &&
        !/^(gen_ai\.(input\.messages|output\.messages|prompt|completion|system_instructions|tool\.(call\.(arguments|result)|parameters|result))|llm\.(input_messages|output_messages)|input\.value|output\.value)(\.|$)/.test(
          semantic,
        )
      )
        continue;
      if (value === undefined || value === null || value === '') continue;
      const signature = JSON.stringify(
        key.startsWith('event_')
          ? [
              key,
              row.event_name,
              eventTimestamp(row)?.toString() ?? [
                row.event_time_unix_nano,
                row.event_time_unix_nano_epoch,
              ],
              value,
            ]
          : [key, value],
      );
      if (seen.has(signature)) continue;
      seen.add(signature);
      entries.push({
        label:
          row.event_name && key.startsWith('event_')
            ? `${String(row.event_name)} · ${plain}`
            : plain,
        value,
      });
    }
  }
  return entries;
}

/** Group the selected, bounded telemetry sample. Absence never becomes a zero or a success. */
export function buildAgentRuns(
  rows: LogRecord[],
  timeColumn = 'p_timestamp',
  options: { limitReached?: boolean; bounds?: { startTime: string; endTime: string } } = {},
): AgentRun[] {
  const groups = new Map<string, { traceId?: string; rows: { row: LogRecord; index: number }[] }>();
  rows.forEach((row, index) => {
    const traceId = identity(row, 'span_trace_id', 'trace_id');
    const runId = identity(row, 'gen_ai.agent.run.id', 'gen_ai.run.id');
    const spanId = identity(row, 'span_span_id', 'span_id');
    const id = traceId
      ? `trace:${traceId}`
      : runId
        ? `run:${runId}`
        : spanId
          ? `span:${spanId}`
          : `record:${index}`;
    const group = groups.get(id) ?? { traceId, rows: [] };
    group.rows.push({ row, index });
    groups.set(id, group);
  });
  return [...groups]
    .map(([id, group]): AgentRun => {
      const warnings = new Set<string>();
      const spanRows = new Map<string, LogRecord[]>();
      for (const { row, index } of group.rows) {
        const spanId = identity(row, 'span_span_id', 'span_id');
        const key = spanId ?? `record:${index}`;
        spanRows.set(key, [...(spanRows.get(key) ?? []), row]);
        if (!spanId)
          warnings.add('Some records have no span ID and cannot be safely deduplicated.');
      }
      const spans: AgentSpan[] = [...spanRows].map(([key, records]) => {
        const metadata = [
          'span_parent_span_id',
          'span_start_time_unix_nano',
          'span_end_time_unix_nano',
          'span_duration_ns',
          'gen_ai.usage.input_tokens',
          'gen_ai.usage.output_tokens',
        ];
        if (
          metadata.some(
            (field) =>
              new Set(
                records
                  .map((entry) => entry[field])
                  .filter((value) => value !== null && value !== undefined),
              ).size > 1,
          )
        )
          warnings.add(
            'Conflicting records share a span ID; displayed telemetry may be incomplete.',
          );
        const ordered = [...records].sort(
          (a, b) =>
            (parseEventTimestamp(a[timeColumn]) || 0) - (parseEventTimestamp(b[timeColumn]) || 0),
        );
        const row = Object.assign(
          {},
          ...ordered.map((entry) =>
            Object.fromEntries(
              Object.entries(entry).filter(([, value]) => value !== null && value !== undefined),
            ),
          ),
        ) as LogRecord;
        const { startTime, durationMs } = spanTiming(row, timeColumn);
        const errors = spanErrors(records);
        const operation = text(row, 'gen_ai.operation.name');
        const model = text(row, 'gen_ai.response.model', 'gen_ai.request.model', 'llm.model_name');
        const toolName = text(row, 'gen_ai.tool.name');
        const kind =
          operation === 'invoke_agent' || operation === 'create_agent'
            ? 'agent'
            : toolName || operation === 'execute_tool'
              ? 'tool'
              : model ||
                  ['chat', 'text_completion', 'generate_content', 'embeddings'].includes(
                    operation ?? '',
                  )
                ? 'model'
                : text(row, 'gen_ai.agent.name')
                  ? 'agent'
                  : 'span';
        return {
          id: `${id}/${key}`,
          spanId: identity(row, 'span_span_id', 'span_id'),
          parentSpanId: identity(row, 'span_parent_span_id', 'parent_span_id'),
          name:
            text(
              row,
              'span_name',
              'gen_ai.agent.name',
              'gen_ai.tool.name',
              'gen_ai.operation.name',
            ) ?? 'Unnamed span',
          kind,
          status: status(
            records,
            durationMs,
            errors,
            spanTiming(row, timeColumn).end !== undefined,
          ),
          startTime,
          durationMs,
          model,
          toolName,
          inputTokens: tokens(
            row,
            'gen_ai.usage.input_tokens',
            'gen_ai.usage.prompt_tokens',
            'llm.token_count.prompt',
          ),
          outputTokens: tokens(
            row,
            'gen_ai.usage.output_tokens',
            'gen_ai.usage.completion_tokens',
            'llm.token_count.completion',
          ),
          errors,
          conversation: capturedConversation(records),
          row,
          rows: records,
          children: [],
        };
      });
      const byId = new Map(spans.filter((span) => span.spanId).map((span) => [span.spanId!, span]));
      const parents = new Map<AgentSpan, AgentSpan>();
      for (const span of spans) {
        if (!span.parentSpanId) continue;
        const parent = byId.get(span.parentSpanId);
        if (!parent) {
          warnings.add('A parent span is outside the captured sample or missing.');
          continue;
        }
        const seen = new Set<AgentSpan>([span]);
        let ancestor: AgentSpan | undefined = parent;
        while (ancestor && !seen.has(ancestor)) {
          seen.add(ancestor);
          ancestor = parents.get(ancestor);
        }
        if (ancestor) {
          warnings.add('A cycle in span parent IDs was removed from the tree.');
          continue;
        }
        parents.set(span, parent);
        parent.children.push(span);
      }
      const roots = spans.filter((span) => !parents.has(span));
      const ordering = (a: AgentSpan, b: AgentSpan) =>
        (Date.parse(a.startTime ?? '') || 0) - (Date.parse(b.startTime ?? '') || 0) ||
        a.id.localeCompare(b.id);
      roots.sort(ordering);
      spans.forEach((span) => span.children.sort(ordering));
      if (!group.traceId)
        warnings.add('Trace ID is missing; grouping is limited to available run or span IDs.');
      if (options.limitReached)
        warnings.add('The telemetry record limit was reached; runs may be incomplete.');
      if (spans.some((span) => span.status === 'incomplete'))
        warnings.add('Some spans lack completion or status telemetry.');
      const tokenTotal = (field: 'inputTokens' | 'outputTokens') => {
        const reported = spans.filter((span) => span[field] !== undefined);
        const modelCalls = reported.filter((span) => span.kind === 'model');
        const ancestorCache = new Map<AgentSpan, Set<AgentSpan>>();
        const rootCache = new Map<AgentSpan, AgentSpan>();
        const ancestors = (span: AgentSpan) => {
          const cached = ancestorCache.get(span);
          if (cached) return cached;
          const result = new Set<AgentSpan>();
          let root = span;
          let parent = parents.get(span);
          while (parent) {
            result.add(parent);
            root = parent;
            parent = parents.get(parent);
          }
          ancestorCache.set(span, result);
          rootCache.set(span, root);
          return result;
        };
        const root = (span: AgentSpan) => {
          ancestors(span);
          return rootCache.get(span)!;
        };
        // Prefer model calls over their rollups. Include other reported branches
        // only when the captured tree proves they are independent of every call.
        // Disconnected rollups could repeat usage from an orphaned model call.
        const candidates = modelCalls.length
          ? reported.filter((span) => {
              if (span.kind === 'model') return true;
              if (modelCalls.some((call) => ancestors(call).has(span) || ancestors(span).has(call)))
                return false;
              if (
                !warnings.has('A cycle in span parent IDs was removed from the tree.') &&
                modelCalls.every((call) => root(call) === root(span))
              )
                return true;
              warnings.add(
                'Token usage is partial because disconnected rollups may overlap model calls.',
              );
              return false;
            })
          : reported;
        const candidateSet = new Set(candidates);
        // Parent usage commonly repeats the child model-call rollup. Count only the deepest reported usage on each branch.
        const hasDescendantUsage = (span: AgentSpan): boolean =>
          span.children.some((child) => candidateSet.has(child) || hasDescendantUsage(child));
        const contributors = candidates.filter((span) => !hasDescendantUsage(span));
        if (spans.some((span) => span.kind === 'model' && span[field] === undefined))
          warnings.add('Token usage is partial because some model calls do not report usage.');
        if (!contributors.length) return undefined;
        const total = contributors.reduce((sum, span) => sum + span[field]!, 0);
        if (!Number.isSafeInteger(total)) {
          warnings.add(
            'Token usage exceeds the safe numeric range and cannot be totaled reliably.',
          );
          return undefined;
        }
        return total;
      };
      const inputTokens = tokenTotal('inputTokens');
      const outputTokens = tokenTotal('outputTokens');
      const starts = spans
        .map((span) => spanTiming(span.row, timeColumn).start)
        .filter((value): value is number => value !== undefined);
      const ends = spans
        .map((span) => {
          const t = spanTiming(span.row, timeColumn);
          return t.start !== undefined && t.end !== undefined && t.durationMs !== undefined
            ? t.start + t.durationMs
            : undefined;
        })
        .filter((value): value is number => value !== undefined);
      const durationMs =
        starts.length === spans.length && ends.length === spans.length
          ? Math.max(...ends) - Math.min(...starts)
          : spans.length === 1
            ? spans[0].durationMs
            : undefined;
      if (durationMs === undefined)
        warnings.add('Run duration is unavailable because span timing is incomplete.');
      const selectedStart = options.bounds ? parseEventTimestamp(options.bounds.startTime) : NaN;
      const clipped =
        Number.isFinite(selectedStart) && starts.some((start) => start < selectedStart);
      if (clipped)
        warnings.add(
          'This run started before the selected ingestion-time range; earlier telemetry may be missing.',
        );
      const depth = (span: AgentSpan) => {
        let result = 0;
        let parent = parents.get(span);
        while (parent) {
          result++;
          parent = parents.get(parent);
        }
        return result;
      };
      const agents = spans
        .filter((span) => span.kind === 'agent')
        .sort((a, b) => depth(a) - depth(b) || ordering(a, b));
      const namedAgent = agents.find((span) => text(span.row, 'gen_ai.agent.name'));
      const topAgents = agents.filter((span) => {
        let parent = parents.get(span);
        while (parent) {
          if (parent.kind === 'agent') return false;
          parent = parents.get(parent);
        }
        return true;
      });
      const authoritative = topAgents.length === 1 ? topAgents[0] : undefined;
      const explicitlyOk =
        authoritative &&
        ['1', 'OK', 'STATUS_CODE_OK'].includes(
          String(
            authoritative.row.span_status_code ?? authoritative.row.span_status_description,
          ).toUpperCase(),
        );
      const isAgentDescendant = (span: AgentSpan) => {
        if (!authoritative) return false;
        let parent = parents.get(span);
        while (parent) {
          if (parent === authoritative) return true;
          parent = parents.get(parent);
        }
        return false;
      };
      const descendantSpans = spans.filter(isAgentDescendant);
      const outsideSpans = spans.filter(
        (span) => span !== authoritative && !isAgentDescendant(span),
      );
      const hasErrors = (span: AgentSpan) => span.status === 'failed' || span.errors.length > 0;
      if (descendantSpans.some(hasErrors))
        warnings.add(
          'Child spans reported errors; captured errors remain available in run details.',
        );
      if (outsideSpans.some(hasErrors))
        warnings.add(
          authoritative
            ? 'Spans outside the agent subtree reported errors; captured errors remain available in run details.'
            : 'Spans reported errors; captured errors remain available in run details.',
        );
      if (authoritative?.errors.length && authoritative.status === 'success')
        warnings.add('The completed agent span contains captured error events.');
      let runStatus: AgentRunStatus =
        // A completed agent only certifies recovery inside its own subtree.
        // The run groups the entire trace, so errors in ancestors or separate
        // roots still fail the run.
        outsideSpans.some((span) => span.status === 'failed') || authoritative?.status === 'failed'
          ? 'failed'
          : authoritative?.status === 'incomplete'
            ? 'incomplete'
            : explicitlyOk && authoritative?.status === 'success'
              ? outsideSpans.some((span) => span.status === 'incomplete')
                ? 'incomplete'
                : 'success'
              : spans.some((span) => span.status === 'failed')
                ? 'failed'
                : spans.some((span) => span.status !== 'success')
                  ? 'incomplete'
                  : 'success';
      const incompleteSample =
        options.limitReached ||
        !group.traceId ||
        clipped ||
        warnings.has('A parent span is outside the captured sample or missing.') ||
        warnings.has('A cycle in span parent IDs was removed from the tree.') ||
        warnings.has(
          'Conflicting records share a span ID; displayed telemetry may be incomplete.',
        ) ||
        spans.some((span) => !span.spanId);
      if (runStatus === 'success' && incompleteSample) runStatus = 'incomplete';
      return {
        id,
        traceId: group.traceId,
        name: namedAgent
          ? text(namedAgent.row, 'gen_ai.agent.name')!
          : (roots[0]?.name ?? 'Unnamed run'),
        status: runStatus,
        startTime: starts.length
          ? new Date(Math.min(...starts)).toISOString()
          : roots[0]?.startTime,
        durationMs,
        models: [
          ...new Set(spans.map((span) => span.model).filter((model): model is string => !!model)),
        ],
        inputTokens,
        outputTokens,
        spans,
        roots,
        warnings: [...warnings],
      };
    })
    .sort(
      (a, b) =>
        (Date.parse(b.startTime ?? '') || 0) - (Date.parse(a.startTime ?? '') || 0) ||
        a.id.localeCompare(b.id),
    );
}
