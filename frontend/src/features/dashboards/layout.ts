import type { DashboardTile } from '../../lib/types';
import { object } from '../../lib/guards';

const record = (value: unknown) => (object(value) ? value : {});
export type TileLayout = { x: number; y: number; w: number; h: number };
type Positioned = { tile: DashboardTile; layout: TileLayout };
const integer = (value: unknown, fallback: number, min: number, max: number) =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.floor(value)))
    : fallback;

/** Sizes are clamped for display only; writes patch coordinates, never stored w/h.
 * Writes pass maxH = Infinity so saved rows never overlap a stored height above 24. */
export function resolvedLayouts(tiles: DashboardTile[], maxH = 24): Positioned[] {
  let bottom = tiles.reduce((end, tile) => {
    const layout = record(tile.layout);
    return typeof layout.y === 'number' && Number.isFinite(layout.y)
      ? Math.max(end, integer(layout.y, 0, 0, 100000) + integer(layout.h, 4, 1, maxH))
      : end;
  }, 0);
  return tiles
    .map((tile) => {
      const stored = record(tile.layout),
        w = integer(stored.w, 6, 1, 12),
        h = integer(stored.h, 4, 1, maxH);
      const append = !(typeof stored.y === 'number' && Number.isFinite(stored.y));
      const y = append ? bottom : integer(stored.y, 0, 0, 100000);
      if (append) bottom += h;
      return { tile, layout: { x: integer(stored.x, 0, 0, 12 - w), y, w, h } };
    })
    .sort((a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x);
}

/** Classic places absent and unknown section ids in the first grid. */
export function sectionGroups(tiles: DashboardTile[], sections: unknown) {
  const seen = new Set<string>();
  const groups = (Array.isArray(sections) ? sections : [])
    .filter(object)
    .filter((section) => {
      if (
        typeof section.sectionId !== 'string' ||
        !section.sectionId ||
        seen.has(section.sectionId)
      )
        return false;
      seen.add(section.sectionId);
      return true;
    })
    .map((section) => ({
      id: String(section.sectionId),
      title: typeof section.title === 'string' ? section.title : 'Untitled section',
      tiles: [] as DashboardTile[],
    }));
  const unsectioned = { id: '', title: '', tiles: [] as DashboardTile[] };
  for (const tile of tiles)
    (groups.find((group) => group.id === tile.sectionId) ?? unsectioned).tiles.push(tile);
  return [unsectioned, ...groups];
}

export function appendLayout(tiles: DashboardTile[], w = 6, h = 4): TileLayout {
  return {
    x: 0,
    y: resolvedLayouts(tiles, Infinity).reduce(
      (end, row) => Math.max(end, row.layout.y + row.layout.h),
      0,
    ),
    w,
    h,
  };
}
const overlaps = (a: TileLayout, b: TileLayout) =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

/** RGL vertical compaction: retain columns and reading order, push collisions down,
 * then raise each item until it touches a blocker. This also closes deletion gaps. */
export function compactLayouts(tiles: DashboardTile[], maxH = 24): Positioned[] {
  const placed: Positioned[] = [];
  for (const row of resolvedLayouts(tiles, maxH)) {
    const layout = { ...row.layout };
    let collision = placed.find((other) => overlaps(layout, other.layout));
    while (collision) {
      layout.y = collision.layout.y + collision.layout.h;
      collision = placed.find((other) => overlaps(layout, other.layout));
    }
    // The highest blocker below the current row is its lowest legal position.
    layout.y = placed.reduce(
      (y, other) =>
        other.layout.y + other.layout.h <= layout.y &&
        layout.x < other.layout.x + other.layout.w &&
        layout.x + layout.w > other.layout.x
          ? Math.max(y, other.layout.y + other.layout.h)
          : y,
      0,
    );
    placed.push({ tile: row.tile, layout });
  }
  return placed.sort((a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x);
}
function writePositions(tiles: DashboardTile[], positions: Positioned[]) {
  const layouts = new Map(positions.map((row) => [row.tile.tile_id, row.layout]));
  return tiles.map((tile) => {
    const position = layouts.get(tile.tile_id),
      stored = record(tile.layout);
    // Compaction changes rows, not columns. Preserve even out-of-bounds stored x;
    // its display clamp must not become an unrelated document edit.
    return !position || stored.y === position.y
      ? tile
      : { ...tile, layout: { ...stored, y: position.y } };
  });
}
export function compactSection(tiles: DashboardTile[], id: string, sections?: unknown) {
  const group = sectionGroups(tiles, sections).find((group) =>
    group.tiles.some((tile) => tile.tile_id === id),
  );
  return group ? writePositions(tiles, compactLayouts(group.tiles, Infinity)) : tiles;
}
/** Swaps with the reading-order neighbour. When compaction would restore the old order
 * (unequal widths), the tile that must come later is placed beneath the other instead. */
export function moveTile(
  tiles: DashboardTile[],
  id: string,
  direction: -1 | 1,
  sections?: unknown,
): DashboardTile[] {
  const section = (rows: DashboardTile[]) =>
    sectionGroups(rows, sections).find((group) => group.tiles.some((tile) => tile.tile_id === id))
      ?.tiles ?? [];
  const order = (rows: DashboardTile[]) =>
    compactLayouts(section(rows)).map((row) => row.tile.tile_id);
  const ids = order(tiles),
    index = ids.indexOf(id),
    neighbour = ids[index + direction];
  if (index < 0 || !neighbour) return tiles;
  const [first, second] = direction > 0 ? [id, neighbour] : [neighbour, id];
  const compacted = compactLayouts(section(tiles), Infinity),
    base = writePositions(tiles, compacted);
  const at = (tileId: string) => compacted.find((row) => row.tile.tile_id === tileId)!.layout;
  const place = (targets: Map<string, TileLayout>) =>
    compactSection(
      base.map((tile) => {
        const target = targets.get(tile.tile_id);
        if (!target) return tile;
        const w = resolvedLayouts([tile])[0].layout.w;
        return {
          ...tile,
          layout: { ...record(tile.layout), x: Math.min(target.x, 12 - w), y: target.y },
        };
      }),
      id,
      sections,
    );
  const swapped = place(
    new Map([
      [first, at(second)],
      [second, at(first)],
    ]),
  );
  const next = order(swapped);
  if (next.indexOf(first) > next.indexOf(second)) return swapped;
  const below = at(second);
  return place(new Map([[first, { ...below, y: below.y + below.h }]]));
}

/** Apply an explicit drag/resize inside one section. The edited tile takes priority
 * at its destination; collisions move down, preserving every other tile's fields. */
export function updateTileLayout(
  tiles: DashboardTile[],
  id: string,
  edits: Partial<TileLayout>,
): DashboardTile[] {
  const rows = compactLayouts(tiles, Infinity);
  const active = rows.find((row) => row.tile.tile_id === id);
  if (!active) return tiles;
  const w = integer(edits.w, active.layout.w, 1, 12);
  const target = {
    x: integer(edits.x, Math.min(active.layout.x, 12 - w), 0, 12 - w),
    y: integer(edits.y, active.layout.y, 0, 100000),
    w,
    h: integer(edits.h, active.layout.h, 1, Infinity),
  };
  // A zero-distance gesture must not normalize an imported document.
  if (
    Object.keys(edits).every(
      (key) => target[key as keyof TileLayout] === active.layout[key as keyof TileLayout],
    )
  )
    return tiles;
  const placed: Positioned[] = [{ tile: active.tile, layout: target }];
  for (const row of compactLayouts(
    tiles.filter((tile) => tile.tile_id !== id),
    Infinity,
  )) {
    const layout = { ...row.layout };
    let collision = placed.find((other) => overlaps(layout, other.layout));
    while (collision) {
      layout.y = collision.layout.y + collision.layout.h;
      collision = placed.find((other) => overlaps(layout, other.layout));
    }
    placed.push({ tile: row.tile, layout });
  }
  // Vertical compaction closes the gap left by a moved tile.
  const normalized = compactLayouts(
    placed.map(({ tile, layout }) => ({ ...tile, layout })),
    Infinity,
  );
  const positions = new Map(normalized.map(({ tile, layout }) => [tile.tile_id, layout]));
  return tiles.map((tile) => {
    const position = positions.get(tile.tile_id)!;
    const stored = record(tile.layout);
    if (tile.tile_id !== id)
      return stored.y === position.y ? tile : { ...tile, layout: { ...stored, y: position.y } };
    const patch: Record<string, number> = { y: position.y };
    if (edits.x !== undefined || (edits.w !== undefined && target.x !== active.layout.x))
      patch.x = position.x;
    if (edits.w !== undefined) patch.w = position.w;
    if (edits.h !== undefined) patch.h = position.h;
    return { ...tile, layout: { ...stored, ...patch } };
  });
}
