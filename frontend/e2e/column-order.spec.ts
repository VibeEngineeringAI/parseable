import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import classic from '../src/features/dashboards/__fixtures__/classic.json' with { type: 'json' };
import tableTile from './fixtures-cartesian/table.json' with { type: 'json' };

async function mockServer(page: Page) {
  const dashboard = {
    ...classic,
    dashboardType: 'Dashboard',
    variables: [],
    sections: [],
    tiles: [
      tableTile,
      {
        ...tableTile,
        tile_id: '01K7A000000000000000000009',
        title: 'Other events',
        layout: { x: 6, y: 0, w: 6, h: 6 },
      },
    ],
  };
  await page.context().addCookies(
    ['user_id', 'username'].map((name) => ({
      name,
      value: 'admin',
      url: test.info().project.use.baseURL!,
    })),
  );
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/users/admin'))
      return route.fulfill({ json: { id: 'admin', username: 'admin' } });
    if (path.endsWith('/role'))
      return route.fulfill({
        json: {
          roles: { root: { actions: [{ privilege: 'admin' }], roleType: 'internal' } },
          groupRoles: {},
        },
      });
    if (path.endsWith('/logstream'))
      return route.fulfill({ json: [{ name: 'application_logs' }, { name: 'app-logs' }] });
    if (path.endsWith('/schema'))
      return route.fulfill({
        json: { fields: ['p_timestamp', 'level', 'host'].map((name) => ({ name })) },
      });
    if (path.endsWith(`/dashboards/${dashboard.dashboardId}`))
      return route.fulfill({ json: dashboard });
    if (path.endsWith('/query'))
      return route.fulfill({
        json: route.request().postDataJSON().query.startsWith('SELECT message')
          ? [{ host: 'server-one', message: 'new schema' }]
          : [{ p_timestamp: new Date().toISOString(), level: 'INFO', host: 'server-one' }],
      });
    return route.fulfill({ json: {} });
  });
  return dashboard;
}

async function demo(page: Page, path = '/logs') {
  await page.addInitScript(() => sessionStorage.setItem('parseable-mode', 'demo'));
  await page.goto(path);
}
const table = (page: Page) => page.getByRole('table', { name: 'Query results', exact: true });
const headerOrder = (page: Page) =>
  table(page)
    .getByRole('columnheader')
    .evaluateAll((headers) =>
      headers.map((header) => header.getAttribute('aria-label') || header.textContent?.trim()),
    );
