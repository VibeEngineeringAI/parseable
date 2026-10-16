import './sql-chart.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../../app/AppProvider';
import { Button, Dialog, Input, InlineError, Select } from '../../components/ui';
import { QueryState } from '../../components/explorer/QueryState';
import { useAsync } from '../../hooks/useAsync';
import { useMutation } from '../../hooks/useMutation';
import type { Dashboard, LogRecord, TimeRange } from '../../lib/types';
import { timeBounds } from '../../lib/query';
import { TileChart } from '../dashboards/TileChart';
import { TileBindingFields } from '../dashboards/TileBindingFields';
import { TileAppearanceFields } from '../dashboards/TileAppearanceFields';
import { chartIssues } from '../dashboards/chartPicker';
import { useDashboardAccess } from '../dashboards/owner';
import { classicTimeRange } from '../dashboards/timeRange';
import { text, tileDatasets } from '../dashboards/tiles';
import { appendSqlTile, executedSqlTile, type SqlChartConfig } from './sqlChart';
export { createSqlChartConfig, readSqlChartConfig, type SqlChartConfig } from './sqlChart';
export function SqlChartPanel({
  rows,
  query,
  range,
  config,
  onConfigChange,
  disabled = false,
  selectedDatasets = [],
}: {
  rows: LogRecord[];
  query: string;
  range: TimeRange;
  config: SqlChartConfig;
  onConfigChange: (config: SqlChartConfig) => void;
  disabled?: boolean;
  selectedDatasets?: string[];
}) {
  const { client } = useApp();
  const access = useDashboardAccess(),
    mutation = useMutation();
  const [open, setOpen] = useState(false),
    [destination, setDestination] = useState('new'),
    [title, setTitle] = useState(''),
    [saved, setSaved] = useState<Dashboard>();
  const saveRead = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => saveRead.current?.abort(), []);
  const [invalid, setInvalid] = useState<Set<string>>(() => new Set());
  const onValidity = useCallback(
    (key: string, valid: boolean) =>
      setInvalid((current) => {
        if (current.has(key) === !valid) return current;
        const next = new Set(current);
        if (valid) next.delete(key);
        else next.add(key);
        return next;
      }),
    [],
  );
  const datasets = useAsync(
    useCallback(
      (signal) => (open ? client.listDatasets(signal) : Promise.resolve([])),
      [client, open],
    ),
  );
  const dashboards = useAsync(
    useCallback(
      (signal) => (open ? client.listDashboards(signal) : Promise.resolve([])),
      [client, open],
    ),
  );
  const selected = useAsync(
    useCallback(
      (signal) =>
        open && destination !== 'new'
          ? client.getDashboard(destination, signal)
          : Promise.resolve(undefined),
      [client, open, destination],
    ),
  );
  const columns = useMemo(() => [...new Set(rows.flatMap(Object.keys))], [rows]);
  const bounds = useMemo(() => timeBounds(range), [range]);
  const change = (edits: Partial<SqlChartConfig>) => {
    setSaved(undefined);
    onConfigChange({ ...config, ...edits });
  };
  const dataset =
    tileDatasets(config)[0] ?? (selectedDatasets.length === 1 ? selectedDatasets[0] : '');
  const issue = !rows.length
    ? 'Run a query that returns rows to configure a chart.'
    : !query.trim()
      ? 'Run a SQL query first.'
      : !text(config.title).trim()
        ? 'Enter a chart title.'
        : invalid.size
          ? 'Correct the chart options.'
          : (chartIssues(config)[0] ?? '');
  const writable = selected.data && !!access.hash && selected.data.author === access.hash;
  const destinationIssue =
    destination === 'new'
      ? !access.canCreate
        ? 'Dashboard creation is unavailable for this account.'
        : !title.trim()
          ? 'Enter a dashboard title.'
          : ''
      : selected.loading
        ? 'Loading dashboard…'
        : !writable
          ? 'This dashboard is read-only. Only its owner can edit it.'
          : '';
  return (
    <div className="stack sql-chart-panel">
      {rows.length > 0 && (
        <div className="dashboard-preview sql-chart-preview" aria-label="Chart preview">
          <TileChart
            tile={config}
            result={{ rows }}
            start={Date.parse(bounds.startTime) / 1000}
            end={Date.parse(bounds.endTime) / 1000}
            height={280}
          />
        </div>
      )}
      <div className="sql-chart-actions">
        {issue && <p className="muted">{issue}</p>}
        <Button
          variant="primary"
          disabled={disabled || !!issue || access.loading}
          onClick={() => {
            setOpen(true);
            mutation.reset();
            setSaved(undefined);
          }}
        >
          Add to Dashboard
        </Button>
      </div>
      {saved && (
        <p role="status">
          Chart added to{' '}
          <Link to={`/dashboards/${encodeURIComponent(saved.dashboardId)}`}>{saved.title}</Link>.
        </p>
      )}
      <details className="sql-chart-config" open>
        <summary>Configure chart</summary>
        <fieldset disabled={disabled || mutation.pending} className="stack">
          <legend>Chart configuration</legend>
          <Input
            label="Chart title"
            value={text(config.title)}
            onChange={(event) => change({ title: event.target.value })}
          />
          <TileAppearanceFields draft={config} change={change} onValidity={onValidity} />
          <TileBindingFields draft={config} change={change} columns={columns} />
        </fieldset>
      </details>
      {open && (
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
              if (issue || destinationIssue || !dataset || disabled) return;
              const tile = executedSqlTile({ ...config, dbName: [dataset] }, query);
              void mutation.run(async () => {
                let result: Dashboard;
                if (destination === 'new')
                  result = await client.createDashboard({
                    title: title.trim(),
                    dataset,
                    tiles: [tile],
                    tags: [],
                    variables: [],
                    sections: [],
                    isFavorite: false,
                    timeRange: classicTimeRange(range, undefined),
                  });
                else {
                  const loaded = selected.data!;
                  saveRead.current?.abort();
                  const controller = new AbortController();
                  saveRead.current = controller;
                  const latest = await client.getDashboard(loaded.dashboardId, controller.signal);
                  if (!mutation.isActive()) return;
                  if (!access.hash || latest.author !== access.hash) {
                    selected.reload();
                    throw new Error('This dashboard is read-only. Only its owner can edit it.');
                  }
                  if (JSON.stringify(latest) !== JSON.stringify(loaded)) {
                    selected.reload();
                    throw new Error(
                      'This dashboard changed. Review the latest version and add the chart again.',
                    );
                  }
                  result = await client.updateDashboard(
                    loaded.dashboardId,
                    appendSqlTile(latest, tile),
                  );
                }
                if (mutation.isActive()) {
                  setSaved(result);
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
              {(dashboards.data ?? []).map((item) => (
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
            <QueryState loading={selected.loading} error={selected.error} retry={selected.reload} />
            <QueryState loading={datasets.loading} error={datasets.error} retry={datasets.reload} />
            <Select
              label="Dataset"
              value={dataset}
              disabled={mutation.pending}
              onChange={(event) => change({ dbName: [event.target.value] })}
            >
              <option value="">Choose the query's dataset</option>
              {[
                ...new Set([
                  ...(datasets.data ?? []).map((item) => item.name),
                  ...(dataset ? [dataset] : []),
                ]),
              ].map((name) => (
                <option key={name}>{name}</option>
              ))}
            </Select>
            <p className="muted">
              {destination === 'new'
                ? 'The new dashboard uses the time range of these results.'
                : 'The chart will run using the existing dashboard’s time range, which may differ from these results.'}{' '}
              The saved SQL is the query that produced these results.
            </p>
            {(issue || destinationIssue || !dataset) && (
              <p className="muted">{issue || destinationIssue || 'Choose a dataset.'}</p>
            )}
            <InlineError error={mutation.error} />
            <div className="dialog-actions">
              <Button disabled={mutation.pending} onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                type="submit"
                disabled={
                  mutation.pending ||
                  disabled ||
                  !!issue ||
                  !!destinationIssue ||
                  !dataset ||
                  !!selected.error
                }
              >
                {mutation.pending ? 'Adding…' : 'Add chart'}
              </Button>
            </div>
          </form>
        </Dialog>
      )}
    </div>
  );
}
