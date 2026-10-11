import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Dashboard, DashboardTile } from '../src/lib/types';
import classic from '../src/features/dashboards/__fixtures__/classic.json' with { type: 'json' };
import area from './fixtures-cartesian/area-config-type-line.json' with { type: 'json' };
import timeseries from './fixtures-cartesian/timeseries.json' with { type: 'json' };
import grouped from './fixtures-cartesian/bar-grouped.json' with { type: 'json' };
import stacked from './fixtures-cartesian/stacked-bar.json' with { type: 'json' };
import horizontal from './fixtures-cartesian/horizontal-bar.json' with { type: 'json' };
import bar from './fixtures-cartesian/bar.json' with { type: 'json' };
import line from './fixtures-cartesian/line.json' with { type: 'json' };
import table from './fixtures-cartesian/table.json' with { type: 'json' };
import promql from './fixtures-cartesian/promql-bar.json' with { type: 'json' };

const start = '2026-10-10T07:59:30Z';
const end = '2026-10-10T08:04:30Z';
const timeBuckets = Array.from({ length: 5 }, (_, index) =>
  new Date(Date.parse(start) + 30_000 + index * 60_000).toISOString(),
);
const values = [24, 72, 32, 88, 40];
const categories = ['ERROR', 'INFO', 'WARN'];
const categoryValues = [60, 90, 75];
const samples = [
  { file: 'area-config-type-line', tile: area, title: 'Area with config.type line' },
  {
    file: 'timeseries-area',
    tile: { ...timeseries, config: { ...timeseries.config, type: 'area' } },
    title: 'Timeseries area',
  },
  { file: 'grouped-bar', tile: grouped, title: 'Grouped bars by level and service' },
  { file: 'stacked-bar', tile: stacked, title: 'Stacked bars over time' },
  { file: 'horizontal-bar', tile: horizontal, title: 'Horizontal bars by level' },
  { file: 'categorical-bar', tile: bar, title: 'Categorical bars' },
  {
    file: 'categorical-line',
    tile: {
      ...line,
      chartQuery: bar.chartQuery,
      config: { ...line.config, axes: { ...line.config.axes, x: bar.config.axes.x } },
    },
    title: 'Categorical line',
  },
  { file: 'table', tile: table, title: 'Recent events table' },
  {
    file: 'promql-instant-bar',
    tile: {
      ...promql,
      dbName: 'otel-metrics',
      chartQuery: ['sum by (status) (http_requests_total)'],
      promqlQueryType: 'instant',
    },
    title: 'PromQL instant bars',
  },
];
const tiles: DashboardTile[] = samples.map(({ tile, file, title }, index) => ({
  ...tile,
  title,
  chartQuery:
    typeof tile.chartQuery === 'string' ? `${tile.chartQuery} /* ${file} */` : tile.chartQuery,
  layout: { x: (index % 2) * 6, y: Math.floor(index / 2) * 8, w: 6, h: 8 },
}));
const dashboard: Dashboard = {
  ...classic,
  title: 'Cartesian chart fixtures',
  dashboardType: 'Dashboard',
  description: 'SQL and instant PromQL charts',
  timeRange: { startTime: start, endTime: end, type: 'custom' },
  variables: [],
  sections: [],
  tiles,
};
const rowsByQuery = new Map(
  tiles
    .filter((tile) => tile.tileType !== 'promql')
    .map((tile) => {
      const file = samples.find((sample) => sample.tile.tile_id === tile.tile_id)!.file;
      const rows =
        file === 'area-config-type-line' || file === 'timeseries-area'
          ? timeBuckets.map((time_bucket, index) => ({
              time_bucket,
              [file === 'timeseries-area' ? 'COUNT_STAR' : 'events']: values[index],
            }))
          : file === 'stacked-bar'
            ? timeBuckets.flatMap((time_bucket, index) => [
                { time_bucket, service: 'api', events: [16, 26, 14, 30, 22][index] },
                { time_bucket, service: 'worker', events: [10, 18, 12, 24, 16][index] },
              ])
            : file === 'grouped-bar'
              ? categories.flatMap((level, index) => [
                  { level, service: 'api', events: [60, 90, 75][index] },
                  { level, service: 'worker', events: [40, 65, 50][index] },
                ])
              : file === 'table'
                ? [
                    { p_timestamp: timeBuckets[0], level: 'INFO', message: 'Request accepted' },
                    { p_timestamp: timeBuckets[1], level: 'WARN', message: 'Worker retry' },
                  ]
                : categories.map((level, index) => ({ level, events: categoryValues[index] }));
      return [String(tile.chartQuery), rows] as const;
    }),
);
const tile = (page: Page, file: string) =>
  page.locator(`[data-tile-id="${samples.find((sample) => sample.file === file)!.tile.tile_id}"]`);

