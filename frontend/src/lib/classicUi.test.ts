import { parser } from '@prometheus-io/lezer-promql';
import { describe, expect, it } from 'vitest';
import {
  classicLogFilters,
  classicLogsState,
  classicMetricsSearch,
  classicRoute,
  classicRoutes,
  classicUiPath,
  nativePath,
} from './classicUi';
import { appPath } from './config';

/** Offsets of PromQL parse errors in `query`. */
function promqlErrors(query: string) {
  const errors: number[] = [];
  parser.parse(query).iterate({
    enter(node) {
      if (node.type.isError) errors.push(node.from);
    },
  });
  return errors;
}

describe('classic routes opened here', () => {
  it.each([
    ['/', 'same', '/'],
    ['/login', 'same', '/login'],
    ['/logs/explore/team%20logs', 'same', '/logs/explore/team%20logs'],
    ['/logs/search/app', 'redirect', '/logs/explore/app'],
    ['/metrics/explore/otel', 'same', '/metrics/explore/otel'],
    [
      '/metrics/explore/otel/metric/http_requests_total',
      'redirect',
      '/metrics/explore/otel?query=http_requests_total',
    ],
    ['/metrics/search/otel', 'redirect', '/metrics/explore/otel'],
    ['/sql-editor', 'same', '/sql-editor'],
    ['/datasets', 'same', '/datasets'],
    ['/dashboards', 'same', '/dashboards'],
    ['/dashboards/01ABC', 'same', '/dashboards/01ABC'],
    ['/alerts', 'same', '/alerts'],
    ['/alerts/create', 'redirect', '/alerts/new'],
    ['/alerts/01ALERT', 'same', '/alerts/01ALERT'],
    ['/alerts/01ALERT/edit', 'same', '/alerts/01ALERT/edit'],
    ['/team', 'same', '/team'],
    ['/settings/alert-targets', 'redirect', '/alerts/targets'],
    ['/settings', 'redirect', '/alerts/targets'],
    ['/traces/explore/spans', 'classic-only', '/traces/explore/spans'],
    ['/apm/otel', 'classic-only', '/apm/otel'],
    ['/apm/otel/checkout.api', 'classic-only', '/apm/otel/checkout.api'],
    ['/agents', 'classic-only', '/agents'],
    ['/agents/app', 'classic-only', '/agents/app'],
    ['/keystone', 'classic-only', '/keystone'],
    ['/keystone/k1', 'classic-only', '/keystone/k1'],
    ['/settings/llm-key', 'classic-only', '/settings/llm-key'],
    ['/settings/billing', 'classic-only', '/settings/billing'],
    ['/settings/network-access', 'classic-only', '/settings/network-access'],
    ['/add-data', 'classic-only', '/add-data'],
    ['/cluster', 'classic-only', '/cluster'],
    ['/onboarding', 'classic-only', '/onboarding'],
    ['/new', 'classic-only', '/new'],
    ['/errors', 'classic-only', '/errors'],
    ['/errors/app', 'classic-only', '/errors/app'],
    ['/no-access', 'classic-only', '/no-access'],
    ['/post-auth', 'classic-only', '/post-auth'],
    ['/sso-callback', 'classic-only', '/sso-callback'],
  ])('%s is %s here at %s', (classic, kind, native) => {
    expect(classicRoute(classic)?.kind).toBe(kind);
    expect(nativePath(classic)).toBe(native);
  });

  it('covers every row of the table', () => {
    const tested = new Set(
      [
        '/',
        '/login',
        '/logs/explore/x',
        '/logs/search/x',
        '/metrics/explore/x',
        '/metrics/explore/x/metric/m',
        '/metrics/search/x',
        '/sql-editor',
        '/datasets',
        '/dashboards',
        '/dashboards/x',
        '/alerts',
        '/alerts/create',
        '/alerts/x',
        '/alerts/x/edit',
        '/team',
        '/settings/alert-targets',
        '/settings',
        '/traces/explore/x',
        '/apm/x',
        '/apm/x/y',
        '/agents',
        '/agents/x',
        '/keystone',
        '/keystone/x',
        '/settings/llm-key',
        '/settings/billing',
        '/settings/network-access',
        '/add-data',
        '/cluster',
        '/onboarding',
        '/new',
        '/errors',
        '/errors/x',
        '/no-access',
        '/post-auth',
        '/sso-callback',
      ].map(classicRoute),
    );
    expect(classicRoutes.filter((route) => !tested.has(route))).toEqual([]);
  });

  it('is not a classic page when the classic router has no such route', () => {
    for (const path of ['/logs', '/metrics', '/components', '/oidc-not-configured', '/device'])
      expect(classicRoute(path)).toBeUndefined();
  });

  it('keeps the query and hash of a redirected link', () => {
    expect(
      nativePath(
        '/alerts/create?dataset=x&queryBuilderType=sql&alertQuery=SELECT+1&title=Panel#draft',
      ),
    ).toBe('/alerts/new?dataset=x&queryBuilderType=sql&alertQuery=SELECT+1&title=Panel#draft');
    expect(nativePath('/alerts/create/?dataset=x')).toBe('/alerts/new?dataset=x');
    expect(nativePath('/logs/search/app?start=1h&end=now&type=fixed')).toBe(
      '/logs/explore/app?start=1h&end=now&type=fixed',
    );
    expect(nativePath('/dashboards/01ABC?range=30m')).toBe('/dashboards/01ABC?range=30m');
  });

  it.each([
    ['http_requests_total', 'http_requests_total'],
    ['a%20b', '{"a b"}'],
    ['system.cpu.load_average.1m', '{"system.cpu.load_average.1m"}'],
    ['a%2Fb', '{"a/b"}'],
    ['say%22hi%22', '{"say\\"hi\\""}'],
  ])('opens the metric %s as the PromQL selector %s', (metric, selector) => {
    const target = new URL(nativePath(`/metrics/explore/otel/metric/${metric}`), 'http://x');
    expect(target.pathname).toBe('/metrics/explore/otel');
    const query = target.searchParams.get('query')!;
    expect(query).toBe(selector);
    expect(promqlErrors(query), query).toEqual([]);
  });

  it('keeps a query already on a metric drilldown link', () => {
    expect(
      nativePath(
        '/metrics/explore/otel/metric/cpu?query=WHERE+text+host+%3D+%27node-a%27&type=fixed#x',
      ),
    ).toBe('/metrics/explore/otel?query=WHERE+text+host+%3D+%27node-a%27&type=fixed&query=cpu#x');
  });

  it.each(['/metrics/explore/otel/metric/100%', '/metrics/explore/otel/metric/%E0%A4%A'])(
    'leaves %s with a malformed escape unchanged',
    (path) => {
      expect(nativePath(path)).toBe(path);
    },
  );

  it.each([
    ['/logs/search/100%', '/logs/explore/100%'],
    ['/logs/search/%E0%A4%A?x=1', '/logs/explore/%E0%A4%A?x=1'],
    ['/logs/search/a%2Fb', '/logs/explore/a%2Fb'],
  ])('moves %s without decoding its dataset', (path, target) => {
    expect(nativePath(path)).toBe(target);
  });

  it('never redirects a path it produced', () => {
    for (const route of classicRoutes) {
      const target = nativePath(route.classic.replaceAll(/:\w+/g, 'x'));
      expect(nativePath(target)).toBe(target);
    }
  });
});

