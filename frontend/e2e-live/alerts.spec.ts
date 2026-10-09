import { randomUUID } from 'node:crypto';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import type {
  Alert,
  AlertSummary,
  AlertTarget,
  AlertTargetStatus,
  PromqlInstantResult,
} from '../src/lib/types';

const live = process.env.PARSEABLE_LIVE_URL;
const username = process.env.PARSEABLE_LIVE_USERNAME || 'frontend-smoke',
  password = process.env.PARSEABLE_LIVE_PASSWORD || 'local-smoke-password';
const base = (process.env.PARSEABLE_LIVE_BASE ?? '/next').replace(/\/+$/, '');
const app = (route: string) => `${base}${route}`,
  appUrl = (route: string) => new URL(app(route), live).href;
const headers = {
  Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
};
const suffix = `${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
const dataset = `alerts_live_${suffix}`,
  metric = `frontend.alerts.gauge_${suffix}`,
  query = `{"${metric}"}`;
const title = `Alerts live ${suffix}`,
  editedTitle = `${title} edited`,
  targetName = `alerts-hook-${suffix}`;
let alertId: string | undefined,
  targetId: string | undefined,
  attemptedIngest = false;
test.skip(!live, 'Set PARSEABLE_LIVE_URL to opt in to the real-server suite.');
test.describe.configure({ mode: 'serial' });
async function signIn(page: Page, path: string) {
  await page.goto(app(`/login?next=${encodeURIComponent(path)}`));
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await expect(page).toHaveURL(appUrl(path));
}
async function getJson<T>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.get(path, { headers, timeout: 10_000 });
  expect(response.status(), await response.text()).toBe(200);
  return response.json();
}
test.beforeAll(async ({ request }) => {
  const now = Math.floor(Date.now() / 1000);
  const points = ['node-a', 'node-b'].flatMap((host, hostIndex) =>
    Array.from({ length: 11 }, (_, index) => ({
      timeUnixNano: String(BigInt(now - 150 + index * 15) * 1_000_000_000n),
      asDouble: hostIndex ? 7.5 : 3.25,
      attributes: [{ key: 'host', value: { stringValue: host } }],
    })),
  );
  attemptedIngest = true;
  const response = await request.post('/v1/metrics', {
    headers: { ...headers, 'X-P-Stream': dataset, 'Content-Type': 'application/json' },
    data: {
      resourceMetrics: [
        {
          resource: {
            attributes: [{ key: 'service.name', value: { stringValue: 'frontend-alerts-live' } }],
          },
          scopeMetrics: [
            {
              scope: { name: 'frontend-alerts-live' },
              metrics: [{ name: metric, gauge: { dataPoints: points } }],
            },
          ],
        },
      ],
    },
    timeout: 10_000,
  });
  expect(response.ok(), await response.text()).toBe(true);
  await expect
    .poll(
      async () => {
        const response = await request.get(
          `/prometheus/api/v1/query?${new URLSearchParams({ stream: dataset, query })}`,
          { headers, timeout: 2000 },
        );
        if (!response.ok()) return 0;
        const body = await response.json();
        return body.status === 'success' && body.data?.resultType === 'vector'
          ? body.data.result.length
          : 0;
      },
      { timeout: 30_000, intervals: [500, 1000] },
    )
    .toBe(2);
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
  async function remove(path: string, missingStatus: number) {
    const response = await request.delete(path, { headers, timeout: 5000 });
    expect(response.ok() || response.status() === missingStatus, await response.text()).toBe(true);
  }
  // Discover names too, so resources are removed if an ID assertion failed after creation.
  await cleanup('alerts', async () => {
    const ids = new Set<string>();
    if (alertId) ids.add(alertId);
    for (let offset = 0; ; offset += 1000) {
      const rows = await getJson<AlertSummary[]>(
        request,
        `/api/v1/alerts?limit=1000&offset=${offset}`,
      );
      rows
        .filter((row) => [title, editedTitle].includes(row.title) && row.datasets.includes(dataset))
        .forEach((row) => ids.add(row.id));
      if (rows.length < 1000) break;
    }
    for (const id of ids)
      await cleanup(`alert ${id}`, () => remove(`/api/v1/alerts/${encodeURIComponent(id)}`, 400));
  });
  await cleanup('targets', async () => {
    const ids = new Set<string>();
    if (targetId) ids.add(targetId);
    (await getJson<AlertTargetStatus[]>(request, '/api/v1/targets'))
      .filter(({ target }) => target.name === targetName)
      .forEach(({ target }) => ids.add(target.id));
    for (const id of ids)
      await cleanup(`target ${id}`, () => remove(`/api/v1/targets/${encodeURIComponent(id)}`, 400));
  });
  if (attemptedIngest)
    await cleanup('OTLP dataset', () =>
      remove(`/api/v1/logstream/${encodeURIComponent(dataset)}`, 404),
    );
  if (errors.length) throw new AggregateError(errors, 'Alerts live-test cleanup failed.');
});
test('create a real masked webhook target and PromQL alert through the UI; preview matches OTLP values', async ({
  page,
  request,
}) => {
  await signIn(page, '/alerts/targets');
  await page.getByRole('button', { name: 'New target', exact: true }).first().click();
  const sheet = page.getByRole('dialog', { name: 'New target', exact: true });
  await sheet.getByLabel('Target name').fill(targetName);
  await sheet.getByLabel('Endpoint URL').fill('https://example.com/parseable-alerts-live');
  const targetCreated = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/v1/targets' &&
      response.request().method() === 'POST',
  );
  await sheet.getByRole('button', { name: 'Create target', exact: true }).click();
  const targetResponse = await targetCreated;
  expect(targetResponse.status(), await targetResponse.text()).toBe(200);
  targetId = ((await targetResponse.json()) as AlertTarget).id;
  await expect(
    page.getByRole('row').filter({ has: page.getByText(targetName, { exact: true }) }),
  ).toContainText('https://********');
  const target = await getJson<AlertTargetStatus>(request, `/api/v1/targets/${targetId}`);
  expect(target.enabled).toBe(true);
  expect(target.target.endpoint).toBe('https://********');
  await page.getByRole('link', { name: 'Back to alerts', exact: true }).click();
  await page.getByRole('link', { name: 'New alert', exact: true }).first().click();
  await page.getByLabel('Dataset', { exact: true }).selectOption(dataset);
  await page.getByRole('textbox', { name: 'PromQL query', exact: true }).fill(query);
  await page.getByLabel('Threshold value').fill('100');
  await page.getByLabel('Hold duration').fill('5m');
  await page.getByLabel('Evaluation frequency (minutes)').fill('1440');
  await page.getByLabel('Title', { exact: true }).fill(title);
  await page.getByRole('checkbox', { name: targetName, exact: true }).check();
  const previewed = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/prometheus/api/v1/query' &&
      new URLSearchParams(response.request().postData() ?? '').get('query') === query,
  );
  await page
    .getByRole('button', { name: 'Preview current values (no notifications)', exact: true })
    .click();
  const previewResponse = await previewed;
  expect(previewResponse.status(), await previewResponse.text()).toBe(200);
  const preview = page.getByRole('table', { name: 'Preview values' });
  await expect(preview.getByRole('row')).toHaveCount(3);
  await expect(preview).toContainText('3.25');
  await expect(preview).toContainText('7.5');
  await expect(preview).toContainText('Within threshold');
  const independent = await getJson<{ data: PromqlInstantResult }>(
    request,
    `/prometheus/api/v1/query?${new URLSearchParams({ stream: dataset, query })}`,
  );
  expect(independent.data.resultType).toBe('vector');
  if (independent.data.resultType !== 'vector') throw new Error('Expected an instant vector');
  expect(independent.data.result.map((row) => Number(row.value[1])).sort()).toEqual([3.25, 7.5]);
  const created = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/v1/alerts' &&
      response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Create alert', exact: true }).click();
  const response = await created;
  expect(response.status(), await response.text()).toBe(200);
  alertId = ((await response.json()) as Alert).id;
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  const persisted = await getJson<Alert>(request, `/api/v1/alerts/${alertId}`);
  expect(persisted).toMatchObject({
    queryType: 'promql',
    query,
    datasets: [dataset],
    promqlConfig: { holdDuration: '5m' },
    evalConfig: { rollingWindow: { evalFrequency: 1440 } },
    targets: [targetId],
  });
});
test('evaluate, mute/unmute and disable/enable update the real rule and its runtime', async ({
  page,
  request,
}) => {
  await signIn(page, `/alerts/${alertId}`);
  let before: Alert | undefined;
  await expect
    .poll(
      async () => {
        before = await getJson<Alert>(request, `/api/v1/alerts/${alertId}`);
        return before.promqlRuntime?.lastEvaluatedAt ?? null;
      },
      { timeout: 15_000, intervals: [500, 1000] },
    )
    .not.toBeNull();
  expect(before!.evalConfig.rollingWindow.evalFrequency).toBe(1440);
  const previous = Date.parse(before!.promqlRuntime!.lastEvaluatedAt!);
  expect(Number.isFinite(previous)).toBe(true);
  const evaluated = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/api/v1/alerts/${alertId}/evaluate_alert` &&
      response.request().method() === 'PUT',
  );
  const refreshed = page.waitForResponse(async (response) => {
    if (
      new URL(response.url()).pathname !== `/api/v1/alerts/${alertId}` ||
      response.request().method() !== 'GET' ||
      !response.ok()
    )
      return false;
    const updated = (await response.json()) as Alert;
    return Date.parse(updated.promqlRuntime?.lastEvaluatedAt ?? '') > previous;
  });
  await page.getByRole('button', { name: 'Evaluate now', exact: true }).click();
  const evaluationResponse = await evaluated;
  expect(evaluationResponse.status(), await evaluationResponse.text()).toBe(200);
  await expect(page.getByRole('status').filter({ hasText: 'Evaluation requested' })).toBeVisible();
  await expect
    .poll(
      async () => {
        const rule = await getJson<Alert>(request, `/api/v1/alerts/${alertId}`);
        return (
          rule.promqlRuntime?.health === 'ok' &&
          Date.parse(rule.promqlRuntime.lastEvaluatedAt ?? '') > previous
        );
      },
      { timeout: 15_000, intervals: [500, 1000] },
    )
    .toBe(true);
  const uiRuntime = ((await (await refreshed).json()) as Alert).promqlRuntime!;
  expect(uiRuntime.health).toBe('ok');
  expect(Date.parse(uiRuntime.lastEvaluatedAt!)).toBeGreaterThan(previous);
  const iso = new Date(uiRuntime.lastEvaluatedAt!).toISOString();
  await expect(page.getByTestId('last-evaluated').locator('time')).toHaveAttribute('datetime', iso);
  await expect(page.getByTestId('last-evaluated')).toContainText(
    `${iso.slice(0, 19).replace('T', ' ')} UTC`,
  );
  await page.getByRole('button', { name: 'Mute', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Mute notifications' })
    .getByRole('button', { name: '1 hour', exact: true })
    .click();
  await expect(page.getByRole('button', { name: 'Unmute', exact: true })).toBeVisible();
  expect(
    (await getJson<Alert>(request, `/api/v1/alerts/${alertId}`)).notificationState,
  ).toHaveProperty('mute');
  await page.getByRole('button', { name: 'Unmute', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Mute', exact: true })).toBeVisible();
  expect((await getJson<Alert>(request, `/api/v1/alerts/${alertId}`)).notificationState).toBe(
    'notify',
  );
  await page.getByRole('button', { name: 'Disable', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Enable', exact: true })).toBeVisible();
  expect((await getJson<Alert>(request, `/api/v1/alerts/${alertId}`)).state).toBe('disabled');
  await expect(page.getByRole('button', { name: 'Evaluate now', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Enable', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Disable', exact: true })).toBeVisible();
  expect((await getJson<Alert>(request, `/api/v1/alerts/${alertId}`)).state).toBe('not-triggered');
});
test('edit resends hold duration, then deletes the real alert and target through typed confirmation', async ({
  page,
  request,
}) => {
  await signIn(page, `/alerts/${alertId}/edit`);
  await expect(page.getByLabel('Dataset', { exact: true })).toBeDisabled();
  await expect(page.getByLabel('Hold duration')).toHaveValue('5m');
  await page.getByLabel('Title', { exact: true }).fill(editedTitle);
  await page.getByLabel('Threshold value').fill('101');
  const updated = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/api/v1/alerts/${alertId}` &&
      response.request().method() === 'PUT',
  );
  await page.getByRole('button', { name: 'Save alert', exact: true }).click();
  const response = await updated;
  expect(response.status(), await response.text()).toBe(200);
  expect(response.request().postDataJSON().promqlConfig).toEqual({ holdDuration: '5m' });
  await expect(page.getByRole('heading', { name: editedTitle, exact: true })).toBeVisible();
  expect((await getJson<Alert>(request, `/api/v1/alerts/${alertId}`)).promqlConfig).toEqual({
    holdDuration: '5m',
  });
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'Delete alert', exact: true });
  await dialog.getByLabel('Confirmation name').fill(editedTitle);
  await dialog.locator('[data-dialog-confirm]').click();
  await expect(page).toHaveURL(appUrl('/alerts'));
  expect(
    (await getJson<AlertSummary[]>(request, '/api/v1/alerts?limit=1000')).some(
      (row) => row.id === alertId,
    ),
  ).toBe(false);
  await page.getByRole('link', { name: 'Targets', exact: true }).click();
  await page
    .getByRole('row')
    .filter({ has: page.getByText(targetName, { exact: true }) })
    .getByRole('button', { name: `Actions for ${targetName}` })
    .click();
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Delete target', exact: true });
  await dialog.getByLabel('Confirmation name').fill(targetName);
  await dialog.locator('[data-dialog-confirm]').click();
  await expect(
    page.getByRole('row').filter({ has: page.getByText(targetName, { exact: true }) }),
  ).toHaveCount(0);
  await expect(page.locator('.alerts-table [data-row-action]').first()).toBeFocused();
  expect(
    (await getJson<AlertTargetStatus[]>(request, '/api/v1/targets')).some(
      ({ target }) => target.id === targetId,
    ),
  ).toBe(false);
});
