import type { DashboardTile } from '../../lib/types';
import { object } from '../../lib/guards';

const record = (value: unknown) => (object(value) ? value : {});
export type TileLayout = { x: number; y: number; w: number; h: number };
type Positioned = { tile: DashboardTile; layout: TileLayout };
const integer = (value: unknown, fallback: number, min: number, max: number) =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.floor(value)))
    : fallback;

/** Sizes are clamped for display only; writes patch coordinates, never stored w/h. */
export function resolvedLayouts(tiles: DashboardTile[]): Positioned[] {
  let bottom = tiles.reduce((end, tile) => {
    const layout = record(tile.layout);
    return typeof layout.y === 'number' && Number.isFinite(layout.y)
      ? Math.max(end, integer(layout.y, 0, 0, 100000) + integer(layout.h, 4, 1, 24))
      : end;
  }, 0);
  return tiles
    .map((tile) => {
      const stored = record(tile.layout),
        w = integer(stored.w, 6, 1, 12),
        h = integer(stored.h, 4, 1, 24);
      const append = !(typeof stored.y === 'number' && Number.isFinite(stored.y));
      const y = append ? bottom : integer(stored.y, 0, 0, 100000);
      if (append) bottom += h;
      return { tile, layout: { x: integer(stored.x, 0, 0, 12 - w), y, w, h } };
    })
    .sort((a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x);
}

/** Classic places absent and unknown section ids in the first grid. */
export function sectionGroups(tiles: DashboardTile[], sections: unknown) {
  const groups = (Array.isArray(sections) ? sections : [])
    .filter(object)
    .filter((section) => typeof section.sectionId === 'string')
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
    y: resolvedLayouts(tiles).reduce((end, row) => Math.max(end, row.layout.y + row.layout.h), 0),
    w,
    h,
  };
}
const overlaps = (a: TileLayout, b: TileLayout) =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

/** RGL vertical compaction: retain columns and reading order, push collisions down,
 * then raise each item until it touches a blocker. This also closes deletion gaps. */
export function compactLayouts(tiles: DashboardTile[]): Positioned[] {
  const placed: Positioned[] = [];
  for (const row of resolvedLayouts(tiles)) {
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
  return group ? writePositions(tiles, compactLayouts(group.tiles)) : tiles;
}
export function moveTile(
  tiles: DashboardTile[],
  id: string,
  direction: -1 | 1,
  sections?: unknown,
): DashboardTile[] {
  const group = sectionGroups(tiles, sections).find((group) =>
    group.tiles.some((tile) => tile.tile_id === id),
  );
  const ordered = compactLayouts(group?.tiles ?? []),
    index = ordered.findIndex((row) => row.tile.tile_id === id);
  const neighbour = ordered[index + direction],
    current = ordered[index];
  if (!current || !neighbour) return tiles;
  const swapped = writePositions(tiles, ordered).map((tile) => {
    const target =
      tile.tile_id === id
        ? neighbour
        : tile.tile_id === neighbour.tile.tile_id
          ? current
          : undefined;
    if (!target) return tile;
    const w = resolvedLayouts([tile])[0].layout.w;
    return {
      ...tile,
      layout: { ...record(tile.layout), x: Math.min(target.layout.x, 12 - w), y: target.layout.y },
    };
  });
  return compactSection(swapped, id, sections);
}
