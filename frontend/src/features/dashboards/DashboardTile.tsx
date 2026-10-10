import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ActionsMenu, Button, Card, Dialog } from '../../components/ui';
import { QueryState } from '../../components/explorer/QueryState';
import { useApp } from '../../app/AppProvider';
import { useAsync } from '../../hooks/useAsync';
import { timeBounds } from '../../lib/query';
import type { QueryLimiter } from '../../lib/concurrency';
import type { DashboardTile as Tile, DashboardVariable, QueryRequest } from '../../lib/types';
import { TileChart } from './TileChart';
import { loadTile } from './queries';
import { knownTile, supportedCharts, text, tileTitle, type TileLayout } from './tiles';
import { storedRange } from './timeRange';
import { tileHandoffs } from './handoffs';
import type { VariableValues } from './variables';
export function DashboardTile({
  tile,
  layout,
  dashboardId,
  variables,
  values,
  bounds,
  anchor,
  revision,
  ready,
  writable,
  promqlEnabled,
  promqlAlerts,
  limit,
  first,
  last,
  onAction,
}: {
  tile: Tile;
  layout: TileLayout;
  dashboardId: string;
  variables: DashboardVariable[];
  values: VariableValues;
  bounds: Omit<QueryRequest, 'sql'>;
  anchor: number;
  revision: number;
  ready: boolean;
  writable: boolean;
  promqlEnabled: boolean;
  promqlAlerts: boolean;
  limit: QueryLimiter;
  first: boolean;
  last: boolean;
  onAction: (action: 'edit' | 'duplicate' | 'earlier' | 'later' | 'delete', tile: Tile) => void;
}) {
  const { client } = useApp(),
    navigate = useNavigate();
  const [viewQuery, setViewQuery] = useState(false);
  const supported = knownTile(tile) && supportedCharts.includes(text(tile.chartType, 'timeseries'));
  const locked = tile.tileType === 'promql' && !promqlEnabled;
  const effectiveBounds = useMemo(
    () => (tile.timeRange ? timeBounds(storedRange(tile.timeRange, anchor), anchor) : bounds),
    [tile.timeRange, anchor, bounds],
  );
  const results = useAsync(
    useCallback(
      (signal) =>
        supported && !locked && ready
          ? loadTile(client, tile, variables, values, effectiveBounds, limit, signal)
          : Promise.resolve(undefined),
      [
        client,
        tile,
        variables,
        JSON.stringify(values),
        effectiveBounds,
        limit,
        supported,
        locked,
        ready,
        revision,
      ],
    ),
  );
  const handoff = tileHandoffs(tile, variables, values, effectiveBounds, promqlAlerts);
  const classic = `/dashboards/${encodeURIComponent(dashboardId)}`;
  return (
    <Card
      className="dashboard-tile"
      role="region"
      aria-label={`Tile ${tileTitle(tile)}`}
      tabIndex={0}
      data-tile-id={tile.tile_id}
      style={{
        gridColumn: `${layout.x + 1} / span ${layout.w}`,
        gridRow: `${layout.y + 1} / span ${layout.h}`,
      }}
    >
      <div className="panel-heading dashboard-tile-heading">
        <h2>{tileTitle(tile)}</h2>
        <ActionsMenu
          label={`Actions for tile ${tileTitle(tile)}`}
          items={[
            ...(writable && knownTile(tile)
              ? [
                  {
                    id: 'edit',
                    label: tile.tileType === 'builder' ? 'Edit as SQL' : 'Edit',
                    disabled: locked,
                    onSelect: () => onAction('edit', tile),
                  },
                  {
                    id: 'duplicate',
                    label: 'Duplicate tile',
                    onSelect: () => onAction('duplicate', tile),
                  },
                  {
                    id: 'earlier',
                    label: 'Move earlier',
                    disabled: first,
                    onSelect: () => onAction('earlier', tile),
                  },
                  {
                    id: 'later',
                    label: 'Move later',
                    disabled: last,
                    onSelect: () => onAction('later', tile),
                  },
                  {
                    id: 'delete',
                    label: 'Delete tile',
                    destructive: true,
                    onSelect: () => onAction('delete', tile),
                  },
                ]
              : []),
            { id: 'query', label: 'View query', onSelect: () => setViewQuery(true) },
            {
              id: 'explore',
              label: 'Explore data',
              disabled: !handoff.exploreUrl,
              onSelect: () => {
                if (handoff.exploreUrl) navigate(handoff.exploreUrl);
              },
            },
            {
              id: 'alert',
              label: 'Create alert',
              disabled: !handoff.alertUrl,
              description: handoff.reason,
              onSelect: () => {
                if (handoff.alertUrl) navigate(handoff.alertUrl);
              },
            },
          ]}
        />
      </div>
      {!knownTile(tile) ? (
        <div className="dashboard-placeholder">
          <p>This tile type is read-only in /next ({text(tile.tileType, 'unknown')}).</p>
          <a className="text-link" href={classic} target="_blank" rel="noopener noreferrer">
            Open dashboard in classic UI
          </a>
        </div>
      ) : !supported ? (
        <div className="dashboard-placeholder">
          <p>This chart type isn't available in /next yet</p>
          <pre>{handoff.queries.join('\n\n') || JSON.stringify(tile.chartQuery, null, 2)}</pre>
          <a className="text-link" href={classic} target="_blank" rel="noopener noreferrer">
            Open dashboard in classic UI
          </a>
        </div>
      ) : locked ? (
        <p className="notice">PromQL dashboard tiles are unavailable on this server.</p>
      ) : !ready ? (
        <p className="muted">Select dashboard variables to load this tile.</p>
      ) : (
        <>
          <QueryState loading={results.loading} error={results.error} retry={results.reload} />
          {results.data && (
            <TileChart
              tile={tile}
              result={results.data}
              start={Date.parse(effectiveBounds.startTime) / 1000}
              end={Date.parse(effectiveBounds.endTime) / 1000}
              height={layout.h * 70 - 110}
            />
          )}
        </>
      )}
      <Dialog open={viewQuery} onOpenChange={setViewQuery} title={`Query for ${tileTitle(tile)}`}>
        <div className="stack">
          <pre className="dashboard-query-view">
            {handoff.queries.join('\n\n') || JSON.stringify(tile.chartQuery, null, 2)}
          </pre>
          <p className="muted">Dataset: {handoff.datasets.join(', ') || 'Unresolved'}</p>
          <Button onClick={() => setViewQuery(false)}>Close</Button>
        </div>
      </Dialog>
    </Card>
  );
}
