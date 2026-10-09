import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('login has working password visibility and administrator recovery', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Password', { exact: true }).fill('private');
  await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute('type', 'password');
  await page.getByRole('button', { name: 'Show password' }).click();
  await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute('type', 'text');
  await page.getByRole('button', { name: 'Hide password' }).click();
  await page.getByRole('button', { name: 'Forgot password?' }).click();
  const dialog = page.getByRole('dialog', { name: 'Reset password' });
  await expect(dialog).toContainText('Please contact admin to reset your password');
  await dialog.getByRole('button', { name: 'Got it' }).click();
  await expect(dialog).not.toBeVisible();
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
});

test('live 401 returns to the requested application path after native sign in', async ({
  page,
}) => {
  let signedIn = false;
  await page.route('**/api/v1/**', (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/v1/o/login') {
      expect(url.searchParams.get('redirect')).toBe('http://127.0.0.1:5173/datasets?view=list');
      signedIn = true;
      return route.fulfill({ status: 200, body: 'ok' });
    }
    return route.fulfill(
      signedIn ? { json: [{ name: 'server_logs' }] } : { status: 401, body: 'Session expired' },
    );
  });
  await page.goto('/datasets?view=list');
  await expect(page).toHaveURL(/\/login\?next=/);
  await page.getByLabel('Username', { exact: true }).fill('reader');
  await page.getByLabel('Password', { exact: true }).fill('secret');
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await expect(page).toHaveURL('/datasets?view=list');
  await expect(page.getByText('server_logs', { exact: true })).toBeVisible();
});

test('OAuth is a document navigation with a safe same-origin redirect', async ({ page }) => {
  await page.route('**/api/v1/o/login?**', (route) => {
    expect(route.request().isNavigationRequest()).toBe(true);
    expect(new URL(route.request().url()).searchParams.get('redirect')).toBe(
      'http://127.0.0.1:5173/',
    );
    return route.fulfill({ contentType: 'text/html', body: '<h1>Identity provider handoff</h1>' });
  });
  await page.goto('/login?next=https%3A%2F%2Fevil.example%2F');
  await page.getByRole('button', { name: 'Sign in with SSO' }).click();
  await expect(page.getByRole('heading', { name: 'Identity provider handoff' })).toBeVisible();
});

test('OAuth not configured preserves native login and the intended route', async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem('parseable-return-path', '/sql-editor'));
  await page.goto('/oidc-not-configured');
  await expect(
    page.getByRole('heading', { name: 'Single sign-on is not configured' }),
  ).toBeVisible();
  await expect(page.getByLabel('Username', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Back to native sign in' }).click();
  await expect(page).toHaveURL('/login?next=%2Fsql-editor');
});

test('forbidden resources expose permission recovery without a demo action', async ({ page }) => {
  await page.route('**/api/v1/**', (route) =>
    route.fulfill({ status: 403, body: 'Dataset access denied' }),
  );
  await page.goto('/logs');
  await expect(page.getByRole('heading', { name: 'Permission denied' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Ask your administrator');
  await expect(page.getByRole('button', { name: 'Explore demo data' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  await expect(page).toHaveURL('/logs');
});

test('stale sessions are cleared before OAuth retry', async ({ page, context }) => {
  await context.addCookies([
    { name: 'session', value: 'expired', url: 'http://127.0.0.1:5173' },
    { name: 'username', value: 'old-reader', url: 'http://127.0.0.1:5173' },
  ]);
  await page.route('**/api/v1/**', (route) => {
    if (new URL(route.request().url()).pathname === '/api/v1/o/login') {
      expect(route.request().headers().cookie || '').not.toContain('session=expired');
      return route.fulfill({ contentType: 'text/html', body: '<h1>OAuth retry</h1>' });
    }
    return route.fulfill({ status: 401, body: 'Expired' });
  });
  await page.goto('/logs');
  await expect(page.getByRole('heading', { name: 'Log in to your account' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign in with SSO' }).click();
  await expect(page.getByRole('heading', { name: 'OAuth retry' })).toBeVisible();
});
