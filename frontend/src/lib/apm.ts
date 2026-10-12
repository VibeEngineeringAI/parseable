import { parseEventTimestamp } from '../components/explorer/timestamp';
import { ApiError } from './apiError';
import { quoteIdentifier, quoteLiteral, timeBounds, paramsRange } from './query';
import type { DatasetInfo, LogRecord, ParseableClient, QueryRequest, TimeRange } from './types';

export type ApmBounds = { startTime: string; endTime: string };
export type ApmMetric = 'avgMs' | 'p50Ms' | 'p95Ms' | 'p99Ms' | 'maxMs';
export type ApmStats = {
  spanCount: number;
  traceCount: number;
  errorCount: number;
  errorRate: number;
  avgMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  maxMs: number | null;
};
export type ApmService = ApmStats & { service: string };
export type ApmOperation = ApmStats & { operation: string };
export type ApmBucket = ApmStats & { bucket: string };
export type ApmSpan = {
  traceId: string;
  spanId: string;
  operation: string;
  startedAt: string;
  durationMs: number | null;
  error: boolean;
};
export type ApmEdge = {
  source: string;
  target: string;
  spanCount: number;
  errorCount: number;
  avgMs: number | null;
};
export type ApmQueryKind = 'inventory' | 'summary' | 'operations' | 'series' | 'spans' | 'topology';
export type ApmSchema = {
  status: boolean;
  parent: boolean;
  timeColumn?: string;
};
export type ApmQueryOptions = ApmBounds & {
  dataset: string;
  kind: ApmQueryKind;
  service?: string;
  limit?: number;
  schema?: ApmSchema;
};
export const APM_LIMITS = {
  inventory: 200,
  operations: 100,
  spans: 50,
  topology: 200,
} as const;
export const APM_BUCKETS = 36;
export const EMPTY_APM_STATS: ApmStats = {
  spanCount: 0,
  traceCount: 0,
  errorCount: 0,
  errorRate: 0,
  avgMs: null,
  p50Ms: null,
  p95Ms: null,
  p99Ms: null,
  maxMs: null,
};

function boundedLimit(kind: ApmQueryKind, value?: number) {
  const max = kind in APM_LIMITS ? APM_LIMITS[kind as keyof typeof APM_LIMITS] : 1;
  const limit = value ?? max;
  if (!Number.isInteger(limit) || limit < 1 || limit > max)
    throw new Error(`APM ${kind} limit must be between 1 and ${max}`);
  return limit;
}
export function apmBucketInterval(bounds: ApmBounds) {
  const normalized = timeBounds(bounds);
  return Math.ceil(
    (Date.parse(normalized.endTime) - Date.parse(normalized.startTime)) / APM_BUCKETS,
  );
}
const aggregate = `COUNT(*) AS "spanCount", COUNT(DISTINCT trace_id) AS "traceCount", SUM(is_error) AS "errorCount", 100.0 * SUM(is_error) / COUNT(*) AS "errorRate", AVG(duration_ms) AS "avgMs", APPROX_PERCENTILE_CONT(duration_ms, 0.5) AS "p50Ms", APPROX_PERCENTILE_CONT(duration_ms, 0.95) AS "p95Ms", APPROX_PERCENTILE_CONT(duration_ms, 0.99) AS "p99Ms", MAX(duration_ms) AS "maxMs"`;

/** Only verified OTLP flattened fields; no sampling limit before dedup or aggregates.
 * Event/link expansion repeats a span, so service + trace + span are the identity.
 * Percentiles use DataFusion's approximate aggregate; duration units are milliseconds.
 */
