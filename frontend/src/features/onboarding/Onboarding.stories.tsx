import { MemoryRouter } from 'react-router-dom';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { SetupGuide, WorkspaceIntro } from './OnboardingPage';

const meta = {
  title: 'Onboarding/Setup guide',
  component: SetupGuide,
  decorators: [
    (Story) => (
      <MemoryRouter>
        <div style={{ maxWidth: 1000, padding: 24 }}>
          <Story />
        </div>
      </MemoryRouter>
    ),
  ],
  args: { datasets: [] },
} satisfies Meta<typeof SetupGuide>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Empty: Story = {};
export const AvailableDatasets: Story = {
  args: {
    datasets: [
      { name: 'app_logs', type: 'logs' },
      { name: 'otel_metrics', type: 'metrics' },
      { name: 'otel_traces', type: 'traces' },
    ],
  },
};
export const MetadataUnavailable: Story = {
  args: { datasets: [{ name: 'restricted_dataset', typeError: 'Permission denied' }] },
};
export const Demo: Story = {
  args: { demo: true, datasets: [{ name: 'sample_logs', type: 'logs' }] },
};
export const NewWorkspace: Story = {
  render: () => <WorkspaceIntro onConnect={() => {}} />,
};
