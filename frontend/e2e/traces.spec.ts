import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {
  storyTraceDetail,
  storyTraceList,
  STORY_SPAN_IDS,
  STORY_TRACE_ID,
} from '../src/features/traces/fixtures';
import type { TraceDetailRequest, TraceListRecord, TraceListRequest } from '../src/lib/types';

type Calls = {
  lists: TraceListRequest[];
  details: TraceDetailRequest[];
  queries: Array<{ query: string; startTime: string; endTime: string }>;
};
async function mockLive(
  page: Page,
  options: {
    listStatus?: number;
    empty?: boolean;
    noDatasets?: boolean;
    metadataStatus?: number;
    unchecked?: boolean;
    discoveryFailure?: () => boolean;
    slowService?: Promise<void>;
  } = {},
) {
  const calls: Calls = { lists: [], details: [], queries: [] };
  await page.route('**/api/**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (path === '/api/v1/logstream')
      if (options.discoveryFailure?.())
        return route.fulfill({ status: 503, body: 'Dataset rescan unavailable' });
    if (path === '/api/v1/logstream')
      return route.fulfill({
        json: options.noDatasets ? [] : [{ name: 'ordinary_logs' }, { name: 'orders_traces' }],
      });
    if (path.endsWith('/ordinary_logs/info') && options.unchecked)
      return route.fulfill({ status: 503, body: 'Metadata unavailable' });
    if (path.endsWith('/info'))
      return route.fulfill({
        json: {
          telemetryType: path.includes('ordinary_logs') ? 'logs' : 'traces',
          logSource: [
            { log_source_format: path.includes('ordinary_logs') ? 'json' : 'otel-traces' },
          ],
        },
      });
    if (path === '/api/v1/about') return route.fulfill({ json: { capabilities: {} } });
    if (path.endsWith('/services/traces/list')) {
      const body = request.postDataJSON() as TraceListRequest;
      calls.lists.push(body);
      if (body.serviceName === 'slow-service' && options.slowService) await options.slowService;
      if (options.listStatus)
        return route.fulfill({
          status: options.listStatus,
          body:
            options.listStatus === 403
              ? 'Trace dataset access denied'
              : options.listStatus === 400
                ? 'Dataset is missing required fields: span_status_code'
                : 'Trace query node unavailable',
        });
      let rows: TraceListRecord[] = options.empty ? [] : [...storyTraceList];
      if (body.options !== 'traces' && !options.empty)
        rows.push(
          ...storyTraceDetail.records.slice(1).map((span) => ({
            ...span,
            p_timestamp: storyTraceDetail.startTime,
            error_count: span.has_error ? 1 : 0,
          })),
        );
      if (body.serviceName) rows = rows.filter((row) => row['service.name'] === body.serviceName);
      if (body.options === 'errorSpans') rows = rows.filter((row) => row.has_error === true);
      if (body.sortBy === 'longestFirst')
        rows.sort((a, b) => b.span_duration_ns - a.span_duration_ns);
      const offset = body.offset ?? 0,
        limit = body.limit ?? 25;
      return route
        .fulfill({
          json: { count: rows.length, offset, limit, records: rows.slice(offset, offset + limit) },
        })
        .catch(() => {});
    }
    if (path.endsWith('/services/traces/detail')) {
      const body = request.postDataJSON() as TraceDetailRequest;
      calls.details.push(body);
      return body.traceId === STORY_TRACE_ID
        ? route.fulfill({ json: storyTraceDetail })
        : route.fulfill({ status: 404, body: 'Trace not found' });
    }
    if (path === '/api/v1/query') {
      const body = request.postDataJSON();
      calls.queries.push(body);
      if (options.metadataStatus)
        return route.fulfill({
          status: options.metadataStatus,
          body: 'Stored-record query denied',
        });
      const span =
        storyTraceDetail.records.find((item) => body.query.includes(`'${item.span_span_id}'`)) ??
        storyTraceDetail.records[0];
      const fields = {
        'service.name': span['service.name'],
        span_span_id: span.span_span_id,
        span_name: span.span_name,
        'http.request.method': 'POST',
        event_name: null,
      };
      const event = {
        ...fields,
        event_name: 'exception',
        event_time_unix_nano: '2026-10-12T10:20:00.03',
        event_message: 'Payment provider timed out',
      };
      return route.fulfill({ json: span.has_error ? [fields, event, { ...event }] : [fields] });
    }
    return route.fulfill({ status: 404, body: 'Not found' });
  });
  return calls;
}

