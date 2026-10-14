import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { writeFile } from 'node:fs/promises';
import type { PageFixtureRequest } from '../src/features/keystone/fixtures/pageHarness';
import type { CreateInvestigationRequest } from '../src/features/keystone/pageContract';
import type { CreateNodeRequest, LayoutPatch } from '../src/lib/keystone/types';

const errors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  const messages: string[] = [];
  errors.set(page, messages);
  page.on('pageerror', (error) => messages.push(error.message));
});
test.afterEach(async ({ page }, testInfo) => {
  const path = testInfo.outputPath('full-page-requests.json');
  await writeFile(path, JSON.stringify(await requests(page), null, 2));
  await testInfo.attach('full-page-requests.json', { path, contentType: 'application/json' });
  expect(errors.get(page)).toEqual([]);
});

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
async function open(page: Page, story = 'durable-mock') {
  await page.goto(`/iframe.html?id=keystone-full-page--${story}&viewMode=story`);
  await expect(page.getByTestId('ks-page')).toHaveAttribute('data-state', 'ready');
  await expect(page.getByTestId('ks-page-fixture-banner')).toContainText('scripted mock inference');
}
async function ready(page: Page) {
  await expect(page.getByTestId('ks-workspace')).toHaveAttribute('data-state', 'ready');
  await frames(page, 3);
}
async function requests(page: Page): Promise<PageFixtureRequest[]> {
  return page.evaluate(() => window.__ksPageRequests ?? []);
}
async function snapshot(page: Page) {
  return page.evaluate(() => window.__ksPageFixture!.snapshot());
}
async function camera(page: Page) {
  return page.locator('.react-flow__viewport').getAttribute('style');
}
async function saved(page: Page) {
  await expect(page.getByTestId('ks-layout-status')).toHaveAttribute('data-state', 'saved');
}
async function geometry(page: Page) {
  return page.locator('.react-flow__node').evaluateAll((nodes) =>
    Object.fromEntries(
      nodes.map((element) => {
        const node = element as HTMLElement;
        return [
          node.dataset.id!,
          { transform: node.style.transform, width: node.style.width, height: node.style.height },
        ];
      }),
    ),
  );
}
function overlaps(nodes: Awaited<ReturnType<typeof geometry>>) {
  const rectangles = Object.entries(nodes).map(([id, node]) => {
    const position = node.transform.match(/translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/)!;
    return {
      id,
      x: Number(position[1]),
      y: Number(position[2]),
      width: parseFloat(node.width),
      height: parseFloat(node.height),
    };
  });
  const pairs: string[] = [];
  for (let a = 0; a < rectangles.length; a++)
    for (let b = a + 1; b < rectangles.length; b++) {
      const left = rectangles[a],
        right = rectangles[b];
      if (
        left.x < right.x + right.width &&
        left.x + left.width > right.x &&
        left.y < right.y + right.height &&
        left.y + left.height > right.y
      )
        pairs.push(`${left.id}:${right.id}`);
    }
  return pairs;
}
async function create(page: Page, prompt = 'Why did checkout errors rise over 30 days?') {
  const form = page.getByTestId('ks-new-investigation');
  await form.getByTestId('ks-new-prompt').fill(prompt);
  await form.getByRole('checkbox', { name: 'checkout_logs', exact: true }).check();
  await form.getByLabel('Time range', { exact: true }).selectOption('30d');
  await expect(form.getByTestId('ks-new-window')).toContainText('30 days');
  await form.getByTestId('ks-new-save').press('Enter');
  await ready(page);
}
async function completed(page: Page) {
  await page
    .getByRole('link', { name: 'Checkout error spike · saved fixture', exact: true })
    .click();
  await ready(page);
}
async function branch(page: Page, intent: 'follow_up' | 'explore', selected: boolean) {
  await page.getByTestId(intent === 'follow_up' ? 'ks-follow-up' : 'ks-explore').press('Enter');
  await expect(page.getByTestId('ks-context-preview')).toBeVisible();
  const sources = page.getByTestId('ks-context-sources').getByRole('checkbox');
  await expect(sources).toHaveCount(2);
  for (const source of await sources.all()) await expect(source).not.toBeChecked();
  await expect(page.getByTestId('ks-context-included')).toContainText('No sources selected');
  if (selected) await page.getByTestId('ks-context-source-ev-n-root-0').check();
  await page.getByTestId('ks-composer-prompt').fill('Compare payment latency for this branch.');
  await expect(page.getByTestId('ks-composer-submit')).toHaveText('Save question');
  await expect(page.getByTestId('ks-scope-inherited')).toContainText('30 days');
  await page.getByTestId('ks-composer-submit').press('Enter');
  await expect(page.getByTestId('ks-inspector')).toHaveAttribute('data-node-id', /n-mock-child-/);
}

