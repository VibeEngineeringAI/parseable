import { object, strings } from '../../lib/teamContract';
import { createUlid } from '../../lib/ids';
import { quoteIdentifier, quoteLiteral } from '../../lib/query';
import { autoStep, formatStep, parseDuration } from '../../lib/promql';
import type { Dashboard, DashboardTile, LogRecord } from '../../lib/types';

export const record = (value: unknown): Record<string, unknown> => (object(value) ? value : {});
export const text = (value: unknown, fallback = '') =>
  typeof value === 'string' ? value : fallback;
export const tileTitle = (tile: DashboardTile) => text(tile.title, 'Untitled tile');
export const supportedCharts = ['timeseries', 'line', 'area', 'bar', 'table', 'query-value'];
export const knownTile = (tile: DashboardTile) =>
  ['code', 'builder', 'promql'].includes(text(tile.tileType));
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
  const dataset = tileDatasets(tile)[0];
  if (!dataset) throw new Error('This legacy query has no dataset. Open it in the classic UI.');
  const x = record(query.x),
    y = record(query.y);
  const xFields = Array.isArray(x.fields) ? x.fields.map(record) : [];
  const yFields = Array.isArray(y.fields) ? y.fields.map(record) : [];
  const expressions: string[] = [],
    groups: string[] = [];
  for (const field of xFields) {
    const name = text(field.name);
    if (!name) continue;
    const grain = text(x.granularity);
    const expression =
      grain && field.type === 'time'
        ? `date_trunc(${quoteLiteral(grain)}, ${quoteIdentifier(name)})`
        : quoteIdentifier(name);
    expressions.push(`${expression} AS ${quoteIdentifier(name)}`);
    groups.push(expression);
  }
  const groupBy = strings(y.groupBy) ? y.groupBy : [];
  for (const name of groupBy)
    if (!groups.includes(quoteIdentifier(name))) {
      expressions.push(quoteIdentifier(name));
      groups.push(quoteIdentifier(name));
    }
  for (const field of yFields) {
    const name = text(field.name),
      aggregate = text(field.aggregate).toUpperCase();
    if (!name) continue;
    if (
      aggregate &&
      ![
        'COUNT',
        'SUM',
        'AVG',
        'MIN',
        'MAX',
        'COUNT_STAR',
        'COUNT_DISTINCT',
        'COUNT(DISTINCT)',
      ].includes(aggregate)
    )
      throw new Error('This legacy aggregate is not available. Open it in the classic UI.');
    const value = name === '*' ? '*' : quoteIdentifier(name);
    const expression =
      aggregate === 'COUNT_STAR'
        ? 'COUNT(*)'
        : ['COUNT_DISTINCT', 'COUNT(DISTINCT)'].includes(aggregate)
          ? `COUNT(DISTINCT ${value})`
          : aggregate
            ? `${aggregate}(${value})`
            : value;
    expressions.push(
      `${expression} AS ${quoteIdentifier(aggregate ? `${aggregate.toLowerCase().replace(/\W/g, '_')}_${name === '*' ? 'all' : name}` : name)}`,
    );
  }
  if (!expressions.length)
    throw new Error('This legacy query is not available. Open it in the classic UI.');
  const filters = Array.isArray(query.filters) ? query.filters.map(record) : [];
  const where = filters.map((filter) => {
    const op = text(filter.operator, '=');
    if (!['=', '!=', '<>', '>', '<', '>=', '<='].includes(op))
      throw new Error('This legacy filter is not available. Open it in the classic UI.');
    const field = text(filter.field) || text(filter.name);
    return `${quoteIdentifier(field)} ${op} ${quoteLiteral(String(filter.value ?? ''))}`;
  });
  return `SELECT ${expressions.join(', ')} FROM ${quoteIdentifier(dataset)}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}${yFields.some((field) => field.aggregate) && groups.length ? ` GROUP BY ${groups.join(', ')}` : ''}`;
}
export type TileLayout = { x: number; y: number; w: number; h: number };
const integer = (value: unknown, fallback: number, min: number, max: number) =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.floor(value)))
    : fallback;
export function resolvedLayouts(
  tiles: DashboardTile[],
): Array<{ tile: DashboardTile; layout: TileLayout }> {
  let bottom = tiles.reduce((end, tile) => {
    const layout = record(tile.layout);
    return typeof layout.y === 'number' && Number.isFinite(layout.y)
      ? Math.max(end, integer(layout.y, 0, 0, 100000) + integer(layout.h, 4, 1, 24))
      : end;
  }, 0);
  return tiles
    .map((tile) => {
      const stored = record(tile.layout),
        w = integer(stored.w, 6, 1, 12),
        h = integer(stored.h, 4, 1, 24);
      const y =
        typeof stored.y === 'number' && Number.isFinite(stored.y)
          ? integer(stored.y, 0, 0, 100000)
          : bottom;
      if (!(typeof stored.y === 'number' && Number.isFinite(stored.y))) bottom += h;
      return { tile, layout: { x: integer(stored.x, 0, 0, 12 - w), y, w, h } };
    })
    .sort((a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x);
}
export function appendLayout(tiles: DashboardTile[], w = 6, h = 4): TileLayout {
  return {
    x: 0,
    y: resolvedLayouts(tiles).reduce(
      (bottom, { layout }) => Math.max(bottom, layout.y + layout.h),
      0,
    ),
    w,
    h,
  };
}
export function moveTile(tiles: DashboardTile[], id: string, direction: -1 | 1): DashboardTile[] {
  const ordered = resolvedLayouts(tiles),
    index = ordered.findIndex(({ tile }) => tile.tile_id === id),
    next = index + direction;
  if (index < 0 || next < 0 || next >= ordered.length) return tiles;
  [ordered[index], ordered[next]] = [ordered[next], ordered[index]];
  let x = 0,
    y = 0,
    rowHeight = 0;
  const positions = new Map<string, TileLayout>();
  for (const { tile, layout } of ordered) {
    if (x + layout.w > 12) {
      y += rowHeight;
      x = 0;
      rowHeight = 0;
    }
    positions.set(tile.tile_id, { ...layout, x, y });
    x += layout.w;
    rowHeight = Math.max(rowHeight, layout.h);
  }
  return tiles.map((tile) => ({
    ...tile,
    layout: { ...record(tile.layout), ...positions.get(tile.tile_id)! },
  }));
}
export function patchTile(
  dashboard: Dashboard,
  id: string,
  edits: Partial<DashboardTile>,
): Dashboard {
  return {
    ...dashboard,
    tiles: (dashboard.tiles ?? []).map((tile) =>
      tile.tile_id === id ? { ...tile, ...edits, tile_id: id } : tile,
    ),
  };
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
        : Date.parse(String(row[xField])) / 1000,
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
