import { test, expect, type Locator, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import classic from '../src/features/dashboards/__fixtures__/classic.json' with { type: 'json' };
import gauge from '../src/features/dashboards/__fixtures__/gauge/gauge.json' with { type: 'json' };
import absolute from '../src/features/dashboards/__fixtures__/gauge/gauge-absolute-segments.json' with { type: 'json' };
import promql from '../src/features/dashboards/__fixtures__/gauge/promql-gauge.json' with { type: 'json' };
import type { Dashboard, LogRecord } from '../src/lib/types';

const dashboard: Dashboard = {
  ...classic,
  title: 'Gauge states',
  sections: [],
  variables: [],
  tiles: [
    { ...gauge, title: 'Green gauge', chartQuery: 'SELECT 5 AS utilization FROM "app-logs"' },
    { ...gauge, title: 'Yellow gauge', chartQuery: 'SELECT 50 AS utilization FROM "app-logs"' },
    { ...gauge, title: 'Red gauge', chartQuery: 'SELECT 95 AS utilization FROM "app-logs"' },
    { ...gauge, title: 'Overflow gauge', chartQuery: 'SELECT 140 AS utilization FROM "app-logs"' },
    {
      ...absolute,
      title: 'Absolute GB gauge',
      chartQuery: 'SELECT 320.4 AS disk_used_gb FROM "app-logs"',
    },
    { ...promql, title: 'PromQL gauge', dbName: 'otel-metrics' },
    {
      ...gauge,
      title: 'Native gauge',
      chartQuery: 'SELECT \'x\' AS a, 42 AS b FROM "app-logs"',
      config: {
        ...gauge.config,
        axes: { ...gauge.config.axes, y: { ...gauge.config.axes.y, field: '' } },
      },
    },
    {
      ...gauge,
      title: 'Empty gauge',
      chartQuery: 'SELECT utilization FROM "app-logs" WHERE 1 = 0',
    },
    {
      ...gauge,
      title: 'Degenerate gauge',
      chartQuery: 'SELECT 60 AS utilization FROM "app-logs"',
      config: {
        ...gauge.config,
        layout: { ...gauge.config.layout, rangeFrom: 50, rangeTo: 50 },
      },
    },
  ].map((tile, index) => ({
    ...tile,
    tile_id: `${gauge.tile_id.slice(0, -2)}${String(index + 1).padStart(2, '0')}`,
    layout: { x: (index % 3) * 4, y: Math.floor(index / 3) * 3, w: 4, h: 3 },
  })),
};

const states = [
  { title: 'Green gauge', min: 0, max: 100, now: 5, text: '5', level: 'green', fraction: 0.05 },
  { title: 'Yellow gauge', min: 0, max: 100, now: 50, text: '50', level: 'yellow', fraction: 0.5 },
  { title: 'Red gauge', min: 0, max: 100, now: 95, text: '95', level: 'red', fraction: 0.95 },
  { title: 'Overflow gauge', min: 0, max: 100, now: 100, text: '140', level: 'red', fraction: 1 },
  {
    title: 'Absolute GB gauge',
    min: 0,
    max: 500,
    now: 320.4,
    text: '320.4 GB',
    level: 'yellow',
    fraction: 0.6408,
  },
  {
    title: 'PromQL gauge',
    min: 0,
    max: 100,
    now: 72.5,
    text: '72.5 %',
    level: 'yellow',
    fraction: 0.725,
  },
  { title: 'Native gauge', min: 0, max: 100, now: 42, text: '42', level: 'yellow', fraction: 0.42 },
  { title: 'Degenerate gauge', min: 50, max: 50, now: 50, text: '60', level: 'red', fraction: 1 },
] as const;
const colours = {
  green: 'rgb(16, 185, 129)',
  yellow: 'rgb(234, 179, 8)',
  red: 'rgb(220, 38, 38)',
};
const sqlRows: Record<string, LogRecord[]> = {
  'SELECT 5 AS utilization': [{ utilization: 5 }],
  'SELECT 50 AS utilization': [{ utilization: 50 }],
  'SELECT 95 AS utilization': [{ utilization: 95 }],
  'SELECT 140 AS utilization': [{ utilization: 140 }],
  'SELECT 320.4 AS disk_used_gb': [{ disk_used_gb: 320.4 }],
  "SELECT 'x' AS a, 42 AS b": [{ a: 'x', b: 42 }],
  'SELECT utilization FROM "app-logs" WHERE 1 = 0': [],
  'SELECT 60 AS utilization': [{ utilization: 60 }],
};
const tile = (page: Page, name: string) =>
  page.locator('[data-tile-id]').filter({ has: page.getByRole('heading', { name, exact: true }) });
const meter = (page: Page, name: string) => page.getByRole('meter', { name, exact: true });
const track = (meter: Locator) => meter.locator('svg > path').first();

async function mockServer(page: Page, baseURL: string) {
  await page.context().addCookies([
    { name: 'user_id', value: 'admin', url: baseURL },
    { name: 'username', value: 'admin', url: baseURL },
  ]);
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
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
    if (path === '/api/v1/dashboards') return route.fulfill({ json: [dashboard] });
    if (path === `/api/v1/dashboards/${dashboard.dashboardId}`)
      return route.fulfill({ json: dashboard });
    if (path === '/api/v1/query') {
      const sql = request.postDataJSON().query as string;
      const match = Object.entries(sqlRows).find(([query]) => sql.includes(query));
      return route.fulfill(
        match ? { json: match[1] } : { status: 400, body: `Unhandled SQL: ${sql}` },
      );
    }
    if (path === '/prometheus/api/v1/query')
      return route.fulfill({
        json: {
          status: 'success',
          data: {
            resultType: 'vector',
            result: [{ metric: { host: 'node-a' }, value: [Date.now() / 1000, '72.5'] }],
          },
        },
      });
    return route.fulfill({ status: 404, body: `Unhandled mock ${path}` });
  });
}

