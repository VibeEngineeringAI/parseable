import { randomUUID } from 'node:crypto';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { formatValue } from '../src/lib/promql';
import type { PromqlInstantResult } from '../src/lib/types';

const live = process.env.PARSEABLE_LIVE_URL;
const username = process.env.PARSEABLE_LIVE_USERNAME || 'frontend-smoke';
const password = process.env.PARSEABLE_LIVE_PASSWORD || 'local-smoke-password';
const base = (process.env.PARSEABLE_LIVE_BASE ?? '/next').replace(/\/+$/, '');
const app = (route: string) => `${base}${route}`;
const appUrl = (route: string) => new URL(app(route), live).href;
const headers = {
  Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
};
const suffix = `${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
const dataset = `metrics_live_${suffix}`;
const path = `/metrics/explore/${dataset}`;
const gauge = `frontend.live.gauge_${suffix}`;
const counter = `frontend.live.counter_${suffix}`;
const gaugeQuery = `{"${gauge}"}`;
const rateQuery = `sum by (host) (rate({"${counter}"}[5m]))`;
const hosts = ['node-a', 'node-b'];
let attemptedIngest = false;

test.skip(!live, 'Set PARSEABLE_LIVE_URL to opt in to the real-server suite.');
test.describe.configure({ mode: 'serial' });

async function signIn(page: Page) {
  await page.goto(app(`/login?next=${encodeURIComponent(path)}`));
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await expect(page).toHaveURL(appUrl(path));
  await expect(page.getByRole('textbox', { name: 'PromQL query A', exact: true })).toBeVisible();
}

test.beforeAll(async ({ request }) => {
  const now = Math.floor(Date.now() / 1000);
  const nanoseconds = (seconds: number) => String(BigInt(seconds) * 1_000_000_000n);
  const points = (counter: boolean) =>
    hosts.flatMap((host, hostIndex) =>
      Array.from({ length: 11 }, (_, index) => ({
        timeUnixNano: nanoseconds(now - 180 + index * 15),
        ...(counter ? { startTimeUnixNano: nanoseconds(now - 240) } : {}),
        asDouble: counter ? 100 + index * (hostIndex + 1) * 15 : hostIndex ? 7.5 : 3.25,
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
            attributes: [{ key: 'service.name', value: { stringValue: 'frontend-metrics-live' } }],
          },
          scopeMetrics: [
            {
              scope: { name: 'frontend-metrics-live' },
              metrics: [
                { name: gauge, gauge: { dataPoints: points(false) } },
                {
                  name: counter,
                  sum: { aggregationTemporality: 2, isMonotonic: true, dataPoints: points(true) },
                },
              ],
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
          `/prometheus/api/v1/query?${new URLSearchParams({ stream: dataset, query: gaugeQuery })}`,
          { headers, timeout: 2000 },
        );
        if (!response.ok()) return 0;
        const payload = await response.json();
        return payload.status === 'success' && payload.data?.resultType === 'vector'
          ? payload.data.result.length
          : 0;
      },
      {
        timeout: 30_000,
        intervals: [500, 1000],
        message: 'OTLP gauge becomes queryable within 30 seconds',
      },
    )
    .toBe(2);
});

test.afterAll(async ({ request }) => {
  if (!live || !attemptedIngest) return;
  const response = await request.delete(`/api/v1/logstream/${encodeURIComponent(dataset)}`, {
    headers,
    timeout: 10_000,
  });
  expect(response.ok() || response.status() === 404, await response.text()).toBe(true);
});

async function runAndCompare(page: Page, request: APIRequestContext, query: string) {
  await page.getByRole('textbox', { name: 'PromQL query A', exact: true }).fill(query);
  const instantResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/prometheus/api/v1/query' &&
      new URLSearchParams(response.request().postData() ?? '').get('query') === query,
  );
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  const response = await instantResponse;
  expect(response.status(), await response.text()).toBe(200);
  const params = new URLSearchParams(response.request().postData()!);
  // Compare the displayed values with an independently authenticated API request at the same instant.
  const api = await request.post('/prometheus/api/v1/query', {
    headers,
    form: { stream: dataset, query, time: params.get('time')! },
  });
  expect(api.status(), await api.text()).toBe(200);
  const payload: { status: string; data: PromqlInstantResult } = await api.json();
  expect(payload.status).toBe('success');
  expect(payload.data.resultType).toBe('vector');
  if (payload.data.resultType !== 'vector') throw new Error('Expected two instant vector series.');
  expect(payload.data.result).toHaveLength(2);
  const legend = page.getByRole('list', { name: 'Series visibility' });
  await expect(legend.getByRole('button')).toHaveCount(2);
  for (const host of hosts) await expect(legend).toContainText(`host="${host}"`);
  await page.getByRole('tab', { name: 'Table', exact: true }).click();
  const table = page.getByRole('table', { name: 'Instant results', exact: true });
  for (const { metric, value } of payload.data.result) {
    const row = table.getByRole('row').filter({ hasText: `host="${metric.host}"` });
    await expect(row.getByRole('cell').nth(1)).toHaveText(formatValue(value[1]));
  }
  await expect(page.getByRole('table', { name: 'Range summary', exact: true })).toBeVisible();
  return table;
}

test('real OTLP metadata lists the gauge and its host values, then gauge results match the API', async ({
  page,
  request,
}) => {
  await signIn(page);
  const browser = page.getByRole('complementary', { name: 'Label browser' });
  await browser.getByRole('button', { name: gauge, exact: true }).click();
  await browser.getByRole('button', { name: 'host', exact: true }).click();
  for (const host of hosts)
    await expect(browser.getByRole('button', { name: host, exact: true })).toBeVisible();
  const table = await runAndCompare(page, request, gaugeQuery);
  await expect(table).toContainText(gauge);
  await expect(table).toContainText('3.25');
  await expect(table).toContainText('7.50');
});

test('cumulative-counter rate has two host series and values matching the API', async ({
  page,
  request,
}) => {
  await signIn(page);
  await runAndCompare(page, request, rateQuery);
});

test('an unsupported real query displays the verbatim 422 execution message', async ({ page }) => {
  await signIn(page);
  const query = `topk(1, ${gaugeQuery})`;
  await page.getByRole('textbox', { name: 'PromQL query A', exact: true }).fill(query);
  const failed = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/prometheus/api/v1/query_range' &&
      new URLSearchParams(response.request().postData() ?? '').get('query') === query,
  );
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  const response = await failed;
  expect(response.status()).toBe(422);
  const payload = await response.json();
  expect(payload.errorType).toBe('execution');
  const alert = page.getByRole('alert').filter({ hasText: 'Range' });
  await expect(alert).toContainText('A · execution');
  await expect(alert.locator('pre')).toHaveText(payload.error);
});
