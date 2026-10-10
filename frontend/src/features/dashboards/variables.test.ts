import { describe, expect, it, vi } from 'vitest';
import {
  allValue,
  defaultSelection,
  hasAllSelection,
  interpolate,
  interpolatePromql,
  interpolateSql,
  loadVariableOptions,
  resolveDataset,
  serializeVariable,
  readVariables,
  setVariableType,
  variableDependencyError,
  variableInputs,
  variableDependencies,
  variableOptionsDefinition,
} from './variables';
import type { DashboardVariable, ParseableClient } from '../../lib/types';
const dataset: DashboardVariable = { name: 'ds', label: 'Dataset', type: 'dataset' };
const bounds = { startTime: '2026-10-10T00:00:00Z', endTime: '2026-10-10T01:00:00Z' };
describe('classic interpolation', () => {
  it('supports both placeholder forms, array alternations, unresolved and empty arrays', () => {
    expect(interpolate('$v ${v} $other', { v: ['a', 'b'] })).toBe('(a|b) (a|b) $other');
    expect(interpolate('$v', { v: [] })).toBe('$v');
    expect(resolveDataset('$ds', { ds: 'metrics' })).toBe('metrics');
    expect(resolveDataset('$ds', {})).toBe('');
  });
  it('escapes PromQL strings, regex arrays and classic All operators', () => {
    expect(interpolatePromql('up{host="$v"}', { v: 'a"\n\r\t\\' })).toBe(
      'up{host="a\\"\\n\\r\\t\\\\"}',
    );
    expect(interpolatePromql('up{host=~"${v}"}', { v: ['a.b', 'c|d'] })).toBe(
      'up{host=~"(a\\\\.b|c\\\\|d)"}',
    );
    expect(interpolatePromql('up{host="$v",region!="$v"}', { v: '.*' })).toBe(
      'up{host=~".*",region!=~".*"}',
    );
  });
  it('quotes dataset identifiers, SQL literals, arrays and embedded literal values', () => {
    const values = { ds: 'a"b', host: ["a'b", 'c'], word: "x'y" };
    expect(
      interpolateSql(
        "SELECT * FROM \"$ds\" WHERE host IN ('$host') AND message='prefix ${word}'",
        values,
        [dataset],
      ),
    ).toBe("SELECT * FROM \"a\"\"b\" WHERE host IN ('a''b','c') AND message='prefix x''y'");
    expect(interpolateSql('SELECT "$host" FROM ${ds}', values, [dataset])).toBe(
      'SELECT "a\'b","c" FROM "a""b"',
    );
    expect(interpolateSql("SELECT '$v'", { v: '$other', other: 'injected' })).toBe(
      "SELECT '$other'",
    );
  });
  it('leaves unknown dollar tokens untouched in generic, SQL and PromQL interpolation', () => {
    const sql =
      "SELECT '$ $1 $unknown ${missing} $__interval $toString $constructor $__proto__', '$host' FROM logs";
    const promql =
      'label_replace(up{host="$host"}, "copy", "$1", "host", "(.*)$") + $__interval + $unknown + ${missing}';
    expect(interpolate(sql, { host: 'node-a' })).toBe(sql.replace('$host', 'node-a'));
    expect(interpolateSql(sql, { host: 'node-a' })).toBe(sql.replace('$host', 'node-a'));
    expect(interpolatePromql(promql, { host: 'node-a' })).toBe(promql.replace('$host', 'node-a'));
  });
  it('preserves unknown definitions and omits empty classic fields', () => {
    expect(
      serializeVariable(
        { name: 'v', label: 'V', type: 'text', defaultValue: '', includeAll: false },
        { name: 'v', label: 'Old', type: 'text', future: 1 },
      ),
    ).toEqual({ name: 'v', label: 'V', type: 'text', future: 1 });
  });
  it('chooses URL, default or first and uses the correct All sentinel', () => {
    const v: DashboardVariable = {
      name: 'v',
      label: 'V',
      type: 'list',
      defaultValue: 'b',
      includeAll: true,
    };
    expect(defaultSelection(v, ['*', 'a', 'b'], '*')).toBe('*');
    expect(defaultSelection(v, ['a', 'b'], null)).toBe('b');
    expect(defaultSelection({ ...v, defaultValue: undefined }, ['a', 'b'], null)).toBe('a');
    expect(defaultSelection({ ...v, defaultValue: undefined }, ['*', 'a', 'b'], null)).toBe('*');
    expect(allValue({ ...v, type: 'promql_query' })).toBe('.*');
    expect(hasAllSelection([v], { v: '*' }, "SELECT '$v'", 'logs')).toBe(true);
    expect(hasAllSelection([v], { v: '*' }, 'SELECT 1', 'logs')).toBe(false);
  });
});
describe('variable option sources', () => {
  it('loads every source with concrete queries, ranges and abort signals', async () => {
    const c = {
      listDatasets: vi.fn().mockResolvedValue([{ name: 'logs' }]),
      query: vi
        .fn()
        .mockResolvedValue([{ first: 'a', second: 'ignored' }, { first: 'a' }, { first: 'b' }]),
      promqlLabelValues: vi.fn().mockResolvedValue({ data: ['node-a', 'node-b'] }),
      promqlQuery: vi.fn().mockResolvedValue({
        resultType: 'vector',
        result: [{ metric: { host: 'node-a' }, value: [0, '1'] }],
      }),
    } as unknown as ParseableClient;
    const signal = new AbortController().signal,
      v = { name: 'v', label: 'V' },
      values = { ds: 'metrics', host: 'node-a' };
    expect(
      await loadVariableOptions(c, { ...v, type: 'dataset' }, values, [dataset], bounds, signal),
    ).toEqual(['logs']);
    expect(
      await loadVariableOptions(
        c,
        { ...v, type: 'list', options: ['a', 'b'], includeAll: true },
        values,
        [],
        bounds,
        signal,
      ),
    ).toEqual(['*', 'a', 'b']);
    expect(
      await loadVariableOptions(c, { ...v, type: 'text' }, values, [], bounds, signal),
    ).toEqual([]);
    expect(
      await loadVariableOptions(
        c,
        { ...v, type: 'sql', sqlQuery: 'SELECT host FROM $ds', includeAll: true },
        values,
        [dataset],
        bounds,
        signal,
      ),
    ).toEqual(['*', 'a', 'b']);
    expect(c.query).toHaveBeenCalledWith({ sql: 'SELECT host FROM "metrics"', ...bounds }, signal);
    expect(
      await loadVariableOptions(
        c,
        { ...v, type: 'promql', dataset: '$ds', labelName: 'host', metric: 'up', includeAll: true },
        values,
        [dataset],
        bounds,
        signal,
      ),
    ).toEqual(['.*', 'node-a', 'node-b']);
    expect(c.promqlLabelValues).toHaveBeenCalledWith(
      'host',
      expect.objectContaining({ stream: 'metrics', match: ['{__name__="up"}'] }),
      signal,
    );
    expect(
      await loadVariableOptions(
        c,
        {
          ...v,
          type: 'promql_query',
          promqlQueryDataset: '$ds',
          promqlQuery: 'up{host="$host"}',
          promqlQueryLabel: 'host',
        },
        values,
        [dataset],
        bounds,
        signal,
      ),
    ).toEqual(['node-a']);
    expect(c.promqlQuery).toHaveBeenCalledWith(
      { stream: 'metrics', query: 'up{host="node-a"}', time: Date.parse(bounds.endTime) / 1000 },
      signal,
    );
  });
});

