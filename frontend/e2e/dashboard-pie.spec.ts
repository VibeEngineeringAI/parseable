import { test, expect, type Locator, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createUlid } from '../src/lib/ids';
import classic from '../src/features/dashboards/__fixtures__/classic.json' with { type: 'json' };
import fixtures from '../src/features/dashboards/__fixtures__/pie-tiles.json' with { type: 'json' };
import type { Dashboard, DashboardTile, PromqlInstantResult, PromqlLabels } from '../src/lib/types';

test.use({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('parseable-theme', 'light'));
});

const tile = (page: Page, name: string) =>
  page.locator('[data-tile-id]').filter({ has: page.getByRole('heading', { name, exact: true }) });
const slices = (chart: Locator) => chart.locator('path.pie-chart-slice');
const plotSvg = (chart: Locator) => chart.locator('.pie-chart-plot-box > svg');
const levels = [
  { level: 'info', events: 120 },
  { level: 'warn', events: 60 },
  { level: 'error', events: 20 },
];
const classicColours = ['#3B82F6', '#10B981', '#C026D3'];
const tealColours = ['#00A896', '#33B9AB', '#66CBC0'];

function fixture(
  name: keyof typeof fixtures,
  options: {
    title?: string;
    colourScheme?: string;
    layout?: Record<string, unknown>;
    chartQuery?: string;
  } = {},
): DashboardTile {
  const value = structuredClone(fixtures[name]);
  return {
    ...value,
    title: options.title ?? value.title,
    chartQuery: options.chartQuery ?? value.chartQuery,
    config: {
      ...value.config,
      colourScheme: options.colourScheme ?? value.config.colourScheme,
      layout: { ...value.config.layout, ...options.layout },
    },
  };
}

function dashboard(tiles: DashboardTile[]): Dashboard {
  return {
    ...structuredClone(classic),
    title: 'Pie and donut dashboard',
    description: 'SQL levels and current PromQL request rates',
    sections: [],
    variables: tiles.some((value) => value.tileType === 'promql')
      ? [
          {
            name: 'metrics_dataset',
            label: 'Metrics dataset',
            type: 'dataset',
            defaultValue: 'otel-metrics',
            customVariable: true,
          },
          { name: 'service', label: 'Service', type: 'text', defaultValue: '.*' },
        ]
      : [],
    tiles: tiles.map((value, index) => ({
      ...value,
      tile_id: createUlid(),
      layout: { x: (index % 2) * 6, y: Math.floor(index / 2) * 4, w: 6, h: 4 },
    })),
  };
}

type Call = {
  path: string;
  method: string;
  body?: Record<string, unknown>;
  params: URLSearchParams;
};

function instantResult(query: string, matrix: boolean): PromqlInstantResult {
  const category = query.includes('sum by (service)') ? 'service' : 'status';
  const names = category === 'service' ? ['api', 'worker', 'web'] : ['200', '404', '500'];
  const time = 1_791_590_400;
  const series = [
    ...[12, 6, 2].map((value, index) => ({
      metric: {
        [category]: names[index],
        ...(index === 1 ? { __name__: 'http_requests_total' } : {}),
      } as PromqlLabels,
      value: String(value),
    })),
    ...['NaN', '+Inf', '-Inf'].map((value) => ({
      metric: { [category]: value },
      value,
    })),
  ];
  return matrix
    ? {
        resultType: 'matrix',
        result: series.map(({ metric, value }) => ({
          metric,
          // Deliberately unsorted, with non-finite samples newer than the last finite one.
          values: Number.isFinite(Number(value))
            ? [
                [time - 10, value],
                [time - 60, '1'],
                [time, 'NaN'],
                [time - 30, '99'],
                [time + 10, '+Inf'],
              ]
            : [
                [time - 10, value],
                [time, 'NaN'],
              ],
        })),
      }
    : {
        resultType: 'vector',
        result: series.map(({ metric, value }) => ({ metric, value: [time, value] })),
      };
}

