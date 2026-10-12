import { useEffect } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import type { BubbleGroup, BubblePoint } from '../../features/dashboards/bubble';
import { BubbleChart, type BubbleChartProps } from './BubbleChart';

const groups: BubbleGroup[] = [
  { id: 'api', label: 'API', colour: '#4b7bea' },
  { id: 'worker', label: 'Worker', colour: '#da1e28' },
  { id: 'scheduler', label: 'Scheduler', colour: '#1baf7a' },
];
const points: BubblePoint[] = Array.from({ length: 18 }, (_, index) => ({
  x: index * 5 + 5,
  y: 120 + Math.sin(index / 2) * 90 + index * 7,
  size: (index + 1) ** 2,
  radius: 4 + ((index + 1) / 18) * 14,
  groupId: 'api',
}));
const groupedPoints: BubblePoint[] = points.map((point, index) => ({
  ...point,
  groupId: groups[index % groups.length].id,
}));

function DarkChart(args: BubbleChartProps) {
  useEffect(() => {
    const root = document.documentElement;
    const previous = root.dataset.theme;
    root.dataset.theme = 'dark';
    return () => {
      if (previous === undefined) delete root.dataset.theme;
      else root.dataset.theme = previous;
    };
  }, []);
  return <BubbleChart {...args} />;
}

const meta = {
  title: 'Metrics/BubbleChart',
  component: BubbleChart,
  parameters: { layout: 'padded' },
  args: {
    points,
    groups: [groups[0]],
    title: 'Request duration chart',
    xLabel: 'Requests',
    yLabel: 'Duration',
    sizeLabel: 'Bytes',
    xTitle: 'Requests',
    yTitle: 'Duration (ms)',
  },
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
} satisfies Meta<typeof BubbleChart>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Grouped: Story = {
  args: { points: groupedPoints, groups, groupLabel: 'Service', legendPosition: 'right' },
};
export const TimeX: Story = {
  args: {
    points: groupedPoints.map((point, index) => ({ ...point, x: 1_700_000_000 + index * 14400 })),
    groups,
    groupLabel: 'Service',
    xIsTime: true,
    xLabel: 'Timestamp',
    xTitle: 'Timestamp (UTC)',
  },
};
export const NoSize: Story = {
  args: {
    points: points.map(({ size, ...point }) => ({ ...point, radius: 11 })),
    sizeLabel: undefined,
  },
};
export const DarkTheme: Story = {
  args: { points: groupedPoints, groups, groupLabel: 'Service' },
  render: (args) => <DarkChart {...args} />,
};
export const Empty: Story = {
  args: { points: [], groups: [], emptyMessage: 'No values returned' },
};
