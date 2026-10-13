import { expect, test, type Page } from '@playwright/test';
import { agentDemoFields, agentDemoRows } from '../src/lib/agents';

const bounds = {
  start: '2026-10-01T09:00:00.000Z',
  end: '2026-10-01T10:00:00.000Z',
};

async function mockAgents(page: Page) {
  let queries = 0;
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/logstream'))
      return route.fulfill({ json: [{ name: 'agent_telemetry' }, { name: 'other_agents' }] });
    if (path.endsWith('/schema'))
      return route.fulfill({
        json: { fields: [...agentDemoFields, 'message', 'captured'].map((name) => ({ name })) },
      });
    if (path.endsWith('/query')) {
      queries++;
      return route.fulfill({
        json: agentDemoRows(Date.parse(bounds.end)).map((row) => ({
          ...row,
          message: 'C:\\repo',
          captured: { messages: [{ content: 'Say "hello"' }] },
        })),
      });
    }
    return route.fulfill({ json: {} });
  });
  return () => queries;
}

async function openAgents(page: Page, search = '') {
  await page.goto(`/agents/agent_telemetry?${new URLSearchParams({ ...bounds, search })}`);
  await expect(page.getByRole('button', { name: 'Inspect run Support assistant' })).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.has('observe')).toBe(true);
}

test('search preserves the caret and every rapidly typed character without refetching', async ({
  page,
}) => {
  const queryCount = await mockAgents(page);
  await openAgents(page, 'Support');
  const before = queryCount();
  const input = page.getByLabel('Search agent runs');
  await input.focus();
  await input.evaluate((node: HTMLInputElement) => node.setSelectionRange(3, 3));
  await input.pressSequentially('X');
  await expect(input).toHaveValue('SupXport');
  await expect.poll(() => input.evaluate((node: HTMLInputElement) => node.selectionStart)).toBe(4);
  await input.pressSequentially('Y');
  await expect(input).toHaveValue('SupXYport');
  await input.fill('');
  await input.pressSequentially('Support', { delay: 0 });
  await expect(input).toHaveValue('Support');
  await expect.poll(() => new URL(page.url()).searchParams.get('search')).toBe('Support');
  await expect(page.getByRole('button', { name: 'Inspect run Support assistant' })).toBeVisible();
  expect(queryCount()).toBe(before);
  expect(new URL(page.url()).searchParams.get('start')).toBe(bounds.start);
  expect(new URL(page.url()).searchParams.get('end')).toBe(bounds.end);
});

test('search matches literal nested values without matching column names', async ({ page }) => {
  await mockAgents(page);
  await openAgents(page);
  const input = page.getByLabel('Search agent runs');
  for (const value of ['C:\\repo', 'say "HELLO"']) {
    await input.fill(value);
    await expect(page.getByRole('button', { name: 'Inspect run Support assistant' })).toBeVisible();
  }
  await input.fill('span_parent_span_id');
  await expect(page.getByText('No matching runs', { exact: true })).toBeVisible();
});

test('Back and Forward restore search, and dataset navigation retains the latest edit', async ({
  page,
}) => {
  const queryCount = await mockAgents(page);
  await openAgents(page, 'Support');
  const input = page.getByLabel('Search agent runs');
  await page.getByRole('button', { name: 'Inspect run Support assistant' }).click();
  await expect(page.getByRole('dialog', { name: 'Agent run details' })).toBeVisible();
  await page
    .getByRole('dialog', { name: 'Agent run details' })
    .getByRole('button', { name: 'Close dialog', exact: true })
    .click();
  // Closing navigates in a transition. Until that commits, Radix still traps
  // focus in the sheet; fill() alone can target the background input too early.
  await expect(page.getByRole('dialog', { name: 'Agent run details' })).toBeHidden();
  await expect.poll(() => new URL(page.url()).searchParams.has('run')).toBe(false);
  await input.click();
  await expect(input).toBeFocused();
  await input.fill('Research');
  await expect.poll(() => new URL(page.url()).searchParams.get('search')).toBe('Research');
  const before = queryCount();
  await page.goBack();
  await expect(input).toHaveValue('Support');
  await page.goForward();
  await expect(input).toHaveValue('Research');
  expect(queryCount()).toBe(before);
  await input.fill('Support');
  await page.getByLabel('Agents dataset').focus();
  await expect(
    page.getByLabel('Agents dataset').getByRole('option', { name: 'other_agents' }),
  ).toBeAttached();
  await page.getByLabel('Agents dataset').selectOption('other_agents');
  await expect(page).toHaveURL(/\/agents\/other_agents\?/);
  await expect(input).toHaveValue('Support');
  await expect(page.getByRole('button', { name: 'Inspect run Support assistant' })).toBeVisible();
  expect(new URL(page.url()).searchParams.get('search')).toBe('Support');
  expect(new URL(page.url()).searchParams.get('start')).toBe(bounds.start);
  expect(new URL(page.url()).searchParams.get('end')).toBe(bounds.end);
});
