import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { SearchableSelect, type SearchableSelectProps } from './SearchableSelect';
import { Dialog } from './Dialog';
import './ui.css';

const options = [
  { value: '', label: 'No dataset' },
  { value: 'app-logs' },
  { value: 'audit-events' },
  { value: 'production-api' },
  ...Array.from({ length: 150 }, (_, index) => ({ value: `service-${index}-logs` })),
];
function Example(props: Partial<SearchableSelectProps>) {
  const [value, setValue] = useState(props.value ?? 'app-logs');
  const [retries, setRetries] = useState(0);
  const [changes, setChanges] = useState(0);
  return (
    <div style={{ maxWidth: 400, padding: 20 }}>
      <button type="button">Outside control</button>
      <SearchableSelect
        label="Dataset"
        options={options}
        {...props}
        value={value}
        onValueChange={(next) => {
          setValue(next);
          setChanges((count) => count + 1);
        }}
        onRetry={props.error ? () => setRetries((count) => count + 1) : undefined}
      />
      <button type="button">Next control</button>
      <p data-testid="committed">{value || '(empty)'}</p>
      <p data-testid="retries">{retries}</p>
      <p data-testid="changes">{changes}</p>
    </div>
  );
}
const meta = {
  title: 'Prism/SearchableSelect',
  component: SearchableSelect,
  args: { label: 'Dataset', options, value: 'app-logs', onValueChange: () => {} },
  render: (args) => <Example {...args} />,
} satisfies Meta<typeof SearchableSelect>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Datasets: Story = {};
export const Unavailable: Story = {
  args: {
    value: 'deleted-logs',
    options: [...options, { value: 'deleted-logs', label: 'deleted-logs (unavailable)' }],
  },
};
export const LoadFailure: Story = { args: { options: [], error: 'Could not load datasets.' } };
export const Loading: Story = { args: { options: [], loading: true } };
export const Disabled: Story = { args: { disabled: true } };
export const InDialog: Story = {
  render: () => {
    const [open, setOpen] = useState(true);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Open editor
        </button>
        <Dialog
          open={open}
          onOpenChange={setOpen}
          title="Edit tile"
          description="Choose a dataset."
        >
          <Example />
        </Dialog>
      </>
    );
  },
};

export const AsyncOptions: Story = {
  render: () => {
    const [updated, setUpdated] = useState(false);
    const [value, setValue] = useState('app-logs');
    return (
      <div style={{ maxWidth: 400, padding: 20 }}>
        <button
          type="button"
          onClick={() => {
            setTimeout(() => setUpdated(true), 1000);
          }}
        >
          Refresh datasets
        </button>
        <SearchableSelect
          label="Dataset"
          value={value}
          onValueChange={setValue}
          options={
            updated
              ? [{ value: 'production-api' }]
              : [{ value: 'app-logs' }, { value: 'audit-events' }]
          }
        />
        <p data-testid="committed">{value}</p>
      </div>
    );
  },
};

export const RetryLoading: Story = {
  render: () => {
    const [loading, setLoading] = useState(false);
    const [failed, setFailed] = useState(true);
    const [value, setValue] = useState('app-logs');
    return (
      <div style={{ maxWidth: 400, padding: 20 }}>
        <SearchableSelect
          label="Dataset"
          value={value}
          onValueChange={setValue}
          options={failed ? [{ value: 'app-logs' }] : options}
          loading={loading}
          error={failed ? 'Could not load datasets.' : undefined}
          onRetry={() => {
            setLoading(true);
            setTimeout(() => {
              setLoading(false);
              setFailed(false);
            }, 1000);
          }}
        />
      </div>
    );
  },
};
