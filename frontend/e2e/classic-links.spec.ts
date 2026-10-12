import { expect, test, type Page } from '@playwright/test';

/** A live server with two datasets; returns the query requests it receives. */
async function server(page: Page) {
  const queries: { query: string; startTime: string; endTime: string }[] = [];
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/v1/logstream')
      return route.fulfill({ json: [{ name: 'app' }, { name: 'other' }] });
    if (path.endsWith('/schema'))
      return route.fulfill({ json: { fields: [{ name: 'level' }, { name: 'message' }] } });
    if (path === '/api/v1/query') {
      queries.push(request.postDataJSON());
      return route.fulfill({ json: [{ level: 'error', message: 'fixture' }] });
    }
    return route.fulfill({ status: 404 });
  });
  return queries;
}

test('a classic Logs bookmark opens with its range and filters', async ({ page }) => {
  const queries = await server(page);
  const query = "WHERE text level = 'error' AND text message ILIKE '%timeout%'";
  await page.goto(
    `/logs/explore/app?start=2026-10-09T08:00:00.000Z&end=2026-10-09T09:30:00.000Z&type=custom&tz=Asia%2FKolkata&query=${encodeURIComponent(query)}&keep=1`,
  );
  await expect(page.getByTestId('filter-pill-value')).toHaveText(['error']);
  await expect(page.getByLabel('Time range', { exact: true })).toHaveValue('custom');
  await expect(page.getByRole('status').filter({ hasText: 'Not carried over' })).toHaveText(
    /time zone Asia\/Kolkata \(times are shown in UTC\), 1 filter\./,
  );
  await expect(page).toHaveURL('/logs/explore/app?keep=1');
  await expect.poll(() => queries.length).toBeGreaterThan(0);
  expect(queries[0]).toMatchObject({
    startTime: '2026-10-09T08:00:00.000Z',
    endTime: '2026-10-09T09:30:00.000Z',
  });
  expect(queries[0].query).toContain(`"level" = 'error'`);
  expect(queries.every((q) => q.startTime === '2026-10-09T08:00:00.000Z')).toBe(true);
  await page.getByRole('button', { name: 'Dismiss' }).click();
  await expect(page.getByText('Not carried over')).toHaveCount(0);
});

test('a classic quick range shows as that range', async ({ page }) => {
  const queries = await server(page);
  await page.goto('/logs/explore/app?start=10m&end=now&type=fixed&tz=UTC');
  await expect(page.getByLabel('Time range', { exact: true })).toHaveValue('10m');
  await expect(page.getByLabel('Time range', { exact: true }).locator('option:checked')).toHaveText(
    'Last 10 minutes',
  );
  await expect(page).toHaveURL('/logs/explore/app');
  await expect(page.getByText('Not carried over')).toHaveCount(0);
  await expect.poll(() => queries.length).toBeGreaterThan(0);
  const { startTime, endTime } = queries[0];
  expect(Date.parse(endTime) - Date.parse(startTime)).toBe(10 * 60_000);
});

/** Opens `path` the way the router's own navigation does, without reloading. */
async function navigateInApp(page: Page, path: string, usr?: unknown) {
  await page.evaluate(
    ({ path, usr }) => {
      const { idx } = window.history.state;
      window.history.pushState({ usr, key: `link-${idx + 1}`, idx: idx + 1 }, '', path);
      window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }));
    },
    { path, usr },
  );
}

const link = (dataset: string, start: string, level: string, rest = '') =>
  `/logs/explore/${dataset}?start=${start}&end=now&type=fixed&query=${encodeURIComponent(`WHERE text level = '${level}'`)}${rest}`;

