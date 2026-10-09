import { randomUUID } from 'node:crypto';
import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { ApiKey, RoleSource, Roles, TeamUser } from '../src/lib/types';

const live = process.env.PARSEABLE_LIVE_URL;
const username = process.env.PARSEABLE_LIVE_USERNAME || 'frontend-smoke';
const password = process.env.PARSEABLE_LIVE_PASSWORD || 'local-smoke-password';
const dataset = process.env.PARSEABLE_LIVE_DATASET || 'frontend_smoke';
const datasetPath = `/logs/explore/${encodeURIComponent(dataset)}`;
// The embedded build is mounted at `/next`; set it empty for a server (or Vite dev) at the root.
const base = (process.env.PARSEABLE_LIVE_BASE ?? '/next').replace(/\/+$/, '');

/** Document path for an application route, mirroring `appPath` in src/lib/config.ts. */
const app = (route: string) => `${base}${route}`;
const appUrl = (route: string) => new URL(app(route), live).href;
const basicAuth = (name: string, secret: string) =>
  `Basic ${Buffer.from(`${name}:${secret}`).toString('base64')}`;
const adminHeaders = { Authorization: basicAuth(username, password) };
const rolePath = (name: string) => `/api/v1/role/${encodeURIComponent(name)}`;
const keysPath = '/api/prism/v1/apikeys';
const namedRow = (page: Page, name: string) =>
  page.getByRole('row').filter({ has: page.getByText(name, { exact: true }) });

// Fresh names for each worker, including serial-suite retries and repeated runs.
const suffix = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
const roleName = `team-live-reader-${suffix}`;
const secondRoleName = `team-live-editor-${suffix}`;
const userName = `team-live-user-${suffix}`;
const keyName = `team-live-key-${suffix}`;
const readerPrivilege = { privilege: 'reader', resource: { stream: dataset } };
let userId = userName;
let oidcActive = false;
let previousDefault: string | null = null;

test.skip(!live, 'Set PARSEABLE_LIVE_URL to opt in to the real-server suite.');
test.describe.configure({ mode: 'serial' });

async function signIn(page: Page, path = datasetPath) {
  await page.goto(app(`/login?next=${encodeURIComponent(path)}`));
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await expect(page).toHaveURL(appUrl(path));
}

async function getJson<T>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.get(path, { headers: adminHeaders, timeout: 10_000 });
  expect(response.status(), await response.text()).toBe(200);
  return response.json();
}

async function rolePrivileges(request: APIRequestContext, name: string) {
  return (await getJson<RoleSource>(request, rolePath(name))).actions;
}

async function userRoles(request: APIRequestContext) {
  const users = await getJson<TeamUser[]>(request, '/api/v1/users');
  const user = users.find((entry) => entry.id === userId);
  expect(user).toBeDefined();
  return Object.keys(user!.roles).sort();
}

async function confirmName(dialog: Locator, name: string) {
  const confirm = dialog.locator('[data-dialog-confirm]');
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel('Confirmation name', { exact: true }).fill(name);
  await confirm.click();
}

test.beforeAll(async ({ request }) => {
  const response = await request.post('/api/v1/ingest', {
    headers: { ...adminHeaders, 'X-P-Stream': dataset },
    data: [
      {
        level: 'INFO',
        service: 'frontend-smoke',
        message: 'Live smoke Team dataset ready',
        request_id: `team-${suffix}`,
      },
    ],
  });
  expect(response.ok(), await response.text()).toBe(true);
  const about = await getJson<{ oidcActive?: boolean }>(request, '/api/v1/about');
  oidcActive = about.oidcActive === true;
  previousDefault = await getJson<string | null>(request, '/api/v1/role/default');
});

