import {
  CONTEXT_POLICY,
  NODE_STATUSES,
  type CanvasLayout,
  type CellValue,
  type Evidence,
  type EvidenceStatus,
  type GraphNode,
  type InvestigationGraph,
  type KeystoneCapabilities,
  type NodeGeometry,
  type NodeStatus,
  type ParentExport,
  type ReadinessState,
  type RunEvent,
  type ScopeVersion,
  type UnavailableReason,
} from './types';

// Strict decoders: unknown fields, wrong types and inconsistent graphs are rejected
// rather than coerced. A parent export carrying any extra field (for example an
// ancestor transcript) fails to decode, so it can never reach the preview.

export type Decoded<T> = { ok: true; value: T } | { ok: false; error: string };

export class DecodeError extends Error {}

/** Graph bounds; larger graphs must be paginated by the server. */
export const MAX_GRAPH_NODES = 1_000;
export const MAX_EVIDENCE_ROWS = 500;
const MAX_COORDINATE = 1_000_000;
const MIN_NODE_SIZE = 80;
const MAX_NODE_SIZE = 4_096;

function fail(path: string, message: string): never {
  throw new DecodeError(`${path}: ${message}`);
}

function record(value: unknown, path: string, keys: readonly string[]) {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    fail(path, 'expected an object');
  const object = value as Record<string, unknown>;
  for (const key of Object.keys(object))
    if (!keys.includes(key)) fail(`${path}.${key}`, 'unexpected field');
  return object;
}

function string(value: unknown, path: string, { empty = false } = {}) {
  if (typeof value !== 'string') fail(path, 'expected a string');
  if (!empty && value.length === 0) fail(path, 'expected a non-empty string');
  return value;
}

function nullableString(value: unknown, path: string) {
  return value === null ? null : string(value, path, { empty: true });
}

function hash(value: unknown, path: string) {
  const text = string(value, path);
  if (!/^[a-f0-9]{64}$/.test(text)) fail(path, 'expected a SHA-256 hash');
  return text;
}

function integer(value: unknown, path: string, min = 0) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min)
    fail(path, `expected an integer ≥ ${min}`);
  return value;
}

function boolean(value: unknown, path: string) {
  if (typeof value !== 'boolean') fail(path, 'expected a boolean');
  return value;
}

function oneOf<T extends string>(value: unknown, path: string, options: readonly T[]): T {
  if (typeof value !== 'string' || !options.includes(value as T))
    fail(path, `expected one of ${options.join(', ')}`);
  return value as T;
}

function stringList(value: unknown, path: string) {
  if (!Array.isArray(value)) fail(path, 'expected an array');
  return value.map((item, index) => string(item, `${path}[${index}]`));
}

function instant(value: unknown, path: string) {
  const text = string(value, path);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(text) ||
    Number.isNaN(Date.parse(text))
  )
    fail(path, 'expected an RFC 3339 UTC instant');
  return text;
}

function schemaVersion(value: unknown, path: string): 1 {
  if (value !== 1) fail(path, 'unsupported schema version');
  return 1;
}

function run<T>(decode: () => T): Decoded<T> {
  try {
    return { ok: true, value: decode() };
  } catch (error) {
    if (error instanceof DecodeError) return { ok: false, error: error.message };
    throw error;
  }
}

function scope(value: unknown, path: string): ScopeVersion {
  const object = record(value, path, ['id', 'datasets', 'start', 'end', 'timezone', 'filters']);
  const start = instant(object.start, `${path}.start`);
  const end = instant(object.end, `${path}.end`);
  if (Date.parse(end) <= Date.parse(start)) fail(path, 'end must be after start');
  const datasets = stringList(object.datasets, `${path}.datasets`);
  if (datasets.length === 0) fail(`${path}.datasets`, 'at least one dataset is required');
  if (new Set(datasets).size !== datasets.length) fail(`${path}.datasets`, 'duplicate dataset');
  return {
    id: string(object.id, `${path}.id`),
    datasets,
    start,
    end,
    timezone: string(object.timezone, `${path}.timezone`),
    filters: stringList(object.filters, `${path}.filters`),
  };
}

function cell(value: unknown, path: string): CellValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  fail(path, 'expected a scalar cell');
}

