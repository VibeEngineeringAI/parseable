import { test, expect, type Page } from '@playwright/test';
import classic from '../src/features/dashboards/__fixtures__/classic.json' with { type: 'json' };
import type { Dashboard } from '../src/lib/types';

const tile = (title: string, x = 0) => ({
  tile_id: title === 'Second' ? '01JZ8Y4A0C7H3GQ5P2W9D8S002' : '01JZ8Y4A0C7H3GQ5P2W9D8S001',
  title,
  tileType: 'code',
  chartType: 'table',
  chartQuery: 'SELECT service FROM "app-logs"',
  dbName: ['app-logs'],
  layout: { x, y: 0, w: 4, h: 3 },
  config: { type: 'table' },
});
async function serve(
  page: Page,
  tiles: unknown[] = [tile('First'), tile('Second', 4)],
  author = classic.author,
) {
  const writes: Dashboard[] = [];
  const queries: any[] = [];
  let current = {
    ...structuredClone(classic),
    author,
    variables: [],
    sections: [],
    tiles,
  } as Dashboard;
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
        json: { fields: ['time', 'service', 'requests'].map((name) => ({ name })) },
      });
    if (path.endsWith('/info'))
      return route.fulfill({ json: { logSource: [{ log_source_format: 'json' }] } });
    if (path === '/api/v1/query') {
      queries.push(request.postDataJSON());
      return route.fulfill({ json: [{ service: 'api', requests: 12 }] });
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
async function save(page: Page) {
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Dashboard saved.', { exact: true })).toBeVisible();
}
async function edit(page: Page, title: string) {
  await page.getByRole('button', { name: `Actions for tile ${title}`, exact: true }).click();
  await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
  return page.getByRole('dialog', { name: 'Edit tile', exact: true });
}
async function action(page: Page, title: string, name: string) {
  await page.getByRole('button', { name: `Section actions for ${title}`, exact: true }).click();
  await page.getByRole('menuitem', { name, exact: true }).click();
}
async function drag(page: Page, label: string, dx: number, dy: number, cancel = false) {
  const handle = page.getByRole('button', { name: label, exact: true });
  await handle.scrollIntoViewIfNeeded();
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 6 });
  if (cancel) await page.keyboard.press('Escape');
  await page.mouse.up();
}

test('pointer and keyboard layout edits persist; Escape and Discard restore layout', async ({
  page,
}) => {
  const server = await serve(page);
  const cell = page.getByRole('region', { name: 'Tile First', exact: true }).locator('..');
  const grid = page.locator('.dashboard-layout-grid').first();
  const column = await grid.evaluate(
    (el) => (el.getBoundingClientRect().width + parseFloat(getComputedStyle(el).columnGap)) / 12,
  );
  await drag(page, 'Move tile First', column, 0);
  await expect(cell).toHaveCSS('grid-column-start', '2');
  await drag(page, 'Resize tile First', column, 0);
  await page.getByRole('button', { name: 'Resize tile First', exact: true }).press('ArrowDown');
  await save(page);
  expect(server.writes.at(-1)!.tiles![0].layout).toMatchObject({ x: 1, w: 5, h: 4 });
  await page.reload();
  await expect(cell).toHaveCSS('grid-column-start', '2');
  await drag(page, 'Move tile First', column, 0, true);
  await expect(cell).toHaveCSS('grid-column-start', '2');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Move tile First', exact: true }).press('ArrowDown');
  await expect(page.locator('.dashboard-layout-cell').first()).toContainText('Second');
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(page.locator('.dashboard-layout-cell').first()).toContainText('First');
  expect(server.writes).toHaveLength(1);
});

