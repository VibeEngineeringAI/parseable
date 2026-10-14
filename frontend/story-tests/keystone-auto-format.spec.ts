import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import {
  autoFormatHundredFixture,
  autoFormatPinnedConflictFixture,
  autoFormatSprawlFixture,
} from '../src/features/keystone/fixtures/synthetic';
import type { RecordedRequest } from '../src/features/keystone/fixtures/storyHarness';
import type { GraphNode, LayoutPatch, NodeGeometry } from '../src/lib/keystone/types';

type Rectangle = Pick<NodeGeometry, 'x' | 'y' | 'width' | 'height'>;
type Rectangles = Record<string, Rectangle>;

async function frames(page: Page, count = 2) {
  await page.evaluate(
    (count) =>
      new Promise<void>((resolve) => {
        const next = () => (--count <= 0 ? resolve() : requestAnimationFrame(next));
        requestAnimationFrame(next);
      }),
    count,
  );
}

async function open(page: Page, story: string, count = 10) {
  await page.goto(`/iframe.html?id=keystone-workspace--${story}&viewMode=story`);
  await expect(page.getByTestId('ks-workspace')).toHaveAttribute('data-state', 'ready');
  await expect(page.locator('.react-flow__node')).toHaveCount(count);
  await frames(page, 3);
}

async function geometry(page: Page): Promise<Rectangles> {
  return page.locator('.react-flow__node').evaluateAll((nodes) =>
    Object.fromEntries(
      nodes.map((element) => {
        const node = element as HTMLElement;
        const coordinates = node.style.transform.match(
          /^translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)$/,
        );
        if (!coordinates) throw new Error(`Missing flow position for ${node.dataset.id}`);
        return [
          node.dataset.id!,
          {
            x: Number(coordinates[1]),
            y: Number(coordinates[2]),
            width: Number.parseFloat(node.style.width),
            height: Number.parseFloat(node.style.height),
          },
        ];
      }),
    ),
  );
}

function collisions(rectangles: Rectangles) {
  const entries = Object.entries(rectangles);
  const result: string[] = [];
  for (let left = 0; left < entries.length; left++) {
    for (let right = left + 1; right < entries.length; right++) {
      const [aId, a] = entries[left],
        [bId, b] = entries[right];
      if (
        a.x < b.x + b.width &&
        a.x + a.width > b.x &&
        a.y < b.y + b.height &&
        a.y + a.height > b.y
      )
        result.push([aId, bId].sort().join(':'));
    }
  }
  return result.sort();
}

function dimensions(rectangles: Rectangles) {
  return Object.fromEntries(
    Object.entries(rectangles).map(([id, rectangle]) => [
      id,
      {
        width: rectangle.width,
        height: rectangle.height,
      },
    ]),
  );
}

function extent(rectangles: Rectangles) {
  const values = Object.values(rectangles);
  const width =
    Math.max(...values.map((node) => node.x + node.width)) -
    Math.min(...values.map((node) => node.x));
  const height =
    Math.max(...values.map((node) => node.y + node.height)) -
    Math.min(...values.map((node) => node.y));
  return { width, height, area: width * height };
}

function edgeExtent(nodes: GraphNode[], rectangles: Rectangles) {
  return nodes.reduce((total, node) => {
    if (!node.parentId) return total;
    const parent = rectangles[node.parentId],
      child = rectangles[node.id];
    return (
      total +
      Math.abs(child.x - parent.x - parent.width) +
      Math.abs(child.y + child.height / 2 - parent.y - parent.height / 2)
    );
  }, 0);
}

async function requests(page: Page): Promise<RecordedRequest[]> {
  return page.evaluate(() => window.__ksRequests ?? []);
}

async function writes(page: Page) {
  return (await requests(page)).filter((request) => request.kind === 'layout.patch');
}

async function camera(page: Page) {
  return page.evaluate(() => window.__ksFixture!.viewport());
}

async function semantics(page: Page) {
  return page.locator('.ks-card').evaluateAll((cards) =>
    cards
      .map((card) => ({
        id: card.getAttribute('data-testid'),
        status: card.getAttribute('data-status'),
        intent: card.getAttribute('data-intent'),
        prompt: card.querySelector('.ks-card-prompt')?.textContent,
        answer: card.querySelector('.ks-card-answer')?.textContent,
        title: card.querySelector('.ks-card-title')?.textContent,
        scope: card.querySelector('.ks-card-footer')?.textContent,
      }))
      .sort((a, b) => a.id!.localeCompare(b.id!)),
  );
}

