import { test, expect, type Page, type Route } from '@playwright/test';
import classic from '../src/features/dashboards/__fixtures__/classic.json' with { type: 'json' };
import promqlTile from '../src/features/dashboards/__fixtures__/query-value/promql-query-value.json' with { type: 'json' };
import valueTile from '../src/features/dashboards/__fixtures__/query-value/query-value.json' with { type: 'json' };
import { createUlid } from '../src/lib/ids';
import type { Dashboard, DashboardTile, QueryRequest } from '../src/lib/types';

const detail = `/dashboards/${classic.dashboardId}`;
const refresh = (page: Page) => page.getByRole('button', { name: 'Refresh', exact: true });
const tile = (page: Page, name = 'Total events') =>
  page.getByRole('region', { name: `Tile ${name}`, exact: true });
const updated = (page: Page) => page.locator('.dashboard-refresh-status time');

async function setup(
  page: Page,
  options: {
    tiles?: DashboardTile[];
    search?: string;
    promql?: (route: Route, path: string) => Promise<void>;
    variables?: Dashboard['variables'];
    query?: (route: Route, body: QueryRequest, count: number) => Promise<void>;
  } = {},
) {
  const calls: QueryRequest[] = [];
  await page.context().addCookies([
    { name: 'user_id', value: 'admin', url: 'http://127.0.0.1:5173' },
    { name: 'username', value: 'admin', url: 'http://127.0.0.1:5173' },
  ]);
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith('/prometheus/') && options.promql) return options.promql(route, path);
    if (path === '/api/v1/about')
      return route.fulfill({ json: { capabilities: { promqlDashboard: true } } });
    if (path === '/api/v1/users/admin')
      return route.fulfill({ json: { id: 'admin', username: 'admin' } });
    if (path === '/api/v1/user/admin/role')
      return route.fulfill({
        json: { roles: { root: { actions: [{ privilege: 'admin' }] } }, groupRoles: {} },
      });
    if (path === '/api/v1/logstream') return route.fulfill({ json: [{ name: 'app-logs' }] });
    if (path === `/api/v1/dashboards/${classic.dashboardId}`)
      return route.fulfill({
        json: {
          ...classic,
          sections: [],
          variables: options.variables ?? [],
          tiles: options.tiles ?? [valueTile],
        },
      });
    if (path === '/api/v1/query') {
      const wire = route.request().postDataJSON();
      const body: QueryRequest = {
        sql: wire.query,
        startTime: wire.startTime,
        endTime: wire.endTime,
      };
      calls.push(body);
      if (options.query) return options.query(route, body, calls.length);
      return route.fulfill({ json: [{ events: calls.length * 10 }] });
    }
    return route.fulfill({ json: [] });
  });
  await page.clock.install({ time: new Date('2026-10-11T12:00:00Z') });
  await page.goto(detail + (options.search ?? ''));
  await expect(tile(page, options.tiles?.[0]?.title as string | undefined)).toBeVisible();
  return calls;
}
async function idle(page: Page) {
  await expect(refresh(page)).toBeEnabled();
}
async function freeze(page: Page) {
  await page.clock.pauseAt(new Date((await page.evaluate(() => Date.now())) + 1000));
}

test('refresh defaults Off; every interval, switching, Off, and navigation clean up timers', async ({
  page,
}) => {
  const calls = await setup(page);
  await idle(page);
  await freeze(page);
  const selector = page.getByLabel('Auto refresh', { exact: true });
  await expect(selector.locator('option')).toHaveText(['Off', '15s', '30s', '1m', '5m']);
  await expect(selector).toHaveValue('0');
  await page.clock.fastForward(600_000);
  expect(calls).toHaveLength(1);
  for (const duration of [15_000, 30_000, 60_000, 300_000]) {
    const before = calls.length;
    await selector.selectOption(String(duration));
    await page.clock.fastForward(duration - 1);
    expect(calls).toHaveLength(before);
    await page.clock.fastForward(1);
    await expect.poll(() => calls.length).toBe(before + 1);
    await idle(page);
  }
  await selector.selectOption('15000');
  await page.clock.fastForward(10_000);
  await selector.selectOption('30000');
  const before = calls.length;
  await page.clock.fastForward(29_999);
  expect(calls).toHaveLength(before);
  await page.clock.fastForward(1);
  await expect.poll(() => calls.length).toBe(before + 1);
  await idle(page);
  await selector.selectOption('0');
  await page.clock.fastForward(600_000);
  expect(calls).toHaveLength(before + 1);
  await refresh(page).click();
  await expect.poll(() => calls.length).toBe(before + 2);
  await idle(page);
  await selector.selectOption('15000');
  await page.getByRole('link', { name: 'Dashboards', exact: true }).last().click();
  await expect(page).toHaveURL(/\/dashboards$/);
  await page.clock.fastForward(600_000);
  expect(calls).toHaveLength(before + 2);
});

