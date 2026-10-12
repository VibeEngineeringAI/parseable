import { isValidTimezone } from '../../components/explorer/timezone';
import type { LogFilter, TimeRange } from '../../lib/types';
import type { LogFilterExpression } from '../../lib/logQuery';

export type LogViewState = {
  version: 1;
  dataset: string;
  range: TimeRange;
  search: string;
  expression: LogFilterExpression;
  columns?: string[];
  timezone: string;
  limit: number;
  wrap: boolean;
  showHistogram: boolean;
};

const MAX_STATE_LENGTH = 65536;
const presets = new Set(['10m', '15m', '30m', '1h', '5h', '6h', '1d', '24h', '3d', '7d']);
function validInstant(value: string): boolean {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const [, year, month, day, hour, minute, second, , offsetHour, offsetMinute] = match;
  const date = new Date(0);
  date.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  return (
    date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() === Number(month) - 1 &&
    date.getUTCDate() === Number(day) &&
    Number(hour) < 24 &&
    Number(minute) < 60 &&
    Number(second) < 60 &&
    (!offsetHour || (Number(offsetHour) < 24 && Number(offsetMinute) < 60))
  );
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid log view: expected an object.');
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string, max = 8192, nonempty = false): string {
  if (
    typeof value !== 'string' ||
    value.includes('\0') ||
    value.length > max ||
    (nonempty && !value.trim())
  )
    throw new Error(`Invalid log view: ${label}.`);
  return value;
}
function combinator(value: unknown): 'and' | 'or' {
  if (value !== 'and' && value !== 'or') throw new Error('Invalid log view: filter combinator.');
  return value;
}
export function validateLogView(value: unknown): LogViewState {
  const raw = object(value);
  if (raw.version !== 1) throw new Error('Unsupported log view version.');
  const dataset = text(raw.dataset, 'dataset', 512, true);
  let range: TimeRange;
  if (typeof raw.range === 'string' && presets.has(raw.range)) range = raw.range as TimeRange;
  else {
    const bounds = object(raw.range);
    const startTime = text(bounds.startTime, 'start time', 64, true);
    const endTime = text(bounds.endTime, 'end time', 64, true);
    if (
      !validInstant(startTime) ||
      !validInstant(endTime) ||
      Date.parse(startTime) >= Date.parse(endTime)
    )
      throw new Error('Invalid log view: absolute time bounds must be ordered instants.');
    range = { startTime, endTime };
  }
  const timezone = text(raw.timezone, 'timezone', 128, true);
  if (timezone === 'local' || !isValidTimezone(timezone))
    throw new Error('Invalid log view: timezone.');
  if (!Number.isInteger(raw.limit) || (raw.limit as number) < 1 || (raw.limit as number) > 10000)
    throw new Error('Invalid log view: result limit must be between 1 and 10000.');
  if (typeof raw.wrap !== 'boolean' || typeof raw.showHistogram !== 'boolean')
    throw new Error('Invalid log view: display settings.');
  const expressionRaw = object(raw.expression);
  if (!Array.isArray(expressionRaw.groups) || expressionRaw.groups.length > 12)
    throw new Error('Invalid log view: filter groups.');
  let ruleCount = 0;
  const groupIds = new Set<string>();
  const ruleIds = new Set<string>();
  const groups = expressionRaw.groups.map((value) => {
    const group = object(value);
    const id = text(group.id, 'group identifier', 128, true);
    if (groupIds.has(id)) throw new Error('Invalid log view: duplicate group identifier.');
    groupIds.add(id);
    if (!Array.isArray(group.rules) || (ruleCount += group.rules.length) > 50)
      throw new Error('Invalid log view: too many filter rules.');
    return {
      id,
      combinator: combinator(group.combinator),
      rules: group.rules.map((value): LogFilter => {
        const rule = object(value);
        const id = text(rule.id, 'rule identifier', 128, true);
        if (ruleIds.has(id)) throw new Error('Invalid log view: duplicate rule identifier.');
        ruleIds.add(id);
        if (rule.operator !== '=' && rule.operator !== '!=')
          throw new Error('Invalid log view: filter operator.');
        return {
          id,
          field: text(rule.field, 'filter field', 512, true),
          operator: rule.operator,
          value: text(rule.value, 'filter value'),
        };
      }),
    };
  });
  let columns: string[] | undefined;
  if (raw.columns !== undefined) {
    if (!Array.isArray(raw.columns) || raw.columns.length > 500)
      throw new Error('Invalid log view: selected columns.');
    columns = [...new Set(raw.columns.map((value) => text(value, 'column', 512, true)))];
  }
  return {
    version: 1,
    dataset,
    range,
    search: text(raw.search, 'search'),
    expression: { combinator: combinator(expressionRaw.combinator), groups },
    ...(columns !== undefined ? { columns } : {}),
    timezone,
    limit: raw.limit as number,
    wrap: raw.wrap,
    showHistogram: raw.showHistogram,
  };
}
export function encodeLogView(state: LogViewState): string {
  const encoded = JSON.stringify(validateLogView(state));
  if (encoded.length > MAX_STATE_LENGTH) throw new Error('Log view is too large to share.');
  return encoded;
}
export function decodeLogView(raw: string): LogViewState {
  if (raw.length > MAX_STATE_LENGTH) throw new Error('Log view is too large to open.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Invalid log view: malformed JSON.');
  }
  return validateLogView(parsed);
}
