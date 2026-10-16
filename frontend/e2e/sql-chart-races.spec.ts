import { test, expect, type Page, type Route } from '@playwright/test';
import classic from '../src/features/dashboards/__fixtures__/classic.json' with { type: 'json' };
import type { Dashboard, DashboardRequest, LogRecord } from '../src/lib/types';

const executed = 'SELECT service, requests FROM "app-logs" ORDER BY requests DESC LIMIT 2';
const pendingDraft = 'SELECT * FROM "other-logs" LIMIT 99';
const rows = [
  { service: 'api', requests: 42 },
  { service: 'worker', requests: 7 },
];

async function serve(page: Page, holdQueries = false) {
  const queries: { sql: string; startTime: string; endTime: string; route: Route }[] = [];
  const writes: { method: string; body: DashboardRequest }[] = [];
  let current: Dashboard = structuredClone(classic);
  let rejectUpdate = false;
  const foreign: Dashboard = {
    ...structuredClone(classic),
    dashboardId: '01JZ8Y3KQ4V9M2X7T5R1B6N0EX',
    title: 'Someone else’s dashboard',
    author: 'another-owner',
  };
  await page.context().addCookies(
    ['user_id', 'username'].map((name) => ({
      name,
      value: 'admin',
      url: String(test.info().project.use.baseURL),
    })),
  );
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/v1/about') return route.fulfill({ json: { capabilities: {} } });
    if (path === '/api/v1/users/admin')
      return route.fulfill({ json: { id: 'admin', username: 'admin' } });
    if (path === '/api/v1/user/admin/role')
      return route.fulfill({
        json: { roles: { root: { actions: [{ privilege: 'admin' }], roleType: 'internal' } } },
      });
    if (path === '/api/v1/logstream')
      return route.fulfill({ json: [{ name: 'app-logs' }, { name: 'other-logs' }] });
    if (path.endsWith('/schema'))
      return route.fulfill({ json: { fields: ['service', 'requests'].map((name) => ({ name })) } });
    if (path.endsWith('/info'))
      return route.fulfill({ json: { logSource: [{ log_source_format: 'json' }] } });
    if (path === '/api/v1/query') {
      const body = request.postDataJSON();
      queries.push({ sql: body.query, startTime: body.startTime, endTime: body.endTime, route });
      // Held routes are released explicitly by the test, including after cancellation.
      if (holdQueries) return;
      return route.fulfill({ json: rows });
    }
    if (path === '/api/v1/dashboards') {
      if (request.method() === 'POST') {
        const body: DashboardRequest = request.postDataJSON();
        writes.push({ method: 'POST', body: structuredClone(body) });
        return route.fulfill({
          json: { ...body, dashboardId: foreign.dashboardId, author: classic.author },
        });
      }
      // Summary metadata intentionally stays stale when the full document changes.
      return route.fulfill({ json: [classic, foreign] });
    }
    if (path === `/api/v1/dashboards/${classic.dashboardId}`) {
      if (request.method() === 'PUT') {
        const body: Dashboard = request.postDataJSON();
        writes.push({ method: 'PUT', body: structuredClone(body) });
        if (rejectUpdate)
          return route.fulfill({ status: 409, json: { message: 'Dashboard save conflict' } });
        current = body;
      }
      return route.fulfill({ json: current });
    }
    if (path === `/api/v1/dashboards/${foreign.dashboardId}`)
      return route.fulfill({ json: foreign });
    return route.fulfill({ json: [] });
  });
  await page.goto('/sql-editor');
  // Identity arrival remounts the workspace; wait before entering any query.
  await expect(page.locator('.shell-username')).toHaveText('admin');
  await expect(page.getByRole('checkbox', { name: 'Select app-logs', exact: true })).toBeVisible();
  return {
    queries,
    writes,
    foreign,
    current: () => structuredClone(current),
    rejectUpdate: () => {
      rejectUpdate = true;
    },
    replace: (dashboard: Dashboard) => {
      current = structuredClone(dashboard);
    },
    release: async (index: number, result: LogRecord[], status = 200) => {
      await queries[index].route.fulfill({
        status,
        json: status === 200 ? result : { message: 'Query failed for this tab' },
      });
      // Flush browser rendering after a deliberately late/aborted response.
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }),
      );
    },
  };
}

async function run(page: Page, sql: string) {
  await page.getByRole('textbox', { name: 'SQL query' }).fill(sql);
  await page.getByRole('button', { name: 'Run query', exact: true }).click();
}

