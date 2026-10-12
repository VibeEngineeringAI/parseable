import { describe, expect, it } from 'vitest';
import { ownsSavedLogView, savedLogViewBody, savedLogViewState } from './SavedViews';
import { canShowContext, contextField } from './LogContext';
import type { LogViewState } from './logViewState';

const state: LogViewState = {
  version: 1,
  dataset: 'app',
  range: '1h',
  search: "can't",
  expression: { combinator: 'and', groups: [] },
  timezone: 'UTC',
  limit: 100,
  wrap: false,
  showHistogram: true,
};
describe('server saved views', () => {
  it('allows mutations only for a verified owner; dataset access and missing ownership do not grant ownership', () => {
    const view = { ...savedLogViewBody(state, 'Other'), user_id: 'alice-hash' };
    expect(ownsSavedLogView(view, 'alice-hash')).toBe(true);
    expect(ownsSavedLogView(view, 'bob-hash')).toBe(false);
    expect(ownsSavedLogView(view, undefined)).toBe(false);
    expect(ownsSavedLogView(savedLogViewBody(state, 'Missing owner'), 'alice-hash')).toBe(false);
    expect(ownsSavedLogView({ ...view, user_id: 'demo' }, undefined, true)).toBe(true);
    expect(ownsSavedLogView(view, undefined, true)).toBe(false);
  });
  it('round trips state and builds escaped compatible SQL', () => {
    const view = savedLogViewBody(state, '  Incidents  ');
    expect(view.filter_name).toBe('Incidents');
    expect(view.query.filter_type).toBe('sql');
    expect(view.query.filter_query).toContain("can''t");
    expect(savedLogViewState(view)).toEqual(state);
  });
  it('preserves unrelated server metadata while updating state and time metadata', () => {
    const previous = {
      ...savedLogViewBody(state, 'Old'),
      filter_id: '01id',
      labels: ['incident'],
      time_filter: { from: 'old', to: 'old' },
    };
    const next = savedLogViewBody({ ...state, wrap: true }, 'New', previous);
    expect(next.filter_id).toBe('01id');
    expect(next.labels).toEqual(['incident']);
    expect(next.time_filter).toBeNull();
    expect(savedLogViewState(next).wrap).toBe(true);
  });
  it('rejects classic formats and mismatched dataset metadata', () => {
    const { explorer_state: _state, ...classic } = savedLogViewBody(state, 'Classic');
    expect(() => savedLogViewState(classic)).toThrow('classic');
    expect(() =>
      savedLogViewState({ ...savedLogViewBody(state, 'Mismatch'), stream_name: 'other' }),
    ).toThrow('inconsistent');
  });
  it('validates names and saves absolute bounds for classic clients', () => {
    expect(() => savedLogViewBody(state, ' ')).toThrow('view name');
    const range = { startTime: '2026-10-12T10:00:00Z', endTime: '2026-10-12T11:00:00Z' };
    expect(savedLogViewBody({ ...state, range }, 'Absolute').time_filter).toEqual({
      from: range.startTime,
      to: range.endTime,
    });
  });
});

describe('context anchor fields', () => {
  it('uses the first string field and skips nonstring values', () => {
    const row = {
      p_timestamp: '2026-10-12T10:00:00Z',
      message: { nested: true },
      body: 'body',
      log: 'log',
    };
    expect(contextField(row)).toBe('body');
    expect(canShowContext(row)).toBe(true);
    expect(contextField({ ...row, message: '' })).toBe('message');
    expect(contextField({ ...row, body: 1, log: null })).toBeUndefined();
    expect(canShowContext({ ...row, p_timestamp: 'invalid' })).toBe(false);
  });
});