test('each classic Logs link opened while Logs is open is applied', async ({ page }) => {
  const queries = await server(page);
  const timeRange = page.getByLabel('Time range', { exact: true });
  const pills = page.getByTestId('filter-pill-value');
  const lastQuery = async () => {
    await expect.poll(() => queries.length).toBeGreaterThan(0);
    return queries[queries.length - 1];
  };
  await page.goto(link('app', '10m', 'error'));
  await expect(timeRange).toHaveValue('10m');
  await expect(pills).toHaveText(['error']);
  await expect(page).toHaveURL('/logs/explore/app');

  await navigateInApp(page, link('app', '3d', 'warn', '&tz=Asia%2FKolkata&keep=1#row-7'), {
    from: 'test',
  });
  await expect(timeRange).toHaveValue('3d');
  await expect(pills).toHaveText(['warn']);
  await expect(page.getByRole('status').filter({ hasText: 'Not carried over' })).toHaveText(
    /time zone Asia\/Kolkata/,
  );
  // The parameters come out, and the rest of the address and the history state stay.
  await expect(page).toHaveURL('/logs/explore/app?keep=1#row-7');
  expect(await page.evaluate(() => window.history.state.usr)).toEqual({ from: 'test' });
  await expect.poll(async () => (await lastQuery()).query).toContain(`"level" = 'warn'`);
  const warn = await lastQuery();
  expect(Date.parse(warn.endTime) - Date.parse(warn.startTime)).toBe(3 * 86_400_000);

  // A link to another dataset is applied after the dataset's own reset.
  await navigateInApp(page, link('other', '30m', 'info'));
  await expect(page.getByLabel('Dataset', { exact: true })).toHaveValue('other');
  await expect(timeRange).toHaveValue('30m');
  await expect(pills).toHaveText(['info']);
  await expect(page.getByText('Not carried over')).toHaveCount(0);
  await expect(page).toHaveURL('/logs/explore/other');
  await expect.poll(async () => (await lastQuery()).query).toContain('FROM "other"');
  const info = await lastQuery();
  expect(info.query).toContain(`"level" = 'info'`);
  expect(Date.parse(info.endTime) - Date.parse(info.startTime)).toBe(30 * 60_000);
  // Every query of the other dataset used that link's filter.
  for (const query of queries.filter((q) => q.query.includes('FROM "other"')))
    expect(query.query).toContain(`"level" = 'info'`);
});

test('an untyped, indented classic Logs filter opens as a filter', async ({ page }) => {
  const queries = await server(page);
  await page.goto(
    `/logs/explore/app?start=1h&end=now&type=fixed&query=${encodeURIComponent(" WHERE level = 'warn'")}`,
  );
  await expect(page.getByTestId('filter-pill-value')).toHaveText(['warn']);
  await expect(page.getByText('Not carried over')).toHaveCount(0);
  await expect.poll(() => queries.at(-1)?.query).toContain(`"level" = 'warn'`);
});

test('a classic Logs link replaces a search typed before it', async ({ page }) => {
  const queries = await server(page);
  await page.goto('/logs/explore/app');
  await page.getByLabel('Search messages').fill('old-search');
  await expect.poll(() => queries.at(-1)?.query).toContain('old-search');
  await navigateInApp(page, link('app', '10m', 'warn'));
  await expect(page.getByTestId('filter-pill-value')).toHaveText(['warn']);
  await expect(page.getByLabel('Search messages')).toHaveValue('');
  await expect.poll(() => queries.at(-1)?.query).toContain(`"level" = 'warn'`);
  expect(queries.at(-1)?.query).not.toContain('old-search');
});

