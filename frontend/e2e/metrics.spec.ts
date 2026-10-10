import { test, expect, type Page, type Route } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const cpu = 'system.cpu.load_average.1m';
const counter = 'http.server.requests';
const cpuQuery = `{"${cpu}"}`;
const prompt = 'Build or write a PromQL query above to plot the chart.';
const editor = (page: Page, id = 'A') =>
  page.getByRole('textbox', { name: `PromQL query ${id}`, exact: true });
const run = (page: Page) => page.getByRole('button', { name: 'Run', exact: true }).click();
const browser = (page: Page) => page.getByRole('complementary', { name: 'Label browser' });
const legend = (page: Page) => page.getByRole('list', { name: 'Series visibility' });

async function demo(page: Page, path = '/metrics') {
  await page.addInitScript(() => sessionStorage.setItem('parseable-mode', 'demo'));
  await page.goto(path);
  await expect(editor(page)).toBeVisible();
  await expect(browser(page).getByRole('button', { name: cpu, exact: true })).toBeVisible();
}

async function axe(page: Page) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  // Disable caret loops and the global 0.01ms transitions for a settled axe snapshot.
  await page.addStyleTag({
    content: '*, *::before, *::after { animation: none !important; transition: none !important; }',
  });
  await page.evaluate(async () => {
    await Promise.allSettled(document.getAnimations().map((animation) => animation.finished));
  });
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
}

type Call = {
  path: string;
  method: string;
  params: URLSearchParams;
  headers: Record<string, string>;
};
const queries = (calls: Call[]) => calls.filter((call) => /\/query(?:_range)?$/.test(call.path));
async function mockLive(
  page: Page,
  options: {
    enabled?: boolean;
    empty?: boolean;
    aboutError?: boolean;
    listError?: boolean;
    malformedAbout?: boolean;
    promql?: (route: Route, call: Call) => Promise<void> | undefined;
  } = {},
) {
  const calls: Call[] = [];
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/v1/about')
      return route.fulfill(
        options.aboutError
          ? { status: 503, body: 'About unavailable' }
          : {
              json: options.malformedAbout
                ? { capabilities: { promql: 'yes' } }
                : { capabilities: { promql: options.enabled ?? true } },
            },
      );
    if (path === '/api/v1/logstream' && options.listError)
      return route.fulfill({ status: 500, body: 'Dataset list unavailable' });
    if (path === '/api/v1/logstream')
      return route.fulfill({
        json: [
          { name: 'web_logs' },
          { name: 'metrics_b' },
          { name: 'metrics_a' },
          { name: 'restricted_metrics' },
        ],
      });
    if (path.endsWith('/restricted_metrics/info'))
      return route.fulfill({ status: 403, body: 'Cannot inspect this dataset' });
    if (path.endsWith('/info'))
      return route.fulfill({
        json:
          path.includes('/web_logs/') || options.empty
            ? { telemetryType: 'logs', logSource: [{ log_source_format: 'json' }] }
            : path.includes('/metrics_b/')
              ? { telemetryType: 'metrics' }
              : { logSource: [{ log_source_format: 'otel-metrics' }] },
      });
    return route.fulfill({ status: 404, body: 'Not found' });
  });
  await page.route('**/prometheus/**', (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const call: Call = {
      path: url.pathname,
      method: request.method(),
      params:
        request.method() === 'POST'
          ? new URLSearchParams(request.postData() ?? '')
          : url.searchParams,
      headers: request.headers(),
    };
    calls.push(call);
    const override = options.promql?.(route, call);
    if (override) return override;
    if (call.path.endsWith('/query_range'))
      return route.fulfill({
        json: {
          status: 'success',
          data: {
            resultType: 'matrix',
            result: ['a', 'b'].map((host, index) => ({
              metric: { __name__: cpu, host },
              values: [
                [Number(call.params.get('start')), String(2 + index)],
                [Number(call.params.get('end')), String(2.5 + index)],
              ],
            })),
          },
        },
      });
    if (call.path.endsWith('/query'))
      return route.fulfill({
        json: {
          status: 'success',
          data: {
            resultType: 'vector',
            result: ['a', 'b'].map((host, index) => ({
              metric: { __name__: cpu, host },
              value: [Number(call.params.get('time')), String(2.5 + index)],
            })),
          },
        },
      });
    if (call.path.endsWith('/label/__name__/values'))
      return route.fulfill({ json: { status: 'success', data: [counter, cpu] } });
    if (call.path.endsWith('/labels'))
      return route.fulfill({
        json: { status: 'success', data: ['__name__', 'host', 'service.name'] },
      });
    if (call.path.endsWith('/label/host/values'))
      return route.fulfill({ json: { status: 'success', data: ['a', 'b'] } });
    if (call.path.endsWith('/label/service.name/values'))
      return route.fulfill({ json: { status: 'success', data: ['checkout', 'inventory'] } });
    return route.fulfill({ status: 404, body: 'Not found' });
  });
  return calls;
}

async function openLive(page: Page, path = '/metrics') {
  await page.goto(path);
  await expect(editor(page)).toBeVisible();
  await expect(browser(page).getByRole('button', { name: cpu, exact: true })).toBeVisible();
}