test('full page saves a 30-day draft, reopens durably, and runs only after an explicit action', async ({
  page,
}, testInfo) => {
  await page.clock.setFixedTime(new Date('2026-10-13T12:00:00Z'));
  await open(page);
  await expect(page.getByTestId('ks-saved-item')).toHaveCount(2);
  await expect(page.getByTestId('ks-new-datasets')).not.toContainText('_internal_fixture');
  await page.waitForTimeout(1000);
  await page.screenshot({ path: testInfo.outputPath('full-page-list.png'), fullPage: true });
  await create(page);
  await expect(page.getByTestId('ks-node-n-mock-root-1')).toHaveAttribute('data-status', 'draft');
  await expect(page.getByTestId('ks-run')).toBeEnabled();
  const created = (await requests(page)).filter(
    (request) => request.kind === 'createInvestigation',
  );
  expect(created).toHaveLength(1);
  expect(created[0].startsInference).toBe(false);
  expect((created[0].body as CreateInvestigationRequest).scope).toMatchObject({
    datasets: ['checkout_logs'],
    start: '2026-09-13T12:00:00Z',
    end: '2026-10-13T12:00:00Z',
  });
  await page.reload();
  await ready(page);
  await page.getByRole('link', { name: 'All investigations', exact: true }).click();
  await expect(page.getByTestId('ks-saved-item')).toHaveCount(3);
  await page
    .getByRole('link', { name: 'Why did checkout errors rise over 30 days?', exact: true })
    .click();
  await ready(page);
  expect((await requests(page)).filter((request) => request.startsInference)).toEqual([]);
  await page.getByTestId('ks-run').press('Enter');
  await expect(page.getByTestId('ks-cancel-run')).toBeEnabled();
  const node = page.locator('.react-flow__node[data-id="n-mock-root-1"]');
  await node.focus();
  await frames(page);
  const viewport = await camera(page);
  for (let step = 0; step < 6; step++) {
    await page.evaluate(() => window.__ksPageFixture!.advanceRun('mock-run-1'));
    await frames(page);
    expect(await camera(page)).toEqual(viewport);
    await expect(node).toBeFocused();
  }
  await expect(page.getByTestId('ks-node-n-mock-root-1')).toHaveAttribute(
    'data-status',
    'completed',
  );
  await expect(page.getByTestId('ks-inspector-answer')).toContainText(
    'This is a scripted fixture answer',
  );
  await expect(page.getByTestId('ks-evidence-mock-source-mock-run-1')).toContainText(
    'MOCK_TIMEOUT',
  );
  await page.waitForTimeout(1000);
  await page.screenshot({ path: testInfo.outputPath('full-page-completed.png'), fullPage: true });
  await page.reload();
  await ready(page);
  await expect(page.getByTestId('ks-inspector-answer')).toContainText('12 timeout samples');
  expect((await requests(page)).filter((request) => request.startsInference)).toHaveLength(1);
  const state = await snapshot(page);
  expect(state.investigations['inv-mock-1'].graph.nodes[0].scope.start).toBe(
    '2026-09-13T12:00:00Z',
  );
});