function evidence(value: unknown, path: string): Evidence {
  const object = record(value, path, [
    'id',
    'nodeId',
    'title',
    'sql',
    'datasets',
    'start',
    'end',
    'executedAt',
    'status',
    'rowCount',
    'truncated',
    'columns',
    'rows',
  ]);
  const columns = stringList(object.columns, `${path}.columns`);
  if (!Array.isArray(object.rows)) fail(`${path}.rows`, 'expected an array');
  if (object.rows.length > MAX_EVIDENCE_ROWS) fail(`${path}.rows`, 'too many rows');
  const rows = object.rows.map((row, index) => {
    if (!Array.isArray(row) || row.length !== columns.length)
      fail(`${path}.rows[${index}]`, 'row width does not match columns');
    return row.map((item, column) => cell(item, `${path}.rows[${index}][${column}]`));
  });
  const rowCount = integer(object.rowCount, `${path}.rowCount`);
  const truncated = boolean(object.truncated, `${path}.truncated`);
  if (rowCount < rows.length) fail(`${path}.rowCount`, 'smaller than returned rows');
  if (!truncated && rowCount !== rows.length)
    fail(`${path}.rowCount`, 'untruncated count mismatch');
  return {
    id: string(object.id, `${path}.id`),
    nodeId: string(object.nodeId, `${path}.nodeId`),
    title: string(object.title, `${path}.title`),
    sql: string(object.sql, `${path}.sql`, { empty: true }),
    datasets: stringList(object.datasets, `${path}.datasets`),
    start: instant(object.start, `${path}.start`),
    end: instant(object.end, `${path}.end`),
    executedAt: instant(object.executedAt, `${path}.executedAt`),
    status: oneOf<EvidenceStatus>(object.status, `${path}.status`, [
      'ok',
      'empty',
      'denied',
      'error',
      'expired',
    ]),
    rowCount,
    truncated,
    columns,
    rows,
  };
}

function node(value: unknown, path: string): GraphNode {
  const object = record(value, path, [
    'id',
    'kind',
    'intent',
    'parentId',
    'parentVersion',
    'version',
    'title',
    'prompt',
    'answer',
    'status',
    'scope',
    'scopeChanged',
    'evidenceCount',
    'contextHash',
    'createdAt',
    'runId',
  ]);
  const parentId = nullableString(object.parentId, `${path}.parentId`);
  const intent = oneOf(object.intent, `${path}.intent`, ['root', 'follow_up', 'explore'] as const);
  const parentVersion =
    object.parentVersion === null
      ? null
      : integer(object.parentVersion, `${path}.parentVersion`, 1);
  if ((parentId === null) !== (intent === 'root'))
    fail(path, 'only the root has no parent, and the root has intent root');
  if ((parentId === null) !== (parentVersion === null))
    fail(path, 'parentVersion must accompany parentId');
  return {
    id: string(object.id, `${path}.id`),
    kind: oneOf(object.kind, `${path}.kind`, ['question', 'visualization'] as const),
    intent,
    parentId,
    parentVersion,
    version: integer(object.version, `${path}.version`, 1),
    title: string(object.title, `${path}.title`),
    prompt: string(object.prompt, `${path}.prompt`),
    answer: nullableString(object.answer, `${path}.answer`),
    status: oneOf<NodeStatus>(object.status, `${path}.status`, NODE_STATUSES),
    scope: scope(object.scope, `${path}.scope`),
    scopeChanged: boolean(object.scopeChanged, `${path}.scopeChanged`),
    evidenceCount: integer(object.evidenceCount, `${path}.evidenceCount`),
    contextHash: nullableString(object.contextHash, `${path}.contextHash`),
    createdAt: instant(object.createdAt, `${path}.createdAt`),
    ...(object.runId === undefined ? {} : { runId: nullableString(object.runId, `${path}.runId`) }),
  };
}

/** Rejects duplicate IDs, dangling parents, multiple roots and cycles. */
function validateTree(nodes: GraphNode[], rootNodeId: string) {
  const byId = new Map<string, GraphNode>();
  for (const item of nodes) {
    if (byId.has(item.id)) fail(`nodes.${item.id}`, 'duplicate node ID');
    byId.set(item.id, item);
  }
  const root = byId.get(rootNodeId);
  if (!root) fail('rootNodeId', 'root node is missing');
  if (root.parentId !== null) fail('rootNodeId', 'root node has a parent');
  for (const item of nodes) {
    if (item.parentId === null && item.id !== rootNodeId) fail(`nodes.${item.id}`, 'second root');
    if (item.parentId !== null && !byId.has(item.parentId))
      fail(`nodes.${item.id}.parentId`, 'parent is not in this investigation');
  }
  // Every node must reach the root within nodes.length steps.
  for (const item of nodes) {
    let current: GraphNode | undefined = item;
    for (let steps = 0; current && current.parentId !== null; steps++) {
      if (steps > nodes.length) fail(`nodes.${item.id}`, 'parent links form a cycle');
      current = byId.get(current.parentId);
    }
  }
}

