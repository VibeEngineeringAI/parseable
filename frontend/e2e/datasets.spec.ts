import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

async function demo(page: Page) {
  await page.addInitScript(() => sessionStorage.setItem('parseable-mode', 'demo'));
  await page.goto('/datasets');
  await expect(page.getByRole('heading', { name: 'Datasets', exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Manage application_logs', exact: true }),
  ).toBeVisible();
}
async function manage(page: Page, name = 'application_logs') {
  await page.getByRole('button', { name: `Manage ${name}`, exact: true }).click();
  const sheet = page.getByRole('dialog', { name, exact: true });
  await expect(sheet.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
  return sheet;
}
async function axe(page: Page) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addStyleTag({
    content: '*, *::before, *::after { animation: none !important; transition: none !important; }',
  });
  await page.evaluate(async () => {
    await Promise.allSettled(document.getAnimations().map((animation) => animation.finished));
  });
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
}

test('create validates names and custom partitions, clears search and shows the new dataset', async ({
  page,
}) => {
  await demo(page);
  await page.getByLabel('Search datasets').fill('api_logs');
  await page.getByRole('button', { name: 'Create dataset', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Create dataset', exact: true });
  const submit = dialog.locator('[data-dialog-confirm]');
  await expect(submit).toBeDisabled();
  await dialog.getByLabel('Dataset name', { exact: true }).fill('select');
  await expect(
    dialog.getByText('SQL keyword cannot be used as stream name', { exact: true }),
  ).toBeVisible();
  await expect(submit).toBeDisabled();
  await dialog.getByLabel('Dataset name', { exact: true }).fill('test_metrics');
  await dialog.getByLabel('Telemetry type', { exact: true }).selectOption('metrics');
  await dialog.getByText('Advanced', { exact: true }).click();
  await dialog.getByLabel('Custom partition', { exact: true }).fill('one,two');
  await expect(
    dialog.getByText('Maximum 1 custom partition key is supported', { exact: true }),
  ).toBeVisible();
  await expect(submit).toBeDisabled();
  await dialog.getByLabel('Custom partition', { exact: true }).fill('service');
  await submit.click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel('Search datasets')).toHaveValue('');
  const row = page
    .getByRole('row')
    .filter({ has: page.getByText('test_metrics', { exact: true }) });
  await expect(row.getByRole('cell').nth(1)).toHaveText('metrics');
  const sheet = await manage(page, 'test_metrics');
  await expect(sheet.getByRole('region', { name: 'Overview', exact: true })).toContainText(
    'service',
  );
  await expect(
    sheet.getByText('No fields yet. Ingest data to infer a schema.', { exact: true }),
  ).toBeVisible();
});

test('duplicate creation errors stay in the dialog', async ({ page }) => {
  await demo(page);
  await page.getByRole('button', { name: 'Create dataset', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Create dataset', exact: true });
  await dialog.getByLabel('Dataset name', { exact: true }).fill('application_logs');
  await dialog.locator('[data-dialog-confirm]').click();
  await expect(dialog.getByRole('alert')).toContainText('already exists');
  await expect(dialog.getByLabel('Dataset name', { exact: true })).toHaveValue('application_logs');
  await expect(dialog.locator('[data-dialog-confirm]')).toBeEnabled();
});

test('manage renders overview, stats, schema, retention, hot tier and danger zone', async ({
  page,
}) => {
  await demo(page);
  const sheet = await manage(page);
  for (const name of ['Overview', 'Schema', 'Retention', 'Hot tier', 'Danger zone']) {
    await expect(sheet.getByRole('region', { name, exact: true })).toBeVisible();
  }
  await expect(
    sheet.getByRole('table', { name: 'Ingestion and storage statistics' }),
  ).toContainText('100');
  await expect(sheet.locator('[data-field-node="p_timestamp"]')).toBeVisible();
  await expect(sheet.locator('[data-field-node="message"]')).toBeVisible();
  await expect(sheet.getByRole('link', { name: 'Explore dataset' })).toHaveAttribute(
    'href',
    '/logs/explore/application_logs',
  );
});

test('retention validates days, persists across reopening and clears', async ({ page }) => {
  await demo(page);
  let sheet = await manage(page);
  const days = sheet.getByLabel('Delete data older than N days', { exact: true });
  const save = sheet.getByRole('button', { name: 'Save retention', exact: true });
  for (const invalid of ['0', '36501', '1.5']) {
    await days.fill(invalid);
    await expect(save).toBeDisabled();
    await expect(
      sheet.getByText('Enter a whole number from 1 to 36500 days.', { exact: true }),
    ).toBeVisible();
  }
  await days.fill('30');
  await save.click();
  await expect(
    sheet.getByText('Current policy: delete data older than 30 days.', { exact: true }),
  ).toBeVisible();
  await expect(sheet.getByRole('status')).toHaveText('Retention saved.');
  await page.keyboard.press('Escape');
  sheet = await manage(page);
  await expect(sheet.getByLabel('Delete data older than N days', { exact: true })).toHaveValue(
    '30',
  );
  await sheet.getByRole('button', { name: 'Clear retention', exact: true }).click();
  await expect(
    sheet.getByText('No retention policy. Data is kept indefinitely.', { exact: true }),
  ).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Clear retention', exact: true })).toBeDisabled();
});

test('hot tier can be enabled, resized and disabled in demo', async ({ page }) => {
  await demo(page);
  const sheet = await manage(page);
  const size = sheet.getByLabel('Hot tier size (GiB)', { exact: true });
  const save = sheet.getByRole('button', { name: 'Save hot tier', exact: true });
  await expect(size).toBeEnabled();
  await size.fill('9');
  await expect(save).toBeDisabled();
  await size.fill('10');
  await save.click();
  const section = sheet.getByRole('region', { name: 'Hot tier', exact: true });
  await expect(section.getByRole('status')).toHaveText('Hot tier saved.');
  await expect(section.getByText('10737418240 Bytes', { exact: true }).first()).toBeVisible();
  await size.fill('20');
  await save.click();
  await expect(section.getByText('21474836480 Bytes', { exact: true }).first()).toBeVisible();
  await section.getByRole('button', { name: 'Disable hot tier', exact: true }).click();
  await expect(
    section.getByText('Hot tier is not enabled for this dataset.', { exact: true }),
  ).toBeVisible();
  await expect(
    section.getByRole('button', { name: 'Disable hot tier', exact: true }),
  ).toBeDisabled();
});

test('deletion requires the exact dataset name and closes the sheet after removal', async ({
  page,
}) => {
  await demo(page);
  const sheet = await manage(page, 'api_logs');
  await sheet.getByRole('button', { name: 'Delete dataset', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete dataset', exact: true });
  const button = confirm.locator('[data-dialog-confirm]');
  await expect(button).toBeDisabled();
  for (const name of ['api', 'API_LOGS', 'api_logs ']) {
    await confirm.getByLabel('Confirmation name', { exact: true }).fill(name);
    await expect(button).toBeDisabled();
  }
  await confirm.getByLabel('Confirmation name', { exact: true }).fill('api_logs');
  await expect(button).toBeEnabled();
  await button.click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Manage api_logs', exact: true })).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Manage application_logs', exact: true }),
  ).toBeVisible();
});

test('keyboard creation and cancellation restore focus', async ({ page }) => {
  await demo(page);
  const opener = page.getByRole('button', { name: 'Create dataset', exact: true });
  await opener.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Create dataset', exact: true });
  await expect(dialog.getByRole('button', { name: 'Close dialog', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(dialog.getByLabel('Dataset name', { exact: true })).toBeFocused();
  await page.keyboard.type('keyboard_dataset');
  await page.keyboard.press('Tab');
  await expect(dialog.getByLabel('Telemetry type', { exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Space');
  await page.keyboard.press('Tab');
  await expect(dialog.getByLabel('Custom partition', { exact: true })).toBeFocused();
  await page.keyboard.type('service');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(dialog.locator('[data-dialog-confirm]')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  await expect(
    page.getByRole('button', { name: 'Manage keyboard_dataset', exact: true }),
  ).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(dialog.getByLabel('Dataset name', { exact: true })).toHaveValue('');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test('dataset page, creation, manage sheet and typed confirmation pass axe', async ({ page }) => {
  await demo(page);
  await axe(page);
  await page.getByRole('button', { name: 'Create dataset', exact: true }).click();
  await page.getByText('Advanced', { exact: true }).click();
  await axe(page);
  await page.keyboard.press('Escape');
  const sheet = await manage(page);
  await expect(sheet.getByRole('button', { name: 'Save retention', exact: true })).toBeEnabled();
  await expect(sheet.getByRole('button', { name: 'Save hot tier', exact: true })).toBeEnabled();
  await axe(page);
  await sheet.getByRole('button', { name: 'Delete dataset', exact: true }).click();
  await axe(page);
  await page.keyboard.press('Escape');
  await expect(sheet.getByRole('button', { name: 'Delete dataset', exact: true })).toBeFocused();
});

async function liveMock(page: Page, disabledHotTier = false) {
  await page.addInitScript(() => sessionStorage.setItem('parseable-mode', 'live'));
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/v1/logstream') return route.fulfill({ json: [{ name: 'web_logs' }] });
    if (path.endsWith('/hottier') && disabledHotTier)
      return route.fulfill({
        status: 403,
        body: 'Hot tier is not enabled at the server config, cannot enable hot tier for stream web_logs',
      });
    return route.fulfill({ status: 403, body: 'Permission denied' });
  });
  await page.goto('/datasets');
}

test('Overview formats timestamps in UTC, preserves raw ISO titles and reports an existing time partition', async ({
  page,
}) => {
  await liveMock(page);
  await page.route('**/api/v1/logstream/web_logs/info', (route) =>
    route.fulfill({
      json: {
        createdAt: '2026-10-11T08:01:02-05:00',
        latestEventAt: '2026-10-11T08:04:05-05:00',
        timePartition: 'event_time',
      },
    }),
  );
  const sheet = await manage(page, 'web_logs');
  const overview = sheet.getByRole('region', { name: 'Overview', exact: true });
  await expect(overview.locator('time').nth(0)).toHaveText('2026-10-11 13:01:02 UTC');
  await expect(overview.locator('time').nth(0)).toHaveAttribute(
    'title',
    '2026-10-11T08:01:02-05:00',
  );
  await expect(overview.locator('time').nth(1)).toHaveText('2026-10-11 13:04:05 UTC');
  await expect(overview.locator('time').nth(1)).toHaveAttribute(
    'title',
    '2026-10-11T08:04:05-05:00',
  );
  await expect(overview).toContainText('event_time');
});

test('server 403 errors explain each action inline without blocking other sections', async ({
  page,
}) => {
  await liveMock(page);
  const unavailable = page.getByRole('row').filter({ hasText: 'web_logs' });
  await expect(unavailable).toContainText('Type unavailable');
  await expect(unavailable).toContainText('Permission denied');
  await expect(unavailable.getByRole('link')).toHaveCount(0);
  await expect(
    unavailable.getByRole('button', { name: 'Manage web_logs', exact: true }),
  ).toBeVisible();
  const sheet = await manage(page, 'web_logs');
  for (const [section, action] of [
    ['Overview', 'view dataset statistics'],
    ['Schema', 'view the dataset schema'],
    ['Retention', 'view dataset retention'],
    ['Hot tier', 'view the dataset hot tier'],
  ]) {
    await expect(sheet.getByRole('region', { name: section, exact: true })).toContainText(
      `You don't have permission to ${action}.`,
    );
  }
  await sheet.getByRole('button', { name: 'Save retention', exact: true }).click();
  await expect(sheet.getByRole('region', { name: 'Retention', exact: true })).toContainText(
    "You don't have permission to change dataset retention.",
  );
  await sheet.getByRole('button', { name: 'Delete dataset', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete dataset', exact: true });
  await confirm.getByLabel('Confirmation name', { exact: true }).fill('web_logs');
  await confirm.locator('[data-dialog-confirm]').click();
  await expect(confirm.getByRole('alert')).toContainText(
    "You don't have permission to delete this dataset.",
  );
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Create dataset', exact: true }).click();
  const create = page.getByRole('dialog', { name: 'Create dataset', exact: true });
  await create.getByLabel('Dataset name', { exact: true }).fill('new_dataset');
  await create.locator('[data-dialog-confirm]').click();
  await expect(create.getByRole('alert')).toContainText(
    "You don't have permission to create datasets.",
  );
});

test('disabled server hot tier is explained and its controls are hidden', async ({ page }) => {
  await liveMock(page, true);
  const sheet = await manage(page, 'web_logs');
  const section = sheet.getByRole('region', { name: 'Hot tier', exact: true });
  await expect(section).toContainText(
    'Hot tier is unavailable because it is not enabled in the server configuration.',
  );
  await expect(section.getByRole('alert')).toHaveCount(0);
  await expect(section.getByRole('button', { name: 'Save hot tier', exact: true })).toHaveCount(0);
});
