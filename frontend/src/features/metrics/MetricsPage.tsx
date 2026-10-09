import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import { Button, EmptyState, Select } from '../../components/ui';
import { PageHeader } from '../../components/explorer/PageHeader';
import { QueryState } from '../../components/explorer/QueryState';
import { TimeRangePicker } from '../../components/explorer/TimeRangePicker';
import type { PromqlMetadataSource } from '../../components/promql/PromqlEditor';
import { useApp } from '../../app/AppProvider';
import { useAsync } from '../../hooks/useAsync';
import { listMetricsDatasets } from '../../lib/metrics';
import { autoStep, formatStep, loadHistory } from '../../lib/promql';
import type { DatasetInfo } from '../../lib/types';
import {
  createRunSnapshot,
  insertBrowserQuery,
  maxQueries,
  metadataRequest,
  parseExplorerSearch,
  rangeBounds,
  serializeExplorerState,
  snapshotState,
  stepError,
  type ExplorerState,
  type RunSnapshot,
} from './helpers';
import { QueryPanel } from './QueryPanel';
import { LabelBrowser } from './LabelBrowser';
import { ResultsCard } from './ResultsCard';
import { useMetricsRun } from './useMetricsRun';
import './metrics.css';

const datasetPath = (name: string) => `/metrics/explore/${encodeURIComponent(name)}`;

export function MetricsPage() {
  const { client } = useApp();
  const { dataset } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const about = useAsync(useCallback((signal) => client.about(signal), [client]));
  const enabled = about.data?.capabilities.promql === true;
  const datasets = useAsync(
    useCallback(
      (signal) => (enabled ? listMetricsDatasets(client, signal) : Promise.resolve([])),
      [client, enabled],
    ),
  );
  if (enabled && datasets.data?.length && !dataset)
    return <Navigate replace to={`${datasetPath(datasets.data[0].name)}${location.search}`} />;
  if (enabled && datasets.data?.some((entry) => entry.name === dataset))
    return <MetricsExplorer dataset={dataset!} datasets={datasets.data} />;
  return (
    <div className="page metrics-page">
      <PageHeader title="Metrics" />
      <QueryState
        loading={about.loading || (enabled && datasets.loading)}
        error={about.error || (enabled ? datasets.error : undefined)}
        retry={about.error ? about.reload : datasets.reload}
      />
      {about.data && !enabled && (
        <EmptyState
          title="PromQL is not available on this server"
          description="The server must run in All or Query mode to explore metrics with PromQL."
        />
      )}
      {enabled && datasets.data && !datasets.data.length && (
        <>
          <EmptyState
            title="No metrics ingested yet"
            description="Add metrics to monitor performance, track trends, and catch regressions at a glance."
          />
          <p className="metrics-ingestion-hint muted">
            Send OTLP metrics to <code>/v1/metrics</code> with the <code>X-P-Stream</code> header
            naming your dataset.
          </p>
        </>
      )}
      {enabled && Boolean(datasets.data?.length) && dataset && (
        <EmptyState
          title="The selected dataset could not be found."
          action={
            <Button
              onClick={() =>
                navigate(`${datasetPath(datasets.data![0].name)}${location.search}`, {
                  replace: true,
                })
              }
            >
              Open {datasets.data![0].name}
            </Button>
          }
        />
      )}
    </div>
  );
}

