import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { PromqlEditor, type PromqlEditorProps, type PromqlMetadataSource } from './PromqlEditor';

const metadata: PromqlMetadataSource = {
  metricNames: async () => [
    'system.cpu.load_average.1m',
    'http.server.requests',
    'process.memory.usage',
  ],
  labelNames: async () => ['host', 'service.name', 'method'],
  labelValues: async (label) =>
    label === 'host'
      ? ['alpha', 'beta', 'gamma']
      : label === 'service.name'
        ? ['gateway', 'worker']
        : ['GET', 'POST'],
};

function EditorExample(args: PromqlEditorProps) {
  const [value, setValue] = useState(args.value);
  const [runs, setRuns] = useState(0);
  useEffect(() => setValue(args.value), [args.value]);
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <PromqlEditor
        {...args}
        value={value}
        onChange={(next) => {
          setValue(next);
          args.onChange(next);
        }}
        onRun={() => {
          setRuns((count) => count + 1);
          args.onRun?.();
        }}
      />
      {args.invalid && (
        <p id={args.describedBy} role="alert">
          Enter a complete PromQL expression.
        </p>
      )}
      <p role="status">Run count: {runs}</p>
      <button type="button">Next control</button>
    </div>
  );
}

const meta = {
  title: 'Metrics/PromqlEditor',
  component: PromqlEditor,
  parameters: { layout: 'padded' },
  args: { value: '', onChange: fn(), onRun: fn() },
  render: (args) => <EditorExample {...args} />,
  decorators: [
    (Story) => (
      <div
        style={{
          maxWidth: 860,
          padding: 16,
          color: 'var(--color-text)',
          background: 'var(--color-bg)',
        }}
      >
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PromqlEditor>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {};
export const WithMetadata: Story = {
  args: { value: 'rate({"http.server.requests"}[5m])', metadata },
};
export const Invalid: Story = {
  args: { value: 'rate(', invalid: true, describedBy: 'promql-error' },
};
