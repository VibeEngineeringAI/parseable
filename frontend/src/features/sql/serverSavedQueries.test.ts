import { describe, expect, it } from 'vitest';
import { savedLogView } from '../../lib/logsContract';
import type { SavedLogView } from '../../lib/types';
import { encodeLogView, type LogViewState } from '../logs/logViewState';
import { saveQuery, type SavedQuery } from './savedQueries';
import {
  classicTimeRange,
  importServerQuery,
  serverSavedQueries,
  serverSavedQuery,
  sqlEditorHandoff,
  sqlHandoffRange,
} from './serverSavedQueries';

// Shapes as stored by classic Prism and returned by GET /api/v1/filters.
const classicSql: SavedLogView = {
  version: 'v2',
  user_id: 'owner-hash',
  stream_name: 'sql',
  filter_name: 'Slow requests',
  filter_id: '01HCLASSICSQL',
  query: {
    filter_type: 'sql',
    filter_query: 'SELECT * FROM "app" WHERE latency > 500',
    filter_builder: null,
  },
  time_filter: { from: '2026-10-01T00:00:00.000Z', to: '2026-10-02T00:00:00.000Z' },
  tenant_id: null,
};
const classicLogsSql: SavedLogView = {
  version: 'v1',
  user_id: 'other-hash',
  stream_name: 'app',
  filter_name: 'App errors',
  filter_id: '01HCLASSICLOGS',
  query: { filter_type: 'sql', filter_query: "SELECT * FROM app WHERE level = 'error'" },
  time_filter: { from: 'now-1h', to: 'now' },
};
const nativeState: LogViewState = {
  version: 1,
  dataset: 'app',
  range: '7d',
  search: '',
  expression: { combinator: 'and', groups: [] },
  timezone: 'UTC',
  limit: 500,
  wrap: false,
  showHistogram: true,
};
// A native Logs view saved with a relative range keeps it only in explorer_state.
const nativeLogsSql: SavedLogView = {
  version: 'v2',
  user_id: 'owner-hash',
  stream_name: 'sql',
  filter_name: 'Native week',
  filter_id: '01HNATIVE',
  query: {
    filter_type: 'sql',
    filter_query: 'SELECT * FROM "app" LIMIT 500',
    filter_builder: null,
  },
  explorer_state: encodeLogView(nativeState),
  time_filter: null,
};
const classicBuilder: SavedLogView = {
  version: 'v2',
  user_id: 'owner-hash',
  stream_name: 'app',
  filter_name: 'Builder',
  filter_id: '01HBUILDER',
  query: {
    filter_type: 'filter',
    filter_query: null,
    filter_builder: {
      id: 'root',
      combinator: 'and',
      rules: [
        {
          id: 'g',
          combinator: 'and',
          rules: [{ id: 'r', field: 'level', value: 'error', operator: '=' }],
        },
      ],
    },
  },
  time_filter: null,
};
const classicSearch: SavedLogView = {
  ...classicBuilder,
  filter_id: '01HSEARCH',
  query: { filter_type: 'search', filter_query: 'timeout' },
};

