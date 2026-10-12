import { expect, test, type Page } from '@playwright/test';

async function open(page: Page, story: string) {
  await page.goto(`/iframe.html?id=dashboards-tile-editor--${story}&viewMode=story`);
  await expect(page.getByRole('dialog', { name: 'Edit tile' })).toBeVisible();
  await expect(page.getByLabel('Dataset', { exact: true })).toHaveValue('application_logs');
}
async function apply(page: Page) {
  await page.getByRole('button', { name: 'Apply tile', exact: true }).click();
  await expect(page.getByTestId('applied-tile')).toBeVisible();
  return JSON.parse((await page.getByTestId('applied-tile').textContent())!);
}

test('visual authoring projects fields, executes generated SQL and emits the builder definition', async ({
  page,
}) => {
  await open(page, 'visual-authoring');
  await page.getByRole('button', { name: 'Add group', exact: true }).click();
  await page.getByLabel('Group by field 1', { exact: true }).selectOption('service');
  await page.getByRole('button', { name: 'Add group', exact: true }).click();
  await page.getByLabel('Group by field 2', { exact: true }).selectOption('host');
  await page.getByRole('button', { name: 'Add filter', exact: true }).click();
  await page.getByLabel('Filter field 1', { exact: true }).selectOption('message');
  await page.getByLabel('Filter value 1', { exact: true }).fill("it's an error");
  await page.getByLabel('Order by', { exact: true }).selectOption('COUNT_STAR');
  await expect(
    page.getByLabel('Order by', { exact: true }).locator('option[value="duration"]'),
  ).toHaveCount(0);
  await page.getByLabel('Section', { exact: true }).selectOption('overview');
  await page.getByText('Generated SQL', { exact: true }).click();
  await expect(page.locator('details pre')).toContainText("'it''s an error'");
  await page.getByRole('button', { name: 'Run query', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Preview', exact: true })).toBeVisible();
  const result = await apply(page);
  expect(result.tileType).toBe('builder');
  expect(result.sectionId).toBe('overview');
  expect(result.chartQuery.y.groupBy).toEqual(['service', 'host']);
  expect(result.chartQuery.filters[0].value).toBe("it's an error");
  expect(result.extensionMetadata).toEqual({ owner: 'Observability', version: 7 });
  await expect(page.getByTestId('executed-queries')).toContainText('COUNT_STAR');
});

test('stored SQL and its opaque metadata survive appearance and title edits', async ({ page }) => {
  await open(page, 'stored-sql-preserved');
  await expect(page.getByText(/original definition is preserved/)).toBeVisible();
  await page.getByLabel('Tile title', { exact: true }).fill('Renamed requests');
  const result = await apply(page);
  expect(result.title).toBe('Renamed requests');
  expect(result.chartQuery).toEqual({
    sql: 'SELECT COUNT(*) AS requests FROM "application_logs"',
    customMetadata: { keep: true },
  });
  expect(result.tileType).toBe('builder');
});

test('legacy missing tileType remains a visual builder and preserves the missing property', async ({
  page,
}) => {
  await open(page, 'legacy-missing-type');
  await expect(page.getByLabel('Query language', { exact: true })).toHaveValue('builder');
  await expect(page.getByLabel('Dimension 1', { exact: true })).toHaveValue('p_timestamp');
  await page.getByLabel('Tile title', { exact: true }).fill('Legacy preserved');
  const result = await apply(page);
  expect(result).not.toHaveProperty('tileType');
  expect(result.chartQuery.x.fields).toEqual([{ name: 'p_timestamp' }]);
});

test('typed filters retain native values, limits recover and clearing sort removes the legacy fallback', async ({
  page,
}) => {
  await open(page, 'typed-filters-and-limits');
  const confirm = page.getByRole('button', { name: 'Apply tile', exact: true });
  await expect(page.getByLabel('Filter value type 1', { exact: true })).toHaveValue('number');
  await expect(page.getByLabel('Filter value type 2', { exact: true })).toHaveValue('boolean');
  await page.getByLabel('Filter value 1', { exact: true }).fill('invalid');
  await expect(confirm).toBeDisabled();
  await expect(
    page.getByText('Enter a finite number for the filter value.', { exact: true }),
  ).toBeVisible();
  await page.getByLabel('Filter value 1', { exact: true }).fill('2.5');
  await page.getByLabel('Filter value 2', { exact: true }).selectOption('false');
  await page.getByLabel('Row limit', { exact: true }).fill('1.5');
  await expect(confirm).toBeDisabled();
  await expect(
    page.getByText('Enter a whole row limit of at least 1.', { exact: true }),
  ).toBeVisible();
  await page.getByLabel('Row limit', { exact: true }).fill('25');
  await expect(confirm).toBeEnabled();
  await page.getByLabel('Row limit', { exact: true }).fill('');
  await expect(confirm).toBeEnabled();
  await page.getByLabel('Order by', { exact: true }).selectOption('');
  await page.getByText('Generated SQL', { exact: true }).click();
  await expect(page.locator('details pre')).toContainText('"duration" >= 2.5');
  await expect(page.locator('details pre')).toContainText('"success" = false');
  await expect(page.locator('details pre')).not.toContainText('ORDER BY');
  await expect(page.locator('details pre')).not.toContainText('LIMIT');
  const result = await apply(page);
  expect(result.chartQuery.filters.map((filter: { value: unknown }) => filter.value)).toEqual([
    2.5,
    false,
  ]);
  expect(result.chartQuery.y).not.toHaveProperty('limit');
  expect(result.chartQuery.x).not.toHaveProperty('sortBy');
  expect(result.chartQuery.y).not.toHaveProperty('sortBy');
});

test('switching chart type recomputes SQL without editing the query fields', async ({ page }) => {
  await open(page, 'visual-authoring');
  await page.getByText('Generated SQL', { exact: true }).click();
  await expect(page.locator('details pre')).toContainText('DATE_TRUNC');
  await page.getByLabel('Chart type', { exact: true }).selectOption('query-value');
  await expect(page.locator('details pre')).not.toContainText('DATE_TRUNC');
  await expect(page.locator('details pre')).not.toContainText('ORDER BY');
  await page.getByLabel('Chart type', { exact: true }).selectOption('timeseries');
  await expect(page.locator('details pre')).toContainText('DATE_TRUNC');
  await expect(page.locator('details pre')).toContainText('ORDER BY');
});

test('unrecognized query definition is preserved on unchanged Apply', async ({ page }) => {
  await open(page, 'opaque-query-preserved');
  const result = await apply(page);
  expect(result.chartQuery).toEqual({
    vendorDefinition: { opaque: true },
    filters: 'custom expression',
  });
});
