import { describe, expect, it } from 'vitest';
import { initialLogView, logViewReducer } from './logViewReducer';

describe('log view transitions', () => {
  const bounds = { startTime: '2026-10-01T10:00:00.000Z', endTime: '2026-10-01T11:00:00.000Z' };
  const expression = {
    combinator: 'and' as const,
    groups: [
      {
        id: 'group',
        combinator: 'and' as const,
        rules: [{ id: 'rule', field: 'host', operator: '=' as const, value: 'a' }],
      },
    ],
  };

  it('resets dataset-specific criteria while preserving time and display preferences', () => {
    const previous = {
      ...initialLogView('a'),
      range: bounds,
      expression,
      search: 'old',
      columns: ['host'],
      limit: 1000,
      timezone: 'America/Chicago',
      wrap: true,
      showHistogram: false,
    };
    const next = logViewReducer(previous, { type: 'resetDataset', dataset: 'b' });
    expect(next).toEqual({
      ...previous,
      dataset: 'b',
      expression: { combinator: 'and', groups: [] },
      search: '',
      columns: undefined,
      limit: 100,
    });
    expect(next.range).toBe(bounds);
  });

  it('applies a view atomically and preserves its exact captured bounds', () => {
    const view = {
      ...initialLogView('b'),
      range: bounds,
      expression,
      search: 'saved',
      limit: 5000,
    };
    const next = logViewReducer(initialLogView('a'), { type: 'applyView', view });
    expect(next).toBe(view);
    expect(logViewReducer(next, { type: 'edit', patch: { wrap: true } }).range).toBe(bounds);
  });

  it('applies classic criteria after a dataset reset and clears typed search', () => {
    const previous = {
      ...initialLogView('a'),
      search: 'typed',
      wrap: true,
      timezone: 'America/Chicago',
    };
    const reset = logViewReducer(previous, { type: 'resetDataset', dataset: 'b' });
    const next = logViewReducer(reset, { type: 'applyClassic', range: bounds, expression });
    expect(next).toEqual({ ...reset, range: bounds, expression, timezone: 'UTC', search: '' });
  });
});