test('retrying dataset discovery preserves trace filters and keyboard focus', async ({ page }) => {
  let failed = false;
  await mockLive(page, { unchecked: true, discoveryFailure: () => failed });
  await page.goto('/traces/explore/orders_traces');
  const service = page.getByRole('textbox', { name: 'Service', exact: true });
  const traceId = page.getByRole('textbox', { name: 'Trace ID', exact: true });
  await service.fill('draft-service');
  await traceId.fill(STORY_TRACE_ID);
  const retry = page.getByRole('button', { name: 'Check again', exact: true });
  failed = true;
  await retry.click();
  await expect(page.getByRole('alert')).toContainText('Dataset rescan unavailable');
  await expect(service).toHaveValue('draft-service');
  await expect(traceId).toHaveValue(STORY_TRACE_ID);
  await expect(retry).toBeFocused();
});

test('demo traces opens from navigation and supports list to trace to span inspection', async ({
  page,
}) => {
  await page.addInitScript(() => sessionStorage.setItem('parseable-mode', 'demo'));
  await page.goto('/traces');
  await expect(page).toHaveURL(/\/traces\/explore\/demo_traces/);
  await expect(page.getByTestId('trace-table')).toBeVisible();
  await page
    .getByTestId('trace-table')
    .getByRole('button', { name: /^Open trace/ })
    .first()
    .click();
  const sheet = page.getByRole('dialog', { name: 'Trace detail', exact: true });
  await expect(sheet.getByTestId('span-waterfall')).toBeVisible();
  await expect(sheet.locator('[data-span-id]')).toHaveCount(3);
  await expect(sheet.getByTestId('span-detail')).toContainText('api-gateway');
  await expect(sheet.getByTestId('span-detail')).toContainText('http.request.method');
  await sheet.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByLabel('Status', { exact: true }).selectOption('error');
  await expect(
    page.getByTestId('trace-table').getByRole('button', { name: /^Open trace/ }),
  ).toHaveCount(3);
  await expect(page.getByTestId('trace-table')).toContainText('checkout');
});

test('native list uses explicit options, bounded server pagination, sorting and service handoff', async ({
  page,
}) => {
  const calls = await mockLive(page);
  await page.goto('/traces');
  await expect(page).toHaveURL(/\/traces\/explore\/orders_traces/);
  await expect(page.getByLabel('Traces dataset')).toHaveValue('orders_traces');
  await expect(page.getByLabel('Traces dataset').locator('option')).toHaveCount(1);
  await expect(
    page.getByTestId('trace-table').getByRole('button', { name: /^Open trace/ }),
  ).toHaveCount(25);
  expect(calls.lists.at(-1)).toMatchObject({ options: 'traces', offset: 0, limit: 25 });
  await page.getByRole('button', { name: 'Sort Duration', exact: true }).click();
  await expect.poll(() => calls.lists.at(-1)?.sortBy).toBe('longestFirst');
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(
    page.getByTestId('trace-table').getByRole('button', { name: /^Open trace/ }),
  ).toHaveCount(6);
  expect(calls.lists.at(-1)?.offset).toBe(25);
  await page.getByLabel('Service', { exact: true }).fill('checkout');
  await page.getByRole('button', { name: 'Apply service', exact: true }).click();
  await expect(
    page.getByTestId('trace-table').getByRole('button', { name: /^Open trace/ }),
  ).toHaveCount(1);
  expect(calls.lists.at(-1)).toMatchObject({
    options: 'spans',
    serviceName: 'checkout',
    offset: 0,
  });
  await page.getByLabel('Status', { exact: true }).selectOption('error');
  await expect.poll(() => calls.lists.at(-1)?.options).toBe('errorSpans');
  const before = calls.lists.length;
  await page.getByRole('button', { name: 'Refresh traces', exact: true }).click();
  await expect.poll(() => calls.lists.length).toBeGreaterThan(before);
});