test.afterAll(async ({ request }) => {
  if (!live) return;
  test.setTimeout(60_000);
  const errors: Error[] = [];
  async function cleanup(label: string, operation: () => Promise<void>) {
    try {
      await operation();
    } catch (error) {
      // Attempt every resource even when an earlier cleanup fails, then report failures.
      errors.push(new Error(`Could not clean up ${label}.`, { cause: error }));
    }
  }
  async function remove(path: string) {
    const response = await request.delete(path, { headers: adminHeaders, timeout: 5_000 });
    expect(response.ok() || response.status() === 404, await response.text()).toBe(true);
  }

  // Restore whatever default OIDC role the server had before this suite ran.
  await cleanup('default OIDC role', async () => {
    if (previousDefault === null) await remove('/api/v1/role/default');
    else {
      const restored = await request.put('/api/v1/role/default', {
        headers: { ...adminHeaders, 'Content-Type': 'application/json' },
        data: JSON.stringify(previousDefault),
      });
      expect(restored.ok(), await restored.text()).toBe(true);
    }
    expect(await getJson<string | null>(request, '/api/v1/role/default')).toBe(previousDefault);
  });
  await cleanup('API key', async () => {
    // Discover by name if creation succeeded but the sheet/ID assertion failed.
    const keys = await getJson<ApiKey[]>(request, keysPath);
    for (const key of keys.filter((entry) => entry.keyName === keyName)) {
      await remove(`${keysPath}/${encodeURIComponent(key.keyId)}`);
    }
  });
  await cleanup('native user', () => remove(`/api/v1/user/${encodeURIComponent(userId)}`));
  for (const name of [roleName, secondRoleName]) {
    await cleanup(`role ${name}`, () => remove(rolePath(name)));
  }
  if (errors.length) throw new AggregateError(errors, 'Team live-test cleanup failed.');
});

