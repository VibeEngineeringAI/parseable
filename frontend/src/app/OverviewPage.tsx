import { useCallback } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, Database, Logs, Terminal, Layers, Plug } from 'lucide-react';
import { Button, Card, Badge } from '../components/ui';
import { PageHeader } from '../components/explorer/PageHeader';
import { QueryState } from '../components/explorer/QueryState';
import { useAsync } from '../hooks/useAsync';
import { useApp } from './AppProvider';
export function OverviewPage({ onConnect }: { onConnect: () => void }) {
  const { client, mode } = useApp();
  const datasets = useAsync(useCallback((signal) => client.listDatasets(signal), [client]));
  return (
    <div className="page overview-page">
      <PageHeader
        title="Your data. A clearer picture."
        description="Explore your workspace and find the signals that matter."
        actions={
          <Button variant="secondary" onClick={onConnect}>
            <Plug size={15} />
            Connection
          </Button>
        }
      />
      <Card className="welcome-card">
        <div>
          <Badge>PARSEABLE WORKSPACE</Badge>
          <h2>From events to understanding.</h2>
          <p>
            Search your logs, ask questions with SQL, and build a shared language for your data.
          </p>
          <Link to="/logs" className="primary-link">
            Explore logs <ArrowUpRight size={16} />
          </Link>
        </div>
        <div className="welcome-art" aria-hidden="true">
          {Array.from({ length: 22 }, (_, i) => (
            <span key={i} style={{ height: `${20 + ((i * 37) % 95)}px` }} />
          ))}
        </div>
      </Card>
      <div className="overview-stats">
        <Card>
          <Database size={19} />
          <span className="muted">Available datasets</span>
          <strong>{datasets.loading ? '…' : datasets.error ? '—' : datasets.data?.length}</strong>
        </Card>
        <Card>
          <Layers size={19} />
          <span className="muted">Workspace</span>
          <strong>{mode === 'demo' ? 'Demo' : 'Self-hosted'}</strong>
        </Card>
        <Card>
          <Terminal size={19} />
          <span className="muted">Query language</span>
          <strong>SQL</strong>
        </Card>
      </div>
      <QueryState loading={datasets.loading} error={datasets.error} retry={datasets.reload} />
      <div className="section-heading">
        <h2>Start exploring</h2>
        <Link to="/datasets" className="text-link">
          View all datasets <ArrowUpRight size={14} />
        </Link>
      </div>
      <div className="dataset-grid">
        {datasets.data?.map((d) => (
          <Link
            key={d.name}
            className="overview-dataset"
            to={`/logs/explore/${encodeURIComponent(d.name)}`}
          >
            <div className="icon-tile">
              <Logs size={20} />
            </div>
            <div>
              <strong>{d.name}</strong>
              <p>Explore events and inspect fields</p>
            </div>
            <ArrowUpRight size={17} />
          </Link>
        ))}
      </div>
      <div className="notice">
        Explore logs, SQL, metrics, alerts, datasets, dashboards, and team settings. Traces and
        other advanced views will follow in later iterations.
      </div>
    </div>
  );
}
