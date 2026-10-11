import { test, expect } from '@playwright/test';

test('thresholds outside the data range are visible as horizontal canvas lines and named in the legend', async ({
  page,
}) => {
  await page.goto('/iframe.html?id=metrics-timeserieschart--with-thresholds&viewMode=story');
  await expect(page.getByText('Lower threshold: 2', { exact: true })).toBeVisible();
  await expect(page.getByText('Upper threshold: 6', { exact: true })).toBeVisible();
  const canvas = page.locator('.uplot canvas');
  await expect(canvas).toBeVisible();
  // Verify the actual reference strokes, including range expansion in both directions.
  // uPlot axes are also canvas pixels, so checking DOM text cannot prove the lines were drawn.
  await expect
    .poll(() =>
      canvas.evaluate((element: HTMLCanvasElement) => {
        const sample = document.createElement('canvas');
        const ctx = sample.getContext('2d')!;
        ctx.fillStyle = getComputedStyle(element).getPropertyValue('--color-warning').trim();
        ctx.fillRect(0, 0, 1, 1);
        const color = ctx.getImageData(0, 0, 1, 1).data;
        const { width, height } = element;
        const pixels = element.getContext('2d')!.getImageData(0, 0, width, height).data;
        const lines: number[] = [];
        for (let y = 0; y < height; y++) {
          let count = 0;
          for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            if (
              pixels[i + 3] > 0 &&
              [0, 1, 2].every((channel) => Math.abs(pixels[i + channel] - color[channel]) < 4)
            )
              count++;
          }
          if (count > width * 0.3 && (!lines.length || y - lines.at(-1)! > 3)) lines.push(y);
        }
        return lines.length === 2 && lines[0] < height * 0.35 && lines[1] > height * 0.55;
      }),
    )
    .toBe(true);
});
