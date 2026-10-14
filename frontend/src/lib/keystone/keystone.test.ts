import { describe, expect, it } from 'vitest';
import {
  applyRunEvent,
  canonicalJson,
  decodeCapabilities,
  decodeGraph,
  decodeLayout,
  decodeParentExport,
  decodeRunEvent,
  formatDuration,
  layoutDelta,
  lineageEdges,
  neighbours,
  readingOrder,
  resolveLayout,
  RunEventSequencer,
  scopeDiff,
  SseParser,
  treeLayout,
  type GraphNode,
  type InvestigationGraph,
  type ScopeVersion,
} from './index';

const scope: ScopeVersion = {
  id: 'scope-1',
  datasets: ['checkout_logs'],
  start: '2026-09-13T00:00:00Z',
  end: '2026-10-13T00:00:00Z',
  timezone: 'UTC',
  filters: [],
};

function node(id: string, parentId: string | null, extra: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    kind: 'question',
    intent: parentId === null ? 'root' : 'follow_up',
    parentId,
    parentVersion: parentId === null ? null : 1,
    version: 1,
    title: id,
    prompt: `prompt ${id}`,
    answer: `answer ${id}`,
    status: 'completed',
    scope,
    scopeChanged: false,
    evidenceCount: 0,
    contextHash: null,
    createdAt: `2026-10-13T00:00:0${id.length % 10}Z`,
    ...extra,
  };
}

function graph(nodes: GraphNode[]): InvestigationGraph {
  return {
    schemaVersion: 1,
    investigationId: 'inv-1',
    title: 'Checkout errors',
    semanticRevision: 3,
    rootNodeId: nodes[0].id,
    nodes,
  };
}

describe('graph decoder', () => {
  it('accepts a rooted tree and derives one edge per child', () => {
    const decoded = decodeGraph(graph([node('p', null), node('a', 'p'), node('b', 'p')]));
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(lineageEdges(decoded.value.nodes)).toHaveLength(2);
  });

  it.each([
    ['unknown field', graph([{ ...node('p', null), transcript: 'x' } as GraphNode])],
    ['dangling parent', graph([node('p', null), node('a', 'missing')])],
    ['duplicate id', graph([node('p', null), node('p', null)])],
    ['second root', graph([node('p', null), node('q', null)])],
    [
      'cycle',
      {
        ...graph([node('p', null), node('a', 'b'), node('b', 'a')]),
      },
    ],
    ['bad instant', graph([node('p', null, { createdAt: '13/10/2026' })])],
    ['inverted scope', graph([node('p', null, { scope: { ...scope, end: scope.start } })])],
    [
      'non-root without parent version',
      graph([node('p', null), node('a', 'p', { parentVersion: null })]),
    ],
  ])('rejects %s', (_name, value) => {
    expect(decodeGraph(value).ok).toBe(false);
  });
});

describe('parent export decoder', () => {
  const exported = {
    contextPolicy: 'direct_parent_v1',
    parentNodeId: 'a',
    parentVersion: 2,
    parentStatus: 'completed',
    prompt: 'What changed?',
    answer: 'Payment latency rose.',
    scope,
    evidence: [],
    omitted: ['Parent input transcript'],
    truncated: false,
  };

  it('accepts exactly the direct-parent fields', () => {
    expect(decodeParentExport(exported).ok).toBe(true);
  });

  it('rejects any ancestor or sibling material', () => {
    expect(decodeParentExport({ ...exported, ancestors: [] }).ok).toBe(false);
    expect(decodeParentExport({ ...exported, contextPolicy: 'ancestor_chain' }).ok).toBe(false);
  });

  it('rejects evidence that belongs to another node', () => {
    const evidence = {
      id: 'e1',
      nodeId: 'p',
      title: 'Errors',
      sql: 'SELECT 1',
      datasets: ['checkout_logs'],
      start: scope.start,
      end: scope.end,
      executedAt: scope.end,
      status: 'ok',
      rowCount: 1,
      truncated: false,
      columns: ['n'],
      rows: [[1]],
    };
    expect(decodeParentExport({ ...exported, evidence: [evidence] }).ok).toBe(false);
    expect(decodeParentExport({ ...exported, evidence: [{ ...evidence, nodeId: 'a' }] }).ok).toBe(
      true,
    );
  });
});

