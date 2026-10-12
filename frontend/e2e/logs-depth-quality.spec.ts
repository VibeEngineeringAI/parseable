import { test, expect, type Page } from '@playwright/test';

const state = (dataset = 'events') => ({
  version: 1,
  dataset,
  range: { startTime: '2026-10-12T12:00:00.000Z', endTime: '2026-10-12T13:00:00.000Z' },
  search: '',
  expression: {
    combinator: 'or',
    groups: ['ERROR', 'WARN'].map((value, i) => ({
      id: `g${i}`,
      combinator: 'and',
      rules: [{ id: `r${i}`, field: 'level', operator: '=', value }],
    })),
  },
  columns: ['p_timestamp', 'message'],
  timezone: 'UTC',
  limit: 100,
  wrap: false,
  showHistogram: true,
});
const viewUrl = () =>
  `/logs/explore/events?${new URLSearchParams({ logView: JSON.stringify(state()) })}`;
const notice =
  'To narrow these OR groups, add the filter within each group, or change Match groups to All groups (AND).';

async function mock(page: Page, infoGate?: Promise<void>) {
  let queryCount = 0;
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (path.endsWith('/logstream'))
      return route.fulfill({ json: [{ name: 'events' }, { name: 'other' }] });
    if (path.endsWith('/schema'))
      return route.fulfill({
        json: { fields: ['p_timestamp', 'message', 'level'].map((name) => ({ name })) },
      });
    if (path.endsWith('/info')) {
      await infoGate;
      return route.fulfill({ json: { timePartition: 'p_timestamp' } });
    }
    if (path.endsWith('/filters'))
      return route.fulfill({
        json: [
          {
            filter_id: 'clean',
            filter_name: 'Clean view',
            stream_name: 'events',
            explorer_state: JSON.stringify({
              ...state(),
              expression: { combinator: 'and', groups: [] },
            }),
            query: {
              filter_type: 'sql',
              filter_query: 'SELECT * FROM events',
              filter_builder: null,
            },
          },
        ],
      });
    if (path.endsWith('/query')) {
      queryCount++;
      return route.fulfill({
        json: request.postDataJSON().query.includes('DATE_BIN')
          ? [{ bucket_start: state().range.startTime, count: 1 }]
          : [{ p_timestamp: '2026-10-12T12:30:00.000Z', message: 'anchor event', level: 'ERROR' }],
      });
    }
    return route.fulfill({ json: {} });
  });
  return () => queryCount;
}

async function rejectNarrowing(page: Page) {
  await page.getByRole('button', { name: 'Open event 1', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Event details' })
    .getByRole('button', { name: 'Include level in filter', exact: true })
    .click();
  await expect(page.getByText(notice, { exact: true })).toBeVisible();
}

test('dataset metadata loading does not display false empty results', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queryCount = await mock(page, gate);
  try {
    await page.goto(viewUrl());
    await expect(page.getByRole('button', { name: 'Share / copy link' })).toBeDisabled();
    await expect(page.getByText('No matching events', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: /0 records/ })).toHaveCount(0);
    expect(queryCount()).toBe(0);
  } finally {
    release();
  }
  await expect(page.getByRole('heading', { name: /1 records/ })).toBeVisible();
});

test('invalid shared views show an error without false empty results or requests', async ({
  page,
}) => {
  const queryCount = await mock(page);
  await page.goto('/logs/explore/events?logView=invalid');
  await expect(page.getByRole('alert')).toContainText('Invalid log view');
  await expect(page.getByRole('button', { name: 'Share / copy link' })).toBeDisabled();
  await expect(page.getByText('No matching events', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: /0 records/ })).toHaveCount(0);
  expect(queryCount()).toBe(0);
  await page.getByRole('button', { name: 'Clear invalid shared view' }).click();
  await expect(page.getByRole('heading', { name: /1 records/ })).toBeVisible();
});

for (const transition of ['AND', 'clear', 'apply', 'dataset'] as const) {
  test(`filter notice clears after ${transition} transition`, async ({ page }) => {
    await mock(page);
    await page.goto(viewUrl());
    await rejectNarrowing(page);
    if (transition === 'AND')
      await page.getByRole('combobox', { name: 'Match groups', exact: true }).selectOption('and');
    if (transition === 'clear')
      await page.getByRole('button', { name: 'Clear all', exact: true }).click();
    if (transition === 'dataset')
      await page.getByRole('combobox', { name: 'Dataset', exact: true }).selectOption('other');
    if (transition === 'apply') {
      await page.getByRole('button', { name: 'Saved views', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Saved log views' });
      await dialog.getByLabel('Saved log view').selectOption('clean');
      await dialog.getByRole('button', { name: 'Apply view', exact: true }).click();
    }
    await expect(page.getByText(notice, { exact: true })).toHaveCount(0);
  });
}
