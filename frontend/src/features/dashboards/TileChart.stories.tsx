import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Button, Select } from '../../components/ui';
import type { DashboardTile, LogRecord } from '../../lib/types';
import { TileChart } from './TileChart';
import { TileBindingFields } from './TileBindingFields';
import {
  applyChartChoice,
  chartChoice,
  chartChoices,
  chartIssues,
  type ChartChoice,
} from './chartPicker';
import './dashboards.css';

const start = Date.parse('2026-10-10T08:00:00Z') / 1000;
const end = start + 240;
const rows = Array.from({ length: 5 }, (_, index) => [
  {
    time: new Date((start + index * 60) * 1000).toISOString(),
    service: 'api',
    region: 'east',
    requests: [12, 18, 10, 24, 16][index],
    errors: index + 1,
    size: 10 + index,
  },
  {
    time: new Date((start + index * 60) * 1000).toISOString(),
    service: 'worker',
    region: 'west',
    requests: [6, 8, 14, 10, 12][index],
    errors: index + 2,
    size: 20 + index,
  },
]).flat();
const base: DashboardTile = {
  tile_id: 'story',
  title: 'Requests',
  chartType: 'timeseries',
  config: {
    type: 'line',
    axes: { x: { field: 'time' }, y: { field: 'requests' }, groupBy: { field: ['service'] } },
  },
};

type ExampleProps = { initial: DashboardTile; data?: LogRecord[]; editor?: boolean };
function Example({ initial, data = rows, editor = false }: ExampleProps) {
  const [tile, setTile] = useState(initial);
  const [saved, setSaved] = useState<DashboardTile>();
  const [range, setRange] = useState({ start, end });
  const [zooms, setZooms] = useState(0);
  const change = (edits: Partial<DashboardTile>) =>
    setTile((current) => ({ ...current, ...edits }));
  const issues = chartIssues(tile);
  return (
    <div
      className="stack"
      style={{
        maxWidth: 900,
        padding: 16,
        background: 'var(--color-surface)',
        color: 'var(--color-text)',
      }}
    >
      {editor && (
        <>
          <Select
            label="Chart type"
            value={chartChoice(tile)}
            onChange={(event) => change(applyChartChoice(tile, event.target.value as ChartChoice))}
          >
            {chartChoices.map(({ value, label }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
          <TileBindingFields draft={tile} change={change} columns={Object.keys(data[0] ?? {})} />
          <p role="status" aria-label="Binding validation">
            {issues.join(' ') || 'Bindings valid'}
          </p>
          <Button
            disabled={issues.length > 0}
            onClick={() => setSaved(JSON.parse(JSON.stringify(tile)))}
          >
            Save and reload tile
          </Button>
        </>
      )}
      <section aria-label="Chart preview">
        <TileChart
          tile={saved ?? tile}
          result={{ rows: data }}
          start={range.start}
          end={range.end}
          height={240}
          onZoomRange={(next) => {
            setRange({
              start: Date.parse(next.startTime) / 1000,
              end: Date.parse(next.endTime) / 1000,
            });
            setZooms((count) => count + 1);
          }}
        />
      </section>
      <output aria-label="Zoom count">{zooms}</output>
    </div>
  );
}
const meta = {
  title: 'Dashboards/TileChart',
  component: Example,
  args: { initial: base },
} satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;
export const DashboardRange: Story = {};
export const AbsoluteTileRange: Story = {
  args: {
    initial: {
      ...base,
      timeRange: {
        type: 'custom',
        startTime: new Date(start * 1000).toISOString(),
        endTime: new Date(end * 1000).toISOString(),
      },
    },
  },
};
export const RelativeTileRange: Story = {
  args: { initial: { ...base, timeRange: { type: 'fixed', startTime: '1h', endTime: 'now' } } },
};
export const StackedEditor: Story = {
  args: {
    editor: true,
    initial: {
      ...base,
      chartType: 'bar',
      config: {
        type: 'bar',
        axes: {
          x: { field: 'time' },
          y: { field: ['requests', 'errors'] },
          groupBy: { field: ['service'] },
        },
      },
    },
  },
};
export const BubbleEditor: Story = {
  args: {
    editor: true,
    initial: {
      ...base,
      chartType: 'bar',
      config: {
        axes: {
          x: { field: 'size' },
          y: { field: 'requests' },
          groupBy: { field: ['service', 'region'] },
        },
      },
    },
  },
};
export const CollidingGroupLabels: Story = {
  args: {
    initial: {
      ...base,
      chartType: 'bar',
      config: {
        axes: {
          x: { field: 'category' },
          y: { field: 'requests' },
          groupBy: { field: ['service', 'region'] },
        },
      },
    },
    data: [
      { category: 'Monday', service: 'api | east', region: 'us', requests: 2 },
      { category: 'Monday', service: 'api', region: 'east | us', requests: 3 },
      { category: 'Tuesday', service: 'api | east', region: 'us', requests: 4 },
      { category: 'Tuesday', service: 'api', region: 'east | us', requests: 6 },
    ],
  },
};
