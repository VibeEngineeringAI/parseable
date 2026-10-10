import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { alertFixture, alertSummaryFixture, targetFixture } from '../src/lib/__fixtures__/alerts';
import type { Alert, AlertRequest } from '../src/lib/types';

const detailPath = `/alerts/${alertFixture.id}`;
const namedRow = (page: Page, name: string) =>
  page.getByRole('row').filter({ has: page.getByText(name, { exact: true }) });
async function demo(page: Page, path = '/alerts') {
  await page.addInitScript(() => sessionStorage.setItem('parseable-mode', 'demo'));
  await page.goto(path);
  if (path.startsWith('/alerts')) await expect(page.locator('.alerts-page')).toBeVisible();
  if (path === '/alerts')
    await expect(page.getByRole('table', { name: 'Alerts', exact: true })).toBeVisible();
}
async function axe(page: Page) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  // Disable caret loops and the global 0.01ms transitions for a settled axe snapshot.
  await page.addStyleTag({
    content: '*, *::before, *::after { animation: none !important; transition: none !important; }',
  });
  await page.evaluate(async () => {
    await Promise.allSettled(document.getAnimations().map((animation) => animation.finished));
  });
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
}
async function createPromql(page: Page, title = 'Test threshold') {
  await page.getByRole('link', { name: 'New alert', exact: true }).first().click();
  await page.getByLabel('Dataset', { exact: true }).selectOption('demo_metrics');
  await page
    .getByRole('textbox', { name: 'PromQL query', exact: true })
    .fill('{__name__="system.cpu.load_average.1m"}');
  await page.getByLabel('Threshold value').fill('1');
  await page.getByLabel('Title', { exact: true }).fill(title);
  await page.getByLabel('Hold duration').fill('5m');
}
async function remove(page: Page, kind: 'alert' | 'target', name: string) {
  const dialog = page.getByRole('dialog', { name: `Delete ${kind}`, exact: true });
  await expect(dialog.locator('[data-dialog-confirm]')).toBeDisabled();
  await dialog.getByLabel('Confirmation name').fill(name);
  await dialog.locator('[data-dialog-confirm]').click();
  await expect(dialog).toBeHidden();
}
async function rowMenu(page: Page, name: string) {
  await namedRow(page, name)
    .getByRole('button', { name: `Actions for ${name}`, exact: true })
    .click();
  return page.getByRole('menu', { name: `Actions for ${name}`, exact: true });
}
async function rowAction(page: Page, name: string, action: string) {
  await (await rowMenu(page, name)).getByRole('menuitem', { name: action, exact: true }).click();
}
type Call = { path: string; method: string; body?: unknown };
async function mocked(
  page: Page,
  options: {
    enabled?: boolean;
    about?: unknown;
    denied?: string;
    count?: number;
    missingType?: boolean;
    empty?: boolean;
    failCreate?: boolean;
    original?: Alert;
  } = {},
) {
  const calls: Call[] = [],
    writes: AlertRequest[] = [];
  let current = structuredClone(options.original ?? alertFixture);
  await page.route('**/api/**', (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    const body = request.postData() ? request.postDataJSON() : undefined;
    calls.push({ path, method: request.method(), body });
    if (path === options.denied)
      return route.fulfill({
        status: 403,
        contentType: 'text/plain',
        body: 'You do not have permission to manage alerts',
      });
    if (path === '/api/v1/about')
      return route.fulfill({
        json: options.about ?? { capabilities: { promqlAlerts: options.enabled ?? true } },
      });
    if (path === '/api/v1/logstream')
      return route.fulfill({ json: [{ name: 'metrics' }, { name: 'logs' }] });
    if (path.endsWith('/info'))
      return route.fulfill({
        json: {
          logSource: [{ log_source_format: path.includes('/metrics/') ? 'otel-metrics' : 'json' }],
        },
      });
    if (path === '/api/v1/targets')
      return route.fulfill({ json: [{ target: targetFixture, enabled: true }] });
    if (path === '/api/v1/alerts/list_tags') return route.fulfill({ json: ['production'] });
    if (path === '/api/v1/alerts') {
      if (request.method() === 'POST') {
        if (options.failCreate)
          return route.fulfill({
            status: 400,
            body: 'Invalid alert query: exactly one aggregate required',
          });
        writes.push(body);
        current = {
          ...structuredClone(current),
          ...body,
          promqlRuntime: undefined,
          targets: body.targets,
        } as Alert;
        return route.fulfill({ json: current });
      }
      return route.fulfill({
        json: options.empty
          ? []
          : options.count
            ? Array.from({ length: options.count }, (_, index) => ({
                ...alertSummaryFixture,
                id: String(index),
                title: `Rule ${String(index).padStart(2, '0')}`,
                severity: 'High',
              }))
            : [{ ...alertSummaryFixture, id: current.id, title: current.title, severity: 'High' }],
      });
    }
    if (/^\/api\/v1\/alerts\/[^/]+$/.test(path)) {
      if (path.endsWith('/missing'))
        return route.fulfill({ status: 400, body: 'Alert does not exist' });
      if (options.missingType && path.endsWith('/0'))
        return route.fulfill({ status: 400, body: 'Missing alert' });
      if (request.method() === 'PUT') {
        writes.push(body);
        current = { ...current, ...body, promqlRuntime: undefined } as Alert;
      }
      return route.fulfill({ json: current });
    }
    if (path === '/api/v1/query') return route.fulfill({ json: [{ total: 8 }] });
    if (
      path === `/api/v1/alerts/${current.id}/update_notification_state` &&
      request.method() === 'PATCH'
    ) {
      current = {
        ...current,
        notificationState: body.state === 'notify' ? 'notify' : { mute: body.state },
      };
      return route.fulfill({ json: current });
    }
    return route.fulfill({ status: 404, body: 'Not found' });
  });
  await page.route('**/prometheus/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/query'))
      return route.fulfill({
        json: {
          status: 'success',
          data: {
            resultType: 'vector',
            result: [{ metric: { host: 'node-a' }, value: [1, '3.25'] }],
          },
        },
      });
    if (path.endsWith('/query_range'))
      return route.fulfill({
        json: { status: 'success', data: { resultType: 'matrix', result: [] } },
      });
    return route.fulfill({ json: { status: 'success', data: ['up'] } });
  });
  return { calls, writes };
}

