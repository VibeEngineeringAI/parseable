import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    sessionStorage.setItem('parseable-mode', 'demo');
    // HTTP LAN/tailnet deployments have getRandomValues but no randomUUID.
    Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: undefined });
  });
  await page.goto('/metrics');
  await expect(page.getByRole('textbox', { name: 'PromQL query A', exact: true })).toBeVisible();
});

test('guided operations compile dotted selectors and preserve unsupported raw expressions', async ({
  page,
}) => {
  const query = page.getByRole('textbox', { name: 'PromQL query A', exact: true });
  await query.fill('{"http.server.requests"}');
  await page.getByRole('button', { name: 'Guided builder', exact: true }).click();
  await page.getByRole('button', { name: 'Add range function', exact: true }).click();
  await page.getByRole('button', { name: 'Add aggregation', exact: true }).click();
  await page.getByLabel('PromQL query A grouping 2', { exact: true }).selectOption('by');
  await page.getByLabel('PromQL query A grouping labels 2').fill('service.name, host');
  await expect(query).toHaveText(
    'sum by ("service.name", host) (rate({"http.server.requests"}[5m]))',
  );
  await page.getByRole('button', { name: 'Raw PromQL', exact: true }).click();
  const raw = 'histogram_quantile(0.95, rate(unknown[5m])) + 1 # preserve';
  await query.fill(raw);
  await expect(page.getByRole('button', { name: 'Guided builder', exact: true })).toBeDisabled();
  await expect(query).toHaveText(raw);
});

test('invalid guided fields block Run and switching mode does not rewrite raw text', async ({
  page,
}) => {
  const query = page.getByRole('textbox', { name: 'PromQL query A', exact: true });
  const raw = ' sum( {"system.cpu.load_average.1m"} ) ';
  await query.fill(raw);
  await page.getByRole('button', { name: 'Guided builder', exact: true }).click();
  await page.getByRole('button', { name: 'Add matcher', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Raw PromQL', exact: true }).click();
  await expect(query).toHaveText(raw);
  await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeEnabled();
});

test('selected executed query creates alert and local library while later edits remain drafts', async ({
  page,
}) => {
  const query = page.getByRole('textbox', { name: 'PromQL query A', exact: true });
  await query.fill('{"system.cpu.load_average.1m"}');
  await page.getByLabel('Query A alias', { exact: true }).fill('CPU');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Create alert', exact: true })).toBeEnabled();
  await page
    .getByRole('textbox', { name: 'PromQL query CPU', exact: true })
    .fill('unexecuted_query');
  await page
    .getByRole('textbox', { name: 'Saved metric query name', exact: true })
    .fill('CPU local');
  await page.getByRole('button', { name: 'Save query', exact: true }).click();
  await page.getByText('Saved metrics queries (1)', { exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'CPU local · demo_metrics', exact: true }),
  ).toBeVisible();
  const records = await page.evaluate(() =>
    Object.keys(localStorage)
      .filter((key) => key.includes(':library'))
      .map((key) => JSON.parse(localStorage.getItem(key)!)),
  );
  expect(records.flat()[0].query).toBe('{"system.cpu.load_average.1m"}');
  await page.getByRole('button', { name: 'Create alert', exact: true }).click();
  await expect(page).toHaveURL(/\/alerts\/new\?/);
  expect(new URL(page.url()).searchParams.get('alertQuery')).toBe('{"system.cpu.load_average.1m"}');
});

test('removing a query preserves later aliases and stable identities across reload', async ({
  page,
}) => {
  await page
    .getByRole('textbox', { name: 'PromQL query A', exact: true })
    .fill('{"system.cpu.load_average.1m"}');
  await page.getByRole('button', { name: 'Add query', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'PromQL query B', exact: true })
    .fill('{"http.server.requests"}');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Executed query', exact: true })).toBeVisible();
  const before = new URL(page.url()).searchParams.getAll('qid');
  await page.getByRole('button', { name: 'Remove query A', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'PromQL query B', exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.getAll('qid')).toEqual([before[1]]);
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'PromQL query B', exact: true })).toBeVisible();
});

