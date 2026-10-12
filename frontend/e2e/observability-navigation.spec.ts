import { expect, test } from '@playwright/test';

test('dataset and overview links open the matching telemetry explorer', async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem('parseable-mode', 'demo'));
  await page.goto('/datasets');
  const traces = page
    .getByRole('row')
    .filter({ has: page.getByRole('link', { name: 'demo_traces', exact: true }) });
  await expect(traces.getByRole('link', { name: 'Explore' })).toHaveAttribute(
    'href',
    '/traces/explore/demo_traces',
  );
  await traces.getByRole('link', { name: 'demo_traces', exact: true }).click();
  await expect(page).toHaveURL('/traces/explore/demo_traces');
  await expect(page.getByTestId('sidebar-traces')).toHaveAttribute('aria-current', 'page');
  await page.getByTestId('sidebar-home').click();
  await expect(
    page.locator('.overview-dataset').filter({ hasText: 'demo_metrics' }),
  ).toHaveAttribute('href', '/metrics/explore/demo_metrics');
  await expect(
    page.locator('.overview-dataset').filter({ hasText: 'demo_traces' }),
  ).toHaveAttribute('href', '/traces/explore/demo_traces');
});

test('new trace datasets retain the OTLP source required by the trace explorer', async ({
  page,
}) => {
  await page.addInitScript(() => sessionStorage.setItem('parseable-mode', 'demo'));
  await page.goto('/datasets');
  await page.getByRole('button', { name: 'Create dataset', exact: true }).click();
  const create = page.getByRole('dialog', { name: 'Create dataset' });
  await create.getByLabel('Dataset name').fill('new_trace_data');
  await create.getByLabel('Telemetry type').selectOption('traces');
  await create.getByRole('button', { name: 'Create dataset', exact: true }).click();
  await expect(create).not.toBeVisible();
  await page.getByRole('button', { name: 'Manage new_trace_data', exact: true }).click();
  const manage = page.getByRole('dialog', { name: 'new_trace_data', exact: true });
  await expect(manage.getByText('otel-traces', { exact: true })).toBeVisible();
  await expect(manage.getByRole('link', { name: 'Explore dataset' })).toHaveAttribute(
    'href',
    '/traces/explore/new_trace_data',
  );
});

test('live name-only inventories resolve explorer links from metadata and retain failed entries', async ({
  page,
}) => {
  await page.addInitScript(() => sessionStorage.setItem('parseable-mode', 'live'));
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/v1/logstream')
      return route.fulfill({
        json: [
          'orders_traces',
          'host_metrics',
          'application_logs',
          'legacy_traces',
          'offline_dataset',
        ].map((name) => ({ name })),
      });
    if (path.endsWith('/offline_dataset/info'))
      return route.fulfill({ status: 503, body: 'Dataset metadata node unavailable' });
    if (path.endsWith('/info')) {
      const source = path.includes('orders_traces')
        ? 'otel-traces'
        : path.includes('host_metrics')
          ? 'otel-metrics'
          : 'json';
      return route.fulfill({
        json: {
          telemetryType: path.includes('legacy_traces') ? 'traces' : undefined,
          logSource: [{ log_source_format: source }],
        },
      });
    }
    if (path === '/api/v1/about') return route.fulfill({ json: { capabilities: {} } });
    if (path.endsWith('/services/traces/list'))
      return route.fulfill({ json: { count: 0, offset: 0, limit: 25, records: [] } });
    return route.fulfill({ status: 404, body: 'Not found' });
  });
  await page.goto('/datasets');
  for (const [name, type] of [
    ['orders_traces', 'traces'],
    ['host_metrics', 'metrics'],
    ['application_logs', 'logs'],
    ['legacy_traces', 'logs'],
  ]) {
    const row = page
      .getByRole('row')
      .filter({ has: page.getByRole('link', { name, exact: true }) });
    await expect(row.getByRole('link', { name: 'Explore' })).toHaveAttribute(
      'href',
      `/${type}/explore/${name}`,
    );
    await expect(row.locator('.ui-badge')).toHaveText(type);
  }
  const offline = page.getByRole('row').filter({ hasText: 'offline_dataset' });
  await expect(offline).toContainText('Type unavailable');
  await expect(offline).toContainText('Dataset metadata node unavailable');
  await expect(offline.getByRole('link')).toHaveCount(0);
  await expect(offline.getByRole('button', { name: 'Manage offline_dataset' })).toBeVisible();
  await page.getByRole('link', { name: 'orders_traces', exact: true }).click();
  await expect(page).toHaveURL('/traces/explore/orders_traces');
  await expect(
    page.getByRole('heading', { name: 'No matching traces', exact: true }),
  ).toBeVisible();
  await page.getByTestId('sidebar-home').click();
  for (const [name, type] of [
    ['orders_traces', 'traces'],
    ['host_metrics', 'metrics'],
    ['application_logs', 'logs'],
    ['legacy_traces', 'logs'],
  ])
    await expect(page.locator('.overview-dataset').filter({ hasText: name })).toHaveAttribute(
      'href',
      `/${type}/explore/${name}`,
    );
  const overviewOffline = page.locator('.overview-dataset').filter({ hasText: 'offline_dataset' });
  await expect(overviewOffline).toContainText('Telemetry type unavailable');
  await expect(overviewOffline).toContainText('Dataset metadata node unavailable');
  await expect(overviewOffline).not.toHaveAttribute('href');
});