test('uppercase lookup opens a UTC waterfall, keyboard selects a span, and actual events render once', async ({
  page,
}) => {
  const calls = await mockLive(page);
  await page.goto('/traces/explore/orders_traces');
  await page.getByLabel('Trace ID', { exact: true }).fill(STORY_TRACE_ID.toUpperCase());
  await page.getByRole('button', { name: 'Look up', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Trace detail', exact: true });
  await expect(sheet.getByTestId('span-waterfall')).toBeVisible();
  expect(calls.details.at(-1)?.traceId).toBe(STORY_TRACE_ID);
  expect(calls.queries.at(-1)).toMatchObject({
    startTime: '2026-10-12T10:20:00.000Z',
    endTime: '2026-10-12T10:21:00.000Z',
  });
  await expect(sheet).toContainText('Parent unavailable');
  const root = sheet.locator(`[data-span-id="${STORY_SPAN_IDS.root}"]`),
    checkout = sheet.locator(`[data-span-id="${STORY_SPAN_IDS.checkout}"]`);
  await root.focus();
  await page.keyboard.press('ArrowDown');
  await expect(checkout).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(checkout).toHaveAttribute('aria-pressed', 'true');
  await expect(
    sheet.getByTestId('span-detail').getByRole('heading', { name: 'exception', exact: true }),
  ).toHaveCount(1);
  await sheet.getByPlaceholder('Search spans…').fill('reserve-stock');
  await expect(sheet.locator('[data-span-id]')).toHaveCount(1);
  await sheet.getByPlaceholder('Search spans…').fill('');
  await sheet.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(page).not.toHaveURL(/traceId=/);
});

test('replacing a slow filter cancels its stale list result', async ({ page }) => {
  let release!: () => void;
  const slow = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls = await mockLive(page, { slowService: slow });
  await page.goto('/traces/explore/orders_traces');
  await expect(page.getByTestId('trace-table')).toBeVisible();
  await page.getByLabel('Service', { exact: true }).fill('slow-service');
  await page.getByRole('button', { name: 'Apply service', exact: true }).click();
  await expect.poll(() => calls.lists.at(-1)?.serviceName).toBe('slow-service');
  await page.getByLabel('Service', { exact: true }).fill('checkout');
  await page.getByRole('button', { name: 'Apply service', exact: true }).click();
  await expect(page.getByTestId('trace-table')).toContainText('create-order');
  release();
  await expect(page.getByTestId('trace-table')).toContainText('checkout');
  await expect(page.getByRole('heading', { name: 'No matching traces', exact: true })).toHaveCount(
    0,
  );
});

for (const [status, heading, message] of [
  [403, 'Permission denied', 'Trace dataset access denied'],
  [400, 'Could not load data', 'span_status_code'],
  [503, 'Could not load data', 'Trace query node unavailable'],
] as const) {
  test(`native ${status} remains visible with its API reason`, async ({ page }) => {
    await mockLive(page, { listStatus: status });
    await page.goto('/traces/explore/orders_traces');
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    await expect(page.getByRole('alert')).toContainText(message);
    await expect(page.getByTestId('trace-table')).toHaveCount(0);
  });
}

test('empty and missing trace states retain recovery paths', async ({ page }) => {
  await mockLive(page, { empty: true });
  await page.goto('/traces/explore/orders_traces?traceId=ffffffffffffffffffffffffffffffff');
  const sheet = page.getByRole('dialog', { name: 'Trace detail', exact: true });
  await expect(sheet.getByRole('heading', { name: 'Trace not found', exact: true })).toBeVisible();
  await sheet.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'No matching traces', exact: true }),
  ).toBeVisible();
  await page.unrouteAll({ behavior: 'wait' });
  await mockLive(page, { noDatasets: true });
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'No trace datasets available', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByTestId('traces-page').getByRole('link', { name: 'Add data', exact: true }),
  ).toHaveAttribute('href', '/add-data');
});

test('tablet toolbar and results scroll within the page', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 800 });
  await mockLive(page);
  await page.goto('/traces/explore/orders_traces');
  await expect(page.getByTestId('trace-table')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  const service = await page.getByLabel('Service', { exact: true }).boundingBox();
  const lookup = await page.getByLabel('Trace ID', { exact: true }).boundingBox();
  expect(lookup?.x).toBe(service?.x);
});

test('dark mobile trace detail remains keyboard accessible when metadata is forbidden', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem('parseable-theme', 'dark'));
  await mockLive(page, { metadataStatus: 403 });
  await page.goto(`/traces/explore/orders_traces?traceId=${STORY_TRACE_ID}`);
  const sheet = page.getByRole('dialog', { name: 'Trace detail', exact: true });
  await expect(sheet.getByTestId('span-waterfall')).toBeVisible();
  await expect(sheet.getByTestId('span-detail')).toContainText('Permission denied');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addStyleTag({
    content: '*, *::before, *::after { animation: none !important; transition: none !important; }',
  });
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
