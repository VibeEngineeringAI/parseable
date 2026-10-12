import { expect, test, type Page } from '@playwright/test';
import { handleApmDemoQuery } from '../src/lib/apmDemo';
import { apmServicePath } from '../src/lib/apm';
import type { LogRecord, QueryRequest } from '../src/lib/types';

async function mockApm(
  page: Page,
  services = ['checkout'],
  timeColumn = 'p_timestamp',
  datasets = ['orders_traces'],
) {
  const captured: Array<
    QueryRequest & {
      kind: string;
      service?: string;
      capturedStart: string;
      capturedEnd: string;
    }
  > = [];
  const timestamp = new Date(Date.now() - 60000).toISOString();
  const rows: LogRecord[] = services.map((service, i) => ({
    'service.name': service,
    span_trace_id: `trace-${i}`,
    span_span_id: `span-${i}`,
    span_name: 'POST /orders',
    span_duration_ns: 42000000,
    span_parent_span_id: '',
    span_status_code: 1,
    span_start_time_unix_nano: timestamp,
    p_timestamp: timestamp,
    [timeColumn]: timestamp,
  }));
  const fields = [
    'p_timestamp',
    'service.name',
    'span_trace_id',
    'span_span_id',
    'span_name',
    'span_duration_ns',
    'span_parent_span_id',
    'span_status_code',
    'span_start_time_unix_nano',
    timeColumn,
  ];
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/v1/logstream')
      return route.fulfill({ json: datasets.map((name) => ({ name })) });
    if (path.endsWith('/info'))
      return route.fulfill({
        json: {
          telemetryType: 'traces',
          logSource: [{ log_source_format: 'otel-traces' }],
          timePartition: timeColumn,
        },
      });
    if (path.endsWith('/schema'))
      return route.fulfill({
        json: { fields: [...new Set(fields)].map((name) => ({ name })) },
      });
    if (path === '/api/v1/about') return route.fulfill({ json: { capabilities: {} } });
    if (path === '/api/v1/query') {
      const body = route.request().postDataJSON();
      const request = {
        sql: body.query,
        startTime: body.startTime,
        endTime: body.endTime,
      };
      const match = /^\/\* parseable-apm:([^\n]+) \*\//.exec(request.sql);
      if (!match) return route.fulfill({ json: [] });
      const meta = JSON.parse(decodeURIComponent(match[1]));
      captured.push({
        ...request,
        kind: meta.kind,
        service: meta.service,
        capturedStart: meta.startTime,
        capturedEnd: meta.endTime,
      });
      return route.fulfill({ json: handleApmDemoQuery(request, rows) });
    }
    return route.fulfill({ status: 404, body: 'No mock for this endpoint' });
  });
  return captured;
}
test('preset-only APM URLs execute 24 hours and carry captured bounds into service and trace links', async ({
  page,
}) => {
  const calls = await mockApm(page);
  await page.goto('/apm/orders_traces?range=24h');
  await expect(page.getByLabel('Time range', { exact: true })).toHaveValue('24h');
  await expect(page.getByRole('link', { name: 'checkout', exact: true })).toBeVisible();
  const inventory = calls.find((call) => call.kind === 'inventory')!;
  expect(Date.parse(inventory.capturedEnd) - Date.parse(inventory.capturedStart)).toBe(86400000);
  await page.getByRole('link', { name: 'checkout', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'checkout', exact: true })).toBeVisible();
  const summary = calls.find((call) => call.kind === 'summary')!;
  expect(summary.capturedStart).toBe(inventory.capturedStart);
  expect(summary.capturedEnd).toBe(inventory.capturedEnd);
  const href = await page
    .getByRole('link', { name: 'Explore service traces' })
    .getAttribute('href');
  const url = new URL(href!, 'https://example.test');
  expect(url.searchParams.get('start')).toBe(inventory.capturedStart);
  expect(url.searchParams.get('end')).toBe(inventory.capturedEnd);
});
for (const service of ['service/worker', '100% checkout', 'x%2Fy']) {
  test(`APM resolves the raw encoded service path once: ${service}`, async ({ page }) => {
    const calls = await mockApm(page, [service]);
    await page.goto(apmServicePath('orders_traces', service));
    await expect(page.getByRole('heading', { name: service, exact: true })).toBeVisible();
    expect(calls.find((call) => call.kind === 'summary')?.service).toBe(service);
    const href = await page
      .getByRole('link', { name: 'Explore service traces' })
      .getAttribute('href');
    expect(new URL(href!, 'https://example.test').searchParams.get('service')).toBe(service);
  });
}
test('APM custom partition queries preserve explicit bounds and quote the selected timestamp field', async ({
  page,
}) => {
  const calls = await mockApm(page, ['checkout'], 'observed"at');
  const end = new Date(),
    start = new Date(end.getTime() - 3600000),
    params = new URLSearchParams({
      start: start.toISOString(),
      end: end.toISOString(),
      range: '24h',
    });
  await page.goto(`/apm/orders_traces?${params}`);
  await expect(page.getByRole('link', { name: 'checkout', exact: true })).toBeVisible();
  const inventory = calls.find((call) => call.kind === 'inventory')!;
  expect(inventory.capturedStart).toBe(start.toISOString());
  expect(inventory.capturedEnd).toBe(end.toISOString());
  expect(inventory.sql).toContain('AND "observed""at" >= TIMESTAMP');
  expect(inventory.sql).toContain('MIN("observed""at")');
  expect(inventory.sql).not.toContain('"p_timestamp"');
  await expect(page.getByText('Dataset time window (observed"at)', { exact: false })).toBeVisible();
});

