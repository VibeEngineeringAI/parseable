import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

for (const story of ['timer', 'slow-response', 'failure', 'recovery']) {
  test(`refresh ${story} story retains data and exposes its state`, async ({ page }) => {
    await page.clock.install();
    await page.goto(`/iframe.html?id=dashboards-refresh--${story}&viewMode=story`);
    const refresh = page.getByRole('button', { name: 'Refresh', exact: true });
    await expect(page.getByRole('group', { name: 'Requests value' })).toHaveText('42');
    await expect(refresh).toBeEnabled();
    await page.clock.pauseAt(new Date((await page.evaluate(() => Date.now())) + 1000));
    if (story === 'timer') {
      await page.getByLabel('Auto refresh').selectOption('15000');
      await page.clock.runFor(14_999);
      await expect(page.getByRole('group', { name: 'Requests value' })).toHaveText('42');
      await page.clock.runFor(1);
      await expect(refresh).toBeDisabled();
      await page.clock.runFor(200);
      await expect(page.getByRole('group', { name: 'Requests value' })).toHaveText('43');
    } else {
      await refresh.click();
      if (story === 'slow-response') {
        await page.clock.runFor(15_000);
        await expect(refresh).toBeDisabled();
        await expect(page.getByText('Refreshing tile…')).toBeVisible();
        await expect(page.getByRole('group', { name: 'Requests value' })).toHaveText('42');
        await page.clock.runFor(5_000);
        await expect(page.getByRole('group', { name: 'Requests value' })).toHaveText('43');
      } else {
        await page.clock.runFor(200);
        await expect(page.locator('.dashboard-tile-error')).toContainText('Refresh failed');
        await expect(page.getByRole('group', { name: 'Requests value' })).toHaveText('42');
        if (story === 'recovery') {
          await refresh.click();
          await page.clock.runFor(200);
          await expect(page.locator('.dashboard-tile-error')).toHaveCount(0);
          await expect(page.getByRole('group', { name: 'Requests value' })).toHaveText('44');
        }
      }
    }
    await page.getByLabel('Auto refresh').selectOption('0');
    await page.clock.resume();
    expect(
      (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
        .violations,
    ).toEqual([]);
  });
}
