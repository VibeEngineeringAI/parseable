import { createUlid } from '../../lib/ids';
import type { Dashboard, DashboardTile, DashboardVariable, TimeRange } from '../../lib/types';
import { appendLayout, compactSection, sectionGroups } from './layout';
import { record, tileTitle } from './tiles';
import { classicTimeRange } from './timeRange';

export function loadDraft(original: Dashboard) {
  const seen = new Set<string>();
  let repaired = 0;
  const tiles = original.tiles?.map((tile) => {
    if (tile.tile_id === '00000000000000000000000000' || seen.has(tile.tile_id)) {
      repaired++;
      let id: string;
      do {
        id = createUlid();
      } while (seen.has(id) || original.tiles?.some((tile) => tile.tile_id === id));
      seen.add(id);
      return { ...tile, tile_id: id };
    }
    seen.add(tile.tile_id);
    return tile;
  });
  return { draft: repaired ? { ...original, tiles } : original, repaired };
}
/** This is the full document passed to PUT; sections and extras are never rebuilt. */
export function dashboardPayload(
  draft: Dashboard,
  range: TimeRange,
  rangeDirty: boolean,
): Dashboard {
  return {
    ...draft,
    ...(rangeDirty || draft.timeRange == null
      ? { timeRange: classicTimeRange(range, draft.timeRange) }
      : {}),
  };
}
export function applyTile(draft: Dashboard, tile: DashboardTile): Dashboard {
  const original = draft.tiles?.find((row) => row.tile_id === tile.tile_id);
  const tiles = original
    ? (draft.tiles ?? []).map((row) => (row.tile_id === tile.tile_id ? tile : row))
    : [...(draft.tiles ?? []), tile];
  const resized = original && JSON.stringify(original.layout) !== JSON.stringify(tile.layout);
  return {
    ...draft,
    tiles: resized || !original ? compactSection(tiles, tile.tile_id, draft.sections) : tiles,
  };
}
export function removeTile(draft: Dashboard, tile: DashboardTile): Dashboard {
  const group = sectionGroups(draft.tiles ?? [], draft.sections).find((group) =>
    group.tiles.some((row) => row.tile_id === tile.tile_id),
  );
  const tiles = (draft.tiles ?? []).filter((row) => row.tile_id !== tile.tile_id);
  const neighbour = group?.tiles.find((row) => row.tile_id !== tile.tile_id);
  return {
    ...draft,
    tiles: neighbour ? compactSection(tiles, neighbour.tile_id, draft.sections) : tiles,
  };
}
export function duplicateTile(draft: Dashboard, tile: DashboardTile): Dashboard {
  const group = sectionGroups(draft.tiles ?? [], draft.sections).find((group) =>
    group.tiles.some((row) => row.tile_id === tile.tile_id),
  );
  const copy = {
    ...structuredClone(tile),
    tile_id: createUlid(),
    title: `${tileTitle(tile)} (Copy)`,
    layout: {
      ...record(tile.layout),
      ...appendLayout(group?.tiles ?? []),
      w: record(tile.layout).w ?? 6,
      h: record(tile.layout).h ?? 4,
    },
  };
  return applyTile(draft, copy);
}
export function applyVariable(
  draft: Dashboard,
  variable: DashboardVariable,
  original?: DashboardVariable,
): Dashboard {
  const variables = Array.isArray(draft.variables) ? draft.variables : [];
  return {
    ...draft,
    variables: original
      ? variables.map((row) => (record(row).name === original.name ? variable : row))
      : [...variables, variable],
  };
}
