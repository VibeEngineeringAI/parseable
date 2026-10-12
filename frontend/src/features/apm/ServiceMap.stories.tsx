import { MemoryRouter } from 'react-router-dom';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { ServiceMap } from './ServiceMap';
const meta = {
  title: 'APM/ServiceMap',
  component: ServiceMap,
  decorators: [
    (Story) => (
      <MemoryRouter>
        <Story />
      </MemoryRouter>
    ),
  ],
  args: {
    dataset: 'demo_traces',
    edges: [
      { source: 'api-gateway', target: 'checkout', spanCount: 7840, errorCount: 392, avgMs: 168.4 },
      { source: 'checkout', target: 'inventory', spanCount: 5240, errorCount: 0, avgMs: 12.1 },
      { source: 'checkout', target: 'payments', spanCount: 4880, errorCount: 24, avgMs: 320 },
    ],
  },
  parameters: { layout: 'padded' },
} satisfies Meta<typeof ServiceMap>;
export default meta;
type Story = StoryObj<typeof meta>;
export const DirectedServices: Story = {};
export const FocusedService: Story = { args: { focusedService: 'checkout' } };
export const CyclicDependencies: Story = {
  args: {
    edges: [
      ...meta.args.edges,
      { source: 'payments', target: 'checkout', spanCount: 20, errorCount: 0, avgMs: 40 },
    ],
  },
};
export const LongNames: Story = {
  args: {
    edges: [
      {
        source: 'production/europe/api-gateway',
        target: 'production/europe/checkout-and-payment-orchestration-service',
        spanCount: 48,
        errorCount: 0,
        avgMs: 30,
      },
    ],
  },
};
