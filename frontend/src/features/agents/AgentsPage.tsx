import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Link,
  useLocation,
  useNavigate,
  useNavigationType,
  useParams,
  useSearchParams,
} from 'react-router-dom';
import { Bot, RefreshCw } from 'lucide-react';
import { Badge, Button, EmptyState, Input, Select, Sheet } from '../../components/ui';
import { PageHeader } from '../../components/explorer/PageHeader';
import { QueryState } from '../../components/explorer/QueryState';
import { TimeRangePicker } from '../../components/explorer/TimeRangePicker';
import { useApp } from '../../app/AppProvider';
import { useAsync } from '../../hooks/useAsync';
import {
  AGENT_RECORD_LIMIT,
  AGENT_RUN_LIMIT,
  agentDemoRows,
  agentRangeFromParams,
  agentBoundsFromParams,
  agentsPath,
  buildAgentRunQuery,
  discoverAgentDatasets,
} from '../../lib/agents';
import { detectAgentHarnesses, mapHarnessRows } from '../../lib/agentHarnesses';
import { buildAgentRuns } from '../../lib/agentRuns';
import { agentValueMatchesSearch } from '../../lib/agentSearch';
import {
  currentObservabilitySearch,
  useObservabilityNavigation,
} from '../../lib/observabilityNavigation';
import { timeBounds } from '../../lib/query';
import type { TimeRange } from '../../lib/types';
import { AgentRunDetails, AgentStatus, AgentTokens, formatAgentDuration } from './AgentRunDetails';
import { AgentTelemetryGuide } from './AgentTelemetryGuide';
import './agents.css';

