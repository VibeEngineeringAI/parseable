import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

async function story(page: Page, name: string) {
  await page.goto(`/iframe.html?id=prism-component-library--${name}&viewMode=story`);
  await expect(page.locator('#storybook-root')).not.toBeEmpty();
}

test('button variants render with names and disabled semantics', async ({ page }) => {
  await story(page, 'buttons');
  await expect(page.getByRole('button')).toHaveCount(7);
  await expect(page.getByRole('button', { name: 'Create dataset', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Unavailable', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Refresh results', exact: true })).toBeVisible();
});

test('input labels, help and errors associate with their controls', async ({ page }) => {
  await story(page, 'inputs');
  const input = page.getByRole('textbox', { name: 'Dataset name', exact: true });
  await input.fill('production_events');
  await expect(input).toHaveValue('production_events');
  await expect(input).toHaveAccessibleDescription('Use a name your team can recognize.');
  const invalid = page.getByRole('textbox', { name: 'Query name', exact: true });
  await expect(invalid).toHaveAttribute('aria-invalid', 'true');
  await expect(invalid).toHaveAccessibleDescription('Enter a name to save this query.');
  await expect(page.getByRole('alert')).toHaveText('Enter a name to save this query.');
  await expect(page.getByRole('textbox', { name: 'Managed value', exact: true })).toHaveAttribute(
    'readonly',
    '',
  );
  await page.getByRole('combobox', { name: 'Time range' }).selectOption('1h');
  await expect(page.getByRole('combobox', { name: 'Time range' })).toHaveValue('1h');
});

test('status badges and empty/loading stories render meaningful text', async ({ page }) => {
  await story(page, 'badges');
  for (const label of ['Logs', 'Healthy', 'Warning', 'Error']) {
    await expect(page.getByText(label, { exact: true })).toBeVisible();
  }
  await story(page, 'empty');
  await expect(page.getByRole('heading', { name: 'No events match your filters' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Clear filters' })).toBeVisible();
  await story(page, 'loading');
  await expect(page.getByRole('status')).toHaveText('Loading events');
});

test('modal contains keyboard focus and Escape restores its opener', async ({ page }) => {
  await story(page, 'modal');
  const opener = page.getByRole('button', { name: 'Save view', exact: true });
  await opener.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Save view', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAccessibleDescription(
    'Keep these filters and columns for your next investigation.',
  );
  await dialog.getByRole('textbox', { name: 'View name' }).fill('Production errors');
  for (let index = 0; index < 8; index++) {
    await page.keyboard.press(index < 4 ? 'Tab' : 'Shift+Tab');
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test('detail sheet exposes its title and record, then restores focus', async ({ page }) => {
  await story(page, 'detail-sheet');
  const opener = page.getByRole('button', { name: 'Inspect record' });
  await opener.click();
  const sheet = page.getByRole('dialog', { name: 'Record details' });
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText('Request completed');
  await sheet.getByRole('button', { name: 'Close dialog' }).click();
  await expect(sheet).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test('tabs select panels with arrow keys', async ({ page }) => {
  await story(page, 'tab-views');
  await expect(page.getByRole('tablist', { name: 'Result format' })).toBeVisible();
  const table = page.getByRole('tab', { name: 'Table', exact: true });
  await table.focus();
  await expect(table).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'JSON', exact: true })).toBeFocused();
  await expect(page.getByRole('tab', { name: 'JSON', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('tabpanel')).toHaveText('Raw event fields appear here.');
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('tabpanel')).toHaveText('Events appear in a table.');
});

for (const name of [
  'buttons',
  'inputs',
  'badges',
  'modal',
  'detail-sheet',
  'empty',
  'tab-views',
  'loading',
]) {
  test(`WCAG accessibility smoke: ${name}`, async ({ page }) => {
    await story(page, name);
    if (name === 'modal')
      await page.getByRole('button', { name: 'Save view', exact: true }).click();
    if (name === 'detail-sheet') await page.getByRole('button', { name: 'Inspect record' }).click();
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    expect(result.violations).toEqual([]);
  });
}
