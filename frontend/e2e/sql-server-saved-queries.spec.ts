import { createHash } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import type { SavedLogView } from '../src/lib/types';

const hash = (id: string) => createHash('sha256').update(id).digest('hex');
const classicSql = (owner: string, extra: Partial<SavedLogView> = {}): SavedLogView => ({
  version: 'v2',
  user_id: hash(owner),
  stream_name: 'sql',
  filter_name: 'Slow requests',
  filter_id: '01HCLASSICSQL',
  query: {
    filter_type: 'sql',
    filter_query: 'SELECT * FROM "events" WHERE latency > 500',
    filter_builder: null,
  },
  time_filter: { from: '2026-10-01T00:00:00.000Z', to: '2026-10-02T00:00:00.000Z' },
  tenant_id: null,
  ...extra,
});
const classicLogs: SavedLogView = {
  version: 'v1',
  user_id: hash('someone-else'),
  stream_name: 'events',
  filter_name: 'Event errors',
  filter_id: '01HCLASSICLOGS',
  query: { filter_type: 'sql', filter_query: "SELECT * FROM events WHERE level = 'error'" },
  time_filter: { from: 'now-1h', to: 'now' },
};
const classicBuilder: SavedLogView = {
  version: 'v2',
  user_id: hash('reader'),
  stream_name: 'events',
  filter_name: 'Builder view',
  filter_id: '01HBUILDER',
  query: {
    filter_type: 'filter',
    filter_query: null,
    filter_builder: {
      id: 'root',
      combinator: 'and',
      rules: [
        {
          id: 'g',
          combinator: 'and',
          rules: [{ id: 'r', field: 'level', value: 'error', operator: '=' }],
        },
      ],
    },
  },
  time_filter: null,
};
const local = {
  id: 'local-mine',
  name: 'Local only',
  sql: 'SELECT 1',
  range: '1h',
  datasets: ['events'],
  updatedAt: '2026-10-20T00:00:00.000Z',
};
const libraryKey = (origin: string, user: string) =>
  `parseable-sql:v1:${encodeURIComponent(origin)}:${encodeURIComponent(user)}:library`;

async function serve(
  page: Page,
  filters: (user: string) => Promise<{ status?: number; body?: string; json?: unknown }>,
) {
  const writes: string[] = [];
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    const user = /user_id=([^;]+)/.exec(request.headers().cookie ?? '')?.[1] ?? '';
    const users = /\/users\/([^/]+)$/.exec(path);
    if (users) return route.fulfill({ json: { id: users[1], username: users[1] } });
    if (path.endsWith('/logstream')) return route.fulfill({ json: [{ name: 'events' }] });
    if (path.endsWith('/schema'))
      return route.fulfill({ json: { fields: [{ name: 'p_timestamp' }, { name: 'message' }] } });
    if (path.endsWith('/info')) return route.fulfill({ json: { timePartition: 'p_timestamp' } });
    if (path.includes('/filters')) {
      if (request.method() !== 'GET') {
        writes.push(`${request.method()} ${path}`);
        return route.fulfill({ status: 500, body: 'unexpected write' });
      }
      const response = await filters(user);
      return route.fulfill(response).catch(() => {
        /* The page may have navigated away and cancelled this request. */
      });
    }
    if (path.endsWith('/query')) return route.fulfill({ json: [] });
    return route.fulfill({ json: {} });
  });
  return writes;
}
async function seedLocal(page: Page, user: string, items: unknown[]) {
  await page.addInitScript(
    ({ user, items }) => {
      const key = `parseable-sql:v1:${encodeURIComponent(location.origin)}:${encodeURIComponent(user)}:library`;
      if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(items));
    },
    { user, items },
  );
}
const serverList = (page: Page) =>
  page.getByLabel('SQL datasets and saved queries').getByLabel('Server saved queries');

test('opening identical server SQL with different datasets preserves each draft scope', async ({
  page,
  context,
  baseURL,
}) => {
  await context.addCookies([{ name: 'user_id', value: 'reader', url: baseURL! }]);
  const writes = await serve(page, async () => ({
    json: [
      classicSql('reader'),
      classicSql('reader', { filter_id: '01HSCOPED', stream_name: 'events' }),
    ],
  }));
  await page.goto('/sql-editor');
  const opens = serverList(page).getByRole('button', { name: /^Slow requests/ });
  await expect(opens).toHaveCount(2);
  await opens.nth(0).click();
  await expect(
    page.getByRole('checkbox', { name: 'Select events', exact: true }),
  ).not.toBeChecked();
  await opens.nth(1).click();
  await expect(page.getByRole('checkbox', { name: 'Select events', exact: true })).toBeChecked();
  await expect(page.getByRole('tab', { name: 'Slow requests', exact: true })).toHaveCount(2);
  await opens.nth(0).click();
  await expect(
    page.getByRole('checkbox', { name: 'Select events', exact: true }),
  ).not.toBeChecked();
  await opens.nth(1).click();
  await expect(page.getByRole('tab', { name: 'Slow requests', exact: true })).toHaveCount(2);
  await page.getByRole('button', { name: 'Save as new', exact: true }).click();
  const stored = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key) || '[]'),
    libraryKey(new URL(baseURL!).origin, 'reader'),
  );
  expect(stored).toHaveLength(1);
  expect(stored[0].datasets).toEqual(['events']);
  expect(writes).toEqual([]);
});

