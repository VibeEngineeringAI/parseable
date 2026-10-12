import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('switching a multi-field bar to stacked requires correction, then renders stacked bars after reload', async ({
  page,
}) => {
  await page.goto('/iframe.html?id=dashboards-tilechart--stacked-editor&viewMode=story');
  await page.getByLabel('Chart type').selectOption('stacked-bar');
  await expect(page.getByRole('status', { name: 'Binding validation' })).toContainText(
    'Stacked bar supports one Y column',
  );
  const save = page.getByRole('button', { name: 'Save and reload tile' });
  await expect(save).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Remove requests', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove errors', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Remove errors', exact: true }).click();
  await expect(page.getByLabel('Y axis', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Add Y axis', exact: true })).toBeDisabled();
  await expect(page.getByRole('status', { name: 'Binding validation' })).toHaveText(
    'Bindings valid',
  );
  await save.click();
  const chart = page.locator('.dashboard-chart');
  await expect(chart).toHaveAttribute('data-chart-kind', 'bar');
  await expect(chart).toHaveAttribute('data-stacked', 'true');
  await expect(page.locator('.charts-legend-item')).toHaveCount(2);
  await page.getByRole('img').press('ArrowRight');
  await expect(page.getByRole('tooltip').locator('strong')).toHaveText(['12', '6']);
});

test('bubble grouping keeps existing chips for correction and allows one replacement group', async ({
  page,
}) => {
  await page.goto('/iframe.html?id=dashboards-tilechart--bubble-editor&viewMode=story');
  await page.getByLabel('Chart type').selectOption('bubble');
  await expect(page.getByRole('status', { name: 'Binding validation' })).toContainText(
    'Bubble supports one Group by column',
  );
  const group = page.getByLabel('Group by', { exact: true });
  await expect(group).toBeDisabled();
  await expect(group).toHaveAccessibleDescription('One column splits the data into series.');
  await expect(page.getByRole('button', { name: 'Save and reload tile' })).toBeDisabled();
  await page.getByRole('button', { name: 'Remove region', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Binding validation' })).toHaveText(
    'Bindings valid',
  );
  await expect(group).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Add Group by', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Remove service', exact: true }).click();
  await group.fill('region');
  await group.press('Enter');
  await expect(
    page.getByRole('list', { name: 'Group by fields' }).getByRole('listitem'),
  ).toHaveCount(1);
  await page.getByRole('button', { name: 'Save and reload tile' }).click();
  await expect(page.getByRole('listitem', { name: 'east', exact: true })).toBeVisible();
  await expect(page.getByRole('listitem', { name: 'west', exact: true })).toBeVisible();
});

for (const variant of ['dashboard-range', 'absolute-tile-range', 'relative-tile-range']) {
  test(`zoom respects ${variant} while preserving keyboard exploration`, async ({ page }) => {
    await page.goto(`/iframe.html?id=dashboards-tilechart--${variant}&viewMode=story`);
    const chart = page.getByRole('img');
    const enabled = variant === 'dashboard-range';
    if (enabled) await expect(chart).toHaveAttribute('data-zoom-enabled', 'true');
    else await expect(chart).not.toHaveAttribute('data-zoom-enabled');
    await chart.press('ArrowRight');
    await chart.press('Shift+ArrowRight');
    await expect(page.getByRole('tooltip')).toBeVisible();
    await chart.press('Enter');
    await expect(page.getByLabel('Zoom count')).toHaveText(enabled ? '1' : '0');
    if (!enabled) {
      const box = (await page.locator('.u-over').boundingBox())!;
      await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2, { steps: 10 });
      await page.mouse.up();
      await expect(page.getByLabel('Zoom count')).toHaveText('0');
      await expect(page.getByText(/Zoomed to/)).toHaveCount(0);
    }
  });
}

test('identical display labels keep independent values and legend toggles', async ({ page }) => {
  await page.goto('/iframe.html?id=dashboards-tilechart--colliding-group-labels&viewMode=story');
  const legend = page.getByRole('button', { name: 'api | east | us', exact: true });
  await expect(legend).toHaveCount(2);
  const chart = page.getByRole('img');
  await chart.press('ArrowRight');
  await expect(page.getByRole('tooltip').locator('strong')).toHaveText(['3', '2']);
  await chart.press('ArrowRight');
  await expect(page.getByRole('tooltip').locator('strong')).toHaveText(['6', '4']);
  await legend.first().click();
  await expect(legend.first()).toHaveAttribute('aria-pressed', 'false');
  await expect(legend.last()).toHaveAttribute('aria-pressed', 'true');
  await chart.press('ArrowRight');
  await expect(page.getByRole('tooltip').locator('strong')).toHaveText(['3']);
  await chart.press('ArrowRight');
  await expect(page.getByRole('tooltip').locator('strong')).toHaveText(['6']);
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
});
