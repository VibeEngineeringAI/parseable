// STORY ONLY: durable browser-local fake storage and manually scripted mock inference.
// This is never imported by the application, and makes no native/server/provider calls.
import { useEffect, useMemo } from 'react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { canonicalJson } from '../../../lib/keystone/context';
import {
  decodeCreatedNode,
  decodeEvidence,
  decodeGraph,
  decodeLayout,
  decodeParentExport,
  decodeRunEvent,
} from '../../../lib/keystone/decode';
import { treeLayout } from '../../../lib/keystone/layout';
import { applyRunEvent } from '../../../lib/keystone/streaming';
import { sha256 } from '../../../lib/sha256';
import type { SseFrame } from '../../../lib/keystone/sse';
import type { TransportResult } from '../../../lib/keystone/transport';
import type {
  CanvasLayout,
  Evidence,
  GraphNode,
  InvestigationGraph,
  ParentExport,
  RunEvent,
} from '../../../lib/keystone/types';
import { eligibleDatasets } from '../eligibleDatasets';
import { KeystoneFullPage } from '../KeystoneFullPage';
import type {
  InvestigationSummary,
  KeystonePageCapabilities,
  KeystonePageTransport,
} from '../pageContract';
import { serverCapabilityTransport, type ServerCapabilityCase } from './serverCapabilities';
import { AVAILABLE_DATASETS, SCOPE_30D, tenNodeFixture } from './synthetic';

export type PageFixtureVariant =
  | 'durable'
  | 'collapse'
  | 'unavailable'
  | 'mobile'
  | 'provider'
  | 'active-run'
  | 'run-link'
  | 'classic-missing'
  | 'denied'
  | `server-${ServerCapabilityCase}`;

/** Capability reads for `server-*` variants come from server-shaped bodies, decoded natively. */
function serverCase(variant: PageFixtureVariant): ServerCapabilityCase | null {
  return variant.startsWith('server-')
    ? (variant.slice('server-'.length) as ServerCapabilityCase)
    : null;
}

/** An ID no fixture store holds, as a classic-only investigation would be. */
export const CLASSIC_ONLY_ID = 'inv-classic-only';

/**
 * MOCK: a saved investigation whose follow-up already has an accepted run waiting in
 * the queue. Only the `active-run` and `run-link` variants seed it; the run moves only
 * when a test calls `advanceRun` or `failRun`.
 */
export const ACTIVE_FIXTURE = {
  investigationId: 'inv-fixture-active',
  title: 'Checkout timeouts · queued mock run',
  rootNodeId: 'n-active-root',
  childNodeId: 'n-active-child',
  runId: 'mock-run-seeded',
} as const;

/**
 * The link a run-link story opens, selecting the queued follow-up and its run. Kept in
 * one place so the route can follow the page's link format.
 */
export function activeRunLink(
  nodeId: string = ACTIVE_FIXTURE.childNodeId,
  runId: string = ACTIVE_FIXTURE.runId,
) {
  const query = new URLSearchParams({ node: nodeId, run: runId });
  return `/keystone/${ACTIVE_FIXTURE.investigationId}?${query}`;
}

/** Where a mock run's script stands; read-only, for tests. */
export interface MockRunState {
  cursor: number;
  total: number;
  delivered: RunEvent[];
  next: RunEvent | null;
}
export interface PageFixtureRequest {
  seq: number;
  kind: string;
  method: 'GET' | 'POST' | 'PATCH';
  path: string;
  body?: unknown;
  startsInference: boolean;
}
interface SavedInvestigation {
  graph: InvestigationGraph;
  layout: CanvasLayout;
  evidence: Record<string, Evidence[]>;
  inheritedSources: Record<string, string[]>;
}
interface MockRun {
  investigationId: string;
  nodeId: string;
  events: RunEvent[];
  cursor: number;
}
interface FixtureStore {
  investigations: Record<string, SavedInvestigation>;
  requests: PageFixtureRequest[];
  runs: Record<string, MockRun>;
  created: number;
  keys: number;
}
export interface PageFixtureHandle {
  mockInference: true;
  advanceRun(runId: string, count?: number): number;
  /**
   * Delivers events until one matching `stop` has been delivered: a status or terminal
   * status such as `composing`, or an event kind such as `evidence`. Returns the count.
   */
  advanceRunTo(runId: string, stop: string): number;
  /**
   * MOCK provider failure: drops the undelivered script and delivers a `failed`
   * terminal event. Nothing already delivered is changed. No request is recorded,
   * because the failure comes from the server, not the user.
   */
  failRun(runId: string, reason?: string): void;
  /** MOCK connection failure; optionally finish on the server before the UI checks it. */
  disconnectRun(runId: string, complete?: boolean): void;
  runState(runId: string): MockRunState;
  snapshot(): FixtureStore;
  failNextCredentialSave(): void;
}
declare global {
  interface Window {
    __ksPageFixture?: PageFixtureHandle;
    __ksPageRequests?: PageFixtureRequest[];
  }
}

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const NOW = '2026-10-13T12:00:00Z';
const label =
  'Synthetic durable browser storage and scripted mock inference. No native server, provider, telemetry, or query calls.';
