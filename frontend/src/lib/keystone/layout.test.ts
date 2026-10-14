import { describe, expect, it } from 'vitest';
import { lineageEdges } from './graph';
import {
  FormatLayoutError,
  formatLayout,
  NODE_HEIGHT,
  NODE_WIDTH,
  resolveLayout,
  treeLayout,
} from './layout';
import type { CanvasLayout, GraphNode, InvestigationGraph, NodeGeometry } from './types';

function graph(parents: (string | null)[]): InvestigationGraph {
  return {
    schemaVersion: 1,
    investigationId: 'format-test',
    title: 'Investigation',
    semanticRevision: 7,
    rootNodeId: 'n0',
    nodes: parents.map((parentId, index): GraphNode => ({
      id: `n${index}`,
      parentId,
      parentVersion: parentId === null ? null : 1,
      kind: 'question',
      intent: parentId === null ? 'root' : 'follow_up',
      version: 1,
      title: `Node ${index}`,
      prompt: 'Question',
      answer: 'Answer',
      status: 'completed',
      scope: {
        id: 'scope',
        datasets: ['logs'],
        start: '2026-10-01T00:00:00Z',
        end: '2026-10-13T00:00:00Z',
        timezone: 'UTC',
        filters: [],
      },
      scopeChanged: false,
      evidenceCount: 0,
      contextHash: null,
      createdAt: new Date(Date.UTC(2026, 9, 13, 0, 0, index)).toISOString(),
    })),
  };
}

function geometry(extra: Partial<NodeGeometry> = {}): NodeGeometry {
  return { x: 0, y: 0, width: NODE_WIDTH, height: NODE_HEIGHT, pinned: false, ...extra };
}

function expectNoOverlap(nodes: Record<string, NodeGeometry>, allowPinnedOverlap = false) {
  const entries = Object.entries(nodes);
  for (let left = 0; left < entries.length; left += 1)
    for (let right = left + 1; right < entries.length; right += 1) {
      const [leftId, a] = entries[left];
      const [rightId, b] = entries[right];
      if (allowPinnedOverlap && a.pinned && b.pinned) continue;
      const overlap =
        a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
      expect(overlap, `${leftId} overlaps ${rightId}`).toBe(false);
    }
}

function bounds(nodes: Record<string, NodeGeometry>) {
  const cards = Object.values(nodes);
  return {
    width:
      Math.max(...cards.map((card) => card.x + card.width)) -
      Math.min(...cards.map((card) => card.x)),
    height:
      Math.max(...cards.map((card) => card.y + card.height)) -
      Math.min(...cards.map((card) => card.y)),
  };
}

