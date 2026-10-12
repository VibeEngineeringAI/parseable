import { test, expect, type Page } from '@playwright/test';

async function mockServer(page: Page, options: { empty?: boolean; failure?: number } = {}) {
  const mutations: string[] = [];
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== 'GET') mutations.push(path);
    if (path === '/api/v1/logstream')
      return route.fulfill(
        options.failure
          ? { status: options.failure, body: 'Dataset inventory unavailable' }
          : {
              json: options.empty
                ? []
                : [{ name: 'logs' }, { name: 'metrics' }, { name: 'traces' }],
            },
      );
    const info = path.match(/\/logstream\/(logs|metrics|traces)\/info$/);
    if (info)
      return route.fulfill({
        json: {
          telemetryType: info[1],
          logSource: [{ log_source_format: info[1] === 'logs' ? 'json' : `otel-${info[1]}` }],
        },
      });
    return route.fulfill({ status: 404, body: 'Not found' });
  });
  return mutations;
}

test('setup discovers telemetry and links to the matching explorers without mutations', async ({
  page,
}) => {
  const mutations = await mockServer(page);
  await page.goto('/onboarding');
  await expect(page.getByRole('heading', { name: 'Get started', exact: true })).toBeVisible();
  await expect(page.getByText('3 accessible datasets.')).toBeVisible();
  for (const kind of ['logs', 'metrics', 'traces']) {
    await expect(
      page.locator('.setup-datasets').getByRole('link', { name: `${kind} ${kind}` }),
    ).toHaveAttribute('href', `/${kind}/explore/${kind}`);
  }
  await page.getByRole('link', { name: 'Set up ingestion' }).click();
  await expect(page).toHaveURL('/add-data');
  expect(mutations).toEqual([]);
});

test('empty setup provides ingestion guidance, and failed discovery retries', async ({ page }) => {
  await mockServer(page, { empty: true });
  await page.goto('/onboarding');
  await expect(page.getByText('No accessible datasets yet.')).toBeVisible();
  await page.unrouteAll();
  await mockServer(page, { failure: 503 });
  await page.getByRole('button', { name: 'Refresh setup' }).click();
  await expect(page.getByRole('alert')).toContainText('Dataset inventory unavailable');
  await expect(page.getByRole('heading', { name: '1. Connect your data' })).toHaveCount(0);
  await page.unrouteAll();
  await mockServer(page);
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText('3 accessible datasets.')).toBeVisible();
});

test('new workspace explains server scope and opens connection settings', async ({ page }) => {
  const mutations = await mockServer(page);
  await page.goto('/new');
  await expect(page.getByRole('heading', { name: 'Set up a workspace' })).toBeVisible();
  await expect(
    page.getByText('Creating a separate hosted workspace', { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: /workspace creation in classic/ })).toHaveCount(0);
  await page.getByRole('main').getByRole('button', { name: 'Connection settings' }).click();
  await expect(page.getByRole('dialog', { name: 'Connect to Parseable' })).toBeVisible();
  expect(mutations).toEqual([]);
});

test('onboarding permission errors preserve the route without presenting demo setup', async ({
  page,
}) => {
  await mockServer(page, { failure: 403 });
  await page.goto('/onboarding');
  await expect(page.getByRole('alert')).toContainText('Permission denied');
  await expect(page.getByRole('button', { name: 'Explore demo data' })).toHaveCount(0);
  await expect(page).toHaveURL('/onboarding');
});
