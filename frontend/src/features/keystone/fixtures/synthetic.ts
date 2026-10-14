// SYNTHETIC STORY FIXTURES. Invented investigations for Storybook and Playwright only.
// They are not telemetry, not a provider and not a production code path: nothing here
// calls a model, runs a query or produces an answer at runtime.

import type {
  CanvasLayout,
  Evidence,
  GraphNode,
  InvestigationGraph,
  ScopeVersion,
} from '../../../lib/keystone/types';

export const SYNTHETIC_LABEL = 'Synthetic fixture: no provider, telemetry or model calls.';

export const SCOPE_30D: ScopeVersion = {
  id: 'scope-30d',
  datasets: ['checkout_logs', 'checkout_traces'],
  start: '2026-09-13T00:00:00Z',
  end: '2026-10-13T00:00:00Z',
  timezone: 'UTC',
  filters: [],
};

export const SCOPE_24H: ScopeVersion = {
  ...SCOPE_30D,
  id: 'scope-24h',
  start: '2026-10-12T00:00:00Z',
};

export const AVAILABLE_DATASETS = ['checkout_logs', 'checkout_traces', 'payments_logs'];

export interface InvestigationFixture {
  name: string;
  graph: InvestigationGraph;
  layout: CanvasLayout | null;
  evidence: Record<string, Evidence[]>;
  /** Server-side working history. It must never appear in any export or request. */
  hidden: Record<string, string>;
  /** Data belonging to another tenant. It must never appear anywhere. */
  otherTenant: string;
}

const T0 = Date.parse('2026-10-13T00:10:00Z');
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString().replace('.000Z', 'Z');

type Spec = [
  id: string,
  parentId: string | null,
  intent: GraphNode['intent'],
  title: string,
  prompt: string,
  answer: string | null,
  status: GraphNode['status'],
  extra?: Partial<GraphNode>,
];

function build(specs: Spec[]): GraphNode[] {
  return specs.map(([id, parentId, intent, title, prompt, answer, status, extra], index) => ({
    id,
    kind: 'question',
    intent,
    parentId,
    parentVersion: parentId === null ? null : 1,
    version: 1,
    title,
    prompt,
    answer,
    status,
    scope: SCOPE_30D,
    scopeChanged: false,
    evidenceCount: 0,
    contextHash: status === 'queued' ? null : `ctx-${id}-${String(index).padStart(4, '0')}`,
    createdAt: at(index),
    ...extra,
  }));
}

function sqlEvidence(nodeId: string, index: number, title: string, scope: ScopeVersion): Evidence {
  const rows = Array.from({ length: 12 }, (_, row) => [
    `2026-10-${String(1 + row).padStart(2, '0')}`,
    120 + ((row * 37 + index * 11) % 90),
    4100 + ((row * 53 + index * 7) % 400),
  ]);
  return {
    id: `ev-${nodeId}-${index}`,
    nodeId,
    title,
    sql: `SELECT date_trunc('day', p_timestamp) AS day,\n       count(*) FILTER (WHERE level = 'error') AS errors,\n       count(*) AS requests\nFROM ${scope.datasets[0]}\nWHERE p_timestamp >= '${scope.start}' AND p_timestamp < '${scope.end}'\nGROUP BY 1\nORDER BY 1`,
    datasets: [scope.datasets[0]],
    start: scope.start,
    end: scope.end,
    executedAt: at(index + 1),
    status: 'ok',
    rowCount: 30,
    truncated: true,
    columns: ['day', 'errors', 'requests'],
    rows,
  };
}

function emptyEvidence(nodeId: string, scope: ScopeVersion): Evidence {
  return {
    id: `ev-${nodeId}-empty`,
    nodeId,
    title: 'Deploy events in window',
    sql: `SELECT p_timestamp, service, version\nFROM ${scope.datasets[0]}\nWHERE event = 'deploy'\n  AND p_timestamp >= '${scope.start}' AND p_timestamp < '${scope.end}'`,
    datasets: [scope.datasets[0]],
    start: scope.start,
    end: scope.end,
    executedAt: at(3),
    status: 'empty',
    rowCount: 0,
    truncated: false,
    columns: ['p_timestamp', 'service', 'version'],
    rows: [],
  };
}

function finish(
  name: string,
  nodes: GraphNode[],
  options: { sentinels?: boolean; layout?: CanvasLayout | null } = {},
): InvestigationFixture {
  const evidence: Record<string, Evidence[]> = {};
  const hidden: Record<string, string> = {};
  const withEvidence = nodes.map((node, index) => {
    hidden[node.id] = `Working history for ${node.id}: KS-HIDDEN-${node.id}`;
    if (node.status !== 'completed' && node.status !== 'partial') return node;
    const items = [sqlEvidence(node.id, index, 'Errors and requests by day', node.scope)];
    if (index === 0) items.push(emptyEvidence(node.id, node.scope));
    evidence[node.id] = items;
    return { ...node, evidenceCount: items.length };
  });
  const sentinelNodes = options.sentinels
    ? withEvidence.map((node) => ({
        ...node,
        prompt: `${node.prompt} (KS-PROMPT-${node.id})`,
        answer: node.answer === null ? null : `${node.answer} (KS-ANSWER-${node.id})`,
      }))
    : withEvidence;
  return {
    name,
    graph: {
      schemaVersion: 1,
      investigationId: `inv-${name}`,
      title: 'Checkout error spike',
      semanticRevision: nodes.length,
      rootNodeId: nodes[0].id,
      nodes: sentinelNodes,
    },
    layout: options.layout ?? null,
    evidence,
    hidden,
    otherTenant: 'KS-TENANT-B-checkout_payroll',
  };
}

