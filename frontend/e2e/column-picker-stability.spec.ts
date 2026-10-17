import { test, expect } from '@playwright/test';

test('column picker keeps checkbox rows in place until an explicit reorder', async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem('parseable-mode', 'demo'));
  await page.goto('/logs');
  await page.getByRole('button', { name: 'Add columns', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Add columns' });
  const rows = picker.locator('.column-option-row');
  const labels = () => rows.locator('label').allTextContents();
  const initial = await labels();
  const checkboxPositions = () =>
    picker.getByRole('checkbox').evaluateAll((inputs) =>
      inputs.map((input) => {
        const { x, y } = input.getBoundingClientRect();
        return { x, y };
      }),
    );
  const initialPositions = await checkboxPositions();
  const host = picker.getByRole('checkbox', { name: 'host', exact: true });
  await host.check();
  await expect.poll(labels).toEqual(initial);
  await expect.poll(checkboxPositions).toEqual(initialPositions);
  await host.uncheck();
  await expect.poll(labels).toEqual(initial);
  await expect.poll(checkboxPositions).toEqual(initialPositions);
  await host.check();
  await picker.getByRole('button', { name: 'Move host earlier', exact: true }).click();
  await expect.poll(async () => (await labels()).slice(0, 2)).toEqual(['host', 'p_timestamp']);
  await picker.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Add columns', exact: true }).click();
  await expect.poll(async () => (await labels()).slice(0, 2)).toEqual(['host', 'p_timestamp']);
});
