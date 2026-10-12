import { expect, it } from 'vitest';
import {
  buildExplorerQuery,
  buildHistogramQuery,
  histogramBuckets,
  type LogFilterExpression,
} from './logQuery';
import { executeDemoQuery } from './demo';
const bounds = { startTime: '2026-10-06T00:00:00Z', endTime: '2026-10-06T01:00:00Z' };
const empty: LogFilterExpression = { combinator: 'and', groups: [] };
it('counts beyond returned limits and fills 48 buckets', () => {
  const rows = Array.from({ length: 250 }, (_, i) => ({
    p_timestamp: new Date(Date.parse(bounds.startTime) + i * 1000).toISOString(),
    message: 'ok',
  }));
  expect(
    executeDemoQuery(
      { sql: buildExplorerQuery('application_logs', '', empty, 100), ...bounds },
      rows,
    ),
  ).toHaveLength(100);
  const sql = buildHistogramQuery('application_logs', '', empty, bounds);
  expect(sql).not.toContain('LIMIT');
  const result = histogramBuckets(executeDemoQuery({ sql, ...bounds }, rows), bounds);
  expect(result.total).toBe(250);
  expect(result.bins).toHaveLength(48);
  expect(result.bins[47]).toBe(0);
});
it('groups OR branches and applies escaped search to all branches', () => {
  const expression: LogFilterExpression = {
    combinator: 'or',
    groups: [
      {
        id: 'a',
        combinator: 'and',
        rules: [
          { id: '1', field: 'level', operator: '=', value: 'ERROR' },
          { id: '2', field: 'service', operator: '=', value: 'api' },
        ],
      },
      {
        id: 'b',
        combinator: 'or',
        rules: [{ id: '3', field: 'service', operator: '=', value: "O'Reilly" }],
      },
    ],
  };
  const rows = [
    { level: 'ERROR', service: 'api', message: '50%_!' },
    { level: 'INFO', service: "O'Reilly", message: '50%_!' },
    { level: 'ERROR', service: 'worker', message: '50%_!' },
    { level: 'ERROR', service: 'api', message: 'other' },
  ].map((row) => ({ ...row, p_timestamp: bounds.startTime }));
  const sql = buildExplorerQuery('application_logs', '50%_!', expression);
  expect(sql).toContain("'O''Reilly'");
  expect(executeDemoQuery({ sql, ...bounds }, rows)).toHaveLength(2);
});
it('supports timestamp partition fields and exclusive upper bound', () => {
  const rows = [
    { p_timestamp: bounds.startTime, event_time: bounds.endTime },
    { p_timestamp: bounds.startTime, event_time: bounds.startTime },
  ];
  const sql = buildHistogramQuery('application_logs', '', empty, bounds, 'event_time');
  expect(histogramBuckets(executeDemoQuery({ sql, ...bounds }, rows), bounds).total).toBe(1);
  expect(buildExplorerQuery('application_logs', '', empty, 100, 'event_time', bounds)).toContain(
    'ORDER BY "event_time"',
  );
});
it('ignores empty groups and validates aggregate data and expression limits', () => {
  expect(
    buildExplorerQuery('application_logs', '', {
      combinator: 'and',
      groups: [{ id: 'e', combinator: 'or', rules: [] }],
    }),
  ).not.toContain('WHERE');
  expect(histogramBuckets([], bounds).total).toBe(0);
  for (const count of [-1, 1.5, '3', NaN])
    expect(() => histogramBuckets([{ bucket_start: bounds.startTime, count }], bounds)).toThrow(
      'Invalid histogram',
    );
  expect(() => histogramBuckets([{ bucket_start: bounds.endTime, count: 1 }], bounds)).toThrow();
  expect(() =>
    buildExplorerQuery('logs', '', {
      combinator: 'and',
      groups: Array.from({ length: 13 }, () => ({ id: 'x', combinator: 'and', rules: [] })),
    }),
  ).toThrow('Too many');
});