async function mockServer(page: Page, document: Dashboard, matrix: boolean) {
  const calls: Call[] = [];
  await page.context().addCookies([
    { name: 'user_id', value: 'admin', url: 'http://127.0.0.1:5182' },
    { name: 'username', value: 'admin', url: 'http://127.0.0.1:5182' },
  ]);
  await page.route('**/api/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname;
    const body = request.postData()
      ? path.startsWith('/prometheus')
        ? Object.fromEntries(new URLSearchParams(request.postData()!))
        : request.postDataJSON()
      : undefined;
    calls.push({ path, method: request.method(), body, params: url.searchParams });
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
    if (path === '/api/v1/dashboards') return route.fulfill({ json: [document] });
    if (path === `/api/v1/dashboards/${document.dashboardId}`)
      return route.fulfill({ json: document });
    if (path === '/api/v1/query' && request.method() === 'POST') {
      const sql = String(body?.query ?? '');
      const rows = sql.includes('WHERE FALSE')
        ? []
        : levels.map(({ level, events }) => ({
            level,
            events: sql.includes('/ 10 AS events')
              ? events / 10
              : sql.includes('* 10 AS events')
                ? events * 10
                : events,
          }));
      return route.fulfill({ json: rows });
    }
    if (path === '/prometheus/api/v1/query')
      return route.fulfill({
        json: {
          status: 'success',
          data: instantResult(String(body?.query ?? url.searchParams.get('query') ?? ''), matrix),
        },
      });
    if (path === '/prometheus/api/v1/query_range')
      return route.fulfill({
        json: { status: 'success', data: { resultType: 'matrix', result: [] } },
      });
    return route.fulfill({ status: 404, body: `Unhandled mock ${path}` });
  });
  return calls;
}

async function openDashboard(page: Page, tiles: DashboardTile[], matrix = false) {
  const document = dashboard(tiles),
    calls = await mockServer(page, document, matrix);
  await page.goto(`/dashboards/${document.dashboardId}`);
  await expect(page.getByRole('heading', { name: document.title, exact: true })).toBeVisible();
  for (const value of tiles) {
    const chart = tile(page, String(value.title));
    await expect(chart.locator('.pie-chart')).toBeVisible();
    await expect(chart).toHaveAttribute('aria-busy', 'false');
  }
  return calls;
}

async function expectFractions(chart: Locator, expected: number[]) {
  const paths = slices(chart);
  await expect(paths).toHaveCount(expected.length);
  for (const [index, fraction] of expected.entries())
    await expect
      .poll(async () => Number(await paths.nth(index).getAttribute('data-fraction')))
      .toBeCloseTo(fraction, 12);
  await expect
    .poll(() =>
      paths.evaluateAll((elements) =>
        elements.reduce(
          (total, element) => total + Number(element.getAttribute('data-fraction')),
          0,
        ),
      ),
    )
    .toBeCloseTo(1, 12);
}

async function hoverSlice(page: Page, path: Locator) {
  await path.scrollIntoViewIfNeeded();
  await expect(path).toBeVisible();
  const point = await path.evaluate((element) => {
    const path = element as SVGPathElement,
      svg = path.ownerSVGElement!;
    const paths = [...svg.querySelectorAll('path.pie-chart-slice')],
      index = paths.indexOf(path);
    const preceding = paths
      .slice(0, index)
      .reduce((total, slice) => total + Number(slice.getAttribute('data-fraction')), 0);
    const angle = (preceding + Number(path.getAttribute('data-fraction')) / 2) * Math.PI * 2;
    const radius =
      (Number(svg.getAttribute('data-outer-radius')) +
        Number(svg.getAttribute('data-inner-radius'))) /
      2;
    const x = svg.width.baseVal.value / 2 + Math.sin(angle) * radius;
    const y = svg.height.baseVal.value / 2 - Math.cos(angle) * radius;
    const box = svg.getBoundingClientRect();
    return { x: box.x + x, y: box.y + y, inside: path.isPointInFill(new DOMPoint(x, y)) };
  });
  expect(point.inside).toBe(true);
  await page.mouse.move(point.x, point.y);
}

