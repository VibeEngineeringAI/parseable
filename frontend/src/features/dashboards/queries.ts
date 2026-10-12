import type { QueryLimiter } from '../../lib/concurrency';
import type {
  DashboardTile,
  DashboardVariable,
  ParseableClient,
  QueryRequest,
  LogRecord,
} from '../../lib/types';
import type { QueryResult } from '../../lib/promqlResults';
import { sparklineEnabled } from './queryValue';
import { withQueryTimeout } from './queryTimeout';
import {
  instantCharts,
  promqlQueries,
  sqlQuery,
  text,
  tileDatasets,
  tileStep,
  tileVariableNames,
} from './tiles';
import {
  interpolatePromql,
  interpolateSql,
  resolveDataset,
  type VariableValues,
} from './variables';
// A failed branch must not release the refresh cycle while sibling requests
// are still running (for example, an instant query alongside its sparkline).
async function settled<T extends readonly unknown[]>(
  promises: T,
): Promise<{ [K in keyof T]: Awaited<T[K]> }> {
  const results = await Promise.allSettled(promises);
  const failure = results.find((result) => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
  return results.map((result) => (result as PromiseFulfilledResult<unknown>).value) as {
    [K in keyof T]: Awaited<T[K]>;
  };
}
export type TileResults = { rows?: LogRecord[]; promql?: QueryResult[] };
export async function loadTile(
  client: ParseableClient,
  tile: DashboardTile,
  variables: DashboardVariable[],
  values: VariableValues,
  bounds: Omit<QueryRequest, 'sql'>,
  limit: QueryLimiter,
  signal: AbortSignal,
): Promise<TileResults> {
  if (
    [...tileVariableNames(tile, variables)].some(
      (name) =>
        !Object.hasOwn(values, name) || (Array.isArray(values[name]) && !values[name].length),
    )
  )
    throw new Error('Select values for all query variables.');
  const request = <T>(operation: (requestSignal: AbortSignal) => Promise<T>) =>
    limit(() => withQueryTimeout(operation, signal), signal);
  if (tile.tileType !== 'promql') {
    const sql = interpolateSql(sqlQuery(tile), values, variables);
    if (!sql.trim()) throw new Error('This tile has no SQL query.');
    return {
      rows: await request((requestSignal) => client.query({ sql, ...bounds }, requestSignal)),
    };
  }
  const stream = resolveDataset(tileDatasets(tile)[0] ?? '', values),
    queries = promqlQueries(tile);
  if (!stream) throw new Error('Select a dataset for this tile.');
  if (!queries.length) throw new Error('This tile has no PromQL query.');
  const start = Date.parse(bounds.startTime) / 1000,
    end = Date.parse(bounds.endTime) / 1000;
  const promql = await settled(
    queries.map(async ({ query: template, type }, index): Promise<QueryResult> => {
      const query = interpolatePromql(template, values);
      const stat = instantCharts.includes(text(tile.chartType));
      const sparkline = index === 0 && sparklineEnabled(tile);
      const [range, instant] = await settled([
        sparkline || (!stat && type !== 'instant')
          ? request((requestSignal) =>
              client.promqlQueryRange(
                { stream, query, start, end, step: tileStep(tile, start, end, query) },
                requestSignal,
              ),
            )
          : undefined,
        stat || type !== 'range'
          ? request((requestSignal) =>
              client.promqlQuery({ stream, query, time: end }, requestSignal),
            )
          : undefined,
      ] as const);
      return { id: String.fromCharCode(65 + index), pending: 0, errors: [], range, instant };
    }),
  );
  return { promql };
}
