import { parseEventTimestamp } from '../components/explorer/timestamp';
import {
  buildErrorQuery,
  errorBucketInterval,
  ERROR_LEVEL_NUMBER,
  ERROR_LEVEL_NUMBER_FIELD,
  ERROR_QUERY_MARKER,
  ERROR_SEVERITY_NUMBER,
  ERROR_SEVERITY_TEXT,
  type ErrorIssueKey,
  type ErrorQueryMeta,
  type ErrorSchema,
} from './errorAnalytics';
import type { LogRecord, QueryRequest } from './types';

type Occurrence = {
  service: string | null;
  error_type: string | null;
  message: string | null;
  at: number;
  trace_id: string | null;
  span_id: string | null;
  operation: string | null;
};

const MARKER = new RegExp(`^/\\* ${ERROR_QUERY_MARKER}:([^\\n]+) \\*/`);

/** The dataset and every column the canonical query references. */
export function errorDemoQueryTarget(request: QueryRequest) {
  const match = MARKER.exec(request.sql);
  if (!match) return undefined;
  const meta = JSON.parse(decodeURIComponent(match[1])) as ErrorQueryMeta;
  const { schema } = meta;
  const fields = [
    schema.timeColumn,
    ...schema.service,
    ...schema.errorType,
    ...schema.message,
    ...schema.exception.type,
    ...schema.exception.message,
    ...schema.severity.text,
    ...schema.severity.number,
    ...[schema.exception.gate, schema.traceId, schema.spanId, schema.operation].filter(
      (field): field is string => !!field,
    ),
    ...(schema.source === 'traces' ? ['span_status_code'] : []),
  ];
  return { dataset: meta.dataset, fields: [...new Set(fields)] };
}

/** CAST(x AS VARCHAR) with '' as NULL. */
function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const result = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return result === '' ? null : result;
}
function coalesce(row: LogRecord, fields: string[]) {
  for (const field of fields) {
    const value = text(row[field]);
    if (value !== null) return value;
  }
  return null;
}
/** SQL MAX over strings ignores NULL and compares code units. */
function max(a: string | null, b: string | null) {
  return a === null ? b : b === null || a >= b ? a : b;
}
/** ASC NULLS FIRST, code-unit order. */
function ascNullsFirst(a: string | null, b: string | null) {
  return a === b ? 0 : a === null ? -1 : b === null ? 1 : a < b ? -1 : 1;
}
function ascNullsLast(a: string | null, b: string | null) {
  return a === b ? 0 : a === null ? 1 : b === null ? -1 : a < b ? -1 : 1;
}
/** TRY_CAST(x AS DOUBLE): numbers and numeric strings, never truncated. */
function double(value: unknown) {
  if (typeof value === 'number') return value;
  // DataFusion trims surrounding whitespace when casting strings to DOUBLE.
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed) ? Number(trimmed) : NaN;
}
const severityNumbers = new Set<number>(ERROR_SEVERITY_NUMBER);
const levelNumbers = new Set<number>(ERROR_LEVEL_NUMBER);
const severities = new Set<string>(ERROR_SEVERITY_TEXT);
function isLogError(row: LogRecord, schema: ErrorSchema) {
  return (
    schema.severity.text.some((field) => {
      const value = text(row[field]);
      return (
        (value !== null && severities.has(value.trim().toUpperCase())) ||
        (field === ERROR_LEVEL_NUMBER_FIELD && levelNumbers.has(double(row[field])))
      );
    }) ||
    schema.severity.number.some((field) => {
      return severityNumbers.has(double(row[field]));
    })
  );
}

/** Same normalization as the SQL errors CTE, over the shared demo records. */
export function demoErrorOccurrences(
  rows: LogRecord[],
  schema: ErrorSchema,
  start: number,
  end: number,
): Occurrence[] {
  const inRange = (row: LogRecord) => {
    const at = parseEventTimestamp(row[schema.timeColumn]);
    return Number.isFinite(at) && at >= start && at < end ? at : undefined;
  };
  if (schema.source === 'logs') {
    const result: Occurrence[] = [];
    for (const row of rows) {
      const at = inRange(row);
      if (at === undefined || !isLogError(row, schema)) continue;
      result.push({
        service: coalesce(row, schema.service),
        error_type: coalesce(row, schema.errorType),
        message: coalesce(row, schema.message),
        at,
        trace_id: schema.traceId ? text(row[schema.traceId]) : null,
        span_id: schema.spanId ? text(row[schema.spanId]) : null,
        operation: null,
      });
    }
    return result;
  }
  type Candidate = { exception: boolean; error_type: string | null; message: string | null };
  type Span = Occurrence & { error: boolean; representative: Candidate };
  /** ROW_NUMBER() = 1 ordered by is_exception DESC, error_type, message ASC NULLS LAST. */
  const better = (a: Candidate, b: Candidate) =>
    a.exception !== b.exception
      ? a.exception
      : (ascNullsLast(a.error_type, b.error_type) || ascNullsLast(a.message, b.message)) < 0;
  const spans = new Map<string, Span>();
  const gate = schema.exception.gate;
  for (const row of rows) {
    const service = row['service.name'],
      trace = row[schema.traceId!],
      span = row[schema.spanId!];
    const at = inRange(row);
    if (
      at === undefined ||
      typeof service !== 'string' ||
      !service ||
      typeof trace !== 'string' ||
      !trace ||
      typeof span !== 'string' ||
      !span
    )
      continue;
    const event = !gate || row[gate] === 'exception';
    const exceptionType = event ? coalesce(row, schema.exception.type) : null,
      exceptionMessage = event ? coalesce(row, schema.exception.message) : null;
    const exception = exceptionType !== null || exceptionMessage !== null;
    const candidate: Candidate = exception
      ? { exception, error_type: exceptionType, message: exceptionMessage }
      : {
          exception,
          error_type: coalesce(row, schema.errorType),
          message: coalesce(row, schema.message),
        };
    const operation = schema.operation ? text(row[schema.operation]) : null;
    const key = JSON.stringify([service, trace, span]);
    const previous = spans.get(key);
    if (!previous) {
      spans.set(key, {
        service,
        trace_id: trace,
        span_id: span,
        at,
        error: double(row.span_status_code) === 2,
        representative: candidate,
        error_type: null,
        message: null,
        operation,
      });
      continue;
    }
    previous.at = Math.min(previous.at, at);
    previous.error ||= double(row.span_status_code) === 2;
    if (better(candidate, previous.representative)) previous.representative = candidate;
    previous.operation = max(previous.operation, operation);
  }
  return [...spans.values()]
    .filter((span) => span.error)
    .map((span) => ({
      service: span.service,
      error_type: span.representative.error_type,
      message: span.representative.message,
      at: span.at,
      trace_id: span.trace_id,
      span_id: span.span_id,
      operation: span.operation,
    }));
}

