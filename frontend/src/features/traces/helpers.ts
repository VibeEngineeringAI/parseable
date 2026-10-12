import { ApiError } from '../../lib/apiError';
import { quoteIdentifier, quoteLiteral } from '../../lib/query';
import { parseEventTimestamp } from '../../components/explorer/timestamp';
import type {
  DatasetInfo,
  ParseableClient,
  TraceDetailRecord,
  TraceDetailResponse,
} from '../../lib/types';

export const TRACE_PAGE_SIZE = 25;
export const SPAN_RECORD_LIMIT = 100;

export function normalizeTraceId(value: string): string {
  const trimmed = value.trim();
  return /^[a-f\d]{32}$/i.test(trimmed) ? trimmed.toLowerCase() : trimmed;
}

// The native API explicitly requires this source; telemetryType alone is insufficient.
export function isTraceDataset(info: DatasetInfo): boolean {
  return info.logSourceFormats.includes('otel-traces');
}

export async function discoverTraceDatasets(client: ParseableClient, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const all = await client.listDatasets(signal);
  const datasets: DatasetInfo[] = [];
  const unchecked: string[] = [];
  let next = 0;
  async function worker() {
    while (next < all.length) {
      signal?.throwIfAborted();
      const entry = all[next++];
      try {
        const info = await client.datasetInfo(entry.name, signal);
        if (isTraceDataset(info)) datasets.push(info);
      } catch (error) {
        if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
        if (!(error instanceof ApiError && (error.status === 403 || error.status === 404)))
          unchecked.push(entry.name);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, all.length) }, worker));
  signal?.throwIfAborted();
  return {
    datasets: datasets.sort((a, b) => a.name.localeCompare(b.name)),
    unchecked: unchecked.sort(),
  };
}

/** Preserve sub-millisecond precision before subtracting absolute timestamps. */
export function timestampNanoseconds(value: string): bigint | undefined {
  const match =
    /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})?$/.exec(
      value.trim(),
    );
  if (!match) return undefined;
  const seconds = Date.parse(`${match[1]}T${match[2]}${match[4] ?? 'Z'}`);
  if (!Number.isFinite(seconds)) return undefined;
  return BigInt(seconds) * 1_000_000n + BigInt((match[3] ?? '').padEnd(9, '0'));
}

export function durationMs(ns: number): number {
  return Number.isFinite(ns) && ns >= 0 ? ns / 1_000_000 : 0;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms === 0) return '0 ms';
  if (ms < 0.001) return `${Number((ms * 1_000_000).toPrecision(3))} ns`;
  if (ms < 1) return `${Number((ms * 1000).toPrecision(3))} µs`;
  if (ms < 1000) return `${Number(ms.toPrecision(3))} ms`;
  return `${Number((ms / 1000).toPrecision(3))} s`;
}

export type WaterfallRow = {
  span: TraceDetailRecord;
  depth: number;
  offsetMs: number;
  durationMs: number;
  timingAvailable: boolean;
};

export function buildWaterfall(records: TraceDetailRecord[]) {
  const unique = [...new Map(records.map((span) => [span.span_span_id, span])).values()];
  const starts = new Map(
    unique.map((span) => [span.span_span_id, timestampNanoseconds(span.span_start_time_unix_nano)]),
  );
  const timestamps = [...starts.values()].filter((value): value is bigint => value !== undefined);
  const origin = timestamps.reduce(
    (min, value) => (value < min ? value : min),
    timestamps[0] ?? 0n,
  );
  const byId = new Map(unique.map((span) => [span.span_span_id, span]));
  const children = new Map<string, TraceDetailRecord[]>();
  const roots: TraceDetailRecord[] = [];
  for (const span of unique) {
    if (!span.span_parent_span_id || !byId.has(span.span_parent_span_id)) roots.push(span);
    else {
      const siblings = children.get(span.span_parent_span_id) ?? [];
      siblings.push(span);
      children.set(span.span_parent_span_id, siblings);
    }
  }
  const compare = (a: TraceDetailRecord, b: TraceDetailRecord) => {
    const left = starts.get(a.span_span_id),
      right = starts.get(b.span_span_id);
    if (left === undefined && right !== undefined) return 1;
    if (left !== undefined && right === undefined) return -1;
    return left !== undefined && right !== undefined && left !== right
      ? left < right
        ? -1
        : 1
      : a.span_span_id.localeCompare(b.span_span_id);
  };
  roots.sort(compare);
  for (const siblings of children.values()) siblings.sort(compare);
  const rows: WaterfallRow[] = [];
  const visited = new Set<string>();
  // Iterative traversal also tolerates malformed cycles and very deep traces.
  function visit(first: TraceDetailRecord) {
    const stack = [{ span: first, depth: 0 }];
    while (stack.length) {
      const { span, depth } = stack.pop()!;
      if (visited.has(span.span_span_id)) continue;
      visited.add(span.span_span_id);
      const start = starts.get(span.span_span_id);
      rows.push({
        span,
        depth,
        offsetMs: start === undefined ? 0 : Number(start - origin) / 1_000_000,
        durationMs: durationMs(span.span_duration_ns),
        timingAvailable:
          start !== undefined &&
          Number.isFinite(span.span_duration_ns) &&
          span.span_duration_ns >= 0,
      });
      for (const child of [...(children.get(span.span_span_id) ?? [])].reverse())
        stack.push({ span: child, depth: depth + 1 });
    }
  }
  for (const root of roots) visit(root);
  for (const span of unique.sort(compare)) visit(span);
  const totalMs = rows.reduce(
    (max, row) => (row.timingAvailable ? Math.max(max, row.offsetMs + row.durationMs) : max),
    0,
  );
  return { rows, totalMs };
}

export function spanRecordQuery(
  dataset: string,
  span: TraceDetailRecord,
  detail: TraceDetailResponse,
) {
  const start = parseEventTimestamp(detail.startTime),
    end = parseEventTimestamp(detail.endTime);
  if (!Number.isFinite(start) || !Number.isFinite(end))
    throw new Error('Trace time bounds are invalid');
  return {
    sql: `SELECT * FROM ${quoteIdentifier(dataset)} WHERE "span_trace_id" = ${quoteLiteral(span.span_trace_id)} AND "span_span_id" = ${quoteLiteral(span.span_span_id)} LIMIT ${SPAN_RECORD_LIMIT}`,
    startTime: new Date(start).toISOString(),
    // Match the native detail handler's inclusion of the last span's minute.
    endTime: new Date(end + 60_000).toISOString(),
  };
}
