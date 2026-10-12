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
import { ApiError } from './client';
import { createUlid } from './ids';
import type {
  LogContextQueryPayload,
  LogContextRequest,
  LogContextResponse,
  LogRecord,
  ParseableClient,
  SavedLogView,
} from './types';

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
const fail = (message: string): never => {
  throw new ApiError(message, 400);
};
function duration(raw: string): number {
  const units: Record<string, number> = {
    ms: 1,
    millisecond: 1,
    milliseconds: 1,
    s: 1000,
    sec: 1000,
    second: 1000,
    seconds: 1000,
    m: 60000,
    min: 60000,
    minute: 60000,
    minutes: 60000,
    h: 3600000,
    hour: 3600000,
    hours: 3600000,
    d: 86400000,
    day: 86400000,
    days: 86400000,
  };
  let total = 0,
    end = 0;
  for (const match of raw.matchAll(/(\d+(?:\.\d+)?)\s*([a-z]+)/g)) {
    if (raw.slice(end, match.index).trim() || !units[match[2]]) fail('Invalid contextWindow');
    total += Number(match[1]) * units[match[2]];
    end = match.index + match[0].length;
  }
  if (raw.slice(end).trim() || !Number.isFinite(total) || total <= 0)
    fail('contextWindow must be greater than 0 and use a supported duration');
  return total;
}
function parseTime(value: string, name: string, now: number): number {
  if (value === 'now' && name !== 'pTimestamp') return now;
  const relative = /^now\s*-\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/.exec(value);
  if (relative && name !== 'pTimestamp') return now - duration(`${relative[1]}${relative[2]}`);
  // Backend also accepts naive UTC timestamps.
  const normalized = /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:\.\d+)?$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  if (!time(normalized)) fail(`Invalid ${name}`);
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) fail(`Invalid ${name}`);
  return parsed;
}
/** Backend ordering is timestamp DESC / anchor field ASC; anchor is the first duplicate. */
export function demoLogContext(
  request: LogContextRequest,
  source: LogRecord[],
  now = Date.now(),
): LogContextResponse {
  if (
    request.conditions &&
    (request.conditions.conditionConfig?.length || request.conditions.groups?.length)
  )
    fail('Demo context does not support conditions. Connect to a server for filtered context.');
  const fields = (['log', 'body', 'message'] as const).filter(
    (field) => request[field] !== undefined,
  );
  if (fields.length !== 1) fail('Request must include exactly one of log, body, or message');
  const field = fields[0];
  if (!source.some((row) => typeof row[field] === 'string'))
    fail(`Context requires a supported string ${field} field`);
  const anchorTime = parseTime(request.pTimestamp, 'pTimestamp', now);
  let start: number, end: number;
  if (request.contextWindow !== undefined) {
    if (request.contextStartTime !== undefined || request.contextEndTime !== undefined)
      fail(
        'Request must include either contextWindow or contextStartTime/contextEndTime, not both',
      );
    const window = duration(request.contextWindow);
    start = Math.floor((anchorTime - window) / 60000) * 60000;
    end = Math.floor((anchorTime + window) / 60000) * 60000;
    if (start >= end) end = start + 60000;
  } else {
    if (request.contextStartTime === undefined || request.contextEndTime === undefined)
      fail('contextStartTime and contextEndTime must be provided together, or use contextWindow');
    start = parseTime(request.contextStartTime!, 'contextStartTime', now);
    end = parseTime(request.contextEndTime!, 'contextEndTime', now);
  }
  if (start >= end) fail('contextStartTime must be before contextEndTime');
  if (anchorTime < start || anchorTime >= end) fail('pTimestamp must be within the context bounds');
  const requestedLimit = request.pageSize ?? 500;
  if (!uint(requestedLimit) || requestedLimit === 0) fail('pageSize must be a positive integer');
  const limit = Math.min(500, requestedLimit);
  const timestamp = (row: LogRecord) => parseTime(String(row.p_timestamp), 'p_timestamp', now);
  const compare = (a: LogRecord, b: LogRecord) =>
    timestamp(b) - timestamp(a) ||
    (String(a[field]) < String(b[field]) ? -1 : String(a[field]) > String(b[field]) ? 1 : 0);
  const scoped = source
    .filter((row) => timestamp(row) >= start && timestamp(row) < end)
    .sort(compare);
  const anchorIndex = scoped.findIndex(
    (row) => timestamp(row) === anchorTime && row[field] === request[field],
  );
  if (anchorIndex < 0)
    fail('No log row matched the provided pTimestamp and log/body/message value');
  const duplicateAnchorCount = scoped.filter(
    (row) => timestamp(row) === anchorTime && row[field] === request[field],
  ).length;
  let newerTake = Math.min(anchorIndex, Math.floor(limit / 2));
  const olderTake = Math.min(scoped.length - anchorIndex, limit - newerTake);
  newerTake = Math.min(anchorIndex, newerTake + limit - newerTake - olderTake);
  const records = structuredClone(scoped.slice(anchorIndex - newerTake, anchorIndex + olderTake));
  const startTime = new Date(start).toISOString(),
    endTime = new Date(end).toISOString();
  const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
  const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const sqlTime = (value: number) =>
    `TIMESTAMP ${literal(new Date(value).toISOString().replace('T', ' ').replace('Z', ''))}`;
  const cursorQuery = (row: LogRecord, previous: boolean): LogContextQueryPayload => {
    const ts = sqlTime(timestamp(row)),
      column = identifier(field),
      value = literal(String(row[field]));
    const op = previous ? '>' : '<',
      tieOp = previous ? '<' : '>';
    return {
      query: `SELECT * FROM ${identifier(request.dataset)} WHERE ("p_timestamp" >= ${sqlTime(start)} AND "p_timestamp" < ${sqlTime(end)}) AND ("p_timestamp" ${op} ${ts} OR ("p_timestamp" = ${ts} AND ${column} ${tieOp} ${value})) ORDER BY "p_timestamp" ${previous ? 'ASC' : 'DESC'}, ${column} ${previous ? 'DESC' : 'ASC'} LIMIT ${limit} OFFSET 0`,
      startTime,
      endTime,
      sendNull: false,
      reverseRecords: previous,
    };
  };
  return {
    scope: 'contextWindow',
    contextStartTime: startTime,
    contextEndTime: endTime,
    limit,
    anchorIndex: newerTake,
    duplicateAnchorCount,
    anchoredDuplicate: 'first',
    records,
    queries: {
      previous: cursorQuery(records[0], true),
      next: cursorQuery(records[records.length - 1], false),
    },
  };
}
export function createDemoLogMethods(
  records: LogRecord[],
  listDatasets: ParseableClient['listDatasets'],
): Pick<
  ParseableClient,
  'listLogViews' | 'createLogView' | 'updateLogView' | 'deleteLogView' | 'logContext'
