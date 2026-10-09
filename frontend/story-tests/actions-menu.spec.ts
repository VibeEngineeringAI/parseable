import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('row menu opens with either arrow, skips disabled actions, wraps, selects and restores focus', async ({
  page,
}) => {
  await page.goto('/iframe.html?id=prism-actionsmenu--row-actions&viewMode=story');
  const trigger = page.getByRole('button', { name: 'Actions for Host load' });
  await trigger.focus();
  await trigger.press('ArrowDown');
  const evaluate = page.getByRole('menuitem', { name: 'Evaluate now' });
  await expect(evaluate).toBeFocused();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'Mute…' })).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.getByRole('menuitem', { name: 'Delete' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(evaluate).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status')).toHaveText('Evaluation requested');
  await expect(trigger).toBeFocused();
  await expect(page.getByRole('menu')).toHaveCount(0);
  await trigger.press('ArrowUp');
  await expect(page.getByRole('menuitem', { name: 'Delete' })).toBeFocused();
  await page.keyboard.press('Home');
  await expect(evaluate).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await trigger.press('Enter');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Next control' })).toBeFocused();
});

test('row menu supports pointer selection and outside dismissal, and passes axe while open', async ({
  page,
}) => {
  await page.goto('/iframe.html?id=prism-actionsmenu--row-actions&viewMode=story');
  const trigger = page.getByRole('button', { name: 'Actions for Host load' });
  await trigger.click();
  await expect(page.getByRole('menu', { name: 'Actions for Host load' })).toBeVisible();
  await trigger.click();
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  await page.getByRole('menuitem', { name: 'Mute…' }).click();
  await expect(trigger).toBeFocused();
  await expect(page.getByRole('status')).toHaveText('Mute selected');
  await trigger.click();
  await page.getByRole('button', { name: 'Next control' }).click();
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Next control' })).toBeFocused();
});