const matches = (item: Occurrence, issue: ErrorIssueKey) =>
  item.service === issue.service &&
  item.error_type === issue.errorType &&
  item.message === issue.message;
const iso = (ms: number) => new Date(ms).toISOString();

/** Called only by the demo client's query dispatcher. Returns undefined for
 * another query family; rejects anything but the canonical generated SQL. */
export function handleErrorDemoQuery(
  request: QueryRequest,
  rows: LogRecord[],
): LogRecord[] | undefined {
  const match = MARKER.exec(request.sql);
  if (!match) return undefined;
  const meta = JSON.parse(decodeURIComponent(match[1])) as ErrorQueryMeta;
  const expected = buildErrorQuery(meta);
  if (
    expected.sql !== request.sql ||
    expected.startTime !== request.startTime ||
    expected.endTime !== request.endTime
  )
    throw new Error('Unsupported demo error query');
  const start = Date.parse(meta.startTime),
    end = Date.parse(meta.endTime);
  if (meta.kind === 'explore') {
    const { schema, issue } = meta;
    const time = (row: LogRecord) => parseEventTimestamp(row[schema.timeColumn]);
    return rows
      .filter((row) => {
        const at = time(row);
        return (
          Number.isFinite(at) &&
          at >= start &&
          at < end &&
          isLogError(row, schema) &&
          coalesce(row, schema.service) === issue!.service &&
          coalesce(row, schema.errorType) === issue!.errorType &&
          coalesce(row, schema.message) === issue!.message
        );
      })
      .sort((a, b) => time(b) - time(a))
      .slice(0, meta.limit)
      .map((row) => structuredClone(row));
  }
  const all = demoErrorOccurrences(rows, meta.schema, start, end);
  const items = meta.issue ? all.filter((item) => matches(item, meta.issue!)) : all;
  const groups = new Map<string, { key: Occurrence; items: Occurrence[] }>();
  for (const item of all) {
    const id = JSON.stringify([item.service, item.error_type, item.message]);
    const group = groups.get(id) ?? { key: item, items: [] };
    group.items.push(item);
    groups.set(id, group);
  }
  const issues = [...groups.values()].map(({ key, items }) => ({
    service: key.service,
    errorType: key.error_type,
    message: key.message,
    occurrences: items.length,
    first: Math.min(...items.map((item) => item.at)),
    last: Math.max(...items.map((item) => item.at)),
  }));
  const page = <T>(list: T[]) => list.slice(meta.offset!, meta.offset! + meta.limit! + 1);
  switch (meta.kind) {
    case 'summary':
      return [
        {
          occurrences: all.length,
          issues: issues.length,
          firstSeen: issues.length ? iso(Math.min(...issues.map((issue) => issue.first))) : null,
          lastSeen: issues.length ? iso(Math.max(...issues.map((issue) => issue.last))) : null,
        },
      ];
    case 'series': {
      const interval = errorBucketInterval(meta);
      const counts = new Map<number, number>();
      for (const item of items) {
        const bucket = start + Math.floor((item.at - start) / interval) * interval;
        counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
      }
      return [...counts]
        .sort(([a], [b]) => a - b)
        .map(([bucket, occurrences]) => ({ bucket: iso(bucket), occurrences }));
    }
    case 'issues': {
      type Issue = (typeof issues)[number];
      const primary: Record<string, (a: Issue, b: Issue) => number> = {
        frequency: (a, b) => b.occurrences - a.occurrences || b.last - a.last,
        latest: (a, b) => b.last - a.last || b.occurrences - a.occurrences,
        first: (a, b) => b.first - a.first || b.occurrences - a.occurrences,
      };
      return page(
        issues.sort(
          (a, b) =>
            primary[meta.sort!](a, b) ||
            ascNullsFirst(a.service, b.service) ||
            ascNullsFirst(a.errorType, b.errorType) ||
            ascNullsFirst(a.message, b.message),
        ),
      ).map(({ first, last, ...issue }) => ({
        ...issue,
        firstSeen: iso(first),
        lastSeen: iso(last),
      }));
    }
    case 'occurrences':
      return page(
        items.sort(
          (a, b) =>
            b.at - a.at ||
            ascNullsLast(a.trace_id, b.trace_id) ||
            ascNullsLast(a.span_id, b.span_id) ||
            ascNullsLast(a.operation, b.operation),
        ),
      ).map((item) => ({
        time: iso(item.at),
        traceId: item.trace_id,
        spanId: item.span_id,
        operation: item.operation,
      }));
  }
}
