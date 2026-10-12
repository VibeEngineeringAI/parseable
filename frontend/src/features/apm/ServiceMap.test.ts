import { describe, expect, it } from 'vitest';
import { layoutApmMap, APM_MAP_EDGE_LIMIT, APM_MAP_NODE_LIMIT } from './ServiceMap';
import type { ApmEdge } from '../../lib/apm';
const edge = (source: string, target: string, spanCount = 10): ApmEdge => ({
  source,
  target,
  spanCount,
  errorCount: 0,
  avgMs: 1,
});
describe('observed service map layout', () => {
  it('lays out parents before children and handles cycles deterministically', () => {
    const edges = [
      edge('gateway', 'checkout'),
      edge('checkout', 'inventory'),
      edge('inventory', 'checkout'),
    ];
    const first = layoutApmMap(edges);
    expect(first).toEqual(layoutApmMap([...edges].reverse()));
    expect(first.nodes.find((n) => n.name === 'gateway')!.x).toBeLessThan(
      first.nodes.find((n) => n.name === 'checkout')!.x,
    );
    expect(first.nodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y))).toBe(
      true,
    );
    expect(first.edges).toHaveLength(3);
  });
  it('caps complexity without inventing relationships', () => {
    const edges = Array.from({ length: 80 }, (_, i) =>
        edge(`service-${i}`, `service-${i + 1}`, 80 - i),
      ),
      graph = layoutApmMap(edges);
    expect(graph.nodes.length).toBeLessThanOrEqual(APM_MAP_NODE_LIMIT);
    expect(graph.edges.length).toBeLessThanOrEqual(APM_MAP_EDGE_LIMIT);
    expect(graph.limited).toBe(true);
    expect(graph.edges.every((item) => edges.includes(item))).toBe(true);
  });
});
