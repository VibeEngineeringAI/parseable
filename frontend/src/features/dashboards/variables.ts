import { dashboardVariable } from '../../lib/dashboardsContract';
import { matcher } from '../../lib/promql';
import type { DashboardVariable, ParseableClient, QueryRequest } from '../../lib/types';

export type VariableValues = Record<string, string | string[]>;
const placeholder = /\$\{?(\w+)\}?/g;
const valueFor = (values: VariableValues, name: string) =>
  Object.hasOwn(values, name) ? values[name] : undefined;
/** Classic leaves every token without a dashboard definition untouched. */
export function referencedVariables(source: string, variables: DashboardVariable[]): string[] {
  const names = new Set(variables.map((variable) => variable.name));
  return [
    ...new Set(
      [...source.matchAll(placeholder)].map((match) => match[1]).filter((name) => names.has(name)),
    ),
  ];
}
const regexEscape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const sqlEscape = (value: string) => value.replaceAll("'", "''");
const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
const promqlEscape = (value: string) =>
  value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')
    .replaceAll('\t', '\\t');
export const readVariables = (value: unknown): DashboardVariable[] =>
  Array.isArray(value) ? value.filter(dashboardVariable) : [];
export function interpolate(value: string, values: VariableValues): string {
  return value.replace(placeholder, (token, name) => {
    const selection = valueFor(values, name);
    return selection === undefined || (Array.isArray(selection) && !selection.length)
      ? token
      : Array.isArray(selection)
        ? `(${selection.join('|')})`
        : selection;
  });
}
function substitutePromql(
  query: string,
  values: VariableValues,
  escape: (value: string) => string,
): string {
  return query.replace(placeholder, (token, name) => {
    const selection = valueFor(values, name);
    return selection === undefined || (Array.isArray(selection) && !selection.length)
      ? token
      : Array.isArray(selection)
        ? `(${selection.map((value) => escape(regexEscape(value))).join('|')})`
        : escape(selection);
  });
}
/** All (`.*`) turns `=` into a regex match; `!=".*"` already excludes nothing and stays. */
export function interpolatePromql(query: string, values: VariableValues): string {
  return substitutePromql(query, values, promqlEscape).replace(/(?<![!=<>])=\s*"\.\*"/g, '=~".*"');
}
/** Matches classic quoting rules for stream identifiers, SQL literals and comma lists. */
export function interpolateSql(
  query: string,
  values: VariableValues,
  variables: DashboardVariable[] = [],
): string {
  const datasetNames = new Set(
    variables.filter((variable) => variable.type === 'dataset').map((variable) => variable.name),
  );
  const dataset = (name: string) => {
    const value = valueFor(values, name),
      selection = Array.isArray(value) ? value[0] : value;
    return selection ? identifier(selection) : undefined;
  };
  // One lexical pass prevents a value containing "$other", quotes or comment markers from being
  // lexed again; comments are kept verbatim so their apostrophes cannot open a literal.
  return query.replace(
    /--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(\$\{?(\w+)\}?)"|\$\{?(\w+)\}?/g,
    (token, quoted, name, bare) => {
      if (token.startsWith('--') || token.startsWith('/*')) return token;
      if (token.startsWith("'")) {
        const contents = token.slice(1, -1),
          exact = /^\$\{?(\w+)\}?$/.exec(contents);
        if (exact && !datasetNames.has(exact[1])) {
          const value = valueFor(values, exact[1]);
          if (value === undefined || (Array.isArray(value) && !value.length)) return token;
          return (Array.isArray(value) ? value : [value])
            .map((value) => `'${sqlEscape(value)}'`)
            .join(',');
        }
        return `'${contents.replace(placeholder, (token, name) => {
          if (datasetNames.has(name)) {
            const stream = dataset(name);
            return stream === undefined ? token : sqlEscape(stream);
          }
          const value = valueFor(values, name),
            selection = Array.isArray(value) ? value[0] : value;
          return selection === undefined ? token : sqlEscape(selection);
        })}'`;
      }
      const variable = name ?? bare;
      if (!variable) return token;
      if (datasetNames.has(variable)) return dataset(variable) ?? token;
      const value = valueFor(values, variable);
      if (value === undefined || (Array.isArray(value) && !value.length)) return token;
      const selections = Array.isArray(value) ? value : [value];
      return name ? selections.map(identifier).join(',') : selections.join(',');
    },
  );
}
export function resolveDataset(dataset: string, values: VariableValues): string {
  const resolved = interpolate(dataset, values);
  return /^\$\{?\w+\}?$/.test(resolved) ? '' : resolved;
}
export const allValue = (variable: DashboardVariable) =>
  variable.type === 'promql' || variable.type === 'promql_query' ? '.*' : '*';
