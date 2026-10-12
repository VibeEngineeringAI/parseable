import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

async function story(page: Page, id: string, theme = 'light') {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`/iframe.html?id=${id}&viewMode=story`);
  await expect(page.locator('#storybook-root')).not.toBeEmpty();
  await page.evaluate((value) => {
    document.documentElement.dataset.theme = value;
  }, theme);
}
async function accessible(page: Page) {
  await page.addStyleTag({
    content: '*, *::before, *::after { animation: none !important; transition: none !important; }',
  });
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
}

for (const [id, source, expectedRows] of [
  ['operations-errors--trace-issue-detail', 'trace', 8],
  ['operations-errors--log-issue-detail', 'log', 25],
] as const) {
  test(`${id} exposes accessible occurrence details and restores focus on close`, async ({
    page,
  }) => {
    await story(page, id);
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('error-occurrence-table').locator('tbody tr')).toHaveCount(
      expectedRows,
    );
    if (source === 'trace') {
      await expect(dialog.getByRole('link', { name: /Open trace/ })).toHaveCount(expectedRows);
    } else {
      await expect(dialog.getByRole('link', { name: /SQL editor/ })).toBeVisible();
      await dialog.getByRole('button', { name: 'Next page', exact: true }).click();
      await expect(dialog.getByTestId('error-occurrence-table').locator('tbody tr')).toHaveCount(6);
    }
    await accessible(page);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('.errors-issue-button:focus')).toHaveCount(1);
  });
}

const states = [
  ['agents-telemetry--default', 'Agents'],
  ['agents-telemetry--empty', 'No agent telemetry in this range'],
  ['agents-telemetry--permission-denied', 'Permission denied'],
  ['agents-telemetry--error', 'Could not load data'],
  ['agents-telemetry--loading', 'Agents'],
  ['agents-telemetry--no-datasets', 'No agent telemetry datasets found'],
  ['agents-telemetry--missing-fields', 'Could not load data'],
  ['agents-telemetry--demo', 'Agents'],
  ['settings-capabilities--llm-providers', 'LLM settings'],
  ['settings-network-access--default', 'Network access'],
  ['settings-network-access--permission-denied', 'Network access'],
  ['settings-network-access--error', 'Network access'],
  ['settings-network-access--loading', 'Network access'],
  ['settings-network-access--validation-error', 'Network access'],
  ['settings-capabilities--keystone', 'Keystone'],
  ['settings-capabilities--investigation', 'Keystone'],
  ['settings-capabilities--classic-available', 'LLM settings'],
  ['settings-capabilities--sample-workspace', 'LLM settings'],
  ['operations-cluster--healthy', 'ingestor'],
  ['operations-cluster--empty', 'No cluster nodes'],
  ['operations-cluster--unreachable', 'ingestor'],
  ['operations-cluster--missing-metric', 'ingestor'],
  ['operations-errors--unavailable', 'No eligible error dataset'],
  ['operations-errors--success', 'Errors'],
  ['operations-errors--loading', 'Errors'],
  ['operations-errors--error', 'Could not load data'],
  ['operations-errors--permission', 'Permission denied'],
  ['operations-errors--empty', 'No errors'],
  ['operations-errors--logs', 'Errors'],
  ['operations-errors--unsupported-schema', 'No eligible error dataset'],
  ['operations-errors--metadata-unavailable', 'Could not verify dataset'],
  ['onboarding-setup-guide--empty', '1. Connect your data'],
  ['onboarding-setup-guide--available-datasets', '1. Connect your data'],
  ['onboarding-setup-guide--metadata-unavailable', '1. Connect your data'],
  ['onboarding-setup-guide--demo', '1. Connect your data'],
  ['onboarding-setup-guide--new-workspace', 'Set up a workspace'],
] as const;

for (const [id, heading] of states) {
  test(`${id} renders its declared state and passes accessibility`, async ({ page }) => {
    await story(page, id);
    const title = page.getByRole('heading', { name: heading, exact: true });
    // Errors has independent summary, frequency and issue requests. Several
    // panels can correctly expose the same failure at the same time.
    await expect(id.startsWith('operations-errors--') ? title.first() : title).toBeVisible();
    if (id.endsWith('--loading') && !id.startsWith('settings-network-access'))
      await expect(
        page.getByRole('status').filter({ hasText: 'Loading data' }).first(),
      ).toContainText('Loading data');
    if (
      id === 'agents-telemetry--permission-denied' ||
      id === 'agents-telemetry--error' ||
      id === 'agents-telemetry--missing-fields'
    ) {
      await expect(page.getByRole('table')).toHaveCount(0);
    }
    if (id === 'agents-telemetry--default' || id === 'agents-telemetry--demo') {
      await expect(page.getByRole('table').getByRole('row')).toHaveCount(4);
    }
    if (id === 'operations-cluster--unreachable') {
      await expect(page.getByText('Unreachable', { exact: true })).toBeVisible();
      await expect(page.getByText('Connection refused', { exact: true })).toBeVisible();
    }
    if (id === 'operations-cluster--missing-metric') {
      await expect(page.getByText('Average CPU usage', { exact: true })).toBeVisible();
      await expect(page.getByText('Unavailable', { exact: true })).toBeVisible();
      await expect(page.getByText(/NaN/)).toHaveCount(0);
    }
    if (id === 'settings-network-access--loading') {
      await expect(page.getByRole('status')).toHaveText('Loading network policy…');
      await expect(page.getByRole('button', { name: 'Save policy' })).toHaveCount(0);
    }
    if (id === 'settings-network-access--permission-denied') {
      await expect(page.getByRole('alert')).toContainText('Administrator permission required');
      await expect(page.getByRole('textbox')).toHaveCount(0);
    }
    if (id === 'settings-network-access--error') {
      await expect(page.getByRole('alert')).toContainText('Could not load network policy');
      await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
    }
    await accessible(page);
  });
}