test('lists classic server SQL read only, opens it and copies it without losing local queries', async ({
  page,
  context,
  baseURL,
}) => {
  await context.addCookies([{ name: 'user_id', value: 'reader', url: baseURL! }]);
  await seedLocal(page, 'reader', [local]);
  const writes = await serve(page, async () => ({
    json: [classicSql('reader'), classicLogs, classicBuilder],
  }));
  await page.goto('/sql-editor');
  const list = serverList(page);
  await expect(list.getByRole('button', { name: /^Slow requests/ })).toContainText('SQL');
  await expect(list.getByRole('button', { name: /^Slow requests/ })).not.toContainText('shared');
  await expect(list.getByRole('button', { name: /^Event errors/ })).toContainText(
    'Logs view · shared',
  );
  // Builder views have no SQL and are never translated.
  await expect(list.getByText('Builder view')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Local only', exact: true })).toBeVisible();

  await list.getByRole('button', { name: /^Slow requests/ }).click();
  await expect(page.getByRole('tab', { name: 'Slow requests', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'SQL query' })).toHaveText(
    'SELECT * FROM "events" WHERE latency > 500',
  );
  await list.getByRole('button', { name: /^Slow requests/ }).click();
  await expect(page.getByRole('tab', { name: 'Slow requests', exact: true })).toHaveCount(1);

  await page
    .getByRole('button', { name: 'Copy server query Event errors to this browser' })
    .click();
  await expect(page.getByText('Copied Event errors to this browser library.')).toBeVisible();
  await page
    .getByRole('button', { name: 'Copy server query Event errors to this browser' })
    .click();
  await expect(page.getByText('Event errors is already in this browser library.')).toBeVisible();
  const stored = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key) || '[]'),
    libraryKey(new URL(baseURL!).origin, 'reader'),
  );
  expect(stored.map((item: { name: string }) => item.name)).toEqual(['Event errors', 'Local only']);
  expect(stored[0]).toMatchObject({
    sql: classicLogs.query.filter_query,
    datasets: ['events'],
    range: '1h',
  });
  expect(stored[1]).toEqual(local);
  expect(writes).toEqual([]);
});

