import { object, strings } from '../../lib/teamContract';
import { dashboardVariable } from '../../lib/dashboardsContract';
import { createUlid } from '../../lib/ids';
import type { Dashboard, DashboardRequest, DashboardTile } from '../../lib/types';
import { record, resolvedLayouts } from './tiles';
/** The classic portable export deliberately omits server metadata, title and timeRange. */
export function exportDashboard(dashboard: Dashboard) {
  return structuredClone({
    tags: dashboard.tags ?? [],
    variables: dashboard.variables ?? [],
    sections: dashboard.sections ?? [],
    tiles: (dashboard.tiles ?? []).map(({ tile_id: _id, ...tile }) => tile),
  });
}
export function importDashboard(json: string, title: string): DashboardRequest {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error('Invalid JSON format. Please check your input.');
  }
  if (!object(value) || !Array.isArray(value.tiles) || !value.tiles.every(object))
    throw new Error('A dashboard must contain a tiles array (which may be empty).');
  if (value.tags != null && !strings(value.tags))
    throw new Error('Tags must be an array of strings.');
  if (value.sections != null && !Array.isArray(value.sections))
    throw new Error('Sections must be an array.');
  if (
    value.variables != null &&
    (!Array.isArray(value.variables) ||
      !value.variables.every(
        (variable) =>
          object(variable) &&
          (!['promql', 'promql_query', 'sql', 'list', 'text', 'dataset'].includes(
            String(variable.type),
          ) ||
            dashboardVariable(variable)),
      ))
  )
    throw new Error('Invalid dashboard variables.');
  if (!title.trim()) throw new Error('Enter a dashboard title.');
  const body = structuredClone(value);
  for (const key of ['dashboardId', 'author', 'created', 'modified']) delete body[key];
  const tiles: DashboardTile[] = value.tiles.map((tile) => ({
    ...structuredClone(tile),
    tile_id: createUlid(),
  }));
  const layouts = new Map(resolvedLayouts(tiles).map(({ tile, layout }) => [tile.tile_id, layout]));
  return {
    ...body,
    title: title.trim(),
    tags: value.tags ?? [],
    variables: value.variables ?? [],
    sections: value.sections ?? [],
    isFavorite: false,
    tiles: tiles.map((tile) => ({
      ...tile,
      layout: { ...record(tile.layout), ...layouts.get(tile.tile_id)! },
    })),
  } as DashboardRequest;
}
export function downloadDashboard(dashboard: Dashboard) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(exportDashboard(dashboard), null, 2)], { type: 'application/json' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = `${dashboard.title.replace(/[\\/\0]/g, '_')}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
