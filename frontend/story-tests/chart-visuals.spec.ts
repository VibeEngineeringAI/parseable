import { test, expect } from '@playwright/test';

// Use fixed fixture data and viewport dimensions so a change to axes, chart geometry,
// legends, labels or theme colours produces a reviewable image diff in CI.
const stories = [
  ['grouped-bars', 'metrics-timeserieschart--grouped-bars', '.charts-figure'],
  ['stacked-bars', 'metrics-timeserieschart--signed-stacked-bars', '.charts-figure'],
  ['horizontal-bars', 'metrics-timeserieschart--horizontal-bars', '.charts-figure'],
  ['area', 'metrics-timeserieschart--area', '.charts-figure'],
  ['pie', 'dashboards-piechart--with-labels', '.pie-chart'],
  ['donut', 'dashboards-piechart--donut', '.pie-chart'],
  ['gauge', 'metrics-gaugechart--yellow', '.charts-gauge'],
  ['bubble', 'metrics-bubblechart--grouped', '.charts-bubble'],
  ['query-value', 'metrics-queryvalue--with-sparkline', '.dashboard-stat'],
  ['group-boundaries', 'dashboards-tilechart--colliding-group-labels', '.charts-figure'],
] as const;

test.use({
  viewport: { width: 1000, height: 800 },
  timezoneId: 'UTC',
  locale: 'en-US',
  reducedMotion: 'reduce',
});
for (const theme of ['light', 'dark']) {
  for (const [name, id, selector] of stories) {
    test(`${name} in ${theme}`, async ({ page }) => {
      await page.goto(`/iframe.html?id=${id}&viewMode=story`);
      const component = page.locator(selector);
      await expect(component).toBeVisible();
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
      }, theme);
      await page.evaluate(() => document.fonts.ready);
      await expect(component).toHaveScreenshot(`${name}-${theme}.png`, { animations: 'disabled' });
    });
  }
  test(`narrow grouped bars in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 700 });
    await page.goto('/iframe.html?id=metrics-timeserieschart--grouped-bars&viewMode=story');
    await expect(page.locator('.charts-figure')).toBeVisible();
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await page.evaluate(() => document.fonts.ready);
    await expect(page.locator('.charts-figure')).toHaveScreenshot(
      `grouped-bars-narrow-${theme}.png`,
      { animations: 'disabled' },
    );
  });
}
