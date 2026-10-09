import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

async function demo(page: Page, path = '/logs') {
  await page.addInitScript(() => sessionStorage.setItem('parseable-mode', 'demo'));
  await page.goto(path);
}

test('filter editing and clearing keeps the operator and value in the query', async ({ page }) => {
  await demo(page);
  await page.getByTestId('add-filter-button').click();
  let dialog = page.getByRole('dialog', { name: 'Add filter' });
  await dialog.getByLabel('Field', { exact: true }).selectOption('level');
  await dialog.getByLabel('Value', { exact: true }).fill('ERROR');
  await dialog.getByRole('button', { name: 'Apply filter' }).click();
  await expect(page.getByRole('table').locator('tbody tr')).toHaveCount(8);
  await page.getByRole('button', { name: 'Edit filter level' }).click();
  dialog = page.getByRole('dialog', { name: 'Edit filter' });
  await dialog.getByLabel('Operator', { exact: true }).selectOption('!=');
  await dialog.getByRole('button', { name: 'Apply filter' }).click();
  await expect(page.getByRole('button', { name: 'Remove filter level != ERROR' })).toBeVisible();
  await expect(page.getByRole('table').locator('tbody')).not.toContainText('ERROR');
  await page.getByRole('button', { name: 'Clear all', exact: true }).click();
  await expect(page.getByTestId('filter-pill-value')).toHaveCount(0);
  await expect(page.getByText('Page 1 of 4', { exact: true })).toBeVisible();
});

test('column picker, sorting and row wrapping retain keyboard accessible results', async ({
  page,
}) => {
  await demo(page);
  await page.getByRole('button', { name: 'Add columns', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add columns' });
  await dialog.getByLabel('Search columns').fill('host');
  await dialog.getByRole('checkbox', { name: 'host', exact: true }).check();
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('columnheader', { name: 'host', exact: true })).toBeVisible();
  const sort = page.getByRole('button', { name: 'Sort host', exact: true });
  await sort.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('columnheader', { name: 'host', exact: true })).toHaveAttribute(
    'aria-sort',
    'ascending',
  );
  await sort.click();
  await expect(page.getByRole('columnheader', { name: 'host', exact: true })).toHaveAttribute(
    'aria-sort',
    'descending',
  );
  const wrap = page.getByRole('button', { name: 'Toggle row wrapping' });
  await wrap.click();
  await expect(wrap).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('table').locator('tbody td').last()).toHaveCSS(
    'white-space',
    'pre-wrap',
  );
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV', exact: true }).click();
  expect((await download).suggestedFilename()).toBe('query-results.csv');
});

test('absolute range validates before applying and cancel preserves selection', async ({
  page,
}) => {
  await demo(page);
  await page.getByRole('button', { name: 'Choose absolute time range' }).click();
  const dialog = page.getByRole('dialog', { name: 'Time range' });
  await dialog.getByLabel('From', { exact: true }).fill('2026-10-06T12:00');
  await dialog.getByLabel('To', { exact: true }).fill('2026-10-06T11:00');
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText('From must be before To.');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Time range', exact: true })).toHaveValue('1h');
  await page.getByRole('button', { name: 'Choose absolute time range' }).click();
  await dialog.getByLabel('From', { exact: true }).fill('2020-01-01T00:00');
  await dialog.getByLabel('To', { exact: true }).fill('2020-01-02T00:00');
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'No matching events' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Time range', exact: true })).toHaveValue(
    'custom',
  );
});

test('event field search, JSON view, and exclusion compose without losing modal focus', async ({
  page,
}) => {
  await demo(page);
  await page.getByRole('button', { name: 'Open event 1', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Event details' });
  await dialog.getByLabel('Search event fields').fill('level');
  await expect(dialog.getByRole('button', { name: 'Exclude level from filter' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Include host in filter' })).toHaveCount(0);
  await dialog.getByRole('tab', { name: 'JSON', exact: true }).click();
  await expect(dialog.getByRole('tabpanel')).toContainText('p_timestamp');
  await dialog.getByRole('tab', { name: 'Fields', exact: true }).click();
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(axe.violations).toEqual([]);
  await dialog.getByRole('button', { name: 'Exclude level from filter' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Remove filter level != ERROR' })).toBeVisible();
});

test('SQL dataset selection quotes the chosen dataset and runs its query', async ({ page }) => {
  await demo(page, '/sql-editor');
  const sidebar = page.getByRole('complementary', { name: 'SQL datasets' });
  await sidebar.getByLabel('Search SQL datasets').fill('api_logs');
  await sidebar.getByRole('button', { name: 'api_logs', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'SQL query' })).toContainText('FROM "api_logs"');
  await page.getByRole('button', { name: 'Run query' }).click();
  await expect(page.getByRole('table')).toBeVisible();
  await page.getByRole('button', { name: 'Toggle row wrapping' }).click();
  await expect(page.getByRole('button', { name: 'Toggle row wrapping' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});