test('Observe navigation opens Metrics and selects only a metrics dataset', async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem('parseable-mode', 'demo'));
  await page.goto('/datasets');
  await page.getByTestId('sidebar-metrics').click();
  await expect(page).toHaveURL('/metrics/explore/demo_metrics');
  await expect(page.getByLabel('Metrics dataset')).toHaveValue('demo_metrics');
  await expect(page.getByLabel('Metrics dataset').locator('option')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: prompt, exact: true })).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Both', exact: true })).toBeChecked();
  await expect(page.getByRole('button', { name: 'Remove query A' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Refresh metrics' })).toBeDisabled();
});

test('demo queries render chart, legend, tables, exports and accessible light/dark results', async ({
  page,
}) => {
  await demo(page);
  await axe(page);
  await editor(page).fill(cpuQuery);
  await editor(page).press('ControlOrMeta+Enter');
  await expect(legend(page).getByRole('button')).toHaveCount(4);
  await expect(page.getByRole('img', { name: /PromQL range result: 4 series/ })).toBeVisible();
  await axe(page);
  await page.getByRole('button', { name: 'Use dark theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await axe(page);
  await page.getByRole('tab', { name: 'Table', exact: true }).click();
  await expect(page.getByRole('table', { name: 'Instant results' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Range summary' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Instant results' })).toContainText(cpu);
  await expect(
    page.getByRole('table', { name: 'Range summary' }).getByRole('columnheader'),
  ).toHaveText(['Series', 'Last', 'Min', 'Max', 'Avg']);
  await page
    .getByRole('region', { name: 'Range summary', exact: true })
    .getByRole('button', { name: 'Sort Max' })
    .click();
  await expect(
    page.getByRole('table', { name: 'Range summary' }).getByRole('columnheader', { name: 'Max' }),
  ).toHaveAttribute('aria-sort', 'ascending');
  const download = page.waitForEvent('download');
  await page
    .getByRole('region', { name: 'Instant results', exact: true })
    .getByRole('button', { name: 'Export JSON' })
    .click();
  expect((await download).suggestedFilename()).toBe('query-results.json');
  await axe(page);
});

for (const type of ['Range', 'Instant', 'Both']) {
  test(`demo ${type} selects the requested result surfaces`, async ({ page }) => {
    await demo(page);
    await editor(page).fill(cpuQuery);
    await page.getByRole('radio', { name: type, exact: true }).check();
    await run(page);
    if (type === 'Instant')
      await expect(
        page.getByRole('heading', { name: 'The chart needs a range query.' }),
      ).toBeVisible();
    else await expect(legend(page).getByRole('button')).toHaveCount(4);
    await page.getByRole('tab', { name: 'Table', exact: true }).click();
    await expect(page.getByRole('table', { name: 'Instant results' })).toHaveCount(
      type === 'Range' ? 0 : 1,
    );
    await expect(page.getByRole('table', { name: 'Range summary' })).toHaveCount(
      type === 'Instant' ? 0 : 1,
    );
  });
}

test('the label browser inserts selectors predictably into the active query', async ({ page }) => {
  await demo(page);
  const panel = browser(page);
  await panel.getByRole('button', { name: cpu, exact: true }).click();
  await panel.getByRole('button', { name: 'Use metric', exact: true }).click();
  await expect(editor(page)).toHaveText(cpuQuery);
  await panel.getByRole('button', { name: 'host', exact: true }).click();
  await panel.getByRole('button', { name: 'node-02', exact: true }).click();
  await expect(editor(page)).toHaveText(`{"${cpu}", host="node-02"}`);
  await editor(page).fill(`sum(${cpuQuery})`);
  await panel.getByRole('button', { name: 'node-01', exact: true }).click();
  await expect(editor(page, 'B')).toHaveText(`{"${cpu}", host="node-01"}`);
  await expect(editor(page)).toHaveText(`sum(${cpuQuery})`);
  await panel.getByRole('button', { name: 'Add as new query', exact: true }).click();
  await expect(editor(page, 'C')).toHaveText(cpuQuery);
  await page.getByRole('button', { name: 'Add query', exact: true }).click();
  await page.getByRole('button', { name: 'Add query', exact: true }).click();
  await expect(page.getByRole('textbox', { name: /PromQL query/ })).toHaveCount(5);
  await expect(page.getByRole('button', { name: 'Add query', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Remove query E' }).click();
  await expect(page.getByRole('textbox', { name: /PromQL query/ })).toHaveCount(4);
  await page.getByRole('button', { name: 'Hide label browser' }).click();
  await expect(panel).toHaveCount(0);
  await page.getByRole('button', { name: 'Show label browser' }).click();
  await expect(panel).toBeVisible();
});

test('removing a query relabels applied results to match the panel', async ({ page }) => {
  const running = page.getByRole('status').filter({ hasText: 'Running queries…' });
  await mockLive(page, {
    promql: (route, call) =>
      call.params.get('query') === 'failing_b'
        ? route.fulfill({ status: 500, body: 'b exploded' })
        : undefined,
  });
  await openLive(page);
  await editor(page).fill(cpuQuery);
  await page.getByRole('button', { name: 'Add query', exact: true }).click();
  await editor(page, 'B').fill('failing_b');
  await page.getByRole('radio', { name: 'Range', exact: true }).check();
  await run(page);
  const alerts = page.locator('.metrics-query-error');
  await expect(alerts).toHaveCount(1);
  await expect(alerts).toContainText('B ·');
  await expect(legend(page).getByRole('button')).toHaveCount(2);
  await expect(legend(page)).toContainText('A:');
  await page.getByRole('button', { name: 'Remove query A' }).click();
  await expect(page.getByRole('textbox', { name: /PromQL query/ })).toHaveCount(1);
  await expect(editor(page, 'A')).toHaveText('failing_b');
  // Results follow the panel: the failing query is now A, and no stale B or series remain.
  await expect(alerts).toHaveCount(1);
  await expect(alerts).toContainText('A ·');
  await expect(alerts).not.toContainText('B ·');
  await expect(legend(page)).toHaveCount(0);
  await expect(running).toHaveCount(0);
});

test('the first run shows a loading state instead of "No data" until requests settle', async ({
  page,
}) => {
  const running = page.getByRole('status').filter({ hasText: 'Running queries…' });
  const loading = page.locator('.loading-state');
  let release = () => {};
  const held = new Promise<void>((done) => {
    release = done;
  });
  await mockLive(page, {
    promql: (route, call) =>
      /\/query(?:_range)?$/.test(call.path)
        ? held
            .then(() =>
              route.fulfill({
                json: {
                  status: 'success',
                  data: call.path.endsWith('/query_range')
                    ? {
                        resultType: 'matrix',
                        result: [{ metric: { host: 'a' }, values: [[1, '2']] }],
                      }
                    : {
                        resultType: 'vector',
                        result: [{ metric: { host: 'a' }, value: [1, '2'] }],
                      },
                },
              }),
            )
            .catch(() => {})
        : undefined,
  });
  await openLive(page);
  await editor(page).fill(cpuQuery);
  await run(page);
  await expect(running).toBeVisible();
  await expect(loading).toBeVisible();
  await expect(page.getByText('No data', { exact: true })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Table', exact: true }).click();
  await expect(loading).toHaveCount(2);
  await expect(page.getByText('No instant results', { exact: true })).toHaveCount(0);
  await expect(page.getByText('No data', { exact: true })).toHaveCount(0);
  release();
  await expect(loading).toHaveCount(0);
  await expect(page.getByRole('table', { name: 'Range summary' })).toContainText('host="a"');
  await expect(running).toHaveCount(0);
});

test('successful queries enter per-dataset history and selecting one does not run', async ({
  page,
}) => {
  const calls = await mockLive(page);
  await openLive(page);
  await editor(page).fill(cpuQuery);
  await run(page);
  await expect(legend(page).getByRole('button')).toHaveCount(2);
  await expect.poll(() => queries(calls).length).toBe(2);
  await editor(page).fill('changed');
  await page.getByRole('button', { name: 'Query A history' }).click();
  await page
    .locator('.metrics-history-menu')
    .getByRole('button', { name: cpuQuery, exact: true })
    .click();
  await expect(editor(page)).toHaveText(cpuQuery);
  expect(queries(calls)).toHaveLength(2);
  await page.getByLabel('Metrics dataset').selectOption('metrics_b');
  await expect(editor(page)).toHaveText(cpuQuery);
  await expect(page.getByRole('heading', { name: prompt, exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Query A history' }).click();
  await expect(page.getByText('No query history yet', { exact: true })).toBeVisible();
  expect(queries(calls)).toHaveLength(2);
});

test('a shared URL restores multiple queries, type, step, range and automatically runs after reload', async ({
  page,
}) => {
  await demo(page);
  await editor(page).fill(cpuQuery);
  await page.getByRole('button', { name: 'Add query', exact: true }).click();
  await editor(page, 'B').fill('{"process.memory.usage"}');
  await page.getByRole('radio', { name: 'Instant', exact: true }).check();
  await page.getByLabel('Step', { exact: true }).fill('30s');
  await page.getByLabel('Time range', { exact: true }).selectOption('6h');
  await expect
    .poll(() => {
      const params = new URL(page.url()).searchParams;
      return {
        queries: params.getAll('query'),
        type: params.get('type'),
        step: params.get('step'),
        range: params.get('range'),
      };
    })
    .toEqual({
      queries: [cpuQuery, '{"process.memory.usage"}'],
      type: 'instant',
      step: '30s',
      range: '6h',
    });
  await page.reload();
  await expect(editor(page)).toHaveText(cpuQuery);
  await expect(editor(page, 'B')).toHaveText('{"process.memory.usage"}');
  await expect(page.getByRole('radio', { name: 'Instant', exact: true })).toBeChecked();
  await expect(page.getByLabel('Step', { exact: true })).toHaveValue('30s');
  await expect(page.getByLabel('Time range', { exact: true })).toHaveValue('6h');
  await expect(page.getByRole('heading', { name: 'The chart needs a range query.' })).toBeVisible();
  await page.getByRole('tab', { name: 'Table', exact: true }).click();
  await expect(page.getByRole('table', { name: 'Instant results' })).toContainText('A: ');
  await expect(page.getByRole('table', { name: 'Instant results' })).toContainText('B: ');
});

test('invalid shared state falls back to defaults', async ({ page }) => {
  await demo(page, '/metrics?type=invalid&step=wrong&range=invalid');
  await expect(page.getByRole('radio', { name: 'Both', exact: true })).toBeChecked();
  await expect(page.getByLabel('Step', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Time range', { exact: true })).toHaveValue('1h');
  await expect(page.getByRole('heading', { name: prompt, exact: true })).toBeVisible();
});

for (const range of ['6h', '1h']) {
  test(`same-route history restores and runs the URL configuration with range ${range}`, async ({
    page,
  }) => {
    const calls = await mockLive(page);
    await openLive(page, '/metrics/explore/metrics_a?query=cpu&type=range&range=1h');
    await expect(legend(page).getByRole('button')).toHaveCount(2);
    await expect.poll(() => queries(calls).length).toBe(1);
    await page.evaluate((range) => {
      window.history.pushState(
        { ...window.history.state, idx: window.history.state.idx + 1, key: 'metrics-memory' },
        '',
        `?query=memory&type=instant&step=90s&range=${range}`,
      );
      window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }));
    }, range);
    await expect(editor(page)).toHaveText('memory');
    await expect(page.getByRole('radio', { name: 'Instant', exact: true })).toBeChecked();
    await expect(page.getByLabel('Step', { exact: true })).toHaveValue('90s');
    await expect(page.getByLabel('Time range', { exact: true })).toHaveValue(range);
    await expect.poll(() => queries(calls).length).toBe(2);
    expect(queries(calls)[1].path).toBe('/prometheus/api/v1/query');
    expect(queries(calls)[1].params.get('query')).toBe('memory');
    await page.goBack();
    await expect(editor(page)).toHaveText('cpu');
    await expect(page.getByRole('radio', { name: 'Range', exact: true })).toBeChecked();
    await expect.poll(() => queries(calls).length).toBe(3);
    expect(queries(calls)[2].path).toBe('/prometheus/api/v1/query_range');
    expect(queries(calls)[2].params.get('query')).toBe('cpu');
    await page.goForward();
    await expect(editor(page)).toHaveText('memory');
    await expect.poll(() => queries(calls).length).toBe(4);
    expect(queries(calls)[3].path).toBe('/prometheus/api/v1/query');
    expect(queries(calls)[3].params.get('query')).toBe('memory');
    await editor(page).fill('draft_memory');
    await expect(page).toHaveURL(/query=draft_memory/);
    expect(queries(calls)).toHaveLength(4);
  });
}

test('step and range validation blocks requests, including the keyboard shortcut', async ({
  page,
}) => {
  const calls = await mockLive(page);
  await openLive(page);
  await editor(page).fill(cpuQuery);
  for (const invalid of ['wrong', '0', '-1s', '1.5m']) {
    await page.getByLabel('Step', { exact: true }).fill(invalid);
    await expect(page.getByRole('alert')).toContainText('Step must be a positive duration');
    await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeDisabled();
    await editor(page).press('ControlOrMeta+Enter');
  }
  await page.getByLabel('Step', { exact: true }).fill('32d');
  await expect(page.getByRole('alert')).toContainText('Step cannot exceed 31 days');
  await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeDisabled();
  await editor(page).press('ControlOrMeta+Enter');
  expect(queries(calls)).toHaveLength(0);
  await page.getByLabel('Step', { exact: true }).fill('1s');
  await page.getByLabel('Time range', { exact: true }).selectOption('7d');
  await expect(page.getByRole('alert')).toContainText('11000 steps');
  await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeDisabled();
  expect(queries(calls)).toHaveLength(0);
  await page.getByLabel('Step', { exact: true }).fill('');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByText(/^auto · /)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeEnabled();
});

test('invalid custom bounds block browser and completion metadata until the range recovers', async ({
  page,
}) => {
  const calls = await mockLive(page);
  await openLive(page);
  const panel = browser(page);
  await panel.getByRole('button', { name: cpu, exact: true }).click();
  await panel.getByRole('button', { name: 'host', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'a', exact: true })).toBeVisible();
  const count = calls.length;
  await page.getByRole('button', { name: 'Choose absolute time range' }).click();
  const dialog = page.getByRole('dialog', { name: 'Time range', exact: true });
  await dialog.getByLabel('From', { exact: true }).fill('2026-09-07T12:00');
  await dialog.getByLabel('To', { exact: true }).fill('2026-10-09T12:00');
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('The time range cannot exceed 31 days');
  await expect(panel.getByRole('list').getByRole('button')).toHaveCount(0);
  await editor(page).fill('ra');
  await editor(page).press('Control+Space');
  await expect(page.getByRole('option', { name: /^ratefunction$/ })).toBeVisible();
  expect(calls).toHaveLength(count);
  await editor(page).press('Escape');
  await editor(page).press('ControlOrMeta+Enter');
  expect(queries(calls)).toHaveLength(0);
  await page.getByLabel('Time range', { exact: true }).selectOption('1h');
  await expect(panel.getByRole('button', { name: cpu, exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'a', exact: true })).toBeVisible();
  expect(calls.length).toBeGreaterThan(count);
  for (const call of calls)
    expect(Number(call.params.get('end')) - Number(call.params.get('start'))).toBeLessThanOrEqual(
      31 * 86400,
    );
});

test('live requests use exact form and metadata parameters, with metric-scoped match[]', async ({
  page,
}) => {
  const calls = await mockLive(page);
  await openLive(page);
  await page.getByRole('button', { name: 'Choose absolute time range' }).click();
  const dialog = page.getByRole('dialog', { name: 'Time range', exact: true });
  await dialog.getByLabel('From', { exact: true }).fill('2026-10-09T10:00');
  await dialog.getByLabel('To', { exact: true }).fill('2026-10-09T11:00');
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
  await browser(page).getByRole('button', { name: cpu, exact: true }).click();
  await browser(page).getByRole('button', { name: 'Use metric', exact: true }).click();
  await browser(page).getByRole('button', { name: 'host', exact: true }).click();
  await expect(browser(page).getByRole('button', { name: 'a', exact: true })).toBeVisible();
  await page.getByLabel('Step', { exact: true }).fill('1m30s');
  await run(page);
  await expect(legend(page).getByRole('button')).toHaveCount(2);
  const [range, instant] = queries(calls);
  const start = Date.parse('2026-10-09T10:00:00Z') / 1000,
    end = start + 3600;
  expect(range.method).toBe('POST');
  expect(range.headers['content-type']).toBe('application/x-www-form-urlencoded');
  expect(Object.fromEntries(range.params)).toEqual({
    stream: 'metrics_a',
    query: cpuQuery,
    start: String(start),
    end: String(end),
    step: '1m30s',
  });
  expect(Object.fromEntries(instant.params)).toEqual({
    stream: 'metrics_a',
    query: cpuQuery,
    time: String(end),
  });
  expect(range.headers).not.toHaveProperty('x-p-stream');
  const scoped = calls.filter(
    (call) => call.path.endsWith('/labels') || call.path.endsWith('/label/host/values'),
  );
  expect(scoped.length).toBeGreaterThanOrEqual(2);
  for (const call of scoped) {
    expect(call.method).toBe('GET');
    expect([...call.params.keys()].sort()).toEqual(['end', 'limit', 'match[]', 'start', 'stream']);
    expect(call.params.getAll('match[]')).toEqual([`{__name__="${cpu}"}`]);
    expect(Object.fromEntries(call.params)).toMatchObject({
      stream: 'metrics_a',
      start: String(start),
      end: String(end),
      limit: '1000',
    });
  }
  const names = calls.filter((call) => call.path.endsWith('/label/__name__/values'));
  for (const call of names)
    expect([...call.params.keys()].sort()).toEqual(['end', 'limit', 'start', 'stream']);
});

test('time changes and refresh use the applied query, type and step until the next Run', async ({
  page,
}) => {
  const calls = await mockLive(page);
  await page.clock.install({ time: new Date('2026-10-09T12:00:00Z') });
  await openLive(page);
  await editor(page).fill(cpuQuery);
  await page.getByLabel('Step', { exact: true }).fill('30s');
  await run(page);
  await expect(legend(page).getByRole('button')).toHaveCount(2);
  await editor(page).fill(`rate({"${counter}"}[5m])`);
  await page.getByRole('radio', { name: 'Instant', exact: true }).check();
  await page.getByLabel('Step', { exact: true }).fill('15s');
  expect(queries(calls)).toHaveLength(2);
  await page.clock.fastForward(5000);
  await page.getByLabel('Time range', { exact: true }).selectOption('6h');
  await expect.poll(() => queries(calls).length).toBe(4);
  const second = queries(calls).slice(2);
  expect(second.map((call) => call.params.get('query'))).toEqual([cpuQuery, cpuQuery]);
  expect(second[0].params.get('step')).toBe('30s');
  expect(Number(second[0].params.get('end')) - Number(second[0].params.get('start'))).toBe(21600);
  await page.clock.fastForward(5000);
  await page.getByRole('button', { name: 'Refresh metrics' }).click();
  await expect.poll(() => queries(calls).length).toBe(6);
  expect(Number(queries(calls)[4].params.get('end'))).toBeGreaterThan(
    Number(second[0].params.get('end')),
  );
  expect(queries(calls)[4].params.get('query')).toBe(cpuQuery);
  await run(page);
  await expect.poll(() => queries(calls).length).toBe(7);
  expect(queries(calls)[6].path).toBe('/prometheus/api/v1/query');
  expect(queries(calls)[6].params.get('query')).toBe(`rate({"${counter}"}[5m])`);
});

test('Run keeps the label browser and its metadata while the range is unchanged', async ({
  page,
}) => {
  const calls = await mockLive(page);
  const metadata = () => calls.filter((call) => !/\/query(?:_range)?$/.test(call.path));
  const names = () => metadata().filter((call) => call.path.endsWith('/label/__name__/values'));
  await page.clock.install({ time: new Date('2026-10-09T12:00:00Z') });
  await openLive(
    page,
    `/metrics?${new URLSearchParams({ start: '2026-10-09T10:00:00Z', end: '2026-10-09T11:00:00Z' })}`,
  );
  const panel = browser(page);
  const search = panel.getByLabel('Search metrics', { exact: true });
  await panel.getByRole('button', { name: cpu, exact: true }).click();
  await panel.getByRole('button', { name: 'host', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'a', exact: true })).toBeVisible();
  await search.fill('cpu');
  await panel.getByLabel('Search values', { exact: true }).fill('b');
  const fetched = metadata().length;
  const named = names().length;
  await editor(page).fill(cpuQuery);
  await run(page);
  await expect(legend(page).getByRole('button')).toHaveCount(2);
  await page.clock.fastForward(5 * 60_000);
  await editor(page).press('ControlOrMeta+Enter');
  await expect.poll(() => queries(calls).length).toBe(4);
  // An absolute range never refetches metadata, so the browser keeps its state.
  expect(metadata()).toHaveLength(fetched);
  await expect(search).toHaveValue('cpu');
  await expect(panel.getByLabel('Search values', { exact: true })).toHaveValue('b');
  await expect(panel.getByRole('button', { name: cpu, exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(panel.getByRole('button', { name: 'b', exact: true })).toBeVisible();
  // A range change requests metadata once and keeps the lists mounted while it reloads.
  await page.getByLabel('Time range', { exact: true }).selectOption('1h');
  await expect.poll(() => queries(calls).length).toBe(6);
  await expect.poll(() => names().length).toBe(named + 1);
  await expect(search).toHaveValue('cpu');
  await expect(panel.getByRole('button', { name: 'b', exact: true })).toBeVisible();
  const relative = metadata().length;
  expect(relative).toBe(fetched + 3);
  await page.clock.fastForward(5000);
  await run(page);
  await expect.poll(() => queries(calls).length).toBe(8);
  expect(metadata()).toHaveLength(relative);
  // A relative range re-anchors on Run once completion caches would have expired.
  await page.clock.fastForward(60_000);
  await run(page);
  await expect.poll(() => names().length).toBe(named + 2);
  expect(Number(names().at(-1)!.params.get('end'))).toBeGreaterThan(
    Number(names().at(-2)!.params.get('end')),
  );
  await expect(search).toHaveValue('cpu');
  await expect(panel.getByLabel('Search values', { exact: true })).toHaveValue('b');
});

for (const [status, errorType, message] of [
  [400, 'bad_data', 'parse error: expected expression'],
  [422, 'execution', 'topk is not supported'],
] as const) {
  test(`HTTP ${status} shows query ID, errorType and verbatim error while another query succeeds`, async ({
    page,
  }) => {
    await mockLive(page, {
      promql: (route, call) =>
        call.params.get('query') === 'bad_query'
          ? route.fulfill({ status, json: { status: 'error', errorType, error: message } })
          : undefined,
    });
    await openLive(page);
    await editor(page).fill('bad_query');
    await page.getByRole('button', { name: 'Add query', exact: true }).click();
    await editor(page, 'B').fill(cpuQuery);
    await page.getByRole('radio', { name: 'Range', exact: true }).check();
    await run(page);
    await expect(page.getByRole('alert')).toContainText(`A · ${errorType}`);
    await expect(page.getByRole('alert').locator('pre')).toHaveText(message);
    await expect(legend(page).getByRole('button')).toHaveCount(2);
    await expect(legend(page)).toContainText('B: ');
    await page.getByRole('tab', { name: 'Table', exact: true }).click();
    await expect(page.getByRole('table', { name: 'Range summary' })).toBeVisible();
    await page.getByRole('button', { name: 'Query A history' }).click();
    await expect(
      page.locator('.metrics-history-menu').getByRole('button', { name: 'bad_query', exact: true }),
    ).toHaveCount(0);
  });
}

for (const jsonForbidden of [true, false]) {
  test(`${jsonForbidden ? 'JSON forbidden 401' : 'plain 403'} stays a query permission error without signing out`, async ({
    page,
  }) => {
    await mockLive(page, {
      promql: (route, call) =>
        /\/query(?:_range)?$/.test(call.path)
          ? route.fulfill(
              jsonForbidden
                ? {
                    status: 401,
                    json: {
                      status: 'error',
                      errorType: 'forbidden',
                      error: 'Reader cannot query this dataset',
                    },
                  }
                : { status: 403, body: 'Role lacks Query action' },
            )
          : undefined,
    });
    await openLive(page);
    await editor(page).fill(cpuQuery);
    await run(page);
    await expect(page.getByRole('alert').first()).toContainText('Permission denied');
    await expect(page).toHaveURL(/\/metrics\/explore\/metrics_a\?/);
    await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Log in to your account' })).toHaveCount(0);
  });
}

test('plain-text PromQL 401 returns to login with the intended explorer URL', async ({ page }) => {
  await mockLive(page, {
    promql: (route, call) =>
      /\/query(?:_range)?$/.test(call.path)
        ? route.fulfill({ status: 401, body: 'Session expired' })
        : undefined,
  });
  await openLive(page);
  await editor(page).fill(cpuQuery);
  await run(page);
  await expect(page).toHaveURL(/\/login\?next=/);
  expect(new URL(page.url()).searchParams.get('next')).toContain(
    '/metrics/explore/metrics_a?query=',
  );
  await expect(page.getByRole('heading', { name: 'Log in to your account' })).toBeVisible();
});

test('explicit capability false shows a mode explanation without PromQL requests or pricing links', async ({
  page,
}) => {
  const calls = await mockLive(page, { enabled: false });
  await page.goto('/metrics');
  await expect(
    page.getByRole('heading', { name: 'PromQL is not available on this server' }),
  ).toBeVisible();
  await expect(page.getByText(/server must run in All or Query mode/)).toBeVisible();
  expect(calls).toHaveLength(0);
  await expect(page.getByRole('link', { name: /pricing|upgrade/i })).toHaveCount(0);
});

test('no metrics datasets shows ingestion help', async ({ page }) => {
  await mockLive(page, { empty: true });
  await page.goto('/metrics');
  await expect(page.getByRole('heading', { name: 'No metrics ingested yet' })).toBeVisible();
  await expect(
    page.getByText(
      'Add metrics to monitor performance, track trends, and catch regressions at a glance.',
    ),
  ).toBeVisible();
  await expect(page.getByText('/v1/metrics', { exact: true })).toBeVisible();
  await expect(page.getByText('X-P-Stream', { exact: true })).toBeVisible();
});

test('unknown dataset offers the first available dataset and keeps the shared query', async ({
  page,
}) => {
  await mockLive(page);
  await page.goto('/metrics/explore/missing?query=1&type=instant');
  await expect(
    page.getByRole('heading', { name: 'The selected dataset could not be found.' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Open metrics_a', exact: true }).click();
  await expect(editor(page)).toHaveText('1');
  await expect(page).toHaveURL('/metrics/explore/metrics_a?query=1&type=instant');
});

for (const option of ['aboutError', 'listError', 'malformedAbout'] as const) {
  test(`${option} uses a readable page-level error with retry`, async ({ page }) => {
    await mockLive(page, { [option]: true });
    await page.goto('/metrics');
    await expect(page.getByRole('heading', { name: 'Could not load data' })).toBeVisible();
    await expect(page.getByRole('alert')).toContainText(
      option === 'aboutError'
        ? 'About unavailable'
        : option === 'listError'
          ? 'Dataset list unavailable'
          : 'Unexpected response from /api/v1/about',
    );
    await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
  });
}

test('a failing dataset info warns without blocking metrics and is reused until retried', async ({
  page,
}) => {
  await mockLive(page);
  let broken = true;
  let infoRequests = 0;
  await page.route('**/api/v1/logstream/*/info', (route) => {
    infoRequests++;
    return broken && route.request().url().includes('/metrics_b/')
      ? route.fulfill({ status: 500, body: 'Dataset info unavailable' })
      : route.fallback();
  });
  await openLive(page);
  const warning = page.getByText('Could not check 1 dataset: metrics_b.');
  await expect(warning).toBeVisible();
  await expect(page.getByLabel('Metrics dataset').locator('option')).toHaveCount(1);
  const scanned = infoRequests;
  await page.getByTestId('sidebar-logs').click();
  await page.getByTestId('sidebar-metrics').click();
  await expect(editor(page)).toBeVisible();
  await expect(warning).toBeVisible();
  expect(infoRequests).toBe(scanned);
  broken = false;
  await page.getByRole('button', { name: 'Check again', exact: true }).click();
  await expect(page.getByLabel('Metrics dataset').locator('option')).toHaveCount(2);
  await expect(warning).toHaveCount(0);
  expect(infoRequests).toBe(scanned + 4);
});

test('a malformed PromQL success is a readable query error', async ({ page }) => {
  await mockLive(page, {
    promql: (route, call) =>
      call.path.endsWith('/query_range')
        ? route.fulfill({
            json: {
              status: 'success',
              data: {
                resultType: 'matrix',
                result: [{ metric: {}, values: [['not a timestamp', '2']] }],
              },
            },
          })
        : undefined,
  });
  await openLive(page);
  await editor(page).fill(cpuQuery);
  await run(page);
  await expect(page.getByRole('alert')).toContainText(
    'Unexpected response from /prometheus/api/v1/query_range',
  );
  await page.getByRole('tab', { name: 'Table', exact: true }).click();
  await expect(page.getByRole('table', { name: 'Instant results' })).toBeVisible();
});

test('metadata lists cap rendering, search, show counts and expose truncation warnings', async ({
  page,
}) => {
  const names = Array.from(
    { length: 350 },
    (_, index) => `metric.${String(index).padStart(3, '0')}`,
  );
  await mockLive(page, {
    promql: (route, call) =>
      call.path.endsWith('/label/__name__/values')
        ? route.fulfill({
            json: {
              status: 'success',
              data: names,
              warnings: ['metadata results truncated to the requested limit'],
            },
          })
        : call.path.endsWith('/label/host/values')
          ? route.fulfill({
              json: {
                status: 'success',
                data: names.map((_, index) => `host-${index}`),
                warnings: ['metadata results truncated to the requested limit'],
              },
            })
          : undefined,
  });
  await page.goto('/metrics');
  const panel = browser(page);
  const metrics = panel.getByRole('region', { name: 'Metrics', exact: true });
  await expect(metrics.getByRole('list').getByRole('button')).toHaveCount(300);
  await expect(
    panel.getByText('Metadata results truncated to the requested limit.', { exact: true }),
  ).toBeVisible();
  await metrics.getByRole('button', { name: 'Show more (50)' }).click();
  await expect(metrics.getByRole('list').getByRole('button')).toHaveCount(350);
  await metrics.getByLabel('Search metrics', { exact: true }).fill('metric.349');
  await expect(metrics.getByRole('list').getByRole('button')).toHaveCount(1);
  await metrics.getByRole('button', { name: 'metric.349', exact: true }).click();
  await panel.getByRole('button', { name: 'host', exact: true }).click();
  const values = panel.getByRole('region', { name: 'Values', exact: true });
  await expect(values.getByRole('list').getByRole('button')).toHaveCount(300);
  await values.getByLabel('Search values', { exact: true }).fill('host-349');
  await expect(values.getByRole('list').getByRole('button')).toHaveCount(1);
  await expect(values.getByText('1 of 350', { exact: true })).toBeVisible();
});

test('instant matrix and scalar rows have sample hints and formatted values', async ({ page }) => {
  await demo(
    page,
    `/metrics?${new URLSearchParams({ query: `${cpuQuery}[5m]`, type: 'instant' })}`,
  );
  await page.getByRole('tab', { name: 'Table', exact: true }).click();
  await expect(page.getByRole('table', { name: 'Instant results' })).toContainText('samples');
  await editor(page).fill('2.5');
  await run(page);
  await expect(page.getByRole('table', { name: 'Instant results' })).toContainText('scalar');
  await expect(page.getByRole('table', { name: 'Instant results' })).toContainText('2.50');
});

test('empty instant and range responses use the requested empty strings', async ({ page }) => {
  await mockLive(page, {
    promql: (route, call) =>
      /\/query(?:_range)?$/.test(call.path)
        ? route.fulfill({
            json: {
              status: 'success',
              data: {
                resultType: call.path.endsWith('/query_range') ? 'matrix' : 'vector',
                result: [],
              },
            },
          })
        : undefined,
  });
  await openLive(page);
  await editor(page).fill(cpuQuery);
  await run(page);
  await expect(page.getByText('No data', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Table', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'No instant results', exact: true }),
  ).toBeVisible();
});

test('re-running cancels the previous requests and late results cannot replace the new run', async ({
  page,
}) => {
  let release = () => {};
  const held = new Promise<void>((done) => {
    release = done;
  });
  let oldRequest = false;
  await mockLive(page, {
    promql: (route, call) =>
      call.params.get('query') === 'old_query'
        ? (async () => {
            oldRequest = true;
            await held;
            await route
              .fulfill({
                json: {
                  status: 'success',
                  data: {
                    resultType: 'matrix',
                    result: [{ metric: { host: 'old' }, values: [[1, '99']] }],
                  },
                },
              })
              .catch(() => {});
          })()
        : undefined,
  });
  await openLive(page);
  await editor(page).fill('old_query');
  await page.getByRole('radio', { name: 'Range', exact: true }).check();
  await run(page);
  await expect.poll(() => oldRequest).toBe(true);
  const cancelled = page.waitForEvent(
    'requestfailed',
    (request) => request.postData()?.includes('old_query') === true,
  );
  await editor(page).fill(cpuQuery);
  await run(page);
  await cancelled;
  await expect(legend(page).getByRole('button')).toHaveCount(2);
  release();
  await page.getByRole('tab', { name: 'Table', exact: true }).click();
  await expect(page.getByRole('table', { name: 'Range summary' })).not.toContainText('old');
  await expect(page.getByRole('table', { name: 'Range summary' })).toContainText('host="a"');
});

test('an invalid range change aborts pending work and retains applied configuration for recovery', async ({
  page,
}) => {
  let release = () => {};
  const held = new Promise<void>((done) => {
    release = done;
  });
  let finish = () => {};
  const completed = new Promise<void>((done) => {
    finish = done;
  });
  let rangeCount = 0;
  const calls = await mockLive(page, {
    promql: (route, call) =>
      call.path.endsWith('/query_range') && ++rangeCount === 1
        ? (async () => {
            await held;
            await route
              .fulfill({
                json: {
                  status: 'success',
                  data: {
                    resultType: 'matrix',
                    result: [{ metric: { host: 'old' }, values: [[1, '99']] }],
                  },
                },
              })
              .catch(() => {});
            finish();
          })()
        : undefined,
  });
  await openLive(page);
  await editor(page).fill('cpu');
  await page.getByRole('radio', { name: 'Range', exact: true }).check();
  await page.getByLabel('Step', { exact: true }).fill('1s');
  const started = page.waitForRequest('**/prometheus/api/v1/query_range');
  await run(page);
  await started;
  await editor(page).fill('memory');
  const cancelled = page.waitForEvent('requestfailed', (request) =>
    request.url().endsWith('/query_range'),
  );
  await page.getByLabel('Time range', { exact: true }).selectOption('7d');
  await expect(page.getByRole('alert')).toContainText('11000 steps');
  await cancelled;
  expect(queries(calls)).toHaveLength(1);
  await expect(page.getByRole('status').filter({ hasText: 'Running queries…' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: prompt, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Refresh metrics' })).toBeEnabled();
  release();
  await completed;
  await expect(legend(page)).toHaveCount(0);
  await page.getByLabel('Time range', { exact: true }).selectOption('1h');
  await expect(legend(page).getByRole('button')).toHaveCount(2);
  expect(queries(calls)).toHaveLength(2);
  expect(queries(calls)[1].params.get('query')).toBe('cpu');
  expect(queries(calls)[1].params.get('step')).toBe('1s');
  expect(
    Number(queries(calls)[1].params.get('end')) - Number(queries(calls)[1].params.get('start')),
  ).toBe(3600);
  await expect(editor(page)).toHaveText('memory');
  await page.getByRole('tab', { name: 'Table', exact: true }).click();
  await expect(page.getByRole('table', { name: 'Range summary' })).not.toContainText('old');
});

test('leaving the explorer aborts in-flight PromQL requests', async ({ page }) => {
  let release = () => {};
  const held = new Promise<void>((done) => {
    release = done;
  });
  await mockLive(page, {
    promql: (route, call) =>
      call.path.endsWith('/query_range')
        ? held
            .then(() =>
              route.fulfill({
                json: { status: 'success', data: { resultType: 'matrix', result: [] } },
              }),
            )
            .catch(() => {})
        : undefined,
  });
  await openLive(page);
  await editor(page).fill(cpuQuery);
  await page.getByRole('radio', { name: 'Range', exact: true }).check();
  const started = page.waitForRequest('**/prometheus/api/v1/query_range');
  await run(page);
  await started;
  const cancelled = page.waitForEvent('requestfailed', (request) =>
    request.url().endsWith('/query_range'),
  );
  await page.getByTestId('sidebar-datasets').click();
  await cancelled;
  release();
  await expect(page).toHaveURL('/datasets');
});

test('390px mobile view contains queries, browser, chart and tables without horizontal page overflow', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await demo(page);
  await browser(page).getByRole('button', { name: cpu, exact: true }).click();
  await browser(page).getByRole('button', { name: 'Use metric', exact: true }).click();
  await run(page);
  await expect(legend(page).getByRole('button')).toHaveCount(4);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.getByRole('tab', { name: 'Table', exact: true }).click();
  await expect(page.getByRole('table', { name: 'Range summary' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await axe(page);
});
