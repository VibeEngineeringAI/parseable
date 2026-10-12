import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Link,
  Navigate,
  useNavigate,
  useNavigationType,
  useParams,
  useSearchParams,
} from 'react-router-dom';
import { GitBranch, RefreshCw, Search } from 'lucide-react';
import { useApp } from '../../app/AppProvider';
import { useAsync } from '../../hooks/useAsync';
import { Button, EmptyState, Input, Select } from '../../components/ui';
import { PageHeader } from '../../components/explorer/PageHeader';
import { QueryState } from '../../components/explorer/QueryState';
import { TimeRangePicker } from '../../components/explorer/TimeRangePicker';
import { paramsRange, timeBounds } from '../../lib/query';
import type { DatasetInfo, TimeRange, TraceListRequest, TraceSortBy } from '../../lib/types';
import { discoverTraceDatasets, normalizeTraceId, TRACE_PAGE_SIZE } from './helpers';
import { TraceDetailSheet } from './TraceDetailSheet';
import { TraceTable } from './TraceTable';
import './traces.css';

const datasetPath = (dataset: string) => `/traces/explore/${encodeURIComponent(dataset)}`;
const sortOptions: Array<{ value: TraceSortBy; label: string }> = [
  { value: 'mostRecent', label: 'Most recent' },
  { value: 'leastRecent', label: 'Least recent' },
  { value: 'longestFirst', label: 'Longest first' },
  { value: 'shortestFirst', label: 'Shortest first' },
  { value: 'mostSpans', label: 'Most spans' },
  { value: 'leastSpans', label: 'Least spans' },
];

function searchRange(params: URLSearchParams): TimeRange {
  if (params.has('start') || params.has('end')) return paramsRange(params);
  const preset = params.get('range');
  if (preset) {
    try {
      timeBounds(preset as TimeRange);
      return preset as TimeRange;
    } catch {
      /* Use the default for malformed links. */
    }
  }
  return '1h';
}

export function TracesPage() {
  const { client } = useApp();
  const route = useParams();
  const dataset = route.dataset ?? route.currentDataset;
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const discovery = useAsync(
    useCallback((signal) => discoverTraceDatasets(client, signal), [client]),
    { keepPreviousData: true },
  );
  const datasets = discovery.data?.datasets;
  if (datasets?.length && !dataset)
    return (
      <Navigate replace to={`${datasetPath(datasets[0].name)}${params.size ? `?${params}` : ''}`} />
    );
  const warning = discovery.data?.unchecked.length ? (
    <p role="status" className="notice traces-discovery-warning">
      Could not check trace eligibility for {discovery.data.unchecked.join(', ')}.{' '}
      <Button variant="ghost" size="sm" onClick={discovery.reload}>
        Check again
      </Button>
    </p>
  ) : undefined;
  if (dataset && datasets?.some((entry) => entry.name === dataset))
    return (
      <>
        {(warning || discovery.error || discovery.loading) && (
          <div className="page traces-discovery">
            {warning}
            <QueryState
              loading={discovery.loading}
              error={discovery.error}
              retry={discovery.reload}
            />
          </div>
        )}
        <TracesExplorer key={dataset} dataset={dataset} datasets={datasets} />
      </>
    );
  return (
    <div className="page traces-page" data-testid="traces-page">
      <PageHeader
        title="Traces"
        description="Follow requests across services and inspect individual spans."
      />
      <QueryState loading={discovery.loading} error={discovery.error} retry={discovery.reload} />
      {warning}
      {datasets && !datasets.length && (
        <EmptyState
          icon={<GitBranch size={24} />}
          title="No trace datasets available"
          description="Ingest OTLP traces into a dataset with the otel-traces source to explore requests and spans."
          action={
            <div className="inline">
              <Link className="ui-button" data-variant="primary" to="/add-data">
                Add data
              </Link>
              <Button variant="secondary" onClick={discovery.reload}>
                Check again
              </Button>
            </div>
          }
        />
      )}
      {!!datasets?.length && dataset && (
        <EmptyState
          title="Trace dataset unavailable"
          description="This dataset could not be found, is not accessible, or does not have the otel-traces source."
          action={
            <div className="inline">
              <Button
                variant="primary"
                onClick={() =>
                  navigate(`${datasetPath(datasets[0].name)}${params.size ? `?${params}` : ''}`)
                }
              >
                Open {datasets[0].name}
              </Button>
              <Button variant="secondary" onClick={discovery.reload}>
                Check again
              </Button>
            </div>
          }
        />
      )}
    </div>
  );
}

