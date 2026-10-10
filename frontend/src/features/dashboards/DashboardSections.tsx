import { EmptyState } from '../../components/ui';
import type { Dashboard, DashboardTile as Tile } from '../../lib/types';
import type { QueryLimiter } from '../../lib/concurrency';
import { DashboardTile } from './DashboardTile';
import { compactLayouts, sectionGroups } from './layout';
import { tileVariableNames } from './tiles';
import type { VariableResolutions } from './VariableControl';
import type { useDashboardUrl } from './useDashboardUrl';
export function DashboardSections({
  dashboard,
  url,
  writable,
  promqlEnabled,
  promqlAlerts,
  resolutions,
  limit,
  onAction,
}: {
  dashboard: Dashboard;
  url: ReturnType<typeof useDashboardUrl>;
  writable: boolean;
  promqlEnabled?: boolean;
  promqlAlerts: boolean;
  resolutions: VariableResolutions;
  limit: QueryLimiter;
  onAction: (action: 'edit' | 'duplicate' | 'earlier' | 'later' | 'delete', tile: Tile) => void;
}) {
  const groups = sectionGroups(dashboard.tiles ?? [], dashboard.sections);
  return (
    <>
      {!(dashboard.tiles ?? []).length && !groups.some((group) => group.id) ? (
        <EmptyState
          title={writable ? 'Start building your dashboard' : 'This dashboard has no tiles'}
          description={
            writable
              ? 'Add SQL and PromQL tiles to visualize your telemetry.'
              : 'The owner can add tiles to this dashboard.'
          }
        />
      ) : (
        groups.map((group) => (
          <section
            key={group.id ? `section:${group.id}` : 'unsectioned'}
            className="dashboard-section"
            aria-label={group.title || 'Dashboard tiles'}
          >
            {group.id && <h2>{group.title}</h2>}
            <div className="dashboard-server-grid">
              {compactLayouts(group.tiles).map(({ tile, layout }, index, rows) => {
                const names = [...tileVariableNames(tile, url.variables)];
                const ready = names.every(
                  (name) =>
                    resolutions[name]?.ready && resolutions[name].value === url.values[name],
                );
                const failed = names.find((name) => resolutions[name]?.error);
                return (
                  <DashboardTile
                    key={tile.tile_id}
                    tile={tile}
                    layout={layout}
                    dashboardId={dashboard.dashboardId}
                    variables={url.variables}
                    values={url.values}
                    bounds={url.bounds}
                    anchor={url.anchor}
                    revision={url.revision}
                    ready={ready}
                    variableError={failed ? `${failed}: ${resolutions[failed].error}` : undefined}
                    writable={writable}
                    promqlEnabled={promqlEnabled}
                    promqlAlerts={promqlAlerts}
                    limit={limit}
                    first={index === 0}
                    last={index === rows.length - 1}
                    onAction={onAction}
                  />
                );
              })}
            </div>
          </section>
        ))
      )}
    </>
  );
}