describe('server saved SQL queries', () => {
  it('ignores saved PromQL filters', () => {
    const promql: SavedLogView = {
      ...classicSearch,
      filter_id: '01HPROMQL',
      stream_name: 'otel_metrics',
      query: { filter_type: 'promql', filter_query: 'sum(rate(http_requests_total[5m]))' },
    };
    expect(savedLogView(promql)).toBe(true);
    expect(serverSavedQuery(promql)).toBeUndefined();
    expect(serverSavedQueries([promql])).toEqual([]);
  });
  it('accepts the real classic fixtures through the client contract', () => {
    for (const view of [classicSql, classicLogsSql, nativeLogsSql, classicBuilder, classicSearch])
      expect(savedLogView(view)).toBe(true);
  });
  it('reads classic SQL editor queries with their saved bounds and no dataset scope', () => {
    expect(serverSavedQuery(classicSql)).toEqual({
      key: JSON.stringify(['owner-hash', '01HCLASSICSQL']),
      filterId: '01HCLASSICSQL',
      name: 'Slow requests',
      sql: 'SELECT * FROM "app" WHERE latency > 500',
      range: { startTime: '2026-10-01T00:00:00.000Z', endTime: '2026-10-02T00:00:00.000Z' },
      rangeFallback: false,
      datasets: [],
      origin: 'sql',
      ownerHash: 'owner-hash',
    });
  });
  it('marks Logs-origin SQL and keeps a supported classic relative window', () => {
    expect(serverSavedQuery(classicLogsSql)).toMatchObject({
      origin: 'logs',
      datasets: ['app'],
      range: '1h',
      rangeFallback: false,
      sql: classicLogsSql.query.filter_query,
    });
    // A converted native Logs view keeps explorer_state and stays Logs-origin.
    expect(serverSavedQuery({ ...classicSql, explorer_state: '{"version":1}' })?.origin).toBe(
      'logs',
    );
  });
  it('maps classic relative presets and flags unsupported windows instead of guessing', () => {
    expect(classicTimeRange('now-7d', 'now')).toBe('7d');
    expect(classicTimeRange('now-1w', 'now')).toBe('7d');
    expect(classicTimeRange('now-24h', 'now')).toBe('24h');
    expect(classicTimeRange('now-1d', 'now')).toBe('1d');
    expect(classicTimeRange('now-60m', 'now')).toBe('1h');
    expect(classicTimeRange('now-2d', 'now')).toBeUndefined();
    expect(classicTimeRange('now-7d', 'now-1d')).toBeUndefined();
    const week = serverSavedQuery({
      ...classicLogsSql,
      time_filter: { from: 'now-7d', to: 'now' },
    });
    expect(week).toMatchObject({ range: '7d', rangeFallback: false });
    expect(week).not.toHaveProperty('savedRange');
    const twoDays = { ...classicLogsSql, time_filter: { from: 'now-2d', to: 'now' } };
    expect(serverSavedQuery(twoDays)).toMatchObject({
      range: '1h',
      rangeFallback: true,
      savedRange: 'now-2d to now',
      sql: classicLogsSql.query.filter_query,
    });
  });
  it('honors a valid native explorer state range and dataset over the empty time filter', () => {
    expect(serverSavedQuery(nativeLogsSql)).toMatchObject({
      origin: 'logs',
      range: '7d',
      rangeFallback: false,
      datasets: ['app'],
      sql: nativeLogsSql.query.filter_query,
    });
    const absolute = {
      ...nativeState,
      range: { startTime: '2026-10-01T00:00:00.000Z', endTime: '2026-10-03T00:00:00.000Z' },
    };
    expect(
      serverSavedQuery({
        ...nativeLogsSql,
        explorer_state: encodeLogView(absolute),
        time_filter: { from: absolute.range.startTime, to: absolute.range.endTime },
      })?.range,
    ).toEqual(absolute.range);
    // A dataset-scoped record whose state names another dataset is not trusted.
    expect(serverSavedQuery({ ...nativeLogsSql, stream_name: 'other' })).toMatchObject({
      range: '1h',
      datasets: ['other'],
    });
  });
  it('never fabricates SQL for builder, search, empty or unidentified records', () => {
    expect(serverSavedQuery(classicBuilder)).toBeUndefined();
    expect(serverSavedQuery(classicSearch)).toBeUndefined();
    expect(
      serverSavedQuery({ ...classicSql, query: { filter_type: 'sql', filter_query: '  ' } }),
    ).toBeUndefined();
    expect(serverSavedQuery({ ...classicSql, filter_id: null })).toBeUndefined();
  });
  it('keeps same-id records of different owners and drops exact duplicates', () => {
    const items = serverSavedQueries([
      classicSql,
      classicSql,
      { ...classicSql, user_id: 'admin-hash' },
      classicBuilder,
      classicLogsSql,
    ]);
    expect(items.map((item) => [item.name, item.ownerHash])).toEqual([
      ['App errors', 'other-hash'],
      ['Slow requests', 'admin-hash'],
      ['Slow requests', 'owner-hash'],
    ]);
  });
  it('hands the stored SQL and its range to the editor verbatim', () => {
    const item = serverSavedQuery(classicSql)!;
    const params = new URL(sqlEditorHandoff(item), 'http://x').searchParams;
    expect(params.get('query')).toBe(item.sql);
    expect(params.get('start')).toBe('2026-10-01T00:00:00.000Z');
    expect(params.get('end')).toBe('2026-10-02T00:00:00.000Z');
    expect(sqlHandoffRange(params)).toEqual(item.range);
    const native = new URL(sqlEditorHandoff(serverSavedQuery(nativeLogsSql)!), 'http://x')
      .searchParams;
    expect(native.has('start')).toBe(false);
    expect(native.get('range')).toBe('7d');
    expect(native.get('query')).toBe(nativeLogsSql.query.filter_query);
    expect(sqlHandoffRange(native)).toBe('7d');
    expect(sqlHandoffRange(new URLSearchParams({ range: 'forever' }))).toBe('1h');
    expect(sqlHandoffRange(new URLSearchParams())).toBe('1h');
  });
  it('copies into the browser library without losing local queries or duplicating', () => {
    const local: SavedQuery = {
      id: 'local',
      name: 'Mine',
      sql: 'SELECT 1',
      range: '1h',
      datasets: ['app'],
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const item = serverSavedQuery(classicSql)!;
    const first = importServerQuery([local], item, new Date('2026-10-21T00:00:00Z'));
    expect(first.items).toHaveLength(2);
    expect(first.items[1]).toBe(local);
    expect(first.imported).toMatchObject({
      name: item.name,
      sql: item.sql,
      range: item.range,
      datasets: [],
    });
    expect(first.imported!.id).not.toBe(item.filterId);
    expect(saveQuery(first.items, local)).toHaveLength(2);
    const again = importServerQuery(first.items, item);
    expect(again.imported).toBeUndefined();
    expect(again.items).toBe(first.items);
    // Equivalent bounds in another ISO spelling are still the same copy.
    const respelled = importServerQuery(first.items, {
      ...item,
      range: { startTime: '2026-10-01T00:00:00Z', endTime: '2026-10-02T00:00:00+00:00' },
    });
    expect(respelled.imported).toBeUndefined();
  });
  it('keeps same-named copies whose window or dataset scope differ', () => {
    const item = serverSavedQuery(classicSql)!;
    const first = importServerQuery([], item).items;
    const otherWindow = importServerQuery(first, {
      ...item,
      range: { startTime: '2026-10-05T00:00:00.000Z', endTime: '2026-10-06T00:00:00.000Z' },
    });
    expect(otherWindow.imported).toBeDefined();
    const relative = importServerQuery(otherWindow.items, { ...item, range: '7d' });
    expect(relative.imported).toBeDefined();
    const scoped = importServerQuery(relative.items, { ...item, datasets: ['app'] });
    expect(scoped.imported).toBeDefined();
    expect(scoped.items).toHaveLength(4);
    expect(importServerQuery(scoped.items, { ...item, range: '7d' }).imported).toBeUndefined();
  });
});
