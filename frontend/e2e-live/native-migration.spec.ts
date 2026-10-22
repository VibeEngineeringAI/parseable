import { randomUUID } from 'node:crypto';
import {
  test,
  expect,
  type APIRequestContext,
  type Page,
  type Request,
  type Response,
} from '@playwright/test';
import type { Alert, AlertSummary, SavedLogView } from '../src/lib/types';

// Records created by classic Prism are seeded through the real API, then opened
// and converted in the native UI. Nothing here is mocked.
const live = process.env.PARSEABLE_LIVE_URL;
const username = process.env.PARSEABLE_LIVE_USERNAME || 'frontend-smoke',
  password = process.env.PARSEABLE_LIVE_PASSWORD || 'local-smoke-password';
const base = (process.env.PARSEABLE_LIVE_BASE ?? '').replace(/\/+$/, '');
const app = (route: string) => `${base}${route}`,
  appUrl = (route: string) => new URL(app(route), live).href;
const headers = {
  Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
};
const suffix = `${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
const dataset = `migration_live_${suffix}`,
  quoted = `"${dataset}"`;
const classicName = `Classic SQL ${suffix}`,
  logsViewName = `Classic logs view ${suffix}`,
  alertTitle = `Builder alert ${suffix}`;
const events = [
  { level: 'ERROR', latency_ms: 100, message: `checkout failed a ${suffix}` },
  { level: 'ERROR', latency_ms: 200, message: `checkout failed b ${suffix}` },
  { level: 'ERROR', latency_ms: 600, message: `checkout failed c ${suffix}` },
  { level: 'INFO', latency_ms: 20, message: `checkout ok a ${suffix}` },
  { level: 'INFO', latency_ms: 40, message: `checkout ok b ${suffix}` },
  { level: 'WARN', latency_ms: 80, message: `checkout slow ${suffix}` },
];
const classicSql = `SELECT level, COUNT(*) AS events, SUM(latency_ms) AS total_latency FROM ${quoted} GROUP BY level ORDER BY level`;
const logsViewSql = `SELECT message, latency_ms FROM ${quoted} WHERE level = 'ERROR' ORDER BY latency_ms`;
const alertSql = `SELECT AVG(latency_ms) FROM ${quoted} WHERE level = 'ERROR'`;
const editedAlertSql = `SELECT COUNT(*) FROM ${quoted} WHERE level = 'ERROR'`;
// Absolute bounds are kept exactly; set in beforeAll around the ingest time.
let classicWindow: { from: string; to: string };
let classicId: string | undefined,
  logsViewId: string | undefined,
  alertId: string | undefined,
  attemptedIngest = false;

test.skip(!live, 'Set PARSEABLE_LIVE_URL to opt in to the real-server suite.');
test.describe.configure({ mode: 'serial' });

async function signIn(page: Page, path: string) {
  await page.goto(app(`/login?next=${encodeURIComponent(path)}`));
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === new URL(appUrl(path)).pathname);
}
async function getJson<T>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.get(path, { headers, timeout: 10_000 });
  expect(response.status(), await response.text()).toBe(200);
  return response.json();
}
async function send<T>(
  request: APIRequestContext,
  method: 'POST' | 'PATCH',
  path: string,
  data: unknown,
): Promise<T> {
  const response = await request.fetch(path, { method, headers, data, timeout: 15_000 });
  expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBe(true);
  return response.json();
}
async function runSql(
  request: APIRequestContext,
  query: string,
  startTime: string,
  endTime: string,
) {
  const response = await request.post('/api/v1/query', {
    headers,
    data: { query, startTime, endTime, sendNull: true },
    timeout: 15_000,
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as Record<string, unknown>[];
}
/**
 * Asserts the UI's real query result exactly. On a mismatch the identical request body is
 * replayed directly so a failure distinguishes a client payload fault from server visibility.
 */
async function expectUiResult(request: APIRequestContext, response: Response, expected: unknown) {
  const body = response.request().postDataJSON();
  const actual = await response.json();
  if (JSON.stringify(actual) === JSON.stringify(expected)) return;
  const replay = await request.post('/api/v1/query', { headers, data: body, timeout: 15_000 });
  const evidence = {
    at: new Date().toISOString(),
    browserRequest: body,
    browserResponse: actual,
    directReplay: { status: replay.status(), body: await replay.text() },
  };
  await test.info().attach('query-mismatch.json', {
    body: JSON.stringify(evidence, null, 2),
    contentType: 'application/json',
  });
  expect(actual, `UI query result differs; ${JSON.stringify(evidence)}`).toEqual(expected);
}
/** Records every non-read request the page makes against server saved views or alerts. */
function watchWrites(page: Page, prefix: string) {
  const writes: string[] = [];
  page.on('request', (request: Request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith(prefix) && request.method() !== 'GET')
      writes.push(`${request.method()} ${path}`);
  });
  return writes;
}
const isQuery = (response: Response) =>
  response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/v1/query';
const serverList = (page: Page) =>
  page.getByLabel('SQL datasets and saved queries').getByLabel('Server saved queries');
async function browserLibrary(page: Page) {
  return page.evaluate(() =>
    Object.keys(localStorage)
      .filter((key) => key.startsWith('parseable-sql:v1:') && key.endsWith(':library'))
      .flatMap((key) => JSON.parse(localStorage.getItem(key) || '[]')),
  ) as Promise<
    Array<{ name: string; sql: string; range: unknown; datasets: string[]; id: string }>
  >;
}

test.beforeAll(async ({ request }) => {
  test.setTimeout(90_000);
  attemptedIngest = true;
  const ingest = await request.post('/api/v1/ingest', {
    headers: { ...headers, 'X-P-Stream': dataset },
    data: events.map((event) => ({ ...event, service: 'native-migration-live' })),
    timeout: 15_000,
  });
  expect(ingest.ok(), await ingest.text()).toBe(true);
  const now = Date.now();
  classicWindow = {
    from: new Date(now - 2 * 60 * 60_000).toISOString(),
    to: new Date(now + 60 * 60_000).toISOString(),
  };
  await expect
    .poll(
      async () => {
        const response = await request.post('/api/v1/query', {
          headers,
          data: {
            query: `SELECT COUNT(*) AS n FROM ${quoted}`,
            startTime: classicWindow.from,
            endTime: classicWindow.to,
          },
          timeout: 5000,
        });
        return response.ok() ? (await response.json())[0]?.n : undefined;
      },
      { timeout: 30_000, intervals: [500, 1000] },
    )
    .toBe(events.length);

  // A classic Prism SQL-editor query: stream_name "sql", no explorer_state.
  const classic = await send<SavedLogView>(request, 'POST', '/api/v1/filters', {
    stream_name: 'sql',
    filter_name: classicName,
    query: { filter_type: 'sql', filter_query: classicSql, filter_builder: null },
    time_filter: classicWindow,
  });
  classicId = classic.filter_id ?? undefined;
  // An older dataset-scoped Logs view: stream_name is the dataset, relative window.
  const logsView = await send<SavedLogView>(request, 'POST', '/api/v1/filters', {
    stream_name: dataset,
    filter_name: logsViewName,
    query: { filter_type: 'sql', filter_query: logsViewSql, filter_builder: null },
    time_filter: { from: 'now-7d', to: 'now' },
  });
  logsViewId = logsView.filter_id ?? undefined;
  expect(classicId).toBeTruthy();
  expect(logsViewId).toBeTruthy();

  // A builder threshold alert as classic Prism stored it, without notification
  // targets so evaluation can never send anything.
  const alert = await send<Alert>(request, 'POST', '/api/v1/alerts', {
    title: alertTitle,
    severity: 'critical',
    query: alertSql,
    queryType: 'builder',
    alertType: 'threshold',
    thresholdConfig: { operator: '>=', value: 5000.5 },
    evalConfig: { rollingWindow: { evalStart: '2h', evalEnd: 'now', evalFrequency: 15 } },
    notificationConfig: { interval: 5 },
    targets: [],
    tags: ['migration', `live-${suffix}`],
    units: 'ms',
    migrationTicket: `fixture-${suffix}`,
  });
  alertId = alert.id;
  expect(alert.queryType).toBe('builder');
  expect(alert.datasets).toEqual([dataset]);
  await send(request, 'PATCH', `/api/v1/alerts/${alertId}/disable`, {});
  await send(request, 'PATCH', `/api/v1/alerts/${alertId}/update_notification_state`, {
    state: 'indefinite',
  });
  await expect
    .poll(async () => {
      const stored = await getJson<Alert>(request, `/api/v1/alerts/${alertId}`);
      return [stored.state, stored.notificationState];
    })
    .toEqual(['disabled', { mute: 'indefinite' }]);
});

test.afterAll(async ({ request }) => {
  if (!live) return;
  test.setTimeout(60_000);
  const errors: Error[] = [];
  async function cleanup(label: string, operation: () => Promise<void>) {
    try {
      await operation();
    } catch (error) {
      errors.push(new Error(`Could not clean up ${label}`, { cause: error }));
    }
  }
  async function remove(path: string, missing: number[]) {
    const response = await request.delete(path, { headers, timeout: 10_000 });
    expect(response.ok() || missing.includes(response.status()), await response.text()).toBe(true);
  }
  // Discover by unique name too, so records are removed if an ID assertion failed.
  await cleanup('alerts', async () => {
    const ids = new Set<string>(alertId ? [alertId] : []);
    for (let offset = 0; ; offset += 1000) {
      const rows = await getJson<AlertSummary[]>(
        request,
        `/api/v1/alerts?limit=1000&offset=${offset}`,
      );
      rows.filter((row) => row.title === alertTitle).forEach((row) => ids.add(row.id));
      if (rows.length < 1000) break;
    }
    for (const id of ids)
      await cleanup(`alert ${id}`, () =>
        remove(`/api/v1/alerts/${encodeURIComponent(id)}`, [400, 404]),
      );
  });
  await cleanup('filters', async () => {
    const ids = new Set<string>([classicId, logsViewId].filter((id): id is string => !!id));
    (await getJson<SavedLogView[]>(request, '/api/v1/filters'))
      .filter((view) => [classicName, logsViewName].includes(view.filter_name) && view.filter_id)
      .forEach((view) => ids.add(view.filter_id!));
    for (const id of ids)
      await cleanup(`filter ${id}`, () =>
        remove(`/api/v1/filters/${encodeURIComponent(id)}`, [400, 404]),
      );
  });
  if (attemptedIngest)
    await cleanup('dataset', () =>
      remove(`/api/v1/logstream/${encodeURIComponent(dataset)}`, [404]),
    );
  if (errors.length) throw new AggregateError(errors, 'Native migration live-test cleanup failed.');
});

test('classic SQL and dataset-scoped SQL views list, open, copy and run without changing the server', async ({
  page,
  request,
}) => {
  const before = await Promise.all(
    [classicId, logsViewId].map((id) => getJson<SavedLogView>(request, `/api/v1/filters/${id}`)),
  );
  expect(before[0]).toMatchObject({ stream_name: 'sql', time_filter: classicWindow });
  expect(before[0].explorer_state ?? null).toBeNull();
  expect(before[1]).toMatchObject({ stream_name: dataset });
  const writes = watchWrites(page, '/api/v1/filters');
  await signIn(page, '/sql-editor');

  const list = serverList(page);
  const classic = list.getByRole('button', { name: new RegExp(`^${classicName}`) });
  const scoped = list.getByRole('button', { name: new RegExp(`^${logsViewName}`) });
  await expect(classic).toHaveCount(1);
  await expect(classic).toContainText('SQL');
  // Created by this user, so not marked shared; a classic view is labelled as such.
  await expect(classic).not.toContainText('shared');
  await expect(scoped).toContainText('Logs view');
  await expect(scoped).not.toContainText('shared');
  // Both stored windows are usable, so neither shows a fallback warning.
  await expect(
    list.getByRole('note').filter({ hasText: new RegExp(`${classicName}|${logsViewName}`) }),
  ).toHaveCount(0);

  // Opening keeps the exact SQL and absolute window and runs it on the server.
  await classic.click();
  await expect(page.getByRole('tab', { name: classicName, exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'SQL query' })).toHaveText(classicSql);
  await expect(page.getByLabel('Time range', { exact: true })).toHaveValue('custom');
  const classicRun = page.waitForResponse(isQuery);
  await page.getByRole('button', { name: 'Run query', exact: true }).click();
  const classicResponse = await classicRun;
  expect(classicResponse.ok(), await classicResponse.text()).toBe(true);
  expect(classicResponse.request().postDataJSON()).toMatchObject({
    query: classicSql,
    startTime: classicWindow.from,
    endTime: classicWindow.to,
  });
  const expectedCounts = [
    { level: 'ERROR', events: 3, total_latency: 900 },
    { level: 'INFO', events: 2, total_latency: 60 },
    { level: 'WARN', events: 1, total_latency: 80 },
  ];
  await expectUiResult(request, classicResponse, expectedCounts);
  expect(await runSql(request, classicSql, classicWindow.from, classicWindow.to)).toEqual(
    expectedCounts,
  );
  const results = page.getByRole('table');
  await expect(results.locator('tbody tr')).toHaveCount(3);
  await expect(results.getByRole('row').filter({ hasText: 'ERROR' })).toContainText('900');

  // The dataset-scoped view opens with its dataset selected and its relative window.
  await scoped.click();
  await expect(page.getByRole('tab', { name: logsViewName, exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'SQL query' })).toHaveText(logsViewSql);
  await expect(page.getByLabel('Time range', { exact: true })).toHaveValue('7d');
  await expect(
    page.getByRole('checkbox', { name: `Select ${dataset}`, exact: true }),
  ).toBeChecked();
  const scopedRun = page.waitForResponse(isQuery);
  await page.getByRole('button', { name: 'Run query', exact: true }).click();
  const scopedResponse = await scopedRun;
  expect(scopedResponse.ok(), await scopedResponse.text()).toBe(true);
  const scopedBody = scopedResponse.request().postDataJSON();
  expect(scopedBody.query).toBe(logsViewSql);
  expect(Date.parse(scopedBody.endTime) - Date.parse(scopedBody.startTime)).toBe(
    7 * 24 * 60 * 60_000,
  );
  await expectUiResult(
    request,
    scopedResponse,
    events
      .filter((event) => event.level === 'ERROR')
      .map(({ message, latency_ms }) => ({ message, latency_ms })),
  );
  await expect(results.locator('tbody tr')).toHaveCount(3);
  await expect(results).toContainText(`checkout failed c ${suffix}`);
  await expect(results).not.toContainText(`checkout ok a ${suffix}`);
  await test.info().attach('sql-results.png', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });

  // Reopening focuses the existing draft instead of duplicating it.
  await classic.click();
  await expect(page.getByRole('tab', { name: classicName, exact: true })).toHaveCount(1);

  // Copies go to this browser only and keep SQL, window and dataset scope.
  await page
    .getByRole('button', { name: `Copy server query ${classicName} to this browser` })
    .click();
  await expect(page.getByText(`Copied ${classicName} to this browser library.`)).toBeVisible();
  await page
    .getByRole('button', { name: `Copy server query ${logsViewName} to this browser` })
    .click();
  await expect(page.getByText(`Copied ${logsViewName} to this browser library.`)).toBeVisible();
  await page
    .getByRole('button', { name: `Copy server query ${classicName} to this browser` })
    .click();
  await expect(page.getByText(`${classicName} is already in this browser library.`)).toBeVisible();
  const library = await browserLibrary(page);
  expect(library.filter((item) => item.name === classicName)).toEqual([
    expect.objectContaining({
      sql: classicSql,
      range: { startTime: classicWindow.from, endTime: classicWindow.to },
      datasets: [],
    }),
  ]);
  expect(library.filter((item) => item.name === logsViewName)).toEqual([
    expect.objectContaining({ sql: logsViewSql, range: '7d', datasets: [dataset] }),
  ]);
  // The copy is an ordinary editable browser query, separate from the server list.
  await page.getByRole('button', { name: classicName, exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'SQL query' })).toHaveText(classicSql);

  expect(writes).toEqual([]);
  const after = await Promise.all(
    [classicId, logsViewId].map((id) => getJson<SavedLogView>(request, `/api/v1/filters/${id}`)),
  );
  expect(after).toEqual(before);
});

test('Logs saved views hand an older dataset-scoped SQL view to the SQL editor unchanged', async ({
  page,
  request,
}) => {
  const before = await getJson<SavedLogView>(request, `/api/v1/filters/${logsViewId}`);
  const writes = watchWrites(page, '/api/v1/filters');
  const logsPath = `/logs/explore/${encodeURIComponent(dataset)}`;
  await signIn(page, logsPath);
  await expect(page.getByRole('table')).toContainText(`checkout failed a ${suffix}`);
  await page.getByRole('button', { name: 'Saved views', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Saved log views' });
  const select = dialog.getByLabel('Saved log view');
  // The classic SQL query is not scoped to this dataset, so only the Logs view is offered.
  await expect(select.locator('option', { hasText: classicName })).toHaveCount(0);
  await select.selectOption({ label: `${logsViewName} (classic or incompatible)` });
  await expect(
    dialog.getByText(/This classic view cannot be applied or overwritten here/),
  ).toBeVisible();
  await expect(dialog.getByText(/saved time range is unreadable/)).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Apply view', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Update selected', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Convert to SQL view' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Open in SQL editor' }).click();

  await expect(page.getByRole('textbox', { name: 'SQL query' })).toHaveText(logsViewSql);
  await expect(page.getByLabel('Time range', { exact: true })).toHaveValue('7d');
  // The consumed handoff leaves no query or range in the URL.
  await expect(page).toHaveURL((url) => url.pathname === app('/sql-editor') && !url.search);
  const run = page.waitForResponse(isQuery);
  await page.getByRole('button', { name: 'Run query', exact: true }).click();
  const response = await run;
  expect(response.ok(), await response.text()).toBe(true);
  expect(response.request().postDataJSON().query).toBe(logsViewSql);
  await expectUiResult(
    request,
    response,
    events
      .filter((event) => event.level === 'ERROR')
      .map(({ message, latency_ms }) => ({ message, latency_ms })),
  );
  await expect(page.getByRole('table').locator('tbody tr')).toHaveCount(3);
  await expect(page.getByRole('table')).toContainText(`checkout failed b ${suffix}`);

  expect(writes).toEqual([]);
  expect(await getJson<SavedLogView>(request, `/api/v1/filters/${logsViewId}`)).toEqual(before);
});

test('a builder alert converts to SQL only on explicit save, keeping settings, disabled and mute', async ({
  page,
  request,
}) => {
  const detailPath = `/alerts/${alertId}`;
  const before = await getJson<Alert>(request, `/api/v1/alerts/${alertId}`);
  expect(before).toMatchObject({
    queryType: 'builder',
    query: alertSql,
    state: 'disabled',
    notificationState: { mute: 'indefinite' },
    targets: [],
  });
  const writes = watchWrites(page, '/api/v1/alerts');
  await signIn(page, detailPath);
  await expect(page.getByRole('heading', { name: alertTitle, exact: true })).toBeVisible();
  await expect(page.locator('.alerts-query')).toHaveText(alertSql);
  await expect(page.getByText('Builder', { exact: true })).toBeVisible();
  await expect(page.getByText('This alert is disabled.', { exact: false })).toBeVisible();
  await expect(page.locator('.alerts-metadata')).toContainText('Muted indefinitely');
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);

  // Cancel leaves the stored builder rule untouched.
  await page.getByRole('button', { name: 'Convert to SQL rule', exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === app(`${detailPath}/edit`));
  await expect(page.getByTestId('alert-conversion-notice')).toContainText(
    'Nothing changes until you save.',
  );
  const sqlEditor = page.getByRole('textbox', { name: 'SQL query', exact: true });
  await expect(sqlEditor).toHaveText(alertSql);
  await expect(page.getByLabel('Alert type')).toHaveValue('code');
  await expect(page.getByLabel('Threshold operator')).toHaveValue('>=');
  await expect(page.getByLabel('Threshold value')).toHaveValue('5000.5');
  await expect(page.getByLabel('Evaluation frequency (minutes)')).toHaveValue('15');
  await expect(page.getByLabel('Evaluation window')).toHaveValue('2h');
  await expect(page.getByLabel('Severity')).toHaveValue('critical');
  // The stored SQL really runs: AVG of the three ERROR latencies.
  await page.getByRole('button', { name: 'Preview SQL (no notifications)' }).click();
  await expect(page.getByText('Preview completed: 1 rows. No notifications sent.')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Preview values' })).toContainText('300');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === app(detailPath));
  await expect(page.getByText('Builder', { exact: true })).toBeVisible();
  expect(writes).toEqual([]);
  expect(await getJson<Alert>(request, `/api/v1/alerts/${alertId}`)).toEqual(before);

  // Explicit conversion stores the same SQL and every setting as a code rule.
  await page.getByRole('button', { name: 'Convert to SQL rule', exact: true }).click();
  await expect(sqlEditor).toHaveText(alertSql);
  const conversion = page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' &&
      new URL(response.url()).pathname === `/api/v1/alerts/${alertId}`,
  );
  await page.getByRole('button', { name: 'Convert and save', exact: true }).click();
  const converted = await conversion;
  expect(converted.ok(), await converted.text()).toBe(true);
  await expect(page).toHaveURL((url) => url.pathname === app(detailPath));
  await expect(page.getByText('SQL', { exact: true })).toBeVisible();
  await expect(page.locator('.alerts-query')).toHaveText(alertSql);
  await expect(page.getByText('This alert is disabled.', { exact: false })).toBeVisible();
  await expect(page.locator('.alerts-metadata')).toContainText('Muted indefinitely');
  expect(writes).toEqual([`PUT /api/v1/alerts/${alertId}`]);
  const stored = await getJson<Alert>(request, `/api/v1/alerts/${alertId}`);
  expect(stored).toEqual({ ...before, queryType: 'code' });
  await test.info().attach('converted-alert.png', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });

  // The converted rule uses the ordinary SQL edit flow and its SQL can be changed.
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Edit alert', exact: true })).toBeVisible();
  await expect(page.getByTestId('alert-conversion-notice')).toHaveCount(0);
  await expect(sqlEditor).toHaveText(alertSql);
  await sqlEditor.fill(editedAlertSql);
  await expect(sqlEditor).toHaveText(editedAlertSql);
  await page.getByRole('button', { name: 'Preview SQL (no notifications)' }).click();
  await expect(page.getByRole('region', { name: 'Preview values' })).toContainText('3');
  await page.getByRole('button', { name: 'Save alert', exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === app(detailPath));
  await expect(page.locator('.alerts-query')).toHaveText(editedAlertSql);
  const edited = await getJson<Alert>(request, `/api/v1/alerts/${alertId}`);
  expect(edited).toEqual({ ...before, queryType: 'code', query: editedAlertSql });
});
