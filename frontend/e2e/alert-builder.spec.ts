import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { alertFixture } from '../src/lib/__fixtures__/alerts';
import type { Alert } from '../src/lib/types';
async function demo(page: Page, path = '/alerts/new') {
  await page.addInitScript(() => sessionStorage.setItem('parseable-mode', 'demo'));
  await page.goto(path);
}

test('SQL guided create, preview, save and reopen preserve typed filters and grouping', async ({
  page,
}) => {
  await demo(page);
  await page.getByLabel('Alert type', { exact: true }).selectOption('builder');
  await page.getByLabel('Dataset', { exact: true }).selectOption('application_logs');
  await page.getByRole('button', { name: 'Add filters condition', exact: true }).click();
  await page.getByLabel('Filters field 1', { exact: true }).selectOption('level');
  await page.getByLabel('Filters value 1', { exact: true }).fill('ERROR');
  await page
    .getByRole('group', { name: 'Group by (up to 3 fields)', exact: true })
    .getByLabel('service', { exact: true })
    .check();
  await page.getByLabel('Title', { exact: true }).fill('Guided error count');
  await page.getByRole('button', { name: 'Preview SQL (no notifications)', exact: true }).click();
  await expect(page.locator('[aria-label="Generated SQL"]')).toContainText(
    'COUNT(*) AS "alert_value"',
  );
  await expect(page.locator('[aria-label="Generated SQL"]')).toContainText('GROUP BY "service"');
  await expect(page.getByText('Server evaluation preview.', { exact: false })).toBeVisible();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addStyleTag({
    content: '*,*::before,*::after{animation:none!important;transition:none!important}',
  });
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  await page.getByRole('button', { name: 'Create alert', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Guided error count', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Saved execution owner; saving binds the editor', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.getByLabel('Alert type', { exact: true })).toHaveValue('builder');
  await expect(page.getByLabel('Filters field 1', { exact: true })).toHaveValue('level');
  await expect(page.getByLabel('Filters value 1', { exact: true })).toHaveValue('ERROR');
  await page.getByLabel('Threshold value', { exact: true }).fill('999');
  await page.getByRole('button', { name: 'Save alert', exact: true }).click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.getByLabel('Threshold value', { exact: true })).toHaveValue('999');
});