describe('layout decoder', () => {
  const layout = {
    schemaVersion: 1,
    investigationId: 'inv-1',
    layoutRevision: 4,
    nodes: { p: { x: 0, y: 0, width: 300, height: 188, pinned: false } },
  };
  it('rejects unknown nodes and non-finite geometry', () => {
    expect(decodeLayout(layout, new Set(['p'])).ok).toBe(true);
    expect(decodeLayout(layout, new Set(['q'])).ok).toBe(false);
    expect(decodeLayout({ ...layout, nodes: { p: { ...layout.nodes.p, x: Number.NaN } } }).ok).toBe(
      false,
    );
    expect(decodeLayout({ ...layout, nodes: { p: { ...layout.nodes.p, width: 20 } } }).ok).toBe(
      false,
    );
  });
});

describe('capabilities decoder', () => {
  it('requires a reason for every non-ready state', () => {
    const value = {
      schemaVersion: 1,
      generative: { state: 'unconfigured', reason: null },
      tools: { state: 'ready', reason: null },
      actions: { read: true, run: false, branch: false, editLayout: true, manageProviders: false },
    };
    expect(decodeCapabilities(value).ok).toBe(false);
    expect(
      decodeCapabilities({
        ...value,
        generative: { state: 'unconfigured', reason: 'provider_unconfigured' },
      }).ok,
    ).toBe(true);
  });
});

describe('SSE parser', () => {
  it('handles split UTF-8, CRLF across chunks, comments and multi-line data', () => {
    const parser = new SseParser();
    const bytes = new TextEncoder().encode(
      ': heartbeat\r\nid: 1\r\ndata: {"t":"é"\r\ndata: }\r\n\r\n',
    );
    const frames = [];
    for (let index = 0; index < bytes.length; index += 3)
      frames.push(...parser.push(bytes.slice(index, index + 3)));
    frames.push(...parser.end());
    expect(frames).toEqual([{ id: '1', event: 'message', data: '{"t":"é"\n}' }]);
  });

  it('flushes an unterminated final frame', () => {
    const parser = new SseParser();
    expect(parser.push('data: a')).toEqual([]);
    expect(parser.end()).toEqual([{ id: null, event: 'message', data: 'a' }]);
  });
});

describe('run event sequencing', () => {
  const frame = (seq: number, extra: Record<string, unknown> = {}) => ({
    id: String(seq),
    event: 'message',
    data: JSON.stringify({
      schemaVersion: 1,
      runId: 'run-1',
      nodeId: 'a',
      seq,
      kind: 'answer_delta',
      text: `t${seq}`,
      ...extra,
    }),
  });

  it('drops duplicates and stalls on a gap until resync', () => {
    const sequencer = new RunEventSequencer('run-1');
    expect(sequencer.accept(frame(1)).type).toBe('apply');
    expect(sequencer.accept(frame(1)).type).toBe('duplicate');
    expect(sequencer.accept(frame(3))).toEqual({ type: 'gap', expected: 2, received: 3 });
    expect(sequencer.accept(frame(2)).type).toBe('gap');
    expect(sequencer.needsResync).toBe(true);
    sequencer.resync(3);
    expect(sequencer.accept(frame(3)).type).toBe('duplicate');
    expect(sequencer.accept(frame(4)).type).toBe('apply');
  });

  it('rejects events for another run, mismatched ids and unknown fields', () => {
    const sequencer = new RunEventSequencer('run-1');
    expect(sequencer.accept(frame(1, { runId: 'run-2' })).type).toBe('invalid');
    expect(sequencer.accept({ ...frame(1), id: '9' }).type).toBe('invalid');
    expect(sequencer.accept(frame(1, { hidden: 'x' })).type).toBe('invalid');
    expect(decodeRunEvent({ ...JSON.parse(frame(1).data), kind: 'reasoning' }).ok).toBe(false);
  });

  it('ignores deltas after a terminal event', () => {
    let state = node('a', 'p', { answer: '', status: 'composing' });
    const base = { schemaVersion: 1 as const, runId: 'run-1', nodeId: 'a' };
    state = applyRunEvent(state, { ...base, seq: 1, kind: 'answer_delta', text: 'Hi' });
    state = applyRunEvent(state, {
      ...base,
      seq: 2,
      kind: 'terminal',
      status: 'cancelled',
      reason: 'user',
    });
    state = applyRunEvent(state, { ...base, seq: 3, kind: 'answer_delta', text: ' late' });
    expect(state.answer).toBe('Hi');
    expect(state.status).toBe('cancelled');
  });
});

