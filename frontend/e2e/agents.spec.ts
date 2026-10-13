import { expect, test, type Locator, type Page } from '@playwright/test';
import type { LogRecord } from '../src/lib/types';

// Fixtures mirror rows produced by src/otel/traces.rs: one row per span, or one
// row per span event (and link) with every span, scope and resource field
// copied onto it. Timestamps are nanosecond text with *_epoch companions; an
// OTLP end time of zero is flattened as epoch 0 with a duration of 0.
const bounds = {
  startTime: '2026-10-12T15:00:00.000Z',
  endTime: '2026-10-12T16:00:00.000Z',
};
const range = new URLSearchParams({ start: bounds.startTime, end: bounds.endTime });
const base = Date.parse(bounds.startTime);
const traceIds = {
  support: 'a1'.repeat(16),
  research: 'b2'.repeat(16),
  billing: 'c3'.repeat(16),
  triage: 'd4'.repeat(16),
};

function nanoText(ms: number) {
  return new Date(ms).toISOString().replace('Z', '000000Z');
}
function ingested(ms: number) {
  return new Date(ms).toISOString().replace('Z', '');
}

type SpanFixture = {
  trace: string;
  id: string;
  parent?: string;
  name: string;
  start: number;
  /** Omitted when the exporter sent no end time. */
  duration?: number;
  status?: 0 | 1 | 2;
  message?: string;
  attributes?: LogRecord;
  events?: LogRecord[];
};

function spanRows(span: SpanFixture): LogRecord[] {
  const end = span.duration === undefined ? undefined : span.start + span.duration;
  const status = span.status ?? 0;
  const row: LogRecord = {
    p_timestamp: ingested((end ?? span.start) + 250),
    'service.name': 'agent-gateway',
    'telemetry.sdk.language': 'python',
    resource_dropped_attributes_count: 0,
    resource_schema_url: '',
    scope_name: 'opentelemetry.instrumentation.openai_agents',
    scope_version: '0.1.0',
    scope_dropped_attributes_count: 0,
    scope_schema_url: '',
    span_trace_id: span.trace,
    span_span_id: span.id,
    span_parent_span_id: span.parent ?? '',
    span_trace_state: '',
    span_flags: 1,
    span_flags_description: '',
    span_name: span.name,
    span_kind: span.attributes?.['gen_ai.operation.name'] === 'chat' ? 3 : 1,
    span_kind_description:
      span.attributes?.['gen_ai.operation.name'] === 'chat' ? 'CLIENT' : 'INTERNAL',
    span_start_time_unix_nano: nanoText(span.start),
    span_start_time_unix_nano_epoch: span.start * 1e6,
    // The backend writes ingestion time as text when OTLP end time is zero.
    span_end_time_unix_nano: nanoText(end ?? span.start + 90_000),
    span_end_time_unix_nano_epoch: end === undefined ? 0 : end * 1e6,
    span_duration_ns: end === undefined ? 0 : (end - span.start) * 1e6,
    span_dropped_attributes_count: 0,
    span_dropped_events_count: 0,
    span_dropped_links_count: 0,
    span_status_code: status,
    span_status_description: ['UNSET', 'OK', 'ERROR'][status],
    span_status_message: span.message ?? '',
    ...span.attributes,
  };
  if (!span.events?.length) return [row];
  return span.events.map((event) => ({ ...row, event_dropped_attributes_count: 0, ...event }));
}

function event(name: string, at: number, start: number, attributes: LogRecord = {}): LogRecord {
  return {
    event_name: name,
    event_time_unix_nano: nanoText(at),
    event_time_unix_nano_epoch: at * 1e6,
    event_duration_ns: (at - start) * 1e6,
    ...Object.fromEntries(
      Object.entries(attributes).map(([key, value]) => [`event_${key}`, value]),
    ),
  };
}

const agent = (name: string) => ({
  'gen_ai.operation.name': 'invoke_agent',
  'gen_ai.agent.name': name,
  'gen_ai.agent.id': `asst_${name.split(' ')[0].toLowerCase()}`,
});

