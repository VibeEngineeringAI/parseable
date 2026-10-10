import { useCallback } from 'react';
import { Link, useLocation, useMatch } from 'react-router-dom';
import { Button } from '../../components/ui';
import { PageHeader } from '../../components/explorer/PageHeader';
import { QueryState } from '../../components/explorer/QueryState';
import { useApp } from '../../app/AppProvider';
import { AlertsList } from './AlertsList';
import { AlertDetail } from './AlertDetail';
import { AlertForm } from './AlertForm';
import { TargetsPage } from './TargetsPage';
import { resolveAlertTypes } from './helpers';
import { useAlertAccess } from './shared';
import { useCollection } from '../../hooks/useCollection';
import './alerts.css';

export function AlertsPage() {
  const location = useLocation();
  const targets = useMatch('/alerts/targets');
  const creating = useMatch('/alerts/new');
  const editing = useMatch('/alerts/:id/edit');
  const detail = useMatch('/alerts/:id');
  if (targets) return <TargetsPage />;
  if (creating) return <AlertForm key={location.key} />;
  const id = (editing ?? detail)?.params.id;
  if (id) return <LoadedAlert key={location.pathname} id={id} editing={Boolean(editing)} />;
  return <AlertsIndex />;
}
function AlertsIndex() {
  const { client } = useApp(),
    canWrite = useAlertAccess();
  const list = useCollection(
    useCallback(
      async (signal) => resolveAlertTypes(client, await client.listAlerts(signal), signal),
      [client],
    ),
  );
  return (
    <div className="page alerts-page stack">
      <PageHeader
        title="Alerts"
        description="Track thresholds in metrics and SQL query results."
        actions={
          <>
            <Link className="ui-button" data-variant="secondary" to="/alerts/targets">
              Targets
            </Link>
            <Button onClick={list.reload} disabled={list.loading}>
              Refresh
            </Button>
            {canWrite && (
              <Link className="ui-button" data-variant="primary" to="/alerts/new">
                New alert
              </Link>
            )}
          </>
        }
      />
      <QueryState loading={list.loading && !list.data} error={list.error} retry={list.reload} />
      {list.data && (
        <>
          {list.data.unchecked.length > 0 && (
            <p role="status" className="notice">
              Could not resolve the query type for {list.data.unchecked.length} alert(s). Other
              rules are available.{' '}
              <Button size="sm" onClick={list.reload}>
                Check again
              </Button>
            </p>
          )}
          <AlertsList
            rows={list.data.rows}
            refreshing={list.loading}
            onChanged={list.reload}
            canWrite={canWrite}
          />
        </>
      )}
    </div>
  );
}
function LoadedAlert({ id, editing }: { id: string; editing: boolean }) {
  const { client } = useApp();
  const detail = useCollection(useCallback((signal) => client.getAlert(id, signal), [client, id]));
  if (detail.data)
    return editing ? (
      <AlertForm key={id} original={detail.data} />
    ) : (
      <AlertDetail alert={detail.data} onChanged={detail.reload} />
    );
  return (
    <div className="page alerts-page">
      <PageHeader title={editing ? 'Edit alert' : 'Alert'} />
      <QueryState loading={detail.loading} error={detail.error} retry={detail.reload} />
    </div>
  );
}
