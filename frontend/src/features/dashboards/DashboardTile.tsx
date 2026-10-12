import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ActionsMenu, Button, Card, Dialog } from '../../components/ui';
import { ExternalLink } from 'lucide-react';
import { classicUiAvailable, classicUiPath } from '../../lib/classicUi';
import { useApp } from '../../app/AppProvider';
import { useDashboardQuery } from './DashboardRefresh';
import { timeBounds } from '../../lib/query';
import type { QueryLimiter } from '../../lib/concurrency';
import type {
  DashboardTile as Tile,
  DashboardVariable,
  QueryRequest,
  TimeRange,
} from '../../lib/types';
import { TileChart } from './TileChart';
import type { TimeSeriesChartProps } from '../../components/charts/TimeSeriesChart';
import { loadTile, type TileResults } from './queries';
import {
  instantCharts,
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
import { sparklineEnabled } from './queryValue';
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
  range,
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
  onZoomRange,
}: {
  tile: Tile;
  layout: TileLayout;
  dashboardId: string;
  variables: DashboardVariable[];
  values: VariableValues;
  bounds: Omit<QueryRequest, 'sql'>;
  range: TimeRange;
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
  onZoomRange?: TimeSeriesChartProps['onZoomRange'];
}) {
  const { client, mode } = useApp(),
    navigate = useNavigate();
  const [viewQuery, setViewQuery] = useState(false);
  const supported = knownTile(tile) && supportedCharts.includes(text(tile.chartType, 'timeseries'));
  const unavailable = tile.tileType === 'promql' && tile.chartType === 'bubble';
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
  const queryInputs = {
    query,
    datasets: tileDatasets(tile),
    values: [...names].map((name) => [name, values[name]]),
    datasetVariables: variables
      .filter((variable) => names.has(variable.name) && variable.type === 'dataset')
      .map((variable) => variable.name),
    ...(tile.tileType === 'promql'
      ? {
          stat: instantCharts.includes(text(tile.chartType)),
          sparkline: sparklineEnabled(tile),
          step: storedStep(tile),
          maxDataPoints:
            record(tile.config).maxDataPoints ?? record(record(tile.config).layout).maxDataPoints,
        }
      : {}),
  };
  // Refreshing a rolling range may reuse a successful snapshot, but changing
  // the query, selection, or range definition must never show unrelated data.
  const resultKey = JSON.stringify({ ...queryInputs, range: tile.timeRange ?? range });
  const inputKey = JSON.stringify({
    ...queryInputs,
    resultKey,
    start: effectiveBounds.startTime,
    end: effectiveBounds.endTime,
    revision,
    supported,
    unavailable,
    locked,
    ready,
  });
  const results = useDashboardQuery(
    useCallback(
      (signal) =>
        supported && !unavailable && !locked && ready
          ? loadTile(client, tile, variables, values, effectiveBounds, limit, signal).then(
              (result) => ({
                result,
                client,
                key: resultKey,
                bounds: effectiveBounds,
                updated: Date.now(),
              }),
            )
          : Promise.resolve(undefined),
      [client, limit, inputKey],
    ),
    { key: JSON.stringify([resultKey, supported, unavailable, locked]), scope: client },
  );
  const [lastResult, setLastResult] = useState<{
    result: TileResults;
    client: typeof client;
    key: string;
    bounds: typeof effectiveBounds;
    updated: number;
  }>();
  useEffect(() => {
    if (results.data) setLastResult(results.data);
  }, [results.data]);
  const result =
    results.data ??
    (lastResult?.key === resultKey && lastResult.client === client ? lastResult : undefined);
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
      aria-busy={supported && !unavailable && !locked && ready && results.loading}
      data-tile-id={tile.tile_id}
      style={{
        gridColumn: `${layout.x + 1} / span ${layout.w}`,
        gridRow: `${layout.y + 1} / span ${layout.h}`,
      }}
    >
      <div className="panel-heading dashboard-tile-heading">
        <h2>{tileTitle(tile)}</h2>
        {result && (
          <span className="muted dashboard-tile-updated">
            Updated{' '}
            <time
              dateTime={new Date(result.updated).toISOString()}
              title={new Date(result.updated).toLocaleString()}
            >
              {new Date(result.updated).toLocaleTimeString()}
            </time>
          </span>
        )}
        <ActionsMenu
          label={`Actions for tile ${tileTitle(tile)}`}
          data-row-action={tile.tile_id}
          items={[
            ...(writable && knownTile(tile)
              ? [
                  {
                    id: 'edit',
                    label: 'Edit',
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
              {typeLabel(tile.tileType)} tiles cannot be shown in this UI. The tile is kept
              unchanged.
            </p>
            {classicLink}
          </div>
        ) : !supported ? (
          <div className="dashboard-placeholder">
            <p>
              {typeLabel(tile.chartType)} charts are not available in this UI yet. The tile is kept
              unchanged.
            </p>
            <pre>{handoff.queries.join('\n\n') || JSON.stringify(tile.chartQuery, null, 2)}</pre>
            {classicLink}
          </div>
        ) : unavailable ? (
          <TileChart
            tile={tile}
            result={{}}
            start={Date.parse(effectiveBounds.startTime) / 1000}
            end={Date.parse(effectiveBounds.endTime) / 1000}
            height="fit"
          />
        ) : locked ? (
          <p className="notice">
            {promqlEnabled === undefined
              ? 'Loading server capabilities…'
              : 'PromQL dashboard tiles are unavailable on this server.'}
          </p>
        ) : !ready && !result ? (
          <p className="muted">
            {variableError
              ? `A variable failed to load: ${variableError}`
              : 'Select a value for this tile’s dashboard variables.'}
          </p>
        ) : (
          <>
            {!ready && (
              <p className={variableError ? 'error-text' : 'muted'}>
                {variableError
                  ? `A variable failed to load: ${variableError}. Showing last successful data.`
                  : 'Waiting for dashboard variables. Showing last successful data.'}
              </p>
            )}
            {results.loading && (
              <p className="muted">{result ? 'Refreshing tile…' : 'Loading tile…'}</p>
            )}
            {results.error && (
              <div className="dashboard-tile-error">
                <p className="error-text">
                  {result ? 'Refresh failed' : 'Query failed'}:{' '}
                  {results.error.message.trim().replace(/\.$/, '')}
                  {result ? '. Showing last successful data.' : ''}
                </p>
                <div className="inline">
                  <Button size="sm" disabled={results.loading} onClick={results.reload}>
                    Retry query
                  </Button>
                  <Button size="sm" onClick={() => setViewQuery(true)}>
                    View query
                  </Button>
                </div>
              </div>
            )}
            {/* Keep chart state (zoom announcements and keyboard focus) during
                loading, but clear data from a different query or range. */}
            {(result || (results.loading && lastResult?.client === client)) && (
              <TileChart
                tile={tile}
                result={result?.result ?? {}}
                start={Date.parse((result?.bounds ?? effectiveBounds).startTime) / 1000}
                end={Date.parse((result?.bounds ?? effectiveBounds).endTime) / 1000}
                height="fit"
                onZoomRange={onZoomRange}
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
