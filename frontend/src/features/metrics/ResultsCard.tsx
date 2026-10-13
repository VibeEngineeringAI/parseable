import { useMemo, useState } from 'react';
import { Button, Card, EmptyState, Spinner, Tabs } from '../../components/ui';
import { TimeSeriesChart } from '../../components/charts/TimeSeriesChart';
import { ApiError, promqlErrorType } from '../../lib/client';
import {
  chartResults,
  instantRows,
  rangeRows,
  type QueryResult,
  type RunSnapshot,
} from './helpers';
import { ResultTable } from './ResultTable';
import type { TimeRange } from '../../lib/types';

const prompt = 'Build or write a PromQL query above to plot the chart.';

type QueryError = QueryResult['errors'][number];

/** Range and instant requests for one query usually fail identically; report that once. */
function groupErrors(errors: QueryError[]) {
  const groups: Array<{ kinds: QueryError['kind'][]; error: Error }> = [];
  for (const { kind, error } of errors) {
    const same = groups.find(
      (group) =>
        group.error.message === error.message &&
        promqlErrorType(group.error) === promqlErrorType(error),
    );
    if (same) same.kinds.push(kind);
    else groups.push({ kinds: [kind], error });
  }
  return groups;
}

export function ResultsCard({
  snapshot,
  results,
  onZoomRange,
  onResetZoom,
}: {
  snapshot?: RunSnapshot;
  results: QueryResult[];
  onZoomRange?: (range: Exclude<TimeRange, string>) => void;
  onResetZoom?: () => void;
}) {
  const [tab, setTab] = useState('chart');
  const count = snapshot?.queries.length ?? 0;
  const names = useMemo(
    () =>
      new Map(
        snapshot?.queries.map((row, index) => [row.id, row.alias?.trim() || `Query ${index + 1}`]),
      ),
    [snapshot],
  );
  const displayResults = useMemo(
    () => results.map((row) => ({ ...row, id: names.get(row.id) ?? row.id })),
    [results, names],
  );
  const chart = useMemo(() => {
    const data = chartResults(results, count);
    return {
      ...data,
      series: data.series.map((series) => {
        const row = snapshot?.queries.find((row) => series.id.startsWith(`${row.id}:`));
        return {
          ...series,
          label:
            row && count > 1
              ? `${names.get(row.id)}: ${series.label.slice(row.id.length + 2)}`
              : series.label,
        };
      }),
    };
  }, [results, count, snapshot, names]);
  const instant = useMemo(() => instantRows(displayResults, count), [displayResults, count]);
  const range = useMemo(() => rangeRows(displayResults, count), [displayResults, count]);
  const pending = snapshot && (!results.length || results.some((row) => row.pending > 0));
  return (
    <Card className="metrics-results-card">
      <div className="panel-heading">
        <h2>Results</h2>
        {onResetZoom && (
          <Button size="sm" onClick={onResetZoom}>
            Reset zoom
          </Button>
        )}
        {pending && (
          <span role="status" className="inline muted">
            <Spinner size={14} />
            Running queries…
          </span>
        )}
      </div>
      {results.flatMap((row) =>
        groupErrors(row.errors).map(({ kinds, error }) => (
          <div className="metrics-query-error" role="alert" key={`${row.id}-${kinds.join('-')}`}>
            <div className="inline wrap">
              <strong>
                {names.get(row.id) ?? row.id} ·{' '}
                {promqlErrorType(error) ??
                  (error instanceof ApiError ? `HTTP ${error.status}` : 'error')}
              </strong>
              <span>
                {kinds.length > 1
                  ? 'Range and instant'
                  : kinds[0] === 'range'
                    ? 'Range'
                    : 'Instant'}
              </span>
              {error instanceof ApiError && error.status === 403 && (
                <strong>Permission denied</strong>
              )}
            </div>
            <pre>{error.message}</pre>
          </div>
        )),
      )}
      <Tabs
        aria-label="Metrics results"
        value={tab}
        onValueChange={setTab}
        items={[
          {
            value: 'chart',
            label: 'Chart',
            content: !snapshot ? (
              <EmptyState title={prompt} />
            ) : snapshot.type === 'instant' ? (
              <EmptyState
                title="The chart needs a range query."
                description="Choose Range or Both to plot results."
              />
            ) : pending && !chart.series.length ? (
              <div className="loading-state">
                <Spinner label="Loading results" />
                Loading results…
              </div>
            ) : (
              <TimeSeriesChart
                timestamps={chart.timestamps}
                series={chart.series}
                title="PromQL range result"
                onZoomRange={onZoomRange}
              />
            ),
          },
          {
            value: 'table',
            label: 'Table',
            content: !snapshot ? (
              <EmptyState title={prompt} />
            ) : (
              <>
                {snapshot.type !== 'range' && (
                  <ResultTable
                    title="Instant results"
                    rows={instant}
                    columns={['Series', 'Value']}
                    empty="No instant results"
                    loading={Boolean(pending)}
                  />
                )}
                {snapshot.type !== 'instant' && (
                  <ResultTable
                    title="Range summary"
                    rows={range}
                    columns={['Series', 'Last', 'Min', 'Max', 'Avg']}
                    empty="No data"
                    loading={Boolean(pending)}
                  />
                )}
              </>
            ),
          },
        ]}
      />
    </Card>
  );
}