export function defaultSelection(
  variable: DashboardVariable,
  options: string[],
  url: string | null,
): string {
  if (variable.type === 'text') return url ?? variable.defaultValue ?? '';
  if (url !== null && options.includes(url)) return url;
  if (variable.defaultValue && options.includes(variable.defaultValue))
    return variable.defaultValue;
  return options[0] ?? '';
}
export function hasAllSelection(
  variables: DashboardVariable[],
  values: VariableValues,
  query: string,
  dataset: string,
) {
  const names = [...`${query} ${dataset}`.matchAll(/\$\{?(\w+)\}?/g)].map((match) => match[1]);
  return variables.some(
    (variable) =>
      names.includes(variable.name) &&
      (values[variable.name] === allValue(variable) ||
        (Array.isArray(values[variable.name]) &&
          (values[variable.name] as string[]).includes(allValue(variable)))),
  );
}
export function variableInputs(
  variable: DashboardVariable,
  values: VariableValues,
): VariableValues {
  const source = variableSource(variable);
  return Object.fromEntries(
    [...source.matchAll(/\$\{?(\w+)\}?/g)]
      .map((match) => [match[1], valueFor(values, match[1])])
      .filter((entry) => entry[1] !== undefined),
  );
}
export async function loadVariableOptions(
  client: ParseableClient,
  variable: DashboardVariable,
  values: VariableValues,
  variables: DashboardVariable[],
  bounds: Omit<QueryRequest, 'sql'>,
  signal: AbortSignal,
): Promise<string[]> {
  let options: string[] = [];
  const start = Date.parse(bounds.startTime) / 1000,
    end = Date.parse(bounds.endTime) / 1000;
  if (variable.type === 'list') options = variable.options ?? [];
  else if (variable.type === 'dataset')
    options = (await client.listDatasets(signal)).map((dataset) => dataset.name);
  else if (variable.type === 'sql') {
    const rows = await client.query(
      { sql: interpolateSql(variable.sqlQuery ?? '', values, variables), ...bounds },
      signal,
    );
    options = rows
      .map((row) => Object.values(row)[0])
      .filter((value) => value != null)
      .map(String);
  } else if (variable.type === 'promql') {
    const stream = resolveDataset(variable.dataset ?? '', values);
    if (!stream) throw new Error('Select a dataset for this variable.');
    // matcher() quotes the raw value; All widens `=` and makes `!=` a no-op.
    const filters = (variable.labelFilters ?? []).flatMap((filter) => {
      const label = filter.label.trim(),
        value = substitutePromql(filter.value, values, (value) => value);
      if (!label || !value.trim()) return [];
      if (value !== '.*') return [matcher(label, value, filter.operator)];
      if (filter.operator === '!=') return [];
      return [matcher(label, value, filter.operator === '=' ? '=~' : filter.operator)];
    });
    if (variable.metric) filters.unshift(matcher('__name__', variable.metric));
    options = (
      await client.promqlLabelValues(
        variable.labelName ?? '',
        { stream, start, end, ...(filters.length ? { match: [`{${filters.join(',')}}`] } : {}) },
        signal,
      )
    ).data;
  } else if (variable.type === 'promql_query') {
    const stream = resolveDataset(variable.promqlQueryDataset ?? '', values);
    if (!stream) throw new Error('Select a dataset for this variable.');
    const result = await client.promqlQuery(
      { stream, query: interpolatePromql(variable.promqlQuery ?? '', values), time: end },
      signal,
    );
    if (result.resultType === 'vector')
      options = result.result
        .map((row) =>
          variable.promqlQueryLabel ? row.metric[variable.promqlQueryLabel] : row.value[1],
        )
        .filter((value) => value !== undefined);
    else if (result.resultType === 'matrix')
      options = result.result
        .map((row) =>
          variable.promqlQueryLabel
            ? row.metric[variable.promqlQueryLabel]
            : row.values.at(-1)?.[1],
        )
        .filter((value): value is string => value !== undefined);
    else options = [result.result[1]];
  }
  options = [...new Set(options)];
  if (variable.includeAll && !['text', 'dataset'].includes(variable.type))
    options = [allValue(variable), ...options.filter((value) => value !== allValue(variable))];
  return options;
}
const fields = [
  'dataset',
  'labelName',
  'metric',
  'labelFilters',
  'options',
  'sqlQuery',
  'promqlQuery',
  'promqlQueryDataset',
  'promqlQueryLabel',
  'includeAll',
  'defaultValue',
];
export function serializeVariable(
  draft: DashboardVariable,
  original?: DashboardVariable,
): DashboardVariable {
  const result = { ...original, ...draft };
  if (original && original.type !== draft.type) {
    for (const field of typeFields[original.type])
      if (!typeFields[draft.type].includes(field)) delete result[field];
  }
  for (const field of fields)
    if (
      result[field] === '' ||
      result[field] === false ||
      result[field] == null ||
      (Array.isArray(result[field]) && !(result[field] as unknown[]).length)
    )
      delete result[field];
  return result;
}

