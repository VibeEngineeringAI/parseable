import type { DashboardTile } from '../../lib/types';
import { record } from './tiles';

export const aggregates = ['COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'COUNT(DISTINCT)'];
export function newBuilderQuery(chartType?: unknown) {
  return {
    x: { fields: chartType === 'timeseries' ? [{ name: 'p_timestamp' }] : [], groupBy: [] },
    y: { fields: [{ name: '*', aggregate: 'COUNT' }], groupBy: [], limit: 100 },
    filters: [],
  };
}
/** Only expose definitions we can execute faithfully. Opaque definitions remain untouched. */
export function editableBuilder(tile: DashboardTile): boolean {
  if (!tile.chartQuery || typeof tile.chartQuery !== 'object' || Array.isArray(tile.chartQuery))
    return false;
  const query = record(tile.chartQuery);
  if (typeof query.sql === 'string' || typeof query.query === 'string') return false;
  const x = record(query.x),
    y = record(query.y);
  if (!Array.isArray(y.fields) || (x.fields != null && !Array.isArray(x.fields))) return false;
  if (query.filters != null && !Array.isArray(query.filters)) return false;
  return (
    (query.filters ?? []).every((filter: unknown) => {
      const row = record(filter);
      return (
        !Array.isArray(row.value) &&
        !String(row.type ?? '').startsWith('list') &&
        ['=', '!=', '<>', '<', '>', '<=', '>=', 'is null', 'is not null'].includes(
          String(row.operator).toLowerCase(),
        )
      );
    }) &&
    y.fields.every((field: unknown) =>
      aggregates.includes(String(record(field).aggregate).toUpperCase()),
    )
  );
}
export function builderAxis(tile: DashboardTile, axis: 'x' | 'y', edits: Record<string, unknown>) {
  const query = record(tile.chartQuery);
  return { chartQuery: { ...query, [axis]: { ...record(query[axis]), ...edits } } };
}

/** Migrate an edited legacy x-axis sort without leaving an active fallback behind. */
export function builderSort(tile: DashboardTile, sortBy?: Record<string, unknown>) {
  const query = record(tile.chartQuery),
    x = { ...record(query.x) },
    y = { ...record(query.y) };
  delete x.sortBy;
  delete y.sortBy;
  if (sortBy) y.sortBy = sortBy;
  return { chartQuery: { ...query, x, y } };
}

/** These are projected names, rather than arbitrary source columns. */
export function builderOrderFields(tile: DashboardTile): string[] {
  const query = record(tile.chartQuery),
    x = record(query.x),
    y = record(query.y);
  const xs = Array.isArray(x.fields) ? x.fields.map(record) : [];
  const ys = Array.isArray(y.fields) ? y.fields.map(record) : [];
  const names = xs.map((field) => String(field.name ?? '')).filter(Boolean);
  if (tile.chartType === 'timeseries' && names.length) names[0] = 'time_bucket';
  for (const axis of [x, y])
    if (Array.isArray(axis.groupBy)) names.push(...axis.groupBy.map(String));
  names.push(
    ...ys.map((field) => {
      const aggregate = String(field.aggregate).toUpperCase(),
        name = String(field.name ?? '');
      return aggregate === 'COUNT' && ['*', 'All rows (*)'].includes(name)
        ? 'COUNT_STAR'
        : `${aggregate}_${name}`;
    }),
  );
  return [...new Set(names)];
}
export function builderIssue(tile: DashboardTile, schema?: string[]): string {
  if (!editableBuilder(tile)) return '';
  const query = record(tile.chartQuery),
    x = record(query.x),
    y = record(query.y);
  const xs = Array.isArray(x.fields) ? x.fields.map(record) : [],
    ys = Array.isArray(y.fields) ? y.fields.map(record) : [];
  const stat = ['query-value', 'gauge'].includes(String(tile.chartType));
  if (!stat && y.limit != null && (!Number.isInteger(y.limit) || Number(y.limit) < 1))
    return 'Enter a whole row limit of at least 1.';
  if (
    Array.isArray(query.filters) &&
    query.filters.some((filter) => {
      const row = record(filter);
      return (
        !String(row.operator).toLowerCase().includes('null') &&
        typeof row.value === 'number' &&
        !Number.isFinite(row.value)
      );
    })
  )
    return 'Enter a finite number for the filter value.';
  if (tile.chartType === 'timeseries' && !xs.length)
    return 'Choose a time field for the first dimension.';
  if (
    ys.some(
      (field) =>
        ['*', 'All rows (*)'].includes(String(field.name)) &&
        String(field.aggregate).toUpperCase() !== 'COUNT',
    )
  )
    return 'Choose a field for this aggregate.';
  const sort = record(y.sortBy ?? x.sortBy);
  if (
    !stat &&
    sort.field &&
    !builderOrderFields(tile).includes(String(sort.field)) &&
    !ys.some((field) => field.name === sort.field)
  )
    return 'Choose an order field used by the query.';
  if (schema) {
    const names = [...xs, ...ys]
      .map((field) => String(field.name ?? ''))
      .filter((name) => !['*', 'All rows (*)'].includes(name));
    for (const axis of [x, y])
      if (Array.isArray(axis.groupBy)) names.push(...axis.groupBy.map(String));
    if (Array.isArray(query.filters))
      names.push(...query.filters.map((filter) => String(record(filter).column ?? '')));
    const missing = [...new Set(names.filter((name) => !schema.includes(name)))];
    if (missing.length) return `Choose fields available in this dataset: ${missing.join(', ')}.`;
  }
  return '';
}

export type FilterValueType = 'text' | 'number' | 'boolean';
export function filterValueType(value: unknown): FilterValueType {
  return typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'text';
}
export function typedFilterValue(value: string, type: FilterValueType): string | number | boolean {
  if (type === 'number') return value.trim() ? Number(value) : NaN;
  if (type === 'boolean') return value === 'true';
  return value;
}