async function preview(page: Page) {
  await expect(page.getByTestId('ks-workspace')).toHaveAttribute('data-format-preview', 'true');
  await expect(page.getByTestId('ks-layout-status')).toHaveAttribute('data-state', 'preview');
  await expect(page.getByTestId('ks-save-layout')).toBeEnabled();
  await frames(page);
}

async function saved(page: Page) {
  await expect(page.getByTestId('ks-layout-status')).toHaveAttribute('data-state', 'saved');
  await expect(page.getByTestId('ks-save-layout')).toHaveCount(0);
}

async function recordMetrics(
  testInfo: TestInfo,
  before: Rectangles,
  after: Rectangles,
  nodes: GraphNode[],
  elapsedMs: number,
) {
  const path = testInfo.outputPath('auto-format-metrics.json');
  await writeFile(
    path,
    JSON.stringify(
      {
        advisoryTiming: true,
        actionToSettledGeometryMs: elapsedMs,
        timingIncludes:
          'Playwright action, two animation frames, DOM snapshot and trace instrumentation',
        nodeCount: nodes.length,
        beforeExtent: extent(before),
        afterExtent: extent(after),
        beforeEdgeExtent: edgeExtent(nodes, before),
        afterEdgeExtent: edgeExtent(nodes, after),
        beforeOverlaps: collisions(before),
        afterOverlaps: collisions(after),
        before,
        after,
      },
      null,
      2,
    ),
  );
  await testInfo.attach('auto-format-metrics.json', { path, contentType: 'application/json' });
}

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  (page as Page & { ksErrors?: string[] }).ksErrors = errors;
});
test.afterEach(async ({ page }, testInfo) => {
  const path = testInfo.outputPath('fixture-requests.json');
  await writeFile(path, JSON.stringify(await requests(page), null, 2));
  await testInfo.attach('fixture-requests.json', { path, contentType: 'application/json' });
  expect((page as Page & { ksErrors?: string[] }).ksErrors).toEqual([]);
});

test('Auto format previews compact size-aware geometry; Save persists once and Undo restores exactly', async ({
  page,
}, testInfo) => {
  await open(page, 'auto-format-sprawl');
  const fixture = autoFormatSprawlFixture();
  const original = await geometry(page),
    originalSemantics = await semantics(page);
  expect(collisions(original).length).toBeGreaterThan(0);
  await page.waitForTimeout(1000);
  await page.screenshot({ path: testInfo.outputPath('auto-format-before.png'), fullPage: true });
  const originalCamera = await camera(page);
  const selection = await page.getByTestId('ks-workspace').getAttribute('data-selected');
  const revision = await page.getByTestId('ks-workspace').getAttribute('data-semantic-revision');
  const format = page.getByTestId('ks-auto-layout');
  await format.focus();
  const formatStarted = Date.now();
  await format.press('Enter');
  await preview(page);
  const formatted = await geometry(page);
  await recordMetrics(
    testInfo,
    original,
    formatted,
    fixture.graph.nodes,
    Date.now() - formatStarted,
  );
  expect(collisions(formatted)).toEqual([]);
  expect(dimensions(formatted)).toEqual(dimensions(original));
  expect(extent(formatted).area).toBeLessThan(extent(original).area * 0.4);
  expect(edgeExtent(fixture.graph.nodes, formatted)).toBeLessThan(
    edgeExtent(fixture.graph.nodes, original) * 0.6,
  );
  expect(await camera(page)).toEqual(originalCamera);
  await expect(format).toBeFocused();
  await expect(page.getByTestId('ks-workspace')).toHaveAttribute('data-selected', selection!);
  await expect(page.getByTestId('ks-workspace')).toHaveAttribute(
    'data-semantic-revision',
    revision!,
  );
  expect(await semantics(page)).toEqual(originalSemantics);
  await page.waitForTimeout(1000); // Longer than the drag autosave debounce; preview must stay local.
  expect(await writes(page)).toEqual([]);
  await format.press('Enter');
  await frames(page);
  expect(await geometry(page)).toEqual(formatted);
  expect(await camera(page)).toEqual(originalCamera);
  // An explicit user camera action makes the compact overview readable in the demo.
  await page.getByRole('button', { name: /^fit view$/i }).click();
  await frames(page, 3);
  await page.waitForTimeout(1000);
  await page.screenshot({ path: testInfo.outputPath('auto-format-after.png'), fullPage: true });
  await page.getByTestId('ks-save-layout').click();
  await saved(page);
  await expect(format).toBeFocused();
  const patches = await writes(page);
  expect(patches).toHaveLength(1);
  const patch = patches[0].body as LayoutPatch;
  expect(patch.expectedLayoutRevision).toBe(7);
  expect(Object.keys(patch).sort()).toEqual(['expectedLayoutRevision', 'nodes']);
  for (const [id, value] of Object.entries(patch.nodes))
    expect(value).toEqual({ ...formatted[id], pinned: false });
  await page.getByTestId('ks-undo-layout').click();
  await expect.poll(() => geometry(page)).toEqual(original);
  await saved(page);
  expect(await writes(page)).toHaveLength(2);
  expect(await semantics(page)).toEqual(originalSemantics);
  expect((await requests(page)).filter((request) => request.startsRun)).toEqual([]);
});

