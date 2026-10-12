import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
const policy = {
  allowPrivate: false,
  allowedDomains: ['alerts.example'],
  allowedCidrs: [],
  deniedDomains: [],
  deniedCidrs: [],
  allowInvalidTls: false,
};
async function live(page: import('@playwright/test').Page) {
  await page.route('**/api/**', (route) => route.fulfill({ json: [] }));
}
test('loads and saves the full outbound policy, retains server validation drafts, discards edits', async ({
  page,
}) => {
  await live(page);
  let puts = 0;
  let body: unknown;
  await page.route('**/api/v1/alert-target-policy', async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: policy });
    puts++;
    body = route.request().postDataJSON();
    if (puts === 1)
      return route.fulfill({
        status: 400,
        json: {
          error: 'invalid_policy',
          message: 'allow and deny domain lists conflict',
          hint: 'Remove overlapping entries',
        },
      });
    await new Promise((resolve) => setTimeout(resolve, 150));
    return route.fulfill({ json: body });
  });
  await page.goto('/settings/network-access');
  await expect(page.getByLabel('Allowed domains')).toHaveValue('alerts.example');
  await page.getByLabel('Denied domains').fill('alerts.example');
  await page.getByRole('button', { name: 'Save policy', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('allow and deny domain lists conflict');
  await expect(page.getByLabel('Denied domains')).toHaveValue('alerts.example');
  await page.getByLabel('Denied domains').fill('blocked.example\n\n other.example ');
  await page.getByLabel('Allow private destinations', { exact: true }).check();
  await page.getByLabel('Allowed CIDRs').fill('10.0.0.0/8');
  await page.getByRole('button', { name: 'Save policy', exact: true }).dblclick();
  await expect(page.getByRole('status')).toContainText('Network policy saved.');
  expect(puts).toBe(2);
  expect(body).toEqual({
    ...policy,
    allowPrivate: true,
    allowedCidrs: ['10.0.0.0/8'],
    deniedDomains: ['blocked.example', 'other.example'],
  });
  await page.getByLabel('Allowed domains').fill('changed.example');
  await page.getByRole('button', { name: 'Discard changes' }).click();
  await expect(page.getByLabel('Allowed domains')).toHaveValue('alerts.example');
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
});
test('load retry and authoritative permission denial', async ({ page }) => {
  await live(page);
  let denied = false;
  await page.route('**/api/v1/alert-target-policy', (route) =>
    route.fulfill(
      denied ? { status: 403, body: 'Forbidden' } : { status: 503, body: 'Unavailable' },
    ),
  );
  await page.goto('/settings/network-access');
  await expect(page.getByRole('alert')).toContainText('Could not load');
  denied = true;
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByRole('alert')).toContainText('Administrator permission required');
  await expect(page.getByRole('button', { name: 'Save policy' })).toHaveCount(0);
});
test('demo changes stay local and unsaved navigation can be cancelled', async ({ page }) => {
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('alert-target-policy')) writes.push(request.url());
  });
  await page.addInitScript(() => sessionStorage.setItem('parseable-mode', 'demo'));
  await page.goto('/settings/network-access');
  await expect(page.getByText(/changes are stored locally/)).toBeVisible();
  await page.getByLabel('Allowed domains').fill('local.example');
  page.once('dialog', (dialog) => dialog.dismiss());
  await page
    .getByRole('navigation', { name: 'Related pages' })
    .getByRole('link', { name: 'Keystone' })
    .click();
  await expect(page).toHaveURL(/network-access/);
  await page.getByRole('button', { name: 'Save policy', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Local sample policy saved.' }),
  ).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Related pages' })
    .getByRole('link', { name: 'Keystone' })
    .click();
  await page
    .getByRole('navigation', { name: 'Related pages' })
    .getByRole('link', { name: 'Network access' })
    .click();
  await expect(page.getByLabel('Allowed domains')).toHaveValue('local.example');
  expect(writes).toEqual([]);
});

test('invalid literal domain syntax prevents PUT and focuses accessible field errors', async ({
  page,
}) => {
  await live(page);
  let puts = 0;
  await page.route('**/api/v1/alert-target-policy', (route) => {
    if (route.request().method() === 'PUT') puts++;
    return route.fulfill({ json: policy });
  });
  await page.goto('/settings/network-access');
  const domains = page.getByLabel('Allowed domains', { exact: true });
  for (const invalid of [
    '*.evil.example',
    'https://host.example',
    'host.example:443/path',
    'host example',
    'host\\example',
  ]) {
    await domains.fill(invalid);
    await page.getByRole('button', { name: 'Save policy', exact: true }).click();
    await expect(domains).toBeFocused();
    await expect(domains).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByRole('alert')).toContainText('Enter a plain hostname');
  }
  expect(puts).toBe(0);
  await domains.fill('valid.example');
  await expect(domains).toHaveAttribute('aria-invalid', 'false');
});
test('revoked save permission retains draft and allows discard without re-enabling writes', async ({
  page,
}) => {
  await live(page);
  await page.route('**/api/v1/alert-target-policy', (route) =>
    route.fulfill(
      route.request().method() === 'GET' ? { json: policy } : { status: 403, body: 'Forbidden' },
    ),
  );
  await page.goto('/settings/network-access');
  const domains = page.getByLabel('Allowed domains', { exact: true });
  await domains.fill('changed.example');
  await page.getByRole('button', { name: 'Save policy', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Administrator permission required');
  await expect(domains).toHaveValue('changed.example');
  await expect(domains).toBeDisabled();
  await page.getByRole('button', { name: 'Discard changes' }).click();
  await expect(domains).toHaveValue('alerts.example');
  await expect(page.getByRole('button', { name: 'Save policy', exact: true })).toBeDisabled();
  await expect(page.getByRole('alert')).toContainText('Administrator permission required');
  page.once('dialog', () => {
    throw new Error('Clean discarded draft must not block navigation');
  });
  await page
    .getByRole('navigation', { name: 'Related pages' })
    .getByRole('link', { name: 'Keystone' })
    .click();
  await expect(page).toHaveURL(/keystone/);
});
