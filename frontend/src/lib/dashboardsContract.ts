import { object, strings } from './guards';
import type { Dashboard, DashboardSummary, DashboardTile, DashboardVariable } from './types';

export const ulid = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/i.test(value);
export const tile = (value: unknown): value is DashboardTile =>
  object(value) && ulid(value.tile_id);
const optionalString = (value: unknown) => value == null || typeof value === 'string';
export function dashboardSummary(value: unknown): value is DashboardSummary {
  return (
    object(value) &&
    ulid(value.dashboardId) &&
    typeof value.title === 'string' &&
    ['author', 'created', 'modified'].every((key) => optionalString(value[key])) &&
    (value.tags == null || strings(value.tags)) &&
    (value.isFavorite == null || typeof value.isFavorite === 'boolean')
  );
}
export function dashboard(value: unknown): value is Dashboard {
  return (
    dashboardSummary(value) &&
    (value.tiles == null || (Array.isArray(value.tiles) && value.tiles.every(tile)))
  );
}
// Recognizes definitions the variables UI can edit. Unknown types are skipped by
// readVariables; callers retain the full document unchanged for saving.
export function dashboardVariable(value: unknown): value is DashboardVariable {
  return (
    object(value) &&
    typeof value.name === 'string' &&
    /^\w+$/.test(value.name) &&
    typeof value.label === 'string' &&
    ['promql', 'promql_query', 'sql', 'list', 'text', 'dataset'].includes(String(value.type)) &&
    [
      'dataset',
      'labelName',
      'metric',
      'sqlQuery',
      'promqlQuery',
      'promqlQueryDataset',
      'promqlQueryLabel',
      'defaultValue',
    ].every((key) => optionalString(value[key])) &&
    (value.options == null || strings(value.options)) &&
    (value.includeAll == null || typeof value.includeAll === 'boolean') &&
    (value.labelFilters == null ||
      (Array.isArray(value.labelFilters) &&
        value.labelFilters.every(
          (filter) =>
            object(filter) &&
            typeof filter.label === 'string' &&
            typeof filter.value === 'string' &&
            ['=', '!=', '=~', '!~'].includes(String(filter.operator)),
        )))
  );
}