export function decodeGraph(value: unknown): Decoded<InvestigationGraph> {
  return run(() => {
    const object = record(value, 'graph', [
      'schemaVersion',
      'investigationId',
      'title',
      'semanticRevision',
      'rootNodeId',
      'nodes',
    ]);
    if (!Array.isArray(object.nodes)) fail('graph.nodes', 'expected an array');
    if (object.nodes.length > MAX_GRAPH_NODES) fail('graph.nodes', 'graph exceeds the node budget');
    const nodes = object.nodes.map((item, index) => node(item, `graph.nodes[${index}]`));
    const rootNodeId = string(object.rootNodeId, 'graph.rootNodeId');
    validateTree(nodes, rootNodeId);
    return {
      schemaVersion: schemaVersion(object.schemaVersion, 'graph.schemaVersion'),
      investigationId: string(object.investigationId, 'graph.investigationId'),
      title: string(object.title, 'graph.title'),
      semanticRevision: integer(object.semanticRevision, 'graph.semanticRevision'),
      rootNodeId,
      nodes,
    };
  });
}

function geometry(value: unknown, path: string): NodeGeometry {
  const object = record(value, path, [
    'x',
    'y',
    'width',
    'height',
    'pinned',
    'collapsed',
    'expandedHeight',
  ]);
  const coordinate = (item: unknown, key: string) => {
    if (typeof item !== 'number' || !Number.isFinite(item) || Math.abs(item) > MAX_COORDINATE)
      fail(`${path}.${key}`, 'expected a bounded finite coordinate');
    return item;
  };
  const size = (item: unknown, key: string) => {
    const number = coordinate(item, key);
    if (number < (key === 'width' ? 100 : MIN_NODE_SIZE) || number > MAX_NODE_SIZE)
      fail(`${path}.${key}`, 'size out of range');
    return number;
  };
  return {
    x: coordinate(object.x, 'x'),
    y: coordinate(object.y, 'y'),
    width: size(object.width, 'width'),
    height: size(object.height, 'height'),
    pinned: boolean(object.pinned, `${path}.pinned`),
    ...(object.collapsed === undefined
      ? {}
      : { collapsed: boolean(object.collapsed, `${path}.collapsed`) }),
    ...(object.expandedHeight === undefined
      ? {}
      : { expandedHeight: size(object.expandedHeight, 'expandedHeight') }),
  };
}

export function decodeLayout(
  value: unknown,
  knownNodeIds?: ReadonlySet<string>,
): Decoded<CanvasLayout> {
  return run(() => {
    const object = record(value, 'layout', [
      'schemaVersion',
      'investigationId',
      'layoutRevision',
      'nodes',
    ]);
    const nodes = record(object.nodes, 'layout.nodes', Object.keys(object.nodes ?? {}));
    const decoded: Record<string, NodeGeometry> = {};
    for (const [id, item] of Object.entries(nodes)) {
      if (knownNodeIds && !knownNodeIds.has(id)) fail(`layout.nodes.${id}`, 'unknown node');
      decoded[id] = geometry(item, `layout.nodes.${id}`);
    }
    return {
      schemaVersion: schemaVersion(object.schemaVersion, 'layout.schemaVersion'),
      investigationId: string(object.investigationId, 'layout.investigationId'),
      layoutRevision: integer(object.layoutRevision, 'layout.layoutRevision'),
      nodes: decoded,
    };
  });
}

export function decodeParentExport(value: unknown): Decoded<ParentExport> {
  return run(() => {
    const object = record(value, 'export', [
      'contextPolicy',
      'parentNodeId',
      'parentVersion',
      'parentStatus',
      'exportHash',
      'prompt',
      'answer',
      'scope',
      'evidence',
      'omitted',
      'truncated',
    ]);
    if (object.contextPolicy !== CONTEXT_POLICY) fail('export.contextPolicy', 'unsupported policy');
    const parentNodeId = string(object.parentNodeId, 'export.parentNodeId');
    if (!Array.isArray(object.evidence)) fail('export.evidence', 'expected an array');
    const items = object.evidence.map((item, index) => evidence(item, `export.evidence[${index}]`));
    for (const item of items)
      if (item.nodeId !== parentNodeId)
        fail(`export.evidence.${item.id}`, 'evidence does not belong to the direct parent');
    return {
      contextPolicy: CONTEXT_POLICY,
      parentNodeId,
      parentVersion: integer(object.parentVersion, 'export.parentVersion', 1),
      parentStatus: oneOf<NodeStatus>(object.parentStatus, 'export.parentStatus', NODE_STATUSES),
      prompt: string(object.prompt, 'export.prompt'),
      answer: string(object.answer, 'export.answer', { empty: true }),
      scope: scope(object.scope, 'export.scope'),
      evidence: items,
      omitted: stringList(object.omitted, 'export.omitted'),
      truncated: boolean(object.truncated, 'export.truncated'),
      ...(object.exportHash === undefined
        ? {}
        : { exportHash: hash(object.exportHash, 'export.exportHash') }),
    };
  });
}

