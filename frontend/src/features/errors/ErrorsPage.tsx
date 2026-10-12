import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import { useApp } from '../../app/AppProvider';
import { useAsync } from '../../hooks/useAsync';
import { PageHeader } from '../../components/explorer/PageHeader';
import { QueryState } from '../../components/explorer/QueryState';
import { Badge, Button, EmptyState, Select, Tabs } from '../../components/ui';
import { TRACE_PAGE_SIZE } from '../traces/helpers';
import { TraceTable } from '../traces/TraceTable';
import { TimeRangePicker } from '../../components/explorer/TimeRangePicker';
import { apmBoundsFromParams, apmRangeFromParams, resolveApmRoute } from '../../lib/apm';
import { ApiError } from '../../lib/apiError';
import {
  discoverErrorDatasets,
  loadErrorSchema,
  UnsupportedErrorSchema,
  type ErrorBounds,
  type ErrorSchema,
} from '../../lib/errorAnalytics';
import { timeBounds } from '../../lib/query';
import type { TimeRange, TraceSortBy } from '../../lib/types';
import { ErrorIssues } from './ErrorIssues';
import '../traces/traces.css';
import './errors.css';

const APPLIED_PARAMS = ['start', 'end', 'range', 'view'];

export function ErrorsUnavailable({ dataset, reason }: { dataset?: string; reason?: string }) {
  return (
    <EmptyState
      title="No eligible error dataset"
      description={
        dataset
          ? `Errors cannot be analyzed in ${dataset}.${reason ? ` ${reason}.` : ''} Explore its logs to investigate application errors.`
          : 'Errors need a log dataset with a severity level field, or a trace dataset ingested with the otel-traces source format.'
      }
      action={
        <Link
          className="ui-button"
          to={dataset ? `/logs/explore/${encodeURIComponent(dataset)}` : '/logs'}
        >
          Explore logs
        </Link>
      }
    />
  );
}

function ErrorSpans({ dataset, bounds }: { dataset: string; bounds: ErrorBounds }) {
  const { client } = useApp();
  const navigate = useNavigate();
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<TraceSortBy>('mostRecent');
  const result = useAsync(
    useCallback(
      (signal) =>
        client.listTraces(
          {
            dataset,
            ...bounds,
            options: 'errorSpans',
            sortBy: sort,
            offset: page * TRACE_PAGE_SIZE,
            limit: TRACE_PAGE_SIZE,
          },
          signal,
        ),
      [client, dataset, bounds, page, sort],
    ),
  );
  return (
    <>
      <p className="errors-caption">
        Individual error spans, {TRACE_PAGE_SIZE} per page. Open one to see its whole trace.
      </p>
      <QueryState loading={result.loading} error={result.error} retry={result.reload} />
      {result.data &&
        (result.data.records.length ? (
          <TraceTable
            data={result.data}
            sort={sort}
            onSort={(value) => {
              setPage(0);
              setSort(value);
            }}
            onPage={setPage}
            noun="error spans"
            onSelect={(row) =>
              navigate(
                `/traces/explore/${encodeURIComponent(dataset)}?${new URLSearchParams({ traceId: row.span_trace_id, start: bounds.startTime, end: bounds.endTime })}`,
              )
            }
          />
        ) : (
          <EmptyState
            title="No error spans"
            description="No matching error spans were found in the selected time range."
          />
        ))}
    </>
  );
}

/** Explains why a dataset outside the discovered list cannot be analyzed, without
 * hiding permission or transport failures behind an "unsupported" message. */
function DatasetUnavailable({ dataset }: { dataset: string }) {
  const { client } = useApp();
  const check = useAsync(
    useCallback((signal) => loadErrorSchema(client, dataset, signal), [client, dataset]),
  );
  if (check.loading) return <QueryState loading />;
  const unsupported = check.error instanceof UnsupportedErrorSchema;
  const missing = check.error instanceof ApiError && check.error.status === 404;
  if (check.error && !unsupported && !missing)
    return <QueryState loading={false} error={check.error} retry={check.reload} />;
  return (
    <ErrorsUnavailable dataset={dataset} reason={unsupported ? check.error?.message : undefined} />
  );
}

function ErrorDataset({
  dataset,
  schema,
  bounds,
  view,
  onView,
}: {
  dataset: string;
  schema: ErrorSchema;
  bounds: ErrorBounds;
  view: string;
  onView: (view: string) => void;
}) {
  const issues = <ErrorIssues dataset={dataset} schema={schema} bounds={bounds} />;
  if (schema.source !== 'traces') return issues;
  return (
    <Tabs
      aria-label="Error views"
      value={view === 'spans' ? 'spans' : 'issues'}
      onValueChange={onView}
      items={[
        { value: 'issues', label: 'Issues', content: issues },
        {
          value: 'spans',
          label: 'Error spans',
          content: <ErrorSpans dataset={dataset} bounds={bounds} />,
        },
      ]}
    />
  );
}

