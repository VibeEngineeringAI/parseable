import { parseEventTimestamp } from '../components/explorer/timestamp';
import { ApiError } from './apiError';
import { apmTransportBounds } from './apm';
import { quoteIdentifier, quoteLiteral, timeBounds } from './query';
import type { DatasetInfo, LogRecord, ParseableClient, QueryRequest } from './types';

export type ErrorSource = 'traces' | 'logs';
/** Half-open ingestion-time range: start inclusive, end exclusive. */
export type ErrorBounds = { startTime: string; endTime: string };
/** Discovered columns, each list in fixed priority order and coalesced per row. */
export type ErrorSchema = {
  source: ErrorSource;
  timeColumn: string;
  service: string[];
  errorType: string[];
  message: string[];
  /** Traces only: event_exception.* fields are read from exception event rows
   * (when `gate` names the event column). A span whose exception row is populated
   * takes its type and message as a pair from that row; the direct, ungated
   * errorType/message attributes are used only when no such row exists. */
  exception: { gate: string | null; type: string[]; message: string[] };
  traceId: string | null;
  spanId: string | null;
  operation: string | null;
  /** Logs only. A row is an error when any field matches; a `level` text field
   * also matches the exact numeric codes in ERROR_LEVEL_NUMBER. */
  severity: { text: string[]; number: string[] };
};
/** Exact group identity. null means absent, NULL or empty, never a placeholder. */
export type ErrorIssueKey = {
  service: string | null;
  errorType: string | null;
  message: string | null;
};
export type ErrorIssue = ErrorIssueKey & {
  id: string;
  occurrences: number;
  firstSeen: string;
  lastSeen: string;
};
export type ErrorSummary = {
  occurrences: number;
  issues: number;
  firstSeen: string | null;
  lastSeen: string | null;
};
export type ErrorBucket = { bucket: string; occurrences: number };
export type ErrorOccurrence = {
  time: string;
  traceId: string | null;
  spanId: string | null;
  operation: string | null;
};
/** frequency: most occurrences; latest: most recently seen; first: newest issues first. */
export type ErrorSort = 'frequency' | 'latest' | 'first';
/** explore: raw stored log records of one issue, for the SQL explorer. */
export type ErrorQueryKind = 'summary' | 'series' | 'issues' | 'occurrences' | 'explore';
export type ErrorPage<T> = { rows: T[]; offset: number; hasMore: boolean };
export type ErrorTarget = Partial<ErrorBounds> & {
  dataset: string;
  schema: ErrorSchema;
  bounds?: ErrorBounds;
};
export type ErrorQueryOptions = ErrorTarget & {
  kind: ErrorQueryKind;
  issue?: ErrorIssueKey;
  sort?: ErrorSort;
  offset?: number;
  limit?: number;
};
/** Canonical demo marker payload: flat normalized bounds, defaults applied. */
export type ErrorQueryMeta = ErrorBounds & {
  dataset: string;
  schema: ErrorSchema;
  kind: ErrorQueryKind;
  issue?: ErrorIssueKey;
  sort?: ErrorSort;
  offset?: number;
  limit?: number;
};

export const ERROR_PAGE_SIZE = 25;
export const ERROR_BUCKETS = 48;
export const ERROR_SORTS: readonly ErrorSort[] = ['frequency', 'latest', 'first'];
export const ERROR_QUERY_MARKER = 'parseable-errors';
export const ERROR_SEVERITY_TEXT = [
  'ERROR',
  'ERROR2',
  'ERROR3',
  'ERROR4',
  'ERR',
  'FATAL',
  'FATAL2',
  'FATAL3',
  'FATAL4',
  'CRITICAL',
  'CRIT',
  'ALERT',
  'EMERG',
  'EMERGENCY',
  'PANIC',
  'SEVERE',
] as const;
/** OTLP SeverityNumber ERROR..FATAL4. */
export const ERROR_SEVERITY_NUMBER = [17, 18, 19, 20, 21, 22, 23, 24] as const;
/** pino/bunyan numeric levels error (50) and fatal (60), read from `level` only. */
export const ERROR_LEVEL_NUMBER = [50, 60] as const;
export const ERROR_LEVEL_NUMBER_FIELD = 'level';
export const ERROR_EXPLORE_LIMIT = { default: 100, max: 10_000 } as const;