async function expectTooltip(chart: Locator, text: string) {
  const tooltip = chart.getByRole('tooltip');
  await expect(tooltip).toBeVisible();
  // Preserve the two spaces between category and percentage in the actual text node.
  await expect.poll(() => tooltip.textContent()).toBe(text);
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

test('SQL pie fractions, clockwise geometry from twelve o’clock and classic/teal colours', async ({
  page,
}) => {
  const calls = await openDashboard(page, [
    fixture('pie'),
    fixture('pie', { title: 'Teal levels', colourScheme: 'teal' }),
  ]);
  expect(
    calls.some(
      (call) =>
        call.path === '/api/v1/query' &&
        call.method === 'POST' &&
        call.body?.query === fixtures.pie.chartQuery,
    ),
  ).toBe(true);
  for (const [name, colours] of [
    [fixtures.pie.title, classicColours],
    ['Teal levels', tealColours],
  ] as const) {
    const chart = tile(page, name),
      paths = slices(chart);
    await expectFractions(chart, [0.6, 0.3, 0.1]);
    await expect(plotSvg(chart)).toHaveAttribute('data-inner-radius', '0');
    for (const [index, row] of levels.entries()) {
      await expect(paths.nth(index)).toHaveAttribute('data-label', row.level);
      await expect(paths.nth(index)).toHaveAttribute('data-value', String(row.events));
      expect(await paths.nth(index).getAttribute('fill')).toBe(colours[index]);
    }
  }
  const geometry = await slices(tile(page, fixtures.pie.title))
    .first()
    .evaluate((element) => {
      const path = element as SVGPathElement,
        svg = path.ownerSVGElement!;
      const radius = Number(svg.getAttribute('data-outer-radius'));
      const center = { x: svg.width.baseVal.value / 2, y: svg.height.baseVal.value / 2 };
      const top = path.getPointAtLength(radius);
      const right = path.getPointAtLength(radius + (radius * Math.PI) / 2);
      return { radius, center, top: { x: top.x, y: top.y }, right: { x: right.x, y: right.y } };
    });
  expect(geometry.radius).toBeGreaterThan(1);
  expect(Math.abs(geometry.top.x - geometry.center.x)).toBeLessThan(1);
  expect(Math.abs(geometry.top.y - (geometry.center.y - geometry.radius))).toBeLessThan(1);
  expect(Math.abs(geometry.right.x - (geometry.center.x + geometry.radius))).toBeLessThan(1);
  expect(Math.abs(geometry.right.y - geometry.center.y)).toBeLessThan(1);
});

for (const name of ['donut', 'donut-config-type-pie'] as const)
  test(`${name} has a half-radius, empty, non-interactive hole`, async ({ page }) => {
    await openDashboard(page, [fixture(name)]);
    const chart = tile(page, fixtures[name].title),
      svg = plotSvg(chart);
    await expectFractions(chart, [0.6, 0.3, 0.1]);
    await expect(chart.locator('.pie-chart')).toHaveAttribute('data-variant', 'donut');
    const outer = Number(await svg.getAttribute('data-outer-radius'));
    expect(outer).toBeGreaterThan(1);
    expect(Number(await svg.getAttribute('data-inner-radius'))).toBe(outer / 2);
    await expect(svg.locator('text')).toHaveCount(0);
    const center = await svg.evaluate((element) => {
      const svg = element as SVGSVGElement,
        box = svg.getBoundingClientRect();
      const point = new DOMPoint(svg.width.baseVal.value / 2, svg.height.baseVal.value / 2);
      return {
        x: box.x + point.x,
        y: box.y + point.y,
        filled: [...svg.querySelectorAll('path')].some((path) => path.isPointInFill(point)),
      };
    });
    expect(center.filled).toBe(false);
    await hoverSlice(page, slices(chart).first());
    await expectTooltip(chart, 'info  60.0% (120)');
    await page.mouse.move(center.x, center.y);
    await expect(chart.getByRole('tooltip')).toHaveCount(0);
  });

for (const position of ['bottom', 'right', 'top', 'left'] as const)
  test(`legend ${position === 'bottom' ? 'defaults to bottom' : position} sits outside the plot`, async ({
    page,
  }) => {
    await openDashboard(page, [
      fixture('pie', { layout: { legendPosition: position === 'bottom' ? undefined : position } }),
    ]);
    const chart = tile(page, fixtures.pie.title);
    await expect(plotSvg(chart)).toBeVisible();
    await expect(chart.locator('.pie-chart')).toHaveAttribute('data-legend-position', position);
    await expect(chart.locator('.pie-chart-legend')).toBeVisible();
    await expect
      .poll(async () => {
        const plot = (await chart.locator('.pie-chart-plot-box').boundingBox())!;
        const legend = (await chart.locator('.pie-chart-legend').boundingBox())!;
        switch (position) {
          case 'bottom':
            return legend.y - (plot.y + plot.height);
          case 'right':
            return legend.x - (plot.x + plot.width);
          case 'top':
            return plot.y - (legend.y + legend.height);
          case 'left':
            return plot.x - (legend.x + legend.width);
        }
      })
      .toBeGreaterThanOrEqual(-0.5);
  });

test('legend toggles strike labels, remove slices and refill the circle before restoring', async ({
  page,
}) => {
  await openDashboard(page, [fixture('pie')]);
  const chart = tile(page, fixtures.pie.title),
    button = chart.getByRole('button', { name: 'warn', exact: true });
  await expectFractions(chart, [0.6, 0.3, 0.1]);
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'false');
  await expect(button.locator('.pie-chart-legend-label')).toHaveCSS(
    'text-decoration-line',
    'line-through',
  );
  await expect(chart.locator('path[data-label="warn"]')).toHaveCount(0);
  await expectFractions(chart, [6 / 7, 1 / 7]);
  await expect(chart.locator('path[data-label="error"]')).toHaveAttribute(
    'fill',
    classicColours[2],
  );
  expect(
    await plotSvg(chart).evaluate((element) => {
      const svg = element as SVGSVGElement,
        paths = [...svg.querySelectorAll('path')];
      const radius = Number(svg.getAttribute('data-outer-radius')) * 0.7;
      return Array.from({ length: 24 }, (_, index) => {
        const angle = ((index + 0.5) * Math.PI * 2) / 24;
        const point = new DOMPoint(
          svg.width.baseVal.value / 2 + Math.sin(angle) * radius,
          svg.height.baseVal.value / 2 - Math.cos(angle) * radius,
        );
        return paths.some((path) => path.isPointInFill(point));
      });
    }),
  ).toEqual(Array(24).fill(true));
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await expect(button.locator('.pie-chart-legend-label')).toHaveCSS('text-decoration-line', 'none');
  await expectFractions(chart, [0.6, 0.3, 0.1]);
  await expect(chart.locator('path[data-label="warn"]')).toHaveAttribute('data-value', '60');
});

