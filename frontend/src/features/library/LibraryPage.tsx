import { useState } from 'react';
import { Plus } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  Input,
  Select,
  Sheet,
  Tabs,
} from '../../components/ui';
import { PageHeader } from '../../components/explorer/PageHeader';
export function LibraryPage() {
  const [dialog, setDialog] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [tab, setTab] = useState('overview');
  return (
    <div className="page">
      <PageHeader
        title="Component library"
        description="Small, accessible building blocks shared across the workspace."
      />
      <div className="library-grid">
        <Card>
          <h2>Actions</h2>
          <p className="muted">A consistent hierarchy for each next step.</p>
          <div className="inline wrap">
            <Button variant="primary">
              <Plus size={14} />
              Primary action
            </Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="ghost">Quiet action</Button>
            <Button variant="danger">Destructive</Button>
            <Button disabled>Disabled</Button>
          </div>
        </Card>
        <Card>
          <h2>Status</h2>
          <p className="muted">Status is communicated with text as well as color.</p>
          <div className="inline wrap">
            <Badge>Neutral</Badge>
            <Badge tone="success">Healthy</Badge>
            <Badge tone="warning">Warning</Badge>
            <Badge tone="danger">Error</Badge>
          </div>
        </Card>
        <Card>
          <h2>Form controls</h2>
          <div className="stack">
            <Input
              label="Dataset name"
              placeholder="application_logs"
              hint="Use a descriptive name."
            />
            <Input label="Invalid field" defaultValue="" error="A value is required." />
            <Select label="Signal">
              <option>Logs</option>
              <option>Metrics</option>
              <option>Traces</option>
            </Select>
          </div>
        </Card>
        <Card>
          <h2>Overlays</h2>
          <p className="muted">Focus stays inside the overlay and returns when it closes.</p>
          <div className="inline">
            <Button variant="secondary" onClick={() => setDialog(true)}>
              Open dialog
            </Button>
            <Button variant="secondary" onClick={() => setSheet(true)}>
              Open sheet
            </Button>
          </div>
          <Dialog
            open={dialog}
            onOpenChange={setDialog}
            title="Example dialog"
            description="Use dialogs for focused decisions."
          >
            <Input label="View name" />
            <div className="ui-dialog-footer">
              <Button onClick={() => setDialog(false)} data-dialog-confirm>
                Done
              </Button>
            </div>
          </Dialog>
          <Sheet
            open={sheet}
            onOpenChange={setSheet}
            title="Example sheet"
            description="Use sheets to inspect details without losing context."
          >
            <p>Compose fields, actions, and related data here.</p>
          </Sheet>
        </Card>
        <Card>
          <h2>Tabs</h2>
          <Tabs
            value={tab}
            onValueChange={setTab}
            aria-label="Example tabs"
            items={[
              {
                value: 'overview',
                label: 'Overview',
                content: <p>Use the arrow keys to switch tabs.</p>,
              },
              {
                value: 'details',
                label: 'Details',
                content: <p>Each panel has a clear purpose.</p>,
              },
            ]}
          />
        </Card>
        <Card>
          <h2>Empty state</h2>
          <EmptyState title="No saved views" description="Save a query to return to it later." />
        </Card>
      </div>
    </div>
  );
}
