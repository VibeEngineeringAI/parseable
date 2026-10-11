import { ApiError } from './client';
import { createUlid } from './ids';
import { sha256Fallback } from './sha256';
import { ulid } from './dashboardsContract';
import type { Dashboard, DashboardRequest, DashboardSummary, ParseableClient } from './types';

type Methods =
  | 'listDashboards'
  | 'getDashboard'
  | 'createDashboard'
  | 'updateDashboard'
  | 'setDashboardFavorite'
  | 'deleteDashboard';
const clone = <T>(value: T): T => structuredClone(value);
const fail = (message: string): never => {
  throw new ApiError(`Cannot perform this operation: ${message}`, 400);
};

export function createDemoDashboards(now = Date.now()): Pick<ParseableClient, Methods> {
  const owner = sha256Fallback('demo');
  let clock = now;
  const timestamp = () => new Date(++clock).toISOString();
  const fixture = (id: string, title: string, extra: Partial<Dashboard>): Dashboard => ({
    title,
    dashboardId: id,
    version: 'v1',
    author: owner,
    created: new Date(now - 86400_000).toISOString(),
    modified: new Date(now).toISOString(),
    tags: ['production'],
    isFavorite: false,
    dashboardType: 'Dashboard',
    tenantId: null,
    tiles: [],
    variables: [],
    sections: [],
    timeRange: {
      startTime: '1h',
      endTime: 'now',
      type: 'fixed',
      label: 'Last 1 hour',
      interval: 3600_000,
      shiftInterval: 1,
    },
    ...extra,
  });
  let dashboards: Dashboard[] = [
    fixture('01M4J000000000000000000001', 'Application signals', {
      description: 'Request duration, recent events and total volume.',
      isFavorite: true,
      tags: ['production', 'logs'],
      tiles: [
        {
          tile_id: '01M4J000000000000000000011',
          title: 'Request duration',
          tileType: 'code',
          authorMode: 'manual',
          chartType: 'timeseries',
          dbName: ['application_logs'],
          chartQuery: 'SELECT * FROM "application_logs" ORDER BY "p_timestamp" ASC LIMIT 100',
          layout: { x: 0, y: 0, w: 8, h: 4 },
          config: {
            type: 'timeseries',
            colourScheme: 'classic',
            layout: { unit: 'ms', precision: 1, legendPosition: 'bottom' },
            axes: {
              x: { field: 'p_timestamp', title: 'Time' },
              y: { field: 'duration_ms', title: 'Duration' },
            },
          },
        },
        {
          tile_id: '01M4J000000000000000000012',
          title: 'Recent events',
          tileType: 'code',
          authorMode: 'manual',
          chartType: 'table',
          dbName: ['application_logs'],
          chartQuery: 'SELECT * FROM "application_logs" ORDER BY "p_timestamp" DESC LIMIT 5',
          layout: { x: 0, y: 4, w: 12, h: 4 },
          config: { type: 'table', layout: {} },
        },
        {
          tile_id: '01M4J000000000000000000013',
          title: 'Event count',
          tileType: 'code',
          authorMode: 'manual',
          chartType: 'query-value',
          dbName: ['application_logs'],
          chartQuery: 'SELECT COUNT(*) AS events FROM "application_logs"',
          layout: { x: 8, y: 0, w: 4, h: 4 },
          config: { type: 'query-value', layout: { precision: 0, unit: 'events' } },
        },
      ],
    }),
    fixture('01M4J000000000000000000002', 'Host metrics', {
      tags: ['production', 'metrics'],
      variables: [
        {
          name: 'metrics_dataset',
          label: 'Metrics dataset',
          type: 'dataset',
          defaultValue: 'demo_metrics',
        },
        {
          name: 'host',
          label: 'Host',
          type: 'promql',
          dataset: '$metrics_dataset',
          labelName: 'host',
          metric: 'system.cpu.load_average.1m',
          includeAll: true,
        },
      ],
      tiles: [
        {
          tile_id: '01M4J000000000000000000021',
          title: 'Host load',
          authorMode: 'manual',
          tileType: 'promql',
          chartType: 'timeseries',
          dbName: '$metrics_dataset',
          chartQuery: ['{__name__="system.cpu.load_average.1m",host=~"$host"}'],
          promqlQueryType: ['range'],
          config: {
            type: 'timeseries',
            colourScheme: 'classic',
            layout: { legendPosition: 'bottom', precision: 2 },
          },
          layout: { x: 0, y: 0, w: 12, h: 4 },
        },
      ],
    }),
    fixture('01M4J000000000000000000003', 'Shared operations', {
      author: sha256Fallback('other-user'),
      tags: ['shared'],
      description: 'An operations dashboard owned by another team member.',
      tiles: [
        {
          tile_id: '01M4J000000000000000000031',
          title: 'API events',
          tileType: 'code',
          chartType: 'query-value',
          chartQuery: 'SELECT COUNT(*) AS events FROM "api_logs"',
          dbName: ['api_logs'],
          config: { layout: { precision: 0, unit: 'events' } },
          layout: { x: 0, y: 0, w: 6, h: 3 },
        },
      ],
    }),
  ];
  const get = (id: string, missing = 'Dashboard does not exist') => {
    if (!ulid(id)) fail('Invalid dashboard ID format - must be a valid ULID');
    return dashboards.find((item) => item.dashboardId === id) ?? fail(missing);
  };
  const unique = (body: DashboardRequest, id?: string) => {
    if (dashboards.some((item) => item.title === body.title && item.dashboardId !== id))
      fail('Dashboard title must be unique');
  };
  async function ready(signal?: AbortSignal) {
    signal?.throwIfAborted();
    await Promise.resolve();
    signal?.throwIfAborted();
  }
  return {
    async listDashboards(signal) {
      await ready(signal);
      return clone(
        [...dashboards]
          .sort((a, b) => String(b.modified).localeCompare(String(a.modified)))
          .map(
            ({
              title,
              author,
              dashboardId,
              created,
              modified,
              tags,
              isFavorite,
            }): DashboardSummary => ({
              title,
              author,
              dashboardId,
              created,
              modified,
              tags,
              isFavorite,
            }),
          ),
      );
    },
    async getDashboard(id, signal) {
      await ready(signal);
      return clone(get(id));
    },
    async createDashboard(body) {
      await ready();
      if (!body.title) fail('Title must be provided');
      unique(body);
      const time = timestamp();
      const value: Dashboard = {
        ...clone(body),
        version: 'v1',
        author: owner,
        dashboardId: createUlid(),
        created: time,
        modified: time,
        tags: body.tags ?? null,
        tiles: body.tiles ?? [],
        isFavorite: body.isFavorite ?? false,
        dashboardType: body.dashboardType ?? 'Dashboard',
        tenantId: null,
      };
      dashboards.push(value);
      return clone(value);
    },
    async updateDashboard(id, body) {
      await ready();
      const original = get(id, 'Dashboard does not exist or user is not authorized');
      const tiles = body.tiles ?? [];
      if (tiles.some((item) => item.tile_id === '00000000000000000000000000'))
        fail('Tile ID must be provided');
      if (new Set(tiles.map((item) => item.tile_id)).size !== tiles.length)
        fail('Tile IDs must be unique');
      if (original.author !== owner)
        fail('Dashboard does not exist or you do not have permission to access it');
      unique(body, id);
      const value: Dashboard = {
        ...clone(body),
        version: 'v1',
        author: owner,
        dashboardId: id,
        created: original.created,
        modified: timestamp(),
        tags: body.tags ?? null,
        tiles,
        isFavorite: body.isFavorite ?? false,
        dashboardType: body.dashboardType ?? 'Dashboard',
        tenantId: body.tenantId ?? null,
      };
      dashboards = dashboards.map((item) => (item.dashboardId === id ? value : item));
      return clone(value);
    },
    async setDashboardFavorite(id, isFavorite) {
      await ready();
      const original = get(id, 'Dashboard does not exist or user is not authorized');
      if (original.author !== owner)
        fail('Dashboard does not exist or you do not have permission to access it');
      const value: Dashboard = { ...original, isFavorite, modified: timestamp() };
      dashboards = dashboards.map((item) => (item.dashboardId === id ? value : item));
      return clone(value);
    },
    async deleteDashboard(id) {
      await ready();
      get(id, 'Dashboard does not exist or you do not have permission to access it');
      // The demo identity has admin privileges: DELETE permits any owner, unlike PUT.
      dashboards = dashboards.filter((item) => item.dashboardId !== id);
    },
  };
}