function decoded<T>(
  result: { ok: true; value: T } | { ok: false; error: string },
): TransportResult<T> {
  return result.ok ? result : { ok: false, kind: 'invalid', message: result.error };
}
export const MOCK_FAILURE = 'Mock provider failure: the scripted model call returned an error.';
const missing = () =>
  ({ ok: false, kind: 'not_found', message: 'Fixture investigation not found.' }) as const;

/**
 * MOCK inference script for one accepted run. It is never sent anywhere: the harness
 * delivers it one event at a time only when a test advances it. The provider response
 * is non-streaming, so the script reports phases and a whole answer, never a percent,
 * token count or estimated time.
 */
function scriptRun(runId: string, node: GraphNode): RunEvent[] {
  const base = { schemaVersion: 1 as const, runId, nodeId: node.id };
  const evidence: Evidence = {
    id: `mock-source-${runId}`,
    nodeId: node.id,
    title: 'Mock timeout sample',
    sql: `SELECT code, count(*) FROM ${node.scope.datasets[0]} WHERE p_timestamp >= '${node.scope.start}' AND p_timestamp < '${node.scope.end}' GROUP BY code`,
    datasets: [node.scope.datasets[0]],
    start: node.scope.start,
    end: node.scope.end,
    executedAt: NOW,
    status: 'ok',
    rowCount: 1,
    truncated: false,
    columns: ['code', 'count'],
    rows: [['MOCK_TIMEOUT', 12]],
  };
  return [
    { ...base, seq: 1, kind: 'status', status: 'querying' },
    { ...base, seq: 2, kind: 'status', status: 'composing' },
    {
      ...base,
      seq: 3,
      kind: 'answer_checkpoint',
      text: 'Mock inference: preliminary timeout counts.',
    },
    { ...base, seq: 4, kind: 'evidence', evidence },
    {
      ...base,
      seq: 5,
      kind: 'answer_checkpoint',
      text: 'Mock inference: 12 timeout samples in the fixed window. This is a scripted fixture answer.',
    },
    { ...base, seq: 6, kind: 'terminal', status: 'completed', reason: null },
  ];
}

/** MOCK: a completed root and a follow-up whose accepted run has not started. */
function activeInvestigation(): { saved: SavedInvestigation; run: MockRun } {
  const scope = { ...SCOPE_30D, id: 'scope-active-30d', datasets: ['checkout_logs'] };
  const root: GraphNode = {
    id: ACTIVE_FIXTURE.rootNodeId,
    kind: 'question',
    intent: 'root',
    parentId: null,
    parentVersion: null,
    version: 1,
    title: 'Checkout timeouts',
    prompt: 'Why did checkout timeouts rise over the last 30 days?',
    answer: 'Mock fixture answer: timeouts rose after payment latency increased.',
    status: 'completed',
    scope,
    scopeChanged: false,
    evidenceCount: 1,
    contextHash: 'mock-context-n-active-root',
    createdAt: NOW,
    runId: 'mock-run-seeded-root',
  };
  const child: GraphNode = {
    ...root,
    id: ACTIVE_FIXTURE.childNodeId,
    intent: 'follow_up',
    parentId: root.id,
    parentVersion: root.version,
    title: 'Timeout codes',
    prompt: 'Which error codes make up the timeouts?',
    answer: null,
    status: 'queued',
    evidenceCount: 0,
    contextHash: null,
    runId: ACTIVE_FIXTURE.runId,
  };
  const graph: InvestigationGraph = {
    schemaVersion: 1,
    investigationId: ACTIVE_FIXTURE.investigationId,
    title: ACTIVE_FIXTURE.title,
    semanticRevision: 3,
    rootNodeId: root.id,
    nodes: [root, child],
  };
  const rootEvidence: Evidence = {
    id: `ev-${root.id}-0`,
    nodeId: root.id,
    title: 'Mock timeouts by day',
    sql: `SELECT date_trunc('day', p_timestamp) AS day, count(*) FROM checkout_logs WHERE p_timestamp >= '${scope.start}' AND p_timestamp < '${scope.end}' GROUP BY 1`,
    datasets: ['checkout_logs'],
    start: scope.start,
    end: scope.end,
    executedAt: NOW,
    status: 'ok',
    rowCount: 1,
    truncated: false,
    columns: ['day', 'count'],
    rows: [['2026-10-04', 41]],
  };
  return {
    saved: {
      graph,
      layout: {
        schemaVersion: 1,
        investigationId: graph.investigationId,
        layoutRevision: 1,
        nodes: treeLayout(graph),
      },
      evidence: { [root.id]: [rootEvidence], [child.id]: [] },
      inheritedSources: { [child.id]: [] },
    },
    run: {
      investigationId: graph.investigationId,
      nodeId: child.id,
      events: scriptRun(ACTIVE_FIXTURE.runId, child),
      cursor: 0,
    },
  };
}