test('labels show each non-overlapping category only, and label false renders none', async ({
  page,
}) => {
  await openDashboard(page, [fixture('pie'), fixture('pie-labels-legend-right')]);
  await expect(tile(page, fixtures.pie.title).locator('text.pie-chart-label')).toHaveCount(0);
  const labels = tile(page, fixtures['pie-labels-legend-right'].title).locator(
    'text.pie-chart-label',
  );
  await expect(labels).toHaveCount(3);
  expect(
    await labels.evaluateAll((elements) =>
      elements.map((element) =>
        [...element.childNodes]
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.textContent)
          .join(''),
      ),
    ),
  ).toEqual(['info', 'warn', 'error']);
  const boxes = await labels.evaluateAll((elements) =>
    elements.map((element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    }),
  );
  for (const [index, box] of boxes.entries())
    for (const other of boxes.slice(index + 1))
      expect(
        box.x < other.x + other.width &&
          other.x < box.x + box.width &&
          box.y < other.y + other.height &&
          other.y < box.y + box.height,
      ).toBe(false);
});

test('slice tooltip text preserves the original total after a legend item is hidden', async ({
  page,
}) => {
  await openDashboard(page, [fixture('pie')]);
  const chart = tile(page, fixtures.pie.title);
  for (const [index, text] of [
    'info  60.0% (120)',
    'warn  30.0% (60)',
    'error  10.0% (20)',
  ].entries()) {
    await hoverSlice(page, slices(chart).nth(index));
    await expectTooltip(chart, text);
  }
  await chart.getByRole('button', { name: 'warn', exact: true }).click();
  await expectFractions(chart, [6 / 7, 1 / 7]);
  await hoverSlice(page, chart.locator('path[data-label="info"]'));
  await expectTooltip(chart, 'info  60.0% (120)');
  await hoverSlice(page, chart.locator('path[data-label="error"]'));
  await expectTooltip(chart, 'error  10.0% (20)');
});

