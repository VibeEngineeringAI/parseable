import { test, expect, type Locator, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Dashboard, DashboardTile } from '../src/lib/types';
import classic from '../src/features/dashboards/__fixtures__/classic.json' with { type: 'json' };
import pieFixtures from '../src/features/dashboards/__fixtures__/pie-tiles.json' with { type: 'json' };
import area from './fixtures-cartesian/area-config-type-line.json' with { type: 'json' };
import timeseries from './fixtures-cartesian/timeseries.json' with { type: 'json' };
import grouped from './fixtures-cartesian/bar-grouped.json' with { type: 'json' };
import stacked from './fixtures-cartesian/stacked-bar.json' with { type: 'json' };
import horizontal from './fixtures-cartesian/horizontal-bar.json' with { type: 'json' };
import bar from './fixtures-cartesian/bar.json' with { type: 'json' };
import line from './fixtures-cartesian/line.json' with { type: 'json' };

const start = '2026-10-10T07:59:30.000Z';
const end = '2026-10-10T08:04:30.000Z';
const timeBuckets = Array.from({ length: 5 }, (_, index) =>
  new Date(Date.parse(start) + 30_000 + index * 60_000).toISOString(),
);
const values = [24, 72, 32, 88, 40];
const categories = ['DEBUG', 'ERROR', 'INFO', 'TRACE', 'WARN'];
const fullLabel = `${'checkout-🚀'.repeat(6)}production`;
const boundaryLabel = `boundary-${'x'.repeat(31)}`;
const truncatedLabel = `${[...fullLabel].slice(0, 40).join('')}…`;
const valueAxisTitle = 'Completed requests (bottom value axis)';
const verticalAxisTitle = 'Requests per minute';
// Classic palette from src/features/dashboards/palettes.ts, in incoming series order.
const palette = ['#3B82F6', '#10B981', '#C026D3', '#EC4899', '#E11D48'];
const shots = '/tmp/charts-work/shots/legend';
const timeRows = timeBuckets.map((time_bucket, index) => ({ time_bucket, events: values[index] }));
const groupedRows = (labels = ['api', 'worker']) =>
  timeBuckets.flatMap((time_bucket, index) =>
    labels.map((service, group) => ({
      time_bucket,
      service,
      events: values[index] - group * 8,
    })),
  );