test('slow refresh keeps data, never overlaps, and waits a full interval after completion', async ({
  page,
}) => {
  let release: (() => Promise<void>) | undefined;
  const calls = await setup(page, {
    query: async (route, _body, count) => {
      if (count === 2) {
        await new Promise<void>((resolve) => {
          release = async () => {
            await route.fulfill({ json: [{ events: 20 }] });
            resolve();
          };
        });
      } else await route.fulfill({ json: [{ events: count * 10 }] });
    },
  });
  await idle(page);
  await freeze(page);
  const firstUpdated = await updated(page).getAttribute('datetime');
  await page.getByLabel('Auto refresh').selectOption('15000');
  await page.clock.fastForward(15000);
  await expect.poll(() => calls.length).toBe(2);
  await expect(refresh(page)).toBeDisabled();
  await expect(tile(page)).toContainText('Refreshing tile…');
  await expect(tile(page).locator('.dashboard-stat')).toHaveText('10');
  await page.clock.fastForward(60_000);
  expect(calls).toHaveLength(2);
  await expect(updated(page)).toHaveAttribute('datetime', firstUpdated!);
  await release!();
  await idle(page);
  await expect(tile(page).locator('.dashboard-stat')).toHaveText('20');
  await page.clock.fastForward(14_999);
  expect(calls).toHaveLength(2);
  await page.clock.fastForward(1);
  await expect.poll(() => calls.length).toBe(3);
});

test('failures retain the last success and timestamp; automatic recovery clears errors', async ({
  page,
}) => {
  const calls = await setup(page, {
    query: async (route, _body, count) => {
      await route.fulfill(
        count === 2
          ? { status: 503, body: 'Temporarily unavailable' }
          : { json: [{ events: count * 10 }] },
      );
    },
  });
  await idle(page);
  await freeze(page);
  const firstUpdated = await updated(page).getAttribute('datetime');
  await page.getByLabel('Auto refresh').selectOption('15000');
  await page.clock.fastForward(15_000);
  await expect(tile(page).locator('.dashboard-tile-error')).toContainText(
    'Refresh failed: Temporarily unavailable',
  );
  await expect(tile(page).locator('.dashboard-stat')).toHaveText('10');
  await expect(updated(page)).toHaveAttribute('datetime', firstUpdated!);
  await expect(page.locator('.dashboard-refresh-status')).toContainText('Refresh failed');
  await idle(page);
  await page.clock.fastForward(15_000);
  await expect(tile(page).locator('.dashboard-stat')).toHaveText('30');
  await expect(tile(page).locator('.dashboard-tile-error')).toHaveCount(0);
  await expect(page.locator('.dashboard-refresh-status')).not.toContainText('Refresh failed');
  await expect(updated(page)).not.toHaveAttribute('datetime', firstUpdated!);
  expect(calls).toHaveLength(3);
});

test('initial failures can be retried with Off selected', async ({ page }) => {
  await setup(page, {
    query: async (route, _body, count) => {
      await route.fulfill(
        count === 1 ? { status: 500, body: 'Query unavailable' } : { json: [{ events: 42 }] },
      );
    },
  });
  await expect(tile(page).locator('.dashboard-tile-error')).toContainText('Query failed');
  await expect(page.locator('.dashboard-refresh-status')).toContainText('Last updated: Never');
  await tile(page).getByRole('button', { name: 'Retry query', exact: true }).click();
  await expect(tile(page).locator('.dashboard-stat')).toHaveText('42');
  await expect(tile(page).locator('.dashboard-tile-error')).toHaveCount(0);
});