test('Team sidebar opens Roles and scoped privileges persist after addition and removal', async ({
  page,
  request,
}) => {
  await signIn(page, '/datasets');
  await page.getByTestId('sidebar-team').click();
  await expect(page).toHaveURL(appUrl('/team'));
  await expect(page.getByRole('heading', { name: 'Access management' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Roles', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.getByLabel('Search roles', { exact: true }).fill(roleName);
  await page.getByRole('button', { name: 'Add role', exact: true }).click();
  const create = page.getByRole('dialog', { name: 'Create new role', exact: true });
  await create.getByLabel('Role name', { exact: true }).fill(roleName);
  await create.getByLabel('Privilege', { exact: true }).selectOption('reader');
  await create.getByLabel('Dataset', { exact: true }).selectOption(dataset);
  await create.locator('[data-dialog-confirm]').click();
  await expect(create).toHaveCount(0);

  const row = namedRow(page, roleName);
  await expect(row.getByText(`reader of ${dataset}`, { exact: true })).toBeVisible();
  expect(await rolePrivileges(request, roleName)).toEqual([readerPrivilege]);

  await row.getByRole('button', { name: `Add privilege to role ${roleName}`, exact: true }).click();
  const add = page.getByRole('dialog', { name: 'Add privilege to role', exact: true });
  await add.getByLabel('Privilege', { exact: true }).selectOption('editor');
  await expect(add.getByLabel('Dataset', { exact: true })).toHaveCount(0);
  await add.locator('[data-dialog-confirm]').click();
  await expect(add).toHaveCount(0);
  await expect(row.getByText('editor', { exact: true })).toBeVisible();
  expect(await rolePrivileges(request, roleName)).toEqual([
    readerPrivilege,
    { privilege: 'editor' },
  ]);

  await row.getByRole('button', { name: `Remove editor from ${roleName}`, exact: true }).click();
  const remove = page.getByRole('dialog', { name: 'Remove privilege', exact: true });
  await remove.locator('[data-dialog-confirm]').click();
  await expect(remove).toHaveCount(0);
  await expect(row.getByText('editor', { exact: true })).toHaveCount(0);
  await expect(row.getByText(`reader of ${dataset}`, { exact: true })).toBeVisible();
  expect(await rolePrivileges(request, roleName)).toEqual([readerPrivilege]);
});

test('native user creation and typed password reset produce working one-time passwords', async ({
  page,
  request,
}) => {
  await signIn(page, '/team');
  await page.getByRole('tab', { name: 'Users', exact: true }).click();
  await page.getByLabel('Search users', { exact: true }).fill(userName);
  await page.getByRole('button', { name: 'Add user', exact: true }).click();
  const create = page.getByRole('dialog', { name: 'Create new user', exact: true });
  await create.getByLabel('Username', { exact: true }).fill(userName);
  await create.getByRole('checkbox', { name: roleName, exact: true }).check();
  await create.locator('[data-dialog-confirm]').click();
  const oldPassword = await create.getByLabel('One-time password', { exact: true }).inputValue();
  expect(oldPassword).toBeTruthy();
  await create.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(create).toHaveCount(0);

  const row = namedRow(page, userName);
  await expect(row.getByText(roleName, { exact: true })).toBeVisible();
  const users = await getJson<TeamUser[]>(request, '/api/v1/users');
  const user = users.find((entry) => entry.username === userName);
  expect(user).toMatchObject({ username: userName, method: 'native' });
  userId = user!.id;
  expect(await userRoles(request)).toEqual([roleName]);
  const userPath = `/api/v1/users/${encodeURIComponent(userId)}`;
  // The request fixture is isolated from the admin browser's session cookies.
  const original = await request.get(userPath, {
    headers: { Authorization: basicAuth(userName, oldPassword) },
  });
  expect(original.status(), await original.text()).toBe(200);

  await row.getByRole('button', { name: `Reset password for ${userName}`, exact: true }).click();
  const reset = page.getByRole('dialog', { name: 'Reset password', exact: true });
  await confirmName(reset, userName);
  const newPassword = await reset.getByLabel('One-time password', { exact: true }).inputValue();
  expect(newPassword).toBeTruthy();
  await reset.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(reset).toHaveCount(0);
  const rejected = await request.get(userPath, {
    headers: { Authorization: basicAuth(userName, oldPassword) },
  });
  // The backend answers invalid Basic credentials with 403; only missing credentials get 401.
  expect(rejected.status()).toBe(403);
  const accepted = await request.get(userPath, {
    headers: { Authorization: basicAuth(userName, newPassword) },
  });
  expect(accepted.status(), await accepted.text()).toBe(200);
});

test('user role assignment and removal persist, and an assigned role cannot be deleted', async ({
  page,
  request,
}) => {
  const secondRole = await request.put(rolePath(secondRoleName), {
    headers: adminHeaders,
    data: [{ privilege: 'editor' }],
  });
  expect(secondRole.ok(), await secondRole.text()).toBe(true);
  await signIn(page, '/team?tab=user');
  await page.getByLabel('Search users', { exact: true }).fill(userName);
  const user = namedRow(page, userName);
  await user.getByRole('button', { name: `Assign roles to ${userName}`, exact: true }).click();
  const assign = page.getByRole('dialog', { name: 'Assign roles', exact: true });
  await assign.getByRole('checkbox', { name: secondRoleName, exact: true }).check();
  await assign.locator('[data-dialog-confirm]').click();
  await expect(assign).toHaveCount(0);
  await expect(user.getByText(secondRoleName, { exact: true })).toBeVisible();
  expect(await userRoles(request)).toEqual([roleName, secondRoleName].sort());

  await user
    .getByRole('button', { name: `Remove ${secondRoleName} from ${userName}`, exact: true })
    .click();
  const remove = page.getByRole('dialog', { name: 'Remove role', exact: true });
  await remove.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(remove).toHaveCount(0);
  await expect(user.getByText(secondRoleName, { exact: true })).toHaveCount(0);
  expect(await userRoles(request)).toEqual([roleName]);

  await page.getByRole('tab', { name: 'Roles', exact: true }).click();
  await page.getByLabel('Search roles', { exact: true }).fill(roleName);
  await namedRow(page, roleName)
    .getByRole('button', { name: `Delete role ${roleName}`, exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Delete role', exact: true });
  const deletion = page.waitForResponse(
    (response) =>
      response.request().method() === 'DELETE' &&
      new URL(response.url()).pathname === rolePath(roleName),
  );
  await confirmName(dialog, roleName);
  const response = await deletion;
  expect(response.status()).toBe(400);
  const serverError = await response.text();
  expect(serverError).toContain('role is assigned to an existing user');
  await expect(dialog.getByRole('alert')).toHaveText(serverError);
  await expect(dialog).toBeVisible();
  expect(await rolePrivileges(request, roleName)).toEqual([readerPrivilege]);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
});

test('default OIDC role can be set and cleared when OIDC is active', async ({ page, request }) => {
  test.skip(!oidcActive, 'GET /api/v1/about did not report oidcActive: true; OIDC is inactive.');
  await signIn(page, '/team');
  await page.getByLabel('Search roles', { exact: true }).fill(roleName);
  const manage = page.getByRole('button', { name: 'Manage default OIDC role', exact: true });
  await manage.click();
  const dialog = page.getByRole('dialog', { name: 'Default OIDC role', exact: true });
  await dialog.getByLabel('Default role', { exact: true }).selectOption(roleName);
  await dialog.getByRole('button', { name: 'Set default', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const row = namedRow(page, roleName);
  await expect(row.getByText('Default', { exact: true })).toBeVisible();
  expect(await getJson<string | null>(request, '/api/v1/role/default')).toBe(roleName);

  await manage.click();
  await expect(dialog.getByText(`Current default: ${roleName}`, { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Clear default', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row.getByText('Default', { exact: true })).toHaveCount(0);
  expect(await getJson<string | null>(request, '/api/v1/role/default')).toBeNull();
});

test('API key creation reveals a UUID once, lists its masked value and supports typed deletion', async ({
  page,
  request,
}) => {
  await signIn(page, '/team');
  await page.getByRole('tab', { name: 'API keys', exact: true }).click();
  await page.getByLabel('Search API keys', { exact: true }).fill(keyName);
  await page.getByRole('button', { name: 'Add API key', exact: true }).click();
  const create = page.getByRole('dialog', { name: 'Add API key', exact: true });
  await create.getByLabel('API key name', { exact: true }).fill(keyName);
  await create.getByRole('checkbox', { name: roleName, exact: true }).check();
  await create.locator('[data-dialog-confirm]').click();
  const key = await create.getByLabel('API key', { exact: true }).inputValue();
  expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  await create.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(create).toHaveCount(0);
  const row = namedRow(page, keyName);
  const masked = `****${key.slice(-4)}`;
  await expect(row.getByText(masked, { exact: true })).toBeVisible();
  await expect(page.getByRole('table')).not.toContainText(key);
  const listed = (await getJson<ApiKey[]>(request, keysPath)).find(
    (entry) => entry.keyName === keyName,
  );
  expect(listed).toMatchObject({ keyName, apiKey: masked, roles: [roleName] });
  const keyId = listed!.keyId;

  await row.getByRole('button', { name: `Delete API key ${keyName}`, exact: true }).click();
  const remove = page.getByRole('dialog', { name: 'Delete API key', exact: true });
  await confirmName(remove, keyName);
  await expect(remove).toHaveCount(0);
  await expect(row).toHaveCount(0);
  const remaining = await getJson<ApiKey[]>(request, keysPath);
  expect(remaining.filter((entry) => entry.keyId === keyId || entry.keyName === keyName)).toEqual(
    [],
  );
});

test('typed deletion removes the native user and both roles from the server', async ({
  page,
  request,
}) => {
  await signIn(page, '/team?tab=user');
  await page.getByLabel('Search users', { exact: true }).fill(userName);
  const user = namedRow(page, userName);
  await user.getByRole('button', { name: `Delete user ${userName}`, exact: true }).click();
  const removeUser = page.getByRole('dialog', { name: 'Delete user', exact: true });
  await confirmName(removeUser, userName);
  await expect(removeUser).toHaveCount(0);
  await expect(user).toHaveCount(0);
  const missingUser = await request.get(`/api/v1/users/${encodeURIComponent(userId)}`, {
    headers: adminHeaders,
  });
  expect(missingUser.status(), await missingUser.text()).toBe(404);
  const users = await getJson<TeamUser[]>(request, '/api/v1/users');
  expect(users.some((entry) => entry.id === userId || entry.username === userName)).toBe(false);

  await page.getByRole('tab', { name: 'Roles', exact: true }).click();
  for (const name of [roleName, secondRoleName]) {
    await page.getByLabel('Search roles', { exact: true }).fill(name);
    const row = namedRow(page, name);
    await row.getByRole('button', { name: `Delete role ${name}`, exact: true }).click();
    const removeRole = page.getByRole('dialog', { name: 'Delete role', exact: true });
    await confirmName(removeRole, name);
    await expect(removeRole).toHaveCount(0);
    await expect(row).toHaveCount(0);
    // GET /role/<missing> returns an empty role with 200, so check the inventory.
    const roles = await getJson<Roles>(request, '/api/v1/roles');
    expect(Object.hasOwn(roles, name)).toBe(false);
  }
});
