import { test, expect, type Page } from '@playwright/test';

const reader = 'isolation-reader';
const sql = 'SELECT n FROM "events" LIMIT 60';

async function rename(page: Page, previous: string, next: string) {
  await page.getByRole('button', { name: `Rename ${previous}`, exact: true }).click();
  await page.getByRole('textbox', { name: 'Query tab name' }).fill(next);
  await page.getByRole('textbox', { name: 'Query tab name' }).press('Enter');
}

for (const stored of [false, true]) {
  test(`initial identity preserves independent matching tabs${stored ? ' alongside a matching stored draft' : ''}`, async ({
    page,
    context,
    baseURL,
  }) => {
    await context.addCookies([{ name: 'user_id', value: reader, url: baseURL! }]);
    if (stored) {
      await page.addInitScript(
        ({ reader, sql }) => {
          const key = `parseable-sql:v1:${encodeURIComponent(location.origin)}:${reader}:drafts`;
          sessionStorage.setItem(
            key,
            JSON.stringify([
              {
                id: 'stored-report',
                savedId: 'saved-report',
                name: 'Stored report',
                sql,
                range: '1h',
                datasets: ['archive'],
                updatedAt: '2026-10-11T00:00:00Z',
              },
            ]),
          );
        },
        { reader, sql },
      );
    }
    let releaseIdentity!: () => void;
    const identity = new Promise<void>((resolve) => {
      releaseIdentity = resolve;
    });
    let executions = 0;
    await page.route('**/api/v1/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith(`/users/${reader}`)) {
        await identity;
        return route.fulfill({ json: { id: reader, username: 'Isolation Reader' } });
      }
      if (path.endsWith('/logstream'))
        return route.fulfill({ json: [{ name: 'events' }, { name: 'archive' }] });
      if (path.endsWith('/query'))
        return route.fulfill({ json: [{ n: ++executions, source: `execution-${executions}` }] });
      return route.fulfill({ json: {} });
    });
    await page.goto('/sql-editor');
    try {
      for (const [index, name, dataset] of [
        [0, 'Events report', 'events'],
        [1, 'Archive report', 'archive'],
      ] as const) {
        if (index) await page.getByRole('button', { name: 'New query tab' }).click();
        await rename(page, 'Query 1', name);
        await page.getByRole('checkbox', { name: `Select ${dataset}`, exact: true }).check();
        await page.getByRole('textbox', { name: 'SQL query' }).fill(sql);
        await page.getByRole('button', { name: 'Run query', exact: true }).click();
        await expect(page.getByRole('table').locator('tbody tr')).toContainText(
          `execution-${index + 1}`,
        );
      }
      releaseIdentity();
      await expect(page.locator('.shell-username')).toHaveText('Isolation Reader');
      await expect(page.getByRole('tablist', { name: 'Query tabs' }).getByRole('tab')).toHaveCount(
        2,
      );
      for (const [name, dataset, execution] of [
        ['Events report', 'events', 1],
        ['Archive report', 'archive', 2],
      ] as const) {
        await page.getByRole('tab', { name, exact: true }).click();
        await expect(page.getByRole('textbox', { name: 'SQL query' })).toHaveText(sql);
        await expect(
          page.getByRole('checkbox', { name: `Select ${dataset}`, exact: true }),
        ).toBeChecked();
        await expect(
          page.getByRole('checkbox', {
            name: `Select ${dataset === 'events' ? 'archive' : 'events'}`,
            exact: true,
          }),
        ).not.toBeChecked();
        await expect(page.getByRole('table').locator('tbody tr')).toContainText(
          `execution-${execution}`,
        );
      }
      await expect
        .poll(() =>
          page.evaluate((reader) => {
            const key = `parseable-sql:v1:${encodeURIComponent(location.origin)}:${reader}:drafts`;
            return JSON.parse(sessionStorage.getItem(key) || '[]').map(
              (draft: { name: string }) => draft.name,
            );
          }, reader),
        )
        .toEqual(['Events report', 'Archive report']);
      expect(executions).toBe(2);
    } finally {
      releaseIdentity();
    }
  });
}

test('completed query results do not inherit another tab sorting or pagination', async ({
  page,
  context,
  baseURL,
}) => {
  await context.addCookies([{ name: 'user_id', value: reader, url: baseURL! }]);
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith(`/users/${reader}`))
      return route.fulfill({ json: { id: reader, username: 'Isolation Reader' } });
    if (path.endsWith('/logstream')) return route.fulfill({ json: [{ name: 'events' }] });
    if (path.endsWith('/query')) {
      const second = route.request().postDataJSON().query.includes('second');
      return route.fulfill({
        json: Array.from({ length: second ? 35 : 60 }, (_, index) => ({
          n: (second ? 135 : 60) - index,
          source: second ? 'second' : 'first',
        })),
      });
    }
    return route.fulfill({ json: {} });
  });
  await page.goto('/sql-editor');
  await expect(page.locator('.shell-username')).toHaveText('Isolation Reader');
  for (const label of ['first', 'second']) {
    if (label === 'second') await page.getByRole('button', { name: 'New query tab' }).click();
    await page
      .getByRole('textbox', { name: 'SQL query' })
      .fill(`SELECT n, '${label}' AS source FROM events`);
    await page.getByRole('button', { name: 'Run query', exact: true }).click();
    await expect(page.getByRole('table').locator('tbody tr')).toHaveCount(25);
    await expect(page.getByRole('table').locator('tbody tr').first()).toContainText(label);
  }
  await page.getByRole('tab', { name: 'Query 1', exact: true }).click();
  await page.getByRole('button', { name: 'Sort n', exact: true }).click();
  await expect(page.getByRole('columnheader', { name: 'n', exact: true })).toHaveAttribute(
    'aria-sort',
    'ascending',
  );
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page.getByText('Page 2 of 3', { exact: true })).toBeVisible();
  await expect(
    page
      .getByRole('table')
      .locator('tbody tr')
      .first()
      .getByRole('cell', { name: '26', exact: true }),
  ).toBeVisible();
  await page.getByRole('tab', { name: 'Query 2', exact: true }).click();
  await expect(page.getByRole('columnheader', { name: 'n', exact: true })).toHaveAttribute(
    'aria-sort',
    'none',
  );
  await expect(page.getByText('Page 1 of 2', { exact: true })).toBeVisible();
  await expect(page.getByRole('table').locator('tbody tr')).toHaveCount(25);
  await expect(
    page
      .getByRole('table')
      .locator('tbody tr')
      .first()
      .getByRole('cell', { name: '135', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('table').locator('tbody tr').first()).toContainText('second');
});