test('hidden tabs pause timers and resume with a fresh interval without catch-up', async ({
  page,
}) => {
  const calls = await setup(page);
  await idle(page);
  await freeze(page);
  await page.getByLabel('Auto refresh').selectOption('15000');
  await page.clock.fastForward(10_000);
  // Exercise the browser visibility event deterministically; headless focus does
  // not reliably change document.hidden across platforms.
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.locator('.dashboard-refresh-status')).toContainText('paused');
  await page.clock.fastForward(300_000);
  expect(calls).toHaveLength(1);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.locator('.dashboard-refresh-status')).not.toContainText('paused');
  await page.clock.fastForward(14_999);
  expect(calls).toHaveLength(1);
  await page.clock.fastForward(1);
  await expect.poll(() => calls.length).toBe(2);
});

test('rolling ranges advance together; relative and absolute tile overrides survive dashboard changes', async ({
  page,
}) => {
  const fixed = {
    type: 'custom',
    startTime: '2026-10-01T00:00:00.000Z',
    endTime: '2026-10-02T00:00:00.000Z',
  };
  const tiles = [
    {
      ...valueTile,
      title: 'Dashboard range',
      tile_id: createUlid(),
      chartQuery: 'SELECT 1 AS events FROM "app-logs"',
    },
    {
      ...valueTile,
      title: 'Relative override',
      tile_id: createUlid(),
      chartQuery: 'SELECT 2 AS events FROM "app-logs"',
      timeRange: { type: 'fixed', startTime: '10m', endTime: 'now' },
    },
    {
      ...valueTile,
      title: 'Absolute override',
      tile_id: createUlid(),
      chartQuery: 'SELECT 3 AS events FROM "app-logs"',
      timeRange: fixed,
    },
  ];
  const calls = await setup(page, { tiles });
  await idle(page);
  await freeze(page);
  const previous = calls.slice();
  await page.getByLabel('Auto refresh').selectOption('15000');
  await page.clock.fastForward(15_000);
  await expect.poll(() => calls.length).toBe(6);
  await idle(page);
  const latest = (index: number) =>
    calls.filter((call) => call.sql === tiles[index].chartQuery).at(-1)!;
  expect(Date.parse(latest(0).endTime)).toBeGreaterThan(Date.parse(previous[0].endTime));
  expect(latest(0).endTime).toBe(latest(1).endTime);
  expect(Date.parse(latest(0).endTime) - Date.parse(latest(0).startTime)).toBe(3_600_000);
  expect(Date.parse(latest(1).endTime) - Date.parse(latest(1).startTime)).toBe(600_000);
  expect(latest(2)).toMatchObject({ startTime: fixed.startTime, endTime: fixed.endTime });
  await page.getByLabel('Time range', { exact: true }).selectOption('30m');
  await idle(page);
  expect(Date.parse(latest(0).endTime) - Date.parse(latest(0).startTime)).toBe(1_800_000);
  expect(Date.parse(latest(1).endTime) - Date.parse(latest(1).startTime)).toBe(600_000);
  expect(latest(2)).toMatchObject({ startTime: fixed.startTime, endTime: fixed.endTime });
});

test('a slow variable query holds the refresh cycle and failure keeps dependent data visible', async ({
  page,
}) => {
  let release: (() => Promise<void>) | undefined;
  let variableCalls = 0;
  const calls = await setup(page, {
    variables: [
      { name: 'host', label: 'Host', type: 'sql', sqlQuery: 'SELECT host FROM "app-logs"' },
    ],
    tiles: [
      {
        ...valueTile,
        chartQuery: `SELECT COUNT(*) AS events FROM "app-logs" WHERE host = '$host'`,
      },
    ],
    query: async (route, body) => {
      if (body.sql.includes('SELECT host')) {
        variableCalls++;
        if (variableCalls === 2) {
          await new Promise<void>((resolve) => {
            release = async () => {
              await route.fulfill({ status: 503, body: 'Hosts unavailable' });
              resolve();
            };
          });
        } else await route.fulfill({ json: [{ host: 'web' }] });
      } else await route.fulfill({ json: [{ events: 42 }] });
    },
  });
  await expect(tile(page).locator('.dashboard-stat')).toHaveText('42');
  await idle(page);
  await freeze(page);
  await page.getByLabel('Auto refresh').selectOption('15000');
  await page.clock.fastForward(15_000);
  await expect.poll(() => variableCalls).toBe(2);
  const count = calls.length;
  await page.clock.fastForward(60_000);
  expect(calls).toHaveLength(count);
  await release!();
  await expect(page.getByText(/Could not load values for Host/)).toBeVisible();
  await expect(tile(page)).toContainText('Showing last successful data.');
  await expect(tile(page).locator('.dashboard-stat')).toHaveText('42');
  await idle(page);
  await page.clock.fastForward(15_000);
  await expect.poll(() => variableCalls).toBe(3);
  await expect(page.getByText(/Could not load values for Host/)).toHaveCount(0);
  await expect(tile(page)).not.toContainText('Showing last successful data.');
});

