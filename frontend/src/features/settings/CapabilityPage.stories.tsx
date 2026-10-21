import type { Meta, StoryObj } from '@storybook/react-vite';
import { MemoryRouter } from 'react-router-dom';
import { CapabilityPage } from './CapabilityPage';

const meta = {
  title: 'Settings/Capabilities',
  component: CapabilityPage,
  args: { feature: 'llm', demo: false },
  decorators: [
    (Story) => (
      <MemoryRouter>
        <Story />
      </MemoryRouter>
    ),
  ],
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof CapabilityPage>;
export default meta;
type Story = StoryObj<typeof meta>;
export const LlmProviders: Story = {};
export const Keystone: Story = { args: { feature: 'keystone' } };
export const Investigation: Story = {
  args: { feature: 'keystone', id: 'investigation-123' },
};
export const SampleWorkspace: Story = { args: { demo: true } };