test('cancel preserves a mock partial answer and source across reload without restarting inference', async ({
  page,
}) => {
  await open(page);
  await page.getByRole('link', { name: 'Saved draft · mock fixture', exact: true }).click();
  await ready(page);
  await page.getByTestId('ks-run').click();
  await expect(page.getByTestId('ks-cancel-run')).toBeEnabled();
  await page.evaluate(() => window.__ksPageFixture!.advanceRun('mock-run-1', 4));
  await expect(page.getByTestId('ks-inspector-answer')).toContainText('preliminary timeout counts');
  await page.getByTestId('ks-cancel-run').click();
  await expect(page.getByTestId('ks-node-n-draft-root')).toHaveAttribute(
    'data-status',
    'cancelled',
  );
  await expect(page.getByTestId('ks-follow-up')).toBeDisabled();
  await page.reload();
  await ready(page);
  await expect(page.getByTestId('ks-inspector-answer')).toContainText('preliminary timeout counts');
  await expect(page.getByTestId('ks-evidence-mock-source-mock-run-1')).toBeVisible();
  const log = await requests(page);
  expect(log.filter((request) => request.kind === 'startRun')).toHaveLength(1);
  expect(log.filter((request) => request.kind === 'cancelRun')).toHaveLength(1);
  const previousScope = (await snapshot(page)).investigations['inv-fixture-draft'].graph.nodes[0]
    .scope;
  await expect(page.getByTestId('ks-run')).toHaveText('Retry question');
  await page.getByTestId('ks-run').press('Enter');
  await expect(page.getByTestId('ks-cancel-run')).toBeEnabled();
  expect(Object.keys((await snapshot(page)).runs)).toEqual(['mock-run-1', 'mock-run-2']);
  await page.evaluate(() => window.__ksPageFixture!.advanceRun('mock-run-2', 6));
  await expect(page.getByTestId('ks-node-n-draft-root')).toHaveAttribute(
    'data-status',
    'completed',
  );
  await expect(page.getByTestId('ks-evidence-mock-source-mock-run-2')).toBeVisible();
  await expect(page.getByTestId('ks-evidence-mock-source-mock-run-1')).toHaveCount(0);
  const starts = (await requests(page)).filter((request) => request.kind === 'startRun');
  expect(starts).toHaveLength(2);
  expect((starts[0].body as { idempotencyKey: string }).idempotencyKey).not.toBe(
    (starts[1].body as { idempotencyKey: string }).idempotencyKey,
  );
  expect((await snapshot(page)).investigations['inv-fixture-draft'].graph.nodes[0].scope).toEqual(
    previousScope,
  );
});

test('private provider setup clears surrogate credentials and never records or echoes them', async ({
  page,
}) => {
  await open(page, 'provider-setup');
  const setup = page.getByTestId('ks-provider-setup');
  await setup.locator('summary').press('Enter');
  const key = page.getByLabel('OpenRouter API key', { exact: true });
  await expect(key).toHaveAttribute('type', 'password');
  await expect(setup).toContainText('xiaomi/mimo-v2.6-flash');
  const marker = 'PUBLIC-FIXTURE-PROVIDER-SURROGATE';
  await key.fill(`  ${marker}  `);
  await setup.getByRole('button', { name: 'Save credential', exact: true }).click();
  await expect(key).toHaveValue('');
  await expect(setup.getByRole('status')).toContainText('Credential saved');
  let recorded = (await requests(page)).filter(
    (request) => request.kind === 'saveProviderCredential',
  );
  expect(recorded).toHaveLength(1);
  expect(recorded[0].body).toEqual({ action: 'credential_saved' });
  const stored = () =>
    page.evaluate(() =>
      JSON.stringify({
        storage: { ...localStorage },
        state: window.__ksPageFixture!.snapshot(),
        requests: window.__ksPageRequests,
      }),
    );
  expect(await stored()).not.toContain(marker);
  expect(await page.locator('body').innerText()).not.toContain(marker);
  await page.evaluate(() => window.__ksPageFixture!.failNextCredentialSave());
  const failureMarker = 'PUBLIC-FIXTURE-PROVIDER-FAILURE';
  await key.fill(`  ${failureMarker}  `);
  await setup.getByRole('button', { name: 'Save credential', exact: true }).click();
  await expect(key).toHaveValue('');
  await expect(setup.getByRole('status')).toContainText(
    'Fixture credential save failed. Try again.',
  );
  expect(await stored()).not.toContain(failureMarker);
  expect(await page.locator('body').innerText()).not.toContain(failureMarker);
  recorded = (await requests(page)).filter((request) => request.kind === 'saveProviderCredential');
  expect(recorded).toHaveLength(2);
  expect(
    recorded.every(
      (request) => JSON.stringify(request.body) === JSON.stringify({ action: 'credential_saved' }),
    ),
  ).toBe(true);
  expect((await requests(page)).filter((request) => request.startsInference)).toEqual([]);
  const audit = await new AxeBuilder({ page })
    .include('.ks-page')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(audit.violations).toEqual([]);
});