const TEN: Spec[] = [
  [
    'n-root',
    null,
    'root',
    'Checkout error spike',
    'Why did checkout errors rise over the last 30 days?',
    'Timeout errors from the payment dependency rose from 0.4% to 3.1% of checkout requests. This is a hypothesis; deploy history has not been checked.',
    'completed',
  ],
  [
    'n-pay',
    'n-root',
    'follow_up',
    'Payment latency',
    'How did payment call latency change in the same window?',
    'p95 payment latency rose from 380 ms to 2.4 s, starting 4 October.',
    'completed',
  ],
  [
    'n-deploy',
    'n-root',
    'explore',
    'Deploy timing',
    'Were there deploys to checkout or payments in this window?',
    'No deploy events were recorded for either service in this window.',
    'completed',
  ],
  [
    'n-region',
    'n-pay',
    'follow_up',
    'Regional split',
    'Is the latency increase limited to a region?',
    'The increase is concentrated in eu-west; us-east is unchanged.',
    'completed',
  ],
  [
    'n-retry',
    'n-pay',
    'explore',
    'Retry volume',
    'Did client retries increase alongside latency?',
    'Retries doubled in eu-west. One of three sources failed, so coverage is incomplete.',
    'partial',
  ],
  [
    'n-viz',
    'n-pay',
    'follow_up',
    'Latency by day',
    'Chart p95 payment latency by day.',
    'Daily p95 latency is charted from the stored result.',
    'completed',
    { kind: 'visualization' },
  ],
  [
    'n-day',
    'n-region',
    'follow_up',
    'Last 24 hours',
    'Is eu-west still slow in the most recent day?',
    'In the last 24 hours eu-west p95 is 2.1 s, so the problem persists.',
    'completed',
    { scope: SCOPE_24H, scopeChanged: true },
  ],
  [
    'n-users',
    'n-deploy',
    'follow_up',
    'Affected merchants',
    'Which merchants saw the most timeouts?',
    'Three merchants account for 61% of timeouts.',
    'completed',
  ],
  [
    'n-config',
    'n-deploy',
    'explore',
    'Config changes',
    'Did configuration change for the payment client?',
    null,
    'failed',
  ],
  [
    'n-cancel',
    'n-users',
    'follow_up',
    'Merchant breakdown',
    'Break timeouts down by merchant and hour.',
    'Partial hourly counts for the first merchant.',
    'cancelled',
  ],
];

export function tenNodeFixture(options: { sentinels?: boolean } = {}) {
  return finish(options.sentinels ? 'context-isolation' : 'ten-nodes', build(TEN), options);
}

/** Ten nodes plus one queued node whose run is fed by the streaming script. */
export function streamingFixture() {
  return finish(
    'streaming',
    build([
      ...TEN,
      [
        'n-stream',
        'n-root',
        'explore',
        'Error codes',
        'Which error codes make up the timeouts?',
        null,
        'queued',
      ],
    ]),
  );
}

const TOPICS = [
  'Payment latency',
  'Retry volume',
  'Deploy timing',
  'Regional split',
  'Error codes',
  'Cache misses',
  'Queue depth',
  'DNS lookups',
  'TLS handshakes',
  'Merchant mix',
];

/** 100 nodes, 99 edges: a deterministic three-way tree. */
export function hundredNodeFixture() {
  const specs: Spec[] = Array.from({ length: 100 }, (_, index) => {
    const topic = TOPICS[index % TOPICS.length];
    const status: GraphNode['status'] =
      index > 0 && index % 17 === 0
        ? 'failed'
        : index > 0 && index % 13 === 0
          ? 'partial'
          : 'completed';
    return [
      `n${index}`,
      index === 0 ? null : `n${Math.floor((index - 1) / 3)}`,
      index === 0 ? 'root' : index % 3 === 1 ? 'follow_up' : 'explore',
      `${topic} ${index}`,
      `What does ${topic.toLowerCase()} show for branch ${index}?`,
      status === 'failed' ? null : `${topic} for branch ${index} is within its 30-day baseline.`,
      status,
    ];
  });
  return finish('hundred-nodes', build(specs));
}

