import { test as base, expect, type Locator, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import classic from '../src/features/dashboards/__fixtures__/classic.json' with { type: 'json' };
import queryValue from '../src/features/dashboards/__fixtures__/query-value/query-value.json' with { type: 'json' };
import promql from '../src/features/dashboards/__fixtures__/query-value/promql-query-value.json' with { type: 'json' };
import editorQueryValue from '../src/features/dashboards/__fixtures__/query-value/editor-query-value.json' with { type: 'json' };
import type { Dashboard, DashboardTile, LogRecord } from '../src/lib/types';

const shots = '/tmp/charts-work/shots/qv';
const start = '2026-10-10T08:00:00Z';
const end = '2026-10-10T08:20:00Z';
const themes = [
  { key: 'blue', label: 'Blue', light: '#3563E9', dark: '#86A1F2' },
  { key: 'brown', label: 'Brown', light: '#9A3412', dark: '#CB9786' },
  { key: 'emerald', label: 'Emerald', light: '#059669', dark: '#4EB494' },
  { key: 'fuchsia', label: 'Fuchsia', light: '#A21CAF', dark: '#D08BD6' },
  { key: 'grey', label: 'Grey', light: '#52525B', dark: '#A3A3A8' },
  { key: 'orange', label: 'Orange', light: '#EA580C', dark: '#F0854E' },
  { key: 'pink', label: 'Pink', light: '#DB2777', dark: '#EA80AF' },
  { key: 'purple', label: 'Purple', light: '#6D28D9', dark: '#B693EC' },
  { key: 'red', label: 'Red', light: '#DC2626', dark: '#EB8585' },
  { key: 'yellow', label: 'Yellow', light: '#CA8A04', dark: '#D09822', ink: '#A16207' },
] as const;
type Theme = (typeof themes)[number]['key'];
type Mode = 'light' | 'dark';
const rgb = (hex: string) =>
  `rgb(${[1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16)).join(', ')})`;
const themeColour = (theme: Theme, mode: Mode, ink = true) => {
  const colour = themes.find(({ key }) => key === theme)!;
  return rgb(mode === 'light' && ink && 'ink' in colour ? colour.ink : colour[mode]);
};

const sqlRows = new Map<string, LogRecord[]>();
const requestValues = [18, 34, 25, 46, 39, 57, 49, 68, 62, 81, 73, 88];
const series = requestValues.map((requests, index) => ({
  time_bucket: new Date(Date.parse(start) + index * 60_000).toISOString(),
  requests,
}));
const rangePoints = Array.from({ length: 20 }, (_, index) => [
  Date.parse(start) / 1000 + index * 60,
  String([21, 29, 25, 38, 34, 44, 40, 48, 43, 58, 51, 60, 54, 68, 63, 76, 70, 82, 78, 91][index]),
]);
const sparkQuery = 'avg(qv_cpu_pct{host="spark-node"})';
const instantQuery = 'avg(qv_cpu_pct{host="instant-node"})';

function sqlTile(
  title: string,
  rows: LogRecord[],
  options: {
    fixture?: typeof queryValue | typeof editorQueryValue;
    field?: string;
    xField?: string;
    layout?: Record<string, unknown>;
    query?: string;
  } = {},
): DashboardTile {
  const source = options.fixture ?? queryValue;
  const query = options.query ?? `SELECT value FROM "app-logs" /* ${title} */`;
  sqlRows.set(query, rows);
  return {
    ...structuredClone(source),
    title,
    dbName: ['app-logs'],
    chartQuery: query,
    config: {
      ...source.config,
      layout: { ...source.config.layout, ...options.layout },
      axes: {
        ...source.config.axes,
        x: { ...source.config.axes.x, field: options.xField ?? '' },
        y: { ...source.config.axes.y, field: options.field ?? 'value' },
      },
    },
  };
}

let nextTileId = 0;
function makeDashboard(title: string, dashboardId: string, tiles: DashboardTile[]): Dashboard {
  return {
    ...structuredClone(classic),
    dashboardId,
    title,
    description: 'Native query values',
    dashboardType: 'Dashboard',
    sections: [],
    variables: [],
    timeRange: { startTime: start, endTime: end, type: 'custom' },
    tiles: tiles.map((tile, index) => ({
      ...tile,
      tile_id: `${queryValue.tile_id.slice(0, -3)}${String(++nextTileId).padStart(3, '0')}`,
      layout: { x: (index % 3) * 4, y: Math.floor(index / 3) * 3, w: 4, h: 3 },
    })),
  };
}

const dashboard = makeDashboard('Query value states', classic.dashboardId, [
  sqlTile('Emerald CPU', [{ cpu_pct: 54.56 }], {
    fixture: editorQueryValue,
    field: 'cpu_pct',
    query: 'SELECT 54.56 AS cpu_pct FROM "app-logs"',
  }),
  sqlTile('Default blue', [{ count: 12345 }], {
    field: 'count',
    query: 'SELECT 12345 AS count FROM "app-logs"',
  }),
  sqlTile('Orange spark', series, {
    fixture: editorQueryValue,
    field: 'requests',
    xField: 'time_bucket',
    query: `SELECT time_bucket, requests FROM "app-logs" /* Orange spark */`,
    layout: { queryValueTheme: 'orange', sparkline: true, unit: '', precision: 0 },
  }),
  sqlTile('Purple nospark', series, {
    field: 'requests',
    xField: 'time_bucket',
    query: `SELECT time_bucket, requests FROM "app-logs" /* Purple nospark */`,
    layout: { queryValueTheme: 'purple', sparkline: false },
  }),
  sqlTile('Yellow', [{ value: 42 }], { layout: { queryValueTheme: 'yellow' } }),
  {
    ...structuredClone(promql),
    title: 'PromQL spark',
    dbName: 'otel-metrics',
    chartQuery: [sparkQuery],
    promqlQueryType: ['instant'],
    config: {
      ...promql.config,
      layout: { ...promql.config.layout, unit: '', humanize: false },
    },
  },
  {
    ...structuredClone(promql),
    title: 'PromQL nospark',
    dbName: 'otel-metrics',
    chartQuery: [instantQuery],
    promqlQueryType: ['instant'],
    config: {
      ...promql.config,
      layout: { ...promql.config.layout, unit: '', humanize: false, sparkline: false },
    },
  },
  sqlTile('Narrow milliseconds', [{ value: 1234567890.55 }], {
    layout: { queryValueTheme: 'brown', unit: 'ms', precision: 2, humanize: false },
  }),
  sqlTile('Short value', [{ value: 7 }], { layout: { queryValueTheme: 'pink' } }),
]);
dashboard.tiles!.find((tile) => tile.title === 'Narrow milliseconds')!.layout = {
  x: 4,
  y: 6,
  w: 3,
  h: 2,
};

const themesDashboard = makeDashboard(
  'Query value themes',
  `${classic.dashboardId.slice(0, -2)}EV`,
  themes.map(({ key, label }) =>
    sqlTile(label, key === 'yellow' ? series : [{ value: 7 }], {
      field: key === 'yellow' ? 'requests' : 'value',
      xField: key === 'yellow' ? 'time_bucket' : '',
      query: `SELECT ${key === 'yellow' ? 'time_bucket, requests' : 'value'} FROM "app-logs" /* theme ${key} */`,
      layout: {
        queryValueTheme: key,
        sparkline: key === 'yellow',
        unit: key === 'yellow' ? '%' : '',
        precision: 0,
      },
    }),
  ),
);
const guardsDashboard = makeDashboard(
  'Query value spark eligibility',
  `${classic.dashboardId.slice(0, -2)}ET`,
  [
    sqlTile('Scalar spark enabled', [{ value: 42 }], { layout: { sparkline: true } }),
    sqlTile(
      'Categories spark enabled',
      requestValues.map((requests, index) => ({
        category: `not-a-timestamp-${String.fromCharCode(65 + index)}`,
        requests,
      })),
      { field: 'requests', xField: 'category', layout: { sparkline: true } },
    ),
    sqlTile('Empty spark enabled', [], { layout: { sparkline: true } }),
  ],
);

const states: { title: string; text: string; theme: Theme; points?: number }[] = [
  { title: 'Emerald CPU', text: '54.56 %', theme: 'emerald' },
  { title: 'Default blue', text: '12.3K', theme: 'blue' },
  { title: 'Orange spark', text: '88', theme: 'orange', points: 12 },
  { title: 'Purple nospark', text: '88', theme: 'purple' },
  { title: 'Yellow', text: '42', theme: 'yellow' },
  { title: 'PromQL spark', text: '72.5', theme: 'blue', points: 20 },
  { title: 'PromQL nospark', text: '11.75', theme: 'blue' },
  { title: 'Narrow milliseconds', text: '1,234,567,890.55 ms', theme: 'brown' },
  { title: 'Short value', text: '7', theme: 'pink' },
];
const tile = (page: Page, name: string) =>
  page.locator('[data-tile-id]').filter({ has: page.getByRole('heading', { name, exact: true }) });
const value = (page: Page, name: string) =>
  tile(page, name).getByRole('group', { name: `${name} value`, exact: true });

type Call = { url: string; path: string; method: string; query?: string; stream?: string };
type Server = { calls: Call[]; writes: Dashboard[] };
async function mockServer(page: Page, baseURL: string): Promise<Server> {
  const calls: Call[] = [];
  const writes: Dashboard[] = [];
  const documents = new Map(
    [dashboard, themesDashboard, guardsDashboard].map((doc) => [
      doc.dashboardId,
      structuredClone(doc),
    ]),
  );
  await page.context().addCookies([
    { name: 'user_id', value: 'admin', url: baseURL },
    { name: 'username', value: 'admin', url: baseURL },
  ]);
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const params = new URLSearchParams(request.postData() ?? url.search);
    calls.push({
      url: request.url(),
      path,
      method,
      query: params.get('query') ?? undefined,
      stream: params.get('stream') ?? undefined,
    });
    if (path === '/api/v1/about')
      return route.fulfill({
        json: {
          capabilities: {
            promql: true,
            promqlDashboard: true,
            promqlMetadata: true,
            promqlAlerts: true,
          },
        },
      });
    if (path === '/api/v1/users/admin')
      return route.fulfill({ json: { id: 'admin', username: 'admin' } });
    if (path === '/api/v1/user/admin/role')
      return route.fulfill({
        json: {
          roles: { root: { actions: [{ privilege: 'admin' }], roleType: 'internal' } },
          groupRoles: {},
        },
      });
    if (path === '/api/v1/logstream')
      return route.fulfill({ json: [{ name: 'app-logs' }, { name: 'otel-metrics' }] });
    if (path.endsWith('/info'))
      return route.fulfill({
        json: {
          logSource: [
            { log_source_format: path.includes('otel-metrics') ? 'otel-metrics' : 'json' },
          ],
        },
      });
    if (path === '/api/v1/targets') return route.fulfill({ json: [] });
    if (path === '/api/v1/dashboards') return route.fulfill({ json: [...documents.values()] });
    if (path.startsWith('/api/v1/dashboards/')) {
      const id = path.split('/').at(-1)!;
      if (method === 'PUT' || method === 'POST') {
        const body = request.postDataJSON() as Dashboard;
        writes.push(structuredClone(body));
        documents.set(id, { ...body, modified: '2026-10-10T09:00:00Z' });
      }
      const doc = documents.get(id);
      return route.fulfill(doc ? { json: doc } : { status: 404, body: `Unknown dashboard ${id}` });
    }
    if (path === '/api/v1/query') {
      const sql = request.postDataJSON().query as string;
      const rows = sqlRows.get(sql);
      return route.fulfill(rows ? { json: rows } : { status: 400, body: `Unhandled SQL: ${sql}` });
    }
    if (path === '/prometheus/api/v1/query' || path === '/prometheus/api/v1/query_range') {
      const query = params.get('query');
      if (
        ![sparkQuery, instantQuery].includes(query ?? '') ||
        params.get('stream') !== 'otel-metrics'
      )
        return route.fulfill({ status: 400, body: `Unhandled PromQL: ${params}` });
      return route.fulfill({
        json: {
          status: 'success',
          data: path.endsWith('/query_range')
            ? {
                resultType: 'matrix',
                result: [{ metric: { host: 'spark-node' }, values: rangePoints }],
              }
            : {
                resultType: 'vector',
                result: [
                  {
                    metric: { host: query === sparkQuery ? 'spark-node' : 'instant-node' },
                    value: [Date.parse(end) / 1000, query === sparkQuery ? '72.5' : '11.75'],
                  },
                ],
              },
        },
      });
    }
    return route.fulfill({ status: 404, body: `Unhandled mock ${method} ${path}` });
  });
  return { calls, writes };
}

