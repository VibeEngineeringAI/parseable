import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('PNG preserves canvas, SVG and tiles below the viewport', async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem('parseable-mode', 'demo'));
  await page.goto('/dashboards');
  await expect(page.getByRole('heading', { name: 'Dashboards', exact: true })).toBeVisible();
  const downloaded = page.waitForEvent('download');
  await page.evaluate(async () => {
    const root = document.createElement('div');
    root.style.cssText =
      'width:400px;height:200px;overflow:auto;background:white;position:fixed;inset:0;z-index:9999';
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 100;
    canvas.style.display = 'block';
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#ff0000';
    context.fillRect(0, 0, 100, 100);
    root.append(canvas);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '100');
    svg.setAttribute('height', '100');
    svg.style.display = 'block';
    svg.innerHTML = '<rect width="100" height="100" fill="#0000ff"/>';
    root.append(svg);
    const bottom = document.createElement('div');
    bottom.style.cssText = 'height:600px;background:#ffff00';
    root.append(bottom);
    document.body.append(root);
    const modulePath = '/src/features/dashboards/exportPng.ts';
    const { downloadDashboardPng } = await import(/* @vite-ignore */ modulePath);
    await downloadDashboardPng(root, 'Charts / full height');
    root.remove();
  });
  const file = await downloaded;
  expect(file.suggestedFilename()).toBe('Charts - full height.png');
  const png = await readFile((await file.path())!);
  const actual = await page.evaluate(async (data) => {
    const image = new Image();
    image.src = `data:image/png;base64,${data}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(image, 0, 0);
    const pixel = (y: number) => [...ctx.getImageData(50, y, 1, 1).data];
    return {
      width: image.width,
      height: image.height,
      red: pixel(50),
      blue: pixel(250),
      bottom: pixel(1500),
    };
  }, png.toString('base64'));
  expect(actual).toEqual({
    width: 800,
    height: 1600,
    red: [255, 0, 0, 255],
    blue: [0, 0, 255, 255],
    bottom: [255, 255, 0, 255],
  });
});

test('presentation hides editing and shell, keeps charts mounted and restores focus', async ({
  page,
}) => {
  await page.addInitScript(() => sessionStorage.setItem('parseable-mode', 'demo'));
  await page.goto('/dashboards');
  await expect(page.getByRole('heading', { name: 'Dashboards', exact: true })).toBeVisible();
  await page.locator('.dashboards-title a').first().click();
  const menu = page.getByRole('button', { name: 'Dashboard actions', exact: true });
  await expect(menu).toBeVisible();
  await page
    .locator('[data-tile-id][aria-busy="true"]')
    .waitFor({ state: 'detached' })
    .catch(() => {});
  const tiles = page.locator('[data-tile-id]');
  await expect(tiles.first()).toBeVisible();
  await tiles.first().evaluate((element) => element.setAttribute('data-state-preserved', 'yes'));
  await menu.click();
  await page.getByRole('menuitem', { name: 'Presentation mode', exact: true }).click();
  const exit = page.getByRole('button', { name: 'Exit presentation', exact: true });
  await expect(exit).toBeFocused();
  await expect(menu).toBeHidden();
  await expect(page.locator('.dashboard-breadcrumb')).toBeHidden();
  await expect(page.locator('.dashboard-presentation')).toBeVisible();
  expect(await page.locator('[inert]').count()).toBeGreaterThan(0);
  await expect(tiles.first()).toHaveAttribute('data-state-preserved', 'yes');
  await exit.evaluate((element) =>
    element.addEventListener('keydown', (event) => event.preventDefault(), { once: true }),
  );
  await page.keyboard.press('Escape');
  await expect(exit).toBeVisible();
  await expect(exit).toBeFocused();
  await exit.evaluate((element) => {
    const select = document.createElement('select');
    element.parentElement!.append(select);
    select.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    select.remove();
  });
  await expect(exit).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(exit).toBeHidden();
  await expect(menu).toBeVisible();
  await expect(menu).toBeFocused();
  await expect(tiles.first()).toHaveAttribute('data-state-preserved', 'yes');
  await menu.click();
  const downloaded = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: /^Export PNG/ }).click();
  const file = await downloaded;
  expect(file.suggestedFilename()).toMatch(/\.png$/);
  expect((await readFile((await file.path())!)).byteLength).toBeGreaterThan(1000);
  await expect(page.getByText('Dashboard PNG downloaded.', { exact: true })).toBeVisible();
});