const ALIASES = {
  severityText: ['p_log_category', 'level', 'log_level', 'severity', 'severity_text'],
  severityNumber: ['severity_number'],
  logService: ['service.name', 'service', 'service_name'],
  logErrorType: ['exception.type', 'error.type', 'error.kind', 'exception_type', 'error_type'],
  logMessage: ['message', 'msg', 'body', 'log', 'error.message'],
  logTraceId: ['trace_id', 'traceId', 'span_trace_id'],
  logSpanId: ['span_id', 'spanId', 'span_span_id'],
  // Event fields exist only on expanded event rows; direct span attributes are ungated.
  traceEventType: ['event_exception.type'],
  traceEventMessage: ['event_exception.message'],
  traceErrorType: ['exception.type'],
  traceMessage: ['exception.message', 'span_status_message'],
};
const TRACE_REQUIRED = ['service.name', 'span_trace_id', 'span_span_id', 'span_status_code'];

/** The dataset is readable but cannot be analyzed; message explains why. */
export class UnsupportedErrorSchema extends Error {
  name = 'UnsupportedErrorSchema';
}

/** Throws UnsupportedErrorSchema explaining why the dataset cannot be analyzed. */
export function inspectErrorSchema(fields: string[], info: DatasetInfo): ErrorSchema {
  const has = new Set(fields);
  const present = (names: string[]) => names.filter((name) => has.has(name));
  if (info.telemetryType === 'metrics')
    throw new UnsupportedErrorSchema('Metrics datasets do not contain error events');
  // A time partition changes what the time range means; never substitute p_timestamp.
  const timeColumn = info.timePartition || 'p_timestamp';
  if (!has.has(timeColumn))
    throw new UnsupportedErrorSchema(
      info.timePartition
        ? `This dataset's time partition column ${info.timePartition} is missing from its schema`
        : 'This dataset does not have the p_timestamp column',
    );
  if (info.logSourceFormats.includes('otel-traces')) {
    const missing = TRACE_REQUIRED.filter((field) => !has.has(field));
    if (missing.length)
      throw new UnsupportedErrorSchema(
        `This dataset does not have the required OTLP span fields: ${missing.join(', ')}`,
      );
    return {
      source: 'traces',
      timeColumn,
      service: ['service.name'],
      errorType: present(ALIASES.traceErrorType),
      message: present(ALIASES.traceMessage),
      exception: {
        gate: has.has('event_name') ? 'event_name' : null,
        type: present(ALIASES.traceEventType),
        message: present(ALIASES.traceEventMessage),
      },
      traceId: 'span_trace_id',
      spanId: 'span_span_id',
      operation: has.has('span_name') ? 'span_name' : null,
      severity: { text: [], number: [] },
    };
  }
  const severity = {
    text: present(ALIASES.severityText),
    number: present(ALIASES.severityNumber),
  };
  if (!severity.text.length && !severity.number.length)
    throw new UnsupportedErrorSchema(
      `This dataset has no severity field (${[...ALIASES.severityText, ...ALIASES.severityNumber].join(', ')})`,
    );
  return {
    source: 'logs',
    timeColumn,
    service: present(ALIASES.logService),
    errorType: present(ALIASES.logErrorType),
    message: present(ALIASES.logMessage),
    exception: { gate: null, type: [], message: [] },
    traceId: present(ALIASES.logTraceId)[0] ?? null,
    spanId: present(ALIASES.logSpanId)[0] ?? null,
    operation: null,
    severity,
  };
}

export async function loadErrorSchema(
  client: Pick<ParseableClient, 'datasetInfo' | 'schema'>,
  dataset: string,
  signal?: AbortSignal,
) {
  const [info, fields] = await Promise.all([
    client.datasetInfo(dataset, signal),
    client.schema(dataset, signal),
  ]);
  return inspectErrorSchema(fields, info);
}

