import { object } from './guards';
import { parseEventTimestamp } from '../components/explorer/timestamp';
import type {
  TraceDetailRecord,
  TraceDetailResponse,
  TraceListRecord,
  TraceListResponse,
  TraceSpanRecord,
} from './types';

const uint = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const nanos = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
export const traceTimestamp = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)?$/.test(value) &&
  Number.isFinite(parseEventTimestamp(value));
export function traceSpanRecord(value: unknown): value is TraceSpanRecord {
  return (
    object(value) &&
    ['service.name', 'span_name', 'span_trace_id', 'span_span_id'].every(
      (key) => typeof value[key] === 'string',
    ) &&
    traceTimestamp(value.span_start_time_unix_nano) &&
    nanos(value.span_start_time_unix_nano_epoch) &&
    nanos(value.span_duration_ns) &&
    uint(value.total_span_count)
  );
}
export function traceListRecord(value: unknown): value is TraceListRecord {
  return traceSpanRecord(value) && traceTimestamp(value.p_timestamp) && uint(value.error_count);
}
export function traceDetailRecord(value: unknown): value is TraceDetailRecord {
  return (
    traceSpanRecord(value) &&
    typeof value.span_parent_span_id === 'string' &&
    typeof value.has_error === 'boolean' &&
    uint(value.level) &&
    value.level <= 100 &&
    uint(value.event_count)
  );
}
export function traceListResponse(value: unknown): value is TraceListResponse {
  return (
    object(value) &&
    uint(value.count) &&
    uint(value.offset) &&
    uint(value.limit) &&
    value.limit >= 1 &&
    value.limit <= 1000 &&
    Array.isArray(value.records) &&
    value.records.length <= value.limit &&
    value.records.every(traceListRecord)
  );
}
export function traceDetailResponse(value: unknown): value is TraceDetailResponse {
  return (
    object(value) &&
    traceTimestamp(value.startTime) &&
    traceTimestamp(value.endTime) &&
    parseEventTimestamp(value.startTime) <= parseEventTimestamp(value.endTime) &&
    Array.isArray(value.records) &&
    value.records.every(traceDetailRecord)
  );
}

/** OTLP child spans may omit service.name; Arrow omits null-valued keys by default.
 * Normalize only that optional display field, then validate the entire wire response. */
export function decodeTraceDetail(value: unknown): TraceDetailResponse | undefined {
  if (!object(value) || !Array.isArray(value.records)) return;
  const normalized = {
    ...value,
    records: value.records.map((record: unknown) =>
      object(record) && record['service.name'] == null
        ? { ...record, 'service.name': '(unknown service)' }
        : record,
    ),
  };
  return traceDetailResponse(normalized) ? normalized : undefined;
}