export function buildApmQuery(options: ApmQueryOptions): QueryRequest {
  const { dataset, kind, service } = options;
  if (!['inventory', 'summary', 'operations', 'series', 'spans', 'topology'].includes(kind))
    throw new Error('Unsupported APM query kind');
  if (kind !== 'inventory' && kind !== 'topology' && !service)
    throw new Error('Select an APM service');
  const bounds = timeBounds(options);
  const limit = boundedLimit(kind, options.limit);
  const interval = apmBucketInterval(bounds);
  const serviceFilter =
    service && kind !== 'topology' ? ` AND "service.name" = ${quoteLiteral(service)}` : '';
  const timeColumn = quoteIdentifier(options.schema?.timeColumn || 'p_timestamp');
  const cte = `WITH spans AS (
    SELECT "service.name" AS service, "span_trace_id" AS trace_id, "span_span_id" AS span_id,
      ${options.schema?.parent === false ? 'CAST(NULL AS VARCHAR)' : 'MAX("span_parent_span_id")'} AS parent_id, MAX("span_name") AS operation,
      MAX(TRY_CAST("span_start_time_unix_nano" AS TIMESTAMP)) AS started_at, MIN(${timeColumn}) AS ingested_at,
      MAX(CASE WHEN TRY_CAST("span_duration_ns" AS DOUBLE) >= 0 THEN TRY_CAST("span_duration_ns" AS DOUBLE) / 1000000.0 END) AS duration_ms,
      ${options.schema?.status === false ? '0' : 'MAX(CASE WHEN "span_status_code" = 2 THEN 1 ELSE 0 END)'} AS is_error
    FROM ${quoteIdentifier(dataset)}
    WHERE "service.name" IS NOT NULL AND "service.name" <> '' AND "span_trace_id" IS NOT NULL AND "span_trace_id" <> '' AND "span_span_id" IS NOT NULL AND "span_span_id" <> ''
      AND ${timeColumn} >= TIMESTAMP ${quoteLiteral(bounds.startTime)}
      AND ${timeColumn} < TIMESTAMP ${quoteLiteral(bounds.endTime)}${serviceFilter}
    GROUP BY "service.name", "span_trace_id", "span_span_id"
  )`;
  let select: string;
  switch (kind) {
    case 'inventory':
      select = `SELECT service AS "service", ${aggregate} FROM spans GROUP BY service ORDER BY "spanCount" DESC, service ASC LIMIT ${limit + 1}`;
      break;
    case 'summary':
      select = `SELECT ${aggregate} FROM spans`;
      break;
    case 'operations':
      select = `SELECT COALESCE(operation, '(unnamed)') AS "operation", ${aggregate} FROM spans GROUP BY COALESCE(operation, '(unnamed)') ORDER BY "spanCount" DESC, "operation" ASC LIMIT ${limit + 1}`;
      break;
    case 'series':
      select = `SELECT DATE_BIN(INTERVAL '${interval} milliseconds', ingested_at, TIMESTAMP ${quoteLiteral(bounds.startTime)}) AS "bucket", ${aggregate} FROM spans GROUP BY "bucket" ORDER BY "bucket" ASC`;
      break;
    case 'spans':
      select = `SELECT trace_id AS "traceId", span_id AS "spanId", COALESCE(operation, '(unnamed)') AS "operation", started_at AS "startedAt", duration_ms AS "durationMs", is_error AS "error" FROM spans WHERE started_at IS NOT NULL ORDER BY is_error DESC, duration_ms DESC NULLS LAST, trace_id ASC, span_id ASC LIMIT ${limit + 1}`;
      break;
    case 'topology':
      select = `SELECT parent.service AS "source", child.service AS "target", COUNT(*) AS "spanCount", SUM(child.is_error) AS "errorCount", AVG(child.duration_ms) AS "avgMs" FROM spans child JOIN (SELECT trace_id, span_id, MIN(service) AS service FROM spans GROUP BY trace_id, span_id HAVING COUNT(*) = 1) parent ON child.trace_id = parent.trace_id AND child.parent_id = parent.span_id WHERE child.service <> parent.service${service ? ` AND (parent.service = ${quoteLiteral(service)} OR child.service = ${quoteLiteral(service)})` : ''} GROUP BY parent.service, child.service ORDER BY "spanCount" DESC, "source" ASC, "target" ASC LIMIT ${limit + 1}`;
      break;
  }
  // Machine-readable contract for the explicitly selected demo adapter, never a live endpoint.
  const meta = encodeURIComponent(
    JSON.stringify({
      ...bounds,
      dataset,
      kind,
      service,
      limit,
      schema: options.schema,
    }),
  );
  return {
    ...apmTransportBounds(bounds),
    sql: `/* parseable-apm:${meta} */\n${cte}\n${select}`,
  };
}
function number(row: LogRecord, key: string, nullable = false): number | null {
  if (row[key] == null && nullable) return null;
  const value = row[key];
  if ((typeof value !== 'number' && typeof value !== 'string') || value === '')
    throw new Error(`Malformed APM result: ${key}`);
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`Malformed APM result: ${key}`);
  return n;
}
function text(row: LogRecord, key: string) {
  if (typeof row[key] !== 'string' || !row[key]) throw new Error(`Malformed APM result: ${key}`);
  return row[key] as string;
}
export function decodeApmStats(row: LogRecord): ApmStats {
  const spanCount = number(row, 'spanCount')!;
  if (!Number.isSafeInteger(spanCount))
    throw new Error('APM span count exceeds safe numeric precision');
  if (spanCount === 0) return { ...EMPTY_APM_STATS };
  const traceCount = number(row, 'traceCount')!,
    errorCount = number(row, 'errorCount')!,
    errorRate = number(row, 'errorRate')!;
  if (
    !Number.isSafeInteger(traceCount) ||
    !Number.isSafeInteger(errorCount) ||
    traceCount > spanCount ||
    errorCount > spanCount ||
    errorRate > 100
  )
    throw new Error('Malformed APM counts');
  return {
    spanCount,
    traceCount,
    errorCount,
    errorRate,
    avgMs: number(row, 'avgMs', true),
    p50Ms: number(row, 'p50Ms', true),
    p95Ms: number(row, 'p95Ms', true),
    p99Ms: number(row, 'p99Ms', true),
    maxMs: number(row, 'maxMs', true),
  };
}
function cap<T>(rows: T[], limit: number) {
  return { rows: rows.slice(0, limit), truncated: rows.length > limit };
}
export async function loadApmInventory(
  client: Pick<ParseableClient, 'query'>,
  dataset: string,
  bounds: ApmBounds,
  signal?: AbortSignal,
  schema?: ApmSchema,
) {
  const rows = await client.query(
    buildApmQuery({ ...bounds, dataset, kind: 'inventory', schema }),
    signal,
  );
  return cap(
    rows.map((row): ApmService => ({
      service: text(row, 'service'),
      ...decodeApmStats(row),
    })),
    APM_LIMITS.inventory,
  );
}
export async function loadApmTopology(
  client: Pick<ParseableClient, 'query'>,
  dataset: string,
  bounds: ApmBounds,
  signal?: AbortSignal,
  schema?: ApmSchema,
  service?: string,
) {
  const rows = await client.query(
    buildApmQuery({ ...bounds, dataset, kind: 'topology', schema, service }),
    signal,
  );
  return cap(
    rows.map((row): ApmEdge => ({
      source: text(row, 'source'),
      target: text(row, 'target'),
      spanCount: number(row, 'spanCount')!,
      errorCount: number(row, 'errorCount')!,
      avgMs: number(row, 'avgMs', true),
    })),
    APM_LIMITS.topology,
  );
}
export async function loadApmInsights(
  client: Pick<ParseableClient, 'query'>,
  dataset: string,
  service: string,
  bounds: ApmBounds,
  signal?: AbortSignal,
  schema?: ApmSchema,
) {
  const request = (kind: ApmQueryKind) =>
    client.query(buildApmQuery({ ...bounds, dataset, service, kind, schema }), signal);
  const [summary, operations, series, spans] = await Promise.all([
    request('summary'),
    request('operations'),
    request('series'),
    request('spans'),
  ]);
  if (summary.length !== 1) throw new Error('Malformed APM summary result');
  return {
    summary: decodeApmStats(summary[0]),
    operations: cap(
      operations.map((row): ApmOperation => ({
        operation: text(row, 'operation'),
        ...decodeApmStats(row),
      })),
      APM_LIMITS.operations,
    ),
    series: series.map((row): ApmBucket => ({
      bucket: text(row, 'bucket'),
      ...decodeApmStats(row),
    })),
    spans: cap(
      spans.map((row): ApmSpan => {
        if (row.error !== 0 && row.error !== 1 && row.error !== '0' && row.error !== '1')
          throw new Error('Malformed APM span error status');
        const startedAt = text(row, 'startedAt');
        if (!Number.isFinite(parseEventTimestamp(startedAt)))
          throw new Error('Malformed APM span timestamp');
        return {
          traceId: text(row, 'traceId'),
          spanId: text(row, 'spanId'),
          operation: text(row, 'operation'),
          startedAt,
          durationMs: number(row, 'durationMs', true),
          error: Number(row.error) === 1,
        };
      }),
      APM_LIMITS.spans,
    ),
  };
}
export type ApmInsights = Awaited<ReturnType<typeof loadApmInsights>>;

