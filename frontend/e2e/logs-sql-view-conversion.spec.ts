import { createHash } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import type { SavedLogView } from '../src/lib/types';

const owner = createHash('sha256').update('reader').digest('hex');
const state = {
  version: 1,
  dataset: 'events',
  range: { startTime: '2026-10-12T12:00:00Z', endTime: '2026-10-12T13:00:00Z' },
  search: 'saved search',
  expression: { combinator: 'and', groups: [] },
  timezone: 'UTC',
  limit: 100,
  wrap: false,
  showHistogram: true,
};
const makeView = (filter_id: string, extra: Partial<SavedLogView> = {}): SavedLogView => ({
  filter_id,
  filter_name: filter_id,
  stream_name: 'events',
  user_id: owner,
  query: { filter_type: 'sql', filter_query: 'SELECT * FROM events', filter_builder: null },
  explorer_state: JSON.stringify(state),
  custom: { pinned: true },
  ...extra,
});
async function fixture(
  page: Page,
  views: SavedLogView[],
  options: { conversionError?: boolean; waitForConversion?: Promise<void> } = {},
) {
  const mutations: { method: string; path: string; body: unknown }[] = [];
  await page
    .context()
    .addCookies([{ name: 'user_id', value: 'reader', url: 'http://127.0.0.1:5173' }]);
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (path.endsWith('/users/reader'))
      return route.fulfill({ json: { id: 'reader', username: 'Reader' } });
    if (path.endsWith('/logstream'))
      return route.fulfill({ json: [{ name: 'events' }, { name: 'other' }] });
    if (path.endsWith('/schema'))
      return route.fulfill({ json: { fields: [{ name: 'p_timestamp' }, { name: 'message' }] } });
    if (path.endsWith('/info')) return route.fulfill({ json: { timePartition: 'p_timestamp' } });
    if (path.endsWith('/filters') && request.method() === 'GET')
      return route.fulfill({ json: views });
    if (path.includes('/filters')) {
      mutations.push({
        method: request.method(),
        path,
        body: request.postData() ? request.postDataJSON() : null,
      });
      if (path.endsWith('/convert-to-sql')) {
        await options.waitForConversion;
        if (options.conversionError)
          return route.fulfill({ status: 503, body: 'Conversion unavailable. Try again.' });
        const view = views.find((view) => view.filter_id === path.split('/').at(-2))!;
        view.stream_name = 'sql';
        return route.fulfill({ json: view });
      }
      if (request.method() === 'POST') {
        const view = { ...request.postDataJSON(), filter_id: 'created', user_id: owner };
        views.push(view);
        return route.fulfill({ json: view });
      }
      if (request.method() === 'PUT') {
        const id = path.split('/').at(-1),
          index = views.findIndex((view) => view.filter_id === id);
        views[index] = { ...request.postDataJSON(), filter_id: id, user_id: owner };
        return route.fulfill({ json: views[index] });
      }
    }
    if (path.endsWith('/query')) return route.fulfill({ json: [] });
    return route.fulfill({ json: {} });
  });
  await page.goto(
    `/logs/explore/events?${new URLSearchParams({ logView: JSON.stringify(state) })}`,
  );
  await page.getByRole('button', { name: 'Saved views', exact: true }).click();
  return { dialog: page.getByRole('dialog', { name: 'Saved log views' }), mutations };
}