const test = base.extend<{ server: Server }>({
  server: [
    async ({ page, baseURL }, use) => {
      await use(await mockServer(page, baseURL!));
    },
    { auto: true },
  ],
});
test.use({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('parseable-theme', 'light'));
});

async function openDashboard(page: Page, doc = dashboard) {
  await page.goto(`/dashboards/${doc.dashboardId}`);
  await expect(page.getByRole('heading', { name: doc.title, exact: true })).toBeVisible();
  await expect(page.locator('.dashboard-stat[data-qv]')).toHaveCount(doc.tiles!.length);
  await expect(page.locator('[data-tile-id][aria-busy="true"]')).toHaveCount(0);
  await expect(page.locator('.dashboard-tile-error')).toHaveCount(0);
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
}
async function setTheme(page: Page, theme: Mode) {
  await page.evaluate((theme) => {
    document.documentElement.dataset.theme = theme;
  }, theme);
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}
async function directText(group: Locator) {
  return group.evaluate((element) =>
    [...element.childNodes]
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent),
  );
}
async function expectSpark(group: Locator, points: number, colour: string) {
  const svg = group.locator('svg.dashboard-stat-spark');
  await expect(svg).toHaveCount(1);
  await expect(svg).toHaveAttribute('aria-hidden', 'true');
  await expect(svg).toHaveAttribute('focusable', 'false');
  const line = svg.locator('.dashboard-stat-spark-line');
  await expect(line).toHaveCSS('stroke', colour);
  expect((await line.getAttribute('d'))!.match(/[ML]/g)).toHaveLength(points);
  await expect(svg.locator('.dashboard-stat-spark-area')).toHaveCSS('fill', colour);
  await expect(svg.locator('.dashboard-stat-spark-area')).toHaveCSS('fill-opacity', '0.14');
  await expect(line).toHaveCSS('stroke-opacity', '0.6');
}
async function fillColour(fill: Locator) {
  return fill.evaluate((element) => {
    const background = getComputedStyle(element).backgroundColor;
    // Chromium can serialize color-mix as color(srgb ...); sample its resolved RGBA.
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d')!;
    context.fillStyle = background;
    context.fillRect(0, 0, 1, 1);
    return { background, rgba: [...context.getImageData(0, 0, 1, 1).data] };
  });
}
async function expectFill(page: Page, name: string, theme: Theme, mode: Mode, percent: number) {
  const fill = value(page, name).locator('.dashboard-stat-fill');
  await expect(fill).toHaveCount(1);
  await expect(fill).toHaveAttribute('data-direction', 'horizontal');
  await expect(fill).toHaveAttribute('aria-hidden', 'true');
  expect(await fill.evaluate((element) => (element as HTMLElement).style.width)).toBe(
    `${percent}%`,
  );
  const geometry = await fill.evaluate((element) => ({
    width: element.getBoundingClientRect().width,
    cardWidth: element.closest('[data-tile-id]')!.clientWidth,
  }));
  expect(Math.abs(geometry.width - geometry.cardWidth * (percent / 100))).toBeLessThanOrEqual(1);
  const resolved = await fillColour(fill);
  const expected = themeColour(theme, mode, false).match(/\d+/g)!.map(Number);
  // Eight-bit premultiplied alpha can round a channel by up to three levels.
  for (const [index, channel] of expected.entries())
    expect(Math.abs(resolved.rgba[index] - channel), resolved.background).toBeLessThanOrEqual(3);
  expect(resolved.rgba[3] / 255, resolved.background).toBeCloseTo(0.16, 2);
}

