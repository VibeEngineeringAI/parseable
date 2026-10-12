import { parser } from '@prometheus-io/lezer-promql';
import { basePath } from './config';
import { matcher, metricSelector, validateRange } from './promql';
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
  /**
   * Query parameters added on the way here, from the decoded classic captures
   * and the link's query, which it may also edit. A value is appended, so a
   * parameter already on the link is kept.
   */
  params?: (captures: Record<string, string>, search: URLSearchParams) => Record<string, string>;
};

/**
 * Every route in Prism v3.2.5's router (`index-CaJv0zbb.js`, outside `*`), and
 * the only place the classic-to-native mapping is defined. Classic Logs query
 * parameters are translated by `classicLogsState`, and classic Metrics ones by
 * `classicMetricsSearch`, since the path is unchanged.
 */
/**
 * The histogram series a classic drilldown charts, by its `suffix`, which
 * classic sets only for a histogram. PromQL here charts gauges and cumulative
 * sums only, so the drilldown opens the plain metric, whose query reports
 * that, and the series is named in the notice.
 */
const histogramSuffixes = ['bucket', 'sum', 'count'];

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
    params: ({ metric }, search) => {
      // Classic shows the drilldown whatever its view, so these say nothing here.
      for (const name of ['viewType', 'viewMode', 'promql', 'state']) search.delete(name);
      return { query: metricSelector(metric) };
    },
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
  { classic: '/traces/explore/:dataset', native: '/traces/explore/:dataset', kind: 'same' },
  { classic: '/apm/:dataset', native: '/apm/:dataset', kind: 'same' },
  { classic: '/apm/:dataset/:service', native: '/apm/:dataset/:service', kind: 'same' },
  { classic: '/agents', kind: 'classic-only' },
  { classic: '/agents/:dataset', kind: 'classic-only' },
  { classic: '/keystone', kind: 'classic-only' },
  { classic: '/keystone/:id', kind: 'classic-only' },
  { classic: '/settings/llm-key', kind: 'classic-only' },
  { classic: '/settings/billing', kind: 'classic-only' },
  { classic: '/settings/network-access', kind: 'classic-only' },
  { classic: '/add-data', native: '/add-data', kind: 'same' },
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
    for (const [name, value] of Object.entries(found.route.params(decoded, search)))
      search.append(name, value);
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
  const { range, unread } = classicRange(params, now);
  const { filters, skipped } = classicLogFilters(params.get('query') ?? '');
  return { range, filters, dropped: droppedFromLink(params, unread, skipped) };
}

/** The range of classic `start`, `end` and `type`, and whether they were present but unusable. */
function classicRange(params: URLSearchParams, now: number) {
  const start = params.get('start'),
    end = params.get('end'),
    type = params.get('type');
  if (!start || !end || !type) return { unread: false };
  let range: TimeRange | undefined;
  if (type === 'fixed')
    range = Object.hasOwn(classicPresets, start) ? classicPresets[start] : undefined;
  else {
    const from = Date.parse(start),
      to = end === 'now' ? now : Date.parse(end);
    if (Number.isFinite(from) && Number.isFinite(to) && from < to)
      range = { startTime: new Date(from).toISOString(), endTime: new Date(to).toISOString() };
  }
  return { range, unread: !range };
}

/** What a classic link asked for that is not carried over, in the order the notice lists it. */
function droppedFromLink(params: URLSearchParams, unreadRange: boolean, filters: number) {
  const dropped: string[] = [];
  if (unreadRange) dropped.push('time range');
  const tz = params.get('tz');
  if (tz && tz !== 'UTC') dropped.push(`time zone ${tz} (times are shown in UTC)`);
  if (filters) dropped.push(filters === 1 ? '1 filter' : `${filters} filters`);
  if (params.get('groupBy')) dropped.push('grouping');
  if (params.get('view')) dropped.push('saved view');
  return dropped;
}

/**
 * Whether `query` is a classic Metrics filter rather than PromQL. Classic writes
 * `WHERE ${type} ${column} …`, and its parser also reads untyped conditions and
 * leading whitespace. None of them parse as PromQL, so a query that does, such
 * as `WHERE > 5` for a metric named WHERE, is kept.
 */
