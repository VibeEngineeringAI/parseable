import { useEffect } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { QueryValue, type QueryValueProps } from './QueryValue';
import { queryValueThemes, type QueryValueTheme } from './queryValue';
import './dashboards.css';

function DarkQueryValue(args: QueryValueProps) {
  useEffect(() => {
    const root = document.documentElement;
    const previous = root.dataset.theme;
    root.dataset.theme = 'dark';
    return () => {
      if (previous === undefined) delete root.dataset.theme;
      else root.dataset.theme = previous;
    };
  }, []);
  return <QueryValue {...args} />;
}

const meta = {
  title: 'Metrics/QueryValue',
  component: QueryValue,
  parameters: { layout: 'padded' },
  args: { label: 'CPU utilization', text: '54.56 %', theme: 'emerald' },
  decorators: [
    (Story, context) => (
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
            height: context.parameters.queryValueHeight ?? 240,
            background: 'var(--color-surface)',
          }}
        >
          <Story />
        </div>
      </div>
    ),
  ],
} satisfies Meta<typeof QueryValue>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Emerald: Story = {};
export const Themes: Story = {
  parameters: { queryValueHeight: 720 },
  render: (args) => (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
        gap: 12,
        flex: 1,
        minHeight: 0,
      }}
    >
      {Object.entries(queryValueThemes).map(([theme, { label }]) => (
        <div key={theme} style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <p className="muted" style={{ padding: 8 }}>
            {label}
          </p>
          <QueryValue {...args} label={label} theme={theme as QueryValueTheme} />
        </div>
      ))}
    </div>
  ),
};
export const WithSparkline: Story = {
  args: { spark: [30, 42, 36, 58, 47, 65, 54.56] },
};
export const WithPercentFill: Story = {
  args: { text: '75 %' },
  render: (args) => (
    <div style={{ display: 'flex', gap: 16, flex: 1, minHeight: 0 }}>
      <QueryValue {...args} label="Vertical fill" fill={{ style: 'vertical', percent: 75 }} />
      <QueryValue {...args} label="Horizontal fill" fill={{ style: 'horizontal', percent: 75 }} />
    </div>
  ),
};
export const SmallBox: Story = {
  args: { label: 'Disk used', text: '1.2 GB' },
  render: (args) => (
    <div style={{ display: 'flex', flexDirection: 'column', width: 160, height: 100 }}>
      <QueryValue {...args} />
    </div>
  ),
};
export const Dark: Story = {
  args: {
    theme: 'blue',
    spark: [30, 42, 36, 58, 47, 65, 54.56],
    fill: { style: 'horizontal', percent: 54.56 },
  },
  render: (args) => <DarkQueryValue {...args} />,
};
export const Empty: Story = { args: { text: undefined } };