describe('explicit layout formatting', () => {
  it('uses resized widths and heights and keeps parent centres aligned with their children', () => {
    const tree = graph([null, 'n0', 'n0', 'n1', 'n1', 'n2', 'n2']);
    const current = {
      n0: geometry({ width: 700, height: 900, x: 10000, y: 9000 }),
      n1: geometry({ width: 1200, height: 600 }),
      n2: geometry({ width: 400, height: 1050 }),
      n3: geometry({ width: 350, height: 700 }),
      n4: geometry({ width: 800, height: 160 }),
      n5: geometry({ width: 1300, height: 150 }),
      n6: geometry({ width: 240, height: 450 }),
    };
    const beforeGraph = structuredClone(tree);
    const beforeGeometry = structuredClone(current);
    const { nodes, pinnedConflicts } = formatLayout(tree, current);
    expectNoOverlap(nodes);
    expect(pinnedConflicts).toEqual([]);
    for (const [id, card] of Object.entries(nodes)) {
      expect(card.width).toBe(current[id as keyof typeof current].width);
      expect(card.height).toBe(current[id as keyof typeof current].height);
    }
    expect(nodes.n1.x - (nodes.n0.x + nodes.n0.width)).toBe(48);
    expect(nodes.n3.x - (nodes.n1.x + nodes.n1.width)).toBe(48);
    const centre = (id: string) => nodes[id].y + nodes[id].height / 2;
    expect(centre('n0')).toBe((centre('n1') + centre('n2')) / 2);
    expect(centre('n1')).toBe((centre('n3') + centre('n4')) / 2);
    expect(tree).toEqual(beforeGraph);
    expect(current).toEqual(beforeGeometry);
  });

  it('packs asymmetric sibling branches without collisions or excessive leaf spacing', () => {
    const tree = graph([null, 'n0', 'n0', 'n0', 'n1', 'n4', 'n2', 'n2', 'n3']);
    const current = Object.fromEntries(
      tree.nodes.map((node, index) => [
        node.id,
        geometry({ width: 240 + (index % 3) * 190, height: 150 + (index % 4) * 230 }),
      ]),
    );
    const { nodes } = formatLayout(tree, current);
    expectNoOverlap(nodes);
    // Unrelated branches share free space at deeper levels instead of reserving
    // the full height of every subtree at every column.
    expect(bounds(nodes).height).toBeLessThan(2500);
    expect(nodes.n1.y).toBeLessThan(nodes.n2.y);
    expect(nodes.n2.y).toBeLessThan(nodes.n3.y);
  });

  it('compacts a scattered 100-card, 99-edge tree and is deterministic and idempotent', () => {
    const tree = graph([
      null,
      ...Array.from({ length: 99 }, (_, index) => `n${Math.floor(index / 3)}`),
    ]);
    const current = Object.fromEntries(
      tree.nodes.map((node, index) => [
        node.id,
        geometry({
          x: index * 4000,
          y: (index % 11) * 5000,
          width: 240 + (index % 5) * 150,
          height: 150 + (index % 7) * 90,
        }),
      ]),
    );
    const formatted = formatLayout(tree, current);
    expect(Object.keys(formatted.nodes)).toHaveLength(100);
    expect(lineageEdges(tree.nodes)).toHaveLength(99);
    expectNoOverlap(formatted.nodes);
    const originalBounds = bounds(current);
    const formattedBounds = bounds(formatted.nodes);
    expect(formattedBounds.width).toBeLessThan(originalBounds.width / 10);
    expect(formattedBounds.height).toBeLessThan(originalBounds.height);
    expect(formatLayout(tree, formatted.nodes)).toEqual(formatted);
    expect(formatLayout({ ...tree, nodes: [...tree.nodes].reverse() }, current)).toEqual(formatted);
  });

  it('preserves pins exactly and avoids a wide pinned obstacle across multiple columns', () => {
    const tree = graph([null, 'n0', 'n0', 'n1', 'n1', 'n2', 'n2']);
    const current = {
      n0: geometry({ x: 5000, y: 6000, pinned: true }),
      n2: geometry({ x: 5348, y: 5800, width: 1000, height: 1000, pinned: true }),
      n3: geometry({ height: 650 }),
    };
    const result = formatLayout(tree, current);
    expect(result.nodes.n0).toEqual(current.n0);
    expect(result.nodes.n2).toEqual(current.n2);
    expect(result.nodes.n3.height).toBe(650);
    expect(result.pinnedConflicts).toEqual([]);
    expectNoOverlap(result.nodes);
    expect(formatLayout(tree, result.nodes)).toEqual(result);
  });

  it('reports every overlapping pinned card while keeping movable cards clear of them', () => {
    const tree = graph([null, 'n0', 'n0', 'n0', 'n1', 'n2']);
    const current = {
      n0: geometry({ x: 0, y: 0, pinned: true }),
      n1: geometry({ x: 100, y: 100, width: 800, height: 800, pinned: true }),
      n2: geometry({ x: 600, y: 200, pinned: true }),
    };
    const result = formatLayout(tree, current);
    expect(result.pinnedConflicts).toEqual(['n0', 'n1', 'n2']);
    for (const [id, card] of Object.entries(current)) expect(result.nodes[id]).toEqual(card);
    expectNoOverlap(result.nodes, true);
    expect(formatLayout(tree, result.nodes)).toEqual(result);
  });

  it('does not flag touching pinned edges as overlapping', () => {
    const result = formatLayout(graph([null, 'n0']), {
      n0: geometry({ pinned: true }),
      n1: geometry({ x: NODE_WIDTH, pinned: true }),
    });
    expect(result.pinnedConflicts).toEqual([]);
  });

  it('translates a 500-card wide chain into saveable coordinates without changing spacing or sizes', () => {
    const tree = graph([null, ...Array.from({ length: 499 }, (_, index) => `n${index}`)]);
    const current = Object.fromEntries(
      tree.nodes.map((node) => [node.id, geometry({ width: 2000, height: 2000 })]),
    );
    const before = structuredClone(current);
    const result = formatLayout(tree, current);
    expect(result.nodes.n0.x).toBeLessThan(0);
    expect(result.nodes.n499.x).toBe(1_000_000);
    for (const card of Object.values(result.nodes)) {
      expect(Math.abs(card.x)).toBeLessThanOrEqual(1_000_000);
      expect(Math.abs(card.y)).toBeLessThanOrEqual(1_000_000);
      expect(card.width).toBe(2000);
      expect(card.height).toBe(2000);
    }
    expectNoOverlap(result.nodes);
    expect(formatLayout(tree, result.nodes)).toEqual(result);
    expect(current).toEqual(before);
  });

  it('fails without changing input when a pin would force cards past the coordinate limit', () => {
    const tree = graph([null, 'n0']);
    const current = {
      n0: geometry({ x: 1_000_000, y: 400, pinned: true }),
      n1: geometry({ x: 200, y: 300, width: 600, height: 500 }),
    };
    const before = structuredClone(current);
    expect(() => formatLayout(tree, current)).toThrow(FormatLayoutError);
    expect(current).toEqual(before);
  });

  it('fails instead of clamping an unpinned layout that cannot fit within both coordinate bounds', () => {
    const tree = graph([null, ...Array.from({ length: 499 }, (_, index) => `n${index}`)]);
    const current = Object.fromEntries(
      tree.nodes.map((node) => [node.id, geometry({ width: 4096, height: 2000 })]),
    );
    const before = structuredClone(current);
    expect(() => formatLayout(tree, current)).toThrow(FormatLayoutError);
    expect(current).toEqual(before);
  });

  it('leaves reopened saved positions untouched and only formats when explicitly requested', () => {
    const tree = graph([null, 'n0', 'n0']);
    const saved: CanvasLayout = {
      schemaVersion: 1,
      investigationId: tree.investigationId,
      layoutRevision: 9,
      nodes: {
        n0: geometry({ x: 1200, y: 1600, width: 800, height: 650 }),
        n1: geometry({ x: 1200, y: 1600, width: 600, height: 500 }),
      },
    };
    const reopened = resolveLayout(tree, saved);
    expect(reopened.n0).toEqual(saved.nodes.n0);
    expect(reopened.n1).toEqual(saved.nodes.n1);
    expect(reopened.n2).toEqual(treeLayout(tree).n2);
    const explicit = resolveLayout(tree, saved, { autoLayout: true });
    expect(explicit).toEqual(formatLayout(tree, saved.nodes).nodes);
    expect(explicit.n0.width).toBe(800);
    expect(explicit.n1.height).toBe(500);
    expectNoOverlap(explicit);
  });
});