export type ErrorDataset = { name: string; source: ErrorSource; schema: ErrorSchema };
export async function discoverErrorDatasets(
  client: Pick<ParseableClient, 'listDatasets' | 'datasetInfo' | 'schema'>,
  signal?: AbortSignal,
) {
  // Listed types can be placeholders; dataset info decides eligibility.
  const datasets = await client.listDatasets(signal);
  const found: ErrorDataset[] = [],
    unchecked: string[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, datasets.length) }, async () => {
      while (next < datasets.length) {
        signal?.throwIfAborted();
        const dataset = datasets[next++];
        let schema: ErrorSchema;
        try {
          schema = await loadErrorSchema(client, dataset.name, signal);
        } catch (error) {
          if (
            signal?.aborted ||
            (error instanceof Error && error.name === 'AbortError') ||
            (error instanceof ApiError && error.status === 401)
          )
            throw error;
          if (
            !(error instanceof UnsupportedErrorSchema) &&
            !(error instanceof ApiError && (error.status === 403 || error.status === 404))
          )
            unchecked.push(dataset.name);
          continue;
        }
        found.push({ name: dataset.name, source: schema.source, schema });
      }
    }),
  );
  return {
    datasets: found.sort((a, b) => a.name.localeCompare(b.name)),
    unchecked: unchecked.sort(),
  };
}

export function errorBucketInterval(bounds: ErrorBounds) {
  const normalized = timeBounds(bounds);
  return Math.ceil(
    (Date.parse(normalized.endTime) - Date.parse(normalized.startTime)) / ERROR_BUCKETS,
  );
}
/** URL-safe stable identity; JSON keeps null distinct from the string "null". */
export function errorIssueId(key: ErrorIssueKey): string {
  return JSON.stringify([key.service, key.errorType, key.message]);
}
export function parseErrorIssueId(id: string): ErrorIssueKey | undefined {
  try {
    const value: unknown = JSON.parse(id);
    if (
      Array.isArray(value) &&
      value.length === 3 &&
      value.every((item) => item === null || typeof item === 'string')
    )
      return { service: value[0], errorType: value[1], message: value[2] };
  } catch {
    /* not an issue id */
  }
  return undefined;
}

function resolveBounds(target: ErrorTarget): ErrorBounds {
  const value = target.bounds ?? { startTime: target.startTime!, endTime: target.endTime! };
  if (!value.startTime || !value.endTime) throw new Error('Error analytics needs a time range');
  return timeBounds(value);
}
function validateSchema(schema: ErrorSchema) {
  const lists = [
    schema.service,
    schema.errorType,
    schema.message,
    schema.exception?.type,
    schema.exception?.message,
    schema.severity?.text,
    schema.severity?.number,
  ];
  if (
    (schema.source !== 'traces' && schema.source !== 'logs') ||
    typeof schema.timeColumn !== 'string' ||
    lists.some((list) => !Array.isArray(list) || list.some((f) => typeof f !== 'string'))
  )
    throw new Error('Invalid error schema');
  if (schema.source === 'logs' && !schema.severity.text.length && !schema.severity.number.length)
    throw new Error('Invalid error schema');
  if (schema.source === 'traces' && (!schema.traceId || !schema.spanId))
    throw new Error('Invalid error schema');
}
function validateKey(issue: ErrorIssueKey) {
  for (const value of [issue.service, issue.errorType, issue.message])
    if (value !== null && (typeof value !== 'string' || value === ''))
      throw new Error('Invalid error issue');
}
const text = (field: string) => `NULLIF(CAST(${quoteIdentifier(field)} AS VARCHAR), '')`;
const coalesce = (fields: string[]) =>
  fields.length === 0
    ? 'CAST(NULL AS VARCHAR)'
    : fields.length === 1
      ? text(fields[0])
      : `COALESCE(${fields.map(text).join(', ')})`;
const equals = (column: string, value: string | null) =>
  value === null ? `${column} IS NULL` : `${column} = ${quoteLiteral(value)}`;
export function errorIssuePredicate(issue: ErrorIssueKey, prefix = '') {
  return [
    equals(`${prefix}service`, issue.service),
    equals(`${prefix}error_type`, issue.errorType),
    equals(`${prefix}message`, issue.message),
  ].join(' AND ');
}
function logIssuePredicate(schema: ErrorSchema, issue: ErrorIssueKey) {
  return [
    equals(coalesce(schema.service), issue.service),
    equals(coalesce(schema.errorType), issue.errorType),
    equals(coalesce(schema.message), issue.message),
  ].join(' AND ');
}
function severityPredicate(schema: ErrorSchema) {
  const values = ERROR_SEVERITY_TEXT.map((value) => quoteLiteral(value)).join(', ');
  // Exact comparison: fractional codes such as 24.9 or 50.9 are not severities.
  const exact = (field: string, codes: readonly number[]) =>
    `TRY_CAST(${quoteIdentifier(field)} AS DOUBLE) IN (${codes.join(', ')})`;
  return `(${[
    ...schema.severity.text.map(
      (field) => `UPPER(TRIM(CAST(${quoteIdentifier(field)} AS VARCHAR))) IN (${values})`,
    ),
    ...schema.severity.text
      .filter((field) => field === ERROR_LEVEL_NUMBER_FIELD)
      .map((field) => exact(field, ERROR_LEVEL_NUMBER)),
    ...schema.severity.number.map((field) => exact(field, ERROR_SEVERITY_NUMBER)),
  ].join(' OR ')})`;
}
function timePredicate(column: string, bounds: ErrorBounds) {
  return `${column} >= TIMESTAMP ${quoteLiteral(bounds.startTime)} AND ${column} < TIMESTAMP ${quoteLiteral(bounds.endTime)}`;
}

