import { test, expect, type Page } from '@playwright/test';

async function demo(page: Page) {
  await page.addInitScript(() => sessionStorage.setItem('parseable-mode', 'demo'));
  await page.goto('/sql-editor');
}
const draftKey = 'parseable-sql:v1:demo:drafts';

test('restoring a large workspace never silently truncates persisted tabs', async ({ page }) => {
  await page.addInitScript(
    ({ key }) => {
      sessionStorage.setItem('parseable-mode', 'demo');
      sessionStorage.setItem(
        key,
        JSON.stringify(
          Array.from({ length: 31 }, (_, index) => ({
            id: `draft-${index}`,
            name: `Query ${index + 1}`,
            sql: `SELECT ${index + 1}`,
            range: '1h',
            datasets: [],
            updatedAt: '2026-10-11T00:00:00Z',
          })),
        ),
      );
    },
    { key: draftKey },
  );
  await page.goto('/sql-editor');
  await expect(page.getByRole('tablist', { name: 'Query tabs' }).getByRole('tab')).toHaveCount(31);
  await expect(page.getByRole('textbox', { name: 'SQL query' })).toContainText('SELECT 31');
});

test('a URL handoff preserves existing browser drafts', async ({ page }) => {
  await page.addInitScript(
    ({ key }) => {
      sessionStorage.setItem('parseable-mode', 'demo');
      if (!sessionStorage.getItem(key))
        sessionStorage.setItem(
          key,
          JSON.stringify([
            {
              id: 'draft',
              name: 'Important draft',
              sql: 'SELECT * FROM "api_logs" LIMIT 8',
              range: '1h',
              datasets: [],
              updatedAt: '2026-10-11T00:00:00Z',
            },
          ]),
        );
    },
    { key: draftKey },
  );
  await page.goto('/sql-editor?query=SELECT%20*%20FROM%20%22application_logs%22%20LIMIT%202');
  await expect(page.getByRole('textbox', { name: 'SQL query' })).toContainText('LIMIT 2');
  await expect(page.getByRole('tab', { name: 'Important draft', exact: true })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate((key) => JSON.parse(sessionStorage.getItem(key) || '[]').length, draftKey),
    )
    .toBe(2);
  await page.reload();
  await expect(page.getByRole('tablist', { name: 'Query tabs' }).getByRole('tab')).toHaveCount(2);
  await page.getByRole('tab', { name: 'Important draft', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'SQL query' })).toContainText('LIMIT 8');
});

test('drafts keep the saved query association across reloads', async ({ page }) => {
  await demo(page);
  await page
    .getByRole('textbox', { name: 'SQL query' })
    .fill('SELECT * FROM "application_logs" LIMIT 7');
  await page.getByRole('textbox', { name: 'Saved query name' }).fill('Associated query');
  await page.getByRole('button', { name: 'Save as new', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate((key) => JSON.parse(sessionStorage.getItem(key) || '[]')[0]?.savedId, draftKey),
    )
    .toBeTruthy();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Update saved', exact: true })).toBeEnabled();
  await page
    .getByRole('textbox', { name: 'SQL query' })
    .fill('SELECT * FROM "application_logs" LIMIT 9');
  await page.getByRole('button', { name: 'Update saved', exact: true }).click();
  const before = await page.getByRole('tablist', { name: 'Query tabs' }).getByRole('tab').count();
  await page
    .getByRole('complementary', { name: 'SQL datasets and saved queries' })
    .getByRole('button', { name: 'Associated query', exact: true })
    .click();
  await expect(page.getByRole('tablist', { name: 'Query tabs' }).getByRole('tab')).toHaveCount(
    before,
  );
});

test('the first live identity response preserves edits made while it is loading', async ({
  page,
  context,
}) => {
  await context.addCookies([
    { name: 'user_id', value: 'delayed-reader', url: 'http://127.0.0.1:5173' },
  ]);
  let releaseIdentity!: () => void;
  const ready = new Promise<void>((resolve) => {
    releaseIdentity = resolve;
  });
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/users/delayed-reader')) {
      await ready;
      return route.fulfill({ json: { id: 'delayed-reader', username: 'Delayed Reader' } });
    }
    if (path.endsWith('/logstream')) return route.fulfill({ json: [{ name: 'events' }] });
    return route.fulfill({ json: {} });
  });
  await page.goto('/sql-editor');
  await page.getByRole('textbox', { name: 'SQL query' }).fill('SELECT * FROM "events" LIMIT 17');
  releaseIdentity();
  await expect(page.locator('.shell-username')).toHaveText('Delayed Reader');
  await expect(page.getByRole('textbox', { name: 'SQL query' })).toContainText('LIMIT 17');
});

