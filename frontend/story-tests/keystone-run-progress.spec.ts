// MOCK ONLY: every run here is a scripted fixture in fixtures/pageHarness.tsx. Nothing
// reaches a native server, provider, credential store or query engine. Runs move only
// when a test calls the harness's advanceRun/advanceRunTo/failRun controls.
import { expect, test, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';
import type { PageFixtureRequest } from '../src/features/keystone/fixtures/pageHarness';
import type { CreateNodeRequest } from '../src/lib/keystone/types';

// Mirrors ACTIVE_FIXTURE in pageHarness.tsx. Copied rather than imported: importing the
// harness would load React and CSS into the Playwright runner.
const ACTIVE = {
  investigationId: 'inv-fixture-active',
  title: 'Checkout timeouts · queued mock run',
  root: 'n-active-root',
  child: 'n-active-child',
  run: 'mock-run-seeded',
} as const;
// The provider response is not streamed, so progress may name phases only.
const INVENTED_PROGRESS = /\d+\s*%|\btokens?\b|\bETA\b|remaining|estimated/i;

const errors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  const messages: string[] = [];
  errors.set(page, messages);
  page.on('pageerror', (error) => messages.push(error.message));
  await page.clock.setFixedTime(new Date('2026-10-13T12:00:00Z'));
});
test.afterEach(async ({ page }, testInfo) => {
  const path = testInfo.outputPath('run-progress-requests.json');
  await writeFile(path, JSON.stringify(await requests(page), null, 2));
  await testInfo.attach('run-progress-requests.json', { path, contentType: 'application/json' });
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
async function open(page: Page, story: 'active-run-mock' | 'run-link-mock') {
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
async function inferenceStarts(page: Page) {
  return (await requests(page)).filter((request) => request.startsInference);
}
async function snapshot(page: Page) {
  return page.evaluate(() => window.__ksPageFixture!.snapshot());
}
async function camera(page: Page) {
  return page.locator('.react-flow__viewport').getAttribute('style');
}
async function advanceTo(page: Page, runId: string, stop: string) {
  await page.evaluate(
    ([runId, stop]) => window.__ksPageFixture!.advanceRunTo(runId, stop),
    [runId, stop],
  );
}
async function openActive(page: Page) {
  await page.getByRole('link', { name: ACTIVE.title, exact: true }).click();
  await ready(page);
}
/** Selects a card the way a keyboard user does, without moving the camera. */
async function select(page: Page, nodeId: string) {
  const card = page.locator(`.react-flow__node[data-id="${nodeId}"]`);
  await card.focus();
  await card.press('Enter');
  await expect(page.getByTestId('ks-workspace')).toHaveAttribute('data-selected', nodeId);
  await expect(page.getByTestId('ks-inspector')).toHaveAttribute('data-node-id', nodeId);
}
async function expectStatus(page: Page, nodeId: string, status: string) {
  await expect(page.getByTestId(`ks-node-${nodeId}`)).toHaveAttribute('data-status', status);
  await expect(page.getByTestId('ks-inspector').locator('.ks-status')).toHaveAttribute(
    'data-status',
    status,
  );
}
async function expectNoInventedProgress(page: Page) {
  expect(await page.getByTestId('ks-inspector').innerText()).not.toMatch(INVENTED_PROGRESS);
  expect(await page.getByTestId(`ks-node-${ACTIVE.child}`).innerText()).not.toMatch(
    INVENTED_PROGRESS,
  );
}

test('reopening a queued run follows it through each phase to completion without starting inference', async ({
  page,
}, testInfo) => {
  await open(page, 'active-run-mock');
  await openActive(page);
  // Opening reads the existing run's events; it never asks for a new run.
  expect(await inferenceStarts(page)).toEqual([]);
  await expect
    .poll(async () =>
      (await requests(page)).some(
        (request) => request.kind === 'runEvents' && request.path.includes(`/runs/${ACTIVE.run}/`),
      ),
    )
    .toBe(true);

  // The completed root can be followed up while its other child is still queued.
  await expect(page.getByTestId('ks-workspace')).toHaveAttribute('data-selected', ACTIVE.root);
  await expect(page.getByTestId('ks-follow-up')).toBeEnabled();

  await select(page, ACTIVE.child);
  await expectStatus(page, ACTIVE.child, 'queued');
  await expect(page.getByTestId('ks-run-activity')).toHaveAttribute('data-run-id', ACTIVE.run);
  await expect(page.getByTestId('ks-run-step-queued')).toHaveAttribute('data-state', 'current');
  await expect(page.getByTestId('ks-run-activity')).toHaveAttribute('data-follow', 'following');
  await expect(page.getByTestId('ks-cancel-run')).toBeEnabled();
  await expect(page.getByTestId('ks-follow-up')).toBeDisabled();
  await expect(page.getByTestId('ks-branch-blocked')).toContainText('completed answer');
  await expectNoInventedProgress(page);
  await page.screenshot({ path: testInfo.outputPath('run-queued.png'), fullPage: true });

  const card = page.locator(`.react-flow__node[data-id="${ACTIVE.child}"]`);
  await card.focus();
  await frames(page);
  const viewport = await camera(page);
  for (const phase of ['querying', 'composing']) {
    await advanceTo(page, ACTIVE.run, phase);
    await expectStatus(page, ACTIVE.child, phase);
    await expect(
      page.getByTestId(phase === 'querying' ? 'ks-run-step-reading' : 'ks-run-step-answering'),
    ).toHaveAttribute('data-state', 'current');
    await expect(page.getByTestId('ks-follow-up')).toBeDisabled();
    await expectNoInventedProgress(page);
    await frames(page);
    expect(await camera(page)).toEqual(viewport);
    await expect(card).toBeFocused();
  }
  await page.screenshot({ path: testInfo.outputPath('run-composing.png'), fullPage: true });

  // Reopening mid-run replays delivered events and resumes; still no new inference.
  await page.reload();
  await ready(page);
  await select(page, ACTIVE.child);
  await expectStatus(page, ACTIVE.child, 'composing');
  expect(await inferenceStarts(page)).toEqual([]);

  await advanceTo(page, ACTIVE.run, 'answer_checkpoint');
  await expect(page.getByTestId('ks-inspector-answer')).toContainText('preliminary timeout counts');
  await expectStatus(page, ACTIVE.child, 'composing');
  await advanceTo(page, ACTIVE.run, 'completed');
  await expectStatus(page, ACTIVE.child, 'completed');
  await expect(page.getByTestId('ks-inspector-answer')).toContainText(
    'This is a scripted fixture answer',
  );
  await expect(page.getByTestId(`ks-evidence-mock-source-${ACTIVE.run}`)).toContainText(
    'MOCK_TIMEOUT',
  );
  await expect(page.getByTestId('ks-cancel-run')).toHaveCount(0);
  await expect(page.getByTestId('ks-run-step-outcome')).toHaveAttribute('data-state', 'done');
  await expect(page.getByTestId('ks-follow-up')).toBeEnabled();
  await page.waitForTimeout(500);
  await page.screenshot({ path: testInfo.outputPath('run-completed.png'), fullPage: true });

  expect(await inferenceStarts(page)).toEqual([]);
  const state = await snapshot(page);
  expect(state.runs[ACTIVE.run].cursor).toBe(state.runs[ACTIVE.run].events.length);
});

test('a direct link selects the linked follow-up and its run without starting inference', async ({
  page,
}, testInfo) => {
  await open(page, 'run-link-mock');
  await ready(page);
  await expect(page.getByTestId('ks-fixture-route')).toHaveAttribute(
    'data-route',
    `/keystone/${ACTIVE.investigationId}?node=${ACTIVE.child}&run=${ACTIVE.run}`,
  );
  await expect(page.getByTestId('ks-workspace')).toHaveAttribute('data-selected', ACTIVE.child);
  await expect(page.getByTestId('ks-inspector')).toHaveAttribute('data-node-id', ACTIVE.child);
  await expectStatus(page, ACTIVE.child, 'queued');
  await expect(page.getByTestId('ks-run-activity')).toHaveAttribute('data-run-id', ACTIVE.run);
  await expect(page.getByTestId('ks-run-link')).toHaveAttribute(
    'href',
    `/keystone/${ACTIVE.investigationId}?node=${ACTIVE.child}&run=${ACTIVE.run}`,
  );
  await expectNoInventedProgress(page);
  await page.screenshot({ path: testInfo.outputPath('run-link-queued.png'), fullPage: true });

  await advanceTo(page, ACTIVE.run, 'querying');
  await expectStatus(page, ACTIVE.child, 'querying');

  await page.reload();
  await ready(page);
  await expect(page.getByTestId('ks-workspace')).toHaveAttribute('data-selected', ACTIVE.child);
  await expectStatus(page, ACTIVE.child, 'querying');
  expect(await inferenceStarts(page)).toEqual([]);
  // Following a link only reads: no writes of any kind.
  const writes = (await requests(page)).filter((request) => request.method !== 'GET');
  expect(writes.map((request) => request.kind)).toEqual([]);
});

test('a failed run is reported as failed, keeps branching closed and survives reload', async ({
  page,
}, testInfo) => {
  await open(page, 'active-run-mock');
  await openActive(page);
  await select(page, ACTIVE.child);
  await advanceTo(page, ACTIVE.run, 'querying');
  await expectStatus(page, ACTIVE.child, 'querying');
  await page.evaluate((runId) => window.__ksPageFixture!.failRun(runId), ACTIVE.run);
  await expectStatus(page, ACTIVE.child, 'failed');
  await expect(page.getByTestId('ks-inspector').locator('.ks-status')).toHaveText('Failed');
  await expect(page.getByTestId('ks-follow-up')).toBeDisabled();
  await expect(page.getByTestId('ks-branch-blocked')).toContainText('failed');
  await expect(page.getByTestId('ks-cancel-run')).toHaveCount(0);
  await expect(page.getByTestId('ks-run')).toHaveText('Retry question');
  await expectNoInventedProgress(page);
  await page.screenshot({ path: testInfo.outputPath('run-failed.png'), fullPage: true });

  await page.reload();
  await ready(page);
  await select(page, ACTIVE.child);
  await expectStatus(page, ACTIVE.child, 'failed');
  await expect(page.getByTestId('ks-follow-up')).toBeDisabled();
  // Failure, reload and reopening never retry on their own.
  expect(await inferenceStarts(page)).toEqual([]);
  const state = await snapshot(page);
  expect(state.runs[ACTIVE.run].events.at(-1)).toMatchObject({
    kind: 'terminal',
    status: 'failed',
  });
});

test('a follow-up from a run completed in view pins that parent and its scope only', async ({
  page,
}) => {
  await open(page, 'active-run-mock');
  await openActive(page);
  await select(page, ACTIVE.child);
  await advanceTo(page, ACTIVE.run, 'completed');
  await expectStatus(page, ACTIVE.child, 'completed');

  await page.getByTestId('ks-quick-follow-up').press('Enter');
  await expect(page.getByTestId('ks-context-preview')).toBeVisible();
  await page
    .getByTestId('ks-composer')
    .getByRole('button', { name: 'Cancel', exact: true })
    .click();
  await expect(page.getByTestId('ks-quick-follow-up')).toBeFocused();
  await page.getByTestId('ks-quick-follow-up').press('Enter');
  const preview = page.getByTestId('ks-context-preview');
  await expect(preview).toBeVisible();
  const included = page.getByTestId('ks-context-included');
  await expect(included).toContainText('Which error codes make up the timeouts?');
  await expect(included).toContainText('This is a scripted fixture answer');
  await expect(included).toContainText('No sources selected');
  // The grandparent's question, answer and sources are not part of this context.
  await expect(preview).not.toContainText('Why did checkout timeouts rise');
  await expect(preview).not.toContainText('Mock fixture answer: timeouts rose');
  await expect(page.getByTestId(`ks-context-source-ev-${ACTIVE.root}-0`)).toHaveCount(0);
  const sources = page.getByTestId('ks-context-sources').getByRole('checkbox');
  await expect(sources).toHaveCount(1);
  await expect(sources.first()).not.toBeChecked();
  await expect(page.getByTestId('ks-context-omitted')).toContainText(
    'Questions and answers above the parent',
  );
  await expect(page.getByTestId('ks-scope-inherited')).toContainText('checkout_logs');

  await page.getByTestId('ks-composer-prompt').fill('Which merchants see MOCK_TIMEOUT most?');
  await expect(page.getByTestId('ks-composer-submit')).toHaveText('Save question');
  await page.getByTestId('ks-composer-submit').press('Enter');
  await expect(page.getByTestId('ks-inspector')).toHaveAttribute('data-node-id', /n-mock-child-/);

  const command = (await requests(page)).find((request) => request.kind === 'createNode')!
    .body as CreateNodeRequest;
  expect(command).toMatchObject({
    parentNodeId: ACTIVE.child,
    parentVersion: 1,
    contextPolicy: 'direct_parent_v1',
    intent: 'follow_up',
    scope: null,
    exportedEvidenceIds: [],
  });
  expect(command.parentExportSha256).toMatch(/^[a-f0-9]{64}$/);
  const saved = (await snapshot(page)).investigations[ACTIVE.investigationId];
  const parent = saved.graph.nodes.find((node) => node.id === ACTIVE.child)!;
  const created = saved.graph.nodes.find((node) => node.id.startsWith('n-mock-child-'))!;
  expect(created).toMatchObject({ parentId: ACTIVE.child, parentVersion: 1, status: 'draft' });
  expect(created.scope).toEqual(parent.scope);
  expect(saved.inheritedSources[created.id]).toEqual([]);
  // Saving a follow-up never runs it.
  expect(await inferenceStarts(page)).toEqual([]);
});

test('lost live updates recover a completed server result and unlock follow-ups', async ({
  page,
}) => {
  await open(page, 'run-link-mock');
  await ready(page);
  await expect(page.getByTestId('ks-run-activity')).toHaveAttribute('data-follow', 'following');
  await page.evaluate((run) => window.__ksPageFixture!.disconnectRun(run, true), ACTIVE.run);
  await expectStatus(page, ACTIVE.child, 'completed');
  await expect(page.getByTestId('ks-stream-note')).toContainText('Live results stopped');
  await expect(page.getByTestId('ks-follow-up')).toBeEnabled();
  await page.getByTestId('ks-load-history').click();
  await expect(page.getByTestId('ks-run-activity')).toHaveAttribute('data-follow', 'ended');
  await expect(page.getByTestId('ks-run-step-answering')).toHaveAttribute('data-state', 'done');
  expect(await inferenceStarts(page)).toEqual([]);
});

test('reconnect resumes an existing run without starting another', async ({ page }) => {
  await open(page, 'run-link-mock');
  await ready(page);
  await expect(page.getByTestId('ks-run-activity')).toHaveAttribute('data-follow', 'following');
  await page.evaluate((run) => window.__ksPageFixture!.disconnectRun(run), ACTIVE.run);
  await expect(page.getByTestId('ks-reconnect')).toBeVisible();
  await advanceTo(page, ACTIVE.run, 'querying');
  await page.getByTestId('ks-reconnect').click();
  await expectStatus(page, ACTIVE.child, 'querying');
  await expect(page.getByTestId('ks-run-activity')).toHaveAttribute('data-follow', 'following');
  await expect(page.getByTestId('ks-stream-note')).toHaveCount(0);
  expect(await inferenceStarts(page)).toEqual([]);
});

test('unknown run links are explained without claiming they are historical runs', async ({
  page,
}) => {
  await open(page, 'run-link-mock');
  await ready(page);
  await page.evaluate(() =>
    localStorage.setItem(
      'keystone-full-page-fixture-v1:run-link:route',
      '/keystone/inv-fixture-active?node=n-active-child&run=unknown-run',
    ),
  );
  await page.reload();
  await ready(page);
  await expect(page.getByTestId('ks-stale-run')).toContainText("not this question's current run");
  await expect(page.getByTestId('ks-run-activity')).toHaveAttribute('data-run-id', ACTIVE.run);
  await page.evaluate(() =>
    localStorage.setItem(
      'keystone-full-page-fixture-v1:run-link:route',
      '/keystone/inv-fixture-active?run=unknown-run',
    ),
  );
  await page.reload();
  await ready(page);
  await expect(page.getByTestId('ks-workspace')).toContainText(
    'The linked question is not in this investigation',
  );
  expect(await inferenceStarts(page)).toEqual([]);
});

test('mobile progress and the prominent follow-up action remain accessible', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, 'run-link-mock');
  await ready(page);
  await expect(page.getByTestId('ks-workspace')).toHaveAttribute('data-view', 'reader');
  await expect(page.getByTestId('ks-run-activity')).toHaveAttribute('data-run-id', ACTIVE.run);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('mobile-run-progress.png'), fullPage: true });
  await advanceTo(page, ACTIVE.run, 'completed');
  await page.getByTestId('ks-quick-follow-up').click();
  await expect(page.getByTestId('ks-composer-prompt')).toBeFocused();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(await inferenceStarts(page)).toEqual([]);
});
