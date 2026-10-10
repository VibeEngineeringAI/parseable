import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { TimeRangePicker } from './TimeRangePicker';
import type { TimeRange } from '../../lib/types';
import { dashboardPresets } from '../../features/dashboards/helpers';
const meta = {
  title: 'Prism/TimeRangePicker',
  component: TimeRangePicker,
  args: { value: '1h', onChange: () => {} },
} satisfies Meta<typeof TimeRangePicker>;
export default meta;
type Story = StoryObj<typeof meta>;
export const DashboardPresets: Story = {
  render: () => {
    const [range, setRange] = useState<TimeRange>('1h');
    return <TimeRangePicker value={range} onChange={setRange} presets={dashboardPresets} />;
  },
};
export const Disabled: Story = { args: { disabled: true, presets: dashboardPresets } };
