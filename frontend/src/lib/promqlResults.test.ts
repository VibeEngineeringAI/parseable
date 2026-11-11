import { describe, expect, it } from 'vitest';
import {
  applyQueryAliases,
  chartResults,
  promqlTableRows,
  type QueryResult,
} from './promqlResults';

const result = (id: string, data: Partial<QueryResult>): QueryResult => ({
  id,
  pending: 0,
  errors: [],
  ...data,
});
const range = result('A', {
  range: {
    resultType: 'matrix',
    result: [
      {
        metric: { host: 'a' },
        values: [
          [1, '1'],
          [2, '2'],
        ],
      },
    ],
  },
});
const instant = result('B', {
  instant: { resultType: 'vector', result: [{ metric: { host: 'b' }, value: [2, '5'] }] },
});

describe('PromQL query aliases', () => {
  it('names empty aggregate labels while preserving series IDs, data and vector dimensions', () => {
    const queries = [
      result('A', {
        range: { resultType: 'matrix', result: [{ metric: {}, values: [[1, '3.5']] }] },
      }),
      result('B', { range: range.range }),
    ];
    const original = chartResults(queries, 2);
    const named = applyQueryAliases(original.series, {
      A: '1-minute average',
      B: '5-minute average',
    });
    expect(named.map((row) => row.label)).toEqual([
      '1-minute average',
      '5-minute average: {host="a"}',
    ]);
    expect(named.map(({ label: _label, ...row }) => row)).toEqual(
      original.series.map(({ label: _label, ...row }) => row),
    );
    expect(original.series[0].label).toBe('A: {}');
  });

  it('keeps default labels for missing, blank and malformed aliases, and supports a single query', () => {
    const series = [{ id: ':{}', label: '{}', values: [3] }];
    expect(applyQueryAliases(series, { A: '  1 minute  ' }, 'A')[0].label).toBe('1 minute');
    for (const aliases of [{}, { A: '' }, { A: ' ' }, { A: 5 }, { A: {} }])
      expect(applyQueryAliases(series, aliases, 'A')[0]).toBe(series[0]);
  });
});

describe('promqlTableRows', () => {
  it('keeps range rows when another query is instant', () => {
    expect(promqlTableRows([range, instant])).toEqual([
      { Query: 'A', host: 'a', time: '1970-01-01T00:00:01.000Z', Value: 1 },
      { Query: 'A', host: 'a', time: '1970-01-01T00:00:02.000Z', Value: 2 },
      { Query: 'B', Series: '{host="b"}', Value: 5 },
    ]);
  });
  it('prefers the instant result of each query and keeps the single-mode shapes', () => {
    const both = result('A', { range: range.range, instant: instant.instant });
    expect(promqlTableRows([both, instant])).toEqual([
      { Series: 'A: {host="b"}', Value: 5 },
      { Series: 'B: {host="b"}', Value: 5 },
    ]);
    expect(promqlTableRows([instant, result('C', {})])).toEqual([
      { Series: 'B: {host="b"}', Value: 5 },
    ]);
    expect(promqlTableRows([range])).toEqual([
      { Query: 'A', host: 'a', time: '1970-01-01T00:00:01.000Z', Value: 1 },
      { Query: 'A', host: 'a', time: '1970-01-01T00:00:02.000Z', Value: 2 },
    ]);
  });
});
