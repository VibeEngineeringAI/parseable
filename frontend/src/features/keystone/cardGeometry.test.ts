import { describe, expect, it } from 'vitest';
import { formatLayout } from '../../lib/keystone/layout';
import type { GraphNode, InvestigationGraph } from '../../lib/keystone/types';
import {
  COLLAPSED_CARD_HEIGHT,
  effectiveGeometry,
  expansionCollisions,
  fromStored,
  geometryDelta,
  restoreStoredSize,
  type CardGeometry,
} from './cardGeometry';

const scope = {
  id: 's',
  datasets: ['app'],
  start: '2026-10-13T00:00:00Z',
  end: '2026-10-13T01:00:00Z',
  timezone: 'UTC',
  filters: [],
};

function node(id: string, parentId: string | null, at: number): GraphNode {
  return {
    id,
    kind: 'question',
    intent: parentId ? 'follow_up' : 'root',
    parentId,
    parentVersion: parentId ? 1 : null,
    version: 1,
    title: id,
    prompt: id,
    answer: null,
    status: 'completed',
    scope,
    scopeChanged: false,
    evidenceCount: 0,
    contextHash: null,
    createdAt: `2026-10-13T00:00:0${at}Z`,
  };
}

const graph: InvestigationGraph = {
  schemaVersion: 1,
  investigationId: 'i',
  title: 'i',
  semanticRevision: 1,
  rootNodeId: 'r',
  nodes: [node('r', null, 0), node('a', 'r', 1), node('b', 'r', 2), node('c', 'r', 3)],
};

const card = (x: number, y: number, extra: Partial<CardGeometry> = {}): CardGeometry => ({
  x,
  y,
  width: 300,
  height: 400,
  pinned: false,
  ...extra,
});

function overlaps(a: { x: number; y: number; width: number; height: number }, b: typeof a) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

describe('collapsible card geometry', () => {
  it('draws collapsed cards at header height and keeps the stored expanded size', () => {
    const drawn = effectiveGeometry({ a: card(0, 0, { collapsed: true }), b: card(0, 0) });
    expect(drawn.a.height).toBe(COLLAPSED_CARD_HEIGHT);
    expect(drawn.b.height).toBe(400);
    expect('collapsed' in drawn.a).toBe(false);
  });

  it('formats collapsed cards compactly, then restores expanded sizes and flags', () => {
    const stored: Record<string, CardGeometry> = {
      r: card(0, 0),
      a: card(0, 0, { collapsed: true }),
      b: card(0, 0, { collapsed: true }),
      c: card(0, 0, { collapsed: false }),
    };
    const formatted = formatLayout(graph, effectiveGeometry(stored));
    const drawn = Object.entries(formatted.nodes);
    for (const [id, item] of drawn)
      for (const [other, rect] of drawn) if (id !== other) expect(overlaps(item, rect)).toBe(false);
    // Collapsed siblings are packed at header height, not at their 400 px expanded size.
    expect(formatted.nodes.b.y - formatted.nodes.a.y).toBeLessThan(100);
    const restored = restoreStoredSize(formatted.nodes, stored);
    expect(restored.a).toMatchObject({ height: 400, collapsed: true });
    expect(restored.c).toMatchObject({ height: 400, collapsed: false });
    expect('collapsed' in restored.r).toBe(false);
  });

  it('keeps pinned cards in place when formatting with collapsed cards', () => {
    const stored: Record<string, CardGeometry> = {
      r: card(0, 0),
      a: card(900, 900, { pinned: true, collapsed: true }),
      b: card(0, 0, { collapsed: true }),
      c: card(0, 0),
    };
    const restored = restoreStoredSize(
      formatLayout(graph, effectiveGeometry(stored)).nodes,
      stored,
    );
    expect(restored.a).toEqual(stored.a);
  });

  it('reports cards an expanded card covers without moving anything', () => {
    const geometry = {
      a: card(0, 0),
      b: card(0, 100, { collapsed: true }),
      c: card(0, 1000),
    };
    expect(expansionCollisions('a', geometry)).toEqual(['b']);
    expect(geometry.b).toEqual(card(0, 100, { collapsed: true }));
    expect(expansionCollisions('a', { ...geometry, a: card(0, 0, { collapsed: true }) })).toEqual(
      [],
    );
  });

  it('reads a recorded expanded height as the stored size and never writes it back', () => {
    const read = fromStored({
      a: { ...card(0, 0, { collapsed: true }), height: 120, expandedHeight: 420 },
      b: card(0, 0),
    });
    expect(read.a).toEqual(card(0, 0, { collapsed: true, height: 420 }));
    expect('expandedHeight' in read.a).toBe(false);
    expect(read.b).toEqual(card(0, 0));
  });

  it('treats a collapse toggle as a layout change but an absent flag as expanded', () => {
    expect(
      Object.keys(geometryDelta({ a: card(0, 0) }, { a: card(0, 0, { collapsed: true }) })),
    ).toEqual(['a']);
    expect(geometryDelta({ a: card(0, 0) }, { a: card(0, 0, { collapsed: false }) })).toEqual({});
  });
});
