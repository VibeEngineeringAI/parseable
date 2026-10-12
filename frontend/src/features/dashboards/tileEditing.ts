import { newBuilderQuery } from './builder';
import type { DashboardTile } from '../../lib/types';
import {
  promqlQueries,
  sqlQuery,
  storedStep,
  tileDatasets,
  tileType,
  type QueryMode,
} from './tiles';

export function convertBuilder(tile: DashboardTile): DashboardTile {
  const chartQuery = sqlQuery(tile);
  if (!chartQuery.trim())
    throw new Error('This builder query cannot be converted faithfully to SQL.');
  return { ...tile, tileType: 'code', chartQuery, dbName: tileDatasets(tile) };
}
export function setQueryLanguage(
  tile: DashboardTile,
  language: 'code' | 'promql' | 'builder',
): DashboardTile {
  if (tileType(tile) === language) return tile;
  if (language === 'code' && tileType(tile) === 'builder') return convertBuilder(tile);
  const next = { ...tile };
  if (tileType(tile) === 'promql')
    for (const key of ['promqlQueryType', 'promqlStep', 'promqlQuery']) delete next[key];
  // These query/dataset fields are shared and are replaced with the new language's shapes.
  return {
    ...next,
    tileType: language,
    chartQuery:
      language === 'promql' ? [''] : language === 'builder' ? newBuilderQuery(tile.chartType) : '',
    dbName: language === 'promql' ? '' : tileType(tile) === 'promql' ? [] : tileDatasets(tile),
    ...(language === 'promql' ? { promqlQueryType: ['range'] } : {}),
  };
}
/** Write PromQL rows in the array shape, keeping a legacy object's step in promqlStep. */
export function promqlRows(
  tile: DashboardTile,
  rows: Array<{ query: string; type: QueryMode }>,
): Partial<DashboardTile> {
  const step = storedStep(tile);
  return {
    chartQuery: rows.map((row) => row.query),
    promqlQueryType: rows.map((row) => row.type),
    ...(step === undefined ? {} : { promqlStep: step }),
  };
}
export function addPromqlQuery(tile: DashboardTile): DashboardTile {
  return { ...tile, ...promqlRows(tile, [...promqlQueries(tile), { query: '', type: 'range' }]) };
}
export function removePromqlQuery(tile: DashboardTile, index: number): DashboardTile {
  return {
    ...tile,
    ...promqlRows(
      tile,
      promqlQueries(tile).filter((_, i) => i !== index),
    ),
  };
}