/** Normalized error rows: one per occurrence. Trace spans are deduplicated by
 * service + trace + span before anything is counted, because event and link
 * expansion repeats a span. Each span takes its type and message together from
 * one representative row so the pair is never mixed across events: rows whose
 * exception event fields are populated win; direct span attributes are used only
 * when the span has no such row; ties break on the pair itself (ASC, NULLS LAST). */
function errorsCte(dataset: string, schema: ErrorSchema, bounds: ErrorBounds) {
  const time = quoteIdentifier(schema.timeColumn);
  const table = quoteIdentifier(dataset);
  if (schema.source === 'traces') {
    const service = quoteIdentifier('service.name'),
      trace = quoteIdentifier(schema.traceId!),
      span = quoteIdentifier(schema.spanId!);
    const event = (fields: string[]) =>
      fields.length === 0
        ? 'CAST(NULL AS VARCHAR)'
        : schema.exception.gate
          ? `CASE WHEN ${quoteIdentifier(schema.exception.gate)} = 'exception' THEN ${coalesce(fields)} END`
          : coalesce(fields);
    const partition = 'PARTITION BY service, trace_id, span_id';
    return `WITH span_rows AS (
    SELECT ${service} AS service, ${trace} AS trace_id, ${span} AS span_id, ${time} AS at,
      CASE WHEN TRY_CAST(${quoteIdentifier('span_status_code')} AS DOUBLE) = 2 THEN 1 ELSE 0 END AS is_error,
      ${event(schema.exception.type)} AS exception_type, ${event(schema.exception.message)} AS exception_message,
      ${coalesce(schema.errorType)} AS direct_type, ${coalesce(schema.message)} AS direct_message,
      ${schema.operation ? text(schema.operation) : 'CAST(NULL AS VARCHAR)'} AS operation
    FROM ${table}
    WHERE ${service} IS NOT NULL AND ${service} <> '' AND ${trace} IS NOT NULL AND ${trace} <> '' AND ${span} IS NOT NULL AND ${span} <> ''
      AND ${timePredicate(time, bounds)}
  ), candidates AS (
    SELECT service, trace_id, span_id, at, is_error, operation,
      CASE WHEN exception_type IS NOT NULL OR exception_message IS NOT NULL THEN 1 ELSE 0 END AS is_exception,
      CASE WHEN exception_type IS NOT NULL OR exception_message IS NOT NULL THEN exception_type ELSE direct_type END AS error_type,
      CASE WHEN exception_type IS NOT NULL OR exception_message IS NOT NULL THEN exception_message ELSE direct_message END AS message
    FROM span_rows
  ), spans AS (
    SELECT service, trace_id, span_id, error_type, message,
      MIN(at) OVER (${partition}) AS at,
      MAX(is_error) OVER (${partition}) AS is_error,
      MAX(operation) OVER (${partition}) AS operation,
      ROW_NUMBER() OVER (${partition} ORDER BY is_exception DESC, error_type ASC NULLS LAST, message ASC NULLS LAST) AS representative
    FROM candidates
  ), errors AS (
    SELECT service, error_type, message, at, trace_id, span_id, operation FROM spans WHERE representative = 1 AND is_error = 1
  )`;
  }
  return `WITH errors AS (
    SELECT ${coalesce(schema.service)} AS service, ${coalesce(schema.errorType)} AS error_type, ${coalesce(schema.message)} AS message, ${time} AS at,
      ${schema.traceId ? text(schema.traceId) : 'CAST(NULL AS VARCHAR)'} AS trace_id, ${schema.spanId ? text(schema.spanId) : 'CAST(NULL AS VARCHAR)'} AS span_id, CAST(NULL AS VARCHAR) AS operation
    FROM ${table}
    WHERE ${timePredicate(time, bounds)} AND ${severityPredicate(schema)}
  )`;
}

