import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

async function story(page: Page, component: 'promqleditor' | 'timeserieschart', name: string) {
  await page.goto(`/iframe.html?id=metrics-${component}--${name}&viewMode=story`);
  await expect(page.locator('#storybook-root')).not.toBeEmpty();
}

// While CodeMirror re-queries its completion sources (after Control+Space on a list that typing
// already opened) it keeps the old list on screen but ignores clicks on it: the tooltip carries
// `cm-tooltip-autocomplete-disabled` until the new result is accepted. Click only once it is live.
async function pickCompletion(page: Page, name: string | RegExp) {
  const option = page.getByRole('option', { name, exact: typeof name === 'string' });
  await expect(option).toBeVisible();
  await expect(page.locator('.cm-tooltip-autocomplete')).not.toHaveClass(
    /cm-tooltip-autocomplete-disabled/,
  );
  await option.click();
}

test('editor has an accessible name and placeholder, and Tab leaves it', async ({ page }) => {
  await story(page, 'promqleditor', 'empty');
  const editor = page.getByRole('textbox', { name: 'PromQL query', exact: true });
  await expect(editor).toBeVisible();
  await expect(
    page.getByText('e.g. rate({"http.server.requests"}[5m])', { exact: true }),
  ).toBeVisible();
  await editor.click();
  await editor.press('Tab');
  await expect(page.getByRole('button', { name: 'Next control' })).toBeFocused();
});

test('editor offers supported functions and quoted dotted metric completions', async ({ page }) => {
  await story(page, 'promqleditor', 'with-metadata');
  const editor = page.getByRole('textbox', { name: 'PromQL query', exact: true });
  await editor.fill('');
  await editor.pressSequentially('ra');
  await editor.press('Control+Space');
  await expect(page.getByRole('option', { name: /^ratefunction$/ })).toBeVisible();
  await editor.press('Escape');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await editor.fill('syst');
  await editor.press('Control+Space');
  await pickCompletion(page, 'system.cpu.load_average.1m');
  await expect(editor).toHaveText('{"system.cpu.load_average.1m"}');
  await editor.fill('system.cpu.l');
  await editor.press('Control+Space');
  await pickCompletion(page, 'system.cpu.load_average.1m');
  await expect(editor).toHaveText('{"system.cpu.load_average.1m"}');
  await editor.fill('{"syst"}');
  await editor.press('ArrowLeft');
  await editor.press('ArrowLeft');
  await editor.press('Control+Space');
  await pickCompletion(page, 'system.cpu.load_average.1m');
  await expect(editor).toHaveText('{"system.cpu.load_average.1m"}');
});

test('editor quotes dotted label names inside selectors', async ({ page }) => {
  await story(page, 'promqleditor', 'with-metadata');
  const editor = page.getByRole('textbox', { name: 'PromQL query', exact: true });
  await editor.fill('{"system.cpu.load_average.1m",ser');
  await editor.press('Control+Space');
  await pickCompletion(page, 'service.name');
  await expect(editor).toContainText('"service.name"');
  await editor.press('Escape');
  await page.keyboard.insertText('="gateway"}');
  await expect(editor).toHaveText('{"system.cpu.load_average.1m","service.name"="gateway"}');
  await editor.fill('{"system.cpu.load_average.1m","ser');
  await editor.press('Control+Space');
  await pickCompletion(page, 'service.name');
  await expect(editor).toHaveText('{"system.cpu.load_average.1m","service.name"');
});

test('unsupported functions are absent and Mod-Enter calls the run callback', async ({ page }) => {
  await story(page, 'promqleditor', 'empty');
  const editor = page.getByRole('textbox', { name: 'PromQL query', exact: true });
  await editor.click();
  await editor.press('Control+Space');
  await expect(page.getByRole('option', { name: /^ratefunction$/ })).toBeVisible();
  await expect(page.getByRole('option', { name: /histogram_quantile/ })).toHaveCount(0);
  await editor.press('Escape');
  await editor.press('ControlOrMeta+Enter');
  await expect(page.getByRole('status')).toHaveText('Run count: 1');
});

