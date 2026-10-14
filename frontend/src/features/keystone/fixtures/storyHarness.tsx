// STORY-ONLY harness. Serves synthetic fixtures through the real strict decoders and
// records every request for Playwright. Never import this from application code.

import { useCallback, useMemo, useRef } from 'react';
import { canonicalJson } from '../../../lib/keystone/context';
import {
  decodeCapabilities,
  decodeCreatedNode,
  decodeEvidence,
  decodeGraph,
  decodeLayout,
  decodeParentExport,
  decodeRunEvent,
} from '../../../lib/keystone/decode';
import { applyRunEvent } from '../../../lib/keystone/streaming';
import { sha256 } from '../../../lib/sha256';
import type { SseFrame } from '../../../lib/keystone/sse';
import type {
  KeystoneTransport,
  RunEventSource,
  TransportResult,
} from '../../../lib/keystone/transport';
import type {
  CanvasLayout,
  Evidence,
  GraphNode,
  KeystoneCapabilities,
  NodeGeometry,
  ParentExport,
  UnavailableReason,
} from '../../../lib/keystone/types';
import { KeystoneWorkspace, type KeystoneView } from '../KeystoneWorkspace';
import type { KeystoneFlowInstance } from '../KeystoneCanvas';
import { AVAILABLE_DATASETS, SYNTHETIC_LABEL, type InvestigationFixture } from './synthetic';

export type RequestKind =
  'capabilities' | 'graph' | 'layout' | 'layout.patch' | 'parentExport' | 'evidence' | 'createNode';

export interface RecordedRequest {
  seq: number;
  kind: RequestKind;
  method: 'GET' | 'POST' | 'PATCH';
  path: string;
  body?: unknown;
  /** Only a branch command can start a run; presentation calls never do. */
  startsRun: boolean;
}

export interface FixtureOptions {
  capabilities?: Partial<Omit<KeystoneCapabilities, 'schemaVersion'>>;
  /** Fail the first layout PATCH with a revision conflict. */
  layoutConflict?: boolean;
  /** Return this graph body instead of the fixture graph (for decoder failures). */
  rawGraph?: unknown;
  /** Capabilities request fails as if the server had no Keystone API. */
  unavailable?: UnavailableReason;
  stream?: { runId: string; events: Record<string, unknown>[]; order: number[] };
}

declare global {
  interface Window {
    __ksRequests?: RecordedRequest[];
    __ksFixture?: KsFixtureHandle;
  }
}

export interface KsFixtureHandle {
  name: string;
  synthetic: true;
  investigationId: string;
  nodeCount: number;
  edgeCount: number;
  otherTenantSentinel: string;
  /** Sentinels a child of `parentId` may inherit: that parent's prompt and answer. */
  inheritedFor(parentId: string): string[];
  /** Sentinels that must never reach a child of `parentId`. */
  forbiddenFor(parentId: string): string[];
  delayArtifact(nodeId: string, milliseconds: number): void;
  abortedEvidence(): string[];
  layoutRevision(): number;
  /** Keep layout writes pending until explicitly released, without arbitrary timers. */
  layoutWrites: { hold(): void; release(): void; pending(): number };
  viewport(): { x: number; y: number; zoom: number } | null;
  stream: { step(): number | null; flush(): number; remaining(): number };
}

