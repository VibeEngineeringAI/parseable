import type { NodeGeometry } from '../../lib/keystone/types';

/**
 * Presentation-only card state. `collapsed` is persisted with the layout revision
 * and never touches the semantic graph. `height` always keeps the expanded size, so
 * expanding restores exactly what the user last resized to.
 *
 * Contract note: `collapsed` is optional. It is only written once a card has been
 * toggled, so layouts from servers that predate the field round-trip unchanged.
 */
export type CardGeometry = NodeGeometry & { collapsed?: boolean };

/**
 * Reads saved geometry into the card model: `height` is the expanded size. A layout
 * that also records `expandedHeight` uses it as that size; it is not written back.
 */
export function fromStored(
  geometry: Readonly<Record<string, NodeGeometry>>,
): Record<string, CardGeometry> {
  const result: Record<string, CardGeometry> = {};
  for (const [id, { expandedHeight, ...item }] of Object.entries(geometry))
    result[id] = expandedHeight === undefined ? item : { ...item, height: expandedHeight };
  return result;
}

/** Height of a collapsed card: the header strip only. */
export const COLLAPSED_CARD_HEIGHT = 46;

export function isCollapsed(geometry: CardGeometry | undefined): boolean {
  return !!geometry?.collapsed;
}

/** The size the card occupies on the canvas right now. */
export function renderedHeight(geometry: CardGeometry): number {
  return geometry.collapsed ? COLLAPSED_CARD_HEIGHT : geometry.height;
}

/** Geometry as drawn: collapsed cards take their header height. */
export function effectiveGeometry(
  geometry: Readonly<Record<string, CardGeometry>>,
): Record<string, NodeGeometry> {
  const result: Record<string, NodeGeometry> = {};
  for (const [id, item] of Object.entries(geometry))
    result[id] = {
      x: item.x,
      y: item.y,
      width: item.width,
      height: renderedHeight(item),
      pinned: item.pinned,
    };
  return result;
}

/**
 * Maps formatter output, computed on drawn sizes, back onto stored geometry: the
 * expanded height and collapsed flag of every card are kept as they were.
 */
export function restoreStoredSize(
  formatted: Readonly<Record<string, NodeGeometry>>,
  stored: Readonly<Record<string, CardGeometry>>,
): Record<string, CardGeometry> {
  const result: Record<string, CardGeometry> = {};
  for (const [id, item] of Object.entries(formatted)) {
    const before = stored[id];
    result[id] =
      before && 'collapsed' in before
        ? { ...item, height: before.height, collapsed: before.collapsed }
        : { ...item, height: before?.height ?? item.height };
  }
  return result;
}

function overlaps(a: NodeGeometry, b: NodeGeometry) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/** Cards a just-expanded card now covers. Reported only; nothing is moved. */
export function expansionCollisions(
  id: string,
  geometry: Readonly<Record<string, CardGeometry>>,
): string[] {
  const card = geometry[id];
  if (!card) return [];
  const drawn = effectiveGeometry(geometry);
  return Object.keys(drawn)
    .filter((other) => other !== id && overlaps(drawn[id], drawn[other]))
    .sort();
}

/** Entries that differ from `saved`, including the collapsed flag. */
export function geometryDelta(
  saved: Readonly<Record<string, CardGeometry>>,
  next: Readonly<Record<string, CardGeometry>>,
): Record<string, CardGeometry> {
  const delta: Record<string, CardGeometry> = {};
  for (const [id, item] of Object.entries(next)) {
    const before = saved[id];
    if (
      !before ||
      before.x !== item.x ||
      before.y !== item.y ||
      before.width !== item.width ||
      before.height !== item.height ||
      before.pinned !== item.pinned ||
      !!before.collapsed !== !!item.collapsed
    )
      delta[id] = item;
  }
  return delta;
}
