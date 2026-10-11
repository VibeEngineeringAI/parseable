import { object, strings } from '../../lib/guards';
import { parseEventTimestamp } from '../../components/explorer/timestamp';
import { legacySql } from './legacySql';
import { referencedVariables } from './variables';
import { appendLayout } from './layout';
export { appendLayout, resolvedLayouts, moveTile, type TileLayout } from './layout';
import { createUlid } from '../../lib/ids';
import { autoStep, formatStep, parseDuration } from '../../lib/promql';
import type { DashboardTile, DashboardVariable, LogRecord } from '../../lib/types';

export const record = (value: unknown): Record<string, unknown> => (object(value) ? value : {});
export const text = (value: unknown, fallback = '') =>
  typeof value === 'string' ? value : fallback;
export const tileTitle = (tile: DashboardTile) => text(tile.title, 'Untitled tile');
export const supportedCharts = ['timeseries', 'line', 'area', 'bar', 'table', 'query-value'];
export const tileType = (tile: DashboardTile) => text(tile.tileType) || 'builder';
export const knownTile = (tile: DashboardTile) =>
  ['code', 'builder', 'promql'].includes(tileType(tile));
export const tileDatasets = (tile: DashboardTile): string[] =>
  strings(tile.dbName) ? tile.dbName : typeof tile.dbName === 'string' ? [tile.dbName] : [];
export type QueryMode = 'range' | 'instant' | 'both';
export function tileVariableNames(
  tile: DashboardTile,
  variables: DashboardVariable[],
): Set<string> {
  let query = '';
  try {
    query =
      tile.tileType === 'promql'
        ? promqlQueries(tile)
            .map((row) => row.query)
            .join(' ')
        : sqlQuery(tile);
  } catch {
    /* Legacy query errors are shown by the tile loader. */
  }
  const source = [query, ...tileDatasets(tile)].join(' ');
  return new Set(referencedVariables(source, variables));
}
export function promqlQueries(tile: DashboardTile): Array<{ query: string; type: QueryMode }> {
  const legacy = { ...record(tile.chartQuery), ...record(tile.promqlQuery) };
  const queries = strings(tile.chartQuery)
    ? tile.chartQuery
    : typeof tile.chartQuery === 'string'
      ? [tile.chartQuery]
      : typeof legacy.query === 'string'
        ? [legacy.query]
        : typeof record(tile.chartQuery).query === 'string'
          ? [String(record(tile.chartQuery).query)]
          : [];
  return queries.map((query, index) => {
    const mode = Array.isArray(tile.promqlQueryType)
      ? tile.promqlQueryType[index]
      : (tile.promqlQueryType ?? legacy.type);
    return { query, type: mode === 'instant' || mode === 'both' ? mode : 'range' };
  });
}
export const storedStep = (tile: DashboardTile) =>
  tile.promqlStep ?? record(tile.promqlQuery).step ?? record(tile.chartQuery).step;