const categoryRows = categories.map((level, index) => ({ level, events: values[index] }));
const groupedLine = {
  ...stacked,
  config: {
    ...stacked.config,
    type: 'line',
    layout: { ...stacked.config.layout, stacked: false },
    axes: {
      ...stacked.config.axes,
      y: { ...stacked.config.axes.y, title: verticalAxisTitle },
    },
  },
};
const samples: {
  file: string;
  title: string;
  tile: DashboardTile;
  rows: Record<string, unknown>[];
}[] = [
  {
    file: 'timeseries-grouped',
    title: 'Timeseries by service',
    tile: groupedLine,
    rows: groupedRows(),
  },
  { file: 'area', title: 'Area with config.type line', tile: area, rows: timeRows },
  {
    file: 'grouped-bar',
    title: 'Grouped bars by service',
    tile: grouped,
    rows: categories.flatMap((level, index) => [
      { level, service: 'api', events: values[index] },
      { level, service: 'worker', events: values[index] - 8 },
    ]),
  },
  {
    file: 'truncated-legend',
    title: 'Long service names',
    tile: groupedLine,
    rows: groupedRows([fullLabel, boundaryLabel]),
  },
  {
    file: 'horizontal-bar',
    title: 'Horizontal bars with bottom title',
    tile: {
      ...horizontal,
      config: {
        ...horizontal.config,
        axes: {
          ...horizontal.config.axes,
          y: { ...horizontal.config.axes.y, title: valueAxisTitle },
        },
      },
    },
    rows: categoryRows,
  },
  {
    file: 'timeseries-area',
    title: 'Timeseries with area fill',
    tile: { ...timeseries, config: { ...timeseries.config, type: 'area' } },
    rows: timeBuckets.map((time_bucket, index) => ({ time_bucket, COUNT_STAR: values[index] })),
  },
  { file: 'stacked-bar', title: 'Stacked bars by service', tile: stacked, rows: groupedRows() },
  { file: 'line', title: 'Ungrouped line over time', tile: line, rows: timeRows },
  {
    file: 'two-groups',
    title: 'Timeseries by service and level',
    tile: {
      ...groupedLine,
      chartQuery:
        'SELECT DATE_TRUNC(\'minute\', "p_timestamp") AS time_bucket, "service", "level", COUNT(*) AS events FROM "app-logs" GROUP BY time_bucket, "service", "level" ORDER BY time_bucket ASC',
      config: {
        ...groupedLine.config,
        axes: { ...groupedLine.config.axes, groupBy: { field: ['service', 'level'] } },
      },
    },
    rows: groupedRows().flatMap((row) => [
      { ...row, level: 'INFO' },
      { ...row, level: 'WARN', events: row.events / 2 },
    ]),
  },
  {
    file: 'pie',
    title: 'Pie legend',
    tile: pieFixtures.pie,
    rows: [fullLabel, boundaryLabel, 'info', 'warn', 'error'].map((level, index) => ({
      level,
      events: values[index],
    })),
  },
  {
    file: 'bubble',
    title: 'Bubble legend',
    tile: {
      ...line,
      chartType: 'bubble',
      chartQuery: 'SELECT duration_ms, payload_bytes, total, service FROM "app-logs" LIMIT 100',
      config: {
        ...line.config,
        type: 'bubble',
        axes: {
          x: { field: 'duration_ms', title: 'Duration (ms)', display: true },
          y: { field: 'payload_bytes', title: 'Payload (bytes)', display: true },
          size: { field: 'total' },
          groupBy: { field: ['service'] },
        },
      },
    },
    rows: values.map((total, index) => ({
      duration_ms: (index + 1) * 100,
      payload_bytes: (index + 1) * 256,
      total,
      service: index % 2 ? boundaryLabel : fullLabel,
    })),
  },
  {
    file: 'time-bar',
    title: 'Bar over time without zoom',
    tile: { ...stacked, chartType: 'bar' },
    rows: groupedRows(),
  },
  {
    file: 'categorical-bar',
    title: 'Categorical bars without zoom',
    tile: bar,
    rows: categoryRows,
  },
];
const tiles: DashboardTile[] = samples.map(({ tile, file, title }, index) => ({
  ...tile,
  tile_id: `01K7A0000000000000000000${String(index + 40).padStart(2, '0')}`,
  title,
  chartQuery: `${tile.chartQuery} /* legend-${file} */`,
  layout: { x: (index % 2) * 6, y: Math.floor(index / 2) * 5, w: 6, h: 5 },
}));
const dashboard: Dashboard = {
  ...classic,
  title: 'Dashboard legend fixtures',
  dashboardType: 'Dashboard',
  description: 'Legend shapes, grouped labels and time selection',
  timeRange: { startTime: start, endTime: end, type: 'custom' },
  variables: [],
  sections: [],
  tiles,
};
const rowsByQuery = new Map(
  tiles.map((tile, index) => [String(tile.chartQuery), samples[index].rows]),
);
const tile = (page: Page, file: string) =>
  page.locator(
    `[data-tile-id="${tiles[samples.findIndex((sample) => sample.file === file)].tile_id}"]`,
  );
const queryFor = (file: string) =>
  String(tiles[samples.findIndex((sample) => sample.file === file)].chartQuery);
type QueryCall = { query: string; startTime: string; endTime: string };
type CanvasLabel = { text: string; x: number; y: number; color: string };
type RecordedCanvas = HTMLCanvasElement & { legendLabels?: CanvasLabel[] };