const typeFields: Record<DashboardVariable['type'], string[]> = {
  promql: ['dataset', 'labelName', 'metric', 'labelFilters', 'includeAll'],
  promql_query: ['promqlQuery', 'promqlQueryDataset', 'promqlQueryLabel', 'includeAll'],
  sql: ['sqlQuery', 'includeAll'],
  list: ['options', 'includeAll'],
  text: [],
  dataset: [],
};
/** Only fields consumed by the option loader, without labels, defaults or extras. */
export function variableOptionsDefinition(variable: DashboardVariable) {
  return {
    type: variable.type,
    ...Object.fromEntries(typeFields[variable.type].map((field) => [field, variable[field]])),
  };
}
function variableSource(variable: DashboardVariable) {
  if (variable.type === 'sql') return variable.sqlQuery ?? '';
  if (variable.type === 'promql_query')
    return [variable.promqlQuery, variable.promqlQueryDataset].join(' ');
  if (variable.type === 'promql')
    return [variable.dataset, ...(variable.labelFilters ?? []).map((filter) => filter.value)].join(
      ' ',
    );
  return '';
}
export function setVariableType(variable: DashboardVariable, type: DashboardVariable['type']) {
  return serializeVariable({ ...variable, type }, variable);
}
export function variableDependencies(
  variable: DashboardVariable,
  variables: DashboardVariable[],
): string[] {
  return referencedVariables(variableSource(variable), variables);
}
export function variableDependencyError(variables: DashboardVariable[]): string | undefined {
  const byName = new Map(variables.map((variable) => [variable.name, variable]));
  const visited = new Set<string>(),
    visiting = new Set<string>();
  function visit(name: string): string | undefined {
    if (visiting.has(name)) return `Variable dependencies contain a cycle at ${name}.`;
    if (visited.has(name)) return;
    visiting.add(name);
    for (const dependency of variableDependencies(byName.get(name)!, variables)) {
      const error = visit(dependency);
      if (error) return error;
    }
    visiting.delete(name);
    visited.add(name);
  }
  for (const variable of variables) {
    const error = visit(variable.name);
    if (error) return error;
  }
}