test('section add, assignment, rename, reorder, collapse and deletion round trip without losing tiles', async ({
  page,
}) => {
  const server = await serve(page);
  for (const title of ['Metrics', 'Logs']) {
    await page.getByRole('button', { name: 'Add section', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Add section', exact: true });
    await dialog.getByLabel('Section title').fill(title);
    await dialog.getByRole('button', { name: 'Add section', exact: true }).click();
  }
  const editor = await edit(page, 'First');
  await editor.getByLabel('Section', { exact: true }).selectOption({ label: 'Metrics' });
  await editor.getByRole('button', { name: 'Apply tile', exact: true }).click();
  await action(page, 'Metrics', 'Rename section');
  const rename = page.getByRole('dialog', { name: 'Rename section', exact: true });
  await rename.getByLabel('Section title').fill('Overview');
  await rename.getByRole('button', { name: 'Rename section', exact: true }).click();
  await action(page, 'Logs', 'Move section earlier');
  await save(page);
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Overview', exact: true })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Overview', exact: true })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  if (process.env.DASHBOARD_FEATURE_SHOTS)
    await page.screenshot({
      path: `${process.env.DASHBOARD_FEATURE_SHOTS}/sections.png`,
      fullPage: true,
    });
  await action(page, 'Overview', 'Collapse by default');
  await save(page);
  expect(server.writes.at(-1)!.sections).toMatchObject([
    { title: 'Logs' },
    { title: 'Overview', collapsed: true },
  ]);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Overview', exact: true })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  await expect(page.getByRole('region', { name: 'Tile First', exact: true })).toHaveCount(0);
  await action(page, 'Overview', 'Delete section');
  await page
    .getByRole('dialog', { name: 'Delete section?' })
    .getByRole('button', { name: 'Delete section', exact: true })
    .click();
  await expect(page.getByRole('region', { name: 'Dashboard tiles', exact: true })).toContainText(
    'First',
  );
  await save(page);
  expect(server.writes.at(-1)!.tiles).toHaveLength(2);
  expect(server.writes.at(-1)!.tiles!.find((t) => t.title === 'First')!.sectionId).toBe('');
  await page.reload();
  await expect(page.getByRole('region', { name: 'Dashboard tiles', exact: true })).toContainText(
    'First',
  );
});

test('read-only dashboards expose no mutation handles', async ({ page }) => {
  const server = await serve(page, [tile('First')], 'someone-else');
  await expect(
    page.getByText('This dashboard is read-only. Only its owner can edit it.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /^(Move|Resize) tile/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add section', exact: true })).toHaveCount(0);
  expect(server.writes).toEqual([]);
});

