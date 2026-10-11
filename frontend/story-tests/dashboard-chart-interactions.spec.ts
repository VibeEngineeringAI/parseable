import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test.use({ reducedMotion: 'reduce' });

for (const theme of ['light', 'dark']) {
  test(`pie supports keyboard inspection, hiding all slices and restoring them in ${theme}`, async ({
    page,
  }) => {
    await page.goto('/iframe.html?id=dashboards-piechart--with-labels&viewMode=story');
    await expect(page.locator('.pie-chart-slice')).toHaveCount(3);
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    const info = page.getByRole('button', { name: 'INFO', exact: true });
    const colour = await info
      .locator('.pie-chart-swatch')
      .evaluate((element) => getComputedStyle(element).backgroundColor);
    await page.locator('.pie-chart-slice').first().focus();
    await expect(page.getByRole('tooltip')).toContainText('72');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    await info.press('Enter');
    await expect(info).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('.pie-chart-slice')).toHaveCount(2);
    await expect(page.locator('.pie-chart-slice[data-label="WARN"]')).toHaveAttribute(
      'data-fraction',
      '0.75',
    );
    await page.getByRole('button', { name: 'WARN', exact: true }).press('Space');
    await page.getByRole('button', { name: 'ERROR', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('All slices are hidden');
    await info.press('Enter');
    await expect(page.locator('.pie-chart-slice')).toHaveCount(1);
    await expect(page.locator('.pie-chart-slice')).toHaveAttribute('data-fraction', '1');
    await expect(info.locator('.pie-chart-swatch')).toHaveCSS('background-color', colour);
    expect(
      (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
        .violations,
    ).toEqual([]);
  });
  test(`bubble keyboard navigation exposes point values and dismisses the tooltip in ${theme}`, async ({
    page,
  }) => {
    await page.goto('/iframe.html?id=metrics-bubblechart--grouped&viewMode=story');
    await expect(page.locator('.charts-bubble-point')).toHaveCount(18);
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    const plot = page.getByRole('group', { name: 'Bubble plot', exact: true });
    await plot.press('Home');
    await expect(page.locator('.charts-bubble-point').first()).toBeFocused();
    await expect(page.getByRole('tooltip')).toContainText('API');
    await expect(page.getByRole('tooltip')).toContainText('Bytes');
    await page.keyboard.press('End');
    await expect(page.locator('.charts-bubble-point').last()).toBeFocused();
    await expect(page.getByRole('tooltip')).toContainText('324');
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('.charts-bubble-point').nth(16)).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    expect(
      (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
        .violations,
    ).toEqual([]);
  });
}