test('new views remain dataset scoped until converted, reopen from SQL storage, and retain SQL on update', async ({
  page,
}) => {
  const views: SavedLogView[] = [];
  const { dialog, mutations } = await fixture(page, views);
  await dialog.getByLabel('Log view name').fill('My saved view');
  await dialog.getByRole('button', { name: 'Save new view', exact: true }).click();
  await expect(dialog.getByText('View saved on the server.', { exact: true })).toBeVisible();
  expect(views[0].stream_name).toBe('events');
  const legacy = structuredClone(views[0]);
  await dialog.getByLabel('Log view name').fill('Unsaved rename');
  await expect(
    dialog.getByText(
      'Convert this saved view to SQL while keeping its existing query and dataset.',
    ),
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Convert to SQL view' }).click();
  await expect(
    dialog.getByText('View converted to SQL. Its query and dataset were retained.'),
  ).toBeVisible();
  expect(views[0]).toEqual({ ...legacy, stream_name: 'sql' });
  expect(mutations.at(-1)).toEqual({
    method: 'POST',
    path: '/api/v1/filters/created/convert-to-sql',
    body: null,
  });
  await expect(dialog.getByLabel('Log view name')).toHaveValue('My saved view');
  await expect(dialog.getByRole('button', { name: 'Convert to SQL view' })).toBeDisabled();
  await page.reload();
  await page.getByRole('button', { name: 'Saved views', exact: true }).click();
  await dialog.getByLabel('Saved log view').selectOption('created');
  await dialog.getByRole('button', { name: 'Apply view', exact: true }).click();
  await expect(page.getByLabel('Search messages', { exact: true })).toHaveValue('saved search');
  await page.getByLabel('Search messages', { exact: true }).fill('updated search');
  await page.getByRole('button', { name: 'Saved views', exact: true }).click();
  await dialog.getByLabel('Saved log view').selectOption('created');
  await dialog.getByLabel('Log view name').fill('Updated SQL view');
  await dialog.getByRole('button', { name: 'Update selected' }).click();
  await expect(dialog.getByText('View saved on the server.', { exact: true })).toBeVisible();
  expect(views[0]).toMatchObject({
    stream_name: 'sql',
    filter_id: legacy.filter_id,
    user_id: owner,
    filter_name: 'Updated SQL view',
  });
  expect(JSON.parse(views[0].explorer_state!)).toMatchObject({
    dataset: 'events',
    search: 'updated search',
  });
});

test('SQL views stay within their explorer dataset and read-only or incompatible views cannot convert', async ({
  page,
}) => {
  const { dialog, mutations } = await fixture(page, [
    makeView('owned'),
    makeView('shared', { user_id: 'someone-else' }),
    makeView('canonical', { stream_name: 'sql' }),
    makeView('other-canonical', {
      stream_name: 'sql',
      explorer_state: JSON.stringify({ ...state, dataset: 'other' }),
    }),
    makeView('malformed', { stream_name: 'sql', explorer_state: '{' }),
    makeView('invalid', { stream_name: 'sql', explorer_state: '{}' }),
    makeView('classic', { explorer_state: null }),
  ]);
  const select = dialog.getByLabel('Saved log view');
  await expect(select.locator('option')).toHaveCount(5);
  await expect(select.locator('option[value="other-canonical"]')).toHaveCount(0);
  await expect(select.locator('option[value="malformed"]')).toHaveCount(0);
  await expect(select.locator('option[value="invalid"]')).toHaveCount(0);
  await select.selectOption('shared');
  await expect(dialog.getByRole('button', { name: 'Convert to SQL view' })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Apply view' })).toBeEnabled();
  await select.selectOption('classic');
  await expect(dialog.getByRole('button', { name: 'Convert to SQL view' })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Apply view' })).toBeDisabled();
  await select.selectOption('canonical');
  await expect(dialog.getByRole('button', { name: 'Convert to SQL view' })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Apply view' })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByLabel('Dataset', { exact: true }).selectOption('other');
  await page.getByRole('button', { name: 'Saved views', exact: true }).click();
  await expect(select.locator('option')).toHaveCount(2);
  await expect(select.locator('option[value="other-canonical"]')).toHaveCount(1);
  expect(mutations).toEqual([]);
});

test('conversion failure retains the legacy view and explains the server error', async ({
  page,
}) => {
  const views = [makeView('owned')],
    options = { conversionError: true };
  const { dialog } = await fixture(page, views, options);
  await dialog.getByLabel('Saved log view').selectOption('owned');
  await dialog.getByRole('button', { name: 'Convert to SQL view' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Conversion unavailable. Try again.');
  expect(views[0].stream_name).toBe('events');
  await expect(dialog.getByRole('button', { name: 'Convert to SQL view' })).toBeEnabled();
  options.conversionError = false;
  await dialog.getByRole('button', { name: 'Convert to SQL view' }).click();
  await expect(
    dialog.getByText('View converted to SQL. Its query and dataset were retained.'),
  ).toBeVisible();
});

test('late conversion responses do not change a reopened dialog selection or name', async ({
  page,
}) => {
  let finish!: () => void;
  const waitForConversion = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const { dialog, mutations } = await fixture(
    page,
    [makeView('converting'), makeView('other-selection')],
    { waitForConversion },
  );
  await dialog.getByLabel('Saved log view').selectOption('converting');
  await dialog.getByRole('button', { name: 'Convert to SQL view' }).click();
  await expect.poll(() => mutations.length).toBe(1);
  await dialog.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByRole('button', { name: 'Saved views', exact: true }).click();
  await dialog.getByLabel('Saved log view').selectOption('other-selection');
  await dialog.getByLabel('Log view name').fill('Keep my draft');
  const response = page.waitForResponse('**/filters/converting/convert-to-sql');
  finish();
  await response;
  await expect(dialog.getByLabel('Saved log view')).toHaveValue('other-selection');
  await expect(dialog.getByLabel('Log view name')).toHaveValue('Keep my draft');
  await expect(
    dialog.getByText('View converted to SQL. Its query and dataset were retained.'),
  ).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Update selected' })).toBeEnabled();
});