test('classic paths that moved open their page here', async ({ page }) => {
  await server(page);
  await page.goto('/logs/search/app?start=1h&end=now&type=fixed');
  await expect(page).toHaveURL('/logs/explore/app');
  await page.goto('/settings');
  await expect(page).toHaveURL('/alerts/targets');
  // A redirect keeps the query, hash and history state of the link.
  await navigateInApp(page, '/logs/search/app?keep=1#row-3', { from: 'test' });
  await expect(page).toHaveURL('/logs/explore/app?keep=1#row-3');
  expect(await page.evaluate(() => window.history.state.usr)).toEqual({ from: 'test' });
  await navigateInApp(page, `/metrics/explore/x/metric/cpu?keep=1#m`, { from: 'test' });
  await expect(page).toHaveURL(/\/metrics\/explore\/x\?keep=1&query=cpu#m$/);
  expect(await page.evaluate(() => window.history.state.usr)).toEqual({ from: 'test' });
  // The dev server rejects a malformed escape itself, so these open from inside the app.
  await page.goto('/');
  for (const [path, target] of [
    ['/logs/search/100%', '/logs/explore/100%'],
    ['/logs/search/%E0%A4%A', '/logs/explore/%E0%A4%A'],
    ['/metrics/explore/x/metric/%E0%A4%A', '/metrics/explore/x/metric/%E0%A4%A'],
  ]) {
    await navigateInApp(page, path);
    await expect(page).toHaveURL(target);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  }
  await page.goto('/keystone/example');
  await expect(
    page.getByRole('heading', { name: 'Keystone analysis is unavailable in this native UI' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
});

test('a classic metric drilldown opens its metric and names the filter it drops', async ({
  page,
}) => {
  await page.addInitScript(() => sessionStorage.setItem('parseable-mode', 'demo'));
  const metric = 'system.cpu.load_average.1m';
  const filter = encodeURIComponent("WHERE text host = 'node-a'");
  await page.goto(
    `/metrics/explore/demo_metrics/metric/${metric}?start=30m&end=now&type=fixed&tz=UTC&query=${filter}#top`,
  );
  const query = encodeURIComponent(`{"${metric}"}`).replace(/%20/g, '+');
  await expect(page).toHaveURL(`/metrics/explore/demo_metrics?query=${query}&range=30m#top`);
  await expect(page.getByRole('textbox', { name: 'PromQL query A', exact: true })).toHaveText(
    `{"${metric}"}`,
  );
  await expect(page.getByLabel('Time range', { exact: true })).toHaveValue('30m');
  await expect(page.getByRole('img', { name: /PromQL range result/ })).toBeVisible();
  const notice = page.getByRole('status').filter({ hasText: 'Not carried over' });
  await expect(notice).toHaveText(/Not carried over from this link: 1 filter\./);
  await notice.getByRole('button', { name: 'Dismiss' }).click();
  await expect(page.getByText('Not carried over')).toHaveCount(0);
  await page.reload();
  await expect(page.getByLabel('Time range', { exact: true })).toHaveValue('30m');
  await expect(page.getByText('Not carried over')).toHaveCount(0);
});

/** A live server whose one metrics dataset is `otel`, with or without PromQL. */
async function metricsServer(
  page: Page,
  promql = true,
  discovered: Promise<void> = Promise.resolve(),
) {
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/v1/about') return route.fulfill({ json: { capabilities: { promql } } });
    if (path === '/api/v1/logstream') return route.fulfill({ json: [{ name: 'otel' }] });
    if (path.endsWith('/info')) {
      await discovered;
      return route.fulfill({ json: { logSource: [{ log_source_format: 'otel-metrics' }] } });
    }
    return route.fulfill({ status: 404 });
  });
  await page.route('**/prometheus/**', (route) =>
    route.fulfill({
      json: {
        status: 'success',
        data: route.request().url().includes('query') ? { resultType: 'matrix', result: [] } : [],
      },
    }),
  );
}

const hostFilter = encodeURIComponent("WHERE text host = 'node-a'");
const notice = (page: Page) => page.getByRole('status').filter({ hasText: 'Not carried over' });

test('a classic Metrics link names its filter on every state of the page', async ({ page }) => {
  await metricsServer(page, false);
  await page.goto(`/metrics/explore/otel?start=1h&end=now&type=fixed&query=${hostFilter}`);
  await expect(page.getByText('PromQL is not available on this server')).toBeVisible();
  await expect(notice(page)).toHaveText(/1 filter\./);
  // Opening the same page again from inside the app is a new visit.
  await navigateInApp(page, '/metrics/explore/otel?range=1h');
  await expect(page.getByText('PromQL is not available on this server')).toBeVisible();
  await expect(notice(page)).toHaveCount(0);
});

test('untyped and indented classic Metrics filters are reported, not run', async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem('parseable-mode', 'demo'));
  const editor = page.getByRole('textbox', { name: 'PromQL query A', exact: true });
  for (const filter of ["WHERE host = 'node-a'", " WHERE text host = 'node-a'"]) {
    await page.goto(
      `/metrics/explore/demo_metrics?start=1h&end=now&type=fixed&query=${encodeURIComponent(filter)}`,
    );
    await expect(page).toHaveURL('/metrics/explore/demo_metrics?range=1h');
    await expect(editor).toBeVisible();
    await expect(editor).not.toContainText('WHERE');
    await expect(notice(page)).toHaveText(/1 filter\./);
  }
});

