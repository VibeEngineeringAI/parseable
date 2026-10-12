import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';

const live = process.env.PARSEABLE_LIVE_URL;
const username = process.env.PARSEABLE_LIVE_USERNAME || 'frontend-smoke';
const password = process.env.PARSEABLE_LIVE_PASSWORD || 'local-smoke-password';
const base = (process.env.PARSEABLE_LIVE_BASE ?? '').replace(/\/+$/, '');
const app = (route: string) => `${base}${route}`;
const headers = {
  Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
};
const name = `ingestion_live_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
const datasetPath = `/api/v1/logstream/${encodeURIComponent(name)}`;
let attemptedCreate = false;
const otlpNames = new Set<string>();

test.skip(!live, 'Set PARSEABLE_LIVE_URL to opt in to the real-server suite.');

test.afterAll(async ({ request }) => {
  if (!live) return;
  for (const dataset of [...(attemptedCreate ? [name] : []), ...otlpNames]) {
    const response = await request.delete(`/api/v1/logstream/${encodeURIComponent(dataset)}`, {
      headers,
      timeout: 10_000,
    });
    expect(response.ok() || response.status() === 404, await response.text()).toBe(true);
  }
});

test('JSON setup creates a dataset, produces a native ingestion request, and verifies real events', async ({
  page,
  request,
}) => {
  await page.goto(app(`/login?next=${encodeURIComponent('/add-data')}`));
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await expect(page).toHaveURL(new URL(app('/add-data'), live).href);
  await expect(page.getByRole('heading', { name: 'Add data', exact: true })).toBeVisible();
  await page.getByLabel('Public ingestion endpoint').fill(new URL(live!).origin);
  await page.getByRole('button', { name: 'Create new dataset', exact: true }).click();
  await page.getByLabel('New dataset name', { exact: true }).fill(name);
  attemptedCreate = true;
  const creation = page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' && new URL(response.url()).pathname === datasetPath,
  );
  await page.getByRole('button', { name: 'Create dataset', exact: true }).click();
  const created = await creation;
  expect(created.ok(), await created.text()).toBe(true);
  expect(created.request().headers()['x-p-log-source']).toBe('json');
  await expect(page.getByLabel('Destination dataset', { exact: true })).toHaveValue(name);
  const command = page.getByLabel('Ingestion command', { exact: true });
  await expect(command).toBeVisible();
  const code = await command.textContent();
  expect(code).toContain('Bearer ${PARSEABLE_API_KEY:?Set PARSEABLE_API_KEY}');
  expect(code).not.toContain(password);
  const endpoint = code?.match(/--request POST '([^']+)'/)?.[1];
  const stream = code?.match(/--header 'X-P-Stream: ([^']+)'/)?.[1];
  const body = code?.match(/--data-binary '([^']+)'/)?.[1];
  expect(endpoint).toBe(new URL('/api/v1/ingest', live).href);
  expect(stream).toBe(name);
  expect(body).toBeDefined();
  await page.getByRole('button', { name: 'Check ingestion', exact: true }).click();
  await expect(page.getByText('No events yet', { exact: true })).toBeVisible();
  // Execute the generated route, destination header and JSON body through the
  // request client, using the disposable fixture's native credentials. Never
  // interpolate browser-generated text into a shell command.
  const ingested = await request.post(endpoint!, {
    headers: { ...headers, 'X-P-Stream': stream!, 'Content-Type': 'application/json' },
    data: JSON.parse(body!),
    timeout: 10_000,
  });
  expect(ingested.ok(), await ingested.text()).toBe(true);
  await expect
    .poll(async () => {
      const response = await request.get(`${datasetPath}/stats`, { headers, timeout: 10_000 });
      expect(response.ok(), await response.text()).toBe(true);
      const result: { ingestion: { count: number } } = await response.json();
      return result.ingestion.count;
    })
    .toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Check ingestion', exact: true }).click();
  await expect(page.getByText('1 new event', { exact: true })).toBeVisible();
  await expect(page.locator('.ingestion-check-result')).toContainText(
    'These arrivals may include other senders',
  );
  await expect(page.getByRole('link', { name: 'Explore logs', exact: true })).toHaveAttribute(
    'href',
    app(`/logs/explore/${name}`),
  );
});

for (const signal of ['logs', 'metrics', 'traces'] as const)
  test(`generated OTLP ${signal} payload is accepted by the real JSON ingestion handler`, async ({
    page,
    request,
  }) => {
    const dataset = `${name}_${signal}`;
    const path = `/api/v1/logstream/${dataset}`;
    await page.goto(app(`/login?next=${encodeURIComponent('/add-data')}`));
    await page.getByLabel('Username', { exact: true }).fill(username);
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Login', exact: true }).click();
    await expect(page).toHaveURL(new URL(app('/add-data'), live).href);
    await page.getByLabel('Public ingestion endpoint').fill(new URL(live!).origin);
    await page.getByRole('radio', { name: /^OTLP HTTP/ }).check();
    await page.getByLabel('Signal', { exact: true }).selectOption(signal);
    await page.getByRole('button', { name: 'Create new dataset', exact: true }).click();
    await page.getByLabel('New dataset name', { exact: true }).fill(dataset);
    otlpNames.add(dataset);
    const creation = page.waitForResponse(
      (response) =>
        response.request().method() === 'PUT' && new URL(response.url()).pathname === path,
    );
    await page.getByRole('button', { name: 'Create dataset', exact: true }).click();
    const created = await creation;
    expect(created.ok(), await created.text()).toBe(true);
    expect(created.request().headers()['x-p-log-source']).toBe(`otel-${signal}`);
    const command = page.getByLabel('Ingestion command', { exact: true });
    await expect(command).toBeVisible();
    const code = await command.textContent();
    const payloadTemplate = code
      ?.split('<<PARSEABLE_OTLP_JSON\n')[1]
      ?.split('\nPARSEABLE_OTLP_JSON')[0];
    expect(payloadTemplate).toBeDefined();
    const timestamp = BigInt(Math.floor(Date.now() / 1000)) * 1_000_000_000n;
    const payload: unknown = JSON.parse(
      payloadTemplate!
        .replaceAll('${PARSEABLE_SAMPLE_TIME}', String(timestamp))
        .replaceAll('${PARSEABLE_SAMPLE_END}', String(timestamp + 1_000_000n)),
    );
    await page.getByRole('button', { name: 'Check ingestion', exact: true }).click();
    await expect(page.getByText('No events yet', { exact: true })).toBeVisible();
    const response = await request.post(`/v1/${signal}`, {
      headers: { ...headers, 'X-P-Stream': dataset, 'Content-Type': 'application/json' },
      data: payload,
      timeout: 10_000,
    });
    expect(response.ok(), await response.text()).toBe(true);
    let observedEvents = 0;
    await expect
      .poll(async () => {
        const result = await request.get(`${path}/stats`, { headers, timeout: 10_000 });
        expect(result.ok(), await result.text()).toBe(true);
        const stats: { ingestion: { lifetime_count: number } } = await result.json();
        observedEvents = stats.ingestion.lifetime_count;
        return observedEvents;
      })
      .toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Check ingestion', exact: true }).click();
    // A metric payload may produce multiple stored events. Match the actual
    // server counter rather than treating one OTLP envelope as one event.
    await expect(
      page.getByText(`${observedEvents} new ${observedEvents === 1 ? 'event' : 'events'}`, {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.locator('.ingestion-check-result')).toContainText(
      'does not verify this source connection',
    );
  });
