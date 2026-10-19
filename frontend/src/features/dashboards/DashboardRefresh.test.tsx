import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createDemoDashboards } from '../../lib/demoDashboards';
import {
  DashboardRefreshControls,
  DashboardRefreshProvider,
  savedRefreshInterval,
} from './DashboardRefresh';

afterEach(() => vi.unstubAllGlobals());
describe('saved dashboard refresh defaults', () => {
  it('starts older documents and unsupported intervals with refresh off', () => {
    for (const value of [undefined, null, -1, 1000, '30000', Number.NaN])
      expect(savedRefreshInterval(value)).toBe(0);
    for (const value of [0, 15_000, 30_000, 60_000, 300_000])
      expect(savedRefreshInterval(value)).toBe(value);
  });
  it('reloads an explicitly saved default into the live refresh controls', async () => {
    const client = createDemoDashboards();
    const created = await client.createDashboard({ title: 'Refresh default', tiles: [] });
    expect(created.refreshInterval).toBeUndefined();
    await client.updateDashboard(created.dashboardId, { ...created, refreshInterval: 30_000 });
    const reloaded = await client.getDashboard(created.dashboardId);
    vi.stubGlobal('document', { hidden: false });
    const markup = renderToStaticMarkup(
      <DashboardRefreshProvider onRefresh={() => {}} savedInterval={reloaded.refreshInterval}>
        <DashboardRefreshControls savedInterval={reloaded.refreshInterval} />
      </DashboardRefreshProvider>,
    );
    expect(markup).toContain('<option value="30000" selected="">30s</option>');
    expect(markup).not.toContain('Use as saved default');
  });
});
