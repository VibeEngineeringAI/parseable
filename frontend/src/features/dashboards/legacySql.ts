import { object, strings } from '../../lib/guards';
import { quoteIdentifier as id, quoteLiteral as literal } from '../../lib/query';
import type { DashboardTile } from '../../lib/types';

const record = (value: unknown) => (object(value) ? value : {});
const text = (value: unknown) => (typeof value === 'string' ? value : '');
const unavailable = (part: string): never => {
  throw new Error(
    `This legacy ${part} cannot be converted faithfully to SQL. Open it in the classic UI.`,
  );
};
function filtersSql(value: unknown): string {
  if (value == null) return '';
  if (!Array.isArray(value)) return unavailable('filter');
  return value
    .map(record)
    .map((filter) => {
      const column = text(filter.column),
        operator = text(filter.operator).trim().toLowerCase();
      if (
        !column ||
        !['=', '!=', '<>', '<', '>', '<=', '>=', 'is null', 'is not null'].includes(operator) ||
        text(filter.type).startsWith('list')
      )
        return unavailable('filter');
      const values = operator.includes('null')
        ? [null]
        : Array.isArray(filter.value)
          ? filter.value
          : [filter.value];
      // Classic deduplicates by String(value), including mixed numeric/text values.
      const unique = values.filter(
        (value, index) => values.findIndex((other) => String(other) === String(value)) === index,
      );
      const predicates = unique.map((value) => {
        const name = id(column.replaceAll('`', ''));
        if (value === null)
          return `${name} IS ${['!=', '<>', 'is not null'].includes(operator) ? 'NOT ' : ''}NULL`;
        if (
          value === undefined ||
          (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean')
        )
          return unavailable('filter');
        const sqlValue = typeof value === 'string' ? literal(value) : String(value);
        return `${name} ${operator.toUpperCase()} ${sqlValue}`;
      });
      return predicates.length > 1 ? `(${predicates.join(' OR ')})` : predicates[0];
    })
    .filter(Boolean)
    .join(' AND ');
}
/** Mirrors ChartPreviewTable's legacy object→AST conversion: time_bucket,
 * uppercase aggregate aliases, both groupBy lists, sortBy and limit. Complex
 * filters are blocked explicitly instead of guessing or dropping them. */
export function legacySql(tile: DashboardTile, query: Record<string, unknown>): string {
  const dataset = strings(tile.dbName) ? tile.dbName[0] : text(tile.dbName);
  if (!dataset) return unavailable('query with no dataset');
  const x = record(query.x),
    y = record(query.y);
  for (const axis of [x, y]) {
    if (axis.fields != null && !Array.isArray(axis.fields)) return unavailable('fields');
    if (axis.groupBy != null && !strings(axis.groupBy)) return unavailable('grouping');
  }
  const xs = Array.isArray(x.fields) ? x.fields.map(record) : [];
  const ys = Array.isArray(y.fields) ? y.fields.map(record) : [];
  const stat = ['query-value', 'gauge'].includes(text(tile.chartType));
  const timeseries = text(tile.chartType) === 'timeseries';
  if (stat && !ys[0]?.aggregate) return unavailable('aggregate');
  const expressions = new Map<string, string>(),
    groups = new Set<string>(),
    aliases = new Map<string, string>();
  if (timeseries && text(xs[0]?.name)) {
    const grain = text(x.granularity) || 'minute';
    if (!['second', 'minute', 'hour', 'day', 'week', 'month', 'quarter', 'year'].includes(grain))
      return unavailable('granularity');
    expressions.set(
      'time_bucket',
      `DATE_TRUNC(${literal(grain)}, ${id(text(xs[0].name))}) AS ${id('time_bucket')}`,
    );
    groups.add('time_bucket');
  }
  if (!stat)
    for (const field of xs) {
      const name = text(field.name);
      if (!name) return unavailable('field');
      if (timeseries && name === text(xs[0]?.name) && !field.aggregate) continue;
      expressions.set(name, `${id(name)} AS ${id(name)}`);
      groups.add(name);
    }
  const groupBy = [
    ...(strings(x.groupBy) ? x.groupBy : []),
    ...(strings(y.groupBy) ? y.groupBy : []),
  ];
  // Query-value selects group columns before the aggregate, as classic does.
  if (stat) for (const name of groupBy) expressions.set(name, `${id(name)} AS ${id(name)}`);
  for (const field of stat ? ys.slice(0, 1) : ys) {
    const name = text(field.name),
      aggregate = text(field.aggregate).toUpperCase();
    if (!aggregate) continue;
    if (!name || !['COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'COUNT(DISTINCT)'].includes(aggregate))
      return unavailable('aggregate');
    const star = aggregate === 'COUNT' && ['All rows (*)', '*'].includes(name);
    const alias = star ? 'COUNT_STAR' : `${aggregate}_${name}`;
    const value = star ? '*' : id(name);
    const expression =
      aggregate === 'COUNT(DISTINCT)' ? `COUNT(DISTINCT ${value})` : `${aggregate}(${value})`;
    expressions.set(alias, `${expression} AS ${id(alias)}`);
    aliases.set(name, alias);
  }
  for (const name of groupBy) {
    if (!expressions.has(name)) expressions.set(name, `${id(name)} AS ${id(name)}`);
    groups.add(name);
  }
  const order: string[] = timeseries && !stat ? [`${id('time_bucket')} DESC`] : [];
  const sort = record(y.sortBy ?? x.sortBy);
  if (!stat && Object.keys(sort).length) {
    const field = text(sort.field),
      alias = aliases.get(field) ?? field;
    if (!field || !['ASC', 'DESC'].includes(text(sort.direction))) return unavailable('sort');
    if (!expressions.has(alias)) expressions.set(alias, `${id(field)} AS ${id(alias)}`);
    order.push(`${id(alias)} ${sort.direction}`);
  }
  const where = filtersSql(query.filters);
  if (!expressions.size) return unavailable('query');
  if (!stat && y.limit != null && (!Number.isInteger(y.limit) || Number(y.limit) < 1))
    return unavailable('limit');
  return `SELECT ${[...expressions.values()].join(', ')} FROM ${id(dataset)}${where ? ` WHERE ${where}` : ''}${groups.size ? ` GROUP BY ${[...groups].map(id).join(', ')}` : ''}${order.length ? ` ORDER BY ${order.join(', ')}` : ''}${!stat && y.limit ? ` LIMIT ${y.limit}` : ''}`;
}