/** A node created by a branch command: it must be a child, never a second root. */
export function decodeCreatedNode(
  value: unknown,
): Decoded<{ node: GraphNode; runId: string | null; semanticRevision: number }> {
  return run(() => {
    const object = record(value, 'created', ['node', 'runId', 'semanticRevision']);
    const created = node(object.node, 'created.node');
    if (created.parentId === null) fail('created.node.parentId', 'a branch must have a parent');
    return {
      node: created,
      runId: nullableString(object.runId, 'created.runId'),
      semanticRevision: integer(object.semanticRevision, 'created.semanticRevision'),
    };
  });
}

export function decodeEvidence(value: unknown): Decoded<Evidence> {
  return run(() => evidence(value, 'evidence'));
}

const READINESS: readonly ReadinessState[] = [
  'ready',
  'unconfigured',
  'disabled',
  'degraded',
  'unavailable',
];
const REASONS: readonly UnavailableReason[] = [
  'backend_missing',
  'provider_unconfigured',
  'provider_disabled',
  'tools_unavailable',
  'permission_denied',
  'topology_unsupported',
];

function readiness(value: unknown, path: string) {
  const object = record(value, path, ['state', 'reason']);
  const state = oneOf(object.state, `${path}.state`, READINESS);
  const reason = object.reason === null ? null : oneOf(object.reason, `${path}.reason`, REASONS);
  if (state !== 'ready' && reason === null) fail(path, 'a non-ready state needs a reason');
  return { state, reason };
}

export function decodeCapabilities(value: unknown): Decoded<KeystoneCapabilities> {
  return run(() => {
    const object = record(value, 'capabilities', [
      'schemaVersion',
      'generative',
      'tools',
      'actions',
    ]);
    const actions = record(object.actions, 'capabilities.actions', [
      'read',
      'run',
      'branch',
      'editLayout',
      'manageProviders',
    ]);
    return {
      schemaVersion: schemaVersion(object.schemaVersion, 'capabilities.schemaVersion'),
      generative: readiness(object.generative, 'capabilities.generative'),
      tools: readiness(object.tools, 'capabilities.tools'),
      actions: {
        read: boolean(actions.read, 'capabilities.actions.read'),
        run: boolean(actions.run, 'capabilities.actions.run'),
        branch: boolean(actions.branch, 'capabilities.actions.branch'),
        editLayout: boolean(actions.editLayout, 'capabilities.actions.editLayout'),
        manageProviders: boolean(actions.manageProviders, 'capabilities.actions.manageProviders'),
      },
    };
  });
}

const TERMINAL = ['completed', 'partial', 'cancelled', 'failed', 'interrupted'] as const;

export function decodeRunEvent(value: unknown): Decoded<RunEvent> {
  return run(() => {
    const kind = record(value, 'event', Object.keys(value ?? {})).kind;
    const base = ['schemaVersion', 'runId', 'nodeId', 'seq', 'kind'];
    const fields: Record<string, string[]> = {
      status: ['status'],
      answer_delta: ['text'],
      answer_checkpoint: ['text'],
      evidence: ['evidence'],
      terminal: ['status', 'reason'],
    };
    const name = oneOf(kind, 'event.kind', Object.keys(fields) as RunEvent['kind'][]);
    const object = record(value, 'event', [...base, ...fields[name]]);
    const common = {
      schemaVersion: schemaVersion(object.schemaVersion, 'event.schemaVersion'),
      runId: string(object.runId, 'event.runId'),
      nodeId: string(object.nodeId, 'event.nodeId'),
      seq: integer(object.seq, 'event.seq', 1),
    };
    switch (name) {
      case 'status':
        return {
          ...common,
          kind: name,
          status: oneOf(object.status, 'event.status', NODE_STATUSES),
        };
      case 'answer_delta':
      case 'answer_checkpoint':
        return { ...common, kind: name, text: string(object.text, 'event.text', { empty: true }) };
      case 'evidence': {
        const item = evidence(object.evidence, 'event.evidence');
        if (item.nodeId !== common.nodeId)
          fail('event.evidence.nodeId', 'evidence for another node');
        return { ...common, kind: name, evidence: item };
      }
      case 'terminal':
        return {
          ...common,
          kind: name,
          status: oneOf(object.status, 'event.status', TERMINAL),
          reason: nullableString(object.reason, 'event.reason'),
        };
    }
  });
}

/** Parses JSON text, then decodes; JSON syntax errors become decode failures. */
export function decodeJson<T>(text: string, decode: (value: unknown) => Decoded<T>): Decoded<T> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: 'body is not valid JSON' };
  }
  return decode(value);
}
