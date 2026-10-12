import { useCallback, useMemo, useRef, useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { AppContext } from '../../app/AppProvider';
import { createDemoClient } from '../../lib/demo';
import { createLimiter } from '../../lib/concurrency';
import { timeBounds } from '../../lib/query';
import { DashboardRefreshControls, DashboardRefreshProvider } from './DashboardRefresh';
import { DashboardTile } from './DashboardTile';
import valueTile from './__fixtures__/query-value/query-value.json';
import './dashboards.css';

type Scenario = 'success' | 'slow' | 'failure' | 'recovery';
function Example({ scenario }: { scenario: Scenario }) {
  const [revision, setRevision] = useState(0);
  const revisionRef = useRef(revision);
  revisionRef.current = revision;
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  const anchor = useMemo(() => Date.now(), [revision]);
  const limit = useMemo(() => createLimiter(4), []);
  // Use the production tile and controller with an abort-aware fake transport.
  const client = useMemo(() => {
    const failed = new Set<number>();
    return {
      ...createDemoClient(),
      async query(_request: unknown, signal?: AbortSignal) {
        const cycle = revisionRef.current;
        signal?.throwIfAborted();
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => {
              signal?.removeEventListener('abort', abort);
              resolve();
            },
            scenario === 'slow' && cycle > 0 ? 20_000 : 200,
          );
          const abort = () => {
            clearTimeout(timer);
            reject(signal?.reason);
          };
          signal?.addEventListener('abort', abort, { once: true });
        });
        if (
          cycle > 0 &&
          (scenario === 'failure' || (scenario === 'recovery' && cycle === 1 && !failed.has(cycle)))
        ) {
          failed.add(cycle);
          throw new Error('The query service is temporarily unavailable.');
        }
        return [{ events: 42 + cycle }];
      },
    };
  }, [scenario]);
  return (
    <MemoryRouter>
      <AppContext.Provider
        value={{
          client,
          mode: 'demo',
          session: 0,
          needsLogin: false,
          identity: undefined,
          demoEnabled: true,
          setMode: () => {},
        }}
      >
        <DashboardRefreshProvider onRefresh={refresh}>
          <div className="stack" style={{ maxWidth: 850 }}>
            <div className="dashboard-time-toolbar">
              <DashboardRefreshControls />
            </div>
            <div className="dashboard-server-grid">
              <DashboardTile
                tile={{ ...valueTile, title: 'Requests' }}
                layout={{ x: 0, y: 0, w: 12, h: 5 }}
                dashboardId="story"
                variables={[]}
                values={{}}
                range="1h"
                bounds={timeBounds('1h', anchor)}
                anchor={anchor}
                revision={revision}
                ready
                writable={false}
                promqlAlerts={false}
                limit={limit}
                first
                last
                onAction={() => {}}
              />
            </div>
            <p className="muted">
              Select an interval or press Refresh. Timers wait for requests to finish and pause in
              hidden tabs.
            </p>
          </div>
        </DashboardRefreshProvider>
      </AppContext.Provider>
    </MemoryRouter>
  );
}
const meta = {
  title: 'Dashboards/Refresh',
  component: Example,
  args: { scenario: 'success' },
} satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Timer: Story = {};
export const SlowResponse: Story = { args: { scenario: 'slow' } };
export const Failure: Story = { args: { scenario: 'failure' } };
export const Recovery: Story = { args: { scenario: 'recovery' } };
