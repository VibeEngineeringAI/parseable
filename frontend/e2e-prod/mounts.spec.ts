import { test, expect, type Page } from '@playwright/test';

/** Requests that failed, error statuses and uncaught errors on `page`. */
function problems(page: Page): string[] {
  const seen: string[] = [];
  page.on('requestfailed', (r) => seen.push(`${r.url()} ${r.failure()?.errorText}`));
  page.on('response', (r) => {
    if (r.status() >= 400) seen.push(`${r.status()} ${r.url()}`);
  });
  page.on('pageerror', (error) => seen.push(error.message));
  return seen;
}

for (const mount of ['', '/next']) {
  test.describe(`the production build mounted at ${mount || '/'}`, () => {
    test('opens the shared agent setup guide from Get started under its mount', async ({
      page,
    }) => {
      const failed = problems(page);
      await page.addInitScript(() => sessionStorage.setItem('parseable-mode', 'demo'));
      await page.goto(`${mount}/onboarding`);
      await page.getByRole('link', { name: 'Set up Claude Code or Codex' }).click();
      await expect(page).toHaveURL(`${mount}/agents?setup=1`);
      const guide = page.getByRole('dialog', { name: 'Set up agent telemetry' });
      await expect(guide).toBeVisible();
      await guide.getByRole('tab', { name: 'Codex', exact: true }).click();
      await expect(guide.getByLabel('Codex settings', { exact: true })).toContainText(
        '[otel.trace_exporter.otlp-http]',
      );
      await expect(
        guide.getByRole('link', { name: 'View collector and ingestion setup' }),
      ).toHaveAttribute('href', `${mount}/add-data`);
      await page.reload();
      await expect(guide).toBeVisible();
      await guide.getByRole('button', { name: 'Close dialog' }).click();
      await expect(page).toHaveURL(`${mount}/agents`);
      expect(failed).toEqual([]);
    });

    test('loads lazy pages on deep routes from its own mount', async ({ page }) => {
      const failed = problems(page);
      const paths: string[] = [];
      page.on('request', (r) => paths.push(new URL(r.url()).pathname));
      await page.addInitScript(() => sessionStorage.setItem('parseable-mode', 'demo'));

      // A hard load two segments deep: relative asset URLs resolve against
      // `<base>`, not the document.
      await page.goto(`${mount}/dashboards/01M4J000000000000000000002`);
      await expect(page.locator('[data-tile-id]').first()).toBeVisible();
      await page.getByRole('link', { name: 'Logs', exact: true }).click();
      await expect(page).toHaveURL(`${mount}/logs`);
      await expect(page.getByRole('table')).toBeVisible();
      await page.getByRole('link', { name: 'Metrics', exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`^[^?]*${mount}/metrics(\\?|$)`));
      await expect(page.getByRole('heading').first()).toBeVisible();

      await page.goto(`${mount}/traces/explore/demo_traces`);
      await expect(page.getByRole('heading', { name: 'Traces', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: /Open trace/ }).first()).toBeVisible();
      await page.goto(`${mount}/apm/demo_traces/checkout`);
      await expect(page.getByRole('heading', { name: 'checkout', exact: true })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Explore service traces' })).toHaveAttribute(
        'href',
        new RegExp(`^${mount}/traces/explore/demo_traces\\?`),
      );
      await page.getByTestId('sidebar-add-data').click();
      await expect(page).toHaveURL(`${mount}/add-data`);
      await expect(page.getByRole('heading', { name: 'Add data', exact: true })).toBeVisible();

      for (const [path, title] of [
        ['/agents/agent_telemetry', 'Agents'],
        ['/cluster', 'Cluster'],
        ['/errors/demo_traces', 'Errors'],
        ['/onboarding', 'Get started'],
        ['/new', 'Set up a workspace'],
        ['/keystone/example', 'Keystone'],
        ['/settings/llm-key', 'LLM settings'],
        ['/settings/network-access', 'Network access'],
      ]) {
        await page.goto(`${mount}${path}`);
        await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
      }
      await expect(page.getByLabel('Allowed domains', { exact: true })).toBeVisible();

      expect(failed).toEqual([]);
      expect(paths.filter((path) => !path.startsWith(`${mount}/`))).toEqual([]);
      // Lazy chunks import the entry module that is already running.
      const entries = new Set(paths.filter((path) => /\/assets\/index-[^/]+\.js$/.test(path)));
      expect(entries.size).toBe(1);
    });

    test('resolves against its mount whichever path serves index.html', async ({ page }) => {
      for (const path of [`${mount}/`, `${mount}/index.html`, `${mount}/a/b/c`]) {
        const response = await page.request.get(path);
        expect(response.status(), path).toBe(200);
        expect(await response.text(), path).toContain(`<base href="${mount}/"`);
      }
      const failed = problems(page);
      await page.goto(`${mount}/index.html`);
      expect(await page.evaluate(() => document.baseURI)).toMatch(new RegExp(`${mount}/$`));
      await expect(page.locator('#root > *').first()).toBeVisible();
      expect(failed).toEqual([]);
    });

    test('links a favicon that resolves under its mount', async ({ page, request }) => {
      await page.goto(`${mount}/logs/explore/application_logs`);
      const icons = await page
        .locator('link[rel="icon"]')
        .evaluateAll((links) => links.map((link) => (link as HTMLLinkElement).href));
      expect(icons.length).toBeGreaterThan(0);
      for (const href of [...icons, new URL(`${mount}/favicon.ico`, page.url()).href]) {
        expect(new URL(href).pathname).toMatch(new RegExp(`^${mount}/favicon\\.(ico|svg)$`));
        const response = await request.get(href);
        expect(response.status(), href).toBe(200);
        expect(response.headers()['content-type'], href).toMatch(/^image\//);
      }
    });
  });
}
