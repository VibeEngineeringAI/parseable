import { expect, test } from '@playwright/test';
import { agentDemoFields } from '../src/lib/agents';
import { demoClusterNodes } from '../src/lib/clusterDemo';

test('agent dataset changes clear inspected records while the new query is pending', async ({
  page,
}) => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/v1/logstream')
      return route.fulfill({ json: [{ name: 'first' }, { name: 'second' }] });
    if (path.endsWith('/schema'))
      return route.fulfill({ json: { fields: agentDemoFields.map((name) => ({ name })) } });
    if (path.endsWith('/info'))
      return route.fulfill({ json: { logSource: [{ log_source_format: 'otel-traces' }] } });
    if (path === '/api/v1/query') {
      const body = route.request().postDataJSON();
      if (body.query.includes('"second"')) await pending;
      return route.fulfill({
        json: [
          {
            p_timestamp: new Date().toISOString(),
            'gen_ai.agent.name': body.query.includes('"second"') ? 'Second agent' : 'First agent',
          },
        ],
      });
    }
    return route.fulfill({ json: {} });
  });
  await page.goto('/agents/first');
  await expect(
    page.getByRole('cell', { name: 'First agent Partial telemetry', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Inspect run First agent' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByLabel('Agents dataset').focus();
  await page.getByLabel('Agents dataset').selectOption('second');
  await expect(
    page.getByRole('cell', { name: 'First agent Partial telemetry', exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole('table')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  release();
  await expect(
    page.getByRole('cell', { name: 'Second agent Partial telemetry', exact: true }),
  ).toBeVisible();
});

test('cluster refresh removes obsolete nodes on permission failure', async ({ page }) => {
  let revoked = false;
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/v1/cluster/info')
      return revoked
        ? route.fulfill({ status: 403, body: 'Forbidden' })
        : route.fulfill({ json: demoClusterNodes });
    if (path === '/api/v1/cluster/metrics' || path === '/api/v1/logstream')
      return route.fulfill({ json: [] });
    return route.fulfill({ json: {} });
  });
  await page.goto('/cluster');
  await expect(page.getByText('https://ingestor-1.demo', { exact: true })).toBeVisible();
  revoked = true;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Permission denied' })).toBeVisible();
  await expect(page.getByText('https://ingestor-1.demo', { exact: true })).toHaveCount(0);
});

test('expired agent session preserves the dataset and time range in the sign-in return path', async ({
  page,
}) => {
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/schema')) return route.fulfill({ status: 401, body: 'Unauthorized' });
    if (path === '/api/v1/logstream') return route.fulfill({ json: [{ name: 'private_agents' }] });
    return route.fulfill({ json: {} });
  });
  const original = '/agents/private_agents?range=24h';
  await page.goto(original);
  await expect(page).toHaveURL(/\/login\?/);
  expect(new URL(page.url()).searchParams.get('next')).toBe(original);
  await expect(page.getByRole('table')).toHaveCount(0);
});

test('demo agents do not attribute synthetic telemetry to an unknown dataset', async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem('parseable-mode', 'demo'));
  await page.goto('/agents/does_not_exist');
  await expect(page.getByRole('heading', { name: 'Agents', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Support assistant', exact: true })).toHaveCount(0);
  await expect(page.getByRole('table')).toHaveCount(0);
});

test('native setup and settings links remain inside a /next mount', async ({ page }) => {
  await page.route('**/next/**', async (route) => {
    if (route.request().resourceType() !== 'document') return route.continue();
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: (await response.text()).replace('<base href="/"/>', '<base href="/next/"/>'),
    });
  });
  await page.route('**/api/**', (route) => route.fulfill({ json: [] }));
  await page.goto('/next/new');
  await expect(
    page.getByRole('heading', { name: 'Set up a workspace', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Set up this server', exact: true })).toHaveAttribute(
    'href',
    '/next/onboarding',
  );
  await expect(
    page.getByRole('link', { name: 'open workspace creation in classic UI', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('link', { name: 'Set up this server', exact: true }).click();
  await expect(page).toHaveURL(/\/next\/onboarding$/);
  await expect(page.getByRole('link', { name: 'Set up ingestion', exact: true })).toHaveAttribute(
    'href',
    '/next/add-data',
  );
  await page.goto('/next/keystone/investigation');
  await expect(page.getByRole('link', { name: 'LLM settings', exact: true })).toHaveAttribute(
    'href',
    '/next/settings/llm-key',
  );
  await expect(
    page.getByRole('link', { name: 'Open investigation in classic UI', exact: true }),
  ).toHaveAttribute('href', '/keystone/investigation');
});
