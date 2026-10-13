import { object } from './teamContract';
import type { DatasetSchemaField, LogContextConditions } from './types';

export type SqlBuilderV1 = {
  kind: 'sql';
  version: 1;
  dataset: string;
  aggregate: { function: 'count' | 'sum' | 'avg' | 'min' | 'max'; column?: string };
  filters?: LogContextConditions | null;
  groupBy?: string[];
};
export const newSqlBuilder = (dataset = ''): SqlBuilderV1 => ({
  kind: 'sql',
  version: 1,
  dataset,
  aggregate: { function: 'count' },
  groupBy: [],
});
export type SqlFieldType = 'int' | 'float' | 'string' | 'boolean' | 'timestamp' | 'list';
export function sqlFieldType(field: DatasetSchemaField): SqlFieldType | undefined {
  const type = field.dataType;
  if (typeof type === 'string') {
    if (/^U?Int(?:8|16|32|64)$/.test(type)) return 'int';
    if (/^Float(?:16|32|64)$/.test(type)) return 'float';
    if (['Utf8', 'LargeUtf8', 'Utf8View'].includes(type)) return 'string';
    if (type === 'Boolean') return 'boolean';
    if (['Date32', 'Date64'].includes(type)) return 'timestamp';
  }
  if (object(type)) {
    if ('Decimal128' in type || 'Decimal256' in type) return 'float';
    if ('Timestamp' in type) return 'timestamp';
    const listKey = ['List', 'LargeList', 'FixedSizeList', 'ListView', 'LargeListView'].find(
      (key) => key in type,
    );
    if (listKey) {
      const child = Array.isArray(type[listKey]) ? (type[listKey] as unknown[])[0] : type[listKey];
      if (object(child)) {
        const kind = sqlFieldType({
          name: typeof child.name === 'string' ? child.name : 'item',
          dataType: child.data_type ?? child.dataType,
        });
        if (['int', 'float', 'boolean', 'string'].includes(kind ?? '')) return 'list';
      }
    }
  }
}
const comparisons = ['=', '!=', '<', '>', '<=', '>='];
export const sqlFilterOperators = (type?: SqlFieldType): string[] => [
  ...(type === 'string'
    ? [
        '=',
        '!=',
        'ilike',
        'contains',
        'begins with',
        'ends with',
        'does not contain',
        'does not begin with',
        'does not end with',
      ]
    : type === 'boolean'
      ? ['=', '!=']
      : type === 'list'
        ? ['contains', 'does not contain', '=', '!=']
        : comparisons),
  'is null',
  'is not null',
];
const keys = (value: Record<string, unknown>, allowed: string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));
/** Separate from alert decoding: a future/invalid specification must remain inspectable. */
export function sqlBuilderConfig(value: unknown): value is SqlBuilderV1 {
  if (
    !object(value) ||
    !keys(value, ['kind', 'version', 'dataset', 'aggregate', 'filters', 'groupBy']) ||
    value.kind !== 'sql' ||
    value.version !== 1 ||
    typeof value.dataset !== 'string' ||
    !value.dataset ||
    !object(value.aggregate) ||
    !keys(value.aggregate, ['function', 'column']) ||
    !['count', 'sum', 'avg', 'min', 'max'].includes(String(value.aggregate.function)) ||
    (value.aggregate.column !== undefined &&
      (typeof value.aggregate.column !== 'string' || !value.aggregate.column)) ||
    (value.aggregate.function !== 'count' && !value.aggregate.column)
  )
    return false;
  if (
    value.groupBy !== undefined &&
    (!Array.isArray(value.groupBy) ||
      value.groupBy.length > 3 ||
      !value.groupBy.every(
        (field) =>
          typeof field === 'string' &&
          field !== '' &&
          field !== 'p_timestamp' &&
          field !== 'alert_value',
      ) ||
      new Set(value.groupBy).size !== value.groupBy.length)
  )
    return false;
  let conditionCount = 0,
    groupCount = 0;
  const group = (candidate: unknown, depth: number): boolean => {
    if (
      !object(candidate) ||
      depth > 3 ||
      !keys(candidate, ['operator', 'conditionConfig', 'groups']) ||
      (candidate.operator != null && !['and', 'or'].includes(String(candidate.operator))) ||
      (candidate.conditionConfig !== undefined && !Array.isArray(candidate.conditionConfig)) ||
      (candidate.groups != null && !Array.isArray(candidate.groups))
    )
      return false;
    const conditions = (candidate.conditionConfig ?? []) as unknown[],
      groups = (candidate.groups ?? []) as unknown[];
    if (depth > 0 && conditions.length === 0 && groups.length === 0) return false;
    conditionCount += conditions.length;
    groupCount += groups.length;
    return (
      conditionCount <= 20 &&
      groupCount <= 10 &&
      conditions.every((condition) => {
        if (
          !object(condition) ||
          !keys(condition, ['column', 'operator', 'value', 'type']) ||
          typeof condition.column !== 'string' ||
          !condition.column ||
          typeof condition.operator !== 'string' ||
          typeof condition.type !== 'string' ||
          !['int', 'float', 'string', 'boolean', 'timestamp', 'list'].includes(condition.type) ||
          !sqlFilterOperators(condition.type as SqlFieldType).includes(condition.operator) ||
          (condition.value != null && typeof condition.value !== 'string')
        )
          return false;
        const literal = String(condition.value ?? '');
        if (literal.length > 1024 || literal.includes('\0')) return false;
        if (condition.operator === 'is null' || condition.operator === 'is not null')
          return !literal;
        if (condition.type === 'int') {
          try {
            return (
              /^[-+]?\d+$/.test(literal) &&
              BigInt(literal) >= -9223372036854775808n &&
              BigInt(literal) <= 18446744073709551615n
            );
          } catch {
            return false;
          }
        }
        if (condition.type === 'float') return !!literal.trim() && Number.isFinite(Number(literal));
        if (condition.type === 'boolean') return ['true', 'false'].includes(literal);
        if (condition.type === 'timestamp')
          return (
            /^\d{4}-\d\d-\d\dT.+(?:Z|[+-]\d\d:\d\d)$/.test(literal) &&
            Number.isFinite(Date.parse(literal))
          );
        return true;
      }) &&
      groups.every((child) => group(child, depth + 1))
    );
  };
  return value.filters == null || group(value.filters, 0);
}
export function builderEditable(
  alert: { queryType?: string; builderConfig?: unknown; builderStatus?: unknown },
  enabled: boolean,
): boolean {
  return (
    alert.queryType !== 'builder' ||
    (enabled && alert.builderStatus === 'editable' && sqlBuilderConfig(alert.builderConfig))
  );
}
/** Demo-only compiler. Live compilation and schema validation belong to the server. */
export function demoCompileSqlBuilder(spec: SqlBuilderV1): string {
  const quote = (value: string) => `"${value.replaceAll('"', '""')}"`,
    literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const condition = (group: LogContextConditions): string => {
    const nodes = (group.conditionConfig ?? []).map((item) => {
      const column = quote(item.column),
        value = item.value ?? '',
        op = item.operator;
      if (op === 'is null' || op === 'is not null') return `${column} ${op.toUpperCase()}`;
      if (
        [
          'contains',
          'begins with',
          'ends with',
          'does not contain',
          'does not begin with',
          'does not end with',
          'ilike',
        ].includes(op)
      ) {
        const pattern =
          op === 'ilike'
            ? value
            : op.includes('contain')
              ? `%${value}%`
              : op.includes('begin')
                ? `${value}%`
                : `%${value}`;
        return `${column} ${op.startsWith('does not') ? 'NOT ' : ''}ILIKE ${literal(pattern)}`;
      }
      return `${column} ${op} ${['int', 'float', 'boolean'].includes(item.type ?? '') ? value : literal(value)}`;
    });
    nodes.push(...(group.groups ?? []).map((child) => `(${condition(child)})`));
    return nodes.join(` ${(group.operator ?? 'and').toUpperCase()} `);
  };
  const group = spec.groupBy ?? [],
    filters = spec.filters ? condition(spec.filters) : '';
  return `SELECT ${group.length ? group.map(quote).join(', ') + ', ' : ''}${spec.aggregate.function.toUpperCase()}(${spec.aggregate.column ? quote(spec.aggregate.column) : '*'}) AS "alert_value" FROM ${quote(spec.dataset)}${filters ? ' WHERE ' + filters : ''}${group.length ? ' GROUP BY ' + group.map(quote).join(', ') : ''}`;
}