async function setTheme(page: Page, theme: 'light' | 'dark') {
  await page.evaluate((theme) => {
    document.documentElement.dataset.theme = theme;
  }, theme);
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}

async function axe(page: Page) {
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
  // Keep the full report, including SVG text contrast marked incomplete; exclude no rules or nodes.
  await test.info().attach('axe-results', {
    body: JSON.stringify(result, null, 2),
    contentType: 'application/json',
  });
  expect(result.violations).toEqual([]);
}

async function expectGeometry(page: Page) {
  for (const state of states) {
    const card = tile(page, state.title);
    const svg = (await meter(page, state.title).locator('svg').boundingBox())!;
    expect(svg.width).toBeGreaterThan(0);
    expect(svg.height).toBeGreaterThan(0);
    for (const container of [card, card.locator('.dashboard-tile-body')]) {
      const bounds = (await container.boundingBox())!;
      expect(svg.x).toBeGreaterThanOrEqual(bounds.x - 1);
      expect(svg.y).toBeGreaterThanOrEqual(bounds.y - 1);
      expect(svg.x + svg.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1);
      expect(svg.y + svg.height).toBeLessThanOrEqual(bounds.y + bounds.height + 1);
    }
  }
}

test.beforeEach(async ({ page, baseURL }) => {
  await mockServer(page, baseURL!);
  await page.addInitScript(() => localStorage.setItem('parseable-theme', 'light'));
  await page.goto(`/dashboards/${dashboard.dashboardId}`);
  await expect(page.getByRole('heading', { name: dashboard.title, exact: true })).toBeVisible();
  await expect(page.getByRole('meter')).toHaveCount(states.length);
  await expect(tile(page, 'Empty gauge').locator('.dashboard-stat')).toHaveText(
    'No values returned',
  );
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('SQL and PromQL gauges show their original value with the expected range, fraction and colour', async ({
  page,
}) => {
  for (const state of states) {
    const gauge = meter(page, state.title);
    const arc = gauge.locator('.charts-gauge-arc');
    const text = gauge.locator('svg text');
    await expect(gauge).toHaveAttribute('aria-valuemin', String(state.min));
    await expect(gauge).toHaveAttribute('aria-valuemax', String(state.max));
    await expect(gauge).toHaveAttribute('aria-valuenow', String(state.now));
    await expect(gauge).toHaveAttribute('aria-valuetext', state.text);
    await expect(gauge).toHaveAttribute('data-level', state.level);
    await expect(arc).toHaveAttribute('data-fraction', /^\d+(\.\d+)?$/);
    expect(Number(await arc.getAttribute('data-fraction'))).toBeCloseTo(state.fraction, 10);
    await expect(gauge).toHaveAttribute(
      'data-fraction',
      (await arc.getAttribute('data-fraction'))!,
    );
    await expect(arc).toHaveCSS('stroke', colours[state.level]);
    await expect(text).toHaveText(state.text);
    await expect(text).toHaveCSS('fill', colours[state.level]);
    await expect(gauge.locator('svg')).toHaveAttribute('aria-hidden', 'true');
    await expect(track(gauge)).toHaveAttribute('fill', 'var(--chart-gauge-track)');
    await expect(track(gauge)).toHaveCSS('fill', 'rgb(241, 242, 246)');
  }
  await expect(meter(page, 'Overflow gauge').locator('.charts-gauge-arc')).toHaveAttribute(
    'data-fraction',
    '1',
  );
  await expect(tile(page, 'Empty gauge').getByRole('meter')).toHaveCount(0);
  await expect(page.locator('.dashboard-tile-error')).toHaveCount(0);
});

test('gauges fit inside their tile bodies and cards before and after a viewport resize', async ({
  page,
}) => {
  await expectGeometry(page);
  await page.setViewportSize({ width: 800, height: 600 });
  await expectGeometry(page);
});

test('prefers-reduced-motion disables the gauge arc transition', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const arc = meter(page, 'Yellow gauge').locator('.charts-gauge-arc');
  await expect(arc).toHaveCSS('transition-duration', '0.4s');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const state of states) {
    const arc = meter(page, state.title).locator('.charts-gauge-arc');
    await expect(arc).toHaveCSS('transition-duration', '0s');
    await expect(arc).toHaveCSS('transition-property', 'none');
  }
});