const TIE_BREAK = 'service ASC NULLS FIRST, error_type ASC NULLS FIRST, message ASC NULLS FIRST';
const SORT_ORDER: Record<ErrorSort, string> = {
  frequency: `"occurrences" DESC, "lastSeen" DESC, ${TIE_BREAK}`,
  latest: `"lastSeen" DESC, "occurrences" DESC, ${TIE_BREAK}`,
  first: `"firstSeen" DESC, "occurrences" DESC, ${TIE_BREAK}`,
};

function canonical(options: ErrorQueryOptions): ErrorQueryMeta {
  const { dataset, schema, kind } = options;
  if (!['summary', 'series', 'issues', 'occurrences', 'explore'].includes(kind))
    throw new Error('Unsupported error query kind');
  validateSchema(schema);
  quoteIdentifier(dataset);
  const meta: ErrorQueryMeta = { ...resolveBounds(options), dataset, schema, kind };
  if (options.issue) {
    if (kind !== 'series' && kind !== 'occurrences' && kind !== 'explore')
      throw new Error(`An issue filter is not supported for ${kind}`);
    validateKey(options.issue);
    meta.issue = {
      service: options.issue.service,
      errorType: options.issue.errorType,
      message: options.issue.message,
    };
  } else if (kind === 'occurrences' || kind === 'explore') throw new Error('Select an error issue');
  if (kind === 'explore' && schema.source !== 'logs')
    throw new Error('Raw error records are explored for log datasets; open traces natively');
  if (kind === 'issues') {
    const sort = options.sort ?? 'frequency';
    if (!ERROR_SORTS.includes(sort)) throw new Error('Unsupported error sort');
    meta.sort = sort;
  } else if (options.sort !== undefined) throw new Error(`Sorting is not supported for ${kind}`);
  if (kind === 'issues' || kind === 'occurrences') {
    const limit = options.limit ?? ERROR_PAGE_SIZE,
      offset = options.offset ?? 0;
    if (!Number.isInteger(limit) || limit < 1 || limit > ERROR_PAGE_SIZE)
      throw new Error(`Error page size must be between 1 and ${ERROR_PAGE_SIZE}`);
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new Error('Error page offset must be a nonnegative integer');
    meta.limit = limit;
    meta.offset = offset;
  } else if (kind === 'explore') {
    const limit = options.limit ?? ERROR_EXPLORE_LIMIT.default;
    if (!Number.isInteger(limit) || limit < 1 || limit > ERROR_EXPLORE_LIMIT.max)
      throw new Error(`Limit must be between 1 and ${ERROR_EXPLORE_LIMIT.max}`);
    if (options.offset !== undefined) throw new Error('Pagination is not supported for explore');
    meta.limit = limit;
  } else if (options.limit !== undefined || options.offset !== undefined)
    throw new Error(`Pagination is not supported for ${kind}`);
  return meta;
}

/** Full-range SQL over a normalized errors CTE; no sampling before aggregates.
 * Transport bounds are expanded to whole minutes; SQL enforces the exact range. */