const READY: KeystoneCapabilities = {
  schemaVersion: 1,
  generative: { state: 'ready', reason: null },
  tools: { state: 'ready', reason: null },
  actions: { read: true, run: true, branch: true, editLayout: true, manageProviders: false },
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function exportFor(node: GraphNode, evidence: Evidence[]): ParentExport {
  return {
    contextPolicy: 'direct_parent_v1',
    parentNodeId: node.id,
    parentVersion: node.version,
    parentStatus: node.status,
    prompt: node.prompt,
    answer: node.answer ?? '',
    scope: node.scope,
    evidence,
    omitted: [],
    truncated: false,
  };
}

export function createFixtureHarness(fixture: InvestigationFixture, options: FixtureOptions = {}) {
  const requests: RecordedRequest[] = [];
  const nodes = new Map(fixture.graph.nodes.map((node) => [node.id, clone(node)]));
  let semanticRevision = fixture.graph.semanticRevision;
  let layout: CanvasLayout = fixture.layout
    ? clone(fixture.layout)
    : {
        schemaVersion: 1,
        investigationId: fixture.graph.investigationId,
        layoutRevision: 1,
        nodes: {},
      };
  let conflictPending = !!options.layoutConflict;
  const evidenceDelays = new Map<string, number>();
  const abortedEvidence: string[] = [];
  let created = 0;
  let flow: KeystoneFlowInstance | null = null;
  let holdLayoutWrites = false;
  const heldLayoutWrites: Array<() => void> = [];
  const capabilities: KeystoneCapabilities = {
    ...READY,
    ...clone(options.capabilities ?? {}),
    schemaVersion: 1,
  };

  const record = (entry: Omit<RecordedRequest, 'seq' | 'startsRun'>) =>
    requests.push({
      ...clone(entry),
      seq: requests.length + 1,
      startsRun: entry.kind === 'createNode',
    });

  // Every response passes through the same strict decoders as the HTTP transport.
  function decoded<T>(
    result: { ok: true; value: T } | { ok: false; error: string },
  ): TransportResult<T> {
    return result.ok
      ? { ok: true, value: result.value }
      : { ok: false, kind: 'invalid', message: `Unexpected Keystone response: ${result.error}` };
  }
  const base = `/investigations/${fixture.graph.investigationId}`;
  const resolve = <T,>(value: T) => Promise.resolve(value);

  const transport: KeystoneTransport = {
    capabilities() {
      record({ kind: 'capabilities', method: 'GET', path: '/capabilities' });
      if (options.unavailable)
        return resolve({
          ok: false,
          kind: 'gated',
          reason: options.unavailable,
          message: 'Unavailable',
        });
      return resolve(decoded(decodeCapabilities(clone(capabilities))));
    },
    graph() {
      record({ kind: 'graph', method: 'GET', path: `${base}/graph` });
      const body = options.rawGraph ?? {
        ...clone(fixture.graph),
        semanticRevision,
        nodes: [...nodes.values()].map(clone),
      };
      return resolve(decoded(decodeGraph(body)));
    },
    layout(_id, nodeIds) {
      record({ kind: 'layout', method: 'GET', path: `${base}/layout` });
      return resolve(decoded(decodeLayout(clone(layout), nodeIds)));
    },
    async patchLayout(_id, patch) {
      record({ kind: 'layout.patch', method: 'PATCH', path: `${base}/layout`, body: patch });
      if (holdLayoutWrites) await new Promise<void>((release) => heldLayoutWrites.push(release));
      if (conflictPending) {
        conflictPending = false;
        layout = { ...layout, layoutRevision: layout.layoutRevision + 1 };
        return resolve({ ok: false, kind: 'conflict', message: 'Layout revision changed.' });
      }
      if (patch.expectedLayoutRevision !== layout.layoutRevision)
        return resolve({ ok: false, kind: 'conflict', message: 'Layout revision changed.' });
      const merged: Record<string, NodeGeometry> = { ...layout.nodes, ...patch.nodes };
      layout = { ...layout, layoutRevision: layout.layoutRevision + 1, nodes: merged };
      return resolve(decoded(decodeLayout(clone(layout))));
    },
    parentExport(_id, nodeId) {
      record({ kind: 'parentExport', method: 'GET', path: `${base}/nodes/${nodeId}/export` });
      const node = nodes.get(nodeId);
      if (!node) return resolve({ ok: false, kind: 'not_found', message: 'Not found' });
      return resolve(
        decoded(decodeParentExport(clone(exportFor(node, fixture.evidence[nodeId] ?? [])))),
      );
    },
    async evidence(_id, nodeId, signal) {
      record({ kind: 'evidence', method: 'GET', path: `${base}/nodes/${nodeId}/evidence` });
      const delay = evidenceDelays.get(nodeId) ?? 0;
      if (delay)
        await new Promise<void>((done) => {
          const timer = setTimeout(done, delay);
          signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              abortedEvidence.push(nodeId);
              done();
            },
            { once: true },
          );
        });
      if (signal?.aborted) return { ok: false, kind: 'error', message: 'Read cancelled.' };
      const items: Evidence[] = [];
      for (const item of clone(fixture.evidence[nodeId] ?? [])) {
        const result = decodeEvidence(item);
        if (!result.ok) return resolve(decoded(result));
        items.push(result.value);
      }
      return resolve({ ok: true, value: items });
    },
    async createNode(_id, request) {
      record({ kind: 'createNode', method: 'POST', path: `${base}/nodes`, body: request });
      if (capabilities.generative.state !== 'ready')
        return {
          ok: false,
          kind: 'gated',
          reason: capabilities.generative.reason ?? 'provider_unconfigured',
          message: 'No provider',
        };
      const parent = nodes.get(request.parentNodeId);
      if (!parent) return { ok: false, kind: 'not_found', message: 'Not found' };
      const expected = await sha256(
        canonicalJson(exportFor(parent, fixture.evidence[parent.id] ?? [])),
      );
      if (request.parentVersion !== parent.version || request.parentExportSha256 !== expected)
        return { ok: false, kind: 'conflict', message: 'Parent export changed.' };
      if (request.expectedSemanticRevision !== semanticRevision)
        return { ok: false, kind: 'conflict', message: 'Semantic revision changed.' };
      created += 1;
      semanticRevision += 1;
      // The fixture records the branch but attaches no provider: the node stays queued.
      const node: GraphNode = {
        id: `n-new-${created}`,
        kind: 'question',
        intent: request.intent,
        parentId: parent.id,
        parentVersion: request.parentVersion,
        version: 1,
        title: request.prompt.length > 40 ? `${request.prompt.slice(0, 39)}…` : request.prompt,
        prompt: request.prompt,
        answer: null,
        status: 'queued',
        scope: request.scope ? { ...request.scope, id: `scope-new-${created}` } : parent.scope,
        scopeChanged: request.scope !== null,
        evidenceCount: 0,
        contextHash: null,
        createdAt: new Date(Date.parse('2026-10-13T06:00:00Z') + created * 1000)
          .toISOString()
          .replace('.000Z', 'Z'),
      };
      nodes.set(node.id, node);
      return decoded(decodeCreatedNode(clone({ node, runId: null, semanticRevision })));
    },
  };

  // Run event source driven step by step by the test, never by a timer.
  const listeners = new Set<(runId: string, frame: SseFrame) => void>();
  const script = options.stream;
  let cursor = 0;
  let committed = 0;
  const frameFor = (seq: number): SseFrame | null => {
    const event = script?.events.find((item) => item.seq === seq);
    return event ? { id: String(seq), event: 'message', data: JSON.stringify(event) } : null;
  };
  const emit = (seq: number) => {
    const frame = frameFor(seq);
    if (!frame || !script) return;
    // Persist every committed event in order, even when delivery intentionally gaps.
    for (let next = committed + 1; next <= seq; next++) {
      const raw = script.events.find((item) => item.seq === next);
      const parsed = decodeRunEvent(raw);
      if (parsed.ok) {
        const event = parsed.value;
        const current = nodes.get(event.nodeId);
        if (current) nodes.set(current.id, applyRunEvent(current, event));
      }
    }
    committed = Math.max(committed, seq);
    for (const listener of listeners) listener(script.runId, frame);
  };
  const events: RunEventSource = {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    replay(runId, after) {
      if (!script || runId !== script.runId) return;
      queueMicrotask(() => {
        for (let seq = after + 1; seq <= committed; seq++) {
          const frame = frameFor(seq);
          if (frame) for (const listener of listeners) listener(runId, frame);
        }
      });
    },
  };

  const edgeCount = fixture.graph.nodes.filter((node) => node.parentId !== null).length;
  const sentinelsOf = (id: string) => [`KS-PROMPT-${id}`, `KS-ANSWER-${id}`, `KS-HIDDEN-${id}`];
  const handle: KsFixtureHandle = {
    name: fixture.name,
    synthetic: true,
    investigationId: fixture.graph.investigationId,
    nodeCount: fixture.graph.nodes.length,
    edgeCount,
    otherTenantSentinel: fixture.otherTenant,
    inheritedFor: (parentId) => [`KS-PROMPT-${parentId}`, `KS-ANSWER-${parentId}`],
    forbiddenFor: (parentId) => [
      `KS-HIDDEN-${parentId}`,
      fixture.otherTenant,
      ...fixture.graph.nodes
        .filter((node) => node.id !== parentId)
        .flatMap((node) => sentinelsOf(node.id)),
    ],
    delayArtifact: (nodeId, milliseconds) => evidenceDelays.set(nodeId, milliseconds),
    abortedEvidence: () => [...abortedEvidence],
    layoutRevision: () => layout.layoutRevision,
    layoutWrites: {
      hold: () => {
        holdLayoutWrites = true;
      },
      release: () => {
        holdLayoutWrites = false;
        for (const release of heldLayoutWrites.splice(0)) release();
      },
      pending: () => heldLayoutWrites.length,
    },
    viewport: () => (flow ? flow.getViewport() : null),
    stream: {
      step() {
        if (!script || cursor >= script.order.length) return null;
        const seq = script.order[cursor++];
        emit(seq);
        return seq;
      },
      flush() {
        let count = 0;
        while (handle.stream.step() !== null) count++;
        return count;
      },
      remaining: () => (script ? script.order.length - cursor : 0),
    },
  };

  return {
    transport,
    events,
    requests,
    handle,
    setFlow(instance: KeystoneFlowInstance) {
      flow = instance;
    },
    install() {
      window.__ksRequests = requests;
      window.__ksFixture = handle;
    },
  };
}

