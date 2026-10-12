import { useCallback, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Bot, RefreshCw } from 'lucide-react';
import { Badge, Button, EmptyState, Input, Select, Sheet } from '../../components/ui';
import { PageHeader } from '../../components/explorer/PageHeader';
import { QueryState } from '../../components/explorer/QueryState';
import { TimeRangePicker } from '../../components/explorer/TimeRangePicker';
import { useApp } from '../../app/AppProvider';
import { useAsync } from '../../hooks/useAsync';
import {
  AGENT_RECORD_LIMIT,
  agentDemoRows,
  agentRangeFromParams,
  agentBoundsFromParams,
  agentsPath,
  agentText,
  buildAgentQuery,
  discoverAgentDatasets,
} from '../../lib/agents';
import { timeBounds } from '../../lib/query';
import type { LogRecord, TimeRange } from '../../lib/types';
import './agents.css';

export function AgentsPage() {
  const { client, mode } = useApp();
  const { dataset } = useParams<{ dataset: string }>();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const searchString = params.toString();
  const range = useMemo(
    () => agentRangeFromParams(new URLSearchParams(searchString)),
    [searchString],
  );
  const bounds = useMemo(
    () => agentBoundsFromParams(new URLSearchParams(searchString)),
    [searchString],
  );
  const suffix = `?${new URLSearchParams({ start: bounds.startTime, end: bounds.endTime, ...(typeof range === 'string' ? { range } : {}) })}`;
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<LogRecord>();
  const [discoveryRequested, setDiscoveryRequested] = useState(false);
  const discoveryEnabled = !dataset || discoveryRequested || mode === 'demo';
  const discovery = useAsync(
    useCallback(
      async (signal) =>
        !discoveryEnabled
          ? undefined
          : mode === 'demo'
            ? { datasets: [{ name: 'agent_telemetry', compatible: true }], unchecked: [] }
            : discoverAgentDatasets(client, signal),
      [client, mode, discoveryEnabled],
    ),
  );
  const result = useAsync(
    useCallback(
      async (signal) => {
        if (!dataset) return undefined;
        if (mode === 'demo') {
          if (dataset !== 'agent_telemetry')
            throw new Error(
              'This dataset is not available in the demo workspace. Select agent_telemetry to explore sample records.',
            );
          return {
            rows: agentDemoRows(Date.parse(bounds.endTime)).filter(
              (row) => Date.parse(String(row.p_timestamp)) >= Date.parse(bounds.startTime),
            ),
            timeColumn: 'p_timestamp',
            traces: false,
          };
        }
        const [fields, info] = await Promise.all([
          client.schema(dataset, signal),
          client.datasetInfo(dataset, signal),
        ]);
        const timeColumn = info.timePartition || 'p_timestamp';
        const rows = await client.query(
          buildAgentQuery(dataset, fields, bounds, timeColumn),
          signal,
        );
        return { rows, timeColumn, traces: info.logSourceFormats.includes('otel-traces') };
      },
      [client, mode, dataset, bounds],
    ),
  );
  const changeRange = (value: TimeRange) => {
    const next = new URLSearchParams(params),
      captured = timeBounds(value);
    next.set('start', captured.startTime);
    next.set('end', captured.endTime);
    if (typeof value === 'string') next.set('range', value);
    else next.delete('range');
    setParams(next);
    setSelected(undefined);
  };
  const rows =
    result.data?.rows.filter((row) =>
      Object.values(row).some(
        (value) => typeof value === 'string' && value.toLowerCase().includes(search.toLowerCase()),
      ),
    ) ?? [];
  return (
    <div className="page agents-page">
      <PageHeader
        title="Agents"
        description="Inspect agent, model, and tool telemetry in your datasets."
        actions={<Badge>{mode === 'demo' ? 'Demo telemetry' : 'Live data'}</Badge>}
      />
      <p className="agents-note">
        Recent telemetry records, including individual spans and events. Run-level analytics and
        model pricing are unavailable in this edition.
      </p>
      {[...params.keys()].some((key) => !['start', 'end', 'range'].includes(key)) && (
        <p role="status" className="agents-note">
          This link includes options that are not applied here:{' '}
          {[...new Set(params.keys())]
            .filter((key) => !['start', 'end', 'range'].includes(key))
            .join(', ')}
          . Use the native time range and search controls to refine these records.
        </p>
      )}
      <div className="agents-controls">
        <Select
          aria-label="Agents dataset"
          value={dataset ?? ''}
          aria-busy={discoveryEnabled && discovery.loading}
          onFocus={() => setDiscoveryRequested(true)}
          onChange={(event) => {
            setDiscoveryRequested(true);
            setSelected(undefined);
            setSearch('');
            navigate(`${agentsPath(event.target.value)}${suffix}`);
          }}
        >
          <option value="" disabled>
            Select an agent dataset
          </option>
          {dataset && !discovery.data?.datasets.some((entry) => entry.name === dataset) && (
            <option value={dataset}>{dataset}</option>
          )}
          {discovery.data?.datasets.map((entry) => (
            <option key={entry.name} value={entry.name}>
              {entry.name}
            </option>
          ))}
        </Select>
        <TimeRangePicker value={range} onChange={changeRange} />
        <Button
          variant="secondary"
          onClick={() => {
            setSelected(undefined);
            if (typeof range === 'string') changeRange(range);
            else result.reload();
          }}
        >
          <RefreshCw size={14} /> Refresh
        </Button>
      </div>
      {dataset && (
        <Button
          variant="ghost"
          onClick={() => {
            if (discoveryEnabled) discovery.reload();
            else setDiscoveryRequested(true);
          }}
        >
          Rescan datasets
        </Button>
      )}
      {dataset && discoveryEnabled && discovery.loading && (
        <p role="status" className="agents-note">
          Finding compatible datasets…
        </p>
      )}
      <QueryState
        loading={!dataset && discovery.loading}
        error={discovery.error}
        retry={discovery.reload}
      />
      {!!discovery.data?.unchecked.length && (
        <p role="status" className="agents-note">
          Could not inspect {discovery.data.unchecked.map((entry) => entry.name).join(', ')}.{' '}
          <Button variant="ghost" onClick={discovery.reload}>
            Rescan datasets
          </Button>
        </p>
      )}
      {!dataset && discovery.data && (
        <EmptyState
          icon={<Bot size={24} />}
          title={
            discovery.data.datasets.length
              ? 'Choose an agent dataset'
              : 'No agent telemetry datasets found'
          }
          description="Datasets with GenAI agent, operation, model, or tool fields appear here. Ingest your instrumentation to get started."
          action={
            <Link className="text-link" to="/add-data">
              Add data
            </Link>
          }
        />
      )}
      {dataset && (
        <>
          <QueryState loading={result.loading} error={result.error} retry={result.reload} />
          {result.data && (
            <section aria-label="Agent telemetry" className="agents-panel">
              <div className="agents-controls">
                <Input
                  aria-label="Search agent telemetry"
                  placeholder="Search loaded telemetry"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
                <Badge>{result.data.rows.length} records loaded</Badge>
              </div>
              <p className="agents-note">
                Showing up to {AGENT_RECORD_LIMIT} recent records in the selected time range. Search
                filters loaded records.
              </p>
              {!rows.length ? (
                <EmptyState
                  title={search ? 'No matching telemetry' : 'No agent telemetry in this range'}
                  description={
                    search ? 'Try another search.' : 'Choose a wider time range or check ingestion.'
                  }
                />
              ) : (
                <div className="agents-table-scroll">
                  <table className="agents-table">
                    <thead>
                      <tr>
                        {['Time', 'Agent', 'Operation', 'Model / tool', 'Status', 'Details'].map(
                          (label) => (
                            <th key={label} scope="col">
                              {label}
                            </th>
                          ),
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row, index) => (
                        <tr key={index}>
                          <td>{agentText(row, result.data!.timeColumn)}</td>
                          <td>{agentText(row, 'gen_ai.agent.name', 'gen_ai.agent.id')}</td>
                          <td>{agentText(row, 'gen_ai.operation.name', 'span_name')}</td>
                          <td>{agentText(row, 'gen_ai.tool.name', 'gen_ai.request.model')}</td>
                          <td>
                            {row.span_status_code === 2
                              ? 'Error'
                              : row.span_status_code === 1
                                ? 'OK'
                                : '—'}
                          </td>
                          <td>
                            <Button
                              variant="ghost"
                              onClick={() => setSelected(row)}
                              aria-label={`Inspect telemetry record ${index + 1}`}
                            >
                              Inspect
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}
        </>
      )}
      <Sheet
        open={!!selected && !!result.data && result.data.rows.includes(selected)}
        onOpenChange={(open) => {
          if (!open) setSelected(undefined);
        }}
        title="Agent telemetry record"
      >
        {selected && (
          <>
            {result.data?.traces &&
              typeof selected.span_trace_id === 'string' &&
              /^[a-fA-F0-9]{32}$/.test(selected.span_trace_id) && (
                <Link
                  className="text-link"
                  to={`/traces/explore/${encodeURIComponent(dataset!)}?${new URLSearchParams({ start: bounds.startTime, end: bounds.endTime, traceId: selected.span_trace_id })}`}
                >
                  Open trace
                </Link>
              )}
            <pre className="agents-record">{JSON.stringify(selected, null, 2)}</pre>
          </>
        )}
      </Sheet>
    </div>
  );
}
