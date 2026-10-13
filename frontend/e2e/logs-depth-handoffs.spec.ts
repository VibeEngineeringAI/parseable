import { expect, test, type Page } from '@playwright/test';
const startTime = '2026-10-12T12:00:00.000Z',
  endTime = '2026-10-12T13:00:00.000Z';
type Query = { query: string; startTime: string; endTime: string };
const state = (extra = {}) => ({
  version: 1,
  dataset: 'events',
  range: { startTime, endTime },
  search: '',
  expression: { combinator: 'and', groups: [] },
  columns: ['p_timestamp', 'message'],
  timezone: 'UTC',
  limit: 100,
  wrap: false,
  showHistogram: true,
  ...extra,
});
const shared = (extra = {}, legacy = {}) =>
  `/logs/explore/events?${new URLSearchParams({ logView: JSON.stringify(state(extra)), ...legacy })}`;
async function fixture(page: Page, partition = 'p_timestamp') {
  const queries: Query[] = [];
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (path.endsWith('/logstream')) return route.fulfill({ json: [{ name: 'events' }] });
    if (path.endsWith('/info')) return route.fulfill({ json: { timePartition: partition } });
    if (path.endsWith('/schema'))
      return route.fulfill({
        json: {
          fields: ['p_timestamp', 'event_time', 'message', 'level'].map((name) => ({ name })),
        },
      });
    if (path.endsWith('/filters')) return route.fulfill({ json: [] });
    if (path.endsWith('/query')) {
      const body = request.postDataJSON() as Query;
      queries.push(body);
      return route.fulfill({
        json: body.query.includes('DATE_BIN')
          ? [{ bucket_start: body.startTime, count: 250 }]
          : [
              {
                p_timestamp: '2026-10-12T12:30:00.000Z',
                event_time: '2026-10-12T12:31:00.000Z',
                message: 'fixture',
                level: 'ERROR',
              },
            ],
      });
    }
    return route.fulfill({ json: {} });
  });
  return queries;
}
async function navigate(page: Page, path: string) {
  await page.evaluate((path) => {
    const idx = window.history.state.idx;
    window.history.pushState({ usr: null, key: `handoff-${idx + 1}`, idx: idx + 1 }, '', path);
    window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }));
  }, path);
}
async function expectLogsURL(page: Page, path: string) {
  await expect(page).toHaveURL((url) => {
    const current = new URL(url);
    current.searchParams.delete('observe');
    return current.pathname + current.search + current.hash === path;
  });
}
test('legacy saved view identifiers preserve filters without blocking queries', async ({
  page,
}) => {
  const queries = await fixture(page);
  await page.goto(
    `/logs/explore/events?${new URLSearchParams({ view: 'f1', start: startTime, end: endTime, type: 'custom', query: "WHERE text level = 'ERROR'" })}`,
  );
  await expect(page.getByRole('heading', { name: /1 records/ })).toBeVisible();
  await expect(page.getByTestId('filter-pill-value')).toHaveText('ERROR');
  await expect(page.getByRole('status').filter({ hasText: 'Not carried over' })).toContainText(
    'saved view',
  );
  await expect(page.getByRole('button', { name: 'Clear invalid shared view' })).toHaveCount(0);
  await expectLogsURL(page, '/logs/explore/events');
  expect(queries.some((q) => q.query.includes('"level" = \'ERROR\''))).toBe(true);
});
test('native state wins over classic cleanup and is consumed once', async ({ page }) => {
  const queries = await fixture(page);
  await page.goto(
    shared(
      { search: 'native', timezone: 'America/Chicago' },
      { start: '10m', end: 'now', type: 'fixed', view: 'f1', keep: 'yes' },
    ),
  );
  await expect(page.getByRole('textbox', { name: 'Search messages' })).toHaveValue('native');
  await expect(page.getByRole('combobox', { name: 'Timezone', exact: true })).toHaveValue(
    'America/Chicago',
  );
  await expect(page.getByRole('heading', { name: /1 records/ })).toBeVisible();
  await expectLogsURL(page, '/logs/explore/events?keep=yes');
  expect(queries.every((q) => q.startTime === startTime && q.endTime === endTime)).toBe(true);
  await page.getByRole('textbox', { name: 'Search messages' }).fill('edited');
  await expect.poll(() => queries.some((q) => q.query.includes("'%edited%'"))).toBe(true);
  await navigate(page, '/logs/explore/events?keep=another');
  await page.goBack();
  await expect(page.getByRole('textbox', { name: 'Search messages' })).toHaveValue('edited');
  await expectLogsURL(page, '/logs/explore/events?keep=yes');
});
test('classic links reset timezone and close event details', async ({ page }) => {
  await fixture(page);
  await page.goto(shared({ timezone: 'America/Chicago' }));
  await page.getByRole('button', { name: 'Open event 1', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Event details' })).toBeVisible();
  await navigate(page, '/logs/explore/events?start=1h&end=now&type=fixed&tz=UTC');
  await expect(page.getByRole('dialog', { name: 'Event details' })).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Timezone', exact: true })).toHaveValue('UTC');
});
test('custom partition formats selected timezone in rows and details', async ({ page }) => {
  const queries = await fixture(page, 'event_time');
  await page.goto(shared({ timezone: 'America/Chicago', columns: ['event_time', 'message'] }));
  await expect(page.getByRole('table')).toContainText('2026-10-12 07:31:00');
  await page.getByRole('button', { name: 'Open event 1', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Event details' })).toContainText(
    '2026-10-12 07:31:00',
  );
  expect(queries.find((q) => q.query.startsWith('SELECT *'))?.query).toContain(
    'ORDER BY "event_time" DESC',
  );
  expect(queries.find((q) => q.query.includes('DATE_BIN'))?.query).toContain(
    '"event_time", TIMESTAMP',
  );
});
test('empty groups retain captured relative bounds and do not repeat queries', async ({ page }) => {
  const queries = await fixture(page);
  await page.goto(shared({ range: '1h' }));
  await expect(page.getByRole('heading', { name: /1 records/ })).toBeVisible();
  await expect(page.getByText('250 matching events', { exact: true })).toBeVisible();
  const count = queries.length,
    bounds = queries[0];
  await page.getByRole('button', { name: 'Add group', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Remove group 1', exact: true })).toBeVisible();
  await page.waitForTimeout(350);
  expect(queries).toHaveLength(count);
  await page.getByRole('button', { name: 'Remove group 1', exact: true }).click();
  await page.waitForTimeout(350);
  expect(queries).toHaveLength(count);
  const href = await page.getByRole('link', { name: 'Open in SQL editor' }).getAttribute('href');
  const link = new URL(href!, 'http://localhost');
  expect(link.searchParams.get('start')).toBe(bounds.startTime);
  expect(link.searchParams.get('end')).toBe(bounds.endTime);
});