async function addFields(page: Page) {
  await expect(table(page)).toBeVisible();
  await page.getByRole('button', { name: 'Add columns', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Add columns' });
  await picker.getByRole('checkbox', { name: 'level', exact: true }).check();
  await picker.getByRole('checkbox', { name: 'host', exact: true }).check();
  await picker.getByRole('button', { name: 'Done', exact: true }).click();
}

for (const virtual of [false, true]) {
  test(`${virtual ? 'virtual' : 'paginated'} log headers drag, keep cells aligned, and preserve sorting`, async ({
    page,
  }) => {
    await demo(page);
    await addFields(page);
    if (virtual) await page.getByLabel('Result limit', { exact: true }).selectOption('1000');
    await table(page).getByRole('button', { name: 'Sort host', exact: true }).click();
    const hostBefore = await table(page)
      .getByRole('row')
      .nth(1)
      .getByRole('cell')
      .nth(3)
      .textContent();
    await table(page)
      .getByRole('button', { name: 'Move host', exact: true })
      .dragTo(table(page).getByRole('columnheader').nth(1));
    await expect
      .poll(() => headerOrder(page))
      .toEqual(['Details', 'host', 'Ingestion Time (UTC)', 'level', 'Data']);
    await expect(table(page).getByRole('row').nth(1).getByRole('cell').nth(1)).toHaveText(
      hostBefore!,
    );
    await expect(
      table(page).getByRole('columnheader', { name: 'host', exact: true }),
    ).toHaveAttribute('aria-sort', 'ascending');
    const handle = table(page).getByRole('button', { name: 'Move host', exact: true });
    await handle.focus();
    await handle.press('ArrowRight');
    await expect(handle).toBeFocused();
    await expect
      .poll(() => headerOrder(page))
      .toEqual(['Details', 'Ingestion Time (UTC)', 'host', 'level', 'Data']);
    await page.reload();
    await expect
      .poll(() => headerOrder(page))
      .toEqual(['Details', 'Ingestion Time (UTC)', 'host', 'level', 'Data']);
  });
}

test('keyboard reordering follows a column across virtual windows in both directions', async ({
  page,
}) => {
  await demo(page);
  await page.getByRole('button', { name: 'Add columns', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Add columns' });
  const checkboxes = picker.getByRole('checkbox');
  const count = await checkboxes.count();
  for (const checkbox of await checkboxes.all()) await checkbox.check();
  await picker.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByLabel('Result limit', { exact: true }).selectOption('1000');
  const handle = table(page).getByRole('button', { name: 'Move p_timestamp', exact: true });
  const viewport = page.locator('.virtual-log-viewport');
  await handle.focus();
  for (const key of ['ArrowRight', 'ArrowLeft']) {
    for (let index = 1; index < count; index++) {
      await page.keyboard.press(key);
      await expect(handle).toBeFocused();
      await expect
        .poll(async () => {
          const grip = await handle.boundingBox();
          const view = await viewport.boundingBox();
          return !!grip && !!view && grip.x >= view.x && grip.x + grip.width <= view.x + view.width;
        })
        .toBe(true);
    }
  }
  await expect.poll(() => viewport.evaluate((node) => node.scrollLeft)).toBe(0);
});

test('column picker drag and buttons preserve order across datasets and fresh visits', async ({
  page,
}) => {
  await demo(page);
  await addFields(page);
  await page.getByRole('button', { name: 'Add columns', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Add columns' });
  await picker
    .getByRole('button', { name: 'Move host', exact: true })
    .dragTo(picker.locator('.column-option-row').first());
  await picker.getByRole('button', { name: 'Move level earlier', exact: true }).click();
  await expect(picker.getByRole('checkbox', { checked: true })).toHaveCount(3);
  await expect(
    picker.getByRole('button', { name: 'Move host earlier', exact: true }),
  ).toBeDisabled();
  await picker.getByRole('textbox', { name: 'Search columns' }).fill('level');
  await picker.getByRole('button', { name: 'Move level earlier', exact: true }).click();
  await picker.getByRole('textbox', { name: 'Search columns' }).fill('');
  await expect(
    picker.getByRole('button', { name: 'Move level earlier', exact: true }),
  ).toBeDisabled();
  expect((await new AxeBuilder({ page }).include('[role="dialog"]').analyze()).violations).toEqual(
    [],
  );
  await picker.getByRole('button', { name: 'Done' }).click();
  await expect
    .poll(() => headerOrder(page))
    .toEqual(['Details', 'level', 'host', 'Ingestion Time (UTC)', 'Data']);
  await page.getByLabel('Dataset', { exact: true }).selectOption('api_logs');
  await expect(table(page).getByRole('columnheader', { name: 'host', exact: true })).toHaveCount(0);
  await page.getByLabel('Dataset', { exact: true }).selectOption('application_logs');
  await expect
    .poll(() => headerOrder(page))
    .toEqual(['Details', 'level', 'host', 'Ingestion Time (UTC)', 'Data']);
  await page.goto('/logs'); // No URL snapshot: restores browser preferences.
  await expect
    .poll(() => headerOrder(page))
    .toEqual(['Details', 'level', 'host', 'Ingestion Time (UTC)', 'Data']);
});

test('explicit shared column order takes precedence without replacing dataset preferences', async ({
  page,
}) => {
  await demo(page);
  await addFields(page);
  const state = {
    version: 1,
    dataset: 'application_logs',
    range: '1h',
    search: '',
    expression: { combinator: 'and', groups: [] },
    columns: ['host', 'level'],
    timezone: 'UTC',
    limit: 100,
    wrap: false,
    showHistogram: true,
  };
  await page.goto(
    `/logs/explore/application_logs?${new URLSearchParams({ logView: JSON.stringify(state) })}`,
  );
  await expect.poll(() => headerOrder(page)).toEqual(['Details', 'host', 'level', 'Data']);
  await page.goto('/logs');
  await expect
    .poll(() => headerOrder(page))
    .toEqual(['Details', 'Ingestion Time (UTC)', 'level', 'host', 'Data']);
});

test('SQL order survives reruns, reloads and reopening a saved query', async ({ page }) => {
  await mockServer(page);
  await page.goto('/sql-editor');
  await page
    .getByRole('textbox', { name: 'SQL query' })
    .fill('SELECT p_timestamp, level, host FROM "application_logs" LIMIT 3');
  const run = page.getByRole('button', { name: 'Run query', exact: true });
  await run.click();
  await table(page)
    .getByRole('button', { name: 'Move host', exact: true })
    .dragTo(table(page).getByRole('columnheader').nth(1));
  const expected = ['Details', 'host', 'Timestamp (UTC)', 'level'];
  await expect.poll(() => headerOrder(page)).toEqual(expected);
  await run.click();
  await expect.poll(() => headerOrder(page)).toEqual(expected);
  await page.reload();
  await run.click();
  await expect.poll(() => headerOrder(page)).toEqual(expected);
  await page.getByRole('textbox', { name: 'Saved query name' }).fill('Ordered results');
  await page.getByRole('button', { name: 'Save as new' }).click();
  await page.getByRole('button', { name: 'Close Ordered results', exact: true }).click();
  await page.getByRole('button', { name: 'Ordered results', exact: true }).click();
  await run.click();
  await expect.poll(() => headerOrder(page)).toEqual(expected);
  await page.getByRole('button', { name: 'Add columns', exact: true }).click();
  await page.getByRole('dialog').getByRole('checkbox', { name: 'level', exact: true }).uncheck();
  await page.getByRole('dialog').getByRole('button', { name: 'Done' }).click();
  await page.reload();
  await run.click();
  await expect.poll(() => headerOrder(page)).toEqual(['Details', 'host', 'Timestamp (UTC)']);
  await page
    .getByRole('textbox', { name: 'SQL query' })
    .fill('SELECT message FROM "application_logs" LIMIT 3');
  await run.click();
  await expect.poll(() => headerOrder(page)).toEqual(['Details', 'host', 'message']);
});

test('metrics result column order persists', async ({ page }) => {
  await demo(page, '/metrics');
  await page
    .getByRole('textbox', { name: 'PromQL query A', exact: true })
    .fill('{"system.cpu.load_average.1m"}');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await page.getByRole('tab', { name: 'Table', exact: true }).click();
  const result = page.getByRole('table', { name: 'Range summary', exact: true });
  await result
    .getByRole('button', { name: 'Move Max', exact: true })
    .dragTo(result.getByRole('columnheader', { name: 'Series', exact: true }));
  await expect(result.getByRole('columnheader').first()).toHaveAttribute('aria-label', 'Max');
  await page.reload();
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await page.getByRole('tab', { name: 'Table', exact: true }).click();
  await expect(result.getByRole('columnheader').first()).toHaveAttribute('aria-label', 'Max');
});

test('dashboard tables remember order independently for each tile', async ({ page }) => {
  const dashboard = await mockServer(page);
  await page.goto(`/dashboards/${dashboard.dashboardId}`);
  const first = page.getByRole('table', { name: 'Recent events results', exact: true });
  const second = page.getByRole('table', { name: 'Other events results', exact: true });
  await first
    .getByRole('button', { name: 'Move host', exact: true })
    .dragTo(first.getByRole('columnheader').first());
  await expect(first.getByRole('columnheader').first()).toHaveAttribute('aria-label', 'host');
  await expect(second.getByRole('columnheader').first()).toHaveAttribute(
    'aria-label',
    'Timestamp (UTC)',
  );
  await page.reload();
  await expect(first.getByRole('columnheader').first()).toHaveAttribute('aria-label', 'host');
  await expect(second.getByRole('columnheader').first()).toHaveAttribute(
    'aria-label',
    'Timestamp (UTC)',
  );
});

test('ordering remains usable with unavailable browser storage', async ({ page }) => {
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith('parseable-columns:'))
        throw new DOMException('Full', 'QuotaExceededError');
      return original.call(this, key, value);
    };
  });
  await demo(page);
  await addFields(page);
  await table(page).getByRole('button', { name: 'Move host', exact: true }).press('ArrowLeft');
  await expect
    .poll(() => headerOrder(page))
    .toEqual(['Details', 'Ingestion Time (UTC)', 'host', 'level', 'Data']);
});
