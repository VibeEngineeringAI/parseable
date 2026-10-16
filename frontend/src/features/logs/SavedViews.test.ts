import { describe, expect, it } from 'vitest';
import {
  ownsSavedLogView,
  savedLogViewBody,
  savedLogViewState,
  savedLogViewsForDataset,
} from './SavedViews';
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
  it('opens canonical SQL views using their explorer dataset and preserves conversion on update', () => {
    const legacy = savedLogViewBody(state, 'Legacy');
    expect(legacy.stream_name).toBe('app');
    const canonical = { ...legacy, stream_name: 'sql', filter_id: 'same-id', user_id: 'owner' };
    expect(savedLogViewState(canonical)).toEqual(state);
    const updated = savedLogViewBody({ ...state, search: 'new search' }, 'New', canonical);
    expect(updated).toMatchObject({ stream_name: 'sql', filter_id: 'same-id', user_id: 'owner' });
    expect(savedLogViewState(updated).search).toBe('new search');
    expect(savedLogViewBody(state, 'Copy').stream_name).toBe('app');
  });
  it('lists native views by their decoded dataset while retaining dataset-scoped classic entries', () => {
    const legacy = savedLogViewBody(state, 'Legacy');
    const canonical = { ...legacy, stream_name: 'sql', filter_name: 'Canonical' };
    const { explorer_state: _state, ...classic } = { ...legacy, filter_name: 'Classic' };
    const available = savedLogViewsForDataset(
      [
        legacy,
        canonical,
        classic,
        {
          ...canonical,
          filter_name: 'Other dataset',
          explorer_state: JSON.stringify({ ...state, dataset: 'other' }),
        },
        { ...canonical, filter_name: 'Broken JSON', explorer_state: '{' },
        { ...canonical, filter_name: 'Invalid state', explorer_state: '{}' },
        { ...classic, stream_name: 'sql' },
        { ...classic, stream_name: 'other' },
      ],
      'app',
    );
    expect(available.map(({ view }) => view.filter_name)).toEqual([
      'Legacy',
      'Canonical',
      'Classic',
    ]);
    expect(available.map(({ decoded }) => decoded?.dataset)).toEqual(['app', 'app', undefined]);
    expect(savedLogViewsForDataset([canonical], 'sql')).toEqual([]);
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
