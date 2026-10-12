import { expect, test, type Page } from '@playwright/test';

// Fixed fixtures, browser locale, time zone, viewport and theme make geometry,
// labels, selected states and colours reviewable in the pinned CI renderer.
test.use({ timezoneId: 'UTC', locale: 'en-US', reducedMotion: 'reduce' });

type VisualStory = {
  name: string;
  id: string;
  selector: string;
  prepare?: (page: Page) => Promise<void>;
};

const stories: VisualStory[] = [
  {
    name: 'span-waterfall',
    id: 'traces-explorer--detail',
    selector: '.traces-waterfall',
    prepare: async (page) => {
      await expect(page.getByRole('dialog', { name: 'Trace detail', exact: true })).toBeVisible();
      await expect(
        page.getByRole('region', { name: 'Span timing', exact: true }).getByRole('button'),
      ).toHaveCount(5);
      await page
        .getByRole('button', { name: 'create-order, checkout, 150 ms, Error', exact: true })
        .click();
      await expect(
        page
          .getByRole('region', { name: 'Span detail', exact: true })
          .getByRole('heading', { name: 'exception', exact: true }),
      ).toBeVisible();
      // Clicking near the bottom of the sheet can scroll the panel while fields
      // load. Start each image from the same waterfall position.
      await page.locator('.traces-waterfall').scrollIntoViewIfNeeded();
      await page.getByRole('textbox', { name: 'Search spans' }).blur();
      await page.evaluate(() => {
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      });
    },
  },
  {
    name: 'service-inventory',
    id: 'apm-serviceinventory--services',
    selector: '.apm-panel',
    prepare: async (page) => {
      await expect(page.getByRole('link', { name: 'checkout', exact: true })).toBeVisible();
    },
  },
  {
    name: 'directed-service-map',
    id: 'apm-servicemap--focused-service',
    selector: '.apm-map-section',
    prepare: async (page) => {
      await expect(
        page.getByRole('link', { name: 'Open checkout service insights', exact: true }),
      ).toHaveAttribute('aria-current', 'page');
    },
  },
  {
    name: 'ingestion-collector-setup',
    id: 'ingestion-setup--default',
    selector: '.ingestion-page',
    prepare: async (page) => {
      await page.getByRole('radio', { name: /^OpenTelemetry Collector/ }).check();
      await page.getByRole('combobox', { name: 'Signal', exact: true }).selectOption('traces');
      await page.getByRole('combobox', { name: 'Destination dataset' }).selectOption('otel_traces');
      await page
        .getByRole('textbox', { name: 'Public ingestion endpoint' })
        .fill('https://ingest.example.com/parseable');
      await expect(page.locator('pre[aria-label="collector.yaml"]')).toContainText(
        'pipelines:\n    traces:',
      );
    },
  },
];

for (const theme of ['light', 'dark'] as const) {
  for (const viewport of [
    { name: 'desktop', width: 1200, height: 900 },
    { name: 'narrow', width: 420, height: 850 },
  ]) {
    for (const { name, id, selector, prepare } of stories) {
      test(`${name} ${viewport.name} in ${theme}`, async ({ page }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.goto(`/iframe.html?id=${id}&viewMode=story`);
        const component = page.locator(selector);
        await expect(component).toBeVisible();
        await prepare?.(page);
        await page.evaluate((value) => {
          document.documentElement.dataset.theme = value;
        }, theme);
        await page.evaluate(async () => {
          await document.fonts.ready;
          await Promise.allSettled(document.getAnimations().map((animation) => animation.finished));
        });
        // Tables/timelines may scroll within their named region. The page itself
        // must stay usable at phone width, without hiding controls off-screen.
        if (viewport.name === 'narrow') {
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
            ),
          ).toBeLessThanOrEqual(1);
        }
        await expect(component).toHaveScreenshot(`${name}-${viewport.name}-${theme}.png`, {
          animations: 'disabled',
        });
      });
    }
  }
}