/** A run script for `n-stream`, including one duplicate and one gap. */
export function streamingScript() {
  const base = { schemaVersion: 1, runId: 'run-stream', nodeId: 'n-stream' };
  const evidence: Evidence = {
    ...sqlEvidence('n-stream', 10, 'Timeouts by error code', SCOPE_30D),
    columns: ['code', 'count', 'share'],
    rows: [
      ['UPSTREAM_TIMEOUT', 18240, 0.71],
      ['CONNECT_TIMEOUT', 5120, 0.2],
      ['READ_TIMEOUT', 2310, 0.09],
    ],
    rowCount: 3,
    truncated: false,
  };
  const words = [
    'Upstream ',
    'timeouts ',
    'are 71% ',
    'of errors; ',
    'connect ',
    'timeouts ',
    'are 20%.',
  ];
  const events: Record<string, unknown>[] = [
    { ...base, seq: 1, kind: 'status', status: 'querying' },
    { ...base, seq: 2, kind: 'evidence', evidence },
    { ...base, seq: 3, kind: 'status', status: 'composing' },
    ...words.map((text, index) => ({ ...base, seq: 4 + index, kind: 'answer_delta', text })),
    {
      ...base,
      seq: 11,
      kind: 'answer_checkpoint',
      text: 'Upstream timeouts are 71% of errors; connect timeouts are 20%.',
    },
    { ...base, seq: 12, kind: 'terminal', status: 'completed', reason: null },
  ];
  // Delivery order: a replayed duplicate after 6, and 10 withheld so 11 opens a gap.
  const order = [1, 2, 3, 4, 5, 6, 5, 7, 8, 9, 11, 12];
  return { runId: base.runId, events, order };
}

/** Same 100-node tree, with an off-screen child receiving 200 separate chunks. */
export function hundredStreamingFixture() {
  const fixture = hundredNodeFixture();
  fixture.name = 'hundred-nodes-streaming';
  const node = fixture.graph.nodes.find((entry) => entry.id === 'n99')!;
  node.status = 'queued';
  node.answer = null;
  node.contextHash = null;
  node.evidenceCount = 0;
  fixture.evidence.n99 = [];
  return fixture;
}

export function hundredStreamingScript() {
  const base = { schemaVersion: 1, runId: 'run-hundred-stream', nodeId: 'n99' };
  const events: Record<string, unknown>[] = [
    { ...base, seq: 1, kind: 'status', status: 'composing' },
    ...Array.from({ length: 200 }, (_, index) => ({
      ...base,
      seq: index + 2,
      kind: 'answer_delta',
      text: `Observation ${index + 1}. `,
    })),
    { ...base, seq: 202, kind: 'terminal', status: 'completed', reason: null },
  ];
  return { runId: base.runId, events, order: events.map((_, index) => index + 1) };
}

/** Wide and tall cards deliberately overlap and have long scattered connectors. */
export function autoFormatSprawlFixture({ streaming = false } = {}) {
  const fixture = streaming ? streamingFixture() : tenNodeFixture();
  fixture.name = streaming ? 'auto-format-streaming' : 'auto-format-sprawl';
  const positions = [
    [0, 1600],
    [200, 1650],
    [4200, 100],
    [2200, 3500],
    [2300, 3550],
    [6500, 700],
    [5800, 5200],
    [4400, 4200],
    [300, 5900],
    [6500, 5900],
    [6600, 2500],
  ];
  const sizes = [
    [560, 310],
    [700, 250],
    [330, 460],
    [430, 380],
    [480, 270],
    [650, 340],
    [360, 420],
    [520, 260],
    [380, 360],
    [540, 300],
    [440, 350],
  ];
  fixture.layout = {
    schemaVersion: 1,
    investigationId: fixture.graph.investigationId,
    layoutRevision: 7,
    nodes: Object.fromEntries(
      fixture.graph.nodes.map((node, index) => [
        node.id,
        {
          x: positions[index][0],
          y: positions[index][1],
          width: sizes[index][0],
          height: sizes[index][1],
          pinned: false,
        },
      ]),
    ),
  };
  return fixture;
}

/** A larger acceptance fixture with variable dimensions and scrambled branches. */
export function autoFormatHundredFixture() {
  const fixture = hundredNodeFixture();
  fixture.name = 'auto-format-hundred';
  fixture.layout = {
    schemaVersion: 1,
    investigationId: fixture.graph.investigationId,
    layoutRevision: 7,
    nodes: Object.fromEntries(
      fixture.graph.nodes.map((node, index) => [
        node.id,
        {
          x: ((index * 37) % 100) * 350,
          y: ((index * 61) % 100) * 320,
          width: 300 + (index % 5) * 110,
          height: 188 + (index % 4) * 85,
          pinned: false,
        },
      ]),
    ),
  };
  return fixture;
}

/** Two deliberately overlapping pins are constraints, not permission to move them. */
export function autoFormatPinnedConflictFixture() {
  const fixture = autoFormatSprawlFixture();
  fixture.name = 'auto-format-pinned-conflict';
  fixture.layout!.nodes['n-root'].pinned = true;
  fixture.layout!.nodes['n-pay'].pinned = true;
  return fixture;
}