export function buildErrorQuery(options: ErrorQueryOptions): QueryRequest {
  const meta = canonical(options);
  const { schema, kind } = meta;
  const bounds = { startTime: meta.startTime, endTime: meta.endTime };
  if (kind === 'explore') {
    const time = quoteIdentifier(schema.timeColumn);
    const select = `SELECT * FROM ${quoteIdentifier(meta.dataset)} WHERE ${timePredicate(time, bounds)} AND ${severityPredicate(schema)} AND ${logIssuePredicate(schema, meta.issue!)} ORDER BY ${time} DESC LIMIT ${meta.limit}`;
    return request(meta, bounds, select);
  }
  const cte = errorsCte(meta.dataset, schema, bounds);
  const issueFilter = meta.issue ? ` WHERE ${errorIssuePredicate(meta.issue)}` : '';
  const page = () => `LIMIT ${meta.limit! + 1} OFFSET ${meta.offset}`;
  let select: string;
  switch (kind) {
    case 'summary':
      select = `SELECT COALESCE(SUM(n), 0) AS "occurrences", COUNT(*) AS "issues", MIN(first_seen) AS "firstSeen", MAX(last_seen) AS "lastSeen" FROM (SELECT COUNT(*) AS n, MIN(at) AS first_seen, MAX(at) AS last_seen FROM errors GROUP BY service, error_type, message) issues`;
      break;
    case 'series':
      select = `SELECT DATE_BIN(INTERVAL '${errorBucketInterval(bounds)} milliseconds', at, TIMESTAMP ${quoteLiteral(bounds.startTime)}) AS "bucket", COUNT(*) AS "occurrences" FROM errors${issueFilter} GROUP BY "bucket" ORDER BY "bucket" ASC`;
      break;
    case 'issues':
      select = `SELECT service AS "service", error_type AS "errorType", message AS "message", COUNT(*) AS "occurrences", MIN(at) AS "firstSeen", MAX(at) AS "lastSeen" FROM errors GROUP BY service, error_type, message ORDER BY ${SORT_ORDER[meta.sort!]} ${page()}`;
      break;
    case 'occurrences':
      select = `SELECT at AS "time", trace_id AS "traceId", span_id AS "spanId", operation AS "operation" FROM errors${issueFilter} ORDER BY at DESC, trace_id ASC NULLS LAST, span_id ASC NULLS LAST, operation ASC NULLS LAST ${page()}`;
      break;
  }
  return request(meta, bounds, `${cte}\n${select}`);
}
function request(meta: ErrorQueryMeta, bounds: ErrorBounds, sql: string): QueryRequest {
  // Machine-readable contract for the explicitly selected demo adapter, never a live endpoint.
  const marker = encodeURIComponent(JSON.stringify(meta));
  return {
    ...apmTransportBounds(bounds),
    sql: `/* ${ERROR_QUERY_MARKER}:${marker} */\n${sql}`,
  };
}

/** Raw stored records (SELECT *) of one log issue for the SQL explorer, so
 * stack traces and other fields stay inspectable. Uses the same time, severity
 * and coalesced key expressions as the aggregates; run it with the transport
 * bounds from apmTransportBounds(bounds). Log datasets only. */
export function buildErrorExplorerSql(
  options: ErrorTarget & { issue: ErrorIssueKey },
  limit: number = ERROR_EXPLORE_LIMIT.default,
): string {
  return buildErrorQuery({ ...options, kind: 'explore', limit }).sql;
}

function fail(key: string): never {
  throw new Error(`Malformed error analytics result: ${key}`);
}
function count(row: LogRecord, key: string): number {
  const value = row[key];
  if ((typeof value !== 'number' && typeof value !== 'string') || value === '') fail(key);
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) fail(key);
  return n;
}
function nullableText(row: LogRecord, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value === '') fail(key);
  return value;
}
function time(row: LogRecord, key: string): string {
  const value = row[key];
  if (typeof value !== 'string' || !Number.isFinite(parseEventTimestamp(value))) fail(key);
  return value;
}
function rows(result: unknown): LogRecord[] {
  if (
    !Array.isArray(result) ||
    result.some((row) => row === null || typeof row !== 'object' || Array.isArray(row))
  )
    fail('rows');
  return result as LogRecord[];
}

