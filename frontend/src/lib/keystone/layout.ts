import { childrenIndex } from './graph';
import type { CanvasLayout, GraphNode, InvestigationGraph, NodeGeometry } from './types';

export const NODE_WIDTH = 300;
export const NODE_HEIGHT = 188;
export const MIN_NODE_WIDTH = 240;
export const MIN_NODE_HEIGHT = 150;
const COLUMN_GAP = 96;
const ROW_GAP = 32;
const FORMAT_COLUMN_GAP = 48;
const FORMAT_ROW_GAP = 24;
const MAX_COORDINATE = 1_000_000;

export class FormatLayoutError extends Error {
  constructor() {
    super(
      'Formatting cannot fit within canvas limits. Move pinned cards inward or use smaller cards.',
    );
    this.name = 'FormatLayoutError';
  }
}

export interface FormattedLayout {
  nodes: Record<string, NodeGeometry>;
  /** Cards that overlap another pinned card; these cannot be moved by formatting. */
  pinnedConflicts: string[];
}

function overlaps(a: NodeGeometry, b: NodeGeometry): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/**
 * Explicit, size-aware formatting. Subtree contours pack sibling branches while
 * keeping parents centred on their children. Columns account for the widest card
 * at each depth. Only sizes and pins influence the result, so formatting twice is
 * stable even when the input starts with manually scattered cards.
 *
 * The first pin in reading order anchors the tree. Pins then act as obstacles:
 * movable cards use the closest free vertical position in their column. Conflicts
 * between pins are reported without changing either card or its pinned state.
 */
export function formatLayout(
  graph: InvestigationGraph,
  currentGeometry: Readonly<Record<string, NodeGeometry>>,
): FormattedLayout {
  const children = childrenIndex(graph.nodes);
  const root = graph.nodes.find((node) => node.id === graph.rootNodeId);
  if (!root) return { nodes: {}, pinnedConflicts: [] };
  const geometry: Record<string, NodeGeometry> = {};
  for (const node of graph.nodes) {
    const current = currentGeometry[node.id];
    geometry[node.id] = current
      ? { ...current }
      : { x: 0, y: 0, width: NODE_WIDTH, height: NODE_HEIGHT, pinned: false };
  }

  interface Subtree {
    positions: Map<string, { depth: number; y: number }>;
    top: number[];
    bottom: number[];
  }

  const pack = (node: GraphNode): Subtree => {
    const positions = new Map<string, { depth: number; y: number }>();
    const top: number[] = [];
    const bottom: number[] = [];
    const childCentres: number[] = [];
    for (const child of children.get(node.id) ?? []) {
      const subtree = pack(child);
      let offset = 0;
      for (let depth = 0; depth < subtree.top.length; depth += 1)
        if (bottom[depth] !== undefined)
          offset = Math.max(offset, bottom[depth] + FORMAT_ROW_GAP - subtree.top[depth]);
      for (const [id, position] of subtree.positions)
        positions.set(id, { depth: position.depth + 1, y: position.y + offset });
      childCentres.push(
        subtree.positions.get(child.id)!.y + offset + geometry[child.id].height / 2,
      );
      for (let depth = 0; depth < subtree.top.length; depth += 1) {
        top[depth] = Math.min(top[depth] ?? Infinity, subtree.top[depth] + offset);
        bottom[depth] = Math.max(bottom[depth] ?? -Infinity, subtree.bottom[depth] + offset);
      }
    }
    const height = geometry[node.id].height;
    const y = childCentres.length
      ? (childCentres[0] + childCentres[childCentres.length - 1]) / 2 - height / 2
      : 0;
    // A tall parent may extend above its children. Keep every subtree normalised
    // so its contours can be merged without depending on its previous location.
    const shift = Math.max(0, -y);
    for (const position of positions.values()) position.y += shift;
    positions.set(node.id, { depth: 0, y: y + shift });
    return {
      positions,
      top: [y + shift, ...top.map((value) => value + shift)],
      bottom: [y + shift + height, ...bottom.map((value) => value + shift)],
    };
  };

  const packed = pack(root);
  const widths: number[] = [];
  for (const [id, position] of packed.positions)
    widths[position.depth] = Math.max(widths[position.depth] ?? 0, geometry[id].width);
  const columns = [0];
  for (let depth = 1; depth < widths.length; depth += 1)
    columns[depth] = columns[depth - 1] + widths[depth - 1] + FORMAT_COLUMN_GAP;

  const order: GraphNode[] = [];
  const visit = (node: GraphNode) => {
    order.push(node);
    for (const child of children.get(node.id) ?? []) visit(child);
  };
  visit(root);
  const pins = order.filter((node) => geometry[node.id].pinned);
  const anchor = pins[0];
  const anchorPosition = anchor && packed.positions.get(anchor.id)!;
  const offsetX = anchor ? geometry[anchor.id].x - columns[anchorPosition!.depth] : 0;
  const offsetY = anchor ? geometry[anchor.id].y - anchorPosition!.y : 0;
  const nodes: Record<string, NodeGeometry> = {};
  const obstacles: NodeGeometry[] = [];
  for (const pin of pins) {
    nodes[pin.id] = { ...geometry[pin.id] };
    obstacles.push(nodes[pin.id]);
  }
  const conflicts = new Set<string>();
  for (let left = 0; left < pins.length; left += 1)
    for (let right = left + 1; right < pins.length; right += 1)
      if (overlaps(nodes[pins[left].id], nodes[pins[right].id])) {
        conflicts.add(pins[left].id);
        conflicts.add(pins[right].id);
      }

  for (const node of order) {
    if (geometry[node.id].pinned) continue;
    const position = packed.positions.get(node.id)!;
    const card = {
      ...geometry[node.id],
      x: columns[position.depth] + offsetX,
      y: position.y + offsetY,
    };
    // Each horizontally intersecting obstacle excludes an interval of top-edge
    // positions. Searching the interval boundaries finds the nearest free slot,
    // including slots above the tree, without repeatedly shoving cards downward.
    const blocked = obstacles
      .filter(
        (obstacle) => card.x < obstacle.x + obstacle.width && card.x + card.width > obstacle.x,
      )
      .map((obstacle) => ({
        start: obstacle.y - card.height - FORMAT_ROW_GAP,
        end: obstacle.y + obstacle.height + FORMAT_ROW_GAP,
      }))
      .sort((a, b) => a.start - b.start || a.end - b.end);
    const merged: typeof blocked = [];
    for (const interval of blocked) {
      const previous = merged[merged.length - 1];
      if (previous && interval.start < previous.end)
        previous.end = Math.max(previous.end, interval.end);
      else merged.push({ ...interval });
    }
    const collision = merged.find((interval) => card.y > interval.start && card.y < interval.end);
    if (collision)
      card.y = card.y - collision.start < collision.end - card.y ? collision.start : collision.end;
    nodes[node.id] = card;
    obstacles.push(card);
  }
  const cards = Object.values(nodes);
  if (cards.some((card) => !Number.isFinite(card.x) || !Number.isFinite(card.y)))
    throw new FormatLayoutError();
  for (const axis of ['x', 'y'] as const) {
    const minimum = Math.min(...cards.map((card) => card[axis]));
    const maximum = Math.max(...cards.map((card) => card[axis]));
    if (minimum >= -MAX_COORDINATE && maximum <= MAX_COORDINATE) continue;
    const minimumShift = -MAX_COORDINATE - minimum;
    const maximumShift = MAX_COORDINATE - maximum;
    // A translation can bring large unpinned trees into the persisted coordinate
    // range without changing spacing. Pins forbid translating the entire tree;
    // clamping individual cards would recreate collisions, so fail atomically.
    if (pins.length || minimumShift > maximumShift) throw new FormatLayoutError();
    const shift = Math.max(minimumShift, Math.min(0, maximumShift));
    for (const card of cards) card[axis] += shift;
  }
  return { nodes, pinnedConflicts: [...conflicts].sort() };
}

