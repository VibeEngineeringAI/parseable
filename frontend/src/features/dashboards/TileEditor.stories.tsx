import { useMemo, useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { AppContext } from '../../app/AppProvider';
import { createDemoClient } from '../../lib/demo';
import { createLimiter } from '../../lib/concurrency';
import type { DashboardTile, DashboardVariable } from '../../lib/types';
import { TileEditor } from './TileEditor';
import { newTile } from './tiles';
import { newBuilderQuery } from './builder';
import './dashboards.css';

const variables: DashboardVariable[] = [];
const values = {};
const sections = [{ sectionId: 'overview', title: 'Overview', id: 'opaque-id' }];

type Scenario = 'visual' | 'stored-sql' | 'legacy' | 'validation' | 'opaque';
function fixture(scenario: Scenario): DashboardTile {
  const tile: DashboardTile = {
    ...newTile([]),
    tile_id: 'story-tile',
    title: 'Request volume',
    tileType: 'builder',
    dbName: ['application_logs'],
    chartType: 'timeseries',
    chartQuery: newBuilderQuery('timeseries'),
    extensionMetadata: { owner: 'Observability', version: 7 },
  };
  if (scenario === 'stored-sql')
    tile.chartQuery = {
      sql: 'SELECT COUNT(*) AS requests FROM "application_logs"',
      customMetadata: { keep: true },
    };
  if (scenario === 'legacy') delete tile.tileType;
  if (scenario === 'opaque')
    tile.chartQuery = { vendorDefinition: { opaque: true }, filters: 'custom expression' };
  if (scenario === 'validation') {
    tile.chartType = 'bar';
    tile.chartQuery = {
      x: {
        fields: [{ name: 'service' }],
        sortBy: { field: 'duration', direction: 'ASC', vendorSort: true },
      },
      y: { fields: [{ name: 'duration', aggregate: 'AVG' }], groupBy: ['host'], limit: 100 },
      filters: [
        { column: 'duration', operator: '>=', value: 10 },
        { column: 'success', operator: '=', value: true },
      ],
    };
  }
  return tile;
}
function Example({ scenario }: { scenario: Scenario }) {
  const [original] = useState(() => fixture(scenario));
  const [open, setOpen] = useState(true);
  const [applied, setApplied] = useState<DashboardTile>();
  const [queries, setQueries] = useState<string[]>([]);
  const limiter = useMemo(() => createLimiter(2), []);
  const client = useMemo(
    () => ({
      ...createDemoClient(),
      async listDatasets() {
        return [
          { name: 'application_logs', type: 'logs' as const },
          { name: 'audit_logs', type: 'logs' as const },
        ];
      },
      async schema(dataset: string) {
        return dataset === 'audit_logs'
          ? ['p_timestamp', 'actor', 'message']
          : ['p_timestamp', 'service', 'host', 'duration', 'success', 'message'];
      },
      async query(request: { sql: string }) {
        setQueries((current) => [...current, request.sql]);
        return [
          {
            time_bucket: '2026-01-01T00:00:00Z',
            COUNT_STAR: 42,
            AVG_duration: 12.5,
            service: 'api',
            host: 'host-1',
          },
        ];
      },
    }),
    [],
  );
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
        {open && (
          <TileEditor
            original={original}
            sections={sections}
            tiles={[original]}
            variables={variables}
            values={values}
            limit={limiter}
            promqlEnabled={false}
            metadataEnabled={false}
            start={1767225600}
            end={1767229200}
            onDirty={() => {}}
            onClose={() => setOpen(false)}
            onApply={(tile) => {
              setApplied(tile);
              setOpen(false);
            }}
          />
        )}
        {!open && (
          <div className="stack">
            <p>Applied tile</p>
            <pre data-testid="applied-tile">{JSON.stringify(applied ?? null, null, 2)}</pre>
            <p>Executed queries</p>
            <pre data-testid="executed-queries">{JSON.stringify(queries, null, 2)}</pre>
          </div>
        )}
      </AppContext.Provider>
    </MemoryRouter>
  );
}
const meta = {
  title: 'Dashboards/Tile editor',
  component: Example,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;
export const VisualAuthoring: Story = { args: { scenario: 'visual' } };
export const StoredSqlPreserved: Story = { args: { scenario: 'stored-sql' } };
export const LegacyMissingType: Story = { args: { scenario: 'legacy' } };
export const TypedFiltersAndLimits: Story = { args: { scenario: 'validation' } };
export const OpaqueQueryPreserved: Story = { args: { scenario: 'opaque' } };
