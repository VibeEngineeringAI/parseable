/** Missing, empty or nonexistent bindings use columns in first appearance order:
 * x is the first timestamp or numeric column; y is the first numeric column other than x;
 * size is the first numeric column after y, excluding x and y, otherwise radius is 11.
 * Only the first y/groupBy array entry is read; an absent group field leaves one group. */
import type { DashboardTile, LogRecord } from '../../lib/types';
import { fieldList } from './chartPicker';
import { paletteColour, tilePalette } from './palettes';
import { groupValue, record, timeValue } from './tiles';

export type BubblePoint = {
  x: number;
  y: number;
  size?: number;
  radius: number;
  groupId: string;
};
export type BubbleGroup = { id: string; label: string; colour: string };
export type BubbleChartData = {
  points: BubblePoint[];
  groups: BubbleGroup[];
  xIsTime: boolean;
  xField: string;
  yField: string;
  sizeField?: string;
  groupField?: string;
  truncated: boolean;
  totalRows: number;
};

const numericValue = (value: unknown) =>
  typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')
    ? Number(value)
    : NaN;

export function bubbleRadius(size: number, max: number): number {
  if (!Number.isFinite(max) || max <= 0) return 11;
  const value = Number.isFinite(size) ? Math.max(0, size) : 0;
  return 4 + 14 * Math.sqrt(Math.min(1, value / max));
}

export function bubbleChart(rows: LogRecord[], tile: DashboardTile): BubbleChartData {
  const axes = record(record(tile.config).axes);
  const fields = [...new Set(rows.flatMap(Object.keys))];
  const configured = (axis: string) => {
    const field = fieldList(record(axes[axis]).field)[0];
    return field && fields.includes(field) ? field : undefined;
  };
  const numeric = (field: string) => rows.some((row) => Number.isFinite(numericValue(row[field])));
  const isTime = (field: string) => {
    const values = rows.map((row) => row[field]).filter((value) => value != null);
    return (
      values.length > 0 &&
      values.every(
        (value) =>
          Number.isFinite(timeValue(value)) &&
          (typeof value !== 'string' || !Number.isFinite(numericValue(value))),
      ) &&
      (values.every((value) => typeof value === 'string') ||
        /timestamp|^time$|^ts$|_time$|_at$/i.test(field))
    );
  };
  const xField = configured('x') ?? fields.find((field) => isTime(field) || numeric(field)) ?? '';
  const yField =
    configured('y') ?? fields.find((field) => field !== xField && numeric(field)) ?? '';
  const sizeField =
    configured('size') ??
    fields.slice(fields.indexOf(yField) + 1).find((field) => field !== xField && numeric(field));
  const groupField = configured('groupBy');
  const xIsTime = isTime(xField);
  const palette = tilePalette(tile);
  const points: BubblePoint[] = [];
  const groups = new Map<string, BubbleGroup>();
  let totalRows = 0;
  for (const row of rows) {
    const x = xIsTime ? timeValue(row[xField]) : numericValue(row[xField]);
    const y = numericValue(row[yField]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    totalRows++;
    if (points.length >= 2000) continue;
    const group = groupField ? row[groupField] : undefined;
    const groupId = groupField
      ? `${typeof group}:${typeof group === 'number' ? String(group) : JSON.stringify(group)}`
      : 'all';
    if (!groups.has(groupId))
      groups.set(groupId, {
        id: groupId,
        label: groupField ? (groupValue(group) ?? '(empty)') : yField,
        colour: paletteColour(palette, groups.size),
      });
    const size = sizeField ? numericValue(row[sizeField]) : NaN;
    points.push({
      x,
      y,
      ...(sizeField ? { size: Number.isFinite(size) ? Math.max(0, size) : 0 } : {}),
      radius: 11,
      groupId,
    });
  }
  if (sizeField && points.length) {
    const sizes = points.map((point) => point.size!);
    const max = Math.max(...sizes);
    const scale = Math.min(...sizes) < max ? max : 0;
    for (const point of points) point.radius = bubbleRadius(point.size!, scale);
  }
  return {
    points,
    groups: [...groups.values()],
    xIsTime,
    xField,
    yField,
    ...(sizeField ? { sizeField } : {}),
    ...(groupField ? { groupField } : {}),
    truncated: totalRows > points.length,
    totalRows,
  };
}
