import { expect, test, type Page } from '@playwright/test';

/** A live server with one dataset; returns the query requests it receives. */
async function server(page: Page) {
  const queries: { query: string; startTime: string; endTime: string }[] = [];
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/v1/logstream') return route.fulfill({ json: [{ name: 'app' }] });
    if (path.endsWith('/schema'))
      return route.fulfill({ json: { fields: [{ name: 'level' }, { name: 'message' }] } });
    if (path === '/api/v1/query') {
      queries.push(request.postDataJSON());
      return route.fulfill({ json: [{ level: 'error', message: 'fixture' }] });
    }
    return route.fulfill({ status: 404 });
  });
  return queries;
}

test('a classic Logs bookmark opens with its range and filters', async ({ page }) => {
  const queries = await server(page);
  const query = "WHERE text level = 'error' AND text message ILIKE '%timeout%'";
  await page.goto(
    `/logs/explore/app?start=2026-10-09T08:00:00.000Z&end=2026-10-09T09:30:00.000Z&type=custom&tz=Asia%2FKolkata&query=${encodeURIComponent(query)}&keep=1`,
  );
  await expect(page.getByTestId('filter-pill-value')).toHaveText(['error']);
  await expect(page.getByLabel('Time range', { exact: true })).toHaveValue('custom');
  await expect(page.getByRole('status').filter({ hasText: 'Not carried over' })).toHaveText(
    /time zone Asia\/Kolkata \(times are shown in UTC\), 1 filter\./,
  );
  await expect(page).toHaveURL('/logs/explore/app?keep=1');
  expect(queries[0]).toMatchObject({
    startTime: '2026-10-09T08:00:00.000Z',
    endTime: '2026-10-09T09:30:00.000Z',
  });
  expect(queries[0].query).toContain(`"level" = 'error'`);
  expect(queries.every((q) => q.startTime === '2026-10-09T08:00:00.000Z')).toBe(true);
  await page.getByRole('button', { name: 'Dismiss' }).click();
  await expect(page.getByText('Not carried over')).toHaveCount(0);
});

test('a classic quick range shows as that range', async ({ page }) => {
  const queries = await server(page);
  await page.goto('/logs/explore/app?start=10m&end=now&type=fixed&tz=UTC');
  await expect(page.getByLabel('Time range', { exact: true })).toHaveValue('10m');
  await expect(page.getByLabel('Time range', { exact: true }).locator('option:checked')).toHaveText(
    'Last 10 minutes',
  );
  await expect(page).toHaveURL('/logs/explore/app');
  await expect(page.getByText('Not carried over')).toHaveCount(0);
  await expect.poll(() => queries.length).toBeGreaterThan(0);
  const { startTime, endTime } = queries[0];
  expect(Date.parse(endTime) - Date.parse(startTime)).toBe(10 * 60_000);
});

test('classic paths that moved open their page here', async ({ page }) => {
  await server(page);
  await page.goto('/logs/search/app?start=1h&end=now&type=fixed');
  await expect(page).toHaveURL('/logs/explore/app');
  await page.goto('/settings');
  await expect(page).toHaveURL('/alerts/targets');
  await page.goto('/apm/app/checkout.api');
  await expect(page.getByText('This page is only available in the classic UI.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
});

test('a classic metric drilldown opens its metric and names the filter it drops', async ({
  page,
}) => {
  await page.addInitScript(() => sessionStorage.setItem('parseable-mode', 'demo'));
  const metric = 'system.cpu.load_average.1m';
  const filter = encodeURIComponent("WHERE text host = 'node-a'");
  await page.goto(
    `/metrics/explore/demo_metrics/metric/${metric}?start=30m&end=now&type=fixed&tz=UTC&query=${filter}#top`,
  );
  const query = encodeURIComponent(`{"${metric}"}`).replace(/%20/g, '+');
  await expect(page).toHaveURL(`/metrics/explore/demo_metrics?query=${query}&range=30m#top`);
  await expect(page.getByRole('textbox', { name: 'PromQL query A', exact: true })).toHaveText(
    `{"${metric}"}`,
  );
  await expect(page.getByLabel('Time range', { exact: true })).toHaveValue('30m');
  await expect(page.getByRole('img', { name: /PromQL range result/ })).toBeVisible();
  const notice = page.getByRole('status').filter({ hasText: 'Not carried over' });
  await expect(notice).toHaveText(/Not carried over from this link: 1 filter\./);
  await notice.getByRole('button', { name: 'Dismiss' }).click();
  await expect(page.getByText('Not carried over')).toHaveCount(0);
  await page.reload();
  await expect(page.getByLabel('Time range', { exact: true })).toHaveValue('30m');
  await expect(page.getByText('Not carried over')).toHaveCount(0);
});

test('a classic Metrics link keeps no classic filter as a PromQL query', async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem('parseable-mode', 'demo'));
  const filter = encodeURIComponent("WHERE text host = 'node-a' AND text env = 'prod'");
  await page.goto(`/metrics/explore/demo_metrics?start=1d&end=now&type=fixed&query=${filter}`);
  await expect(page).toHaveURL('/metrics/explore/demo_metrics?range=24h');
  await expect(
    page.getByRole('heading', { name: 'Build or write a PromQL query above to plot the chart.' }),
  ).toBeVisible();
  await expect(page.getByLabel('Time range', { exact: true })).toHaveValue('24h');
  await expect(page.getByRole('status').filter({ hasText: 'Not carried over' })).toHaveText(
    /Not carried over from this link: 2 filters\./,
  );
});

test('a page whose code fails to load keeps reload and sign out', async ({ page }) => {
  await server(page);
  await page.route('**/src/features/logs/LogsPage.tsx*', (route) => route.abort());
  await page.goto('/logs/explore/app');
  const error = page.getByRole('alert');
  await expect(error.getByRole('heading', { name: 'This page could not be loaded' })).toBeVisible();
  await expect(error.getByRole('button', { name: 'Reload' })).toBeVisible();
  await expect(error.getByRole('link', { name: 'Back to overview' })).toHaveAttribute('href', '/');
  await page.route('**/api/v1/o/logout?**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<h1>Signed out</h1>' }),
  );
  await error.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Signed out' })).toBeVisible();
});
