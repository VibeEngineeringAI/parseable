import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const screens = [
  {
    path: '/keystone',
    title: 'Keystone',
    message: 'Keystone analysis is unavailable in this native UI',
  },
  {
    path: '/keystone/investigation-123',
    title: 'Keystone',
    message: 'Keystone analysis is unavailable in this native UI',
  },
  {
    path: '/settings/llm-key',
    title: 'LLM settings',
    message: 'Provider management is unavailable in this native UI',
  },
];

for (const screen of screens) {
  test(`${screen.path} explains native capability scope without inventing API requests`, async ({
    page,
  }) => {
    const managementRequests: string[] = [];
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (/\/api\/.*\/(keystone|llm|network)/.test(path)) managementRequests.push(path);
    });
    await page.addInitScript(() => sessionStorage.setItem('parseable-mode', 'demo'));
    await page.goto(screen.path);
    await expect(page.getByRole('heading', { name: screen.title, exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: screen.message })).toBeVisible();
    await expect(
      page.getByText(
        'Sample workspace: this capability is not simulated. No settings are changed.',
      ),
    ).toBeVisible();
    await expect(page.locator('main input[type="password"]')).toHaveCount(0);
    await expect(page.getByRole('link', { name: /in classic UI/ })).toHaveCount(0);
    if (screen.path.includes('investigation-123')) {
      await expect(
        page.getByText(
          'This investigation has not been loaded. Its existence and your access have not been verified.',
        ),
      ).toBeVisible();
    }
    expect(managementRequests).toEqual([]);
    expect(
      (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
        .violations,
    ).toEqual([]);
  });
}

test('management pages expose useful native navigation', async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem('parseable-mode', 'demo'));
  await page.goto('/settings/llm-key');
  await page
    .getByRole('navigation', { name: 'Related pages' })
    .getByRole('link', { name: 'Network access' })
    .click();
  await expect(page.getByRole('heading', { name: 'Network access', exact: true })).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Related pages' })
    .getByRole('link', { name: 'Keystone' })
    .click();
  await expect(page.getByRole('heading', { name: 'Keystone', exact: true })).toBeVisible();
});

test('live provider settings do not collect credentials or claim provider state', async ({
  page,
}) => {
  const requests: string[] = [];
  await page.route('**/api/**', (route) => {
    requests.push(new URL(route.request().url()).pathname);
    if (route.request().url().endsWith('/logstream')) return route.fulfill({ json: [] });
    return route.fulfill({ status: 403, body: 'Permission denied' });
  });
  await page.goto('/settings/llm-key?add_llm=true');
  await expect(page.getByRole('heading', { name: 'LLM settings', exact: true })).toBeVisible();
  await expect(page.getByText(/No provider credentials are read or stored here/)).toBeVisible();
  await expect(page.getByText(/Sample workspace:/)).toHaveCount(0);
  await expect(page.locator('main input')).toHaveCount(0);
  expect(requests.filter((path) => /\/(llm|keystone|network)/.test(path))).toEqual([]);
});
