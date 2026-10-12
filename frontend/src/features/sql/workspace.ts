import type { LogRecord, QueryRequest, TimeRange } from '../../lib/types';
import { createSqlChartConfig, type SqlChartConfig } from './sqlChart';
import { quoteIdentifier } from '../../lib/query';
export type QueryTab = {
  id: string;
  savedId?: string;
  name: string;
  query: string;
  range: TimeRange;
  datasets: string[];
  rows: LogRecord[];
  request?: QueryRequest;
  loading: boolean;
  error?: Error;
  columns?: string[];
  wrap: boolean;
  view: 'results' | 'chart';
  chart: SqlChartConfig;
  elapsed?: number;
  canceled?: boolean;
};
export function createQueryTab(name: string, query = '', range: TimeRange = '1h'): QueryTab {
  return {
    id: crypto.randomUUID(),
    name,
    query,
    range,
    datasets: [],
    rows: [],
    loading: false,
    wrap: false,
    view: 'results',
    chart: createSqlChartConfig(),
  };
}
export function datasetQuery(names: string[]): string {
  if (!names.length) return '';
  const source = names
    .map((name) => `SELECT * FROM ${quoteIdentifier(name)}`)
    .join('\nUNION ALL BY NAME\n');
  return `${names.length > 1 ? `SELECT * FROM (\n${source}\n) AS combined` : source}\nORDER BY "p_timestamp" DESC\nLIMIT 100`;
}
