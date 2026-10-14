// Actual native HTTP/SSE, coordinator and durable repository; synthetic auth/rows/model.
// The launcher proves fixture identity before this suite performs any mutations.
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

const base = '/api/prism/v1/keystone/native';
type NativeCall = { method: string; url: string; body: unknown; status?: number };
type StartedRun = { id: string; scope: unknown };
type EventData = {
  runId: string;
  nodeId: string;
  sequence: number;
  kind: string;
  payload: unknown;
};
type EventFrame = { id: number; event: string; data: EventData };
const pageErrors = new Map<string, string[]>();
test.beforeEach(async ({ request }) => {
  const response = await request.get(`${base}/capabilities`);
  expect(response.status()).toBe(200);
  expect(process.env.KEYSTONE_NATIVE_ID).toBeTruthy();
  expect(response.headers()['x-keystone-native-fixture']).toBe(process.env.KEYSTONE_NATIVE_ID);
});
async function ready(page: Page) {
  await expect(page.getByTestId('ks-workspace')).toHaveAttribute('data-state', 'ready');
}
async function create(page: Page, prompt: string) {
  await page.goto('/keystone');
  await page.getByTestId('ks-new-prompt').fill(prompt);
  await page.getByRole('checkbox', { name: 'logs', exact: true }).check();
  await page.getByTestId('ks-new-save').click();
  await ready(page);
  const node = await page.getByTestId('ks-inspector').getAttribute('data-node-id');
  expect(node).toBeTruthy();
  return node!;
}
function readRequestBody(body: string | null): unknown {
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    return { unparsedBody: body };
  }
}
function observe(page: Page, info: TestInfo) {
  const calls: NativeCall[] = [];
  page.on('request', (request) => {
    if (request.url().includes(base))
      calls.push({
        method: request.method(),
        url: request.url(),
        body: readRequestBody(request.postData()),
      });
  });
  // afterEach writes even if a browser assertion fails.
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => {
    const call = [...calls]
      .reverse()
      .find(
        (entry) => entry.url === response.url() && entry.method === response.request().method(),
      );
    if (call) call.status = response.status();
  });
  pageErrors.set(info.testId, errors);
  logs.set(info.testId, calls);
  return calls;
}
const logs = new Map<string, NativeCall[]>();
test.afterEach(async ({}, info) => {
  await writeFile(
    info.outputPath('native-requests.json'),
    JSON.stringify(logs.get(info.testId) ?? [], null, 2),
  );
  await info.attach('native-requests', {
    path: info.outputPath('native-requests.json'),
    contentType: 'application/json',
  });
  await info.attach('page-errors', {
    body: JSON.stringify(pageErrors.get(info.testId) ?? []),
    contentType: 'application/json',
  });
  expect(pageErrors.get(info.testId) ?? []).toEqual([]);
  logs.delete(info.testId);
  pageErrors.delete(info.testId);
});
const runs = (calls: NativeCall[]) =>
  calls.filter((call) => call.method === 'POST' && call.url.endsWith('/runs'));
