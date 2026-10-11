import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { TimeSeriesChart, type ChartSeries, type TimeSeriesChartProps } from './TimeSeriesChart';

const timestamps = Array.from({ length: 12 }, (_, index) => 1_700_000_000 + index * 60);
const series: ChartSeries[] = ['alpha', 'beta', 'gamma'].map((host, slot) => ({
  id: host,
  label: `{host="${host}"}`,
  values: timestamps.map((_, index) => (slot + 1) * 2.5 + Math.sin(index / 2 + slot)),
}));

function DarkChart(args: TimeSeriesChartProps) {
  useEffect(() => {
    const root = document.documentElement;
    const previous = root.dataset.theme;
    root.dataset.theme = 'dark';
    return () => {
      if (previous === undefined) delete root.dataset.theme;
      else root.dataset.theme = previous;
    };
  }, []);
  return <TimeSeriesChart {...args} />;
}

function RerenderingChart(args: TimeSeriesChartProps) {
  const [revision, setRevision] = useState(0);
  const [threshold, setThreshold] = useState(2);
  const [end, setEnd] = useState(timestamps[0] + 3000);
  return (
    <>
      <button onClick={() => setRevision((value) => value + 1)}>Render again</button>
      <button onClick={() => setThreshold((value) => value + 1)}>Raise threshold</button>
      <button onClick={() => setEnd((value) => value + 600)}>Extend range</button>
      <p role="status">Render {revision}</p>
      <TimeSeriesChart
        {...args}
        thresholds={[{ value: threshold, label: 'Threshold' }]}
        xRange={[timestamps[0] - 600, end]}
      />
    </>
  );
}

const meta = {
  title: 'Metrics/TimeSeriesChart',
  component: TimeSeriesChart,
  parameters: { layout: 'padded' },
  args: { timestamps, series, title: 'PromQL range result' },
  decorators: [
    (Story) => (
      <div
        style={{
          maxWidth: 960,
          padding: 16,
          color: 'var(--color-text)',
          background: 'var(--color-bg)',
        }}
      >
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TimeSeriesChart>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ThreeSeries: Story = {};
export const RequestedRange: Story = {
  args: {
    series: [series[0]],
    showTitle: false,
    xRange: [timestamps[0] - 600, timestamps[0] + 3000],
  },
};
export const ManySeries: Story = {
  args: {
    series: Array.from({ length: 25 }, (_, slot) => ({
      id: `host-${slot + 1}`,
      label: `{host="node-${slot + 1}"}`,
      values: timestamps.map((_, index) => slot + Math.sin(index / 2 + slot)),
    })),
  },
};
export const GapsAndNaN: Story = {
  args: {
    series: [
      { id: 'gaps', label: '{host="gaps"}', values: [1, 2, null, null, 4, 3, 2, null, 1, 2, 3, 4] },
      {
        id: 'nan',
        label: '{host="non-finite"}',
        values: [2, 3, NaN, Infinity, 5, 4, -Infinity, 3, 2, 3, 4, 5],
      },
    ],
  },
};
export const Empty: Story = { args: { timestamps: [], series: [] } };
export const DarkTheme: Story = { render: (args) => <DarkChart {...args} /> };
export const Rerendering: Story = { render: (args) => <RerenderingChart {...args} /> };
export const WithThresholds: Story = {
  args: {
    series: [
      {
        id: 'host-a',
        label: 'host-a',
        values: timestamps.map((_, index) => 3.75 + Math.sin(index / 2) / 2),
      },
    ],
    thresholds: [
      { value: 2, label: 'Lower threshold' },
      { value: 6, label: 'Upper threshold' },
    ],
  },
};
export const DashboardSizing: Story = {
  args: { height: 180, yAxisSize: 112, announceSeries: false },
};
