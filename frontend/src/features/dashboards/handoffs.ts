import type { DashboardTile, DashboardVariable, QueryRequest } from '../../lib/types';
import { knownTile, promqlQueries, sqlQuery, tileDatasets, tileTitle } from './tiles';
import {
  hasAllSelection,
  interpolatePromql,
  interpolateSql,
  resolveDataset,
  type VariableValues,
} from './variables';
export function tileHandoffs(
  tile: DashboardTile,
  variables: DashboardVariable[],
  values: VariableValues,
  bounds: Omit<QueryRequest, 'sql'>,
  promqlAlerts: boolean,
) {
  const datasets = tileDatasets(tile).map((dataset) => resolveDataset(dataset, values));
  const isPromql = tile.tileType === 'promql';
  let original: string[] = [];
  try {
    original = isPromql ? promqlQueries(tile).map((row) => row.query) : [sqlQuery(tile)];
  } catch {
    /* Unknown legacy queries remain visible in classic. */
  }
  const queries = original.map((query) =>
    isPromql ? interpolatePromql(query, values) : interpolateSql(query, values, variables),
  );
  const unresolved =
    queries.some((query) => /\$\{?\w+\}?/.test(query)) ||
    datasets.some((dataset) => !dataset || /\$\{?\w+\}?/.test(dataset));
  const all = hasAllSelection(variables, values, original.join(' '), tileDatasets(tile).join(' '));
  const reason = !knownTile(tile)
    ? 'This tile type is read-only.'
    : isPromql && !promqlAlerts
      ? 'PromQL alerts are unavailable on this server.'
      : all
        ? 'Select explicit variable values instead of All to create an alert.'
        : datasets.length !== 1 ||
            (isPromql && queries.length !== 1) ||
            unresolved ||
            !queries[0]?.trim()
          ? 'Alerts require one concrete query and dataset.'
          : undefined;
  const alertParams = new URLSearchParams({
    dataset: datasets[0] ?? '',
    queryBuilderType: isPromql ? 'promql' : 'sql',
    alertQuery: queries[0] ?? '',
    title: tileTitle(tile),
  });
  const exploreParams = new URLSearchParams();
  for (const query of queries) exploreParams.append('query', query);
  if (isPromql) {
    const types = promqlQueries(tile).map((row) => row.type);
    exploreParams.set(
      'type',
      types.every((type) => type === types[0]) ? (types[0] ?? 'range') : 'both',
    );
    exploreParams.set('start', bounds.startTime);
    exploreParams.set('end', bounds.endTime);
  }
  return {
    alertUrl: reason ? undefined : `/alerts/new?${alertParams}`,
    reason,
    exploreUrl:
      knownTile(tile) && queries.length && datasets[0] && !unresolved
        ? isPromql
          ? `/metrics/explore/${encodeURIComponent(datasets[0])}?${exploreParams}`
          : `/sql-editor?${exploreParams}`
        : undefined,
    queries,
    datasets,
  };
}
