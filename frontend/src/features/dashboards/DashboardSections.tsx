import { useState } from 'react';
import { ActionsMenu, EmptyState } from '../../components/ui';
import type { TimeSeriesChartProps } from '../../components/charts/TimeSeriesChart';
import type { Dashboard, DashboardTile as Tile } from '../../lib/types';
import type { QueryLimiter } from '../../lib/concurrency';
import { DashboardTile } from './DashboardTile';
import { sectionGroups } from './layout';
import { dashboardSections } from './sections';
import { DashboardTileGrid } from './DashboardTileGrid';
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
  onZoomRange,
  onLayoutChange,
  onSectionAction,
  onSectionCollapse,
}: {
  dashboard: Dashboard;
  url: ReturnType<typeof useDashboardUrl>;
  writable: boolean;
  promqlEnabled?: boolean;
  promqlAlerts: boolean;
  resolutions: VariableResolutions;
  limit: QueryLimiter;
  onAction: (action: 'edit' | 'duplicate' | 'earlier' | 'later' | 'delete', tile: Tile) => void;
  onZoomRange?: TimeSeriesChartProps['onZoomRange'];
  onLayoutChange: (tiles: Tile[], message?: string) => void;
  onSectionAction: (
    action: 'rename' | 'delete' | 'earlier' | 'later',
    id: string,
    title: string,
  ) => void;
  onSectionCollapse: (id: string, collapsed: boolean) => void;
}) {
  const [viewCollapsed, setViewCollapsed] = useState<Record<string, boolean>>({});
  const sections = dashboardSections(dashboard.sections);
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
        groups.map((group) => {
          const stored = sections.find((section) => section.sectionId === group.id);
          const collapsed =
            viewCollapsed[group.id] !== undefined
              ? viewCollapsed[group.id]
              : stored?.collapsed === true;
          const sectionIndex = sections.findIndex((section) => section.sectionId === group.id);
          return (
            <section
              key={group.id ? `section:${group.id}` : 'unsectioned'}
              className="dashboard-section"
              aria-label={group.title || 'Dashboard tiles'}
            >
              {group.id && (
                <div className="dashboard-section-heading">
                  <h2>
                    <button
                      className="dashboard-section-toggle"
                      type="button"
                      aria-expanded={!collapsed}
                      onClick={() => {
                        setViewCollapsed((current) => ({ ...current, [group.id]: !collapsed }));
                      }}
                    >
                      <span aria-hidden="true">{collapsed ? '▸' : '▾'}</span> {group.title}
                    </button>
                  </h2>
                  <span className="muted">
                    {group.tiles.length} {group.tiles.length === 1 ? 'tile' : 'tiles'}
                  </span>
                  {writable && (
                    <ActionsMenu
                      data-dashboard-edit-control
                      label={`Section actions for ${group.title}`}
                      items={[
                        {
                          id: 'collapse-default',
                          label:
                            stored?.collapsed === true
                              ? 'Expand by default'
                              : 'Collapse by default',
                          onSelect: () => {
                            setViewCollapsed((current) => {
                              const next = { ...current };
                              delete next[group.id];
                              return next;
                            });
                            onSectionCollapse(group.id, stored?.collapsed !== true);
                          },
                        },
                        {
                          id: 'rename',
                          label: 'Rename section',
                          onSelect: () => onSectionAction('rename', group.id, group.title),
                        },
                        {
                          id: 'earlier',
                          label: 'Move section earlier',
                          disabled: sectionIndex === 0,
                          onSelect: () => onSectionAction('earlier', group.id, group.title),
                        },
                        {
                          id: 'later',
                          label: 'Move section later',
                          disabled: sectionIndex === sections.length - 1,
                          onSelect: () => onSectionAction('later', group.id, group.title),
                        },
                        {
                          id: 'delete',
                          label: 'Delete section',
                          destructive: true,
                          onSelect: () => onSectionAction('delete', group.id, group.title),
                        },
                      ]}
                    />
                  )}
                </div>
              )}
              {!collapsed && group.id && !group.tiles.length && (
                <p className="muted">
                  This section is empty. Choose this section when adding or editing a tile.
                </p>
              )}
              {!collapsed && (
                <DashboardTileGrid
                  tiles={group.tiles}
                  writable={writable}
                  onLayoutChange={onLayoutChange}
                >
                  {(tile, layout, index, count) => {
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
                        range={url.range}
                        anchor={url.anchor}
                        revision={url.revision}
                        ready={ready}
                        variableError={
                          failed ? `${failed}: ${resolutions[failed].error}` : undefined
                        }
                        writable={writable}
                        promqlEnabled={promqlEnabled}
                        promqlAlerts={promqlAlerts}
                        limit={limit}
                        first={index === 0}
                        last={index === count - 1}
                        onAction={onAction}
                        onZoomRange={onZoomRange}
                      />
                    );
                  }}
                </DashboardTileGrid>
              )}
            </section>
          );
        })
      )}
    </>
  );
}