test('reports failure and permission errors and retries without touching local queries', async ({
  page,
  context,
  baseURL,
}) => {
  await context.addCookies([{ name: 'user_id', value: 'reader', url: baseURL! }]);
  await seedLocal(page, 'reader', [local]);
  // Development StrictMode may repeat the initial request, so phases are explicit.
  let phase: 'unavailable' | 'ok' | 'forbidden' = 'unavailable';
  const writes = await serve(page, async () =>
    phase === 'unavailable'
      ? { status: 503, body: 'Filters unavailable' }
      : phase === 'ok'
        ? { json: [classicSql('reader')] }
        : { status: 403, body: 'Forbidden' },
  );
  await page.goto('/sql-editor');
  const sidebar = page.getByLabel('SQL datasets and saved queries');
  await expect(sidebar.getByRole('alert')).toContainText('Filters unavailable');
  await expect(page.getByRole('button', { name: 'Local only', exact: true })).toBeVisible();
  phase = 'ok';
  await sidebar.getByRole('button', { name: 'Retry server saved queries' }).click();
  await expect(serverList(page).getByRole('button', { name: /^Slow requests/ })).toBeVisible();
  phase = 'forbidden';
  await page.reload();
  await expect(sidebar.getByRole('alert')).toContainText(
    'You do not have permission to list server saved queries.',
  );
  await expect(sidebar.getByRole('button', { name: 'Retry server saved queries' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Local only', exact: true })).toBeVisible();
  expect(writes).toEqual([]);
});

test('an expired session signs in again and keeps the local library', async ({
  page,
  context,
  baseURL,
}) => {
  await context.addCookies([{ name: 'user_id', value: 'reader', url: baseURL! }]);
  await seedLocal(page, 'reader', [local]);
  await serve(page, async () => ({ status: 401, body: 'Session expired' }));
  await page.goto('/sql-editor');
  await expect(page).toHaveURL(/\/login\?next=/);
  expect(
    await page.evaluate(
      (key) => localStorage.getItem(key),
      libraryKey(new URL(baseURL!).origin, 'reader'),
    ),
  ).toBe(JSON.stringify([local]));
});

test('switching accounts discards an in-flight list and shows only the new account', async ({
  page,
  context,
  baseURL,
}) => {
  await context.addCookies([{ name: 'user_id', value: 'alice', url: baseURL! }]);
  await seedLocal(page, 'alice', [{ ...local, name: 'Alice local' }]);
  await seedLocal(page, 'bob', [{ ...local, name: 'Bob local' }]);
  let releaseAlice!: () => void;
  const alice = new Promise<void>((resolve) => (releaseAlice = resolve));
  await serve(page, async (user) => {
    if (user === 'alice') {
      await alice;
      return { json: [classicSql('alice', { filter_name: 'Alice server' })] };
    }
    return { json: [classicSql('bob', { filter_name: 'Bob server', filter_id: 'bob' })] };
  });
  await page.goto('/sql-editor');
  await expect(page.getByText('Loading server saved queries…')).toBeVisible();
  await context.clearCookies();
  await context.addCookies([{ name: 'user_id', value: 'bob', url: baseURL! }]);
  await page.reload();
  releaseAlice();
  await expect(serverList(page).getByRole('button', { name: /^Bob server/ })).toBeVisible();
  await expect(page.getByText('Alice server')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Bob local', exact: true })).toBeVisible();
  await expect(page.getByText('Alice local')).toHaveCount(0);
  const origin = new URL(baseURL!).origin;
  const stored = await page.evaluate(
    (keys) => keys.map((key) => JSON.parse(localStorage.getItem(key) || '[]')[0]?.name),
    [libraryKey(origin, 'alice'), libraryKey(origin, 'bob')],
  );
  expect(stored).toEqual(['Alice local', 'Bob local']);
});

test('demo keeps its own browser library alongside demo server views', async ({ page }) => {
  await page.addInitScript(() => {
    sessionStorage.setItem('parseable-mode', 'demo');
    if (!localStorage.getItem('parseable-sql:v1:demo:library'))
      localStorage.setItem(
        'parseable-sql:v1:demo:library',
        JSON.stringify([
          {
            id: 'demo-local',
            name: 'Demo local',
            sql: 'SELECT 1',
            range: '1h',
            datasets: [],
            updatedAt: '2026-10-20T00:00:00.000Z',
          },
        ]),
      );
  });
  await page.goto('/sql-editor');
  await expect(page.getByRole('button', { name: 'Demo local', exact: true })).toBeVisible();
  await expect(
    page.getByLabel('SQL datasets and saved queries').getByText('No server saved queries.'),
  ).toBeVisible();
});

test('classic Logs views open their stored SQL read only; builder views stay unavailable', async ({
  page,
  context,
  baseURL,
}) => {
  await context.addCookies([{ name: 'user_id', value: 'reader', url: baseURL! }]);
  const views = [
    { ...classicLogs, user_id: hash('reader'), time_filter: { from: 'now-2d', to: 'now' } },
    classicBuilder,
  ];
  const before = structuredClone(views);
  const writes = await serve(page, async () => ({ json: views }));
  await page.goto('/logs/explore/events');
  await page.getByRole('button', { name: 'Saved views', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Saved log views' });
  const select = dialog.getByLabel('Saved log view');
  await select.selectOption({ label: 'Builder view (classic or incompatible)' });
  await expect(dialog.getByText(/stores a filter builder or search instead of SQL/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Open in SQL editor' })).toBeDisabled();
  await select.selectOption({ label: 'Event errors (classic or incompatible)' });
  await expect(dialog.getByText(/saved time range is unreadable/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Apply view', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Convert to SQL view' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Open in SQL editor' }).click();
  await expect(page).toHaveURL(/\/sql-editor\?/);
  expect(new URL(page.url()).searchParams.get('query')).toBe(classicLogs.query.filter_query);
  await expect(page.getByRole('textbox', { name: 'SQL query' })).toHaveText(
    classicLogs.query.filter_query!,
  );
  expect(writes).toEqual([]);
  expect(views).toEqual(before);
});

const nativeWeek: SavedLogView = {
  version: 'v2',
  user_id: hash('reader'),
  stream_name: 'sql',
  filter_name: 'Native week',
  filter_id: '01HNATIVE',
  query: { filter_type: 'sql', filter_query: 'SELECT * FROM "events" LIMIT 500' },
  explorer_state: JSON.stringify({
    version: 1,
    dataset: 'events',
    range: '7d',
    search: '',
    expression: { combinator: 'and', groups: [] },
    timezone: 'UTC',
    limit: 500,
    wrap: false,
    showHistogram: true,
  }),
  time_filter: null,
};

test('classic relative windows keep supported presets and warn before using a fallback', async ({
  page,
  context,
  baseURL,
}) => {
  await context.addCookies([{ name: 'user_id', value: 'reader', url: baseURL! }]);
  const writes = await serve(page, async () => ({
    json: [
      { ...classicLogs, filter_name: 'Week errors', time_filter: { from: 'now-7d', to: 'now' } },
      {
        ...classicLogs,
        filter_id: '01HTWODAYS',
        filter_name: 'Two day errors',
        query: { filter_type: 'sql', filter_query: 'SELECT 2' },
        time_filter: { from: 'now-2d', to: 'now' },
      },
    ],
  }));
  await page.goto('/sql-editor');
  const list = serverList(page);
  await expect(list.getByRole('note')).toHaveCount(1);
  await expect(list.getByRole('note')).toHaveText(
    'Saved time range now-2d to now is not supported; opening or copying uses the last hour.',
  );
  await list.getByRole('button', { name: /^Week errors/ }).click();
  await expect(page.getByRole('textbox', { name: 'SQL query' })).toHaveText(
    classicLogs.query.filter_query!,
  );
  await expect(page.getByLabel('Time range', { exact: true })).toHaveValue('7d');
  await list.getByRole('button', { name: /^Two day errors/ }).click();
  await expect(page.getByRole('textbox', { name: 'SQL query' })).toHaveText('SELECT 2');
  await expect(page.getByLabel('Time range', { exact: true })).toHaveValue('1h');
  expect(writes).toEqual([]);
});

test('native Logs views open in SQL with their saved relative range', async ({
  page,
  context,
  baseURL,
}) => {
  await context.addCookies([{ name: 'user_id', value: 'reader', url: baseURL! }]);
  const views = [nativeWeek];
  const before = structuredClone(views);
  const writes = await serve(page, async () => ({ json: views }));
  await page.goto('/logs/explore/events');
  await page.getByRole('button', { name: 'Saved views', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Saved log views' });
  await dialog.getByLabel('Saved log view').selectOption({ label: 'Native week' });
  await dialog.getByRole('button', { name: 'Open in SQL editor' }).click();
  await expect(page.getByRole('textbox', { name: 'SQL query' })).toHaveText(
    nativeWeek.query.filter_query!,
  );
  await expect(page.getByLabel('Time range', { exact: true })).toHaveValue('7d');
  // The consumed handoff leaves no query, range or bounds in the URL.
  await expect(page).toHaveURL(/\/sql-editor$/);

  await serverList(page)
    .getByRole('button', { name: /^Native week/ })
    .click();
  await expect(page.getByRole('tab', { name: 'Native week', exact: true })).toHaveCount(1);
  await expect(page.getByLabel('Time range', { exact: true })).toHaveValue('7d');
  expect(writes).toEqual([]);
  expect(views).toEqual(before);
});

test('copies same-named server queries with different windows or datasets separately', async ({
  page,
  context,
  baseURL,
}) => {
  await context.addCookies([{ name: 'user_id', value: 'reader', url: baseURL! }]);
  const writes = await serve(page, async () => ({
    json: [
      classicSql('reader'),
      classicSql('reader', {
        filter_id: '01HOCTOBER5',
        time_filter: { from: '2026-10-05T00:00:00.000Z', to: '2026-10-06T00:00:00.000Z' },
      }),
      classicSql('reader', { filter_id: '01HSCOPED', stream_name: 'events' }),
    ],
  }));
  await page.goto('/sql-editor');
  const copies = page.getByRole('button', {
    name: 'Copy server query Slow requests to this browser',
  });
  await expect(copies).toHaveCount(3);
  for (const index of [0, 1, 2]) {
    await copies.nth(index).click();
    await expect(page.getByText('Copied Slow requests to this browser library.')).toBeVisible();
  }
  await copies.nth(1).click();
  await expect(page.getByText('Slow requests is already in this browser library.')).toBeVisible();
  const stored = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key) || '[]'),
    libraryKey(new URL(baseURL!).origin, 'reader'),
  );
  expect(
    stored.map((item: { range: unknown; datasets: string[] }) => [item.range, item.datasets]),
  ).toEqual(
    expect.arrayContaining([
      [{ startTime: '2026-10-01T00:00:00.000Z', endTime: '2026-10-02T00:00:00.000Z' }, []],
      [{ startTime: '2026-10-05T00:00:00.000Z', endTime: '2026-10-06T00:00:00.000Z' }, []],
      [{ startTime: '2026-10-01T00:00:00.000Z', endTime: '2026-10-02T00:00:00.000Z' }, ['events']],
    ]),
  );
  expect(stored).toHaveLength(3);
  expect(writes).toEqual([]);
});
