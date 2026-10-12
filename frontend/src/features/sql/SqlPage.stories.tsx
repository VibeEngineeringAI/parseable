import { useMemo, useState } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { AppContext } from '../../app/AppProvider';
import { createDemoClient } from '../../lib/demo';
import type { Dashboard, ParseableClient } from '../../lib/types';
import { SqlPage } from './SqlPage';
import '../dashboards/dashboards.css';

type Args = { failure?: boolean };
const initialSql = 'SELECT service, requests FROM "application_logs"';
function Playground({ failure = false }: Args) {
  const [saved, setSaved] = useState<Dashboard>();
  const [executed, setExecuted] = useState<string[]>([]);
  const client = useMemo(
    () =>
      ({
        ...createDemoClient(),
        async listDatasets() {
          return [
            { name: 'application_logs', type: 'logs' as const },
            { name: 'audit_logs', type: 'logs' as const },
          ];
        },
        async schema() {
          return ['p_timestamp', 'service', 'requests'];
        },
        async userRoleSources() {
          return {
            roles: {
              admin: { actions: [{ privilege: 'admin' as const }], roleType: 'user' as const },
            },
            groupRoles: {},
          };
        },
        async query(request, signal) {
          setExecuted((items) => [...items, request.sql]);
          // Explicit marker permits a reproducible overlapping request without
          // imposing a delay on all chart/library interactions.
          if (/slow/i.test(request.sql))
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(resolve, 1200);
              signal?.addEventListener(
                'abort',
                () => {
                  clearTimeout(timer);
                  reject(new DOMException('Aborted', 'AbortError'));
                },
                { once: true },
              );
            });
          if (failure || /fail/i.test(request.sql))
            throw new Error('Fixture query failed: invalid SQL');
          return [
            { service: /slow/i.test(request.sql) ? 'slow-result' : 'api', requests: 42 },
            { service: 'web', requests: 17 },
          ];
        },
        async listDashboards() {
          return [];
        },
        async createDashboard(body) {
          const dashboard = {
            ...structuredClone(body),
            dashboardId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
            created: '2026-10-10T00:00:00Z',
            modified: '2026-10-10T00:00:00Z',
          };
          setSaved(dashboard);
          return dashboard;
        },
      }) satisfies ParseableClient,
    [failure],
  );
  return (
    <AppContext.Provider
      value={{
        client,
        mode: 'live',
        session: 0,
        needsLogin: false,
        identity: { id: 'sql-story-user', username: 'SQL author', source: 'server' },
        demoEnabled: true,
        setMode: () => {},
      }}
    >
      <SqlPage />
      <aside aria-label="Story transport inspection" style={{ padding: 24 }}>
        <details>
          <summary>Saved dashboard document</summary>
          <pre data-testid="saved-sql-dashboard">{JSON.stringify(saved ?? null, null, 2)}</pre>
        </details>
        <details>
          <summary>Executed SQL</summary>
          <pre data-testid="executed-sql">{JSON.stringify(executed, null, 2)}</pre>
        </details>
      </aside>
    </AppContext.Provider>
  );
}
function Example(args: Args) {
  const router = useMemo(
    () =>
      createMemoryRouter([{ path: '/sql', element: <Playground {...args} /> }], {
        initialEntries: [`/sql?query=${encodeURIComponent(initialSql)}`],
      }),
    [args.failure],
  );
  return <RouterProvider router={router} />;
}
const meta = {
  title: 'SQL/Workspace',
  component: Example,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const FailedQuery: Story = { args: { failure: true } };
