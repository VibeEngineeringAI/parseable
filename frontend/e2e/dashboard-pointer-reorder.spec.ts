import { test, expect, type Locator, type Page } from '@playwright/test';
import classic from '../src/features/dashboards/__fixtures__/classic.json' with { type: 'json' };
import type { Dashboard } from '../src/lib/types';

/** Two tiles stacked in the same column: dragging either one past the other changes
 * reading order, which is the case that reorders the grid during a live gesture. */
const tile = (title: string, y: number) => ({
  tile_id: title === 'Second' ? '01JZ8Y4A0C7H3GQ5P2W9D8S002' : '01JZ8Y4A0C7H3GQ5P2W9D8S001',
  title,
  tileType: 'code',
  chartType: 'table',
  chartQuery: 'SELECT service FROM "app-logs"',
  dbName: ['app-logs'],
  layout: { x: 0, y, w: 4, h: 3 },
  config: { type: 'table' },
});
async function serve(page: Page, tiles: unknown[] = [tile('First', 0), tile('Second', 3)]) {
  const writes: Dashboard[] = [];
  let current = {
    ...structuredClone(classic),
    author: classic.author,
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
    if (path === '/api/v1/query')
      return route.fulfill({ json: [{ service: 'api', requests: 12 }] });
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
  return { writes };
}
async function save(page: Page) {
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Dashboard saved.', { exact: true })).toBeVisible();
}
const cellFor = (page: Page, title: string) =>
  page.getByRole('region', { name: `Tile ${title}`, exact: true }).locator('..');
/** One grid row in CSS pixels, read from the same properties the component measures. */
const rowHeight = (grid: Locator) =>
  grid.evaluate((el) => {
    const style = getComputedStyle(el);
    return (parseFloat(style.gridAutoRows) || 70) + (parseFloat(style.rowGap) || 0);
  });
/** Presses a handle and returns a mover that drags it by whole grid rows. */
async function press(page: Page, label: string) {
  const handle = page.getByRole('button', { name: label, exact: true });
  await handle.scrollIntoViewIfNeeded();
  const box = (await handle.boundingBox())!;
  const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
  await page.mouse.move(x, y);
  await page.mouse.down();
  return (dy: number) => page.mouse.move(x, y + dy, { steps: 6 });
}

test('a vertical drag past a sibling keeps its gesture when the grid reorders mid-drag', async ({
  page,
}) => {
  const server = await serve(page);
  const grid = page.locator('.dashboard-layout-grid').first();
  const row = await rowHeight(grid);
  await expect(page.locator('.dashboard-layout-cell').first()).toContainText('First');
  // Three rows down puts First below Second, so compaction swaps their reading order.
  const move = await press(page, 'Move tile First');
  await move(row * 3);
  // The preview must still be live after the reorder: First has moved off the top row.
  await expect(cellFor(page, 'First')).toHaveCSS('grid-row-start', '4');
  await page.mouse.up();
  await expect(cellFor(page, 'First')).toHaveCSS('grid-row-start', '4');
  await expect(page.locator('.dashboard-layout-cell').first()).toContainText('Second');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  await save(page);
  expect(server.writes.at(-1)!.tiles!.find((t) => t.title === 'First')!.layout).toMatchObject({
    y: 3,
  });
  expect(server.writes.at(-1)!.tiles!.find((t) => t.title === 'Second')!.layout).toMatchObject({
    y: 0,
  });
});

test('Escape during a reordering drag restores the original order and leaves no edit', async ({
  page,
}) => {
  const server = await serve(page);
  const grid = page.locator('.dashboard-layout-grid').first();
  const row = await rowHeight(grid);
  const move = await press(page, 'Move tile Second');
  await move(-row * 3);
  await expect(cellFor(page, 'Second')).toHaveCSS('grid-row-start', '1');
  await page.keyboard.press('Escape');
  await expect(cellFor(page, 'Second')).toHaveCSS('grid-row-start', '4');
  await page.mouse.up();
  await expect(page.locator('.dashboard-layout-cell').first()).toContainText('First');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  expect(server.writes).toEqual([]);
});

test('a committed drag leaves reading order matching the visible layout', async ({ page }) => {
  const server = await serve(page);
  const grid = page.locator('.dashboard-layout-grid').first();
  const row = await rowHeight(grid);
  const move = await press(page, 'Move tile First');
  await move(row * 3);
  await page.mouse.up();
  const cells = page.locator('.dashboard-layout-cell');
  await expect(cells.first()).toContainText('Second');
  await expect(
    grid.locator('.dashboard-layout-cell').getByRole('heading', { level: 2 }),
  ).toHaveText(['Second', 'First']);
  // Arrow keys address the committed order, so Up on First is the exact inverse of
  // the drag and returns the draft to the saved document.
  await page.getByRole('button', { name: 'Move tile First', exact: true }).press('ArrowUp');
  await expect(cells.first()).toContainText('First');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  expect(server.writes).toEqual([]);
});