// Successful: all spans completed with OTel's default UNSET status. The first
// chat span streams two chunk events, so it arrives as two duplicated rows.
const supportStart = base + 10 * 60_000;
const support: SpanFixture[] = [
  {
    trace: traceIds.support,
    id: 'a100000000000001',
    name: 'invoke_agent Support assistant',
    start: supportStart,
    duration: 4200,
    attributes: agent('Support assistant'),
  },
  {
    trace: traceIds.support,
    id: 'a100000000000002',
    parent: 'a100000000000001',
    name: 'chat gpt-4o',
    start: supportStart + 100,
    duration: 1800,
    attributes: {
      'gen_ai.operation.name': 'chat',
      'gen_ai.system': 'openai',
      'gen_ai.request.model': 'gpt-4o',
      'gen_ai.response.model': 'gpt-4o-2024-08-06',
      'gen_ai.usage.input_tokens': 1200,
      'gen_ai.usage.output_tokens': 300,
      'gen_ai.prompt.0.role': 'user',
      'gen_ai.prompt.0.content': 'Where is order 8812?',
      'gen_ai.completion.0.role': 'assistant',
      'gen_ai.completion.0.content': 'Let me look that order up for you.',
    },
    events: [
      event('llm.content.completion.chunk', supportStart + 900, supportStart + 100),
      event('llm.content.completion.chunk', supportStart + 1700, supportStart + 100),
    ],
  },
  {
    trace: traceIds.support,
    id: 'a100000000000003',
    parent: 'a100000000000001',
    name: 'execute_tool lookup_order',
    start: supportStart + 2000,
    duration: 650,
    attributes: {
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': 'lookup_order',
      'gen_ai.tool.call.id': 'call_Q1x8',
      'gen_ai.tool.call.arguments': '{"order_id":"8812"}',
    },
  },
  {
    trace: traceIds.support,
    id: 'a100000000000004',
    parent: 'a100000000000001',
    name: 'chat gpt-4o-mini',
    start: supportStart + 2800,
    duration: 1300,
    attributes: {
      'gen_ai.operation.name': 'chat',
      'gen_ai.system': 'openai',
      'gen_ai.request.model': 'gpt-4o-mini',
      'gen_ai.response.model': 'gpt-4o-mini-2024-07-18',
      'gen_ai.usage.input_tokens': 300,
      'gen_ai.usage.output_tokens': 120,
    },
  },
];

// Failed: the root reports ERROR after a tool timeout recorded as an exception.
const researchStart = base + 20 * 60_000;
const research: SpanFixture[] = [
  {
    trace: traceIds.research,
    id: 'b200000000000001',
    name: 'invoke_agent Research assistant',
    start: researchStart,
    duration: 31_500,
    status: 2,
    message: 'Tool call failed: upstream timeout',
    attributes: agent('Research assistant'),
  },
  {
    trace: traceIds.research,
    id: 'b200000000000002',
    parent: 'b200000000000001',
    name: 'chat claude-sonnet-4-5',
    start: researchStart + 100,
    duration: 900,
    status: 1,
    attributes: {
      'gen_ai.operation.name': 'chat',
      'gen_ai.system': 'anthropic',
      'gen_ai.request.model': 'claude-sonnet-4-5',
      'gen_ai.usage.input_tokens': 800,
      'gen_ai.usage.output_tokens': 90,
    },
  },
  {
    trace: traceIds.research,
    id: 'b200000000000003',
    parent: 'b200000000000001',
    name: 'execute_tool fetch_url',
    start: researchStart + 1100,
    duration: 30_000,
    status: 2,
    message: 'TimeoutError',
    attributes: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'fetch_url' },
    events: [
      event('exception', researchStart + 31_100, researchStart + 1100, {
        'exception.type': 'TimeoutError',
        'exception.message': 'GET https://docs.example.com/guide timed out after 30s',
      }),
    ],
  },
];

// Incomplete: the root was exported without an end time, and its model call
// records neither model names nor token usage.
const billingStart = base + 30 * 60_000;
const billing: SpanFixture[] = [
  {
    trace: traceIds.billing,
    id: 'c300000000000001',
    name: 'invoke_agent Billing assistant',
    start: billingStart,
    attributes: agent('Billing assistant'),
  },
  {
    trace: traceIds.billing,
    id: 'c300000000000002',
    parent: 'c300000000000001',
    name: 'chat',
    start: billingStart + 100,
    duration: 700,
    attributes: { 'gen_ai.operation.name': 'chat' },
  },
];

// Recovered: a failed tool call is retried and the root reports explicit OK.
const triageStart = base + 40 * 60_000;
const triage: SpanFixture[] = [
  {
    trace: traceIds.triage,
    id: 'd400000000000001',
    name: 'invoke_agent Triage assistant',
    start: triageStart,
    duration: 2600,
    status: 1,
    attributes: agent('Triage assistant'),
  },
  {
    trace: traceIds.triage,
    id: 'd400000000000002',
    parent: 'd400000000000001',
    name: 'execute_tool lookup_customer',
    start: triageStart + 100,
    duration: 400,
    status: 2,
    message: 'CustomerNotFound',
    attributes: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'lookup_customer' },
    events: [
      event('exception', triageStart + 480, triageStart + 100, {
        'exception.type': 'CustomerNotFound',
        'exception.message': 'No customer with email jo@example.com',
      }),
    ],
  },
  {
    trace: traceIds.triage,
    id: 'd400000000000003',
    parent: 'd400000000000001',
    name: 'chat gpt-4o-mini',
    start: triageStart + 600,
    duration: 1900,
    status: 1,
    attributes: {
      'gen_ai.operation.name': 'chat',
      'gen_ai.system': 'openai',
      'gen_ai.request.model': 'gpt-4o-mini',
      'gen_ai.response.model': 'gpt-4o-mini-2024-07-18',
      'gen_ai.usage.input_tokens': 410,
      'gen_ai.usage.output_tokens': 60,
    },
  },
];

