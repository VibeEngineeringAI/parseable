import { useMemo, useState } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { AppContext } from '../../app/AppProvider';
import { createDemoClient } from '../../lib/demo';
import type { Dashboard, ParseableClient } from '../../lib/types';
import { DashboardView } from './DashboardView';
import classic from './__fixtures__/classic.json';

type Args = { readOnly?: boolean; stacked?: boolean };

function Playground({ readOnly = false, stacked = false }: Args) {
  const [revision, setRevision] = useState(0);
  const [saved, setSaved] = useState<Dashboard>();
  const client = useMemo(() => {
    let current: Dashboard = {
      ...structuredClone(classic),
      title: 'Editing playground',
      author: readOnly ? 'another-owner' : classic.author,
      variables: [],
      sections: [
        { sectionId: 'overview', title: 'Overview', collapsed: false },
        { sectionId: 'logs', title: 'Logs', collapsed: false },
      ],
      tiles: ['Requests', 'Latency'].map((title, index) => ({
        tile_id: `01JZ8Y4A0C7H3GQ5P2W9D8S00${index + 1}`,
        title,
        tileType: 'code',
        chartType: 'table',
        chartQuery: 'SELECT service, requests FROM "application_logs"',
        dbName: ['application_logs'],
        // Stacking the tiles in one column makes a vertical drag cross a sibling,
        // which is the case that changes reading order mid-gesture.
        layout: stacked ? { x: 0, y: index * 3, w: 4, h: 3 } : { x: index * 4, y: 0, w: 4, h: 3 },
        config: { type: 'table' },
        sectionId: 'overview',
      })),
    };
    return {
      ...createDemoClient(),
      async getDashboard() {
        return structuredClone(current);
      },
      async updateDashboard(_id, body) {
        current = { ...current, ...structuredClone(body), modified: '2026-10-10T09:00:00Z' };
        setSaved(structuredClone(current));
        return structuredClone(current);
      },
      async query() {
        return [
          { service: 'api', requests: 42 },
          { service: 'web', requests: 17 },
        ];
      },
      async schema() {
        return ['service', 'requests'];
      },
    } satisfies ParseableClient;
  }, [readOnly, stacked]);
  return (
    <div>
      <AppContext.Provider
        value={{
          client,
          mode: 'demo',
          session: 0,
          needsLogin: false,
          identity: { id: 'admin', username: 'admin', source: 'server' },
          demoEnabled: true,
          setMode: () => {},
        }}
      >
        <DashboardView key={revision} />
        <aside className="stack" aria-label="Story transport inspection" style={{ padding: 24 }}>
          <button type="button" onClick={() => setRevision((value) => value + 1)}>
            Reload saved dashboard
          </button>
          <details>
            <summary>Saved dashboard document</summary>
            <pre aria-label="Saved dashboard document">
              {JSON.stringify(saved ?? null, null, 2)}
            </pre>
          </details>
        </aside>
      </AppContext.Provider>
    </div>
  );
}
function Example({ readOnly = false, stacked = false }: Args) {
  const router = useMemo(
    () =>
      createMemoryRouter(
        [
          {
            path: '/dashboards/:id',
            element: <Playground readOnly={readOnly} stacked={stacked} />,
          },
        ],
        { initialEntries: [`/dashboards/${classic.dashboardId}`] },
      ),
    [readOnly, stacked],
  );
  return <RouterProvider router={router} />;
}
const meta = {
  title: 'Dashboards/Editing',
  component: Example,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Editable: Story = {};
export const ReadOnly: Story = { args: { readOnly: true } };
export const StackedTiles: Story = { args: { stacked: true } };
