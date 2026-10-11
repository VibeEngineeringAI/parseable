import type { DashboardRequest } from '../../lib/types';
import { quoteIdentifier } from '../../lib/query';
import { createUlid } from '../../lib/ids';
import { mapConcurrent } from '../../lib/concurrency';
import { chartConfig } from './tiles';
import type { LocalDashboard } from './storage';
import { availableTitle } from './helpers';
export type ImportItem = { local: LocalDashboard; title: string };
export function planLocalImport(
  local: LocalDashboard[],
  serverTitles: string[],
  importedIds: string[],
) {
  const taken = new Set(serverTitles),
    imported = new Set(importedIds),
    seen = new Set<string>();
  const create: ImportItem[] = [],
    skip: LocalDashboard[] = [];
  for (const item of local) {
    if (imported.has(item.id) || seen.has(item.id)) {
      skip.push(item);
      continue;
    }
    seen.add(item.id);
    const title = availableTitle(item.title.trim() || 'Imported dashboard', taken);
    create.push({ local: item, title });
  }
  return { create, skip };
}

export function localImportBody(item: ImportItem, tileId: string): DashboardRequest {
  const { local, title } = item;
  return {
    title,
    description: local.description,
    tags: [],
    variables: [],
    sections: [],
    isFavorite: false,
    tiles: [
      {
        tile_id: tileId,
        title: 'Event volume',
        authorMode: 'manual',
        tileType: 'code',
        chartType: 'bar',
        dbName: [local.dataset],
        chartQuery: `SELECT date_trunc('minute', "p_timestamp") AS time, COUNT(*) AS events FROM ${quoteIdentifier(local.dataset)} GROUP BY time ORDER BY time`,
        config: {
          ...chartConfig('bar'),
          axes: {
            x: { field: 'time', title: 'Time', display: true },
            y: { field: 'events', title: 'Events', display: true, beginAtZero: true },
          },
        },
        layout: { x: 0, y: 0, w: 12, h: 4 },
      },
    ],
  };
}
export type LocalImportResult = { id: string; title: string; imported: boolean; error?: string };
export async function runLocalImport(
  items: ImportItem[],
  create: (body: DashboardRequest) => Promise<unknown>,
  serverTitles: string[],
): Promise<LocalImportResult[]> {
  const taken = new Set([...serverTitles, ...items.map((item) => item.title)]);
  return mapConcurrent(items, 3, async (item) => {
    let body: DashboardRequest | undefined;
    try {
      body = localImportBody(item, createUlid());
      try {
        await create(body);
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('Dashboard title must be unique'))
          throw error;
        body = { ...body, title: availableTitle(item.title, taken) };
        await create(body);
      }
      return { id: item.local.id, title: body.title, imported: true };
    } catch (error) {
      return {
        id: item.local.id,
        title: body?.title ?? item.title,
        imported: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
}
export type ImportMarker = { importedIds: string[]; dismissed?: boolean };
export const markerKey = (identity: string) => `parseable-dashboards-import-v1:${identity}`;
export function readImportMarker(identity: string): ImportMarker {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(markerKey(identity)) ?? '{}');
    if (Array.isArray(value))
      return { importedIds: value.filter((id): id is string => typeof id === 'string') };
    if (value && typeof value === 'object') {
      const marker = value as Record<string, unknown>;
      return {
        importedIds: Array.isArray(marker.importedIds)
          ? marker.importedIds.filter((id): id is string => typeof id === 'string')
          : [],
        dismissed: marker.dismissed === true,
      };
    }
  } catch {
    /* Browser storage can be unavailable or corrupt. */
  }
  return { importedIds: [] };
}
