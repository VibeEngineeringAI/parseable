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
export function hydrateQueryTabs(
  drafts: QueryTab[],
  activeTabs: QueryTab[],
  editedTabs: ReadonlySet<string>,
): QueryTab[] {
  // Each stored draft can hydrate one live tab. Never match against live tabs:
  // identical SQL and ranges do not imply that two tabs are the same tab.
  const remaining = [...drafts];
  const hydrated = activeTabs.map((item) => {
    const index = remaining.findIndex(
      (draft) =>
        draft.query === item.query && JSON.stringify(draft.range) === JSON.stringify(item.range),
    );
    if (index < 0) return item;
    const stored = remaining.splice(index, 1)[0];
    return editedTabs.has(item.id)
      ? { ...item, savedId: item.savedId || stored.savedId }
      : {
          ...item,
          name: stored.name,
          savedId: stored.savedId,
          datasets: stored.datasets,
          chart: stored.chart,
        };
  });
  return [...remaining, ...hydrated];
}
export function datasetQuery(names: string[]): string {
  if (!names.length) return '';
  const source = names
    .map((name) => `SELECT * FROM ${quoteIdentifier(name)}`)
    .join('\nUNION ALL BY NAME\n');
  return `${names.length > 1 ? `SELECT * FROM (\n${source}\n) AS combined` : source}\nORDER BY "p_timestamp" DESC\nLIMIT 100`;
}
