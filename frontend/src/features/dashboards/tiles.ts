import { object, strings } from '../../lib/guards';
import { parseEventTimestamp } from '../../components/explorer/timestamp';
import { legacySql } from './legacySql';
import { appendLayout } from './layout';
export { appendLayout, resolvedLayouts, moveTile, type TileLayout } from './layout';
import { createUlid } from '../../lib/ids';
import { autoStep, formatStep, parseDuration } from '../../lib/promql';
import type { DashboardTile, LogRecord } from '../../lib/types';

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
export function tileVariableNames(tile: DashboardTile): Set<string> {
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
  return new Set([...source.matchAll(/\$\{?(\w+)\}?/g)].map((match) => match[1]));
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
export function tileStep(tile: DashboardTile, start: number, end: number, query: string): string {
  const legacy = tile.promqlStep ?? record(tile.promqlQuery).step ?? record(tile.chartQuery).step;
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
export function sqlChart(rows: LogRecord[], tile: DashboardTile) {
  const axes = record(record(tile.config).axes),
    x = record(axes.x),
    y = record(axes.y);
  const fields = [...new Set(rows.flatMap(Object.keys))];
  const xField =
    text(x.field) || fields.find((field) => /timestamp|^time$|^ts$/i.test(field)) || '';
  const yFields = strings(y.field)
    ? y.field
    : text(y.field)
      ? [text(y.field)]
      : fields.filter(
          (field) => field !== xField && rows.some((row) => typeof row[field] === 'number'),
        );
  const ordered = rows.map((row, index) => ({
    row,
    time:
      typeof row[xField] === 'number'
        ? Number(row[xField])
        : parseEventTimestamp(row[xField]) / 1000,
    index,
  }));
  const categorical = ordered.some((row) => !Number.isFinite(row.time));
  if (!categorical) ordered.sort((a, b) => a.time - b.time);
  return {
    categorical,
    timestamps: ordered.map((row, index) => (categorical ? index : row.time)),
    series: yFields.map((field) => ({
      id: field,
      label: field,
      values: ordered.map(({ row }) =>
        typeof row[field] === 'number' && Number.isFinite(row[field])
          ? (row[field] as number)
          : null,
      ),
    })),
  };
}