export function ErrorsPage() {
  const { client, mode } = useApp();
  const location = useLocation();
  // Router params decode %2F before matching; decode the raw segment exactly once.
  const { dataset } = resolveApmRoute(location.pathname);
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const [refreshRevision, setRefreshRevision] = useState(0);
  const searchString = params.toString();
  const bounds = useMemo(
    () => apmBoundsFromParams(new URLSearchParams(searchString)),
    [searchString],
  );
  const range = useMemo(
    () => apmRangeFromParams(new URLSearchParams(searchString)),
    [searchString],
  );
  // Capture a relative range once so paging, sorting, details and handoffs share it.
  useEffect(() => {
    if (params.get('start') && params.get('end')) return;
    const next = new URLSearchParams(params);
    next.set('start', bounds.startTime);
    next.set('end', bounds.endTime);
    if (typeof range === 'string') next.set('range', range);
    setParams(next, { replace: true });
  }, [params, bounds, range, setParams]);
  const discovery = useAsync(
    useCallback((signal) => discoverErrorDatasets(client, signal), [client]),
    { keepPreviousData: true },
  );
  const changeRange = (value: TimeRange) => {
    const captured = timeBounds(value),
      next = new URLSearchParams(params);
    next.set('start', captured.startTime);
    next.set('end', captured.endTime);
    if (typeof value === 'string') next.set('range', value);
    else next.delete('range');
    setParams(next);
  };
  const refresh = () => {
    changeRange(range);
    setRefreshRevision((revision) => revision + 1);
  };
  const changeView = (view: string) => {
    const next = new URLSearchParams(params);
    if (view === 'issues') next.delete('view');
    else next.set('view', view);
    setParams(next, { replace: true });
  };
  const datasets = discovery.data?.datasets ?? [];
  const selected = dataset ?? datasets[0]?.name;
  const entry = datasets.find((candidate) => candidate.name === selected);
  const unapplied = [
    ...new Set(
      [...params.keys()].filter(
        (key) =>
          !APPLIED_PARAMS.includes(key) ||
          (key === 'view' &&
            (entry?.source === 'logs'
              ? params.get('view') !== 'issues'
              : !['issues', 'spans'].includes(params.get('view') ?? ''))),
      ),
    ),
  ];
  return (
    <div className="page errors-page">
      <PageHeader
        title="Errors"
        description="Find the errors that happen most often and see when they occur."
        actions={mode === 'demo' ? <Badge>Sample data</Badge> : undefined}
      />
      {unapplied.length > 0 && (
        <p role="status" className="notice">
          This link includes options that are not applied here: {unapplied.join(', ')}.
        </p>
      )}
      <div className="errors-controls">
        <Select
          className="errors-dataset"
          label="Dataset"
          value={entry ? entry.name : ''}
          disabled={!discovery.data}
          onChange={(event) =>
            navigate(
              `/errors/${encodeURIComponent(event.target.value)}${params.size ? `?${params}` : ''}`,
            )
          }
        >
          <option value="" disabled>
            Select dataset
          </option>
          {datasets.map((candidate) => (
            <option key={candidate.name} value={candidate.name}>
              {candidate.name} ({candidate.source === 'traces' ? 'traces' : 'logs'})
            </option>
          ))}
        </Select>
        <TimeRangePicker value={range} onChange={changeRange} />
        <Button variant="secondary" onClick={refresh}>
          <RefreshCw size={14} aria-hidden="true" /> Refresh
        </Button>
      </div>
      <QueryState loading={discovery.loading} error={discovery.error} retry={discovery.reload} />
      {discovery.data?.unchecked.length ? (
        <p role="status" className="notice">
          Could not check datasets: {discovery.data.unchecked.join(', ')}.{' '}
          <Button variant="ghost" onClick={discovery.reload}>
            Check again
          </Button>
        </p>
      ) : null}
      {discovery.data &&
        (entry ? (
          <ErrorDataset
            key={`${entry.name}:${bounds.startTime}:${bounds.endTime}:${refreshRevision}`}
            dataset={entry.name}
            schema={entry.schema}
            bounds={bounds}
            view={params.get('view') ?? 'issues'}
            onView={changeView}
          />
        ) : selected && discovery.data.unchecked.includes(selected) ? (
          <EmptyState
            title="Could not verify dataset"
            description={`Could not check whether ${selected} can be analyzed for errors. Dataset details are temporarily unavailable.`}
            action={<Button onClick={discovery.reload}>Retry dataset verification</Button>}
          />
        ) : dataset ? (
          <DatasetUnavailable key={dataset} dataset={dataset} />
        ) : (
          <ErrorsUnavailable />
        ))}
    </div>
  );
}