test('schema insertion uses the SQL cursor and a closed draft can be recovered', async ({
  page,
}) => {
  await demo(page);
  const editor = page.getByRole('textbox', { name: 'SQL query' });
  await editor.fill('SELECT  FROM "application_logs"');
  await editor.press('Control+Home');
  for (let position = 0; position < 7; position++) await editor.press('ArrowRight');
  await page.getByRole('button', { name: 'Explore schema for application_logs' }).click();
  await page.getByRole('button', { name: 'message', exact: true }).click();
  await expect(editor).toHaveText('SELECT "message" FROM "application_logs"');
  await page.getByRole('button', { name: 'Close Query 1' }).click();
  await expect(editor).toHaveText('');
  await page.getByRole('button', { name: 'Undo close', exact: true }).click();
  await expect(editor).toHaveText('SELECT "message" FROM "application_logs"');
  await expect(page.getByRole('tab', { name: 'Query 1', exact: true })).toBeFocused();
});

test('URL handoff is consumed so an edited draft reload does not re-add the original query', async ({
  page,
}) => {
  await page.addInitScript(() => sessionStorage.setItem('parseable-mode', 'demo'));
  await page.goto('/sql-editor?query=SELECT%201&range=1h');
  await expect(page).toHaveURL(/\/sql-editor$/);
  await page.getByRole('textbox', { name: 'SQL query' }).fill('SELECT 42');
  await page.reload();
  await expect(page.getByRole('tablist', { name: 'Query tabs' }).getByRole('tab')).toHaveCount(1);
  await expect(page.getByRole('textbox', { name: 'SQL query' })).toHaveText('SELECT 42');
});

test('draft workspaces stay independent in two browser tabs', async ({ page, context }) => {
  await demo(page);
  await page.getByRole('textbox', { name: 'SQL query' }).fill('SELECT 11');
  const second = await context.newPage();
  await demo(second);
  await second.getByRole('textbox', { name: 'SQL query' }).fill('SELECT 22');
  await second.reload();
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'SQL query' })).toHaveText('SELECT 11');
  await expect(second.getByRole('textbox', { name: 'SQL query' })).toHaveText('SELECT 22');
});

test('initial live URL hydration preserves matching named configured draft metadata', async ({
  page,
  context,
}) => {
  await context.addCookies([
    { name: 'user_id', value: 'metadata-reader', url: 'http://127.0.0.1:5173' },
  ]);
  await page.addInitScript(() => {
    const scope = `parseable-sql:v1:${encodeURIComponent(location.origin)}:metadata-reader:drafts`;
    if (!sessionStorage.getItem(scope))
      sessionStorage.setItem(
        scope,
        JSON.stringify([
          {
            id: 'metadata-draft',
            savedId: 'saved-metadata',
            name: 'Named report',
            sql: 'SELECT 42',
            range: '1h',
            datasets: ['events'],
            chart: {
              tile_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
              tileType: 'code',
              title: 'Configured report',
              chartType: 'bar',
              config: { axes: {}, layout: {} },
            },
            updatedAt: '2026-10-11T00:00:00Z',
          },
        ]),
      );
  });
  let releaseIdentity!: () => void;
  const ready = new Promise<void>((resolve) => {
    releaseIdentity = resolve;
  });
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/users/metadata-reader')) {
      await ready;
      return route.fulfill({ json: { id: 'metadata-reader', username: 'Metadata Reader' } });
    }
    if (path.endsWith('/logstream')) return route.fulfill({ json: [{ name: 'events' }] });
    return route.fulfill({ json: {} });
  });
  await page.goto('/sql-editor?query=SELECT%2042');
  await expect(page.getByRole('textbox', { name: 'SQL query' })).toHaveText('SELECT 42');
  releaseIdentity();
  await expect(page.getByRole('tab', { name: 'Named report', exact: true })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Select events', exact: true })).toBeChecked();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const scope = `parseable-sql:v1:${encodeURIComponent(location.origin)}:metadata-reader:drafts`;
        return JSON.parse(sessionStorage.getItem(scope) || '[]')[0]?.chart?.title;
      }),
    )
    .toBe('Configured report');
});
