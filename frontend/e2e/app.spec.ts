import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

async function demo(page: Page, path = '/logs') {
  await page.addInitScript(() => sessionStorage.setItem('parseable-mode', 'demo'));
  await page.goto(path);
}

test('a failed live connection remains visible until the user chooses demo', async ({ page }) => {
  await page.route('**/api/v1/**', (route) =>
    route.fulfill({ status: 503, contentType: 'text/plain', body: 'Test server unavailable' }),
  );
  await page.goto('/logs');
  await expect(page.getByRole('heading', { name: 'Could not load data' })).toBeVisible();
  await expect(page.getByText('Live server', { exact: true })).toBeVisible();
  await expect(page.getByRole('table')).toHaveCount(0);
  await page.getByRole('button', { name: 'Explore demo data' }).click();
  await expect(page.getByText('Demo data', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Dataset', { exact: true })).toHaveValue('application_logs');
  await expect(page.getByRole('table')).toBeVisible();
});

test('log filters, columns, event details and pagination compose', async ({ page }) => {
  await demo(page);
  await expect(page.getByRole('table')).toBeVisible();
  await expect(page.getByText('Page 1 of 4', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Next page' }).click();
  await expect(page.getByText('Page 2 of 4', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Add filter', exact: true }).click();
  const filter = page.getByRole('dialog', { name: 'Add filter' });
  await filter.getByLabel('Field', { exact: true }).selectOption('level');
  await filter.getByLabel('Value', { exact: true }).fill('ERROR');
  await filter.getByRole('button', { name: 'Apply filter' }).click();
  await expect(page.getByTestId('filter-pill-value')).toHaveText('ERROR');
  const rows = page.getByRole('table').locator('tbody tr');
  await expect(rows).toHaveCount(8);
  for (const row of await rows.all())
    await expect(row.getByText('ERROR', { exact: true })).toBeVisible();
  await page.locator('[data-field-node="host"]').click();
  await expect(page.getByRole('columnheader', { name: 'host', exact: true })).toBeVisible();
  await page.locator('[data-field-node="host"]').click();
  await expect(page.getByRole('columnheader', { name: 'host', exact: true })).toHaveCount(0);
  const opener = page.getByRole('button', { name: 'Open event 1', exact: true });
  await opener.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Event details' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(opener).toBeFocused();
  await page.getByRole('button', { name: 'Remove filter level = ERROR' }).click();
  await expect(page.getByTestId('filter-pill-value')).toHaveCount(0);
  await expect(page.getByText('Page 1 of 4', { exact: true })).toBeVisible();
});

test('SQL editor runs a real query against the explicit demo adapter', async ({ page }) => {
  await demo(page, '/sql-editor');
  await expect(page.getByRole('heading', { name: 'Ready when you are' })).toBeVisible();
  const editor = page.getByRole('textbox', { name: 'SQL query' });
  await editor.fill('SELECT * FROM "application_logs" WHERE "level" = \'ERROR\' LIMIT 3');
  await editor.press('Control+Enter');
  await expect(page.getByRole('table').locator('tbody tr')).toHaveCount(3);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export JSON' }).click();
  expect((await download).suggestedFilename()).toBe('query-results.json');
  await editor.fill('SELECT COUNT(*) FROM "application_logs" GROUP BY "level"');
  await page.getByRole('button', { name: 'Run query' }).click();
  await expect(page.getByRole('alert')).toContainText('Demo SQL supports');
  await expect(page.getByRole('table')).toHaveCount(0);
});

test('narrow-screen navigation retains accessible links and contained layout', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await demo(page);
  await page.getByTestId('sidebar-datasets').click();
  await expect(page.getByRole('heading', { name: 'Datasets', exact: true })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

test('a dashboard persists locally and deletion requires confirmation', async ({ page }) => {
  await demo(page, '/dashboards');
  await page.getByRole('button', { name: 'Create dashboard', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Create dashboard' });
  await dialog.getByLabel('Dashboard name').fill('Production signals');
  await dialog.getByLabel('Description').fill('Application event volume');
  await dialog.getByLabel('Dataset', { exact: true }).selectOption('application_logs');
  await dialog.getByRole('button', { name: 'Create dashboard', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Production signals', exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Production signals', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Create dashboard', exact: true }).click();
  await dialog.getByLabel('Dashboard name').fill(' production SIGNALS ');
  await expect(dialog.getByLabel('Dashboard name')).toHaveAccessibleDescription(
    'A dashboard with this name already exists.',
  );
  await expect(
    dialog.getByRole('button', { name: 'Create dashboard', exact: true }),
  ).toBeDisabled();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Delete dashboard Production signals' }).click();
  await expect(page.getByRole('dialog', { name: 'Delete dashboard?' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('heading', { name: 'Production signals', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Delete dashboard Production signals' }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Delete dashboard', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'Production signals', exact: true })).toHaveCount(
    0,
  );
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Production signals', exact: true })).toHaveCount(
    0,
  );
});

test('dashboards saved with duplicate titles get distinct delete labels', async ({ page }) => {
  await page.addInitScript(() => {
    const dashboard = { description: '', dataset: 'application_logs', title: 'API errors' };
    localStorage.setItem(
      'parseable-dashboards-v1-demo',
      JSON.stringify([
        { ...dashboard, id: 'a' },
        { ...dashboard, id: 'b' },
      ]),
    );
  });
  await demo(page, '/dashboards');
  await expect(
    page.getByRole('button', { name: 'Delete dashboard API errors', exact: true }),
  ).toHaveCount(1);
  await page.getByRole('button', { name: 'Delete dashboard API errors (2)', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Delete dashboard', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'API errors (2)', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'API errors', exact: true })).toBeVisible();
});

test('dataset search and schema inspection lead to the matching explorer', async ({ page }) => {
  await demo(page, '/datasets');
  await page.getByRole('textbox', { name: 'Search datasets' }).fill('api_logs');
  await expect(page.getByRole('heading', { name: 'application_logs', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'View schema for api_logs' }).click();
  const sheet = page.getByRole('dialog', { name: 'api_logs', exact: true });
  await expect(sheet.locator('[data-field-node="p_timestamp"]')).toBeVisible();
  await expect(sheet.locator('[data-field-node="trace_id"]')).toBeVisible();
  await sheet.getByRole('link', { name: 'Explore dataset' }).click();
  await expect(page).toHaveURL(/\/logs\/explore\/api_logs$/);
  await expect(page.getByLabel('Dataset', { exact: true })).toHaveValue('api_logs');
  await expect(page.getByRole('table')).toBeVisible();
});

test('library dialogs restore focus, contain keyboard navigation, and tabs use arrow keys', async ({
  page,
}) => {
  await demo(page, '/components');
  const opener = page.getByRole('button', { name: 'Open dialog', exact: true });
  await opener.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Example dialog' });
  await expect(dialog).toBeVisible();
  for (let index = 0; index < 6; index++) {
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  await page.getByRole('tab', { name: 'Overview', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Details', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('tabpanel')).toContainText('Each panel has a clear purpose.');
  await page.getByRole('button', { name: 'Use dark theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(results.violations).toEqual([]);
});

for (const route of ['/logs', '/sql-editor', '/datasets', '/dashboards', '/team', '/components']) {
  test(`accessibility smoke: ${route}`, async ({ page }) => {
    await demo(page, route);
    await expect(page.locator('main h1')).toBeVisible();
    await expect(page.getByText('Loading data…', { exact: true })).toHaveCount(0);
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
}

test('native login switches from demo to live and sends backend query contracts', async ({
  page,
}) => {
  let authenticated = false;
  let queryBody: Record<string, unknown> | undefined;
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/v1/o/login') {
      expect(request.headers().authorization).toBe(
        `Basic ${Buffer.from('reader:test-password').toString('base64')}`,
      );
      expect(new URL(request.url()).searchParams.get('redirect')).toBe(
        'http://127.0.0.1:5173/logs',
      );
      authenticated = true;
      return route.fulfill({ status: 200, body: 'ok' });
    }
    if (path === '/api/v1/o/logout') {
      expect(request.isNavigationRequest()).toBe(true);
      authenticated = false;
      return route.fulfill({ status: 302, headers: { Location: '/login' } });
    }
    expect(request.headers().authorization).toBeUndefined();
    if (!authenticated) return route.fulfill({ status: 401, body: 'Sign in required' });
    if (path === '/api/v1/logstream') return route.fulfill({ json: [{ name: 'server_logs' }] });
    if (path.endsWith('/schema'))
      return route.fulfill({ json: { fields: [{ name: 'p_timestamp' }, { name: 'message' }] } });
    if (path === '/api/v1/query') {
      queryBody = request.postDataJSON();
      return route.fulfill({
        json: [{ p_timestamp: new Date().toISOString(), message: 'Live contract fixture' }],
      });
    }
    return route.fulfill({ status: 404 });
  });
  await demo(page);
  await page.getByRole('button', { name: 'Connection settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Connect to Parseable' });
  await dialog.getByLabel('Username').fill('reader');
  await dialog.getByLabel('Password', { exact: true }).fill('test-password');
  await dialog.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByText('Live server', { exact: true })).toBeVisible();
  await expect(page.getByRole('table')).toContainText('Live contract fixture');
  expect(queryBody?.query).toContain('FROM "server_logs"');
  expect(queryBody?.sendNull).toBe(true);
  expect(queryBody?.startTime).toEqual(expect.any(String));
  expect(queryBody?.endTime).toEqual(expect.any(String));
  expect(
    await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage })),
  ).not.toContain('test-password');
  await page.getByRole('button', { name: 'Connection settings' }).click();
  await page.getByRole('button', { name: 'Sign out of server' }).click();
  await expect(page.getByRole('table')).toHaveCount(0);
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Log in to your account' })).toBeVisible();
});

test('mobile navigation has names for assistive technology', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await demo(page, '/');
  await page.getByRole('link', { name: 'Logs', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Logs', exact: true })).toBeVisible();
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(results.violations).toEqual([]);
});

test('dark SQL editor retains accessible syntax contrast', async ({ page }) => {
  await demo(page, '/sql-editor');
  await page.getByRole('textbox', { name: 'SQL query' }).waitFor();
  await page.getByRole('button', { name: 'Use dark theme' }).click();
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(results.violations).toEqual([]);
});

test('event details do not carry a status over to the next event', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await demo(page);
  await page.getByRole('button', { name: 'Open event 1', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Event details' });
  await sheet.getByRole('button', { name: 'Copy JSON' }).click();
  await expect(sheet.getByRole('status')).toHaveText('Event copied');
  await sheet.getByRole('button', { name: 'Include level in filter' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Open event 1', exact: true }).click();
  await expect(sheet.getByRole('status')).toHaveText('');
  await sheet.getByRole('button', { name: 'Copy JSON' }).click();
  await expect(sheet.getByRole('status')).toHaveText('Event copied');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Open event 1', exact: true }).click();
  await expect(sheet.getByRole('status')).toHaveText('');
});

test('switching dataset never queries it with the previous filters', async ({ page }) => {
  const queries: string[] = [];
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/v1/logstream')
      return route.fulfill({ json: [{ name: 'a_logs' }, { name: 'b_logs' }] });
    if (path.endsWith('/schema'))
      return route.fulfill({ json: { fields: [{ name: 'level' }, { name: 'message' }] } });
    if (path === '/api/v1/query') {
      queries.push(request.postDataJSON().query);
      return route.fulfill({ json: [{ level: 'ERROR', message: 'fixture' }] });
    }
    return route.fulfill({ status: 404 });
  });
  await page.goto('/logs/explore/a_logs');
  await expect(page.getByRole('table')).toBeVisible();
  await page.getByRole('button', { name: 'Add filter', exact: true }).click();
  const filter = page.getByRole('dialog', { name: 'Add filter' });
  await filter.getByLabel('Field', { exact: true }).selectOption('level');
  await filter.getByLabel('Value', { exact: true }).fill('ERROR');
  await filter.getByRole('button', { name: 'Apply filter' }).click();
  await expect
    .poll(() => queries.some((q) => q.includes('a_logs') && q.includes('ERROR')))
    .toBe(true);
  await page.getByLabel('Search messages').fill('needle');
  await expect
    .poll(() => queries.some((q) => q.includes('a_logs') && q.includes('needle')))
    .toBe(true);
  await page.getByLabel('Dataset', { exact: true }).selectOption('b_logs');
  await expect.poll(() => queries.some((q) => q.includes('b_logs'))).toBe(true);
  await expect(page.getByTestId('filter-pill-value')).toHaveCount(0);
  await expect(page.getByLabel('Search messages')).toHaveValue('');
  expect(
    queries.filter((q) => q.includes('b_logs') && (q.includes('ERROR') || q.includes('needle'))),
  ).toEqual([]);
});

test('a copy that finishes after the sheet reopens is not reported', async ({ page }) => {
  await demo(page);
  await page.evaluate(() => {
    const pending: (() => void)[] = [];
    Object.assign(window, { finishCopy: () => pending.splice(0).forEach((done) => done()) });
    navigator.clipboard.writeText = () => new Promise<void>((done) => pending.push(done));
  });
  await page.getByRole('button', { name: 'Open event 1', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Event details' });
  await sheet.getByRole('button', { name: 'Copy JSON' }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Open event 1', exact: true }).click();
  await page.evaluate(() => (window as unknown as { finishCopy: () => void }).finishCopy());
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await expect(sheet.getByRole('status')).toHaveText('');
});

test('filter chips on the same field have distinct remove labels', async ({ page }) => {
  await demo(page);
  await expect(page.getByRole('table')).toBeVisible();
  const filter = page.getByRole('dialog', { name: 'Add filter' });
  for (const [operator, value] of [
    ['!=', 'DEBUG'],
    ['!=', 'INFO'],
  ]) {
    await page.getByRole('button', { name: 'Add filter', exact: true }).click();
    await filter.getByLabel('Field', { exact: true }).selectOption('level');
    await filter.getByLabel('Operator', { exact: true }).selectOption(operator);
    await filter.getByLabel('Value', { exact: true }).fill(value);
    await filter.getByRole('button', { name: 'Apply filter' }).click();
  }
  await page.getByRole('button', { name: 'Add filter', exact: true }).click();
  await filter.getByLabel('Field', { exact: true }).selectOption('level');
  await filter.getByLabel('Operator', { exact: true }).selectOption('!=');
  await filter.getByLabel('Value', { exact: true }).fill('DEBUG');
  await filter.getByRole('button', { name: 'Apply filter' }).click();
  await expect(page.getByTestId('filter-pill-value')).toHaveText(['DEBUG', 'INFO']);
  await expect(page.getByRole('button', { name: 'Remove filter level != DEBUG' })).toHaveCount(1);
  await page.getByRole('button', { name: 'Remove filter level != INFO' }).click();
  await expect(page.getByTestId('filter-pill-value')).toHaveText(['DEBUG']);
});

test('a filter applied while results reload keeps the page and a real field', async ({ page }) => {
  const errors: Error[] = [];
  page.on('pageerror', (error) => errors.push(error));
  let release = () => {};
  const held = new Promise<void>((done) => (release = done));
  let queries = 0;
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/v1/logstream') return route.fulfill({ json: [{ name: 'server_logs' }] });
    // An empty schema leaves the field list to the returned rows.
    if (path.endsWith('/schema')) return route.fulfill({ json: { fields: [] } });
    if (path === '/api/v1/query') {
      if (++queries > 1) await held;
      return route.fulfill({ json: [{ level: 'ERROR', message: 'fixture' }] });
    }
    return route.fulfill({ status: 404 });
  });
  await page.clock.install();
  await page.goto('/logs');
  await expect(page.getByRole('table')).toContainText('fixture');
  // Hold the search debounce so the dialog opens before the reload starts.
  await page.clock.pauseAt(Date.now() + 60_000);
  await page.getByLabel('Search messages').fill('needle');
  await page.getByTestId('add-filter-button').click();
  const filter = page.getByRole('dialog', { name: 'Add filter' });
  await filter.getByLabel('Value', { exact: true }).fill('ERROR');
  await page.clock.runFor(300);
  await expect.poll(() => queries).toBe(2);
  await filter.getByRole('button', { name: 'Apply filter' }).click();
  await page.clock.resume();
  await expect(page.getByRole('heading', { name: 'Logs', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove filter level = ERROR' })).toBeVisible();
  release();
  await expect(page.getByRole('table')).toContainText('fixture');
  expect(errors).toEqual([]);
});

test('an earlier copy finishing late keeps the reopened sheet status', async ({ page }) => {
  await demo(page);
  await page.evaluate(() => {
    const pending: (() => void)[] = [];
    Object.assign(window, { finishCopy: (index: number) => pending[index]() });
    navigator.clipboard.writeText = () => new Promise<void>((done) => pending.push(done));
  });
  const finishCopy = (index: number) =>
    page.evaluate(
      (i) => (window as unknown as { finishCopy: (i: number) => void }).finishCopy(i),
      index,
    );
  await page.getByRole('button', { name: 'Open event 1', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Event details' });
  await sheet.getByRole('button', { name: 'Copy JSON' }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Open event 1', exact: true }).click();
  await sheet.getByRole('button', { name: 'Copy JSON' }).click();
  await finishCopy(1);
  await expect(sheet.getByRole('status')).toHaveText('Event copied');
  await finishCopy(0);
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await expect(sheet.getByRole('status')).toHaveText('Event copied');
});
