import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFile } from 'node:fs/promises';
import { createUlid } from '../src/lib/ids';
import ingestDemoTile from '../src/features/dashboards/__fixtures__/ingest-demo-tile.json' with { type: 'json' };
import classic from '../src/features/dashboards/__fixtures__/classic.json' with { type: 'json' };
import type { Dashboard, DashboardSummary } from '../src/lib/types';
const id = classic.dashboardId;
const detail = `/dashboards/${id}`;
const tile = (page: Page, name: string) =>
  page.locator('[data-tile-id]').filter({ has: page.getByRole('heading', { name, exact: true }) });
async function demo(page: Page, path = '/dashboards') {
  await page.addInitScript(() => sessionStorage.setItem('parseable-mode', 'demo'));
  await page.goto(path);
  await expect(page.getByRole('heading').first()).toBeVisible();
}
async function tileAction(page: Page, title: string, action: string) {
  await page.getByRole('button', { name: `Actions for tile ${title}`, exact: true }).click();
  await page.getByRole('menuitem', { name: action, exact: true }).click();
}
async function addSql(page: Page, title: string, dataset = 'application_logs') {
  await page.getByRole('button', { name: 'Add tile', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Add tile', exact: true });
  await editor.getByLabel('Tile title').fill(title);
  await editor.getByLabel('Dataset', { exact: true }).selectOption(dataset);
  await editor
    .getByRole('textbox', { name: 'SQL query', exact: true })
    .fill(`SELECT COUNT(*) AS events FROM "${dataset}"`);
  await editor.getByLabel('Chart type').selectOption('query-value');
  await editor.getByRole('button', { name: 'Add tile', exact: true }).click();
}
async function axe(page: Page) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addStyleTag({
    content: '*, *::before, *::after { animation: none !important; transition: none !important; }',
  });
  await page.evaluate(async () => {
    await Promise.allSettled(document.getAnimations().map((animation) => animation.finished));
  });
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
}
type Call = {
  path: string;
  method: string;
  body?: Record<string, unknown>;
  params: URLSearchParams;
};
async function mockServer(
  page: Page,
  options: {
    document?: Dashboard;
    enabled?: boolean;
    denied?: string;
    denyWrite?: boolean;
    rows?: DashboardSummary[];
    failTitle?: string;
    privilege?: string;
    queryRows?: Record<string, unknown>[];
  } = {},
) {
  let current = structuredClone(options.document ?? classic) as Dashboard,
    clock = 0;
  const writes: Dashboard[] = [],
    creates: Dashboard[] = [],
    calls: Call[] = [];
  const documents = new Map<string, Dashboard>([[current.dashboardId, current]]);
  await page.context().addCookies([
    { name: 'user_id', value: 'admin', url: 'http://127.0.0.1:5173' },
    { name: 'username', value: 'admin', url: 'http://127.0.0.1:5173' },
  ]);
  await page.route('**/api/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname,
      method = request.method();
    const body = request.postData()
      ? path.startsWith('/prometheus')
        ? Object.fromEntries(new URLSearchParams(request.postData()!))
        : request.postDataJSON()
      : undefined;
    calls.push({ path, method, body, params: url.searchParams });
    if (path === options.denied)
      return route.fulfill({ status: 403, body: 'Dashboard permission denied' });
    if (path === '/api/v1/about')
      return route.fulfill({
        json: {
          capabilities: {
            promql: true,
            promqlDashboard: options.enabled ?? true,
            promqlMetadata: options.enabled ?? true,
            promqlAlerts: true,
          },
        },
      });
    if (path === '/api/v1/users/admin')
      return route.fulfill({ json: { id: 'admin', username: 'admin' } });
    if (path === '/api/v1/user/admin/role')
      return route.fulfill({
        json: {
          roles: {
            root: { actions: [{ privilege: options.privilege ?? 'admin' }], roleType: 'internal' },
          },
          groupRoles: {},
        },
      });
    if (path === '/api/v1/logstream')
      return route.fulfill({ json: [{ name: 'app-logs' }, { name: 'otel-metrics' }] });
    if (path.endsWith('/info'))
      return route.fulfill({
        json: {
          logSource: [
            { log_source_format: path.includes('otel-metrics') ? 'otel-metrics' : 'json' },
          ],
        },
      });
    if (path === '/api/v1/targets') return route.fulfill({ json: [] });
    if (path === '/api/v1/dashboards') {
      if (method === 'POST') {
        if (body.title === options.failTitle)
          return route.fulfill({ status: 403, body: 'Import denied' });
        if ([...documents.values()].some((value) => value.title === body.title))
          return route.fulfill({
            status: 400,
            body: 'Cannot perform this operation: Dashboard title must be unique',
          });
        const doc = {
          ...body,
          author: classic.author,
          dashboardId: createUlid(),
          created: '2026-10-10T08:00:00Z',
          modified: `2026-10-10T08:00:${String(++clock).padStart(2, '0')}Z`,
          version: 'v1',
          tenantId: null,
          dashboardType: body.dashboardType ?? 'Dashboard',
          tiles: body.tiles ?? [],
        } as Dashboard;
        documents.set(doc.dashboardId, doc);
        creates.push(doc);
        return route.fulfill({ json: doc });
      }
      return route.fulfill({
        json:
          options.rows ??
          [...documents.values()].map(
            ({ title, author, dashboardId, created, modified, tags, isFavorite }) => ({
              title,
              author,
              dashboardId,
              created,
              modified,
              tags,
              isFavorite,
            }),
          ),
      });
    }
    if (path.startsWith('/api/v1/dashboards/')) {
      const requestedId = path.split('/').at(-1)!;
      if (method === 'PUT') {
        if (options.denyWrite)
          return route.fulfill({ status: 403, body: 'Dashboard update denied' });
        const favourite = url.searchParams.get('isFavorite');
        if (favourite !== null && body) return route.fulfill({ status: 400, body: 'Both' });
        if (!body && favourite === null) return route.fulfill({ status: 400, body: 'No body' });
        if (body) writes.push(structuredClone(body));
        const doc = {
          ...(body ?? { ...documents.get(requestedId)!, isFavorite: favourite === 'true' }),
          modified: `2026-10-10T08:01:${String(++clock).padStart(2, '0')}Z`,
        } as Dashboard;
        documents.set(requestedId, doc);
        if (requestedId === id) current = doc;
        return route.fulfill({ json: doc });
      }
      if (method === 'DELETE') {
        documents.delete(requestedId);
        return route.fulfill({ status: 200, body: '' });
      }
      const doc = documents.get(requestedId);
      return route.fulfill(
        doc
          ? { json: doc }
          : { status: 400, body: 'Cannot perform this operation: Dashboard does not exist' },
      );
    }
    if (path === '/api/v1/query')
      return route.fulfill({
        json: options.queryRows ?? [{ time: '2026-10-10T08:00:00Z', events: 12 }],
      });
    if (path.startsWith('/prometheus/api/v1/label/'))
      return route.fulfill({
        json: {
          status: 'success',
          data: path.includes('/__name__/') ? ['up'] : ['node-a', 'node-b'],
        },
      });
    if (path === '/prometheus/api/v1/labels')
      return route.fulfill({ json: { status: 'success', data: ['host'] } });
    if (path === '/prometheus/api/v1/query_range')
      return route.fulfill({
        json: {
          status: 'success',
          data: {
            resultType: 'matrix',
            result: [
              {
                metric: { host: body?.query?.toString().includes('node-b') ? 'node-b' : 'node-a' },
                values: [
                  [Date.now() / 1000 - 30, '3'],
                  [Date.now() / 1000, '4'],
                ],
              },
            ],
          },
        },
      });
    if (path === '/prometheus/api/v1/query')
      return route.fulfill({
        json: {
          status: 'success',
          data: {
            resultType: 'vector',
            result: [{ metric: { host: 'node-a' }, value: [Date.now() / 1000, '4'] }],
          },
        },
      });
    return route.fulfill({ status: 404, body: `Unhandled mock ${path}` });
  });
  return {
    writes,
    creates,
    calls,
    change: (edits: Partial<Dashboard>) => {
      current = {
        ...current,
        ...edits,
        modified: `2026-10-10T08:02:${String(++clock).padStart(2, '0')}Z`,
      };
      documents.set(id, current);
    },
    current: () => current,
  };
}

test('demo CRUD, SQL tile preview/config, duplicate/move and typed deletion', async ({ page }) => {
  await demo(page);
  await page.getByRole('button', { name: 'Create dashboard', exact: true }).click();
  const create = page.getByRole('dialog', { name: 'Create dashboard', exact: true });
  await create.getByLabel('Dashboard title').fill('Signals test');
  await create.getByLabel('Tags', { exact: true }).fill('ops, demo');
  await create.getByLabel('Description').fill('A saved description');
  await create.locator('[data-dialog-confirm]').click();
  await expect(page.getByRole('heading', { name: 'Signals test', exact: true })).toBeVisible();
  await addSql(page, 'Events');
  await expect(tile(page, 'Events').getByLabel('Events value')).toContainText('100');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();
  await tileAction(page, 'Events', 'Edit');
  const editor = page.getByRole('dialog', { name: 'Edit tile', exact: true });
  await editor.getByLabel('Tile title').fill('Total events');
  await editor.getByLabel('Unit', { exact: true }).fill('events');
  await editor.getByLabel('Precision').fill('0');
  await editor.getByRole('button', { name: 'Run query', exact: true }).click();
  await expect(editor.getByLabel('Total events value')).toContainText('100 events');
  await editor.getByRole('button', { name: 'Apply tile', exact: true }).click();
  await tileAction(page, 'Total events', 'Duplicate tile');
  await expect(tile(page, 'Total events (Copy)')).toBeVisible();
  await tileAction(page, 'Total events (Copy)', 'Move earlier');
  await expect(page.locator('[data-tile-id] h2').first()).toHaveText('Total events (Copy)');
  await tileAction(page, 'Total events (Copy)', 'Delete tile');
  await page
    .getByRole('dialog', { name: 'Delete tile?', exact: true })
    .getByRole('button', { name: 'Delete tile', exact: true })
    .click();
  await expect(tile(page, 'Total events (Copy)')).toHaveCount(0);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: 'Dashboard actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Duplicate dashboard', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Signals test (Copy)', exact: true }),
  ).toBeVisible();
  await expect(tile(page, 'Total events')).toBeVisible();
  await page.getByRole('button', { name: 'Dashboard actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Delete dashboard', exact: true }).click();
  const deletion = page.getByRole('dialog', { name: 'Delete dashboard', exact: true });
  await deletion.getByLabel('Confirmation name').fill('Signals test (Copy)');
  await deletion.locator('[data-dialog-confirm]').click();
  await expect(page.getByRole('heading', { name: 'Dashboards', exact: true })).toBeVisible();
});