it('removes only known old variable-type fields and preserves unknown definitions in the document', () => {
  const sql: DashboardVariable = {
    name: 'v',
    label: 'V',
    type: 'sql',
    sqlQuery: 'SELECT 1',
    future: 42,
    defaultValue: 'x',
    includeAll: true,
  };
  expect(setVariableType(sql, 'text')).toEqual({
    name: 'v',
    label: 'V',
    type: 'text',
    future: 42,
    defaultValue: 'x',
  });
  expect(serializeVariable({ ...sql, type: 'list', options: ['x'] }, sql)).toEqual({
    name: 'v',
    label: 'V',
    type: 'list',
    future: 42,
    defaultValue: 'x',
    includeAll: true,
    options: ['x'],
  });
  const definitions = [sql, { name: 'f', type: 'future', unknown: true }];
  expect(readVariables(definitions)).toEqual([sql]);
  expect(definitions[1]).toEqual({ name: 'f', type: 'future', unknown: true });
});
it('allows unknown tokens and rejects self references and cycles only in option definitions', () => {
  const a: DashboardVariable = { name: 'a', label: 'A', type: 'sql', sqlQuery: "SELECT '$b'" };
  const b: DashboardVariable = { name: 'b', label: 'B', type: 'text' };
  expect(variableDependencyError([a, b])).toBeUndefined();
  expect(variableDependencyError([a])).toBeUndefined();
  expect(variableDependencyError([{ ...a, name: 'b' }])).toBe(
    'Variable dependencies contain a cycle at b.',
  );
  expect(variableDependencyError([a, { ...b, type: 'sql', sqlQuery: "SELECT '$a'" }])).toContain(
    'cycle',
  );
  const list: DashboardVariable = {
    name: 'list',
    label: 'List',
    type: 'list',
    options: ['one'],
    sqlQuery: "SELECT '$missing'",
  };
  expect(variableInputs(list, { missing: 'value' })).toEqual({});
  expect(variableDependencies(list, [list])).toEqual([]);
  expect(variableDependencyError([list])).toBeUndefined();
  expect(
    variableOptionsDefinition({ ...a, label: 'Renamed', defaultValue: 'new', unknown: 7 }),
  ).toEqual(variableOptionsDefinition(a));
});
it('filters dependencies to existing variables across SQL, PromQL, datasets and label filters', () => {
  const host: DashboardVariable = { name: 'host', label: 'Host', type: 'text' };
  const definitions: DashboardVariable[] = [
    dataset,
    host,
    {
      name: 'sql',
      label: 'SQL',
      type: 'sql',
      sqlQuery: "SELECT '$ $1 $unknown $__interval $host' FROM $ds",
    },
    {
      name: 'result',
      label: 'Result',
      type: 'promql_query',
      promqlQueryDataset: '$ds',
      promqlQuery: 'label_replace(up{host="$host"}, "copy", "$1", "host", "(.*)$") + $__interval',
    },
    {
      name: 'filtered',
      label: '$unknown',
      type: 'promql',
      dataset: '$ds',
      labelName: 'host',
      labelFilters: [{ label: 'host', operator: '=~', value: '$host|node$unknown$' }],
    },
    { name: 'literal', label: '$host', type: 'text', defaultValue: '$host', future: '$literal' },
    { name: 'list', label: 'List', type: 'list', options: ['$list', '$unknown'] },
  ];
  expect(variableDependencies(definitions[2], definitions)).toEqual(['host', 'ds']);
  expect(variableDependencies(definitions[3], definitions)).toEqual(['host', 'ds']);
  expect(variableDependencies(definitions[4], definitions)).toEqual(['ds', 'host']);
  expect(variableDependencies(definitions[5], definitions)).toEqual([]);
  expect(variableDependencies(definitions[6], definitions)).toEqual([]);
  expect(variableDependencyError(definitions)).toBeUndefined();
  expect(variableDependencyError([{ ...definitions[3], promqlQueryDataset: '$result' }])).toContain(
    'cycle',
  );
  expect(
    variableDependencyError([
      { ...definitions[4], labelFilters: [{ label: 'host', operator: '=~', value: '$filtered' }] },
    ]),
  ).toContain('cycle');
});
it('interpolates SQL All and variable name prefixes exactly', () => {
  expect(interpolateSql("SELECT '$host', '$hostname'", { host: '*', hostname: 'api' })).toBe(
    "SELECT '*', 'api'",
  );
  expect(interpolatePromql('up{host="$host",name="$hostname"}', { host: 'a', hostname: 'b' })).toBe(
    'up{host="a",name="b"}',
  );
});