describe('layout', () => {
  const tree = graph([node('p', null), node('a', 'p'), node('bb', 'p'), node('ccc', 'a')]);

  it('is deterministic and centres parents on their children', () => {
    const first = treeLayout(tree);
    expect(treeLayout(structuredClone(tree))).toEqual(first);
    expect(first.p.x).toBe(0);
    expect(first.ccc.x).toBeGreaterThan(first.a.x);
    expect(first.p.y).toBe((first.a.y + first.bb.y) / 2);
  });

  it('keeps saved geometry, and pinned cards survive auto layout', () => {
    const saved = {
      schemaVersion: 1 as const,
      investigationId: 'inv-1',
      layoutRevision: 2,
      nodes: {
        a: { x: 999, y: 999, width: 320, height: 200, pinned: true },
        bb: { x: 777, y: 777, width: 300, height: 188, pinned: false },
      },
    };
    const kept = resolveLayout(tree, saved);
    expect(kept.bb.x).toBe(777);
    const auto = resolveLayout(tree, saved, { autoLayout: true });
    expect(auto.a.x).toBe(999);
    expect(auto.bb.x).not.toBe(777);
    expect(Object.keys(layoutDelta(kept, auto))).toContain('bb');
    expect(layoutDelta(kept, auto)).not.toHaveProperty('a');
  });

  it('lays out 100 nodes and 99 edges', () => {
    const nodes = [node('n0', null)];
    for (let index = 1; index < 100; index++)
      nodes.push(node(`n${index}`, `n${Math.floor((index - 1) / 3)}`));
    const large = graph(nodes);
    expect(decodeGraph(large).ok).toBe(true);
    expect(Object.keys(treeLayout(large))).toHaveLength(100);
    expect(lineageEdges(nodes)).toHaveLength(99);
    expect(readingOrder(large)).toHaveLength(100);
  });
});

describe('branch neighbours', () => {
  it('lists siblings in creation order without crossing branches', () => {
    const tree = graph([
      node('p', null),
      node('a', 'p', { createdAt: '2026-10-13T00:00:01Z' }),
      node('b', 'p', { createdAt: '2026-10-13T00:00:02Z' }),
      node('c', 'a'),
    ]);
    const result = neighbours(tree, 'b');
    expect(result.parent?.id).toBe('p');
    expect(result.siblings.map((item) => item.id)).toEqual(['a', 'b']);
    expect(result.index).toBe(1);
    expect(neighbours(tree, 'c').siblings.map((item) => item.id)).toEqual(['c']);
  });
});

describe('scope diff', () => {
  it('keeps an inherited 30-day window unchanged', () => {
    const diff = scopeDiff(scope, scope);
    expect(diff.changed).toBe(false);
    expect(formatDuration(diff.parentDurationMs)).toBe('30 days');
  });

  it('flags narrowing to 24 hours as a change and widening as wider', () => {
    const narrowed = scopeDiff(scope, { ...scope, start: '2026-10-12T00:00:00Z' });
    expect(narrowed.changed).toBe(true);
    expect(narrowed.widens).toBe(false);
    expect(formatDuration(narrowed.childDurationMs)).toBe('24 hours');
    const widened = scopeDiff(scope, { ...scope, datasets: ['checkout_logs', 'payments'] });
    expect(widened.widens).toBe(true);
    expect(widened.datasetsAdded).toEqual(['payments']);
  });
});

describe('canonical JSON', () => {
  it('sorts keys at every level so equal exports hash identically', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 0 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[2,{"y":0,"z":1}]},"b":1}',
    );
  });
});
