import { useEffect } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { colourSchemes } from '../../features/dashboards/palettes';
import { PieChart, type PieChartProps } from './PieChart';

const slices = [
  { label: 'INFO', value: 72 },
  { label: 'WARN', value: 21 },
  { label: 'ERROR', value: 7 },
];

function DarkChart(args: PieChartProps) {
  useEffect(() => {
    const root = document.documentElement;
    const previous = root.dataset.theme;
    root.dataset.theme = 'dark';
    return () => {
      if (previous === undefined) delete root.dataset.theme;
      else root.dataset.theme = previous;
    };
  }, []);
  return <PieChart {...args} />;
}

const meta = {
  title: 'Dashboards/PieChart',
  component: PieChart,
  parameters: { layout: 'padded' },
  args: {
    slices,
    variant: 'pie',
    palette: colourSchemes.classic.colours,
    title: 'Events by level',
    height: 320,
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
} satisfies Meta<typeof PieChart>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Pie: Story = {};
export const Donut: Story = { args: { variant: 'donut' } };
export const WithLabels: Story = { args: { showLabels: true } };
export const LegendRight: Story = { args: { showLabels: true, legendPosition: 'right' } };
export const ManySlices: Story = {
  args: {
    showLabels: true,
    slices: Array.from({ length: 25 }, (_, index) => ({
      label: `Service ${index + 1} with a longer category name`,
      value: (index % 5) + 1,
    })),
  },
};
export const NegativeAndZero: Story = {
  args: {
    slices: [
      { label: 'Positive', value: 10 },
      { label: 'Negative', value: -3 },
      { label: 'Zero', value: 0 },
      { label: '', value: 2 },
    ],
  },
};
export const NonPositiveTotal: Story = {
  args: {
    slices: [
      { label: 'Negative', value: -5 },
      { label: 'Positive', value: 3 },
    ],
  },
};
export const SingleSlice: Story = { args: { slices: [slices[0]], variant: 'donut' } };
export const Empty: Story = { args: { slices: [] } };
export const Dark: Story = { render: (args) => <DarkChart {...args} /> };
