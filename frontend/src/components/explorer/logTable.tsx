import { Badge } from '../ui';
import type { LogRecord } from '../../lib/types';
import { formatTimestamp } from './timezone';

export type LogTableSort = { field: string; descending: boolean };
export function formatValue(value: unknown): string {
  if (value == null) return '—';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}
export function orderLogRows(rows: LogRecord[], sort?: LogTableSort): LogRecord[] {
  if (!sort) return rows;
  return [...rows].sort((a, b) => {
    const left = a[sort.field],
      right = b[sort.field];
    const result =
      typeof left === 'number' && typeof right === 'number'
        ? left - right
        : formatValue(left).localeCompare(formatValue(right), undefined, { numeric: true });
    return sort.descending ? -result : result;
  });
}
export function columnLabel(
  field: string | null,
  timestampField: string,
  timezone: string,
  summary: boolean,
): string {
  if (field === null) return 'Data';
  return field === timestampField
    ? `${summary && timestampField === 'p_timestamp' ? 'Ingestion Time' : 'Timestamp'} (${timezone})`
    : field;
}
export function cellClassName(field: string | null): string {
  return field === 'message' ? 'message-cell' : field === null ? 'mono log-data-cell' : 'mono';
}
export function cellText(
  row: LogRecord,
  field: string | null,
  fields: string[],
  timestampField: string,
  timezone: string,
): string {
  if (field === null)
    return Object.entries(row)
      .filter(([key]) => !fields.includes(key))
      .map(([key, value]) => `${key}=${formatValue(value)}`)
      .join(' ');
  return field === timestampField ? formatTimestamp(row[field], timezone) : formatValue(row[field]);
}
export function LogCellContent({
  row,
  field,
  fields,
  timestampField,
  timezone,
}: {
  row: LogRecord;
  field: string | null;
  fields: string[];
  timestampField: string;
  timezone: string;
}) {
  if (field === null)
    return (
      <>
        {Object.entries(row)
          .filter(([key]) => !fields.includes(key))
          .map(([key, value]) => (
            <span className="log-data-pair" key={key}>
              <span className="log-data-key">{key}</span>=<span>{formatValue(value)}</span>{' '}
            </span>
          ))}
      </>
    );
  if (field === 'level') {
    const level = String(row[field]).toLowerCase();
    return (
      <Badge tone={level === 'error' ? 'danger' : level === 'warn' ? 'warning' : 'success'}>
        {formatValue(row[field])}
      </Badge>
    );
  }
  return <>{cellText(row, field, fields, timestampField, timezone)}</>;
}
