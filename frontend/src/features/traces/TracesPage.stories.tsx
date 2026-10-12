import { useMemo, useState } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { AppContext } from '../../app/AppProvider';
import { ApiError } from '../../lib/apiError';
import { createDemoClient } from '../../lib/demo';
import { parseEventTimestamp } from '../../components/explorer/timestamp';
import type { ParseableClient, TraceListRequest } from '../../lib/types';
import { storyTraceDetail, storyTraceList, STORY_BOUNDS, STORY_TRACE_ID } from './fixtures';
import { TracesPage } from './TracesPage';

type State =
  | 'default'
  | 'detail'
  | 'permission'
  | 'empty'
  | 'loading'
  | 'no-datasets'
  | 'missing-fields'
  | 'error'
  | 'not-found'
  | 'service-handoff'
  | 'metadata-error';
type Args = { state: State };
const boundsSearch = new URLSearchParams({
  start: STORY_BOUNDS.startTime,
  end: STORY_BOUNDS.endTime,
});

function pause(signal?: AbortSignal, duration = 900) {
  return new Promise<void>((resolve, reject) => {
    signal?.throwIfAborted();
    const timer = setTimeout(resolve, duration);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

function Playground({ state }: Args) {
  const [requests, setRequests] = useState<TraceListRequest[]>([]);
  const client = useMemo(
    () =>
      ({
        ...createDemoClient(),
        async listDatasets() {
          return state === 'no-datasets' ? [] : [{ name: 'orders_traces', type: 'logs' as const }];
        },
        async datasetInfo(name) {
          return { name, telemetryType: 'traces', logSourceFormats: ['otel-traces'] };
        },
        async listTraces(request, signal) {
          setRequests((previous) => [...previous, request]);
          if (state === 'loading') await pause(signal, 3_600_000);
          if (request.serviceName === 'slow-service') await pause(signal);
          signal?.throwIfAborted();
          if (state === 'permission')
            throw new ApiError('You do not have access to orders_traces', 403);
          if (state === 'missing-fields')
            throw new ApiError(
              "Dataset 'orders_traces' is missing required fields for the traces API: span_status_code",
              400,
            );
          if (state === 'error')
            throw new ApiError('Trace query failed: query node unavailable', 503);
          let rows = state === 'empty' ? [] : [...storyTraceList];
          if (request.options !== 'traces')
            rows.push(
              ...storyTraceDetail.records.slice(1).map((span) => ({
                ...span,
                p_timestamp: storyTraceDetail.startTime,
                error_count: span.has_error ? 1 : 0,
              })),
            );
          if (request.serviceName)
            rows = rows.filter((row) => row['service.name'] === request.serviceName);
          if (request.options === 'errorSpans')
            rows = rows.filter((row) => row.error_count > 0 && row.has_error === true);
          const sorts = {
            mostRecent: ['span_start_time_unix_nano', -1],
            leastRecent: ['span_start_time_unix_nano', 1],
            longestFirst: ['span_duration_ns', -1],
            shortestFirst: ['span_duration_ns', 1],
            mostSpans: ['total_span_count', -1],
            leastSpans: ['total_span_count', 1],
          } as const;
          const [field, direction] = sorts[request.sortBy ?? 'mostRecent'];
          rows.sort(
            (a, b) =>
              (field === 'span_start_time_unix_nano'
                ? parseEventTimestamp(a[field]) - parseEventTimestamp(b[field])
                : Number(a[field]) - Number(b[field])) * direction,
          );
          return {
            count: rows.length,
            offset: request.offset ?? 0,
            limit: request.limit ?? 25,
            records: rows.slice(request.offset ?? 0, (request.offset ?? 0) + (request.limit ?? 25)),
          };
        },
        async traceDetail(request) {
          if (request.traceId !== STORY_TRACE_ID || state === 'not-found')
            throw new ApiError(`Trace not found: ${request.traceId}`, 404);
          return structuredClone(storyTraceDetail);
        },
        async query(request) {
          if (state === 'metadata-error')
            throw new ApiError('Stored-record query is not permitted', 403);
          const span =
            storyTraceDetail.records.find((item) =>
              request.sql.includes(`'${item.span_span_id}'`),
            ) ?? storyTraceDetail.records[0];
          const base = {
            span_span_id: span.span_span_id,
            span_name: span.span_name,
            'service.name': span['service.name'],
            'deployment.environment.name': 'production',
            'http.request.method': 'POST',
            'http.response.status_code': span.has_error ? 504 : 200,
            span_status_message: span.has_error ? 'Payment provider timed out' : '',
            p_timestamp: storyTraceDetail.startTime,
          };
          const event = {
            ...base,
            event_name: 'exception',
            event_time_unix_nano: '2026-10-12T10:20:00.030000000',
            event_message: 'Upstream timeout',
          };
          return span.has_error ? [base, event, { ...event }] : [base];
        },
      }) satisfies ParseableClient,
    [state],
  );
  return (
    <AppContext.Provider
      value={{
        client,
        mode: 'live',
        session: 0,
        needsLogin: false,
        identity: { id: 'trace-story', username: 'Trace reader', source: 'server' },
        demoEnabled: false,
        setMode: () => {},
      }}
    >
      <TracesPage />
      <details className="page">
        <summary>Story transport inspection</summary>
        <pre data-testid="trace-list-requests">{JSON.stringify(requests, null, 2)}</pre>
      </details>
    </AppContext.Provider>
  );
}

function Example({ state }: Args) {
  const router = useMemo(() => {
    const search = new URLSearchParams(boundsSearch);
    if (['detail', 'metadata-error'].includes(state)) search.set('traceId', STORY_TRACE_ID);
    if (state === 'not-found') search.set('traceId', 'ffffffffffffffffffffffffffffffff');
    if (state === 'service-handoff') search.set('service', 'checkout');
    return createMemoryRouter(
      [
        { path: '/traces', element: <Playground state={state} /> },
        { path: '/traces/explore/:dataset', element: <Playground state={state} /> },
      ],
      { initialEntries: [`/traces/explore/orders_traces?${search}`] },
    );
  }, [state]);
  return <RouterProvider router={router} />;
}

const meta = {
  title: 'Traces/Explorer',
  component: Example,
  args: { state: 'default' },
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Detail: Story = { args: { state: 'detail' } };
export const PermissionDenied: Story = { args: { state: 'permission' } };
export const Empty: Story = { args: { state: 'empty' } };
export const Loading: Story = { args: { state: 'loading' } };
export const NoDatasets: Story = { args: { state: 'no-datasets' } };
export const MissingFields: Story = { args: { state: 'missing-fields' } };
export const Error: Story = { args: { state: 'error' } };
export const LookupNotFound: Story = { args: { state: 'not-found' } };
export const ServiceHandoff: Story = { args: { state: 'service-handoff' } };
export const MetadataPermission: Story = { args: { state: 'metadata-error' } };
