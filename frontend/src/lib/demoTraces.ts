import { ApiError } from './apiError';
import { parseEventTimestamp } from '../components/explorer/timestamp';
import { alertDuration } from '../features/alerts/helpers';
import type {
  LogRecord,
  LogContextConditions,
  ParseableClient,
  TraceDetailResponse,
  TraceListRecord,
  TraceListRequest,
  TraceListResponse,
} from './types';

/** Flattened OTLP fixtures include repeated spans for events, matching the server. */
export function createDemoTraceRecords(now = Date.now()): LogRecord[] {
  const rows: LogRecord[] = [];
  for (let trace = 0; trace < 12; trace++) {
    const traceId = (trace + 1).toString(16).padStart(32, '0');
    const start = now - 60_000 - trace * 45_000;
    const rootId = (trace * 3 + 1).toString(16).padStart(16, '0');
    for (let span = 0; span < 3; span++) {
      const spanId = (trace * 3 + span + 1).toString(16).padStart(16, '0');
      const spanStart = start + span * 12;
      const duration = span === 0 ? 180 + trace * 8 : 35 + trace * 3 + span * 7;
      const error = trace % 4 === 0 && span === 1;
      const row: LogRecord = {
        'service.name': ['api-gateway', 'checkout', 'inventory'][span],
        span_name: ['POST /orders', 'create-order', 'reserve-stock'][span],
        span_trace_id: traceId,
        span_span_id: spanId,
        span_parent_span_id: span === 0 ? '' : rootId,
        span_start_time_unix_nano: new Date(spanStart).toISOString(),
        span_start_time_unix_nano_epoch: spanStart * 1_000_000,
        span_end_time_unix_nano: new Date(spanStart + duration).toISOString(),
        span_end_time_unix_nano_epoch: (spanStart + duration) * 1_000_000,
        span_duration_ns: duration * 1_000_000,
        span_status_code: error ? 2 : 1,
        span_status_description: error ? 'Error' : 'Ok',
        span_status_message: error ? 'Payment provider timed out' : '',
        span_kind: span === 0 ? 2 : 1,
        span_kind_description: span === 0 ? 'Server' : 'Internal',
        p_timestamp: new Date(spanStart).toISOString(),
        'http.request.method': 'POST',
        'http.response.status_code': error ? 504 : 200,
        'deployment.environment.name': 'demo',
        event_name: null,
      };
      rows.push(row);
      if (span === 1)
        rows.push({
          ...row,
          event_name: error ? 'exception' : 'order.validated',
          event_time_unix_nano: new Date(spanStart + 8).toISOString(),
          event_duration_ns: 8_000_000,
          event_message: error ? 'Upstream timeout' : 'Order validated',
        });
    }
  }
  return rows;
}

function bounds(startTime: string, endTime: string, now = Date.now()): [number, number] {
  const duration = alertDuration(startTime);
  const relative = /^now\s*-\s*(\d+(?:\.\d+)?)\s*(s|m|h|d)$/.exec(startTime);
  const units: Record<string, number> = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  const start =
    duration !== undefined
      ? now - duration * 1000
      : relative
        ? now - Number(relative[1]) * units[relative[2]]
        : parseEventTimestamp(startTime);
  const end = endTime === 'now' ? now : parseEventTimestamp(endTime);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end)
    throw new ApiError('Invalid trace time range', 400);
  return [start, end];
}
export function demoTraceRows(
  startTime: string,
  endTime: string,
  rows = createDemoTraceRecords(),
): LogRecord[] {
  const [start, end] = bounds(startTime, endTime);
  return structuredClone(
    rows.filter((row) => {
      const at = parseEventTimestamp(row.p_timestamp);
      return at >= start && at < end;
    }),
  );
}

function matches(row: LogRecord, conditions: LogContextConditions): boolean {
  const tests = (conditions.conditionConfig ?? []).map((condition) => {
    const value = row[condition.column];
    const wanted = condition.value;
    switch (condition.operator) {
      case 'is null':
        return value == null;
      case 'is not null':
        return value != null;
      case '=':
        return value != null && String(value) === wanted;
      case '!=':
        return value != null && String(value) !== wanted;
      case '>':
        return value != null && Number(value) > Number(wanted);
      case '<':
        return value != null && Number(value) < Number(wanted);
      case '>=':
        return value != null && Number(value) >= Number(wanted);
      case '<=':
        return value != null && Number(value) <= Number(wanted);
      default:
        throw new ApiError(
          'Demo traces support comparison and null filters. Connect to a server for other filters.',
          400,
        );
    }
  });
  tests.push(...(conditions.groups ?? []).map((group) => matches(row, group)));
  if (!tests.length)
    throw new ApiError('conditions must have at least one condition or group', 400);
  return conditions.operator === 'or' ? tests.some(Boolean) : tests.every(Boolean);
}

