import { describe, expect, it, vi } from 'vitest';
import classic from './__fixtures__/classic.json';
import {
  checkDashboardConflict,
  dashboardDate,
  duplicateDashboard,
  filterDashboards,
  editDashboardMetadata,
} from './helpers';
import { dashboardRange, classicTimeRange } from './timeRange';
import { ulid } from '../../lib/dashboardsContract';
import type { ParseableClient } from '../../lib/types';
describe('dashboard helpers', () => {
  it('renames without adding a description or changing stored tag values and extras', () => {
    const { description: _description, ...source } = classic;
    const tags = ['svc,api', ' repeated ', ' repeated '];
    expect(editDashboardMetadata({ ...source, tags }, 'Renamed', tags, '')).toEqual({
      ...source,
      tags,
      title: 'Renamed',
    });
    expect(
      editDashboardMetadata({ ...source, description: { unknown: true } }, 'Renamed', tags, '')
        .description,
    ).toEqual({ unknown: true });
    expect(
      editDashboardMetadata(classic, classic.title, classic.tags, 'New description').description,
    ).toBe('New description');
  });
  it('preserves missing and null tags on a title-only edit', () => {
    const { tags: _tags, ...withoutTags } = classic;
    for (const source of [withoutTags, { ...withoutTags, tags: null }])
      expect(editDashboardMetadata(source, 'Renamed', [], classic.description)).toEqual({
        ...source,
        title: 'Renamed',
      });
  });
  it('checks modified again before save and propagates aborts and permission errors', async () => {
    const getDashboard = vi.fn().mockResolvedValue({ ...classic, modified: 'later' }),
      client = { getDashboard } as unknown as ParseableClient;
    const signal = new AbortController().signal;
    expect((await checkDashboardConflict(client, classic, signal))?.modified).toBe('later');
    expect(getDashboard).toHaveBeenCalledWith(classic.dashboardId, signal);
    getDashboard.mockResolvedValue(classic);
    expect(await checkDashboardConflict(client, classic, signal)).toBeUndefined();
    getDashboard.mockRejectedValue(new Error('Denied'));
    await expect(checkDashboardConflict(client, classic, signal)).rejects.toThrow('Denied');
  });
  it('duplicates all extras with fresh tile ULIDs and no old metadata', () => {
    const result = duplicateDashboard(classic);
    expect(result.title).toBe('Service health (Copy)');
    expect(result.isFavorite).toBe(false);
    expect(result.tiles.every((tile) => ulid(tile.tile_id))).toBe(true);
    expect(new Set(result.tiles.map((tile) => tile.tile_id)).size).toBe(4);
    expect(result.tiles.map((tile) => tile.tile_id)).not.toEqual(
      classic.tiles.map((tile) => tile.tile_id),
    );
    expect(result.variables).toEqual(classic.variables);
    expect(result.timeRange).toEqual(classic.timeRange);
    expect(result.future).toEqual(classic.future);
    expect(result.dashboardId).toBeUndefined();
    expect(result).not.toHaveProperty('tenantId');
    expect(result.dashboardType).toBe('Report');
  });
  it('parses Chrono summary dates and filters/sorts without fetching details', () => {
    expect(dashboardDate('2026-10-10 12:00:00.123456789 UTC')).toBe('2026-10-10T12:00:00.123Z');
    expect(dashboardDate('bad')).toBeUndefined();
    const rows = [
      classic,
      {
        ...classic,
        dashboardId: '01M4J000000000000000000004',
        title: 'Other',
        author: 'other',
        isFavorite: false,
      },
    ];
    expect(
      filterDashboards(rows, {
        search: 'health',
        tab: 'mine',
        tag: 'prod',
        sort: 'title',
        descending: false,
        owner: classic.author,
      }),
    ).toEqual([classic]);
    expect(
      filterDashboards(rows, {
        search: '',
        tab: 'favourites',
        tag: '',
        sort: 'created',
        descending: true,
      }),
    ).toEqual([classic]);
    expect(
      filterDashboards(rows, { search: '', tab: 'all', tag: '', sort: 'title', descending: false }),
    ).toEqual([rows[1], classic]);
    expect(
      filterDashboards(rows, { search: '', tab: 'all', tag: '', sort: 'title', descending: true }),
    ).toEqual([classic, rows[1]]);
  });
  it('reads saved and URL ranges and writes the exact fixed or custom classic shape', () => {
    expect(dashboardRange(new URLSearchParams(), classic.timeRange)).toBe('1h');
    expect(dashboardRange(new URLSearchParams('range=30m'), classic.timeRange)).toBe('30m');
    expect(classicTimeRange('1h', undefined)).toEqual(classic.timeRange);
    const range = { startTime: '2026-10-10T00:00:00.000Z', endTime: '2026-10-10T00:30:00.000Z' };
    expect(classicTimeRange(range, { customExtra: 1 })).toMatchObject({
      ...range,
      type: 'custom',
      interval: 1800000,
      shiftInterval: 1,
      customExtra: 1,
    });
    expect(dashboardRange(new URLSearchParams('start=bad&end=now'), classic.timeRange)).toBe('1h');
  });
});