export async function discoverApmDatasets(
  client: Pick<ParseableClient, 'listDatasets' | 'datasetInfo' | 'schema'>,
  signal?: AbortSignal,
) {
  const datasets = await client.listDatasets(signal);
  const found: DatasetInfo[] = [],
    unchecked: string[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, datasets.length) }, async () => {
      while (next < datasets.length) {
        signal?.throwIfAborted();
        const dataset = datasets[next++];
        try {
          const info = await client.datasetInfo(dataset.name, signal);
          // Native trace handoff requires OTLP source metadata, not list type.
          if (info.logSourceFormats.includes('otel-traces')) found.push(info);
        } catch (error) {
          if (
            signal?.aborted ||
            (error instanceof Error && error.name === 'AbortError') ||
            (error instanceof ApiError && error.status === 401)
          )
            throw error;
          if (!(error instanceof ApiError && (error.status === 403 || error.status === 404)))
            unchecked.push(dataset.name);
        }
      }
    }),
  );
  return {
    datasets: found.sort((a, b) => a.name.localeCompare(b.name)),
    unchecked: unchecked.sort(),
  };
}
export function apmServicePath(dataset: string, service?: string) {
  return `/apm/${encodeURIComponent(dataset)}${service ? `/${encodeURIComponent(service)}` : ''}`;
}
export function apmTracePath(
  dataset: string,
  service: string,
  bounds: ApmBounds,
  traceId?: string,
) {
  return `/traces/explore/${encodeURIComponent(dataset)}?${new URLSearchParams({ service, start: bounds.startTime, end: bounds.endTime, ...(traceId ? { traceId } : {}) })}`;
}

