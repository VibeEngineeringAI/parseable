import { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { ServiceInventory } from './ServiceInventory';
import { EMPTY_APM_STATS, type ApmMetric, type ApmService } from '../../lib/apm';
export const inventoryStoryServices: ApmService[] = [
  {
    ...EMPTY_APM_STATS,
    service: 'api-gateway',
    spanCount: 18420,
    traceCount: 17532,
    errorCount: 48,
    errorRate: 0.26,
    avgMs: 32.6,
    p50Ms: 24.2,
    p95Ms: 124.8,
    p99Ms: 380,
    maxMs: 1480,
  },
  {
    ...EMPTY_APM_STATS,
    service: 'checkout',
    spanCount: 7840,
    traceCount: 7620,
    errorCount: 392,
    errorRate: 5,
    avgMs: 168.4,
    p50Ms: 110,
    p95Ms: 540,
    p99Ms: 1100,
    maxMs: 3100,
  },
  {
    ...EMPTY_APM_STATS,
    service: 'inventory',
    spanCount: 5240,
    traceCount: 4810,
    errorCount: 0,
    errorRate: 0,
    avgMs: 12.1,
    p50Ms: 10,
    p95Ms: 42,
    p99Ms: 70,
    maxMs: 250,
  },
  {
    ...EMPTY_APM_STATS,
    service: 'background-worker',
    spanCount: 890,
    traceCount: 810,
    errorCount: 0,
    errorRate: 0,
  },
];
function Interactive(args: React.ComponentProps<typeof ServiceInventory>) {
  const [search, setSearch] = useState(''),
    [metric, setMetric] = useState<ApmMetric>('p95Ms');
  return (
    <ServiceInventory
      {...args}
      search={search}
      onSearchChange={setSearch}
      metric={metric}
      onMetricChange={setMetric}
    />
  );
}
const meta = {
  title: 'APM/ServiceInventory',
  component: ServiceInventory,
  decorators: [
    (Story) => (
      <MemoryRouter>
        <Story />
      </MemoryRouter>
    ),
  ],
  args: {
    dataset: 'demo_traces',
    services: inventoryStoryServices,
    search: '',
    metric: 'p95Ms',
    onSearchChange: () => {},
    onMetricChange: () => {},
  },
  parameters: { layout: 'padded' },
} satisfies Meta<typeof ServiceInventory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Services: Story = { render: (args) => <Interactive {...args} /> };
export const Empty: Story = { args: { services: [] } };
export const NoMatches: Story = { args: { search: 'missing-service' } };
export const LongServiceNames: Story = {
  args: {
    services: [
      {
        ...inventoryStoryServices[0],
        service: 'production/europe/checkout-and-payment-orchestration-service',
      },
    ],
  },
};
