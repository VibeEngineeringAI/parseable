import type { Dashboard } from '../../lib/types';
import { createUlid } from '../../lib/ids';
import { object } from '../../lib/guards';
import { appendLayout, compactSection, sectionGroups } from './layout';
import { record } from './tiles';

export function dashboardSections(sections: unknown) {
  const seen = new Set<string>();
  return (Array.isArray(sections) ? sections : [])
    .filter(object)
    .filter(
      (section): section is { sectionId: string; title?: unknown; [key: string]: unknown } =>
        typeof section.sectionId === 'string' && !!section.sectionId,
    )
    .filter((section) => {
      if (seen.has(section.sectionId)) return false;
      seen.add(section.sectionId);
      return true;
    });
}

export function addSection(draft: Dashboard, title: string): Dashboard {
  if (!title.trim()) return draft;
  return {
    ...draft,
    sections: [
      ...(Array.isArray(draft.sections) ? draft.sections : []),
      { sectionId: createUlid(), title: title.trim(), collapsed: false },
    ],
  };
}

export function patchSection(
  draft: Dashboard,
  id: string,
  patch: { title?: string; collapsed?: boolean },
): Dashboard {
  return {
    ...draft,
    sections: (Array.isArray(draft.sections) ? draft.sections : []).map((section) =>
      object(section) && section.sectionId === id ? { ...section, ...patch } : section,
    ),
  };
}

export function moveSection(draft: Dashboard, id: string, direction: -1 | 1): Dashboard {
  const sections = Array.isArray(draft.sections) ? [...draft.sections] : [];
  const visible = dashboardSections(sections);
  const neighbour = visible[visible.findIndex((section) => section.sectionId === id) + direction];
  if (!neighbour) return draft;
  const from = sections.findIndex((section) => object(section) && section.sectionId === id);
  if (from < 0) return draft;
  const to = sections.indexOf(neighbour);
  [sections[from], sections[to]] = [sections[to], sections[from]];
  return { ...draft, sections };
}

/** Deleting a container keeps its tiles, appending them to the unsectioned grid. */
export function removeSection(draft: Dashboard, id: string): Dashboard {
  const sections = (Array.isArray(draft.sections) ? draft.sections : []).filter(
    (section) => !object(section) || section.sectionId !== id,
  );
  const unsectioned = sectionGroups(draft.tiles ?? [], draft.sections)[0].tiles.slice();
  const tiles = (draft.tiles ?? []).map((tile) => {
    if (tile.sectionId !== id) return tile;
    const layout = record(tile.layout);
    const next = {
      ...tile,
      sectionId: '',
      layout: {
        ...layout,
        ...appendLayout(
          unsectioned,
          typeof layout.w === 'number' ? layout.w : 6,
          typeof layout.h === 'number' ? layout.h : 4,
        ),
      },
    };
    unsectioned.push(next);
    return next;
  });
  return { ...draft, sections, tiles };
}

export function relocateTile(draft: Dashboard, tileId: string, sectionId: unknown): Dashboard {
  const tile = draft.tiles?.find((tile) => tile.tile_id === tileId);
  if (!tile) return draft;
  const destination =
    sectionGroups(draft.tiles ?? [], draft.sections).find((group) => group.id === sectionId) ??
    sectionGroups(draft.tiles ?? [], draft.sections)[0];
  const peers = destination.tiles.filter((row) => row.tile_id !== tileId);
  const next = {
    ...tile,
    sectionId,
    layout: {
      ...record(tile.layout),
      ...appendLayout(peers),
      w: record(tile.layout).w ?? 6,
      h: record(tile.layout).h ?? 4,
    },
  };
  const tiles = draft.tiles!.map((row) => (row.tile_id === tileId ? next : row));
  return { ...draft, tiles: compactSection(tiles, tileId, draft.sections) };
}
