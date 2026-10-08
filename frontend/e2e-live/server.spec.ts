import { test, expect, type Page } from '@playwright/test';

const live = process.env.PARSEABLE_LIVE_URL;
const username = process.env.PARSEABLE_LIVE_USERNAME || 'frontend-smoke';
const password = process.env.PARSEABLE_LIVE_PASSWORD || 'local-smoke-password';
const dataset = process.env.PARSEABLE_LIVE_DATASET || 'frontend_smoke';
const datasetPath = `/logs/explore/${encodeURIComponent(dataset)}`;

test.skip(!live, 'Set PARSEABLE_LIVE_URL to opt in to the real-server suite.');

test.beforeAll(async ({ request }) => {
  const response = await request.post('/api/v1/ingest', {
    headers: {
      Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
      'X-P-Stream': dataset,
    },
    data: [
      {
        level: 'INFO',
        service: 'frontend-smoke',
        message: 'Live smoke request accepted',
        request_id: 'smoke-1',
      },
      {
        level: 'ERROR',
        service: 'frontend-smoke',
        message: 'Live smoke payment timeout',
        request_id: 'smoke-2',
      },
      {
        level: 'WARN',
        service: 'frontend-smoke',
        message: 'Live smoke retry scheduled',
        request_id: 'smoke-3',
      },
      {
        level: 'INFO',
        service: 'frontend-smoke',
        message: 'Live smoke request complete',
        request_id: 'smoke-4',
      },
    ],
  });
  expect(response.ok(), await response.text()).toBe(true);
});

async function signIn(page: Page, path = datasetPath) {
  await page.goto(`/login?next=${encodeURIComponent(path)}`);
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await expect(page).toHaveURL(new URL(path, live).href);
}

test('native login uses a session and shell logout invalidates it', async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole('table')).toContainText('Live smoke');
  await expect(page.getByText(username, { exact: true }).first()).toBeVisible();
  const savedSession = (await page.context().cookies()).find((cookie) => cookie.name === 'session');
  expect(savedSession).toBeDefined();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole('table')).toHaveCount(0);
  const result = await page.request.get('/api/v1/logstream', {
    headers: { Cookie: `session=${savedSession!.value}` },
  });
  expect(result.status()).toBe(401);
});

test('missing session asks for login and preserves the intended route', async ({
  page,
  context,
}) => {
  await signIn(page);
  await expect(page.getByRole('table')).toContainText('Live smoke');
  await context.clearCookies();
  await page.reload();
  await expect(page).toHaveURL(/\/login\?next=/);
  expect(new URL(page.url()).searchParams.get('next')).toBe(datasetPath);
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await expect(page).toHaveURL(new URL(datasetPath, live).href);
  await expect(page.getByRole('table')).toContainText('Live smoke');
});

test('an invalidated server session is recovered without stale identity', async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole('table')).toContainText('Live smoke');
  // Invalidate server-side but leave the browser's old session cookie in place.
  const redirect = new URL('/login', live).href;
  const response = await page.request.get(`/api/v1/o/logout?${new URLSearchParams({ redirect })}`);
  expect(response.ok()).toBe(true);
  await page.reload();
  await expect(page).toHaveURL(/\/login\?next=/);
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await expect(page.getByRole('table')).toContainText('Live smoke');
});

test('logs filter and keyboard event details use ingested data', async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole('table')).toContainText('Live smoke');
  await page.getByRole('button', { name: 'Add filter', exact: true }).click();
  const filter = page.getByRole('dialog', { name: 'Add filter' });
  await filter.getByLabel('Field', { exact: true }).selectOption('level');
  await filter.getByLabel('Value', { exact: true }).fill('ERROR');
  await filter.getByRole('button', { name: 'Apply filter' }).click();
  await expect(page.getByRole('table')).toContainText('Live smoke payment timeout');
  await expect(page.getByRole('table')).not.toContainText('Live smoke request accepted');
  await expect(page.locator('[data-filter-pill-id]')).toContainText('ERROR');
  const opener = page.getByRole('button', { name: 'Open event 1', exact: true });
  await opener.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Event details' })).toContainText('smoke-2');
  await page.keyboard.press('Escape');
  await expect(opener).toBeFocused();
});

