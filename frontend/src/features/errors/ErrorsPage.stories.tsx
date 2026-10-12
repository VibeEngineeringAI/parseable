import { useMemo, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { AppContext } from '../../app/AppProvider';
import { ApiError } from '../../lib/apiError';
import { createDemoClient } from '../../lib/demo';
import type { ParseableClient, TraceListRequest } from '../../lib/types';
import { storyTraceList, STORY_BOUNDS } from '../traces/fixtures';
import { ErrorsPage } from './ErrorsPage';
type State = 'success' | 'loading' | 'error' | 'permission' | 'empty' | 'unavailable';
function Example({ state }: { state: State }) {
  const [requests, setRequests] = useState<TraceListRequest[]>([]);
  const client = useMemo(
    () =>
      ({
        ...createDemoClient(),
        async listDatasets() {
          return state === 'unavailable'
            ? []
            : [{ name: 'orders_traces', type: 'traces' as const }];
        },
        async datasetInfo(name: string) {
          return { name, telemetryType: 'traces', logSourceFormats: ['otel-traces'] };
        },
        async listTraces(request: TraceListRequest, signal?: AbortSignal) {
          setRequests((previous) => [...previous, request]);
          signal?.throwIfAborted();
          if (state === 'loading')
            await new Promise<void>((_, reject) =>
              signal?.addEventListener(
                'abort',
                () => reject(new DOMException('Aborted', 'AbortError')),
                { once: true },
              ),
            );
          if (state === 'error') throw new ApiError('Trace query node unavailable', 503);
          if (state === 'permission') throw new ApiError('Error span access denied', 403);
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
      }) satisfies ParseableClient,
    [state],
  );
  const router = useMemo(
    () =>
      createMemoryRouter(
        [
          {
            path: '/errors/:dataset?',
            element: <ErrorsPage />,
          },
        ],
        {
          initialEntries: [
            `/errors/orders_traces?${new URLSearchParams({ start: STORY_BOUNDS.startTime, end: STORY_BOUNDS.endTime })}`,
          ],
        },
      ),
    [],
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
        <pre data-testid="error-list-requests">{JSON.stringify(requests, null, 2)}</pre>
      </details>
    </AppContext.Provider>
  );
}
const meta = { title: 'Operations/Errors', component: Example } satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Success: Story = { args: { state: 'success' } };
export const Loading: Story = { args: { state: 'loading' } };
export const Error: Story = { args: { state: 'error' } };
export const Permission: Story = { args: { state: 'permission' } };
export const Empty: Story = { args: { state: 'empty' } };
export const Unavailable: Story = { args: { state: 'unavailable' } };
