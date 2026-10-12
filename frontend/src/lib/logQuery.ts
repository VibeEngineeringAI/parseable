import { quoteIdentifier, quoteLiteral, timeBounds } from './query';
import { parseEventTimestamp } from '../components/explorer/timestamp';
import type { LogFilter, LogRecord } from './types';
export type LogFilterGroup = { id: string; combinator: 'and' | 'or'; rules: LogFilter[] };
export type LogFilterExpression = { combinator: 'and' | 'or'; groups: LogFilterGroup[] };
type Bounds = { startTime: string; endTime: string };
function join(parts: string[], combinator: 'and' | 'or'): string {
  if (combinator !== 'and' && combinator !== 'or') throw new Error('Unsupported filter combinator');
  return parts.length ? `(${parts.join(` ${combinator.toUpperCase()} `)})` : '';
}
function where(
  search: string,
  expression: LogFilterExpression,
  bounds?: Bounds,
  timestampField = 'p_timestamp',
): string {
  if (
    expression.groups.length > 12 ||
    expression.groups.reduce((n, group) => n + group.rules.length, 0) > 50
  )
    throw new Error('Too many filter groups or rules');
  const grouped = join(
    expression.groups
      .map((group) =>
        join(
          group.rules.map((rule) => {
            if (rule.operator !== '=' && rule.operator !== '!=')
              throw new Error('Unsupported filter operator');
            return `${quoteIdentifier(rule.field)} ${rule.operator} ${quoteLiteral(rule.value)}`;
          }),
          group.combinator,
        ),
      )
      .filter(Boolean),
    expression.combinator,
  );
  const conditions = grouped ? [grouped] : [];
  if (search.trim()) {
    const pattern = `%${search.trim().replaceAll('!', '!!').replaceAll('%', '!%').replaceAll('_', '!_')}%`;
    conditions.push(`CAST("message" AS VARCHAR) ILIKE ${quoteLiteral(pattern)} ESCAPE '!'`);
  }
  if (bounds) {
    const normalized = timeBounds(bounds),
      field = quoteIdentifier(timestampField);
    conditions.push(
      `${field} >= TIMESTAMP ${quoteLiteral(normalized.startTime)}`,
      `${field} < TIMESTAMP ${quoteLiteral(normalized.endTime)}`,
    );
  }
  return conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
}
export function buildExplorerQuery(
  dataset: string,
  search: string,
  expression: LogFilterExpression,
  limit = 1000,
  timestampField = 'p_timestamp',
  bounds?: Bounds,
): string {
  if (!Number.isInteger(limit) || limit < 1 || limit > 10000)
    throw new Error('Limit must be between 1 and 10000');
  return `SELECT * FROM ${quoteIdentifier(dataset)}${where(search, expression, bounds, timestampField)} ORDER BY ${quoteIdentifier(timestampField)} DESC LIMIT ${limit}`;
}
function histogramGeometry(bounds: Bounds) {
  const normalized = timeBounds(bounds);
  const start = Date.parse(normalized.startTime),
    end = Date.parse(normalized.endTime);
  return { ...normalized, start, end, interval: Math.ceil((end - start) / 48) };
}
export function buildHistogramQuery(
  dataset: string,
  search: string,
  expression: LogFilterExpression,
  bounds: Bounds,
  timestampField = 'p_timestamp',
): string {
  const geometry = histogramGeometry(bounds);
  return `SELECT DATE_BIN(INTERVAL '${geometry.interval} milliseconds', ${quoteIdentifier(timestampField)}, TIMESTAMP '${geometry.startTime}') AS "bucket_start", COUNT(*) AS "count" FROM ${quoteIdentifier(dataset)}${where(search, expression, bounds, timestampField)} GROUP BY "bucket_start" ORDER BY "bucket_start" ASC`;
}
export function histogramBuckets(
  rows: LogRecord[],
  bounds: Bounds,
): { bins: number[]; total: number } {
  const { start, end, interval } = histogramGeometry(bounds);
  const bins = Array<number>(48).fill(0);
  for (const row of rows) {
    const timestamp = parseEventTimestamp(row.bucket_start);
    const count = row.count;
    const index = Math.floor((timestamp - start) / interval);
    if (
      !Number.isFinite(timestamp) ||
      timestamp < start ||
      timestamp >= end ||
      (timestamp - start) % interval !== 0 ||
      index >= 48 ||
      typeof count !== 'number' ||
      !Number.isSafeInteger(count) ||
      count < 0
    )
      throw new Error('Invalid histogram response');
    bins[index] += count;
    if (!Number.isSafeInteger(bins[index])) throw new Error('Invalid histogram response');
  }
  const total = bins.reduce((sum, count) => sum + count, 0);
  if (!Number.isSafeInteger(total)) throw new Error('Invalid histogram response');
  return { bins, total };
}
