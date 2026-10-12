import { createHash } from 'node:crypto';
import { test, expect } from '@playwright/test';

test('saved views allow owner-only mutations, shared apply/copy, and refresh after reopening', async ({
  page,
  context,
  baseURL,
}) => {
  const owner = createHash('sha256').update('reader').digest('hex');
  const state = {
    version: 1,
    dataset: 'events',
    range: { startTime: '2026-10-12T12:00:00Z', endTime: '2026-10-12T13:00:00Z' },
    search: '',
    expression: { combinator: 'and', groups: [] },
    columns: ['p_timestamp'],
    timezone: 'UTC',
    limit: 100,
    wrap: false,
    showHistogram: true,
  };
  const makeView = (filter_id: string, filter_name: string, user_id: string) => ({
    filter_id,
    filter_name,
    user_id,
    stream_name: 'events',
    query: { filter_type: 'sql', filter_query: 'SELECT * FROM events', filter_builder: null },
    explorer_state: JSON.stringify(state),
  });
  const views = [
    makeView('shared', 'Shared incidents', 'another-owner'),
    makeView('owned', 'My incidents', owner),
  ];
  const mutations: Array<{ method: string; path: string }> = [];
  let reads = 0;
  await context.addCookies([{ name: 'user_id', value: 'reader', url: baseURL! }]);
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (path.endsWith('/users/reader'))
      return route.fulfill({ json: { id: 'reader', username: 'Reader' } });
    if (path.endsWith('/logstream')) return route.fulfill({ json: [{ name: 'events' }] });
    if (path.endsWith('/schema'))
      return route.fulfill({ json: { fields: [{ name: 'p_timestamp' }, { name: 'message' }] } });
    if (path.endsWith('/info')) return route.fulfill({ json: { timePartition: 'p_timestamp' } });
    if (path.endsWith('/filters') && request.method() === 'GET') {
      reads++;
      return route.fulfill({ json: views });
    }
    if (path.includes('/filters')) {
      mutations.push({ method: request.method(), path });
      if (request.method() === 'DELETE') return route.fulfill({ status: 200 });
      return route.fulfill({
        json: {
          ...request.postDataJSON(),
          filter_id: path.endsWith('/owned') ? 'owned' : 'copy',
          user_id: owner,
        },
      });
    }
    if (path.endsWith('/query'))
      return route.fulfill({
        json: request.postDataJSON().query.includes('DATE_BIN')
          ? [{ bucket_start: state.range.startTime, count: 1 }]
          : [{ p_timestamp: '2026-10-12T12:30:00Z', message: 'event' }],
      });
    return route.fulfill({ json: {} });
  });
  await page.goto(
    `/logs/explore/events?${new URLSearchParams({ logView: JSON.stringify(state) })}`,
  );
  await page.getByRole('button', { name: 'Saved views', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Saved log views' });
  await dialog.getByLabel('Saved log view').selectOption('shared');
  await expect(dialog.getByText(/This view is read only/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Update selected' })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Delete selected' })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Apply view' })).toBeEnabled();
  await expect(dialog.getByRole('button', { name: 'Save new view' })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Apply view' }).click();
  expect(mutations).toEqual([]);
  const beforeReads = reads;
  views.push(makeView('new-tab', 'Created in another tab', 'another-owner'));
  await page.getByRole('button', { name: 'Saved views', exact: true }).click();
  await expect(dialog.getByRole('option', { name: /Created in another tab/ })).toHaveCount(1);
  expect(reads).toBeGreaterThan(beforeReads);
  await dialog.getByLabel('Saved log view').selectOption('owned');
  await expect(dialog.getByRole('button', { name: 'Update selected' })).toBeEnabled();
  await expect(dialog.getByRole('button', { name: 'Delete selected' })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Update selected' }).click();
  await expect(dialog.getByText('View saved on the server.')).toBeVisible();
  expect(mutations).toEqual([{ method: 'PUT', path: '/api/v1/filters/owned' }]);
});