function TracesExplorer({ dataset, datasets }: { dataset: string; datasets: DatasetInfo[] }) {
  const { client } = useApp();
  const [params, setParams] = useSearchParams();
  const navigationType = useNavigationType();
  // Router navigations can defer rendering. Compose rapid edits with the latest
  // draft so closing detail followed by filtering cannot restore a stale traceId.
  const draftParams = useRef(params);
  const observedSearch = useRef(params.toString());
  const pendingSearches = useRef(new Set<string>());
  const search = params.toString();
  if (observedSearch.current !== search) {
    observedSearch.current = search;
    if (navigationType !== 'POP' && pendingSearches.current.has(search)) {
      pendingSearches.current.delete(search);
      if (draftParams.current.toString() === search) pendingSearches.current.clear();
    } else {
      pendingSearches.current.clear();
      draftParams.current = params;
    }
  }
  const navigate = useNavigate();
  const service = params.get('service') ?? '';
  const traceId = normalizeTraceId(params.get('traceId') ?? '');
  // A service handoff from APM includes child-span participation unless a view is explicit.
  const view =
    params.get('view') === 'traces'
      ? 'traces'
      : params.get('view') === 'spans' || service
        ? 'spans'
        : 'traces';
  const errorOnly = params.get('status') === 'error';
  const option = errorOnly ? 'errorSpans' : view;
  const noun = option === 'errorSpans' ? 'error spans' : option;
  const sort = sortOptions.find(({ value }) => value === params.get('sort'))?.value ?? 'mostRecent';
  const rawPage = Number(params.get('page') ?? 0);
  const page = Number.isSafeInteger(rawPage) && rawPage >= 0 && rawPage <= 1_000_000 ? rawPage : 0;
  const rangeKey = JSON.stringify(searchRange(params));
  const range = useMemo(() => JSON.parse(rangeKey) as TimeRange, [rangeKey]);
  const [refresh, setRefresh] = useState(0);
  const bounds = useMemo(() => timeBounds(range), [range, refresh]);
  const [serviceInput, setServiceInput] = useState(service);
  const [lookup, setLookup] = useState(traceId);
  useEffect(() => setServiceInput(service), [service]);
  useEffect(() => setLookup(traceId), [traceId]);
  const update = (
    changes: Record<string, string | undefined>,
    resetPage = true,
    replace = false,
  ) => {
    const next = new URLSearchParams(draftParams.current);
    if (resetPage) next.delete('page');
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    draftParams.current = next;
    pendingSearches.current.add(next.toString());
    setParams(next, { replace });
  };
  const listRequest = useMemo<TraceListRequest>(
    () => ({
      dataset,
      ...bounds,
      serviceName: service || undefined,
      options: option,
      sortBy: sort,
      limit: TRACE_PAGE_SIZE,
      offset: page * TRACE_PAGE_SIZE,
    }),
    [dataset, bounds, service, option, sort, page],
  );
  const list = useAsync(
    useCallback((signal) => client.listTraces(listRequest, signal), [client, listRequest]),
  );
  const detailRequest = useMemo(
    () => (traceId ? { dataset, traceId, ...bounds } : undefined),
    [dataset, traceId, bounds],
  );
  const count = list.data?.count;
  useEffect(() => {
    if (count !== undefined && page > 0 && page * TRACE_PAGE_SIZE >= count)
      update({ page: String(Math.max(0, Math.ceil(count / TRACE_PAGE_SIZE) - 1)) }, false, true);
  }, [count, page, setParams]);
  return (
    <div className="page traces-page" data-testid="traces-page">
      <PageHeader
        title="Traces"
        description="Follow requests across services and inspect individual spans."
        actions={
          <>
            <Select
              aria-label="Traces dataset"
              value={dataset}
              onChange={(event) => {
                const next = new URLSearchParams(params);
                next.delete('traceId');
                next.delete('page');
                navigate(`${datasetPath(event.target.value)}${next.size ? `?${next}` : ''}`);
              }}
            >
              {datasets.map((entry) => (
                <option key={entry.name} value={entry.name}>
                  {entry.name}
                </option>
              ))}
            </Select>
            <TimeRangePicker
              value={range}
              onChange={(next) =>
                update(
                  typeof next === 'string'
                    ? { range: next, start: undefined, end: undefined }
                    : { range: undefined, start: next.startTime, end: next.endTime },
                )
              }
            />
            <Button
              aria-label="Refresh traces"
              variant="secondary"
              size="icon"
              onClick={() => {
                setRefresh((value) => value + 1);
              }}
            >
              <RefreshCw size={15} aria-hidden="true" />
            </Button>
          </>
        }
      />
      <section className="traces-controls" aria-label="Trace filters">
        <form
          className="traces-service-filter"
          onSubmit={(event) => {
            event.preventDefault();
            update({ service: serviceInput.trim() });
          }}
        >
          <Input
            label="Service"
            placeholder="Exact service name"
            value={serviceInput}
            onChange={(event) => setServiceInput(event.target.value)}
          />
          <Button type="submit" variant="secondary">
            Apply service
          </Button>
        </form>
        <Select
          label="View"
          value={view}
          disabled={errorOnly}
          onChange={(event) => update({ view: event.target.value })}
        >
          <option value="traces">Traces</option>
          <option value="spans">All spans</option>
        </Select>
        <Select
          label="Status"
          value={errorOnly ? 'error' : 'all'}
          onChange={(event) =>
            update({ status: event.target.value === 'error' ? 'error' : undefined })
          }
        >
          <option value="all">All statuses</option>
          <option value="error">Error spans</option>
        </Select>
        <Select
          label="Sort by"
          value={sort}
          onChange={(event) => update({ sort: event.target.value })}
        >
          {sortOptions.map(({ value, label }) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
        <form
          className="traces-lookup"
          onSubmit={(event) => {
            event.preventDefault();
            if (lookup.trim()) update({ traceId: normalizeTraceId(lookup) }, false);
          }}
        >
          <Input
            aria-label="Trace ID"
            placeholder="Lookup by Trace ID"
            value={lookup}
            onChange={(event) => setLookup(event.target.value)}
          />
          <Button type="submit" variant="primary" disabled={!lookup.trim()}>
            <Search size={14} aria-hidden="true" />
            Look up
          </Button>
        </form>
      </section>
      <div className="traces-results-heading">
        <h2>
          {option === 'errorSpans'
            ? 'Error spans'
            : view === 'spans'
              ? 'All spans'
              : 'Trace results'}
          {count !== undefined && <BadgeCount count={count} />}
        </h2>
        {(service || errorOnly || view === 'spans') && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => update({ service: undefined, status: undefined, view: undefined })}
          >
            Clear filters
          </Button>
        )}
      </div>
      <p className="muted traces-scope-notice">
        {option === 'traces'
          ? 'Traces shows root spans within the selected time window. Widen the time range if the root is outside it.'
          : option === 'errorSpans'
            ? 'Error spans shows individual spans with an error status, including child spans.'
            : 'All spans includes root and child spans.'}{' '}
        Span and error counts reflect the selected service and time window.
      </p>
      <QueryState loading={list.loading} error={list.error} retry={list.reload} />
      {list.data && !list.data.records.length && (
        <EmptyState
          title="No matching traces"
          description="Try a wider time range, change the service or status, or look up a trace ID."
          action={
            service || errorOnly ? (
              <Button
                variant="secondary"
                onClick={() => update({ service: undefined, status: undefined })}
              >
                Clear filters
              </Button>
            ) : undefined
          }
        />
      )}
      {!!list.data?.records.length && (
        <TraceTable
          data={list.data}
          sort={sort}
          onSort={(value) => update({ sort: value })}
          onPage={(value) => update({ page: value ? String(value) : undefined }, false)}
          onSelect={(row) => update({ traceId: row.span_trace_id }, false)}
          noun={noun}
        />
      )}
      {detailRequest && (
        <TraceDetailSheet
          key={`${dataset}:${traceId}`}
          client={client}
          request={detailRequest}
          onClose={() => update({ traceId: undefined }, false)}
        />
      )}
    </div>
  );
}

function BadgeCount({ count }: { count: number }) {
  return <span className="traces-result-count">{count.toLocaleString()}</span>;
}