test('legacy builder conversion and duplication preserve raw SQL and server execution', async ({
  page,
}) => {
  await demo(page, '/alerts/01M4H000000000000000000012');
  await page.getByRole('button', { name: 'Inspect / convert', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Builder alerts are read-only', exact: true }),
  ).toBeVisible();
  const original = await page.locator('.alerts-query').first().textContent();
  page.once('dialog', (dialog) => {
    expect(dialog.message()).toContain('keeps server execution');
    void dialog.accept();
  });
  await page.getByRole('button', { name: 'Convert to SQL', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'SQL query', exact: true })).toHaveText(original!);
  await page.getByRole('button', { name: 'Save alert', exact: true }).click();
  await expect(page.getByText('Server (legacy or raw SQL rule)', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Duplicate', exact: true }).click();
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue(
    'Checkout errors (builder) (Copy)',
  );
  await expect(page.getByRole('textbox', { name: 'SQL query', exact: true })).toHaveText(original!);
});

async function mocked(
  page: Page,
  options: { enabled?: boolean; original?: Alert; conflict?: boolean; holdPreview?: boolean } = {},
) {
  await page.addInitScript(() => sessionStorage.setItem('parseable-mode', 'live'));
  let current: Alert = options.original ?? {
    ...alertFixture,
    queryType: 'code',
    query: 'SELECT COUNT(*) AS total FROM "logs"',
    datasets: ['logs'],
    promqlConfig: undefined,
    promqlRuntime: undefined,
    executionMode: 'server',
  };
  const writes: unknown[] = [];
  let release: (() => void) | undefined;
  let previewStarted = false;
  await page.route('**/api/**', async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname;
    if (path === '/api/v1/about')
      return route.fulfill({
        json: {
          capabilities: options.enabled === false ? {} : { alertBuilder: true, alertPreview: true },
        },
      });
    if (path === '/api/v1/logstream') return route.fulfill({ json: [{ name: 'logs' }] });
    if (path.endsWith('/info'))
      return route.fulfill({ json: { logSource: [{ log_source_format: 'json' }] } });
    if (path.endsWith('/schema'))
      return route.fulfill({
        json: {
          fields: [
            { name: 'service', data_type: 'Utf8', nullable: true },
            { name: 'value', data_type: 'Int64', nullable: true },
          ],
        },
      });
    if (path === '/api/v1/targets') return route.fulfill({ json: [] });
    if (path === '/api/v1/alerts/list_tags') return route.fulfill({ json: [] });
    if (path === '/api/v1/alerts/preview') {
      previewStarted = true;
      const body = req.postDataJSON();
      if (options.holdPreview)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return route.fulfill({
        json: {
          queryType: body.queryType,
          compiledQuery: 'SELECT COUNT(*) AS "alert_value" FROM "logs"',
          builderConfig: body.builderConfig,
          datasets: ['logs'],
          measure: 'alert_value',
          dimensions: [],
          window: { start: '2026-10-12T12:00:00Z', end: '2026-10-12T12:10:00Z' },
          threshold: body.thresholdConfig,
          simple: true,
          noData: false,
          wouldTrigger: true,
          groups: [{ labels: {}, value: 8, breached: true }],
          totalGroups: 1,
          breachedGroups: 1,
          truncated: false,
        },
      });
    }
    if (path === '/api/v1/query') return route.fulfill({ json: [{ total: 8 }] });
    if (path === '/api/v1/alerts' && req.method() === 'POST') {
      writes.push(req.postDataJSON());
      if (options.conflict)
        return route.fulfill({
          status: 409,
          body: 'BuilderConflict: query does not match builderConfig',
        });
      current = { ...current, ...req.postDataJSON() };
      return route.fulfill({ json: current });
    }
    if (path === `/api/v1/alerts/${current.id}`) return route.fulfill({ json: current });
    return route.fulfill({ status: 404, body: 'Not found' });
  });
  return { writes, started: () => previewStarted, release: () => release?.() };
}

test('unknown builder specifications remain inspectable and duplicate as SQL', async ({ page }) => {
  const original = {
    ...alertFixture,
    queryType: 'builder' as const,
    builderConfig: { kind: 'sql', version: 99, unknown: 'preserve' },
    builderStatus: 'unsupported' as const,
    executionMode: 'owner' as const,
  };
  await mocked(page, { original });
  await page.goto(`/alerts/${original.id}/edit`);
  await expect(page.locator('.alerts-query').nth(1)).toContainText('"version": 99');
  await page.getByRole('button', { name: 'Duplicate as SQL', exact: true }).click();
  await expect(page.getByLabel('Alert type', { exact: true })).toHaveValue('code');
  await expect(page.getByRole('textbox', { name: 'SQL query', exact: true })).toHaveText(
    original.query,
  );
});

test('absent capabilities keep SQL editor and label query-only preview', async ({ page }) => {
  await mocked(page, { enabled: false });
  await page.goto('/alerts/new');
  await expect(
    page.getByLabel('Alert type', { exact: true }).locator('option[value=builder]'),
  ).toHaveCount(0);
  await page.getByLabel('Dataset', { exact: true }).selectOption('logs');
  await page
    .getByRole('textbox', { name: 'SQL query', exact: true })
    .fill('SELECT COUNT(*) AS total FROM "logs"');
  await page.getByRole('button', { name: 'Preview SQL (no notifications)', exact: true }).click();
  await expect(
    page.getByText('Query values only — threshold not evaluated.', { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole('table', { name: 'Preview values', exact: true })).toContainText(
    'total=',
  );
  await expect(page.getByRole('columnheader', { name: 'Threshold', exact: true })).toHaveCount(0);
});

test('conflict keeps builder draft intact and changing threshold cancels stale preview', async ({
  page,
}) => {
  const api = await mocked(page, { conflict: true, holdPreview: true });
  await page.goto('/alerts/new');
  await page.getByLabel('Alert type', { exact: true }).selectOption('builder');
  await page.getByLabel('Dataset', { exact: true }).selectOption('logs');
  await page.getByLabel('Title', { exact: true }).fill('Draft remains');
  await page.getByRole('button', { name: 'Preview SQL (no notifications)', exact: true }).click();
  await expect.poll(api.started).toBe(true);
  await page.getByLabel('Threshold value', { exact: true }).fill('999');
  api.release();
  await expect(page.locator('[aria-label="Generated SQL"]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Create alert', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'BuilderConflict' })).toBeVisible();
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Draft remains');
  await expect(page.getByLabel('Threshold value', { exact: true })).toHaveValue('999');
  expect(api.writes).toHaveLength(1);
});

test('invalid PromQL guided draft blocks preview and save while last executable text is retained', async ({
  page,
}) => {
  await demo(page);
  await page.getByLabel('Dataset', { exact: true }).selectOption('demo_metrics');
  await page.getByRole('textbox', { name: 'PromQL query', exact: true }).fill('up');
  await page.getByRole('button', { name: 'Guided builder', exact: true }).click();
  await page.getByRole('button', { name: 'Add matcher', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill('Invalid guided');
  await expect(
    page.getByRole('button', { name: 'Preview current values (no notifications)', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Create alert', exact: true }).click();
  await expect(page).toHaveURL(/\/alerts\/new$/);
  await page.getByRole('button', { name: 'Raw PromQL', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'PromQL query', exact: true })).toHaveText('up');
});

test('grouped empty preview reports no groups rather than scalar zero', async ({ page }) => {
  await mocked(page);
  await page.route('**/api/v1/alerts/preview', (route) =>
    route.fulfill({
      json: {
        queryType: 'builder',
        compiledQuery: 'SELECT "service", COUNT(*) AS "alert_value" FROM "logs" GROUP BY "service"',
        datasets: ['logs'],
        measure: 'alert_value',
        dimensions: ['service'],
        window: { start: '2026-10-12T12:00:00Z', end: '2026-10-12T12:10:00Z' },
        threshold: { operator: '>', value: 0 },
        simple: false,
        noData: true,
        wouldTrigger: false,
        groups: [],
        totalGroups: 0,
        breachedGroups: 0,
        truncated: false,
      },
    }),
  );
  await page.goto('/alerts/new');
  await page.getByLabel('Alert type', { exact: true }).selectOption('builder');
  await page.getByLabel('Dataset', { exact: true }).selectOption('logs');
  await page
    .getByRole('group', { name: 'Group by (up to 3 fields)', exact: true })
    .getByLabel('service', { exact: true })
    .check();
  await page.getByRole('button', { name: 'Preview SQL (no notifications)', exact: true }).click();
  await expect(
    page.getByText('No groups returned; nothing would trigger.', { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText('the server evaluated the empty aggregate as zero', { exact: false }),
  ).toHaveCount(0);
});

test('switching from a PromQL handoff to SQL clears the old query and dataset', async ({
  page,
}) => {
  await demo(page, '/alerts/new?dataset=demo_metrics&alertQuery=up');
  await expect(page.getByRole('textbox', { name: 'PromQL query', exact: true })).toHaveText('up');
  await page.getByLabel('Alert type', { exact: true }).selectOption('code');
  await expect(page.getByRole('textbox', { name: 'SQL query', exact: true })).toHaveText('');
  await expect(page.getByLabel('Dataset', { exact: true })).toHaveValue('');
});

test('PromQL detail shows the safe display owner', async ({ page }) => {
  await demo(page, '/alerts/01M4H000000000000000000010');
  await expect(page.getByText('Execution owner', { exact: true })).toBeVisible();
  await expect(
    page.locator('.alerts-metadata').getByText('Demo user', { exact: true }),
  ).toBeVisible();
});
