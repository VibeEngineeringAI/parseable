import type {
  Dashboard,
  DashboardRequest,
  DashboardSummary,
  DashboardTile,
  ParseableClient,
} from '../../lib/types';
import { createUlid } from '../../lib/ids';

export const dashboardError = (error?: string) =>
  error?.replace(/^Cannot perform this operation: /, '');
export const tagsFromText = (text: string) => [
  ...new Set(
    text
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  ),
];
export function dashboardDate(value: string | null | undefined) {
  if (!value) return undefined;
  const normalized = value
    .replace(' UTC', 'Z')
    .replace(' ', 'T')
    .replace(/(\.\d{3})\d+/, '$1');
  const date = Date.parse(normalized);
  return Number.isFinite(date) ? new Date(date).toISOString() : undefined;
}
function hasConflict(loaded: Dashboard, latest: Dashboard): boolean {
  return loaded.modified !== latest.modified;
}
export async function checkDashboardConflict(
  client: ParseableClient,
  loaded: Dashboard,
  signal: AbortSignal,
) {
  const latest = await client.getDashboard(loaded.dashboardId, signal);
  return hasConflict(loaded, latest) ? latest : undefined;
}
/** Only the metadata fields that differ from `original`. */
export function metadataPatch(
  original: Dashboard,
  title: string,
  tags: string[],
  description: string,
): Partial<Dashboard> {
  const currentDescription = typeof original.description === 'string' ? original.description : '';
  return {
    ...(title !== original.title ? { title } : {}),
    ...(JSON.stringify(tags) !== JSON.stringify(original.tags ?? []) ? { tags } : {}),
    ...(description !== currentDescription ? { description } : {}),
  };
}
export function editDashboardMetadata(
  original: Dashboard,
  title: string,
  tags: string[],
  description: string,
): Dashboard {
  return { ...original, ...metadataPatch(original, title, tags, description) };
}
/** True when someone else changed a field that `patch` also changes. */
export function patchConflicts(loaded: Dashboard, latest: Dashboard, patch: Partial<Dashboard>) {
  return Object.keys(patch).some(
    (key) => JSON.stringify(latest[key]) !== JSON.stringify(loaded[key]),
  );
}
export function availableTitle(title: string, taken: Set<string>) {
  let result = title,
    index = 2;
  while (taken.has(result)) result = `${title} (${index++})`;
  taken.add(result);
  return result;
}
export function duplicateDashboard(
  source: Dashboard,
  titles: Iterable<string>,
): DashboardRequest & { tiles: DashboardTile[] } {
  const body = structuredClone(source);
  for (const key of ['dashboardId', 'author', 'created', 'modified', 'tenantId']) delete body[key];
  return {
    ...body,
    title: availableTitle(`${source.title} (Copy)`, new Set(titles)),
    isFavorite: false,
    tiles: (source.tiles ?? []).map((tile) => ({ ...tile, tile_id: createUlid() })),
  };
}
export type DashboardSort = 'title' | 'created' | 'modified';
export function filterDashboards(
  rows: DashboardSummary[],
  {
    search,
    tab,
    tag,
    sort,
    descending,
    owner,
  }: {
    search: string;
    tab: string;
    tag: string;
    sort: DashboardSort;
    descending: boolean;
    owner?: string;
  },
) {
  return rows
    .filter(
      (row) =>
        row.title.toLowerCase().includes(search.toLowerCase()) &&
        (tab !== 'mine' || (!!owner && row.author === owner)) &&
        (tab !== 'favourites' || row.isFavorite) &&
        (!tag || row.tags?.includes(tag)),
    )
    .sort((a, b) => {
      const compare =
        sort === 'title'
          ? a.title.localeCompare(b.title)
          : (dashboardDate(a[sort]) ?? '').localeCompare(dashboardDate(b[sort]) ?? '');
      return (descending ? -compare : compare) || a.dashboardId.localeCompare(b.dashboardId);
    });
}

export const dashboardPresets = [
  { value: '10m', label: 'Last 10 minutes' },
  { value: '30m', label: 'Last 30 minutes' },
  { value: '1h', label: 'Last 1 hour' },
  { value: '5h', label: 'Last 5 hours' },
  { value: '1d', label: 'Last 24 hours' },
  { value: '3d', label: 'Last 3 days' },
] as const;
