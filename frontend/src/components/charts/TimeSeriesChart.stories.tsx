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

const colors = ['#2563eb', '#f97316', '#10b981'];
const categories = ['gateway', 'payments', 'accounts', 'search', 'queues', 'exports'];
const categoryIndices = categories.map((_, index) => index);
const categorySeries: ChartSeries[] = [
  { id: 'api', label: 'API', values: [12, 18, 8, 22, 5, 14] },
  { id: 'workers', label: 'Workers', values: [8, 12, 16, 6, 9, 10] },
  { id: 'edge', label: 'Edge', values: [4, 5, 6, 8, 3, 7] },
];

export const Area: Story = {
  args: { title: 'Area', fill: true, paddedBounds: true, colors },
};
export const SmoothArea: Story = {
  args: { ...Area.args, title: 'Smooth area', smooth: true },
};
export const GroupedBars: Story = {
  args: {
    title: 'Grouped bars',
    timestamps: categoryIndices,
    categories,
    series: categorySeries,
    kind: 'bar',
    colors,
    paddedBounds: true,
    xAxisTitle: 'Service',
  },
};
export const StackedBars: Story = {
  args: { ...GroupedBars.args, title: 'Stacked bars', stacked: true },
};
export const HorizontalBars: Story = {
  args: { ...GroupedBars.args, title: 'Horizontal bars', horizontal: true, yAxisSize: 96 },
};
export const CategoricalLine: Story = {
  args: {
    title: 'Categorical line',
    timestamps: timestamps.map((_, index) => index),
    categories: [
      'gateway-eu',
      'gateway-us',
      'payments-eu',
      'payments-us',
      'accounts-eu',
      'accounts-us',
      'search-eu',
      'search-us',
      'background-worker-production-eu',
      'background-worker-production-us',
      'exports-eu',
      'exports-us',
    ],
    colors,
    paddedBounds: true,
    xAxisTitle: 'Service and region',
  },
};
export const BarsOverTime: Story = {
  args: {
    title: 'Bars over time',
    timestamps: [0, 60, 120, 300, 420, 480].map((offset) => timestamps[0] + offset),
    series: categorySeries,
    kind: 'bar',
    paddedBounds: true,
    colors,
  },
};
export const DarkGroupedBars: Story = {
  args: { ...GroupedBars.args, title: 'Grouped bars in dark theme' },
  render: (args) => <DarkChart {...args} />,
};
export const SignedStackedBars: Story = {
  args: {
    ...StackedBars.args,
    title: 'Positive and negative stacks',
    series: [
      { id: 'api', label: 'API', values: [12, -8, 10, null, -6, 4] },
      { id: 'workers', label: 'Workers', values: [8, -4, -5, 6, 3, -2] },
      { id: 'edge', label: 'Edge', values: [-4, 6, 3, 4, -2, 5] },
    ],
  },
};
export const HiddenCategoryAxis: Story = {
  args: { ...GroupedBars.args, title: 'Bars without category ticks', showXAxis: false },
};
export const CyclingPalette: Story = {
  args: {
    ...GroupedBars.args,
    title: 'Palette cycling with top series',
    series: [categorySeries[2], categorySeries[0], categorySeries[1]],
    colors: colors.slice(0, 2),
    maxSeries: 2,
  },
};
