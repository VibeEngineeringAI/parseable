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

/** Fails the requests for assets matching `pattern`, as if a deploy had removed them. */
async function removeAssets(page: Page, pattern: RegExp) {
  const removed: string[] = [];
  await page.route(
    (url) => url.pathname.startsWith('/next/assets/') && pattern.test(url.pathname),
    (route) => {
      removed.push(new URL(route.request().url()).pathname);
      return route.abort();
    },
  );
  return removed;
}

// Pages with their own stylesheet fail in Vite's CSS preload, before their module loads.
for (const [path, asset] of [
  ['/next/metrics', /\/MetricsPage-[\w-]+\.css$/],
  ['/next/team', /\/TeamPage-[\w-]+\.css$/],
  ['/next/alerts', /\/AlertsPage-[\w-]+\.css$/],
  ['/next/dashboards', /\/dashboards-[\w-]+\.css$/],
  // Logs has no stylesheet of its own, so its module is what goes missing.
  ['/next/logs/explore/app', /\/LogsPage-[\w-]+\.js$/],
] as const) {
  test(`${path} without its ${asset.source.slice(2, -12)} asset offers a reload`, async ({
    page,
  }) => {
    await server(page);
    const removed = await removeAssets(page, asset);
    await page.goto(path);
    const error = page.getByRole('alert');
    await expect(
      error.getByRole('heading', { name: 'This page could not be loaded' }),
    ).toBeVisible();
    await expect(error).toContainText('Parseable may have been updated');
    await expect(error).not.toContainText('/next/assets/');
    await expect(error.getByRole('button', { name: 'Reload' })).toBeVisible();
    await expect(error.getByRole('link', { name: 'Back to overview' })).toHaveAttribute(
      'href',
      '/next',
    );
    expect(removed.length).toBeGreaterThan(0);
  });
}
