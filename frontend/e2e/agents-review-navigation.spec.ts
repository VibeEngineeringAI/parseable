import { expect, test, type Page } from '@playwright/test';
import { STORY_TRACE_ID, storyTraceDetail, storyTraceList } from '../src/features/traces/fixtures';
import { encodeLogView, decodeLogView } from '../src/features/logs/logViewState';
import { initialLogView } from '../src/features/logs/logViewReducer';

const bounds = { startTime: '2026-10-01T09:00:00.000Z', endTime: '2026-10-01T10:00:00.000Z' };
type Window = typeof bounds;
async function mockNavigation(page: Page) {
  const queries: Array<Window & { query: string }> = [];
  const lists: Array<Window & { serviceName?: string; sortBy: string }> = [];
  const details: Array<Window & { traceId: string }> = [];
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/logstream')) return route.fulfill({ json: [{ name: 'events' }] });
    if (path.endsWith('/schema'))
      return route.fulfill({
        json: { fields: ['p_timestamp', 'span_trace_id', 'message'].map((name) => ({ name })) },
      });
    if (path.endsWith('/info'))
      return route.fulfill({
        json: { telemetryType: 'traces', logSource: [{ log_source_format: 'otel-traces' }] },
      });
    if (path.endsWith('/services/traces/list')) {
      lists.push(route.request().postDataJSON());
      return route.fulfill({
        json: { count: 1, records: storyTraceList.slice(0, 1), offset: 0, limit: 25 },
      });
    }
    if (path.endsWith('/services/traces/detail')) {
      details.push(route.request().postDataJSON());
      return route.fulfill({ json: storyTraceDetail });
    }
    if (path.endsWith('/query')) {
      const query = route.request().postDataJSON();
      queries.push(query);
      return route.fulfill({
        json: query.query.startsWith('SELECT *')
          ? [
              {
                p_timestamp: '2026-10-01T09:30:00.000Z',
                span_trace_id: STORY_TRACE_ID,
                message: 'historical event',
              },
            ]
          : [],
      });
    }
    return route.fulfill({ json: {} });
  });
  return { queries, lists, details };
}

test('trace-focused Share retains its frozen window on open, reload and explorer handoffs', async ({
  page,
}) => {
  const calls = await mockNavigation(page);
  const rows = () => calls.queries.filter((query) => query.query.startsWith('SELECT *'));
  await page.goto(
    `/logs/explore/events?${new URLSearchParams({ traceId: STORY_TRACE_ID, start: bounds.startTime, end: bounds.endTime })}`,
  );
  await expect(page.getByRole('button', { name: 'Clear trace filter' })).toBeVisible();
  await expect.poll(() => rows().at(-1)).toMatchObject(bounds);
  await expect.poll(() => new URL(page.url()).searchParams.has('observe')).toBe(true);
  await page.getByRole('button', { name: 'Share / copy link' }).click();
  const shared = await page.getByLabel('View link').inputValue();
  const params = new URL(shared).searchParams;
  expect(decodeLogView(params.get('logView')!).range).toEqual(bounds);
  expect(params.get('logTraceId')).toBe(STORY_TRACE_ID);
  calls.queries.length = 0;
  await page.goto(shared);
  await expect.poll(() => rows().at(-1)).toMatchObject(bounds);
  expect(rows().at(-1)?.query).toContain(`"span_trace_id" = '${STORY_TRACE_ID}'`);
  await expect.poll(() => new URL(page.url()).searchParams.has('logView')).toBe(false);
  calls.queries.length = 0;
  await page.reload();
  await expect.poll(() => rows().at(-1)).toMatchObject(bounds);
  await expect(page.getByRole('button', { name: 'Clear trace filter' })).toBeVisible();
  await page.getByTestId('sidebar-traces').click();
  await expect.poll(() => calls.lists.at(-1)).toMatchObject(bounds);
  calls.queries.length = 0;
  await page.getByTestId('sidebar-logs').click();
  await expect.poll(() => rows().at(-1)).toMatchObject(bounds);
  expect(rows().at(-1)?.query).toContain(`"span_trace_id" = '${STORY_TRACE_ID}'`);
});

test('explicit preset handoffs override a shared view while preserving trace focus', async ({
  page,
}) => {
  const calls = await mockNavigation(page);
  const params = new URLSearchParams({
    logView: encodeLogView({ ...initialLogView('events'), range: bounds, search: 'historical' }),
    logTraceId: STORY_TRACE_ID,
    range: '6h',
    start: '2026-10-02T04:00:00.000Z',
    end: '2026-10-02T10:00:00.000Z',
  });
  await page.goto(`/logs/explore/events?${params}`);
  await expect
    .poll(() => calls.queries.filter((query) => query.query.startsWith('SELECT *')).at(-1))
    .toMatchObject({
      startTime: params.get('start'),
      endTime: params.get('end'),
    });
  await expect(page.getByLabel('Time range', { exact: true })).toHaveValue('6h');
  const query = calls.queries.filter((query) => query.query.startsWith('SELECT *')).at(-1)?.query;
  expect(query).toContain(STORY_TRACE_ID);
  expect(query).toContain('historical');
});