async function start(page: Page): Promise<StartedRun> {
  const accepted = page.waitForResponse(
    (response) => response.request().method() === 'POST' && response.url().endsWith('/runs'),
  );
  await page.getByTestId('ks-run').click();
  const response = await accepted;
  expect(response.status()).toBe(202);
  const body = (await response.json()) as { run: StartedRun };
  expect(body.run.id).toBeTruthy();
  return body.run;
}
function frames(body: string): EventFrame[] {
  return body
    .split(/\r?\n\r?\n/)
    .filter((block) => block.trim() && !block.startsWith(':'))
    .map((block) => {
      const lines = block.split(/\r?\n/);
      const id = Number(lines.find((line) => line.startsWith('id: '))?.slice(4));
      const event = lines.find((line) => line.startsWith('event: '))?.slice(7);
      const data = JSON.parse(
        lines
          .filter((line) => line.startsWith('data: '))
          .map((line) => line.slice(6))
          .join('\n'),
      ) as EventData;
      expect(Number.isSafeInteger(id)).toBe(true);
      expect(event).toBe('keystone');
      return { id, event: event!, data };
    });
}
async function saveArtifact(info: TestInfo, name: string, body: string, contentType: string) {
  const path = info.outputPath(name);
  await writeFile(path, body);
  await info.attach(name, { path, contentType });
}
async function replay(
  page: Page,
  calls: NativeCall[],
  run: StartedRun,
  node: string,
  terminal: string,
  info: TestInfo,
) {
  const events = calls.find((call) =>
    new URL(call.url).pathname.endsWith(`/runs/${run.id}/events`),
  );
  expect(events).toBeTruthy();
  const url = events!.url.split('?')[0];
  const response = await page.request.get(`${url}?after=0`);
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('text/event-stream');
  const body = await response.text();
  await saveArtifact(info, 'native-sse.txt', body, 'text/plain');
  const committed = frames(body);
  expect(committed.length).toBeGreaterThan(4);
  expect(committed.map((frame) => frame.id)).toEqual(committed.map((_, index) => index + 1));
  for (const frame of committed)
    expect(frame.data).toMatchObject({ runId: run.id, nodeId: node, sequence: frame.id });
  expect(committed[committed.length - 1].data.kind).toBe(terminal);
  const after = committed[Math.floor(committed.length / 2) - 1].id;
  const resumed = await page.request.get(`${url}?after=${after}`);
  expect(resumed.status()).toBe(200);
  expect(resumed.headers()['content-type']).toContain('text/event-stream');
  const resumedBody = await resumed.text();
  await saveArtifact(info, 'native-sse-replay.txt', resumedBody, 'text/plain');
  expect(frames(resumedBody)).toEqual(committed.filter((frame) => frame.id > after));
}

