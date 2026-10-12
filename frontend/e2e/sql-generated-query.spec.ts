import { expect, test } from '@playwright/test';
import { datasetQuery } from '../src/features/sql/workspace';
test('selected datasets execute a quoted UNION ALL BY NAME query against the live transport', async ({
  page,
}) => {
  const names = ['application_logs', 'audit"archive'];
  let sql = '';
  await page.context().addCookies(
    ['user_id', 'username'].map((name) => ({
      name,
      value: 'admin',
      url: String(test.info().project.use.baseURL),
    })),
  );
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/v1/users/admin')
      return route.fulfill({ json: { id: 'admin', username: 'admin' } });
    if (path === '/api/v1/about') return route.fulfill({ json: { capabilities: {} } });
    if (path === '/api/v1/logstream')
      return route.fulfill({ json: names.map((name) => ({ name })) });
    if (path === '/api/v1/query') {
      sql = route.request().postDataJSON().query;
      return route.fulfill({
        json: [
          { p_timestamp: '2026-10-11T12:00:00Z', service: 'api', actor: null },
          { p_timestamp: '2026-10-11T11:00:00Z', service: null, actor: 'admin' },
        ],
      });
    }
    return route.fulfill({ json: {} });
  });
  await page.goto('/sql-editor?query=SELECT%201');
  await page.getByRole('checkbox', { name: `Select ${names[0]}`, exact: true }).check();
  await page.getByRole('checkbox', { name: `Select ${names[1]}`, exact: true }).check();
  await expect(page.getByRole('textbox', { name: 'SQL query' })).toContainText('SELECT 1');
  await page.getByRole('button', { name: 'New query from selection' }).click();
  await page.getByRole('button', { name: 'Run query', exact: true }).click();
  await expect.poll(() => sql).toBe(datasetQuery(names));
  await expect(page.getByRole('table').locator('tbody tr')).toHaveCount(2);
});
