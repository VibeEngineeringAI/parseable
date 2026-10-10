import type { DashboardTile } from '../../lib/types';
import { promqlQueries, sqlQuery, tileDatasets } from './tiles';

export function convertBuilder(tile: DashboardTile): DashboardTile {
  const chartQuery = sqlQuery(tile);
  if (!chartQuery.trim())
    throw new Error('This builder query cannot be converted faithfully to SQL.');
  return { ...tile, tileType: 'code', chartQuery, dbName: tileDatasets(tile) };
}
export function setQueryLanguage(tile: DashboardTile, language: 'code' | 'promql'): DashboardTile {
  if (tile.tileType === language) return tile;
  const next = { ...tile };
  if (tile.tileType === 'promql')
    for (const key of ['promqlQueryType', 'promqlStep', 'promqlQuery']) delete next[key];
  // These query/dataset fields are shared and are replaced with the new language's shapes.
  return {
    ...next,
    tileType: language,
    chartQuery: language === 'promql' ? [''] : '',
    dbName: language === 'promql' ? '' : [],
    ...(language === 'promql' ? { promqlQueryType: ['range'] } : {}),
  };
}
export function addPromqlQuery(tile: DashboardTile): DashboardTile {
  const rows = promqlQueries(tile);
  return {
    ...tile,
    chartQuery: [...rows.map((row) => row.query), ''],
    promqlQueryType: [...rows.map((row) => row.type), 'range'],
  };
}
export function removePromqlQuery(tile: DashboardTile, index: number): DashboardTile {
  const rows = promqlQueries(tile).filter((_, i) => i !== index);
  return {
    ...tile,
    chartQuery: rows.map((row) => row.query),
    promqlQueryType: rows.map((row) => row.type),
  };
}