test('Traces Refresh reloads fixed list and open detail, and advances preset bounds', async ({
  page,
}) => {
  const calls = await mockNavigation(page);
  await page.goto(
    `/traces/explore/events?${new URLSearchParams({ start: bounds.startTime, end: bounds.endTime, service: 'api-gateway', sort: 'longestFirst' })}`,
  );
  await expect(page.getByTestId('trace-table')).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.has('observe')).toBe(true);
  await page.waitForLoadState('networkidle');
  const before = calls.lists.length;
  const beforeClosedDetail = calls.details.length;
  await page.getByRole('button', { name: 'Refresh traces' }).click();
  await expect.poll(() => calls.lists.length).toBe(before + 1);
  await page.waitForLoadState('networkidle');
  expect(calls.lists).toHaveLength(before + 1);
  expect(calls.details).toHaveLength(beforeClosedDetail);
  expect(calls.lists.at(-1)).toMatchObject({
    ...bounds,
    serviceName: 'api-gateway',
    sortBy: 'longestFirst',
  });
  await page.getByRole('button', { name: `Open trace ${STORY_TRACE_ID}, POST /orders` }).click();
  await expect(page.getByRole('dialog', { name: 'Trace detail', exact: true })).toBeVisible();
  await expect.poll(() => calls.details.length).toBeGreaterThan(0);
  await page.waitForLoadState('networkidle');
  const beforeDetail = calls.details.length;
  const beforeList = calls.lists.length;
  // The modal hides the toolbar; exercise its handler with the detail request retained.
  await page
    .getByRole('button', { name: 'Refresh traces', includeHidden: true })
    .evaluate((button: HTMLButtonElement) => button.click());
  await expect.poll(() => calls.lists.length).toBe(beforeList + 1);
  await expect.poll(() => calls.details.length).toBe(beforeDetail + 1);
  await page.waitForLoadState('networkidle');
  expect(calls.lists).toHaveLength(beforeList + 1);
  expect(calls.details).toHaveLength(beforeDetail + 1);
  expect(calls.lists.at(-1)).toMatchObject(bounds);
  expect(calls.details.at(-1)).toMatchObject({ ...bounds, traceId: STORY_TRACE_ID });
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await expect(page.getByRole('dialog', { name: 'Trace detail', exact: true })).toHaveCount(0);
  await expect.poll(() => new URL(page.url()).searchParams.has('traceId')).toBe(false);
  // Wait for the closed detail to reach the remembered explorer snapshot before
  // testing a handoff; a pending close must not be mistaken for a refresh failure.
  await expect
    .poll(() => {
      const observe = new URL(page.url()).searchParams.get('observe');
      if (!observe) return true;
      const query = JSON.parse(observe).views.traces?.query;
      return query === undefined || new URLSearchParams(query).has('traceId');
    })
    .toBe(false);
  await page.getByLabel('Time range', { exact: true }).selectOption('1h');
  await expect.poll(() => new URL(page.url()).searchParams.get('range')).toBe('1h');
  await expect.poll(() => calls.lists.at(-1)?.startTime).not.toBe(bounds.startTime);
  await page.getByTestId('sidebar-logs').click();
  await expect(page.getByLabel('Time range', { exact: true })).toHaveValue('1h');
  await page.getByTestId('sidebar-traces').click();
  await expect(page.getByTestId('trace-table')).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Trace detail', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Time range', { exact: true })).toHaveValue('1h');
  await page.waitForLoadState('networkidle');
  expect(calls.lists.at(-1)).toMatchObject({ serviceName: 'api-gateway', sortBy: 'longestFirst' });
  const presetBefore = calls.lists.length;
  const presetClosedDetail = calls.details.length;
  const previousEnd = calls.lists.at(-1)!.endTime;
  await page.getByRole('button', { name: 'Refresh traces' }).click();
  await expect.poll(() => calls.lists.length).toBe(presetBefore + 1);
  await page.waitForLoadState('networkidle');
  expect(calls.lists).toHaveLength(presetBefore + 1);
  expect(calls.details).toHaveLength(presetClosedDetail);
  expect(Date.parse(calls.lists.at(-1)!.endTime)).toBeGreaterThan(Date.parse(previousEnd));
  expect(Date.parse(calls.lists.at(-1)!.endTime) - Date.parse(calls.lists.at(-1)!.startTime)).toBe(
    3_600_000,
  );
  await page.getByRole('button', { name: `Open trace ${STORY_TRACE_ID}, POST /orders` }).click();
  await expect(page.getByRole('dialog', { name: 'Trace detail', exact: true })).toBeVisible();
  // Opening mounts a new Sheet: development StrictMode replays its loading
  // effect. Establish a settled baseline; Refresh below must still fetch once.
  await expect.poll(() => calls.details.length).toBeGreaterThan(presetClosedDetail);
  await page.waitForLoadState('networkidle');
  expect(calls.details.at(-1)).toMatchObject({
    startTime: calls.lists.at(-1)!.startTime,
    endTime: calls.lists.at(-1)!.endTime,
    traceId: STORY_TRACE_ID,
  });
  const presetDetailBefore = calls.details.length;
  const presetListBefore = calls.lists.length;
  const previousDetailEnd = calls.details.at(-1)!.endTime;
  await page
    .getByRole('button', { name: 'Refresh traces', includeHidden: true })
    .evaluate((button: HTMLButtonElement) => button.click());
  await expect.poll(() => calls.lists.length).toBe(presetListBefore + 1);
  await expect.poll(() => calls.details.length).toBe(presetDetailBefore + 1);
  await page.waitForLoadState('networkidle');
  expect(calls.lists).toHaveLength(presetListBefore + 1);
  expect(calls.details).toHaveLength(presetDetailBefore + 1);
  for (const request of [
    ...calls.lists.slice(presetListBefore),
    ...calls.details.slice(presetDetailBefore),
  ]) {
    expect(Date.parse(request.endTime)).toBeGreaterThan(Date.parse(previousDetailEnd));
    expect(Date.parse(request.endTime) - Date.parse(request.startTime)).toBe(3_600_000);
  }
  expect(calls.details.at(-1)).toMatchObject({
    startTime: calls.lists.at(-1)!.startTime,
    endTime: calls.lists.at(-1)!.endTime,
    traceId: STORY_TRACE_ID,
  });
});
