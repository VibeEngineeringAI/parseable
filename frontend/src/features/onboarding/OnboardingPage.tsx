import { useCallback } from 'react';
import { Link } from 'react-router-dom';
import { Database, Import, Search, UsersRound } from 'lucide-react';
import { useApp } from '../../app/AppProvider';
import { PageHeader } from '../../components/explorer/PageHeader';
import { QueryState } from '../../components/explorer/QueryState';
import { Badge, Button, Card } from '../../components/ui';
import { useAsync } from '../../hooks/useAsync';
import {
  datasetPath,
  listDatasetInventory,
  type DatasetInventoryEntry,
} from '../../lib/datasetPath';
import './onboarding.css';

export function SetupGuide({
  datasets,
  demo = false,
}: {
  datasets: DatasetInventoryEntry[];
  demo?: boolean;
}) {
  return (
    <div className="setup-guide">
      <Card className="setup-step">
        <Import size={22} aria-hidden="true" />
        <div>
          <h2>1. Connect your data</h2>
          <p>
            Choose JSON, OTLP, or an OpenTelemetry Collector, select a dataset, and check for
            arriving events.
          </p>
          <p className="muted">
            {demo
              ? 'Sample datasets are available. Ingestion checks require a live server.'
              : `${datasets.length} accessible ${datasets.length === 1 ? 'dataset' : 'datasets'}. A dataset alone does not confirm ingestion.`}
          </p>
          <Link className="ui-button" data-variant="primary" to="/add-data">
            Set up ingestion
          </Link>
        </div>
      </Card>
      <Card className="setup-step">
        <Search size={22} aria-hidden="true" />
        <div>
          <h2>2. Explore your signals</h2>
          <p>Open an available dataset in its matching explorer, or query it with SQL.</p>
          {datasets.length > 0 ? (
            <ul className="setup-datasets">
              {datasets.slice(0, 8).map((dataset) => (
                <li key={dataset.name}>
                  {dataset.type ? (
                    <Link to={datasetPath(dataset)}>
                      {dataset.name}
                      <Badge>{dataset.type}</Badge>
                    </Link>
                  ) : (
                    <span>
                      {dataset.name} <span className="muted">— {dataset.typeError}</span>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No accessible datasets yet. Start by adding data.</p>
          )}
          <div className="inline">
            <Link to="/datasets">View all datasets</Link>
            <Link to="/sql-editor">Open SQL editor</Link>
          </div>
        </div>
      </Card>
      <Card className="setup-step">
        <UsersRound size={22} aria-hidden="true" />
        <div>
          <h2>3. Share access</h2>
          <p>
            Administrators can manage users and roles for this server. Access follows your server
            permissions.
          </p>
          <Link to="/team">Manage your team</Link>
        </div>
      </Card>
    </div>
  );
}

export function OnboardingPage() {
  const { client, mode } = useApp();
  const inventory = useAsync(
    useCallback((signal) => listDatasetInventory(client, signal), [client]),
  );
  return (
    <div className="page onboarding-page">
      <PageHeader
        title="Get started"
        description="Set up this workspace, connect telemetry, and explore your data."
        actions={
          <Button onClick={inventory.reload} disabled={inventory.loading}>
            Refresh setup
          </Button>
        }
      />
      <QueryState loading={inventory.loading} error={inventory.error} retry={inventory.reload} />
      {inventory.data && <SetupGuide datasets={inventory.data} demo={mode === 'demo'} />}
    </div>
  );
}

export function WorkspaceIntro({
  onConnect,
  demo = false,
}: {
  onConnect: () => void;
  demo?: boolean;
}) {
  return (
    <div className="page onboarding-page">
      <PageHeader
        title="Set up a workspace"
        description="Start with the Parseable server serving this application."
      />
      <Card className="setup-step">
        <Database size={24} aria-hidden="true" />
        <div>
          <h2>{demo ? 'You are exploring a demo workspace' : 'Your server is your workspace'}</h2>
          <p>
            This frontend connects to its own Parseable server. Creating a separate hosted workspace
            is not supported by this server’s API.
          </p>
          <div className="inline">
            <Link className="ui-button" data-variant="primary" to="/onboarding">
              {demo ? 'Explore setup' : 'Set up this server'}
            </Link>
            <Button onClick={onConnect}>Connection settings</Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

export function NewWorkspacePage({ onConnect }: { onConnect: () => void }) {
  const { mode } = useApp();
  return <WorkspaceIntro onConnect={onConnect} demo={mode === 'demo'} />;
}
