import { describe, expect, it } from 'vitest';
import { savedLogView } from '../../lib/logsContract';
import type { SavedLogView } from '../../lib/types';
import { saveQuery, type SavedQuery } from './savedQueries';
import {
  importServerQuery,
  serverSavedQueries,
  serverSavedQuery,
  sqlEditorHandoff,
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
  it('accepts the real classic fixtures through the client contract', () => {
    for (const view of [classicSql, classicLogsSql, classicBuilder, classicSearch])
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
  it('marks Logs-origin SQL and falls back from unreadable bounds without changing the SQL', () => {
    expect(serverSavedQuery(classicLogsSql)).toMatchObject({
      origin: 'logs',
      datasets: ['app'],
      range: '1h',
      rangeFallback: true,
      sql: classicLogsSql.query.filter_query,
    });
    // A converted native Logs view keeps explorer_state and stays Logs-origin.
    expect(serverSavedQuery({ ...classicSql, explorer_state: '{"version":1}' })?.origin).toBe(
      'logs',
    );
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
  it('hands the stored SQL to the editor verbatim', () => {
    const item = serverSavedQuery(classicSql)!;
    const params = new URL(sqlEditorHandoff(item), 'http://x').searchParams;
    expect(params.get('query')).toBe(item.sql);
    expect(params.get('start')).toBe('2026-10-01T00:00:00.000Z');
    expect(params.get('end')).toBe('2026-10-02T00:00:00.000Z');
    expect(sqlEditorHandoff(serverSavedQuery(classicLogsSql)!)).not.toContain('start=');
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
  });
});
