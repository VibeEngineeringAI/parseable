import { test, expect, type Locator, type Page } from '@playwright/test';
async function open(page: Page, story = 'editable') {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/iframe.html?id=dashboards-editing--${story}&viewMode=story`);
  await expect(
    page.getByRole('heading', { name: 'Editing playground', exact: true }),
  ).toBeVisible();
  if (story !== 'read-only')
    await expect(
      page.getByRole('button', { name: 'Move tile Requests', exact: true }),
    ).toBeVisible();
}
async function save(page: Page) {
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Dashboard saved.', { exact: true })).toBeVisible();
  return JSON.parse(
    (await page.getByLabel('Saved dashboard document', { exact: true }).textContent()) ?? 'null',
  );
}
async function action(page: Page, title: string, name: string) {
  await page.getByRole('button', { name: `Section actions for ${title}`, exact: true }).click();
  await page.getByRole('menuitem', { name, exact: true }).click();
}
/** Presses a handle and returns a mover, so a test can assert mid-gesture. */
async function press(page: Page, name: string) {
  const handle = page.getByRole('button', { name, exact: true });
  await handle.scrollIntoViewIfNeeded();
  const box = (await handle.boundingBox())!;
  const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
  await page.mouse.move(x, y);
  await page.mouse.down();
  return (dx: number, dy = 0) => page.mouse.move(x + dx, y + dy, { steps: 6 });
}
async function drag(page: Page, name: string, dx: number, cancel = false) {
  await (
    await press(page, name)
  )(dx);
  if (cancel) await page.keyboard.press('Escape');
  await page.mouse.up();
}
const cellFor = (page: Page, title: string) =>
  page.getByRole('region', { name: `Tile ${title}`, exact: true }).locator('..');
/** One grid row in CSS pixels, read from the properties the component measures. */
const rowHeight = (grid: Locator) =>
  grid.evaluate((el) => {
    const style = getComputedStyle(el);
    return (parseFloat(style.gridAutoRows) || 70) + (parseFloat(style.rowGap) || 0);
  });

test('production editing story persists drag, resize and keyboard edits while Escape and Discard cancel', async ({
  page,
}) => {
  await open(page);
  const cell = page.getByRole('region', { name: 'Tile Requests', exact: true }).locator('..');
  const column = await page
    .locator('.dashboard-layout-grid')
    .filter({ has: page.getByRole('button', { name: 'Move tile Requests', exact: true }) })
    .evaluate(
      (el) => (el.getBoundingClientRect().width + parseFloat(getComputedStyle(el).columnGap)) / 12,
    );
  await drag(page, 'Move tile Requests', column);
  await expect(cell).toHaveCSS('grid-column-start', '2');
  await drag(page, 'Resize tile Requests', column);
  await page.getByRole('button', { name: 'Resize tile Requests', exact: true }).press('ArrowDown');
  const document = await save(page);
  expect(document.tiles[0].layout).toMatchObject({ x: 1, w: 5, h: 4 });
  await page.getByRole('button', { name: 'Reload saved dashboard' }).click();
  await expect(cell).toHaveCSS('grid-column-start', '2');
  await drag(page, 'Move tile Requests', column, true);
  await expect(cell).toHaveCSS('grid-column-start', '2');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Move tile Requests', exact: true }).press('ArrowDown');
  await expect(page.locator('.dashboard-layout-cell').first()).toContainText('Latency');
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(page.locator('.dashboard-layout-cell').first()).toContainText('Requests');
});

test('production sections story creates, renames, reorders and deletes containers while retaining their tiles', async ({
  page,
}) => {
  await open(page);
  await page.getByRole('button', { name: 'Add section', exact: true }).click();
  const add = page.getByRole('dialog', { name: 'Add section', exact: true });
  await add.getByLabel('Section title').fill('Errors');
  await add.getByRole('button', { name: 'Add section', exact: true }).click();
  await action(page, 'Overview', 'Rename section');
  const rename = page.getByRole('dialog', { name: 'Rename section', exact: true });
  await rename.getByLabel('Section title').fill('Summary');
  await rename.getByRole('button', { name: 'Rename section', exact: true }).click();
  await action(page, 'Logs', 'Move section earlier');
  let document = await save(page);
  expect(document.sections.map((section: any) => section.title)).toEqual([
    'Logs',
    'Summary',
    'Errors',
  ]);
  await page.getByRole('button', { name: 'Summary', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Reload saved dashboard' }).click();
  await expect(page.getByRole('button', { name: 'Summary', exact: true })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await action(page, 'Summary', 'Collapse by default');
  document = await save(page);
  expect(document.sections.find((section: any) => section.title === 'Summary').collapsed).toBe(
    true,
  );
  await page.getByRole('button', { name: 'Reload saved dashboard' }).click();
  await expect(page.getByRole('button', { name: 'Summary', exact: true })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  await expect(page.getByRole('region', { name: 'Tile Requests', exact: true })).toHaveCount(0);
  await action(page, 'Summary', 'Delete section');
  await page
    .getByRole('dialog', { name: 'Delete section?' })
    .getByRole('button', { name: 'Delete section', exact: true })
    .click();
  await expect(page.getByRole('region', { name: 'Dashboard tiles', exact: true })).toContainText(
    'Requests',
  );
  document = await save(page);
  expect(document.tiles).toHaveLength(2);
  expect(document.tiles.every((tile: any) => tile.sectionId === '')).toBe(true);
  await page.getByRole('button', { name: 'Reload saved dashboard' }).click();
  await expect(page.getByRole('region', { name: 'Tile Requests', exact: true })).toBeVisible();
});

test('read-only production story permits transient collapse and hides editing controls', async ({
  page,
}) => {
  await open(page, 'read-only');
  await expect(
    page.getByText('This dashboard is read-only. Only its owner can edit it.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /^(Move|Resize) tile/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add section', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Tile Requests', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Reload saved dashboard' }).click();
  await expect(page.getByRole('region', { name: 'Tile Requests', exact: true })).toBeVisible();
});

test('stacked tiles keep a vertical drag alive while it crosses a sibling', async ({ page }) => {
  await open(page, 'stacked-tiles');
  const grid = page
    .locator('.dashboard-layout-grid')
    .filter({ has: page.getByRole('button', { name: 'Move tile Requests', exact: true }) });
  const cells = grid.locator('.dashboard-layout-cell');
  await expect(cells.first()).toContainText('Requests');
  // Three rows down puts Requests below Latency, which swaps their reading order.
  await (
    await press(page, 'Move tile Requests')
  )(0, (await rowHeight(grid)) * 3);
  await expect(cellFor(page, 'Requests')).toHaveCSS('grid-row-start', '4');
  await page.mouse.up();
  await expect(cellFor(page, 'Requests')).toHaveCSS('grid-row-start', '4');
  await expect(cells.first()).toContainText('Latency');
  await expect(cells.getByRole('heading', { level: 2 })).toHaveText(['Latency', 'Requests']);
  const document = await save(page);
  expect(document.tiles.find((tile: any) => tile.title === 'Requests').layout).toMatchObject({
    y: 3,
  });
  expect(document.tiles.find((tile: any) => tile.title === 'Latency').layout).toMatchObject({
    y: 0,
  });
});

test('Escape during a reordering drag restores the stacked order and leaves nothing to save', async ({
  page,
}) => {
  await open(page, 'stacked-tiles');
  const grid = page
    .locator('.dashboard-layout-grid')
    .filter({ has: page.getByRole('button', { name: 'Move tile Requests', exact: true }) });
  await (
    await press(page, 'Move tile Requests')
  )(0, (await rowHeight(grid)) * 3);
  await page.keyboard.press('Escape');
  await expect(cellFor(page, 'Requests')).toHaveCSS('grid-row-start', '1');
  await page.mouse.up();
  await expect(grid.locator('.dashboard-layout-cell').first()).toContainText('Requests');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
});