test('HTTP-safe IDs support initial metrics rendering and saving executed queries', async ({
  page,
}) => {
  expect(await page.evaluate(() => typeof crypto.randomUUID)).toBe('undefined');
  await page
    .getByRole('textbox', { name: 'PromQL query A', exact: true })
    .fill('{"system.cpu.load_average.1m"}');
  expect(new URL(page.url()).searchParams.get('qid')).toMatch(/^[a-f0-9]{32}$/);
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Saved metric query name', exact: true })
    .fill('HTTP CPU');
  await page.getByRole('button', { name: 'Save query', exact: true }).click();
  await page.getByText('Saved metrics queries (1)', { exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'HTTP CPU · demo_metrics', exact: true }),
  ).toBeVisible();
  const saved = await page.evaluate(() =>
    Object.keys(localStorage)
      .filter((key) => key.includes(':library'))
      .flatMap((key) => JSON.parse(localStorage.getItem(key)!)),
  );
  expect(saved[0].id).toMatch(/^[a-f0-9]{32}$/);
});

test('removing an unexecuted row after loading a saved draft preserves both executed queries', async ({
  page,
}) => {
  await page
    .getByRole('textbox', { name: 'PromQL query A', exact: true })
    .fill('{"system.cpu.load_average.1m"}');
  await page.getByRole('button', { name: 'Add query', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'PromQL query B', exact: true })
    .fill('{"http.server.requests"}');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  const executed = page.getByRole('combobox', { name: 'Executed query', exact: true });
  const ids = new URL(page.url()).searchParams.getAll('qid');
  await executed.selectOption(ids[0]);
  await page
    .getByRole('textbox', { name: 'Saved metric query name', exact: true })
    .fill('Saved CPU');
  await page.getByRole('button', { name: 'Save query', exact: true }).click();
  await page.getByText('Saved metrics queries (1)', { exact: true }).click();
  await page.getByRole('button', { name: 'Saved CPU · demo_metrics', exact: true }).click();
  await expect(
    page.getByRole('textbox', { name: 'PromQL query Saved CPU', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Add query', exact: true }).click();
  await page.getByRole('button', { name: 'Remove query A', exact: true }).click();
  await expect(executed.getByRole('option')).toHaveCount(3);
  await expect(executed.getByRole('option').nth(1)).toHaveAttribute('value', ids[0]);
  await expect(executed.getByRole('option').nth(2)).toHaveAttribute('value', ids[1]);
});

test('dashboard handoff saves executed expression and step despite later draft edits', async ({
  page,
}) => {
  await page
    .getByRole('textbox', { name: 'PromQL query A', exact: true })
    .fill('{"system.cpu.load_average.1m"}');
  await page.getByRole('textbox', { name: 'Step', exact: true }).fill('30s');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Add to Dashboard', exact: true })).toBeEnabled();
  await page.getByRole('textbox', { name: 'PromQL query A', exact: true }).fill('unexecuted');
  await page.getByRole('textbox', { name: 'Step', exact: true }).fill('1m');
  await page.getByRole('button', { name: 'Add to Dashboard', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add to Dashboard', exact: true });
  await dialog.getByLabel('Dashboard title', { exact: true }).fill('Metric investigation');
  await expect(dialog).toContainText('Saved step: 30s.');
  await dialog.getByRole('button', { name: 'Add query', exact: true }).click();
  await page.getByRole('link', { name: 'Metric investigation', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Metric investigation', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('region', { name: 'Tile A', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Dashboard actions', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: 'Export JSON', exact: true }).click();
  const output = test.info().outputPath('executed-metric-dashboard.json');
  await (await download).saveAs(output);
  const exported = JSON.parse(await readFile(output, 'utf8'));
  expect(exported.tiles).toHaveLength(1);
  expect(exported.tiles[0]).toMatchObject({
    tileType: 'promql',
    dbName: ['demo_metrics'],
    chartQuery: ['{"system.cpu.load_average.1m"}'],
    promqlStep: '30s',
    promqlQueryType: ['range'],
  });
});

test('keyboard chart zoom applies explicit bounds and Reset restores the selected preset', async ({
  page,
}) => {
  await page
    .getByRole('textbox', { name: 'PromQL query A', exact: true })
    .fill('{"system.cpu.load_average.1m"}');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  const plot = page.locator('.metrics-results .charts-plot');
  await expect(plot).toHaveAttribute('data-zoom-enabled', 'true');
  await plot.focus();
  await plot.press('ArrowRight');
  await plot.press('Shift+ArrowRight');
  await plot.press('Shift+ArrowRight');
  await plot.press('Enter');
  await expect(page.getByRole('button', { name: 'Reset zoom', exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get('start')).toBeTruthy();
  await page.getByRole('button', { name: 'Reset zoom', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('range')).toBe('1h');
  await expect(page.getByRole('button', { name: 'Reset zoom', exact: true })).toHaveCount(0);
});
