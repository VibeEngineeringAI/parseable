import { useCallback, useMemo, useState } from 'react';
import { Link, Navigate, useNavigate, useLocation, useSearchParams } from 'react-router-dom';
import { RefreshCw, Activity, GitBranch, List } from 'lucide-react';
import { Badge, Button, EmptyState, Input, Select, Tabs } from '../../components/ui';
import { PageHeader } from '../../components/explorer/PageHeader';
import { QueryState } from '../../components/explorer/QueryState';
import { TimeRangePicker } from '../../components/explorer/TimeRangePicker';
import { useApp } from '../../app/AppProvider';
import { useAsync } from '../../hooks/useAsync';
import {
  apmServicePath,
  resolveApmRoute,
  apmBoundsFromParams,
  apmRangeFromParams,
  discoverApmDatasets,
  inspectApmSchema,
  loadApmInsights,
  loadApmInventory,
  loadApmTopology,
  type ApmBounds,
  type ApmMetric,
  type ApmSchema,
} from '../../lib/apm';
import { timeBounds } from '../../lib/query';
import type { TimeRange } from '../../lib/types';
import { ServiceInventory } from './ServiceInventory';
import { ServiceInsights } from './ServiceInsights';
import { ServiceTopology } from './ServiceTopology';
import './apm.css';