test('list favourites and rename preserve the full document; typed deletion restores focus', async ({
  page,
}) => {
  const source = {
    ...classic,
    isFavorite: false,
    tags: ['svc,api', ' repeated ', ' repeated '],
    description: ' keep whitespace ',
  };
  const server = await mockServer(page, { document: source });
  await page.goto('/dashboards');
  await page.getByRole('button', { name: `Favourite ${source.title}`, exact: true }).click();
  await expect(
    page.getByRole('button', { name: `Unfavourite ${source.title}`, exact: true }),
  ).toBeEnabled();
  const favourite = server.calls.find((call) => call.method === 'PUT')!;
  expect(favourite.body).toBeUndefined();
  expect(favourite.params.get('isFavorite')).toBe('true');
  expect(server.writes).toHaveLength(0);
  expect(server.current()).toEqual({ ...source, isFavorite: true, modified: expect.any(String) });
  const beforeRename = structuredClone(server.current());
  await page.getByRole('button', { name: `Actions for ${source.title}`, exact: true }).click();
  await page.getByRole('menuitem', { name: 'Rename and tags', exact: true }).click();
  const form = page.getByRole('dialog', { name: 'Rename and tags', exact: true });
  await form.getByLabel('Dashboard title').fill('Renamed service');
  await form.locator('[data-dialog-confirm]').click();
  await expect(page.getByRole('link', { name: 'Renamed service', exact: true })).toBeVisible();
  expect(server.writes[0]).toEqual({ ...beforeRename, title: 'Renamed service' });
  await page.getByRole('button', { name: 'Actions for Renamed service', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
  const deletion = page.getByRole('dialog', { name: 'Delete dashboard', exact: true });
  await expect(deletion.locator('[data-dialog-confirm]')).toBeDisabled();
  await deletion.getByLabel('Confirmation name').fill('Renamed service');
  await deletion.locator('[data-dialog-confirm]').click();
  await expect(page.getByRole('link', { name: 'Renamed service', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Search dashboards')).toBeFocused();
});

test('demo PromQL tile add/edit/delete and variable selection', async ({ page }) => {
  await demo(page, '/dashboards/01M4J000000000000000000002');
  await expect(tile(page, 'Host load').getByRole('img')).toHaveAccessibleName(/4 series from/);
  await page.getByLabel('Host', { exact: true }).selectOption({ label: 'All' });
  await expect(page).toHaveURL(/var-host=\.\*/);
  await page.getByRole('button', { name: 'Add tile', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Add tile', exact: true });
  await editor.getByLabel('Tile title').fill('Metric stat');
  await editor.getByLabel('Query language').selectOption('promql');
  await editor.getByLabel('Dataset', { exact: true }).selectOption('$metrics_dataset');
  await editor
    .getByRole('textbox', { name: 'PromQL query A', exact: true })
    .fill('{__name__="system.cpu.load_average.1m",host=~"$host"}');
  await editor.getByLabel('Chart type').selectOption('query-value');
  await editor.getByRole('button', { name: 'Add tile', exact: true }).click();
  await expect(tile(page, 'Metric stat').getByLabel('Metric stat value')).toHaveText(/^\d/);
  await tileAction(page, 'Metric stat', 'Edit');
  await page.getByRole('dialog').getByLabel('Tile title').fill('Edited metric');
  await page.getByRole('button', { name: 'Apply tile', exact: true }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();
  await tileAction(page, 'Edited metric', 'Delete tile');
  await page.getByRole('button', { name: 'Delete tile', exact: true }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();
  await page.getByTestId('sidebar-dashboards').click();
  await page.getByRole('link', { name: 'Host metrics', exact: true }).click();
  await expect(tile(page, 'Host load').getByRole('img')).toHaveAccessibleName(/4 series from/);
  await expect(tile(page, 'Edited metric')).toHaveCount(0);
});

test('a full-document PUT changes one tile title and keeps every classic field', async ({
  page,
}) => {
  const source = structuredClone(classic);
  source.tiles[0].layout.h = 30;
  const server = await mockServer(page, { document: source });
  await page.goto(detail);
  await expect(tile(page, 'Host load').getByRole('img')).toHaveAccessibleName(/1 series from/);
  await tileAction(page, 'Host load', 'Edit');
  await expect(page.getByLabel('Height (rows)')).toHaveValue('24');
  await page.getByLabel('Height (rows)').focus();
  await page.getByRole('dialog').getByLabel('Tile title').fill('Edited host load');
  await page.getByRole('button', { name: 'Apply tile', exact: true }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Dashboard saved.', { exact: true })).toBeVisible();
  const expected = structuredClone(source);
  expected.tiles[0].title = 'Edited host load';
  expect(server.writes).toEqual([expected]);
  expect(server.calls.some((call) => call.path.endsWith('/add_tile'))).toBe(false);
});

test('conflict Reload discards my edits and Overwrite saves the explicit copy', async ({
  page,
}) => {
  const server = await mockServer(page);
  await page.goto(detail);
  await tileAction(page, 'Host load', 'Edit');
  await page.getByRole('dialog').getByLabel('Tile title').fill('My edit');
  await page.getByRole('button', { name: 'Apply tile', exact: true }).click();
  server.change({ title: 'Server title' });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const conflict = page.getByRole('dialog', {
    name: 'Dashboard changed on the server',
    exact: true,
  });
  await expect(conflict).toBeVisible();
  expect(server.writes).toHaveLength(0);
  await conflict.getByRole('button', { name: 'Reload', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Server title', exact: true })).toBeVisible();
  await expect(tile(page, 'Host load')).toBeVisible();
  await tileAction(page, 'Host load', 'Edit');
  await page.getByRole('dialog').getByLabel('Tile title').fill('My overwrite');
  await page.getByRole('button', { name: 'Apply tile', exact: true }).click();
  server.change({ title: 'Another server title' });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await conflict.getByRole('button', { name: 'Overwrite', exact: true }).click();
  await expect(page.getByText('Dashboard saved.', { exact: true })).toBeVisible();
  expect(server.writes[0].title).toBe('Server title');
  expect(server.writes[0].tiles![0].title).toBe('My overwrite');
});

test('variables re-query SQL and PromQL with concrete request bodies; selections stay in the URL', async ({
  page,
}) => {
  const doc = {
    ...classic,
    variables: [
      ...classic.variables,
      { name: 'level', label: 'Level', type: 'list', options: ['error', 'warn'], includeAll: true },
    ],
    tiles: [
      classic.tiles[0],
      {
        ...classic.tiles[1],
        tileType: 'code',
        chartQuery: 'SELECT COUNT(*) AS events FROM "app-logs" WHERE level=\'$level\'',
      },
    ],
  } as Dashboard;
  const server = await mockServer(page, { document: doc });
  await page.goto(detail);
  await expect(tile(page, 'Host load').getByRole('img')).toHaveAccessibleName(/1 series from/);
  await page.getByLabel('Host', { exact: true }).selectOption('node-b');
  await page.getByLabel('Level', { exact: true }).selectOption('warn');
  await expect
    .poll(
      () =>
        server.calls.filter((call) => call.path === '/prometheus/api/v1/query_range').at(-1)?.body
          ?.query,
    )
    .toContain('host=~"node-b"');
  await expect
    .poll(() => server.calls.filter((call) => call.path === '/api/v1/query').at(-1)?.body?.query)
    .toContain("level='warn'");
  await expect(page).toHaveURL(/var-host=node-b/);
  await expect(page).toHaveURL(/var-level=warn/);
  await page.getByRole('button', { name: 'Add variable', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Add variable', exact: true });
  await editor.getByLabel('Variable name').fill('note');
  await editor.getByLabel('Variable label').fill('Note');
  await editor.getByLabel('Variable type').selectOption('text');
  await editor.getByLabel('Default value').fill('default');
  await editor.getByRole('button', { name: 'Add variable', exact: true }).click();
  await page.getByLabel('Note', { exact: true }).fill('selection');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Dashboard saved.', { exact: true })).toBeVisible();
  expect(server.writes[0].variables).toContainEqual({
    name: 'note',
    label: 'Note',
    type: 'text',
    defaultValue: 'default',
  });
  expect(server.writes[0]).not.toHaveProperty('variableValues');
});

test('non-owners see read-only tiles, including unknown and unavailable chart placeholders', async ({
  page,
}) => {
  await mockServer(page, {
    document: { ...classic, author: 'another-owner' },
    privilege: 'reader',
  });
  await page.goto(`${detail}/`);
  await expect(
    page.getByText(
      'This dashboard is read-only. Only its owner can edit it. Duplicate it to make an editable copy.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add tile', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
  await expect(tile(page, 'AI summary')).toContainText('AI tiles cannot be shown');
  await expect(tile(page, 'Distribution')).toContainText(
    'Pie charts are not available in /next yet.',
  );
  await expect(tile(page, 'Distribution').getByRole('link', { name: /classic UI/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Actions for tile Host load', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Edit', exact: true })).toHaveCount(0);
});

test('PromQL capability off prevents authoring and querying without hiding stored tiles', async ({
  page,
}) => {
  const server = await mockServer(page, {
    enabled: false,
    document: { ...classic, tiles: [classic.tiles[0], classic.tiles[1]] },
  });
  await page.goto(detail);
  await expect(tile(page, 'Host load')).toContainText('PromQL dashboard tiles are unavailable');
  await expect(tile(page, 'Errors').getByRole('img')).toHaveAccessibleName(/1 series from/);
  await expect(page.getByLabel('Host', { exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Add tile', exact: true }).click();
  await expect(page.getByLabel('Query language').locator('option[value="promql"]')).toBeDisabled();
  await expect(
    page
      .getByLabel('Dataset', { exact: true })
      .getByRole('option', { name: 'app-logs', exact: true }),
  ).toHaveCount(1);
  await page.waitForLoadState('networkidle');
  expect(server.calls.filter((call) => call.path.startsWith('/prometheus'))).toHaveLength(0);
});

test('403 reads and saves stay inline without signing the user out', async ({ page }) => {
  await mockServer(page, { denied: '/api/v1/dashboards' });
  await page.goto('/dashboards');
  await expect(page.getByRole('heading', { name: 'Permission denied', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Explore demo data', exact: true })).toHaveCount(0);
  await page.unroute('**/api/**');
  const server = await mockServer(page, { denyWrite: true });
  await page.goto(detail);
  await tileAction(page, 'Host load', 'Edit');
  await page.getByRole('dialog').getByLabel('Tile title').fill('Denied edit');
  await page.getByRole('button', { name: 'Apply tile', exact: true }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Dashboard update denied');
  await expect(page).toHaveURL(new RegExp(detail));
  await expect(page.getByText('Unsaved changes', { exact: true })).toBeVisible();
  expect(server.writes).toHaveLength(0);
});

test('builder conversion requires confirmation and a stored pie type is retained on title edit', async ({
  page,
}) => {
  const server = await mockServer(page);
  await page.goto(detail);
  await tileAction(page, 'Errors', 'Edit as SQL');
  const confirmation = page.getByRole('dialog', { name: 'Edit builder tile as SQL?', exact: true });
  await expect(confirmation).toContainText("visual builder isn't available");
  await confirmation.getByRole('button', { name: 'Edit as SQL', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Edit tile' })
    .getByRole('button', { name: 'Apply tile', exact: true })
    .click();
  await tileAction(page, 'Distribution', 'Edit');
  await expect(page.getByLabel('Chart type')).toHaveValue('pie');
  await page.getByRole('dialog').getByLabel('Tile title').fill('Saved pie');
  await page.getByRole('button', { name: 'Apply tile', exact: true }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Dashboard saved.', { exact: true })).toBeVisible();
  expect(server.writes[0].tiles![1].tileType).toBe('code');
  expect(server.writes[0].tiles![3]).toEqual({ ...classic.tiles[3], title: 'Saved pie' });
});

test('list uses limit=0, 25-row pagination, search, tabs, tag filters and sorting', async ({
  page,
}) => {
  const rows = Array.from({ length: 31 }, (_, index) => ({
    ...classic,
    dashboardId: createUlid(),
    title: `Dashboard ${String(index).padStart(2, '0')}`,
    author: index % 2 ? 'other' : classic.author,
    isFavorite: index % 3 === 0,
    tags: [index % 2 ? 'shared' : 'mine'],
  }));
  const server = await mockServer(page, { rows });
  await page.goto('/dashboards');
  await expect(page.getByText('Page 1 of 2', { exact: true })).toBeVisible();
  await expect(page.locator('tbody tr')).toHaveCount(25);
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page.locator('tbody tr')).toHaveCount(6);
  await page.getByRole('tab', { name: 'Mine', exact: true }).click();
  await expect(page.locator('tbody tr')).toHaveCount(16);
  await page.getByRole('tab', { name: 'Favourites', exact: true }).click();
  await expect(page.locator('tbody tr')).toHaveCount(11);
  await page.getByRole('tab', { name: 'All', exact: true }).click();
  await page.getByLabel('Filter by tag').selectOption('shared');
  await expect(page.locator('tbody tr')).toHaveCount(15);
  await page.getByLabel('Search dashboards').fill('09');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await page.getByLabel('Search dashboards').fill('');
  await page.getByLabel('Filter by tag').selectOption('');
  await page.getByRole('button', { name: 'Sort ascending', exact: true }).click();
  await expect(page.locator('tbody tr').first()).toContainText('Dashboard 30');
  expect(server.calls.find((call) => call.path === '/api/v1/dashboards')?.params.get('limit')).toBe(
    '0',
  );
  await page.waitForLoadState('networkidle');
  expect(server.calls.filter((call) => call.path.startsWith('/api/v1/dashboards/'))).toHaveLength(
    0,
  );
});

test('import accepts a file with promql_query, empty tiles and timeRange; export matches classic', async ({
  page,
}) => {
  const server = await mockServer(page);
  await page.goto('/dashboards');
  await page.getByRole('button', { name: 'Import dashboard', exact: true }).click();
  const importer = page.getByRole('dialog', { name: 'Import dashboard', exact: true });
  await importer.getByLabel('Dashboard title').fill('File import');
  const input = { ...classic, tiles: [] };
  await importer.getByLabel('Upload JSON').setInputFiles({
    name: 'classic.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(input)),
  });
  await importer.locator('[data-dialog-confirm]').click();
  await expect(page.getByRole('heading', { name: 'File import', exact: true })).toBeVisible();
  expect(server.creates[0].variables).toEqual(classic.variables);
  expect(server.creates[0].timeRange).toEqual(classic.timeRange);
  expect(server.creates[0].tiles).toEqual([]);
  await page.getByRole('button', { name: 'Dashboard actions', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: 'Export JSON', exact: true }).click();
  const downloaded = await download;
  const output = test.info().outputPath('export.json');
  await downloaded.saveAs(output);
  const exported = JSON.parse(await readFile(output, 'utf8'));
  expect(Object.keys(exported)).toEqual(['tags', 'variables', 'sections', 'tiles']);
  expect(exported.variables).toEqual(classic.variables);
  await page
    .getByRole('navigation', { name: 'Dashboard breadcrumb' })
    .getByRole('link', { name: 'Dashboards', exact: true })
    .click();
  await page.getByRole('button', { name: 'Import dashboard', exact: true }).click();
  await importer.getByLabel('Dashboard title').fill('Paste import');
  await importer.getByLabel('Paste dashboard JSON').fill('{"tiles":[]}');
  await importer.locator('[data-dialog-confirm]').click();
  await expect(page.getByRole('heading', { name: 'Paste import', exact: true })).toBeVisible();
});

test('live local import retains copies, records identity and requires explicit removal', async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      'parseable-dashboards-v1-live',
      JSON.stringify([
        { id: 'local-one', title: 'Local volume', description: 'Keep me', dataset: 'app-logs' },
      ]),
    ),
  );
  const server = await mockServer(page);
  await page.goto('/dashboards');
  await page.getByRole('button', { name: 'Import local dashboards', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Remove local copies', exact: true }),
  ).toBeVisible();
  expect(server.creates[0]).toMatchObject({
    description: 'Keep me',
    tiles: [
      { tileType: 'code', dbName: ['app-logs'], chartQuery: expect.stringContaining('date_trunc') },
    ],
  });
  expect(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem('parseable-dashboards-import-v1:admin')!).importedIds,
    ),
  ).toEqual(['local-one']);
  expect(
    await page.evaluate(() => localStorage.getItem('parseable-dashboards-v1-live')),
  ).not.toBeNull();
  await page.getByRole('button', { name: 'Remove local copies', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: 'Remove local copies?', exact: true });
  await confirmation.getByRole('button', { name: 'Remove local copies', exact: true }).click();
  expect(
    await page.evaluate(() => localStorage.getItem('parseable-dashboards-v1-live')),
  ).toBeNull();
});

test('local import reports partial failures and Don’t ask again dismisses the notice for this identity', async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      'parseable-dashboards-v1-live',
      JSON.stringify([
        { id: 'ok', title: 'Good', description: '', dataset: 'app-logs' },
        { id: 'bad', title: 'Bad', description: '', dataset: 'app-logs' },
      ]),
    ),
  );
  await mockServer(page, { failTitle: 'Bad' });
  await page.goto('/dashboards');
  await page.getByRole('button', { name: 'Import local dashboards', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Bad: Import denied');
  await expect(page.getByRole('button', { name: 'Remove local copies', exact: true })).toHaveCount(
    0,
  );
  await page.getByRole('button', { name: "Don't ask again", exact: true }).click();
  await page.reload();
  await expect(page.getByRole('link', { name: classic.title, exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Import local dashboards', exact: true }),
  ).toHaveCount(0);
});

test('create-alert URLs are concrete; All is disabled with a tooltip; classic SQL links prefill', async ({
  page,
}) => {
  await mockServer(page);
  await page.goto(detail);
  await expect(tile(page, 'Host load').getByRole('img')).toHaveAccessibleName(/1 series from/);
  await page.getByLabel('Host', { exact: true }).selectOption({ label: 'All' });
  await page.getByRole('button', { name: 'Actions for tile Host load', exact: true }).click();
  const disabled = page.getByRole('menuitem', { name: 'Create alert', exact: true });
  await expect(disabled).toBeDisabled();
  await expect(disabled).toHaveAttribute('aria-disabled', 'true');
  await disabled.focus();
  await expect(disabled).toHaveAccessibleDescription(
    'Select explicit variable values instead of All to create an alert.',
  );
  await disabled.press('Enter');
  await expect(page).toHaveURL(new RegExp(detail));
  await page.keyboard.press('Escape');
  await page.getByLabel('Host', { exact: true }).selectOption('node-b');
  await tileAction(page, 'Host load', 'Create alert');
  await expect(page.getByRole('heading', { name: 'New alert', exact: true })).toBeVisible();
  const url = new URL(page.url());
  expect(url.pathname).toBe('/alerts/new');
  expect(url.searchParams.get('dataset')).toBe('otel-metrics');
  expect(url.searchParams.get('alertQuery')).toContain('host=~"node-b"');
  expect(url.searchParams.get('queryBuilderType')).toBe('promql');
  expect(url.searchParams.get('title')).toBe('Host load');
  await page.goto(
    '/alerts/create?' +
      new URLSearchParams({
        dataset: 'app-logs',
        queryBuilderType: 'builder',
        alertQuery: 'SELECT COUNT(*) FROM "app-logs"',
        title: 'SQL panel',
      }),
  );
  await expect(page).toHaveURL(/\/alerts\/new\?/);
  await expect(page.getByRole('textbox', { name: 'SQL query', exact: true })).toHaveText(
    'SELECT COUNT(*) FROM "app-logs"',
  );
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue('SQL panel');
});

const blocksUnload = (page: Page) =>
  page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });

test('an unsaved time range stays saveable without prompting on leave', async ({ page }) => {
  await mockServer(page, { document: { ...classic, variables: [], tiles: [classic.tiles[1]] } });
  await page.goto(detail);
  await page.getByLabel('Time range', { exact: true }).selectOption('30m');
  await expect(page.getByText('Unsaved changes', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  let prompts = 0;
  page.on('dialog', async (dialog) => {
    prompts++;
    await dialog.dismiss();
  });
  await page.getByTestId('sidebar-dashboards').click();
  await expect(page.getByRole('heading', { name: 'Dashboards', exact: true })).toBeVisible();
  expect(prompts).toBe(0);
});

test('time ranges refresh every tile and a dirty leave guard lets the user stay or discard', async ({
  page,
}) => {
  const server = await mockServer(page, {
    document: { ...classic, variables: [], tiles: [classic.tiles[1]] },
  });
  await page.goto(detail);
  await page.getByLabel('Time range', { exact: true }).selectOption('30m');
  await expect(page).toHaveURL(/range=30m/);
  await expect(page.getByText('Unsaved changes', { exact: true })).toBeVisible();
  expect(await blocksUnload(page)).toBe(false);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Dashboard saved.', { exact: true })).toBeVisible();
  expect(server.writes[0].timeRange).toMatchObject({
    startTime: '30m',
    endTime: 'now',
    type: 'fixed',
    interval: 1800000,
  });
  const queries = server.calls.filter((call) => call.path === '/api/v1/query').length;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect
    .poll(() => server.calls.filter((call) => call.path === '/api/v1/query').length)
    .toBeGreaterThan(queries);
  await tileAction(page, 'Errors', 'Edit as SQL');
  await page
    .getByRole('dialog', { name: 'Edit builder tile as SQL?', exact: true })
    .getByRole('button', { name: 'Edit as SQL', exact: true })
    .click();
  await page.getByRole('dialog').getByLabel('Tile title').fill('Dirty');
  await page.getByRole('button', { name: 'Apply tile', exact: true }).click();
  expect(await blocksUnload(page)).toBe(true);
  let leave = false,
    handled = 0;
  page.on('dialog', async (dialog) => {
    if (leave) await dialog.accept();
    else await dialog.dismiss();
    handled++;
  });
  await page.getByTestId('sidebar-dashboards').click();
  await expect.poll(() => handled).toBe(1);
  await expect(page.getByRole('heading', { name: classic.title, exact: true })).toBeVisible();
  leave = true;
  await page.getByTestId('sidebar-dashboards').click();
  await expect(page.getByRole('heading', { name: 'Dashboards', exact: true })).toBeVisible();
});

test('a late tile response cannot replace the result of a new variable selection', async ({
  page,
}) => {
  await mockServer(page, {
    document: {
      ...classic,
      variables: [
        {
          name: 'level',
          label: 'Level',
          type: 'list',
          options: ['error', 'warn'],
          defaultValue: 'error',
        },
      ],
      tiles: [
        {
          ...classic.tiles[1],
          tileType: 'code',
          chartType: 'query-value',
          chartQuery: 'SELECT COUNT(*) AS events FROM "app-logs" WHERE level=\'$level\'',
        },
      ],
    },
  });
  let release!: () => void,
    started = false,
    finished = false;
  const oldResponse = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/v1/query', async (route) => {
    const old = route.request().postDataJSON().query.includes("level='error'");
    if (old) {
      started = true;
      await oldResponse;
    }
    await route.fulfill({ json: [{ events: old ? 111 : 222 }] }).catch(() => undefined);
    if (old) finished = true;
  });
  await page.goto(detail);
  await expect.poll(() => started).toBe(true);
  await page.getByLabel('Level', { exact: true }).selectOption('warn');
  await expect(tile(page, 'Errors').getByLabel('Errors value')).toHaveText('222');
  release();
  await expect.poll(() => finished).toBe(true);
  await expect(tile(page, 'Errors').getByLabel('Errors value')).toHaveText('222');
});

test('pending saves freeze document edits and a failed save keeps the complete draft', async ({
  page,
}) => {
  await mockServer(page, { document: { ...classic, tiles: [classic.tiles[0]] } });
  let release!: () => void,
    started = false;
  const saving = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/v1/dashboards/' + id, async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback();
    started = true;
    await saving;
    await route.fulfill({
      status: 400,
      body: 'Cannot perform this operation: User is not authorized',
    });
  });
  await page.goto(detail);
  await tileAction(page, 'Host load', 'Edit');
  await page.getByRole('dialog').getByLabel('Tile title').fill('Keep my edit');
  await page.getByRole('button', { name: 'Apply tile', exact: true }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => started).toBe(true);
  await expect(page.getByRole('button', { name: 'Add tile', exact: true })).toBeDisabled();
  await expect(page.getByLabel('Time range', { exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Actions for tile Keep my edit', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Edit', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  release();
  await expect(page.getByRole('alert')).toContainText('User is not authorized');
  await expect(page.getByText('Unsaved changes', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  await expect(tile(page, 'Keep my edit')).toBeVisible();
});

for (const theme of ['light', 'dark'])
  for (const surface of ['list', 'view', 'editor'])
    test(`axe ${theme} on dashboard ${surface}`, async ({ page }) => {
      await page.addInitScript((theme) => localStorage.setItem('parseable-theme', theme), theme);
      await demo(
        page,
        surface === 'list' ? '/dashboards' : '/dashboards/01M4J000000000000000000001',
      );
      if (surface === 'list')
        await expect(
          page.getByRole('link', { name: 'Application signals', exact: true }),
        ).toBeVisible();
      else
        await expect(tile(page, 'Request duration').getByRole('img')).toHaveAccessibleName(
          /1 series from/,
        );
      if (surface === 'editor') {
        await tileAction(page, 'Request duration', 'Edit');
        await expect(page.getByRole('dialog', { name: 'Edit tile', exact: true })).toBeVisible();
      }
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await axe(page);
    });

test('390px contains list, tiles and the editor; keyboard tile actions remain reachable', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await demo(page);
  const title = page.getByRole('link', { name: 'Application signals', exact: true });
  await expect(title).toBeVisible();
  const titleBox = (await title.boundingBox())!,
    cellBox = (await title.locator('xpath=ancestor::td').boundingBox())!;
  expect(titleBox.x).toBeGreaterThanOrEqual(cellBox.x);
  expect(titleBox.x + titleBox.width).toBeLessThanOrEqual(cellBox.x + cellBox.width);
  expect(titleBox.x + titleBox.width).toBeLessThanOrEqual(390);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
  await page.getByRole('link', { name: 'Application signals', exact: true }).click();
  await expect(tile(page, 'Request duration').getByRole('img')).toHaveAccessibleName(
    /1 series from/,
  );
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
  const actions = page.getByRole('button', {
    name: 'Actions for tile Request duration',
    exact: true,
  });
  const actionBox = (await actions.boundingBox())!;
  expect(actionBox.x).toBeGreaterThanOrEqual(0);
  expect(actionBox.x + actionBox.width).toBeLessThanOrEqual(390);
  await expect
    .poll(() =>
      tile(page, 'Request duration').evaluate(
        (element) => element.scrollHeight - element.clientHeight,
      ),
    )
    .toBeLessThanOrEqual(1);
  expect(
    await tile(page, 'Request duration').evaluate((element) =>
      parseFloat(getComputedStyle(element).paddingLeft),
    ),
  ).toBe(16);
  const chart = tile(page, 'Request duration'),
    xTitle = chart.getByText('Time', { exact: true });
  await expect(xTitle).toBeVisible();
  const axisBox = (await xTitle.boundingBox())!,
    chartBox = (await chart.boundingBox())!;
  expect(axisBox.y + axisBox.height).toBeLessThanOrEqual(chartBox.y + chartBox.height - 16);
  await actions.focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'Edit', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Edit tile', exact: true })).toBeVisible();
  const applyBox = (await page
    .getByRole('button', { name: 'Apply tile', exact: true })
    .boundingBox())!;
  expect(applyBox.x).toBeGreaterThanOrEqual(0);
  expect(applyBox.x + applyBox.width).toBeLessThanOrEqual(390);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
  await axe(page);
  await page.keyboard.press('Escape');
  await page.goto('/dashboards/01M4J000000000000000000002');
  const metrics = tile(page, 'Host load');
  await expect(metrics.getByRole('img')).toHaveAccessibleName(/4 series from/);
  const legend = metrics.getByRole('list', { name: 'Series visibility' });
  expect(await legend.evaluate((element) => getComputedStyle(element).overflowY)).toBe('auto');
  expect(
    await legend.evaluate((element) => element.scrollHeight - element.clientHeight),
  ).toBeGreaterThan(0);
  await legend.hover();
  await page.mouse.wheel(0, 500);
  await expect.poll(() => legend.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  const last = legend.getByRole('button').last();
  await last.focus();
  await expect(last).toBeFocused();
  const lastBox = (await last.boundingBox())!,
    legendBox = (await legend.boundingBox())!;
  expect(lastBox.y).toBeGreaterThanOrEqual(legendBox.y);
  expect(lastBox.y + lastBox.height).toBeLessThanOrEqual(legendBox.y + legendBox.height + 1);
  await last.press('Enter');
  await expect(last).toHaveAttribute('aria-pressed', 'false');
});

test('sections have independent grids at identical coordinates; moves preserve other sections', async ({
  page,
}) => {
  const sections = [
    { sectionId: 'api', title: 'API', isExpanded: false, future: 1 },
    { sectionId: 'db', title: 'DB' },
  ];
  const make = (title: string, sectionId?: string, x = 0) => ({
    ...classic.tiles[1],
    tile_id: createUlid(),
    tileType: 'code',
    chartType: 'query-value',
    title,
    layout: { x, y: 0, w: 6, h: 4 },
    ...(sectionId ? { sectionId } : {}),
  });
  const tiles = [
    make('Unsectioned'),
    make('API first', 'api'),
    make('API second', 'api', 6),
    make('DB first', 'db'),
    make('DB second', 'db', 6),
  ];
  const server = await mockServer(page, {
    document: { ...classic, variables: [], sections, tiles },
  });
  await page.goto(detail);
  for (const name of tiles.map((tile) => tile.title))
    await expect(tile(page, name).getByLabel(`${name} value`)).toHaveText('12');
  await expect(page.locator('.dashboard-section > h2')).toHaveText(['API', 'DB']);
  const a = await tile(page, 'API first').boundingBox(),
    b = await tile(page, 'DB first').boundingBox();
  expect(b!.y).toBeGreaterThan(a!.y + a!.height);
  await tileAction(page, 'API first', 'Move later');
  await expect(
    page.getByRole('region', { name: 'API', exact: true }).locator('[data-tile-id] h2'),
  ).toHaveText(['API second', 'API first']);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();
  expect(server.writes[0].sections).toEqual(sections);
  expect(server.writes[0].tiles![0]).toEqual(tiles[0]);
  expect(server.writes[0].tiles!.slice(3)).toEqual(tiles.slice(3));
});

test('legacy object builder from ingest_demo_data renders, converts and saves a string without editing its SQL', async ({
  page,
}) => {
  const source = { ...ingestDemoTile, dbName: ['app-logs'] };
  const server = await mockServer(page, {
    document: { ...classic, variables: [], sections: [], tiles: [source] },
  });
  await page.route('**/api/v1/query', (route) =>
    route.fulfill({
      json: [
        { time_bucket: new Date().toISOString(), COUNT_severity_number: 9, severity_text: 'ERROR' },
        {
          time_bucket: new Date().toISOString(),
          COUNT_severity_number: 300,
          severity_text: 'INFO',
        },
      ],
    }),
  );
  await page.goto(detail);
  await expect(tile(page, source.title).getByRole('img')).toHaveAccessibleName(/2 series from/);
  for (const label of ['ERROR', 'INFO'])
    await expect(tile(page, source.title).locator('.charts-legend')).toContainText(label);
  await tileAction(page, source.title, 'Edit as SQL');
  await page.getByRole('dialog').getByRole('button', { name: 'Edit as SQL', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Edit tile', exact: true });
  await expect(editor.getByLabel('Tile title')).toBeFocused();
  await editor.getByLabel('Tile title').fill('Converted builder');
  const query =
    'SELECT DATE_TRUNC(\'minute\', "p_timestamp") AS "time_bucket", COUNT("severity_number") AS "COUNT_severity_number", "severity_text" AS "severity_text" FROM "app-logs" GROUP BY "time_bucket", "severity_text" ORDER BY "time_bucket" DESC';
  await expect(editor.getByRole('textbox', { name: 'SQL query', exact: true })).toHaveText(query);
  await editor.getByRole('button', { name: 'Apply tile', exact: true }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();
  expect(server.writes[0].tiles).toEqual([
    { ...source, title: 'Converted builder', tileType: 'code', chartQuery: query },
  ]);
});

test('unknown dollar tokens reach SQL and label_replace tile queries unchanged', async ({
  page,
}) => {
  const sql =
    "SELECT COUNT(*) AS events FROM \"app-logs\" WHERE message='$ $1 $unknown ${missing} $__interval' AND host='$host'";
  const promql = 'label_replace(up{host="$host"}, "copy", "$1", "host", "(.*)$") + $__interval';
  const server = await mockServer(page, {
    document: {
      ...classic,
      variables: [{ name: 'host', label: 'Host', type: 'list', options: ['node-a'] }],
      sections: [],
      tiles: [
        {
          ...classic.tiles[1],
          title: 'Dollar SQL',
          tileType: 'code',
          chartType: 'query-value',
          chartQuery: sql,
        },
        {
          ...classic.tiles[0],
          title: 'Dollar PromQL',
          chartQuery: [promql],
          dbName: 'otel-metrics',
        },
      ],
    },
  });
  await page.goto(detail);
  await expect(tile(page, 'Dollar SQL').getByLabel('Dollar SQL value')).toHaveText('12');
  await expect(tile(page, 'Dollar PromQL').getByRole('img')).toHaveAccessibleName(/1 series from/);
  await page.waitForLoadState('networkidle');
  expect(
    server.calls.filter((call) => call.path === '/api/v1/query').map((call) => call.body?.query),
  ).toEqual([sql.replace('$host', 'node-a')]);
  expect(
    server.calls
      .filter((call) => call.path === '/prometheus/api/v1/query_range')
      .map((call) => call.body?.query),
  ).toEqual([promql.replace('$host', 'node-a')]);
  await expect(page.getByText(/Select a value for this tile/)).toHaveCount(0);
});

test('SQL and PromQL variable definitions with unknown dollar tokens load and remain editable', async ({
  page,
}) => {
  const sql = 'SELECT \'$ $1 $unknown ${missing} $__interval\' FROM "app-logs"';
  const promql = 'label_replace(up, "copy", "$1", "host", "(.*)$")';
  const variables = [
    { name: 'literal', label: 'Literal', type: 'sql' as const, sqlQuery: sql },
    {
      name: 'replacement',
      label: 'Replacement',
      type: 'promql_query' as const,
      promqlQuery: promql,
      promqlQueryDataset: 'otel-metrics',
      promqlQueryLabel: 'host',
    },
  ];
  const server = await mockServer(page, {
    queryRows: [{ events: 12 }],
    document: {
      ...classic,
      variables,
      sections: [],
      tiles: [
        {
          ...classic.tiles[1],
          tileType: 'code',
          chartType: 'query-value',
          chartQuery:
            "SELECT COUNT(*) AS events FROM \"app-logs\" WHERE host='$replacement' AND value='$literal'",
        },
      ],
    },
  });
  await page.goto(detail);
  await expect(page.getByLabel('Literal', { exact: true })).toHaveValue('12');
  await expect(page.getByLabel('Replacement', { exact: true })).toHaveValue('node-a');
  await expect(tile(page, 'Errors').getByLabel('Errors value')).toHaveText('12');
  await page.waitForLoadState('networkidle');
  expect(
    server.calls.some((call) => call.path === '/api/v1/query' && call.body?.query === sql),
  ).toBe(true);
  expect(
    server.calls.some(
      (call) => call.path === '/prometheus/api/v1/query' && call.body?.query === promql,
    ),
  ).toBe(true);
  for (const variable of variables) {
    await page
      .getByRole('button', { name: `Actions for variable ${variable.label}`, exact: true })
      .click();
    await page.getByRole('menuitem', { name: 'Edit variable', exact: true }).click();
    const editor = page.getByRole('dialog', { name: 'Edit variable', exact: true });
    await expect(editor.getByRole('button', { name: 'Apply variable', exact: true })).toBeEnabled();
    await editor.getByLabel('Variable label').fill(`${variable.label} edited`);
    await editor.getByRole('button', { name: 'Apply variable', exact: true }).click();
  }
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();
  expect(server.writes[0].variables).toEqual(
    variables.map((variable) => ({ ...variable, label: `${variable.label} edited` })),
  );
});

test('Move earlier and later follow compacted reading order on a stored layout with gaps', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const tiles = ['A', 'B', 'C'].map((title, index) => ({
    ...classic.tiles[1],
    tile_id: createUlid(),
    title,
    tileType: 'code',
    chartType: 'query-value',
    layout: { x: index === 1 ? 6 : 0, y: [0, 10, 5][index], w: 6, h: 2, future: title },
  }));
  const server = await mockServer(page, {
    document: { ...classic, variables: [], sections: [], tiles },
  });
  const order = () =>
    page.locator('[data-tile-id]').evaluateAll((elements) =>
      elements
        .map((element) => {
          const bounds = element.getBoundingClientRect();
          return { title: element.querySelector('h2')!.textContent, x: bounds.x, y: bounds.y };
        })
        .sort((a, b) => a.y - b.y || a.x - b.x)
        .map((row) => row.title),
    );
  await page.goto(detail);
  for (const title of ['A', 'B', 'C'])
    await expect(tile(page, title).getByLabel(`${title} value`)).toHaveText('12');
  await expect.poll(order).toEqual(['A', 'B', 'C']);
  await page.getByRole('button', { name: 'Actions for tile C', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Move later', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await tileAction(page, 'B', 'Move earlier');
  await expect.poll(order).toEqual(['B', 'A', 'C']);
  await page.getByRole('button', { name: 'Actions for tile B', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Move earlier', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await tileAction(page, 'B', 'Move later');
  await expect.poll(order).toEqual(['A', 'B', 'C']);
  await tileAction(page, 'B', 'Move later');
  await expect.poll(order).toEqual(['A', 'C', 'B']);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();
  expect(server.writes[0].tiles!.map((row) => row.layout)).toEqual([
    { ...tiles[0].layout, y: 0 },
    { ...tiles[1].layout, x: 0, y: 2 },
    { ...tiles[2].layout, x: 6, y: 0 },
  ]);
});

test('tile request counts follow only effective query inputs; range, one variable, refresh and save', async ({
  page,
}) => {
  await page.addInitScript(() => {
    new MutationObserver(() => {
      if (document.querySelector('[role="alert"]'))
        document.documentElement.dataset.sawDashboardAlert = 'true';
    }).observe(document, { childList: true, subtree: true });
  });
  const doc = {
    ...classic,
    sections: [],
    variables: [
      ...classic.variables.slice(0, 2),
      { name: 'level', label: 'Level', type: 'list', options: ['error', 'warn'] },
    ],
    tiles: [
      {
        ...classic.tiles[1],
        tile_id: createUlid(),
        title: 'Filtered',
        tileType: 'code',
        chartType: 'query-value',
        chartQuery:
          'SELECT COUNT(*) AS events FROM "app-logs" WHERE level=\'$level\' /* filtered */',
        layout: { x: 0, y: 0, w: 6, h: 4 },
      },
      {
        ...classic.tiles[1],
        tile_id: createUlid(),
        title: 'Independent',
        tileType: 'code',
        chartType: 'query-value',
        chartQuery: 'SELECT COUNT(*) AS events FROM "app-logs" /* independent */',
        layout: { x: 6, y: 0, w: 6, h: 4 },
      },
      { ...classic.tiles[0], sectionId: undefined, layout: { x: 0, y: 4, w: 12, h: 4 } },
    ],
  } as Dashboard;
  const server = await mockServer(page, { document: doc });
  let navigationPrompts = 0;
  page.on('dialog', async (dialog) => {
    navigationPrompts++;
    await dialog.dismiss();
  });
  const counts = () => ({
    filtered: server.calls.filter(
      (call) =>
        call.path === '/api/v1/query' && String(call.body?.query).includes('/* filtered */'),
    ).length,
    independent: server.calls.filter(
      (call) =>
        call.path === '/api/v1/query' && String(call.body?.query).includes('/* independent */'),
    ).length,
    promql: server.calls.filter((call) => call.path === '/prometheus/api/v1/query_range').length,
  });
  const evidence: Record<string, ReturnType<typeof counts>> = {};
  async function settled(phase: string, expected: ReturnType<typeof counts>) {
    await expect.poll(counts).toEqual(expected);
    await page.waitForLoadState('networkidle');
    expect(counts()).toEqual(expected);
    evidence[phase] = counts();
  }
  await page.goto(detail);
  await expect(tile(page, 'Filtered').getByLabel('Filtered value')).toHaveText('12');
  await expect(tile(page, 'Independent').getByLabel('Independent value')).toHaveText('12');
  await expect(tile(page, 'Host load').getByRole('img')).toHaveAccessibleName(/1 series from/);
  await settled('initial', { filtered: 1, independent: 1, promql: 1 });
  expect(await page.locator('html').getAttribute('data-saw-dashboard-alert')).toBeNull();
  await page.getByLabel('Time range', { exact: true }).selectOption('30m');
  await settled('time range', { filtered: 2, independent: 2, promql: 2 });
  await page.getByLabel('Host', { exact: true }).selectOption('node-b');
  await settled('host variable', { filtered: 2, independent: 2, promql: 3 });
  await page.getByLabel('Level', { exact: true }).selectOption('warn');
  await settled('level variable', { filtered: 3, independent: 2, promql: 3 });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await settled('refresh', { filtered: 4, independent: 3, promql: 4 });
  await tileAction(page, 'Independent', 'Move earlier');
  await settled('move', { filtered: 4, independent: 3, promql: 4 });
  await page.getByRole('button', { name: 'Actions for variable Host', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Edit variable', exact: true }).click();
  await page.getByLabel('Variable label').fill('Renamed host');
  await page.getByRole('dialog').locator('[data-dialog-confirm]').click();
  await settled('variable label', { filtered: 4, independent: 3, promql: 4 });
  await tileAction(page, 'Independent', 'Edit');
  await page.getByRole('dialog').getByLabel('Tile title').fill('Renamed independent');
  await page.getByRole('button', { name: 'Apply tile', exact: true }).click();
  await settled('edit title', { filtered: 4, independent: 3, promql: 4 });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();
  await settled('save', { filtered: 4, independent: 3, promql: 4 });
  expect(navigationPrompts).toBe(0);
  await test.info().attach('tile-request-counts.json', {
    body: JSON.stringify(evidence, null, 2),
    contentType: 'application/json',
  });
});

test('text variables debounce local typing without losing characters or moving the caret', async ({
  page,
}) => {
  const doc = {
    ...classic,
    variables: [{ name: 'text', label: 'Text', type: 'text', defaultValue: 'api-gateway' }],
    sections: [],
    tiles: [
      {
        ...classic.tiles[1],
        tileType: 'code',
        chartType: 'query-value',
        chartQuery: 'SELECT COUNT(*) AS events FROM "app-logs" WHERE name=\'$text\'',
      },
    ],
  } as Dashboard;
  const server = await mockServer(page, { document: doc });
  await page.goto(detail);
  await expect(tile(page, 'Errors').getByLabel('Errors value')).toHaveText('12');
  await page.waitForLoadState('networkidle');
  const before = server.calls.filter((call) => call.path === '/api/v1/query').length;
  const input = page.getByLabel('Text', { exact: true });
  await input.focus();
  await input.evaluate((input: HTMLInputElement) => input.setSelectionRange(4, 4));
  await input.pressSequentially('quick-', { delay: 15 });
  await expect(input).toHaveValue('api-quick-gateway');
  expect(await input.evaluate((input: HTMLInputElement) => input.selectionStart)).toBe(10);
  await input.press('Enter');
  await expect(page).toHaveURL(/var-text=api-quick-gateway/);
  await expect
    .poll(() => server.calls.filter((call) => call.path === '/api/v1/query').length)
    .toBe(before + 1);
  await page.waitForLoadState('networkidle');
  expect(server.calls.filter((call) => call.path === '/api/v1/query')).toHaveLength(before + 1);
  await input.fill('blur-value');
  await input.blur();
  await expect(page).toHaveURL(/var-text=blur-value/);
  await expect
    .poll(() => server.calls.filter((call) => call.path === '/api/v1/query').length)
    .toBe(before + 2);
  await page.waitForLoadState('networkidle');
  expect(server.calls.filter((call) => call.path === '/api/v1/query')).toHaveLength(before + 2);
});

test('duplicate and nil tile ids are repaired on load, so editing and deleting affect one tile', async ({
  page,
}) => {
  const first = { ...classic.tiles[1], tileType: 'code', chartType: 'query-value', title: 'First' };
  const server = await mockServer(page, {
    document: {
      ...classic,
      variables: [],
      sections: [],
      tiles: [
        first,
        { ...first, title: 'Second' },
        { ...first, title: 'Nil', tile_id: '00000000000000000000000000' },
      ],
    },
  });
  await page.goto(detail);
  await expect(page.getByText(/The next save will assign new IDs to 2 tiles/)).toBeVisible();
  await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Discard', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Dashboard actions', exact: true }).click();
  await expect(
    page.getByRole('menuitem', { name: 'Duplicate dashboard', exact: true }),
  ).not.toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Escape');
  const prompts: string[] = [];
  page.on('dialog', async (dialog) => {
    prompts.push(dialog.message());
    await dialog.dismiss();
  });
  await page
    .getByRole('navigation', { name: 'Dashboard breadcrumb' })
    .getByRole('link', { name: 'Dashboards', exact: true })
    .click();
  await expect(page).toHaveURL('/dashboards');
  expect(prompts).toEqual([]);
  await page.getByRole('link', { name: classic.title, exact: true }).click();
  await expect(page.getByText(/assign new IDs to 2 tiles/)).toBeVisible();
  const repairedIds = await page
    .locator('[data-tile-id]')
    .evaluateAll((elements) => elements.map((element) => element.getAttribute('data-tile-id')));
  await tileAction(page, 'Second', 'Edit');
  await page.getByRole('dialog').getByLabel('Tile title').fill('Discard this edit');
  await page.getByRole('button', { name: 'Apply tile', exact: true }).click();
  await expect(page.getByText('Unsaved changes', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();
  await expect(tile(page, 'Second')).toBeVisible();
  expect(
    await page
      .locator('[data-tile-id]')
      .evaluateAll((elements) => elements.map((element) => element.getAttribute('data-tile-id'))),
  ).toEqual(repairedIds);
  await expect(page.getByText(/The next save will assign new IDs/)).toBeVisible();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText(/The next save will assign new IDs/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  expect(server.writes[0].tiles!.map((row) => row.tile_id)).toEqual(repairedIds);
  await tileAction(page, 'Second', 'Edit');
  await page.getByRole('dialog').getByLabel('Tile title').fill('Second edited');
  await page.getByRole('button', { name: 'Apply tile', exact: true }).click();
  await expect(tile(page, 'First').getByLabel('First value')).toHaveText('12');
  await tileAction(page, 'First', 'Delete tile');
  await page.getByRole('dialog').getByRole('button', { name: 'Delete tile', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Actions for tile Second edited', exact: true }),
  ).toBeFocused();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();
  expect(server.writes.at(-1)!.tiles!.map((tile) => tile.title)).toEqual(['Second edited', 'Nil']);
  expect(new Set(server.writes.at(-1)!.tiles!.map((tile) => tile.tile_id)).size).toBe(2);
  await expect(page.getByText(/The next save will assign new IDs/)).toHaveCount(0);
});

for (const privilege of ['reader', 'admin'])
  test(`${privilege} non-owners with repaired tile IDs can leave and duplicate without unsaved changes`, async ({
    page,
  }) => {
    const first = {
      ...classic.tiles[1],
      title: 'First',
      tileType: 'code',
      chartType: 'query-value',
    };
    const server = await mockServer(page, {
      privilege,
      document: {
        ...classic,
        author: 'other',
        variables: [],
        sections: [],
        tiles: [
          first,
          { ...first, title: 'Second' },
          { ...first, title: 'Nil', tile_id: '00000000000000000000000000' },
        ],
      },
    });
    const prompts: string[] = [];
    page.on('dialog', async (dialog) => {
      prompts.push(dialog.message());
      await dialog.dismiss();
    });
    await page.goto(detail);
    await expect(page.getByText(/This dashboard is read-only/)).toBeVisible();
    for (const title of ['First', 'Second', 'Nil'])
      await expect(tile(page, title).getByLabel(`${title} value`)).toHaveText('12');
    await expect(page.getByText(/Saving will assign|next save will assign/)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
    const repairedIds = await page
      .locator('[data-tile-id]')
      .evaluateAll((elements) => elements.map((element) => element.getAttribute('data-tile-id')));
    expect(new Set(repairedIds).size).toBe(3);
    await page
      .getByRole('navigation', { name: 'Dashboard breadcrumb' })
      .getByRole('link', { name: 'Dashboards', exact: true })
      .click();
    await expect(page).toHaveURL('/dashboards');
    expect(prompts).toEqual([]);
    await page.getByRole('link', { name: classic.title, exact: true }).click();
    await page.waitForLoadState('networkidle');
    const workingIds = await page
      .locator('[data-tile-id]')
      .evaluateAll((elements) => elements.map((element) => element.getAttribute('data-tile-id')));
    await page.getByRole('button', { name: 'Dashboard actions', exact: true }).click();
    const duplicate = page.getByRole('menuitem', { name: 'Duplicate dashboard', exact: true });
    await expect(duplicate).not.toHaveAttribute('aria-disabled', 'true');
    await duplicate.click();
    await expect(
      page.getByRole('heading', { name: `${classic.title} (Copy)`, exact: true }),
    ).toBeVisible();
    const ids = server.creates[0].tiles!.map((tile) => tile.tile_id);
    expect(new Set(ids).size).toBe(3);
    expect(
      ids.every(
        (id) =>
          /^[0-9A-HJKMNP-TV-Z]{26}$/.test(id) &&
          id !== '00000000000000000000000000' &&
          !workingIds.includes(id),
      ),
    ).toBe(true);
    expect(server.writes).toEqual([]);
    expect(prompts).toEqual([]);
  });

test('conflict Cancel after an overwrite error keeps the draft dirty and editable', async ({
  page,
}) => {
  const server = await mockServer(page, { denyWrite: true });
  await page.goto(detail);
  await tileAction(page, 'Host load', 'Edit');
  await page.getByRole('dialog').getByLabel('Tile title').fill('Keep this edit');
  await page.getByRole('button', { name: 'Apply tile', exact: true }).click();
  server.change({ title: 'Concurrent' });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const conflict = page.getByRole('dialog', {
    name: 'Dashboard changed on the server',
    exact: true,
  });
  await conflict.getByRole('button', { name: 'Overwrite', exact: true }).click();
  await expect(conflict.getByRole('alert')).toContainText('Dashboard update denied');
  await conflict.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(conflict).toHaveCount(0);
  await expect(tile(page, 'Keep this edit')).toBeVisible();
  await expect(page.getByText('Unsaved changes', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Dashboard update denied');
  await tileAction(page, 'Keep this edit', 'Edit');
  await expect(page.getByLabel('Tile title')).toHaveValue('Keep this edit');
});

test('dependent variables wait for upstream validation; editor allows unknown tokens and rejects cycles', async ({
  page,
}) => {
  const server = await mockServer(page, { document: { ...classic, tiles: [classic.tiles[0]] } });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/v1/logstream', async (route) => {
    await gate;
    await route.fallback();
  });
  await page.goto(`${detail}?var-metrics_dataset=deleted_ds`);
  await expect(page.getByLabel('Metrics dataset', { exact: true })).toBeDisabled();
  expect(server.calls.filter((call) => call.path.startsWith('/prometheus'))).toHaveLength(0);
  release();
  await expect(page.getByLabel('Metrics dataset', { exact: true })).toHaveValue('otel-metrics');
  await expect(tile(page, 'Host load').getByRole('img')).toHaveAccessibleName(/1 series from/);
  await page.waitForLoadState('networkidle');
  expect(
    server.calls
      .filter((call) => call.path.startsWith('/prometheus'))
      .every(
        (call) => call.params.get('stream') !== 'deleted_ds' && call.body?.stream !== 'deleted_ds',
      ),
  ).toBe(true);
  await page.getByRole('button', { name: 'Add variable', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Add variable', exact: true });
  await editor.getByLabel('Variable name').fill('cycle');
  await editor.getByLabel('Variable label').fill('Cycle');
  await editor.getByLabel('Variable type').selectOption('sql');
  await editor.getByRole('textbox', { name: 'SQL query', exact: true }).fill("SELECT '$missing'");
  await expect(editor).not.toContainText('references a variable that does not exist');
  await expect(editor.locator('[data-dialog-confirm]')).toBeEnabled();
  await editor.getByRole('textbox', { name: 'SQL query', exact: true }).fill("SELECT '$cycle'");
  await expect(editor).toContainText('contain a cycle');
  await expect(editor.locator('[data-dialog-confirm]')).toBeDisabled();
});

test('PromQL capabilities load neutrally, recover from errors, and owners avoid a read-only flash', async ({
  page,
}) => {
  await mockServer(page, { document: { ...classic, tiles: [classic.tiles[0]] } });
  await page.addInitScript(() =>
    new MutationObserver(() => {
      if (document.body?.textContent?.includes('This dashboard is read-only.'))
        document.documentElement.dataset.readOnlyFlash = 'true';
    }).observe(document, { childList: true, subtree: true }),
  );
  let release!: () => void,
    fail = true;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/v1/about', async (route) => {
    if (fail) {
      await gate;
      await route.fulfill({ status: 503, body: 'Capabilities temporarily offline' });
    } else await route.fallback();
  });
  await page.goto(detail);
  await expect(tile(page, 'Host load')).toContainText('Loading server capabilities');
  await expect(
    page.getByText('PromQL dashboard tiles are unavailable on this server.', { exact: true }),
  ).toHaveCount(0);
  for (const action of ['Add tile', 'Add variable']) {
    await page.getByRole('button', { name: action, exact: true }).click();
    const editor = page.getByRole('dialog', { name: action, exact: true });
    await expect(editor.getByText('Loading server capabilities…', { exact: true })).toBeVisible();
    await expect(editor).not.toContainText('unavailable');
    await editor.getByRole('button', { name: 'Close dialog', exact: true }).click();
  }
  release();
  await expect(page.getByRole('alert')).toContainText('Capabilities temporarily offline');
  fail = false;
  await page.getByRole('button', { name: 'Retry capabilities', exact: true }).click();
  await expect(tile(page, 'Host load').getByRole('img')).toHaveAccessibleName(/1 series from/);
  await expect(page.getByRole('button', { name: 'Add tile', exact: true })).toBeVisible();
  expect(await page.locator('html').getAttribute('data-read-only-flash')).toBeNull();
});

test('variable load errors stay compact and named; tiles explain failed values without demo links', async ({
  page,
}) => {
  const document = {
    ...classic,
    variables: [
      { name: 'healthy', label: 'Healthy', type: 'text', defaultValue: 'Ready' },
      {
        name: 'host',
        label: 'Host',
        type: 'sql',
        sqlQuery: 'SELECT DISTINCT host FROM "app-logs"',
      },
    ],
    sections: [],
    tiles: [
      {
        ...classic.tiles[1],
        tileType: 'code',
        chartQuery: 'SELECT COUNT(*) FROM "app-logs" WHERE host=\'$host\'',
      },
    ],
  } as Dashboard;
  await mockServer(page, { document });
  await page.route('**/api/v1/query', (route) =>
    route.fulfill({ status: 400, body: 'Values unavailable' }),
  );
  await page.goto(detail);
  const error = page.locator('.dashboard-variable-error');
  await expect(error).toContainText('Could not load values for Host: Values unavailable');
  await expect(page.getByLabel('Healthy', { exact: true })).toHaveValue('Ready');
  const healthy = (await page.getByLabel('Healthy', { exact: true }).boundingBox())!,
    failed = (await page.getByLabel('Host', { exact: true }).boundingBox())!;
  expect(healthy.y).toBe(failed.y);
  expect((await error.boundingBox())!.height).toBeLessThan(120);
  await expect(page.getByLabel('Host', { exact: true })).toHaveAccessibleDescription(
    /Host: Values unavailable/,
  );
  await expect(tile(page, 'Errors')).toContainText(
    'A variable failed to load: host: Values unavailable',
  );
  await expect(tile(page, 'Errors')).not.toContainText('Select a value');
  await expect(page.getByRole('button', { name: 'Explore demo data', exact: true })).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('import rejects files over 5 MB before reading them', async ({ page }) => {
  const server = await mockServer(page);
  await page.goto('/dashboards');
  await page.getByRole('button', { name: 'Import dashboard', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Import dashboard', exact: true });
  await expect(editor.getByLabel('Dashboard title')).toBeFocused();
  await editor.getByLabel('Dashboard title').fill('Large import');
  await editor.getByLabel('Upload JSON').setInputFiles({
    name: 'large.json',
    mimeType: 'application/json',
    buffer: Buffer.alloc(5 * 1024 * 1024 + 1, ' '),
  });
  await expect(editor.getByRole('alert')).toHaveText('Dashboard imports must be 5 MB or smaller.');
  await expect(editor.getByLabel('Paste dashboard JSON')).toHaveValue('');
  await expect(editor.locator('[data-dialog-confirm]')).toBeDisabled();
  expect(server.creates).toEqual([]);
});

for (const privilege of ['reader', 'admin', 'ingestor'])
  test(`${privilege} permissions govern all non-owner controls and disabled favourites`, async ({
    page,
  }) => {
    const server = await mockServer(page, { privilege, document: { ...classic, author: 'other' } });
    await page.goto('/dashboards');
    await page.waitForLoadState('networkidle');
    const favourite = page.getByRole('button', { name: 'Unfavourite Service health', exact: true });
    await expect(favourite).toHaveAttribute('aria-disabled', 'true');
    await favourite.focus();
    await expect(favourite).toHaveAccessibleDescription('Only the owner can change favourites.');
    await favourite.press('Enter');
    await page.waitForLoadState('networkidle');
    expect(server.writes).toEqual([]);
    await page.getByRole('button', { name: 'Actions for Service health', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: 'Rename and tags', exact: true })).toHaveCount(
      0,
    );
    await expect(page.getByRole('menuitem', { name: 'Delete', exact: true })).toHaveCount(
      privilege === 'admin' ? 1 : 0,
    );
    if (privilege === 'ingestor') {
      const duplicate = page.getByRole('menuitem', { name: 'Duplicate', exact: true });
      await expect(duplicate).toHaveAttribute('aria-disabled', 'true');
      await duplicate.press('Enter');
      expect(server.creates).toEqual([]);
    }
    await page.keyboard.press('Escape');
    await page.getByRole('link', { name: classic.title, exact: true }).click();
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Add variable', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Dashboard actions', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: 'Rename and tags', exact: true })).toHaveCount(
      0,
    );
    await expect(page.getByRole('menuitem', { name: 'Delete dashboard', exact: true })).toHaveCount(
      privilege === 'admin' ? 1 : 0,
    );
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Actions for tile Host load', exact: true }).click();
    for (const action of ['Edit', 'Delete tile', 'Duplicate tile', 'Move earlier', 'Move later'])
      await expect(page.getByRole('menuitem', { name: action, exact: true })).toHaveCount(0);
  });

test('favourite toggles the latest row, and list conflicts can be cancelled for further editing', async ({
  page,
}) => {
  const server = await mockServer(page, { document: { ...classic, isFavorite: false } });
  await page.goto('/dashboards');
  await expect(page.getByRole('link', { name: classic.title, exact: true })).toBeVisible();
  server.change({ isFavorite: true });
  await page.getByRole('button', { name: `Favourite ${classic.title}`, exact: true }).click();
  await expect
    .poll(() => server.calls.find((call) => call.method === 'PUT')?.params.get('isFavorite'))
    .toBe('false');
  expect(server.writes).toHaveLength(0);
  await page.getByRole('button', { name: `Actions for ${classic.title}`, exact: true }).click();
  await page.getByRole('menuitem', { name: 'Rename and tags', exact: true }).click();
  await page.getByLabel('Dashboard title').fill('Local rename');
  server.change({ title: 'Remote rename' });
  await page.getByRole('dialog').locator('[data-dialog-confirm]').click();
  const conflict = page.getByRole('dialog', {
    name: 'Dashboard changed on the server',
    exact: true,
  });
  await expect(conflict).toBeVisible();
  await conflict.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByLabel('Dashboard title')).toHaveValue('Local rename');
  await Promise.all([
    page.waitForEvent('dialog').then(async (dialog) => {
      expect(dialog.message()).toBe('Leave without saving this dashboard?');
      await dialog.dismiss();
    }),
    // Invoke route navigation while the restored form is open to exercise its guard.
    page.evaluate(() =>
      document
        .querySelector<HTMLAnchorElement>(
          'nav[aria-label="Main navigation"] a[href="/sql-editor"]',
        )!
        .click(),
    ),
  ]);
  await expect(page).toHaveURL(/\/dashboards$/);
  await expect(page.getByLabel('Dashboard title')).toHaveValue('Local rename');
});

test('list rename patches the latest copy, repairs tile IDs and repeats duplicates under free titles', async ({
  page,
}) => {
  const server = await mockServer(page, {
    document: { ...classic, tiles: [classic.tiles[0], classic.tiles[0]] },
  });
  await page.goto('/dashboards');
  async function rename(from: string, to: string) {
    await page.getByRole('button', { name: `Actions for ${from}`, exact: true }).click();
    await page.getByRole('menuitem', { name: 'Rename and tags', exact: true }).click();
    await page.getByLabel('Dashboard title').fill(to);
  }
  await rename(classic.title, 'Mine');
  server.change({ tags: ['remote'] });
  await page.getByRole('dialog').locator('[data-dialog-confirm]').click();
  await expect(page.getByRole('link', { name: 'Mine', exact: true })).toBeVisible();
  expect(server.writes[0]).toMatchObject({ title: 'Mine', tags: ['remote'] });
  expect(new Set(server.writes[0].tiles!.map((tile) => tile.tile_id)).size).toBe(2);
  await rename('Mine', 'Mine again');
  server.change({ title: 'Theirs', variables: [] });
  await page.getByRole('dialog').locator('[data-dialog-confirm]').click();
  const conflict = page.getByRole('dialog', {
    name: 'Dashboard changed on the server',
    exact: true,
  });
  await conflict.getByRole('button', { name: 'Overwrite', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Mine again', exact: true })).toBeVisible();
  expect(server.writes[1]).toMatchObject({ title: 'Mine again', tags: ['remote'], variables: [] });
  for (const copy of ['Mine again (Copy)', 'Mine again (Copy) (2)']) {
    await page.getByRole('button', { name: 'Actions for Mine again', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Duplicate', exact: true }).click();
    await expect(page.getByRole('heading', { name: copy, exact: true })).toBeVisible();
    await page.goto('/dashboards');
  }
  expect(server.creates.map((doc) => doc.title)).toEqual([
    'Mine again (Copy)',
    'Mine again (Copy) (2)',
  ]);
});

test('created and updated sorts use their distinct dates in both directions', async ({ page }) => {
  const rows = ['A', 'B', 'C'].map((title, index) => ({
    ...classic,
    dashboardId: createUlid(),
    title,
    created: `2026-10-0${index + 1}T00:00:00Z`,
    modified: `2026-10-0${3 - index}T00:00:00Z`,
  }));
  await mockServer(page, { rows });
  await page.goto('/dashboards');
  await page.getByLabel('Sort dashboards').selectOption('created');
  await expect(page.locator('tbody tr a')).toHaveText(['A', 'B', 'C']);
  await page.getByRole('button', { name: 'Sort ascending', exact: true }).click();
  await expect(page.locator('tbody tr a')).toHaveText(['C', 'B', 'A']);
  await page.getByRole('button', { name: 'Sort descending', exact: true }).click();
  await page.getByLabel('Sort dashboards').selectOption('modified');
  await expect(page.locator('tbody tr a')).toHaveText(['C', 'B', 'A']);
  await page.getByRole('button', { name: 'Sort ascending', exact: true }).click();
  await expect(page.locator('tbody tr a')).toHaveText(['A', 'B', 'C']);
});

test('list, text and dataset variables can be authored; View query and Explore data show concrete SQL', async ({
  page,
}) => {
  await mockServer(page, {
    document: { ...classic, sections: [], variables: [], tiles: [classic.tiles[1]] },
  });
  await page.goto(detail);
  for (const type of ['list', 'text', 'dataset']) {
    await page.getByRole('button', { name: 'Add variable', exact: true }).click();
    const editor = page.getByRole('dialog', { name: 'Add variable', exact: true });
    await expect(editor.getByLabel('Variable name')).toBeFocused();
    await editor.getByLabel('Variable name').fill(type);
    await editor.getByLabel('Variable label').fill(`${type} variable`);
    await editor.getByLabel('Variable type').selectOption(type);
    if (type === 'list') await editor.getByLabel('Values (comma separated)').fill('one, two');
    else
      await editor
        .getByLabel(type === 'dataset' ? 'Default dataset' : 'Default value')
        .fill(type === 'dataset' ? 'app-logs' : 'note');
    await editor.locator('[data-dialog-confirm]').click();
    if (type === 'text')
      await expect(page.getByLabel('text variable', { exact: true })).toHaveValue('note');
    else
      await expect(page.getByLabel(`${type} variable`, { exact: true })).toHaveValue(
        type === 'list' ? 'one' : 'app-logs',
      );
  }
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();
  await tileAction(page, 'Errors', 'View query');
  const query = page.getByRole('dialog', { name: 'Query for Errors', exact: true });
  await expect(query.locator('pre')).toHaveText(String(classic.tiles[1].chartQuery));
  await expect(query).toContainText('Dataset: app-logs');
  await query.getByRole('button', { name: 'Close', exact: true }).click();
  await tileAction(page, 'Errors', 'Explore data');
  await expect(page).toHaveURL(
    (url) =>
      url.pathname === '/sql-editor' &&
      url.searchParams.get('query') === classic.tiles[1].chartQuery &&
      url.searchParams.has('start') &&
      url.searchParams.has('end'),
  );
});

test('1440px titles stay inside their cells and charts fit with visible axis titles', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await demo(page);
  const title = page.getByRole('link', { name: 'Application signals', exact: true });
  await expect(title).toBeVisible();
  const link = (await title.boundingBox())!,
    cell = (await title.locator('xpath=ancestor::td').boundingBox())!;
  expect(cell.width).toBeGreaterThan(300);
  expect(link.x).toBeGreaterThanOrEqual(cell.x);
  expect(link.x + link.width).toBeLessThanOrEqual(cell.x + cell.width);
  await title.click();
  const chart = tile(page, 'Request duration');
  await expect(chart.getByRole('img')).toHaveAccessibleName(/1 series from/);
  await expect
    .poll(() => chart.evaluate((element) => element.scrollHeight - element.clientHeight))
    .toBeLessThanOrEqual(1);
  await expect
    .poll(() =>
      chart
        .locator('.dashboard-chart')
        .evaluate((element) => element.scrollHeight - element.clientHeight),
    )
    .toBeLessThanOrEqual(1);
  const bounds = (await chart.boundingBox())!,
    axis = (await chart.getByText('Time', { exact: true }).boundingBox())!;
  const plot = (await chart.locator('.charts-plot-box').boundingBox())!,
    legend = (await chart.locator('.charts-legend').boundingBox())!;
  expect(axis.y).toBeGreaterThanOrEqual(plot.y + plot.height);
  expect(axis.y + axis.height).toBeLessThanOrEqual(legend.y);
  expect((await chart.locator('.u-over').boundingBox())!.height).toBeGreaterThanOrEqual(80);
  expect(axis.y + axis.height).toBeLessThanOrEqual(bounds.y + bounds.height - 16);
  expect(await chart.evaluate((element) => getComputedStyle(element).padding)).toBe('16px');
  // Formatted millisecond labels need more room than the shared 64px default.
  expect(
    await chart
      .locator('.u-over')
      .evaluate((element) => parseFloat((element as HTMLElement).style.left)),
  ).toBeGreaterThan(64);
  expect(
    await chart
      .locator('.dashboard-chart')
      .evaluate((element) => getComputedStyle(element).overflowY),
  ).not.toBe('auto');
});

test('Save, Discard and conflict Reload focus the heading; new edits clear the saved status', async ({
  page,
}) => {
  const server = await mockServer(page, {
    document: {
      ...classic,
      variables: [],
      sections: [],
      tiles: [{ ...classic.tiles[1], tileType: 'code' }],
    },
  });
  await page.goto(detail);
  await tileAction(page, 'Errors', 'Edit');
  await expect(page.getByLabel('Tile title')).toBeFocused();
  await page.getByLabel('Tile title').fill('Local errors');
  await page.getByRole('button', { name: 'Apply tile', exact: true }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('heading', { name: classic.title, exact: true })).toBeFocused();
  const status = page.locator('.dashboards-status');
  await expect(status).toHaveText('Dashboard saved.');
  await page.getByLabel('Time range', { exact: true }).selectOption('30m');
  await expect(status).toHaveText('');
  await expect(page.getByText('Unsaved changes', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Dashboard actions', exact: true }).click();
  const duplicate = page.getByRole('menuitem', { name: 'Duplicate dashboard', exact: true });
  await expect(duplicate).toHaveAttribute('aria-disabled', 'true');
  await expect(duplicate).toHaveAccessibleDescription(
    'Save or discard your changes before duplicating this dashboard.',
  );
  await duplicate.press('Enter');
  await page.waitForLoadState('networkidle');
  expect(server.creates).toEqual([]);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(page.getByRole('heading', { name: classic.title, exact: true })).toBeFocused();
  await tileAction(page, 'Local errors', 'Edit');
  await page.getByLabel('Tile title').fill('Conflict errors');
  await page.getByRole('button', { name: 'Apply tile', exact: true }).click();
  server.change({ title: 'Remote dashboard' });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const conflict = page.getByRole('dialog', {
    name: 'Dashboard changed on the server',
    exact: true,
  });
  await conflict.getByRole('button', { name: 'Reload', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Remote dashboard', exact: true })).toBeFocused();
});

test('delete restores neighbouring or Add focus; tile actions announce through one quiet-on-load region', async ({
  page,
}) => {
  await mockServer(page, {
    document: {
      ...classic,
      sections: [],
      variables: [
        { name: 'first', label: 'First', type: 'list', options: ['one'] },
        { name: 'last', label: 'Last', type: 'text', defaultValue: 'note' },
      ],
      tiles: [{ ...classic.tiles[1], layout: { x: 0, y: 0, w: 12, h: 4 } }],
    },
  });
  await page.goto(detail);
  const status = page.getByRole('status');
  await expect(status).toHaveCount(1);
  await expect(status).toHaveText('');
  await expect(tile(page, 'Errors').getByRole('img')).toHaveAccessibleName(/1 series from/);
  await expect(status).toHaveText('');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(status).toHaveText('Refreshing 1 tile.');
  await tileAction(page, 'Errors', 'Duplicate tile');
  await expect(status).toHaveText('Tile duplicated. Save to keep this change.');
  await tileAction(page, 'Errors (Copy)', 'Move earlier');
  await expect(status).toHaveText('Tile moved earlier. Save to keep this change.');
  await tileAction(page, 'Errors (Copy)', 'Move later');
  await expect(status).toHaveText('Tile moved later. Save to keep this change.');
  await tileAction(page, 'Errors (Copy)', 'Delete tile');
  await expect(
    page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }),
  ).toBeFocused();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete tile', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Actions for tile Errors', exact: true }),
  ).toBeFocused();
  await expect(status).toHaveText('Tile deleted. Save to keep this change.');
  await tileAction(page, 'Errors', 'Delete tile');
  await page.getByRole('dialog').getByRole('button', { name: 'Delete tile', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Add tile', exact: true })).toBeFocused();
  for (const label of ['First', 'Last']) {
    await page.getByRole('button', { name: `Actions for variable ${label}`, exact: true }).click();
    await page.getByRole('menuitem', { name: 'Delete variable', exact: true }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Delete variable', exact: true })
      .click();
    await expect(
      page.getByRole('button', {
        name: label === 'First' ? 'Actions for variable Last' : 'Add variable',
        exact: true,
      }),
    ).toBeFocused();
  }
  await expect(page.getByRole('region', { name: 'Dashboard variables', exact: true })).toHaveCount(
    0,
  );
});

test('height can be cleared and typed as 8; resize compacts neighbours and keeps their dimensions', async ({
  page,
}) => {
  const tiles = ['Tall', 'Right', 'Below'].map((title, index) => ({
    ...classic.tiles[1],
    tileType: 'code',
    tile_id: createUlid(),
    title,
    layout: {
      x: index === 1 ? 6 : 0,
      y: index === 2 ? 4 : 0,
      w: 6,
      h: index === 1 ? 3 : 4,
      future: index,
    },
  }));
  const server = await mockServer(page, {
    document: { ...classic, variables: [], sections: [], tiles },
  });
  await page.goto(detail);
  await tileAction(page, 'Tall', 'Edit');
  const editor = page.getByRole('dialog'),
    height = editor.getByLabel('Height (rows)');
  await height.fill('');
  await expect(height).toHaveValue('');
  await expect(editor.getByRole('button', { name: 'Apply tile', exact: true })).toBeDisabled();
  await height.pressSequentially('8');
  await expect(height).toHaveValue('8');
  await editor.getByLabel('Width (columns)').selectOption('8');
  await editor.getByLabel('X-axis title').fill('Observed time');
  await editor.getByLabel('Y-axis title').fill('Total events');
  await editor.getByLabel('Legend position').selectOption('right');
  await editor.getByRole('button', { name: 'Apply tile', exact: true }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();
  expect(server.writes.at(-1)!.tiles!.map((row) => row.layout)).toEqual([
    { ...tiles[0].layout, w: 8, h: 8 },
    { ...tiles[1].layout, y: 8 },
    { ...tiles[2].layout, y: 8 },
  ]);
  const boxes = await Promise.all(
    ['Tall', 'Right', 'Below'].map((title) => tile(page, title).boundingBox()),
  );
  expect(boxes[1]!.y).toBeGreaterThanOrEqual(boxes[0]!.y + boxes[0]!.height);
  expect(boxes[2]!.y).toBe(boxes[1]!.y);
  expect(boxes[2]!.x + boxes[2]!.width).toBeLessThanOrEqual(boxes[1]!.x);
  const legend = (await tile(page, 'Tall').locator('.charts-legend').boundingBox())!,
    plot = (await tile(page, 'Tall').locator('.charts-plot-box').boundingBox())!;
  expect(legend.x).toBeGreaterThanOrEqual(plot.x + plot.width);
});

test('tile query failures stay in their tile with Retry and View query and no demo switch', async ({
  page,
}) => {
  await mockServer(page, {
    document: { ...classic, variables: [], sections: [], tiles: [classic.tiles[1]] },
  });
  await page.route('**/api/v1/query', (route) =>
    route.fulfill({ status: 400, body: 'Unknown field' }),
  );
  await page.goto(detail);
  const error = tile(page, 'Errors');
  await expect(error).toContainText('Query failed: Unknown field');
  await expect(error.getByRole('button', { name: 'Retry query', exact: true })).toBeVisible();
  await expect(error.getByRole('button', { name: 'Explore demo data', exact: true })).toHaveCount(
    0,
  );
  await error.getByRole('button', { name: 'View query', exact: true }).click();
  await expect(
    page.getByRole('dialog', { name: 'Query for Errors', exact: true }).locator('pre'),
  ).toHaveText(String(classic.tiles[1].chartQuery));
});
