import { useCallback } from 'react';
import { Link } from 'react-router-dom';
import { Trash2, ArrowUpRight } from 'lucide-react';
import { Button, Card, Badge } from '../../components/ui';
import { QueryState } from '../../components/explorer/QueryState';
import { LogHistogram } from '../../components/explorer/LogHistogram';
import { useApp } from '../../app/AppProvider';
import { useAsync } from '../../hooks/useAsync';
import { buildLogQuery, timeBounds } from '../../lib/query';
import type { Dashboard } from './storage';
export function DashboardTile({
  dashboard,
  onDelete,
}: {
  dashboard: Dashboard;
  onDelete: () => void;
}) {
  const { client } = useApp();
  const results = useAsync(
    useCallback(
      (signal) =>
        client.query(
          { sql: buildLogQuery(dashboard.dataset, '', [], 100), ...timeBounds('1h') },
          signal,
        ),
      [client, dashboard.dataset],
    ),
  );
  return (
    <Card className="dashboard-tile" data-tile-id={dashboard.id}>
      <div className="panel-heading">
        <div>
          <h2>{dashboard.title}</h2>
          <p className="muted">{dashboard.description || dashboard.dataset}</p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Delete dashboard ${dashboard.title}`}
          onClick={onDelete}
        >
          <Trash2 size={15} />
        </Button>
      </div>
      <QueryState loading={results.loading} error={results.error} retry={results.reload} />
      {!results.loading && !results.error && <LogHistogram rows={results.data || []} />}
      <div className="dashboard-footer">
        <Badge>Last hour · up to 100 events</Badge>
        <Link className="text-link" to={`/logs/explore/${encodeURIComponent(dashboard.dataset)}`}>
          Explore <ArrowUpRight size={13} />
        </Link>
      </div>
    </Card>
  );
}