test('100 variable-size cards format without overlaps or drift and preserve semantics', async ({
  page,
}, testInfo) => {
  await open(page, 'auto-format-hundred', 100);
  const fixture = autoFormatHundredFixture();
  const original = await geometry(page),
    originalSemantics = await semantics(page),
    originalCamera = await camera(page);
  const formatStarted = Date.now();
  await page.getByTestId('ks-auto-layout').click();
  await preview(page);
  const formatted = await geometry(page);
  await recordMetrics(
    testInfo,
    original,
    formatted,
    fixture.graph.nodes,
    Date.now() - formatStarted,
  );
  expect(Object.keys(formatted)).toHaveLength(100);
  expect(collisions(formatted)).toEqual([]);
  expect(dimensions(formatted)).toEqual(dimensions(original));
  expect(extent(formatted).area).toBeLessThan(extent(original).area * 0.5);
  expect(edgeExtent(fixture.graph.nodes, formatted)).toBeLessThan(
    edgeExtent(fixture.graph.nodes, original) * 0.5,
  );
  await page.getByTestId('ks-auto-layout').click();
  await frames(page);
  expect(await geometry(page)).toEqual(formatted);
  expect(await camera(page)).toEqual(originalCamera);
  expect(await semantics(page)).toEqual(originalSemantics);
  expect(await writes(page)).toEqual([]);
  await page.getByTestId('ks-save-layout').click();
  await saved(page);
  expect(await writes(page)).toHaveLength(1);
  expect((await requests(page)).filter((request) => request.startsRun)).toEqual([]);
});

test('overlapping pinned cards stay fixed, report a conflict, and never overlap movable cards', async ({
  page,
}) => {
  await open(page, 'auto-format-pinned-conflict');
  const fixture = autoFormatPinnedConflictFixture();
  const original = await geometry(page);
  await page.getByTestId('ks-auto-layout').click();
  await preview(page);
  const formatted = await geometry(page);
  expect(formatted['n-root']).toEqual(original['n-root']);
  expect(formatted['n-pay']).toEqual(original['n-pay']);
  expect(collisions(formatted)).toEqual(['n-pay:n-root']);
  await expect(page.getByTestId('ks-pinned-conflicts')).toHaveAttribute('data-count', '2');
  await expect(page.getByTestId('ks-pinned-conflicts')).toContainText('2 pinned cards overlap');
  await page.getByTestId('ks-save-layout').click();
  await saved(page);
  const patches = await writes(page);
  expect(patches).toHaveLength(1);
  const patch = patches[0].body as LayoutPatch;
  for (const id of ['n-root', 'n-pay']) {
    if (patch.nodes[id]) expect(patch.nodes[id]).toEqual(fixture.layout!.nodes[id]);
  }
  expect((await requests(page)).filter((request) => request.startsRun)).toEqual([]);
});

