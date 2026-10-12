import { tile } from '../../lib/dashboardsContract';
import { object } from '../../lib/guards';
import type { Dashboard, DashboardTile } from '../../lib/types';
import { createUlid } from '../../lib/ids';
import { loadDraft } from '../dashboards/draft';
import { appendLayout } from '../dashboards/layout';
import { newTile, record, supportedCharts } from '../dashboards/tiles';
export type SqlChartConfig = DashboardTile;
export const createSqlChartConfig = (): SqlChartConfig => ({ ...newTile([]), title: 'SQL chart' });
export function executedSqlTile(config: SqlChartConfig, query: string): DashboardTile {
  return {
    ...structuredClone(config),
    tile_id: createUlid(),
    title: String(config.title ?? '').trim(),
    tileType: 'code',
    chartQuery: query,
  };
}
export function appendSqlTile(dashboard: Dashboard, tile: DashboardTile): Dashboard {
  const repaired = loadDraft(dashboard).draft;
  const tiles = repaired.tiles ?? [];
  return {
    ...repaired,
    tiles: [
      ...tiles,
      {
        ...tile,
        layout: {
          ...record(tile.layout),
          ...appendLayout(tiles),
          w: record(tile.layout).w ?? 6,
          h: record(tile.layout).h ?? 4,
        },
      },
    ],
  };
}

/** Restore only a supported chart document; leave invalid library data untouched. */
export function readSqlChartConfig(value: unknown): SqlChartConfig | undefined {
  if (
    !tile(value) ||
    value.tileType !== 'code' ||
    typeof value.title !== 'string' ||
    typeof value.chartType !== 'string' ||
    !supportedCharts.includes(value.chartType) ||
    !object(value.config) ||
    !object(value.config.axes) ||
    !object(value.config.layout)
  )
    return undefined;
  return structuredClone(value);
}
