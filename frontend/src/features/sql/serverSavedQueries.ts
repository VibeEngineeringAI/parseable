import { timeBounds } from '../../lib/query';
import type { SavedLogView, TimeRange } from '../../lib/types';
import type { SavedQuery } from './savedQueries';

/**
 * A server /filters record that stores runnable SQL. Classic SQL-editor queries
 * use stream_name "sql" without an explorer_state; everything else came from a
 * Logs view (classic dataset-scoped or native). Builder and search views have no
 * SQL and are never translated here.
 */
export type ServerSavedQuery = {
  key: string;
  filterId: string;
  name: string;
  sql: string;
  range: TimeRange;
  /** Saved time bounds were present but unusable; the default range is used. */
  rangeFallback: boolean;
  datasets: string[];
  origin: 'sql' | 'logs';
  ownerHash?: string;
};

export function serverSavedQuery(view: SavedLogView): ServerSavedQuery | undefined {
  const sql = view.query.filter_query;
  if (view.query.filter_type !== 'sql' || typeof sql !== 'string' || !sql.trim()) return;
  if (typeof view.filter_id !== 'string' || !view.filter_id) return;
  let range: TimeRange = '1h';
  let rangeFallback = false;
  if (view.time_filter) {
    try {
      range = timeBounds({ startTime: view.time_filter.from, endTime: view.time_filter.to });
    } catch {
      rangeFallback = true;
    }
  }
  const ownerHash = typeof view.user_id === 'string' && view.user_id ? view.user_id : undefined;
  return {
    key: JSON.stringify([ownerHash ?? null, view.filter_id]),
    filterId: view.filter_id,
    name: view.filter_name.trim() || 'Untitled query',
    sql,
    range,
    rangeFallback,
    datasets: view.stream_name === 'sql' ? [] : [view.stream_name],
    origin: view.stream_name === 'sql' && view.explorer_state == null ? 'sql' : 'logs',
    ownerHash,
  };
}

export function serverSavedQueries(views: SavedLogView[]): ServerSavedQuery[] {
  const seen = new Set<string>();
  return views
    .flatMap((view) => {
      const item = serverSavedQuery(view);
      if (!item || seen.has(item.key)) return [];
      seen.add(item.key);
      return [item];
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
}

/** Opens the stored SQL verbatim; the server record is not read back or changed. */
export function sqlEditorHandoff(item: Pick<ServerSavedQuery, 'sql' | 'range'>): string {
  const params = new URLSearchParams({ query: item.sql });
  if (typeof item.range === 'object') {
    params.set('start', item.range.startTime);
    params.set('end', item.range.endTime);
  }
  return `/sql-editor?${params}`;
}

/** A browser-library copy; the server record stays the source of the original. */
export function importServerQuery(
  items: SavedQuery[],
  item: ServerSavedQuery,
  now = new Date(),
): { items: SavedQuery[]; imported?: SavedQuery } {
  if (items.some((existing) => existing.name === item.name && existing.sql === item.sql))
    return { items };
  const imported: SavedQuery = {
    id: crypto.randomUUID(),
    name: item.name,
    sql: item.sql,
    range: item.range,
    datasets: [...item.datasets],
    updatedAt: now.toISOString(),
  };
  return { items: [imported, ...items], imported };
}