test('absolute dashboard ranges refresh variables and tiles without moving the bounds', async ({
  page,
}) => {
  const startTime = '2026-10-01T00:00:00.000Z';
  const endTime = '2026-10-02T00:00:00.000Z';
  const calls = await setup(page, {
    search: `?start=${startTime}&end=${endTime}`,
    variables: [
      { name: 'host', label: 'Host', type: 'sql', sqlQuery: 'SELECT host FROM "app-logs"' },
    ],
    tiles: [
      {
        ...valueTile,
        chartQuery: `SELECT COUNT(*) AS events FROM "app-logs" WHERE host = '$host'`,
      },
    ],
    query: async (route, body) => {
      await route.fulfill({
        json: body.sql.includes('SELECT host') ? [{ host: 'web' }] : [{ events: 42 }],
      });
    },
  });
  await expect(tile(page).locator('.dashboard-stat')).toHaveText('42');
  await idle(page);
  await freeze(page);
  const count = calls.length;
  await page.getByLabel('Auto refresh').selectOption('15000');
  await page.clock.fastForward(15_000);
  await expect.poll(() => calls.length).toBe(count + 2);
  await idle(page);
  for (const call of calls) expect(call).toMatchObject({ startTime, endTime });
});

test('a failed PromQL branch cannot start another cycle while its sibling is still pending', async ({
  page,
}) => {
  let rangeCalls = 0;
  let instantCalls = 0;
  let release: (() => Promise<void>) | undefined;
  const times: number[] = [];
  await setup(page, {
    tiles: [{ ...promqlTile, dbName: 'app-logs', chartQuery: ['up'] }],
    promql: async (route, path) => {
      const params = new URLSearchParams(route.request().postData()!);
      const range = path.endsWith('query_range');
      const count = range ? ++rangeCalls : ++instantCalls;
      const end = Number(params.get(range ? 'end' : 'time'));
      times.push(end);
      const respond = async () => {
        await route.fulfill({
          json: {
            status: 'success',
            data: range
              ? {
                  resultType: 'matrix',
                  result: [
                    {
                      metric: {},
                      values: [
                        [end - 60, '10'],
                        [end, '20'],
                      ],
                    },
                  ],
                }
              : { resultType: 'vector', result: [{ metric: {}, value: [end, '20'] }] },
          },
        });
      };
      if (range && count === 2) {
        await new Promise<void>((resolve) => {
          release = async () => {
            await respond();
            resolve();
          };
        });
      } else if (!range && count === 2)
        await route.fulfill({ status: 503, body: 'Instant query unavailable' });
      else await respond();
    },
  });
  await expect(tile(page, 'Total request rate').locator('.dashboard-stat')).toContainText('20');
  await idle(page);
  await freeze(page);
  await page.getByLabel('Auto refresh').selectOption('15000');
  await page.clock.fastForward(15_000);
  await expect.poll(() => rangeCalls).toBe(2);
  await expect.poll(() => instantCalls).toBe(2);
  await page.clock.fastForward(60_000);
  expect(rangeCalls).toBe(2);
  expect(instantCalls).toBe(2);
  await expect(refresh(page)).toBeDisabled();
  await release!();
  await expect(tile(page, 'Total request rate').locator('.dashboard-tile-error')).toContainText(
    'Refresh failed',
  );
  await expect(tile(page, 'Total request rate').locator('.dashboard-stat')).toContainText('20');
  await idle(page);
  await page.clock.fastForward(15_000);
  await expect.poll(() => rangeCalls).toBe(3);
  await expect.poll(() => instantCalls).toBe(3);
  await expect(tile(page, 'Total request rate').locator('.dashboard-tile-error')).toHaveCount(0);
  expect(times[0]).toBe(times[1]);
  expect(times[2]).toBe(times[3]);
  expect(times[2]).toBeGreaterThan(times[0]);
});

