import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useApp } from '../../app/AppProvider';
import { createId } from '../../lib/ids';
import { Button, Dialog, Input, InlineError, Select } from '../../components/ui';
import { QueryState } from '../../components/explorer/QueryState';
import { useAsync } from '../../hooks/useAsync';
import { useMutation } from '../../hooks/useMutation';
import { loadMetricLibrary, saveMetricLibrary, type NamedMetricQuery } from '../../lib/promql';
import type { Dashboard } from '../../lib/types';
import { useDashboardAccess } from '../dashboards/owner';
import { classicTimeRange } from '../dashboards/timeRange';
import { appendSqlTile } from '../sql/sqlChart';
import type { QueryResult, RunSnapshot } from './helpers';
import { executedMetricTile, metricAlertHandoff } from './reuse';

export function MetricsReuse({
  snapshot,
  results,
  scope,
  promqlAlerts,
  onLoad,
}: {
  snapshot?: RunSnapshot;
  results: QueryResult[];
  scope: string | null;
  promqlAlerts: boolean;
  onLoad: (item: NamedMetricQuery) => void;
}) {
  const { client } = useApp();
  const navigate = useNavigate();
  const access = useDashboardAccess();
  const mutation = useMutation();
  const [selectedId, setSelectedId] = useState('');
  const [name, setName] = useState('');
  const [library, setLibrary] = useState(() => loadMetricLibrary(scope));
  const [storageError, setStorageError] = useState('');
  const [open, setOpen] = useState(false);
  const [destination, setDestination] = useState('new');
  const [title, setTitle] = useState('');
  const [saved, setSaved] = useState<Dashboard>();
  const saveRead = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => saveRead.current?.abort(), []);
  const dashboards = useAsync(
    useCallback(
      (signal) => (open ? client.listDashboards(signal) : Promise.resolve([])),
      [client, open],
    ),
  );
  const selectedDashboard = useAsync(
    useCallback(
      (signal) =>
        open && destination !== 'new'
          ? client.getDashboard(destination, signal)
          : Promise.resolve(undefined),
      [client, open, destination],
    ),
  );
  const row =
    snapshot?.queries.find((entry) => entry.id === selectedId) ??
    (snapshot?.queries.length === 1 ? snapshot.queries[0] : undefined);
  const result = results.find((entry) => entry.id === row?.id);
  const ready = !!row && !!result && result.pending === 0 && !!(result.range || result.instant);
  const alert =
    snapshot && row
      ? metricAlertHandoff(snapshot, row.id, result)
      : { reason: 'Select an executed query.' };
  const issue =
    destination === 'new'
      ? !access.canCreate
        ? 'Dashboard creation is unavailable for this account.'
        : !title.trim()
          ? 'Enter a dashboard title.'
          : ''
      : selectedDashboard.loading
        ? 'Loading dashboard…'
        : !selectedDashboard.data || !access.hash || selectedDashboard.data.author !== access.hash
          ? 'Only the owner can edit this dashboard.'
          : '';
  function writeLibrary(items: NamedMetricQuery[]) {
    if (saveMetricLibrary(scope, items)) {
      setLibrary(items);
      setStorageError('');
    } else setStorageError('Browser storage is unavailable or full. The library was not saved.');
  }
  return (
    <div className="stack metrics-reuse">
      <details>
        <summary>Saved metrics queries ({library.length})</summary>
        <p className="muted">
          Private to this browser, server and signed-in account. Demo queries use separate storage.
          Clearing browser data removes this library.
        </p>
        {!scope && <p className="muted">Sign in to use local history and saved queries.</p>}
        {library.map((item) => (
          <div className="inline wrap" key={item.id}>
            <Button variant="ghost" size="sm" onClick={() => onLoad(item)}>
              {item.name} · {item.dataset}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Delete saved query ${item.name}`}
              onClick={() => writeLibrary(library.filter((v) => v.id !== item.id))}
            >
              Delete
            </Button>
          </div>
        ))}
      </details>
      {snapshot && (
        <>
          <div className="inline wrap">
            <Select
              label="Executed query"
              aria-label="Executed query"
              value={row?.id ?? ''}
              onChange={(event) => {
                setSelectedId(event.target.value);
                setSaved(undefined);
              }}
            >
              <option value="">Select a query</option>
              {snapshot.queries.map((entry, index) => (
                <option key={entry.id} value={entry.id}>
                  {entry.alias || `Query ${index + 1}`} · {entry.query}
                </option>
              ))}
            </Select>
            <Button
              disabled={!promqlAlerts || !alert.url}
              title={!promqlAlerts ? 'PromQL alerts are unavailable on this server.' : alert.reason}
              onClick={() => {
                if (alert.url) navigate(alert.url);
              }}
            >
              Create alert
            </Button>
            <Button
              disabled={!ready || access.loading}
              onClick={() => {
                setOpen(true);
                mutation.reset();
                setSaved(undefined);
              }}
            >
              Add to Dashboard
            </Button>
          </div>
          {alert.reason && <p className="muted">{alert.reason}</p>}
          <p className="muted">
            Actions use the selected executed expression and its step; edits above apply after Run.
          </p>
          <div className="inline wrap">
            <Input
              aria-label="Saved metric query name"
              placeholder="Saved query name"
              value={name}
              maxLength={120}
              onChange={(event) => setName(event.target.value)}
            />
            <Button
              disabled={!ready || !scope || !name.trim() || library.length >= 100}
              onClick={() => {
                if (!row) return;
                writeLibrary([
                  {
                    id: createId(),
                    name: name.trim(),
                    dataset: snapshot.stream,
                    query: row.query,
                    type: snapshot.type,
                    step: row.resolvedStep,
                    updatedAt: new Date().toISOString(),
                  },
                  ...library,
                ]);
                setName('');
              }}
            >
              Save query
            </Button>
          </div>
        </>
      )}
      {storageError && (
        <p role="alert" className="error-text">
          {storageError}
        </p>
      )}
      {saved && (
        <p role="status">
          Query added to{' '}
          <Link to={`/dashboards/${encodeURIComponent(saved.dashboardId)}`}>{saved.title}</Link>.
        </p>
      )}
      {open && snapshot && row && (
        <Dialog
          open
          title="Add to Dashboard"
          dismissible={!mutation.pending}
          onOpenChange={(value) => {
            if (!mutation.pending) setOpen(value);
          }}
        >
          <form
            className="stack"
            onSubmit={(event) => {
              event.preventDefault();
              if (issue || !ready) return;
              const tile = executedMetricTile(
                snapshot,
                row.id,
                name.trim() || row.alias?.trim() || 'Metric chart',
              );
              void mutation.run(async () => {
                let next: Dashboard;
                if (destination === 'new')
                  next = await client.createDashboard({
                    title: title.trim(),
                    tiles: [tile],
                    tags: [],
                    variables: [],
                    sections: [],
                    isFavorite: false,
                    timeRange: classicTimeRange(
                      {
                        startTime: new Date(snapshot.start * 1000).toISOString(),
                        endTime: new Date(snapshot.end * 1000).toISOString(),
                      },
                      undefined,
                    ),
                  });
                else {
                  const loaded = selectedDashboard.data!;
                  saveRead.current?.abort();
                  const controller = new AbortController();
                  saveRead.current = controller;
                  const latest = await client.getDashboard(loaded.dashboardId, controller.signal);
                  if (!mutation.isActive()) return;
                  if (!access.hash || latest.author !== access.hash) {
                    selectedDashboard.reload();
                    throw new Error('Only the owner can edit this dashboard.');
                  }
                  if (JSON.stringify(latest) !== JSON.stringify(loaded)) {
                    selectedDashboard.reload();
                    throw new Error(
                      'This dashboard changed. Review the latest version and add the query again.',
                    );
                  }
                  next = await client.updateDashboard(
                    latest.dashboardId,
                    appendSqlTile(latest, tile),
                  );
                }
                if (mutation.isActive()) {
                  setSaved(next);
                  setOpen(false);
                }
              });
            }}
          >
            <QueryState
              loading={dashboards.loading || access.loading}
              error={dashboards.error}
              retry={dashboards.reload}
            />
            <Select
              label="Dashboard"
              value={destination}
              disabled={mutation.pending}
              onChange={(event) => {
                setDestination(event.target.value);
                mutation.reset();
              }}
            >
              <option value="new">Create a new dashboard</option>
              {dashboards.data?.map((item) => (
                <option
                  key={item.dashboardId}
                  value={item.dashboardId}
                  disabled={!access.hash || item.author !== access.hash}
                >
                  {item.title}
                  {item.author !== access.hash ? ' (read-only)' : ''}
                </option>
              ))}
            </Select>
            {destination === 'new' && (
              <Input
                label="Dashboard title"
                required
                value={title}
                disabled={mutation.pending}
                onChange={(event) => setTitle(event.target.value)}
              />
            )}
            <QueryState
              loading={selectedDashboard.loading}
              error={selectedDashboard.error}
              retry={selectedDashboard.reload}
            />
            <p className="muted">
              {destination === 'new'
                ? 'The new dashboard uses the captured result bounds.'
                : 'This tile uses the existing dashboard’s time range, which may differ from these results.'}{' '}
              Saved step: {row.resolvedStep}. Saved expression: <code>{row.query}</code>
            </p>
            {issue && <p className="muted">{issue}</p>}
            <InlineError error={mutation.error} />
            <div className="dialog-actions">
              <Button disabled={mutation.pending} onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                disabled={mutation.pending || !!issue || !ready}
              >
                {mutation.pending ? 'Adding…' : 'Add query'}
              </Button>
            </div>
          </form>
        </Dialog>
      )}
    </div>
  );
}
