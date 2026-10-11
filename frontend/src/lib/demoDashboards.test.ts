import { describe, expect, it } from 'vitest';
import { createDemoDashboards } from './demoDashboards';
import { dashboard } from './dashboardsContract';
import classic from '../features/dashboards/__fixtures__/classic.json';
describe('per-client dashboard demo', () => {
  it('provides SQL, PromQL and another owner fixtures', async () => {
    const client = createDemoDashboards(),
      rows = await client.listDashboards();
    expect(rows).toHaveLength(3);
    for (const row of rows)
      expect(Object.keys(row).sort()).toEqual([
        'author',
        'created',
        'dashboardId',
        'isFavorite',
        'modified',
        'tags',
        'title',
      ]);
    const sql = await client.getDashboard(
      rows.find((row) => row.title === 'Application signals')!.dashboardId,
    );
    expect(sql.tiles?.map((tile) => tile.chartType)).toEqual([
      'timeseries',
      'table',
      'query-value',
    ]);
    expect(dashboard(sql)).toBe(true);
    expect(new Set(rows.map((row) => row.author)).size).toBe(2);
  });
  it('clones, round trips extras, replaces whole documents and isolates clients', async () => {
    const client = createDemoDashboards(),
      created = await client.createDashboard({ ...classic, title: 'Created' });
    created.tiles![0].title = 'Edited';
    expect((await client.getDashboard(created.dashboardId)).tiles![0].title).toBe('Host load');
    const saved = await client.updateDashboard(created.dashboardId, created);
    expect(saved.tiles![0].title).toBe('Edited');
    expect(await client.listDashboards()).toHaveLength(4);
    expect(await createDemoDashboards().listDashboards()).toHaveLength(3);
    expect(saved.future).toEqual(classic.future);
    expect(saved.variables).toEqual(classic.variables);
    expect(saved.created).toBe(created.created);
    expect(saved.modified).not.toBe(created.modified);
    await client.deleteDashboard(saved.dashboardId);
    expect(await createDemoDashboards().listDashboards()).toHaveLength(3);
  });
  it('uses server validation messages, exact tenant-wide titles and ownership', async () => {
    const c = createDemoDashboards();
    await expect(c.createDashboard({ title: '' })).rejects.toThrow('Title must be provided');
    const created = await c.createDashboard({ title: 'One' });
    await expect(c.createDashboard({ title: 'One' })).rejects.toThrow(
      'Dashboard title must be unique',
    );
    await c.createDashboard({ title: 'one' });
    await expect(c.updateDashboard(created.dashboardId, { title: 'one' })).rejects.toThrow(
      'Dashboard title must be unique',
    );
    const other = (await c.listDashboards()).find((row) => row.title === 'Shared operations')!;
    await expect(c.updateDashboard(other.dashboardId, { title: 'New' })).rejects.toThrow(
      'you do not have permission',
    );
    await c.deleteDashboard(other.dashboardId);
    await expect(c.getDashboard(other.dashboardId)).rejects.toMatchObject({ status: 400 });
    await expect(
      c.updateDashboard(created.dashboardId, {
        title: 'One',
        tiles: [{ tile_id: '00000000000000000000000000' }],
      }),
    ).rejects.toThrow('Tile ID must be provided');
    await expect(
      c.updateDashboard(created.dashboardId, {
        title: 'One',
        tiles: [classic.tiles[0], classic.tiles[0]],
      }),
    ).rejects.toThrow('Tile IDs must be unique');
  });
  it('toggles favourites with a partial update that keeps unrepaired tiles and checks ownership', async () => {
    const c = createDemoDashboards(),
      tiles = [classic.tiles[0], classic.tiles[0]];
    const created = await c.createDashboard({ ...classic, title: 'Starred', tiles });
    const starred = await c.setDashboardFavorite(created.dashboardId, true);
    expect(starred).toEqual({ ...created, isFavorite: true, modified: starred.modified });
    expect(starred.modified).not.toBe(created.modified);
    expect((await c.getDashboard(created.dashboardId)).tiles).toEqual(tiles);
    expect((await c.setDashboardFavorite(created.dashboardId, false)).isFavorite).toBe(false);
    const other = (await c.listDashboards()).find((row) => row.title === 'Shared operations')!;
    await expect(c.setDashboardFavorite(other.dashboardId, true)).rejects.toThrow(
      'you do not have permission',
    );
    await expect(c.setDashboardFavorite('01M4J000000000000000000099', true)).rejects.toThrow(
      'Dashboard does not exist or user is not authorized',
    );
  });
  it('honours aborted reads', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(createDemoDashboards().listDashboards(controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});

it('returns the exact server messages for missing dashboards and validates tiles before owner checks', async () => {
  const client = createDemoDashboards(),
    id = '01M4J000000000000000000099';
  await expect(client.getDashboard(id)).rejects.toThrow(
    'Cannot perform this operation: Dashboard does not exist',
  );
  await expect(client.updateDashboard(id, { title: 'Missing' })).rejects.toThrow(
    'Cannot perform this operation: Dashboard does not exist or user is not authorized',
  );
  await expect(client.deleteDashboard(id)).rejects.toThrow(
    'Cannot perform this operation: Dashboard does not exist or you do not have permission to access it',
  );
  const other = (await client.listDashboards()).find((row) => row.title === 'Shared operations')!;
  await expect(
    client.updateDashboard(other.dashboardId, {
      title: 'Bad',
      tiles: [{ tile_id: '00000000000000000000000000' }],
    }),
  ).rejects.toThrow('Tile ID must be provided');
});
