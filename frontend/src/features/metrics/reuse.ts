import { createUlid } from '../../lib/ids';
import type { DashboardTile } from '../../lib/types';
import { newTile } from '../dashboards/tiles';
import type { QueryResult, RunSnapshot } from './helpers';

export function executedMetricTile(
  snapshot: RunSnapshot,
  id: string,
  title: string,
): DashboardTile {
  const row = snapshot.queries.find((query) => query.id === id);
  if (!row) throw new Error('Select an executed query.');
  return {
    ...newTile([]),
    tile_id: createUlid(),
    title: title.trim(),
    tileType: 'promql',
    chartType: snapshot.type === 'instant' ? 'table' : 'line',
    dbName: [snapshot.stream],
    chartQuery: [row.query],
    promqlQueryType: [snapshot.type === 'instant' ? 'instant' : 'range'],
    promqlStep: row.resolvedStep,
  };
}
export function metricAlertHandoff(
  snapshot: RunSnapshot,
  id: string,
  result?: QueryResult,
): { url?: string; reason?: string } {
  const row = snapshot.queries.find((query) => query.id === id);
  if (!row || !result || result.pending) return { reason: 'Select a completed executed query.' };
  if (result.instant?.resultType !== 'vector')
    return {
      reason: 'Run this query as Instant or Both and return an instant vector to create an alert.',
    };
  const params = new URLSearchParams({
    dataset: snapshot.stream,
    queryBuilderType: 'promql',
    alertQuery: row.query,
    title: row.alias?.trim() || 'Metric threshold',
  });
  return { url: `/alerts/new?${params}` };
}
