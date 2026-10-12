import { expect, test } from '@playwright/test';
import { demoClusterNodes } from '../src/lib/clusterDemo';
import { storyTraceList } from '../src/features/traces/fixtures';
test('cluster shows verified node data and preserves metrics permission failures', async ({
  page,
}) => {
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/v1/cluster/info') return route.fulfill({ json: demoClusterNodes });
    if (path === '/api/v1/cluster/metrics')
      return route.fulfill({ status: 403, body: 'Cluster metrics access denied' });
    if (path === '/api/v1/logstream') return route.fulfill({ json: [] });
    return route.fulfill({ json: {} });
  });
  await page.goto('/cluster');
  await expect(page.getByRole('heading', { name: 'Cluster', exact: true })).toBeVisible();
  await expect(page.getByText('https://ingestor-1.demo', { exact: true })).toBeVisible();
  await expect(page.getByText('Permission denied', { exact: true })).toBeVisible();
  await expect(page.getByText('Reachable', { exact: true })).toHaveCount(2);
});
test('errors uses supported OTLP error span endpoint and opens trace detail', async ({ page }) => {
  const requests: unknown[] = [];
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/v1/logstream') return route.fulfill({ json: [{ name: 'orders_traces' }] });
    if (path.endsWith('/info'))
      return route.fulfill({
        json: { telemetryType: 'traces', logSource: [{ log_source_format: 'otel-traces' }] },
      });
    if (path.endsWith('/services/traces/list')) {
      requests.push(route.request().postDataJSON());
      return route.fulfill({
        json: {
          count: storyTraceList.length,
          offset: 0,
          limit: 25,
          records: storyTraceList.slice(0, 25),
        },
      });
    }
    return route.fulfill({ json: {} });
  });
  await page.goto('/errors/orders_traces');
  await expect(page.getByRole('heading', { name: 'Errors', exact: true })).toBeVisible();
  await expect(page.getByTestId('trace-table')).toBeVisible();
  expect(requests[0]).toMatchObject({
    dataset: 'orders_traces',
    options: 'errorSpans',
    limit: 25,
    offset: 0,
  });
  const body = requests[0] as { startTime: string; endTime: string };
  expect(Date.parse(body.endTime) - Date.parse(body.startTime)).toBe(3600000);
  await page.getByLabel('Time range', { exact: true }).selectOption('6h');
  await expect
    .poll(() =>
      requests.some((value) => {
        const request = value as { startTime: string; endTime: string };
        return Date.parse(request.endTime) - Date.parse(request.startTime) === 6 * 3600000;
      }),
    )
    .toBe(true);
  const sixHours = requests.find((value) => {
    const request = value as { startTime: string; endTime: string };
    return Date.parse(request.endTime) - Date.parse(request.startTime) === 6 * 3600000;
  }) as {
    startTime: string;
    endTime: string;
    offset: number;
    sortBy: string;
  };
  expect(Date.parse(sixHours.endTime) - Date.parse(sixHours.startTime)).toBe(6 * 3600000);
  expect(sixHours).toMatchObject({ offset: 0, sortBy: 'mostRecent' });
  await expect(page).toHaveURL(/range=6h/);
  await page
    .getByTestId('trace-table')
    .getByRole('button')
    .filter({ hasText: storyTraceList[0].span_name })
    .first()
    .click();
  await expect(page).toHaveURL(/\/traces\/explore\/orders_traces\?.*traceId=/);
});
test('errors explains ineligible datasets without querying fabricated error APIs', async ({
  page,
}) => {
  let unsupportedRequests = 0;
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.includes('/errors/')) unsupportedRequests++;
    if (path === '/api/v1/logstream') return route.fulfill({ json: [{ name: 'logs' }] });
    if (path.endsWith('/info'))
      return route.fulfill({
        json: { telemetryType: 'logs', logSource: [{ log_source_format: 'json' }] },
      });
    return route.fulfill({ json: {} });
  });
  await page.goto('/errors/logs');
  await expect(page.getByText('No eligible error dataset')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Explore logs' })).toHaveAttribute(
    'href',
    '/logs/explore/logs',
  );
  expect(unsupportedRequests).toBe(0);
});
test('errors retries unverified dataset metadata instead of declaring it ineligible', async ({
  page,
}) => {
  let metadataUnavailable = true;
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/v1/logstream') return route.fulfill({ json: [{ name: 'orders_traces' }] });
    if (path.endsWith('/info'))
      return metadataUnavailable
        ? route.fulfill({ status: 503, body: 'Metadata temporarily unavailable' })
        : route.fulfill({
            json: { telemetryType: 'traces', logSource: [{ log_source_format: 'otel-traces' }] },
          });
    if (path.endsWith('/services/traces/list'))
      return route.fulfill({ json: { count: 0, offset: 0, limit: 25, records: [] } });
    return route.fulfill({ json: {} });
  });
  await page.goto('/errors/orders_traces');
  await expect(page.getByText('Could not verify dataset', { exact: true })).toBeVisible();
  await expect(page.getByText('No eligible error dataset')).toHaveCount(0);
  metadataUnavailable = false;
  await page.getByRole('button', { name: 'Retry dataset verification' }).click();
  await expect(page.getByText('No error spans', { exact: true })).toBeVisible();
});
test('cluster renders null CPU as unavailable without discarding valid metrics', async ({
  page,
}) => {
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/v1/cluster/info') return route.fulfill({ json: [demoClusterNodes[0]] });
    if (path === '/api/v1/cluster/metrics')
      return route.fulfill({
        json: [
          {
            address: demoClusterNodes[0].domain_name,
            node_type: 'ingestor',
            parseable_events_ingested: 125000,
            process_resident_memory_bytes: 268435456,
            process_cpu_usage_percent_avg: null,
            parseable_staging_files: 4,
          },
        ],
      });
    if (path === '/api/v1/logstream') return route.fulfill({ json: [] });
    return route.fulfill({ json: {} });
  });
  await page.goto('/cluster');
  await expect(page.getByText('125,000', { exact: true })).toBeVisible();
  await expect(
    page.locator('dt').filter({ hasText: 'Average CPU usage' }).locator('+ dd'),
  ).toHaveText('Unavailable');
  await expect(page.getByText('256.0 MiB', { exact: true })).toBeVisible();
  await expect(page.getByText('Could not load data', { exact: true })).toHaveCount(0);
});