export function decodeErrorSummary(result: unknown): ErrorSummary {
  const list = rows(result);
  if (list.length !== 1) fail('summary');
  const row = list[0];
  const occurrences = count(row, 'occurrences'),
    issues = count(row, 'issues');
  if (issues > occurrences || (occurrences > 0 && issues === 0)) fail('issues');
  if (occurrences === 0) {
    if (row.firstSeen != null || row.lastSeen != null) fail('firstSeen');
    return { occurrences, issues, firstSeen: null, lastSeen: null };
  }
  const firstSeen = time(row, 'firstSeen'),
    lastSeen = time(row, 'lastSeen');
  if (parseEventTimestamp(firstSeen) > parseEventTimestamp(lastSeen)) fail('lastSeen');
  return { occurrences, issues, firstSeen, lastSeen };
}
/** Dense buckets covering the range; absent buckets are zero within a successful query. */
export function decodeErrorSeries(result: unknown, bounds: ErrorBounds): ErrorBucket[] {
  const normalized = timeBounds(bounds);
  const start = Date.parse(normalized.startTime),
    end = Date.parse(normalized.endTime),
    interval = errorBucketInterval(normalized);
  const buckets = Array.from({ length: Math.ceil((end - start) / interval) }, (_, index) => ({
    bucket: new Date(start + index * interval).toISOString(),
    occurrences: 0,
  }));
  const seen = new Set<number>();
  for (const row of rows(result)) {
    const at = parseEventTimestamp(time(row, 'bucket'));
    const index = (at - start) / interval;
    if (!Number.isInteger(index) || index < 0 || index >= buckets.length || seen.has(index))
      fail('bucket');
    seen.add(index);
    const occurrences = count(row, 'occurrences');
    if (occurrences === 0) fail('occurrences');
    buckets[index].occurrences = occurrences;
  }
  return buckets;
}
export function decodeErrorIssue(row: LogRecord): ErrorIssue {
  const key = {
    service: nullableText(row, 'service'),
    errorType: nullableText(row, 'errorType'),
    message: nullableText(row, 'message'),
  };
  const occurrences = count(row, 'occurrences');
  if (occurrences < 1) fail('occurrences');
  const firstSeen = time(row, 'firstSeen'),
    lastSeen = time(row, 'lastSeen');
  if (parseEventTimestamp(firstSeen) > parseEventTimestamp(lastSeen)) fail('lastSeen');
  return { id: errorIssueId(key), ...key, occurrences, firstSeen, lastSeen };
}
export function decodeErrorOccurrence(row: LogRecord): ErrorOccurrence {
  return {
    time: time(row, 'time'),
    traceId: nullableText(row, 'traceId'),
    spanId: nullableText(row, 'spanId'),
    operation: nullableText(row, 'operation'),
  };
}
function paged<T>(list: LogRecord[], decode: (row: LogRecord) => T, offset: number, limit: number) {
  if (list.length > limit + 1) fail('page');
  return {
    rows: list.slice(0, limit).map(decode),
    offset,
    hasMore: list.length > limit,
  } satisfies ErrorPage<T>;
}

type Client = Pick<ParseableClient, 'query'>;
export async function loadErrorSummary(client: Client, target: ErrorTarget, signal?: AbortSignal) {
  return decodeErrorSummary(
    await client.query(buildErrorQuery({ ...target, kind: 'summary' }), signal),
  );
}
export async function loadErrorSeries(
  client: Client,
  target: ErrorTarget & { issue?: ErrorIssueKey },
  signal?: AbortSignal,
) {
  return decodeErrorSeries(
    await client.query(buildErrorQuery({ ...target, kind: 'series' }), signal),
    resolveBounds(target),
  );
}
export async function loadErrorIssues(
  client: Client,
  target: ErrorTarget & { sort?: ErrorSort; offset?: number; limit?: number },
  signal?: AbortSignal,
): Promise<ErrorPage<ErrorIssue>> {
  const request = buildErrorQuery({ ...target, kind: 'issues' });
  const result = rows(await client.query(request, signal));
  const page = paged(result, decodeErrorIssue, target.offset ?? 0, target.limit ?? ERROR_PAGE_SIZE);
  if (new Set(page.rows.map((issue) => issue.id)).size !== page.rows.length) fail('issue identity');
  return page;
}
export async function loadErrorOccurrences(
  client: Client,
  target: ErrorTarget & { issue: ErrorIssueKey; offset?: number; limit?: number },
  signal?: AbortSignal,
): Promise<ErrorPage<ErrorOccurrence>> {
  const request = buildErrorQuery({ ...target, kind: 'occurrences' });
  return paged(
    rows(await client.query(request, signal)),
    decodeErrorOccurrence,
    target.offset ?? 0,
    target.limit ?? ERROR_PAGE_SIZE,
  );
}
export async function loadErrorOverview(
  client: Client,
  target: ErrorTarget & { sort?: ErrorSort; offset?: number },
  signal?: AbortSignal,
) {
  const { sort, offset, ...base } = target;
  const [summary, series, issues] = await Promise.all([
    loadErrorSummary(client, base, signal),
    loadErrorSeries(client, base, signal),
    loadErrorIssues(client, { ...base, sort, offset }, signal),
  ]);
  return { summary, series, issues };
}
export type ErrorOverview = Awaited<ReturnType<typeof loadErrorOverview>>;
