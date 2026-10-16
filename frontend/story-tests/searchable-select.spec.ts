import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const story = (name: string) => `/iframe.html?id=prism-searchableselect--${name}&viewMode=story`;

test('query stays separate, keyboard selection, empty choice, and dismissal', async ({ page }) => {
  await page.goto(story('datasets'));
  const input = page.getByRole('combobox', { name: 'Dataset' });
  await expect(input).toHaveValue('app-logs');
  await input.click();
  await expect(input).toHaveValue('');
  await expect(page.getByRole('status')).toContainText('Showing 100 of 154');
  await input.fill('app-lgos');
  await expect(page.getByRole('option', { name: 'app-logs', exact: true })).toBeVisible();
  await input.press('Enter');
  await expect(page.getByTestId('committed')).toHaveText('app-logs');
  await expect(page.getByRole('listbox')).toBeVisible();
  await input.fill('audit');
  await input.press('ArrowDown');
  await input.press('Enter');
  await expect(input).toHaveValue('audit-events');
  await expect(page.getByTestId('committed')).toHaveText('audit-events');
  await input.click();
  await input.fill('absolutely-no-such-dataset');
  await expect(page.getByRole('status')).toHaveText('No matching datasets');
  await input.press('Tab');
  await expect(input).toHaveValue('audit-events');
  await expect(page.getByRole('button', { name: 'Next control' })).toBeFocused();
  await input.click();
  await page.getByRole('option', { name: 'No dataset', exact: true }).click();
  await expect(page.getByTestId('committed')).toHaveText('(empty)');
  await expect(input).toBeFocused();
  await input.click();
  await input.fill('audit');
  await page.getByRole('button', { name: 'Outside control' }).click();
  await expect(input).toHaveValue('No dataset');
  await expect(page.getByRole('listbox')).toHaveCount(0);
});

test('Escape dismisses picker before its parent dialog', async ({ page }) => {
  await page.goto(story('in-dialog'));
  const input = page.getByRole('combobox', { name: 'Dataset' });
  await input.click();
  await input.fill('audit');
  await input.press('Escape');
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(input).toHaveValue('app-logs');
  await input.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('saved unavailable dataset is visible and retry is actionable', async ({ page }) => {
  await page.goto(story('unavailable'));
  await expect(page.getByRole('combobox')).toHaveValue('deleted-logs (unavailable)');
  await page.goto(story('load-failure'));
  await page.getByRole('combobox').click();
  await expect(page.getByRole('alert')).toHaveText('Could not load datasets.');
  await page.getByRole('button', { name: 'Retry loading datasets' }).click();
  await expect(page.getByTestId('retries')).toHaveText('1');
});

for (const theme of ['light', 'dark'])
  test(`open picker passes axe in ${theme}`, async ({ page }) => {
    await page.goto(story('datasets'));
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await page.getByRole('combobox').click();
    expect(
      (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
        .violations,
    ).toEqual([]);
  });

test('async replacement clears active option rather than committing its replacement', async ({
  page,
}) => {
  await page.goto(story('async-options'));
  await page.clock.install();
  await page.getByRole('button', { name: 'Refresh datasets' }).click();
  const input = page.getByRole('combobox');
  await input.click();
  await input.press('ArrowDown');
  await input.press('ArrowDown');
  await expect(input).toHaveAttribute('aria-activedescendant', /options-1$/);
  await page.clock.fastForward(1000);
  await expect(page.getByRole('option', { name: 'production-api' })).toBeVisible();
  await expect(input).not.toHaveAttribute('aria-activedescendant');
  await input.press('Enter');
  await expect(page.getByTestId('committed')).toHaveText('app-logs');
  await expect(page.getByRole('listbox')).toBeVisible();
});

test('touch movement does not activate options while scrolling', async ({ page }) => {
  await page.goto(story('datasets'));
  const input = page.getByRole('combobox');
  await input.click();
  await page
    .getByRole('option', { name: 'audit-events', exact: true })
    .dispatchEvent('pointermove', { pointerType: 'touch' });
  await expect(input).not.toHaveAttribute('aria-activedescendant');
});

test('reselecting committed value closes without emitting change', async ({ page }) => {
  await page.goto(story('datasets'));
  const input = page.getByRole('combobox');
  await input.click();
  await page.getByRole('option', { name: 'app-logs', exact: true }).click();
  await expect(page.getByTestId('changes')).toHaveText('0');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(input).toBeFocused();
  await input.click();
  await page.getByRole('option', { name: 'audit-events', exact: true }).click();
  await expect(page.getByTestId('changes')).toHaveText('1');
});

test('retry is reachable by Tab with popup closed and returns focus to input', async ({ page }) => {
  await page.goto(story('load-failure'));
  const input = page.getByRole('combobox');
  const retry = page.getByRole('button', { name: 'Retry loading datasets' });
  await expect(retry).toBeVisible();
  await input.click();
  await input.press('Tab');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(retry).toBeFocused();
  await retry.press('Enter');
  await expect(page.getByTestId('retries')).toHaveText('1');
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('status')).toHaveText('No matching datasets');
  await retry.click();
  await expect(page.getByTestId('retries')).toHaveText('2');
  await expect(input).toBeFocused();
});

test('status click and list scrolling retain input focus', async ({ page }) => {
  await page.goto(story('datasets'));
  const input = page.getByRole('combobox');
  await input.click();
  await page.getByRole('status').click();
  await expect(input).toBeFocused();
  await expect(page.getByRole('listbox')).toBeVisible();
  const listbox = page.getByRole('listbox');
  await listbox.hover();
  await page.mouse.wheel(0, 300);
  await expect.poll(() => listbox.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect(input).toBeFocused();
  await input.fill('audit');
  await expect(page.getByRole('option', { name: 'audit-events', exact: true })).toBeVisible();
});

test('retry keeps input focus when button becomes disabled during loading', async ({ page }) => {
  await page.goto(story('retry-loading'));
  await page.clock.install();
  const input = page.getByRole('combobox');
  const retry = page.getByRole('button', { name: 'Retry loading datasets' });
  await retry.click();
  await expect(retry).toBeDisabled();
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute('aria-busy', 'true');
  await expect(page.getByRole('status')).toHaveText('Loading datasets…');
  await page.clock.fastForward(1000);
  await expect(retry).toHaveCount(0);
  await expect(page.getByRole('option', { name: 'audit-events', exact: true })).toBeVisible();
  await expect(input).toBeFocused();
});