function isClassicMetricsFilter(query: string): boolean {
  if (!/^\s*WHERE\s+\S/i.test(query)) return false;
  let invalid = false;
  parser.parse(query).iterate({
    enter(node) {
      if (node.type.isError) invalid = true;
      return !invalid;
    },
  });
  return invalid;
}

/**
 * Classic Metrics parameters that this page does not read under the same name.
 * Every parameter Prism v3.2.5's Metrics pages read (`Metrics-DYr03wWH.js`,
 * `MetricsExploreView-DmrgxGoz.js`) is either here, translated below, or
 * `start`, `end`, `type` and `query`: `tz`, `groupBy` and `view` are reported;
 * `viewType` picks classic's view, of which a list or table is reported and the
 * explorer translated; `viewMode` only lays out the list; `fromSavedFilter` only
 * marks a saved filter as loaded; a drilldown's histogram `suffix` is reported;
 * `promql` and `state` hold the explorer's queries.
 */
const classicMetricsOnly = [
  'tz',
  'groupBy',
  'view',
  'viewType',
  'viewMode',
  'fromSavedFilter',
  'suffix',
  'promql',
  'state',
];

/** The most queries this page runs; mirrors `maxQueries` in the Metrics helpers. */
const metricsQueryLimit = 5;

const plural = (count: number, one: string, many: string) =>
  count === 1 ? `1 ${one}` : `${count} ${many}`;

/**
 * The queries, step and query type in classic's serialized explorer `state`,
 * as Prism v3.2.5 reads it (`ya` in `MetricsExploreView-DmrgxGoz.js`), and how
 * many builder queries do not translate. Undefined when classic would reject
 * it too and fall back to `promql`.
 */
function classicExplorerState(value: string) {
  let state: unknown;
  try {
    state = JSON.parse(value);
  } catch {
    return;
  }
  const { tiles, step, queryType } = (state ?? {}) as Record<string, unknown>;
  if (
    !Array.isArray(tiles) ||
    !tiles.length ||
    (queryType && !['range', 'instant', 'both'].includes(queryType as string)) ||
    tiles.some(
      (tile) =>
        !tile ||
        typeof tile !== 'object' ||
        !['promql', 'builder'].includes((tile as Record<string, unknown>).editorMode as string),
    )
  )
    return;
  const queries: string[] = [];
  let untranslated = 0;
  for (const tile of tiles as Record<string, unknown>[]) {
    if (tile.editorMode === 'promql') {
      queries.push(typeof tile.promqlQuery === 'string' ? tile.promqlQuery : '');
      continue;
    }
    const selector = builderSelector(tile.promqlMetric, tile.promqlMatchers, tile.operations);
    if (selector === malformed) return;
    if (selector === undefined) untranslated++;
    else queries.push(selector);
  }
  return {
    queries,
    step: typeof step === 'string' ? step : '',
    type: queryType as string | undefined,
    untranslated,
  };
}

/** A builder query whose shape makes classic reject the whole state. */
const malformed = Symbol('malformed');

/**
 * The selector a classic builder query without operations stands for, as
 * classic's `Ca` writes it; undefined if it has operations or an operator
 * PromQL lacks; `malformed` where classic's own code would throw.
 */
function builderSelector(metric: unknown, matchers: unknown, operations: unknown) {
  const isMissing = (value: unknown) => value === undefined || value === null;
  if (!isMissing(metric) && typeof metric !== 'string') return malformed;
  if (!isMissing(matchers) && !Array.isArray(matchers)) return malformed;
  if (!isMissing(operations) && !Array.isArray(operations)) return malformed;
  // Classic's `fi`/`di` read each operation's `type`, `params` and `byLabels`.
  for (const operation of (operations ?? []) as unknown[]) {
    if (!operation || typeof operation !== 'object') return malformed;
    const { type, params, byLabels } = operation as Record<string, unknown>;
    if (typeof type !== 'string' || !Array.isArray(params)) return malformed;
    if (!isMissing(byLabels) && !Array.isArray(byLabels)) return malformed;
  }
  const parts: string[] = [];
  let unsupported = false;
  for (const entry of (matchers ?? []) as unknown[]) {
    if (!entry || typeof entry !== 'object') return malformed;
    const { label, operator, value } = entry as Record<string, unknown>;
    // Classic skips a matcher without a label or value.
    if (!label || value === undefined || value === '') continue;
    if (typeof label !== 'string' || typeof value !== 'string') return malformed;
    if (!['=', '!=', '=~', '!~'].includes(operator as string)) unsupported = true;
    else parts.push(matcher(label, value, operator as '=' | '!=' | '=~' | '!~'));
  }
  if (unsupported || (operations as unknown[] | null)?.length) return;
  if (!metric) return parts.length ? `{${parts.join(', ')}}` : '';
  const name = metricSelector(metric);
  if (!parts.length) return name;
  return name.startsWith('{')
    ? `{${name.slice(1, -1)}, ${parts.join(', ')}}`
    : `${name}{${parts.join(', ')}}`;
}