test('dark theme changes the gauge track and retains the threshold colours', async ({ page }) => {
  await setTheme(page, 'dark');
  for (const state of states) {
    const gauge = meter(page, state.title);
    await expect(track(gauge)).toHaveCSS('fill', 'rgb(45, 48, 64)');
    await expect(gauge.locator('.charts-gauge-arc')).toHaveCSS('stroke', colours[state.level]);
    await expect(gauge.locator('svg text')).toHaveCSS('fill', colours[state.level]);
  }
});

for (const theme of ['light', 'dark'] as const)
  test(`WCAG accessibility on the gauge dashboard in ${theme}`, async ({ page }) => {
    await setTheme(page, theme);
    await axe(page);
  });

test('save gauge dashboard and tile screenshots when GAUGE_SHOTS_DIR is set', async ({ page }) => {
  const directory = process.env.GAUGE_SHOTS_DIR;
  test.skip(!directory, 'Set GAUGE_SHOTS_DIR to save gauge screenshots.');
  await mkdir(directory!, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expectGeometry(page);
  await page.screenshot({
    path: join(directory!, 'gauge-states-light.png'),
    fullPage: true,
    animations: 'disabled',
  });
  for (const colour of ['green', 'yellow', 'red'])
    await tile(page, `${colour[0].toUpperCase()}${colour.slice(1)} gauge`).screenshot({
      path: join(directory!, `gauge-${colour}.png`),
      animations: 'disabled',
    });
  await setTheme(page, 'dark');
  await expect(track(meter(page, 'Yellow gauge'))).toHaveCSS('fill', 'rgb(45, 48, 64)');
  await page.screenshot({
    path: join(directory!, 'gauge-states-dark.png'),
    fullPage: true,
    animations: 'disabled',
  });
});