describe('comparing in the classic UI', () => {
  it.each([
    ['/', '/'],
    ['/logs', '/'],
    ['/logs/explore/team%20logs', '/logs/explore/team%20logs'],
    ['/metrics', '/'],
    ['/metrics/explore/team%20metrics', '/metrics/explore/team%20metrics'],
    ['/sql-editor', '/sql-editor'],
    ['/datasets', '/datasets'],
    ['/dashboards', '/dashboards'],
    ['/dashboards/01ABC/', '/dashboards/01ABC'],
    ['/team', '/team'],
    ['/alerts', '/alerts'],
    ['/alerts/new', '/alerts/create'],
    ['/alerts/targets', '/settings/alert-targets'],
    ['/alerts/abc', '/alerts/abc'],
    ['/alerts/abc/edit', '/alerts/abc/edit'],
    ['/components', '/'],
  ])('maps %s to the classic page %s', (route, classic) => {
    expect(classicUiPath(route)).toBe(classic);
  });

  it('prefixes document navigations with the mount path', () => {
    expect(appPath('/login', '/next')).toBe('/next/login');
    expect(appPath('/login', '')).toBe('/login');
  });
});

describe('classic Logs links', () => {
  const state = (search: string) =>
    classicLogsState(new URLSearchParams(search), Date.parse('2026-10-10T12:00:00Z'));

  it.each([
    ['10m', '10m'],
    ['30m', '30m'],
    ['1h', '1h'],
    ['5h', '5h'],
    ['1d', '24h'],
    ['3d', '3d'],
  ])('reads the classic preset %s as %s', (start, range) => {
    expect(state(`start=${start}&end=now&type=fixed&tz=UTC`)).toEqual({
      range,
      filters: [],
      dropped: [],
    });
  });

  it('reads a custom range in UTC', () => {
    expect(
      state('start=2026-10-09T08:00:00.000Z&end=2026-10-09T09:30:00.000Z&type=custom').range,
    ).toEqual({ startTime: '2026-10-09T08:00:00.000Z', endTime: '2026-10-09T09:30:00.000Z' });
  });

  it('ends a custom range that ran to now at the time the link was opened', () => {
    expect(state('start=2026-10-10T11:00:00.000Z&end=now&type=custom').range).toEqual({
      startTime: '2026-10-10T11:00:00.000Z',
      endTime: '2026-10-10T12:00:00.000Z',
    });
  });

  it('reports a range it cannot read and leaves the default in place', () => {
    expect(state('start=2h&end=now&type=fixed')).toEqual({
      range: undefined,
      filters: [],
      dropped: ['time range'],
    });
    expect(state('start=later&end=now&type=custom').dropped).toEqual(['time range']);
    for (const start of ['constructor', 'toString', '__proto__', 'hasOwnProperty'])
      expect(state(`type=fixed&start=${start}&end=now`), start).toEqual({
        range: undefined,
        filters: [],
        dropped: ['time range'],
      });
    expect(state('start=1h&end=now').range).toBeUndefined();
  });

  it('reports what this frontend does not support', () => {
    expect(
      state(
        "start=1h&end=now&type=fixed&tz=Asia%2FKolkata&groupBy=host&view=f1&query=WHERE+text+msg+ILIKE+'%25x%25'",
      ).dropped,
    ).toEqual([
      'time zone Asia/Kolkata (times are shown in UTC)',
      '1 filter',
      'grouping',
      'saved view',
    ]);
  });

  it('reads equality filters from the classic query', () => {
    expect(
      state(
        `query=${encodeURIComponent("WHERE text level = 'error' AND number status != 500 AND text \"host name\" = 'it''s'")}`,
      ),
    ).toEqual({
      range: undefined,
      filters: [
        { field: 'level', operator: '=', value: 'error' },
        { field: 'status', operator: '!=', value: '500' },
        { field: 'host name', operator: '=', value: "it's" },
      ],
      dropped: [],
    });
  });
});

