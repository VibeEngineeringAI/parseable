import { describe, expect, it } from 'vitest';
import { createDemoDashboards } from './demoDashboards';
import { dashboard } from './dashboardsContract';
import classic from '../features/dashboards/__fixtures__/classic.json';
describe('per-client dashboard demo', () => {
  it('provides SQL, PromQL and another owner fixtures', async () => {
    const client = createDemoDashboards(),
      rows = await client.listDashboards();
    expect(rows).toHaveLength(3);
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
  it('honours aborted reads', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(createDemoDashboards().listDashboards(controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});
