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
    expect(defaultSelection(v, ['a', 'b', '*'], '*')).toBe('*');
    expect(defaultSelection(v, ['a', 'b'], null)).toBe('b');
    expect(defaultSelection({ ...v, defaultValue: undefined }, ['a', 'b'], null)).toBe('a');
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
    ).toEqual(['a', 'b', '*']);
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
    ).toEqual(['a', 'b', '*']);
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
    ).toEqual(['node-a', 'node-b', '.*']);
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