function seed(variant: PageFixtureVariant): FixtureStore {
  const completed = tenNodeFixture({ sentinels: true });
  completed.graph.investigationId = 'inv-fixture-completed';
  completed.graph.title = 'Checkout error spike · saved fixture';
  const geometry = treeLayout(completed.graph);
  if (variant === 'collapse') {
    geometry['n-root'] = { ...geometry['n-root'], width: 350, height: 280, collapsed: true };
    geometry['n-pay'] = {
      ...geometry['n-pay'],
      x: 0,
      y: geometry['n-root'].y + 70,
      width: 350,
      height: 260,
    };
  }
  const draft: GraphNode = {
    ...completed.graph.nodes[0],
    id: 'n-draft-root',
    title: 'Saved draft · mock fixture',
    prompt: 'What changed in checkout over the last 30 days?',
    answer: null,
    status: 'draft',
    evidenceCount: 0,
    contextHash: null,
  };
  const draftGraph: InvestigationGraph = {
    schemaVersion: 1,
    investigationId: 'inv-fixture-draft',
    title: draft.title,
    semanticRevision: 1,
    rootNodeId: draft.id,
    nodes: [draft],
  };
  const active = variant === 'active-run' || variant === 'run-link' ? activeInvestigation() : null;
  return {
    investigations: {
      ...(active ? { [ACTIVE_FIXTURE.investigationId]: active.saved } : {}),
      [completed.graph.investigationId]: {
        graph: completed.graph,
        layout: {
          schemaVersion: 1,
          investigationId: completed.graph.investigationId,
          layoutRevision: 1,
          nodes: geometry,
        },
        evidence: completed.evidence,
        inheritedSources: {},
      },
      [draftGraph.investigationId]: {
        graph: draftGraph,
        layout: {
          schemaVersion: 1,
          investigationId: draftGraph.investigationId,
          layoutRevision: 1,
          nodes: treeLayout(draftGraph),
        },
        evidence: {},
        inheritedSources: {},
      },
    },
    requests: [],
    runs: active ? { [ACTIVE_FIXTURE.runId]: active.run } : {},
    created: 0,
    keys: 0,
  };
}

