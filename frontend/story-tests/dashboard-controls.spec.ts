import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
test('dashboard charts reserve room for formatted axis labels and delegate announcements', async ({
  page,
}) => {
  await page.goto('/iframe.html?id=metrics-timeserieschart--dashboard-sizing&viewMode=story');
  await expect(page.getByRole('img')).toHaveAccessibleName(/3 series from/);
  await expect(page.locator('.charts-count-row > span')).toHaveAttribute('aria-live', 'off');
  expect(
    await page.locator('.uplot').evaluate((element) => element.getBoundingClientRect().height),
  ).toBe(180);
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
});
test('disabled menu reason stays visible and keyboard reachable, and activation does nothing', async ({
  page,
}) => {
  await page.goto('/iframe.html?id=prism-actionsmenu--disabled-with-reason&viewMode=story');
  await page.getByRole('button', { name: 'Dashboard actions' }).press('ArrowDown');
  const item = page.getByRole('menuitem', { name: 'Duplicate', exact: true });
  await expect(item).toBeFocused();
  await expect(item).toHaveAttribute('aria-disabled', 'true');
  await expect(item).toHaveAccessibleDescription('Save your changes before duplicating.');
  await expect(
    page.getByText('Save your changes before duplicating.', { exact: true }),
  ).toBeVisible();
  await item.press('Enter');
  await expect(page.getByRole('status')).toHaveText('No action selected');
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
});
test('dashboard range presets include the six picks and custom range', async ({ page }) => {
  await page.goto('/iframe.html?id=prism-timerangepicker--dashboard-presets&viewMode=story');
  const range = page.getByLabel('Time range', { exact: true });
  await expect(range.locator('option')).toHaveText([
    'Last 10 minutes',
    'Last 30 minutes',
    'Last 1 hour',
    'Last 5 hours',
    'Last 24 hours',
    'Last 3 days',
    'Custom range',
  ]);
  await range.selectOption('30m');
  await expect(range).toHaveValue('30m');
  await page.getByRole('button', { name: 'Choose absolute time range' }).click();
  await expect(page.getByRole('dialog', { name: 'Time range', exact: true })).toBeVisible();
  await expect(page.getByLabel('From', { exact: true })).toBeFocused();
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
});
test('disabled time range prevents both preset and absolute changes', async ({ page }) => {
  await page.goto('/iframe.html?id=prism-timerangepicker--disabled&viewMode=story');
  await expect(page.getByLabel('Time range', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Choose absolute time range' })).toBeDisabled();
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
});