test('SQL executes on DataFusion and reports an actual query error', async ({ page }) => {
  const sql = `SELECT * FROM "${dataset.replaceAll('"', '""')}" LIMIT 10`;
  await signIn(page, `/sql-editor?query=${encodeURIComponent(sql)}`);
  await page.getByRole('button', { name: 'Run query', exact: true }).click();
  await expect(page.getByRole('table')).toContainText('Live smoke');
  const editor = page.getByRole('textbox', { name: 'SQL query' });
  await editor.fill('SELECT * FROM "frontend_smoke_missing_table"');
  await editor.press('Control+Enter');
  await expect(page.getByRole('alert')).toContainText(/not found|does not exist/i);
  await expect(page.getByRole('table')).toHaveCount(0);
});

test('dataset inventory and Arrow schema lead back to logs', async ({ page }) => {
  await signIn(page, '/datasets');
  await page.getByRole('textbox', { name: 'Search datasets' }).fill(dataset);
  await page.getByRole('button', { name: `View schema for ${dataset}` }).click();
  const schema = page.getByRole('dialog', { name: dataset, exact: true });
  await expect(schema.locator('[data-field-node="message"]')).toBeVisible();
  await expect(schema.locator('[data-field-node="request_id"]')).toBeVisible();
  await schema.getByRole('link', { name: 'Explore dataset' }).click();
  await expect(page).toHaveURL(new URL(datasetPath, live).href);
  await expect(page.getByRole('table')).toContainText('Live smoke');
});

test('SSO traverses the provider, real callback and signed-in UI', async ({ page, request }) => {
  test.skip(
    process.env.PARSEABLE_LIVE_OIDC !== 'true',
    'Enable the local OIDC fixture separately.',
  );
  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  const role = await request.put('/api/v1/role/frontend-smoke-reader', {
    headers: { Authorization: authorization },
    data: [{ privilege: 'reader', resource: { stream: dataset } }],
  });
  expect(role.ok(), await role.text()).toBe(true);
  await page.goto(`/login?next=${encodeURIComponent(datasetPath)}`);
  await page.getByRole('button', { name: 'Sign in with SSO', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Local mock identity provider' })).toBeVisible();
  await expect(page).toHaveURL(
    (url) =>
      url.origin === `http://127.0.0.1:${process.env.MOCK_OIDC_PORT || '8251'}` &&
      url.pathname === '/authorize',
  );
  const callback = page.waitForRequest((req) => new URL(req.url()).pathname === '/api/v1/o/code');
  await page.getByRole('button', { name: 'Sign in as Smoke SSO User' }).click();
  expect((await callback).isNavigationRequest()).toBe(true);
  await expect(page).toHaveURL(new URL(datasetPath, live).href);
  await expect(page.getByText('Smoke SSO User', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('table')).toContainText('Live smoke');
  // Reader accounts can inspect metadata, but cannot enumerate administrative roles.
  const deniedRoles = await page.request.get('/api/v1/roles');
  expect(deniedRoles.status()).toBe(403);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByLabel('Username', { exact: true })).toBeVisible();
  // Re-enter SSO with any stale cookie still supplied by the backend logout response.
  await page.getByRole('button', { name: 'Sign in with SSO', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Local mock identity provider' })).toBeVisible();
});

test('an unconfigured OIDC server explains native login and keeps the return path', async ({
  page,
}) => {
  test.skip(
    process.env.PARSEABLE_LIVE_NO_OIDC !== 'true',
    'Run against a server started without OIDC options.',
  );
  await page.goto(`/login?next=${encodeURIComponent(datasetPath)}`);
  await page.getByRole('button', { name: 'Sign in with SSO', exact: true }).click();
  await expect(page).toHaveURL(/\/oidc-not-configured/);
  await expect(
    page.getByRole('heading', { name: 'Single sign-on is not configured' }),
  ).toBeVisible();
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await expect(page).toHaveURL(new URL(datasetPath, live).href);
  await expect(page.getByRole('table')).toContainText('Live smoke');
});
