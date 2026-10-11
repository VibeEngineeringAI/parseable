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

export const fillStyles = ['horizontal', 'vertical', 'diagonal', 'none'] as const;
export type FillStyle = (typeof fillStyles)[number];
export const fillStyle = (tile: DashboardTile): FillStyle => {
  const style = record(record(tile.config).layout).percentFill;
  return fillStyles.find((known) => known === style) ?? 'horizontal';
};

/** Percent query values fill their tile to their share of 0–100 unless the fill is turned off;
 * other units do not fill. */
export function percentFill(value: number, tile: DashboardTile): number | undefined {
  const unit = text(record(record(tile.config).layout).unit)
    .trim()
    .toLowerCase();
  return (unit === '%' || unit === 'percent') && fillStyle(tile) !== 'none'
    ? Math.max(0, Math.min(100, value))
    : undefined;
}

/** Clip path for a fill that sweeps from the top-left corner. Its edge is the line
 * x/width + y/height = t, placed so the covered area is exactly `percent` of the tile. */
export function diagonalFill(percent: number): string {
  const share = Math.max(0, Math.min(100, percent)) / 100;
  const t = share <= 0.5 ? Math.sqrt(2 * share) : 2 - Math.sqrt(2 * (1 - share));
  const points =
    t <= 1
      ? [
          [0, 0],
          [t, 0],
          [0, t],
        ]
      : [
          [0, 0],
          [1, 0],
          [1, t - 1],
          [t - 1, 1],
          [0, 1],
        ];
  const at = (value: number) => `${Number((value * 100).toFixed(2))}%`;
  return `polygon(${points.map(([x, y]) => `${at(x)} ${at(y)}`).join(', ')})`;
}