const allRows = (spans: SpanFixture[]) => spans.flatMap(spanRows);
// Query results are newest first, interleaving runs as the SQL endpoint would.
const agentRows = [...triage, ...billing, ...research, ...support]
  .flatMap(spanRows)
  .sort((a, b) => String(b.p_timestamp).localeCompare(String(a.p_timestamp)));
const agentFields = [...new Set(agentRows.flatMap((row) => Object.keys(row)))];

type Captured = { query: string; startTime: string; endTime: string };
async function serveAgents(
  page: Page,
  options: {
    status?: number;
    rows?: LogRecord[];
    datasets?: string[];
    fields?: string[];
    logs?: { dataset: string; fields: string[]; rows: LogRecord[] };
  } = {},
) {
  const captured: Captured[] = [];
  const state = { status: options.status ?? 200, rows: options.rows ?? agentRows };
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/v1/logstream')
      return route.fulfill({
        json: (options.datasets ?? ['agent_telemetry']).map((name) => ({ name })),
      });
    if (path.endsWith('/schema'))
      return route.fulfill({
        json: {
          fields: (path.includes(`/${options.logs?.dataset}/`)
            ? options.logs!.fields
            : (options.fields ?? agentFields)
          ).map((name) => ({ name })),
        },
      });
    if (path.endsWith('/info'))
      return route.fulfill({
        json: { telemetryType: 'traces', logSource: [{ log_source_format: 'otel-traces' }] },
      });
    if (path === '/api/v1/about') return route.fulfill({ json: { capabilities: {} } });
    if (path === '/api/v1/query') {
      const request: Captured = route.request().postDataJSON();
      captured.push(request);
      if (options.logs && request.query.includes(`FROM "${options.logs.dataset}"`))
        return route.fulfill({ json: options.logs.rows });
      return state.status === 200
        ? route.fulfill({ json: state.rows })
        : route.fulfill({ status: state.status, body: 'Access denied' });
    }
    return route.fulfill({ status: 404, body: 'No fixture' });
  });
  return { captured, state };
}