for (const selected of [false, true]) {
  test(`branch saves a draft with ${selected ? 'only the explicitly selected source' : 'no sources selected by default'}`, async ({
    page,
  }) => {
    await open(page);
    await completed(page);
    await branch(page, selected ? 'explore' : 'follow_up', selected);
    const command = (await requests(page)).find((request) => request.kind === 'createNode')!
      .body as CreateNodeRequest;
    expect(command).toMatchObject({
      parentNodeId: 'n-root',
      parentVersion: 1,
      contextPolicy: 'direct_parent_v1',
      scope: null,
      intent: selected ? 'explore' : 'follow_up',
      exportedEvidenceIds: selected ? ['ev-n-root-0'] : [],
    });
    expect(command.parentExportSha256).toMatch(/^[a-f0-9]{64}$/);
    expect((await requests(page)).filter((request) => request.startsInference)).toEqual([]);
    const state = await snapshot(page),
      saved = state.investigations['inv-fixture-completed'];
    const child = saved.graph.nodes.find((node) => node.id.startsWith('n-mock-child-'))!;
    expect(child.status).toBe('draft');
    expect(child.scope).toEqual(saved.graph.nodes[0].scope);
    expect(saved.inheritedSources[child.id]).toEqual(selected ? ['ev-n-root-0'] : []);
    await page.reload();
    await ready(page);
    expect(
      (await snapshot(page)).investigations['inv-fixture-completed'].inheritedSources[child.id],
    ).toEqual(saved.inheritedSources[child.id]);
  });
}

test('storage remains usable when execution is unavailable and draft Run is explicitly gated', async ({
  page,
}) => {
  await open(page, 'execution-unavailable');
  await expect(page.getByTestId('ks-readiness-storage')).toHaveAttribute('data-state', 'ready');
  await expect(page.getByTestId('ks-readiness-execution')).toHaveAttribute(
    'data-state',
    'unavailable',
  );
  await create(page, 'A draft saved while execution is unavailable.');
  await expect(page.getByTestId('ks-run')).toBeDisabled();
  await expect(page.getByTestId('ks-run-blocked')).toBeVisible();
  await page.getByRole('link', { name: 'All investigations', exact: true }).click();
  await completed(page);
  await branch(page, 'follow_up', false);
  await expect(page.getByTestId('ks-run')).toBeDisabled();
  expect((await requests(page)).filter((request) => request.startsInference)).toEqual([]);
});

