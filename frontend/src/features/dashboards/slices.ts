import { parseSampleValue, seriesLabel } from '../../lib/promql';
import type { QueryResult } from '../../lib/promqlResults';
import type { DashboardTile, LogRecord, PromqlSample } from '../../lib/types';
import type { TileResults } from './queries';
import { record, text } from './tiles';

export type Slice = { label: string; value: number };

const sliceValue = (value: unknown): number =>
  value == null
    ? 0
    : typeof value === 'number'
      ? value
      : typeof value === 'string' || typeof value === 'boolean'
        ? Number(value)
        : NaN;

/** Classic uses the first Y field as the category and the first other row key as the amount.
 * When Y is unset, native-created tiles infer the first non-numeric category and first numeric
 * value column (or a second numeric column as the category). Non-finite amounts are dropped;
 * classic would poison its total. */
export function sqlSlices(rows: LogRecord[], tile: DashboardTile): Slice[] {
  const field = record(record(record(tile.config).axes).y).field;
  let categoryField = text(Array.isArray(field) ? field[0] : field);
  let valueField: string | undefined;
  if (!categoryField) {
    const fields = [...new Set(rows.flatMap(Object.keys))];
    const numeric = new Set(
      fields.filter(
        (field) =>
          rows.some((row) => row[field] != null) &&
          rows.every((row) => row[field] == null || typeof row[field] === 'number'),
      ),
    );
    valueField = fields.find((field) => numeric.has(field));
    categoryField =
      fields.find((field) => !numeric.has(field)) ??
      fields.find((field) => field !== valueField) ??
      '';
    if (!categoryField || valueField === undefined) return [];
  }
  // Object keys keep classic's integer categories first, then other categories in appearance order.
  const totals: Record<string, number> = Object.create(null);
  for (const row of rows) {
    const category = row[categoryField];
    if (category == null) continue;
    const key = valueField ?? Object.keys(row).find((key) => key !== categoryField);
    const value = sliceValue(key === undefined ? undefined : row[key]);
    if (!Number.isFinite(value)) continue;
    const label = typeof category === 'object' ? JSON.stringify(category) : String(category);
    totals[label] = (totals[label] ?? 0) + value;
  }
  return Object.entries(totals).flatMap(([label, value]) =>
    Number.isFinite(value) ? [{ label, value }] : [],
  );
}

function lastFiniteSample(samples: PromqlSample[]): number | undefined {
  let timestamp = -Infinity,
    last: number | undefined;
  for (const [time, sample] of samples) {
    const value = parseSampleValue(sample);
    if (Number.isFinite(value) && time >= timestamp) {
      timestamp = time;
      last = value;
    }
  }
  return last;
}

export function promqlSlices(results: QueryResult[]): Slice[] {
  return results.flatMap<Slice>((query) => {
    const result = query.instant ?? query.range;
    const prefix = results.length > 1 ? `[${query.id}] ` : '';
    if (!result) return [];
    if (result.resultType === 'scalar') {
      const value = parseSampleValue(result.result[1]);
      return Number.isFinite(value) ? [{ label: `${prefix}value`, value }] : [];
    }
    if (result.resultType !== 'vector' && result.resultType !== 'matrix') return [];
    return result.result.flatMap<Slice>((series) => {
      const value =
        'value' in series ? parseSampleValue(series.value[1]) : lastFiniteSample(series.values);
      return value !== undefined && Number.isFinite(value)
        ? [{ label: `${prefix}${seriesLabel(series.metric, { keepName: true })}`, value }]
        : [];
    });
  });
}

export const tileSlices = (result: TileResults, tile: DashboardTile): Slice[] =>
  result.promql ? promqlSlices(result.promql) : sqlSlices(result.rows ?? [], tile);