test('visual builder generates executable filtered SQL and survives save/reload', async ({
  page,
}) => {
  const server = await serve(page, []);
  await page.getByRole('button', { name: 'Add tile', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Add tile', exact: true });
  await editor.getByLabel('Tile title').fill('Requests');
  await editor.getByRole('combobox', { name: 'Dataset', exact: true }).click();
  await editor.getByRole('option', { name: 'app-logs', exact: true }).click();
  await editor.getByLabel('Query language').selectOption('builder');
  await editor.getByLabel('Chart type').selectOption('table');
  await expect(editor.getByLabel('Dimension 1')).toBeVisible();
  await editor.getByLabel('Dimension 1').selectOption('service');
  await editor.getByLabel('Aggregate 1', { exact: true }).selectOption('SUM');
  await editor.getByLabel('Aggregate field 1', { exact: true }).selectOption('requests');
  await editor.getByRole('button', { name: 'Add filter', exact: true }).click();
  await editor.getByLabel('Filter field 1').selectOption('service');
  await editor.getByLabel('Filter value 1').fill("api's");
  if (process.env.DASHBOARD_FEATURE_SHOTS)
    await editor.screenshot({ path: `${process.env.DASHBOARD_FEATURE_SHOTS}/visual-builder.png` });
  await editor.getByRole('button', { name: 'Run query', exact: true }).click();
  await expect.poll(() => JSON.stringify(server.queries)).toContain("api''s");
  await editor.getByRole('button', { name: 'Add tile', exact: true }).click();
  await save(page);
  expect(server.writes.at(-1)!.tiles![0]).toMatchObject({
    tileType: 'builder',
    chartQuery: {
      x: { fields: [{ name: 'service' }] },
      y: { fields: [{ name: 'requests', aggregate: 'SUM' }] },
      filters: [{ column: 'service', value: "api's" }],
    },
  });
  await page.reload();
  const reloaded = await edit(page, 'Requests');
  await expect(reloaded.getByLabel('Dimension 1')).toHaveValue('service');
  await expect(reloaded.getByLabel('Filter value 1')).toHaveValue("api's");
});

test('stored SQL builder definitions stay intact when changing only title', async ({ page }) => {
  const original = {
    ...tile('Stored'),
    tileType: 'builder',
    chartQuery: { sql: 'SELECT service FROM "app-logs"', future: { keep: true } },
  };
  const server = await serve(page, [original]);
  const editor = await edit(page, 'Stored');
  await expect(editor.getByText(/original definition is preserved/)).toBeVisible();
  await editor.getByLabel('Tile title').fill('Stored renamed');
  await editor.getByRole('button', { name: 'Apply tile', exact: true }).click();
  await save(page);
  expect(server.writes.at(-1)!.tiles![0]).toEqual({ ...original, title: 'Stored renamed' });
});

for (const legacy of ['SQL', 'Visual'] as const) {
  test(`legacy ${legacy} tile without tileType uses its inferred query editor`, async ({
    page,
  }) => {
    const { tileType: _type, ...base } = tile('Legacy');
    const original = {
      ...base,
      chartQuery:
        legacy === 'SQL'
          ? 'SELECT service FROM "app-logs"'
          : {
              x: { fields: [{ name: 'service' }], groupBy: [] },
              y: { fields: [{ name: '*', aggregate: 'COUNT' }], groupBy: [], limit: 100 },
              filters: [],
            },
    };
    const server = await serve(page, [original]);
    const editor = await edit(page, 'Legacy');
    await expect(editor.getByLabel('Query language')).toHaveValue('builder');
    if (legacy === 'SQL')
      await expect(editor.getByText(/original definition is preserved/)).toBeVisible();
    else await expect(editor.getByLabel('Dimension 1')).toHaveValue('service');
    await editor.getByLabel('Tile title').fill('Legacy renamed');
    await editor.getByRole('button', { name: 'Apply tile', exact: true }).click();
    await save(page);
    expect(server.writes.at(-1)!.tiles![0].chartQuery).toEqual(original.chartQuery);
    await page.reload();
    await expect(
      page.getByRole('region', { name: 'Tile Legacy renamed', exact: true }),
    ).toBeVisible();
  });
}

test('legacy sort and unlimited queries are accurately displayed and can be cleared', async ({
  page,
}) => {
  const original = {
    ...tile('Legacy sort'),
    tileType: 'builder',
    chartQuery: {
      x: { fields: [], sortBy: { field: 'COUNT_STAR', direction: 'DESC' }, future: true },
      y: { fields: [{ name: '*', aggregate: 'COUNT' }] },
      filters: [],
    },
  };
  const server = await serve(page, [original]);
  const editor = await edit(page, 'Legacy sort');
  await expect(editor.getByLabel('Row limit', { exact: true })).toHaveValue('');
  await expect(editor.getByLabel('Order by', { exact: true })).toHaveValue('COUNT_STAR');
  await editor.getByLabel('Order by', { exact: true }).selectOption('');
  await editor.getByLabel('Row limit', { exact: true }).fill('30');
  await editor.getByLabel('Row limit', { exact: true }).fill('');
  await editor.getByRole('button', { name: 'Apply tile', exact: true }).click();
  await save(page);
  const query = server.writes.at(-1)!.tiles![0].chartQuery as typeof original.chartQuery;
  expect(query.x).toEqual({ fields: [], future: true });
  expect(query.y).toEqual(original.chartQuery.y);
});

test('title edits preserve malformed stored builders without silently repairing queries', async ({
  page,
}) => {
  const original = {
    ...tile('Malformed'),
    tileType: 'builder',
    chartQuery: {
      x: { fields: [], sortBy: { field: 'COUNT_STAR', direction: 'sideways' } },
      y: { fields: [{ name: '*', aggregate: 'COUNT' }] },
      filters: [],
    },
  };
  const server = await serve(page, [original]);
  const editor = await edit(page, 'Malformed');
  await editor.getByLabel('Tile title').fill('Retained malformed');
  await editor.getByRole('button', { name: 'Apply tile', exact: true }).click();
  await save(page);
  expect(server.writes.at(-1)!.tiles![0].chartQuery).toEqual(original.chartQuery);
});