test('APM preserves dependency view, search and latency metric across ranges and same-bounds refresh, then resets on dataset change', async ({
  page,
}) => {
  const calls = await mockApm(page, ['checkout'], 'p_timestamp', [
    'orders_traces',
    'archive_traces',
  ]);
  const metadataRequests: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.endsWith('/schema') || path.endsWith('/info') || path === '/api/v1/logstream')
      metadataRequests.push(path);
  });
  await page.goto('/apm/orders_traces?range=1h');
  await expect(page.getByLabel('Select latency metric')).toBeVisible();
  await page.getByLabel('Select latency metric').selectOption('p99Ms');
  await page.getByLabel('Search services', { exact: true }).fill('checkout');
  await page.getByRole('tab', { name: 'Dependencies', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Service dependencies' })).toBeVisible();
  await expect(page.getByLabel('Search service dependencies')).toHaveValue('checkout');

  const initialTopology = calls.filter((call) => call.kind === 'topology').at(-1)!;
  await page.getByLabel('Time range', { exact: true }).selectOption('6h');
  await expect(page.getByRole('tab', { name: 'Dependencies', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByLabel('Search service dependencies')).toHaveValue('checkout');
  await expect
    .poll(() => calls.filter((call) => call.kind === 'topology').at(-1)?.capturedStart)
    .not.toBe(initialTopology.capturedStart);
  await expect(page.getByRole('region', { name: 'Service dependencies' })).toBeVisible();
  const rangedTopology = calls.filter((call) => call.kind === 'topology').at(-1)!;
  expect(Date.parse(rangedTopology.capturedEnd) - Date.parse(rangedTopology.capturedStart)).toBe(
    6 * 3600000,
  );

  // Convert the current bounds to an absolute range: Refresh must execute even
  // when changeRange writes the same search parameters.
  await page.getByRole('button', { name: 'Choose absolute time range' }).click();
  await page.getByLabel('From', { exact: true }).fill(rangedTopology.capturedStart.slice(0, -1));
  await page.getByLabel('To', { exact: true }).fill(rangedTopology.capturedEnd.slice(0, -1));
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.getByLabel('Time range', { exact: true })).toHaveValue('custom');
  await expect(page.getByRole('region', { name: 'Service dependencies' })).toBeVisible();
  const beforeRefresh = calls.length;
  const metadataCount = metadataRequests.length;
  await page.getByRole('button', { name: 'Refresh APM' }).click();
  await expect
    .poll(() =>
      calls
        .slice(beforeRefresh)
        .map((call) => call.kind)
        .sort(),
    )
    .toEqual(['inventory', 'topology']);
  await expect(page.getByRole('region', { name: 'Service dependencies' })).toBeVisible();
  for (const call of calls.slice(beforeRefresh)) {
    expect(call.capturedStart).toBe(rangedTopology.capturedStart);
    expect(call.capturedEnd).toBe(rangedTopology.capturedEnd);
  }
  expect(metadataRequests).toHaveLength(metadataCount);
  await expect(page.getByRole('tab', { name: 'Dependencies', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByLabel('Search service dependencies')).toHaveValue('checkout');
  await page.getByRole('tab', { name: 'Services', exact: true }).click();
  await expect(page.getByLabel('Search services', { exact: true })).toHaveValue('checkout');
  await expect(page.getByLabel('Select latency metric')).toHaveValue('p99Ms');

  await page.getByRole('tab', { name: 'Dependencies', exact: true }).click();
  await page.getByLabel('APM dataset').selectOption('archive_traces');
  await expect(page.getByRole('tab', { name: 'Services', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByLabel('Search services', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Select latency metric')).toHaveValue('p95Ms');
});

test('absolute-range APM service refresh reruns every insight query with the same bounds', async ({
  page,
}) => {
  const calls = await mockApm(page);
  const end = new Date(),
    start = new Date(end.getTime() - 3600000),
    params = new URLSearchParams({
      start: start.toISOString(),
      end: end.toISOString(),
    });
  await page.goto(`/apm/orders_traces/checkout?${params}`);
  await expect(page.getByRole('heading', { name: 'checkout', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Service dependencies' })).toBeVisible();
  const beforeRefresh = calls.length;
  await page.getByRole('button', { name: 'Refresh APM' }).click();
  await expect
    .poll(() =>
      calls
        .slice(beforeRefresh)
        .map((call) => call.kind)
        .sort(),
    )
    .toEqual(['operations', 'series', 'spans', 'summary', 'topology']);
  await expect(page.getByRole('heading', { name: 'checkout', exact: true })).toBeVisible();
  for (const call of calls.slice(beforeRefresh)) {
    expect(call.capturedStart).toBe(start.toISOString());
    expect(call.capturedEnd).toBe(end.toISOString());
  }
});
