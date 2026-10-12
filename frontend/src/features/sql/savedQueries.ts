import { readSqlChartConfig } from './sqlChart';
import type { SessionIdentity, TimeRange } from '../../lib/types';
export type SavedQuery = {
  id: string;
  savedId?: string;
  name: string;
  sql: string;
  range: TimeRange;
  datasets: string[];
  updatedAt: string;
  chart?: unknown;
};
export function sqlStorageScope(
  mode: 'live' | 'demo',
  identity?: SessionIdentity,
  server = typeof location === 'undefined' ? '' : location.origin,
): string | null {
  if (mode === 'demo') return 'parseable-sql:v1:demo';
  return identity?.id
    ? `parseable-sql:v1:${encodeURIComponent(server)}:${encodeURIComponent(identity.id)}`
    : null;
}
const ranges = new Set(['10m', '15m', '30m', '1h', '5h', '6h', '1d', '24h', '3d', '7d']);
export function readSavedQueries(raw: string | null): SavedQuery[] {
  try {
    const data: unknown = JSON.parse(raw || '[]');
    if (!Array.isArray(data)) return [];
    const seen = new Set<string>();
    return data.filter((item): item is SavedQuery => {
      if (!item || typeof item !== 'object') return false;
      const v = item as SavedQuery;
      const validRange =
        typeof v.range === 'string'
          ? ranges.has(v.range)
          : v.range &&
            !Array.isArray(v.range) &&
            typeof v.range.startTime === 'string' &&
            typeof v.range.endTime === 'string' &&
            Number.isFinite(Date.parse(v.range.startTime)) &&
            Number.isFinite(Date.parse(v.range.endTime)) &&
            Date.parse(v.range.startTime) < Date.parse(v.range.endTime);
      if (
        typeof v.id !== 'string' ||
        !v.id ||
        seen.has(v.id) ||
        typeof v.name !== 'string' ||
        !v.name.trim() ||
        typeof v.sql !== 'string' ||
        typeof v.updatedAt !== 'string' ||
        !Number.isFinite(Date.parse(v.updatedAt)) ||
        !Array.isArray(v.datasets) ||
        !v.datasets.every((d) => typeof d === 'string') ||
        !validRange
      )
        return false;
      // Chart data is optional; a malformed config must not prevent opening SQL.
      if (v.chart !== undefined) {
        const chart = readSqlChartConfig(v.chart);
        if (chart) v.chart = chart;
        else delete v.chart;
      }
      if (v.savedId !== undefined && (typeof v.savedId !== 'string' || !v.savedId))
        delete v.savedId;
      seen.add(v.id);
      return true;
    });
  } catch {
    return [];
  }
}
export function saveQuery(items: SavedQuery[], item: SavedQuery): SavedQuery[] {
  return [item, ...items.filter((existing) => existing.id !== item.id)].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );
}
