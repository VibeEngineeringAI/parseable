import { createPortal } from 'react-dom';
import { createId } from '../../lib/ids';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { PanelLeft, RefreshCw, Terminal, WrapText, Download } from 'lucide-react';
import { Button, EmptyState, Select } from '../../components/ui';
import { QueryState } from '../../components/explorer/QueryState';
import { TimeRangePicker } from '../../components/explorer/TimeRangePicker';
import { ColumnPicker } from '../../components/explorer/ColumnPicker';
import { DataTable, exportRecords } from '../../components/explorer/DataTable';
import { LogHistogram } from '../../components/explorer/LogHistogram';
import { RecordSheet } from '../../components/explorer/RecordSheet';
import { FieldSidebar } from './FieldSidebar';
import { FilterBar, type LogFilter } from './FilterBar';
import { useApp } from '../../app/AppProvider';
import { ApiError } from '../../lib/client';
import { useAsync } from '../../hooks/useAsync';
import { buildLogQuery, timeBounds } from '../../lib/query';
import type { LogRecord, TimeRange } from '../../lib/types';
export function LogsPage() {
  const { client } = useApp();
  const { currentDataset } = useParams();
  const navigate = useNavigate();
  const datasets = useAsync(useCallback((signal) => client.listDatasets(signal), [client]));
  const dataset = currentDataset || datasets.data?.[0]?.name || '';
  const [range, setRange] = useState<TimeRange>('1h');
  const [search, setSearch] = useState('');
  // Tagged with its dataset so a timer left over from the previous dataset is ignored.
  const [debounced, setDebounced] = useState({ dataset, search: '' });
  const [filters, setFilters] = useState<LogFilter[]>([]);
  const [columns, setColumns] = useState<string[]>();
  const [showFields, setShowFields] = useState(true);
  const [wrap, setWrap] = useState(false);
  const [showHistogram, setShowHistogram] = useState(true);
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
  const [stateDataset, setStateDataset] = useState(dataset);
  if (stateDataset !== dataset) {
    setStateDataset(dataset);
    setFilters([]);
    setColumns(undefined);
    setSearch('');
    setDebounced({ dataset, search: '' });
    setRow(undefined);
    setRowFields({ fields: [] });
  }
  const schema = useAsync(
    useCallback(
      (signal) => (dataset ? client.schema(dataset, signal) : Promise.resolve([])),
      [client, dataset],
    ),
  );
  const debouncedSearch = debounced.dataset === dataset ? debounced.search : '';
  const sql = useMemo(
    () => (dataset ? buildLogQuery(dataset, debouncedSearch, filters, 100) : ''),
    [dataset, debouncedSearch, filters],
  );
  const results = useAsync(
    useCallback(
      (signal) => (sql ? client.query({ sql, ...timeBounds(range) }, signal) : Promise.resolve([])),
      [client, sql, range],
    ),
  );
  if (results.data && rowFields.rows !== results.data)
    setRowFields({ rows: results.data, fields: [...new Set(results.data.flatMap(Object.keys))] });
  const fields = schema.data?.length ? schema.data : rowFields.fields;
  const visibleColumns = columns ?? ['p_timestamp'].filter((f) => fields.includes(f));
  // An identical filter changes nothing, so it is not added twice.
  const addFilter = (filter: LogFilter) =>
    setFilters((items) =>
      items.some(
        (f) =>
          f.field === filter.field && f.operator === filter.operator && f.value === filter.value,
      )
        ? items
        : [...items, filter],
    );
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
                <TimeRangePicker value={range} onChange={setRange} />
                <Button
                  variant="secondary"
                  size="icon"
                  aria-label="Refresh logs"
                  onClick={results.reload}
                  disabled={results.loading}
                >
                  <RefreshCw size={15} />
                </Button>
              </div>
            </div>
            <div className="explorer-filters">
              <FilterBar
                key={dataset}
                search={search}
                onSearch={setSearch}
                fields={fields}
                filters={filters}
                onAdd={addFilter}
                onRemove={(id) => setFilters(filters.filter((f) => f.id !== id))}
                onUpdate={(filter) =>
                  setFilters(filters.map((f) => (f.id === filter.id ? filter : f)))
                }
                onClear={() => {
                  setFilters([]);
                  setSearch('');
                }}
              />
              <Link
                className="text-link sql-handoff"
                aria-label="Open in SQL editor"
                title="Open in SQL editor"
                to={`/sql-editor?query=${encodeURIComponent(sql)}`}
              >
                <Terminal size={15} />
              </Link>
            </div>
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
            <QueryState loading={results.loading} error={results.error} retry={results.reload} />
            {!results.loading && !results.error && (
              <>
                {showHistogram && (
                  <LogHistogram rows={results.data || []} bounds={timeBounds(range)} />
                )}
                <div className="panel-heading result-heading">
                  <h2>{results.data?.length || 0} records</h2>
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
                      onClick={() => exportRecords(results.data || [], 'json')}
                    >
                      <Download size={14} />
                      Export JSON
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={!results.data?.length}
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
                />
              </>
            )}
          </section>
        </div>
      )}
      <RecordSheet
        row={row}
        onClose={() => setRow(undefined)}
        onFilter={(field, value, operator = '=') =>
          addFilter({ id: createId(), field, operator, value })
        }
      />
    </div>
  );
}
