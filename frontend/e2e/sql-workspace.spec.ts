import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

async function demo(page: Page) {
  await page.addInitScript(() => sessionStorage.setItem('parseable-mode', 'demo'));
  await page.goto('/sql-editor');
}

test('query tabs retain independent SQL, output and wrapping and support renaming and closing', async ({
  page,
}) => {
  await demo(page);
  const editor = page.getByRole('textbox', { name: 'SQL query' });
  await editor.fill('SELECT * FROM "application_logs" LIMIT 3');
  await editor.press('Control+Enter');
  await expect(page.getByRole('table').locator('tbody tr')).toHaveCount(3);
  await page.getByRole('button', { name: 'Toggle row wrapping' }).click();
  await page.getByRole('button', { name: 'New query tab' }).click();
  await expect(editor).toHaveText('');
  await expect(page.getByRole('heading', { name: 'Ready when you are' })).toBeVisible();
  await editor.fill('SELECT * FROM "api_logs" LIMIT 2');
  await page.getByRole('button', { name: 'Run query' }).click();
  await expect(page.getByRole('table').locator('tbody tr')).toHaveCount(2);
  await page.getByRole('tab', { name: 'Query 1', exact: true }).click();
  await expect(editor).toContainText('application_logs');
  await expect(page.getByRole('table').locator('tbody tr')).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'Toggle row wrapping' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: 'Rename Query 1' }).click();
  await page.getByRole('textbox', { name: 'Query tab name' }).fill('Application sample');
  await page.getByRole('textbox', { name: 'Query tab name' }).press('Enter');
  await expect(page.getByRole('tab', { name: 'Application sample', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.getByRole('button', { name: 'Close Application sample' }).click();
  await expect(editor).toContainText('api_logs');
  await expect(page.getByRole('table').locator('tbody tr')).toHaveCount(2);
  await page.getByRole('button', { name: 'Close Query 2' }).click();
  await expect(page.getByRole('tablist', { name: 'Query tabs' }).getByRole('tab')).toHaveCount(1);
});

test('resizing panels works with keyboard and pointer without changing the query', async ({
  page,
}) => {
  await demo(page);
  const sidebar = page.getByRole('separator', { name: 'Resize SQL sidebar' });
  const editor = page.getByRole('separator', { name: 'Resize SQL editor' });
  const initial = Number(await sidebar.getAttribute('aria-valuenow'));
  await sidebar.focus();
  await sidebar.press('ArrowRight');
  await expect(sidebar).toHaveAttribute('aria-valuenow', String(initial + 20));
  await editor.focus();
  await editor.press('Home');
  await expect(editor).toHaveAttribute('aria-valuenow', '180');
  const box = await editor.boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2 + 80);
  await page.mouse.up();
  await expect(editor).toHaveAttribute('aria-valuenow', '260');
  await expect(page.getByRole('textbox', { name: 'SQL query' })).toContainText('application_logs');
});

test('dataset selection creates a multi-dataset query without replacing the draft', async ({
  page,
}) => {
  await demo(page);
  const editor = page.getByRole('textbox', { name: 'SQL query' });
  await editor.fill('SELECT * FROM "application_logs" LIMIT 7');
  await page.getByRole('checkbox', { name: 'Select application_logs', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Select api_logs', exact: true }).check();
  await expect(editor).toContainText('LIMIT 7');
  await page.getByRole('button', { name: 'New query from selection' }).click();
  await expect(editor).toContainText('UNION ALL');
  await expect(editor).toContainText('FROM "api_logs"');
  await page.getByRole('tab', { name: 'Query 1', exact: true }).click();
  await expect(editor).toContainText('LIMIT 7');
});

test('saved queries can be searched, reopened, updated and deleted after a reload', async ({
  page,
}) => {
  await demo(page);
  const sidebar = page.getByRole('complementary', { name: 'SQL datasets and saved queries' });
  const editor = page.getByRole('textbox', { name: 'SQL query' });
  await editor.fill('SELECT * FROM "application_logs" LIMIT 7');
  await sidebar.getByRole('textbox', { name: 'Saved query name' }).fill('Application errors');
  await sidebar.getByRole('button', { name: 'Save as new' }).click();
  await page.reload();
  await sidebar.getByRole('textbox', { name: 'Search saved queries' }).fill('Application errors');
  await sidebar.getByRole('button', { name: 'Application errors', exact: true }).click();
  await expect(editor).toContainText('LIMIT 7');
  await editor.fill('SELECT * FROM "application_logs" LIMIT 9');
  await sidebar.getByRole('button', { name: 'Update saved' }).click();
  await page.reload();
  await sidebar.getByRole('button', { name: 'Application errors', exact: true }).click();
  await expect(editor).toContainText('LIMIT 9');
  await sidebar.getByRole('button', { name: 'Delete saved query Application errors' }).click();
  await expect(
    sidebar.getByRole('button', { name: 'Application errors', exact: true }),
  ).toHaveCount(0);
});

test('SQL workspace stays contained on a narrow screen and passes accessibility checks', async ({
  page,
}) => {
  await demo(page);
  await expect(page.getByRole('textbox', { name: 'SQL query' })).toBeVisible();
  expect((await new AxeBuilder({ page }).include('.sql-workspace').analyze()).violations).toEqual(
    [],
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'New query tab' }).click();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
  await expect(page.getByRole('textbox', { name: 'SQL query' })).toBeVisible();
});
