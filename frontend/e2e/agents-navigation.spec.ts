import { expect, test, type Page } from '@playwright/test';
import { agentDemoFields, agentDemoRows } from '../src/lib/agents';
import { storyTraceDetail, storyTraceList } from '../src/features/traces/fixtures';
import { encodeLogView } from '../src/features/logs/logViewState';
import { initialLogView } from '../src/features/logs/logViewReducer';

const bounds = { startTime: '2026-10-12T09:00:00.000Z', endTime: '2026-10-12T10:00:00.000Z' };
async function mockNavigation(page: Page) {
  const queries: Array<{ query: string; startTime: string; endTime: string }> = [];
  const details: Array<{ traceId: string; startTime: string; endTime: string }> = [];
  const lists: Array<{
    serviceName?: string;
    options?: string;
    startTime: string;
    endTime: string;
  }> = [];
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/v1/logstream') return route.fulfill({ json: [{ name: 'agent_telemetry' }] });
    if (path.endsWith('/schema'))
      return route.fulfill({
        json: { fields: [...agentDemoFields, 'message', 'level'].map((name) => ({ name })) },
      });
    if (path.endsWith('/info'))
      return route.fulfill({
        json: { telemetryType: 'traces', logSource: [{ log_source_format: 'otel-traces' }] },
      });
    if (path === '/api/v1/about') return route.fulfill({ json: { capabilities: {} } });
    if (path.endsWith('/services/traces/list')) {
      lists.push(route.request().postDataJSON());
      return route.fulfill({
        json: {
          count: storyTraceList.length,
          records: storyTraceList.slice(0, 25),
          offset: 0,
          limit: 25,
        },
      });
    }
    if (path.endsWith('/services/traces/detail')) {
      details.push(route.request().postDataJSON());
      return route.fulfill({ json: storyTraceDetail });
    }
    if (path === '/api/v1/query') {
      queries.push(route.request().postDataJSON());
      return route.fulfill({
        json: agentDemoRows(Date.parse(bounds.endTime)).map((row) => ({
          ...row,
          message: 'Support request',
          level: 'error',
        })),
      });
    }
    return route.fulfill({ status: 404, body: 'No fixture' });
  });
  return { queries, details, lists };
}

