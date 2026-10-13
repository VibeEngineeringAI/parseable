import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { agentDemoFields, agentDemoRows } from '../src/lib/agents';

async function serve(page: Page, options: { empty?: boolean; error?: boolean } = {}) {
  const mutations: string[] = [];
  const queries: unknown[] = [];
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (req.method() !== 'GET' && path !== '/api/v1/query') mutations.push(path);
    if (path === '/api/v1/logstream')
      return route.fulfill(
        options.error
          ? { status: 503, body: 'Discovery unavailable' }
          : { json: options.empty ? [] : [{ name: 'agent_telemetry' }] },
      );
    if (path.endsWith('/schema'))
      return route.fulfill({ json: { fields: agentDemoFields.map((name) => ({ name })) } });
    if (path.endsWith('/info'))
      return route.fulfill({
        json: { telemetryType: 'traces', logSource: [{ log_source_format: 'otel-traces' }] },
      });
    if (path === '/api/v1/query') {
      queries.push(req.postDataJSON());
      return route.fulfill({ json: agentDemoRows(Date.parse('2026-10-12T16:00:00.000Z')) });
    }
    if (path === '/api/v1/about') return route.fulfill({ json: { capabilities: {} } });
    return route.fulfill({ status: 404, body: 'No fixture' });
  });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          (window as unknown as { copied: string }).copied = value;
        },
      },
    });
  });
  return { mutations, queries };
}
const guide = (page: Page) => page.getByRole('dialog', { name: 'Set up agent telemetry' });
const copied = (page: Page) =>
  page.evaluate(() => (window as unknown as { copied: string }).copied);

test('Get started opens the shared guide and copies provider configs with explicit content choice', async ({
  page,
}) => {
  const { mutations } = await serve(page, { empty: true });
  await page.goto('/onboarding');
  await page.getByRole('link', { name: 'Set up Claude Code or Codex' }).click();
  await expect(page).toHaveURL('/agents?setup=1');
  const panel = guide(page);
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('checkbox')).not.toBeChecked();
  await panel.getByLabel('Collector base URL').fill('https://collector.example/otel/');
  await panel.getByRole('button', { name: 'Copy Claude Code settings' }).click();
  const config = JSON.parse(await copied(page));
  expect(config.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT).toBe(
    'https://collector.example/otel/v1/traces',
  );
  expect(config.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe(
    'https://collector.example/otel/v1/logs',
  );
  expect(config.env.OTEL_LOG_USER_PROMPTS).toBe('0');
  expect(config.env.OTEL_LOG_ASSISTANT_RESPONSES).toBe('0');
  await panel.getByRole('checkbox').check();
  await panel.getByRole('button', { name: 'Copy Claude Code settings' }).click();
  expect(JSON.parse(await copied(page)).env.OTEL_LOG_TOOL_CONTENT).toBe('1');
  await panel.getByRole('tab', { name: 'Codex', exact: true }).click();
  await expect(panel.getByRole('checkbox')).not.toBeChecked();
  await panel.getByRole('button', { name: 'Copy Codex settings' }).click();
  expect(await copied(page)).toContain('endpoint = "https://collector.example/otel/v1/traces"');
  expect(await copied(page)).toContain('endpoint = "https://collector.example/otel/v1/logs"');
  expect(await copied(page)).toContain('log_user_prompt = false');
  await panel.getByRole('checkbox').check();
  await panel.getByText('Copy instructions for your coding agent', { exact: true }).click();
  await panel.getByRole('button', { name: 'Copy Telemetry setup agent brief' }).click();
  expect(await copied(page)).toContain('Set up Codex telemetry');
  expect(await copied(page)).toContain('log_user_prompt = true');
  expect(await copied(page)).toContain('Requested content flags are explicitly enabled');
  expect(mutations).toEqual([]);
});

test('invalid endpoints withhold copy actions and clipboard failure leaves selectable config', async ({
  page,
}) => {
  await serve(page, { empty: true });
  await page.goto('/agents?setup=1');
  const panel = guide(page);
  await panel.getByLabel('Collector base URL').fill('https://user:secret@example.com?token=x');
  await expect(panel.getByLabel('Collector base URL')).toHaveAttribute('aria-invalid', 'true');
  await expect(panel.getByRole('button', { name: 'Copy Claude Code settings' })).toHaveCount(0);
  await panel.getByLabel('Collector base URL').fill('http://127.0.0.1:4318');
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: async () => {
          throw new Error('unavailable');
        },
      },
    });
  });
  await panel.getByRole('button', { name: 'Copy Claude Code settings' }).click();
  await expect(
    panel.getByText('Clipboard is unavailable. Select and copy the configuration below.'),
  ).toBeVisible();
  await expect(panel.getByLabel('Claude Code settings', { exact: true })).toContainText(
    'CLAUDE_CODE_ENABLE_TELEMETRY',
  );
});

test('guide preserves dataset, filters, frozen range and query count on close and reload', async ({
  page,
}) => {
  const { queries } = await serve(page);
  const params = new URLSearchParams({
    start: '2026-10-12T15:00:00.000Z',
    end: '2026-10-12T16:00:00.000Z',
    search: 'Support',
    status: 'success',
    model: 'example-model',
  });
  await page.goto(`/agents/agent_telemetry?${params}`);
  await expect(page.getByRole('button', { name: 'Inspect run Support assistant' })).toBeVisible();
  const count = queries.length;
  await page.getByRole('button', { name: 'Set up telemetry', exact: true }).click();
  await expect(guide(page)).toBeVisible();
  await guide(page).getByRole('button', { name: 'Close dialog' }).click();
  await expect(guide(page)).toHaveCount(0);
  for (const [key, value] of params) expect(new URL(page.url()).searchParams.get(key)).toBe(value);
  expect(queries.length).toBe(count);
  await expect(page.getByRole('button', { name: 'Set up telemetry', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Set up telemetry', exact: true }).click();
  await page.reload();
  await expect(guide(page)).toBeVisible();
  await page.keyboard.press('Escape');
  for (const [key, value] of params) expect(new URL(page.url()).searchParams.get(key)).toBe(value);
  await expect(page.getByRole('button', { name: 'Inspect run Support assistant' })).toBeVisible();
});

for (const state of ['empty', 'error'] as const) {
  test(`guide is available with ${state} discovery`, async ({ page }) => {
    const { mutations } = await serve(page, { [state]: true });
    await page.goto('/agents');
    await page
      .getByRole('button', {
        name: state === 'empty' ? 'Configure an agent' : 'Set up telemetry',
        exact: true,
      })
      .click();
    await expect(guide(page)).toBeVisible();
    await expect(
      guide(page).getByRole('button', { name: 'Copy Claude Code settings' }),
    ).toBeVisible();
    expect(mutations).toEqual([]);
  });
}

test('guide supports narrow screens, keyboard tabs and accessible controls', async ({ page }) => {
  await serve(page, { empty: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/agents?setup=1');
  const panel = guide(page);
  await expect(panel).toBeVisible();
  await panel.getByRole('tab', { name: 'Claude Code' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(panel.getByRole('tab', { name: 'Codex', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await panel
    .getByLabel('Collector base URL')
    .fill('https://collector.example/some/long/path/prefix');
  await panel.getByText('Mapping and validation checklist', { exact: true }).click();
  await expect(panel.getByText('Map agent and operation', { exact: false })).toBeVisible();
  expect(await panel.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).include('[role="dialog"]').analyze()).violations).toEqual(
    [],
  );
});