test('invalid editor associates its error and keeps the syntax linter enabled', async ({
  page,
}) => {
  await story(page, 'promqleditor', 'invalid');
  const editor = page.getByRole('textbox', { name: 'PromQL query', exact: true });
  await expect(editor).toHaveAttribute('aria-invalid', 'true');
  await expect(editor).toHaveAccessibleDescription('Enter a complete PromQL expression.');
  await expect(page.locator('.cm-lintRange-error').first()).toBeVisible();
});

test('chart figure and keyboard cursor expose values and Escape hides the tooltip', async ({
  page,
}) => {
  await story(page, 'timeserieschart', 'three-series');
  await expect(
    page.getByRole('figure', { name: 'PromQL range result', exact: true }),
  ).toBeVisible();
  const chart = page.getByRole('img', {
    name: /PromQL range result: 3 series from .* UTC to .* UTC/,
  });
  await chart.focus();
  await chart.press('ArrowRight');
  const tooltip = page.getByRole('tooltip');
  await expect(tooltip).toBeVisible();
  await expect(tooltip.locator('strong')).toHaveCount(3);
  await expect(tooltip.locator('strong').last()).toHaveText('2.5');
  await chart.press('ArrowRight');
  await expect(tooltip.locator('strong').last()).toHaveText('2.98');
  await chart.press('ArrowLeft');
  await expect(tooltip.locator('strong').last()).toHaveText('2.5');
  await chart.press('Escape');
  await expect(tooltip).toHaveCount(0);
});

test('legend toggle updates aria-pressed and the count, and Alt-click isolates', async ({
  page,
}) => {
  await story(page, 'timeserieschart', 'three-series');
  const alpha = page.getByRole('button', { name: '{host="alpha"}', exact: true });
  await expect(alpha).toHaveAttribute('aria-pressed', 'true');
  await alpha.click();
  await expect(alpha).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByText('2 of 3 series', { exact: true })).toBeVisible();
  await alpha.click({ modifiers: ['Alt'] });
  await expect(alpha).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('1 of 3 series', { exact: true })).toBeVisible();
});

test('requested range leaves space before and after samples without repeating a card title', async ({
  page,
}) => {
  await story(page, 'timeserieschart', 'requested-range');
  await expect(page.locator('.charts-title')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '{host="alpha"}', exact: true })).toBeVisible();
  const chart = page.getByRole('img', { name: /PromQL range result: 1 series/ });
  await chart.focus();
  await chart.press('ArrowRight');
  const cursor = page.locator('.u-cursor-x');
  const plot = (await page.locator('.u-over').boundingBox())!;
  // The first sample is 10 minutes into the requested hour; the last is 21 minutes in.
  // Cursor positions verify the actual x scale, rather than only its accessible label.
  await expect
    .poll(async () => Math.abs((await cursor.boundingBox())!.x - plot.x - plot.width / 6))
    .toBeLessThanOrEqual(1);
  for (let index = 0; index < 11; index++) await chart.press('ArrowRight');
  await expect
    .poll(async () => Math.abs((await cursor.boundingBox())!.x - plot.x - plot.width * 0.35))
    .toBeLessThanOrEqual(1);
  await expect(page.getByRole('tooltip').locator('time')).toHaveAttribute(
    'datetime',
    new Date((1_700_000_000 + 660) * 1000).toISOString(),
  );
});

test('chart draws the 20 highest-peaking series and keeps colours when showing all 25', async ({
  page,
}) => {
  await story(page, 'timeserieschart', 'many-series');
  await expect(page.getByText('20 of 25 series', { exact: true })).toBeVisible();
  const legend = page.locator('.charts-legend-item');
  await expect(legend).toHaveCount(20);
  // Peaks rise with the node number, so node-1..5 are the ones left out.
  await expect(page.getByRole('button', { name: '{host="node-5"}', exact: true })).toHaveCount(0);
  const topKey = page
    .getByRole('button', { name: '{host="node-25"}', exact: true })
    .locator('.charts-line-key');
  await expect(topKey).toHaveCSS('border-top-color', 'rgb(42, 120, 214)');
  const eighthKey = page
    .getByRole('button', { name: '{host="node-18"}', exact: true })
    .locator('.charts-line-key');
  await expect(eighthKey).toHaveCSS('border-top-color', 'rgb(227, 73, 72)');
  const ninthKey = page
    .getByRole('button', { name: '{host="node-17"}', exact: true })
    .locator('.charts-line-key');
  await expect(ninthKey).toHaveCSS('border-top-color', 'rgb(199, 203, 215)');
  await page.getByRole('button', { name: 'Show all 25', exact: true }).click();
  await expect(page.getByText('25 series', { exact: true })).toBeVisible();
  await expect(legend).toHaveCount(25);
  await expect(topKey).toHaveCSS('border-top-color', 'rgb(42, 120, 214)');
  await expect(eighthKey).toHaveCSS('border-top-color', 'rgb(227, 73, 72)');
  await page.getByRole('button', { name: '{host="node-24"}', exact: true }).click();
  await expect(topKey).toHaveCSS('border-top-color', 'rgb(42, 120, 214)');
  await page.getByRole('button', { name: 'Show top 20', exact: true }).click();
  await expect(page.getByText('19 of 25 series', { exact: true })).toBeVisible();
  await expect(legend).toHaveCount(20);
});