function createPageHarness(variant: PageFixtureVariant) {
  const key = `keystone-full-page-fixture-v1:${variant}`;
  const stored = localStorage.getItem(key);
  const store: FixtureStore = stored ? JSON.parse(stored) : seed(variant);
  const persist = () => localStorage.setItem(key, JSON.stringify(store));
  persist();
  const record = (
    kind: string,
    method: PageFixtureRequest['method'],
    path: string,
    body?: unknown,
  ) => {
    store.requests.push({
      seq: store.requests.length + 1,
      kind,
      method,
      path,
      ...(body === undefined ? {} : { body: clone(body) }),
      startsInference: kind === 'startRun',
    });
    persist();
  };
  const caps: KeystonePageCapabilities = {
    storage: { state: 'ready', reason: null },
    execution:
      variant === 'unavailable'
        ? { state: 'unavailable', reason: 'execution_unavailable' }
        : { state: 'ready', reason: null },
    workspace: {
      schemaVersion: 1,
      generative: { state: 'ready', reason: null },
      tools: { state: 'ready', reason: null },
      actions: {
        // `denied`: storage is ready, but the role has no investigation access.
        read: variant !== 'denied',
        run: variant !== 'denied',
        branch: variant !== 'denied',
        editLayout: variant !== 'denied',
        manageProviders: variant === 'provider',
      },
    },
  };
  if (variant === 'provider')
    caps.provider = {
      model: 'xiaomi/mimo-v2.6-flash',
      apiBase: 'https://openrouter.ai/api/v1',
      credentialEntry: true,
    };
  let credentialFailure = false;
  const summary = (saved: SavedInvestigation): InvestigationSummary => ({
    id: saved.graph.investigationId,
    title: saved.graph.title,
    rootNodeId: saved.graph.rootNodeId,
    updatedAt: NOW,
  });
  const parentExport = async (
    saved: SavedInvestigation,
    node: GraphNode,
  ): Promise<ParentExport> => {
    const value: ParentExport = {
      contextPolicy: 'direct_parent_v1',
      parentNodeId: node.id,
      parentVersion: node.version,
      parentStatus: node.status,
      prompt: node.prompt,
      answer: node.answer ?? '',
      scope: node.scope,
      evidence: saved.evidence[node.id] ?? [],
      omitted: [],
      truncated: false,
    };
    return { ...value, exportHash: await sha256(canonicalJson(value)) };
  };
  const subscribers = new Map<
    string,
    Set<{ after: number; emit: (frame: SseFrame) => void; done: () => void; fail: () => void }>
  >();
  const deliver = (runId: string) => {
    const run = store.runs[runId];
    for (const subscriber of [...(subscribers.get(runId) ?? [])]) {
      for (const event of run.events.slice(0, run.cursor)) {
        if (event.seq <= subscriber.after) continue;
        subscriber.after = event.seq;
        subscriber.emit({ id: String(event.seq), event: 'message', data: JSON.stringify(event) });
        if (event.kind === 'terminal') subscriber.done();
      }
    }
  };
  const advanceRun = (runId: string, count = 1) => {
    const run = store.runs[runId];
    if (!run) throw new Error(`Unknown mock run ${runId}`);
    const saved = store.investigations[run.investigationId];
    let delivered = 0;
    while (delivered < count && run.cursor < run.events.length) {
      const event = run.events[run.cursor++];
      const parsed = decodeRunEvent(event);
      if (!parsed.ok) throw new Error(parsed.error);
      const index = saved.graph.nodes.findIndex((node) => node.id === run.nodeId);
      const known = new Set((saved.evidence[run.nodeId] ?? []).map((item) => item.id));
      saved.graph.nodes[index] = applyRunEvent(saved.graph.nodes[index], parsed.value, known);
      if (event.kind === 'terminal') saved.graph.semanticRevision++;
      if (event.kind === 'evidence' && !known.has(event.evidence.id))
        saved.evidence[run.nodeId] = [...(saved.evidence[run.nodeId] ?? []), event.evidence];
      delivered++;
    }
    persist();
    deliver(runId);
    return delivered;
  };
  const runOf = (runId: string) => {
    const run = store.runs[runId];
    if (!run) throw new Error(`Unknown mock run ${runId}`);
    return run;
  };
  // Replaces the undelivered script with one terminal event and delivers it.
  const terminate = (runId: string, status: 'cancelled' | 'failed', reason: string) => {
    const run = runOf(runId);
    if (run.events.slice(0, run.cursor).some((event) => event.kind === 'terminal'))
      throw new Error(`Mock run ${runId} already ended`);
    run.events = run.events.slice(0, run.cursor);
    run.events.push({
      schemaVersion: 1,
      runId,
      nodeId: run.nodeId,
      seq: run.cursor + 1,
      kind: 'terminal',
      status,
      reason,
    });
    advanceRun(runId);
  };
  const advanceRunTo = (runId: string, stop: string) => {
    const run = runOf(runId);
    let delivered = 0;
    while (run.cursor < run.events.length) {
      const event = run.events[run.cursor];
      delivered += advanceRun(runId);
      if (event.kind === stop || ('status' in event && event.status === stop)) return delivered;
    }
    throw new Error(`Mock run ${runId} never reached ${stop}`);
  };
  const transport: KeystonePageTransport = {
    async saveProviderCredential(_key, signal) {
      // Only a synthetic marker is recorded. The entered value is never retained,
      // logged, persisted, exposed by a hook, or included in an error.
      record('saveProviderCredential', 'POST', '/fixture/provider', { action: 'credential_saved' });
      if (signal.aborted) return { ok: false, kind: 'error', message: 'Fixture save cancelled.' };
      if (_key !== _key.trim())
        return { ok: false, kind: 'error', message: 'Fixture credential save failed. Try again.' };
      if (credentialFailure) {
        credentialFailure = false;
        return { ok: false, kind: 'error', message: 'Fixture credential save failed. Try again.' };
      }
      return { ok: true, value: 'saved' };
    },
    async capabilities(signal) {
      record('pageCapabilities', 'GET', '/capabilities');
      const server = serverCase(variant);
      if (server) return serverCapabilityTransport(server).capabilities(signal);
      return { ok: true, value: clone(caps) };
    },
    async listInvestigations() {
      record('listInvestigations', 'GET', '/investigations');
      return {
        ok: true,
        value: { items: Object.values(store.investigations).map(summary), next: null },
      };
    },
    async createInvestigation(request) {
      record('createInvestigation', 'POST', '/investigations', request);
      const id = `inv-mock-${++store.created}`,
        nodeId = `n-mock-root-${store.created}`;
      const node: GraphNode = {
        id: nodeId,
        kind: 'question',
        intent: 'root',
        parentId: null,
        parentVersion: null,
        version: 1,
        title: request.title,
        prompt: request.prompt,
        answer: null,
        status: 'draft',
        scope: { ...request.scope, id: `scope-${id}` },
        scopeChanged: false,
        evidenceCount: 0,
        contextHash: null,
        createdAt: NOW,
      };
      const graph: InvestigationGraph = {
        schemaVersion: 1,
        investigationId: id,
        title: request.title,
        semanticRevision: 1,
        rootNodeId: nodeId,
        nodes: [node],
      };
      const saved: SavedInvestigation = {
        graph,
        layout: {
          schemaVersion: 1,
          investigationId: id,
          layoutRevision: 1,
          nodes: treeLayout(graph),
        },
        evidence: {},
        inheritedSources: {},
      };
      store.investigations[id] = saved;
      persist();
      return { ok: true, value: summary(saved) };
    },
    workspace: {
      async capabilities() {
        record('capabilities', 'GET', '/workspace/capabilities');
        return { ok: true, value: clone(caps.workspace) };
      },
      async graph(id) {
        record('graph', 'GET', `/investigations/${id}/graph`);
        const saved = store.investigations[id];
        return saved ? decoded(decodeGraph(clone(saved.graph))) : missing();
      },
      async layout(id, ids) {
        record('layout', 'GET', `/investigations/${id}/layout`);
        const saved = store.investigations[id];
        return saved ? decoded(decodeLayout(clone(saved.layout), ids)) : missing();
      },
      async patchLayout(id, patch) {
        record('layout.patch', 'PATCH', `/investigations/${id}/layout`, patch);
        const saved = store.investigations[id];
        if (!saved) return missing();
        if (patch.expectedLayoutRevision !== saved.layout.layoutRevision)
          return { ok: false, kind: 'conflict', message: 'Fixture layout revision changed.' };
        const next = {
          ...saved.layout,
          layoutRevision: saved.layout.layoutRevision + 1,
          nodes: { ...saved.layout.nodes, ...patch.nodes },
        };
        const parsed = decodeLayout(next, new Set(saved.graph.nodes.map((node) => node.id)));
        if (parsed.ok) {
          saved.layout = parsed.value;
          persist();
        }
        return decoded(parsed);
      },
      async parentExport(id, nodeId) {
        record('parentExport', 'GET', `/investigations/${id}/nodes/${nodeId}/export`);
        const saved = store.investigations[id],
          node = saved?.graph.nodes.find((item) => item.id === nodeId);
        return saved && node
          ? decoded(decodeParentExport(await parentExport(saved, node)))
          : missing();
      },
      async evidence(id, nodeId, signal) {
        record('evidence', 'GET', `/investigations/${id}/nodes/${nodeId}/evidence`);
        if (signal?.aborted) return { ok: false, kind: 'error', message: 'Read cancelled.' };
        const saved = store.investigations[id];
        if (!saved) return missing();
        const items: Evidence[] = [];
        for (const item of saved.evidence[nodeId] ?? []) {
          const parsed = decodeEvidence(clone(item));
          if (!parsed.ok) return decoded(parsed);
          items.push(parsed.value);
        }
        return { ok: true, value: items };
      },
      async createNode(id, request) {
        record('createNode', 'POST', `/investigations/${id}/nodes`, request);
        const saved = store.investigations[id],
          parent = saved?.graph.nodes.find((node) => node.id === request.parentNodeId);
        if (!saved || !parent) return missing();
        const exported = await parentExport(saved, parent);
        if (
          request.parentVersion !== parent.version ||
          request.parentExportSha256 !== exported.exportHash ||
          request.expectedSemanticRevision !== saved.graph.semanticRevision
        )
          return { ok: false, kind: 'conflict', message: 'Fixture parent changed.' };
        const sources = request.exportedEvidenceIds ?? [];
        if (sources.some((source) => !exported.evidence.some((item) => item.id === source)))
          return { ok: false, kind: 'denied', message: 'Source is not from this parent.' };
        const nodeId = `n-mock-child-${++store.created}`;
        const node: GraphNode = {
          id: nodeId,
          kind: 'question',
          intent: request.intent,
          parentId: parent.id,
          parentVersion: parent.version,
          version: 1,
          title: request.prompt.slice(0, 60),
          prompt: request.prompt,
          answer: null,
          status: 'draft',
          scope: request.scope ? { ...request.scope, id: `scope-${nodeId}` } : clone(parent.scope),
          scopeChanged: request.scope !== null,
          evidenceCount: 0,
          contextHash: null,
          createdAt: NOW,
        };
        saved.graph.nodes.push(node);
        saved.graph.semanticRevision++;
        saved.layout.nodes[nodeId] = treeLayout(saved.graph)[nodeId];
        saved.inheritedSources[nodeId] = [...sources];
        persist();
        return decoded(
          decodeCreatedNode({ node, runId: null, semanticRevision: saved.graph.semanticRevision }),
        );
      },
    },
    async startRun(id, request) {
      record('startRun', 'POST', `/investigations/${id}/runs`, request);
      if (caps.execution.state !== 'ready')
        return {
          ok: false,
          kind: 'gated',
          reason: 'tools_unavailable',
          message: 'Mock execution unavailable.',
        };
      const saved = store.investigations[id],
        node = saved?.graph.nodes.find((item) => item.id === request.nodeId);
      if (!saved || !node) return missing();
      if (
        !['draft', 'failed', 'cancelled', 'interrupted', 'partial'].includes(node.status) ||
        node.version !== request.nodeVersion ||
        saved.graph.semanticRevision !== request.expectedRevision
      )
        return { ok: false, kind: 'conflict', message: 'Draft changed.' };
      const runId = `mock-run-${Object.keys(store.runs).length + 1}`;
      node.status = 'queued';
      node.runId = runId;
      node.answer = null;
      node.evidenceCount = 0;
      saved.evidence[node.id] = [];
      saved.graph.semanticRevision++;
      store.runs[runId] = {
        investigationId: id,
        nodeId: node.id,
        events: scriptRun(runId, node),
        cursor: 0,
      };
      persist();
      return { ok: true, value: { runId } };
    },
    async cancelRun(id, runId) {
      record('cancelRun', 'POST', `/investigations/${id}/runs/${runId}/cancel`);
      const run = store.runs[runId];
      if (!run || run.investigationId !== id) return missing();
      const ended = run.events.slice(0, run.cursor).find((event) => event.kind === 'terminal');
      if (ended?.kind === 'terminal') return { ok: true, value: { status: ended.status } };
      terminate(runId, 'cancelled', 'Mock cancellation requested.');
      return { ok: true, value: { status: 'cancelled' } };
    },
    runEvents(id, runId, after, onFrame, signal) {
      record('runEvents', 'GET', `/investigations/${id}/runs/${runId}/events?after=${after}`);
      const run = store.runs[runId];
      if (!run || run.investigationId !== id) return Promise.resolve(missing());
      return new Promise((resolve) => {
        const set = subscribers.get(runId) ?? new Set();
        subscribers.set(runId, set);
        const subscriber = {
          after,
          emit: onFrame,
          done: () => {
            set.delete(subscriber);
            resolve({ ok: true, value: 'ended' });
          },
          fail: () => {
            set.delete(subscriber);
            resolve({ ok: false, kind: 'error', message: 'Mock event connection interrupted.' });
          },
        };
        set.add(subscriber);
        signal.addEventListener('abort', subscriber.done, { once: true });
        if (signal.aborted) subscriber.done();
        else deliver(runId);
      });
    },
  };
  const handle: PageFixtureHandle = {
    mockInference: true,
    advanceRun,
    advanceRunTo,
    failRun: (runId, reason = MOCK_FAILURE) => terminate(runId, 'failed', reason),
    disconnectRun: (runId, complete = false) => {
      const disconnected = [...(subscribers.get(runId) ?? [])];
      subscribers.get(runId)?.clear();
      if (complete) advanceRunTo(runId, 'completed');
      disconnected.forEach((subscriber) => subscriber.fail());
    },
    runState: (runId) => {
      const run = runOf(runId);
      return clone({
        cursor: run.cursor,
        total: run.events.length,
        delivered: run.events.slice(0, run.cursor),
        next: run.events[run.cursor] ?? null,
      });
    },
    snapshot: () => clone(store),
    failNextCredentialSave: () => {
      credentialFailure = true;
    },
  };
  return {
    key,
    transport,
    handle,
    createKey: () => {
      store.keys++;
      persist();
      return `mock-idempotency-${variant}-${store.keys}`;
    },
    // Records each dataset operation the page's loader makes: one listing, then one
    // metadata lookup per investigable name, through the page's own eligibility rule.
    loadDatasets: async (signal: AbortSignal) => {
      record('listDatasets', 'GET', '/api/v1/logstream');
      return eligibleDatasets(
        [...AVAILABLE_DATASETS, '_internal_fixture'],
        async (name) => {
          record('datasetInfo', 'GET', `/api/v1/logstream/${name}/info`);
          return { streamType: 'UserDefined' };
        },
        signal,
      );
    },
    install: () => {
      window.__ksPageFixture = handle;
      window.__ksPageRequests = store.requests;
    },
  };
}