test('tooltips use the tile value formatter: compact numbers, precision and units', async ({
  page,
}) => {
  await openDashboard(page, [
    fixture('pie', {
      title: 'Request rates',
      chartQuery: 'SELECT "level", COUNT(*) / 10 AS events FROM "app-logs" GROUP BY "level"',
      layout: { unit: 'req/s', precision: 2 },
    }),
    fixture('pie', {
      title: 'Large counts',
      chartQuery: 'SELECT "level", COUNT(*) * 10 AS events FROM "app-logs" GROUP BY "level"',
    }),
  ]);
  const rates = tile(page, 'Request rates'),
    counts = tile(page, 'Large counts');
  await hoverSlice(page, slices(rates).first());
  await expectTooltip(rates, 'info  60.0% (12.00 req/s)');
  await hoverSlice(page, slices(counts).first());
  // Without a unit the shared tile formatter abbreviates (classic: 1.2K).
  await expectTooltip(counts, 'info  60.0% (1.2K)');
});

test('Tab focuses slices and shows a tooltip; Escape hides it without moving focus', async ({
  page,
}) => {
  await openDashboard(page, [fixture('pie')]);
  const chart = tile(page, fixtures.pie.title),
    paths = slices(chart);
  await expect(paths).toHaveCount(3);
  await chart
    .getByRole('button', { name: `Actions for tile ${fixtures.pie.title}`, exact: true })
    .focus();
  await page.keyboard.press('Tab');
  await expect(paths.first()).toBeFocused();
  await expectTooltip(chart, 'info  60.0% (120)');
  await page.keyboard.press('Escape');
  await expect(chart.getByRole('tooltip')).toHaveCount(0);
  await expect(paths.first()).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(paths.nth(1)).toBeFocused();
  await expectTooltip(chart, 'warn  30.0% (60)');
});

for (const name of ['promql-pie', 'promql-donut'] as const)
  test(`${name} uses finite vector values, full series names and the instant endpoint`, async ({
    page,
  }) => {
    const calls = await openDashboard(page, [fixture(name)]);
    const chart = tile(page, fixtures[name].title),
      paths = slices(chart);
    const labels =
      name === 'promql-pie'
        ? ['{status="200"}', 'http_requests_total{status="404"}', '{status="500"}']
        : ['{service="api"}', 'http_requests_total{service="worker"}', '{service="web"}'];
    await expectFractions(chart, [0.6, 0.3, 0.1]);
    await expect(chart.locator('.pie-chart')).toHaveAttribute(
      'data-variant',
      name === 'promql-pie' ? 'pie' : 'donut',
    );
    const outer = Number(await plotSvg(chart).getAttribute('data-outer-radius'));
    expect(outer).toBeGreaterThan(1);
    expect(Number(await plotSvg(chart).getAttribute('data-inner-radius'))).toBe(
      name === 'promql-pie' ? 0 : outer / 2,
    );
    await expect(chart.locator('.pie-chart-legend-item')).toHaveCount(3);
    for (const [index, label] of labels.entries()) {
      await expect(paths.nth(index)).toHaveAttribute('data-label', label);
      await expect(paths.nth(index)).toHaveAttribute('data-value', String([12, 6, 2][index]));
      await expect(paths.nth(index)).toHaveAccessibleName(
        `${label}  ${[60, 30, 10][index].toFixed(1)}% (${[12, 6, 2][index].toFixed(2)} req/s)`,
      );
    }
    await hoverSlice(page, paths.first());
    await expectTooltip(chart, `${labels[0]}  60.0% (12.00 req/s)`);
    const query = fixtures[name].chartQuery[0].replace('$service', '.*');
    const instant = calls.filter(
      (call) => call.path === '/prometheus/api/v1/query' && call.body?.query === query,
    );
    expect(instant.length).toBeGreaterThan(0);
    for (const call of instant) {
      expect(call.method).toBe('POST');
      expect(call.body).toMatchObject({ stream: 'otel-metrics', query, time: expect.any(String) });
      expect(Number.isFinite(Number(call.body?.time))).toBe(true);
    }
    expect(calls.filter((call) => call.path === '/prometheus/api/v1/query_range')).toHaveLength(0);
  });