const columns = ['Run', 'Status', 'Started (UTC)', 'Duration', 'Model', 'Tokens', 'Spans'];
function runRow(page: Page, name: string) {
  return page
    .getByRole('region', { name: 'Agent runs' })
    .getByRole('row')
    .filter({ has: page.getByText(name, { exact: true }) });
}
function cell(row: Locator, column: string) {
  return row.getByRole('cell').nth(columns.indexOf(column));
}
function summaryCount(page: Page, label: string) {
  return page
    .getByLabel('Loaded run summary')
    .locator('div')
    .filter({ has: page.getByText(label, { exact: true }) });
}
function sqlBounds(query: string) {
  // The run query repeats its bounds in the trace-seeding subquery.
  return [...new Set([...query.matchAll(/TIMESTAMP '([^']+)'/g)].map((match) => match[1]))];
}
function fact(scope: Locator, label: string) {
  return scope
    .locator('dt', { hasText: new RegExp(`^${label}$`) })
    .first()
    .locator('xpath=following-sibling::dd[1]');
}
async function openRun(page: Page, name: string) {
  await page.getByRole('button', { name: `Inspect run ${name}`, exact: true }).click();
  const details = page.getByRole('dialog', { name: 'Agent run details' });
  await expect(details.getByRole('heading', { name, level: 2 })).toBeVisible();
  return details;
}

test('discovers agent datasets and queries the exact selected bounds', async ({ page }) => {
  const { captured } = await serveAgents(page);
  await page.goto(`/agents?${range}`);
  await expect(page.getByRole('heading', { name: 'Choose an agent dataset' })).toBeVisible();
  await page.getByLabel('Agents dataset').selectOption('agent_telemetry');
  await expect(page).toHaveURL(/\/agents\/agent_telemetry\?/);
  await expect(runRow(page, 'Support assistant')).toBeVisible();
  expect(captured).toHaveLength(1);
  expect(captured[0].query).toContain('agent_telemetry');
  expect(sqlBounds(captured[0].query)).toEqual([bounds.startTime, bounds.endTime]);
});

test('groups event-expanded spans into runs with honest status, duration, model and tokens', async ({
  page,
}) => {
  await serveAgents(page);
  await page.goto(`/agents/agent_telemetry?${range}`);
  await expect(page.getByRole('region', { name: 'Agent runs' }).getByRole('row')).toHaveCount(5);
  await expect(summaryCount(page, 'Runs')).toContainText('4');
  await expect(summaryCount(page, 'Successful')).toContainText('2');
  await expect(summaryCount(page, 'Failed')).toContainText('1');
  await expect(summaryCount(page, 'Incomplete')).toContainText('1');
  await expect(page.getByText('4 of 4 runs')).toBeVisible();

  // Completed UNSET spans are successful. Streamed chunk events duplicate the
  // first model span's row, but it is one span and its usage is counted once.
  const supportRow = runRow(page, 'Support assistant');
  await expect(cell(supportRow, 'Status')).toHaveText('Successful');
  await expect(cell(supportRow, 'Duration')).toHaveText('4.20 s');
  await expect(cell(supportRow, 'Model')).toContainText('gpt-4o-2024-08-06');
  await expect(cell(supportRow, 'Model')).toContainText('gpt-4o-mini-2024-07-18');
  await expect(cell(supportRow, 'Tokens')).toContainText('1,500 in');
  await expect(cell(supportRow, 'Tokens')).toContainText('420 out');
  await expect(cell(supportRow, 'Spans')).toHaveText('4');

  const researchRow = runRow(page, 'Research assistant');
  await expect(cell(researchRow, 'Status')).toHaveText('Failed');
  await expect(cell(researchRow, 'Spans')).toHaveText('3');

  // Missing completion, model and usage are reported, never shown as zero.
  const billingRow = runRow(page, 'Billing assistant');
  await expect(cell(billingRow, 'Status')).toHaveText('Incomplete');
  await expect(cell(billingRow, 'Duration')).toHaveText('Not recorded');
  await expect(cell(billingRow, 'Model')).toHaveText('Not recorded');
  await expect(cell(billingRow, 'Tokens')).toHaveText('Not recorded');
  await expect(billingRow).not.toContainText(/\b0 (in|out)\b|0 ms/);

  // An explicit OK root is authoritative after a recovered tool failure.
  await expect(cell(runRow(page, 'Triage assistant'), 'Status')).toHaveText('Successful');
});

test('filters loaded runs by status, model and span content', async ({ page }) => {
  const { captured } = await serveAgents(page);
  await page.goto(`/agents/agent_telemetry?${range}`);
  const table = page.getByRole('region', { name: 'Agent runs' });
  await expect(runRow(page, 'Support assistant')).toBeVisible();

  await page.getByLabel('Run status').selectOption({ label: 'Failed' });
  await expect(table.getByRole('row')).toHaveCount(2);
  await expect(runRow(page, 'Research assistant')).toBeVisible();
  await expect(page).toHaveURL(/status=failed/);
  await page.getByLabel('Run status').selectOption({ label: 'All statuses' });

  await page.getByLabel('Run model').selectOption('gpt-4o-mini-2024-07-18');
  await expect(page.getByText('2 of 4 runs')).toBeVisible();
  await expect(runRow(page, 'Support assistant')).toBeVisible();
  await expect(runRow(page, 'Triage assistant')).toBeVisible();
  await page.getByLabel('Run model').selectOption({ label: 'All models' });

  // Search reaches child span and event fields, not just run names.
  await page.getByLabel('Search agent runs').fill('docs.example.com');
  await expect(table.getByRole('row')).toHaveCount(2);
  await expect(runRow(page, 'Research assistant')).toBeVisible();
  await page.getByLabel('Search agent runs').fill('no-such-agent');
  await expect(page.getByRole('heading', { name: 'No matching runs' })).toBeVisible();
  // Filters work on loaded runs and never resubmit the query.
  expect(captured).toHaveLength(1);
});

test('run details show the span tree, selected span facts and deduplicated raw records', async ({
  page,
}) => {
  await serveAgents(page);
  await page.goto(`/agents/agent_telemetry?${range}`);
  const details = await openRun(page, 'Support assistant');
  await expect(page).toHaveURL(new RegExp(`run=[^&]*${traceIds.support}`));
  await expect(details).toContainText(traceIds.support);
  await expect(details.getByRole('link', { name: 'Open trace' })).toHaveAttribute(
    'href',
    new RegExp(traceIds.support),
  );

  await expect(details.getByRole('tab', { name: 'Span tree (4)' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const tree = details.getByRole('list', { name: 'Run span tree' });
  const root = tree.getByRole('listitem').filter({
    has: page.getByRole('button', { name: /invoke_agent Support assistant/ }),
  });
  const children = root.getByRole('list', { name: 'Child spans' });
  await expect(children.getByRole('button')).toHaveCount(3);
  await expect(children.getByRole('button', { name: /^chat gpt-4o(?!-)/ })).toBeVisible();
  await expect(children.getByRole('button', { name: /execute_tool lookup_order/ })).toBeVisible();
  await expect(children.getByRole('button', { name: /chat gpt-4o-mini/ })).toBeVisible();

  await children.getByRole('button', { name: /^chat gpt-4o(?!-)/ }).click();
  const span = details.getByRole('region', { name: 'Selected span' });
  await expect(span.getByRole('heading', { name: 'chat gpt-4o', exact: true })).toBeVisible();
  await expect(span).toContainText('a100000000000002');
  await expect(span).toContainText('a100000000000001');
  await expect(span).toContainText('gpt-4o-2024-08-06');
  await expect(span).toContainText('1,200 in');
  await expect(span).toContainText('1.80 s');
  // Both event rows are retained as raw records for the one span.
  await span.getByText('Recorded fields (2 records)').click();
  await expect(span.getByText(/llm\.content\.completion\.chunk/)).toHaveCount(2);
  await expect(span).toContainText('"span_kind_description": "CLIENT"');
});

test('run details list model calls, tool calls and captured conversation once', async ({
  page,
}) => {
  await serveAgents(page);
  await page.goto(`/agents/agent_telemetry?${range}`);
  const details = await openRun(page, 'Support assistant');

  await details.getByRole('tab', { name: 'Model calls (2)' }).click();
  const models = details.getByRole('list', { name: 'Model calls' });
  await expect(models.getByRole('listitem')).toHaveCount(2);
  await expect(models).toContainText('gpt-4o-2024-08-06');
  await expect(models).toContainText('300 in');
  await expect(models).toContainText('120 out');

  await details.getByRole('tab', { name: 'Tool calls (1)' }).click();
  const tools = details.getByRole('list', { name: 'Tool calls' });
  await expect(tools.getByRole('listitem')).toHaveCount(1);
  await expect(tools).toContainText('lookup_order');

  await details.getByRole('tab', { name: 'Errors (0)' }).click();
  await expect(details.getByText('No errors reported in the loaded spans.')).toBeVisible();

  // Span attributes are copied onto each streamed event row; content must not repeat.
  await details.getByRole('tab', { name: 'Conversation' }).click();
  const conversation = details.getByRole('region', {
    name: 'Conversation from chat gpt-4o',
    exact: true,
  });
  await expect(conversation.getByText('Where is order 8812?', { exact: true })).toHaveCount(1);
  await expect(
    conversation.getByText('Let me look that order up for you.', { exact: true }),
  ).toHaveCount(1);
  await expect(
    details.getByRole('region', { name: 'Conversation from execute_tool lookup_order' }),
  ).toContainText(/"order_id"\s*:\s*"8812"/);
});

test('failed run details expose span errors and exception events', async ({ page }) => {
  await serveAgents(page);
  await page.goto(`/agents/agent_telemetry?${range}`);
  const details = await openRun(page, 'Research assistant');
  await expect(details.getByText('Failed', { exact: true }).first()).toBeVisible();
  await details.getByRole('tab', { name: 'Errors (2)' }).click();
  const errors = details.getByRole('tabpanel');
  await expect(errors).toContainText('Tool call failed: upstream timeout');
  await expect(errors).toContainText('GET https://docs.example.com/guide timed out after 30s');
  await expect(errors).toContainText('TimeoutError');

  await errors.getByRole('button', { name: 'execute_tool fetch_url' }).click();
  const span = details.getByRole('region', { name: 'Selected span' });
  await expect(span.getByRole('heading', { name: 'execute_tool fetch_url' })).toBeVisible();
  await expect(span).toContainText('fetch_url');
  await expect(span).toContainText('Not recorded'); // tools report no token usage
  await details.getByRole('tab', { name: 'Conversation' }).click();
  await expect(details.getByText(/No conversation content captured/)).toBeVisible();
});

test('recovered and incomplete runs keep their gaps visible in details', async ({ page }) => {
  await serveAgents(page);
  await page.goto(`/agents/agent_telemetry?${range}`);

  let details = await openRun(page, 'Triage assistant');
  await expect(details.getByText('Successful', { exact: true }).first()).toBeVisible();
  await expect(details.getByRole('tab', { name: 'Errors (1)' })).toBeVisible();
  await expect(details.getByRole('status').first()).toContainText(/error|fail/i);
  await details.getByRole('tab', { name: 'Errors (1)' }).click();
  await expect(details.getByRole('tabpanel')).toContainText(
    'No customer with email jo@example.com',
  );
  await page.keyboard.press('Escape');
  await expect(details).toBeHidden();
  await expect(page).not.toHaveURL(/run=/);

  details = await openRun(page, 'Billing assistant');
  await expect(details.getByText('Incomplete', { exact: true }).first()).toBeVisible();
  for (const label of ['Duration', 'Models', 'Token usage'])
    await expect(fact(details, label)).toHaveText('Not recorded');
  await expect(details.getByRole('status').first()).toContainText(/duration/i);
  await details.getByRole('tab', { name: 'Model calls (1)' }).click();
  await expect(details.getByRole('list', { name: 'Model calls' })).toContainText(
    'Name not recorded',
  );
});

test('selection is cleared when reloaded data no longer contains the run', async ({ page }) => {
  const { captured, state } = await serveAgents(page);
  await page.goto(`/agents/agent_telemetry?${range}`);
  const details = await openRun(page, 'Support assistant');

  state.rows = [...allRows(research), ...allRows(triage)];
  await page.goBack();
  await expect(details).toBeHidden();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect.poll(() => captured.length).toBe(2);
  await expect(runRow(page, 'Support assistant')).toHaveCount(0);
  await expect(runRow(page, 'Research assistant')).toBeVisible();

  // Returning to the old run link must not resurrect details from earlier data.
  await page.goForward();
  await expect(page).toHaveURL(/run=/);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('invoke_agent Support assistant')).toHaveCount(0);
});

test('a run link outside the loaded data opens no stale details', async ({ page }) => {
  await serveAgents(page, { rows: allRows(research) });
  await page.goto(`/agents/agent_telemetry?${range}&run=trace:${traceIds.support}`);
  await expect(runRow(page, 'Research assistant')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('permission failure renders recovery without stale runs or details', async ({ page }) => {
  await serveAgents(page, { status: 403 });
  await page.goto(`/agents/agent_telemetry?${range}&run=trace:${traceIds.support}`);
  await expect(page.getByRole('heading', { name: 'Permission denied' })).toBeVisible();
  await expect(page.getByRole('table')).toHaveCount(0);
  await expect(page.getByLabel('Loaded run summary')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('run table and details stay within a mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await serveAgents(page);
  await page.goto(`/agents/agent_telemetry?${range}`);
  await expect(runRow(page, 'Support assistant')).toBeVisible();
  const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(await fits()).toBe(true);

  const details = await openRun(page, 'Support assistant');
  await expect
    .poll(async () => {
      const box = await details.boundingBox();
      return !!box && box.x >= 0 && box.x + box.width <= 390;
    })
    .toBe(true);
  await details.getByRole('tab', { name: 'Conversation' }).click();
  const message = details.getByText('Where is order 8812?', { exact: true }).first();
  await message.scrollIntoViewIfNeeded();
  const messageBox = await message.boundingBox();
  expect(messageBox && messageBox.x >= 0 && messageBox.x + messageBox.width <= 390).toBe(true);
  expect(await fits()).toBe(true);
});

test('empty telemetry on mobile stays within viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await serveAgents(page, { rows: [] });
  await page.goto(`/agents/agent_telemetry?${range}`);
  await expect(
    page.getByRole('heading', { name: 'No agent telemetry in this range' }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('direct agent links defer schema discovery until the dataset selector is focused', async ({
  page,
}) => {
  const schemaRequests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.endsWith('/schema')) schemaRequests.push(request.url());
  });
  await serveAgents(page, { datasets: ['agent_telemetry', 'another_dataset'] });
  await page.goto(`/agents/agent_telemetry?${range}`);
  await expect(page.getByRole('table')).toBeVisible();
  expect(schemaRequests.filter((url) => url.includes('another_dataset'))).toHaveLength(0);
  await page.getByLabel('Agents dataset').focus();
  await expect
    .poll(() => schemaRequests.filter((url) => url.includes('another_dataset')).length)
    .toBe(1);
});

test('direct nonagent dataset link rejects its schema before submitting a query', async ({
  page,
}) => {
  const { captured } = await serveAgents(page);
  await page.route('**/api/v1/logstream/*/schema', (route) =>
    route.fulfill({ json: { fields: [{ name: 'p_timestamp' }, { name: 'message' }] } }),
  );
  await page.goto('/agents/application_logs');
  await expect(page.getByRole('alert')).toContainText('no recognized GenAI agent');
  expect(captured).toHaveLength(0);
  await expect(page.getByRole('table')).toHaveCount(0);
});

test('refreshing a preset submits one query with newly captured bounds', async ({ page }) => {
  const { captured } = await serveAgents(page);
  await page.goto('/agents/agent_telemetry?range=24h');
  await expect(page.getByRole('table')).toBeVisible();
  expect(captured).toHaveLength(1);
  const [firstStart, firstEnd] = sqlBounds(captured[0].query);
  expect(Date.parse(firstEnd) - Date.parse(firstStart)).toBe(86_400_000);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect.poll(() => captured.length).toBe(2);
  await expect(page.getByRole('table')).toBeVisible();
  const [start, end] = sqlBounds(captured[1].query);
  expect(end).not.toBe(firstEnd);
  expect(Date.parse(end) - Date.parse(start)).toBe(86_400_000);
  expect(new URL(page.url()).searchParams.get('end')).toBe(end);
});

test('discloses the trace limit even when fewer than 1000 records are loaded', async ({ page }) => {
  const rows = Array.from({ length: 100 }, (_, index) =>
    spanRows({
      trace: (index + 1).toString(16).padStart(32, '0'),
      id: '0101010101010101',
      name: `Agent ${index}`,
      start: base + 1000,
      duration: 100,
      status: 1,
      attributes: {
        'gen_ai.agent.name': `Agent ${index}`,
        'gen_ai.operation.name': 'invoke_agent',
      },
    }),
  ).flat();
  await serveAgents(page, { rows });
  await page.goto(`/agents/agent_telemetry?${range}`);
  await expect(page.getByRole('status').filter({ hasText: '100-trace limit' })).toContainText(
    'Older runs may be omitted',
  );
  await expect(page.getByRole('table').getByRole('row')).toHaveCount(101);
});

for (const trace of ['trace-with-dashes', '']) {
  test(`run details do not silently open unfiltered logs for unsupported identity: ${trace || 'missing'}`, async ({
    page,
  }) => {
    const rows = spanRows({
      trace,
      id: '0101010101010101',
      name: 'Unlinked agent',
      start: base + 1000,
      duration: 100,
      status: 1,
      attributes: {
        'gen_ai.agent.name': 'Unlinked agent',
        'gen_ai.operation.name': 'invoke_agent',
      },
    });
    await serveAgents(page, { rows });
    await page.goto(`/agents/agent_telemetry?${range}`);
    const details = await openRun(page, 'Unlinked agent');
    await expect(details.getByRole('link', { name: 'Open logs', exact: true })).toHaveCount(0);
    await expect(details.getByRole('link', { name: 'Open trace', exact: true })).toHaveCount(0);
    await expect(details.getByRole('tab', { name: 'Span tree (1)' })).toBeVisible();
  });
}

// Spans as Codex CLI 0.162.1 exports them: no GenAI agent fields, usage on the
// response handler below each model call, and intermediate spans filtered out.
const codexTrace = 'e5'.repeat(16);
const codex = (span: Omit<SpanFixture, 'trace' | 'status'>) =>
  spanRows({
    ...span,
    trace: codexTrace,
    attributes: { 'service.name': 'codex-app-server', ...span.attributes },
  });
const codexRows = [
  codex({
    id: 'e500000000000001',
    parent: 'e5000000000000aa',
    name: 'session_task.turn',
    start: base + 1000,
    duration: 4000,
    attributes: {
      model: 'gpt-6-luna',
      'codex.turn.token_usage.input_tokens': '32558',
      'codex.turn.token_usage.output_tokens': '38',
    },
  }),
  codex({
    id: 'e500000000000002',
    parent: 'e5000000000000bb',
    name: 'try_run_sampling_request',
    start: base + 1100,
    duration: 1600,
    attributes: { model: 'gpt-6-luna' },
  }),
  codex({
    id: 'e500000000000003',
    parent: 'e500000000000002',
    name: 'receiving_stream',
    start: base + 1110,
    duration: 1580,
  }),
  codex({
    id: 'e500000000000004',
    parent: 'e500000000000003',
    name: 'handle_responses',
    start: base + 2600,
    duration: 40,
    attributes: { 'gen_ai.usage.input_tokens': '32558', 'gen_ai.usage.output_tokens': '38' },
  }),
  codex({
    id: 'e500000000000005',
    parent: 'e5000000000000cc',
    name: 'exec',
    start: base + 2700,
    duration: 137,
    attributes: { tool_name: 'exec', call_id: 'call_codex' },
  }),
].flat();
const codexFields = [
  ...new Set([...codexRows.flatMap((row) => Object.keys(row)), 'gen_ai.usage.input_tokens']),
];

test('native Codex traces become runs with mapped model calls, tools and usage', async ({
  page,
}) => {
  const { captured } = await serveAgents(page, {
    rows: codexRows,
    datasets: ['codex-traces'],
    fields: codexFields,
  });
  await page.goto(`/agents?${range}`);
  await page.getByLabel('Agents dataset').selectOption('codex-traces');
  const row = runRow(page, 'Codex');
  await expect(cell(row, 'Status')).toHaveText('Successful');
  await expect(cell(row, 'Model')).toHaveText('gpt-6-luna');
  await expect(cell(row, 'Tokens')).toContainText('32,558 in');
  await expect(cell(row, 'Tokens')).toContainText('38 out');
  await expect(cell(row, 'Spans')).toHaveText('3');
  expect(captured[0].query).toContain(`"span_name" = 'session_task.turn'`);
  expect(captured[0].query).toContain(`LIKE 'codex%'`);

  const details = await openRun(page, 'Codex');
  const children = details
    .getByRole('list', { name: 'Run span tree' })
    .getByRole('list', { name: 'Child spans' });
  await expect(children.getByRole('button')).toHaveCount(2);
  await children.getByRole('button', { name: /exec/ }).click();
  const span = details.getByRole('region', { name: 'Selected span' });
  await expect(span).toContainText('Mapped from native Codex telemetry');
  // Facts and raw records show what Codex recorded, not the attached tree position.
  await expect(fact(span, 'Parent span ID')).toHaveText('e5000000000000cc');
  await span.getByText('Recorded fields (1 record)').click();
  await expect(span).toContainText('"tool_name": "exec"');
  await expect(span).not.toContainText('gen_ai.tool.name');
});

test('Codex conversation logs fill run details from the paired logs dataset', async ({ page }) => {
  // Log records as Codex exports them with log_user_prompt on, stamped with the
  // trace and span they happened in. The tool result names the call it answers.
  const logs = [
    {
      'event.name': 'codex.user_prompt',
      'event.timestamp': ingested(base + 1000),
      trace_id: codexTrace,
      span_id: 'e5000000000000aa',
      'conversation.id': 'conversation',
      prompt: 'List the files here',
    },
    {
      'event.name': 'codex.tool_result',
      'event.timestamp': ingested(base + 2840),
      trace_id: codexTrace,
      span_id: 'e5000000000000dd',
      call_id: 'call_codex',
      tool_name: 'exec',
      arguments: 'ls',
      output: 'README.md',
    },
  ];
  const { captured } = await serveAgents(page, {
    rows: codexRows,
    datasets: ['codex-traces', 'codex-logs', 'archive-logs'],
    fields: codexFields,
    logs: {
      dataset: 'codex-logs',
      fields: [
        ...new Set([...logs.flatMap((row) => Object.keys(row)), 'originator', 'p_timestamp']),
      ],
      rows: logs,
    },
  });
  await page.goto(`/agents/codex-traces?${range}`);
  await expect(page.getByLabel('Conversation logs')).toHaveValue('codex-logs');
  const details = await openRun(page, 'Codex');
  await details.getByRole('tab', { name: 'Conversation' }).click();
  const turn = details.getByRole('region', { name: 'Conversation from session_task.turn' });
  await expect(turn).toContainText('User prompt');
  await expect(turn).toContainText('List the files here');
  const tool = details.getByRole('region', { name: 'Conversation from exec' });
  await expect(tool).toContainText('Tool arguments · exec');
  await expect(tool).toContainText('README.md');
  const logQuery = captured.find((request) => request.query.includes('FROM "codex-logs"'));
  expect(logQuery?.query).toContain(`"trace_id" IN ('${codexTrace}')`);
  expect(sqlBounds(logQuery!.query)).toEqual([bounds.startTime, bounds.endTime]);

  // Conversation text is searchable, and logs can be turned off.
  await page.keyboard.press('Escape');
  await expect(details).toBeHidden();
  await page.getByLabel('Search agent runs').fill('README.md');
  await expect(page).toHaveURL(/search=README\.md/);
  await expect(runRow(page, 'Codex')).toBeVisible();
  await page.getByLabel('Conversation logs').selectOption('none');
  await expect(page).toHaveURL(/logs=none/);
  await expect(page.getByRole('heading', { name: 'No matching runs' })).toBeVisible();
});

test('discloses the record limit from the queried rows when Codex mapping drops some', async ({
  page,
}) => {
  const trace = 'f6'.repeat(16);
  const codex = (span: Omit<SpanFixture, 'trace' | 'status'>) =>
    spanRows({
      ...span,
      trace,
      attributes: { 'service.name': 'codex-app-server', ...span.attributes },
    });
  const rows = [
    codex({
      id: 'f600000000000001',
      name: 'session_task.turn',
      start: base + 1000,
      duration: 4000,
      attributes: { model: 'gpt-6-luna', 'codex.turn.token_usage.input_tokens': '10' },
    }),
    codex({
      id: 'f600000000000002',
      parent: 'f600000000000001',
      name: 'try_run_sampling_request',
      start: base + 1100,
      duration: 3000,
      attributes: { model: 'gpt-6-luna' },
    }),
    // Stream spans count toward the record limit but are not shown as run spans.
    ...Array.from({ length: 998 }, (_, index) =>
      codex({
        id: (index + 1).toString(16).padStart(16, '0'),
        parent: 'f600000000000002',
        name: 'receiving_stream',
        start: base + 1200,
        duration: 10,
      }),
    ),
  ].flat();
  await serveAgents(page, {
    rows,
    datasets: ['codex-traces'],
    fields: [...new Set(rows.flatMap((row) => Object.keys(row)))],
  });
  await page.goto(`/agents/codex-traces?${range}`);
  await expect(cell(runRow(page, 'Codex'), 'Spans')).toHaveText('2');
  await expect(page.getByRole('status').filter({ hasText: 'record limit' })).toContainText(
    'narrow the time range',
  );
});
