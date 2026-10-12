import { quoteIdentifier, quoteLiteral, timeBounds } from './query';
import { parseEventTimestamp } from '../components/explorer/timestamp';
import type { LogRecord } from './types';
import {
  MAX_FILTER_GROUPS,
  MAX_FILTER_RULES,
  MAX_LOG_ROWS,
  ruleCount,
  type LogFilterExpression,
} from './logFilters';
export type { LogFilterGroup, LogFilterExpression } from './logFilters';
export const HISTOGRAM_BUCKETS = 48;
export type LogCriteria = Readonly<{ source: string; predicate: string; timestamp: string }>;
export type HistogramAggregate = {
  bins: number[];
  total: number;
  start: number;
  end: number;
  interval: number;
};
type Bounds = { startTime: string; endTime: string };
function join(parts: string[], combinator: 'and' | 'or'): string {
  if (combinator !== 'and' && combinator !== 'or') throw new Error('Unsupported filter combinator');
  return parts.length ? `(${parts.join(` ${combinator.toUpperCase()} `)})` : '';
}
export function compileLogCriteria(
  dataset: string,
  search: string,
  expression: LogFilterExpression,
  timestampField = 'p_timestamp',
): LogCriteria {
  if (expression.groups.length > MAX_FILTER_GROUPS || ruleCount(expression) > MAX_FILTER_RULES)
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
  return {
    source: quoteIdentifier(dataset),
    predicate: conditions.join(' AND '),
    timestamp: quoteIdentifier(timestampField),
  };
}
function where(criteria: LogCriteria, bounds?: Bounds): string {
  const conditions = criteria.predicate ? [criteria.predicate] : [];
  if (bounds) {
    const normalized = timeBounds(bounds);
    conditions.push(
      `${criteria.timestamp} >= TIMESTAMP ${quoteLiteral(normalized.startTime)}`,
      `${criteria.timestamp} < TIMESTAMP ${quoteLiteral(normalized.endTime)}`,
    );
  }
  return conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
}
export function buildRowsFromCriteria(
  criteria: LogCriteria,
  limit: number,
  bounds?: Bounds,
): string {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LOG_ROWS)
    throw new Error(`Limit must be between 1 and ${MAX_LOG_ROWS}`);
  return `SELECT * FROM ${criteria.source}${where(criteria, bounds)} ORDER BY ${criteria.timestamp} DESC LIMIT ${limit}`;
}
export function buildExplorerQuery(
  dataset: string,
  search: string,
  expression: LogFilterExpression,
  limit = 1000,
  timestampField = 'p_timestamp',
  bounds?: Bounds,
): string {
  return buildRowsFromCriteria(
    compileLogCriteria(dataset, search, expression, timestampField),
    limit,
    bounds,
  );
}

function histogramGeometry(bounds: Bounds) {
  const normalized = timeBounds(bounds);
  const start = Date.parse(normalized.startTime),
    end = Date.parse(normalized.endTime);
  return { ...normalized, start, end, interval: Math.ceil((end - start) / HISTOGRAM_BUCKETS) };
}
export function buildHistogramQuery(
  dataset: string,
  search: string,
  expression: LogFilterExpression,
  bounds: Bounds,
  timestampField = 'p_timestamp',
): string {
  return buildHistogramFromCriteria(
    compileLogCriteria(dataset, search, expression, timestampField),
    bounds,
  );
}
export function buildHistogramFromCriteria(criteria: LogCriteria, bounds: Bounds): string {
  const geometry = histogramGeometry(bounds);
  return `SELECT DATE_BIN(INTERVAL '${geometry.interval} milliseconds', ${criteria.timestamp}, TIMESTAMP '${geometry.startTime}') AS "bucket_start", COUNT(*) AS "count" FROM ${criteria.source}${where(criteria, bounds)} GROUP BY "bucket_start" ORDER BY "bucket_start" ASC`;
}

export function histogramBuckets(rows: LogRecord[], bounds: Bounds): HistogramAggregate {
  const { start, end, interval } = histogramGeometry(bounds);
  const bins = Array<number>(HISTOGRAM_BUCKETS).fill(0);
  for (const row of rows) {
    const timestamp = parseEventTimestamp(row.bucket_start);
    const count = row.count;
    const index = Math.floor((timestamp - start) / interval);
    if (
      !Number.isFinite(timestamp) ||
      timestamp < start ||
      timestamp >= end ||
      (timestamp - start) % interval !== 0 ||
      index >= HISTOGRAM_BUCKETS ||
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
  return { bins, total, start, end, interval };
}