function FixtureRoute({
  harness,
  classicAvailable,
}: {
  harness: ReturnType<typeof createPageHarness>;
  classicAvailable: boolean;
}) {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  // The query is kept so a reload reopens the same linked node and run.
  useEffect(
    () => localStorage.setItem(`${harness.key}:route`, location.pathname + location.search),
    [harness.key, location.pathname, location.search],
  );
  return (
    <>
      {/* STORY ONLY: exposes the in-memory route so tests can check links. */}
      <output
        hidden
        data-testid="ks-fixture-route"
        data-route={location.pathname + location.search}
      />
      <KeystoneFullPage
        transport={harness.transport}
        investigationId={id}
        loadDatasets={harness.loadDatasets}
        onOpen={(next) => navigate(`/keystone/${next}`)}
        createIdempotencyKey={harness.createKey}
        classicAvailable={classicAvailable}
      />
    </>
  );
}

export function KeystonePageFixtureStory({
  variant = 'durable',
  classicAvailable = false,
  route: start,
}: {
  variant?: PageFixtureVariant;
  /** Mounts the page as it is under a prefix, beside the classic UI. */
  classicAvailable?: boolean;
  /** The first route, when it differs from the variant's default. */
  route?: string;
}) {
  const harness = useMemo(() => createPageHarness(variant), [variant]);
  harness.install();
  const initial =
    localStorage.getItem(`${harness.key}:route`) ??
    start ??
    (variant === 'collapse' || variant === 'server-degraded'
      ? '/keystone/inv-fixture-completed'
      : variant === 'run-link'
        ? activeRunLink()
        : variant === 'classic-missing'
          ? `/keystone/${CLASSIC_ONLY_ID}`
          : '/keystone');
  const route = <FixtureRoute harness={harness} classicAvailable={classicAvailable} />;
  return (
    <main className="ks-story" data-testid="ks-full-fixture" data-mock-inference="true">
      <p className="ks-story-label" data-testid="ks-page-fixture-banner">
        {label}
      </p>
      <MemoryRouter initialEntries={[initial]}>
        <Routes>
          <Route path="/keystone" element={route} />
          <Route path="/keystone/:id" element={route} />
        </Routes>
      </MemoryRouter>
    </main>
  );
}
