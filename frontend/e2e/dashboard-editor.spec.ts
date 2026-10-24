import { test, expect, type Locator, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import classic from '../src/features/dashboards/__fixtures__/classic.json' with { type: 'json' };
import type { Dashboard } from '../src/lib/types';

const detail = `/dashboards/${classic.dashboardId}`;
const shotDir = process.env.EDITOR_SHOTS;
const columns = [
  { time: '2026-10-10T08:00:00Z', service: 'api', requests: 12, size: 4, cpu_pct: 41.5 },
  { time: '2026-10-10T08:05:00Z', service: 'web', requests: 7, size: 9, cpu_pct: 43 },
];

/** Serves an empty classic dashboard and records the document written by Save. */
async function serve(page: Page, tiles: Dashboard['tiles'] = []) {
  const writes: Dashboard[] = [];
  let current = { ...structuredClone(classic), variables: [], sections: [], tiles } as Dashboard;
  await page.context().addCookies([
    { name: 'user_id', value: 'admin', url: 'http://127.0.0.1:5185' },
    { name: 'username', value: 'admin', url: 'http://127.0.0.1:5185' },
  ]);
  await page.route('**/api/**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (path === '/api/v1/about')
      return route.fulfill({ json: { capabilities: { promql: true, promqlDashboard: true } } });
    if (path === '/api/v1/users/admin')
      return route.fulfill({ json: { id: 'admin', username: 'admin' } });
    if (path === '/api/v1/user/admin/role')
      return route.fulfill({
        json: { roles: { root: { actions: [{ privilege: 'admin' }], roleType: 'internal' } } },
      });
    if (path === '/api/v1/logstream')
      return route.fulfill({ json: [{ name: 'app-logs' }, { name: 'otel-metrics' }] });
    if (path.endsWith('/info'))
      return route.fulfill({ json: { logSource: [{ log_source_format: 'json' }] } });
    if (path === '/api/v1/targets') return route.fulfill({ json: [] });
    if (path === '/api/v1/query') return route.fulfill({ json: columns });
    if (path.startsWith('/api/v1/dashboards/')) {
      if (request.method() === 'PUT') {
        current = { ...request.postDataJSON(), modified: '2026-10-10T09:00:00Z' };
        writes.push(structuredClone(current));
      }
      return route.fulfill({ json: current });
    }
    if (path === '/api/v1/dashboards') return route.fulfill({ json: [] });
    return route.fulfill({ status: 404, body: `Unhandled mock ${path}` });
  });
  await page.goto(detail);
  await expect(page.getByRole('heading', { name: classic.title, exact: true })).toBeVisible();
  return { writes };
}

/** Full-height dialog screenshot for the project wiki, only when EDITOR_SHOTS names a directory. */
async function shot(page: Page, name: string) {
  if (!shotDir) return;
  await page.setViewportSize({ width: 1440, height: 2000 });
  await page.screenshot({ path: `${shotDir}/${name}.png` });
  await page.setViewportSize({ width: 1440, height: 1000 });
}

async function axe(page: Page) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addStyleTag({
    content: '*, *::before, *::after { animation: none !important; transition: none !important; }',
  });
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
}

