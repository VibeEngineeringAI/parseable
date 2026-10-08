import { createId } from '../../lib/ids';
import { useCallback, useState, type FormEvent } from 'react';
import { Plus, Search } from 'lucide-react';
import { Button, Dialog, Input, Select, EmptyState } from '../../components/ui';
import { PageHeader } from '../../components/explorer/PageHeader';
import { QueryState } from '../../components/explorer/QueryState';
import { useApp } from '../../app/AppProvider';
import { useAsync } from '../../hooks/useAsync';
import { DashboardTile } from './DashboardTile';
import { loadDashboards, titleKey, type Dashboard } from './storage';
export function DashboardsPage() {
  const { client, mode } = useApp();
  const key = `parseable-dashboards-v1-${mode}`;
  const [dashboards, setDashboards] = useState(() => loadDashboards(key));
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [deleting, setDeleting] = useState<Dashboard>();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [dataset, setDataset] = useState('');
  const [error, setError] = useState('');
  const datasets = useAsync(useCallback((signal) => client.listDatasets(signal), [client]));
  const name = title.trim();
  // Titles label each tile's delete button, so they must be unique.
  const duplicate = dashboards.some((d) => titleKey(d.title) === titleKey(name));
  function persist(next: Dashboard[]) {
    try {
      localStorage.setItem(key, JSON.stringify(next));
      setDashboards(next);
      setError('');
      return true;
    } catch {
      setError('Could not save to browser storage. Free up space and try again.');
      return false;
    }
  }
  function create(e: FormEvent) {
    e.preventDefault();
    const selected = dataset || datasets.data?.[0]?.name;
    if (!name || duplicate || !selected) return;
    if (persist([...dashboards, { id: createId(), title: name, description, dataset: selected }])) {
      setOpen(false);
      setTitle('');
      setDescription('');
    }
  }
  return (
    <div className="page">
      <PageHeader
        title="Dashboards"
        description="Browser-local dashboards"
        actions={
          <Button variant="primary" onClick={() => setOpen(true)}>
            <Plus size={16} />
            Create dashboard
          </Button>
        }
      />
      <div className="list-toolbar">
        <div className="search-field">
          <Search size={16} aria-hidden="true" />
          <Input
            aria-label="Search dashboards"
            placeholder="Search dashboards"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <span className="muted">{dashboards.length} dashboards</span>
      </div>
      <div className="notice">
        Saved in this browser only. Each tile shows up to 100 returned events from the last hour.
      </div>
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
      {!dashboards.length ? (
        <EmptyState
          title="A clear view starts here"
          description="Create a dashboard to keep an eye on event volume for a dataset."
          action={
            <Button variant="primary" onClick={() => setOpen(true)}>
              <Plus size={15} />
              Create your first dashboard
            </Button>
          }
        />
      ) : (
        <div className="dashboard-grid">
          {dashboards
            .filter((d) =>
              `${d.title} ${d.description}`.toLowerCase().includes(search.toLowerCase()),
            )
            .map((d) => (
              <DashboardTile key={d.id} dashboard={d} onDelete={() => setDeleting(d)} />
            ))}
        </div>
      )}
      {!!dashboards.length &&
        !dashboards.some((d) =>
          `${d.title} ${d.description}`.toLowerCase().includes(search.toLowerCase()),
        ) && <EmptyState title="No dashboards found" description="Try a different search." />}
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Create dashboard"
        description="Choose a dataset for your first event-volume tile."
      >
        <form onSubmit={create} className="stack">
          <Input
            label="Dashboard name"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={80}
            error={duplicate ? 'A dashboard with this name already exists.' : undefined}
            required
          />
          <Input
            label="Description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <QueryState loading={datasets.loading} error={datasets.error} retry={datasets.reload} />
          <Select
            label="Dataset"
            value={dataset || datasets.data?.[0]?.name || ''}
            onChange={(e) => setDataset(e.target.value)}
            required
          >
            <option value="" disabled>
              Select a dataset
            </option>
            {datasets.data?.map((d) => (
              <option key={d.name}>{d.name}</option>
            ))}
          </Select>
          <Button
            variant="primary"
            type="submit"
            disabled={!datasets.data?.length || !name || duplicate}
            data-dialog-confirm
          >
            Create dashboard
          </Button>
        </form>
      </Dialog>
      <Dialog
        open={!!deleting}
        onOpenChange={(v) => {
          if (!v) setDeleting(undefined);
        }}
        title="Delete dashboard?"
        description={`Remove ${deleting?.title || 'this dashboard'} from this browser?`}
      >
        <Button
          variant="danger"
          data-dialog-confirm
          onClick={() => {
            if (persist(dashboards.filter((d) => d.id !== deleting?.id))) setDeleting(undefined);
          }}
        >
          Delete dashboard
        </Button>
      </Dialog>
    </div>
  );
}