test('instant matrix pie and donut select the last finite sample by timestamp', async ({
  page,
}) => {
  const calls = await openDashboard(page, [fixture('promql-pie'), fixture('promql-donut')], true);
  for (const name of ['promql-pie', 'promql-donut'] as const) {
    const chart = tile(page, fixtures[name].title);
    await expectFractions(chart, [0.6, 0.3, 0.1]);
    for (const [index, value] of [12, 6, 2].entries())
      await expect(slices(chart).nth(index)).toHaveAttribute('data-value', String(value));
    await expect(chart.locator('.pie-chart-legend-item')).toHaveCount(3);
    expect(
      calls.some(
        (call) =>
          call.path === '/prometheus/api/v1/query' &&
          call.body?.query === fixtures[name].chartQuery[0].replace('$service', '.*'),
      ),
    ).toBe(true);
  }
  expect(calls.filter((call) => call.path === '/prometheus/api/v1/query_range')).toHaveLength(0);
});

test('empty SQL results show No values returned without an SVG', async ({ page }) => {
  await openDashboard(page, [
    fixture('pie', {
      chartQuery: 'SELECT "level", COUNT(*) AS events FROM "app-logs" WHERE FALSE GROUP BY "level"',
    }),
  ]);
  const chart = tile(page, fixtures.pie.title);
  await expect(chart.getByText('No values returned', { exact: true })).toBeVisible();
  await expect(plotSvg(chart)).toHaveCount(0);
  await expect(slices(chart)).toHaveCount(0);
});

for (const theme of ['light', 'dark'] as const)
  test(`pie, donut and labelled pie have accessible slice names and pass axe in ${theme}`, async ({
    page,
  }) => {
    await openDashboard(page, [
      fixture('pie'),
      fixture('donut', { title: 'Donut levels' }),
      fixture('pie-labels-legend-right'),
    ]);
    if (theme === 'dark')
      await page.getByRole('button', { name: 'Use dark theme', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    for (const name of [
      fixtures.pie.title,
      'Donut levels',
      fixtures['pie-labels-legend-right'].title,
    ]) {
      const chart = tile(page, name);
      await expectFractions(chart, [0.6, 0.3, 0.1]);
      for (const [index, label] of [
        'info  60.0% (120)',
        'warn  30.0% (60)',
        'error  10.0% (20)',
      ].entries()) {
        await expect(slices(chart).nth(index)).toHaveAttribute('aria-label', label);
        await expect(slices(chart).nth(index)).toHaveAccessibleName(label);
      }
    }
    await axe(page);
  });

test(
  'capture pie/donut dashboard and tile screenshots',
  {
    annotation: {
      type: 'screenshots',
      description:
        'Always saves light/dark dashboard and light tile artifacts in /tmp/charts-work/shots/pie/',
    },
  },
  async ({ page }, testInfo) => {
    await openDashboard(page, [
      fixture('pie'),
      fixture('donut', { title: 'Donut levels' }),
      fixture('pie-labels-legend-right'),
      fixture('promql-donut'),
    ]);
    for (const name of [
      fixtures.pie.title,
      'Donut levels',
      fixtures['pie-labels-legend-right'].title,
      fixtures['promql-donut'].title,
    ])
      await expectFractions(tile(page, name), [0.6, 0.3, 0.1]);
    await expect(
      tile(page, fixtures['pie-labels-legend-right'].title).locator('text.pie-chart-label'),
    ).toHaveCount(3);
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
    const directory = '/tmp/charts-work/shots/pie';
    await mkdir(directory, { recursive: true });
    const fullLight = join(directory, 'dashboard-pie-donut-light.png');
    const labelsLight = join(directory, 'tile-pie-labels-legend-right-light.png');
    const promqlLight = join(directory, 'tile-promql-donut-light.png');
    const fullDark = join(directory, 'dashboard-pie-donut-dark.png');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.screenshot({ path: fullLight, fullPage: true, animations: 'disabled' });
    await tile(page, fixtures['pie-labels-legend-right'].title).screenshot({
      path: labelsLight,
      animations: 'disabled',
    });
    await tile(page, fixtures['promql-donut'].title).screenshot({
      path: promqlLight,
      animations: 'disabled',
    });
    await page.getByRole('button', { name: 'Use dark theme', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.screenshot({ path: fullDark, fullPage: true, animations: 'disabled' });
    for (const path of [fullLight, labelsLight, promqlLight, fullDark])
      await testInfo.attach(path.split('/').at(-1)!, { path, contentType: 'image/png' });
  },
);