export function inspectApmSchema(fields: string[], timeColumn = 'p_timestamp'): ApmSchema {
  const required = [
    timeColumn,
    'service.name',
    'span_trace_id',
    'span_span_id',
    'span_name',
    'span_duration_ns',
    'span_start_time_unix_nano',
  ];
  const missing = required.filter((field) => !fields.includes(field));
  if (missing.length)
    throw new Error(
      `This dataset does not have the required OTLP span fields: ${missing.join(', ')}`,
    );
  return {
    status: fields.includes('span_status_code'),
    parent: fields.includes('span_parent_span_id'),
    timeColumn,
  };
}

/** The server rounds envelope timestamps down to minutes. Expand the envelope,
 * then SQL enforces the precise captured ingestion-time range. */
export function apmTransportBounds(bounds: ApmBounds): ApmBounds {
  const normalized = timeBounds(bounds);
  return {
    startTime: new Date(Math.floor(Date.parse(normalized.startTime) / 60000) * 60000).toISOString(),
    endTime: new Date(
      (Math.floor(Date.parse(normalized.endTime) / 60000) + 1) * 60000,
    ).toISOString(),
  };
}

/** React Router decodes encoded slashes in params after decodePath, so recover
 * dataset/service from raw segments and decode exactly once. */
export function resolveApmRoute(pathname: string): {
  dataset?: string;
  service?: string;
} {
  const segments = pathname.split('/');
  const decode = (value: string | undefined) => {
    if (!value) return undefined;
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };
  return { dataset: decode(segments[2]), service: decode(segments[3]) };
}
export function apmRangeFromParams(params: URLSearchParams): TimeRange {
  const preset = params.get('range');
  if (preset) {
    try {
      const validated = timeBounds(preset as TimeRange);
      if (params.get('start') && params.get('end')) {
        const absolute = paramsRange(params);
        if (typeof absolute !== 'string') {
          const expectedDuration = Date.parse(validated.endTime) - Date.parse(validated.startTime);
          const actualDuration = Date.parse(absolute.endTime) - Date.parse(absolute.startTime);
          if (Math.abs(expectedDuration - actualDuration) > 1) return absolute;
        }
      }
      return preset as TimeRange;
    } catch {
      /* fall back to bounds */
    }
  }
  return paramsRange(params);
}
export function apmBoundsFromParams(params: URLSearchParams, now = Date.now()): ApmBounds {
  return timeBounds(
    params.get('start') && params.get('end') ? paramsRange(params) : apmRangeFromParams(params),
    now,
  );
}
export function formatApmRate(value: number): string {
  return value > 0 && value < 0.01
    ? '<0.01'
    : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