test('streaming updates answers without formatting either saved or previewed geometry', async ({
  page,
}) => {
  await open(page, 'auto-format-streaming', 11);
  const original = await geometry(page),
    originalCamera = await camera(page);
  for (let event = 0; event < 6; event++) {
    await page.evaluate(() => window.__ksFixture!.stream.step());
    await frames(page);
    expect(await geometry(page)).toEqual(original);
    expect(await camera(page)).toEqual(originalCamera);
  }
  await expect(page.getByTestId('ks-save-layout')).toHaveCount(0);
  await page.getByTestId('ks-auto-layout').click();
  await preview(page);
  const formatted = await geometry(page);
  expect(collisions(formatted)).toEqual([]);
  while ((await page.evaluate(() => window.__ksFixture!.stream.step())) !== null) {
    await frames(page);
    expect(await geometry(page)).toEqual(formatted);
    expect(await camera(page)).toEqual(originalCamera);
  }
  await expect(page.getByTestId('ks-stream-status')).toHaveAttribute('data-applied', '12');
  await expect(page.getByTestId('ks-node-n-stream')).toHaveAttribute('data-status', 'completed');
  await expect(page.getByTestId('ks-workspace')).toHaveAttribute('data-selected', 'n-root');
  await expect(page.getByTestId('ks-auto-layout')).toBeFocused();
  expect(await writes(page)).toEqual([]);
  expect((await requests(page)).filter((request) => request.startsRun)).toEqual([]);
});

test('format suspends a queued move autosave and Undo resumes only that original move', async ({
  page,
}) => {
  await open(page, 'ten-nodes');
  await page.getByTestId('ks-jump').click();
  await page.waitForTimeout(250);
  const node = page.locator('.react-flow__node[data-id="n-root"]');
  const original = await geometry(page);
  await node.press('ArrowRight');
  await expect.poll(() => geometry(page)).not.toEqual(original);
  const moved = await geometry(page);
  expect(await writes(page)).toEqual([]);
  // Trigger immediately, before the 300 ms move autosave, without click animation waits.
  await page.getByTestId('ks-auto-layout').evaluate((button: HTMLElement) => button.click());
  await preview(page);
  await page.waitForTimeout(700);
  expect(await writes(page)).toEqual([]);
  await page.getByTestId('ks-undo-layout').click();
  await expect.poll(() => geometry(page)).toEqual(moved);
  await saved(page);
  const patches = await writes(page);
  expect(patches).toHaveLength(1);
  const patch = patches[0].body as LayoutPatch;
  expect(Object.keys(patch.nodes)).toEqual(['n-root']);
  expect(patch.nodes['n-root']).toEqual({ ...moved['n-root'], pinned: false });
  expect((await requests(page)).filter((request) => request.startsRun)).toEqual([]);
});

test('in-flight writes block formatting and preview edits; manual moves invalidate saved Undo', async ({
  page,
}) => {
  await open(page, 'ten-nodes');
  await page.getByTestId('ks-jump').click();
  await page.waitForTimeout(250);
  const node = page.locator('.react-flow__node[data-id="n-root"]');
  await page.evaluate(() => window.__ksFixture!.layoutWrites.hold());
  await node.press('ArrowRight');
  await expect.poll(() => page.evaluate(() => window.__ksFixture!.layoutWrites.pending())).toBe(1);
  await expect(page.getByTestId('ks-auto-layout')).toBeDisabled();
  await page.getByTestId('ks-auto-layout').evaluate((button: HTMLElement) => button.click());
  await expect(page.getByTestId('ks-save-layout')).toHaveCount(0);
  await page.evaluate(() => window.__ksFixture!.layoutWrites.release());
  await saved(page);
  await page.getByTestId('ks-auto-layout').click();
  await preview(page);
  const formatted = await geometry(page);
  await page.evaluate(() => window.__ksFixture!.layoutWrites.hold());
  await page.getByTestId('ks-save-layout').click();
  await expect.poll(() => page.evaluate(() => window.__ksFixture!.layoutWrites.pending())).toBe(1);
  await expect(page.getByTestId('ks-save-layout')).toBeDisabled();
  await expect(page.getByTestId('ks-auto-layout')).toBeDisabled();
  await expect(page.getByTestId('ks-undo-layout')).toBeDisabled();
  await expect(page.getByTestId('ks-canvas')).toHaveAttribute('data-editable', 'false');
  await node.press('ArrowRight');
  expect(await geometry(page)).toEqual(formatted);
  expect(await writes(page)).toHaveLength(2);
  await page.evaluate(() => window.__ksFixture!.layoutWrites.release());
  await saved(page);
  await expect(page.getByTestId('ks-undo-layout')).toBeEnabled();
  await node.press('ArrowRight');
  await saved(page);
  await expect(page.getByTestId('ks-undo-layout')).toBeDisabled();
  expect((await requests(page)).filter((request) => request.startsRun)).toEqual([]);
});