export interface KeystoneFixtureStoryProps {
  fixture: InvestigationFixture;
  options?: FixtureOptions;
  view?: KeystoneView;
  selectedId?: string;
  isAdmin?: boolean;
}

export function KeystoneFixtureStory({
  fixture,
  options,
  view,
  selectedId,
  isAdmin,
}: KeystoneFixtureStoryProps) {
  const harness = useMemo(() => createFixtureHarness(fixture, options), [fixture, options]);
  // Installed during render so requests made by child effects are already recorded.
  const installed = useRef<typeof harness | null>(null);
  if (installed.current !== harness) {
    harness.install();
    installed.current = harness;
  }
  const keys = useRef(0);
  const createKey = useCallback(() => `idem-${fixture.name}-${++keys.current}`, [fixture.name]);
  return (
    <div className="ks-story" data-testid="ks-story" data-fixture={fixture.name}>
      <p className="ks-story-label" data-testid="ks-fixture-banner">
        {SYNTHETIC_LABEL}
      </p>
      <KeystoneWorkspace
        transport={harness.transport}
        events={options?.stream ? harness.events : undefined}
        investigationId={fixture.graph.investigationId}
        isAdmin={isAdmin}
        availableDatasets={AVAILABLE_DATASETS}
        initialView={view}
        initialSelectedId={selectedId}
        createIdempotencyKey={createKey}
        onCanvasInit={harness.setFlow}
      />
    </div>
  );
}
