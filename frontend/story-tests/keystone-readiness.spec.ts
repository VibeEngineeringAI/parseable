import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type { PageFixtureRequest } from '../src/features/keystone/fixtures/pageHarness';

// Server-shaped capability bodies run through the real native decoder; the fixture
// answers them locally, so no server, provider or query is contacted.
const errors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  const messages: string[] = [];
  errors.set(page, messages);
  page.on('pageerror', (error) => messages.push(error.message));
});
test.afterEach(async ({ page }) => {
  expect(errors.get(page)).toEqual([]);
});

async function open(page: Page, story: string, state: 'ready' | 'error' = 'ready') {
  await page.goto(`/iframe.html?id=keystone-full-page--${story}&viewMode=story`);
  await expect(page.getByTestId('ks-page')).toHaveAttribute('data-state', state);
}
async function requests(page: Page): Promise<PageFixtureRequest[]> {
  return page.evaluate(() => window.__ksPageRequests ?? []);
}
async function audit(page: Page) {
  const result = await new AxeBuilder({ page })
    .include('.ks-page')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(result.violations).toEqual([]);
}

test('a default server explains that storage is not enabled, not a role problem', async ({
  page,
}) => {
  await open(page, 'storage-unavailable');
  await expect(page.getByTestId('ks-readiness-storage')).toHaveAttribute(
    'data-state',
    'unavailable',
  );
  await expect(page.getByTestId('ks-readiness-storage')).toContainText('not enabled');
  await expect(page.getByTestId('ks-readiness-execution')).toHaveAttribute(
    'data-state',
    'unavailable',
  );
  await expect(page.getByTestId('ks-page-denied')).toHaveCount(0);
  await expect(page.getByTestId('ks-saved')).toHaveCount(0);
  await expect(page.getByTestId('ks-new-investigation')).toHaveCount(0);
  // Without a classic UI beside it, no classic link is offered.
  await expect(page.getByTestId('ks-classic-link')).toHaveCount(0);
  expect((await requests(page)).map((request) => request.kind)).toEqual(['pageCapabilities']);
  await audit(page);
});

test('degraded storage on an investigation link explains recovery and loads nothing', async ({
  page,
}) => {
  await open(page, 'storage-degraded');
  await expect(page.getByTestId('ks-page')).toHaveAttribute('data-view', 'investigation');
  await expect(page.getByTestId('ks-readiness-storage')).toContainText('restart');
  await expect(page.getByTestId('ks-page-denied')).toHaveCount(0);
  await expect(page.getByTestId('ks-workspace')).toHaveCount(0);
  expect((await requests(page)).map((request) => request.kind)).toEqual(['pageCapabilities']);
});

test('a node that does not serve investigations reports storage, not access', async ({ page }) => {
  await open(page, 'ingest-node');
  await expect(page.getByTestId('ks-readiness-storage')).toHaveAttribute(
    'data-state',
    'unavailable',
  );
  await expect(page.getByTestId('ks-page-denied')).toHaveCount(0);
  expect((await requests(page)).map((request) => request.kind)).toEqual(['pageCapabilities']);
});

// An investigation link the page cannot open makes only the capability read: no
// dataset listing or metadata lookup, no investigation read and no write.
const gated: { story: string; state: 'ready' | 'error'; shows: string }[] = [
  { story: 'denied-investigation', state: 'ready', shows: 'ks-page-denied' },
  { story: 'storage-unavailable-investigation', state: 'ready', shows: 'ks-readiness' },
  { story: 'storage-degraded', state: 'ready', shows: 'ks-readiness' },
  { story: 'unsupported-server-investigation', state: 'error', shows: 'ks-page-error' },
  { story: 'session-expired', state: 'error', shows: 'ks-page-error' },
  { story: 'access-forbidden', state: 'error', shows: 'ks-page-error' },
];
for (const { story, state, shows } of gated)
  test(`${story} reads only capabilities before the gate`, async ({ page }) => {
    await open(page, story, state);
    await expect(page.getByTestId('ks-page')).toHaveAttribute('data-view', 'investigation');
    await expect(page.getByTestId(shows)).toBeVisible();
    await expect(page.getByTestId('ks-workspace')).toHaveCount(0);
    // Give a stray effect time to start before reading the ledger.
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 250)));
    expect((await requests(page)).map((request) => request.kind)).toEqual(['pageCapabilities']);
  });

