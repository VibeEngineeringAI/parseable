import { basePath } from './config';
import { metricSelector } from './promql';
import type { LogFilter, TimeRange } from './types';

/** The classic (Prism) UI owns the root while this frontend is mounted under a prefix. */
export const classicUiAvailable = basePath !== '';

/**
 * How a classic URL opens here:
 * - `same`: the same path shows the equivalent page.
 * - `redirect`: the page lives at another path.
 * - `classic-only`: this frontend has no such page.
 */
export type ClassicRouteKind = 'same' | 'redirect' | 'classic-only';

export type ClassicRoute = {
  /** Classic path; `:name` matches one segment. */
  classic: string;
  /** Path here, using the classic captures. Absent for `classic-only`. */
  native?: string;
  kind: ClassicRouteKind;
  /** Query parameters added on the way here, from the decoded classic captures. */
  params?: (captures: Record<string, string>) => Record<string, string>;
};

/**
 * Every route in Prism v3.2.5's router (`index-CaJv0zbb.js`, outside `*`), and
 * the only place the classic-to-native mapping is defined. Classic Logs query
 * parameters are translated by `classicLogsState`, since the path is unchanged.
 */
export const classicRoutes: readonly ClassicRoute[] = [
  { classic: '/', native: '/', kind: 'same' },
  { classic: '/login', native: '/login', kind: 'same' },
  { classic: '/logs/explore/:dataset', native: '/logs/explore/:dataset', kind: 'same' },
  { classic: '/logs/search/:dataset', native: '/logs/explore/:dataset', kind: 'redirect' },
  { classic: '/metrics/explore/:dataset', native: '/metrics/explore/:dataset', kind: 'same' },
  {
    classic: '/metrics/explore/:dataset/metric/:metric',
    native: '/metrics/explore/:dataset',
    kind: 'redirect',
    params: ({ metric }) => ({ query: metricSelector(metric) }),
  },
  { classic: '/metrics/search/:dataset', native: '/metrics/explore/:dataset', kind: 'redirect' },
  { classic: '/sql-editor', native: '/sql-editor', kind: 'same' },
  { classic: '/datasets', native: '/datasets', kind: 'same' },
  { classic: '/dashboards', native: '/dashboards', kind: 'same' },
  { classic: '/dashboards/:id', native: '/dashboards/:id', kind: 'same' },
  { classic: '/alerts', native: '/alerts', kind: 'same' },
  { classic: '/alerts/create', native: '/alerts/new', kind: 'redirect' },
  { classic: '/alerts/:id', native: '/alerts/:id', kind: 'same' },
  { classic: '/alerts/:id/edit', native: '/alerts/:id/edit', kind: 'same' },
  { classic: '/team', native: '/team', kind: 'same' },
  { classic: '/settings/alert-targets', native: '/alerts/targets', kind: 'redirect' },
  // Classic redirects its settings index to alert targets.
  { classic: '/settings', native: '/alerts/targets', kind: 'redirect' },
  { classic: '/traces/explore/:dataset', kind: 'classic-only' },
  { classic: '/apm/:dataset', kind: 'classic-only' },
  { classic: '/apm/:dataset/:service', kind: 'classic-only' },
  { classic: '/agents', kind: 'classic-only' },
  { classic: '/agents/:dataset', kind: 'classic-only' },
  { classic: '/keystone', kind: 'classic-only' },
  { classic: '/keystone/:id', kind: 'classic-only' },
  { classic: '/settings/llm-key', kind: 'classic-only' },
  { classic: '/settings/billing', kind: 'classic-only' },
  { classic: '/settings/network-access', kind: 'classic-only' },
  { classic: '/add-data', kind: 'classic-only' },
  { classic: '/cluster', kind: 'classic-only' },
  { classic: '/onboarding', kind: 'classic-only' },
  { classic: '/new', kind: 'classic-only' },
  { classic: '/errors', kind: 'classic-only' },
  { classic: '/errors/:dataset', kind: 'classic-only' },
  { classic: '/no-access', kind: 'classic-only' },
  { classic: '/post-auth', kind: 'classic-only' },
  { classic: '/sso-callback', kind: 'classic-only' },
];

const segments = (path: string) => path.split('/').filter(Boolean);

/** Captures of `pattern` in `pathname`, kept percent-encoded, or undefined. */
function match(pattern: string, pathname: string): Record<string, string> | undefined {
  const want = segments(pattern),
    have = segments(pathname);
  if (want.length !== have.length) return;
  const captures: Record<string, string> = {};
  for (const [i, part] of want.entries()) {
    if (part.startsWith(':')) captures[part.slice(1)] = have[i];
    else if (part !== have[i]) return;
  }
  return captures;
}

const fill = (pattern: string, captures: Record<string, string>) =>
  `/${segments(pattern)
    .map((part) => (part.startsWith(':') ? captures[part.slice(1)] : part))
    .join('/')}`;

/** The matching route with the most literal segments, so `/alerts/create` beats `/alerts/:id`. */
function bestMatch(side: 'classic' | 'native', pathname: string) {
  let best: { route: ClassicRoute; captures: Record<string, string>; literals: number } | undefined;
  for (const route of classicRoutes) {
    const pattern = route[side];
    const captures = pattern === undefined ? undefined : match(pattern, pathname);
    if (!pattern || !captures) continue;
    const literals = segments(pattern).filter((part) => !part.startsWith(':')).length;
    if (!best || literals > best.literals) best = { route, captures, literals };
  }
  return best;
}

