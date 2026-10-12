import { parseEventTimestamp } from '../components/explorer/timestamp';
import { buildApmQuery, apmBucketInterval, EMPTY_APM_STATS, type ApmQueryOptions } from './apm';
import type { LogRecord, QueryRequest } from './types';

/** Derive APM from the shared trace fixtures. Called only by the demo client's
 * query dispatcher. Returns undefined for another query family. */
export function handleApmDemoQuery(
  request: QueryRequest,
  rows: LogRecord[],
): LogRecord[] | undefined {
  const match = /^\/\* parseable-apm:([^\n]+) \*\//.exec(request.sql);
  if (!match) return undefined;
  const options = JSON.parse(decodeURIComponent(match[1])) as ApmQueryOptions;
  const expected = buildApmQuery(options);
  if (
    expected.sql !== request.sql ||
    expected.startTime !== request.startTime ||
    expected.endTime !== request.endTime
  )
    throw new Error('Unsupported demo APM query');
  const start = Date.parse(options.startTime),
    end = Date.parse(options.endTime);
  const unique = new Map<
    string,
    {
      service: string;
      trace: string;
      span: string;
      parent: string;
      operation: string | null;
      startedAt: string;
      time: number;
      ingested: number;
      duration: number | null;
      error: number;
    }
  >();
  for (const row of rows) {
    const service = row['service.name'],
      trace = row.span_trace_id,
      span = row.span_span_id;
    const time = parseEventTimestamp(row.span_start_time_unix_nano);
    const ingested = parseEventTimestamp(row[options.schema?.timeColumn || 'p_timestamp']);
    if (
      typeof service !== 'string' ||
      !service ||
      typeof trace !== 'string' ||
      !trace ||
      typeof span !== 'string' ||
      !span ||
      ingested < start ||
      ingested >= end ||
      !Number.isFinite(ingested)
    )
      continue;
    const duration = row.span_duration_ns == null ? NaN : Number(row.span_duration_ns) / 1e6;
    const item = {
      service,
      trace,
      span,
      parent: options.schema?.parent === false ? '' : String(row.span_parent_span_id ?? ''),
      operation: row.span_name == null ? null : String(row.span_name),
      startedAt: String(row.span_start_time_unix_nano),
      time,
      ingested,
      duration: Number.isFinite(duration) && duration >= 0 ? duration : null,
      error: options.schema?.status === false ? 0 : Number(row.span_status_code) === 2 ? 1 : 0,
    };
    const key = JSON.stringify([service, trace, span]);
    const previous = unique.get(key);
    if (previous) {
      // Match MAX reductions in SQL even if duplicated span metadata conflicts.
      previous.ingested = Math.min(previous.ingested, item.ingested);
      previous.error = Math.max(previous.error, item.error);
      previous.duration =
        previous.duration == null
          ? item.duration
          : item.duration == null
            ? previous.duration
            : Math.max(previous.duration, item.duration);
      previous.parent = previous.parent > item.parent ? previous.parent : item.parent;
      previous.operation =
        previous.operation == null
          ? item.operation
          : item.operation == null || previous.operation > item.operation
            ? previous.operation
            : item.operation;
      if (
        Number.isFinite(item.time) &&
        (!Number.isFinite(previous.time) || item.time > previous.time)
      ) {
        previous.time = item.time;
        previous.startedAt = item.startedAt;
      }
    } else unique.set(key, item);
  }
  type Span = typeof unique extends Map<string, infer V> ? V : never;
  const all = [...unique.values()];
  const spans =
    options.service && options.kind !== 'topology'
      ? all.filter((span) => span.service === options.service)
      : all;
  const stats = (items: Span[]): LogRecord => {
    if (!items.length) return { ...EMPTY_APM_STATS };
    const durations = items
      .map((item) => item.duration)
      .filter((v): v is number => v != null)
      .sort((a, b) => a - b);
    const percentile = (p: number) => {
      if (!durations.length) return null;
      const position = (durations.length - 1) * p,
        lower = Math.floor(position),
        fraction = position - lower;
      return durations[lower] + (durations[Math.ceil(position)] - durations[lower]) * fraction;
    };
    const errors = items.reduce((sum, item) => sum + item.error, 0);
    return {
      spanCount: items.length,
      traceCount: new Set(items.map((item) => item.trace)).size,
      errorCount: errors,
      errorRate: (100 * errors) / items.length,
      avgMs: durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null,
      p50Ms: percentile(0.5),
      p95Ms: percentile(0.95),
      p99Ms: percentile(0.99),
      maxMs: durations.at(-1) ?? null,
    };
  };
  const group = (key: (item: Span) => string) => {
    const result = new Map<string, Span[]>();
    for (const span of spans) {
      const value = key(span);
      result.set(value, [...(result.get(value) ?? []), span]);
    }
    return [...result].map(([value, items]) => ({ value, ...stats(items) }));
  };
  const limit = options.limit! + 1;
  const ranked = (items: LogRecord[], key: string) =>
    items
      .sort(
        (a, b) =>
          Number(b.spanCount) - Number(a.spanCount) || String(a[key]).localeCompare(String(b[key])),
      )
      .slice(0, limit);
  switch (options.kind) {
    case 'summary':
      return [stats(spans)];
    case 'inventory':
      return ranked(
        group((item) => item.service).map(({ value, ...row }) => ({
          service: value,
          ...row,
        })),
        'service',
      );
    case 'operations':
      return ranked(
        group((item) => item.operation ?? '(unnamed)').map(({ value, ...row }) => ({
          operation: value,
          ...row,
        })),
        'operation',
      );
    case 'series': {
      const interval = apmBucketInterval(options);
      return group((item) =>
        new Date(start + Math.floor((item.ingested - start) / interval) * interval).toISOString(),
      )
        .map(({ value, ...row }) => ({ bucket: value, ...row }))
        .sort((a, b) => a.bucket.localeCompare(b.bucket));
    }
    case 'spans':
      return spans
        .filter((item) => Number.isFinite(item.time))
        .sort(
          (a, b) =>
            b.error - a.error ||
            (b.duration ?? -1) - (a.duration ?? -1) ||
            a.trace.localeCompare(b.trace) ||
            a.span.localeCompare(b.span),
        )
        .slice(0, limit)
        .map((item) => ({
          traceId: item.trace,
          spanId: item.span,
          operation: item.operation ?? '(unnamed)',
          startedAt: item.startedAt,
          durationMs: item.duration,
          error: item.error,
        }));
    case 'topology': {
      const parents = new Map<string, Span[]>();
      for (const span of all) {
        const key = JSON.stringify([span.trace, span.span]);
        parents.set(key, [...(parents.get(key) ?? []), span]);
      }
      const edges = new Map<string, { source: string; target: string; items: Span[] }>();
      for (const child of all) {
        const candidates = parents.get(JSON.stringify([child.trace, child.parent]));
        if (candidates?.length !== 1 || candidates[0].service === child.service) continue;
        const source = candidates[0].service,
          target = child.service,
          key = JSON.stringify([source, target]);
        const edge = edges.get(key) ?? { source, target, items: [] };
        edge.items.push(child);
        edges.set(key, edge);
      }
      return [...edges.values()]
        .filter(
          (edge) =>
            !options.service || edge.source === options.service || edge.target === options.service,
        )
        .map(({ source, target, items }) => {
          const { spanCount, errorCount, avgMs } = stats(items);
          return { source, target, spanCount, errorCount, avgMs };
        })
        .sort(
          (a, b) =>
            Number(b.spanCount) - Number(a.spanCount) ||
            a.source.localeCompare(b.source) ||
            a.target.localeCompare(b.target),
        )
        .slice(0, limit);
    }
  }
}