describe('classic Metrics links', () => {
  const now = Date.parse('2026-10-10T12:00:00Z');
  const translate = (search: string) => classicMetricsSearch(search, now);
  const host = `query=${encodeURIComponent("WHERE text host = 'node-a'")}`;

  it('treats only a query that is not PromQL as a classic filter', () => {
    for (const query of [
      "WHERE text host = 'node-a'",
      "WHERE (text env = 'x' OR text env = 'y')",
      'WHERE number n > 1',
      'WHERE listString tags contains [a]',
      // Classic's parser also reads untyped conditions and leading whitespace.
      "WHERE host = 'node-a'",
      " WHERE text host = 'node-a'",
      "\n where host != 'node-a'",
      'WHERE `host.name` = 1',
      'WHERE "host name" = \'a\'',
    ]) {
      expect(promqlErrors(query), query).not.toEqual([]);
      expect(translate(`?query=${encodeURIComponent(query)}`), query).toEqual({
        search: '',
        dropped: ['1 filter'],
      });
    }
    // PromQL with a metric named WHERE stays a query.
    for (const query of [
      'WHERE',
      'WHERE > 5',
      ' WHERE > 5',
      'WHERE and on() up',
      'WHERE or up',
      'WHERE unless up',
      'WHERE offset 5m',
      'WHERE{host="a"}',
      'WHERE [5m]',
      'WHERE * 2',
      'WHERE == bool 1',
      'WHERE atan2 up',
    ]) {
      expect(promqlErrors(query), query).toEqual([]);
      expect(translate(`?query=${encodeURIComponent(query)}`), query).toBeUndefined();
    }
  });

  it('reports untyped and indented classic filters with a range', () => {
    for (const query of ["WHERE host = 'node-a'", " WHERE text host = 'node-a'"])
      expect(
        translate(`?query=${encodeURIComponent(query)}&query=cpu&start=1h&end=now&type=fixed`),
        query,
      ).toEqual({ search: '?query=cpu&range=1h', dropped: ['1 filter'] });
  });

  it('leaves a link from this frontend alone', () => {
    for (const search of [
      '',
      '?query=cpu&type=range&range=6h',
      '?query=WHERE&type=both',
      `?query=${encodeURIComponent('WHERE{host="a"}')}`,
      `?query=${encodeURIComponent('WHERE > 5')}&type=instant`,
      `?query=${encodeURIComponent('WHERE and on() up')}`,
      '?start=2026-10-10T10:00:00.000Z&end=2026-10-10T11:00:00.000Z',
    ])
      expect(translate(search), search).toBeUndefined();
  });

  it('reports the filter of a drilldown and keeps the metric query', () => {
    const link = nativePath(
      `/metrics/explore/otel/metric/system.cpu.load_average.1m?start=10m&end=now&type=fixed&tz=UTC&${host}`,
    );
    const { pathname, search } = new URL(link, 'http://x');
    expect(pathname).toBe('/metrics/explore/otel');
    expect(translate(search)).toEqual({
      search: `?query=${encodeURIComponent('{"system.cpu.load_average.1m"}')}&range=10m`,
      dropped: ['1 filter'],
    });
  });

  it('counts every condition it drops', () => {
    const query = encodeURIComponent(
      "WHERE text host = 'a' AND (text env = 'x' OR text env = 'y') AND number n > 1",
    );
    expect(translate(`?query=${query}&query=cpu`)).toEqual({
      search: '?query=cpu',
      dropped: ['3 filters'],
    });
  });

  it.each([
    ['start=1h&end=now&type=fixed', '?range=1h'],
    ['start=1d&end=now&type=fixed', '?range=24h'],
    ['start=3d&end=now&type=fixed', '?range=3d'],
    [
      'start=2026-10-10T11:00:00.000Z&end=now&type=custom',
      '?start=2026-10-10T11%3A00%3A00.000Z&end=2026-10-10T12%3A00%3A00.000Z',
    ],
  ])('carries the classic range %s as %s', (params, search) => {
    expect(translate(`?${params}`)).toEqual({ search, dropped: [] });
  });

  it('reports a range it cannot use', () => {
    for (const params of [
      'start=2h&end=now&type=fixed',
      'start=constructor&end=now&type=fixed',
      'start=later&end=now&type=custom',
      // More than the 31 days a query can cover.
      'start=2026-08-01T00:00:00.000Z&end=now&type=custom',
    ])
      expect(translate(`?${params}`), params).toEqual({ search: '', dropped: ['time range'] });
  });

  it('removes classic-only parameters and keeps the rest', () => {
    expect(
      translate(
        `?${host}&tz=Asia%2FKolkata&groupBy=host&view=v1&viewType=list&viewMode=chart&fromSavedFilter=true&suffix=sum&step=30s&promql=up`,
      ),
    ).toEqual({
      search: '?step=30s&query=up',
      dropped: [
        'time zone Asia/Kolkata (times are shown in UTC)',
        '1 filter',
        'grouping',
        'saved view',
      ],
    });
  });

  it.each(['?viewType=list', '?viewMode=chart', '?fromSavedFilter=true', '?suffix=bucket'])(
    'recognises %s alone as a classic link',
    (search) => {
      expect(translate(search)).toEqual({ search: '', dropped: [] });
    },
  );

  it('opens the query of a classic PromQL link', () => {
    // As Prism's own link builder writes it: /metrics/explore/<dataset>?promql=<query>.
    const link = `/metrics/explore/otel?${new URLSearchParams({ promql: 'rate(up[5m])' })}`;
    expect(nativePath(link)).toBe(link);
    expect(translate(new URL(link, 'http://x').search)).toEqual({
      search: `?${new URLSearchParams({ query: 'rate(up[5m])' })}`,
      dropped: [],
    });
  });

  /** Classic's serialized explorer `state`, as its encoder writes it. */
  const state = (value: unknown) => `state=${encodeURIComponent(JSON.stringify(value))}`;

  it('opens the queries, step and query type of classic explorer state', () => {
    const link = state({
      step: '30s',
      queryType: 'range',
      tiles: [
        { id: 'A', editorMode: 'promql', promqlQuery: 'sum(rate(http.requests[5m]))' },
        {
          id: 'B',
          editorMode: 'builder',
          promqlMetric: 'system.cpu.load_average.1m',
          promqlMatchers: [
            { label: 'host', operator: '=', value: 'node-a' },
            { label: 'service.name', operator: '!~', value: 'db.*' },
            { label: 'skipped', operator: '=', value: '' },
          ],
          operations: [],
        },
        {
          id: 'C',
          editorMode: 'builder',
          promqlMetric: 'up',
          promqlMatchers: [{ label: 'job', operator: '=', value: 'api' }],
          operations: [],
        },
        { id: 'D', editorMode: 'builder', promqlMetric: 'up', operations: [{ id: 'rate' }] },
      ],
    });
    const result = translate(`?${link}&start=1h&end=now&type=fixed&viewType=explorer`)!;
    const next = new URLSearchParams(result.search);
    expect(next.getAll('query')).toEqual([
      'sum(rate(http.requests[5m]))',
      '{"system.cpu.load_average.1m", host="node-a", "service.name"!~"db.*"}',
      'up{job="api"}',
    ]);
    expect(Object.fromEntries([...next].filter(([name]) => name !== 'query'))).toEqual({
      range: '1h',
      type: 'range',
      step: '30s',
    });
    expect(result.dropped).toEqual(['1 query built with operations']);
    for (const query of next.getAll('query').slice(1))
      expect(promqlErrors(query), query).toEqual([]);
  });

  it('prefers readable state over promql, as classic does', () => {
    const tiles = [{ id: 'A', editorMode: 'promql', promqlQuery: 'up' }];
    expect(translate(`?${state({ tiles })}&promql=down`)).toEqual({
      search: '?query=up',
      dropped: [],
    });
  });

  it.each([
    ['not JSON', 'state=%7B'],
    ['no tiles', state({ tiles: [] })],
    ['an unknown query type', state({ queryType: 'table', tiles: [{ editorMode: 'promql' }] })],
    ['an unknown editor', state({ tiles: [{ editorMode: 'sql' }] })],
  ])('reports state with %s and falls back to promql', (_, link) => {
    expect(translate(`?${link}&promql=down`)).toEqual({
      search: '?query=down',
      dropped: ['saved queries'],
    });
  });

  it('reports a step this page cannot use and queries beyond five', () => {
    const tiles = Array.from({ length: 7 }, (_, index) => ({
      id: String(index),
      editorMode: 'promql',
      promqlQuery: `q${index}`,
    }));
    const result = translate(`?${state({ step: 'soon', tiles })}&viewType=explorer`)!;
    expect(new URLSearchParams(result.search).getAll('query')).toHaveLength(7);
    expect(result.dropped).toEqual(['step', '2 queries beyond the first five']);
  });

  it('reads state only where classic shows its explorer', () => {
    const saved = state({ tiles: [{ id: 'A', editorMode: 'promql', promqlQuery: 'up' }] });
    // Switching to another view keeps `state` in the address; those views ignore it.
    expect(translate(`?${saved}&viewType=list`)).toEqual({ search: '', dropped: [] });
    expect(translate(`?${saved}`)).toEqual({ search: '', dropped: [] });
    expect(translate(`?${saved}&viewType=table`)).toEqual({ search: '', dropped: ['table view'] });
    expect(translate(`?${saved}&viewType=explorer`)).toEqual({ search: '?query=up', dropped: [] });
  });

  it('quotes a builder label that is not a plain identifier', () => {
    const result = translate(
      `?viewType=explorer&${state({
        tiles: [
          {
            editorMode: 'builder',
            promqlMetric: 'up',
            promqlMatchers: [{ label: 'region:zone', operator: '=~', value: 'api|web' }],
            operations: [],
          },
        ],
      })}`,
    )!;
    const [query] = new URLSearchParams(result.search).getAll('query');
    expect(query).toBe('up{"region:zone"=~"api|web"}');
    expect(promqlErrors(query)).toEqual([]);
  });

  it('reports a builder matcher with an operator PromQL lacks', () => {
    const tiles = [
      {
        editorMode: 'builder',
        promqlMetric: 'up',
        promqlMatchers: [{ label: 'job', operator: '>', value: '1' }],
      },
    ];
    expect(translate(`?viewType=explorer&${state({ tiles })}`)).toEqual({
      search: '',
      dropped: ['1 query built with operations'],
    });
  });

  it.each([
    ['a null matcher', { promqlMetric: 'up', promqlMatchers: [null] }],
    ['matchers that are not a list', { promqlMetric: 'up', promqlMatchers: 'job=api' }],
    ['operations that are not a list', { promqlMetric: 'up', operations: { id: 'rate' } }],
    ['a metric that is not text', { promqlMetric: 5 }],
    ['a value that is not text', { promqlMatchers: [{ label: 'job', operator: '=', value: 1 }] }],
  ])('rejects builder state with %s, as classic does', (_, tile) => {
    const link = state({ tiles: [{ editorMode: 'builder', ...tile }] });
    expect(translate(`?${link}&promql=down`)).toEqual({
      search: '?query=down',
      dropped: ['saved queries'],
    });
  });

  it('drops what classic ignores on a drilldown', () => {
    const saved = state({ tiles: [{ editorMode: 'promql', promqlQuery: 'up' }] });
    expect(
      nativePath(
        `/metrics/explore/otel/metric/cpu?viewType=table&viewMode=chart&promql=x&${saved}`,
      ),
    ).toBe('/metrics/explore/otel?query=cpu');
  });

  it('opens the histogram series a classic drilldown chose', () => {
    expect(nativePath('/metrics/explore/otel/metric/http.server.duration?suffix=count')).toBe(
      `/metrics/explore/otel?query=${encodeURIComponent('{"http.server.duration_count"}')}`,
    );
    expect(nativePath('/metrics/explore/otel/metric/latency?suffix=bucket&x=1')).toBe(
      '/metrics/explore/otel?x=1&query=latency_bucket',
    );
    expect(nativePath('/metrics/explore/otel/metric/latency?suffix=max')).toBe(
      '/metrics/explore/otel?query=latency',
    );
  });

  it('produces a search it would not translate again', () => {
    for (const search of [
      `?${host}&start=1h&end=now&type=fixed`,
      '?start=2026-10-10T11:00:00.000Z&end=now&type=custom',
      '?promql=up&viewType=explorer',
      `?${state({ queryType: 'instant', step: '1m', tiles: [{ editorMode: 'promql', promqlQuery: 'up' }] })}&viewType=explorer`,
    ])
      expect(translate(translate(search)!.search)).toBeUndefined();
  });
});

