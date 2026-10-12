import { expect, test, type Page } from '@playwright/test';
import { handleErrorDemoQuery } from '../src/lib/errorAnalyticsDemo';
import type { LogRecord, QueryRequest } from '../src/lib/types';

// Browser tests exercise request/state/navigation behavior. The separate
// errorAnalytics.live.test.ts executes the generated SQL on a real server.
const bounds = {
  startTime: '2026-10-12T15:00:00.123Z',
  endTime: '2026-10-12T16:00:00.123Z',
};
const range = new URLSearchParams({ start: bounds.startTime, end: bounds.endTime });
const logRows: LogRecord[] = [
  // Identical logs are separate occurrences: six retries form one issue.
  ...Array.from({ length: 6 }, (_, index) => ({
    p_timestamp: `2026-10-12T15:0${index}:30.000Z`,
    level: 'ERROR',
    service: 'checkout',
    'exception.type': 'TimeoutError',
    message: "Payment gateway's connection timed out",
  })),
  // More groups than one page prove that the overview is not a page subtotal.
  ...Array.from({ length: 31 }, (_, index) => ({
    p_timestamp: '2026-10-12T15:20:00.000Z',
    level: 'ERROR',
    service: 'worker',
    'exception.type': 'JobError',
    message: `Job failure ${String(index).padStart(2, '0')}`,
  })),
  {
    p_timestamp: '2026-10-12T15:30:00.000Z',
    level: 'INFO',
    service: 'checkout',
    message: 'No error occurred',
  },
];

const traceBase = {
  p_timestamp: '2026-10-12T15:10:00.000Z',
  'service.name': 'checkout',
  span_trace_id: 'a'.repeat(32),
  span_span_id: '1'.repeat(16),
  span_name: 'charge-card',
  span_status_code: 2,
  event_name: 'exception',
  'event_exception.type': 'TimeoutError',
  'event_exception.message': 'Payment gateway timeout',
};
const traceRows: LogRecord[] = [
  traceBase,
  { ...traceBase }, // Expanded event/retry: still just one span.
  { ...traceBase, span_trace_id: 'b'.repeat(32), span_span_id: '2'.repeat(16) },
  { ...traceBase, span_span_id: '3'.repeat(16), span_status_code: 1 }, // Exception alone is insufficient.
];

type CapturedQuery = QueryRequest & {
  kind: string;
  offset?: number;
  sort?: string;
  issue?: unknown;
};

async function serveLogs(
  page: Page,
  options: { unsupported?: boolean; denied?: boolean; traces?: boolean } = {},
) {
  const requests: CapturedQuery[] = [];
  let denied = options.denied ?? false;
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/v1/logstream')
      return route.fulfill({
        json: [{ name: options.traces ? 'orders_traces' : 'application_logs' }],
      });
    if (path.endsWith('/info'))
      return route.fulfill({
        json: {
          telemetryType: options.traces ? 'traces' : 'logs',
          logSource: [{ log_source_format: options.traces ? 'otel-traces' : 'json' }],
        },
      });
    if (path.endsWith('/schema'))
      return route.fulfill({
        json: {
          fields: (options.traces
            ? Object.keys(traceBase)
            : options.unsupported
              ? ['p_timestamp', 'message']
              : ['p_timestamp', 'level', 'service', 'exception.type', 'message']
          ).map((name) => ({ name, data_type: 'Utf8' })),
        },
      });
    if (path === '/api/v1/query') {
      const body = route.request().postDataJSON();
      const request: QueryRequest = {
        sql: body.query,
        startTime: body.startTime,
        endTime: body.endTime,
      };
      const match = /^\/\* parseable-errors:([^\n]+) \*\//.exec(request.sql);
      if (match) {
        requests.push({ ...request, ...JSON.parse(decodeURIComponent(match[1])) });
        if (denied) return route.fulfill({ status: 403, body: 'Error analytics access denied' });
        return route.fulfill({
          json: handleErrorDemoQuery(request, options.traces ? traceRows : logRows),
        });
      }
      return route.fulfill({ json: [] });
    }
    return route.fulfill({ json: {} });
  });
  return { requests, allowQueries: () => (denied = false) };
}

