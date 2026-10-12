import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

for (const story of ['interactive', 'read-only']) {
  test(`${story} presentation preserves query state and respects child Escape`, async ({
    page,
  }) => {
    await page.goto(`/iframe.html?id=dashboards-presentation--${story}&viewMode=story`);
    const enter = page.getByRole('button', { name: 'Presentation mode', exact: true });
    const query = page.getByRole('textbox', { name: 'Query state', exact: true });
    await query.fill('SELECT 42 AS requests');
    await page.getByRole('button', { name: 'Refresh snapshot' }).click();
    await expect(page.getByLabel('Query revision')).toHaveText('2');
    const chart = page.getByTestId('canvas-chart');
    await chart.evaluate((element) => element.setAttribute('data-retained', 'yes'));
    await enter.click();
    const exit = page.getByRole('button', { name: 'Exit presentation', exact: true });
    await expect(exit).toBeFocused();
    await expect(enter).toBeHidden();
    await expect(page.getByRole('button', { name: 'Edit tile', exact: true })).toBeHidden();
    await expect(page.locator('aside')).toHaveAttribute('inert', '');
    await expect(chart).toHaveAttribute('data-retained', 'yes');
    await expect(query).toHaveValue('SELECT 42 AS requests');
    await query.focus();
    await page.keyboard.press('Escape');
    await expect(exit).toBeVisible();
    const select = page.getByRole('combobox', { name: 'Dataset', exact: true });
    await select.focus();
    await page.keyboard.press('Escape');
    await expect(exit).toBeVisible();
    await exit.focus();
    await page.keyboard.press('Escape');
    await expect(exit).toHaveCount(0);
    await expect(enter).toBeFocused();
    await expect(page.locator('aside')).not.toHaveAttribute('inert', '');
    await expect(query).toHaveValue('SELECT 42 AS requests');
    await expect(page.getByLabel('Query revision')).toHaveText('2');
    await expect(chart).toHaveAttribute('data-retained', 'yes');
  });
}

test('story PNG contains canvas, SVG and the final offscreen tile without editing chrome', async ({
  page,
}) => {
  await page.goto('/iframe.html?id=dashboards-presentation--interactive&viewMode=story');
  const root = page.getByTestId('dashboard-capture');
  await expect(page.getByTestId('canvas-chart')).toBeVisible();
  const dimensions = await root.evaluate((element) => ({
    width: Math.ceil(element.getBoundingClientRect().width),
    height: Math.ceil(element.scrollHeight),
  }));
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export PNG', exact: true }).click();
  const file = await downloaded;
  expect(file.suggestedFilename()).toBe('Operations snapshot.png');
  const data = (await readFile((await file.path())!)).toString('base64');
  const pixels = await page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(image, 0, 0);
    const pixel = (x: number, y: number) => [...ctx.getImageData(x, y, 1, 1).data];
    return {
      width: image.width,
      height: image.height,
      canvas: pixel(50, 350),
      svg: pixel(50, 550),
      last: pixel(50, 2450),
      chrome: pixel(image.width - 10, 10),
    };
  }, data);
  expect(pixels.width).toBe(dimensions.width * 2);
  expect(pixels.height).toBe(dimensions.height * 2);
  expect(pixels.canvas).toEqual([255, 0, 0, 255]);
  expect(pixels.svg).toEqual([0, 0, 255, 255]);
  expect(pixels.last).toEqual([255, 255, 0, 255]);
  expect(pixels.chrome).toEqual([255, 255, 255, 255]);
  await expect(page.locator('p[role="status"]')).toHaveText('Dashboard PNG downloaded.');
});
