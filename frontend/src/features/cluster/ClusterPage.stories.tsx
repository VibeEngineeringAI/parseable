import type { Meta, StoryObj } from '@storybook/react-vite';
import { ClusterOverview } from './ClusterPage';
import { demoClusterNodes, demoClusterMetrics } from '../../lib/clusterDemo';
const meta = { title: 'Operations/Cluster', component: ClusterOverview } satisfies Meta<
  typeof ClusterOverview
>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Healthy: Story = { args: { nodes: demoClusterNodes } };
export const Empty: Story = { args: { nodes: [] } };
export const Unreachable: Story = {
  args: {
    nodes: [
      {
        ...demoClusterNodes[0],
        reachable: false,
        status: null,
        error: 'Connection refused',
        staging_path: '',
      },
    ],
  },
};

export const MissingMetric: Story = {
  args: {
    nodes: [demoClusterNodes[0]],
    metrics: [{ ...demoClusterMetrics[0], process_cpu_usage_percent_avg: null }],
  },
};