for (const [id, heading] of [
  ['agents-telemetry--default', 'Agents'],
  ['settings-capabilities--classic-available', 'LLM settings'],
  ['settings-network-access--default', 'Network access'],
  ['operations-cluster--healthy', 'ingestor'],
  ['operations-errors--success', 'Errors'],
  ['onboarding-setup-guide--available-datasets', '1. Connect your data'],
] as const) {
  test(`${id} supports a narrow dark viewport`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await story(page, id, 'dark');
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    await accessible(page);
  });
}

test('agent record search, keyboard inspection and focus restoration work', async ({ page }) => {
  await story(page, 'agents-telemetry--default');
  const table = page.getByRole('table');
  await expect(table.getByRole('row')).toHaveCount(4);
  const search = page.getByRole('textbox', { name: 'Search agent telemetry' });
  await search.fill('Research assistant');
  await expect(table.getByRole('row')).toHaveCount(2);
  const inspect = page.getByRole('button', { name: 'Inspect telemetry record 1' });
  await inspect.focus();
  await inspect.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Agent telemetry record' });
  await expect(dialog).toContainText('Research assistant');
  await expect(dialog.getByRole('link', { name: 'Open trace' })).toHaveAttribute(
    'href',
    /\/traces\/explore\/agent_telemetry\?.*traceId=/,
  );
  await accessible(page);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(inspect).toBeFocused();
  await search.fill('unmatched-search');
  await expect(page.getByRole('heading', { name: 'No matching telemetry' })).toBeVisible();
  await search.clear();
  await expect(table.getByRole('row')).toHaveCount(4);
});

test('failed agent queries remain honest after retry', async ({ page }) => {
  await story(page, 'agents-telemetry--error');
  await expect(page.getByRole('alert')).toContainText('Query node unavailable');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('alert')).toContainText('Query node unavailable');
  await expect(page.getByRole('table')).toHaveCount(0);
});

test('settings classic links preserve feature destinations and demo never links live mutations', async ({
  page,
}) => {
  await story(page, 'settings-capabilities--investigation');
  const open = page.getByRole('link', { name: 'Open investigation in classic UI' });
  await expect(open).toHaveAttribute('href', '/keystone/investigation-123');
  await open.focus();
  await expect(open).toBeFocused();
  await expect(
    page.getByText(/Its existence and your access have not been verified/),
  ).toBeVisible();
  await story(page, 'settings-capabilities--classic-available');
  await expect(page.getByRole('link', { name: 'Open LLM settings in classic UI' })).toHaveAttribute(
    'href',
    '/settings/llm-key',
  );
  await expect(page.locator('input')).toHaveCount(0);
  await story(page, 'settings-capabilities--sample-workspace');
  await expect(page.getByRole('status')).toContainText('not simulated');
  await expect(page.getByRole('link', { name: /in classic UI/ })).toHaveCount(0);
});

test('setup directs each telemetry type to its explorer and does not link inaccessible metadata', async ({
  page,
}) => {
  await story(page, 'onboarding-setup-guide--available-datasets');
  await expect(page.getByRole('link', { name: 'app_logs logs' })).toHaveAttribute(
    'href',
    '/logs/explore/app_logs',
  );
  await expect(page.getByRole('link', { name: 'otel_metrics metrics' })).toHaveAttribute(
    'href',
    '/metrics/explore/otel_metrics',
  );
  await expect(page.getByRole('link', { name: 'otel_traces traces' })).toHaveAttribute(
    'href',
    '/traces/explore/otel_traces',
  );
  await expect(page.getByRole('link', { name: 'Set up ingestion' })).toHaveAttribute(
    'href',
    '/add-data',
  );
  await story(page, 'onboarding-setup-guide--metadata-unavailable');
  await expect(page.getByText(/restricted_dataset/)).toContainText('Permission denied');
  await expect(page.getByRole('link', { name: /restricted_dataset/ })).toHaveCount(0);
});

