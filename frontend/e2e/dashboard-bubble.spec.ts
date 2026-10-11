import { test, expect, type Locator, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type { Dashboard, DashboardTile } from '../src/lib/types';

const id = '01K7A000000000000000000001';
const detail = `/dashboards/${id}`;
const tile = (page: Page, title: string) =>
  page
    .locator('[data-tile-id]')
    .filter({ has: page.getByRole('heading', { name: title, exact: true }) });
const figure = (page: Page, title: string) =>
  tile(page, title).getByRole('group', { name: `${title} chart`, exact: true });

function bubbleTile(
  title: string,
  {
    index = 0,
    xField = 'duration_ms',
    sizeField = 'total',
    groupBy = [],
    legendPosition = 'bottom',
    precision,
  }: {
    index?: number;
    xField?: string;
    sizeField?: string | null;
    groupBy?: string | string[];
    legendPosition?: 'top' | 'bottom' | 'left' | 'right';
    precision?: number;
  } = {},
) {
  return {
    tile_id: `01K7A0000000000000000000${String(index + 10).padStart(2, '0')}`,
    title,
    authorMode: 'manual',
    tileType: 'code',
    chartType: 'bubble',
    chartQuery:
      'SELECT "duration_ms", "payload_bytes", "total", "service" FROM "app-logs" LIMIT 100',
    dbName: ['app-logs'],
    config: {
      type: 'bubble',
      colourScheme: 'classic',
      layout: {
        legendPosition,
        segments: { value: [10, 90], isPercent: true },
        label: false,
        ...(precision === undefined ? {} : { precision }),
      },
      axes: {
        x: { field: xField, title: xField, display: true },
        y: { field: 'payload_bytes', title: 'payload_bytes', display: true, beginAtZero: true },
        ...(sizeField === null ? {} : { size: { field: sizeField } }),
        groupBy: { field: groupBy },
      },
      advanced: {
        dataLabels: { enabled: false },
        tooltip: { enabled: true, mode: 'index', intersect: false },
      },
    },
    layout: { x: index % 2 ? 6 : 0, y: Math.floor(index / 2) * 9, w: 6, h: 9 },
  } satisfies DashboardTile;
}

function dashboard(tiles: DashboardTile[]): Dashboard {
  return {
    dashboardId: id,
    version: 'v1',
    title: 'Bubble dashboard',
    author: '8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918',
    created: '2026-09-01T10:00:00Z',
    modified: '2026-10-10T08:00:00Z',
    tenantId: 'example',
    tags: ['e2e'],
    isFavorite: false,
    dashboardType: 'Report',
    description: 'SQL bubble chart coverage',
    timeRange: {
      startTime: '1h',
      endTime: 'now',
      type: 'fixed',
      label: 'Last 1 hour',
      interval: 3600000,
      shiftInterval: 1,
    },
    variables: [],
    sections: [],
    tiles,
  };
}

async function mockServer(
  page: Page,
  baseURL: string | undefined,
  options: {
    document: Dashboard;
    queryRows?: Record<string, unknown>[];
    enabled?: boolean;
  },
) {
  await page.addInitScript(() => sessionStorage.setItem('parseable-mode', 'live'));
  await page.context().addCookies(
    ['user_id', 'username'].map((name) => ({
      name,
      value: 'admin',
      url: new URL(baseURL ?? 'http://127.0.0.1').origin,
    })),
  );
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/v1/about')
      return route.fulfill({
        json: {
          license: { plan: 'Enterprise' },
          capabilities: {
            promql: options.enabled ?? true,
            promqlDashboard: options.enabled ?? true,
            promqlMetadata: options.enabled ?? true,
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
    if (route.request().method() === 'GET' && path === '/api/v1/dashboards') {
      const { dashboardId, title, author, created, modified, tags, isFavorite } = options.document;
      return route.fulfill({
        json: [{ dashboardId, title, author, created, modified, tags, isFavorite }],
      });
    }
    if (route.request().method() === 'GET' && path === `/api/v1/dashboards/${id}`)
      return route.fulfill({ json: options.document });
    if (path === '/api/v1/query') return route.fulfill({ json: options.queryRows ?? [] });
    if (path.startsWith('/prometheus/api/v1/label/') || path === '/prometheus/api/v1/labels')
      return route.fulfill({ json: { status: 'success', data: [] } });
    if (path === '/prometheus/api/v1/query_range')
      return route.fulfill({
        json: {
          status: 'success',
          data: {
            resultType: 'matrix',
            result: [
              {
                metric: { service: 'payments' },
                values: [
                  [1791619200, '3'],
                  [1791619230, '4'],
                ],
              },
            ],
          },
        },
      });
    return route.fulfill({ status: 404, body: `Unhandled mock ${path}` });
  });
}

async function axe(page: Page) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addStyleTag({
    content: '*, *::before, *::after { animation: none !important; transition: none !important; }',
  });
  await page.evaluate(async () => {
    await Promise.allSettled(document.getAnimations().map((animation) => animation.finished));
  });
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
}

async function tooltipValues(tooltip: Locator, values: Record<string, string>) {
  await expect(tooltip).toBeVisible();
  for (const [field, value] of Object.entries(values)) {
    await expect(tooltip.getByText(field, { exact: true })).toBeVisible();
    await expect(tooltip.getByText(value, { exact: true })).toBeVisible();
  }
}

test.use({ timezoneId: 'America/Chicago' });

test('SQL bubbles retain row order, scale radius by sqrt(size), and use 11px for equal sizes', async ({
  page,
  baseURL,
}) => {
  const document = dashboard([
    bubbleTile('Sized bubbles'),
    bubbleTile('Equal sizes', { index: 1, sizeField: 'equal_size' }),
  ]);
  await mockServer(page, baseURL, {
    document,
    queryRows: [
      { duration_ms: 3000, payload_bytes: 512, total: 0, equal_size: 7 },
      { duration_ms: 1000, payload_bytes: 128, total: 25, equal_size: 7 },
      { duration_ms: 2000, payload_bytes: 256, total: 100, equal_size: 7 },
    ],
  });
  await page.goto(detail);
  const points = figure(page, 'Sized bubbles').locator('circle.charts-bubble-point');
  await expect(points).toHaveCount(3);
  const geometry = await points.evaluateAll((points) =>
    points.map((point) => ({
      r: Number(point.getAttribute('r') ?? NaN),
      x: Number(point.getAttribute('cx') ?? NaN),
      y: Number(point.getAttribute('cy') ?? NaN),
      opacity: Number(point.getAttribute('fill-opacity')),
      stroke: getComputedStyle(point).stroke,
    })),
  );
  expect(geometry.map(({ r }) => r)).toEqual([4, 11, 18]);
  for (const point of geometry) {
    expect([point.r, point.x, point.y].every(Number.isFinite)).toBe(true);
    expect(point.opacity).toBe(0.2);
    expect(point.stroke).toBe('none');
  }
  expect(geometry[0].x).toBeGreaterThan(geometry[2].x);
  expect(geometry[2].x).toBeGreaterThan(geometry[1].x);
  const equal = figure(page, 'Equal sizes').locator('circle.charts-bubble-point');
  await expect(equal).toHaveCount(3);
  expect(
    await equal.evaluateAll((points) => points.map((point) => Number(point.getAttribute('r')))),
  ).toEqual([11, 11, 11]);
});

test('missing size and two-column results use a constant 11px radius', async ({
  page,
  baseURL,
}) => {
  await mockServer(page, baseURL, {
    document: dashboard([
      bubbleTile('No size column', { sizeField: null }),
      bubbleTile('Missing configured size', { index: 1, sizeField: 'missing' }),
    ]),
    queryRows: [
      { duration_ms: 5, payload_bytes: 10 },
      { duration_ms: 15, payload_bytes: 20 },
    ],
  });
  await page.goto(detail);
  for (const title of ['No size column', 'Missing configured size']) {
    const points = figure(page, title).locator('circle.charts-bubble-point');
    await expect(points).toHaveCount(2);
    expect(
      await points.evaluateAll((points) => points.map((point) => Number(point.getAttribute('r')))),
    ).toEqual([11, 11]);
  }
});

test('hover and keyboard inspect labelled values, sorted x navigation and Escape without a tab flood', async ({
  page,
  baseURL,
}) => {
  await mockServer(page, baseURL, {
    document: dashboard([bubbleTile('Inspect bubbles', { groupBy: 'service', precision: 2 })]),
    queryRows: [
      { duration_ms: 3000, payload_bytes: 512, total: 100, service: 'payments' },
      { duration_ms: 1000, payload_bytes: 128, total: 25, service: 'checkout' },
      { duration_ms: 2000, payload_bytes: 256, total: 50, service: 'payments' },
    ],
  });
  await page.goto(detail);
  const chart = figure(page, 'Inspect bubbles'),
    points = chart.locator('circle.charts-bubble-point'),
    plot = chart.locator('.charts-plot'),
    tooltip = page.getByRole('tooltip');
  await expect(points).toHaveCount(3);
  await expect(plot).toHaveAttribute('tabindex', '0');
  expect(
    await points.evaluateAll((points) => points.map((point) => point.getAttribute('tabindex'))),
  ).toEqual(['-1', '-1', '-1']);
  await points.first().hover();
  await expect(points.first()).toHaveAttribute('fill-opacity', '0.2');
  await tooltipValues(tooltip, {
    duration_ms: '3,000',
    payload_bytes: '512.00',
    total: '100.00',
    service: 'payments',
  });
  await page.mouse.move(0, 0);
  await expect(tooltip).toBeHidden();
  await plot.focus();
  await page.keyboard.press('Home');
  await expect(points.nth(1)).toBeFocused();
  await expect(points.nth(1)).toHaveAccessibleName(/duration_ms/);
  await expect(points.nth(1)).toHaveAccessibleName(/1,000/);
  await tooltipValues(tooltip, {
    duration_ms: '1,000',
    payload_bytes: '128.00',
    total: '25.00',
    service: 'checkout',
  });
  await page.keyboard.press('ArrowRight');
  await expect(points.nth(2)).toBeFocused();
  await tooltipValues(tooltip, {
    duration_ms: '2,000',
    payload_bytes: '256.00',
    total: '50.00',
    service: 'payments',
  });
  await page.keyboard.press('ArrowLeft');
  await expect(points.nth(1)).toBeFocused();
  await page.keyboard.press('End');
  await expect(points.nth(0)).toBeFocused();
  await tooltipValues(tooltip, {
    duration_ms: '3,000',
    payload_bytes: '512.00',
    total: '100.00',
    service: 'payments',
  });
  await page.keyboard.press('Home');
  await expect(points.nth(1)).toBeFocused();
  await tooltipValues(tooltip, {
    duration_ms: '1,000',
    payload_bytes: '128.00',
    total: '25.00',
    service: 'checkout',
  });
  await page.keyboard.press('Escape');
  await expect(tooltip).toBeHidden();
  await page.keyboard.press('Tab');
  await expect(chart.locator('.charts-bubble-point:focus')).toHaveCount(0);
});

test('group legend uses first appearance palette order and occupies the right of the plot', async ({
  page,
  baseURL,
}) => {
  await mockServer(page, baseURL, {
    document: dashboard([
      bubbleTile('Grouped bubbles', { groupBy: ['service'], legendPosition: 'right' }),
      bubbleTile('Ungrouped bubbles', { index: 1 }),
    ]),
    queryRows: [
      { duration_ms: 300, payload_bytes: 512, total: 25, service: 'payments' },
      { duration_ms: 100, payload_bytes: 128, total: 100, service: 'checkout' },
      { duration_ms: 200, payload_bytes: 256, total: 50, service: 'payments' },
    ],
  });
  await page.goto(detail);
  const chart = figure(page, 'Grouped bubbles'),
    points = chart.locator('circle.charts-bubble-point'),
    legend = chart.locator('ul.charts-legend');
  await expect(points).toHaveCount(3);
  await expect(legend.getByRole('listitem')).toHaveText(['payments', 'checkout']);
  expect(
    await points.evaluateAll((points) =>
      points.map((point) => point.getAttribute('fill')?.toUpperCase()),
    ),
  ).toEqual(['#3B82F6', '#10B981', '#3B82F6']);
  await expect(tile(page, 'Grouped bubbles').locator('.dashboard-chart')).toHaveAttribute(
    'data-legend-position',
    'right',
  );
  const [plotBounds, legendBounds] = await Promise.all([
    chart.locator('.charts-plot').boundingBox(),
    legend.boundingBox(),
  ]);
  expect(plotBounds).not.toBeNull();
  expect(legendBounds).not.toBeNull();
  expect(legendBounds!.x).toBeGreaterThanOrEqual(plotBounds!.x + plotBounds!.width - 1);
  expect(legendBounds!.y).toBeLessThan(plotBounds!.y + plotBounds!.height);
  expect(legendBounds!.y + legendBounds!.height).toBeGreaterThan(plotBounds!.y);
  await expect(figure(page, 'Ungrouped bubbles').locator('circle.charts-bubble-point')).toHaveCount(
    3,
  );
  await expect(figure(page, 'Ungrouped bubbles').locator('.charts-legend')).toHaveCount(0);
});

for (const span of ['within a day', 'over multiple days'])
  test(`timestamp x uses UTC 24-hour ticks ${span} and a full date-time tooltip`, async ({
    page,
    baseURL,
  }) => {
    const timestamps =
      span === 'within a day'
        ? ['2026-10-10T00:05:00Z', '2026-10-10T05:05:00Z', '2026-10-10T10:05:00Z']
        : ['2026-10-10T00:05:00Z', '2026-10-11T12:05:00Z', '2026-10-13T00:05:00Z'];
    await mockServer(page, baseURL, {
      document: dashboard([bubbleTile('Timestamp bubbles', { xField: 'timestamp' })]),
      queryRows: timestamps.map((timestamp, index) => ({
        timestamp,
        payload_bytes: (index + 1) * 128,
        total: (index + 1) * 25,
      })),
    });
    await page.goto(detail);
    const chart = figure(page, 'Timestamp bubbles'),
      points = chart.locator('circle.charts-bubble-point');
    await expect(points).toHaveCount(3);
    const labels = (await chart.locator('.charts-bubble-x-tick').allTextContents()).map((label) =>
      label.trim(),
    );
    expect(labels.length).toBeGreaterThan(1);
    if (span === 'within a day')
      expect(labels.every((label) => /^\d{2}:\d{2}$/.test(label))).toBe(true);
    else
      expect(
        labels.some((label) =>
          /\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}|[A-Za-z]{3,9}\s+\d{1,2}|\d{1,2}\s+[A-Za-z]{3,9}/.test(
            label,
          ),
        ),
      ).toBe(true);
    await points.first().hover();
    const tooltip = page.getByRole('tooltip');
    await expect(tooltip).toBeVisible();
    await expect(tooltip.getByText('timestamp', { exact: true })).toBeVisible();
    await expect(tooltip).toContainText('2026');
    await expect(tooltip).toContainText(/Oct(?:ober)?\s+10|10\s+Oct(?:ober)?|10\/10|2026-10-10/);
    await expect(tooltip).toContainText(/00:05|12:05(?::00)?\s*AM/);
  });

for (const scenario of ['enabled', 'capability disabled', 'missing variable'])
  test(`PromQL bubble shows its explicit status without page errors: ${scenario}`, async ({
    page,
    baseURL,
  }) => {
    const template = bubbleTile('PromQL bubble');
    const promql: DashboardTile = {
      ...template,
      tileType: 'promql',
      chartQuery: [
        scenario === 'missing variable'
          ? 'sum by (service) (rate(http_requests_total{service=~"$service"}[5m]))'
          : 'sum by (service) (rate(http_requests_total[5m]))',
      ],
      dbName: 'otel-metrics',
      promqlQueryType: ['range'],
      config: {
        ...template.config,
        axes: {
          x: { field: '', title: '', display: true },
          y: { field: '', title: '', display: true, beginAtZero: false },
        },
      },
    };
    const document = dashboard([promql]);
    if (scenario === 'missing variable')
      document.variables = [
        {
          name: 'service',
          label: 'Service',
          type: 'promql',
          dataset: 'otel-metrics',
          labelName: 'service',
        },
      ];
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await mockServer(page, baseURL, { document, enabled: scenario !== 'capability disabled' });
    await page.goto(detail);
    await expect(tile(page, 'PromQL bubble').getByRole('status')).toHaveText(
      'Bubble charts are not available for PromQL tiles.',
    );
    await expect(tile(page, 'PromQL bubble').locator('circle.charts-bubble-point')).toHaveCount(0);
    await page.waitForLoadState('networkidle');
    expect(errors).toEqual([]);
  });

for (const theme of ['light', 'dark'])
  test(`axe ${theme} on grouped bubbles and the keyboard tooltip`, async ({ page, baseURL }) => {
    await page.addInitScript((theme) => localStorage.setItem('parseable-theme', theme), theme);
    await mockServer(page, baseURL, {
      document: dashboard([bubbleTile('Accessible bubbles', { groupBy: ['service'] })]),
      queryRows: [
        { duration_ms: 30, payload_bytes: 512, total: 25, service: 'payments' },
        { duration_ms: 10, payload_bytes: 128, total: 100, service: 'checkout' },
        { duration_ms: 20, payload_bytes: 256, total: 50, service: 'payments' },
      ],
    });
    await page.goto(detail);
    const chart = figure(page, 'Accessible bubbles');
    await expect(chart.locator('circle.charts-bubble-point')).toHaveCount(3);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await axe(page);
    await page.mouse.move(0, 0);
    await chart.locator('.charts-plot').focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tooltip')).toBeVisible();
    await axe(page);
  });

test('invalid rows are skipped before the first 2000 valid points are capped', async ({
  page,
  baseURL,
}) => {
  await mockServer(page, baseURL, {
    document: dashboard([bubbleTile('Capped bubbles')]),
    queryRows: [
      { duration_ms: 'not a number', payload_bytes: 1, total: 1 },
      { duration_ms: 1, payload_bytes: 'not a number', total: 1 },
      ...Array.from({ length: 2001 }, (_, index) => ({
        duration_ms: 2001 - index,
        payload_bytes: index + 1,
        total: index + 1,
      })),
    ],
  });
  await page.goto(detail);
  const points = figure(page, 'Capped bubbles').locator('circle.charts-bubble-point');
  await expect(points).toHaveCount(2000);
  await expect(tile(page, 'Capped bubbles')).toContainText(/first\s+2,?000\s+of\s+2,?001/i);
  await expect(points.first()).toHaveAccessibleName(/2,001/);
  expect(
    await points.evaluateAll((points) =>
      points.every((point) =>
        ['cx', 'cy', 'r'].every((attribute) =>
          Number.isFinite(Number(point.getAttribute(attribute) ?? NaN)),
        ),
      ),
    ),
  ).toBe(true);
  expect(Number(await points.first().getAttribute('cx'))).toBeGreaterThan(
    Number(await points.last().getAttribute('cx')),
  );
});

test('empty SQL results show the selected time range message without points or a legend', async ({
  page,
  baseURL,
}) => {
  await mockServer(page, baseURL, {
    document: dashboard([bubbleTile('Empty bubbles', { groupBy: ['service'] })]),
    queryRows: [],
  });
  await page.goto(detail);
  await expect(tile(page, 'Empty bubbles')).toContainText('No results for the selected time range');
  await expect(tile(page, 'Empty bubbles').locator('circle.charts-bubble-point')).toHaveCount(0);
  await expect(tile(page, 'Empty bubbles').locator('.charts-legend')).toHaveCount(0);
});