test('native save, explicit run, run link/reload, selected direct-parent evidence', async ({
  page,
}, info) => {
  const calls = observe(page, info);
  let node = '';
  let run: StartedRun;
  await test.step('Save a durable draft and navigate without implicit inference', async () => {
    node = await create(page, `Browser diagnostic ${info.testId}`);
    await expect(page.getByTestId(`ks-node-${node}`)).toHaveAttribute('data-status', 'draft');
    const url = page.url();
    await page.reload();
    await ready(page);
    await page.goto(url);
    await ready(page);
    expect(runs(calls)).toHaveLength(0);
  });
  await test.step('Explicit Run completes through real native SSE; run link survives reload', async () => {
    run = await start(page);
    await expect(page.getByTestId(`ks-node-${node}`)).toHaveAttribute('data-status', 'completed', {
      timeout: 20_000,
    });
    await expect(page.getByTestId('ks-inspector-answer')).toContainText(
      'Synthetic diagnostic answer',
    );
    expect(runs(calls)).toHaveLength(1);
    const runLink = page.url();
    expect(new URL(runLink).searchParams.get('run')).toBe(run.id);
    await page.goto('/keystone');
    await page.goto(runLink);
    await ready(page);
    await page.reload();
    await ready(page);
    await expect(page.getByTestId(`ks-node-${node}`)).toHaveAttribute('data-status', 'completed');
    expect(runs(calls)).toHaveLength(1);
  });
  await test.step('Select exactly one source for a draft child; never implicitly run it', async () => {
    await page.getByTestId('ks-follow-up').click();
    const sources = page.getByTestId('ks-context-sources').getByRole('checkbox');
    await expect(sources.first()).toBeVisible();
    for (const source of await sources.all()) await expect(source).not.toBeChecked();
    await sources.first().check();
    const selected = (await sources.first().getAttribute('data-testid'))!.replace(
      'ks-context-source-',
      '',
    );
    await page.getByTestId('ks-composer-prompt').fill('Child synthetic diagnostic');
    const storedResponse = page.waitForResponse(
      (response) => response.request().method() === 'POST' && response.url().endsWith('/nodes'),
    );
    await page.getByTestId('ks-composer-submit').click();
    const stored = await storedResponse;
    expect(stored.status()).toBe(201);
    const storedBody = (await stored.json()) as {
      node: {
        id: string;
        scope: unknown;
        parent: { nodeId: string; version: number };
        selectedRunId: string | null;
      };
      context: {
        manifest: {
          evidence: { id: string }[];
          scope: unknown;
          directParent: { nodeId: string; version: number };
          parentExportHash: string;
          contextPolicy: string;
        };
      };
    };
    expect(storedBody.context.manifest.evidence.map((evidence) => evidence.id)).toEqual([selected]);
    await expect(page.getByTestId(`ks-node-${storedBody.node.id}`)).toHaveAttribute(
      'data-status',
      'draft',
    );
    await expect(page.getByTestId('ks-inspector')).not.toHaveAttribute('data-node-id', node);
    const child: unknown = stored.request().postDataJSON();
    expect(child).toMatchObject({
      parentNodeId: node,
      contextPolicy: 'direct_parent_v1',
      exportedEvidenceIds: [selected],
      requestedScope: null,
      parentExportSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(storedBody.node.scope).toEqual(run.scope);
    expect(storedBody.node.selectedRunId).toBeNull();
    expect(storedBody.node.parent).toEqual({ nodeId: node, version: 1 });
    expect(storedBody.context.manifest).toMatchObject({
      contextPolicy: 'direct_parent_v1',
      scope: run.scope,
      directParent: { nodeId: node, version: 1 },
      parentExportHash: (child as { parentExportSha256: string }).parentExportSha256,
    });
    expect(runs(calls)).toHaveLength(1);
    await page.reload();
    await ready(page);
    await expect(page.getByTestId(`ks-node-${storedBody.node.id}`)).toHaveAttribute(
      'data-status',
      'draft',
    );
    expect(runs(calls)).toHaveLength(1);
  });
  await test.step('Replay committed SSE strictly after the supplied cursor', async () =>
    replay(page, calls, run, node, 'completed', info));
});

test('native composing reload/resubscribe, actual cancellation acknowledgement and terminal reload', async ({
  page,
}, info) => {
  const calls = observe(page, info);
  const node = await create(page, `[diagnostic:hold] browser diagnostic ${info.testId}`);
  let run: StartedRun;
  await test.step('Reload while composing and resubscribe without another Run', async () => {
    run = await start(page);
    await expect(page.getByTestId(`ks-node-${node}`)).toHaveAttribute('data-status', 'composing', {
      timeout: 15_000,
    });
    const before = calls.filter((call) => call.url.includes('/events?')).length;
    await page.reload();
    await ready(page);
    await expect(page.getByTestId('ks-run-live')).toContainText('Live. Steps update');
    await expect(page.getByTestId(`ks-node-${node}`)).toHaveAttribute('data-status', 'composing');
    await expect
      .poll(() => calls.filter((call) => call.url.includes('/events?')).length)
      .toBeGreaterThan(before);
    expect(runs(calls)).toHaveLength(1);
  });
  await test.step('Cancel acknowledges a nonterminal run before terminal cancelled replay', async () => {
    const acknowledgement = page.waitForResponse(
      (response) => response.request().method() === 'POST' && response.url().endsWith('/cancel'),
    );
    await page.getByTestId('ks-cancel-run').click();
    const response = await acknowledgement;
    expect(response.status()).toBe(200);
    const body: unknown = await response.json();
    await saveArtifact(
      info,
      'native-cancel-ack.json',
      JSON.stringify(body, null, 2),
      'application/json',
    );
    expect(body).toMatchObject({ run: { id: run.id, status: 'running' } });
    await expect(page.getByTestId(`ks-node-${node}`)).toHaveAttribute('data-status', 'cancelled', {
      timeout: 15_000,
    });
    await page.reload();
    await ready(page);
    await expect(page.getByTestId(`ks-node-${node}`)).toHaveAttribute('data-status', 'cancelled');
    expect(runs(calls)).toHaveLength(1);
  });
  await test.step('Replay committed cancellation SSE after a cursor', async () =>
    replay(page, calls, run, node, 'cancelled', info));
});
