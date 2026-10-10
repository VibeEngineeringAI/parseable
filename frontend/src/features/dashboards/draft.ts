import { dashboardVariable } from '../../lib/dashboardsContract';
import { strings } from '../../lib/guards';
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
const storedVariables = (draft: Dashboard): unknown[] =>
  Array.isArray(draft.variables) ? draft.variables : [];
/** Every stored name, including definitions the editor cannot read; new names must avoid them. */
export const variableNames = (draft: Dashboard): string[] =>
  storedVariables(draft)
    .map((row) => record(row).name)
    .filter((name): name is string => typeof name === 'string');
// Edits target one readable row so hidden definitions sharing its name survive.
const variableIndex = (variables: unknown[], name: string) =>
  variables.findIndex((row) => dashboardVariable(row) && row.name === name);
const renameTokens = (value: string, from: string, to: string) =>
  value.replace(/\$(\{?)(\w+)(\}?)/g, (token, open: string, name: string, close: string) =>
    name === from ? `$${open}${to}${close}` : token,
  );
const renameIn = (value: unknown, from: string, to: string) =>
  typeof value === 'string'
    ? renameTokens(value, from, to)
    : strings(value)
      ? value.map((row) => renameTokens(row, from, to))
      : value;
const variableSources = ['sqlQuery', 'promqlQuery', 'promqlQueryDataset', 'dataset'] as const;
/** Rewrites $from and ${from} in tile queries, datasets and other variables' sources. */
function renameReferences(draft: Dashboard, index: number, from: string, to: string): Dashboard {
  const variables = storedVariables(draft);
  if (variables.some((row, i) => i !== index && record(row).name === from)) return draft;
  return {
    ...draft,
    tiles: draft.tiles?.map((tile) => {
      const next = { ...tile };
      for (const field of ['chartQuery', 'dbName'])
        if (field in tile) next[field] = renameIn(tile[field], from, to);
      return JSON.stringify(next) === JSON.stringify(tile) ? tile : next;
    }),
    variables: variables.map((row, i) => {
      if (i === index || !dashboardVariable(row)) return row;
      const next: DashboardVariable = { ...row };
      for (const field of variableSources)
        if (typeof row[field] === 'string') next[field] = renameTokens(row[field], from, to);
      if (row.labelFilters)
        next.labelFilters = row.labelFilters.map((filter) => ({
          ...filter,
          value: renameTokens(filter.value, from, to),
        }));
      return JSON.stringify(next) === JSON.stringify(row) ? row : next;
    }),
  };
}
export function applyVariable(
  draft: Dashboard,
  variable: DashboardVariable,
  original?: DashboardVariable,
): Dashboard {
  const variables = storedVariables(draft);
  const index = original ? variableIndex(variables, original.name) : -1;
  if (index < 0) return { ...draft, variables: [...variables, variable] };
  const next = {
    ...draft,
    variables: variables.map((row, i) => (i === index ? variable : row)),
  };
  return original && original.name !== variable.name
    ? renameReferences(next, index, original.name, variable.name)
    : next;
}
export function removeVariable(draft: Dashboard, variable: DashboardVariable): Dashboard {
  const variables = storedVariables(draft);
  const index = variableIndex(variables, variable.name);
  return index < 0 ? draft : { ...draft, variables: variables.filter((_, i) => i !== index) };
}