test('collapse persists expanded height, expansion reports collisions, and format Save/Undo preserves collapse', async ({
  page,
}, testInfo) => {
  await open(page, 'collapse-persistence');
  await ready(page);
  const toggle = page.getByTestId('ks-node-toggle-n-root');
  await page.getByTestId('ks-jump').click();
  await page.waitForTimeout(250);
  const original = await geometry(page),
    originalGraph = (await snapshot(page)).investigations['inv-fixture-completed'].graph;
  expect(original['n-root'].height).toBe('46px');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('ks-node-body-n-root')).toBeHidden();
  await expect(page.getByTestId('ks-inspector-answer')).toBeVisible();
  const viewport = await camera(page);
  await toggle.press('Space');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('ks-expand-collision')).toContainText('expanded card covers');
  const expanded = await geometry(page);
  expect(expanded['n-root']).toEqual({ ...original['n-root'], height: '280px' });
  for (const id of Object.keys(original).filter((id) => id !== 'n-root'))
    expect(expanded[id]).toEqual(original[id]);
  expect(await camera(page)).toEqual(viewport);
  await saved(page);
  await page.screenshot({ path: testInfo.outputPath('expanded-collision.png'), fullPage: true });
  await toggle.press('Enter');
  await saved(page);
  await page.reload();
  await ready(page);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect((await geometry(page))['n-root'].height).toBe('46px');
  let state = await snapshot(page);
  expect(state.investigations['inv-fixture-completed'].layout.nodes['n-root']).toMatchObject({
    height: 280,
    collapsed: true,
  });
  expect(state.investigations['inv-fixture-completed'].graph).toEqual(originalGraph);
  const beforeFormat = await geometry(page),
    beforeCamera = await camera(page);
  const writesBefore = (await requests(page)).filter(
    (request) => request.kind === 'layout.patch',
  ).length;
  await page.getByTestId('ks-auto-layout').press('Enter');
  await expect(page.getByTestId('ks-layout-status')).toHaveAttribute('data-state', 'preview');
  await frames(page);
  expect(overlaps(await geometry(page))).toEqual([]);
  expect(await camera(page)).toEqual(beforeCamera);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await page.waitForTimeout(500);
  expect((await requests(page)).filter((request) => request.kind === 'layout.patch')).toHaveLength(
    writesBefore,
  );
  await page.getByTestId('ks-save-layout').click();
  await saved(page);
  state = await snapshot(page);
  expect(state.investigations['inv-fixture-completed'].layout.nodes['n-root']).toMatchObject({
    height: 280,
    collapsed: true,
  });
  await page.screenshot({ path: testInfo.outputPath('collapsed-formatted.png'), fullPage: true });
  await page.getByTestId('ks-undo-layout').click();
  await expect.poll(() => geometry(page)).toEqual(beforeFormat);
  await saved(page);
  expect((await requests(page)).filter((request) => request.startsInference)).toEqual([]);
  const patch = (await requests(page)).find((request) => request.kind === 'layout.patch')!
    .body as LayoutPatch;
  expect(patch.nodes['n-root'].height).toBe(280);
});

test.describe('full page mobile keyboard', () => {
  test.use({
    isMobile: true,
    hasTouch: true,
    viewport: { width: 390, height: 844 },
    reducedMotion: 'reduce',
  });
  test('draft, reader and local collapse remain accessible and never run implicitly', async ({
    page,
  }) => {
    await open(page, 'mobile');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
    const initialAudit = await new AxeBuilder({ page })
      .include('.ks-page')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    expect(initialAudit.violations).toEqual([]);
    await create(page);
    await expect(page.getByTestId('ks-workspace')).toHaveAttribute('data-view', 'reader');
    await page.getByTestId('ks-reader').press('Home');
    await expect(page.getByTestId('ks-reader')).toBeFocused();
    await page.getByTestId('ks-view-canvas').press('Enter');
    await expect(page.getByTestId('ks-canvas')).toHaveAttribute('data-editable', 'false');
    const node = page.locator('.react-flow__node[data-id="n-mock-root-1"]');
    await page.getByTestId('ks-node-toggle-n-mock-root-1').press('Space');
    await expect(page.getByTestId('ks-node-toggle-n-mock-root-1')).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect((await geometry(page))['n-mock-root-1'].height).toBe('46px');
    const position = await geometry(page);
    await node.press('ArrowRight');
    expect(await geometry(page)).toEqual(position);
    expect((await requests(page)).filter((request) => request.kind === 'layout.patch')).toEqual([]);
    expect((await requests(page)).filter((request) => request.startsInference)).toEqual([]);
    const audit = await new AxeBuilder({ page })
      .include('.ks-page')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    expect(audit.violations).toEqual([]);
  });
});
