import { createPortal } from 'react-dom';
import { createId } from '../../lib/ids';
import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { PanelLeft, RefreshCw, Terminal, WrapText, Download } from 'lucide-react';
import { Button, EmptyState, Select, Dialog, Input } from '../../components/ui';
import { LinkNotice } from '../../components/explorer/LinkNotice';
import { QueryState } from '../../components/explorer/QueryState';
import { TimeRangePicker } from '../../components/explorer/TimeRangePicker';
import { ColumnPicker } from '../../components/explorer/ColumnPicker';
import { DataTable, exportRecords } from '../../components/explorer/DataTable';
import { LogHistogram } from '../../components/explorer/LogHistogram';
import { RecordSheet } from '../../components/explorer/RecordSheet';
import { FieldSidebar } from './FieldSidebar';
import { GroupedFilterBar } from './GroupedFilterBar';
import { SavedViews } from './SavedViews';
import { decodeLogView, encodeLogView, type LogViewState } from './logViewState';
import { initialLogView, logViewReducer } from './logViewReducer';
import { resolveTimezone } from '../../components/explorer/timezone';
import { TimezoneSelect } from '../../components/explorer/TimezoneSelect';
import { LogContext, canShowContext } from './LogContext';
import { appPath } from '../../lib/config';
import { emptyExpression, narrowLogExpression, MAX_LOG_ROWS } from '../../lib/logFilters';
import {
  compileLogCriteria,
  buildRowsFromCriteria,
  buildHistogramFromCriteria,
  histogramBuckets,
  type LogFilterExpression,
} from '../../lib/logQuery';
import { useApp } from '../../app/AppProvider';
import { ApiError } from '../../lib/client';
import { useAsync } from '../../hooks/useAsync';
import { timeBounds } from '../../lib/query';
import { classicLogsParams, classicLogsState } from '../../lib/classicUi';
import type { LogRecord, LogFilter } from '../../lib/types';
export function LogsPage() {
  const { client } = useApp();
  const { currentDataset } = useParams();
  const navigate = useNavigate();
  const datasets = useAsync(useCallback((signal) => client.listDatasets(signal), [client]));
  const dataset = currentDataset || datasets.data?.[0]?.name || '';
  const location = useLocation();
  const [params] = useSearchParams();
  const [dropped, setDropped] = useState<string[]>([]);
  const [view, dispatchView] = useReducer(logViewReducer, dataset, initialLogView);
  const { range, search, expression, timezone, limit, columns, wrap, showHistogram } = view;
  const editView = (patch: Partial<Omit<LogViewState, 'version' | 'dataset'>>) =>
    dispatchView({ type: 'edit', patch });
  const setRange = (range: LogViewState['range']) => editView({ range });
  const setSearch = (search: string) => editView({ search });
  const setExpression = (expression: LogFilterExpression) => {
    setFilterNotice('');
    editView({ expression });
  };
  const setTimezone = (timezone: string) => editView({ timezone });
  const setLimit = (limit: number) => editView({ limit });
  const setColumns = (columns: string[]) => editView({ columns });
  const setWrap = (wrap: boolean) => editView({ wrap });
  const setShowHistogram = (showHistogram: boolean) => editView({ showHistogram });
  // Tagged with its dataset so a timer left over from the previous dataset is ignored.
  const [debounced, setDebounced] = useState({ dataset, search: '' });
  const [filterNotice, setFilterNotice] = useState('');
  const [revision, setRevision] = useState(0);
  const [contextRow, setContextRow] = useState<LogRecord>();
  const [shareUrl, setShareUrl] = useState('');
  const [shareStatus, setShareStatus] = useState('');
  const [linkError, setLinkError] = useState('');
  const [showFields, setShowFields] = useState(true);
  const [row, setRow] = useState<LogRecord>();
  // Fields seen in the latest returned rows, kept while the next results load
  // or if they fail, so the field list does not empty out. Reset with the dataset.
  const [rowFields, setRowFields] = useState<{ rows?: LogRecord[]; fields: string[] }>({
    fields: [],
  });
  useEffect(() => {
    const timer = setTimeout(() => setDebounced({ dataset, search }), 250);
    return () => clearTimeout(timer);
  }, [dataset, search]);
  // Reset during render, not in an effect, so the query never runs with the
  // previous dataset's filters against the new one.
  if (view.dataset !== dataset) {
    dispatchView({ type: 'resetDataset', dataset });
    setFilterNotice('');
    setDebounced({ dataset, search: '' });
    setRow(undefined);
    setContextRow(undefined);
    setShareUrl('');
    setLinkError('');
    setRowFields({ fields: [] });
  }
  // A classic Logs link carries its range and filters in the query string. Each
  // one is applied once, including one that arrives while this page is open,
  // and after the dataset reset above so a link to another dataset keeps them.
  const link = classicLogsParams.some((name) => params.has(name)) ? location.key : undefined;
  const [appliedLink, setAppliedLink] = useState<string>();
  if (link && dataset && appliedLink !== link) {
    const linked = classicLogsState(params);
    setAppliedLink(link);
    setFilterNotice('');
    setRow(undefined);
    setContextRow(undefined);
    setLinkError('');
    dispatchView({
      type: 'applyClassic',
      range: linked.range ?? '1h',
      expression: {
        combinator: 'and',
        groups: [
          {
            id: createId(),
            combinator: 'and',
            rules: linked.filters.map((filter) => ({ ...filter, id: createId() })),
          },
        ],
      },
    });
    // A search typed before the link would narrow its results without showing why.
    setDebounced({ dataset, search: '' });
    setDropped(linked.dropped);
  }
  const applyView = (view: LogViewState) => {
    dispatchView({ type: 'applyView', view });
    setDebounced({ dataset: view.dataset, search: view.search });
    setFilterNotice('');
    setRow(undefined);
    setContextRow(undefined);
    setDropped([]);
    setLinkError('');
  };
  const [appliedView, setAppliedView] = useState<string>();
  if (params.has('logView') && appliedView !== location.key && dataset) {
    setAppliedView(location.key);
    try {
      const view = decodeLogView(params.get('logView')!);
      if (view.dataset !== dataset)
        throw new Error('The shared view dataset does not match this page.');
      applyView(view);
    } catch (error) {
      setLinkError(error instanceof Error ? error.message : 'Invalid shared view');
    }
  }
  // Consume handoffs once so subsequent edits are not overwritten by navigation.
  useEffect(() => {
    const classicApplied = !!link && appliedLink === link;
    const nativeApplied = params.has('logView') && appliedView === location.key && !linkError;
    if (!classicApplied && !nativeApplied) return;
    const rest = new URLSearchParams(location.search);
    if (classicApplied) for (const name of classicLogsParams) rest.delete(name);
    if (nativeApplied) rest.delete('logView');
    navigate(
      { pathname: location.pathname, search: rest.toString(), hash: location.hash },
      { replace: true, state: location.state },
    );
  }, [link, appliedLink, appliedView, linkError, location, navigate, params]);
  const schema = useAsync(
    useCallback(
      (signal) => (dataset ? client.schema(dataset, signal) : Promise.resolve([])),
      [client, dataset],
    ),
  );
  const debouncedSearch = debounced.dataset === dataset ? debounced.search : '';
  const info = useAsync(
    useCallback(
      (signal) => (dataset ? client.datasetInfo(dataset, signal) : Promise.resolve(undefined)),
      [client, dataset],
    ),
  );
  const timestampField = info.data?.timePartition || 'p_timestamp';
  const compiled = useMemo(() => {
    try {
      return {
        criteria: dataset
          ? compileLogCriteria(dataset, debouncedSearch, expression, timestampField)
          : undefined,
        error: '',
      };
    } catch (error) {
      return {
        criteria: undefined,
        error: error instanceof Error ? error.message : 'Invalid log query',
      };
    }
  }, [dataset, debouncedSearch, expression, timestampField]);
  const { source, predicate, timestamp } = compiled.criteria ?? {};
  // Stabilize by semantic SQL values: client IDs and empty groups do not trigger queries.
  const criteria = useMemo(
    () =>
      source && timestamp && predicate !== undefined ? { source, predicate, timestamp } : undefined,
    [source, predicate, timestamp],
  );
  // Capture now again only for a changed range, effective criteria, or explicit refresh.
  const bounds = useMemo(() => timeBounds(range), [range, criteria, revision]);
  const sql = useMemo(
    () => (criteria ? buildRowsFromCriteria(criteria, limit, bounds) : ''),
    [criteria, limit, bounds],
  );
  const ready = !!criteria && !info.loading && !linkError && !compiled.error;
  const results = useAsync(
    useCallback(
      (signal) => (ready ? client.query({ sql, ...bounds }, signal) : Promise.resolve(undefined)),
      [client, sql, bounds, ready],
    ),
  );
  const histogram = useAsync(
    useCallback(
      async (signal) => {
        if (!ready || !criteria) return undefined;
        const rows = await client.query(
          {
            sql: buildHistogramFromCriteria(criteria, bounds),
            ...bounds,
          },
          signal,
        );
        return histogramBuckets(rows, bounds);
      },
      [client, ready, criteria, bounds],
    ),
  );
  if (results.data && rowFields.rows !== results.data)
    setRowFields({ rows: results.data, fields: [...new Set(results.data.flatMap(Object.keys))] });
  const fields = schema.data?.length ? schema.data : rowFields.fields;
  const visibleColumns = columns ?? [timestampField].filter((f) => fields.includes(f));
  const addFilter = (filter: LogFilter) => {
    try {
      setExpression(narrowLogExpression(expression, filter, createId()));
    } catch (error) {
      setFilterNotice(error instanceof Error ? error.message : 'Could not add this filter.');
    }
  };
  const refresh = () => setRevision((value) => value + 1);
  const share = () => {
    try {
      const encoded = encodeLogView({ ...view, range: bounds });
      setShareUrl(
        new URL(
          appPath(
            `/logs/explore/${encodeURIComponent(dataset)}?${new URLSearchParams({ logView: encoded })}`,
          ),
          window.location.origin,
        ).href,
      );
      setShareStatus('');
      setFilterNotice('');
    } catch (error) {
      setFilterNotice(error instanceof Error ? error.message : 'Could not create the view link.');
    }
  };
  return (
    <div className="page logs-page">
      <h1 className="sr-only">Logs</h1>
      {(() => {
        const selector = (
          <Select
            aria-label="Dataset"
            value={dataset}
            onChange={(e) => navigate(`/logs/explore/${encodeURIComponent(e.target.value)}`)}
          >
            {!datasets.data?.length && <option value="">Select a dataset</option>}
            {datasets.data?.map((d) => (
              <option key={d.name}>{d.name}</option>
            ))}
          </Select>
        );
        const slot = document.getElementById('workspace-context');
        return slot ? (
          createPortal(selector, slot)
        ) : (
          <div className="dataset-toolbar">{selector}</div>
        );
      })()}
      <QueryState loading={datasets.loading} error={datasets.error} retry={datasets.reload} />
      {!datasets.loading && !datasets.error && !dataset && (
        <EmptyState
          title="No datasets yet"
          description="Ingest events into your Parseable server to begin exploring."
        />
      )}
      {!!dataset && !datasets.error && (
        <div className={`explorer-layout ${showFields ? '' : 'fields-hidden'}`}>
          {showFields && (
            <FieldSidebar
              key={dataset}
              fields={fields}
              selected={visibleColumns}
              onToggle={(field) =>
                setColumns(
                  visibleColumns.includes(field)
                    ? visibleColumns.length > 1
                      ? visibleColumns.filter((f) => f !== field)
                      : visibleColumns
                    : [...visibleColumns, field],
                )
              }
            />
          )}
          <section className="explorer-content" aria-label="Log results">
            <div className="explorer-toolbar">
              <Button
                variant="ghost"
                size="icon"
                data-testid="lmt-sidebar-toggle"
                aria-label="Toggle fields"
                aria-expanded={showFields}
                onClick={() => setShowFields(!showFields)}
              >
                <PanelLeft size={16} />
              </Button>
              <div className="inline explorer-time-controls">
                <TimeRangePicker value={range} onChange={setRange} timezone={timezone} />
                <TimezoneSelect
                  value={timezone}
                  onChange={(value) => setTimezone(resolveTimezone(value))}
                />
                <Button
                  variant="secondary"
                  size="icon"
                  aria-label="Refresh logs"
                  onClick={refresh}
                  disabled={results.loading}
                >
                  <RefreshCw size={15} />
                </Button>
              </div>
            </div>
            <div className="explorer-filters">
              <GroupedFilterBar
                key={dataset}
                search={search}
                onSearch={setSearch}
                fields={fields}
                expression={expression}
                onChange={setExpression}
                onClear={() => {
                  setExpression(emptyExpression());
                  setSearch('');
                }}
              />
              <Link
                className="text-link sql-handoff"
                aria-label="Open in SQL editor"
                title="Open in SQL editor"
                to={`/sql-editor?${new URLSearchParams({ query: sql, start: bounds.startTime, end: bounds.endTime })}`}
              >
                <Terminal size={15} />
              </Link>
            </div>
            <div className="logs-view-controls">
              <SavedViews
                timestampField={timestampField}
                state={view}
                onApply={(next) => {
                  if (next.dataset !== dataset)
                    navigate(
                      `/logs/explore/${encodeURIComponent(next.dataset)}?${new URLSearchParams({ logView: encodeLogView(next) })}`,
                    );
                  else applyView(next);
                }}
              />
              <Button
                size="sm"
                variant="secondary"
                onClick={share}
                disabled={search !== debouncedSearch || !ready}
              >
                Share / copy link
              </Button>
              <Select
                aria-label="Result limit"
                value={limit}
                onChange={(e) => setLimit(Number(e.target.value))}
              >
                {[...new Set([100, 1000, 5000, MAX_LOG_ROWS, limit])]
                  .sort((a, b) => a - b)
                  .map((count) => (
                    <option key={count} value={count}>
                      Load up to {count.toLocaleString()} rows
                    </option>
                  ))}
              </Select>
            </div>
            {linkError && (
              <div role="alert">
                <p>{linkError}</p>
                <Button
                  onClick={() => {
                    const rest = new URLSearchParams(location.search);
                    rest.delete('logView');
                    setLinkError('');
                    navigate(
                      { pathname: location.pathname, search: rest.toString() },
                      { replace: true },
                    );
                  }}
                >
                  Clear invalid shared view
                </Button>
              </div>
            )}
            {compiled.error && <p role="alert">{compiled.error}</p>}
            {filterNotice && <p role="status">{filterNotice}</p>}
            {info.error && (
              <p className="notice" role="status">
                Dataset time partition unavailable. Using ingestion time.
              </p>
            )}
            <LinkNotice dropped={dropped} onDismiss={() => setDropped([])} />
            <>
              {schema.error && (
                <p role="status" className="notice">
                  {schema.error instanceof ApiError && schema.error.status === 403
                    ? 'Permission denied for field schema.'
                    : 'Field schema unavailable.'}{' '}
                  Showing fields from returned events.{' '}
                  <Button size="sm" variant="ghost" onClick={schema.reload}>
                    Retry schema
                  </Button>
                </p>
              )}
            </>
            {ready && showHistogram && (
              <section aria-label="Histogram totals">
                <QueryState
                  loading={histogram.loading}
                  error={histogram.error}
                  retry={histogram.reload}
                />
                {histogram.data && <LogHistogram aggregate={histogram.data} timezone={timezone} />}
              </section>
            )}
            <QueryState
              loading={ready && results.loading}
              error={ready ? results.error : undefined}
              retry={refresh}
            />
            {ready && !results.loading && !results.error && results.data && (
              <>
                <div className="panel-heading result-heading">
                  <h2>
                    {results.data?.length || 0} records{' '}
                    <span className="muted">
                      loaded
                      {histogram.data
                        ? ` of ${histogram.data.total.toLocaleString()} matching`
                        : ''}
                    </span>
                  </h2>
                  <div className="inline wrap results-actions">
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-pressed={showHistogram}
                      onClick={() => setShowHistogram(!showHistogram)}
                    >
                      {showHistogram ? 'Hide' : 'Show'} histogram
                    </Button>
                    <ColumnPicker fields={fields} selected={visibleColumns} onChange={setColumns} />
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Toggle row wrapping"
                      aria-pressed={wrap}
                      onClick={() => setWrap(!wrap)}
                    >
                      <WrapText size={15} />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={!results.data?.length}
                      title="Export loaded rows"
                      onClick={() => exportRecords(results.data || [], 'json')}
                    >
                      <Download size={14} />
                      Export JSON
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={!results.data?.length}
                      title="Export loaded rows"
                      onClick={() => exportRecords(results.data || [], 'csv')}
                    >
                      Export CSV
                    </Button>
                  </div>
                </div>
                <DataTable
                  rows={results.data || []}
                  columns={visibleColumns}
                  onSelect={setRow}
                  wrap={wrap}
                  summary
                  timestampField={timestampField}
                  virtualized={limit > 100 || visibleColumns.length > 20}
                  timezone={timezone}
                />
              </>
            )}
          </section>
        </div>
      )}
      <RecordSheet
        row={row}
        timezone={timezone}
        timestampField={timestampField}
        onContext={
          row && canShowContext(row)
            ? () => {
                setContextRow(row);
                setRow(undefined);
              }
            : undefined
        }
        onClose={() => setRow(undefined)}
        onFilter={(field, value, operator = '=') =>
          addFilter({ id: createId(), field, operator, value })
        }
      />
      {contextRow && (
        <LogContext
          key={dataset}
          dataset={dataset}
          row={contextRow}
          timezone={timezone}
          onClose={() => {
            setRow(contextRow);
            setContextRow(undefined);
          }}
        />
      )}
      <Dialog
        open={!!shareUrl}
        onOpenChange={(open) => {
          if (!open) setShareUrl('');
        }}
        title="Share log view"
        description="This link includes filters and the captured time range. Anyone opening it needs dataset access."
      >
        <div className="stack">
          <Input label="View link" readOnly value={shareUrl} onFocus={(e) => e.target.select()} />
          <Button
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(shareUrl);
                setShareStatus('Link copied');
              } catch {
                setShareStatus('Clipboard unavailable. Select and copy the link above.');
              }
            }}
          >
            Copy link
          </Button>
          <span role="status">{shareStatus}</span>
        </div>
      </Dialog>
    </div>
  );
}
