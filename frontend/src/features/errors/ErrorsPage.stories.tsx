import { useMemo, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { AppContext } from '../../app/AppProvider';
import { ApiError } from '../../lib/apiError';
import { createDemoClient } from '../../lib/demo';
import { handleErrorDemoQuery } from '../../lib/errorAnalyticsDemo';
import type { LogRecord, ParseableClient, QueryRequest, TraceListRequest } from '../../lib/types';
import { storyTraceList, STORY_BOUNDS } from '../traces/fixtures';
import { ErrorsPage } from './ErrorsPage';

type State =
  | 'success'
  | 'logs'
  | 'loading'
  | 'error'
  | 'permission'
  | 'empty'
  | 'unavailable'
  | 'unsupported'
  | 'unchecked';

const start = Date.parse(STORY_BOUNDS.startTime);
const at = (minute: number) => new Date(start + minute * 60_000 + 1_234).toISOString();

const TRACE_FIELDS = [
  'p_timestamp',
  'service.name',
  'span_trace_id',
  'span_span_id',
  'span_name',
  'span_status_code',
  'span_status_message',
  'event_name',
  'event_exception.type',
  'event_exception.message',
];
/** Raw span rows: a retried span and its exception event count once. */
const traceRows: LogRecord[] = [
  ...Array.from({ length: 9 }, (_, index) => ({
    p_timestamp: at(index * 6),
    'service.name': 'checkout',
    span_trace_id: `${index.toString(16)}`.padStart(32, 'a'),
    span_span_id: `${index.toString(16)}`.padStart(16, '1'),
    span_name: 'authorize-payment',
    span_status_code: 2,
    span_status_message: 'Payment provider timed out',
    event_name: index === 0 ? 'exception' : null,
    'event_exception.type': index === 0 ? 'TimeoutError' : null,
    'event_exception.message': index === 0 ? 'Card authorization deadline exceeded' : null,
  })),
  {
    p_timestamp: at(20),
    'service.name': 'inventory',
    span_trace_id: 'b'.repeat(32),
    span_span_id: '2'.repeat(16),
    span_name: 'reserve-stock',
    span_status_code: 2,
    span_status_message: '',
  },
  {
    p_timestamp: at(30),
    'service.name': 'inventory',
    span_trace_id: 'c'.repeat(32),
    span_span_id: '3'.repeat(16),
    span_name: 'reserve-stock',
    span_status_code: 1,
    span_status_message: '',
  },
];

const LOG_FIELDS = [
  'p_timestamp',
  'level',
  'severity_number',
  'service',
  'message',
  'exception.type',
  'trace_id',
];
const logRows: LogRecord[] = [
  ...Array.from({ length: 31 }, (_, index) => ({
    p_timestamp: at(index % 58),
    level: index % 4 ? 'ERROR' : 'fatal',
    service: 'api-gateway',
    message: 'Upstream request timed out after 3000ms',
    'exception.type': 'UpstreamTimeout',
    trace_id: `8e74f620af734b9086bb${index.toString(16).padStart(12, '0')}`,
  })),
  // Exact grouping: a different request ID is a different issue.
  ...Array.from({ length: 27 }, (_, index) => ({
    p_timestamp: at(40 + (index % 15)),
    severity_number: 17,
    service: 'worker',
    message: `Job ${1000 + index} failed`,
  })),
  { p_timestamp: at(12), level: 'ERROR', message: 'Unhandled rejection' },
  { p_timestamp: at(13), level: 'INFO', service: 'worker', message: 'Job started' },
];

function Example({ state }: { state: State }) {
  const [traceRequests, setTraceRequests] = useState<TraceListRequest[]>([]);
  const [queries, setQueries] = useState<QueryRequest[]>([]);
  const client = useMemo(() => {
    const pending = (signal?: AbortSignal) =>
      new Promise<never>((_, reject) =>
        signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
          once: true,
        }),
      );
    const fail = () => {
      if (state === 'error') throw new ApiError('Query node unavailable', 503);
      if (state === 'permission') throw new ApiError('Error data access denied', 403);
    };
    return {
      ...createDemoClient(),
      async listDatasets() {
        return state === 'unavailable'
          ? []
          : [
              { name: 'orders_logs', type: 'logs' as const },
              { name: 'orders_traces', type: 'traces' as const },
            ];
      },
      async datasetInfo(name: string) {
        if (state === 'unchecked' && name === 'orders_traces')
          throw new ApiError('Metadata service unavailable', 503);
        return name === 'orders_traces' && state !== 'unsupported'
          ? { name, telemetryType: 'traces', logSourceFormats: ['otel-traces'] }
          : { name, telemetryType: 'logs', logSourceFormats: ['json'] };
      },
      async schema(name: string) {
        if (state === 'unsupported') return ['p_timestamp', 'message'];
        return name === 'orders_traces' ? TRACE_FIELDS : LOG_FIELDS;
      },
      async query(request: QueryRequest, signal?: AbortSignal) {
        setQueries((previous) => [...previous, request]);
        signal?.throwIfAborted();
        if (state === 'loading') return pending(signal);
        fail();
        const rows =
          state === 'empty' ? [] : request.sql.includes('"orders_traces"') ? traceRows : logRows;
        const result = handleErrorDemoQuery(request, rows);
        if (!result) throw new ApiError('Unsupported story query', 400);
        return result;
      },
      async listTraces(request: TraceListRequest, signal?: AbortSignal) {
        setTraceRequests((previous) => [...previous, request]);
        signal?.throwIfAborted();
        if (state === 'loading') return pending(signal);
        fail();
        const rows = state === 'empty' ? [] : storyTraceList.filter((row) => row.error_count > 0);
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
              ? Date.parse(a[field]) - Date.parse(b[field])
              : Number(a[field]) - Number(b[field])) * direction,
        );
        return {
          count: rows.length,
          offset: request.offset ?? 0,
          limit: request.limit ?? 25,
          records: rows.slice(request.offset ?? 0, (request.offset ?? 0) + (request.limit ?? 25)),
        };
      },
    } satisfies ParseableClient;
  }, [state]);
  const router = useMemo(
    () =>
      createMemoryRouter([{ path: '/errors/:dataset?', element: <ErrorsPage /> }], {
        initialEntries: [
          `/errors/${state === 'logs' ? 'orders_logs' : 'orders_traces'}?${new URLSearchParams({ start: STORY_BOUNDS.startTime, end: STORY_BOUNDS.endTime })}`,
        ],
      }),
    [state],
  );
  return (
    <AppContext.Provider
      value={{
        client,
        mode: 'live',
        session: 0,
        needsLogin: false,
        identity: { id: 'error-story', username: 'Error reader', source: 'server' },
        demoEnabled: false,
        setMode: () => {},
      }}
    >
      <RouterProvider router={router} />
      <details className="page">
        <summary>Story transport inspection</summary>
        <pre data-testid="error-list-requests">{JSON.stringify(traceRequests, null, 2)}</pre>
        <pre data-testid="error-query-requests">{JSON.stringify(queries, null, 2)}</pre>
      </details>
    </AppContext.Provider>
  );
}

const meta = { title: 'Operations/Errors', component: Example } satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Success: Story = { args: { state: 'success' } };
export const Logs: Story = { args: { state: 'logs' } };
export const TraceIssueDetail: Story = {
  args: { state: 'success' },
  play: async ({ canvas, userEvent }) => {
    // Issues are ordered by frequency; open the most frequent one.
    await userEvent.click((await canvas.findAllByRole('button', { name: /Payment provider/ }))[0]);
  },
};
export const LogIssueDetail: Story = {
  args: { state: 'logs' },
  play: async ({ canvas, userEvent }) => {
    await userEvent.click((await canvas.findAllByRole('button', { name: /Upstream request/ }))[0]);
  },
};
export const Loading: Story = { args: { state: 'loading' } };
export const Error: Story = { args: { state: 'error' } };
export const Permission: Story = { args: { state: 'permission' } };
export const Empty: Story = { args: { state: 'empty' } };
export const Unavailable: Story = { args: { state: 'unavailable' } };
export const UnsupportedSchema: Story = { args: { state: 'unsupported' } };
export const MetadataUnavailable: Story = { args: { state: 'unchecked' } };