test('Alerts is reachable after Metrics in Observe, with no Classic UI sidebar group', async ({
  page,
}) => {
  await demo(page, '/datasets');
  await page.getByTestId('sidebar-alerts').click();
  await expect(page).toHaveURL(/\/alerts$/);
  await expect(page.getByRole('heading', { name: 'Alerts', exact: true })).toBeVisible();
  const observe = page
    .locator('.sidebar-group')
    .filter({ has: page.getByText('Observe', { exact: true }) });
  await expect(observe.getByRole('link')).toHaveText(['Logs', 'Metrics', 'Alerts']);
  await expect(page.locator('.sidebar-group-label').filter({ hasText: 'Classic UI' })).toHaveCount(
    0,
  );
});
test('PromQL CRUD, inline target creation, preview, edit, duplicate and typed deletion', async ({
  page,
}) => {
  await demo(page);
  await createPromql(page);
  for (const [index, tag] of ['test', 'production'].entries()) {
    await page.getByRole('button', { name: 'Add tag', exact: true }).click();
    await page.getByLabel(`Tag ${index + 1}`, { exact: true }).fill(tag);
  }
  await page
    .getByRole('button', { name: 'Preview current values (no notifications)', exact: true })
    .click();
  const preview = page.getByRole('table', { name: 'Preview values' });
  await expect(preview.getByRole('row')).toHaveCount(5);
  await expect(preview).toContainText('Threshold breached');
  await expect(preview).toContainText('Within threshold');
  await page.getByRole('button', { name: 'New target', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'New target', exact: true });
  await sheet.getByLabel('Target name').fill('Inline hook');
  await sheet.getByLabel('Endpoint URL').fill('https://example.com/alerts');
  await sheet.getByRole('button', { name: 'Create target', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'Inline hook', exact: true })).toBeChecked();
  await expect(
    page.getByRole('status').filter({ hasText: 'Inline hook: Target created and selected.' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Create alert', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Test threshold', exact: true })).toBeVisible();
  await expect(page.getByText('Inline hook', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.getByLabel('Dataset', { exact: true })).toBeDisabled();
  await expect(page.getByLabel('Alert type')).toBeDisabled();
  await expect(page.getByLabel('Hold duration')).toHaveValue('5m');
  await page.getByLabel('Hold duration').fill('1h30m');
  await page.getByRole('button', { name: 'Save alert', exact: true }).click();
  await expect(page.getByText('1h30m', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Duplicate', exact: true }).click();
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Test threshold (Copy)');
  await expect(page.getByLabel('Hold duration')).toHaveValue('1h30m');
  await page.getByRole('button', { name: 'Create alert', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Test threshold (Copy)', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await remove(page, 'alert', 'Test threshold (Copy)');
  await expect(page.getByRole('heading', { name: 'Alerts', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Test threshold', exact: true }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await remove(page, 'alert', 'Test threshold');
  await expect(namedRow(page, 'Test threshold')).toHaveCount(0);
});
test('SQL create and preview use the existing editor with optional targets', async ({ page }) => {
  await demo(page);
  await page.getByRole('link', { name: 'New alert', exact: true }).click();
  await page.getByLabel('Alert type').selectOption('code');
  await page.getByLabel('Dataset', { exact: true }).selectOption('application_logs');
  await page
    .getByRole('textbox', { name: 'SQL query', exact: true })
    .fill('SELECT COUNT(*) AS errors FROM "application_logs" WHERE level = \'ERROR\'');
  await page.getByLabel('Title', { exact: true }).fill('SQL test');
  await page.getByRole('button', { name: 'Preview SQL (no notifications)', exact: true }).click();
  await expect(page.getByRole('table', { name: 'Preview values' })).toContainText('errors=');
  await expect(
    page
      .getByRole('table', { name: 'Preview values' })
      .getByRole('row')
      .nth(1)
      .getByRole('cell')
      .nth(1),
  ).toHaveText(/^[1-9]\d*(?:\.00)?$/);
  await page.getByRole('button', { name: 'Create alert', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'SQL test', exact: true })).toBeVisible();
  await expect(page.getByText('SQL', { exact: true })).toBeVisible();
  await expect(page.getByText('No targets. State tracking only.', { exact: true })).toBeVisible();
});
test('list menus evaluate, mute/unmute, disable/enable, and return focus after cancelling delete', async ({
  page,
}) => {
  await demo(page);
  const row = namedRow(page, 'High host load');
  const opener = row.getByRole('button', { name: 'Actions for High host load' });
  const status = page.locator('section[aria-label="Alerts list"] > .alerts-status');
  await expect(status).toBeAttached();
  await expect(status).toHaveText('');
  await status.evaluate((element) => element.setAttribute('data-live-region', 'existing'));
  await rowAction(page, 'High host load', 'Evaluate now');
  await expect(
    page.getByRole('status').filter({ hasText: 'High host load: Evaluation requested' }),
  ).toBeVisible();
  await expect(status).toHaveAttribute('data-live-region', 'existing');
  await expect(opener).toBeFocused();
  await rowAction(page, 'High host load', 'Mute…');
  await page
    .getByRole('dialog', { name: 'Mute notifications' })
    .getByRole('button', { name: 'Indefinitely', exact: true })
    .click();
  await expect(opener).toBeFocused();
  await expect(row.locator('.alerts-muted')).toHaveAttribute('title', 'Muted indefinitely');
  await rowAction(page, 'High host load', 'Unmute');
  await expect(row.locator('.alerts-muted')).toHaveCount(0);
  await expect(
    (await rowMenu(page, 'High host load')).getByRole('menuitem', { name: 'Mute…', exact: true }),
  ).toBeEnabled();
  await page.keyboard.press('Escape');
  await rowAction(page, 'High host load', 'Disable');
  const menu = await rowMenu(page, 'High host load');
  await expect(menu.getByRole('menuitem', { name: 'Evaluate now' })).toBeDisabled();
  await menu.getByRole('menuitem', { name: 'Enable' }).click();
  await expect(row).toContainText('Not triggered');
  await rowAction(page, 'High host load', 'Delete');
  await page.keyboard.press('Escape');
  await expect(opener).toBeFocused();
});
test('detail shows firing instances, delivery attempts, disabled banner and custom UTC mute', async ({
  page,
}) => {
  await demo(page, detailPath);
  const status = page.locator('.alerts-action-block > .alerts-status');
  await expect(status).toHaveText('');
  await status.evaluate((element) => element.setAttribute('data-live-region', 'existing'));
  await expect(page.getByRole('table', { name: 'Alert instances' })).toContainText('Firing');
  await expect(page.getByRole('table', { name: 'Alert instances' }).getByRole('row')).toHaveCount(
    3,
  );
  await expect(page.getByRole('table', { name: 'Notification deliveries' })).toContainText(
    '2 of 3',
  );
  await page.getByRole('button', { name: 'Mute', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Mute notifications' });
  await dialog.getByLabel('Mute until (UTC)').fill('2099-01-01T12:00');
  await dialog.getByRole('button', { name: 'Mute until date' }).click();
  await expect(page.locator('.alerts-metadata')).toContainText('Muted until');
  await expect(page.getByRole('button', { name: 'Unmute', exact: true })).toBeFocused();
  await expect(status).toHaveText('Notifications muted.');
  await expect(status).toHaveAttribute('data-live-region', 'existing');
  await page.getByRole('button', { name: 'Unmute', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Mute', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Disable', exact: true }).click();
  await expect(page.getByText('This alert is disabled.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enable', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Enable', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Disable', exact: true })).toBeFocused();
  await expect(page.getByRole('button', { name: 'Evaluate now', exact: true })).toBeEnabled();
});
test('builder rules are read-only with SQL and no Edit action', async ({ page }) => {
  await demo(page, '/alerts/01M4H000000000000000000012');
  await expect(
    page.getByText('Editing builder alerts is not supported yet.', { exact: false }),
  ).toBeVisible();
  await expect(page.locator('.alerts-query')).toContainText('SELECT COUNT(*)');
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Duplicate', exact: true })).toHaveCount(0);
});
test('title search, tag filtering and sorting distinguish empty searches', async ({ page }) => {
  await demo(page);
  await page.getByLabel('Search alerts').fill('HIGH HOST');
  await expect(
    page.getByRole('table', { name: 'Alerts', exact: true }).getByRole('row'),
  ).toHaveCount(2);
  await page.getByLabel('Search alerts').fill('missing');
  await expect(page.getByRole('heading', { name: 'No matching alerts' })).toBeVisible();
  await page.getByLabel('Search alerts').fill('');
  await page.getByLabel('Filter by tag').selectOption('logs');
  await expect(
    page.getByRole('table', { name: 'Alerts', exact: true }).getByRole('row'),
  ).toHaveCount(3);
  await page.getByRole('button', { name: 'Sort by title' }).click();
  await expect(page.getByRole('columnheader').first()).toHaveAttribute('aria-sort', 'descending');
});
test('target CRUD masks secrets, requires endpoint re-entry and keeps 409 in the delete dialog', async ({
  page,
}) => {
  await demo(page, '/alerts/targets');
  const status = page.locator('.alerts-page > .alerts-status');
  await expect(status).toHaveText('');
  await status.evaluate((element) => element.setAttribute('data-live-region', 'existing'));
  await page.getByRole('button', { name: 'New target', exact: true }).click();
  let sheet = page.getByRole('dialog', { name: 'New target', exact: true });
  await sheet.getByLabel('Target name').fill('Test hook');
  await sheet.getByLabel('Endpoint URL').fill('https://example.com/secret-token');
  await sheet.getByRole('button', { name: 'Add header' }).click();
  await sheet.getByLabel('Header 1 name').fill('X-Key');
  await sheet.getByLabel('Header 1 value').fill('header-secret');
  await sheet.getByRole('button', { name: 'Create target', exact: true }).click();
  const row = namedRow(page, 'Test hook');
  await expect(
    page.getByRole('status').filter({ hasText: 'Test hook: Target created.' }),
  ).toBeVisible();
  await expect(status).toHaveAttribute('data-live-region', 'existing');
  await expect(row).toContainText('https://********');
  await expect(row).not.toContainText('secret-token');
  await rowAction(page, 'Test hook', 'Edit');
  sheet = page.getByRole('dialog', { name: 'Edit target', exact: true });
  await expect(sheet.getByLabel('Endpoint URL')).toHaveValue('');
  await expect(sheet.getByLabel('Header 1 value')).toHaveValue('');
  await expect(sheet.getByLabel('Target name')).toHaveAttribute('readonly', '');
  await expect(
    sheet.getByText('Endpoints are masked by the server.', { exact: false }),
  ).toBeVisible();
  // The masked endpoint must be re-entered: saving without it explains why instead of sending.
  await expect(sheet.getByLabel('Endpoint URL')).not.toHaveAttribute('aria-invalid', 'true');
  await sheet.getByRole('button', { name: 'Save target' }).click();
  await expect(sheet.getByLabel('Endpoint URL')).toHaveAttribute('aria-invalid', 'true');
  await expect(sheet.getByLabel('Endpoint URL')).toBeFocused();
  await sheet.getByLabel('Endpoint URL').fill('https://example.com/new');
  await sheet.getByLabel('Header 1 value').fill('new-secret');
  await sheet.getByRole('button', { name: 'Save target' }).click();
  await expect(row.getByRole('button', { name: 'Actions for Test hook' })).toBeFocused();
  await rowAction(page, 'Test hook', 'Delete');
  await remove(page, 'target', 'Test hook');
  await expect(row).toHaveCount(0);
  await expect(
    namedRow(page, 'Operations Slack').getByRole('button', {
      name: 'Actions for Operations Slack',
    }),
  ).toBeFocused();
  await rowAction(page, 'Operations Slack', 'Delete');
  const dialog = page.getByRole('dialog', { name: 'Delete target' });
  await dialog.getByLabel('Confirmation name').fill('Operations Slack');
  await dialog.locator('[data-dialog-confirm]').click();
  await expect(dialog.getByRole('alert')).toContainText(
    "Can't delete a Target which is being used",
  );
  await page.keyboard.press('Escape');
  await page.getByLabel('Search targets').fill('missing');
  await expect(page.getByRole('heading', { name: 'No matching targets' })).toBeVisible();
});
test('Slack and Alertmanager targets retain their distinct fields', async ({ page }) => {
  await demo(page, '/alerts/targets');
  for (const kind of ['slack', 'alertManager']) {
    await page.getByRole('button', { name: 'New target', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: 'New target', exact: true });
    await sheet.getByLabel('Target type').selectOption(kind);
    await sheet.getByLabel('Target name').fill(`Test ${kind}`);
    await sheet
      .getByLabel('Endpoint URL')
      .fill(
        kind === 'slack'
          ? 'https://hooks.slack.com/services/test'
          : 'https://example.com/api/v2/alerts',
      );
    if (kind === 'alertManager') {
      await sheet.getByLabel('Username', { exact: true }).fill('svc');
      await sheet.getByLabel('Password', { exact: true }).fill('secret');
    }
    await sheet.getByRole('button', { name: 'Create target', exact: true }).click();
    await expect(namedRow(page, `Test ${kind}`)).toContainText(
      kind === 'slack' ? 'Slack' : 'Alertmanager',
    );
  }
});
test('validation errors describe their controls and block invalid thresholds, frequency and hold', async ({
  page,
}) => {
  await demo(page);
  await createPromql(page);
  await page.getByLabel('Threshold value').fill('');
  await page.getByLabel('Threshold value').blur();
  await expect(page.getByLabel('Threshold value')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByLabel('Threshold value')).toHaveAccessibleDescription(
    'Enter a finite threshold value.',
  );
  // An invalid value in a field the user is still editing stays quiet until it loses focus.
  await page.getByLabel('Evaluation frequency (minutes)').fill('1441');
  await expect(page.getByLabel('Evaluation frequency (minutes)')).not.toHaveAttribute(
    'aria-invalid',
    'true',
  );
  await page.getByLabel('Evaluation frequency (minutes)').blur();
  await expect(page.getByLabel('Evaluation frequency (minutes)')).toHaveAccessibleDescription(
    'Use 1–1440 whole minutes.',
  );
  await page.getByLabel('Hold duration').fill('31d');
  await page.getByLabel('Hold duration').blur();
  await expect(page.getByLabel('Hold duration')).toHaveAccessibleDescription(
    'Hold duration cannot exceed 30 days.',
  );
  const query = page.getByRole('textbox', { name: 'PromQL query', exact: true });
  await query.fill('up[5m]');
  await expect(query).toHaveAttribute('aria-invalid', 'true');
  await expect(query).toHaveAccessibleDescription(
    'Alerts require an instant vector of numeric samples.',
  );
  // Create stays available: submitting an invalid form focuses the first invalid field.
  await page.getByRole('button', { name: 'Create alert', exact: true }).click();
  await expect(page).toHaveURL(/\/alerts\/new$/);
  await expect(query).toBeFocused();
});
test('saving with a deleted target focuses that target and sends nothing', async ({ page }) => {
  const api = await mocked(page, { original: { ...alertFixture, targets: ['deleted'] } });
  await page.goto(`${detailPath}/edit`);
  const deleted = page.getByRole('checkbox', { name: 'Unavailable target deleted', exact: true });
  const message = 'Remove unavailable targets or select existing targets.';
  await expect(deleted).toHaveAttribute('aria-invalid', 'true');
  await expect(deleted).toHaveAccessibleDescription(message);
  await expect(page.getByRole('checkbox', { name: 'Operations' })).not.toHaveAttribute(
    'aria-invalid',
    'true',
  );
  await page.getByRole('button', { name: 'Save alert', exact: true }).click();
  await expect(deleted).toBeFocused();
  await expect(page).toHaveURL(/\/edit$/);
  expect(api.writes).toHaveLength(0);
  await deleted.click();
  await expect(deleted).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: 'Operations' })).not.toHaveAttribute(
    'aria-invalid',
    'true',
  );
  await page.getByRole('button', { name: 'Save alert', exact: true }).click();
  await expect(page.getByRole('heading', { name: alertFixture.title, exact: true })).toBeVisible();
  expect(api.writes).toHaveLength(1);
  expect(api.writes[0]).toMatchObject({ targets: [] });
});
test('a submit attempt skips the disabled invalid Alert type and focuses the stored query', async ({
  page,
}) => {
  const api = await mocked(page, {
    enabled: false,
    original: { ...alertFixture, query: 'sum by (host.name) (up)' },
  });
  await page.goto(`${detailPath}/edit`);
  const type = page.getByLabel('Alert type');
  const query = page.getByRole('textbox', { name: 'PromQL query', exact: true });
  await expect(type).toBeDisabled();
  await expect(type).toHaveAttribute('aria-invalid', 'true');
  // The stored query is not typed here, so its error shows on load.
  await expect(query).toHaveAccessibleDescription('Enter a valid PromQL expression.');
  await page.getByRole('button', { name: 'Save alert', exact: true }).click();
  await expect(query).toBeFocused();
  expect(api.writes).toHaveLength(0);
});
test('dirty form blocks sidebar navigation and browser Back until confirmed', async ({ page }) => {
  await demo(page);
  await createPromql(page);
  const dismiss = (dialog: import('@playwright/test').Dialog) => dialog.dismiss();
  page.on('dialog', dismiss);
  await page.getByTestId('sidebar-metrics').click();
  await expect(page).toHaveURL(/\/alerts\/new$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/alerts\/new$/);
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Test threshold');
  page.off('dialog', dismiss);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByTestId('sidebar-metrics').click();
  await expect(page).toHaveURL(/\/metrics/);
});
test('mocked create and update resend promqlConfig without runtime or ownership', async ({
  page,
}) => {
  const api = await mocked(page);
  await page.goto(
    '/alerts/new?dataset=metrics&queryBuilderType=promql&alertQuery=up&title=Dashboard%20handoff',
  );
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Dashboard handoff');
  await expect(page.getByRole('textbox', { name: 'PromQL query', exact: true })).toHaveText('up');
  await page.getByLabel('Hold duration').fill('7m');
  await page.getByLabel('Threshold value').fill('2.5');
  await page.getByRole('button', { name: 'Create alert', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard handoff', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill('Edited handoff');
  await page.getByRole('button', { name: 'Save alert', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Edited handoff', exact: true })).toBeVisible();
  expect(api.writes).toHaveLength(2);
  for (const body of api.writes) {
    expect(body.promqlConfig).toEqual({ holdDuration: '7m' });
    expect(body).toMatchObject({
      queryType: 'promql',
      datasets: ['metrics'],
      query: 'up',
      thresholdConfig: { operator: '>', value: 2.5 },
      evalConfig: { rollingWindow: { evalStart: '10m', evalEnd: 'now', evalFrequency: 1 } },
      notificationConfig: { interval: 1 },
      targets: [],
    });
    expect(body).not.toHaveProperty('promqlRuntime');
    expect(body).not.toHaveProperty('executionIdentity');
  }
  expect(
    api.calls.some(
      (call) => call.method === 'PUT' && call.path === `/api/v1/alerts/${alertFixture.id}`,
    ),
  ).toBe(true);
});
for (const about of [
  { capabilities: { promqlAlerts: false }, license: { plan: 'Enterprise' } },
  { license: { plan: 'Enterprise' } },
])
  test(`PromQL requires explicit capability: ${JSON.stringify(about)}`, async ({ page }) => {
    await mocked(page, { about });
    await page.goto('/alerts/new');
    await expect(page.getByLabel('Alert type')).toHaveValue('code');
    await expect(
      page.getByLabel('Alert type').getByRole('option', { name: 'PromQL threshold' }),
    ).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'SQL query', exact: true })).toBeVisible();
  });
for (const path of ['/api/v1/alerts', '/api/v1/targets'])
  test(`403 stays in live mode for ${path}`, async ({ page }) => {
    await mocked(page, { denied: path });
    await page.goto(path.endsWith('/targets') ? '/alerts/targets' : '/alerts');
    await expect(page.getByRole('heading', { name: 'Permission denied' })).toBeVisible();
    await expect(page.getByText('Live server', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Explore demo data' })).toHaveCount(0);
  });
test('empty list has a creation CTA, missing detail keeps the HTTP 400 message', async ({
  page,
}) => {
  await mocked(page, { empty: true });
  await page.goto('/alerts');
  await expect(page.getByRole('heading', { name: 'No alerts yet' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'New alert', exact: true })).toHaveCount(2);
  await page.goto('/alerts/missing');
  await expect(page.getByRole('alert')).toContainText('Alert does not exist');
});
test('25-row pagination and a failed type lookup preserve all other alerts', async ({ page }) => {
  await mocked(page, { count: 27, missingType: true });
  await page.goto('/alerts');
  const table = page.getByRole('table', { name: 'Alerts', exact: true });
  await expect(table.getByRole('row')).toHaveCount(26);
  await expect(page.getByRole('status').filter({ hasText: 'Could not resolve' })).toBeVisible();
  await expect(namedRow(page, 'Rule 00')).toContainText('Unavailable');
  await page.getByRole('button', { name: 'Next page' }).click();
  await expect(table.getByRole('row')).toHaveCount(3);
  await page.getByLabel('Search alerts').fill('Rule 00');
  await expect(table.getByRole('row')).toHaveCount(2);
});
test('save failure stays in the dirty form with the plain-text server error', async ({ page }) => {
  await mocked(page, { failCreate: true });
  await page.goto('/alerts/new?dataset=metrics&alertQuery=up&title=Failure');
  await page.getByRole('button', { name: 'Create alert', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(
    'Invalid alert query: exactly one aggregate required',
  );
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Failure');
});
test('a PromQL alert whose dataset could not be checked still previews and saves with a warning', async ({
  page,
}) => {
  const api = await mocked(page);
  await page.route('**/api/v1/logstream/metrics/info', (route) =>
    route.fulfill({ status: 500, body: 'Internal error' }),
  );
  const warning = 'This dataset could not be verified as OTLP metrics.';
  await page.goto(`${detailPath}/edit`);
  const dataset = page.getByLabel('Dataset', { exact: true });
  await expect(dataset).toHaveValue('metrics');
  await expect(
    page.getByRole('status').filter({ hasText: 'Some datasets could not be checked: metrics.' }),
  ).toBeVisible();
  await expect(page.getByText(warning)).toBeVisible();
  await expect(page.getByText('Select an OTLP metrics dataset.')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Preview current values (no notifications)', exact: true }),
  ).toBeEnabled();
  await page.getByLabel('Threshold value').fill('9');
  await page.getByRole('button', { name: 'Save alert', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${detailPath}$`));
  expect(api.writes).toHaveLength(1);
  expect(api.writes[0]).toMatchObject({ datasets: ['metrics'], thresholdConfig: { value: 9 } });

  await page.goto('/alerts/new?queryBuilderType=promql');
  await page
    .getByLabel('Dataset', { exact: true })
    .selectOption({ label: 'metrics (not verified)' });
  await expect(page.getByText(warning)).toBeVisible();
  await expect(page.getByText('Select an OTLP metrics dataset.')).toHaveCount(0);
});
for (const type of ['promql', 'code'] as const) {
  test(`${type} dataset-permission 401 keeps the session, draft and dirty guard on failed save`, async ({
    page,
  }) => {
    const query = type === 'promql' ? 'up' : 'SELECT COUNT(*) FROM "logs"';
    const source = {
      ...alertFixture,
      queryType: type,
      query,
      datasets: [type === 'promql' ? 'metrics' : 'logs'],
    };
    await mocked(page, { original: source });
    await page.context().addCookies([
      { name: 'user_id', value: 'writer', url: 'http://127.0.0.1:5173' },
      { name: 'session', value: 'valid-session', url: 'http://127.0.0.1:5173' },
    ]);
    const body =
      type === 'promql'
        ? 'ActixError: User does not have access to stream- private_metrics'
        : 'ActixError: User does not have access to stream- private_logs';
    await page.route(`**/api/v1/alerts/${alertFixture.id}`, (route) =>
      route.request().method() === 'PUT'
        ? route.fulfill({ status: 401, contentType: 'text/plain', body })
        : route.fallback(),
    );
    await page.goto(`${detailPath}/edit`);
    await page.getByLabel('Title', { exact: true }).fill('Keep this draft');
    await page.getByLabel('Threshold value').fill('9');
    await page.getByRole('button', { name: 'Save alert', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText(
      'Permission denied: User does not have access to stream-',
    );
    await expect(page).toHaveURL(new RegExp(`${detailPath}/edit$`));
    await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Keep this draft');
    await expect(page.getByLabel('Threshold value')).toHaveValue('9');
    await expect(
      page.getByRole('textbox', {
        name: type === 'promql' ? 'PromQL query' : 'SQL query',
        exact: true,
      }),
    ).toHaveText(query);
    expect(
      (await page.context().cookies()).find((cookie) => cookie.name === 'session')?.value,
    ).toBe('valid-session');
    const confirmation = page.waitForEvent('dialog');
    const leaving = page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await (await confirmation).dismiss();
    await leaving;
    await expect(page).toHaveURL(new RegExp(`${detailPath}/edit$`));
  });
  test(`${type} query is dynamically read-only during a held save and editable after failure`, async ({
    page,
  }) => {
    const api = await mocked(page, { enabled: type === 'promql' });
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    await page.route('**/api/v1/alerts', async (route) => {
      if (route.request().method() !== 'POST' || !first) return route.fallback();
      first = false;
      await held;
      await route.fulfill({ status: 400, body: 'Temporary save failure' });
    });
    const query = type === 'promql' ? 'up' : 'SELECT COUNT(*) FROM "logs"';
    const edited = type === 'promql' ? 'sum(up)' : 'SELECT SUM(total) FROM "logs"';
    await page.goto(
      `/alerts/new?dataset=${type === 'promql' ? 'metrics' : 'logs'}&alertQuery=${encodeURIComponent(query)}&title=Held`,
    );
    const editor = page.getByRole('textbox', {
      name: type === 'promql' ? 'PromQL query' : 'SQL query',
      exact: true,
    });
    const started = page.waitForRequest(
      (request) =>
        new URL(request.url()).pathname === '/api/v1/alerts' && request.method() === 'POST',
    );
    try {
      await page.getByRole('button', { name: 'Create alert', exact: true }).click();
      const submission = await started;
      expect(submission.postDataJSON().query).toBe(query);
      await expect(editor).toHaveAttribute('aria-readonly', 'true');
      await expect(editor).not.toBeEditable();
      await editor.click();
      await page.keyboard.type(' + 1');
      await expect(editor).toHaveText(query);
    } finally {
      release();
    }
    await expect(page.getByRole('alert')).toContainText('Temporary save failure');
    await expect(editor).toHaveAttribute('aria-readonly', 'false');
    await expect(editor).toBeEditable();
    await editor.fill(edited);
    await page.getByRole('button', { name: 'Create alert', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Held', exact: true })).toBeVisible();
    expect(api.writes[0].query).toBe(edited);
  });
}
test('a real Rust session-expiry 401 still clears cookies and returns a failed save to login', async ({
  page,
}) => {
  await mocked(page);
  await page
    .context()
    .addCookies([{ name: 'session', value: 'expired-session', url: 'http://127.0.0.1:5173' }]);
  await page.route('**/api/v1/alerts', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({
          status: 401,
          body: 'Your session has expired or is no longer valid. Please re-authenticate to access this resource.',
        })
      : route.fallback(),
  );
  await page.goto('/alerts/new?dataset=metrics&alertQuery=up&title=Expired');
  await page.getByRole('button', { name: 'Create alert', exact: true }).click();
  await expect(page).toHaveURL(/\/login\?/);
  await expect(page.getByRole('button', { name: 'Login', exact: true })).toBeVisible();
  expect((await page.context().cookies()).some((cookie) => cookie.name === 'session')).toBe(false);
});
test('untouched tags with commas and whitespace round-trip through edit and duplicate', async ({
  page,
}) => {
  const tags = ['team,west', ' padded ', 'multiple  spaces'];
  const api = await mocked(page, { original: { ...alertFixture, tags } });
  await page.goto(`${detailPath}/edit`);
  for (const [index, tag] of tags.entries())
    await expect(page.getByLabel(`Tag ${index + 1}`, { exact: true })).toHaveValue(tag);
  await page.getByLabel('Threshold value').fill('4');
  await page.getByRole('button', { name: 'Save alert', exact: true }).click();
  await expect(page.getByRole('heading', { name: alertFixture.title, exact: true })).toBeVisible();
  expect(api.writes[0].tags).toEqual(tags);
  await page.getByRole('button', { name: 'Duplicate', exact: true }).click();
  for (const [index, tag] of tags.entries())
    await expect(page.getByLabel(`Tag ${index + 1}`, { exact: true })).toHaveValue(tag);
  await page.getByRole('button', { name: 'Create alert', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: `${alertFixture.title} (Copy)`, exact: true }),
  ).toBeVisible();
  expect(api.writes[1].tags).toEqual(tags);
});

test('tag inputs keep their identity, focus neighbours after removal, focus additions and omit blanks on save', async ({
  page,
}) => {
  const api = await mocked(page, {
    original: { ...alertFixture, tags: ['first', 'second', 'third'] },
  });
  await page.goto(`${detailPath}/edit`);
  await page
    .getByLabel('Tag 2', { exact: true })
    .evaluate((element) => element.setAttribute('data-original', 'second'));
  await page
    .getByLabel('Tag 3', { exact: true })
    .evaluate((element) => element.setAttribute('data-original', 'third'));
  await page.getByRole('button', { name: 'Remove tag 1', exact: true }).click();
  await expect(page.getByLabel('Tag 1', { exact: true })).toBeFocused();
  await expect(page.getByLabel('Tag 1', { exact: true })).toHaveAttribute(
    'data-original',
    'second',
  );
  await expect(page.getByLabel('Tag 2', { exact: true })).toHaveAttribute('data-original', 'third');
  await page.getByRole('button', { name: 'Remove tag 2', exact: true }).click();
  await expect(page.getByLabel('Tag 1', { exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Remove tag 1', exact: true }).click();
  const add = page.getByRole('button', { name: 'Add tag', exact: true });
  await expect(add).toBeFocused();
  for (const [index, tag] of ['team,west', ' padded ', '', ' \t '].entries()) {
    await add.click();
    const input = page.getByLabel(`Tag ${index + 1}`, { exact: true });
    await expect(input).toBeFocused();
    await input.fill(tag);
  }
  await page.getByRole('button', { name: 'Save alert', exact: true }).click();
  await expect(page.getByRole('heading', { name: alertFixture.title, exact: true })).toBeVisible();
  expect(api.writes[0].tags).toEqual(['team,west', ' padded ']);
});

test('an untouched edit keeps tag inputs stable across theme changes and leaves without a dirty prompt', async ({
  page,
}) => {
  await mocked(page);
  let prompts = 0;
  page.on('dialog', async (dialog) => {
    prompts++;
    await dialog.dismiss();
  });
  await page.goto(`${detailPath}/edit`);
  const tag = page.getByLabel('Tag 1', { exact: true });
  await expect(tag).toHaveValue('production');
  await tag.evaluate((element) => element.setAttribute('data-retained', 'true'));
  await page.getByRole('button', { name: 'Use dark theme', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(tag).toHaveAttribute('data-retained', 'true');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page).toHaveURL(detailPath);
  expect(prompts).toBe(0);
});

test('header inputs focus additions, surviving neighbours and Add after the last removal', async ({
  page,
}) => {
  await demo(page, '/alerts/targets');
  await page.getByRole('button', { name: 'New target', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'New target', exact: true });
  // A pristine sheet shows no errors; blurring an empty field or submitting reveals them.
  await expect(sheet.getByLabel('Target name')).not.toHaveAttribute('aria-invalid', 'true');
  await expect(sheet.getByLabel('Target name')).not.toHaveAccessibleDescription(
    /Enter a target name/,
  );
  await expect(sheet.getByRole('alert')).toHaveCount(0);
  await sheet.getByLabel('Target name').focus();
  await sheet.getByLabel('Target name').blur();
  await expect(sheet.getByLabel('Target name')).toHaveAccessibleDescription('Enter a target name.');
  await expect(sheet.getByLabel('Endpoint URL')).not.toHaveAttribute('aria-invalid', 'true');
  await sheet.getByRole('button', { name: 'Create target', exact: true }).click();
  await expect(sheet.getByLabel('Target name')).toBeFocused();
  await expect(sheet.getByLabel('Endpoint URL')).toHaveAccessibleDescription(
    /Enter a complete HTTP or HTTPS endpoint URL\./,
  );
  const add = sheet.getByRole('button', { name: 'Add header', exact: true });
  for (let index = 1; index <= 3; index++) {
    await add.click();
    await expect(sheet.getByLabel(`Header ${index} name`, { exact: true })).toBeFocused();
    await sheet.getByLabel(`Header ${index} name`, { exact: true }).fill(`X-${index}`);
    await sheet.getByLabel(`Header ${index} value`, { exact: true }).fill(String(index));
  }
  await sheet
    .getByLabel('Header 2 name', { exact: true })
    .evaluate((element) => element.setAttribute('data-original', 'second'));
  await sheet.getByRole('button', { name: 'Remove header 1', exact: true }).click();
  await expect(sheet.getByLabel('Header 1 name', { exact: true })).toBeFocused();
  await expect(sheet.getByLabel('Header 1 name', { exact: true })).toHaveAttribute(
    'data-original',
    'second',
  );
  await sheet.getByRole('button', { name: 'Remove header 2', exact: true }).click();
  await expect(sheet.getByLabel('Header 1 name', { exact: true })).toBeFocused();
  await sheet.getByRole('button', { name: 'Remove header 1', exact: true }).click();
  await expect(add).toBeFocused();
});

test('a header error marks and focuses only the invalid header field', async ({ page }) => {
  await demo(page, '/alerts/targets');
  await page.getByRole('button', { name: 'New target', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'New target', exact: true });
  await sheet.getByLabel('Target name').fill('Hook');
  await sheet.getByLabel('Endpoint URL').fill('https://example.com/hook');
  const add = sheet.getByRole('button', { name: 'Add header', exact: true });
  await add.click();
  await sheet.getByLabel('Header 1 name', { exact: true }).fill('X-One');
  await sheet.getByLabel('Header 1 value', { exact: true }).fill('one');
  await add.click();
  await sheet.getByLabel('Header 2 name', { exact: true }).fill('X-Two');
  await sheet.getByRole('button', { name: 'Create target', exact: true }).click();
  const message = 'Each header needs a valid name and a non-empty value without line breaks.';
  await expect(sheet.getByRole('alert')).toHaveText(message);
  const value = sheet.getByLabel('Header 2 value', { exact: true });
  await expect(value).toBeFocused();
  await expect(value).toHaveAttribute('aria-invalid', 'true');
  await expect(value).toHaveAccessibleDescription(message);
  for (const label of ['Header 1 name', 'Header 1 value', 'Header 2 name']) {
    const input = sheet.getByLabel(label, { exact: true });
    await expect(input).not.toHaveAttribute('aria-invalid', 'true');
    await expect(input).not.toHaveAccessibleDescription(message);
  }
  // A duplicate name marks the repeated name, not its value or the first row.
  await value.fill('two');
  await sheet.getByLabel('Header 2 name', { exact: true }).fill('x-one');
  await expect(sheet.getByRole('alert')).toHaveText('Header names must be unique.');
  await expect(sheet.getByLabel('Header 2 name', { exact: true })).toHaveAttribute(
    'aria-invalid',
    'true',
  );
  await expect(value).not.toHaveAttribute('aria-invalid', 'true');
  await expect(sheet.getByLabel('Header 1 name', { exact: true })).not.toHaveAttribute(
    'aria-invalid',
    'true',
  );
});

test('trailing-slash alert routes reach the intended list, targets, form, detail and edit views', async ({
  page,
}) => {
  const api = await mocked(page);
  for (const [path, title] of [
    ['/alerts/', 'Alerts'],
    ['/alerts/targets/', 'Alert targets'],
    ['/alerts/new/', 'New alert'],
    [`${detailPath}/`, alertFixture.title],
    [`${detailPath}/edit/`, 'Edit alert'],
  ]) {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  }
  await expect(page.getByRole('button', { name: 'Save alert', exact: true })).toBeEnabled();
  expect(
    api.calls.some(({ path }) => ['/api/v1/alerts/targets', '/api/v1/alerts/new'].includes(path)),
  ).toBe(false);
});

for (const type of ['sql', 'code'])
  test(`${type} handoff selects SQL and saves the prefilled query`, async ({ page }) => {
    const api = await mocked(page);
    const query = 'SELECT COUNT(*) FROM "logs"';
    await page.goto(
      `/alerts/new?${new URLSearchParams({ queryBuilderType: type, dataset: 'logs', alertQuery: query, title: 'SQL handoff' })}`,
    );
    await expect(page.getByLabel('Alert type')).toHaveValue('code');
    await expect(page.getByRole('textbox', { name: 'SQL query', exact: true })).toHaveText(query);
    await page.getByRole('button', { name: 'Create alert', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'SQL handoff', exact: true })).toBeVisible();
    expect(api.writes[0]).toMatchObject({ queryType: 'code', query, datasets: ['logs'] });
  });

test('an invalid handoff shows its error on load while a blank new form stays quiet until blur or a submit attempt', async ({
  page,
}) => {
  await mocked(page);
  const query = page.getByRole('textbox', { name: 'PromQL query', exact: true });
  const create = page.getByRole('button', { name: 'Create alert', exact: true });
  await page.goto(
    `/alerts/new?${new URLSearchParams({ dataset: 'metrics', alertQuery: 'sum by (host.name) (up)', title: 'Invalid handoff' })}`,
  );
  await expect(query).toHaveAttribute('aria-invalid', 'true');
  await expect(query).toHaveAccessibleDescription('Enter a valid PromQL expression.');
  await expect(page.getByLabel('Title', { exact: true })).not.toHaveAttribute(
    'aria-invalid',
    'true',
  );
  await create.click();
  await expect(query).toBeFocused();
  await expect(query).toHaveAccessibleDescription('Enter a valid PromQL expression.');
  await expect(page.getByText('Enter a valid PromQL expression.', { exact: true })).toBeVisible();
  await page.goto('/alerts/new');
  const title = page.getByLabel('Title', { exact: true });
  const dataset = page.getByLabel('Dataset', { exact: true });
  await expect(title).toBeVisible();
  await expect(title).not.toHaveAttribute('aria-invalid', 'true');
  await expect(title).not.toHaveAccessibleDescription(/Enter an alert title/);
  await expect(query).toHaveAttribute('aria-invalid', 'false');
  await expect(query).not.toHaveAccessibleDescription('Enter a query.');
  await expect(dataset).not.toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await title.focus();
  await title.blur();
  await expect(title).toHaveAccessibleDescription('Enter an alert title.');
  await expect(dataset).not.toHaveAttribute('aria-invalid', 'true');
  await create.click();
  await expect(dataset).toBeFocused();
  await expect(dataset).toHaveAccessibleDescription(/Select a dataset\./);
  await expect(query).toHaveAccessibleDescription('Enter a query.');
});

for (const duplicate of [
  { id: 'stale', title: 'Stale' },
  { ...alertFixture, queryType: 'builder' },
])
  test(`invalid or builder duplicate history is ignored safely: ${duplicate.id}`, async ({
    page,
  }) => {
    const api = await mocked(page);
    await page.addInitScript((duplicate) => {
      history.replaceState({ ...history.state, usr: { duplicate } }, '');
    }, duplicate);
    await page.goto('/alerts/new');
    await expect(
      page.getByText('This alert cannot be duplicated. Create a new rule.', { exact: true }),
    ).toBeVisible();
    const title = page.getByLabel('Title', { exact: true });
    await expect(title).toHaveValue('');
    await page.getByRole('button', { name: 'Create alert', exact: true }).click();
    await expect(title).toHaveAccessibleDescription('Enter an alert title.');
    await expect(page).toHaveURL(/\/alerts\/new$/);
    expect(api.writes).toHaveLength(0);
  });

test('editing an alert preserves server-accepted long duration aliases unchanged', async ({
  page,
}) => {
  const api = await mocked(page, {
    original: {
      ...alertFixture,
      evalConfig: {
        rollingWindow: { ...alertFixture.evalConfig.rollingWindow, evalStart: '10mins' },
      },
      promqlConfig: { holdDuration: '2hrs' },
    },
  });
  await page.goto(`${detailPath}/edit`);
  await expect(page.getByLabel('Evaluation window')).toHaveValue('10mins');
  await expect(page.getByLabel('Hold duration')).toHaveValue('2hrs');
  await expect(page.getByRole('button', { name: 'Save alert', exact: true })).toBeEnabled();
  await page.getByLabel('Threshold value').fill('4');
  await page.getByRole('button', { name: 'Save alert', exact: true }).click();
  await expect(page.getByRole('heading', { name: alertFixture.title, exact: true })).toBeVisible();
  expect(api.writes[0]).toMatchObject({
    evalConfig: { rollingWindow: { evalStart: '10mins' } },
    promqlConfig: { holdDuration: '2hrs' },
  });
});
test('deleting alert rows focuses the next row, previous row, then search for an empty list', async ({
  page,
}) => {
  await demo(page);
  for (const [name, next] of [
    ['High host load', 'Muted memory warning'],
    ['Muted memory warning', 'Checkout errors (builder)'],
    ['Checkout errors (builder)', 'Application errors'],
    ['Application errors', undefined],
  ] as const) {
    await rowAction(page, name, 'Delete');
    await remove(page, 'alert', name);
    await expect(namedRow(page, name)).toHaveCount(0);
    await expect(
      next
        ? namedRow(page, next).getByRole('button', { name: `Actions for ${next}` })
        : page.getByLabel('Search alerts'),
    ).toBeFocused();
  }
  await expect(page.getByRole('heading', { name: 'No alerts yet' })).toBeVisible();
});
test('deleting target rows focuses the next row, previous row, then search for an empty list', async ({
  page,
}) => {
  await mocked(page);
  let targets = ['Alpha', 'Bravo', 'Charlie'].map((name) => ({
    target: { ...targetFixture, id: name, name },
    enabled: true,
  }));
  await page.route('**/api/v1/targets', (route) => route.fulfill({ json: targets }));
  await page.route('**/api/v1/targets/*', (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-1)!;
    const target = targets.find((row) => row.target.id === id)!.target;
    targets = targets.filter((row) => row.target.id !== id);
    return route.fulfill({ json: target });
  });
  await page.goto('/alerts/targets');
  for (const [name, next] of [
    ['Bravo', 'Charlie'],
    ['Charlie', 'Alpha'],
    ['Alpha', undefined],
  ] as const) {
    await rowAction(page, name, 'Delete');
    await remove(page, 'target', name);
    await expect(namedRow(page, name)).toHaveCount(0);
    await expect(
      next
        ? namedRow(page, next).getByRole('button', { name: `Actions for ${next}` })
        : page.getByLabel('Search targets'),
    ).toBeFocused();
  }
  await expect(page.getByRole('heading', { name: 'No targets yet' })).toBeVisible();
});
test('delivery errors redact credential-bearing URLs', async ({ page }) => {
  await mocked(page);
  await page.goto(detailPath);
  const deliveries = page.getByRole('table', { name: 'Notification deliveries' });
  await expect(deliveries).toContainText('[redacted endpoint]');
  await expect(deliveries).not.toContainText('secret-token');
  await expect(deliveries.locator('xpath=ancestor::*[@role="alert"]')).toHaveCount(0);
});
test('the threshold shows its exact configured value while measured values are rounded', async ({
  page,
}) => {
  const runtime = alertFixture.promqlRuntime!;
  await mocked(page, {
    original: {
      ...alertFixture,
      thresholdConfig: { operator: '>', value: 1234.5 },
      promqlRuntime: {
        ...runtime,
        instances: { a: { ...runtime.instances.a, value: 0.12345 } },
      },
    } as Alert,
  });
  await page.goto(detailPath);
  const evaluation = page
    .locator('.ui-card')
    .filter({ has: page.getByRole('heading', { name: 'Threshold and evaluation', exact: true }) });
  await expect(evaluation.locator('dt:text-is("Threshold") + dd')).toHaveText('> 1234.5');
  await expect(
    page.getByText('Threshold: > 1234.5. Times are UTC.', { exact: true }),
  ).toBeVisible();
  const value = page
    .getByRole('table', { name: 'Alert instances' })
    .locator('tbody td:nth-child(3)');
  await expect(value).toHaveText('0.1235');
  await expect(value).toHaveAttribute('title', '0.12345');
});

for (const health of ['ok', 'noData', 'error'] as const)
  test(`runtime health ${health} and every instance/delivery state use human labels`, async ({
    page,
  }) => {
    const runtime = alertFixture.promqlRuntime!;
    await mocked(page, {
      original: {
        ...alertFixture,
        promqlRuntime: {
          ...runtime,
          health,
          instances: Object.fromEntries(
            ['pending', 'firing', 'resolved'].map((state) => [
              state,
              { ...runtime.instances.a, state },
            ]),
          ),
          deliveries: [
            { ...runtime.deliveries[0], firing: true },
            { ...runtime.deliveries[0], firing: false },
          ],
        },
      } as Alert,
    });
    await page.goto(detailPath);
    const card = page
      .locator('.ui-card')
      .filter({ has: page.getByRole('heading', { name: 'PromQL runtime', exact: true }) });
    await expect(card.locator('.inline > .ui-badge')).toHaveText(
      { ok: 'OK', noData: 'No data', error: 'Error' }[health],
    );
    await expect(
      page
        .getByRole('table', { name: 'Alert instances' })
        .locator('tbody td:nth-child(2) .ui-badge'),
    ).toHaveText(['Pending', 'Firing', 'Resolved']);
    await expect(
      page
        .getByRole('table', { name: 'Notification deliveries' })
        .locator('tbody td:first-child > span'),
    ).toHaveText(['Firing', 'Resolved']);
  });

for (const type of ['promql', 'code'])
  test(`${type} preview rounds displayed values, preserves raw values and announces completion in an existing region`, async ({
    page,
  }) => {
    await mocked(page);
    const value = 0.6462820502768744;
    await page.route('**/prometheus/api/v1/query', (route) =>
      route.fulfill({
        json: {
          status: 'success',
          data: {
            resultType: 'vector',
            result: [{ metric: { host: 'node-a' }, value: [1, String(value)] }],
          },
        },
      }),
    );
    await page.route(
      (url) => url.pathname === '/api/v1/query',
      (route) => route.fulfill({ json: [{ total: value }] }),
    );
    await page.goto(
      `/alerts/new?${new URLSearchParams({ queryBuilderType: type, dataset: type === 'promql' ? 'metrics' : 'logs', alertQuery: type === 'promql' ? 'up' : 'SELECT SUM(total) FROM "logs"', title: 'Rounded preview' })}`,
    );
    const status = page.locator('.alerts-preview [role="status"]');
    await expect(status).toHaveText('');
    await status.evaluate((element) => element.setAttribute('data-live-region', 'existing'));
    await page.getByRole('button', { name: /^Preview .*\(no notifications\)$/ }).click();
    const cell = page
      .getByRole('table', { name: 'Preview values' })
      .locator('tbody td:nth-child(2)');
    await expect(cell).toHaveText('0.6463');
    await expect(cell).toHaveAttribute('title', String(value));
    await expect(status).toHaveText(
      `Preview completed: 1 ${type === 'promql' ? 'series' : 'rows'}. No notifications sent.`,
    );
    await expect(status).toHaveAttribute('data-live-region', 'existing');
  });

test('runtime and preview tables can be scrolled by keyboard and pass axe at 390px', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await demo(page, detailPath);
  for (const name of ['Alert instances', 'Notification deliveries']) {
    const region = page.getByRole('region', { name, exact: true });
    await expect(region).toHaveAttribute('tabindex', '0');
    expect(await region.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
      true,
    );
    await region.focus();
    await expect(region).toBeFocused();
    await region.press('ArrowRight');
    await expect.poll(() => region.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  }
  await axe(page);
  await page.getByRole('button', { name: 'Duplicate', exact: true }).click();
  await page
    .getByRole('button', { name: 'Preview current values (no notifications)', exact: true })
    .click();
  const preview = page.getByRole('region', { name: 'Preview values', exact: true });
  await expect(preview).toHaveAttribute('tabindex', '0');
  expect(await preview.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  await preview.focus();
  await preview.press('ArrowRight');
  await expect.poll(() => preview.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  await axe(page);
});

test('all Tags chips fit their cell at 1024px without being obscured by Actions', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 844 });
  await demo(page);
  const row = namedRow(page, 'High host load');
  await expect(row.locator('td:nth-child(6) .ui-badge')).toHaveText(['production', 'metrics']);
  const region = page.getByRole('region', { name: 'Alerts table' });
  await region.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  const tags = (await row.locator('td:nth-child(6)').boundingBox())!;
  const actions = (await row.locator('td:last-child').boundingBox())!;
  for (const chip of await row.locator('td:nth-child(6) .ui-badge').all()) {
    const box = (await chip.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(tags.x);
    expect(box.x + box.width).toBeLessThanOrEqual(tags.x + tags.width);
    expect(box.x + box.width).toBeLessThanOrEqual(actions.x);
  }
});
test('detail, preview and target sheet have padded cards, readable labels, UTC times and aligned fields', async ({
  page,
}) => {
  await mocked(page);
  // The chart's window ends at "now" and moves forward whenever the alert reloads, which rebuilds
  // the plot with the new range. Pin the clock so Mute does not move the window and the test
  // checks only that the plot is kept when nothing about the expression changed.
  await page.clock.setFixedTime(new Date('2026-10-10T12:00:00Z'));
  let ranges = 0;
  await page.route('**/prometheus/api/v1/query_range', (route) => {
    ranges++;
    const end = Number(new URLSearchParams(route.request().postData()!).get('end'));
    return route.fulfill({
      json: {
        status: 'success',
        data: {
          resultType: 'matrix',
          result: [
            {
              metric: { 'host.name': 'host-a', job: 'shots' },
              values: [
                [end - 3000, '3.25'],
                [end - 1800, '4.25'],
              ],
            },
          ],
        },
      },
    });
  });
  await page.goto(detailPath);
  await expect(
    page.getByRole('heading', { name: 'Expression over the last hour', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.charts-title')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'host-a', exact: true })).toBeVisible();
  const plot = page.locator('.uplot');
  await expect(plot).toBeVisible();
  await plot.evaluate((element) => element.setAttribute('data-retained', 'true'));
  // StrictMode mounts the chart twice in development, so count from here rather than from 1.
  const loaded = ranges;
  await page.getByRole('button', { name: 'Mute', exact: true }).click();
  const reloaded = page.waitForResponse(
    (response) =>
      response.request().method() === 'GET' &&
      new URL(response.url()).pathname === `/api/v1/alerts/${alertFixture.id}`,
  );
  await page
    .getByRole('dialog', { name: 'Mute notifications' })
    .getByRole('button', { name: 'Indefinitely', exact: true })
    .click();
  await (await reloaded).finished();
  await expect(page.getByRole('button', { name: 'Unmute', exact: true })).toBeVisible();
  await expect(
    page.getByRole('table', { name: 'Alert instances' }).locator('.alerts-label-chip'),
  ).toHaveText('host=node-a');
  await expect(
    page.getByRole('table', { name: 'Notification deliveries' }).locator('.alerts-label-chip'),
  ).toHaveText('host=node-a');
  // The reload must not query the range again, which would rebuild the plot.
  expect(ranges).toBe(loaded);
  await expect(plot).toHaveAttribute('data-retained', 'true');
  await expect(page.locator('.alerts-page time').first()).toBeVisible();
  for (const time of await page.locator('.alerts-page time').all())
    await expect(time).toHaveText(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC$/);
  await expect(page.locator('.ui-card-body').first()).toBeVisible();
  for (const body of await page.locator('.ui-card-body').all())
    expect(
      await body.evaluate((element) => parseFloat(getComputedStyle(element).paddingLeft)),
    ).toBeGreaterThanOrEqual(12);
  await page.getByRole('button', { name: 'Duplicate', exact: true }).click();
  await page
    .getByRole('button', { name: 'Preview current values (no notifications)', exact: true })
    .click();
  await expect(
    page.getByRole('table', { name: 'Preview values' }).locator('.alerts-label-chip'),
  ).toHaveText('host=node-a');
  const preview = (await page.locator('.alerts-preview').boundingBox())!;
  const button = (await page
    .getByRole('button', { name: 'Preview current values (no notifications)', exact: true })
    .boundingBox())!;
  expect(button.x - preview.x).toBeGreaterThanOrEqual(12);
  expect(button.width).toBeLessThan(preview.width - 24);
  await page.getByRole('button', { name: 'New target', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'New target', exact: true });
  await sheet.getByRole('button', { name: 'Add header', exact: true }).click();
  const name = (await sheet.getByLabel('Header 1 name').boundingBox())!;
  const value = (await sheet.getByLabel('Header 1 value').boundingBox())!;
  expect(Math.abs(name.width - value.width)).toBeLessThanOrEqual(1);
  const endpoint = (await sheet.getByLabel('Endpoint URL').boundingBox())!;
  const fieldset = (await sheet.getByRole('group', { name: 'Custom headers' }).boundingBox())!;
  expect(Math.abs(endpoint.x - fieldset.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(endpoint.width - fieldset.width)).toBeLessThanOrEqual(1);
});
test('preview never evaluates a saved rule, clears stale results and shows No data', async ({
  page,
}) => {
  const api = await mocked(page);
  let queries = 0;
  await page.route('**/prometheus/api/v1/query', (route) => {
    queries++;
    return route.fulfill({
      json: {
        status: 'success',
        data: {
          resultType: 'vector',
          result: queries === 1 ? [{ metric: { host: 'preview-host' }, value: [1, '3.25'] }] : [],
        },
      },
    });
  });
  await page.goto('/alerts/new?dataset=metrics&alertQuery=up&title=Preview');
  await page
    .getByRole('button', { name: 'Preview current values (no notifications)', exact: true })
    .click();
  const table = page.getByRole('table', { name: 'Preview values' });
  await expect(table).toContainText('preview-host');
  await page.getByLabel('Threshold value').fill('4');
  await expect(table).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Preview current values (no notifications)', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'No data', exact: true })).toBeVisible();
  await expect(page.locator('.alerts-preview [role="status"]')).toHaveText(
    'Preview completed: No data. No notifications sent.',
  );
  expect(queries).toBe(2);
  expect(api.writes).toHaveLength(0);
  expect(api.calls.some((call) => call.path.endsWith('/evaluate_alert'))).toBe(false);
});
test('leaving the form aborts its pending preview', async ({ page }) => {
  await mocked(page);
  let release = () => {};
  const held = new Promise<void>((done) => {
    release = done;
  });
  await page.route('**/prometheus/api/v1/query', (route) =>
    held
      .then(() =>
        route.fulfill({ json: { status: 'success', data: { resultType: 'vector', result: [] } } }),
      )
      .catch(() => {}),
  );
  await page.goto('/alerts/new?dataset=metrics&alertQuery=up&title=Preview');
  const started = page.waitForRequest('**/prometheus/api/v1/query');
  await page
    .getByRole('button', { name: 'Preview current values (no notifications)', exact: true })
    .click();
  await started;
  const cancelled = page.waitForEvent('requestfailed', (request) =>
    request.url().endsWith('/query'),
  );
  await page.getByTestId('sidebar-alerts').click();
  await cancelled;
  release();
  await expect(page).toHaveURL(/\/alerts$/);
  await expect(page.getByRole('table', { name: 'Alerts', exact: true })).toBeVisible();
});
test('SQL preview uses the same rolling-window request as alert evaluation', async ({ page }) => {
  const api = await mocked(page, { enabled: false });
  await page.goto('/alerts/new');
  await page.getByLabel('Dataset', { exact: true }).selectOption('logs');
  await page
    .getByRole('textbox', { name: 'SQL query', exact: true })
    .fill('SELECT COUNT(*) FROM "logs"');
  await page.getByLabel('Evaluation window').fill('1h30m');
  await page.getByRole('button', { name: 'Preview SQL (no notifications)', exact: true }).click();
  await expect(page.getByRole('table', { name: 'Preview values' })).toContainText('8');
  expect(api.calls.find((call) => call.path === '/api/v1/query')).toMatchObject({
    method: 'POST',
    body: {
      query: 'SELECT COUNT(*) FROM "logs"',
      startTime: '1h30m',
      endTime: 'now',
      sendNull: true,
    },
  });
});
test('known reader privileges make list actions and create form read-only', async ({ page }) => {
  await mocked(page);
  await page
    .context()
    .addCookies([{ name: 'user_id', value: 'reader', url: 'http://127.0.0.1:5173' }]);
  await page.route('**/api/v1/users/reader', (route) =>
    route.fulfill({ json: { id: 'reader', username: 'Reader' } }),
  );
  await page.route('**/api/v1/user/reader/role', (route) =>
    route.fulfill({
      json: {
        roles: {
          readers: {
            actions: [{ privilege: 'reader', resource: { stream: 'metrics' } }],
            roleType: 'user',
          },
        },
        groupRoles: {},
      },
    }),
  );
  await page.goto('/alerts');
  await expect(page.getByRole('table', { name: 'Alerts', exact: true })).toContainText('Read-only');
  await expect(page.getByRole('link', { name: 'New alert', exact: true })).toHaveCount(0);
  await page.goto('/alerts/new');
  await expect(page.getByRole('heading', { name: 'Permission denied', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create alert', exact: true })).toHaveCount(0);
});
for (const theme of ['light', 'dark'])
  for (const view of ['list', 'detail', 'form', 'targets', 'sheet'])
    test(`${view} passes axe in ${theme}`, async ({ page }) => {
      const path =
        view === 'list'
          ? '/alerts'
          : view === 'detail'
            ? detailPath
            : view === 'form'
              ? '/alerts/new'
              : '/alerts/targets';
      await demo(page, path);
      if (theme === 'dark') {
        await page.getByRole('button', { name: 'Use dark theme' }).click();
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      }
      if (view === 'sheet') {
        await page.getByRole('button', { name: 'New target', exact: true }).click();
        await expect(page.getByRole('dialog', { name: 'New target', exact: true })).toBeVisible();
      }
      if (view === 'form')
        await expect(
          page.getByRole('textbox', { name: 'PromQL query', exact: true }),
        ).toBeVisible();
      if (view === 'detail')
        await expect(page.getByRole('table', { name: 'Alert instances' })).toBeVisible();
      await axe(page);
    });
// The row actions must be on screen and clickable at 390px without scrolling the table sideways.
async function expectRowActionsReachable(page: Page, name: string) {
  const region = page.getByRole('region', {
    name: page.url().endsWith('/targets') ? 'Targets table' : 'Alerts table',
  });
  const actions = namedRow(page, name).getByRole('button', { name: `Actions for ${name}` });
  await region.evaluate((element) => (element.scrollLeft = 0));
  await expect(actions).toBeVisible();
  const box = (await actions.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(await region.evaluate((element) => element.scrollLeft)).toBe(0);
  // Nothing covers the button: a click at its centre reaches it.
  expect(
    await actions.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return element.contains(hit);
    }),
  ).toBe(true);
  await actions.click();
  await expect(page.getByRole('menu', { name: `Actions for ${name}`, exact: true })).toBeVisible();
  expect(await region.evaluate((element) => element.scrollLeft)).toBe(0);
  await page.keyboard.press('Escape');
  await expect(actions).toBeFocused();
}

test('list, detail, form, targets and an open sheet fit 390px without horizontal overflow', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of ['/alerts', detailPath, '/alerts/new', '/alerts/targets']) {
    await demo(page, path);
    if (path === '/alerts') {
      const region = page.getByRole('region', { name: 'Alerts table' });
      expect(await region.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
        true,
      );
      expect((await namedRow(page, 'High host load').boundingBox())!.height).toBeLessThanOrEqual(
        60,
      );
      await namedRow(page, 'High host load')
        .getByRole('button', { name: 'Actions for High host load' })
        .focus();
      await page.keyboard.press('ArrowDown');
      await expect(page.getByRole('menuitem', { name: 'Evaluate now' })).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(
        namedRow(page, 'High host load').getByRole('button', {
          name: 'Actions for High host load',
        }),
      ).toBeFocused();
    }
    if (path === '/alerts' || path === '/alerts/targets')
      await expectRowActionsReachable(
        page,
        path === '/alerts' ? 'High host load' : 'Operations Slack',
      );
    if (path.endsWith('/new'))
      await expect(page.getByRole('textbox', { name: 'PromQL query', exact: true })).toBeVisible();
    if (path === detailPath)
      await expect(page.getByRole('table', { name: 'Alert instances' })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    ).toBeLessThanOrEqual(1);
  }
  await page.getByRole('button', { name: 'New target', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
});

test('a tabbed-to sort button scrolls clear of the sticky Actions column at 390px', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [path, first, tabbed] of [
    ['/alerts', 'Sort by title', ['Sort by severity', 'Sort by state']],
    ['/alerts/targets', 'Sort by name', ['Sort by type', 'Sort by endpoint']],
  ] as const) {
    await demo(page, path);
    await page.getByRole('button', { name: first, exact: true }).focus();
    for (const name of tabbed) {
      await page.keyboard.press('Tab');
      const button = page.getByRole('button', { name, exact: true });
      await expect(button).toBeFocused();
      const { centreHit, right, stickyLeft } = await button.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const sticky = element.closest('table')!.querySelector('thead th:last-child')!;
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        return {
          centreHit: element.contains(hit),
          right: rect.right,
          stickyLeft: sticky.getBoundingClientRect().left,
        };
      });
      expect(centreHit, name).toBe(true);
      expect(right, name).toBeLessThan(stickyLeft);
    }
  }
});
