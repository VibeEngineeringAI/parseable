import { expect, test, type Page } from '@playwright/test';
async function open(page: Page, story = 'default') {
  await page.goto(`/iframe.html?id=sql-workspace--${story}&viewMode=story`);
  await expect(page.getByRole('tab', { name: 'Query 1', exact: true })).toBeVisible();
}
async function edit(page: Page, sql: string) {
  const editor = page.locator('.cm-content');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText(sql);
}
test('overlapping execution remains attached to its tab after switching', async ({ page }) => {
  await open(page);
  await edit(page, 'SELECT service, requests FROM "application_logs" -- slow');
  await page.getByRole('button', { name: 'Run query', exact: true }).click();
  await page.getByRole('button', { name: 'New query tab' }).click();
  await edit(page, 'SELECT service, requests FROM "audit_logs"');
  await page.getByRole('button', { name: 'Run query', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'api', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Query 1', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'slow-result', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Query 2', exact: true }).click();
  await expect(page.locator('.cm-content')).toContainText('audit_logs');
  await expect(page.getByRole('cell', { name: 'api', exact: true })).toBeVisible();
});
test('failed transport reports an error with editable SQL and can retry', async ({ page }) => {
  await open(page, 'failed-query');
  await page.getByRole('button', { name: 'Run query', exact: true }).click();
  await expect(page.getByText('Fixture query failed: invalid SQL', { exact: false })).toBeVisible();
  await expect(page.locator('.cm-content')).toContainText('application_logs');
  await expect(page.getByRole('button', { name: 'Run query', exact: true })).toBeEnabled();
});
test('opening a library query focuses its existing tab and sidebar supports keyboard resizing', async ({
  page,
}) => {
  await open(page);
  await page.getByLabel('Saved query name', { exact: true }).fill('Requests library');
  await page.getByRole('button', { name: 'Save as new', exact: true }).click();
  await page.getByRole('button', { name: 'New query tab' }).click();
  await edit(page, 'SELECT 99');
  await page.getByLabel('Search saved queries').fill('Requests library');
  await page.getByRole('button', { name: 'Requests library', exact: true }).click();
  await expect(
    page.getByRole('tab', { name: 'Requests library', exact: true, selected: true }),
  ).toBeVisible();
  await expect(page.getByRole('tablist', { name: 'Query tabs' }).getByRole('tab')).toHaveCount(2);
  await expect(page.getByRole('tab', { name: 'Requests library', exact: true })).toHaveCount(1);
  await expect(page.locator('.cm-content')).toContainText('application_logs');
  await page.getByRole('tab', { name: 'Query 1', exact: true }).click();
  await expect(page.locator('.cm-content')).toContainText('SELECT 99');
  const resize = page.getByRole('separator', { name: 'Resize SQL sidebar' });
  const before = await resize.getAttribute('aria-valuenow');
  await resize.focus();
  await page.keyboard.press('ArrowRight');
  await expect(resize).not.toHaveAttribute('aria-valuenow', before!);
});
test('chart configuration saves the executed SQL as a dashboard tile', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Run query', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'api', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Chart', exact: true }).click();
  await page.getByLabel('Chart type', { exact: true }).selectOption('table');
  await page.getByLabel('Chart title', { exact: true }).fill('Service requests');
  await page.getByRole('button', { name: 'Add to Dashboard', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add to Dashboard' });
  await dialog.getByLabel('Dashboard title', { exact: true }).fill('SQL dashboard');
  await dialog.getByLabel('Dataset', { exact: true }).selectOption('application_logs');
  await dialog.getByRole('button', { name: 'Add chart', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Chart added to' })).toBeVisible();
  await page.getByText('Saved dashboard document', { exact: true }).click();
  const document = JSON.parse((await page.getByTestId('saved-sql-dashboard').textContent())!);
  expect(document.title).toBe('SQL dashboard');
  expect(document.tiles[0]).toMatchObject({
    title: 'Service requests',
    tileType: 'code',
    chartType: 'table',
    chartQuery: 'SELECT service, requests FROM "application_logs"',
    dbName: ['application_logs'],
  });
});