test('classic explorer bookmarks open their PromQL queries', async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem('parseable-mode', 'demo'));
  const metric = 'system.cpu.load_average.1m';
  const editor = (id: string) =>
    page.getByRole('textbox', { name: `PromQL query ${id}`, exact: true });
  // Prism's own link: /metrics/explore/<dataset>?promql=<query>.
  await page.goto(
    `/metrics/explore/demo_metrics?${new URLSearchParams({ promql: `{"${metric}"}` })}`,
  );
  await expect(editor('A')).toHaveText(`{"${metric}"}`);
  await expect(page.getByRole('img', { name: /PromQL range result/ })).toBeVisible();
  await expect(notice(page)).toHaveCount(0);
  // Its serialized explorer state, with a builder query it cannot translate.
  const state = JSON.stringify({
    step: '1m',
    queryType: 'range',
    tiles: [
      { id: 'A', editorMode: 'promql', promqlQuery: `{"${metric}"}` },
      { id: 'B', editorMode: 'builder', promqlMetric: metric, promqlMatchers: [], operations: [] },
      {
        id: 'C',
        editorMode: 'builder',
        promqlMetric: metric,
        operations: [{ type: 'rate', params: ['5m'] }],
      },
    ],
  });
  await page.goto(
    `/metrics/explore/demo_metrics?${new URLSearchParams({ viewType: 'explorer', type: 'fixed', start: '1h', end: 'now', state })}`,
  );
  await expect(editor('A')).toHaveText(`{"${metric}"}`);
  await expect(editor('B')).toHaveText(`{"${metric}"}`);
  await expect(page.getByRole('radio', { name: 'Range', exact: true })).toBeChecked();
  await expect(page.getByLabel('Step', { exact: true })).toHaveValue('1m');
  await expect(notice(page)).toHaveText(/1 query built with operations\./);
});

test('a query being typed is never taken for a classic filter', async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem('parseable-mode', 'demo'));
  await page.goto('/metrics/explore/demo_metrics');
  const editor = page.getByRole('textbox', { name: 'PromQL query A', exact: true });
  // A metric named WHERE, part-way through `WHERE > 5`: not PromQL yet, and
  // shaped like a classic filter, but this page's own edit.
  await editor.fill('WHERE >');
  await expect(page).toHaveURL(/query=WHERE\+%3E/);
  await expect(editor).toHaveText('WHERE >');
  await expect(notice(page)).toHaveCount(0);
});

test('a classic PromQL link that does not parse opens as classic shows it', async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem('parseable-mode', 'demo'));
  await page.goto(
    `/metrics/explore/demo_metrics?${new URLSearchParams({ promql: 'WHERE >', viewType: 'explorer', tz: 'Asia/Kolkata' })}`,
  );
  const editor = page.getByRole('textbox', { name: 'PromQL query A', exact: true });
  await expect(editor).toHaveText('WHERE >');
  await expect(page).toHaveURL(/query=WHERE\+%3E/);
  // Translated once: the notice is the link's, not a second rewrite's "1 filter".
  await expect(notice(page)).toHaveText(/time zone Asia\/Kolkata \(times are shown in UTC\)\./);
});

test('a dismissed Metrics notice stays dismissed after reconnecting', async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem('parseable-mode', 'demo'));
  await page.goto(`/metrics/explore/demo_metrics?start=1h&end=now&type=fixed&query=${hostFilter}`);
  await expect(notice(page)).toHaveText(/1 filter\./);
  await notice(page).getByRole('button', { name: 'Dismiss' }).click();
  await expect(notice(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Connection settings' }).click();
  await page.getByRole('button', { name: 'Explore demo data' }).click();
  await expect(page.getByRole('textbox', { name: 'PromQL query A', exact: true })).toBeVisible();
  await expect(notice(page)).toHaveCount(0);
});