for (const mode of ['light', 'dark'] as const) {
  test(`SQL and PromQL values, themes, percent tint and spark paths in ${mode}`, async ({
    page,
  }) => {
    await openDashboard(page);
    await setTheme(page, mode);
    for (const state of states) {
      const group = value(page, state.title);
      await expect(group).toHaveClass('dashboard-stat');
      await expect(group).toHaveAttribute('data-qv', state.theme);
      await expect(group).toHaveAttribute('data-empty', 'false');
      await expect(group).toHaveText(state.text);
      expect(await directText(group)).toEqual([state.text]);
      await expect(group).toHaveCSS('color', themeColour(state.theme, mode));
      await expect(group).toHaveCSS('font-weight', '700');
      if (state.points)
        await expectSpark(group, state.points, themeColour(state.theme, mode, false));
      else await expect(group.locator('.dashboard-stat-spark')).toHaveCount(0);
      if (state.title !== 'Emerald CPU')
        await expect(group.locator('.dashboard-stat-fill')).toHaveCount(0);
    }
    await expectFill(page, 'Emerald CPU', 'emerald', mode, 54.56);
  });

  test(`all ten themes keep their value ink and yellow tint separate in ${mode}`, async ({
    page,
  }) => {
    await openDashboard(page, themesDashboard);
    await setTheme(page, mode);
    for (const theme of themes) {
      const group = value(page, theme.label);
      await expect(group).toHaveAttribute('data-qv', theme.key);
      await expect(group).toHaveCSS('color', themeColour(theme.key, mode));
      await expect(group).toHaveText(theme.key === 'yellow' ? '88 %' : '7');
    }
    await expectFill(page, 'Yellow', 'yellow', mode, 88);
    await expectSpark(value(page, 'Yellow'), 12, themeColour('yellow', mode, false));
  });
}

