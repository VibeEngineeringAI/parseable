import { useMemo } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { AppContext } from '../../app/AppProvider';
import { createDemoClient } from '../../lib/demo';
import { ApiError } from '../../lib/apiError';
import { agentDemoFields, agentDemoRows } from '../../lib/agents';
import { buildAgentRuns } from '../../lib/agentRuns';
import { AgentsPage } from './AgentsPage';

type State =
  | 'default'
  | 'empty'
  | 'permission'
  | 'error'
  | 'loading'
  | 'no-datasets'
  | 'missing-fields'
  | 'demo'
  | 'success'
  | 'failed'
  | 'incomplete'
  | 'missing-telemetry'
  | 'setup'
  | 'run-details';
function exampleRows(state: State) {
  if (state === 'missing-telemetry')
    return [
      {
        p_timestamp: new Date().toISOString(),
        'gen_ai.agent.name': 'Sparse assistant',
        'gen_ai.operation.name': 'invoke_agent',
      },
    ];
  return agentDemoRows();
}
function Example({ state }: { state: State }) {
  const client = useMemo(
    () => ({
      ...createDemoClient(),
      async listDatasets() {
        return state === 'no-datasets'
          ? []
          : [{ name: 'agent_telemetry', type: 'traces' as const }];
      },
      async schema() {
        return state === 'missing-fields' ? ['p_timestamp'] : agentDemoFields;
      },
      async datasetInfo(name: string) {
        return { name, logSourceFormats: ['otel-traces'], timePartition: 'p_timestamp' };
      },
      async query(_request: unknown, signal?: AbortSignal) {
        if (state === 'loading')
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 3600000);
            signal?.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                reject(new DOMException('Aborted', 'AbortError'));
              },
              { once: true },
            );
          });
        if (state === 'permission') throw new ApiError('Access to agent_telemetry is denied', 403);
        if (state === 'error') throw new ApiError('Query node unavailable', 503);
        return state === 'empty' ? [] : exampleRows(state);
      },
    }),
    [state],
  );
  const router = useMemo(
    () =>
      createMemoryRouter(
        [
          { path: '/agents', element: <AgentsPage /> },
          { path: '/agents/:dataset', element: <AgentsPage /> },
        ],
        {
          initialEntries: [
            state === 'setup'
              ? '/agents?setup=1'
              : state === 'no-datasets'
                ? '/agents'
                : `/agents/agent_telemetry${
                    state === 'run-details'
                      ? `?${new URLSearchParams({ run: buildAgentRuns(exampleRows(state))[0].id })}`
                      : ['success', 'failed', 'incomplete'].includes(state)
                        ? `?status=${state}`
                        : ''
                  }`,
          ],
        },
      ),
    [state],
  );
  return (
    <AppContext.Provider
      value={{
        client,
        mode: state === 'demo' ? 'demo' : 'live',
        session: 0,
        needsLogin: false,
        identity: undefined,
        demoEnabled: false,
        setMode: () => {},
      }}
    >
      <RouterProvider router={router} />
    </AppContext.Provider>
  );
}
const meta = {
  title: 'Agents/Telemetry',
  component: Example,
  args: { state: 'default' },
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Empty: Story = { args: { state: 'empty' } };
export const PermissionDenied: Story = { args: { state: 'permission' } };
export const Error: Story = { args: { state: 'error' } };
export const Loading: Story = { args: { state: 'loading' } };
export const NoDatasets: Story = { args: { state: 'no-datasets' } };
export const MissingFields: Story = { args: { state: 'missing-fields' } };
export const Demo: Story = { args: { state: 'demo' } };
export const SuccessfulRuns: Story = { args: { state: 'success' } };
export const FailedRuns: Story = { args: { state: 'failed' } };
export const IncompleteRuns: Story = { args: { state: 'incomplete' } };
export const MissingTelemetry: Story = { args: { state: 'missing-telemetry' } };
export const RunDetails: Story = { args: { state: 'run-details' } };
export const TelemetrySetup: Story = { args: { state: 'setup' } };
