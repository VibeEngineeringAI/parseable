import { useEffect } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { gaugeModel } from '../../features/dashboards/gauge';
import { GaugeChart, type GaugeChartProps } from './GaugeChart';

const tile = {
  tile_id: 'gauge',
  config: { layout: { segments: { value: [10, 90], isPercent: true } } },
};

function DarkChart(args: GaugeChartProps) {
  useEffect(() => {
    const root = document.documentElement;
    const previous = root.dataset.theme;
    root.dataset.theme = 'dark';
    return () => {
      if (previous === undefined) delete root.dataset.theme;
      else root.dataset.theme = previous;
    };
  }, []);
  return <GaugeChart {...args} />;
}

const meta = {
  title: 'Metrics/GaugeChart',
  component: GaugeChart,
  parameters: { layout: 'padded' },
  args: { label: 'CPU utilization', model: gaugeModel(5, tile), text: '5 %' },
  decorators: [
    (Story) => (
      <div
        style={{
          maxWidth: 480,
          padding: 16,
          color: 'var(--color-text)',
          background: 'var(--color-bg)',
        }}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            height: 240,
            background: 'var(--color-surface)',
          }}
        >
          <Story />
        </div>
      </div>
    ),
  ],
} satisfies Meta<typeof GaugeChart>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Green: Story = {};
export const Yellow: Story = { args: { model: gaugeModel(50, tile), text: '50 %' } };
export const Red: Story = { args: { model: gaugeModel(95, tile), text: '95 %' } };
export const Neutral: Story = {
  args: {
    model: gaugeModel(50, {
      ...tile,
      config: { colourScheme: 'classic', layout: { segments: { value: [] } } },
    }),
    text: '50 %',
  },
};
export const Overflow: Story = { args: { model: gaugeModel(140, tile), text: '140 %' } };
export const AbsoluteGB: Story = {
  args: {
    label: 'Disk used',
    model: gaugeModel(350, {
      ...tile,
      config: {
        layout: {
          rangeFrom: 0,
          rangeTo: 500,
          segments: { value: [300, 450], isPercent: false },
        },
      },
    }),
    text: '350.0 GB',
  },
};
export const Dark: Story = {
  args: { model: gaugeModel(50, tile), text: '50 %' },
  render: (args) => <DarkChart {...args} />,
};
export const SmallBox: Story = {
  args: { model: gaugeModel(75, tile), text: '75 %' },
  render: (args) => (
    <div style={{ display: 'flex', flexDirection: 'column', width: 160, height: 100 }}>
      <GaugeChart {...args} />
    </div>
  ),
};
