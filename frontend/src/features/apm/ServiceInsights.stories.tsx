import { MemoryRouter } from 'react-router-dom';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { ServiceInsights } from './ServiceInsights';
import { EMPTY_APM_STATS, type ApmInsights } from '../../lib/apm';
const bounds = { startTime: '2026-10-12T15:00:00.000Z', endTime: '2026-10-12T16:00:00.000Z' };
const summary = {
  ...EMPTY_APM_STATS,
  spanCount: 360,
  traceCount: 180,
  errorCount: 18,
  errorRate: 5,
  avgMs: 120,
  p50Ms: 90,
  p95Ms: 420,
  p99Ms: 920,
  maxMs: 3100,
};
const insights: ApmInsights = {
  summary,
  operations: { rows: [{ ...summary, operation: 'POST /checkout' }], truncated: false },
  series: Array.from({ length: 36 }, (_, i) => ({
    ...summary,
    spanCount: 10,
    traceCount: 5,
    errorCount: i % 2,
    errorRate: (i % 2) * 10,
    avgMs: 80 + i * 3,
    p95Ms: 300 + i * 8,
    p99Ms: 700 + i * 10,
    bucket: new Date(Date.parse(bounds.startTime) + i * 100000).toISOString(),
  })),
  spans: {
    rows: [
      {
        traceId: '8e74f620af734b9086bb000000000001',
        spanId: '0000000000000001',
        operation: 'POST /checkout',
        startedAt: '2026-10-12T15:50:00.000Z',
        durationMs: 3100,
        error: true,
      },
      {
        traceId: '8e74f620af734b9086bb000000000002',
        spanId: '0000000000000002',
        operation: 'POST /checkout',
        startedAt: '2026-10-12T15:48:00.000Z',
        durationMs: 920,
        error: false,
      },
    ],
    truncated: false,
  },
};
const meta = {
  title: 'APM/ServiceInsights',
  component: ServiceInsights,
  decorators: [
    (Story) => (
      <MemoryRouter>
        <Story />
      </MemoryRouter>
    ),
  ],
  args: { dataset: 'demo_traces', service: 'checkout', bounds, insights },
  parameters: { layout: 'padded' },
} satisfies Meta<typeof ServiceInsights>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Overview: Story = {};
export const Empty: Story = {
  args: { insights: { ...insights, summary: { ...EMPTY_APM_STATS } } },
};
export const LimitedResults: Story = {
  args: {
    insights: {
      ...insights,
      operations: { ...insights.operations, truncated: true },
      spans: { ...insights.spans, truncated: true },
    },
  },
};
