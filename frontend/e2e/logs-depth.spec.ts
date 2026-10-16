import { test, expect, type Page } from '@playwright/test';
const startTime = '2026-10-12T12:00:00.000Z',
  endTime = '2026-10-12T13:00:00.000Z';
const fields = [
  'p_timestamp',
  'message',
  'level',
  ...Array.from({ length: 120 }, (_, i) => `field_${i}`),
];
const view = (extra = {}) => ({
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
const url = (state: ReturnType<typeof view>) =>
  `/logs/explore/events?${new URLSearchParams({ logView: JSON.stringify(state) })}`;
type Query = { query: string; startTime: string; endTime: string };
async function mocked(page: Page, options: { histogramError?: boolean; large?: boolean } = {}) {
  const queries: Query[] = [],
    saved: Record<string, unknown>[] = [];
  const row = {
    p_timestamp: '2026-10-12T12:30:00.000Z',
    message: 'anchor event',
    level: 'ERROR',
    ...Object.fromEntries(fields.slice(3).map((field) => [field, field])),
  };
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (path.endsWith('/logstream')) return route.fulfill({ json: [{ name: 'events' }] });
    if (path.endsWith('/schema'))
      return route.fulfill({ json: { fields: fields.map((name) => ({ name })) } });
    if (path.endsWith('/info')) return route.fulfill({ json: { timePartition: 'p_timestamp' } });
    if (path.endsWith('/filters')) {
      if (request.method() === 'POST') {
        const item = { ...request.postDataJSON(), filter_id: 'depth-view' };
        saved.push(item);
        return route.fulfill({ json: item });
      }
      return route.fulfill({ json: saved });
    }
    if (path.endsWith('/query/context'))
      return route.fulfill({
        json: {
          scope: 'contextWindow',
          contextStartTime: startTime,
          contextEndTime: endTime,
          limit: 101,
          anchorIndex: 1,
          duplicateAnchorCount: 1,
          anchoredDuplicate: 'first',
          records: [{ ...row, message: 'nearby event' }, row],
          queries: { previous: null, next: null },
        },
      });
    if (path.endsWith('/query')) {
      const body = request.postDataJSON() as Query;
      queries.push(body);
      if (body.query.includes('DATE_BIN'))
        return options.histogramError
          ? route.fulfill({ status: 503, body: 'Histogram unavailable' })
          : route.fulfill({ json: [{ bucket_start: body.startTime, count: 731 }] });
      const limit = Number(/LIMIT (\d+)/.exec(body.query)?.[1] ?? 100);
      return route.fulfill({
        json: Array.from({ length: options.large ? limit : 100 }, (_, index) => ({
          ...row,
          message: index ? `event ${index}` : row.message,
        })),
      });
    }
    return route.fulfill({ json: {} });
  });
  return { queries, saved };
}
test('histogram counts all matches with identical grouped filters and captured bounds', async ({
  page,
}) => {
  const { queries } = await mocked(page);
  const expression = {
    combinator: 'or',
    groups: ['ERROR', 'WARN'].map((value, i) => ({
      id: `g${i}`,
      combinator: 'and',
      rules: [{ id: `r${i}`, field: 'level', operator: '=', value }],
    })),
  };
  await page.goto(url(view({ expression, search: 'event' })));
  await expect(page.getByText('731 matching events', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: /100 records/ })).toBeVisible();
  const loaded = queries.find((q) => q.query.startsWith('SELECT *'))!,
    histogram = queries.find((q) => q.query.includes('DATE_BIN'))!;
  expect(loaded.query).toContain('LIMIT 100');
  expect(histogram.query).not.toContain('LIMIT');
  expect(loaded.startTime).toBe(startTime);
  expect(histogram.startTime).toBe(loaded.startTime);
  expect(histogram.endTime).toBe(loaded.endTime);
  expect(loaded.query.split(' WHERE ')[1].split(' ORDER BY ')[0]).toBe(
    histogram.query.split(' WHERE ')[1].split(' GROUP BY ')[0],
  );
  await page.getByRole('button', { name: 'Open event 1', exact: true }).click();
  await page.getByRole('button', { name: 'Surrounding logs', exact: true }).click();
  const selected = page
    .getByRole('dialog', { name: 'Surrounding logs' })
    .locator('li[aria-current="true"]');
  await expect(selected).toContainText('Selected event');
  await expect(selected).toContainText('anchor event');
});
test('histogram failure leaves loaded events usable', async ({ page }) => {
  await mocked(page, { histogramError: true });
  await page.goto(url(view()));
  await expect(page.getByRole('heading', { name: /100 records/ })).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Histogram totals' }).getByRole('alert'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Open event 1', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Event details' })).toContainText('anchor event');
});
test('timezone share links and server saved views restore after reload', async ({ page }) => {
  const { saved } = await mocked(page);
  await page.goto(url(view()));
  await page
    .getByRole('combobox', { name: 'Timezone', exact: true })
    .selectOption('America/Chicago');
  await page.getByRole('textbox', { name: 'Search messages' }).fill('anchor');
  await page.getByRole('button', { name: 'Share / copy link' }).click();
  const shared = await page.getByRole('textbox', { name: 'View link' }).inputValue();
  expect(JSON.parse(new URL(shared).searchParams.get('logView')!)).toMatchObject({
    timezone: 'America/Chicago',
    search: 'anchor',
  });
  await page.goto(shared);
  await expect(page.getByRole('combobox', { name: 'Timezone', exact: true })).toHaveValue(
    'America/Chicago',
  );
  await expect(page.getByRole('textbox', { name: 'Search messages' })).toHaveValue('anchor');
  await page.getByRole('button', { name: 'Saved views', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Saved log views' });
  await dialog.getByRole('textbox', { name: 'Log view name' }).fill('Depth view');
  await dialog.getByRole('button', { name: 'Save new view', exact: true }).click();
  await expect(dialog.getByText('View saved on the server.', { exact: true })).toBeVisible();
  expect(saved).toHaveLength(1);
  await page.goto(url(view()));
  await page.getByRole('button', { name: 'Saved views', exact: true }).click();
  await dialog
    .getByRole('combobox', { name: 'Saved log view' })
    .selectOption({ label: 'Depth view (read only)' });
  await dialog.getByRole('button', { name: 'Apply view', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Timezone', exact: true })).toHaveValue(
    'America/Chicago',
  );
  await expect(page.getByRole('textbox', { name: 'Search messages' })).toHaveValue('anchor');
});
test('large wide results bound both rendered axes and keep wrapping and details usable', async ({
  page,
}) => {
  await mocked(page, { large: true });
  await page.goto(url(view({ limit: 10000, columns: fields })));
  const viewport = page.locator('.virtual-log-viewport');
  await expect(viewport).toBeVisible();
  await expect(page.getByRole('table')).toHaveAttribute('aria-rowcount', '10001');
  expect(await page.locator('.virtual-log-row').count()).toBeLessThan(40);
  expect(await page.getByRole('columnheader').count()).toBeLessThan(15);
  await viewport.evaluate((node) => {
    node.scrollTop = 200000;
    node.scrollLeft = 20000;
  });
  await expect
    .poll(() => page.locator('.virtual-log-row').first().getAttribute('data-index'))
    .not.toBe('0');
  await expect(page.getByRole('columnheader', { name: 'field_80', exact: true })).toBeVisible();
  expect(await page.locator('.virtual-log-row').count()).toBeLessThan(40);
  expect(await page.getByRole('columnheader').count()).toBeLessThan(15);
  await page.getByRole('button', { name: 'Toggle row wrapping' }).click();
  await expect(page.locator('.virtual-log-wrap').first()).toHaveCSS('height', '96px');
  await viewport.evaluate((node) => {
    node.scrollTop = 0;
    node.scrollLeft = 0;
  });
  await page.getByRole('button', { name: 'Open event 1', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Event details' })).toContainText('anchor event');
});

test('demo grouped OR filters combine with message search', async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem('parseable-mode', 'demo'));
  await page.goto('/logs');
  async function add(button: string, value: string) {
    await page.getByRole('button', { name: button, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Add filter' });
    await dialog.getByLabel('Field', { exact: true }).selectOption('level');
    await dialog.getByLabel('Value', { exact: true }).fill(value);
    await dialog.getByRole('button', { name: 'Apply filter' }).click();
  }
  await add('Add filter', 'ERROR');
  await page.getByRole('button', { name: 'Add group', exact: true }).click();
  await add('Add filter to group 2', 'WARN');
  await page.getByRole('combobox', { name: 'Match groups', exact: true }).selectOption('or');
  const body = page.getByRole('table').locator('tbody');
  await expect(body).toContainText('ERROR');
  await expect(body).toContainText('WARN');
  await expect(body).not.toContainText('INFO');
  await page.getByRole('textbox', { name: 'Search messages' }).fill('timed out');
  await expect(page.getByText('8 matching events', { exact: true })).toBeVisible();
  await expect(body).toContainText('ERROR');
  await expect(body).not.toContainText('WARN');
  await expect(page.getByTestId('filter-pill-value')).toHaveCount(2);
});

test('virtual event keyboard navigation reaches the entire result and preserves focus during scrolling', async ({
  page,
}) => {
  await mocked(page, { large: true });
  await page.goto(url(view({ limit: 10000 })));
  const viewport = page.locator('.virtual-log-viewport');
  const first = page.getByRole('button', { name: 'Open event 1', exact: true });
  await first.focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('button', { name: 'Open event 2', exact: true })).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.getByRole('button', { name: 'Open event 10000', exact: true })).toBeFocused();
  await page.keyboard.press('PageUp');
  const previous = await page.evaluate(() =>
    document.activeElement?.getAttribute('data-event-button'),
  );
  expect(Number(previous)).toBeLessThan(9999);
  await viewport.evaluate((node) => {
    node.scrollTop = 0;
  });
  await expect(page.locator(`[data-event-button="${previous}"]`)).toBeFocused();
  expect(await page.locator('.virtual-log-row').count()).toBeLessThan(40);
  await page.keyboard.press('Home');
  await expect(first).toBeFocused();
  await page.keyboard.press('PageDown');
  expect(
    Number(await page.evaluate(() => document.activeElement?.getAttribute('data-event-button'))),
  ).toBeGreaterThan(1);
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Event details' })).toContainText('anchor event');
});

test('event include action does not widen an existing OR expression', async ({ page }) => {
  const { queries } = await mocked(page);
  const expression = {
    combinator: 'or',
    groups: ['ERROR', 'WARN'].map((value, i) => ({
      id: `g${i}`,
      combinator: 'and',
      rules: [{ id: `r${i}`, field: 'level', operator: '=', value }],
    })),
  };
  await page.goto(url(view({ expression })));
  await page.getByRole('button', { name: 'Open event 1', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Event details' })
    .getByRole('button', { name: 'Include level in filter', exact: true })
    .click();
  await expect(
    page.getByText(
      'To narrow these OR groups, add the filter within each group, or change Match groups to All groups (AND).',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByTestId('filter-pill-value')).toHaveCount(2);
  const loaded = queries.filter((query) => query.query.startsWith('SELECT *'));
  expect(loaded).toHaveLength(1);
});