test('error fallback opens logs for the requested dataset', async ({ page }) => {
  await story(page, 'operations-errors--unavailable');
  const logs = page.getByRole('link', { name: 'Explore logs' });
  await expect(logs).toHaveAttribute('href', '/logs/explore/orders_traces');
  await logs.focus();
  await expect(logs).toBeFocused();
});

test('error span sorting and range changes issue the matching transport requests', async ({
  page,
}) => {
  await story(page, 'operations-errors--success');
  await expect(page.getByRole('table')).toBeVisible();
  const requests = async () =>
    JSON.parse((await page.getByTestId('error-list-requests').textContent()) ?? '[]') as Array<{
      options: string;
      sortBy: string;
      offset: number;
      startTime: string;
      endTime: string;
    }>;
  await expect.poll(async () => (await requests()).at(-1)?.options).toBe('errorSpans');
  await page.getByRole('button', { name: 'Sort Duration' }).click();
  await expect.poll(async () => (await requests()).at(-1)?.sortBy).toBe('longestFirst');
  await page.getByRole('combobox', { name: 'Time range', exact: true }).selectOption('15m');
  await expect
    .poll(async () => {
      const last = (await requests()).at(-1);
      return last && Date.parse(last.endTime) - Date.parse(last.startTime);
    })
    .toBe(15 * 60 * 1000);
  expect((await requests()).at(-1)?.offset).toBe(0);
  expect((await requests()).at(-1)?.sortBy).toBe('mostRecent');
  await accessible(page);
});

test('outbound network policy saves normalized local changes and discards a later draft', async ({
  page,
}) => {
  await story(page, 'settings-network-access--default');
  const domains = page.getByRole('textbox', { name: 'Allowed domains', exact: true });
  await expect(domains).toBeVisible();
  const original = await domains.inputValue();
  const save = page.getByRole('button', { name: 'Save policy' });
  const discard = page.getByRole('button', { name: 'Discard changes' });
  await expect(save).toBeDisabled();
  await domains.fill('alerts.example.com\n\nstatus.example.com\n');
  await page.getByRole('checkbox', { name: 'Allow private destinations', exact: true }).check();
  await expect(save).toBeEnabled();
  await save.click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Local sample policy saved.' }),
  ).toBeVisible();
  await expect(domains).toHaveValue('alerts.example.com\nstatus.example.com');
  await expect(save).toBeDisabled();
  await expect(discard).toBeDisabled();
  await domains.fill('changed.example.com');
  await discard.click();
  await expect(domains).toHaveValue('alerts.example.com\nstatus.example.com');
  await expect(save).toBeDisabled();
  await expect(
    page.getByRole('checkbox', { name: 'Allow private destinations', exact: true }),
  ).toBeChecked();
  expect(original).not.toBe('alerts.example.com\nstatus.example.com');
  await accessible(page);
});

test('failed policy save retains editable draft and discard restores server state', async ({
  page,
}) => {
  await story(page, 'settings-network-access--validation-error');
  const cidrs = page.getByRole('textbox', { name: 'Allowed CIDRs', exact: true });
  await expect(cidrs).toBeVisible();
  const saved = await cidrs.inputValue();
  await cidrs.fill('10.0.0.0/8');
  await page.getByRole('button', { name: 'Save policy' }).click();
  await expect(page.getByRole('alert')).toContainText('Could not save network policy');
  await expect(page.getByRole('alert')).toContainText('allow and deny CIDR lists conflict');
  await expect(cidrs).toHaveValue('10.0.0.0/8');
  await expect(cidrs).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Save policy' })).toBeEnabled();
  await expect(page.getByText('Network policy saved.', { exact: true })).toHaveCount(0);
  await accessible(page);
  await page.getByRole('button', { name: 'Discard changes' }).click();
  await expect(cidrs).toHaveValue(saved);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save policy' })).toBeDisabled();
});

test('network policy load retry preserves the service failure', async ({ page }) => {
  await story(page, 'settings-network-access--error');
  await expect(page.getByRole('alert')).toContainText('Service unavailable');
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByRole('alert')).toContainText('Service unavailable');
  await expect(page.getByRole('textbox')).toHaveCount(0);
});

test('invalid policy domain identifies and focuses the field without saving', async ({ page }) => {
  await story(page, 'settings-network-access--default');
  const domains = page.getByRole('textbox', { name: 'Allowed domains', exact: true });
  await expect(domains).toBeVisible();
  await domains.fill('https://alerts.example.com/path');
  await page.getByRole('button', { name: 'Save policy' }).click();
  await expect(domains).toHaveAttribute('aria-invalid', 'true');
  await expect(domains).toBeFocused();
  await expect(page.getByText(/Invalid domain: https:\/\/alerts.example.com\/path/)).toBeVisible();
  await expect(page.getByText('Local sample policy saved.', { exact: true })).toHaveCount(0);
  await accessible(page);
  await page.getByRole('button', { name: 'Discard changes' }).click();
  await expect(domains).not.toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByRole('button', { name: 'Save policy' })).toBeDisabled();
});
