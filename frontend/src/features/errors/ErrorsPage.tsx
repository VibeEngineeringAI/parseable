import { useCallback, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useApp } from '../../app/AppProvider';
import { useAsync } from '../../hooks/useAsync';
import { PageHeader } from '../../components/explorer/PageHeader';
import { QueryState } from '../../components/explorer/QueryState';
import { Badge, Button, EmptyState, Select } from '../../components/ui';
import { discoverTraceDatasets, TRACE_PAGE_SIZE } from '../traces/helpers';
import { TraceTable } from '../traces/TraceTable';
import { TimeRangePicker } from '../../components/explorer/TimeRangePicker';
import { paramsRange, timeBounds } from '../../lib/query';
import type { TimeRange, TraceSortBy } from '../../lib/types';
import '../traces/traces.css';
export function ErrorsUnavailable({ dataset }: { dataset?: string }) {
  return (
    <EmptyState
      title="No eligible error dataset"
      description={
        dataset
          ? `${dataset} is not an accessible OTLP trace dataset. Explore its logs to investigate application errors.`
          : 'Error spans require an accessible dataset ingested with the otel-traces source format.'
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
function errorRange(params: URLSearchParams): TimeRange {
  if (params.has('start') || params.has('end')) return paramsRange(params);
  const preset = params.get('range');
  if (preset) {
    try {
      timeBounds(preset as TimeRange);
      return preset as TimeRange;
    } catch {
      /* Fall back to the default range. */
    }
  }
  return '1h';
}
function ErrorSpans({ dataset }: { dataset: string }) {
  const { client } = useApp();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const rangeKey = JSON.stringify(errorRange(params));
  const range = useMemo(() => JSON.parse(rangeKey) as TimeRange, [rangeKey]);
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<TraceSortBy>('mostRecent');
  const [revision, setRevision] = useState(0);
  const bounds = useMemo(() => timeBounds(range), [range, revision]);
  function changeRange(value: TimeRange) {
    const next = new URLSearchParams(params);
    next.delete('start');
    next.delete('end');
    next.delete('range');
    if (typeof value === 'string') next.set('range', value);
    else {
      next.set('start', value.startTime);
      next.set('end', value.endTime);
    }
    setPage(0);
    setSort('mostRecent');
    setParams(next);
  }
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
      <div className="inline">
        <p>OTLP error spans · {TRACE_PAGE_SIZE} results per page</p>
        <TimeRangePicker value={range} onChange={changeRange} />
        <Button
          onClick={() => {
            setPage(0);
            setRevision((v) => v + 1);
          }}
        >
          Refresh
        </Button>
      </div>
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
export function ErrorsPage() {
  const { dataset } = useParams();
  const [params] = useSearchParams();
  const { client, mode } = useApp();
  const navigate = useNavigate();
  const discovery = useAsync(
    useCallback((signal) => discoverTraceDatasets(client, signal), [client]),
  );
  const selected = dataset ?? discovery.data?.datasets[0]?.name;
  const eligible = discovery.data?.datasets.some((entry) => entry.name === selected);
  return (
    <div className="page">
      <PageHeader title="Errors" description="Investigate error spans in OTLP trace datasets." />
      {mode === 'demo' && <Badge>Sample data</Badge>}
      <p className="notice">
        This view lists individual error spans. Grouped error issues and frequency analysis are
        unavailable on this server.
      </p>
      {[...params.keys()].some((key) => !['start', 'end', 'range'].includes(key)) && (
        <p role="status">
          This link includes options that are not applied here:{' '}
          {[...new Set(params.keys())]
            .filter((key) => !['start', 'end', 'range'].includes(key))
            .join(', ')}
          . Use the native time range and sort controls to refine these error spans.
        </p>
      )}
      <QueryState loading={discovery.loading} error={discovery.error} retry={discovery.reload} />
      {discovery.data?.unchecked.length ? (
        <p role="status">
          Could not check datasets: {discovery.data.unchecked.join(', ')}.{' '}
          <Button onClick={discovery.reload}>Check again</Button>
        </p>
      ) : null}
      {discovery.data && (
        <>
          <Select
            label="Trace dataset"
            value={eligible ? selected : ''}
            onChange={(event) =>
              navigate(
                `/errors/${encodeURIComponent(event.target.value)}${params.size ? `?${params}` : ''}`,
              )
            }
          >
            <option value="" disabled>
              Select dataset
            </option>
            {discovery.data.datasets.map((entry) => (
              <option key={entry.name} value={entry.name}>
                {entry.name}
              </option>
            ))}
          </Select>
          {eligible && selected ? (
            <ErrorSpans
              key={`${selected}:${JSON.stringify(errorRange(params))}`}
              dataset={selected}
            />
          ) : selected && discovery.data.unchecked.includes(selected) ? (
            <EmptyState
              title="Could not verify dataset"
              description={`Could not verify whether ${selected} supports OTLP error spans. Dataset metadata is temporarily unavailable.`}
              action={<Button onClick={discovery.reload}>Retry dataset verification</Button>}
            />
          ) : (
            <ErrorsUnavailable dataset={dataset} />
          )}
        </>
      )}
    </div>
  );
}