test('editing after a classic Metrics link keeps its notice, and dismissing keeps the edit', async ({
  page,
}) => {
  await metricsServer(page);
  await page.goto(`/metrics/explore/otel?start=1h&end=now&type=fixed&query=${hostFilter}`);
  const editor = page.getByRole('textbox', { name: 'PromQL query A', exact: true });
  await expect(editor).toBeVisible();
  await expect(notice(page)).toHaveText(/1 filter\./);
  await editor.fill('up');
  await page.getByLabel('Time range', { exact: true }).selectOption('6h');
  await expect(page).toHaveURL(/query=up.*range=6h/);
  await expect(notice(page)).toHaveText(/1 filter\./);
  // Dismissing right after an edit does not navigate, so it cannot undo the edit.
  await editor.fill('down');
  await notice(page).getByRole('button', { name: 'Dismiss' }).click();
  await expect(notice(page)).toHaveCount(0);
  await expect(page).toHaveURL(/query=down/);
  await expect(editor).toHaveText('down');
  await page.reload();
  await expect(editor).toHaveText('down');
  await expect(notice(page)).toHaveCount(0);
});

test('a classic Metrics link to a missing dataset keeps its notice when another opens', async ({
  page,
}) => {
  await metricsServer(page);
  await page.goto(`/metrics/explore/gone?start=1h&end=now&type=fixed&query=${hostFilter}`);
  await expect(page.getByText('The selected dataset could not be found.')).toBeVisible();
  await expect(notice(page)).toHaveText(/1 filter\./);
  await page.getByRole('button', { name: 'Open otel' }).click();
  await expect(page).toHaveURL('/metrics/explore/otel?range=1h');
  await expect(page.getByRole('textbox', { name: 'PromQL query A', exact: true })).toBeVisible();
  await expect(notice(page)).toHaveText(/1 filter\./);
  // A later link from elsewhere in the app is not the one the notice is about.
  await navigateInApp(page, '/metrics/explore/otel?query=up&type=range');
  await expect(page.getByRole('textbox', { name: 'PromQL query A', exact: true })).toHaveText('up');
  await expect(notice(page)).toHaveCount(0);
});

test('a notice dismissed while datasets load stays dismissed', async ({ page }) => {
  let discover = () => {};
  await metricsServer(page, true, new Promise<void>((resolve) => (discover = resolve)));
  await page.goto('/datasets');
  await navigateInApp(page, `/metrics?start=1h&end=now&type=fixed&query=${hostFilter}`, {
    from: 'test',
  });
  await expect(notice(page)).toHaveText(/1 filter\./);
  await notice(page).getByRole('button', { name: 'Dismiss' }).click();
  await expect(notice(page)).toHaveCount(0);
  discover();
  await expect(page).toHaveURL('/metrics/explore/otel?range=1h');
  await expect(page.getByRole('textbox', { name: 'PromQL query A', exact: true })).toBeVisible();
  await expect(notice(page)).toHaveCount(0);
  // The redirects keep the rest of the history state.
  expect(await page.evaluate(() => window.history.state.usr.from)).toBe('test');
});

test('back and forward show the notice of each Metrics entry', async ({ page }) => {
  await metricsServer(page);
  const editor = page.getByRole('textbox', { name: 'PromQL query A', exact: true });
  await page.goto('/metrics/explore/otel');
  await editor.fill('up');
  await expect(page).toHaveURL(/query=up/);
  await navigateInApp(page, `/metrics/explore/otel?query=${hostFilter}&query=cpu`);
  await expect(editor).toHaveText('cpu');
  await expect(notice(page)).toHaveText(/1 filter\./);
  await page.goBack();
  await expect(editor).toHaveText('up');
  await expect(notice(page)).toHaveCount(0);
  await page.goForward();
  await expect(editor).toHaveText('cpu');
  await expect(notice(page)).toHaveText(/1 filter\./);
});

test('a classic Metrics link keeps no classic filter as a PromQL query', async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem('parseable-mode', 'demo'));
  const filter = encodeURIComponent("WHERE text host = 'node-a' AND text env = 'prod'");
  await page.goto(`/metrics/explore/demo_metrics?start=1d&end=now&type=fixed&query=${filter}`);
  await expect(page).toHaveURL('/metrics/explore/demo_metrics?range=24h');
  await expect(
    page.getByRole('heading', { name: 'Build or write a PromQL query above to plot the chart.' }),
  ).toBeVisible();
  await expect(page.getByLabel('Time range', { exact: true })).toHaveValue('24h');
  await expect(page.getByRole('status').filter({ hasText: 'Not carried over' })).toHaveText(
    /Not carried over from this link: 2 filters\./,
  );
});