describe('classic Logs filters', () => {
  it('skips conditions it cannot express', () => {
    expect(
      classicLogFilters(
        "WHERE (text level = 'a' OR text level = 'b') AND text host IS NOT NULL AND number n > 3 AND text app = 'x AND y'",
      ),
    ).toEqual({ filters: [{ field: 'app', operator: '=', value: 'x AND y' }], skipped: 3 });
  });

  it('reads untyped conditions after leading whitespace, as classic does', () => {
    for (const query of [
      "WHERE host = 'node-a'",
      " WHERE text host = 'node-a'",
      "\n where host = 'node-a'",
    ])
      expect(classicLogFilters(query), query).toEqual({
        filters: [{ field: 'host', operator: '=', value: 'node-a' }],
        skipped: 0,
      });
    expect(
      classicLogsState(new URLSearchParams(`query=${encodeURIComponent(" WHERE host = 'a'")}`)),
    ).toEqual({
      range: undefined,
      filters: [{ field: 'host', operator: '=', value: 'a' }],
      dropped: [],
    });
  });

  it('reads untyped and boolean comparisons', () => {
    expect(classicLogFilters('WHERE ok = true AND `k` = 1.5').filters).toEqual([
      { field: 'ok', operator: '=', value: 'true' },
      { field: 'k', operator: '=', value: '1.5' },
    ]);
  });

  it('skips a field or value containing NUL', () => {
    expect(
      classicLogFilters(
        "WHERE text msg = 'a\0b' AND text \"a\0b\" = 'x' AND `c\0d` != 1 AND text level = 'error'",
      ),
    ).toEqual({ filters: [{ field: 'level', operator: '=', value: 'error' }], skipped: 3 });
    expect(
      classicLogsState(new URLSearchParams("query=WHERE+text+msg+%3D+'a%00b'")).dropped,
    ).toEqual(['1 filter']);
  });

  it('has nothing to read without a condition', () => {
    expect(classicLogFilters('')).toEqual({ filters: [], skipped: 0 });
    expect(classicLogFilters('WHERE ')).toEqual({ filters: [], skipped: 0 });
  });
});
