import { paramsRange, timeBounds } from '../../lib/query';
import type { SavedLogView, TimeRange } from '../../lib/types';
import { decodeLogView } from '../logs/logViewState';
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
  /** The stored bounds as saved, for explaining a fallback. */
  savedRange?: string;
  datasets: string[];
  origin: 'sql' | 'logs';
  ownerHash?: string;
};

const presetMs: [Extract<TimeRange, string>, number][] = [
  ['10m', 10 * 60_000],
  ['15m', 15 * 60_000],
  ['30m', 30 * 60_000],
  ['1h', 60 * 60_000],
  ['5h', 5 * 60 * 60_000],
  ['6h', 6 * 60 * 60_000],
  ['24h', 24 * 60 * 60_000],
  ['1d', 24 * 60 * 60_000],
  ['3d', 3 * 24 * 60 * 60_000],
  ['7d', 7 * 24 * 60 * 60_000],
];
const unitMs: Record<string, number> = {
  m: 60_000,
  h: 60 * 60_000,
  d: 24 * 60 * 60_000,
  w: 7 * 24 * 60 * 60_000,
};

export function isRangePreset(value: unknown): value is Extract<TimeRange, string> {
  return presetMs.some(([preset]) => preset === value);
}

/**
 * Classic Prism stores relative windows as `now-<n><unit>` to `now`. Only
 * windows matching a native preset are kept; anything else is unsupported.
 */
export function classicTimeRange(from: string, to: string): TimeRange | undefined {
  const relative = /^now-(\d{1,4})([mhdw])$/.exec(from.trim());
  if (relative) {
    if (to.trim() !== 'now') return;
    const label = `${Number(relative[1])}${relative[2]}`;
    const ms = Number(relative[1]) * unitMs[relative[2]];
    return (
      presetMs.find(([preset]) => preset === label)?.[0] ??
      presetMs.find(([, duration]) => duration === ms)?.[0]
    );
  }
  try {
    return timeBounds({ startTime: from, endTime: to });
  } catch {
    return;
  }
}

/** A validated native explorer state is authoritative for range and dataset. */
function nativeState(view: SavedLogView) {
  if (typeof view.explorer_state !== 'string') return;
  try {
    const state = decodeLogView(view.explorer_state);
    if (view.stream_name !== 'sql' && state.dataset !== view.stream_name) return;
    return state;
  } catch {
    return;
  }
}

export function serverSavedQuery(view: SavedLogView): ServerSavedQuery | undefined {
  const sql = view.query.filter_query;
  if (view.query.filter_type !== 'sql' || typeof sql !== 'string' || !sql.trim()) return;
  if (typeof view.filter_id !== 'string' || !view.filter_id) return;
  const state = nativeState(view);
  let range: TimeRange = '1h';
  let rangeFallback = false;
  let savedRange: string | undefined;
  if (state) range = state.range;
  else if (view.time_filter) {
    const saved = classicTimeRange(view.time_filter.from, view.time_filter.to);
    if (saved) range = saved;
    else {
      rangeFallback = true;
      savedRange = `${view.time_filter.from} to ${view.time_filter.to}`;
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
    ...(savedRange ? { savedRange } : {}),
    datasets: state ? [state.dataset] : view.stream_name === 'sql' ? [] : [view.stream_name],
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
  } else params.set('range', item.range);
  return `/sql-editor?${params}`;
}

/** Reads a SQL editor handoff range: absolute bounds first, then a relative preset. */
export function sqlHandoffRange(params: URLSearchParams): TimeRange {
  if (params.get('start') && params.get('end')) return paramsRange(params);
  const preset = params.get('range');
  return isRangePreset(preset) ? preset : '1h';
}

function rangeKey(range: TimeRange): string {
  if (typeof range === 'string') return range;
  try {
    return JSON.stringify(timeBounds(range));
  } catch {
    return JSON.stringify(range);
  }
}

/** Same query, window and dataset scope; the name alone does not make a copy equal. */
function sameQuery(a: Pick<SavedQuery, 'name' | 'sql' | 'range' | 'datasets'>, b: typeof a) {
  return (
    a.name === b.name &&
    a.sql === b.sql &&
    rangeKey(a.range) === rangeKey(b.range) &&
    JSON.stringify([...a.datasets].sort()) === JSON.stringify([...b.datasets].sort())
  );
}

/** A browser-library copy; the server record stays the source of the original. */
export function importServerQuery(
  items: SavedQuery[],
  item: ServerSavedQuery,
  now = new Date(),
): { items: SavedQuery[]; imported?: SavedQuery } {
  if (items.some((existing) => sameQuery(existing, item))) return { items };
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