test('log issues show full-range totals while paging and sorting groups on the server', async ({
  page,
}) => {
  const fixture = await serveLogs(page);
  await page.goto(`/errors/application_logs?${range}`);
  await expect(page.getByRole('heading', { name: 'Errors', exact: true })).toBeVisible();
  await expect(
    page.getByText("Payment gateway's connection timed out", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('img', { name: /Error log records over time/ })).toBeVisible();
  await expect(
    page
      .locator('dt')
      .filter({ hasText: /^Error log records$/ })
      .locator('+ dd'),
  ).toHaveText('37');
  await expect(
    page
      .locator('dt')
      .filter({ hasText: /^Issues$/ })
      .locator('+ dd'),
  ).toHaveText('32');
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect
    .poll(() =>
      fixture.requests.some((request) => request.kind === 'issues' && request.offset === 25),
    )
    .toBe(true);
  await expect(
    page
      .locator('dt')
      .filter({ hasText: /^Error log records$/ })
      .locator('+ dd'),
  ).toHaveText('37');
  await page.getByRole('button', { name: 'Sort by Last seen (UTC)', exact: true }).click();
  await expect
    .poll(() =>
      fixture.requests.some(
        (request) =>
          request.kind === 'issues' && request.sort === 'latest' && (request.offset ?? 0) === 0,
      ),
    )
    .toBe(true);
});

test('a log issue opens its matching occurrences and hands the exact query to SQL', async ({
  page,
}) => {
  const fixture = await serveLogs(page);
  await page.goto(`/errors/application_logs?${range}`);
  await page.getByRole('button', { name: /Payment gateway's connection timed out/ }).click();
  const detail = page.getByRole('dialog');
  await expect(detail).toBeVisible();
  await expect
    .poll(() => fixture.requests.some((request) => request.kind === 'occurrences'))
    .toBe(true);
  const link = detail.getByRole('link', { name: /SQL/ });
  const href = new URL((await link.getAttribute('href'))!, 'http://localhost');
  expect(href.pathname).toBe('/sql-editor');
  expect(href.searchParams.get('start')).toBe('2026-10-12T15:00:00.000Z');
  expect(href.searchParams.get('end')).toBe('2026-10-12T16:01:00.000Z');
  expect(href.searchParams.get('query')).toContain(bounds.startTime);
  expect(href.searchParams.get('query')).toContain(bounds.endTime);
  expect(href.searchParams.get('query')).toContain("Payment gateway''s connection timed out");
  expect(href.searchParams.get('query')).toMatch(/^SELECT \* FROM /);
  expect(href.searchParams.get('query')).not.toContain('parseable-errors:');
  // A trace id in a log is not evidence of a compatible trace dataset.
  await expect(detail.getByRole('link', { name: /Open trace/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(detail).toHaveCount(0);
});

test('permission failures stay errors and retry restores real analytics', async ({ page }) => {
  const fixture = await serveLogs(page, { denied: true });
  await page.goto(`/errors/application_logs?${range}`);
  await expect(page.getByText('Permission denied', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('No errors', { exact: true })).toHaveCount(0);
  fixture.allowQueries();
  await page
    .getByRole('region', { name: 'Issues', exact: true })
    .getByRole('button', { name: 'Try again', exact: true })
    .click();
  await expect(
    page.getByText("Payment gateway's connection timed out", { exact: true }),
  ).toBeVisible();
});

test('logs without a recognized severity field explain eligibility without guessing errors from text', async ({
  page,
}) => {
  const fixture = await serveLogs(page, { unsupported: true });
  await page.goto(`/errors/application_logs?${range}`);
  await expect(page.getByRole('link', { name: 'Explore logs' })).toHaveAttribute(
    'href',
    '/logs/explore/application_logs',
  );
  expect(fixture.requests).toHaveLength(0);
});

test('trace issue drill-down preserves exact bounds and links each deduplicated occurrence', async ({
  page,
}) => {
  await serveLogs(page, { traces: true });
  await page.goto(`/errors/orders_traces?${range}`);
  await expect(
    page
      .locator('dt')
      .filter({ hasText: /^Error spans$/ })
      .locator('+ dd'),
  ).toHaveText('2');
  await page.getByRole('button', { name: /Payment gateway timeout/ }).click();
  const detail = page.getByRole('dialog');
  await expect(detail.getByTestId('error-occurrence-table').locator('tbody tr')).toHaveCount(2);
  const links = detail.getByRole('link', { name: /Open trace/ });
  await expect(links).toHaveCount(2);
  const href = new URL((await links.first().getAttribute('href'))!, 'http://localhost');
  expect(href.pathname).toBe('/traces/explore/orders_traces');
  expect(href.searchParams.get('start')).toBe(bounds.startTime);
  expect(href.searchParams.get('end')).toBe(bounds.endTime);
  expect(href.searchParams.get('traceId')).toBe('a'.repeat(32));
  await expect(detail.getByRole('link', { name: /SQL/ })).toHaveCount(0);
});

test('changing the range resets the issue page and uses one captured interval for all panels', async ({
  page,
}) => {
  const fixture = await serveLogs(page);
  await page.goto(`/errors/application_logs?${range}`);
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect.poll(() => fixture.requests.some((request) => request.offset === 25)).toBe(true);
  const previousRequests = fixture.requests.length;
  await page.getByLabel('Time range', { exact: true }).selectOption('6h');
  await expect(page).toHaveURL(/range=6h/);
  await expect
    .poll(
      () => new Set(fixture.requests.slice(previousRequests).map((request) => request.kind)).size,
    )
    .toBe(3);
  const refreshed = fixture.requests.slice(previousRequests);
  expect(refreshed.find((request) => request.kind === 'issues')?.offset).toBe(0);
  expect(new Set(refreshed.map((request) => `${request.startTime}/${request.endTime}`)).size).toBe(
    1,
  );
  expect(Date.parse(refreshed[0].endTime) - Date.parse(refreshed[0].startTime)).toBe(6 * 3_600_000);
});

test('sample log investigation runs in the SQL editor instead of handing off an unsupported query', async ({
  page,
}) => {
  await page.addInitScript(() => sessionStorage.setItem('parseable-mode', 'demo'));
  await page.goto('/errors/application_logs');
  await page
    .getByRole('button', { name: /Upstream request timed out/ })
    .first()
    .click();
  await page
    .getByRole('dialog')
    .getByRole('link', { name: /SQL editor/ })
    .click();
  await expect(page).toHaveURL(/\/sql-editor/);
  await page.getByRole('button', { name: 'Run query', exact: true }).click();
  await expect(page.getByRole('table')).toBeVisible();
  await expect(page.getByRole('table')).toContainText('Upstream request timed out');
  await expect(page.getByText(/Demo SQL supports SELECT/)).toHaveCount(0);
});
