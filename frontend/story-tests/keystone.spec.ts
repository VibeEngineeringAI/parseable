import { expect, test, type Locator, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import type { RecordedRequest } from '../src/features/keystone/fixtures/storyHarness';
import type { CreateNodeRequest, LayoutPatch } from '../src/lib/keystone/types';

const pageErrors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(error.message));
});
test.afterEach(async ({ page }, testInfo) => {
  const recorded = await requests(page);
  const path = testInfo.outputPath('fixture-requests.json');
  await writeFile(path, JSON.stringify(recorded, null, 2));
  await testInfo.attach('fixture-requests.json', {
    path,
    contentType: 'application/json',
  });
  expect(pageErrors.get(page) ?? []).toEqual([]);
});

async function frames(page: Page, count = 2) {
  await page.evaluate(
    (count) =>
      new Promise<void>((resolve) => {
        const step = () => (--count <= 0 ? resolve() : requestAnimationFrame(step));
        requestAnimationFrame(step);
      }),
    count,
  );
}

async function drag(page: Page, target: Locator, dx: number, dy: number) {
  const box = await target.boundingBox();
  expect(box).not.toBeNull();
  const x = box!.x + box!.width / 2;
  const y = box!.y + box!.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 15 });
  await page.mouse.up();
  await frames(page);
}

async function viewport(page: Page) {
  return page.locator('.react-flow__viewport').getAttribute('style');
}

function observeMutations(page: Page) {
  const mutations: string[] = [];
  page.on('request', (request) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method()))
      mutations.push(`${request.method()} ${request.url()}`);
  });
  return mutations;
}

type FrameRecorder = { intervals: number[]; last: number | null; running: boolean };

