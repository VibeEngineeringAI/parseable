import type { GraphEdge, GraphNode, InvestigationGraph } from './types';

/** Children sorted by creation time, then ID, so every traversal is deterministic. */
export function childrenIndex(nodes: readonly GraphNode[]) {
  const children = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    if (node.parentId === null) continue;
    const list = children.get(node.parentId) ?? [];
    list.push(node);
    children.set(node.parentId, list);
  }
  for (const list of children.values())
    list.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return children;
}

/** Lineage edges derived from parent links. There is no client path to author an edge. */
export function lineageEdges(nodes: readonly GraphNode[]): GraphEdge[] {
  return nodes
    .filter((node) => node.parentId !== null)
    .map((node) => ({
      id: `${node.parentId}->${node.id}`,
      source: node.parentId as string,
      target: node.id,
      intent: node.intent === 'explore' ? 'explore' : 'follow_up',
    }));
}

export interface BranchNeighbours {
  parent: GraphNode | null;
  children: GraphNode[];
  siblings: GraphNode[];
  index: number;
}

export function neighbours(graph: InvestigationGraph, nodeId: string): BranchNeighbours {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const children = childrenIndex(graph.nodes);
  const node = byId.get(nodeId);
  const parent = node?.parentId ? (byId.get(node.parentId) ?? null) : null;
  const siblings = parent ? (children.get(parent.id) ?? []) : node ? [node] : [];
  return {
    parent,
    children: children.get(nodeId) ?? [],
    siblings,
    index: siblings.findIndex((item) => item.id === nodeId),
  };
}

/** Depth-first order used for keyboard reading and search results. */
export function readingOrder(graph: InvestigationGraph): GraphNode[] {
  const children = childrenIndex(graph.nodes);
  const root = graph.nodes.find((node) => node.id === graph.rootNodeId);
  const order: GraphNode[] = [];
  const stack = root ? [root] : [];
  while (stack.length) {
    const node = stack.pop() as GraphNode;
    order.push(node);
    stack.push(...[...(children.get(node.id) ?? [])].reverse());
  }
  return order;
}