async function chart(page: Page) {
  await run(page, executed);
  await expect(page.getByRole('table').locator('tbody tr')).toHaveCount(2);
  await page.getByRole('tab', { name: 'Chart', exact: true }).click();
  await page.getByLabel('Chart type', { exact: true }).selectOption('bar');
  await page.getByLabel('Chart title', { exact: true }).fill('Requests by service');
  await page.getByLabel('X axis (time or category)', { exact: true }).fill('service');
  await page.getByLabel('Y axis', { exact: true }).fill('requests');
  await page.getByRole('button', { name: 'Add Y axis', exact: true }).click();
  await page.getByLabel('Unit', { exact: true }).fill('req');
  await page.getByLabel('Precision', { exact: true }).fill('1');
  await page.getByLabel('Width (columns)', { exact: true }).selectOption('8');
  await page.getByLabel('Height (rows)', { exact: true }).fill('5');
  await expect(page.locator('.dashboard-preview').getByRole('img')).toBeVisible();
}

async function destination(page: Page, id = 'new') {
  await page.getByRole('button', { name: 'Add to Dashboard', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add to Dashboard', exact: true });
  await expect(dialog.getByLabel('Dashboard', { exact: true }).locator('option')).toHaveCount(3);
  await dialog.getByLabel('Dashboard', { exact: true }).selectOption(id);
  await dialog.getByLabel('Dataset', { exact: true }).selectOption('app-logs');
  if (id === 'new')
    await dialog.getByLabel('Dashboard title', { exact: true }).fill('SQL analysis');
  await expect(dialog.getByRole('button', { name: 'Add chart', exact: true })).toBeEnabled();
  return dialog;
}

test('slow queries finish independently across tabs, including an inactive tab finishing last', async ({
  page,
}) => {
  const server = await serve(page, true);
  await run(page, 'SELECT service FROM "app-logs" -- first');
  await expect.poll(() => server.queries.length).toBe(1);
  await page.getByRole('button', { name: 'New query tab' }).click();
  await run(page, 'SELECT service FROM "other-logs" -- second');
  await expect.poll(() => server.queries.length).toBe(2);
  await server.release(1, [{ service: 'second-result' }]);
  await expect(page.getByRole('cell', { name: 'second-result', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: /^Query 1(?: Running)?$/ }).click();
  await expect(page.getByRole('button', { name: 'Cancel query' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'second-result', exact: true })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Query 2', exact: true }).click();
  await server.release(0, [{ service: 'first-result' }, { service: 'first-extra' }]);
  await expect(page.getByRole('cell', { name: 'second-result', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Query 1', exact: true }).click();
  await expect(page.getByRole('table').locator('tbody tr')).toHaveCount(2);
  await expect(page.getByRole('cell', { name: 'first-result', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'SQL query' })).toContainText('-- first');
  expect(server.queries.map((query) => query.sql)).toEqual([
    'SELECT service FROM "app-logs" -- first',
    'SELECT service FROM "other-logs" -- second',
  ]);
});

test('cancelled responses cannot overwrite a newer execution in the same tab', async ({ page }) => {
  const server = await serve(page, true);
  await run(page, executed);
  await expect.poll(() => server.queries.length).toBe(1);
  await page.getByRole('button', { name: 'Cancel query' }).click();
  await expect(page.getByRole('heading', { name: 'Ready when you are' })).toBeVisible();
  await run(page, pendingDraft);
  await expect.poll(() => server.queries.length).toBe(2);
  await server.release(1, [{ service: 'replacement-result' }]);
  await expect(page.getByRole('cell', { name: 'replacement-result', exact: true })).toBeVisible();
  await server.release(0, [{ service: 'cancelled-result' }]);
  await expect(page.getByRole('table').locator('tbody tr')).toHaveCount(1);
  await expect(page.getByRole('cell', { name: 'replacement-result', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'cancelled-result', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Run query', exact: true })).toBeEnabled();
});

test('closing a running tab isolates its late response from a new tab with the same name', async ({
  page,
}) => {
  const server = await serve(page, true);
  await run(page, executed);
  await expect.poll(() => server.queries.length).toBe(1);
  await page.getByRole('button', { name: 'Close Query 1' }).click();
  await expect(page.getByRole('textbox', { name: 'SQL query' })).toHaveText('');
  await run(page, pendingDraft);
  await expect.poll(() => server.queries.length).toBe(2);
  await server.release(0, [{ service: 'closed-result' }]);
  await expect(page.getByRole('button', { name: 'Cancel query' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'closed-result', exact: true })).toHaveCount(0);
  await server.release(1, [{ service: 'new-tab-result' }]);
  await expect(page.getByRole('cell', { name: 'new-tab-result', exact: true })).toBeVisible();
  await expect(page.getByRole('tablist', { name: 'Query tabs' }).getByRole('tab')).toHaveCount(1);
});

test('query errors belong to their originating tab and do not erase another tab’s results', async ({
  page,
}) => {
  const server = await serve(page, true);
  await run(page, executed);
  await expect.poll(() => server.queries.length).toBe(1);
  await page.getByRole('button', { name: 'New query tab' }).click();
  await run(page, pendingDraft);
  await expect.poll(() => server.queries.length).toBe(2);
  await server.release(1, rows);
  await expect(page.getByRole('table').locator('tbody tr')).toHaveCount(2);
  await server.release(0, [], 500);
  await expect(page.getByText('Query failed for this tab', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('table').locator('tbody tr')).toHaveCount(2);
  await page.getByRole('tab', { name: 'Query 1', exact: true }).click();
  await expect(page.getByText('Query failed for this tab', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run query', exact: true })).toBeEnabled();
});

test('result and chart views retain bindings and appearance independently for each query tab', async ({
  page,
}) => {
  const server = await serve(page);
  await chart(page);
  await page.getByRole('tab', { name: 'Results', exact: true }).click();
  await expect(page.getByRole('table').locator('tbody tr')).toHaveCount(2);
  await page.getByRole('tab', { name: 'Chart', exact: true }).click();
  await expect(page.getByLabel('Chart type', { exact: true })).toHaveValue('bar');
  await expect(page.getByRole('list', { name: 'Y axis fields', exact: true })).toContainText(
    'requests',
  );
  await page.getByRole('button', { name: 'New query tab' }).click();
  await run(page, pendingDraft);
  await expect(page.getByRole('table').locator('tbody tr')).toHaveCount(2);
  await page.getByRole('tab', { name: 'Chart', exact: true }).click();
  await expect(page.getByLabel('Chart type', { exact: true })).toHaveValue('timeseries');
  await page.getByLabel('Chart type', { exact: true }).selectOption('pie');
  await page.getByLabel('Chart title', { exact: true }).fill('Second chart');
  await page.getByLabel('Category column', { exact: true }).fill('service');
  await page.getByRole('tab', { name: 'Query 1', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Chart', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByLabel('Chart title', { exact: true })).toHaveValue('Requests by service');
  await expect(page.getByLabel('Chart type', { exact: true })).toHaveValue('bar');
  await expect(page.getByLabel('X axis (time or category)', { exact: true })).toHaveValue(
    'service',
  );
  await expect(page.getByRole('list', { name: 'Y axis fields', exact: true })).toContainText(
    'requests',
  );
  await expect(page.getByLabel('Unit', { exact: true })).toHaveValue('req');
  await expect(page.getByLabel('Precision', { exact: true })).toHaveValue('1');
  await expect(page.getByLabel('Width (columns)', { exact: true })).toHaveValue('8');
  await expect(page.getByLabel('Height (rows)', { exact: true })).toHaveValue('5');
  await page.getByRole('tab', { name: 'Query 2', exact: true }).click();
  await expect(page.getByLabel('Chart type', { exact: true })).toHaveValue('pie');
  await expect(page.getByLabel('Chart title', { exact: true })).toHaveValue('Second chart');
  await expect(page.getByLabel('Category column', { exact: true })).toHaveValue('service');
  expect(server.queries).toHaveLength(2);
});

for (const target of ['new', 'existing'] as const) {
  test(`Add to ${target} Dashboard saves executed SQL and chart configuration while preserving destination fields`, async ({
    page,
  }) => {
    const server = await serve(page);
    const original = server.current();
    await chart(page);
    await page.getByRole('textbox', { name: 'SQL query' }).fill(pendingDraft);
    const dialog = await destination(page, target === 'new' ? 'new' : classic.dashboardId);
    await dialog.getByRole('button', { name: 'Add chart', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(
      page.getByRole('link', {
        name: target === 'new' ? 'SQL analysis' : classic.title,
        exact: true,
      }),
    ).toBeVisible();
    expect(server.writes).toHaveLength(1);
    const write = server.writes[0];
    expect(write.method).toBe(target === 'new' ? 'POST' : 'PUT');
    const added = write.body.tiles!.at(-1)!;
    expect(added).toMatchObject({
      title: 'Requests by service',
      tileType: 'code',
      chartType: 'bar',
      chartQuery: executed,
      dbName: ['app-logs'],
      layout: { w: 8, h: 5 },
      config: {
        type: 'bar',
        axes: { x: { field: 'service' }, y: { field: 'requests' } },
        layout: { unit: 'req', precision: 1 },
      },
    });
    expect(added.tile_id).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    expect(original.tiles!.map((tile) => tile.tile_id)).not.toContain(added.tile_id);
    expect(server.queries).toHaveLength(1);
    await expect(page.getByRole('textbox', { name: 'SQL query' })).toContainText(pendingDraft);
    if (target === 'existing') {
      expect(write.body).toEqual({ ...original, tiles: [...original.tiles!, added] });
      expect(added.layout).toMatchObject({ x: 0, y: 12 });
    } else {
      expect(write.body).toMatchObject({
        title: 'SQL analysis',
        dataset: 'app-logs',
        tags: [],
        variables: [],
        sections: [],
        isFavorite: false,
        timeRange: {
          startTime: server.queries[0].startTime,
          endTime: server.queries[0].endTime,
          type: 'custom',
        },
      });
      expect(write.body.tiles).toHaveLength(1);
      for (const key of ['dashboardId', 'author', 'created', 'modified', 'tenantId'])
        expect(write.body).not.toHaveProperty(key);
    }
  });
}

test('dashboard ownership is checked on the loaded document as well as the destination list', async ({
  page,
}) => {
  const server = await serve(page);
  await chart(page);
  const dialog = await destination(page, classic.dashboardId);
  await expect(
    dialog
      .getByLabel('Dashboard', { exact: true })
      .locator(`option[value="${server.foreign.dashboardId}"]`),
  ).toBeDisabled();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  // List metadata can be stale: ownership changes before the selected document is fetched.
  server.replace({ ...server.current(), author: 'new-owner' });
  await page.getByRole('button', { name: 'Add to Dashboard', exact: true }).click();
  await expect(
    dialog.getByText('This dashboard is read-only. Only its owner can edit it.', { exact: true }),
  ).toBeVisible();
  await expect(
    dialog
      .getByLabel('Dashboard', { exact: true })
      .locator(`option[value="${classic.dashboardId}"]`),
  ).toBeEnabled();
  await expect(dialog.getByRole('button', { name: 'Add chart', exact: true })).toBeDisabled();
  expect(server.writes).toHaveLength(0);
});

test('a conflicting dashboard edit shows an error, performs no write and allows a reviewed retry', async ({
  page,
}) => {
  const server = await serve(page);
  await chart(page);
  const dialog = await destination(page, classic.dashboardId);
  const latest = {
    ...server.current(),
    modified: '2026-10-11T12:00:00Z',
    description: 'Changed by another session',
    future: { important: [4, 5, 6] },
  };
  server.replace(latest);
  await dialog.getByRole('button', { name: 'Add chart', exact: true }).click();
  await expect(
    dialog.getByText('This dashboard changed. Review the latest version and add the chart again.', {
      exact: true,
    }),
  ).toBeVisible();
  expect(server.writes).toHaveLength(0);
  await expect(dialog.getByRole('button', { name: 'Add chart', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Add chart', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(server.writes).toHaveLength(1);
  const added = server.writes[0].body.tiles!.at(-1)!;
  expect(server.writes[0].body).toEqual({ ...latest, tiles: [...latest.tiles!, added] });
  expect(added.chartQuery).toBe(executed);
});

test('HTTP 409 keeps the dashboard dialog and configuration available without reporting success', async ({
  page,
}) => {
  const server = await serve(page);
  await chart(page);
  const original = server.current();
  const dialog = await destination(page, classic.dashboardId);
  server.rejectUpdate();
  await dialog.getByRole('button', { name: 'Add chart', exact: true }).click();
  await expect(dialog.getByText('Dashboard save conflict', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Add chart', exact: true })).toBeEnabled();
  await expect(dialog.getByLabel('Dashboard', { exact: true })).toHaveValue(classic.dashboardId);
  await expect(dialog.getByLabel('Dataset', { exact: true })).toHaveValue('app-logs');
  await expect(page.getByText('Chart added to', { exact: false })).toHaveCount(0);
  expect(server.writes).toHaveLength(1);
  expect(server.current()).toEqual(original);
  expect(server.writes[0].body.tiles!.at(-1)!.chartQuery).toBe(executed);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByLabel('Chart title', { exact: true })).toHaveValue('Requests by service');
  await expect(page.getByRole('list', { name: 'Y axis fields', exact: true })).toContainText(
    'requests',
  );
});