test('a retained time series keeps the successful time axis until new data arrives', async ({
  page,
}) => {
  let fail = false;
  await setup(page, {
    tiles: [
      {
        ...valueTile,
        chartType: 'timeseries',
        config: { type: 'line', axes: { x: { field: 'time' }, y: { field: 'events' } } },
      },
    ],
    query: async (route, body) => {
      await route.fulfill(
        fail
          ? { status: 503, body: 'Try again later' }
          : {
              json: [
                { time: body.startTime, events: 10 },
                { time: body.endTime, events: 20 },
              ],
            },
      );
    },
  });
  const chart = tile(page).getByRole('img');
  await expect(chart).toHaveAccessibleName(/1 series from/);
  await idle(page);
  await freeze(page);
  const label = await chart.getAttribute('aria-label');
  fail = true;
  await page.getByLabel('Auto refresh').selectOption('15000');
  await page.clock.fastForward(15_000);
  await expect(tile(page).locator('.dashboard-tile-error')).toContainText('Refresh failed');
  await expect(chart).toHaveAttribute('aria-label', label!);
  await idle(page);
  fail = false;
  await page.clock.fastForward(15_000);
  await expect(chart).not.toHaveAttribute('aria-label', label!);
});

test('changed query inputs never show a previous selection as retained refresh data', async ({
  page,
}) => {
  let fail = false;
  await setup(page, {
    variables: [{ name: 'host', label: 'Host', type: 'list', options: ['web', 'worker'] }],
    tiles: [
      {
        ...valueTile,
        chartQuery: `SELECT COUNT(*) AS events FROM "app-logs" WHERE host = '$host'`,
      },
    ],
    query: async (route) => {
      await route.fulfill(fail ? { status: 503, body: 'Unavailable' } : { json: [{ events: 42 }] });
    },
  });
  await expect(tile(page).locator('.dashboard-stat')).toHaveText('42');
  fail = true;
  await page.getByLabel('Host', { exact: true }).selectOption('worker');
  await expect(tile(page).locator('.dashboard-tile-error')).toContainText('Query failed');
  await expect(tile(page).locator('.dashboard-stat')).toHaveCount(0);
  await expect(tile(page).locator('time')).toHaveCount(0);
  fail = false;
  await refresh(page).click();
  await expect(tile(page).locator('.dashboard-stat')).toHaveText('42');
  fail = true;
  await page.getByLabel('Time range', { exact: true }).selectOption('30m');
  await expect(tile(page).locator('.dashboard-tile-error')).toContainText('Query failed');
  await expect(tile(page).locator('.dashboard-stat')).toHaveCount(0);
});

test('partial success advances Last updated; successful variables alone never do', async ({
  page,
}) => {
  let allowHealthy = false;
  const tiles = [
    {
      ...valueTile,
      tile_id: createUlid(),
      title: 'Healthy',
      chartQuery: `SELECT COUNT(*) AS events FROM "app-logs" WHERE host = '$host'`,
    },
    {
      ...valueTile,
      tile_id: createUlid(),
      title: 'Broken',
      chartQuery: 'SELECT missing FROM "app-logs"',
    },
  ];
  await setup(page, {
    tiles,
    variables: [
      { name: 'host', label: 'Host', type: 'sql', sqlQuery: 'SELECT host FROM "app-logs"' },
    ],
    query: async (route, body) => {
      await route.fulfill(
        body.sql.includes('SELECT host')
          ? { json: [{ host: 'web' }] }
          : allowHealthy && body.sql.includes('COUNT')
            ? { json: [{ events: 42 }] }
            : { status: 503, body: 'Unavailable' },
      );
    },
  });
  await expect(tile(page, 'Healthy').locator('.dashboard-tile-error')).toBeVisible();
  await expect(tile(page, 'Broken').locator('.dashboard-tile-error')).toBeVisible();
  await expect(page.locator('.dashboard-refresh-status')).toContainText('Last updated: Never');
  await idle(page);
  await freeze(page);
  allowHealthy = true;
  await page.getByLabel('Auto refresh').selectOption('15000');
  await page.clock.fastForward(15000);
  await expect(tile(page, 'Healthy').locator('.dashboard-stat')).toHaveText('42');
  await expect(updated(page)).toBeVisible();
  const timestamp = await updated(page).getAttribute('datetime');
  await expect(page.locator('.dashboard-refresh-status')).toContainText('Refresh failed');
  await idle(page);
  await page.clock.fastForward(15000);
  await expect(updated(page)).not.toHaveAttribute('datetime', timestamp!);
});