test('PromQL spark requests one instant and one range; disabled spark requests only instant', async ({
  page,
  server,
}) => {
  await openDashboard(page);
  await expect(value(page, 'PromQL spark')).toHaveText('72.5');
  await expect(value(page, 'PromQL nospark')).toHaveText('11.75');
  await expectSpark(value(page, 'PromQL spark'), 20, themeColour('blue', 'light'));
  await expect(value(page, 'PromQL nospark').locator('.dashboard-stat-spark')).toHaveCount(0);
  for (const [query, endpoints] of [
    [sparkQuery, ['/prometheus/api/v1/query', '/prometheus/api/v1/query_range']],
    [instantQuery, ['/prometheus/api/v1/query']],
  ] as const) {
    const calls = server.calls.filter(
      (call) => call.query === query && call.stream === 'otel-metrics',
    );
    expect(calls.map((call) => call.path).sort()).toEqual([...endpoints].sort());
    expect(calls.every((call) => call.method === 'POST')).toBe(true);
  }
  await test.info().attach('query-value-request-urls', {
    body: JSON.stringify(server.calls, null, 2),
    contentType: 'application/json',
  });
});

test('enabled spark needs timestamp rows; scalar, categorical and empty results have no spark', async ({
  page,
}) => {
  await openDashboard(page, guardsDashboard);
  for (const [title, text] of [
    ['Scalar spark enabled', '42'],
    ['Categories spark enabled', '88'],
    ['Empty spark enabled', 'No values returned'],
  ]) {
    await expect(value(page, title)).toHaveText(text);
    await expect(value(page, title).locator('svg.dashboard-stat-spark')).toHaveCount(0);
  }
  await expect(value(page, 'Empty spark enabled')).toHaveAttribute('data-empty', 'true');
  await expect(value(page, 'Empty spark enabled')).toHaveCSS('font-size', '16px');
});

