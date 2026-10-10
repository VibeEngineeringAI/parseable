import { dashboardVariable } from '../../lib/dashboardsContract';
import { matcher } from '../../lib/promql';
import type { DashboardVariable, ParseableClient, QueryRequest } from '../../lib/types';

export type VariableValues = Record<string, string | string[]>;
const placeholder = /\$\{?(\w+)\}?/g;
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
    const selection = values[name];
    return selection === undefined || (Array.isArray(selection) && !selection.length)
      ? token
      : Array.isArray(selection)
        ? `(${selection.join('|')})`
        : selection;
  });
}
export function interpolatePromql(query: string, values: VariableValues): string {
  return query
    .replace(placeholder, (token, name) => {
      const selection = values[name];
      return selection === undefined || (Array.isArray(selection) && !selection.length)
        ? token
        : Array.isArray(selection)
          ? `(${selection.map((value) => promqlEscape(regexEscape(value))).join('|')})`
          : promqlEscape(selection);
    })
    .replace(/(!?)=\s*"(\.\*)"/g, '$1=~"$2"');
}
/** Matches classic quoting rules for stream identifiers, SQL literals and comma lists. */
export function interpolateSql(
  query: string,
  values: VariableValues,
  variables: DashboardVariable[] = [],
): string {
  const datasets = variables.filter((variable) => variable.type === 'dataset');
  let resolved = query;
  for (const variable of datasets) {
    const value = values[variable.name],
      selection = Array.isArray(value) ? value[0] : value;
    if (!selection) continue;
    const name = regexEscape(variable.name),
      quoted = identifier(selection);
    resolved = resolved.replace(
      new RegExp(`"\\$\\{${name}\\}"|"\\$${name}"|\\$\\{${name}\\}|\\$${name}\\b`, 'g'),
      () => quoted,
    );
  }
  const datasetNames = new Set(datasets.map((variable) => variable.name));
  // One lexical pass prevents a value containing "$other" from being interpolated again.
  return resolved.replace(
    /'(?:''|[^'])*'|"(\$\{?(\w+)\}?)"|\$\{?(\w+)\}?/g,
    (token, quoted, name, bare) => {
      if (token.startsWith("'")) {
        const contents = token.slice(1, -1),
          exact = /^\$\{?(\w+)\}?$/.exec(contents);
        if (exact && !datasetNames.has(exact[1])) {
          const value = values[exact[1]];
          if (value === undefined || (Array.isArray(value) && !value.length)) return token;
          return (Array.isArray(value) ? value : [value])
            .map((value) => `'${sqlEscape(value)}'`)
            .join(',');
        }
        return `'${contents.replace(placeholder, (token, name) => {
          if (datasetNames.has(name)) return token;
          const value = values[name],
            selection = Array.isArray(value) ? value[0] : value;
          return selection === undefined ? token : sqlEscape(selection);
        })}'`;
      }
      const variable = name ?? bare;
      if (!variable || datasetNames.has(variable)) return token;
      const value = values[variable];
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
  return options.find((value) => value !== allValue(variable)) ?? options[0] ?? '';
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
  const source = [
    variable.dataset,
    variable.sqlQuery,
    variable.promqlQuery,
    variable.promqlQueryDataset,
    ...(variable.labelFilters ?? []).map((filter) => filter.value),
  ].join(' ');
  return Object.fromEntries(
    [...source.matchAll(/\$\{?(\w+)\}?/g)]
      .map((match) => [match[1], values[match[1]]])
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
    const filters = (variable.labelFilters ?? []).map((filter) =>
      matcher(filter.label, interpolatePromql(filter.value, values), filter.operator),
    );
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
    options = [...options.filter((value) => value !== allValue(variable)), allValue(variable)];
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