> {
  const views = new Map<string, SavedLogView>();
  const clone = <T>(value: T): T => structuredClone(value);
  const ready = async (signal?: AbortSignal) => {
    signal?.throwIfAborted();
    await Promise.resolve();
    signal?.throwIfAborted();
  };
  const validate = async (body: SavedLogView) => {
    if (!savedLogView(body)) fail('Invalid saved log view');
    if (!(await listDatasets()).some((dataset) => dataset.name === body.stream_name))
      fail('Stream not found');
  };
  const find = (id: string) => {
    if (!views.has(id)) fail('Filter does not exist or user is not authorized');
  };
  return {
    async listLogViews(signal) {
      await ready(signal);
      return clone([...views.values()]);
    },
    async createLogView(body) {
      await validate(body);
      const view = {
        ...clone(body),
        filter_id: createUlid(),
        version: 'v2',
        user_id: 'demo',
        tenant_id: null,
      };
      views.set(view.filter_id, view);
      return clone(view);
    },
    async updateLogView(id, body) {
      find(id);
      await validate(body);
      const view = {
        ...clone(body),
        filter_id: id,
        version: 'v2',
        user_id: 'demo',
        tenant_id: null,
      };
      views.set(id, view);
      return clone(view);
    },
    async deleteLogView(id) {
      find(id);
      views.delete(id);
    },
    async logContext(request, signal) {
      await ready(signal);
      if (
        !(await listDatasets(signal)).some(
          (dataset) => dataset.name === request.dataset && dataset.type === 'logs',
        )
      )
        fail('Context requires a sample log dataset');
      return demoLogContext(request, records);
    },
  };
}
