import { useMemo, useRef, useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { AppContext } from '../../app/AppProvider';
import { createDemoClient } from '../../lib/demo';
import type { DatasetInfo, ParseableClient } from '../../lib/types';
import { IngestionPage } from './IngestionPage';

type Args = {
  state:
    'live' | 'empty' | 'permission' | 'verification-error' | 'demo' | 'loading' | 'new-arrivals';
};
const seed: DatasetInfo[] = [
  { name: 'application_logs', telemetryType: 'logs', logSourceFormats: ['json'] },
  { name: 'otel_logs', telemetryType: 'logs', logSourceFormats: ['otel-logs'] },
  { name: 'otel_metrics', telemetryType: 'metrics', logSourceFormats: ['otel-metrics'] },
  { name: 'otel_traces', telemetryType: 'traces', logSourceFormats: ['otel-traces'] },
];

function Example({ state }: Args) {
  const [items, setItems] = useState(seed);
  const checks = useRef(0);
  const client = useMemo(
    () =>
      ({
        ...createDemoClient(),
        async listDatasets() {
          if (state === 'loading') return new Promise<never>(() => {});
          if (state === 'permission')
            throw new Error('Permission denied: dataset access is required.');
          return (state === 'empty' ? [] : items).map((item) => ({
            name: item.name,
            type: 'logs' as const,
          }));
        },
        async datasetInfo(name) {
          const info = items.find((item) => item.name === name);
          if (!info) throw new Error('Dataset not found');
          return info;
        },
        async createDataset(name, options) {
          if (items.some((item) => item.name === name)) throw new Error('Dataset already exists');
          setItems((values) => [
            ...values,
            {
              name,
              telemetryType: options.telemetryType,
              logSourceFormats: [options.logSource || 'json'],
            },
          ]);
        },
        async schema() {
          return ['p_timestamp', 'message', 'service', 'level'];
        },
        async datasetStats(name) {
          if (state === 'verification-error')
            throw new Error('Ingestion statistics are temporarily unavailable.');
          const count = name.startsWith('empty') ? 0 : 42;
          const observed = state === 'new-arrivals' ? checks.current++ : 0;
          return {
            stream: name,
            time: '2026-10-12T15:30:00Z',
            ingestion: {
              count: observed > 0 ? 20 : count,
              size: 2048,
              format: 'json',
              lifetime_count: count + observed * 3,
              lifetime_size: 2048,
              deleted_count: 0,
              deleted_size: 0,
            },
            storage: { size: 1024, format: 'parquet', lifetime_size: 1024, deleted_size: 0 },
          };
        },
      }) satisfies ParseableClient,
    [items, state],
  );
  return (
    <MemoryRouter>
      <AppContext.Provider
        value={{
          client,
          mode: state === 'demo' ? 'demo' : 'live',
          session: 0,
          needsLogin: false,
          demoEnabled: true,
          identity: { id: 'story-user', username: 'Story user', source: 'server' },
          setMode: () => {},
        }}
      >
        <IngestionPage />
      </AppContext.Provider>
    </MemoryRouter>
  );
}
const meta = {
  title: 'Ingestion/Setup',
  component: Example,
  args: { state: 'live' },
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const EmptyWorkspace: Story = { args: { state: 'empty' } };
export const PermissionDenied: Story = { args: { state: 'permission' } };
export const VerificationError: Story = { args: { state: 'verification-error' } };
export const DemoMode: Story = { args: { state: 'demo' } };
export const Loading: Story = { args: { state: 'loading' } };
export const NewArrivals: Story = { args: { state: 'new-arrivals' } };
