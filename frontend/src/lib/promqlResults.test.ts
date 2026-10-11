import { describe, expect, it } from 'vitest';
import { promqlTableRows, type QueryResult } from './promqlResults';

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
