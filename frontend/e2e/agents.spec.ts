import { expect, test, type Page } from '@playwright/test';
import { agentDemoFields, agentDemoRows } from '../src/lib/agents';
async function mockAgents(page: Page, status = 200, empty = false) {
  const captured: Array<{ query: string; startTime: string; endTime: string }> = [];
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/v1/logstream') return route.fulfill({ json: [{ name: 'agent_telemetry' }] });
    if (path.endsWith('/schema'))
      return route.fulfill({ json: { fields: agentDemoFields.map((name) => ({ name })) } });
    if (path.endsWith('/info'))
      return route.fulfill({
        json: { telemetryType: 'traces', logSource: [{ log_source_format: 'otel-traces' }] },
      });
    if (path === '/api/v1/about') return route.fulfill({ json: { capabilities: {} } });
    if (path === '/api/v1/query') {
      captured.push(route.request().postDataJSON());
      return status === 200
        ? route.fulfill({ json: empty ? [] : agentDemoRows() })
        : route.fulfill({ status, body: 'Access denied' });
    }
    return route.fulfill({ status: 404, body: 'No fixture' });
  });
  return captured;
}
test('discovers agent datasets, filters loaded records and exposes raw fields', async ({
  page,
}) => {
  const captured = await mockAgents(page);
  await page.goto('/agents');
  await expect(page.getByRole('heading', { name: 'Choose an agent dataset' })).toBeVisible();
  await page.getByLabel('Agents dataset').selectOption('agent_telemetry');
  await expect(page.getByRole('table')).toBeVisible();
  expect(captured[0].query).toContain('LIMIT 100');
  expect(Date.parse(captured[0].endTime) - Date.parse(captured[0].startTime)).toBe(3600000);
  await page.getByLabel('Search agent telemetry').fill('Research');
  await expect(page.getByRole('row')).toHaveCount(2);
  await page.getByRole('button', { name: 'Inspect telemetry record 1' }).click();
  await expect(page.getByRole('dialog')).toContainText('gen_ai.usage.input_tokens');
  await expect(page.getByRole('link', { name: 'Open trace' })).toHaveAttribute(
    'href',
    /traceId=00000000000000000000000000000002/,
  );
});
test('permission failure renders recovery without stale telemetry', async ({ page }) => {
  await mockAgents(page, 403);
  await page.goto('/agents/agent_telemetry');
  await expect(page.getByRole('heading', { name: 'Permission denied' })).toBeVisible();
  await expect(page.getByRole('table')).toHaveCount(0);
});
test('empty telemetry on mobile stays within viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockAgents(page, 200, true);
  await page.goto('/agents/agent_telemetry');
  await expect(
    page.getByRole('heading', { name: 'No agent telemetry in this range' }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('direct agent links defer schema discovery until the dataset selector is focused', async ({
  page,
}) => {
  const schemaRequests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.endsWith('/schema')) schemaRequests.push(request.url());
  });
  await mockAgents(page);
  await page.route('**/api/v1/logstream', (route) =>
    route.fulfill({ json: [{ name: 'agent_telemetry' }, { name: 'another_dataset' }] }),
  );
  await page.goto('/agents/agent_telemetry');
  await expect(page.getByRole('table')).toBeVisible();
  expect(schemaRequests.filter((url) => url.includes('another_dataset'))).toHaveLength(0);
  await page.getByLabel('Agents dataset').focus();
  await expect
    .poll(() => schemaRequests.filter((url) => url.includes('another_dataset')).length)
    .toBe(1);
});

test('direct nonagent dataset link rejects its schema before submitting a query', async ({
  page,
}) => {
  const captured = await mockAgents(page);
  await page.route('**/api/v1/logstream/*/schema', (route) =>
    route.fulfill({ json: { fields: [{ name: 'p_timestamp' }, { name: 'message' }] } }),
  );
  await page.goto('/agents/application_logs');
  await expect(page.getByRole('alert')).toContainText('no recognized GenAI agent');
  expect(captured).toHaveLength(0);
  await expect(page.getByRole('table')).toHaveCount(0);
});

test('refreshing a preset submits one query with newly captured bounds', async ({ page }) => {
  const captured = await mockAgents(page);
  await page.goto('/agents/agent_telemetry?range=24h');
  await expect(page.getByRole('table')).toBeVisible();
  expect(captured).toHaveLength(1);
  const firstEnd = captured[0].endTime;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('table')).toBeVisible();
  await expect.poll(() => captured.length).toBe(2);
  expect(captured[1].endTime).not.toBe(firstEnd);
  expect(Date.parse(captured[1].endTime) - Date.parse(captured[1].startTime)).toBe(86400000);
});
