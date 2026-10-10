import type { QueryLimiter } from '../../lib/concurrency';
import type {
  DashboardTile,
  DashboardVariable,
  ParseableClient,
  QueryRequest,
  LogRecord,
} from '../../lib/types';
import type { QueryResult } from '../../lib/promqlResults';
import { promqlQueries, sqlQuery, tileDatasets, tileStep } from './tiles';
import {
  interpolatePromql,
  interpolateSql,
  resolveDataset,
  type VariableValues,
} from './variables';
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
  if (tile.tileType !== 'promql') {
    const sql = interpolateSql(sqlQuery(tile), values, variables);
    if (/\$\{?\w+\}?/.test(sql)) throw new Error('Select values for all query variables.');
    if (!sql.trim()) throw new Error('This tile has no SQL query.');
    return { rows: await limit(() => client.query({ sql, ...bounds }, signal), signal) };
  }
  const stream = resolveDataset(tileDatasets(tile)[0] ?? '', values),
    queries = promqlQueries(tile);
  if (!stream || /\$\{?\w+\}?/.test(stream)) throw new Error('Select a dataset for this tile.');
  if (!queries.length) throw new Error('This tile has no PromQL query.');
  const start = Date.parse(bounds.startTime) / 1000,
    end = Date.parse(bounds.endTime) / 1000;
  const promql = await Promise.all(
    queries.map(async ({ query: template, type }, index): Promise<QueryResult> => {
      const query = interpolatePromql(template, values);
      if (/\$\{?\w+\}?/.test(query)) throw new Error('Select values for all query variables.');
      const stat = tile.chartType === 'query-value';
      const [range, instant] = await Promise.all([
        !stat && type !== 'instant'
          ? limit(
              () =>
                client.promqlQueryRange(
                  { stream, query, start, end, step: tileStep(tile, start, end, query) },
                  signal,
                ),
              signal,
            )
          : undefined,
        stat || type !== 'range'
          ? limit(() => client.promqlQuery({ stream, query, time: end }, signal), signal)
          : undefined,
      ]);
      return { id: String.fromCharCode(65 + index), pending: 0, errors: [], range, instant };
    }),
  );
  return { promql };
}
