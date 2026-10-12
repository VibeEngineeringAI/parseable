import type { Meta, StoryObj } from '@storybook/react-vite';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { NetworkAccessEditor } from './NetworkAccessPage';
import { createDemoClient } from '../../lib/demo';
import { ApiError } from '../../lib/apiError';
const meta = {
  title: 'Settings/Network access',
  component: NetworkAccessEditor,
  args: { client: createDemoClient(), demo: true },
  decorators: [
    (Story) => <RouterProvider router={createMemoryRouter([{ path: '*', element: <Story /> }])} />,
  ],
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof NetworkAccessEditor>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const PermissionDenied: Story = {
  args: {
    demo: false,
    client: {
      ...createDemoClient(),
      getAlertTargetPolicy: async () => {
        throw new ApiError('Forbidden', 403);
      },
    },
  },
};
export const Error: Story = {
  args: {
    demo: false,
    client: {
      ...createDemoClient(),
      getAlertTargetPolicy: async () => {
        throw new ApiError('Service unavailable', 503);
      },
    },
  },
};
export const Loading: Story = {
  args: {
    demo: false,
    client: { ...createDemoClient(), getAlertTargetPolicy: () => new Promise(() => {}) },
  },
};
export const ValidationError: Story = {
  args: {
    demo: false,
    client: {
      ...createDemoClient(),
      putAlertTargetPolicy: async () => {
        throw new ApiError('allow and deny CIDR lists conflict', 400);
      },
    },
  },
};