/**
 * The Metrics search for a classic Metrics link, and what could not be carried
 * over, or undefined if `search` is not from classic. Classic keeps its range
 * in `type=fixed|custom` with `start` and `end`, which become `range`, or ISO
 * `start` and `end`, here. Its `query` holds column filters on the dataset's
 * records, not PromQL. Classic does not apply them to a metric's chart either,
 * so they are reported rather than turned into label matchers.
 */
export function classicMetricsSearch(
  search: string,
  now = Date.now(),
): { search: string; dropped: string[] } | undefined {
  const params = new URLSearchParams(search);
  const type = params.get('type');
  const classicTime = type === 'fixed' || type === 'custom';
  const filters = params.getAll('query').filter((query) => isClassicMetricsFilter(query));
  if (!classicTime && !filters.length && !classicMetricsOnly.some((name) => params.has(name)))
    return;
  const next = new URLSearchParams();
  for (const [name, value] of params) {
    if (name === 'query' ? isClassicMetricsFilter(value) : classicMetricsOnly.includes(name))
      continue;
    if (!classicTime || !['type', 'start', 'end'].includes(name)) next.append(name, value);
  }
  let { range, unread } = classicTime ? classicRange(params, now) : { unread: false };
  // Metrics queries at most 31 days.
  if (typeof range === 'object') {
    const start = Date.parse(range.startTime) / 1000,
      end = Date.parse(range.endTime) / 1000;
    if (validateRange({ start, end, step: Math.max(1, end - start) })) {
      range = undefined;
      unread = true;
    }
  }
  if (typeof range === 'string') next.set('range', range);
  else if (range) {
    next.set('start', range.startTime);
    next.set('end', range.endTime);
  }
  const conditions = filters.reduce((count, query) => {
    const { filters, skipped } = classicLogFilters(query);
    return count + filters.length + skipped;
  }, 0);
  const dropped = droppedFromLink(params, unread, conditions);
  // Classic shows its explorer for `viewType=explorer`, or any `promql`, and
  // otherwise its "All metrics" list (the default) or a table of records,
  // neither of which this page has. The explorer reads
  // `state` and, without a readable one, `promql`. A `state` left from an
  // earlier visit to the explorer is ignored by the other views, so it is here.
  const promql = params.get('promql');
  const viewType = params.get('viewType');
  const explorer = !!promql || viewType === 'explorer';
  // `viewMode` lays out the All metrics view, which is also classic's default.
  if (viewType === 'list' || (!viewType && !explorer && params.has('viewMode')))
    dropped.push('All metrics view');
  if (viewType === 'table') dropped.push('table view');
  const suffix = params.get('suffix');
  if (suffix && histogramSuffixes.includes(suffix)) dropped.push(`histogram _${suffix} series`);
  const saved =
    explorer && params.has('state') ? classicExplorerState(params.get('state')!) : undefined;
  if (explorer && params.has('state') && !saved) dropped.push('saved queries');
  const queries = saved?.queries ?? (promql ? [promql] : []);
  for (const query of queries) next.append('query', query);
  if (saved?.untranslated)
    dropped.push(
      plural(saved.untranslated, 'query built with operations', 'queries built with operations'),
    );
  if (saved?.type) next.set('type', saved.type);
  if (saved?.step) {
    if (validateRange({ start: 0, end: 0, step: saved.step })) dropped.push('step');
    else next.set('step', saved.step);
  }
  const extra = next.getAll('query').length - metricsQueryLimit;
  if (extra > 0)
    dropped.push(plural(extra, 'query beyond the first five', 'queries beyond the first five'));
  const query = next.toString();
  return { search: query ? `?${query}` : '', dropped };
}
