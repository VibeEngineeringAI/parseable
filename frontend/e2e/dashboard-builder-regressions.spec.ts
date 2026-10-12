import { test, expect, type Page, type Locator } from '@playwright/test';
import classic from '../src/features/dashboards/__fixtures__/classic.json' with { type: 'json' };
import type { Dashboard, DashboardTile } from '../src/lib/types';

async function serve(page: Page, tiles: DashboardTile[] = []) {
  const writes: Dashboard[] = [];
  const queries: string[] = [];
  let current: Dashboard = {
    ...structuredClone(classic),
    variables: [],
    sections: [],
    tiles,
  };
  await page.context().addCookies(
    ['user_id', 'username'].map((name) => ({
      name,
      value: 'admin',
      url: String(test.info().project.use.baseURL),
    })),
  );
  await page.route('**/api/**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (path === '/api/v1/about') return route.fulfill({ json: { capabilities: {} } });
    if (path === '/api/v1/users/admin')
      return route.fulfill({ json: { id: 'admin', username: 'admin' } });
    if (path === '/api/v1/user/admin/role')
      return route.fulfill({
        json: { roles: { root: { actions: [{ privilege: 'admin' }], roleType: 'internal' } } },
      });
    if (path === '/api/v1/logstream') return route.fulfill({ json: [{ name: 'app-logs' }] });
    if (path.endsWith('/schema'))
      return route.fulfill({
        json: { fields: ['p_timestamp', 'service', 'requests'].map((name) => ({ name })) },
      });
    if (path.endsWith('/info'))
      return route.fulfill({ json: { logSource: [{ log_source_format: 'json' }] } });
    if (path === '/api/v1/query') {
      const body = request.postDataJSON();
      const sql = body.query as string;
      queries.push(sql);
      const rows = [2, 30, 5].map((COUNT_STAR, index) => ({
        time_bucket: new Date(Date.parse(body.endTime) - (3 - index) * 60_000).toISOString(),
        COUNT_STAR,
        service: 'api',
      }));
      // Simulate the server's first ORDER BY key before LIMIT. This makes an
      // unwanted leading time_bucket DESC observable in the plotted values.
      const order = sql.match(/ORDER BY "(time_bucket|COUNT_STAR)" (ASC|DESC)/);
      if (order) {
        const field = order[1] as 'time_bucket' | 'COUNT_STAR';
        rows.sort((a, b) => {
          const compare = a[field] < b[field] ? -1 : a[field] > b[field] ? 1 : 0;
          return order[2] === 'ASC' ? compare : -compare;
        });
      }
      const limit = Number(sql.match(/LIMIT (\d+)/)?.[1] ?? rows.length);
      return route.fulfill({ json: rows.slice(0, limit) });
    }
    if (path.startsWith('/api/v1/dashboards/')) {
      if (request.method() === 'PUT') {
        current = request.postDataJSON();
        writes.push(structuredClone(current));
      }
      return route.fulfill({ json: current });
    }
    return route.fulfill({ json: [] });
  });
  await page.goto(`/dashboards/${classic.dashboardId}`);
  await expect(page.getByRole('heading', { name: classic.title, exact: true })).toBeVisible();
  return { writes, queries };
}