export function ApmPage() {
  const { client, mode } = useApp();
  const location = useLocation();
  const { dataset, service } = resolveApmRoute(location.pathname);
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [refreshRevision, setRefreshRevision] = useState(0);
  const searchString = params.toString();
  const bounds = useMemo(
    () => apmBoundsFromParams(new URLSearchParams(searchString)),
    [searchString],
  );
  const range = useMemo(
    () => apmRangeFromParams(new URLSearchParams(searchString)),
    [searchString],
  );
  const suffix = `?${new URLSearchParams({ start: bounds.startTime, end: bounds.endTime, ...(typeof range === 'string' ? { range } : {}) })}`;
  const discovery = useAsync(
    useCallback((signal) => discoverApmDatasets(client, signal), [client]),
    { keepPreviousData: true },
  );
  const schema = useAsync(
    useCallback(
      async (signal) => {
        if (!dataset) return undefined;
        const [fields, info] = await Promise.all([
          client.schema(dataset, signal),
          client.datasetInfo(dataset, signal),
        ]);
        if (!info.logSourceFormats.includes('otel-traces'))
          throw new Error(
            'APM and trace navigation require a dataset ingested through the OpenTelemetry traces source.',
          );
        return inspectApmSchema(fields, info.timePartition || 'p_timestamp');
      },
      [client, dataset],
    ),
  );
  const changeRange = (value: TimeRange) => {
    const captured = timeBounds(value),
      next = new URLSearchParams(params);
    next.set('start', captured.startTime);
    next.set('end', captured.endTime);
    if (typeof value === 'string') next.set('range', value);
    else next.delete('range');
    setParams(next);
  };
  const refresh = () => {
    changeRange(range);
    setRefreshRevision((revision) => revision + 1);
  };
  if (!dataset && discovery.data?.datasets.length)
    return <Navigate replace to={`${apmServicePath(discovery.data.datasets[0].name)}${suffix}`} />;
  return (
    <div className="page apm-page">
      <PageHeader
        title="Application performance"
        description="Understand service activity, span latency, and observed dependencies."
        actions={<Badge>{mode === 'demo' ? 'Demo traces' : 'Live data'}</Badge>}
      />
      <div className="apm-controls">
        <Select
          className="apm-dataset"
          aria-label="APM dataset"
          value={dataset ?? ''}
          disabled={!discovery.data}
          onChange={(e) => navigate(`${apmServicePath(e.target.value)}${suffix}`)}
        >
          <option value="" disabled>
            Select a trace dataset
          </option>
          {dataset && !discovery.data?.datasets.some((d) => d.name === dataset) && (
            <option value={dataset}>{dataset}</option>
          )}
          {discovery.data?.datasets.map((d) => (
            <option value={d.name} key={d.name}>
              {d.name}
            </option>
          ))}
        </Select>
        <TimeRangePicker value={range} onChange={changeRange} />
        <Button variant="secondary" onClick={refresh} aria-label="Refresh APM">
          <RefreshCw size={14} /> Refresh
        </Button>
      </div>
      {discovery.error && (
        <QueryState loading={false} error={discovery.error} retry={discovery.reload} />
      )}
      {discovery.data?.unchecked.length ? (
        <div className="apm-warning" role="status">
          Could not check {discovery.data.unchecked.join(', ')}.{' '}
          <Button variant="ghost" onClick={discovery.reload}>
            Rescan datasets
          </Button>
        </div>
      ) : null}
      {!dataset && (
        <>
          <QueryState loading={discovery.loading} />
          {discovery.data && !discovery.data.datasets.length && (
            <EmptyState
              icon={<Activity size={24} />}
              title="No trace datasets found"
              description="APM uses OpenTelemetry trace datasets. Ingest spans with service.name to see your services."
              action={
                <Link className="text-link" to="/add-data">
                  Set up trace ingestion
                </Link>
              }
            />
          )}
        </>
      )}
      {dataset && (
        <>
          <QueryState loading={schema.loading} error={schema.error} retry={schema.reload} />
          {schema.data && (
            <>
              {!schema.data.status && (
                <p className="apm-warning">
                  This dataset has no span status field. Error metrics show zero explicit errors;
                  the health of these spans is unknown.
                </p>
              )}
              <ApmDataset
                key={dataset}
                dataset={dataset}
                service={service}
                bounds={bounds}
                refreshRevision={refreshRevision}
                schema={schema.data}
                suffix={suffix}
              />
            </>
          )}
        </>
      )}
    </div>
  );
}
function ApmDataset({
  dataset,
  service,
  bounds,
  refreshRevision,
  schema,
  suffix,
}: {
  dataset: string;
  service?: string;
  bounds: ApmBounds;
  refreshRevision: number;
  schema: ApmSchema;
  suffix: string;
}) {
  const { client } = useApp();
  const [search, setSearch] = useState(''),
    [metric, setMetric] = useState<ApmMetric>('p95Ms'),
    [view, setView] = useState('services');
  const inventory = useAsync(
    useCallback(
      (signal) =>
        service
          ? Promise.resolve(undefined)
          : loadApmInventory(client, dataset, bounds, signal, schema),
      [client, dataset, bounds, schema, service, refreshRevision],
    ),
  );
  const insights = useAsync(
    useCallback(
      (signal) =>
        service
          ? loadApmInsights(client, dataset, service, bounds, signal, schema)
          : Promise.resolve(undefined),
      [client, dataset, service, bounds, schema, refreshRevision],
    ),
  );
  const topology = useAsync(
    useCallback(
      (signal) =>
        (service || view === 'dependencies') && schema.parent
          ? loadApmTopology(client, dataset, bounds, signal, schema, service)
          : Promise.resolve(undefined),
      [client, dataset, bounds, schema, service, view, refreshRevision],
    ),
  );
  const scope = (
    <p className="apm-note">
      {new Date(bounds.startTime).toLocaleString()} – {new Date(bounds.endTime).toLocaleString()} ·
      {schema.timeColumn === 'p_timestamp'
        ? 'Ingestion-time window'
        : `Dataset time window (${schema.timeColumn})`}
      : counts use unique spans, including every span kind. Latency percentiles are approximate.
    </p>
  );
  const dependencies = (
    <>
      <QueryState loading={topology.loading} error={topology.error} retry={topology.reload} />
      {!schema.parent && (
        <EmptyState
          title="Parent span IDs unavailable"
          description="Service dependencies require span_parent_span_id in this dataset."
        />
      )}
      {topology.data && (
        <ServiceTopology
          edges={topology.data.rows}
          dataset={dataset}
          focusedService={service}
          search={search}
          suffix={suffix}
        />
      )}
      {topology.data?.truncated && (
        <p className="apm-warning">
          Showing the 200 connections with the most child spans. Connections to this service may be
          outside this limit.
        </p>
      )}
    </>
  );
  if (service)
    return (
      <>
        <QueryState loading={insights.loading} error={insights.error} retry={insights.reload} />
        {insights.error && (
          <Link className="text-link" to={`${apmServicePath(dataset)}${suffix}`}>
            Back to services
          </Link>
        )}
        {insights.data && (
          <>
            <ServiceInsights
              insights={insights.data}
              dataset={dataset}
              service={service}
              bounds={bounds}
              suffix={suffix}
              timeColumn={schema.timeColumn}
            />
            {scope}
            {dependencies}
          </>
        )}
      </>
    );
  return (
    <>
      <Tabs
        aria-label="APM view"
        value={view}
        onValueChange={setView}
        items={[
          {
            value: 'services',
            label: (
              <span className="inline">
                <List size={14} /> Services
              </span>
            ),
            content: (
              <>
                <QueryState
                  loading={inventory.loading}
                  error={inventory.error}
                  retry={inventory.reload}
                />
                {inventory.data && (
                  <ServiceInventory
                    dataset={dataset}
                    services={inventory.data.rows}
                    search={search}
                    onSearchChange={setSearch}
                    metric={metric}
                    onMetricChange={setMetric}
                    suffix={suffix}
                  />
                )}
                {inventory.data?.truncated && (
                  <p className="apm-warning">
                    Showing the 200 services with the most spans. Search and sorting apply to these
                    services.
                  </p>
                )}
              </>
            ),
          },
          {
            value: 'dependencies',
            label: (
              <span className="inline">
                <GitBranch size={14} /> Dependencies
              </span>
            ),
            content: (
              <div className="stack">
                <Input
                  aria-label="Search service dependencies"
                  placeholder="Search for services"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                {dependencies}
              </div>
            ),
          },
        ]}
      />
      {scope}
    </>
  );
}