async function startFrames(page: Page) {
  await page.evaluate(() => {
    const recorder: FrameRecorder = { intervals: [], last: null, running: true };
    (window as unknown as { __ksFrames: FrameRecorder }).__ksFrames = recorder;
    const tick = (time: number) => {
      if (!recorder.running) return;
      if (recorder.last !== null) recorder.intervals.push(time - recorder.last);
      recorder.last = time;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function stopFrames(page: Page) {
  return page.evaluate(() => {
    const recorder = (window as unknown as { __ksFrames: FrameRecorder }).__ksFrames;
    recorder.running = false;
    const sorted = [...recorder.intervals].sort((a, b) => a - b);
    return {
      frames: sorted.length,
      p95Ms: sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? null,
      over50Ms: sorted.filter((interval) => interval > 50).length,
      maximumMs: sorted.at(-1) ?? null,
      intervalsMs: recorder.intervals,
    };
  });
}

async function openReady(page: Page, storyId: string) {
  await page.goto(`/iframe.html?id=${storyId}&viewMode=story`);
  await expect(page.getByTestId('ks-workspace')).toHaveAttribute('data-state', 'ready');
  await frames(page, 3);
}

async function selectedNode(page: Page) {
  const id = await page.getByTestId('ks-workspace').getAttribute('data-selected');
  expect(id).toBeTruthy();
  return id!;
}

async function flowGeometry(page: Page, id: string) {
  return page.locator(`.react-flow__node[data-id="${id}"]`).evaluate((node) => ({
    transform: (node as HTMLElement).style.transform,
    width: (node as HTMLElement).style.width,
    height: (node as HTMLElement).style.height,
  }));
}

async function selectAnswerText(page: Page, id: string) {
  const answer = page.getByTestId(`ks-node-body-${id}`).locator('.ks-card-answer');
  const coordinates = await answer.evaluate((paragraph) => {
    const text = paragraph.firstChild;
    if (!text) throw new Error('Fixture answer has no text');
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, Math.min(text.textContent?.length ?? 0, 20));
    const boxes = Array.from(range.getClientRects());
    if (!boxes.length) throw new Error('Fixture answer has no visible text bounds');
    const first = boxes[0];
    return { x: first.x + 1, y: first.y + first.height / 2, end: first.right - 1 };
  });
  await page.mouse.move(coordinates.x, coordinates.y);
  await page.mouse.down();
  await page.mouse.move(coordinates.end, coordinates.y, { steps: 12 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).not.toBe('');
}

async function pan(page: Page, dx: number, dy: number) {
  const box = await page.getByTestId('ks-canvas').boundingBox();
  expect(box).not.toBeNull();
  // A gutter above the cards avoids capturing a node header or answer body.
  const x = box!.x + box!.width * 0.55;
  const y = box!.y + 8;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 20 });
  await page.mouse.up();
  await frames(page);
}

async function requests(page: Page): Promise<RecordedRequest[]> {
  return page.evaluate(() => window.__ksRequests ?? []);
}

async function saved(page: Page) {
  await expect(page.getByTestId('ks-layout-status')).toHaveAttribute('data-state', 'saved');
}

async function showSelected(page: Page) {
  await page.getByTestId('ks-jump').click();
  // The ordinary camera move lasts 200 ms; wait for its final frame before a gate.
  await page.waitForTimeout(250);
  await frames(page);
}

test('header drag, answer selection, resize, pan and zoom change presentation only', async ({
  page,
}) => {
  const networkMutations = observeMutations(page);
  await openReady(page, 'keystone-workspace--ten-nodes');
  await showSelected(page);
  const id = await selectedNode(page);
  const semantic = await page.getByTestId('ks-workspace').getAttribute('data-semantic-revision');
  const before = await flowGeometry(page, id);
  const camera = await viewport(page);
  await selectAnswerText(page, id);
  expect(await flowGeometry(page, id)).toEqual(before);
  expect(await viewport(page)).toEqual(camera);
  expect((await requests(page)).filter((request) => request.method !== 'GET')).toEqual([]);
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await drag(page, page.getByTestId(`ks-node-header-${id}`), 95, 50);
  await expect.poll(() => flowGeometry(page, id)).not.toEqual(before);
  await saved(page);
  const moved = await flowGeometry(page, id);
  const firstPatch = (await requests(page))
    .filter((request) => request.kind === 'layout.patch')
    .at(-1)!.body as LayoutPatch;
  const zoom = (await page.evaluate(() => window.__ksFixture!.viewport()))!.zoom;
  await drag(page, page.getByTestId(`ks-node-header-${id}`), 40, 20);
  await saved(page);
  const secondPatch = (await requests(page))
    .filter((request) => request.kind === 'layout.patch')
    .at(-1)!.body as LayoutPatch;
  // React Flow begins a drag after its 2 px threshold; the first mouse step
  // can be consumed by that gesture start. Bound that loss plus rounding.
  const tolerance = (40 / 15 + 2) / zoom + 1;
  expect(Math.abs(secondPatch.nodes[id].x - firstPatch.nodes[id].x - 40 / zoom)).toBeLessThan(
    tolerance,
  );
  expect(Math.abs(secondPatch.nodes[id].y - firstPatch.nodes[id].y - 20 / zoom)).toBeLessThan(
    tolerance,
  );
  const resize = page.locator(`.react-flow__node[data-id="${id}"] .ks-resize-handle.bottom.right`);
  await expect(resize).toBeVisible();
  await drag(page, resize, 60, 40);
  await expect.poll(async () => (await flowGeometry(page, id)).width).not.toBe(moved.width);
  await saved(page);
  const resized = await flowGeometry(page, id);
  const beforePan = await viewport(page);
  await pan(page, 60, 35);
  expect(await viewport(page)).not.toBe(beforePan);
  await page.getByRole('button', { name: 'Zoom In', exact: true }).click();
  await frames(page);
  expect(await flowGeometry(page, id)).toEqual(resized);
  await expect(page.getByTestId('ks-workspace')).toHaveAttribute(
    'data-semantic-revision',
    semantic!,
  );
  const writes = (await requests(page)).filter((request) => request.method !== 'GET');
  expect(writes.length).toBeGreaterThanOrEqual(2);
  expect(writes.every((request) => request.kind === 'layout.patch' && !request.startsRun)).toBe(
    true,
  );
  for (const request of writes) {
    const body = request.body as LayoutPatch;
    expect(body.expectedLayoutRevision).toBeGreaterThanOrEqual(1);
    expect(Object.keys(body).sort()).toEqual(['expectedLayoutRevision', 'nodes']);
  }
  expect(networkMutations).toEqual([]);
});

test('keyboard move, pin, Auto format, explicit Save, undo and reset use only layout revisions', async ({
  page,
}) => {
  await openReady(page, 'keystone-workspace--ten-nodes');
  await showSelected(page);
  const id = await selectedNode(page);
  const node = page.locator(`.react-flow__node[data-id="${id}"]`);
  const before = await flowGeometry(page, id);
  await node.focus();
  await node.press('ArrowRight');
  await expect.poll(() => flowGeometry(page, id)).not.toEqual(before);
  await saved(page);
  const moved = await flowGeometry(page, id);
  await page.getByTestId('ks-pin').press('Enter');
  await expect(page.getByTestId('ks-pin')).toHaveAttribute('aria-pressed', 'true');
  await saved(page);
  await page.getByTestId('ks-auto-layout').click();
  await expect(page.getByTestId('ks-layout-status')).toHaveAttribute('data-state', 'preview');
  await page.getByTestId('ks-save-layout').click();
  await saved(page);
  expect(await flowGeometry(page, id)).toEqual(moved);
  await page.getByTestId('ks-undo-layout').click();
  await saved(page);
  expect(await flowGeometry(page, id)).toEqual(moved);
  await page.getByTestId('ks-reset-position').click();
  await saved(page);
  expect(await flowGeometry(page, id)).toEqual(before);
  await expect(page.getByTestId('ks-pin')).toHaveAttribute('aria-pressed', 'false');
  expect((await requests(page)).filter((request) => request.startsRun)).toEqual([]);
});

test('reader arrows navigate parent, children and siblings without semantic commands', async ({
  page,
}) => {
  await openReady(page, 'keystone-workspace--branch-reader');
  const reader = page.getByTestId('ks-reader');
  await reader.focus();
  await expect(reader).toBeFocused();
  await reader.press('ArrowDown');
  await expect(reader).toHaveAttribute('data-node-id', 'n-region');
  await reader.press('ArrowRight');
  await expect(reader).toHaveAttribute('data-node-id', 'n-retry');
  await reader.press('ArrowLeft');
  await expect(reader).toHaveAttribute('data-node-id', 'n-region');
  await reader.press('ArrowUp');
  await expect(reader).toHaveAttribute('data-node-id', 'n-pay');
  await reader.press('Home');
  await expect(reader).toHaveAttribute('data-node-id', 'n-root');
  expect((await requests(page)).every((request) => request.method === 'GET')).toBe(true);
});

test('partial and cancelled answers retain their text and cannot start a branch', async ({
  page,
}) => {
  await openReady(page, 'keystone-workspace--branch-reader');
  await page.getByTestId('ks-reader').press('ArrowDown');
  await page.getByTestId('ks-reader').press('ArrowRight');
  await expect(page.getByTestId('ks-reader')).toHaveAttribute('data-node-id', 'n-retry');
  await expect(page.getByTestId('ks-inspector-answer')).toContainText('coverage is incomplete');
  await expect(page.getByTestId('ks-inspector')).toContainText('This answer is incomplete');
  await expect(
    page.getByTestId('ks-inspector').getByRole('heading', { name: 'Sources (1)' }),
  ).toBeVisible();
  await expect(page.getByTestId('ks-follow-up')).toBeDisabled();
  await page.getByTestId('ks-reader').press('Home');
  await page
    .getByRole('navigation', { name: 'Follow-ups from this question' })
    .getByRole('button', { name: 'Deploy timing', exact: true })
    .click();
  await page.getByTestId('ks-reader').press('ArrowDown');
  await page.getByTestId('ks-reader').press('ArrowDown');
  await expect(page.getByTestId('ks-reader')).toHaveAttribute('data-node-id', 'n-cancel');
  await expect(page.getByTestId('ks-inspector-answer')).toHaveText(
    'Partial hourly counts for the first merchant.',
  );
  await expect(page.getByTestId('ks-follow-up')).toBeDisabled();
  await expect(page.getByTestId('ks-explore')).toBeDisabled();
  expect((await requests(page)).filter((request) => request.startsRun)).toEqual([]);
});

test('changing selection aborts a delayed evidence read and keeps current sources isolated', async ({
  page,
}) => {
  await openReady(page, 'keystone-workspace--ten-nodes');
  await page.evaluate(() => window.__ksFixture!.delayArtifact('n-pay', 3000));
  await page.getByTestId('ks-view-reader').click();
  await page.getByTestId('ks-reader').press('ArrowDown');
  await expect(page.getByTestId('ks-inspector')).toHaveAttribute('data-node-id', 'n-pay');
  await expect
    .poll(async () =>
      (await requests(page)).some(
        (request) => request.kind === 'evidence' && request.path.endsWith('/n-pay/evidence'),
      ),
    )
    .toBe(true);
  await page.getByTestId('ks-reader').press('ArrowDown');
  const inspector = page.getByTestId('ks-inspector');
  await expect(inspector).toHaveAttribute('data-node-id', 'n-region');
  await expect
    .poll(() => page.evaluate(() => window.__ksFixture!.abortedEvidence()))
    .toContain('n-pay');
  await expect(inspector.getByTestId('ks-evidence-ev-n-region-3')).toBeVisible();
  await expect(inspector.getByTestId('ks-evidence-ev-n-pay-1')).toHaveCount(0);
  await frames(page, 5);
  await expect(inspector).not.toContainText('Read cancelled');
  await page.evaluate(() => window.__ksFixture!.delayArtifact('n-pay', 0));
  await page.getByTestId('ks-reader').press('ArrowUp');
  await expect(inspector).toHaveAttribute('data-node-id', 'n-pay');
  await expect(inspector.getByTestId('ks-evidence-ev-n-pay-1')).toBeVisible();
  expect((await requests(page)).filter((request) => request.startsRun)).toEqual([]);
});

for (const intent of ['follow_up', 'explore'] as const) {
  test(`${intent} previews and submits only the pinned direct parent export`, async ({ page }) => {
    await openReady(page, 'keystone-workspace--context-isolation');
    const action = page.getByTestId(intent === 'follow_up' ? 'ks-follow-up' : 'ks-explore');
    await action.press('Enter');
    await expect(page.getByTestId('ks-composer-prompt')).toBeFocused();
    await expect(page.getByTestId('ks-context-preview')).toBeVisible();
    const bytes = (await page.getByTestId('ks-context-bytes').textContent())!;
    const exported = JSON.parse(bytes);
    const sentinels = await page.evaluate(() => ({
      included: window.__ksFixture!.inheritedFor('n-pay'),
      forbidden: window.__ksFixture!.forbiddenFor('n-pay'),
    }));
    const visibleText = await page.locator('body').innerText();
    expect(visibleText).not.toContain('KS-HIDDEN-');
    expect(visibleText).not.toContain('KS-TENANT-B-checkout_payroll');
    for (const sentinel of sentinels.included) expect(bytes).toContain(sentinel);
    for (const sentinel of sentinels.forbidden) expect(bytes).not.toContain(sentinel);
    expect(exported.parentNodeId).toBe('n-pay');
    expect(exported.parentVersion).toBe(1);
    expect(exported.contextPolicy).toBe('direct_parent_v1');
    await expect(page.getByTestId('ks-context-omitted')).toContainText(
      'Questions and answers above the parent',
    );
    await expect(page.getByTestId('ks-context-omitted')).toContainText('Other branches');
    await expect(page.getByTestId('ks-scope-inherited')).toContainText('30 days');
    const hash = createHash('sha256').update(bytes).digest('hex');
    await expect(page.getByTestId('ks-context-hash')).toHaveText(hash.slice(0, 12));
    // Navigating another branch leaves the open composer pinned to its original parent.
    await page.getByTestId('ks-view-reader').click();
    await page.getByTestId('ks-reader').press('ArrowRight');
    await expect(page.getByTestId('ks-reader')).toHaveAttribute('data-node-id', 'n-deploy');
    expect(await page.getByTestId('ks-context-bytes').textContent()).toBe(bytes);
    await page.getByTestId('ks-composer-prompt').fill('What changed in the payment dependency?');
    await page.getByTestId('ks-composer-submit').press('Enter');
    await expect(page.getByTestId('ks-inspector')).toHaveAttribute('data-node-id', 'n-new-1');
    const created = (await requests(page)).filter((request) => request.kind === 'createNode');
    expect(created).toHaveLength(1);
    const command = created[0].body as CreateNodeRequest;
    expect(command).toMatchObject({
      parentNodeId: 'n-pay',
      parentVersion: 1,
      parentExportSha256: hash,
      contextPolicy: 'direct_parent_v1',
      intent,
      scope: null,
      expectedSemanticRevision: 10,
    });
    expect(command.idempotencyKey).toMatch(/^idem-context-isolation-/);
    for (const sentinel of sentinels.forbidden)
      expect(JSON.stringify(command)).not.toContain(sentinel);
    await expect(page.getByLabel('Selected question details')).toBeFocused();
  });
}

test('scope remains 30 days until an explicit change is reviewed and approved', async ({
  page,
}) => {
  await openReady(page, 'keystone-workspace--fixed-scope');
  await page.getByTestId('ks-follow-up').click();
  await expect(page.getByTestId('ks-scope-inherited')).toContainText('30 days');
  await page.getByTestId('ks-composer-prompt').fill('Compare a wider window.');
  await page.getByTestId('ks-scope-change-toggle').check();
  await page.getByTestId('ks-scope-start').fill('2026-09-12T00:00:00Z');
  await expect(page.getByTestId('ks-scope-diff')).toContainText('30 days to 31 days (wider)');
  await expect(page.getByTestId('ks-scope-diff')).toHaveAttribute('data-widens', 'true');
  await expect(page.getByTestId('ks-composer-submit')).toBeDisabled();
  expect((await requests(page)).filter((request) => request.startsRun)).toEqual([]);
  await page.getByTestId('ks-scope-approve').check();
  await expect(page.getByTestId('ks-composer-submit')).toBeEnabled();
  await page.getByTestId('ks-scope-end').fill('2026-10-14T00:00:00Z');
  await expect(page.getByTestId('ks-scope-approve')).not.toBeChecked();
  await expect(page.getByTestId('ks-composer-submit')).toBeDisabled();
  await page.getByTestId('ks-scope-approve').check();
  await page.getByTestId('ks-composer-submit').click();
  await expect(page.getByTestId('ks-inspector')).toHaveAttribute('data-node-id', 'n-new-1');
  await expect(page.getByTestId('ks-inspector')).toContainText('Changed from parent');
  const command = (await requests(page)).find((request) => request.kind === 'createNode')!
    .body as CreateNodeRequest;
  expect(command.scope).toMatchObject({
    start: '2026-09-12T00:00:00Z',
    end: '2026-10-14T00:00:00Z',
  });
});

test('composer cancellation restores focus and a 24-hour child retains its approved scope', async ({
  page,
}) => {
  await openReady(page, 'keystone-workspace--approved-scope-change');
  await expect(page.getByTestId('ks-inspector')).toContainText('24 hours');
  const action = page.getByTestId('ks-follow-up');
  await action.press('Enter');
  await expect(page.getByTestId('ks-scope-inherited')).toContainText('24 hours');
  await page
    .getByTestId('ks-composer')
    .getByRole('button', { name: 'Cancel', exact: true })
    .click();
  await expect(action).toBeFocused();
  expect((await requests(page)).filter((request) => request.startsRun)).toEqual([]);
});

test('duplicate and gap replay produce one answer without changing camera or selection', async ({
  page,
}) => {
  await openReady(page, 'keystone-workspace--streaming');
  await showSelected(page);
  await pan(page, 60, 30);
  const camera = await page.evaluate(() => window.__ksFixture!.viewport());
  const selected = await selectedNode(page);
  let count = 0;
  while ((await page.evaluate(() => window.__ksFixture!.stream.step())) !== null) {
    count++;
    await frames(page);
    expect(await page.evaluate(() => window.__ksFixture!.viewport())).toEqual(camera);
    expect(await selectedNode(page)).toBe(selected);
  }
  expect(count).toBe(12);
  await expect(page.getByTestId('ks-stream-status')).toHaveAttribute('data-applied', '12');
  await expect(page.getByTestId('ks-stream-status')).toHaveAttribute('data-duplicates', '1');
  await expect(page.getByTestId('ks-stream-status')).toHaveAttribute('data-gaps', '1');
  expect(await page.evaluate(() => window.__ksFixture!.viewport())).toEqual(camera);
  expect(await selectedNode(page)).toBe(selected);
  await expect(page.getByTestId('ks-new-result')).toContainText('Error codes');
  await page.getByTestId('ks-view-reader').click();
  await page.getByTestId('ks-reader').press('Home');
  await page
    .getByRole('navigation', { name: 'Follow-ups from this question' })
    .getByRole('button', { name: 'Error codes', exact: true })
    .click();
  await expect(page.getByTestId('ks-reader-answer')).toHaveText(
    'Upstream timeouts are 71% of errors; connect timeouts are 20%.',
  );
  await expect(
    page.getByTestId('ks-inspector').getByRole('heading', { name: 'Sources (1)' }),
  ).toBeVisible();
  expect((await requests(page)).filter((request) => request.startsRun)).toEqual([]);
});

test('a layout revision conflict blocks edits until reloading', async ({ page }) => {
  await openReady(page, 'keystone-workspace--layout-conflict');
  await page.getByTestId('ks-pin').click();
  await expect(page.getByTestId('ks-layout-status')).toHaveAttribute('data-state', 'conflict');
  await expect(page.getByTestId('ks-auto-layout')).toBeDisabled();
  await expect(page.getByTestId('ks-canvas')).toHaveAttribute('data-editable', 'false');
  await page.getByTestId('ks-reload-layout').click();
  await saved(page);
  await expect(page.getByTestId('ks-canvas')).toHaveAttribute('data-editable', 'true');
  await expect(page.getByTestId('ks-workspace')).toHaveAttribute('data-layout-revision', '2');
  expect((await requests(page)).filter((request) => request.startsRun)).toEqual([]);
});

for (const story of [
  'read-only',
  'provider-unconfigured',
  'tools-unavailable',
  'incomplete-parent',
]) {
  test(`${story} explains blocked actions and sends no branch command`, async ({ page }) => {
    await openReady(page, `keystone-workspace--${story}`);
    await expect(page.getByTestId('ks-follow-up')).toBeDisabled();
    await expect(page.getByTestId('ks-explore')).toBeDisabled();
    await expect(page.getByTestId('ks-branch-blocked')).toBeVisible();
    if (story === 'read-only') {
      await expect(page.getByTestId('ks-canvas')).toHaveAttribute('data-editable', 'false');
      await expect(page.getByTestId('ks-auto-layout')).toBeDisabled();
    }
    expect((await requests(page)).filter((request) => request.startsRun)).toEqual([]);
  });
}

for (const story of [
  'backend-missing',
  'permission-denied',
  'topology-unsupported',
  'malformed-graph',
]) {
  test(`${story} has a real unavailable or error state`, async ({ page }) => {
    await page.goto(`/iframe.html?id=keystone-workspace--${story}&viewMode=story`);
    await expect(page.getByTestId('ks-workspace')).toHaveAttribute(
      'data-state',
      story === 'malformed-graph' ? 'error' : 'unavailable',
    );
    await expect(page.getByTestId('ks-canvas')).toHaveCount(0);
    expect((await requests(page)).filter((request) => request.startsRun)).toEqual([]);
  });
}

test.describe('mobile touch', () => {
  test.use({ isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 } });
  test('viewport defaults to the reader and canvas overview permits camera actions only', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openReady(page, 'keystone-workspace--branch-reader-mobile');
    await expect(page.getByTestId('ks-workspace')).toHaveAttribute('data-view', 'reader');
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
    await expect(page.getByTestId('ks-canvas')).toHaveCount(0);
    const widths = await page.evaluate(() => ({
      viewport: innerWidth,
      content: document.documentElement.scrollWidth,
    }));
    expect(widths.content).toBeLessThanOrEqual(widths.viewport);
    const button = page.getByTestId('ks-follow-up');
    expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.getByTestId('ks-reader').press('ArrowDown');
    await expect(page.getByTestId('ks-reader')).toHaveAttribute('data-node-id', 'n-day');
    await page.getByTestId('ks-view-canvas').click();
    await expect(page.getByTestId('ks-canvas')).toHaveAttribute('data-editable', 'false');
    await expect(page.getByTestId('ks-layout-status')).toContainText(
      'Use a larger screen to move cards',
    );
    for (const control of ['ks-auto-layout', 'ks-undo-layout', 'ks-reset-position', 'ks-pin']) {
      await expect(page.getByTestId(control)).toBeDisabled();
    }
    await expect(page.locator('.react-flow__node.draggable')).toHaveCount(0);
    await expect(page.locator('.ks-resize-handle')).toHaveCount(0);
    await showSelected(page);
    const id = await selectedNode(page);
    const node = page.locator(`.react-flow__node[data-id="${id}"]`);
    const geometry = await flowGeometry(page, id);
    await node.focus();
    await node.press('ArrowRight');
    await frames(page);
    expect(await flowGeometry(page, id)).toEqual(geometry);
    await drag(page, page.getByTestId(`ks-node-header-${id}`), 50, 25);
    expect(await flowGeometry(page, id)).toEqual(geometry);
    const beforePan = await viewport(page);
    await pan(page, 35, 20);
    expect(await viewport(page)).not.toBe(beforePan);
    const beforeZoom = await page.evaluate(() => window.__ksFixture!.viewport()!.zoom);
    await page.getByRole('button', { name: 'Zoom In', exact: true }).click();
    await frames(page);
    expect(await page.evaluate(() => window.__ksFixture!.viewport()!.zoom)).toBeGreaterThan(
      beforeZoom,
    );
    expect(await flowGeometry(page, id)).toEqual(geometry);
    expect((await requests(page)).filter((request) => request.kind === 'layout.patch')).toEqual([]);
    expect((await requests(page)).filter((request) => request.startsRun)).toEqual([]);
  });
});

