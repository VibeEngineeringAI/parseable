import { expect, test, type Page } from '@playwright/test';

/** A live server with one dataset and no PromQL. */
async function server(page: Page) {
  await page.route('**/api/v1/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/v1/logstream') return route.fulfill({ json: [{ name: 'app' }] });
    if (path === '/api/v1/about') return route.fulfill({ json: { capabilities: {} } });
    if (path.endsWith('/schema')) return route.fulfill({ json: { fields: [] } });
    if (path === '/api/v1/query') return route.fulfill({ json: [] });
    return route.fulfill({ status: 404 });
  });
}

/** Fails the requests for `mount`'s assets matching `pattern`, as if a deploy had removed them. */
async function removeAssets(page: Page, mount: string, pattern: RegExp) {
  const removed: string[] = [];
  await page.route(
    (url) => url.pathname.startsWith(`${mount}/assets/`) && pattern.test(url.pathname),
    (route) => {
      removed.push(new URL(route.request().url()).pathname);
      return route.abort();
    },
  );
  return removed;
}

// Only a production build preloads a lazy page's stylesheet before its module.
// When that stylesheet is gone, Vite rejects with a plain Error, not a TypeError.
for (const mount of ['', '/next']) {
  test.describe(`a page whose assets are gone, mounted at ${mount || '/'}`, () => {
    for (const [path, asset] of [
      ['/metrics', /\/MetricsPage-[\w-]+\.css$/],
      ['/team', /\/TeamPage-[\w-]+\.css$/],
      ['/alerts', /\/AlertsPage-[\w-]+\.css$/],
      ['/dashboards', /\/dashboards-[\w-]+\.css$/],
      // Logs has no stylesheet of its own, so its module is what goes missing.
      ['/logs/explore/app', /\/LogsPage-[\w-]+\.js$/],
    ] as const) {
      test(`${path} offers a reload`, async ({ page }) => {
        await server(page);
        const removed = await removeAssets(page, mount, asset);
        await page.goto(`${mount}${path}`);
        const error = page.locator('main#main-section').getByRole('alert');
        await expect(
          error.getByRole('heading', { name: 'This page could not be loaded' }),
        ).toBeVisible();
        await expect(error).toContainText('Parseable may have been updated');
        await expect(error).not.toContainText('/assets/');
        await expect(error.getByRole('button', { name: 'Reload' })).toBeVisible();
        // The shell stays, with its navigation and sign-out.
        await expect(page.getByTestId('sidebar-datasets')).toBeVisible();
        await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
        expect(removed.length).toBeGreaterThan(0);
        // Back to overview reloads the app at its own mount.
        const back = error.getByRole('link', { name: 'Back to overview' });
        await expect(back).toHaveAttribute('href', mount || '/');
        await back.click();
        await expect(page).toHaveURL(new RegExp(`^[^?#]*//[^/]+${mount}/?$`));
        await expect(page.getByRole('alert')).toHaveCount(0);
        await expect(page.getByTestId('sidebar-datasets')).toBeVisible();
      });
    }
  });
}