function splitPath(path: string) {
  const url = new URL(path, 'http://classic.invalid');
  return { pathname: url.pathname, search: url.searchParams, hash: url.hash };
}

/** The classic route a path matches, or undefined if it is not a classic page. */
export function classicRoute(pathname: string): ClassicRoute | undefined {
  return bestMatch('classic', pathname)?.route;
}

/**
 * The path here for a classic link, keeping its query and hash. A classic-only
 * page, or any path the classic UI does not route, is returned unchanged.
 */
export function nativePath(path: string): string {
  const { pathname, search, hash } = splitPath(path);
  const found = bestMatch('classic', pathname);
  if (!found?.route.native || found.route.kind === 'same') return path;
  if (found.route.params) {
    const decoded: Record<string, string> = {};
    for (const [name, value] of Object.entries(found.captures)) {
      try {
        decoded[name] = decodeURIComponent(value);
      } catch {
        // A malformed escape is not a link classic produced; the not-found page handles it.
        return path;
      }
    }
    for (const [name, value] of Object.entries(found.route.params(decoded)))
      search.set(name, value);
  }
  const query = search.toString();
  return `${fill(found.route.native, found.captures)}${query ? `?${query}` : ''}${hash}`;
}

/** The classic UI page equivalent to a route in this frontend, for comparison. */
export function classicUiPath(pathname: string): string {
  const found = bestMatch('native', pathname);
  return found ? fill(found.route.classic, found.captures) : '/';
}

/** Classic quick ranges, by their `start` value when `type=fixed`. */
const classicPresets: Record<string, TimeRange> = {
  '10m': '10m',
  '30m': '30m',
  '1h': '1h',
  '5h': '5h',
  '1d': '24h',
  '3d': '3d',
};

const filterTypes = 'number|text|boolean|timestamp|listInt|listFloat|listString';
const comparison = new RegExp(
  `^(?:(?:${filterTypes})\\s+)?(?:"((?:[^"]|"")+)"|\`([^\`]+)\`|([^\\s"'\`()=!<>]+))\\s*(!=|=)\\s*(?:'((?:[^']|'')*)'|(-?\\d+(?:\\.\\d+)?|true|false))$`,
  'i',
);

/** Splits on `AND` outside quotes and parentheses. */
function topLevelAnd(clause: string): string[] {
  const parts: string[] = [];
  let depth = 0,
    quote = '',
    current = '';
  for (let i = 0; i < clause.length; i++) {
    const c = clause[i];
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (depth === 0 && /^\sAND\s/i.test(clause.slice(i, i + 5))) {
      parts.push(current);
      current = '';
      i += 4;
      continue;
    }
    current += c;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

/**
 * Filters from a classic Logs `query` (`WHERE text level = 'error' AND …`).
 * This frontend filters on `=` and `!=` only, so any other condition is
 * counted as skipped rather than guessed at.
 */
export function classicLogFilters(query: string): {
  filters: Omit<LogFilter, 'id'>[];
  skipped: number;
} {
  const where = query.trim().replace(/^WHERE\b\s*/i, '');
  const filters: Omit<LogFilter, 'id'>[] = [];
  let skipped = 0;
  for (const condition of where ? topLevelAnd(where) : []) {
    const m = comparison.exec(condition);
    if (!m) {
      skipped++;
      continue;
    }
    const [, doubleQuoted, backticked, bare, operator, quoted, literal] = m;
    const field = doubleQuoted?.replaceAll('""', '"') ?? backticked ?? bare,
      value = quoted !== undefined ? quoted.replaceAll("''", "'") : literal;
    // The query builder rejects NUL, and classic never writes it.
    if (field.includes('\0') || value.includes('\0')) {
      skipped++;
      continue;
    }
    filters.push({ field, operator: operator as LogFilter['operator'], value });
  }
  return { filters, skipped };
}

/** Classic Logs parameters this frontend reads; any others are left alone. */
export const classicLogsParams = [
  'start',
  'end',
  'type',
  'tz',
  'query',
  'groupBy',
  'view',
  'fromSavedFilter',
] as const;

/**
 * The time range and filters of a classic Logs link, plus what could not be
 * carried over. A preset is `type=fixed&start=1h&end=now`; a custom range has
 * ISO `start` and `end`, where `end` may be `now`. Classic sends both in UTC, so
 * `tz` only changed how times were displayed.
 */
export function classicLogsState(
  params: URLSearchParams,
  now = Date.now(),
): {
  range?: TimeRange;
  filters: Omit<LogFilter, 'id'>[];
  dropped: string[];
} {
  const dropped: string[] = [];
  const start = params.get('start'),
    end = params.get('end'),
    type = params.get('type');
  let range: TimeRange | undefined;
  if (start && end && type) {
    if (type === 'fixed')
      range = Object.hasOwn(classicPresets, start) ? classicPresets[start] : undefined;
    else {
      const from = Date.parse(start),
        to = end === 'now' ? now : Date.parse(end);
      if (Number.isFinite(from) && Number.isFinite(to) && from < to)
        range = { startTime: new Date(from).toISOString(), endTime: new Date(to).toISOString() };
    }
    if (!range) dropped.push('time range');
  }
  const tz = params.get('tz');
  if (tz && tz !== 'UTC') dropped.push(`time zone ${tz} (times are shown in UTC)`);
  const { filters, skipped } = classicLogFilters(params.get('query') ?? '');
  if (skipped) dropped.push(skipped === 1 ? '1 filter' : `${skipped} filters`);
  if (params.get('groupBy')) dropped.push('grouping');
  if (params.get('view')) dropped.push('saved view');
  return { range, filters, dropped };
}