export function AgentsPage() {
  const { client, mode } = useApp();
  const { dataset } = useParams<{ dataset: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const navigationType = useNavigationType();
  const [params, setParams] = useSearchParams();
  const searchString = params.toString();
  // Filter edits must not recapture a moving relative time range and rerun the query.
  const timeString = JSON.stringify([params.get('start'), params.get('end'), params.get('range')]);
  const range = useMemo(
    () => agentRangeFromParams(new URLSearchParams(searchString)),
    [timeString],
  );
  const rawBounds = useMemo(
    () => agentBoundsFromParams(new URLSearchParams(searchString)),
    [timeString],
  );
  const boundsKey = JSON.stringify(rawBounds);
  const bounds = useMemo(() => JSON.parse(boundsKey) as ReturnType<typeof timeBounds>, [boundsKey]);
  const urlSearch = params.get('search') ?? '';
  // Router updates can run in a transition. Keep typing synchronous, and do not
  // let an earlier URL commit replace a newer edit while navigation catches up.
  const [search, setSearch] = useState(urlSearch);
  const pendingSearch = useRef<{ value: string; dataset?: string } | undefined>(undefined);
  useLayoutEffect(() => {
    if (
      pendingSearch.current &&
      pendingSearch.current.dataset === dataset &&
      navigationType !== 'POP' &&
      pendingSearch.current.value !== urlSearch
    )
      return;
    pendingSearch.current = undefined;
    setSearch(urlSearch);
  }, [urlSearch, dataset, navigationType, location.key]);
  const status = params.get('status') ?? '';
  const model = params.get('model') ?? '';
  const setupOpen = params.get('setup') === '1';
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
              'This dataset is not available in the demo workspace. Select agent_telemetry to explore sample runs.',
            );
          return {
            rows: agentDemoRows(Date.parse(bounds.endTime)).filter(
              (row) => Date.parse(String(row.p_timestamp)) >= Date.parse(bounds.startTime),
            ),
            limitReached: false,
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
          buildAgentRunQuery(dataset, fields, bounds, timeColumn),
          signal,
        );
        return {
          rows: mapHarnessRows(detectAgentHarnesses(fields), rows),
          limitReached: rows.length >= AGENT_RECORD_LIMIT,
          timeColumn,
          traces: info.logSourceFormats.includes('otel-traces'),
        };
      },
      [client, mode, dataset, bounds],
    ),
  );
  const authorizedDataset = useRef<string | undefined>(undefined);
  if (result.data) authorizedDataset.current = dataset;
  const { href } = useObservabilityNavigation({
    view: 'agents',
    dataset,
    range,
    bounds,
    params,
    enabled: !!dataset && authorizedDataset.current === dataset,
  });
  const runs = useMemo(
    () =>
      buildAgentRuns(result.data?.rows ?? [], result.data?.timeColumn, {
        limitReached: result.data?.limitReached,
        bounds,
      }),
    [result.data, bounds],
  );
  const visibleRuns = useMemo(
    () =>
      runs.filter(
        (run) =>
          (!status || run.status === status) &&
          (!model || run.models.includes(model)) &&
          (!search ||
            run.spans.some((span) =>
              span.rows.some((row) => agentValueMatchesSearch(row, search)),
            )),
      ),
    [runs, search, status, model],
  );
  const selected = runs.find((run) => run.id === params.get('run'));
  const selectedTraceId =
    selected?.traceId && /^[a-fA-F0-9]{32}$/.test(selected.traceId) ? selected.traceId : undefined;
  const updateFilter = (key: string, value: string) => {
    const next = new URLSearchParams(
      currentObservabilitySearch(location.pathname, params.toString()),
    );
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };
  const closeRun = () => {
    const next = new URLSearchParams(
      currentObservabilitySearch(location.pathname, params.toString()),
    );
    next.delete('run');
    setParams(next, { replace: true });
  };
  const changeRange = (value: TimeRange) => {
    const next = new URLSearchParams(
        currentObservabilitySearch(location.pathname, params.toString()),
      ),
      captured = timeBounds(value);
    next.set('start', captured.startTime);
    next.set('end', captured.endTime);
    if (typeof value === 'string') next.set('range', value);
    else next.delete('range');
    next.delete('run');
    setParams(next);
  };
  const models = [...new Set(runs.flatMap((run) => run.models))].sort();
  return (
    <div className="page agents-page">
      <PageHeader
        title="Agents"
        description="Follow agent runs from model calls to tools and captured conversation."
        actions={
          <>
            <Badge>{mode === 'demo' ? 'Demo telemetry' : 'Live data'}</Badge>
            <Button onClick={() => updateFilter('setup', '1')}>Set up telemetry</Button>
          </>
        }
      />
      <div className="agents-controls">
        <Select
          aria-label="Agents dataset"
          value={dataset ?? ''}
          aria-busy={discoveryEnabled && discovery.loading}
          onFocus={() => setDiscoveryRequested(true)}
          onChange={(event) => {
            setDiscoveryRequested(true);
            const next = new URLSearchParams(
              currentObservabilitySearch(location.pathname, params.toString()),
            );
            next.delete('run');
            next.set('start', bounds.startTime);
            next.set('end', bounds.endTime);
            navigate(`${agentsPath(event.target.value)}?${next}`);
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
            if (typeof range === 'string') changeRange(range);
            else {
              closeRun();
              result.reload();
            }
          }}
        >
          <RefreshCw size={14} aria-hidden="true" /> Refresh
        </Button>
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
      </div>
      {dataset && mode !== 'demo' && (
        <nav className="agents-related-links" aria-label="Related telemetry">
          <Link className="text-link" to={href('logs', { dataset })}>
            Open logs
          </Link>
          {result.data?.traces && (
            <Link className="text-link" to={href('traces', { dataset })}>
              Open traces
            </Link>
          )}
        </nav>
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
            <div className="inline">
              <Button onClick={() => updateFilter('setup', '1')}>Configure an agent</Button>
              <Link className="text-link" to="/add-data">
                Add data
              </Link>
            </div>
          }
        />
      )}
      {dataset && (
        <>
          <QueryState loading={result.loading} error={result.error} retry={result.reload} />
          {result.data && (
            <>
              <div className="agents-summary" aria-label="Loaded run summary">
                {[
                  ['Runs', runs.length],
                  ['Successful', runs.filter((run) => run.status === 'success').length],
                  ['Failed', runs.filter((run) => run.status === 'failed').length],
                  ['Incomplete', runs.filter((run) => run.status === 'incomplete').length],
                ].map(([label, value]) => (
                  <div key={label}>
                    <span>{label}</span>
                    <strong>{value}</strong>
                  </div>
                ))}
              </div>
              <section aria-label="Agent runs" className="agents-panel">
                <div className="agents-controls">
                  <Input
                    aria-label="Search agent runs"
                    placeholder="Search loaded runs"
                    value={search}
                    onChange={(event) => {
                      const value = event.target.value;
                      pendingSearch.current = { value, dataset };
                      setSearch(value);
                      updateFilter('search', value);
                    }}
                  />
                  <Select
                    aria-label="Run status"
                    value={status}
                    onChange={(event) => updateFilter('status', event.target.value)}
                  >
                    <option value="">All statuses</option>
                    <option value="success">Successful</option>
                    <option value="failed">Failed</option>
                    <option value="incomplete">Incomplete</option>
                    {status && !['success', 'failed', 'incomplete'].includes(status) && (
                      <option value={status}>{status}</option>
                    )}
                  </Select>
                  <Select
                    aria-label="Run model"
                    value={model}
                    onChange={(event) => updateFilter('model', event.target.value)}
                  >
                    <option value="">All models</option>
                    {model && !models.includes(model) && <option value={model}>{model}</option>}
                    {models.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </Select>
                  <Badge>
                    {visibleRuns.length} of {runs.length} runs
                  </Badge>
                </div>
                <p className="agents-note">
                  Related spans are grouped by trace or explicit run ID. Filters apply to loaded
                  runs. Up to {AGENT_RUN_LIMIT} recent traces and{' '}
                  {AGENT_RECORD_LIMIT.toLocaleString()}
                  records are loaded in this time range; missing or partial telemetry is marked in
                  run details.
                </p>
                {runs.filter((run) => run.traceId).length >= AGENT_RUN_LIMIT && (
                  <p role="status" className="agents-warnings">
                    The {AGENT_RUN_LIMIT}-trace limit was reached. Older runs may be omitted; narrow
                    the time range to explore them.
                  </p>
                )}
                {result.data.limitReached && (
                  <p role="status" className="agents-warnings">
                    The record limit was reached. Runs may have additional spans or events; narrow
                    the time range to improve coverage.
                  </p>
                )}
                {!visibleRuns.length ? (
                  <EmptyState
                    title={
                      search || status || model
                        ? 'No matching runs'
                        : 'No agent telemetry in this range'
                    }
                    description={
                      search || status || model
                        ? 'Try another search or clear the run filters.'
                        : 'Choose a wider time range or check ingestion.'
                    }
                  />
                ) : (
                  <div className="agents-table-scroll">
                    <table className="agents-table">
                      <thead>
                        <tr>
                          {[
                            'Run',
                            'Status',
                            'Started (UTC)',
                            'Duration',
                            'Model',
                            'Tokens',
                            'Spans',
                            'Details',
                          ].map((label) => (
                            <th key={label} scope="col">
                              {label}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {visibleRuns.map((run) => (
                          <tr key={run.id}>
                            <td>
                              <strong>{run.name}</strong>
                              {!!run.warnings.length && (
                                <span className="agents-row-warning">Partial telemetry</span>
                              )}
                            </td>
                            <td>
                              <AgentStatus status={run.status} />
                            </td>
                            <td>{run.startTime ?? 'Not recorded'}</td>
                            <td>{formatAgentDuration(run.durationMs)}</td>
                            <td>{run.models.join(', ') || 'Not recorded'}</td>
                            <td>
                              <AgentTokens input={run.inputTokens} output={run.outputTokens} />
                            </td>
                            <td>{run.spans.length}</td>
                            <td>
                              <Button
                                variant="ghost"
                                onClick={() => {
                                  const next = new URLSearchParams(
                                    currentObservabilitySearch(
                                      location.pathname,
                                      params.toString(),
                                    ),
                                  );
                                  next.set('run', run.id);
                                  setParams(next);
                                }}
                                aria-label={`Inspect run ${run.name}`}
                              >
                                Inspect run
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </>
          )}
        </>
      )}
      <Sheet
        open={!!selected && !setupOpen}
        onOpenChange={(open) => {
          if (!open) closeRun();
        }}
        title="Agent run details"
        className="agents-run-sheet"
      >
        {selected && (
          <>
            {mode !== 'demo' && selectedTraceId && (
              <nav className="agents-related-links" aria-label="Run telemetry">
                {selected.traceId &&
                  /^[a-fA-F0-9]{32}$/.test(selected.traceId) &&
                  result.data?.traces && (
                    <Link
                      className="text-link"
                      to={href('traces', { dataset, traceId: selected.traceId })}
                    >
                      Open trace
                    </Link>
                  )}
                <Link
                  className="text-link"
                  to={href('logs', {
                    dataset,
                    traceId: selectedTraceId,
                  })}
                >
                  Open logs
                </Link>
              </nav>
            )}
            <AgentRunDetails run={selected} key={selected.id} />
          </>
        )}
      </Sheet>
      <Sheet
        open={setupOpen}
        onOpenChange={(open) => updateFilter('setup', open ? '1' : '')}
        title="Set up agent telemetry"
        description="Connect Claude Code or Codex to your collector, then verify runs in Agents."
        className="agents-setup-sheet"
      >
        <AgentTelemetryGuide />
      </Sheet>
    </div>
  );
}