test('Agents trace drilldown and browser back preserve filters, selected run and captured window', async ({
  page,
}) => {
  const calls = await mockNavigation(page);
  await page.goto(
    `/agents/agent_telemetry?${new URLSearchParams({ start: bounds.startTime, end: bounds.endTime, range: '1h', search: 'Support', status: 'success', model: 'example-model' })}`,
  );
  await expect(page.getByLabel('Search agent runs')).toHaveValue('Support');
  await expect(page.getByRole('button', { name: 'Inspect run Support assistant' })).toBeVisible();
  await page.getByRole('button', { name: 'Inspect run Support assistant' }).click();
  await page.getByRole('link', { name: 'Open trace', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Trace detail' })).toBeVisible();
  await expect.poll(() => calls.details.length).toBeGreaterThan(0);
  expect(calls.details.at(-1)).toMatchObject({
    ...bounds,
    traceId: '00000000000000000000000000000001',
  });
  await expect(page.getByLabel('Time range', { exact: true })).toHaveValue('1h');
  expect(new URL(page.url()).searchParams.has('model')).toBe(false);
  await page.goBack();
  await expect(page.getByRole('dialog', { name: 'Agent run details' })).toBeVisible();
  await expect(page.getByLabel('Search agent runs')).toHaveValue('Support');
  await expect(page.getByLabel('Run status')).toHaveValue('success');
  await expect(page.getByLabel('Run model')).toHaveValue('example-model');
  await expect(page.getByLabel('Time range', { exact: true })).toHaveValue('1h');
});

test('sidebar travel restores independent grouped log filters, trace filters and Agent filters', async ({
  page,
}) => {
  const calls = await mockNavigation(page);
  const logView = {
    ...initialLogView('agent_telemetry'),
    range: bounds,
    search: 'Support',
    expression: {
      combinator: 'or' as const,
      groups: [
        {
          id: 'g',
          combinator: 'and' as const,
          rules: [{ id: 'r', field: 'level', operator: '=' as const, value: 'error' }],
        },
      ],
    },
  };
  await page.goto(
    `/logs/explore/agent_telemetry?${new URLSearchParams({ logView: encodeLogView(logView) })}`,
  );
  await expect(page.getByLabel('Search messages')).toHaveValue('Support');
  await expect(page.getByLabel('Remove filter level = error')).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.has('observe')).toBe(true);
  await page.getByTestId('sidebar-agents').click();
  await expect(page.getByRole('button', { name: 'Inspect run Support assistant' })).toBeVisible();
  await page.getByLabel('Search agent runs').fill('Support');
  await page.getByLabel('Run status').selectOption('success');
  await page.getByLabel('Run model').selectOption('example-model');
  await page.getByTestId('sidebar-traces').click();
  await expect(page.getByTestId('trace-table')).toBeVisible();
  await page.getByLabel('Service', { exact: true }).fill('worker');
  await page.getByRole('button', { name: 'Apply service' }).click();
  await page.getByLabel('Status', { exact: true }).selectOption('error');
  await page.getByLabel('Sort by').selectOption('longestFirst');
  await expect.poll(() => calls.lists.at(-1)?.serviceName).toBe('worker');
  await page.getByTestId('sidebar-logs').click();
  await expect(page.getByLabel('Search messages')).toHaveValue('Support');
  await expect(page.getByLabel('Remove filter level = error')).toBeVisible();
  await expect.poll(() => calls.queries.at(-1)?.query).toContain('"level" = \'error\'');
  await expect.poll(() => new URL(page.url()).searchParams.has('logView')).toBe(false);
  await page.getByTestId('sidebar-agents').click();
  await expect(page.getByLabel('Search agent runs')).toHaveValue('Support');
  await expect(page.getByLabel('Run status')).toHaveValue('success');
  await expect(page.getByLabel('Run model')).toHaveValue('example-model');
  await page.getByTestId('sidebar-traces').click();
  await expect(page.getByLabel('Service', { exact: true })).toHaveValue('worker');
  await expect(page.getByLabel('Status', { exact: true })).toHaveValue('error');
  await expect(page.getByLabel('Sort by')).toHaveValue('longestFirst');
  expect(calls.lists.at(-1)).toMatchObject(bounds);
});

test('opening run logs combines trace focus with saved log criteria and retains absolute bounds', async ({
  page,
}) => {
  const calls = await mockNavigation(page);
  await page.goto(
    `/agents/agent_telemetry?${new URLSearchParams({ start: bounds.startTime, end: bounds.endTime })}`,
  );
  await page.getByRole('button', { name: 'Inspect run Support assistant' }).click();
  await page
    .getByRole('dialog', { name: 'Agent run details' })
    .getByRole('link', { name: 'Open logs', exact: true })
    .click();
  await expect(page.getByRole('button', { name: 'Clear trace filter' })).toBeVisible();
  await expect
    .poll(() => calls.queries.at(-1)?.query)
    .toContain('"span_trace_id" = \'00000000000000000000000000000001\'');
  expect(calls.queries.at(-1)).toMatchObject(bounds);
  await page.getByTestId('sidebar-agents').click();
  await expect(page.getByRole('dialog', { name: 'Agent run details' })).toBeVisible();
});

test('consumed Logs navigation restores filters on reload and browser back', async ({ page }) => {
  const calls = await mockNavigation(page);
  const logView = {
    ...initialLogView('agent_telemetry'),
    range: bounds,
    search: 'Support',
    expression: {
      combinator: 'and' as const,
      groups: [
        {
          id: 'g',
          combinator: 'and' as const,
          rules: [{ id: 'r', field: 'level', operator: '=' as const, value: 'error' }],
        },
      ],
    },
  };
  await page.goto(
    `/logs/explore/agent_telemetry?${new URLSearchParams({ logView: encodeLogView(logView) })}`,
  );
  await expect.poll(() => new URL(page.url()).searchParams.has('observe')).toBe(true);
  await page.reload();
  await expect(page.getByLabel('Search messages')).toHaveValue('Support');
  await expect(page.getByLabel('Remove filter level = error')).toBeVisible();
  await expect.poll(() => calls.queries.at(-1)?.query).toContain('"level" = \'error\'');
  expect(calls.queries.at(-1)).toMatchObject(bounds);
  await page.getByTestId('sidebar-agents').click();
  await expect(page.getByRole('button', { name: 'Inspect run Support assistant' })).toBeVisible();
  await page.goBack();
  await expect(page.getByLabel('Search messages')).toHaveValue('Support');
  await expect(page.getByLabel('Remove filter level = error')).toBeVisible();
  expect(calls.queries.at(-1)).toMatchObject(bounds);
});

test('switching Logs dataset during a native handoff resets its filters and retains the window', async ({
  page,
}) => {
  const calls = await mockNavigation(page);
  await page.route('**/api/v1/logstream', (route) =>
    route.fulfill({ json: [{ name: 'agent_telemetry' }, { name: 'other_dataset' }] }),
  );
  const logView = { ...initialLogView('agent_telemetry'), range: bounds, search: 'Support' };
  await page.goto(
    `/logs/explore/agent_telemetry?${new URLSearchParams({ logView: encodeLogView(logView) })}`,
  );
  await expect.poll(() => new URL(page.url()).searchParams.has('observe')).toBe(true);
  await page.getByLabel('Dataset', { exact: true }).selectOption('other_dataset');
  await expect(page.getByLabel('Search messages')).toHaveValue('');
  await expect.poll(() => calls.queries.at(-1)?.query).toContain('"other_dataset"');
  expect(calls.queries.at(-1)).toMatchObject(bounds);
  await expect(page.getByText('The shared view dataset does not match this page.')).toHaveCount(0);
});

test('trace focus narrows OR groups and replacing the focused run never retains an old trace predicate', async ({
  page,
}) => {
  const calls = await mockNavigation(page);
  const logView = {
    ...initialLogView('agent_telemetry'),
    range: bounds,
    expression: {
      combinator: 'or' as const,
      groups: [
        {
          id: 'g1',
          combinator: 'and' as const,
          rules: [{ id: 'r1', field: 'level', operator: '=' as const, value: 'error' }],
        },
        {
          id: 'g2',
          combinator: 'and' as const,
          rules: [{ id: 'r2', field: 'message', operator: '=' as const, value: 'Support request' }],
        },
      ],
    },
  };
  await page.goto(
    `/logs/explore/agent_telemetry?${new URLSearchParams({ logView: encodeLogView(logView) })}`,
  );
  await expect.poll(() => new URL(page.url()).searchParams.has('observe')).toBe(true);
  await page.getByTestId('sidebar-agents').click();
  await page.getByRole('button', { name: 'Inspect run Support assistant' }).click();
  await page
    .getByRole('dialog', { name: 'Agent run details' })
    .getByRole('link', { name: 'Open logs', exact: true })
    .click();
  await expect(page.getByRole('button', { name: 'Clear trace filter' })).toBeVisible();
  await expect
    .poll(() => calls.queries.at(-1)?.query)
    .toContain('"span_trace_id" = \'00000000000000000000000000000001\'');
  expect(calls.queries.at(-1)?.query).toContain(' OR ');
  await expect(page.getByLabel('Match groups')).toHaveValue('or');
  await page.getByTestId('sidebar-agents').click();
  await expect(page.getByRole('dialog', { name: 'Agent run details' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Inspect run Research assistant' }).click();
  await page
    .getByRole('dialog', { name: 'Agent run details' })
    .getByRole('link', { name: 'Open logs', exact: true })
    .click();
  await expect
    .poll(() => calls.queries.at(-1)?.query)
    .toContain('"span_trace_id" = \'00000000000000000000000000000002\'');
  expect(calls.queries.at(-1)?.query).not.toContain('00000000000000000000000000000001');
  expect(calls.queries.at(-1)?.query).toContain(' OR ');
  await page.getByRole('button', { name: 'Clear trace filter' }).click();
  await expect.poll(() => calls.queries.at(-1)?.query).not.toContain('"span_trace_id"');
  await expect(page.getByLabel('Remove filter level = error')).toBeVisible();
});

test('sidebar travel preserves trace filter edits while their list request is pending', async ({
  page,
}) => {
  await mockNavigation(page);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = false;
  await page.route('**/services/traces/list', async (route) => {
    if (route.request().postDataJSON().serviceName === 'slow-worker') {
      started = true;
      await pending;
    }
    await route.fallback().catch(() => {});
  });
  try {
    await page.goto(
      `/traces/explore/agent_telemetry?${new URLSearchParams({ start: bounds.startTime, end: bounds.endTime })}`,
    );
    await expect(page.getByTestId('trace-table')).toBeVisible();
    await page.getByLabel('Service', { exact: true }).fill('slow-worker');
    await page.getByRole('button', { name: 'Apply service' }).click();
    await expect.poll(() => started).toBe(true);
    await page.getByTestId('sidebar-agents').click();
    await expect(page.getByRole('button', { name: 'Inspect run Support assistant' })).toBeVisible();
    await page.getByTestId('sidebar-traces').click();
    await expect(page.getByLabel('Service', { exact: true })).toHaveValue('slow-worker');
  } finally {
    release();
  }
});

test('run log handoffs use trace_id aliases and report absent trace fields without invalid SQL', async ({
  page,
}) => {
  const calls = await mockNavigation(page);
  let hasTraceField = true;
  await page.route('**/schema', (route) =>
    route.fulfill({
      json: {
        fields: [
          ...agentDemoFields.filter((field) => field !== 'span_trace_id'),
          ...(hasTraceField ? ['trace_id'] : []),
          'message',
          'level',
        ].map((name) => ({ name })),
      },
    }),
  );
  await page.goto(
    `/agents/agent_telemetry?${new URLSearchParams({ start: bounds.startTime, end: bounds.endTime })}`,
  );
  await page.getByRole('button', { name: 'Inspect run Support assistant' }).click();
  await page
    .getByRole('dialog', { name: 'Agent run details' })
    .getByRole('link', { name: 'Open logs', exact: true })
    .click();
  await expect
    .poll(() => calls.queries.at(-1)?.query)
    .toContain('"trace_id" = \'00000000000000000000000000000001\'');
  await page.getByTestId('sidebar-agents').click();
  await expect(page.getByRole('dialog', { name: 'Agent run details' })).toBeVisible();
  hasTraceField = false;
  const before = calls.queries.length;
  await page
    .getByRole('dialog', { name: 'Agent run details' })
    .getByRole('link', { name: 'Open logs', exact: true })
    .click();
  await expect(
    page.getByText('This dataset has no trace ID field. Trace-focused logs are unavailable.'),
  ).toBeVisible();
  expect(calls.queries).toHaveLength(before);
});

for (const parameter of ['traceId', 'logTraceId']) {
  test(`standalone ${parameter} links apply trace focus without navigation context`, async ({
    page,
  }) => {
    const calls = await mockNavigation(page);
    await page.goto(
      `/logs/explore/agent_telemetry?${new URLSearchParams({ [parameter]: '00000000000000000000000000000001' })}`,
    );
    await expect(page.getByRole('button', { name: 'Clear trace filter' })).toBeVisible();
    await expect
      .poll(() => calls.queries.at(-1)?.query)
      .toContain('"span_trace_id" = \'00000000000000000000000000000001\'');
    await expect.poll(() => new URL(page.url()).searchParams.has(parameter)).toBe(false);
    await page.reload();
    await expect(page.getByRole('button', { name: 'Clear trace filter' })).toBeVisible();
  });

  test(`standalone ${parameter} links recover when the dataset has no trace field`, async ({
    page,
  }) => {
    const calls = await mockNavigation(page);
    await page.route('**/schema', (route) =>
      route.fulfill({ json: { fields: [{ name: 'p_timestamp' }, { name: 'message' }] } }),
    );
    await page.goto(
      `/logs/explore/agent_telemetry?${new URLSearchParams({ [parameter]: '00000000000000000000000000000001' })}`,
    );
    await expect(
      page.getByText('This dataset has no trace ID field. Trace-focused logs are unavailable.'),
    ).toBeVisible();
    expect(calls.queries).toHaveLength(0);
    await page.getByRole('button', { name: 'Clear invalid shared view' }).click();
    await expect.poll(() => calls.queries.length).toBeGreaterThan(0);
    expect(calls.queries.at(-1)?.query).not.toContain('"span_trace_id"');
    await expect(page.getByRole('button', { name: 'Clear invalid shared view' })).toHaveCount(0);
  });
}

test('malformed standalone trace links show a notice and continue loading Logs', async ({
  page,
}) => {
  const calls = await mockNavigation(page);
  await page.goto('/logs/explore/agent_telemetry?traceId=not-a-trace');
  await expect(
    page.getByText('The trace ID in this link is invalid and was not applied.'),
  ).toBeVisible();
  await expect.poll(() => calls.queries.length).toBeGreaterThan(0);
  expect(calls.queries.at(-1)?.query).not.toContain('"span_trace_id"');
  await expect.poll(() => new URL(page.url()).searchParams.has('traceId')).toBe(false);
});
