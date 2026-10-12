import { expect, it } from 'vitest';
import { addSection, moveSection, patchSection, removeSection } from './sections';
import { applyTile } from './draft';
import type { Dashboard } from '../../lib/types';

const dashboard: Dashboard = {
  dashboardId: 'dashboard',
  title: 'Dashboard',
  extra: { preserved: true },
  sections: [
    { sectionId: 'a', title: 'Alpha', future: 9 },
    { opaque: true },
    { sectionId: 'b', title: 'Beta' },
  ],
  tiles: [
    { tile_id: 'root', layout: { x: 0, y: 0, w: 12, h: 4 } },
    { tile_id: 'one', sectionId: 'a', layout: { x: 0, y: 0, w: 6, h: 4, future: true } },
    { tile_id: 'two', sectionId: 'b', layout: { x: 0, y: 0, w: 6, h: 4 } },
  ],
};
it('creates unique sections and preserves unknown definitions and document extras', () => {
  const next = addSection(addSection(dashboard, ' New '), 'New');
  const sections = next.sections as Array<Record<string, unknown>>;
  expect(sections.slice(0, 3)).toEqual(dashboard.sections);
  expect(sections[3]).toMatchObject({ title: 'New', collapsed: false });
  expect(sections[3].sectionId).not.toEqual(sections[4].sectionId);
  expect(next.extra).toEqual(dashboard.extra);
  expect(addSection(dashboard, '  ')).toBe(dashboard);
});
it('renames, collapses and reorders without rebuilding section metadata', () => {
  const next = moveSection(
    patchSection(dashboard, 'a', { title: 'Renamed', collapsed: true }),
    'a',
    1,
  );
  expect(next.sections).toEqual([
    { sectionId: 'b', title: 'Beta' },
    { opaque: true },
    { sectionId: 'a', title: 'Renamed', collapsed: true, future: 9 },
  ]);
  expect(next.tiles).toBe(dashboard.tiles);
  expect(moveSection(dashboard, 'a', -1)).toBe(dashboard);
});
it('deleting a section preserves every tile and appends its tiles below the unsectioned tiles', () => {
  const before = structuredClone(dashboard);
  const next = removeSection(dashboard, 'a');
  expect(next.sections).toEqual([{ opaque: true }, { sectionId: 'b', title: 'Beta' }]);
  expect(next.tiles).toHaveLength(3);
  expect(next.tiles![1]).toMatchObject({
    tile_id: 'one',
    sectionId: '',
    layout: { y: 4, w: 6, h: 4, future: true },
  });
  expect(next.tiles![2]).toBe(dashboard.tiles![2]);
  expect(dashboard).toEqual(before);
});
it('moving a tile in the editor appends to its destination without overlap', () => {
  const next = applyTile(dashboard, { ...dashboard.tiles![1], sectionId: 'b' });
  expect(next.tiles![1]).toMatchObject({ sectionId: 'b', layout: { x: 0, y: 4, future: true } });
  expect(next.tiles![0]).toBe(dashboard.tiles![0]);
  expect(next.tiles![2]).toBe(dashboard.tiles![2]);
});
it('unsectioned normalization does not move a tile during a title edit', () => {
  const source = removeSection(dashboard, 'a');
  const tile = source.tiles![1];
  const next = applyTile(source, { ...tile, sectionId: undefined, title: 'Renamed' });
  expect(next.tiles![1].layout).toEqual(tile.layout);
});
it('section deletion appends below imported heights without clipping their stored size', () => {
  const source = {
    ...dashboard,
    tiles: dashboard.tiles!.map((tile, i) =>
      i === 0 ? { ...tile, layout: { x: 0, y: 0, w: 12, h: 50 } } : tile,
    ),
  };
  expect(removeSection(source, 'a').tiles![1].layout).toMatchObject({ y: 50 });
});
