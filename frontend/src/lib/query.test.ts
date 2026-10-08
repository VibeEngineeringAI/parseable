import { describe, expect, it } from 'vitest';
import { buildLogQuery, quoteIdentifier, timeBounds } from './query';
import { createDemoRecords, executeDemoQuery } from './demo';

const now = Date.parse('2026-10-06T12:00:00Z');
const bounds = timeBounds('15m', now + 1);
describe('query construction', () => {
  it('escapes SQL identifiers, values and literal search wildcards', () => {
    const sql = buildLogQuery('a"; DROP TABLE x;--', "50%_! O'Reilly", [
      { id: '1', field: 'user"name', operator: '=', value: "x' OR 1=1--" },
    ]);
    expect(sql).toContain('FROM "a""; DROP TABLE x;--"');
    expect(sql).toContain('"user""name" = \'x\'\' OR 1=1--\'');
    expect(sql).toContain("ILIKE '%50!%!_!! O''Reilly%' ESCAPE '!'");
  });
  it('validates and normalizes absolute ranges independently of refresh time', () => {
    const range = { startTime: '2026-10-06T11:00:00Z', endTime: '2026-10-06T12:00:00Z' };
    expect(timeBounds(range, now + 3600000)).toEqual({
      startTime: '2026-10-06T11:00:00.000Z',
      endTime: '2026-10-06T12:00:00.000Z',
    });
    expect(() => timeBounds({ ...range, startTime: range.endTime })).toThrow('Invalid time range');
    expect(() => timeBounds({ ...range, endTime: 'not a date' })).toThrow('Invalid time range');
  });
  it('validates row limits and computes exact UTC ranges', () => {
    expect(() => buildLogQuery('logs', '', [], -1)).toThrow('Limit');
    expect(() => buildLogQuery('logs', '', [], 1.5)).toThrow('Limit');
    expect(() => quoteIdentifier('')).toThrow();
    expect(timeBounds('1h', now)).toEqual({
      startTime: '2026-10-06T11:00:00.000Z',
      endTime: '2026-10-06T12:00:00.000Z',
    });
  });
});

describe('demo query semantics', () => {
  it('applies filters, literal search, descending order, limit and time bounds', () => {
    const records = createDemoRecords(now);
    const sql = buildLogQuery(
      'application_logs',
      'UPSTREAM',
      [{ id: '1', field: 'level', operator: '=', value: 'ERROR' }],
      3,
    );
    const result = executeDemoQuery({ sql, ...bounds }, records);
    expect(result).toHaveLength(3);
    expect(result.every((row) => row.level === 'ERROR')).toBe(true);
    expect(result[0].p_timestamp).toBe(new Date(now).toISOString());
    expect(
      executeDemoQuery(
        {
          sql,
          startTime: new Date(now + 1).toISOString(),
          endTime: new Date(now + 2).toISOString(),
        },
        records,
      ),
    ).toEqual([]);
  });
  it('handles wildcards and quotes as literal search characters', () => {
    const records = [{ ...createDemoRecords(now)[0], message: "Paid 50%_! O'Reilly" }];
    const sql = buildLogQuery('application_logs', "50%_! O'Reilly", []);
    expect(executeDemoQuery({ sql, ...bounds }, records)).toHaveLength(1);
    expect(
      executeDemoQuery({ sql, ...bounds }, [{ ...records[0], message: 'Paid 50 other' }]),
    ).toHaveLength(0);
  });
  it('rejects unsupported statements rather than silently approximating them', () => {
    for (const sql of [
      'DELETE FROM application_logs',
      'SELECT count(*) FROM application_logs',
      "SELECT * FROM application_logs WHERE level = 'ERROR' OR 1=1",
      'SELECT * FROM application_logs; SELECT * FROM api_logs',
      'SELECT * FROM application_logs LIMIT 1 trailing',
      "SELECT * FROM application_logs WHERE AND level = 'ERROR'",
    ]) {
      expect(() => executeDemoQuery({ sql, ...bounds }, createDemoRecords(now))).toThrow(
        'Demo SQL supports',
      );
    }
  });
});