export function demoTraceList(request: TraceListRequest, rows: LogRecord[]): TraceListResponse {
  const limit = request.limit ?? 500,
    offset = request.offset ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
    throw new ApiError('limit must be between 1 and 1000', 400);
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new ApiError('offset must be a nonnegative integer', 400);
  if (request.serviceName !== undefined && !request.serviceName.trim())
    throw new ApiError('serviceName must not be empty when provided', 400);
  if (request.options !== undefined && !['traces', 'spans', 'errorSpans'].includes(request.options))
    throw new ApiError('Invalid trace list option', 400);
  if (request.conditions?.conditions) matches({}, request.conditions.conditions);
  const source = demoTraceRows(request.startTime, request.endTime, rows).filter(
    (row) =>
      (request.serviceName === undefined || row['service.name'] === request.serviceName.trim()) &&
      (!request.conditions?.conditions || matches(row, request.conditions.conditions)),
  );
  const spans = [...new Map(source.map((row) => [String(row.span_span_id), row])).values()];
  const selected = spans.filter((row) =>
    request.options === 'traces'
      ? !row.span_parent_span_id
      : request.options === 'errorSpans'
        ? row.span_status_code === 2
        : true,
  );
  const records: TraceListRecord[] = selected.map((row) => {
    const trace = spans.filter((other) => other.span_trace_id === row.span_trace_id);
    return {
      'service.name': String(row['service.name']),
      span_name: String(row.span_name),
      span_duration_ns: Number(row.span_duration_ns),
      span_trace_id: String(row.span_trace_id),
      span_span_id: String(row.span_span_id),
      span_start_time_unix_nano: String(row.span_start_time_unix_nano),
      span_start_time_unix_nano_epoch: Number(row.span_start_time_unix_nano_epoch),
      p_timestamp: String(row.p_timestamp),
      total_span_count: trace.length,
      error_count: trace.filter((other) => other.span_status_code === 2).length,
    };
  });
  const sorts = {
    mostRecent: ['span_start_time_unix_nano_epoch', -1],
    leastRecent: ['span_start_time_unix_nano_epoch', 1],
    longestFirst: ['span_duration_ns', -1],
    shortestFirst: ['span_duration_ns', 1],
    mostSpans: ['total_span_count', -1],
    leastSpans: ['total_span_count', 1],
  } as const;
  const sort = sorts[request.sortBy ?? 'mostRecent'];
  if (!sort) throw new ApiError('Invalid trace sort', 400);
  records.sort(
    (a, b) =>
      (Number(a[sort[0]]) - Number(b[sort[0]])) * sort[1] ||
      b.span_start_time_unix_nano_epoch - a.span_start_time_unix_nano_epoch ||
      a.span_span_id.localeCompare(b.span_span_id),
  );
  return { count: records.length, limit, offset, records: records.slice(offset, offset + limit) };
}

export function createDemoTraceMethods(
  rows: LogRecord[],
  listDatasets: ParseableClient['listDatasets'],
  datasetInfo?: ParseableClient['datasetInfo'],
): Pick<ParseableClient, 'listTraces' | 'traceDetail'> {
  async function dataset(name: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const item = (await listDatasets(signal)).find((item) => item.name === name);
    if (!item) throw new ApiError(`Stream not found: ${name}`, 404);
    if (item.type !== 'traces')
      throw new ApiError(`Dataset '${name}' must have log source 'otel-traces'`, 400);
    if (datasetInfo && !(await datasetInfo(name, signal)).logSourceFormats.includes('otel-traces'))
      throw new ApiError(`Dataset '${name}' must have log source 'otel-traces'`, 400);
    return name === 'demo_traces' ? rows : [];
  }
  return {
    async listTraces(request, signal) {
      return demoTraceList(request, await dataset(request.dataset, signal));
    },
    async traceDetail(request, signal): Promise<TraceDetailResponse> {
      const source = await dataset(request.dataset, signal);
      if (!request.traceId.trim()) throw new ApiError('traceId is required', 400);
      const discovery = demoTraceRows(request.startTime, request.endTime, source).filter(
        (row) => row.span_trace_id === request.traceId.trim(),
      );
      if (!discovery.length) throw new ApiError(`Trace not found: ${request.traceId}`, 404);
      const grouped = new Map<string, LogRecord[]>();
      for (const row of discovery) {
        const key = String(row.span_span_id);
        grouped.set(key, [...(grouped.get(key) ?? []), row]);
      }
      const times = discovery.map((row) => parseEventTimestamp(row.p_timestamp));
      const records = [...grouped.values()]
        .map((group) => {
          const row = group[0];
          return {
            'service.name': String(row['service.name']),
            span_name: String(row.span_name),
            span_duration_ns: Number(row.span_duration_ns),
            span_trace_id: String(row.span_trace_id),
            span_span_id: String(row.span_span_id),
            span_parent_span_id: String(row.span_parent_span_id),
            span_start_time_unix_nano: String(row.span_start_time_unix_nano),
            span_start_time_unix_nano_epoch: Number(row.span_start_time_unix_nano_epoch),
            total_span_count: grouped.size,
            has_error: group.some((item) => item.span_status_code === 2),
            level: row.span_parent_span_id ? 1 : 0,
            event_count: group.filter((item) => item.event_name != null).length,
          };
        })
        .sort(
          (a, b) =>
            a.level - b.level ||
            a.span_start_time_unix_nano_epoch - b.span_start_time_unix_nano_epoch,
        );
      return {
        startTime: new Date(Math.min(...times)).toISOString(),
        endTime: new Date(Math.max(...times)).toISOString(),
        records,
      };
    },
  };
}