test('null and non-finite samples stay missing in the tooltip', async ({ page }) => {
  await story(page, 'timeserieschart', 'gaps-and-na-n');
  const chart = page.getByRole('img', { name: /PromQL range result: 2 series/ });
  await chart.focus();
  await chart.press('ArrowRight');
  await chart.press('ArrowRight');
  await chart.press('ArrowRight');
  await expect(page.getByRole('tooltip').locator('strong')).toHaveText(['-', '-']);
});

test('theme changes recolour the chart without reloading', async ({ page }) => {
  await story(page, 'timeserieschart', 'dark-theme');
  const key = page
    .getByRole('button', { name: '{host="gamma"}', exact: true })
    .locator('.charts-line-key');
  await expect(key).toHaveCSS('border-top-color', 'rgb(57, 135, 229)');
  await page
    .locator('.uplot')
    .evaluate((element) => element.setAttribute('data-previous-instance', 'true'));
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light';
  });
  await expect(key).toHaveCSS('border-top-color', 'rgb(42, 120, 214)');
  await expect(page.locator('.uplot')).not.toHaveAttribute('data-previous-instance');
});

test('empty chart reserves its height and shows No data', async ({ page }) => {
  await story(page, 'timeserieschart', 'empty');
  await expect(page.getByText('No data', { exact: true })).toBeVisible();
  await expect(page.locator('.charts-plot-box')).toHaveCSS('height', '280px');
  await expect(page.locator('canvas')).toHaveCount(0);
});

test('inline thresholds and ranges retain the plot across renders and update when their values change', async ({
  page,
}) => {
  await story(page, 'timeserieschart', 'rerendering');
  const plot = page.locator('.uplot');
  await expect(plot).toBeVisible();
  await plot.evaluate((element) => element.setAttribute('data-retained', 'true'));
  await page.getByRole('button', { name: 'Render again' }).click();
  await expect(page.getByRole('status')).toHaveText('Render 1');
  await expect(plot).toHaveAttribute('data-retained', 'true');
  await page.getByRole('button', { name: 'Raise threshold' }).click();
  await expect(page.locator('.charts-thresholds')).toHaveText('Threshold: 3');
  await expect(plot).not.toHaveAttribute('data-retained');
  await plot.evaluate((element) => element.setAttribute('data-retained', 'true'));
  await page.getByRole('button', { name: 'Extend range' }).click();
  await expect(plot).not.toHaveAttribute('data-retained');
});

for (const [component, name] of [
  ['promqleditor', 'empty'],
  ['promqleditor', 'with-metadata'],
  ['promqleditor', 'invalid'],
  ['timeserieschart', 'three-series'],
  ['timeserieschart', 'requested-range'],
  ['timeserieschart', 'with-thresholds'],
  ['timeserieschart', 'many-series'],
  ['timeserieschart', 'gaps-and-na-n'],
  ['timeserieschart', 'empty'],
  ['timeserieschart', 'dark-theme'],
] as const) {
  test(`WCAG accessibility: ${component}/${name}`, async ({ page }) => {
    await story(page, component, name);
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    expect(result.violations).toEqual([]);
  });
}

test('WCAG accessibility: timeserieschart/with-thresholds in dark', async ({ page }) => {
  await story(page, 'timeserieschart', 'with-thresholds');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
  });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.evaluate(async () => {
    await Promise.allSettled(document.getAnimations().map((animation) => animation.finished));
  });
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
});