async function openDashboard(page: Page, theme: 'light' | 'dark' = 'light', overrideRange = false) {
  const calls: QueryCall[] = [];
  await page.addInitScript((theme) => {
    localStorage.setItem('parseable-theme', theme);
    const original = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (text, x, y, maxWidth) {
      const canvas = this.canvas as RecordedCanvas;
      const point = this.getTransform().transformPoint(new DOMPoint(x, y));
      (canvas.legendLabels ??= []).push({
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
        json: { capabilities: { promql: true, promqlDashboard: true, promqlMetadata: true } },
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
    if (path === '/api/v1/logstream') return route.fulfill({ json: [{ name: 'app-logs' }] });
    if (path.endsWith('/info'))
      return route.fulfill({ json: { logSource: [{ log_source_format: 'json' }] } });
    if (path === `/api/v1/dashboards/${dashboard.dashboardId}`)
      return route.fulfill({
        json: overrideRange
          ? {
              ...dashboard,
              tiles: tiles.map((entry) =>
                entry.chartQuery === queryFor('timeseries-grouped')
                  ? { ...entry, timeRange: { type: 'custom', startTime: start, endTime: end } }
                  : entry,
              ),
            }
          : dashboard,
      });
    if (path === '/api/v1/query') {
      const body = request.postDataJSON() as QueryCall;
      calls.push(body);
      const rows = rowsByQuery.get(body.query);
      return route.fulfill(
        rows ? { json: rows } : { status: 400, body: `Unexpected SQL: ${body.query}` },
      );
    }
    return route.fulfill({ status: 404, body: `Unhandled mock ${path}` });
  });
  await page.goto(`/dashboards/${dashboard.dashboardId}`);
  await expect(page.getByRole('heading', { name: dashboard.title, exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  await expect(page.locator('[data-tile-id] canvas')).toHaveCount(samples.length - 2);
  await expect(tile(page, 'pie').locator('path.pie-chart-slice')).toHaveCount(5);
  await expect(tile(page, 'bubble').locator('circle.charts-bubble-point')).toHaveCount(5);
  await chartsReady(page);
  await expect.poll(() => new Set(calls.map((call) => call.query)).size).toBe(tiles.length);
  await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();
  await expect.poll(() => urlRange(page)).toEqual({ startTime: start, endTime: end });
  return calls;
}

async function chartsReady(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  await expect
    .poll(() =>
      page.evaluate(() =>
        [...document.querySelectorAll<RecordedCanvas>('[data-tile-id] canvas')].every((canvas) => {
          const muted = getComputedStyle(canvas.closest('.dashboard-chart')!)
            .getPropertyValue('--color-muted')
            .trim();
          return (
            canvas.width > 0 && canvas.height > 0 && canvas.legendLabels?.at(-1)?.color === muted
          );
        }),
      ),
    )
    .toBe(true);
}

async function expectSquares(card: Locator, count: number) {
  await expect(card.locator('[data-legend-swatch]')).toHaveCount(count);
  const swatches = card.locator('.charts-legend-swatch[data-legend-swatch="square"]');
  await expect(swatches).toHaveCount(count);
  expect(
    await swatches.evaluateAll((elements) =>
      elements.map((element) => {
        const style = getComputedStyle(element);
        const rgb = style.backgroundColor.match(/\d+/g)!.slice(0, 3).map(Number);
        return {
          width: style.width,
          height: style.height,
          radius: style.borderRadius,
          colour: `#${rgb
            .map((value) => value.toString(16).padStart(2, '0'))
            .join('')
            .toUpperCase()}`,
        };
      }),
    ),
  ).toEqual(
    palette.slice(0, count).map((colour) => ({
      width: '12px',
      height: '12px',
      radius: '4px',
      colour,
    })),
  );
}

async function expectFullLabels(card: Locator, role: 'button' | 'listitem' = 'button') {
  expect([...fullLabel].length).toBeGreaterThan(50);
  expect([...boundaryLabel]).toHaveLength(40);
  for (const [label, display] of [
    [fullLabel, truncatedLabel],
    [boundaryLabel, boundaryLabel],
  ]) {
    const item = card.getByRole(role, { name: label, exact: true });
    await expect(item).toHaveAccessibleName(label);
    await expect(item).toHaveAttribute('title', label);
    await expect(item).toHaveText(display);
    expect([...(await item.innerText())]).toHaveLength(label === fullLabel ? 41 : 40);
  }
}

async function expectAxisTitles(page: Page) {
  const sideways = tile(page, 'horizontal-bar');
  await expect(sideways.locator('.dashboard-axis-title')).toHaveCount(0);
  await expect(sideways.getByText(valueAxisTitle, { exact: true })).toHaveCount(0);
  const labels = await sideways.locator('canvas').evaluate((element) => {
    // Keep the most recent position for each text after resize/font redraws.
    const latest = new Map<string, CanvasLabel>();
    for (const label of (element as RecordedCanvas).legendLabels ?? [])
      latest.set(label.text, label);
    return [...latest.values()];
  });
  const title = labels.find((label) => label.text === valueAxisTitle);
  expect(title).toBeDefined();
  const ticks = labels.filter((label) => /^-?\d+(?:\.\d+)?$/.test(label.text));
  expect(ticks.length).toBeGreaterThan(1);
  for (const tick of ticks) expect(title!.y).toBeGreaterThan(tick.y);
  const vertical = tile(page, 'timeseries-grouped');
  const paragraph = vertical.locator('.dashboard-axis-title');
  await expect(paragraph).toHaveText(verticalAxisTitle);
  const [paragraphBox, canvasBox] = await Promise.all([
    paragraph.boundingBox(),
    vertical.locator('canvas').boundingBox(),
  ]);
  expect(paragraphBox!.y + paragraphBox!.height).toBeLessThanOrEqual(canvasBox!.y);
}

async function axe(page: Page) {
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

function urlRange(page: Page) {
  const params = new URL(page.url()).searchParams;
  return { startTime: params.get('start'), endTime: params.get('end') };
}

async function beginDrag(page: Page, file: string, from: number, to: number) {
  const over = tile(page, file).locator('.u-over');
  await over.scrollIntoViewIfNeeded();
  const box = (await over.boundingBox())!;
  expect(box.width * Math.abs(to - from)).toBeGreaterThan(3);
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * from, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * to, y, { steps: 12 });
  return box;
}

async function expectSelection(card: Locator) {
  const selection = card.locator('.u-select');
  await expect(selection).toBeVisible();
  expect(
    await selection.evaluate((element) => {
      const style = getComputedStyle(element);
      return { background: style.backgroundColor, border: style.borderColor };
    }),
  ).toEqual({ background: 'rgba(147, 51, 234, 0.08)', border: 'rgba(147, 51, 234, 0.4)' });
}

async function expectZoom(page: Page, calls: QueryCall[], previousCount: number) {
  await expect.poll(() => urlRange(page)).not.toEqual({ startTime: start, endTime: end });
  const range = urlRange(page);
  for (const bound of [range.startTime, range.endTime])
    expect(bound).toMatch(/^2026-10-10T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  expect(Date.parse(range.startTime!)).toBeGreaterThan(Date.parse(start));
  expect(Date.parse(range.endTime!)).toBeLessThan(Date.parse(end));
  expect(Date.parse(range.endTime!)).toBeGreaterThan(Date.parse(range.startTime!));
  expect(new URL(page.url()).searchParams.has('range')).toBe(false);
  await expect(page.getByRole('combobox', { name: 'Time range', exact: true })).toHaveValue(
    'custom',
  );
  await expect(page.getByText('Unsaved changes', { exact: true })).toBeVisible();
  await expect(page.getByText('All changes saved', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  await expect
    .poll(
      () =>
        calls
          .slice(previousCount)
          .filter(
            (call) =>
              call.query === queryFor('timeseries-grouped') &&
              call.startTime === range.startTime &&
              call.endTime === range.endTime,
          ).length,
    )
    .toBeGreaterThan(0);
  const request = calls
    .slice(previousCount)
    .find((call) => call.query === queryFor('timeseries-grouped'))!;
  expect(request.startTime).toBe(range.startTime);
  expect(request.endTime).toBe(range.endTime);
  // The custom picker must expose the new bounds, not just retain its initial custom value.
  await page.getByRole('button', { name: 'Choose absolute time range', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Time range', exact: true });
  // Chromium omits zero seconds from datetime-local values; compare the UTC instants.
  for (const [label, bound] of [
    ['From', range.startTime],
    ['To', range.endTime],
  ]) {
    const input = dialog.getByLabel(label!, { exact: true });
    await expect
      .poll(async () => Date.parse(`${await input.inputValue()}Z`))
      .toBe(Date.parse(bound!));
  }
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  return request;
}

async function expectNoZoom(
  page: Page,
  calls: QueryCall[],
  previousCount: number,
  previousUrl: string,
) {
  await page.waitForLoadState('networkidle');
  await expect(page).toHaveURL(previousUrl);
  await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();
  await expect(page.getByText('Unsaved changes', { exact: true })).toHaveCount(0);
  expect(calls).toHaveLength(previousCount);
}

test.use({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });

for (const theme of ['light', 'dark'] as const) {
  test(`${theme}: swatches, group titles, code-point truncation, axis titles and axe`, async ({
    page,
  }) => {
    await openDashboard(page, theme);
    const groupedTile = tile(page, 'timeseries-grouped');
    const lineSwatches = groupedTile.locator('[data-legend-swatch="line"]');
    await expect(lineSwatches).toHaveCount(2);
    await expect(groupedTile.locator('[data-legend-swatch="square"]')).toHaveCount(0);
    await expect(lineSwatches.first()).toHaveCSS('border-color', 'rgb(59, 130, 246)');
    for (const [file, count] of [
      ['grouped-bar', 2],
      ['stacked-bar', 2],
      ['area', 1],
      ['timeseries-area', 1],
      ['horizontal-bar', 1],
      ['categorical-bar', 1],
      ['pie', 5],
      ['bubble', 2],
    ] as const)
      await expectSquares(tile(page, file), count);
    for (const file of ['timeseries-grouped', 'grouped-bar', 'stacked-bar']) {
      const card = tile(page, file);
      await expect(card.locator('li.charts-legend-title')).toHaveText('service:');
      await expect(
        card.getByRole('list', { name: 'service: series visibility', exact: true }),
      ).toBeVisible();
    }
    await expect(tile(page, 'two-groups').locator('li.charts-legend-title')).toHaveText(
      'service | level:',
    );
    await expect(
      tile(page, 'two-groups').getByRole('list', {
        name: 'service | level: series visibility',
        exact: true,
      }),
    ).toBeVisible();
    for (const file of ['line', 'area', 'timeseries-area', 'categorical-bar']) {
      await expect(tile(page, file).locator('li.charts-legend-title')).toHaveCount(0);
      await expect(
        tile(page, file).getByRole('list', { name: 'Series visibility', exact: true }),
      ).toBeVisible();
    }
    await expectFullLabels(tile(page, 'truncated-legend'));
    await expectFullLabels(tile(page, 'pie'));
    await expectFullLabels(tile(page, 'bubble'), 'listitem');
    await expectAxisTitles(page);
    await axe(page);
  });
}

test('mouse drag shows the selection and zooms the dashboard URL, picker, badge and query', async ({
  page,
}) => {
  const calls = await openDashboard(page);
  const previousCount = calls.length;
  const card = tile(page, 'timeseries-grouped');
  await expect(card.getByRole('img')).toHaveAttribute('data-zoom-enabled', 'true');
  await beginDrag(page, 'timeseries-grouped', 0.28, 0.74);
  await expectSelection(card);
  // Record the selected plot bounds while the mouse is held down.
  const selected = await card.locator('.u-select').evaluate((element) => {
    const left = parseFloat((element as HTMLElement).style.left);
    const width = parseFloat((element as HTMLElement).style.width);
    const plotWidth = element.closest('.u-over')!.getBoundingClientRect().width;
    return { from: left / plotWidth, to: (left + width) / plotWidth };
  });
  const duration = Date.parse(end) - Date.parse(start);
  const selectedStart = Math.floor((Date.parse(start) + selected.from * duration) / 1000) * 1000;
  const selectedEnd = Math.ceil((Date.parse(start) + selected.to * duration) / 1000) * 1000;
  expect(
    timeBuckets.filter(
      (time) => Date.parse(time) >= selectedStart && Date.parse(time) <= selectedEnd,
    ).length,
  ).toBeGreaterThanOrEqual(2);
  await mkdir(shots, { recursive: true });
  await page.screenshot({ path: join(shots, 'zoom-selection.png') });
  await page.mouse.up();
  await page.mouse.move(0, 0);
  const request = await expectZoom(page, calls, previousCount);
  expect(Date.parse(request.startTime)).toBeGreaterThanOrEqual(selectedStart - 1000);
  expect(Date.parse(request.startTime)).toBeLessThanOrEqual(selectedStart + 1000);
  expect(Date.parse(request.endTime)).toBeGreaterThanOrEqual(selectedEnd - 1000);
  expect(Date.parse(request.endTime)).toBeLessThanOrEqual(selectedEnd + 1000);
  await expect(card.locator('.u-select')).toBeHidden();
  await expect(card.locator('[aria-live="polite"][aria-atomic="true"]')).toContainText('Zoomed to');
});

test('keyboard Shift+Arrow selection announces points and Enter applies the absolute range', async ({
  page,
}) => {
  const calls = await openDashboard(page);
  const previousCount = calls.length;
  const previousUrl = page.url();
  const card = tile(page, 'timeseries-grouped');
  const plot = card.getByRole('img');
  await page.mouse.move(0, 0);
  await plot.focus();
  await expect(plot).toHaveAccessibleDescription(/Shift\+ArrowLeft.*Enter to zoom/);
  await plot.press('ArrowRight');
  await plot.press('Shift+ArrowRight');
  await plot.press('Shift+ArrowRight');
  await expectSelection(card);
  const announcement = card.locator('[aria-live="polite"][aria-atomic="true"]');
  await expect(announcement).toContainText('Selected 3 points');
  await expect(announcement).toContainText('Press Enter to zoom.');
  await expectNoZoom(page, calls, previousCount, previousUrl);
  await plot.press('Enter');
  const request = await expectZoom(page, calls, previousCount);
  expect(request.startTime).toBe(timeBuckets[0]);
  expect(request.endTime).toBe(timeBuckets[2]);
  await expect(card.locator('.u-select')).toBeHidden();
  await expect(announcement).toContainText('Zoomed to');
});

test('a one-point drag, a plain click and Escape cancellation leave the range and queries unchanged', async ({
  page,
}) => {
  const calls = await openDashboard(page);
  const previousCount = calls.length;
  const previousUrl = page.url();
  const card = tile(page, 'timeseries-grouped');
  const box = await beginDrag(page, 'timeseries-grouped', 0.47, 0.53);
  await page.mouse.up();
  await expectNoZoom(page, calls, previousCount, previousUrl);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expectNoZoom(page, calls, previousCount, previousUrl);
  await page.mouse.move(0, 0);
  const plot = card.getByRole('img');
  await plot.focus();
  await plot.press('ArrowRight');
  await plot.press('Shift+ArrowRight');
  await plot.press('Shift+ArrowRight');
  await expectSelection(card);
  await plot.press('Escape');
  await expect(card.locator('.u-select')).toBeHidden();
  await expect(card.locator('[aria-live="polite"][aria-atomic="true"]')).toHaveText(
    'Selection cleared.',
  );
  await plot.press('Enter');
  await expectNoZoom(page, calls, previousCount, previousUrl);
});

test('a tile with its own range cannot change the dashboard URL or other tile queries by zooming', async ({
  page,
}) => {
  const calls = await openDashboard(page, 'light', true);
  const previousCount = calls.length;
  const previousUrl = page.url();
  const card = tile(page, 'timeseries-grouped');
  const plot = card.getByRole('img');
  await expect(plot).not.toHaveAttribute('data-zoom-enabled');
  await plot.press('ArrowRight');
  await plot.press('Shift+ArrowRight');
  await plot.press('Enter');
  await expectNoZoom(page, calls, previousCount, previousUrl);
  await beginDrag(page, 'timeseries-grouped', 0.28, 0.74);
  await page.mouse.up();
  await expect(card.locator('.u-select')).toBeHidden();
  await expect(card.getByText(/Zoomed to/)).toHaveCount(0);
  await expectNoZoom(page, calls, previousCount, previousUrl);
});

for (const file of ['line', 'area', 'time-bar', 'categorical-bar']) {
  test(`${file}: dragging a non-timeseries tile does not zoom or mark the dashboard dirty`, async ({
    page,
  }) => {
    const calls = await openDashboard(page);
    const previousCount = calls.length;
    const previousUrl = page.url();
    const card = tile(page, file);
    expect(await card.getByRole('img').getAttribute('data-zoom-enabled')).toBeNull();
    await beginDrag(page, file, 0.28, 0.74);
    await expect(card.locator('.u-select')).toBeHidden();
    await page.mouse.up();
    await expectNoZoom(page, calls, previousCount, previousUrl);
  });
}

test('save full dashboard light/dark and individual legend tile screenshots', async ({ page }) => {
  await mkdir(shots, { recursive: true });
  await openDashboard(page);
  await page.mouse.move(0, 0);
  for (const file of [
    'timeseries-grouped',
    'area',
    'grouped-bar',
    'truncated-legend',
    'horizontal-bar',
  ])
    await tile(page, file).screenshot({ path: join(shots, `${file}-light.png`) });
  await page.getByRole('heading', { name: dashboard.title, exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(shots, 'legend-light.png'), fullPage: true });
  await page.getByRole('button', { name: 'Use dark theme', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await chartsReady(page);
  await page.mouse.move(0, 0);
  await page.screenshot({ path: join(shots, 'legend-dark.png'), fullPage: true });
});
