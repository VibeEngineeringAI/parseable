import { randomUUID } from 'node:crypto';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

const live = process.env.PARSEABLE_LIVE_URL;
const username = process.env.PARSEABLE_LIVE_USERNAME || 'frontend-smoke';
const password = process.env.PARSEABLE_LIVE_PASSWORD || 'local-smoke-password';
const base = (process.env.PARSEABLE_LIVE_BASE ?? '').replace(/\/+$/, '');
const app = (route: string) => `${base}${route}`;
const headers = {
  Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
};
const suffix = `${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
const name = `dataset_live_${suffix}`;
const datasetPath = `/api/v1/logstream/${encodeURIComponent(name)}`;

test.skip(!live, 'Set PARSEABLE_LIVE_URL to opt in to the real-server suite.');

async function signIn(page: Page) {
  await page.goto(app(`/login?next=${encodeURIComponent('/datasets')}`));
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await expect(page).toHaveURL(new URL(app('/datasets'), live).href);
}
async function getJson<T>(request: APIRequestContext, suffix: string): Promise<T> {
  const response = await request.get(datasetPath + suffix, { headers, timeout: 10_000 });
  expect(response.status(), await response.text()).toBe(200);
  return response.json();
}
test.afterAll(async ({ request }) => {
  if (!live) return;
  const response = await request.delete(datasetPath, { headers, timeout: 10_000 });
  expect(response.ok() || response.status() === 404, await response.text()).toBe(true);
});

test('UI creation with a custom partition, retention set/clear, hot-tier availability and typed deletion', async ({
  page,
  request,
}) => {
  await signIn(page);
  await page.getByRole('button', { name: 'Create dataset', exact: true }).click();
  const create = page.getByRole('dialog', { name: 'Create dataset', exact: true });
  await create.getByLabel('Dataset name', { exact: true }).fill(name);
  await create.getByLabel('Telemetry type', { exact: true }).selectOption('logs');
  await create.getByText('Advanced', { exact: true }).click();
  await create.getByLabel('Custom partition', { exact: true }).fill('service');
  const creation = page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' && new URL(response.url()).pathname === datasetPath,
  );
  await create.locator('[data-dialog-confirm]').click();
  const response = await creation;
  expect(response.ok(), await response.text()).toBe(true);
  await expect(create).toHaveCount(0);
  const info = await getJson<{
    telemetryType: string;
    customPartition: string;
  }>(request, '/info');
  expect(info.telemetryType).toBe('logs');
  expect(info.customPartition).toBe('service');

  await page.getByLabel('Search datasets', { exact: true }).fill(name);
  const hotTierResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'GET' &&
      new URL(response.url()).pathname === `${datasetPath}/hottier`,
  );
  await page.getByRole('button', { name: `Manage ${name}`, exact: true }).click();
  const sheet = page.getByRole('dialog', { name, exact: true });
  await expect(sheet.getByLabel('Delete data older than N days', { exact: true })).toBeEnabled();
  await sheet.getByLabel('Delete data older than N days', { exact: true }).fill('30');
  await sheet.getByRole('button', { name: 'Save retention', exact: true }).click();
  await expect(
    sheet.getByText('Current policy: delete data older than 30 days.', { exact: true }),
  ).toBeVisible();
  expect(await getJson(request, '/retention')).toEqual([
    { description: 'Delete data older than 30 days', action: 'delete', duration: '30d' },
  ]);
  await sheet.getByRole('button', { name: 'Clear retention', exact: true }).click();
  await expect(
    sheet.getByText('No retention policy. Data is kept indefinitely.', { exact: true }),
  ).toBeVisible();
  expect(await getJson(request, '/retention')).toEqual([]);

  const hotTier = sheet.getByRole('region', { name: 'Hot tier', exact: true });
  const hotTierResult = await hotTierResponse;
  if (
    hotTierResult.status() === 403 &&
    (await hotTierResult.text()).includes('Hot tier is not enabled at the server config')
  ) {
    await expect(
      hotTier.getByText(
        'Hot tier is unavailable because it is not enabled in the server configuration.',
        { exact: true },
      ),
    ).toBeVisible();
    await expect(hotTier.locator('form')).toHaveCount(0);
  } else {
    await expect(hotTier.locator('form')).toBeVisible();
  }
  await sheet.getByRole('button', { name: 'Delete dataset', exact: true }).click();
  const remove = page.getByRole('dialog', { name: 'Delete dataset', exact: true });
  await expect(remove.locator('[data-dialog-confirm]')).toBeDisabled();
  await remove.getByLabel('Confirmation name', { exact: true }).fill(name);
  await remove.locator('[data-dialog-confirm]').click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: `Manage ${name}`, exact: true })).toHaveCount(0);
  const missing = await request.get(`${datasetPath}/info`, { headers, timeout: 10_000 });
  expect(missing.status(), await missing.text()).toBe(404);
  const inventory = await request.get('/api/v1/logstream', { headers, timeout: 10_000 });
  expect(inventory.ok(), await inventory.text()).toBe(true);
  const remaining: Array<{ name: string }> = await inventory.json();
  expect(remaining.some((dataset) => dataset.name === name)).toBe(false);
});

test('static schema metadata and ingestion survive custom partition change and removal', async ({
  page,
  request,
}) => {
  const staticName = `${name}_static`,
    path = `/api/v1/logstream/${staticName}`;
  await signIn(page);
  try {
    await page.getByRole('button', { name: 'Create dataset', exact: true }).click();
    const create = page.getByRole('dialog', { name: 'Create dataset', exact: true });
    await create.getByLabel('Dataset name', { exact: true }).fill(staticName);
    await create.getByText('Advanced', { exact: true }).click();
    await create.getByLabel('Static schema', { exact: true }).check();
    await create
      .getByLabel('Creation schema JSON', { exact: true })
      .fill(
        '{"fields":[{"name":"service","data_type":"string"},{"name":"value","data_type":"int"}]}',
      );
    await create.getByLabel('Custom partition', { exact: true }).fill('service');
    await create.getByLabel('apm', { exact: true }).check();
    await create.getByLabel('Labels', { exact: true }).fill('live-fixture, static-schema');
    await create.locator('[data-dialog-confirm]').click();
    await expect(create).toHaveCount(0);
    const info = await request.get(`${path}/info`, { headers });
    expect(info.ok(), await info.text()).toBe(true);
    const metadata = await info.json();
    expect(metadata).toMatchObject({
      staticSchemaFlag: 'true',
      datasetTags: ['a-p-m'],
      customPartition: 'service',
    });
    expect([...metadata.datasetLabels].sort()).toEqual(['live-fixture', 'static-schema']);
    const schema = await request.get(`${path}/schema`, { headers });
    expect(schema.ok(), await schema.text()).toBe(true);
    expect((await schema.json()).fields).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'value', data_type: 'Int64' })]),
    );
    const ingest = await request.post(path, { headers, data: [{ service: 'checkout', value: 7 }] });
    expect(ingest.ok(), await ingest.text()).toBe(true);
    await page.getByLabel('Search datasets', { exact: true }).fill('apm');
    await page.getByRole('button', { name: `Manage ${staticName}`, exact: true }).click();
    const sheet = page.getByRole('dialog', { name: staticName, exact: true });
    await expect(
      sheet
        .getByRole('region', { name: 'Overview', exact: true })
        .getByText('apm', { exact: true }),
    ).toBeVisible();
    const partitions = sheet.getByRole('region', { name: 'Partitions', exact: true });
    await partitions.getByLabel('Custom partition field', { exact: true }).fill('value');
    await partitions.getByRole('button', { name: 'Save custom partition', exact: true }).click();
    await expect(partitions.locator('p[role=status]')).toHaveText('Custom partition saved.');
    await partitions.getByRole('button', { name: 'Remove custom partition', exact: true }).click();
    await expect(partitions.getByLabel('Custom partition field', { exact: true })).toHaveValue('');
    await expect
      .poll(async () => {
        const response = await request.post('/api/v1/query', {
          headers,
          data: {
            query: `SELECT service, value FROM "${staticName}"`,
            startTime: new Date(Date.now() - 3600000).toISOString(),
            endTime: new Date(Date.now() + 60000).toISOString(),
            sendNull: true,
          },
        });
        expect(response.ok(), await response.text()).toBe(true);
        return await response.json();
      })
      .toEqual(
        expect.arrayContaining([expect.objectContaining({ service: 'checkout', value: 7 })]),
      );
  } finally {
    const response = await request.delete(path, { headers });
    expect(response.ok() || response.status() === 404, await response.text()).toBe(true);
  }
});