test('a plain-text 401 from the auth middleware reads as an access problem', async ({ page }) => {
  await open(page, 'session-expired', 'error');
  const error = page.getByTestId('ks-page-error');
  await expect(error).toHaveAttribute('data-kind', 'denied');
  await expect(error).toContainText('You do not have permission for this. Sign in again');
  await expect(error).not.toContainText('cannot read');
  await expect(error).not.toContainText('Unauthorized');
  // No classic UI beside this page, so no classic link.
  await expect(page.getByTestId('ks-classic-link')).toHaveCount(0);
  await audit(page);
});

test('a plain-text 403 from the auth middleware reads as an access problem', async ({ page }) => {
  await open(page, 'access-forbidden', 'error');
  const error = page.getByTestId('ks-page-error');
  await expect(error).toHaveAttribute('data-kind', 'denied');
  await expect(error).toContainText('You do not have permission for this');
  await expect(error).not.toContainText('cannot read');
  await expect(error).not.toContainText('Forbidden');
  await expect(page.getByTestId('ks-classic-link').getByRole('link')).toHaveAttribute(
    'href',
    '/keystone/inv-fixture-completed',
  );
  await audit(page);
});

test('an HTML 200 stays an unreadable response, not an access problem', async ({ page }) => {
  await open(page, 'unsupported-server-investigation', 'error');
  await expect(page.getByTestId('ks-page-error')).toHaveAttribute('data-kind', 'invalid');
  await expect(page.getByTestId('ks-page-error')).toContainText('cannot read');
});

test('an open investigation lists datasets only after the capability read', async ({ page }) => {
  await open(page, 'ready-investigation');
  await expect(page.getByTestId('ks-workspace')).toBeVisible();
  await expect
    .poll(async () => (await requests(page)).filter((r) => r.kind === 'datasetInfo').length)
    .toBeGreaterThan(0);
  const kinds = (await requests(page)).map((request) => request.kind);
  expect(kinds[0]).toBe('pageCapabilities');
  expect(kinds.filter((kind) => kind === 'listDatasets')).toHaveLength(1);
  expect(kinds.indexOf('listDatasets')).toBeGreaterThan(kinds.indexOf('pageCapabilities'));
  // Internal names are never looked up.
  const lookups = (await requests(page)).filter((request) => request.kind === 'datasetInfo');
  expect(lookups.every((request) => !request.path.includes('/_'))).toBe(true);
  expect((await requests(page)).filter((request) => request.method !== 'GET')).toEqual([]);
  expect((await requests(page)).filter((request) => request.startsInference)).toEqual([]);
});

test('a server without Keystone offers the classic UI beside the error', async ({ page }) => {
  await open(page, 'unsupported-server', 'error');
  await expect(page.getByTestId('ks-page-error')).toBeVisible();
  const link = page.getByTestId('ks-classic-link').getByRole('link');
  await expect(link).toHaveText('Open Keystone in the classic UI');
  await expect(link).toHaveAttribute('href', '/keystone');
  expect((await requests(page)).map((request) => request.kind)).toEqual(['pageCapabilities']);
  await audit(page);
});

test('a classic investigation link this server does not hold leads back to the classic UI', async ({
  page,
}) => {
  await open(page, 'classic-only-investigation');
  await expect(page.getByTestId('ks-workspace')).toHaveAttribute('data-state', 'unavailable');
  const link = page.getByTestId('ks-classic-link').getByRole('link');
  await expect(link).toHaveText('Open this investigation in the classic UI');
  // A plain same-origin path outside the router, with the ID as one encoded segment.
  await expect(link).toHaveAttribute('href', '/keystone/inv-classic-only');
  const kinds = (await requests(page)).map((request) => request.kind);
  expect(kinds).toContain('graph');
  expect(kinds).not.toContain('layout.patch');
  expect((await requests(page)).filter((request) => request.startsInference)).toEqual([]);
  await audit(page);
});