async function textGeometry(group: Locator) {
  return group.evaluate((element) => {
    const el = [...element.childNodes].find(
      (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
    )!;
    const range = document.createRange();
    range.selectNodeContents(el);
    const text = range.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    return {
      text: el.textContent,
      textWidth: text.width,
      clientWidth: element.clientWidth,
      clientHeight: element.clientHeight,
      widthLimit: 0.9 * (element.clientWidth - 16),
      fontSize: parseFloat(getComputedStyle(element).fontSize),
      left: text.left - box.left,
      right: box.right - text.right,
    };
  });
}

for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 800, height: 700 },
  { width: 420, height: 800 },
]) {
  test(`text fits its padding and refits at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await openDashboard(page);
    const short = value(page, 'Short value');
    await expect.poll(async () => (await textGeometry(short)).fontSize).toBeGreaterThan(60);
    await page.setViewportSize(viewport);
    const measurements = [];
    try {
      for (const name of ['Narrow milliseconds', 'Short value']) {
        const group = value(page, name);
        await expect(group).toHaveText(name === 'Short value' ? '7' : '1,234,567,890.55 ms');
        await expect
          .poll(
            async () => {
              const geometry = await textGeometry(group);
              return geometry.textWidth - geometry.widthLimit;
            },
            { message: `${name} text must fit 90% of (clientWidth - 16)` },
          )
          .toBeLessThanOrEqual(1);
        const geometry = await textGeometry(group);
        measurements.push({ viewport, name, ...geometry });
        expect(geometry.textWidth).toBeLessThanOrEqual(geometry.clientWidth);
        expect(geometry.left).toBeGreaterThanOrEqual(8);
        expect(geometry.right).toBeGreaterThanOrEqual(8);
        expect(geometry.fontSize).toBeGreaterThanOrEqual(10);
        expect(geometry.fontSize).toBeLessThanOrEqual(100);
        expect(geometry.fontSize).toBeLessThanOrEqual(0.7 * geometry.clientHeight);
        if (geometry.fontSize >= 20) expect((100 - geometry.fontSize) % 4).toBe(0);
      }
    } finally {
      const narrow = await textGeometry(value(page, 'Narrow milliseconds'));
      measurements.push({ viewport, name: 'Narrow milliseconds at completion', ...narrow });
      await test.info().attach('query-value-text-geometry', {
        body: JSON.stringify(measurements, null, 2),
        contentType: 'application/json',
      });
      console.log('Query value text geometry:', measurements);
      await mkdir(shots, { recursive: true });
      await tile(page, 'Narrow milliseconds').screenshot({
        path: join(shots, `qv-narrow-${viewport.width}.png`),
        animations: 'disabled',
      });
    }
  });
}

async function tileAction(page: Page, title: string, action: string) {
  await page.getByRole('button', { name: `Actions for tile ${title}`, exact: true }).click();
  await page.getByRole('menuitem', { name: action, exact: true }).click();
}
test('editing theme and spark previews, applies, reopens and saves without losing stored layout keys', async ({
  page,
  server,
}) => {
  await openDashboard(page);
  await tileAction(page, 'Orange spark', 'Edit');
  const editor = page.getByRole('dialog', { name: 'Edit tile', exact: true });
  const theme = editor.getByLabel('Theme', { exact: true });
  const spark = editor.getByLabel('Spark chart', { exact: true });
  await expect(theme.locator('option')).toHaveCount(10);
  await expect(theme.locator('option')).toHaveText(themes.map(({ label }) => label));
  await expect(theme).toHaveValue('orange');
  await expect(spark).toHaveValue('enabled');
  await theme.selectOption({ label: 'Fuchsia' });
  await spark.selectOption({ label: 'Disabled' });
  await editor.getByRole('button', { name: 'Run query', exact: true }).click();
  const preview = editor.getByRole('group', { name: 'Orange spark value', exact: true });
  await expect(preview).toHaveAttribute('data-qv', 'fuchsia');
  await expect(preview).toHaveText('88');
  await expect(preview.locator('svg.dashboard-stat-spark')).toHaveCount(0);
  await editor.getByRole('button', { name: 'Apply tile', exact: true }).click();
  await expect(editor).toBeHidden();
  await expect(value(page, 'Orange spark')).toHaveAttribute('data-qv', 'fuchsia');
  await expect(value(page, 'Orange spark').locator('svg.dashboard-stat-spark')).toHaveCount(0);
  await tileAction(page, 'Orange spark', 'Edit');
  await expect(theme).toHaveValue('fuchsia');
  await expect(spark).toHaveValue('disabled');
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Dashboard saved.', { exact: true })).toBeVisible();
  expect(server.writes).toHaveLength(1);
  const original = dashboard.tiles!.find((tile) => tile.title === 'Orange spark')!;
  const config = original.config as typeof editorQueryValue.config;
  const expected = structuredClone(dashboard);
  expected.tiles = expected.tiles!.map((tile) =>
    tile.tile_id === original.tile_id
      ? {
          ...tile,
          config: {
            ...config,
            layout: { ...config.layout, queryValueTheme: 'fuchsia', sparkline: false },
          },
        }
      : tile,
  );
  expect(server.writes[0]).toEqual(expected);
  const saved = server.writes[0].tiles!.find((tile) => tile.tile_id === original.tile_id)!;
  expect((saved.config as typeof editorQueryValue.config).layout).toMatchObject({
    queryValueTheme: 'fuchsia',
    sparkline: false,
    segments: config.layout.segments,
    legendPosition: 'left',
  });
  expect(
    server.calls.filter(
      (call) =>
        call.path === `/api/v1/dashboards/${dashboard.dashboardId}` &&
        ['PUT', 'POST'].includes(call.method),
    ),
  ).toHaveLength(1);
  await page.reload();
  await expect(value(page, 'Orange spark')).toHaveAttribute('data-qv', 'fuchsia');
  await expect(value(page, 'Orange spark').locator('svg.dashboard-stat-spark')).toHaveCount(0);
  await tileAction(page, 'Orange spark', 'Edit');
  await expect(theme).toHaveValue('fuchsia');
  await expect(spark).toHaveValue('disabled');
});
// dashboard-editor.spec.ts already verifies that choosing Query value writes sparkline: true.

async function axe(page: Page, name: string) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addStyleTag({
    content: '*, *::before, *::after { animation: none !important; transition: none !important; }',
  });
  await page.evaluate(async () => {
    await Promise.allSettled(document.getAnimations().map((animation) => animation.finished));
  });
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  // Keep every finding, including incomplete contrast checks; exclude no nodes or rules.
  await test.info().attach(`axe-results-${name}`, {
    body: JSON.stringify(result, null, 2),
    contentType: 'application/json',
  });
  for (const violation of result.violations.filter((finding) => finding.id === 'color-contrast'))
    console.log(`Axe contrast ${name}:`, JSON.stringify(violation.nodes, null, 2));
  expect.soft(result.violations, `WCAG findings on ${name}`).toEqual([]);
}
for (const mode of ['light', 'dark'] as const) {
  test(`WCAG accessibility with all themes, yellow ink and percent fill in ${mode}`, async ({
    page,
  }) => {
    for (const doc of [dashboard, themesDashboard]) {
      await openDashboard(page, doc);
      await setTheme(page, mode);
      await axe(page, `${doc.title}-${mode}`);
    }
  });

  test(`save dashboard, themes grid and four tile screenshots in ${mode}`, async ({ page }) => {
    await mkdir(shots, { recursive: true });
    await openDashboard(page);
    await setTheme(page, mode);
    await expect(value(page, 'Emerald CPU')).toHaveCSS('color', themeColour('emerald', mode));
    await page.screenshot({
      path: join(shots, `qv-dashboard-${mode}.png`),
      fullPage: true,
      animations: 'disabled',
    });
    for (const [name, file] of [
      ['Emerald CPU', 'emerald-cpu'],
      ['Orange spark', 'orange-spark'],
      ['Purple nospark', 'purple-nospark'],
      ['PromQL spark', 'promql-spark'],
    ])
      await tile(page, name).screenshot({
        path: join(shots, `qv-${file}-${mode}.png`),
        animations: 'disabled',
      });
    await openDashboard(page, themesDashboard);
    await setTheme(page, mode);
    await expect(value(page, 'Yellow')).toHaveCSS('color', themeColour('yellow', mode));
    await page.screenshot({
      path: join(shots, `qv-themes-${mode}.png`),
      fullPage: true,
      animations: 'disabled',
    });
  });
}