export function tileStep(tile: DashboardTile, start: number, end: number, query: string): string {
  const legacy = storedStep(tile);
  if (typeof legacy === 'string' && (parseDuration(legacy) ?? 0) > 0) return legacy;
  if (typeof legacy === 'number' && Number.isFinite(legacy) && legacy > 0) return `${legacy}s`;
  const maxDP = Number(
    record(tile.config).maxDataPoints ?? record(record(tile.config).layout).maxDataPoints,
  );
  const seconds = autoStep({
    start,
    end,
    query,
    width: 600,
    maxDataPoints: Number.isFinite(maxDP) && maxDP > 0 ? maxDP : 500,
  });
  return Number.isFinite(seconds) && seconds > 0 ? formatStep(seconds) : '60s';
}
/** Read old object chartQuery without rewriting the stored tile. Unsupported legacy SQL is explicit. */
export function sqlQuery(tile: DashboardTile): string {
  if (typeof tile.chartQuery === 'string') return tile.chartQuery;
  const query = record(tile.chartQuery);
  if (typeof query.query === 'string') return query.query;
  if (typeof query.sql === 'string') return query.sql;
  if (!object(tile.chartQuery)) return '';
  return legacySql(tile, query);
}
export function chartConfig(chartType: string) {
  return {
    type: chartType,
    colourScheme: 'classic',
    layout: {
      legendPosition: 'bottom',
      segments: { value: [10, 90], isPercent: true },
      label: false,
    },
    axes: {
      x: { field: '', title: '', display: true },
      y: { field: '', title: '', display: true, beginAtZero: false },
    },
    advanced: {
      dataLabels: { enabled: false },
      tooltip: { enabled: true, mode: 'index', intersect: false },
    },
  };
}
export function newTile(tiles: DashboardTile[]): DashboardTile {
  return {
    tile_id: createUlid(),
    title: '',
    authorMode: 'manual',
    tileType: 'code',
    chartType: 'timeseries',
    chartQuery: '',
    dbName: [],
    layout: appendLayout(tiles),
    config: chartConfig('timeseries'),
  };
}
// Numbers count as Unix seconds or milliseconds; smaller numbers and numeric strings are not times.
const timeValue = (value: unknown) => {
  if (typeof value === 'number')
    return value >= 1e9 && value < 1e11
      ? value
      : value >= 1e12 && value < 1e14
        ? value / 1000
        : NaN;
  if (typeof value === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(value)) return NaN;
  return parseEventTimestamp(value) / 1000;
};
const groupValue = (value: unknown) =>
  value == null || value === ''
    ? '(empty)'
    : typeof value === 'string'
      ? value
      : JSON.stringify(value);
/** One series per y field and group. Rows whose x values are not all timestamps are
 * `categorical` and have no chart data; callers show them as a table. */
export function sqlChart(rows: LogRecord[], tile: DashboardTile) {
  const axes = record(record(tile.config).axes),
    x = record(axes.x),
    y = record(axes.y);
  const fields = [...new Set(rows.flatMap(Object.keys))];
  const numeric = (field: string) => rows.some((row) => typeof row[field] === 'number');
  const xField =
    text(x.field) || fields.find((field) => /timestamp|^time$|^ts$/i.test(field)) || '';
  const yFields = strings(y.field)
    ? y.field
    : text(y.field)
      ? [text(y.field)]
      : fields.filter((field) => field !== xField && numeric(field));
  const points = rows.map((row) => ({ row, time: timeValue(row[xField]) }));
  if (points.some((point) => !Number.isFinite(point.time)))
    return { categorical: true, timestamps: [], series: [] };
  const timestamps = [...new Set(points.map((point) => point.time))].sort((a, b) => a - b);
  const builder = object(tile.chartQuery) ? record(tile.chartQuery) : undefined;
  // Builder tiles declare their groups. Otherwise only repeated x values are split, and only by
  // low-cardinality columns, so raw log rows with messages and ids stay one series per y field.
  const groupFields = builder
    ? [record(builder.x).groupBy, record(builder.y).groupBy]
        .flatMap((groups) => (strings(groups) ? groups : []))
        .filter((field) => fields.includes(field))
    : timestamps.length === rows.length
      ? []
      : fields.filter((field) => {
          if (field === xField || yFields.includes(field) || numeric(field)) return false;
          const distinct = new Set(rows.map((row) => groupValue(row[field]))).size;
          return distinct <= 20 && distinct < rows.length;
        });
  const position = new Map(timestamps.map((time, index) => [time, index]));
  const series = new Map<string, { id: string; label: string; values: (number | null)[] }>();
  if (!groupFields.length)
    for (const field of yFields)
      series.set(field, { id: field, label: field, values: timestamps.map(() => null) });
  for (const { row, time } of points) {
    const group = groupFields.map((field) => groupValue(row[field]));
    for (const field of yFields) {
      const id = groupFields.length ? JSON.stringify([field, ...group]) : field;
      let entry = series.get(id);
      if (!entry) {
        const label = group.join(', ');
        entry = {
          id,
          label: yFields.length > 1 ? `${field}: ${label}` : label,
          values: timestamps.map(() => null),
        };
        series.set(id, entry);
      }
      const value = row[field];
      if (typeof value === 'number' && Number.isFinite(value))
        entry.values[position.get(time)!] = value;
    }
  }
  return { categorical: false, timestamps, series: [...series.values()] };
}
