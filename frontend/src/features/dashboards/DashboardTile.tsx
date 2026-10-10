import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ActionsMenu, Button, Card, Dialog } from '../../components/ui';
import { ExternalLink } from 'lucide-react';
import { classicUiAvailable, classicUiPath } from '../../lib/classicUi';
import { useApp } from '../../app/AppProvider';
import { useAsync } from '../../hooks/useAsync';
import { timeBounds } from '../../lib/query';
import type { QueryLimiter } from '../../lib/concurrency';
import type { DashboardTile as Tile, DashboardVariable, QueryRequest } from '../../lib/types';
import { TileChart } from './TileChart';
import { loadTile, type TileResults } from './queries';
import {
  knownTile,
  supportedCharts,
  text,
  tileTitle,
  tileType,
  tileVariableNames,
  record,
  promqlQueries,
  storedStep,
  sqlQuery,
  tileDatasets,
  type TileLayout,
} from './tiles';
import { storedRange } from './timeRange';
import { tileHandoffs } from './handoffs';
import type { VariableValues } from './variables';
const typeLabel = (value: unknown) => {
  const name = text(value) || 'Unknown';
  return name.toLowerCase() === 'ai' ? 'AI' : name.charAt(0).toUpperCase() + name.slice(1);
};
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
  variableError,
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
  variableError?: string;
  writable: boolean;
  promqlEnabled?: boolean;
  promqlAlerts: boolean;
  limit: QueryLimiter;
  first: boolean;
  last: boolean;
  onAction: (action: 'edit' | 'duplicate' | 'earlier' | 'later' | 'delete', tile: Tile) => void;
}) {
  const { client, mode } = useApp(),
    navigate = useNavigate();
  const [viewQuery, setViewQuery] = useState(false);
  const supported = knownTile(tile) && supportedCharts.includes(text(tile.chartType, 'timeseries'));
  const locked = tile.tileType === 'promql' && promqlEnabled !== true;
  const effectiveBounds = useMemo(
    () => (tile.timeRange ? timeBounds(storedRange(tile.timeRange, anchor), anchor) : bounds),
    [JSON.stringify(tile.timeRange), anchor, bounds.startTime, bounds.endTime],
  );
  const names = tileVariableNames(tile, variables);
  let query: unknown;
  try {
    query = tile.tileType === 'promql' ? promqlQueries(tile) : sqlQuery(tile);
  } catch (error) {
    query = error instanceof Error ? error.message : String(error);
  }
  const inputKey = JSON.stringify({
    query,
    datasets: tileDatasets(tile),
    values: [...names].map((name) => [name, values[name]]),
    datasetVariables: variables
      .filter((variable) => names.has(variable.name) && variable.type === 'dataset')
      .map((variable) => variable.name),
    ...(tile.tileType === 'promql'
      ? {
          stat: tile.chartType === 'query-value',
          step: storedStep(tile),
          maxDataPoints:
            record(tile.config).maxDataPoints ?? record(record(tile.config).layout).maxDataPoints,
        }
      : {}),
    start: effectiveBounds.startTime,
    end: effectiveBounds.endTime,
    revision,
    supported,
    locked,
    ready,
  });
  const results = useAsync(
    useCallback(
      (signal) =>
        supported && !locked && ready
          ? loadTile(client, tile, variables, values, effectiveBounds, limit, signal)
          : Promise.resolve(undefined),
      [client, limit, inputKey],
    ),
  );
  const [lastResult, setLastResult] = useState<TileResults>();
  useEffect(() => {
    if (results.data) setLastResult(results.data);
  }, [results.data]);
  const result = results.data ?? lastResult;
  const handoff = tileHandoffs(tile, variables, values, effectiveBounds, promqlAlerts);
  const classic =
    classicUiAvailable && mode !== 'demo'
      ? classicUiPath(`/dashboards/${encodeURIComponent(dashboardId)}`)
      : undefined;
  const classicLink = classic && (
    <a className="text-link" href={classic} target="_blank" rel="noopener noreferrer">
      Open in classic UI <ExternalLink size={14} aria-hidden="true" />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
  return (
    <Card
      className="dashboard-server-tile"
      role="region"
      aria-label={`Tile ${tileTitle(tile)}`}
      aria-busy={supported && !locked && ready && results.loading}
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
          data-row-action={tile.tile_id}
          items={[
            ...(writable && knownTile(tile)
              ? [
                  {
                    id: 'edit',
                    label: tileType(tile) === 'builder' ? 'Edit as SQL' : 'Edit',
                    description: locked
                      ? promqlEnabled === undefined
                        ? 'Loading server capabilities.'
                        : 'PromQL dashboard tiles are unavailable on this server.'
                      : undefined,
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
      <div className="dashboard-tile-body">
        {!knownTile(tile) ? (
          <div className="dashboard-placeholder">
            <p>
              {typeLabel(tile.tileType)} tiles cannot be shown in /next. The tile is kept unchanged.
            </p>
            {classicLink}
          </div>
        ) : !supported ? (
          <div className="dashboard-placeholder">
            <p>
              {typeLabel(tile.chartType)} charts are not available in /next yet. The tile is kept
              unchanged.
            </p>
            <pre>{handoff.queries.join('\n\n') || JSON.stringify(tile.chartQuery, null, 2)}</pre>
            {classicLink}
          </div>
        ) : locked ? (
          <p className="notice">
            {promqlEnabled === undefined
              ? 'Loading server capabilities…'
              : 'PromQL dashboard tiles are unavailable on this server.'}
          </p>
        ) : !ready && (!lastResult || variableError) ? (
          <p className="muted">
            {variableError
              ? `A variable failed to load: ${variableError}`
              : 'Select a value for this tile’s dashboard variables.'}
          </p>
        ) : (
          <>
            {results.loading && <p className="muted">Loading tile…</p>}
            {results.error && (
              <div className="dashboard-tile-error">
                <p className="error-text">Query failed: {results.error.message}</p>
                <div className="inline">
                  <Button size="sm" onClick={results.reload}>
                    Retry query
                  </Button>
                  <Button size="sm" onClick={() => setViewQuery(true)}>
                    View query
                  </Button>
                </div>
              </div>
            )}
            {result && !results.error && (
              <TileChart
                tile={tile}
                result={result}
                start={Date.parse(effectiveBounds.startTime) / 1000}
                end={Date.parse(effectiveBounds.endTime) / 1000}
                height="fit"
              />
            )}
          </>
        )}
      </div>
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