function MetricsExplorer({ dataset, datasets }: { dataset: string; datasets: DatasetInfo[] }) {
  const { client } = useApp();
  const location = useLocation();
  const navigate = useNavigate();
  const [state, setState] = useState(() => parseExplorerSearch(location.search));
  const draft = useRef(state);
  const writtenSearch = useRef(location.search);
  const pendingSearches = useRef(new Set<string>());
  const autoRun = useRef(state.queries.some((query) => query.trim()));
  const [active, setActive] = useState(0);
  const [showBrowser, setShowBrowser] = useState(true);
  const [snapshot, setSnapshot] = useState<RunSnapshot>();
  const appliedSnapshot = useRef<RunSnapshot | undefined>(undefined);
  const [runError, setRunError] = useState<string>();
  const [clock, setClock] = useState(() => Date.now());
  const resultElement = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const rangeKey = JSON.stringify(state.range);
  const bounds = useMemo(() => rangeBounds(state.range, clock), [rangeKey, clock]);
  const previous = useRef({ dataset, rangeKey });
  const currentSnapshot = snapshot?.stream === dataset ? snapshot : undefined;
  const currentApplied =
    appliedSnapshot.current?.stream === dataset ? appliedSnapshot.current : undefined;
  const results = useMetricsRun(client, currentSnapshot);

  function update(change: (current: ExplorerState) => ExplorerState) {
    // Navigation can defer a render. Combine edits with the latest draft rather than old props.
    const next = change(draft.current);
    if (JSON.stringify(next.range) !== JSON.stringify(draft.current.range)) setClock(Date.now());
    draft.current = next;
    setState(next);
    setRunError(undefined);
    writtenSearch.current = serializeExplorerState(next);
    pendingSearches.current.add(writtenSearch.current);
    navigate({ pathname: location.pathname, search: writtenSearch.current }, { replace: true });
  }

  function apply(next: ExplorerState) {
    const now = Date.now();
    const run = createRunSnapshot(next, dataset, width, now);
    setClock(now);
    setRunError(run.error);
    // Clearing the active snapshot cancels requests; keep the applied configuration for recovery.
    setSnapshot(run.snapshot);
    if (run.snapshot) appliedSnapshot.current = run.snapshot;
  }

  useEffect(() => {
    if (pendingSearches.current.has(location.search)) {
      pendingSearches.current.delete(location.search);
      if (location.search === writtenSearch.current) pendingSearches.current.clear();
    } else if (location.search !== writtenSearch.current) {
      pendingSearches.current.clear();
      writtenSearch.current = location.search;
      const next = parseExplorerSearch(location.search);
      draft.current = next;
      setState(next);
      setActive(0);
      apply(next);
      previous.current = { dataset, rangeKey: JSON.stringify(next.range) };
    }
  }, [location.search, location.key]);

  useEffect(() => {
    const element = resultElement.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => setWidth(entries[0].contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    // URL restoration may have scheduled new state before this render's range effect runs.
    if (draft.current !== state) return;
    if (previous.current.dataset !== dataset) {
      appliedSnapshot.current = undefined;
      setSnapshot(undefined);
      setRunError(undefined);
      setClock(Date.now());
    } else if (previous.current.rangeKey !== rangeKey && appliedSnapshot.current) {
      apply(snapshotState(appliedSnapshot.current, state.range));
    }
    previous.current = { dataset, rangeKey };
  }, [dataset, rangeKey]);

  useEffect(() => {
    if (autoRun.current) {
      autoRun.current = false;
      apply(state);
    }
  }, []);

  const metadata = useMemo<PromqlMetadataSource>(
    () => ({
      metricNames: async (signal) => {
        const request = metadataRequest(dataset, bounds);
        return request ? (await client.promqlLabelValues('__name__', request, signal)).data : [];
      },
      labelNames: async (metric, signal) => {
        const request = metadataRequest(dataset, bounds, metric ? [metric] : []);
        return request ? (await client.promqlLabels(request, signal)).data : [];
      },
      labelValues: async (label, metric, signal) => {
        const request = metadataRequest(dataset, bounds, metric ? [metric] : []);
        return request ? (await client.promqlLabelValues(label, request, signal)).data : [];
      },
    }),
    [client, dataset, bounds],
  );
  const preview = createRunSnapshot(state, dataset, width, clock);
  const validation =
    preview.error === 'Enter a PromQL query to run.' || stepError(state.step)
      ? undefined
      : preview.error;
  const steps = [...new Set(state.queries.map((query) => autoStep({ ...bounds, width, query })))];
  const autoLabel = `auto · ${steps.map(formatStep).join(' / ')}`;
  const activeIndex = Math.min(active, state.queries.length - 1);

  return (
    <div className="page metrics-page">
      <PageHeader
        title="Metrics"
        actions={
          <>
            <Select
              aria-label="Metrics dataset"
              value={dataset}
              onChange={(event) => {
                writtenSearch.current = serializeExplorerState(draft.current);
                pendingSearches.current.add(writtenSearch.current);
                navigate(`${datasetPath(event.target.value)}${writtenSearch.current}`, {
                  replace: true,
                });
              }}
            >
              {datasets.map((entry) => (
                <option key={entry.name} value={entry.name}>
                  {entry.name}
                </option>
              ))}
            </Select>
            <TimeRangePicker
              value={state.range}
              onChange={(range) => update((current) => ({ ...current, range }))}
            />
            <Button
              size="icon"
              aria-label="Refresh metrics"
              disabled={!currentApplied}
              onClick={() => currentApplied && apply(snapshotState(currentApplied, state.range))}
            >
              <RefreshCw size={15} aria-hidden="true" />
            </Button>
          </>
        }
      />
      <div className={`metrics-layout ${showBrowser ? '' : 'metrics-browser-hidden'}`}>
        <QueryPanel
          state={state}
          onChange={update}
          active={activeIndex}
          onFocus={setActive}
          onRun={() => {
            if (!createRunSnapshot(draft.current, dataset, width).error) apply(draft.current);
          }}
          metadata={metadata}
          history={loadHistory(dataset)}
          autoLabel={autoLabel}
          rangeError={validation}
          showBrowser={showBrowser}
          onToggleBrowser={() => setShowBrowser(!showBrowser)}
        />
        {showBrowser && (
          <LabelBrowser
            key={dataset}
            client={client}
            dataset={dataset}
            bounds={bounds}
            activeEmpty={!state.queries[activeIndex].trim()}
            full={state.queries.length >= maxQueries}
            onInsert={(metric, labelValue) => {
              const inserted = insertBrowserQuery(
                draft.current.queries,
                activeIndex,
                metric,
                labelValue,
              );
              if (inserted.error) setRunError(inserted.error);
              else {
                update((current) => ({ ...current, queries: inserted.queries }));
                setActive(inserted.active);
              }
            }}
          />
        )}
        <div className="metrics-results" ref={resultElement}>
          {runError && runError !== validation && (
            <p role="alert" className="metrics-validation error-text">
              {runError}
            </p>
          )}
          <ResultsCard snapshot={currentSnapshot} results={results} />
        </div>
      </div>
    </div>
  );
}
