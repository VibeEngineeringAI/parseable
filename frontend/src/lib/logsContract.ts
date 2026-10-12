export type {
  SavedLogView,
  SavedLogViewBuilder,
  SavedLogViewRule,
  LogContextRequest,
  LogContextResponse,
  LogContextQueryPayload,
  LogContextConditions,
} from './types';
import { object } from './guards';
import type { LogContextQueryPayload, LogContextResponse, SavedLogView } from './types';

const optionalString = (value: unknown) => value == null || typeof value === 'string';
function builder(value: unknown): boolean {
  return (
    object(value) &&
    typeof value.id === 'string' &&
    typeof value.combinator === 'string' &&
    Array.isArray(value.rules) &&
    value.rules.every(
      (group) =>
        object(group) &&
        typeof group.id === 'string' &&
        typeof group.combinator === 'string' &&
        Array.isArray(group.rules) &&
        group.rules.every(
          (rule) =>
            object(rule) &&
            ['id', 'field', 'value', 'operator'].every((key) => typeof rule[key] === 'string'),
        ),
    )
  );
}
export function savedLogView(value: unknown): value is SavedLogView {
  return (
    object(value) &&
    typeof value.filter_name === 'string' &&
    typeof value.stream_name === 'string' &&
    ['filter_id', 'version', 'user_id', 'tenant_id'].every((key) => optionalString(value[key])) &&
    optionalString(value.explorer_state) &&
    object(value.query) &&
    typeof value.query.filter_type === 'string' &&
    ['filter', 'sql', 'search'].includes(value.query.filter_type) &&
    optionalString(value.query.filter_query) &&
    (value.query.filter_builder == null || builder(value.query.filter_builder)) &&
    (value.time_filter == null ||
      (object(value.time_filter) &&
        typeof value.time_filter.from === 'string' &&
        typeof value.time_filter.to === 'string'))
  );
}
const time = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)?$/.test(value) &&
  Number.isFinite(Date.parse(value));
const uint = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
export function logContextQueryPayload(value: unknown): value is LogContextQueryPayload {
  return (
    object(value) &&
    typeof value.query === 'string' &&
    value.query.trim().length > 0 &&
    time(value.startTime) &&
    time(value.endTime) &&
    Date.parse(value.startTime) < Date.parse(value.endTime) &&
    typeof value.sendNull === 'boolean' &&
    typeof value.reverseRecords === 'boolean'
  );
}
export function logContextResponse(value: unknown): value is LogContextResponse {
  return (
    object(value) &&
    value.scope === 'contextWindow' &&
    time(value.contextStartTime) &&
    time(value.contextEndTime) &&
    Date.parse(value.contextStartTime) < Date.parse(value.contextEndTime) &&
    uint(value.limit) &&
    value.limit > 0 &&
    value.limit <= 500 &&
    uint(value.anchorIndex) &&
    uint(value.duplicateAnchorCount) &&
    value.duplicateAnchorCount > 0 &&
    value.anchoredDuplicate === 'first' &&
    Array.isArray(value.records) &&
    value.records.every((record) => object(record) && time(record.p_timestamp)) &&
    value.records.length > 0 &&
    value.records.length <= value.limit &&
    value.anchorIndex < value.records.length &&
    object(value.queries) &&
    (value.queries.previous === null || logContextQueryPayload(value.queries.previous)) &&
    (value.queries.next === null || logContextQueryPayload(value.queries.next))
  );
}
