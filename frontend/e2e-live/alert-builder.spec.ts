import { randomUUID } from 'node:crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';

const live = process.env.PARSEABLE_LIVE_URL;
const username = process.env.PARSEABLE_LIVE_USERNAME || 'frontend-smoke';
const password = process.env.PARSEABLE_LIVE_PASSWORD || 'local-smoke-password';
const headers = {
  Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
};
const suffix = `${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
const dataset = `builder_live_${suffix}`;
const title = `Builder live ${suffix}`;
const appBase = (process.env.PARSEABLE_LIVE_BASE ?? '').replace(/\/+$/, '');
const ids = new Set<string>();
const config = {
  kind: 'sql',
  version: 1,
  dataset,
  aggregate: { function: 'sum', column: 'value' },
  filters: {
    operator: 'and',
    conditionConfig: [{ column: 'level', operator: '=', value: 'error', type: 'string' }],
  },
  groupBy: ['service'],
};
const body = () => ({
  title,
  severity: 'high',
  queryType: 'builder',
  query: '',
  builderConfig: config,
  datasets: [dataset],
  alertType: 'threshold',
  thresholdConfig: { operator: '>', value: 10 },
  evalConfig: { rollingWindow: { evalStart: '1h', evalEnd: 'now', evalFrequency: 1440 } },
  notificationConfig: { interval: 1440 },
  targets: [],
  tags: ['live-builder-fixture'],
});
test.skip(!live, 'Set PARSEABLE_LIVE_URL to use a disposable real server.');
test.describe.configure({ mode: 'serial' });

async function json(request: APIRequestContext, path: string) {
  const response = await request.get(path, { headers });
  expect(response.status(), await response.text()).toBe(200);
  return response.json();
}
async function create(
  request: APIRequestContext,
  payload: ReturnType<typeof body> | Record<string, unknown>,
) {
  const response = await request.post('/api/v1/alerts', { headers, data: payload });
  expect(response.status(), await response.text()).toBe(200);
  const saved = await response.json();
  ids.add(saved.id);
  return saved;
}
test.beforeAll(async ({ request }) => {
  const about = await json(request, '/api/v1/about');
  expect(about.capabilities).toMatchObject({ alertBuilder: true, alertPreview: true });
  const ingest = await request.post('/api/v1/ingest', {
    headers: { ...headers, 'X-P-Stream': dataset },
    data: [
      { service: 'api', level: 'error', value: 7 },
      { service: 'api', level: 'error', value: 8 },
      { service: 'worker', level: 'error', value: 3 },
      { service: 'api', level: 'info', value: 100 },
    ],
  });
  expect(ingest.ok(), await ingest.text()).toBe(true);
});
test.afterAll(async ({ request }) => {
  if (!live) return;
  // Recover resources by this unique fixture title even if creation assertions failed.
  const list = await json(request, '/api/v1/alerts?limit=1000');
  for (const alert of list)
    if (alert.title.startsWith(title) && alert.datasets.includes(dataset)) ids.add(alert.id);
  const failures: string[] = [];
  for (const id of ids) {
    const response = await request.delete(`/api/v1/alerts/${id}`, { headers });
    if (!response.ok() && response.status() !== 400 && response.status() !== 404)
      failures.push(`alert ${id}: ${response.status()}`);
  }
  const response = await request.delete(`/api/v1/logstream/${dataset}`, { headers });
  if (!response.ok() && response.status() !== 404) failures.push(`dataset: ${response.status()}`);
  expect(failures).toEqual([]);
});

test('preview compiles typed rules, evaluates grouped thresholds and leaves alert resources unchanged', async ({
  request,
}) => {
  const before = await json(request, '/api/v1/alerts?limit=1000');
  let preview: Record<string, any> = {};
  await expect
    .poll(
      async () => {
        const response = await request.post('/api/v1/alerts/preview', { headers, data: body() });
        expect(response.status(), await response.text()).toBe(200);
        preview = await response.json();
        return preview.totalGroups;
      },
      { timeout: 30_000 },
    )
    .toBe(2);
  expect(preview).toMatchObject({
    queryType: 'builder',
    datasets: [dataset],
    measure: 'alert_value',
    dimensions: ['service'],
    simple: false,
    noData: false,
    wouldTrigger: true,
    totalGroups: 2,
    breachedGroups: 1,
    truncated: false,
    groups: [
      { labels: { service: 'api' }, value: 15, breached: true },
      { labels: { service: 'worker' }, value: 3, breached: false },
    ],
  });
  expect(preview.compiledQuery).toContain(`FROM "${dataset}"`);
  expect(preview.builderConfig).toMatchObject(config);
  expect(await json(request, '/api/v1/alerts?limit=1000')).toEqual(before);

  const mismatch = await request.post('/api/v1/alerts/preview', {
    headers,
    data: { ...body(), query: `SELECT COUNT(*) FROM "${dataset}"` },
  });
  expect(mismatch.status(), await mismatch.text()).toBe(409);
  const invalid = await request.post('/api/v1/alerts/preview', {
    headers,
    data: {
      ...body(),
      builderConfig: { ...config, aggregate: { function: 'sum', column: 'service' } },
    },
  });
  expect(invalid.status(), await invalid.text()).toBe(400);
  expect(await json(request, '/api/v1/alerts?limit=1000')).toEqual(before);
});

test('builder round trips and conversion keeps execution ownership; missing specs cannot silently overwrite', async ({
  request,
}) => {
  const saved = await create(request, body());
  const path = `/api/v1/alerts/${saved.id}`;
  const original = await json(request, path);
  expect(original).toMatchObject({
    queryType: 'builder',
    builderStatus: 'editable',
    executionMode: 'owner',
    builderConfig: config,
  });
  expect(original.executionIdentity).toBeUndefined();
  expect(original.query).toContain('SUM("value")');

  const disabled = await request.patch(`${path}/disable`, { headers });
  expect(disabled.ok(), await disabled.text()).toBe(true);
  const unchanged = await json(request, path);
  const preview = await request.post('/api/v1/alerts/preview', { headers, data: body() });
  expect(preview.status(), await preview.text()).toBe(200);
  expect(await json(request, path)).toEqual(unchanged);
  const evaluate = await request.put(`${path}/evaluate_alert`, { headers });
  expect(evaluate.status(), await evaluate.text()).toBe(400);

  const withoutSpec: Record<string, unknown> = { ...body(), query: original.query };
  delete withoutSpec.builderConfig;
  const ambiguous = await request.put(path, { headers, data: withoutSpec });
  expect(ambiguous.status(), await ambiguous.text()).toBe(409);
  const edit = await request.put(path, { headers, data: { ...body(), title: `${title} edited` } });
  expect(edit.status(), await edit.text()).toBe(200);
  expect(await json(request, path)).toMatchObject({
    builderConfig: config,
    builderStatus: 'editable',
    state: 'disabled',
  });
  const convert = await request.put(path, { headers, data: { ...withoutSpec, queryType: 'code' } });
  expect(convert.status(), await convert.text()).toBe(200);
  const converted = await json(request, path);
  expect(converted).toMatchObject({
    queryType: 'code',
    query: original.query,
    executionMode: 'owner',
  });
  expect(converted.builderConfig).toBeUndefined();
  expect(converted.executionIdentity).toBeUndefined();
});

test('legacy SQL stays server-owned and builder bounds reject unsafe requests', async ({
  request,
}) => {
  const legacy: Record<string, unknown> = {
    ...body(),
    query: `SELECT COUNT(*) AS count FROM "${dataset}"`,
    title: `${title} legacy`,
  };
  delete legacy.builderConfig;
  const saved = await create(request, legacy);
  const path = `/api/v1/alerts/${saved.id}`;
  expect(await json(request, path)).toMatchObject({
    queryType: 'builder',
    executionMode: 'server',
  });
  const converted = await request.put(path, { headers, data: { ...legacy, queryType: 'code' } });
  expect(converted.status(), await converted.text()).toBe(200);
  expect(await json(request, path)).toMatchObject({ queryType: 'code', executionMode: 'server' });
  for (const builderConfig of [
    { ...config, version: 999 },
    { ...config, groupBy: ['service', 'service'] },
    {
      ...config,
      filters: {
        operator: 'and',
        conditionConfig: [{ column: 'value', operator: '=', value: '1e400', type: 'float' }],
      },
    },
  ]) {
    const response = await request.post('/api/v1/alerts', {
      headers,
      data: { ...body(), builderConfig },
    });
    expect(response.status(), await response.text()).toBe(400);
  }
});

test('guided UI authors, previews and reopens a rule compiled by the real server', async ({
  page,
}) => {
  await page.goto(`${appBase}/login?next=${encodeURIComponent('/alerts/new')}`);
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await page.getByLabel('Alert type', { exact: true }).selectOption('builder');
  await page.getByLabel('Dataset', { exact: true }).selectOption(dataset);
  await page.getByLabel('Aggregate function', { exact: true }).selectOption('sum');
  await page.getByLabel('Aggregate field', { exact: true }).selectOption('value');
  await page.getByRole('button', { name: 'Add filters condition', exact: true }).click();
  await page.getByLabel('Filters field 1', { exact: true }).selectOption('level');
  await page.getByLabel('Filters value 1', { exact: true }).fill('error');
  await page
    .getByRole('group', { name: 'Group by (up to 3 fields)', exact: true })
    .getByLabel('service', { exact: true })
    .check();
  await page.getByLabel('Threshold value', { exact: true }).fill('10');
  await page.getByLabel('Evaluation frequency (minutes)', { exact: true }).fill('1440');
  await page.getByLabel('Title', { exact: true }).fill(`${title} UI`);
  await page.getByRole('button', { name: 'Preview SQL (no notifications)', exact: true }).click();
  await expect(page.getByLabel('Generated SQL', { exact: true })).toContainText(
    'SUM("value") AS "alert_value"',
  );
  await expect(page.getByRole('table', { name: 'Preview values', exact: true })).toContainText(
    '15',
  );
  const responsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/v1/alerts' &&
      response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Create alert', exact: true }).click();
  const response = await responsePromise;
  expect(response.status(), await response.text()).toBe(200);
  ids.add((await response.json()).id);
  await expect(page.getByRole('heading', { name: `${title} UI`, exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.getByLabel('Aggregate function', { exact: true })).toHaveValue('sum');
  await expect(page.getByLabel('Aggregate field', { exact: true })).toHaveValue('value');
  await expect(page.getByLabel('Filters value 1', { exact: true })).toHaveValue('error');
});

test('preview checks permission and scheduled rules stop evaluating after owner access is revoked', async ({
  request,
}) => {
  const roleName = `builder-role-${suffix.replaceAll('_', '-')}`;
  const userName = `builder-user-${suffix.replaceAll('_', '-')}`;
  const rolePath = `/api/v1/role/${roleName}`;
  const userPath = `/api/v1/user/${userName}`;
  const deniedDataset = `${dataset}_denied`;
  let ownedId: string | undefined;
  try {
    const ingest = await request.post('/api/v1/ingest', {
      headers: { ...headers, 'X-P-Stream': deniedDataset },
      data: [{ service: 'api', level: 'error', value: 1 }],
    });
    expect(ingest.ok(), await ingest.text()).toBe(true);
    const role = await request.put(rolePath, {
      headers,
      data: [{ privilege: 'reader', resource: { stream: dataset } }],
    });
    expect(role.ok(), await role.text()).toBe(true);
    const user = await request.post(userPath, { headers, data: [roleName] });
    expect(user.ok(), await user.text()).toBe(true);
    const userHeaders = {
      Authorization: `Basic ${Buffer.from(`${userName}:${await user.text()}`).toString('base64')}`,
    };
    const readerPreview = await request.post('/api/v1/alerts/preview', {
      headers: userHeaders,
      data: body(),
    });
    expect(readerPreview.status(), await readerPreview.text()).toBe(403);

    const writer = await request.put(rolePath, {
      headers,
      data: [{ privilege: 'writer', resource: { stream: dataset } }],
    });
    expect(writer.ok(), await writer.text()).toBe(true);
    const deniedPreview = await request.post('/api/v1/alerts/preview', {
      headers: userHeaders,
      data: { ...body(), builderConfig: { ...config, dataset: deniedDataset } },
    });
    expect(deniedPreview.ok(), await deniedPreview.text()).toBe(false);
    const permittedPreview = await request.post('/api/v1/alerts/preview', {
      headers: userHeaders,
      data: body(),
    });
    expect(permittedPreview.status(), await permittedPreview.text()).toBe(200);
    const created = await request.post('/api/v1/alerts', {
      headers: userHeaders,
      data: { ...body(), title: `${title} owned` },
    });
    expect(created.status(), await created.text()).toBe(200);
    ownedId = (await created.json()).id as string;
    ids.add(ownedId);
    const path = `/api/v1/alerts/${ownedId}`;
    // Unauthorized schema probes must fail before resolving fields or loading a stream.
    // The response is identical for numeric, nonnumeric, absent columns and absent streams.
    const forbiddenBodies = new Set<string>();
    for (const stream of [deniedDataset, `${deniedDataset}_missing`]) {
      for (const column of ['value', 'service', 'missing_column']) {
        const probe = {
          ...body(),
          builderConfig: {
            ...config,
            dataset: stream,
            aggregate: { function: 'sum', column },
          },
        };
        for (const [method, endpoint] of [
          ['post', '/api/v1/alerts/preview'],
          ['post', '/api/v1/alerts'],
          ['put', path],
        ] as const) {
          const response = await request[method](endpoint, { headers: userHeaders, data: probe });
          const message = await response.text();
          expect(response.status(), message).toBe(403);
          forbiddenBodies.add(message);
        }
      }
    }
    expect(forbiddenBodies.size).toBe(1);
    expect(await json(request, path)).toMatchObject({ builderConfig: config });
    await expect
      .poll(async () => (await json(request, path)).sqlRuntime?.health, { timeout: 30_000 })
      .toBe('ok');
    const before = await json(request, path);
    expect(before.executionOwner).toBe(userName);
    expect(before.executionIdentity).toBeUndefined();
    const revoke = await request.put(rolePath, {
      headers,
      data: [{ privilege: 'writer', resource: { stream: deniedDataset } }],
    });
    expect(revoke.ok(), await revoke.text()).toBe(true);
    const evaluate = await request.put(`${path}/evaluate_alert`, { headers });
    expect(evaluate.ok(), await evaluate.text()).toBe(true);
    await expect
      .poll(async () => (await json(request, path)).sqlRuntime?.health, { timeout: 30_000 })
      .toBe('error');
    const after = await json(request, path);
    expect(after.state).toBe(before.state);
    expect(after.sqlRuntime.error).toMatch(/permission|access|owner/i);
    expect(after.executionMode).toBe('owner');
  } finally {
    // Remove the owner-bound rule before deleting its fixture identity.
    if (ownedId) {
      const removed = await request.delete(`/api/v1/alerts/${ownedId}`, { headers });
      expect(removed.ok(), await removed.text()).toBe(true);
      ids.delete(ownedId);
    }
    for (const path of [userPath, rolePath, `/api/v1/logstream/${deniedDataset}`]) {
      const removed = await request.delete(path, { headers });
      expect(removed.ok() || removed.status() === 404, await removed.text()).toBe(true);
    }
  }
});