test('a page whose code fails to load keeps the shell, reload and sign out', async ({ page }) => {
  await server(page);
  await page.route('**/src/features/logs/LogsPage.tsx*', (route) => route.abort());
  await page.goto('/logs/explore/app');
  const error = page.getByRole('alert');
  await expect(error.getByRole('heading', { name: 'This page could not be loaded' })).toBeVisible();
  await expect(error.getByRole('button', { name: 'Reload' })).toBeVisible();
  await expect(error.getByRole('link', { name: 'Back to overview' })).toHaveAttribute('href', '/');
  // The error is inside the shell, so its navigation still works.
  await expect(page.locator('main#main-section').getByRole('alert')).toBeVisible();
  await page.getByTestId('sidebar-datasets').click();
  await expect(page).toHaveURL('/datasets');
  await expect(page.getByRole('alert')).toHaveCount(0);
  // Navigating back to the failing page shows the error in the shell again.
  await page.getByTestId('sidebar-logs').click();
  await expect(
    page
      .locator('main#main-section')
      .getByRole('alert')
      .getByRole('heading', { name: 'This page could not be loaded' }),
  ).toBeVisible();
  await expect(page.getByTestId('sidebar-datasets')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(1);
});

test('a page that throws as soon as it is navigated to keeps the shell', async ({ page }) => {
  await server(page);
  await page.goto('/logs/explore/app');
  await expect(page.getByLabel('Time range', { exact: true })).toBeVisible();
  await page.getByTestId('sidebar-datasets').click();
  await expect(page).toHaveURL('/datasets');
  // Logs creates filter IDs while it renders a classic link, in the navigation's own render.
  await page.evaluate(() => {
    const original = crypto.getRandomValues.bind(crypto);
    Object.assign(window, { restoreRandom: () => (crypto.getRandomValues = original) });
    crypto.getRandomValues = () => {
      throw new Error('No randomness');
    };
  });
  await navigateInApp(page, link('app', '10m', 'error'));
  const error = page.locator('main#main-section').getByRole('alert');
  await expect(error.getByRole('heading', { name: 'Something went wrong' })).toBeVisible();
  await expect(error).toContainText('No randomness');
  await expect(page.getByRole('alert')).toHaveCount(1);
  await expect(page.getByTestId('sidebar-datasets')).toBeVisible();
  await page.evaluate(() => (window as unknown as { restoreRandom: () => void }).restoreRandom());
  await page.getByTestId('sidebar-datasets').click();
  await expect(page).toHaveURL('/datasets');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('a page that fails on its first navigation keeps the shell', async ({ page }) => {
  await server(page);
  await page.route('**/src/features/team/TeamPage.tsx*', (route) => route.abort());
  await page.goto('/datasets');
  await expect(page.getByRole('heading', { name: 'Datasets' }).first()).toBeVisible();
  await page.getByTestId('sidebar-team').click();
  await expect(
    page
      .locator('main#main-section')
      .getByRole('alert')
      .getByRole('heading', { name: 'This page could not be loaded' }),
  ).toBeVisible();
  await expect(page.getByTestId('sidebar-datasets')).toBeVisible();
  await page.route('**/api/v1/o/logout?**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<h1>Signed out</h1>' }),
  );
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Signed out' })).toBeVisible();
});

test('an error outside a page still offers reload and sign out', async ({ page }) => {
  await server(page);
  // The shell reads the theme while it renders; make that throw.
  await page.addInitScript(() => {
    const getItem = Storage.prototype.getItem;
    Storage.prototype.getItem = function (key) {
      if (key === 'parseable-theme') throw new Error('Storage is unavailable');
      return getItem.call(this, key);
    };
  });
  await page.goto('/datasets');
  const error = page.getByRole('alert');
  await expect(error.getByRole('heading', { name: 'Something went wrong' })).toBeVisible();
  await expect(error).toContainText('Storage is unavailable');
  await expect(page.getByTestId('sidebar-datasets')).toHaveCount(0);
  await expect(error.getByRole('button', { name: 'Reload' })).toBeVisible();
  await expect(error.getByRole('button', { name: 'Sign out' })).toBeVisible();
});