async function openDashboard(page: Page, theme: 'light' | 'dark' = 'light') {
  await page.addInitScript((theme) => {
    localStorage.setItem('parseable-theme', theme);
    // Record actual canvas tick labels, including their transformed drawing coordinates.
    const original = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (text, x, y, maxWidth) {
      const canvas = this.canvas as HTMLCanvasElement & {
        cartesianLabels?: { text: string; x: number; y: number; color: string }[];
      };
      const point = this.getTransform().transformPoint(new DOMPoint(x, y));
      (canvas.cartesianLabels ??= []).push({
        text,
        x: point.x,
        y: point.y,
        color: String(this.fillStyle),
      });
      original.call(this, text, x, y, maxWidth);
    };
  }, theme);
  const origin = test.info().project.use.baseURL!;
  await page
    .context()
    .addCookies(['user_id', 'username'].map((name) => ({ name, value: 'admin', url: origin })));
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
    if (path === `/api/v1/dashboards/${dashboard.dashboardId}`)
      return route.fulfill({ json: dashboard });
    if (path === '/api/v1/query') {
      const sql = request.postDataJSON().query;
      const rows = rowsByQuery.get(sql);
      return route.fulfill(rows ? { json: rows } : { status: 400, body: `Unexpected SQL: ${sql}` });
    }
    if (path === '/prometheus/api/v1/query')
      return route.fulfill({
        json: {
          status: 'success',
          data: {
            resultType: 'vector',
            result: ['200', '404', '500'].map((status, index) => ({
              metric: { status },
              value: [Date.parse(end) / 1000, String([60, 90, 75][index])],
            })),
          },
        },
      });
    return route.fulfill({ status: 404, body: `Unhandled mock ${path}` });
  });
  await page.goto(`/dashboards/${dashboard.dashboardId}`);
  await expect(page.getByRole('heading', { name: dashboard.title, exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  await expect(page.locator('[data-tile-id] canvas')).toHaveCount(8);
  await expect(tile(page, 'table').getByRole('table')).toBeVisible();
  await chartsReady(page);
}

async function chartsReady(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  await expect
    .poll(() =>
      page.evaluate(() =>
        [...document.querySelectorAll('.dashboard-chart')].every((chart) => {
          const canvas = chart.querySelector('canvas') as HTMLCanvasElement & {
            cartesianLabels?: { color: string }[];
          };
          const muted = getComputedStyle(chart).getPropertyValue('--color-muted').trim();
          return canvas?.width > 0 && canvas.cartesianLabels?.at(-1)?.color === muted;
        }),
      ),
    )
    .toBe(true);
}

async function canvasPixels(page: Page, file: string) {
  const id = samples.find((sample) => sample.file === file)!.tile.tile_id;
  return page.evaluate((id) => {
    const element = document.querySelector(`[data-tile-id="${id}"]`)!;
    const canvas = element.querySelector('canvas') as HTMLCanvasElement & {
      cartesianLabels?: { text: string; x: number; y: number; color: string }[];
    };
    const canvasBox = canvas.getBoundingClientRect();
    const over = element.querySelector('.u-over')!.getBoundingClientRect();
    const scale = canvas.width / canvasBox.width;
    const plot = {
      left: Math.round((over.left - canvasBox.left) * scale),
      top: Math.round((over.top - canvasBox.top) * scale),
      width: Math.round(over.width * scale),
      height: Math.round(over.height * scale),
    };
    const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
    const palette = [
      [59, 130, 246],
      [16, 185, 129],
    ]; // #3B82F6, #10B981
    const at = (x: number, y: number) =>
      Array.from(pixels.slice((y * canvas.width + x) * 4, (y * canvas.width + x) * 4 + 4));
    const near = (rgba: number[], rgb: number[], tolerance = 1) =>
      rgb.every((value, index) => Math.abs(rgba[index] - value) <= tolerance);
    const mask = new Int8Array(canvas.width * canvas.height).fill(-1);
    let fillPixels = 0,
      strokePixels = 0,
      leftAxisPixels = 0;
    let fillSample: number[] = [];
    for (let y = plot.top; y < plot.top + plot.height; y++) {
      for (let x = 0; x < plot.left + plot.width; x++) {
        const rgba = at(x, y);
        if (x < plot.left) {
          if (rgba[3] > 80) leftAxisPixels++;
          continue;
        }
        if (near(rgba, palette[0], 6) && rgba[3] >= 24 && rgba[3] <= 28) {
          fillPixels++;
          // Sample well below the first rising segment, away from its stroke and grid.
          if (
            Math.abs(x - (plot.left + plot.width * 0.2)) < 3 &&
            Math.abs(y - (plot.top + plot.height * 0.85)) < 3
          )
            fillSample = rgba;
        }
        if (near(rgba, palette[0], 6) && rgba[3] > 80) strokePixels++;
        if (rgba[3] === 255)
          mask[y * canvas.width + x] = palette.findIndex((rgb) => near(rgba, rgb));
      }
    }
    // Connected full-colour pixels prove rectangular bars rather than thin line strokes.
    const blocks: {
      color: number;
      x: number;
      y: number;
      width: number;
      height: number;
      pixels: number;
    }[] = [];
    const queue = new Int32Array(mask.length);
    for (let y = plot.top; y < plot.top + plot.height; y++) {
      for (let x = plot.left; x < plot.left + plot.width; x++) {
        const first = y * canvas.width + x;
        const color = mask[first];
        if (color < 0) continue;
        let head = 0,
          tail = 1,
          minX = x,
          maxX = x,
          minY = y,
          maxY = y;
        queue[0] = first;
        mask[first] = -1;
        while (head < tail) {
          const current = queue[head++];
          const cx = current % canvas.width,
            cy = Math.floor(current / canvas.width);
          minX = Math.min(minX, cx);
          maxX = Math.max(maxX, cx);
          minY = Math.min(minY, cy);
          maxY = Math.max(maxY, cy);
          for (const next of [
            ...(cx > plot.left ? [current - 1] : []),
            ...(cx < plot.left + plot.width - 1 ? [current + 1] : []),
            ...(cy > plot.top ? [current - canvas.width] : []),
            ...(cy < plot.top + plot.height - 1 ? [current + canvas.width] : []),
          ]) {
            if (mask[next] !== color) continue;
            mask[next] = -1;
            queue[tail++] = next;
          }
        }
        const width = maxX - minX + 1,
          height = maxY - minY + 1;
        if (width >= 4 && height >= 4 && tail > width * height * 0.95)
          blocks.push({ color, x: minX, y: minY, width, height, pixels: tail });
      }
    }
    const profile = Array.from({ length: 17 }, (_, index) => {
      const fraction = 0.1 + index * 0.05;
      const x = Math.round(plot.left + plot.width * fraction);
      for (const offset of [0, -1, 1]) {
        for (let y = plot.top; y < plot.top + plot.height; y++) {
          const rgba = at(x + offset, y);
          if (near(rgba, palette[0], 6) && rgba[3] > 80) return (y - plot.top) / plot.height;
        }
      }
      return null;
    });
    const columns = Array.from({ length: 5 }, (_, index) => {
      const x = Math.round(plot.left + plot.width * (0.1 + index * 0.2));
      const runs: { color: number; y: number; height: number }[] = [];
      for (let y = plot.top; y < plot.top + plot.height; y++) {
        const rgba = at(x, y);
        const color = rgba[3] === 255 ? palette.findIndex((rgb) => near(rgba, rgb)) : -1;
        const previous = runs.at(-1);
        if (previous?.color === color) previous.height++;
        else runs.push({ color, y, height: 1 });
      }
      return runs.filter((run) => run.color >= 0);
    });
    return {
      plot,
      blocks,
      profile,
      columns,
      fillPixels,
      strokePixels,
      fillSample,
      leftAxisPixels,
      background: getComputedStyle(element.querySelector('.charts-figure')!).backgroundColor,
      labels: canvas.cartesianLabels?.slice().reverse() ?? [],
    };
  }, id);
}

function expectSolidBars(drawing: Awaited<ReturnType<typeof canvasPixels>>, count: number) {
  expect(drawing.blocks).toHaveLength(count);
  for (const block of drawing.blocks) {
    expect(block.width).toBeGreaterThanOrEqual(12);
    expect(block.height).toBeGreaterThanOrEqual(12);
    expect(block.pixels / (block.width * block.height)).toBeGreaterThan(0.98);
  }
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

test.use({ viewport: { width: 1440, height: 1000 } });

for (const theme of ['light', 'dark'] as const) {
  test(`${theme}: canvas fills, smooth/straight curves, grouped/stacked/horizontal and categorical bars`, async ({
    page,
  }) => {
    await openDashboard(page, theme);
    for (const { file } of samples.filter(({ file }) => file !== 'table')) {
      const card = tile(page, file);
      const wrapper = card.locator('.dashboard-chart');
      await expect(card.getByRole('img')).toBeVisible();
      await expect(card.locator('.dashboard-table')).toHaveCount(0);
      await expect(card.getByText(/results are shown as a table/)).toHaveCount(0);
      await expect(wrapper).toHaveAttribute(
        'data-chart-kind',
        file.includes('area') ? 'area' : file === 'categorical-line' ? 'line' : 'bar',
      );
      await expect(wrapper).toHaveAttribute('data-stacked', String(file === 'stacked-bar'));
      await expect(wrapper).toHaveAttribute(
        'data-orientation',
        file === 'horizontal-bar' ? 'horizontal' : 'vertical',
      );
    }
    const curved = await canvasPixels(page, 'area-config-type-line');
    const straight = await canvasPixels(page, 'timeseries-area');
    for (const drawing of [curved, straight]) {
      expect(drawing.fillPixels).toBeGreaterThan(drawing.plot.width * drawing.plot.height * 0.2);
      expect(drawing.strokePixels).toBeGreaterThan(100);
      expect(drawing.fillSample).toHaveLength(4);
      expect(drawing.fillSample[3]).toBe(Math.round(255 * 0.1));
      const background = drawing.background.match(/\d+/g)!.slice(0, 3).map(Number);
      const composited = drawing.fillSample
        .slice(0, 3)
        .map((value, index) =>
          Math.round(
            (value * drawing.fillSample[3]) / 255 +
              background[index] * (1 - drawing.fillSample[3] / 255),
          ),
        );
      expect(composited).not.toEqual(background);
      expect(composited).not.toEqual([59, 130, 246]);
    }
    const deviations = (profile: (number | null)[]) =>
      profile.flatMap((value, index) => {
        expect(
          value,
          `Stroke profile at sample ${index}: ${JSON.stringify(profile)}`,
        ).not.toBeNull();
        if (index % 4 === 0) return [];
        const first = Math.floor(index / 4) * 4;
        const fraction = (index - first) / 4;
        return [
          Math.abs(value! - (profile[first]! * (1 - fraction) + profile[first + 4]! * fraction)),
        ];
      });
    expect(
      Math.max(...deviations(straight.profile)),
      JSON.stringify(straight.profile),
    ).toBeLessThan(0.01);
    expect(Math.max(...deviations(curved.profile)), JSON.stringify(curved.profile)).toBeGreaterThan(
      0.025,
    );

    const groups = await canvasPixels(page, 'grouped-bar');
    expectSolidBars(groups, 6);
    const slotWidth = groups.plot.width / categories.length;
    for (let index = 0; index < categories.length; index++) {
      const pair = groups.blocks
        .filter(
          (block) =>
            block.x >= groups.plot.left + index * slotWidth &&
            block.x + block.width <= groups.plot.left + (index + 1) * slotWidth,
        )
        .sort((a, b) => a.x - b.x);
      expect(pair.map((block) => block.color)).toEqual([0, 1]);
      expect(pair[1].x - (pair[0].x + pair[0].width)).toBeGreaterThanOrEqual(0);
      expect(pair[1].x - (pair[0].x + pair[0].width)).toBeLessThan(slotWidth * 0.1);
      expect(pair[0].y + pair[0].height).toBe(pair[1].y + pair[1].height);
    }
    const stacks = await canvasPixels(page, 'stacked-bar');
    expectSolidBars(stacks, 10);
    for (const column of stacks.columns) {
      expect(column.map((run) => run.color)).toEqual([1, 0]);
      expect(column[0].y + column[0].height).toBe(column[1].y);
      expect(column.every((run) => run.height >= 12)).toBe(true);
    }
    const sideways = await canvasPixels(page, 'horizontal-bar');
    expectSolidBars(sideways, 3);
    for (const block of sideways.blocks) {
      expect(block.color).toBe(0);
      expect(block.width).toBeGreaterThan(block.height);
      expect(Math.abs(block.x - sideways.plot.left)).toBeLessThanOrEqual(1);
    }
    for (const category of categories) {
      const label = sideways.labels.find((label) => label.text === category)!;
      expect(label).toBeDefined();
      expect(label.x).toBeLessThan(sideways.plot.left);
      expect(label.y).toBeGreaterThan(sideways.plot.top);
      expect(label.y).toBeLessThan(sideways.plot.top + sideways.plot.height);
    }
    expect(sideways.leftAxisPixels).toBeGreaterThan(100);
    for (const file of ['categorical-bar', 'promql-instant-bar']) {
      const drawing = await canvasPixels(page, file);
      expectSolidBars(drawing, 3);
      expect(drawing.blocks.every((block) => block.color === 0)).toBe(true);
      await expect(tile(page, file).getByRole('img')).toHaveAccessibleName(
        /1 series across 3 categories/,
      );
    }
    const categoricalLine = await canvasPixels(page, 'categorical-line');
    expect(categoricalLine.strokePixels).toBeGreaterThan(100);
    // A thin stroke has translucent antialiased edges, but no filled interior.
    expect(categoricalLine.fillPixels).toBeLessThan(
      categoricalLine.plot.width * categoricalLine.plot.height * 0.001,
    );
    expect(categoricalLine.fillSample).toEqual([]);
    expect(categoricalLine.blocks).toEqual([]);
    await expect(tile(page, 'table').locator('.dashboard-table')).toHaveCount(1);
    await expect(tile(page, 'table').getByRole('table')).toContainText('Request accepted');
    await expect(tile(page, 'table').getByRole('img')).toHaveCount(0);
    await axe(page);
  });
}

test('keyboard category tooltips and legend toggles change the drawn series', async ({ page }) => {
  await openDashboard(page);
  const groupedTile = tile(page, 'grouped-bar');
  const chart = groupedTile.getByRole('img');
  await chart.focus();
  await chart.press('ArrowRight');
  await expect(groupedTile.getByRole('tooltip')).toContainText('ERROR');
  await chart.press('ArrowRight');
  await expect(groupedTile.getByRole('tooltip')).toContainText('INFO');
  await chart.press('ArrowLeft');
  await expect(groupedTile.getByRole('tooltip')).toContainText('ERROR');
  await chart.press('Escape');
  await expect(groupedTile.getByRole('tooltip')).toHaveCount(0);
  const worker = groupedTile.getByRole('button', { name: 'worker', exact: true });
  await worker.click();
  await expect(worker).toHaveAttribute('aria-pressed', 'false');
  await expect
    .poll(async () => (await canvasPixels(page, 'grouped-bar')).blocks.map((block) => block.color))
    .toEqual([0, 0, 0]);
  await chart.focus();
  await chart.press('ArrowRight');
  await expect(groupedTile.getByRole('tooltip')).toContainText('api');
  await expect(groupedTile.getByRole('tooltip')).not.toContainText('worker');
  await worker.click();
  await expect(worker).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await canvasPixels(page, 'grouped-bar')).blocks.length).toBe(6);
  const sideways = tile(page, 'horizontal-bar');
  await sideways.getByRole('img').focus();
  await sideways.getByRole('img').press('ArrowDown');
  await expect(sideways.getByRole('tooltip')).toContainText('ERROR');
  await sideways.getByRole('img').press('ArrowDown');
  await expect(sideways.getByRole('tooltip')).toContainText('INFO');
  await sideways.getByRole('img').press('ArrowUp');
  await expect(sideways.getByRole('tooltip')).toContainText('ERROR');
  await sideways.getByRole('img').press('Escape');
  const instant = tile(page, 'promql-instant-bar');
  await instant.getByRole('img').focus();
  await instant.getByRole('img').press('ArrowRight');
  await expect(instant.getByRole('tooltip')).toContainText('status="200"');
});

test('save light tile screenshots and light/dark dashboard screenshots', async ({ page }) => {
  const directory = process.env.CHARTS_SHOTS_DIR;
  test.skip(!directory, 'Set CHARTS_SHOTS_DIR to save chart screenshots.');
  await mkdir(directory!, { recursive: true });
  await openDashboard(page);
  for (const { file } of samples)
    await tile(page, file).screenshot({ path: join(directory!, `${file}-light.png`) });
  await page.getByRole('heading', { name: dashboard.title, exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(directory!, 'dashboard-light.png'), fullPage: true });
  await page.getByRole('button', { name: 'Use dark theme', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await chartsReady(page);
  await page.screenshot({ path: join(directory!, 'dashboard-dark.png'), fullPage: true });
});
