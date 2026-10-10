import type { LogFilter, TimeRange } from './types';

const durations: Record<Extract<TimeRange, string>, number> = {
  '10m': 10 * 60_000,
  '15m': 15 * 60_000,
  '30m': 30 * 60_000,
  '1h': 60 * 60_000,
  '5h': 5 * 60 * 60_000,
  '6h': 6 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
  '24h': 24 * 60 * 60_000,
  '3d': 3 * 24 * 60 * 60_000,
  '7d': 7 * 24 * 60 * 60_000,
};

export function timeBounds(range: TimeRange, now: Date | number = Date.now()) {
  if (typeof range === 'object' && range !== null) {
    const start = Date.parse(range.startTime);
    const end = Date.parse(range.endTime);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end)
      throw new Error('Invalid time range');
    return { startTime: new Date(start).toISOString(), endTime: new Date(end).toISOString() };
  }
  const end = Number(now);
  if (!Number.isFinite(end) || !(range in durations)) throw new Error('Invalid time range');
  return {
    startTime: new Date(end - durations[range]).toISOString(),
    endTime: new Date(end).toISOString(),
  };
}

export function quoteIdentifier(value: string): string {
  if (!value || value.includes('\0'))
    throw new Error('A field or dataset name must be nonempty and contain no null characters');
  return `"${value.replaceAll('"', '""')}"`;
}

export function quoteLiteral(value: string): string {
  if (value.includes('\0')) throw new Error('Filter values cannot contain null characters');
  return `'${value.replaceAll("'", "''")}'`;
}

/** Search is a literal case-insensitive substring of the message field. */
export function buildLogQuery(
  dataset: string,
  search: string,
  filters: LogFilter[],
  limit = 100,
): string {
  if (!Number.isInteger(limit) || limit < 1 || limit > 10_000)
    throw new Error('Limit must be between 1 and 10000');
  const conditions = filters.map(({ field, operator, value }) => {
    if (operator !== '=' && operator !== '!=') throw new Error('Unsupported filter operator');
    return `${quoteIdentifier(field)} ${operator} ${quoteLiteral(value)}`;
  });
  if (search.trim()) {
    const pattern = `%${search.trim().replaceAll('!', '!!').replaceAll('%', '!%').replaceAll('_', '!_')}%`;
    conditions.push(`CAST("message" AS VARCHAR) ILIKE ${quoteLiteral(pattern)} ESCAPE '!'`);
  }
  return `SELECT * FROM ${quoteIdentifier(dataset)}${conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''} ORDER BY "p_timestamp" DESC LIMIT ${limit}`;
}
