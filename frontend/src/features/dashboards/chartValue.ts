import type { DashboardTile, LogRecord } from '../../lib/types';
import { record, text } from './tiles';

/** Stable query-value rule: configured y field, otherwise first numeric column
 * of the last row. PromQL uses Value so a matrix's Samples never becomes the stat. */
export function chartValue(
  rows: LogRecord[],
  tile: DashboardTile,
  promql = false,
): number | undefined {
  const row = rows.at(-1);
  if (!row) return;
  const field = record(record(tile.config).axes).y;
  const configured = record(field).field;
  const name = Array.isArray(configured) ? text(configured[0]) : text(configured);
  const numeric = (value: unknown) =>
    typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')
      ? Number(value)
      : NaN;
  const value = name
    ? numeric(row[name])
    : promql
      ? numeric(row.Value)
      : Object.values(row).map(numeric).find(Number.isFinite);
  return Number.isFinite(value) ? value : undefined;
}