async function addBuilder(page: Page) {
  await page.getByRole('button', { name: 'Add tile', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Add tile', exact: true });
  await editor.getByLabel('Tile title', { exact: true }).fill('Bucket counts');
  await editor.getByLabel('Dataset', { exact: true }).selectOption('app-logs');
  await editor.getByLabel('Query language', { exact: true }).selectOption('builder');
  return editor;
}

async function save(page: Page) {
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Dashboard saved.', { exact: true })).toBeVisible();
}

async function firstChartValue(editor: Locator, expected: number) {
  const chart = editor.locator('.dashboard-preview').getByRole('img');
  await expect(chart).toBeVisible();
  await chart.focus();
  await chart.press('ArrowRight');
  await expect(editor.getByRole('tooltip').locator('strong')).toHaveText(String(expected));
  await chart.press('Escape');
}

test('new default time-series builder plots preview and saved buckets with automatic bindings', async ({
  page,
}) => {
  const server = await serve(page);
  const editor = await addBuilder(page);
  await expect(editor.getByLabel('X axis (time or category)', { exact: true })).toHaveValue('');
  await editor.getByRole('button', { name: 'Run query', exact: true }).click();
  await expect(editor.locator('.dashboard-preview figure')).toBeVisible();
  await expect(editor.getByText(/x values are not timestamps/)).toHaveCount(0);
  await editor.getByRole('button', { name: 'Add tile', exact: true }).click();
  await save(page);
  expect(server.writes.at(-1)!.tiles![0]).toMatchObject({
    tileType: 'builder',
    chartType: 'timeseries',
    config: { axes: { x: { field: '' }, y: { field: '' } } },
    chartQuery: { x: { fields: [{ name: 'p_timestamp' }] } },
  });
  await page.reload();
  const region = page.getByRole('region', { name: 'Tile Bucket counts', exact: true });
  await expect(region.locator('figure')).toBeVisible();
  await expect(region.getByText(/x values are not timestamps/)).toHaveCount(0);
  expect(server.queries.at(-1)).toContain('ORDER BY "time_bucket" DESC LIMIT 100');
});

test('time and aggregate ASC/DESC sorting controls limited results and survives save/reload', async ({
  page,
}) => {
  const server = await serve(page);
  const editor = await addBuilder(page);
  await editor.getByLabel('Row limit', { exact: true }).fill('2');
  for (const [field, direction, firstValue] of [
    ['time_bucket', 'ASC', 2],
    ['time_bucket', 'DESC', 30],
    ['COUNT_STAR', 'ASC', 2],
    ['COUNT_STAR', 'DESC', 30],
  ] as const) {
    await editor.getByLabel('Order by', { exact: true }).selectOption(field);
    await editor.getByLabel('Order direction', { exact: true }).selectOption(direction);
    const count = server.queries.length;
    await editor.getByRole('button', { name: 'Run query', exact: true }).click();
    await expect.poll(() => server.queries.length).toBeGreaterThan(count);
    expect(server.queries.at(-1)!.split(' ORDER BY ')[1]).toBe(`"${field}" ${direction} LIMIT 2`);
    await firstChartValue(editor, firstValue);
  }
  await editor.getByRole('button', { name: 'Add tile', exact: true }).click();
  await save(page);
  expect(server.writes.at(-1)!.tiles![0].chartQuery).toMatchObject({
    y: { sortBy: { field: 'COUNT_STAR', direction: 'DESC' }, limit: 2 },
  });
  await page.reload();
  await expect(
    page.getByRole('region', { name: 'Tile Bucket counts', exact: true }).locator('figure'),
  ).toBeVisible();
  expect(server.queries.at(-1)!.split(' ORDER BY ')[1]).toBe('"COUNT_STAR" DESC LIMIT 2');
  await page.getByRole('button', { name: 'Actions for tile Bucket counts', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
  const reloaded = page.getByRole('dialog', { name: 'Edit tile', exact: true });
  await expect(reloaded.getByLabel('Order by', { exact: true })).toHaveValue('COUNT_STAR');
  await reloaded.getByLabel('Order by', { exact: true }).selectOption('');
  await reloaded.getByRole('button', { name: 'Run query', exact: true }).click();
  await expect.poll(() => server.queries.at(-1)).toContain('ORDER BY "time_bucket" DESC LIMIT 2');
  await reloaded.getByRole('button', { name: 'Apply tile', exact: true }).click();
  await save(page);
  expect(server.writes.at(-1)!.tiles![0].chartQuery).toMatchObject({ y: { limit: 2 } });
  expect((server.writes.at(-1)!.tiles![0].chartQuery as { y: object }).y).not.toHaveProperty(
    'sortBy',
  );
});

test('explicit legacy X binding and opaque metadata survive preview, title edits and save/reload', async ({
  page,
}) => {
  const original: DashboardTile = {
    tile_id: '01JZ8Y4A0C7H3GQ5P2W9D8S001',
    title: 'Explicit binding',
    chartType: 'timeseries',
    dbName: ['app-logs'],
    chartQuery: {
      x: { fields: [{ name: 'p_timestamp' }], granularity: 'minute', futureDimension: true },
      y: { fields: [{ name: '*', aggregate: 'COUNT' }], limit: 2 },
    },
    layout: { x: 0, y: 0, w: 6, h: 4 },
    config: {
      axes: { x: { field: 'service', vendorBinding: true }, y: { field: '' } },
      vendorConfig: { keep: true },
    },
    extensionMetadata: { owner: 'Observability' },
  };
  const server = await serve(page, [original]);
  await page
    .getByRole('button', { name: 'Actions for tile Explicit binding', exact: true })
    .click();
  await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Edit tile', exact: true });
  await expect(editor.getByLabel('Query language', { exact: true })).toHaveValue('builder');
  await expect(editor.getByLabel('X axis (time or category)', { exact: true })).toHaveValue(
    'service',
  );
  await editor.getByRole('button', { name: 'Run query', exact: true }).click();
  await expect(
    editor.locator('.dashboard-preview').getByText(/x values are not timestamps/),
  ).toBeVisible();
  await editor.getByLabel('Tile title', { exact: true }).fill('Binding preserved');
  await editor.getByRole('button', { name: 'Apply tile', exact: true }).click();
  await save(page);
  expect(server.writes.at(-1)!.tiles![0]).toEqual({ ...original, title: 'Binding preserved' });
  await page.reload();
  await expect(
    page
      .getByRole('region', { name: 'Tile Binding preserved', exact: true })
      .getByText(/x values are not timestamps/),
  ).toBeVisible();
});