test('manual refresh retains focus and busy activation adds no requests', async ({ page }) => {
  let release: (() => Promise<void>) | undefined;
  const calls = await setup(page, {
    query: async (route, _body, count) => {
      if (count === 2) {
        await new Promise<void>((resolve) => {
          release = async () => {
            await route.fulfill({ json: [{ events: 20 }] });
            resolve();
          };
        });
      } else await route.fulfill({ json: [{ events: 10 }] });
    },
  });
  await idle(page);
  await refresh(page).focus();
  await refresh(page).press('Enter');
  await expect(refresh(page)).toHaveAttribute('aria-disabled', 'true');
  await expect(refresh(page)).toBeFocused();
  await refresh(page).press('Enter');
  await refresh(page).press('Space');
  expect(calls).toHaveLength(2);
  await release!();
  await idle(page);
  await expect(refresh(page)).toBeFocused();
});

test('repeated failures announce once, then announce recovery without timestamp chatter', async ({
  page,
}) => {
  let fail = true;
  await setup(page, {
    query: async (route) => {
      await route.fulfill(fail ? { status: 503, body: 'Unavailable' } : { json: [{ events: 42 }] });
    },
  });
  const announcement = page.locator('.dashboard-refresh-status [aria-live]');
  await expect(announcement).toContainText('Refresh failed');
  await expect(announcement).not.toContainText('Last updated');
  await expect(tile(page).getByRole('alert')).toHaveCount(0);
  await idle(page);
  await freeze(page);
  await page.evaluate(() => {
    const region = document.querySelector('.dashboard-refresh-status [aria-live]')!;
    (window as unknown as { announcements: string[] }).announcements = [];
    new MutationObserver(() => {
      (window as unknown as { announcements: string[] }).announcements.push(region.textContent!);
    }).observe(region, { childList: true, subtree: true, characterData: true });
  });
  await page.getByLabel('Auto refresh').selectOption('15000');
  await page.clock.fastForward(15000);
  await idle(page);
  await page.clock.fastForward(15000);
  await idle(page);
  expect(
    await page.evaluate(() => (window as unknown as { announcements: string[] }).announcements),
  ).toEqual([]);
  fail = false;
  await page.clock.fastForward(15000);
  await expect(announcement).toHaveText('Refresh recovered.');
  expect(
    await page.evaluate(() => (window as unknown as { announcements: string[] }).announcements),
  ).toEqual(['Refresh recovered.']);
});

test('a request timeout is visible and the next interval recovers', async ({ page }) => {
  const calls = await setup(page, {
    query: async (route, _body, count) => {
      if (count !== 2) await route.fulfill({ json: [{ events: count * 10 }] });
    },
  });
  await idle(page);
  await freeze(page);
  await page.getByLabel('Auto refresh').selectOption('15000');
  await page.clock.fastForward(15000);
  await expect.poll(() => calls.length).toBe(2);
  await page.clock.fastForward(120_000);
  await expect(tile(page).locator('.dashboard-tile-error')).toContainText(
    'Query timed out after 2 minutes.',
  );
  await expect(tile(page).locator('.dashboard-stat')).toHaveText('10');
  await idle(page);
  await page.clock.fastForward(15000);
  await expect(tile(page).locator('.dashboard-stat')).toHaveText('30');
});

test('query timeouts exclude time spent waiting in the dashboard concurrency queue', async ({
  page,
}) => {
  const requests: Route[] = [];
  const tiles = Array.from({ length: 8 }, (_, index) => ({
    ...valueTile,
    tile_id: createUlid(),
    title: `Query ${index + 1}`,
  }));
  await setup(page, {
    tiles,
    query: async (route) => {
      requests.push(route);
    },
  });
  await expect.poll(() => requests.length).toBe(4);
  await freeze(page);
  await page.clock.fastForward(90_000);
  await Promise.all(requests.slice(0, 4).map((route) => route.fulfill({ json: [{ events: 42 }] })));
  await expect.poll(() => requests.length).toBe(8);
  await page.clock.fastForward(90_000);
  await expect(page.locator('.dashboard-tile-error')).toHaveCount(0);
  await expect(refresh(page)).toBeDisabled();
  await Promise.all(requests.slice(4).map((route) => route.fulfill({ json: [{ events: 42 }] })));
  await idle(page);
  await expect(page.locator('.dashboard-stat')).toHaveText(Array(8).fill('42'));
});
