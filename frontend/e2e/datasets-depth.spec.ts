import { test, expect, type Page } from '@playwright/test';
async function demo(page: Page) {
  await page.addInitScript(() => sessionStorage.setItem('parseable-mode', 'demo'));
  await page.goto('/datasets');
}

test('static creation validates primitive schema and preserves typed fields and metadata', async ({
  page,
}) => {
  await demo(page);
  await page.getByRole('button', { name: 'Create dataset', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Create dataset', exact: true });
  await dialog.getByLabel('Dataset name', { exact: true }).fill('typed_logs');
  await dialog.getByText('Advanced', { exact: true }).click();
  await dialog.getByLabel('Static schema', { exact: true }).check();
  await dialog.getByLabel('apm', { exact: true }).check();
  await dialog.getByLabel('Labels', { exact: true }).fill('production, checkout');
  const editor = dialog.getByLabel('Creation schema JSON', { exact: true }),
    submit = dialog.locator('[data-dialog-confirm]');
  await editor.fill('{"fields":[{"name":"x","data_type":"struct"}]}');
  await expect(submit).toBeDisabled();
  await expect(dialog).toContainText('Unsupported type');
  await editor.fill(
    '{"fields":[{"name":"service","data_type":"string"},{"name":"value","data_type":"int"}]}',
  );
  await dialog.getByLabel('Custom partition', { exact: true }).fill('missing');
  await expect(submit).toBeDisabled();
  await dialog.getByLabel('Custom partition', { exact: true }).fill('service');
  await submit.click();
  await expect(dialog).toHaveCount(0);
  await page.getByLabel('Search datasets', { exact: true }).fill('checkout');
  await expect(page.getByRole('button', { name: 'Manage typed_logs', exact: true })).toBeVisible();
  await page.getByLabel('Dataset type', { exact: true }).selectOption('metrics');
  await expect(page.getByRole('button', { name: 'Manage typed_logs', exact: true })).toHaveCount(0);
  await page.getByLabel('Dataset type', { exact: true }).selectOption('logs');
  await page.getByRole('button', { name: 'Manage typed_logs', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'typed_logs', exact: true });
  await expect(sheet.getByRole('region', { name: 'Overview', exact: true })).toContainText(
    'production, checkout',
  );
  await expect(sheet.locator('[data-field-node="value"]')).toContainText('Int64');
  await expect(sheet.locator('[data-field-node="value"]')).toContainText('Nullable');
  const partitions = sheet.getByRole('region', { name: 'Partitions', exact: true });
  await partitions.getByLabel('Custom partition field', { exact: true }).fill('missing');
  await expect(
    partitions.getByRole('button', { name: 'Save custom partition', exact: true }),
  ).toBeDisabled();
  await partitions.getByLabel('Custom partition field', { exact: true }).fill('value');
  await partitions.getByRole('button', { name: 'Save custom partition', exact: true }).click();
  await expect(partitions.locator('p[role=status]')).toHaveText('Custom partition saved.');
  await partitions.getByRole('button', { name: 'Remove custom partition', exact: true }).click();
  await expect(partitions.getByLabel('Custom partition field', { exact: true })).toHaveValue('');
  await expect(
    partitions.getByRole('button', { name: 'Save time partition limit', exact: true }),
  ).toBeDisabled();
});

test('metrics inference is offered only for metrics and read-back preserves the choice', async ({
  page,
}) => {
  await demo(page);
  await page.getByRole('button', { name: 'Create dataset', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Create dataset', exact: true });
  await expect(dialog.getByLabel('Infer metrics timestamps')).toHaveCount(0);
  await dialog.getByLabel('Telemetry type', { exact: true }).selectOption('metrics');
  await expect(dialog.getByLabel('Infer metrics timestamps')).toBeChecked();
  await dialog.getByLabel('Infer metrics timestamps').uncheck();
  await dialog.getByLabel('Dataset name', { exact: true }).fill('test_metrics');
  await dialog.locator('[data-dialog-confirm]').click();
  await page.getByRole('button', { name: 'Manage test_metrics', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Overview', exact: true })).toContainText(
    'Disabled',
  );
});

test('partition mutations use independent payloads; dependency errors do not claim no alerts', async ({
  page,
}) => {
  await page.addInitScript(() => sessionStorage.setItem('parseable-mode', 'live'));
  let customPartition = 'service',
    limit = '30';
  const writes: Record<string, string>[] = [];
  await page.route('**/api/**', (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname;
    if (path === '/api/v1/logstream') return route.fulfill({ json: [{ name: 'existing' }] });
    if (path === '/api/v1/logstream/existing/info')
      return route.fulfill({
        json: {
          logSource: [{ log_source_format: 'json' }],
          timePartition: 'event_time',
          timePartitionLimit: limit,
          customPartition,
          staticSchemaFlag: 'true',
        },
      });
    if (path === '/api/v1/logstream/existing/schema')
      return route.fulfill({
        json: {
          fields: [
            { name: 'service', data_type: 'Utf8', nullable: true },
            { name: 'region', data_type: 'Utf8', nullable: true },
            { name: 'event_time', data_type: { Timestamp: ['Millisecond', null] }, nullable: true },
          ],
        },
      });
    if (path === '/api/v1/logstream/existing' && req.method() === 'PUT') {
      const h = req.headers();
      writes.push(h);
      if (h['x-p-time-partition-limit']) limit = h['x-p-time-partition-limit'].replace('d', '');
      else customPartition = h['x-p-custom-partition'] ?? '';
      return route.fulfill({ body: 'Updated' });
    }
    return route.fulfill({ status: 403, body: 'Permission denied' });
  });
  await page.goto('/datasets');
  await page.getByRole('button', { name: 'Manage existing', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'existing', exact: true }),
    partitions = sheet.getByRole('region', { name: 'Partitions', exact: true });
  await partitions.getByLabel('Custom partition field', { exact: true }).fill('region');
  await partitions.getByRole('button', { name: 'Save custom partition', exact: true }).click();
  await expect(partitions.locator('p[role=status]')).toHaveText('Custom partition saved.');
  await partitions.getByLabel('Time partition limit (days)', { exact: true }).fill('14');
  await partitions.getByRole('button', { name: 'Save time partition limit', exact: true }).click();
  await expect(partitions.locator('p[role=status]')).toHaveText('Time partition limit saved.');
  expect(writes[0]['x-p-time-partition-limit']).toBeUndefined();
  expect(writes[1]['x-p-custom-partition']).toBeUndefined();
  await sheet.getByRole('button', { name: 'Delete dataset', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete dataset', exact: true });
  await expect(confirm).toContainText('Dependencies could not be checked');
  await expect(confirm).not.toContainText('No accessible dependent alerts were returned');
});

test('discard confirmation retains the partition draft when dismissed', async ({ page }) => {
  await demo(page);
  await page.getByRole('button', { name: 'Manage application_logs', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'application_logs', exact: true });
  await sheet.getByLabel('Custom partition field', { exact: true }).fill('draft_service');
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.keyboard.press('Escape');
  await expect(sheet).toBeVisible();
  await expect(sheet.getByLabel('Custom partition field', { exact: true })).toHaveValue(
    'draft_service',
  );
  page.once('dialog', (dialog) => dialog.accept());
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
});

test('accessible dependent alerts are listed as links before deletion', async ({ page }) => {
  await demo(page);
  await page.getByRole('button', { name: 'Manage application_logs', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'application_logs', exact: true });
  await page.route('**/api/v1/alerts', (route) => route.fulfill({ json: [] }));
  await sheet.getByRole('button', { name: 'Delete dataset', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete dataset', exact: true });
  await expect(confirm).toContainText('only includes alerts you can access');
  await expect(confirm.getByRole('link').first()).toBeVisible();
  await expect(confirm.getByRole('link').first()).toHaveAttribute('href', /\/alerts\//);
});

test('creation rejects unsupported label characters without losing the draft', async ({ page }) => {
  await demo(page);
  await page.getByRole('button', { name: 'Create dataset', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Create dataset', exact: true });
  await dialog.getByLabel('Dataset name', { exact: true }).fill('label_guard');
  await dialog.getByText('Advanced', { exact: true }).click();
  await dialog.getByLabel('Labels', { exact: true }).fill('équipe, prod');
  await expect(dialog.locator('[data-dialog-confirm]')).toBeDisabled();
  await expect(dialog).toContainText('printable ASCII');
  await expect(dialog.getByLabel('Dataset name', { exact: true })).toHaveValue('label_guard');
  await dialog.getByLabel('Labels', { exact: true }).fill('team, prod');
  await expect(dialog.locator('[data-dialog-confirm]')).toBeEnabled();
});

test('successful partition save retains its value when metadata refresh fails', async ({
  page,
}) => {
  await page.addInitScript(() => sessionStorage.setItem('parseable-mode', 'live'));
  let saved = false;
  await page.route('**/api/**', (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (path === '/api/v1/logstream') return route.fulfill({ json: [{ name: 'saved_partition' }] });
    if (path.endsWith('/info'))
      return saved
        ? route.fulfill({ status: 503, body: 'Metadata refresh failed' })
        : route.fulfill({
            json: { logSource: [{ log_source_format: 'json' }], customPartition: 'service' },
          });
    if (path.endsWith('/schema'))
      return route.fulfill({
        json: {
          fields: [
            { name: 'service', data_type: 'Utf8' },
            { name: 'region', data_type: 'Utf8' },
          ],
        },
      });
    if (path === '/api/v1/logstream/saved_partition' && request.method() === 'PUT') {
      saved = true;
      return route.fulfill({ body: 'Updated' });
    }
    return route.fulfill({ status: 403, body: 'Permission denied' });
  });
  await page.goto('/datasets');
  await page.getByRole('button', { name: 'Manage saved_partition', exact: true }).click();
  const partitions = page.getByRole('region', { name: 'Partitions', exact: true });
  await partitions.getByLabel('Custom partition field', { exact: true }).fill('region');
  await partitions.getByRole('button', { name: 'Save custom partition', exact: true }).click();
  await expect(partitions).toContainText('Metadata refresh failed');
  await expect(partitions.getByLabel('Custom partition field', { exact: true })).toHaveValue(
    'region',
  );
  await expect(partitions.locator('p[role=status]')).toHaveText('Custom partition saved.');
});
