import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';

const live = process.env.PARSEABLE_LIVE_URL;
const username = process.env.PARSEABLE_LIVE_USERNAME || 'frontend-smoke';
const password = process.env.PARSEABLE_LIVE_PASSWORD || 'local-smoke-password';
const base = (process.env.PARSEABLE_LIVE_BASE ?? '').replace(/\/+$/, '');
const headers = {
  Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
};
const dataset = `apm_trace_live_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
const traceId = randomUUID().replaceAll('-', '');
const spanId = randomUUID().replaceAll('-', '').slice(0, 16);
const service = `apm-live-${randomUUID().slice(0, 8)}`;
const operation = 'fractional-window-investigation';
let attemptedIngest = false;
test.skip(!live, 'Set PARSEABLE_LIVE_URL to opt in to the real-server suite.');

test.afterAll(async ({ request }) => {
  if (!attemptedIngest) return;
  const response = await request.delete(`/api/v1/logstream/${dataset}`, { headers });
  expect(response.ok() || response.status() === 404, await response.text()).toBe(true);
});

test('APM investigation preserves fractional bounds and opens a real native trace waterfall', async ({
  request,
  page,
}) => {
  test.setTimeout(90_000);
  // Avoid minute rollover and its buffer flush while seeding/navigating. The
  // upper bound must remain strictly after the persisted timestamp in its minute.
  await expect
    .poll(
      () => {
        const phase = Date.now() % 60_000;
        return phase > 5000 && phase < 55_000;
      },
      { timeout: 15_000, intervals: [100] },
    )
    .toBe(true);
  const now = Date.now();
  const nanos = BigInt(now) * 1_000_000n;
  attemptedIngest = true;
  const ingest = await request.post('/v1/traces', {
    headers: { ...headers, 'X-P-Stream': dataset },
    data: {
      resourceSpans: [
        {
          resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }] },
          scopeSpans: [
            {
              scope: { name: 'apm-live-regression' },
              spans: [
                {
                  traceId,
                  spanId,
                  name: operation,
                  kind: 2,
                  startTimeUnixNano: String(nanos),
                  endTimeUnixNano: String(nanos + 25_000_000n),
                  status: { code: 1 },
                },
              ],
            },
          ],
        },
      ],
    },
  });
  expect(ingest.ok(), await ingest.text()).toBe(true);
  // Derive the window from persisted ingestion time, rather than assuming it equals
  // the span clock. Its upper bound remains inside the same minute, so flooring
  // that bound excludes this span even when the seed runs near a minute boundary.
  let persisted = '';
  await expect
    .poll(
      async () => {
        const response = await request.post('/api/v1/query', {
          headers,
          data: {
            query: `SELECT p_timestamp FROM "${dataset}" WHERE span_trace_id = '${traceId}' LIMIT 1`,
            startTime: new Date(now - 60_000).toISOString(),
            endTime: new Date(Date.now() + 60_000).toISOString(),
          },
        });
        if (!response.ok()) return false;
        persisted = (await response.json())[0]?.p_timestamp ?? '';
        return !!persisted;
      },
      { timeout: 30_000, intervals: [500, 1000] },
    )
    .toBe(true);
  const timestamp = Date.parse(/[Z]|[+-]\d\d:\d\d$/.test(persisted) ? persisted : `${persisted}Z`);
  const start = new Date(timestamp - 1).toISOString();
  const minuteEnd = Math.floor(timestamp / 60_000) * 60_000 + 60_000;
  const end = new Date(timestamp + (minuteEnd - timestamp) / 2).toISOString();
  expect(Date.parse(end)).toBeGreaterThan(timestamp);
  expect(Math.floor(Date.parse(end) / 60_000)).toBe(Math.floor(timestamp / 60_000));
  const path = `/apm/${dataset}/${encodeURIComponent(service)}?${new URLSearchParams({ start, end })}`;
  await page.goto(`${base}/login?next=${encodeURIComponent(path)}`);
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  const investigation = page.getByRole('link', { name: operation, exact: false });
  await expect(investigation).toBeVisible();
  const href = new URL((await investigation.getAttribute('href'))!, live);
  expect(href.searchParams.get('start')).toBe(start);
  expect(href.searchParams.get('end')).toBe(end);
  expect(href.searchParams.get('traceId')).toBe(traceId);
  const fetched = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/prism/v1/services/traces/detail' &&
      response.request().method() === 'POST',
  );
  const listed = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/prism/v1/services/traces/list' &&
      response.request().method() === 'POST',
  );
  await investigation.click();
  const [list, detail] = await Promise.all([listed, fetched]);
  expect(list.request().postDataJSON()).toMatchObject({
    dataset,
    serviceName: service,
    startTime: start,
    endTime: end,
  });
  expect(list.status(), await list.text()).toBe(200);
  const listing = await list.json();
  expect(listing.records).toEqual([
    expect.objectContaining({ span_trace_id: traceId, span_span_id: spanId }),
  ]);
  expect(detail.request().postDataJSON()).toMatchObject({
    dataset,
    traceId,
    startTime: start,
    endTime: end,
  });
  expect(detail.status(), await detail.text()).toBe(200);
  const body = await detail.json();
  expect(body.records).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ span_trace_id: traceId, span_span_id: spanId }),
    ]),
  );
  const sheet = page.getByRole('dialog', { name: 'Trace detail' });
  await expect(sheet.getByTestId('span-waterfall')).toBeVisible();
  await expect(
    sheet.getByRole('button', { name: `${operation}, ${service},`, exact: false }),
  ).toBeVisible();
});