test('reduced motion keeps reader focus and accessible inspection usable', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openReady(page, 'keystone-workspace--branch-reader');
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(
    true,
  );
  await page.getByTestId('ks-reader').focus();
  await page.getByTestId('ks-reader').press('ArrowDown');
  await expect(page.getByTestId('ks-reader')).toBeFocused();
  await page.getByTestId('ks-view-canvas').click();
  await page.getByTestId('ks-jump').click();
  await frames(page);
  const camera = await page.evaluate(() => window.__ksFixture!.viewport());
  await frames(page, 10);
  expect(await page.evaluate(() => window.__ksFixture!.viewport())).toEqual(camera);
  await page.getByTestId('ks-view-reader').click();
  const accessibility = await new AxeBuilder({ page })
    .include('.ks-workspace')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(accessibility.violations).toEqual([]);
});

for (const rate of [1, 4]) {
  test(`100-node tree interactions record advisory frame timings at ${rate}x CPU`, async ({
    page,
  }, testInfo) => {
    // Trace snapshots and 200 separately rendered events are expensive under CPU
    // throttling; this timeout allows measurement without gating frame speed.
    testInfo.setTimeout(180_000);
    await openReady(page, 'keystone-workspace--hundred-nodes-streaming');
    const tree = await page.evaluate(() => ({
      nodes: window.__ksFixture!.nodeCount,
      edges: window.__ksFixture!.edgeCount,
      synthetic: window.__ksFixture!.synthetic,
    }));
    expect(tree).toEqual({ nodes: 100, edges: 99, synthetic: true });
    await expect(
      page.getByRole('application', { name: 'Investigation canvas, 100 questions' }),
    ).toBeVisible();
    const session = await page.context().newCDPSession(page);
    await session.send('Emulation.setCPUThrottlingRate', { rate });
    await startFrames(page);
    await pan(page, 100, 60);
    await page.getByRole('button', { name: 'Zoom In', exact: true }).click();
    await page.getByRole('button', { name: 'Zoom Out', exact: true }).click();
    await showSelected(page);
    const id = await selectedNode(page);
    await drag(page, page.getByTestId(`ks-node-header-${id}`), 75, 35);
    await saved(page);
    await page.getByTestId('ks-pin').click();
    await saved(page);
    await page.getByTestId('ks-auto-layout').click();
    await expect(page.getByTestId('ks-layout-status')).toHaveAttribute('data-state', 'preview');
    await page.getByTestId('ks-save-layout').click();
    await saved(page);
    await pan(page, -80, -40);
    await page.locator(`.react-flow__node[data-id="${id}"]`).focus();
    await frames(page);
    const readingState = () =>
      page.evaluate(() => ({
        camera: window.__ksFixture!.viewport(),
        selected: document
          .querySelector('[data-testid="ks-workspace"]')
          ?.getAttribute('data-selected'),
        focusedNode: document.activeElement?.getAttribute('data-id'),
      }));
    const stable = await readingState();
    expect(stable.focusedNode).toBe('n0');
    const beforeStreamRequests = await requests(page);
    let chunks = 0;
    while ((await page.evaluate(() => window.__ksFixture!.stream.step())) !== null) {
      chunks++;
      await frames(page);
      expect(await readingState()).toEqual(stable);
    }
    expect(chunks).toBe(202);
    await expect(page.getByTestId('ks-stream-status')).toHaveAttribute('data-applied', '202');
    await expect(page.getByTestId('ks-node-n99')).toHaveAttribute('data-status', 'completed');
    await expect(page.getByTestId('ks-node-body-n99')).toContainText('Observation 200.');
    expect(await requests(page)).toEqual(beforeStreamRequests);
    await frames(page, 30);
    const timing = await stopFrames(page);
    await session.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    await session.detach();
    const report = {
      cpuThrottle: rate,
      ...tree,
      ...timing,
      advisory: true,
      streamedEvents: chunks,
      scenario:
        'pan, zoom, selected-card drag, pin, auto layout, 200 answer chunks with stable camera/selection/focus',
    };
    const timingPath = testInfo.outputPath('frame-timing.json');
    await writeFile(timingPath, JSON.stringify(report, null, 2));
    await testInfo.attach('frame-timing.json', {
      path: timingPath,
      contentType: 'application/json',
    });
    console.log(
      `Keystone frames ${rate}x: ${JSON.stringify({ frames: timing.frames, p95Ms: timing.p95Ms, over50Ms: timing.over50Ms, maximumMs: timing.maximumMs })}`,
    );
    expect(timing.frames).toBeGreaterThan(30);
    expect((await requests(page)).filter((request) => request.startsRun)).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath(`hundred-nodes-${rate}x.png`),
      fullPage: true,
    });
  });
}
