import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { createUlid } from '../src/lib/ids';
import classicFixture from './fixtures/classic-dashboard.json' with { type: 'json' };
import type { Dashboard, DashboardSummary } from '../src/lib/types';
const live = process.env.PARSEABLE_LIVE_URL;
const server = process.env.PARSEABLE_LIVE_SERVER_URL;
const username = process.env.PARSEABLE_LIVE_USERNAME || 'frontend-smoke',
  password = process.env.PARSEABLE_LIVE_PASSWORD || 'local-smoke-password';
const base = (process.env.PARSEABLE_LIVE_BASE ?? '/next').replace(/\/+$/, '');
const app = (path: string) => `${base}${path}`,
  appUrl = (path: string) => new URL(app(path), live).href;
const headers = {
  Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
};
const suffix = `${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
const logs = `dash_logs_${suffix}`,
  metrics = `dash_metrics_${suffix}`,
  metric = `frontend.dashboards.load_${suffix}`;
const title = `Dashboards live ${suffix}`,
  reverseTitle = `Classic reverse ${suffix}`,
  ownedTitle = `Other owner ${suffix}`;
const role = `dash_reader_${suffix}`,
  user = `dash.reader.${suffix}`;
const dashboardIds = new Set<string>();
let primary: Dashboard,
  reverse: Dashboard,
  roleAttempted = false,
  userAttempted = false,
  ingestAttempted = false;
const sql = `SELECT * FROM "${logs}" ORDER BY "p_timestamp" DESC LIMIT 12`;
const promql = `{__name__="${metric}",host=~"$host"}`;
test.skip(
  !live || !server,
  'Set PARSEABLE_LIVE_URL and PARSEABLE_LIVE_SERVER_URL to opt in to the classic interchangeability suite.',
);
// Tests 3 and 4 are independent; a create failure must not skip reverse or ownership checks.
async function signIn(page: Page, path: string) {
  await page.goto(app(`/login?next=${encodeURIComponent(path)}`));
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === new URL(appUrl(path)).pathname);
}
async function json<T>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.get(path, { headers, timeout: 10000 });
  expect(response.status(), await response.text()).toBe(200);
  return response.json();
}
async function apiCreate(request: APIRequestContext, body: unknown, auth = headers) {
  const response = await request.post('/api/v1/dashboards', {
    headers: auth,
    data: body,
    timeout: 10000,
  });
  expect(response.status(), await response.text()).toBe(200);
  const doc = (await response.json()) as Dashboard;
  dashboardIds.add(doc.dashboardId);
  return doc;
}
test.beforeAll(async ({ request }) => {
  // Cookies are shared across ports only when both origins use the same host.
  if (new URL(live!).hostname !== new URL(server!).hostname)
    throw new Error('The /next and classic origins must use the same host to share login cookies.');
  const now = Math.floor(Date.now() / 1000);
  ingestAttempted = true;
  const points = ['node-a', 'node-b'].flatMap((host, hostIndex) =>
    Array.from({ length: 11 }, (_, index) => ({
      timeUnixNano: String(BigInt(now - 150 + index * 15) * 1_000_000_000n),
      asDouble: hostIndex ? 7.5 : 3.25,
      attributes: [{ key: 'host', value: { stringValue: host } }],
    })),
  );
  const otlp = await request.post('/v1/metrics', {
    headers: { ...headers, 'X-P-Stream': metrics, 'Content-Type': 'application/json' },
    data: {
      resourceMetrics: [
        {
          resource: {
            attributes: [
              { key: 'service.name', value: { stringValue: 'frontend-dashboards-live' } },
            ],
          },
          scopeMetrics: [
            {
              scope: { name: 'frontend-dashboards-live' },
              metrics: [{ name: metric, gauge: { dataPoints: points } }],
            },
          ],
        },
      ],
    },
    timeout: 10000,
  });
  expect(otlp.ok(), await otlp.text()).toBe(true);
  const ingest = await request.post('/api/v1/ingest', {
    headers: { ...headers, 'X-P-Stream': logs },
    data: Array.from({ length: 12 }, (_, index) => ({
      level: index % 3 ? 'INFO' : 'ERROR',
      service: 'frontend-dashboards-live',
      message: `Dashboard live event ${index}`,
      duration_ms: 10 + index,
    })),
    timeout: 10000,
  });
  expect(ingest.ok(), await ingest.text()).toBe(true);
  await expect
    .poll(
      async () => {
        const response = await request.get(
          `/prometheus/api/v1/query?${new URLSearchParams({ stream: metrics, query: `{__name__="${metric}"}` })}`,
          { headers, timeout: 2000 },
        );
        if (!response.ok()) return 0;
        const body = await response.json();
        return body.status === 'success' ? body.data.result.length : 0;
      },
      { timeout: 30000, intervals: [500, 1000] },
    )
    .toBe(2);
  await expect
    .poll(
      async () => {
        const response = await request.post('/api/v1/query', {
          headers,
          data: {
            query: sql,
            startTime: new Date(Date.now() - 3600_000).toISOString(),
            endTime: new Date().toISOString(),
            sendNull: true,
          },
          timeout: 2000,
        });
        return response.ok() ? (await response.json()).length : 0;
      },
      { timeout: 30000, intervals: [500, 1000] },
    )
    .toBe(12);
});
test.afterAll(async ({ request }) => {
  if (!live || !server) return;
  test.setTimeout(60000);
  const errors: Error[] = [];
  async function cleanup(label: string, operation: () => Promise<void>) {
    try {
      await operation();
    } catch (error) {
      errors.push(new Error(`Could not clean up ${label}`, { cause: error }));
    }
  }
  async function remove(path: string, missing = 400) {
    const response = await request.delete(path, { headers, timeout: 5000 });
    expect(response.ok() || response.status() === missing, await response.text()).toBe(true);
  }
  await cleanup('dashboard discovery', async () => {
    const rows = await json<DashboardSummary[]>(request, '/api/v1/dashboards?limit=0');
    for (const row of rows)
      if ([title, reverseTitle, ownedTitle].includes(row.title)) dashboardIds.add(row.dashboardId);
  });
  for (const id of dashboardIds)
    await cleanup(`dashboard ${id}`, () => remove(`/api/v1/dashboards/${id}`));
  if (ingestAttempted)
    for (const dataset of [logs, metrics])
      await cleanup(dataset, () => remove(`/api/v1/logstream/${dataset}`, 404));
  if (userAttempted) await cleanup('reader user', () => remove(`/api/v1/user/${user}`, 404));
  if (roleAttempted) await cleanup('reader role', () => remove(`/api/v1/role/${role}`, 404));
  if (errors.length) throw new AggregateError(errors, 'Dashboard live-test cleanup failed.');
});
test('create SQL and PromQL tiles and variables through /next; verify exact classic shapes', async ({
  page,
  request,
}) => {
  await signIn(page, '/dashboards');
  await page.getByRole('button', { name: 'Create dashboard', exact: true }).click();
  const create = page.getByRole('dialog', { name: 'Create dashboard', exact: true });
  await create.getByLabel('Dashboard title').fill(title);
  await create.getByLabel('Tags', { exact: true }).fill('parity, live');
  await create.getByLabel('Description').fill('SQL and PromQL classic interchangeability');
  const createdResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/v1/dashboards' &&
      response.request().method() === 'POST',
  );
  await create.locator('[data-dialog-confirm]').click();
  const response = await createdResponse;
  expect(response.status(), await response.text()).toBe(200);
  const created = (await response.json()) as Dashboard;
  dashboardIds.add(created.dashboardId);
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Add variable', exact: true }).click();
  let variable = page.getByRole('dialog', { name: 'Add variable', exact: true });
  await variable.getByLabel('Variable name').fill('metrics_dataset');
  await variable.getByLabel('Variable label').fill('Metrics dataset');
  await variable.getByLabel('Variable type').selectOption('dataset');
  await variable.getByLabel('Default dataset').fill(metrics);
  await variable.locator('[data-dialog-confirm]').click();
  await page.getByRole('button', { name: 'Add variable', exact: true }).click();
  variable = page.getByRole('dialog', { name: 'Add variable', exact: true });
  await variable.getByLabel('Variable name').fill('host');
  await variable.getByLabel('Variable label').fill('Host');
  await variable.getByLabel('Variable type').selectOption('promql');
  await variable.getByLabel('Variable dataset').selectOption('$metrics_dataset');
  await variable.getByLabel('Label name', { exact: true }).fill('host');
  await variable.getByLabel('Metric (optional)').fill(metric);
  await variable.getByLabel('Include All option').check();
  await variable.getByLabel('Default value').fill('node-a');
  await variable.locator('[data-dialog-confirm]').click();
  await page.getByRole('button', { name: 'Add tile', exact: true }).click();
  let editor = page.getByRole('dialog', { name: 'Add tile', exact: true });
  await editor.getByLabel('Tile title').fill('Live log events');
  await editor.getByLabel('Dataset', { exact: true }).selectOption(logs);
  await editor.getByRole('textbox', { name: 'SQL query', exact: true }).fill(sql);
  await editor.getByLabel('Chart type').selectOption('table');
  await editor.getByLabel('Width (columns)').selectOption('12');
  await editor.locator('[data-dialog-confirm]').click();
  await page.getByRole('button', { name: 'Add tile', exact: true }).click();
  editor = page.getByRole('dialog', { name: 'Add tile', exact: true });
  await editor.getByLabel('Tile title').fill('Live host load');
  await editor.getByLabel('Query language').selectOption('promql');
  await editor.getByLabel('Dataset', { exact: true }).selectOption('$metrics_dataset');
  await editor.getByRole('textbox', { name: 'PromQL query A', exact: true }).fill(promql);
  await editor.getByLabel('Width (columns)').selectOption('12');
  await editor.locator('[data-dialog-confirm]').click();
  // Staging conversion can briefly empty both query data and host options, causing All.
  // Reselect the concrete host on recovery and require its single nonempty series.
  const host = page.getByLabel('Host', { exact: true });
  await expect
    .poll(
      async () => {
        if (await host.locator('option[value="node-a"]').count()) await host.selectOption('node-a');
        const rows = page
          .waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/query', {
            timeout: 5000,
          })
          .then((response) => response.json())
          .catch(() => []);
        const matrix = page
          .waitForResponse(
            (response) => new URL(response.url()).pathname === '/prometheus/api/v1/query_range',
            { timeout: 5000 },
          )
          .then((response) => response.json())
          .catch(() => undefined);
        await page.getByRole('button', { name: 'Refresh', exact: true }).click();
        const [logsResult, metricsResult] = await Promise.all([rows, matrix]);
        await page.waitForLoadState('networkidle');
        return (
          logsResult.length === 12 &&
          metricsResult?.status === 'success' &&
          metricsResult.data.result.length === 1 &&
          metricsResult.data.result[0].metric.host === 'node-a' &&
          metricsResult.data.result[0].values?.length > 0 &&
          (await host.inputValue()) === 'node-a'
        );
      },
      { timeout: 30000, intervals: [1000, 2000] },
    )
    .toBe(true);
  await expect(
    page.getByRole('region', { name: 'Live log events results', exact: true }),
  ).toContainText('Dashboard live event 0');
  await expect(
    page
      .locator('[data-tile-id]')
      .filter({ has: page.getByRole('heading', { name: 'Live host load', exact: true }) })
      .getByRole('img'),
  ).toHaveAccessibleName(/1 series from/);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Dashboard saved.', { exact: true })).toBeVisible();
  const storedResponse = await request.get(`/api/v1/dashboards/${created.dashboardId}`, {
    headers,
  });
  expect(storedResponse.status()).toBe(200);
  const verbatim = await storedResponse.text();
  primary = JSON.parse(verbatim);
  await writeFile(test.info().outputPath('created-dashboard.json'), verbatim);
  await test
    .info()
    .attach('stored-dashboard.json', { body: verbatim, contentType: 'application/json' });
  expect(primary.tiles).toHaveLength(2);
  const [sqlTile, promTile] = primary.tiles!;
  expect(sqlTile).toEqual({
    tile_id: expect.any(String),
    config: { ...classicFixture.tiles[0].config, type: 'table' },
    layout: { x: 0, y: 0, w: 12, h: 4 },
    title: 'Live log events',
    tileType: 'code',
    chartQuery: sql,
    dbName: [logs],
    chartType: 'table',
    authorMode: 'manual',
  });
  expect(promTile).toEqual({
    tile_id: expect.any(String),
    config: { ...classicFixture.tiles[0].config, type: 'timeseries' },
    layout: { x: 0, y: 4, w: 12, h: 4 },
    title: 'Live host load',
    tileType: 'promql',
    chartQuery: [promql],
    promqlQueryType: ['range'],
    dbName: '$metrics_dataset',
    chartType: 'timeseries',
    authorMode: 'manual',
  });
  for (const tile of primary.tiles!) {
    expect(tile.tile_id).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    for (const value of Object.values(tile.layout as Record<string, number>))
      expect(Number.isFinite(value) && Number.isInteger(value)).toBe(true);
  }
  expect(primary.variables).toEqual([
    { name: 'metrics_dataset', label: 'Metrics dataset', type: 'dataset', defaultValue: metrics },
    {
      name: 'host',
      label: 'Host',
      type: 'promql',
      dataset: '$metrics_dataset',
      labelName: 'host',
      metric,
      includeAll: true,
      defaultValue: 'node-a',
    },
  ]);
  expect(primary.timeRange).toEqual({
    startTime: '1h',
    endTime: 'now',
    type: 'fixed',
    label: 'Last 1 hour',
    interval: 3600000,
    shiftInterval: 1,
  });
  expect(primary).not.toHaveProperty('variableValues');
});
test('hard-load the saved dashboard on the classic origin; both tiles render without errors', async ({
  page,
}) => {
  expect(
    primary,
    'The create test must provide a saved dashboard for the classic check.',
  ).toBeDefined();
  await signIn(page, `/dashboards/${primary.dashboardId}`);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const resultPromises: Array<Promise<unknown>> = [];
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.origin === new URL(server!).origin && url.pathname === '/prometheus/api/v1/query_range')
      resultPromises.push(response.json().catch(() => null));
  });
  await page.goto(`${server}/dashboards/${primary.dashboardId}`);
  const sqlTile = page.locator(`[data-tile-id="${primary.tiles![0].tile_id}"]`),
    promTile = page.locator(`[data-tile-id="${primary.tiles![1].tile_id}"]`);
  await expect(sqlTile).toContainText('Dashboard live event 0', { timeout: 30000 });
  await expect(promTile.locator('canvas')).toBeVisible({ timeout: 30000 });
  await expect
    .poll(
      async () => {
        const bodies = await Promise.all(resultPromises);
        return bodies.some((value) => {
          const body = value as {
            status?: string;
            data?: { resultType?: string; result?: Array<{ values?: unknown[] }> };
          } | null;
          return (
            body?.status === 'success' &&
            body.data?.resultType === 'matrix' &&
            body.data.result?.some((row) => row.values?.length)
          );
        });
      },
      { timeout: 30000 },
    )
    .toBe(true);
  await expect(page.getByText('node-a', { exact: true }).first()).toBeVisible();
  expect(pageErrors).toEqual([]);
  await expect(sqlTile).not.toContainText(/Query Error|Query failed to load|No results for/);
  await expect(promTile).not.toContainText(/Query Error|Query failed to load|No results for/);
  await page.screenshot({
    path: test.info().outputPath('classic-interchangeability.png'),
    fullPage: true,
  });
  await test.info().attach('classic-interchangeability', {
    path: test.info().outputPath('classic-interchangeability.png'),
    contentType: 'image/png',
  });
});
test('classic-shaped API dashboard renders in /next and unknown document, tile and config fields survive editing', async ({
  page,
  request,
}) => {
  const config = structuredClone(classicFixture.tiles[1].config);
  const {
    dashboardId: _id,
    author: _author,
    created: _created,
    modified: _modified,
    ...fixture
  } = structuredClone(classicFixture);
  reverse = await apiCreate(request, {
    ...fixture,
    title: reverseTitle,
    tags: ['parity'],
    isFavorite: true,
    dashboardType: 'Report',
    description: 'A classic-shaped report',
    sections: [{ sectionId: 'health', title: 'Health', isExpanded: true, futureSection: 'keep' }],
    variables: [
      { name: 'metrics_dataset', label: 'Metrics dataset', type: 'dataset', defaultValue: metrics },
      {
        name: 'host',
        label: 'Host',
        type: 'promql',
        dataset: '$metrics_dataset',
        labelName: 'host',
        metric,
        includeAll: true,
        defaultValue: 'node-a',
      },
    ],
    timeRange: {
      startTime: '1h',
      endTime: 'now',
      type: 'fixed',
      label: 'Last 1 hour',
      interval: 3600000,
      shiftInterval: 1,
      unknownTime: 'keep',
    },
    future: { important: true },
    tiles: [
      {
        ...fixture.tiles[0],
        tile_id: createUlid(),
        title: 'Classic log events',
        authorMode: 'manual',
        tileType: 'code',
        chartType: 'table',
        chartQuery: sql,
        dbName: [logs],
        config: { ...classicFixture.tiles[0].config, type: 'table', unknownConfig: 'keep' },
        layout: { x: 0, y: 0, w: 12, h: 4, static: true },
        sectionId: 'health',
        futureTile: { keep: [1, 2] },
      },
      {
        ...fixture.tiles[1],
        tile_id: createUlid(),
        title: 'Classic host load',
        authorMode: 'manual',
        tileType: 'promql',
        chartType: 'timeseries',
        chartQuery: [promql],
        promqlQueryType: ['range'],
        dbName: '$metrics_dataset',
        config: {
          ...config,
          layout: { ...config.layout, unit: 'load', precision: 2, futureLayout: true },
        },
        layout: { x: 0, y: 4, w: 12, h: 4 },
        sectionId: 'health',
      },
    ],
  });
  const nonemptyMatrix = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/prometheus/api/v1/query_range' && response.ok(),
  );
  await signIn(page, `/dashboards/${reverse.dashboardId}`);
  const matrix = await (await nonemptyMatrix).json();
  expect(matrix.status).toBe('success');
  expect(matrix.data.result.some((row: { values?: unknown[] }) => row.values?.length)).toBe(true);
  await expect(
    page.getByRole('region', { name: 'Classic log events results', exact: true }),
  ).toContainText('Dashboard live event 0');
  await expect(
    page
      .locator('[data-tile-id]')
      .filter({ has: page.getByRole('heading', { name: 'Classic host load', exact: true }) })
      .getByRole('img'),
  ).toHaveAccessibleName(/1 series from/);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Actions for tile Classic log events', exact: true })
    .click();
  await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Edit tile', exact: true })
    .getByLabel('Tile title')
    .fill('Edited classic log events');
  await page.getByRole('button', { name: 'Apply tile', exact: true }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Dashboard saved.', { exact: true })).toBeVisible();
  const saved = await json<Dashboard>(request, `/api/v1/dashboards/${reverse.dashboardId}`);
  const expected = structuredClone(reverse);
  expected.tiles![0].title = 'Edited classic log events';
  expected.modified = saved.modified;
  expect(saved).toEqual(expected);
});
test('limit=0 is complete; admins may delete another owner but PUT remains owner-only', async ({
  page,
  request,
}) => {
  roleAttempted = true;
  const roleResponse = await request.put(`/api/v1/role/${role}`, {
    headers,
    data: [{ privilege: 'reader', resource: 'all' }],
  });
  expect(roleResponse.status(), await roleResponse.text()).toBe(200);
  userAttempted = true;
  const userResponse = await request.post(`/api/v1/user/${user}`, { headers, data: [role] });
  expect(userResponse.status(), await userResponse.text()).toBe(200);
  const userPassword = await userResponse.text();
  const owned = await apiCreate(
    request,
    { title: ownedTitle, tiles: [] },
    { Authorization: `Basic ${Buffer.from(`${user}:${userPassword}`).toString('base64')}` },
  );
  const adminUpdate = await request.put(`/api/v1/dashboards/${owned.dashboardId}`, {
    headers,
    data: { ...owned, title: `${ownedTitle} edited` },
  });
  expect(adminUpdate.status()).toBe(400);
  expect(await adminUpdate.text()).toBe(
    'Cannot perform this operation: Dashboard does not exist or you do not have permission to access it',
  );
  await signIn(page, `/dashboards/${owned.dashboardId}`);
  await expect(
    page.getByText(
      'This dashboard is read-only. Only its owner can edit it. Duplicate it to make an editable copy.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
  const all = await json<DashboardSummary[]>(request, '/api/v1/dashboards?limit=0');
  for (const id of dashboardIds) expect(all.some((row) => row.dashboardId === id)).toBe(true);
  const deletion = await request.delete(`/api/v1/dashboards/${owned.dashboardId}`, { headers });
  expect(deletion.status()).toBe(200);
  dashboardIds.delete(owned.dashboardId);
});
