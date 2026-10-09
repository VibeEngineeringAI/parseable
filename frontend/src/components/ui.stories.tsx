import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Plus, RefreshCw } from 'lucide-react';
import { Badge, Button, Card, Dialog, EmptyState, Input, Select, Sheet, Spinner, Tabs } from './ui';

const meta = {
  title: 'Prism/Component library',
  parameters: { layout: 'padded' },
  decorators: [
    (Story) => (
      <div
        style={{
          fontFamily: 'var(--font-sans)',
          color: 'var(--color-text)',
          padding: 24,
          background: 'var(--color-bg)',
        }}
      >
        <Story />
      </div>
    ),
  ],
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Buttons: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
      <Button variant="primary">
        <Plus size={15} aria-hidden="true" />
        Create dataset
      </Button>
      <Button>Save view</Button>
      <Button variant="ghost">Cancel</Button>
      <Button variant="danger">Delete dataset</Button>
      <Button disabled>Unavailable</Button>
      <Button size="sm">Small action</Button>
      <Button size="icon" aria-label="Refresh results">
        <RefreshCw size={16} aria-hidden="true" />
      </Button>
    </div>
  ),
};

export const Inputs: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 20, maxWidth: 340 }}>
      <Input
        label="Dataset name"
        placeholder="production_logs"
        hint="Use a name your team can recognize."
      />
      <Input label="Query name" defaultValue="" error="Enter a name to save this query." />
      <Input label="Managed value" defaultValue="Read only" readOnly />
      <Select label="Time range" defaultValue="15m">
        <option value="15m">Last 15 minutes</option>
        <option value="1h">Last hour</option>
      </Select>
    </div>
  ),
};

export const Badges: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: 12 }}>
      <Badge>Logs</Badge>
      <Badge tone="success">Healthy</Badge>
      <Badge tone="warning">Warning</Badge>
      <Badge tone="danger">Error</Badge>
    </div>
  ),
};

function DialogExample() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)}>
        Save view
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Save view"
        description="Keep these filters and columns for your next investigation."
      >
        <Input label="View name" placeholder="Production errors" />
        <div className="ui-dialog-footer">
          <Button onClick={() => setOpen(false)}>Cancel</Button>
          <Button variant="primary" data-dialog-confirm onClick={() => setOpen(false)}>
            Save view
          </Button>
        </div>
      </Dialog>
    </>
  );
}
export const Modal: Story = { render: () => <DialogExample /> };

function SheetExample() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Inspect record</Button>
      <Sheet
        open={open}
        onOpenChange={setOpen}
        title="Record details"
        description="A single event from production_logs."
      >
        <pre style={{ fontFamily: 'var(--font-mono)', fontSize: 12, whiteSpace: 'pre-wrap' }}>
          {JSON.stringify(
            { level: 'info', message: 'Request completed', service: 'gateway' },
            null,
            2,
          )}
        </pre>
      </Sheet>
    </>
  );
}
export const DetailSheet: Story = { render: () => <SheetExample /> };

export const Empty: Story = {
  render: () => (
    <Card>
      <EmptyState
        title="No events match your filters"
        description="Try expanding the time range or removing a filter."
        action={<Button>Clear filters</Button>}
      />
    </Card>
  ),
};

function TabsExample() {
  const [value, setValue] = useState('table');
  return (
    <Tabs
      aria-label="Result format"
      value={value}
      onValueChange={setValue}
      items={[
        { value: 'table', label: 'Table', content: 'Events appear in a table.' },
        { value: 'json', label: 'JSON', content: 'Raw event fields appear here.' },
      ]}
    />
  );
}
export const TabViews: Story = { render: () => <TabsExample /> };
export const Loading: Story = { render: () => <Spinner label="Loading events" /> };