async function openEditor(page: Page, title: string, chart: string, sql: string) {
  await page.getByRole('button', { name: 'Add tile', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Add tile', exact: true });
  await editor.getByLabel('Tile title').fill(title);
  await editor.getByRole('combobox', { name: 'Dataset', exact: true }).click();
  await editor.getByRole('option', { name: 'app-logs', exact: true }).click();
  await editor.getByRole('textbox', { name: 'SQL query', exact: true }).fill(sql);
  await editor.getByLabel('Chart type').selectOption({ label: chart });
  return editor;
}

const add = (editor: Locator) =>
  editor.getByRole('button', { name: 'Add tile', exact: true }).click();
async function addField(editor: Locator, label: string, value: string) {
  await editor.getByLabel(label, { exact: true }).fill(value);
  await editor.getByRole('button', { name: `Add ${label}`, exact: true }).click();
}

test('creating every chart type through the editor saves classic-compatible keys', async ({
  page,
}) => {
  // Eleven editor flows and four full-page accessibility scans share this budget.
  test.setTimeout(60_000);

  const server = await serve(page);
  const sql = 'SELECT time, service, requests FROM "app-logs"';

  let editor = await openEditor(page, 'Stacked', 'Stacked bar', sql);
  await expect(editor.getByLabel('Chart type')).toHaveValue('stacked-bar');
  await editor.getByLabel('X axis (time or category)').fill('time');
  await addField(editor, 'Y axis', 'requests');
  await addField(editor, 'Group by', 'service');
  await editor.getByLabel('Color scheme').selectOption('teal');
  await editor.getByLabel('Legend position').selectOption('top');
  await editor.getByLabel('Orientation').selectOption('horizontal');
  await expect(editor.getByLabel('Labels')).toHaveCount(0);
  await shot(page, 'editor-stacked-bar');
  await axe(page);
  await add(editor);

  editor = await openEditor(page, 'Pie', 'Pie', sql);
  await expect(editor.getByText(/slice labels from this column/)).toBeVisible();
  await expect(editor.getByLabel('Group by')).toHaveCount(0);
  await expect(editor.getByLabel('X axis (time or category)')).toHaveCount(0);
  await expect(editor.getByLabel('X-axis title')).toHaveCount(0);
  await editor.getByLabel('Category column').fill('service');
  await editor.getByLabel('Labels').selectOption('show');
  await editor.getByLabel('Legend position').selectOption('right');
  await editor.getByLabel('Color scheme').selectOption('purple');
  await expect(editor.getByLabel('Legend position').locator('option')).toHaveText([
    'Top',
    'Bottom',
    'Left',
    'Right',
  ]);
  await shot(page, 'editor-pie');
  await axe(page);
  await add(editor);

  editor = await openEditor(page, 'Donut', 'Donut', sql);
  await editor.getByLabel('Category column').fill('service');
  await add(editor);

  editor = await openEditor(
    page,
    'Gauge',
    'Gauge',
    'SELECT AVG(cpu_pct) AS cpu_pct FROM "app-logs"',
  );
  await expect(editor.getByLabel('Color scheme')).toHaveCount(0);
  await expect(editor.getByLabel('Legend position')).toHaveCount(0);
  await editor.getByLabel('Value column').fill('cpu_pct');
  await editor.getByLabel('Range to').fill('200');
  await editor.getByLabel('Segments').selectOption('2');
  await editor.getByLabel('Threshold mode').selectOption('absolute');
  await expect(editor.getByLabel('Threshold 1')).toHaveValue('20');
  await expect(editor.getByLabel('Threshold 2')).toHaveValue('180');
  await editor.getByLabel('Threshold 1').fill('50');
  await editor.getByLabel('Threshold 2').fill('150');
  await editor.getByLabel('Auto-formatting').selectOption('on');
  await editor.getByLabel('Unit', { exact: true }).fill('GB');
  await shot(page, 'editor-gauge');
  await axe(page);
  await add(editor);

  editor = await openEditor(page, 'Bubble', 'Bubble', sql);
  await editor.getByLabel('X axis', { exact: true }).fill('requests');
  await editor.getByLabel('Y axis', { exact: true }).fill('size');
  await editor.getByLabel('Size field').fill('size');
  await addField(editor, 'Group by', 'service');
  await shot(page, 'editor-bubble');
  await axe(page);
  await add(editor);

  editor = await openEditor(page, 'Horizontal', 'Bar', sql);
  await editor.getByLabel('Orientation').selectOption('horizontal');
  await add(editor);

  editor = await openEditor(page, 'Area', 'Area', sql);
  await add(editor);
  editor = await openEditor(page, 'Line', 'Line', sql);
  await add(editor);
  editor = await openEditor(page, 'Value', 'Query value', sql);
  await add(editor);
  editor = await openEditor(page, 'Table', 'Table', sql);
  await expect(editor.getByLabel('X axis (time or category)')).toHaveCount(0);
  await add(editor);
  editor = await openEditor(page, 'Timeseries bars', 'Timeseries', sql);
  await editor.getByLabel('Series style').selectOption('area');
  await add(editor);

  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Dashboard saved.', { exact: true })).toBeVisible();
  const tiles = new Map(server.writes.at(-1)!.tiles!.map((tile) => [tile.title, tile]));
  const config = (title: string) => tiles.get(title)!.config as any;
  const summary = (title: string) => ({
    chartType: tiles.get(title)!.chartType,
    type: config(title).type,
  });

  expect(summary('Stacked')).toEqual({ chartType: 'timeseries', type: 'bar' });
  expect(config('Stacked').layout).toMatchObject({
    stacked: true,
    barOrientation: 'horizontal',
    legendPosition: 'top',
  });
  expect(config('Stacked').colourScheme).toBe('teal');
  expect(config('Stacked').axes).toMatchObject({
    x: { field: 'time' },
    y: { field: 'requests' },
    groupBy: { field: ['service'] },
  });

  expect(summary('Pie')).toEqual({ chartType: 'pie', type: 'pie' });
  expect(config('Pie')).toMatchObject({
    colourScheme: 'purple',
    layout: { label: true, legendPosition: 'right', stacked: false },
    axes: { y: { field: 'service' } },
  });
  expect(summary('Donut')).toEqual({ chartType: 'donut', type: 'donut' });
  expect(config('Donut').axes.y.field).toBe('service');

  expect(summary('Gauge')).toEqual({ chartType: 'gauge', type: 'gauge' });
  expect(config('Gauge').layout).toMatchObject({
    rangeTo: 200,
    segments: { value: [50, 150], isPercent: false },
    humanize: true,
    unit: 'GB',
  });
  expect(config('Gauge').axes.y.field).toBe('cpu_pct');

  expect(summary('Bubble')).toEqual({ chartType: 'bubble', type: 'bubble' });
  expect(config('Bubble').axes).toMatchObject({
    x: { field: 'requests' },
    y: { field: 'size' },
    size: { field: 'size' },
    groupBy: { field: ['service'] },
  });

  expect(summary('Horizontal')).toEqual({ chartType: 'bar', type: 'bar' });
  expect(config('Horizontal').layout.barOrientation).toBe('horizontal');
  expect(summary('Area')).toEqual({ chartType: 'area', type: 'area' });
  expect(summary('Line')).toEqual({ chartType: 'line', type: 'line' });
  expect(summary('Value')).toEqual({ chartType: 'query-value', type: 'query-value' });
  expect(config('Value').layout.sparkline).toBe(true);
  expect(summary('Table')).toEqual({ chartType: 'table', type: 'table' });
  expect(summary('Timeseries bars')).toEqual({ chartType: 'timeseries', type: 'area' });
  expect(config('Timeseries bars').layout.stacked).toBeUndefined();
});

const stored = (title: string, chartType: string, config: Record<string, unknown>, y: number) => ({
  tile_id: `01JZ8Y4A0C7H3GQ5P2W9D8S${String(y).padStart(3, '0')}`,
  title,
  tileType: 'code',
  chartType,
  chartQuery: 'SELECT time, service, requests FROM "app-logs"',
  dbName: ['app-logs'],
  layout: { x: 0, y, w: 6, h: 6 },
  config,
});

async function edit(page: Page, title: string) {
  await page.getByRole('button', { name: `Actions for tile ${title}`, exact: true }).click();
  await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
  return page.getByRole('dialog', { name: 'Edit tile', exact: true });
}

test('stored tiles read back into the picker and keep unknown keys untouched', async ({ page }) => {
  const tiles = [
    stored(
      'Stacked',
      'timeseries',
      { type: 'bar', layout: { stacked: true, future: 1 }, extra: { keep: true } },
      0,
    ),
    stored('Plain bars', 'timeseries', { type: 'bar', layout: { future: 2 } }, 1),
    stored('Left line', 'line', { type: 'line', layout: { legendPosition: 'left' } }, 2),
    stored('Precise gauge', 'gauge', { type: 'gauge', layout: { precision: -1, unit: '%' } }, 3),
    stored('Old scheme', 'bar', { type: 'bar', colourScheme: 'forest' }, 4),
    stored('Odd', 'heatmap', { type: 'heatmap' }, 5),
  ] as unknown as Dashboard['tiles'];
  const server = await serve(page, tiles);

  let editor = await edit(page, 'Stacked');
  await expect(editor.getByLabel('Chart type')).toHaveValue('stacked-bar');
  await expect(editor.getByLabel('Orientation')).toHaveValue('vertical');
  await editor.getByLabel('Tile title').fill('Stacked renamed');
  await editor.getByRole('button', { name: 'Apply tile', exact: true }).click();

  editor = await edit(page, 'Plain bars');
  await expect(editor.getByLabel('Chart type')).toHaveValue('timeseries');
  await expect(editor.getByLabel('Series style')).toHaveValue('bar');
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click();

  editor = await edit(page, 'Left line');
  await expect(editor.getByLabel('Legend position')).toHaveValue('left');
  await expect(editor.getByLabel('Legend position').locator('option')).toHaveText([
    'Left (preserved)',
    'Top',
    'Bottom',
  ]);
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click();

  editor = await edit(page, 'Precise gauge');
  await expect(editor.getByLabel('Precision')).toHaveValue('-1');
  await expect(editor.getByLabel('Segments')).toHaveValue('2');
  await expect(editor.getByLabel('Auto-formatting')).toHaveValue('off');
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click();

  editor = await edit(page, 'Old scheme');
  await expect(editor.getByLabel('Color scheme')).toHaveValue('classic');
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click();

  editor = await edit(page, 'Odd');
  await expect(editor.getByLabel('Chart type')).toHaveValue('heatmap');
  await expect(editor.getByLabel('Chart type').locator('option').first()).toHaveText(
    'heatmap (preserved)',
  );
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click();

  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Dashboard saved.', { exact: true })).toBeVisible();
  expect(server.writes.at(-1)!.tiles).toEqual([
    { ...tiles![0], title: 'Stacked renamed' },
    ...tiles!.slice(1),
  ]);

  // Round trip through the variants: Stacked bar and back keeps the bar subtype, drops the flag.
  editor = await edit(page, 'Plain bars');
  await editor.getByLabel('Chart type').selectOption('stacked-bar');
  await editor.getByLabel('Chart type').selectOption('timeseries');
  await expect(editor.getByLabel('Series style')).toHaveValue('bar');
  await editor.getByRole('button', { name: 'Apply tile', exact: true }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Dashboard saved.', { exact: true })).toBeVisible();
  expect(server.writes.at(-1)!.tiles![1].config).toEqual({
    type: 'bar',
    layout: { future: 2, stacked: false },
  });
});

test('gauge ranges and thresholds are validated and rescale in absolute mode', async ({ page }) => {
  await serve(page);
  const editor = await openEditor(page, 'Gauge', 'Gauge', 'SELECT 1 AS v');
  const apply = editor.getByRole('button', { name: 'Add tile', exact: true });
  await expect(apply).toBeEnabled();
  await editor.getByLabel('Range from').fill('100');
  await expect(
    editor.getByRole('alert').filter({ hasText: 'Range from must be below' }),
  ).toBeVisible();
  await expect(apply).toBeDisabled();
  await editor.getByLabel('Range from').fill('0');
  await expect(apply).toBeEnabled();
  await editor.getByLabel('Threshold 2').fill('5');
  await expect(
    editor.getByRole('alert').filter({ hasText: 'thresholds must increase' }),
  ).toBeVisible();
  await expect(apply).toBeDisabled();
  await editor.getByLabel('Threshold 2').fill('150');
  await expect(editor.getByRole('alert').filter({ hasText: 'Percent thresholds' })).toBeVisible();
  await editor.getByLabel('Threshold 2').fill('90');
  await expect(apply).toBeEnabled();
  await editor.getByLabel('Threshold mode').selectOption('absolute');
  await editor.getByLabel('Range to').fill('200');
  await expect(editor.getByLabel('Threshold 2')).toHaveValue('180');
  await editor.getByLabel('Segments').selectOption('0');
  await expect(editor.getByLabel('Threshold 1')).toHaveCount(0);
  await editor.getByLabel('Range to').fill('');
  await expect(apply).toBeDisabled();
});

test('column suggestions come from the preview and group by is limited to two', async ({
  page,
}) => {
  await serve(page);
  const editor = await openEditor(
    page,
    'Series',
    'Line',
    'SELECT time, service, requests FROM "app-logs"',
  );
  await editor.getByRole('button', { name: 'Run query', exact: true }).click();
  await expect(editor.locator('datalist option')).toHaveCount(columns.length ? 5 : 0);
  await editor.getByLabel('Group by', { exact: true }).fill('service');
  await editor.getByLabel('Group by', { exact: true }).press('Enter');
  await expect(editor.getByRole('dialog')).toHaveCount(0);
  await addField(editor, 'Group by', 'requests');
  await expect(editor.getByLabel('Group by', { exact: true })).toBeDisabled();
  await editor.getByRole('button', { name: 'Remove service', exact: true }).click();
  await expect(editor.getByLabel('Group by', { exact: true })).toBeEnabled();
  await addField(editor, 'Y axis', 'requests');
  await addField(editor, 'Y axis', 'cpu_pct');
  await expect(
    editor.getByRole('list', { name: 'Y axis fields' }).getByRole('listitem'),
  ).toHaveCount(2);
});

for (const choice of ['Stacked bar', 'Bubble'] as const) {
  test(`${choice} blocks applying unsupported inherited bindings until explicitly corrected`, async ({
    page,
  }) => {
    await serve(page);
    const editor = await openEditor(
      page,
      'Binding limits',
      'Bar',
      'SELECT time, service, requests, size FROM "app-logs"',
    );
    await editor.getByLabel('X axis (time or category)').fill('time');
    await addField(editor, 'Y axis', 'requests');
    if (choice === 'Stacked bar') await addField(editor, 'Y axis', 'size');
    await addField(editor, 'Group by', 'service');
    if (choice === 'Bubble') await addField(editor, 'Group by', 'region');
    await editor.getByLabel('Chart type').selectOption({ label: choice });
    const submit = editor.getByRole('button', { name: 'Add tile', exact: true });
    await expect(submit).toBeDisabled();
    await expect(submit).toHaveAccessibleDescription(
      choice === 'Stacked bar'
        ? 'Stacked bar supports one Y column. Remove extra Y fields and use Group by for series.'
        : 'Bubble supports one Group by column. Remove extra grouping fields.',
    );
    await editor
      .getByRole('button', {
        name: choice === 'Stacked bar' ? 'Remove size' : 'Remove region',
        exact: true,
      })
      .click();
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(editor).toHaveCount(0);
  });
}
