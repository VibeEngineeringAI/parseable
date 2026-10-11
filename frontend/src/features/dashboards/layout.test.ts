import { expect, it } from 'vitest';
import { compactLayouts, compactSection, moveTile, sectionGroups } from './layout';
import { applyTile, removeTile } from './draft';
import classic from './__fixtures__/classic.json';
import type { DashboardTile } from '../../lib/types';
const tile = (tile_id: string, x: number, y: number, w: number, h: number): DashboardTile => ({
  tile_id,
  layout: { x, y, w, h, future: true },
});
const mixed = [
  tile('a', 0, 0, 6, 8),
  tile('b', 6, 0, 6, 4),
  tile('c', 6, 4, 6, 4),
  tile('d', 0, 8, 12, 4),
];
it('moves through compacted reading order when stored rows contain gaps', () => {
  const source = [tile('a', 0, 0, 6, 2), tile('b', 6, 10, 6, 2), tile('c', 0, 5, 6, 2)];
  const before = structuredClone(source);
  const order = (tiles: DashboardTile[]) => compactLayouts(tiles).map((row) => row.tile.tile_id);
  expect(order(source)).toEqual(['a', 'b', 'c']);
  expect(order(moveTile(source, 'b', -1))).toEqual(['b', 'a', 'c']);
  expect(order(moveTile(source, 'b', 1))).toEqual(['a', 'c', 'b']);
  expect(moveTile(source, 'a', -1)).toBe(source);
  expect(moveTile(source, 'c', 1)).toBe(source);
  expect(moveTile(moveTile(source, 'b', -1), 'b', 1).map((row) => row.layout)).toEqual([
    { ...(source[0].layout as object), y: 0 },
    { ...(source[1].layout as object), y: 0 },
    { ...(source[2].layout as object), y: 2 },
  ]);
  expect(source).toEqual(before);
});
it('swaps neighbours beside a tall tile without repacking unrelated columns', () => {
  const moved = moveTile(mixed, 'c', -1);
  expect(moved).toEqual([
    mixed[0],
    { ...mixed[1], layout: { ...(mixed[1].layout as object), x: 6, y: 4 } },
    { ...mixed[2], layout: { ...(mixed[2].layout as object), x: 6, y: 0 } },
    mixed[3],
  ]);
  expect(moveTile(moved, 'c', 1)).toEqual(mixed);
});
it('changes reading order when tiles of unequal widths would compact back into place', () => {
  const source = [tile('A', 4, 0, 4, 4), tile('B', 0, 4, 6, 4)];
  const order = (tiles: DashboardTile[]) => compactLayouts(tiles).map((row) => row.tile.tile_id);
  expect(order(source)).toEqual(['A', 'B']);
  for (const moved of [moveTile(source, 'A', 1), moveTile(source, 'B', -1)]) {
    expect(order(moved)).toEqual(['B', 'A']);
    expect(moved.map((row) => row.layout)).toEqual([
      { x: 0, y: 4, w: 4, h: 4, future: true },
      { x: 0, y: 0, w: 6, h: 4, future: true },
    ]);
    expect(order(moveTile(moved, 'A', -1))).toEqual(['A', 'B']);
    expect(order(moveTile(moved, 'B', 1))).toEqual(['A', 'B']);
  }
  const wide = [tile('A', 0, 0, 8, 4), tile('B', 8, 0, 4, 4), tile('C', 0, 4, 12, 4)];
  expect(order(moveTile(wide, 'A', 1))).toEqual(['B', 'A', 'C']);
  expect(order(moveTile(wide, 'B', -1))).toEqual(['B', 'A', 'C']);
});
it('resolves resize collisions and closes deletion gaps with mixed heights', () => {
  const dashboard = { ...classic, sections: [], tiles: mixed };
  const resized = applyTile(dashboard, { ...mixed[1], layout: { x: 6, y: 0, w: 6, h: 8 } });
  expect(resized.tiles!.map((tile) => (tile.layout as { y: number }).y)).toEqual([0, 0, 8, 12]);
  const removed = removeTile(dashboard, mixed[1]);
  expect(removed.tiles!.map((tile) => (tile.layout as { y: number }).y)).toEqual([0, 0, 8]);
  const widened = applyTile(dashboard, { ...mixed[1], layout: { x: 4, y: 0, w: 8, h: 4 } });
  const rows = compactLayouts(widened.tiles!);
  for (const a of rows)
    for (const b of rows)
      if (a !== b)
        expect(
          a.layout.x < b.layout.x + b.layout.w &&
            a.layout.x + a.layout.w > b.layout.x &&
            a.layout.y < b.layout.y + b.layout.h &&
            a.layout.y + a.layout.h > b.layout.y,
        ).toBe(false);
});
it('groups in classic section order and restricts compaction and moves to that section', () => {
  const sections = [
    { sectionId: 'b', title: 'DB', future: 1 },
    { sectionId: 'a', title: 'API' },
  ];
  const tiles = [
    tile('u', 0, 0, 12, 4),
    { ...tile('a1', 0, 0, 6, 4), sectionId: 'a' },
    { ...tile('b1', 0, 0, 6, 4), sectionId: 'b' },
    { ...tile('a2', 6, 0, 6, 4), sectionId: 'a' },
    { ...tile('orphan', 0, 4, 6, 4), sectionId: 'missing' },
  ];
  expect(
    sectionGroups(tiles, sections).map((group) => group.tiles.map((tile) => tile.tile_id)),
  ).toEqual([['u', 'orphan'], ['b1'], ['a1', 'a2']]);
  const moved = moveTile(tiles, 'a2', -1, sections);
  expect(moved[0]).toBe(tiles[0]);
  expect(moved[2]).toBe(tiles[2]);
  expect(moved[4]).toBe(tiles[4]);
  expect(moved[1].layout).toMatchObject({ x: 6, y: 0 });
  expect(sections).toEqual([
    { sectionId: 'b', title: 'DB', future: 1 },
    { sectionId: 'a', title: 'API' },
  ]);
});
it('never writes display-clamped widths or heights to untouched tiles', () => {
  const source = [tile('a', 0, 0, 6, 30), tile('b', 6, 0, 6, 4), tile('c', 6, 4, 6, 4)];
  const moved = moveTile(source, 'c', -1);
  expect(moved[0]).toBe(source[0]);
  expect(compactSection(source, 'b')[0].layout).toMatchObject({ h: 30, w: 6, future: true });
  const oversized = { ...source[0], layout: { x: 99, y: 0, w: 30, h: 30, future: true } };
  expect(compactSection([oversized, ...source.slice(1)], 'b')[0]).toBe(oversized);
});