/**
 * Deterministic left-to-right tree layout. Leaves take consecutive rows in reading
 * order; each parent is centred on its children. The same graph always yields the
 * same positions, without measuring the DOM or calling any service.
 */
export function treeLayout(graph: InvestigationGraph): Record<string, NodeGeometry> {
  const children = childrenIndex(graph.nodes);
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const positions: Record<string, NodeGeometry> = {};
  let row = 0;
  const place = (node: GraphNode, depth: number): number => {
    const kids = children.get(node.id) ?? [];
    let y: number;
    if (kids.length === 0) {
      y = row * (NODE_HEIGHT + ROW_GAP);
      row += 1;
    } else {
      const ys = kids.map((child) => place(child, depth + 1));
      y = (ys[0] + ys[ys.length - 1]) / 2;
    }
    positions[node.id] = {
      x: depth * (NODE_WIDTH + COLUMN_GAP),
      y,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      pinned: false,
    };
    return y;
  };
  // Decoded graphs are acyclic and bounded, so recursion depth ≤ MAX_GRAPH_NODES.
  const root = byId.get(graph.rootNodeId);
  if (root) place(root, 0);
  return positions;
}

/**
 * Saved geometry wins for known nodes; new nodes get their computed position.
 * Explicit auto layout uses current sizes and keeps deliberately pinned cards put.
 */
export function resolveLayout(
  graph: InvestigationGraph,
  saved: CanvasLayout | null,
  { autoLayout = false }: { autoLayout?: boolean } = {},
): Record<string, NodeGeometry> {
  if (autoLayout) return formatLayout(graph, saved?.nodes ?? {}).nodes;
  const computed = treeLayout(graph);
  const resolved: Record<string, NodeGeometry> = {};
  for (const node of graph.nodes) {
    const stored = saved?.nodes[node.id];
    if (stored) resolved[node.id] = stored;
    else resolved[node.id] = { ...computed[node.id] };
  }
  return resolved;
}

/** Geometry entries that differ from the saved revision, for a minimal PATCH. */
export function layoutDelta(
  saved: Record<string, NodeGeometry>,
  next: Record<string, NodeGeometry>,
): Record<string, NodeGeometry> {
  const delta: Record<string, NodeGeometry> = {};
  for (const [id, geometry] of Object.entries(next)) {
    const before = saved[id];
    if (
      !before ||
      before.x !== geometry.x ||
      before.y !== geometry.y ||
      before.width !== geometry.width ||
      before.height !== geometry.height ||
      before.pinned !== geometry.pinned
    )
      delta[id] = geometry;
  }
  return delta;
}
