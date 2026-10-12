import { MemoryRouter } from 'react-router-dom';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { ServiceTopology } from './ServiceTopology';
const meta = {
  title: 'APM/ServiceTopology',
  component: ServiceTopology,
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
} satisfies Meta<typeof ServiceTopology>;
export default meta;
type Story = StoryObj<typeof meta>;
export const ObservedDependencies: Story = {};
export const FocusedService: Story = { args: { focusedService: 'inventory' } };
export const NoDependencies: Story = { args: { edges: [] } };
