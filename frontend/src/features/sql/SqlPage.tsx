import { useCallback, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Play, Download, WrapText, Database } from 'lucide-react';
import { Button, Card, EmptyState, Input } from '../../components/ui';
import { PageHeader } from '../../components/explorer/PageHeader';
import { ColumnPicker } from '../../components/explorer/ColumnPicker';
import { DataTable, exportRecords } from '../../components/explorer/DataTable';
import { QueryState } from '../../components/explorer/QueryState';
import { RecordSheet } from '../../components/explorer/RecordSheet';
import { TimeRangePicker } from '../../components/explorer/TimeRangePicker';
import { SqlEditor } from './SqlEditor';
import { useApp } from '../../app/AppProvider';
import { useAsync } from '../../hooks/useAsync';
import { timeBounds, quoteIdentifier } from '../../lib/query';
import type { LogRecord, TimeRange } from '../../lib/types';
export function SqlPage() {
  const { client, mode } = useApp();
  const [params] = useSearchParams();
  const [query, setQuery] = useState(
    params.get('query') ||
      (mode === 'demo'
        ? 'SELECT * FROM "application_logs"\nORDER BY "p_timestamp" DESC\nLIMIT 100'
        : ''),
  );
  const [range, setRange] = useState<TimeRange>('1h');
  const [request, setRequest] = useState<{ sql: string; startTime: string; endTime: string }>();
  const [row, setRow] = useState<LogRecord>();
  const [wrap, setWrap] = useState(false);
  const [columns, setColumns] = useState<string[]>();
  const [datasetSearch, setDatasetSearch] = useState('');
  const datasets = useAsync(useCallback((signal) => client.listDatasets(signal), [client]));
  const results = useAsync(
    useCallback(
      (signal) => (request ? client.query(request, signal) : Promise.resolve([])),
      [request, client],
    ),
  );
  const run = () => {
    if (query.trim()) {
      setColumns(undefined);
      setRequest({ sql: query, ...timeBounds(range) });
    }
  };
  return (
    <div className="page sql-page">
      <div className="sql-query-tab">Query 1</div>
      <PageHeader
        title="SQL editor"

        actions={<TimeRangePicker value={range} onChange={setRange} />}
      />
      <div className="sql-layout">
        <aside className="sql-datasets" aria-label="SQL datasets">
          <div className="panel-heading">
            <h2>Explorer</h2>
            <span className="count-label">{datasets.data?.length || 0}</span>
          </div>
          <Input
            aria-label="Search SQL datasets"
            placeholder="Search datasets"
            value={datasetSearch}
            onChange={(e) => setDatasetSearch(e.target.value)}
          />
          <QueryState loading={datasets.loading} error={datasets.error} retry={datasets.reload} />
          {datasets.data
            ?.filter((d) => d.name.toLowerCase().includes(datasetSearch.toLowerCase()))
            .map((dataset) => (
              <Button
                key={dataset.name}
                className="sql-dataset"
                variant="ghost"
                title={`Query ${dataset.name}`}
                onClick={() =>
                  setQuery(
                    `SELECT * FROM ${quoteIdentifier(dataset.name)}\nORDER BY "p_timestamp" DESC\nLIMIT 100`,
                  )
                }
              >
                <Database size={14} />
                {dataset.name}
              </Button>
            ))}
        </aside>
        <div className="sql-main">
          <Card className="editor-card">
            <div className="panel-heading">
              <h2>Query</h2>
              <span className="muted">⌘ / Ctrl + Enter to run</span>
            </div>
            <SqlEditor value={query} onChange={setQuery} onRun={run} />
            <div className="editor-footer">
              <span className="muted">
                {mode === 'demo'
                  ? 'Demo supports SELECT *, exact filters, message search, ordering, and limits.'
                  : 'Queries run against your connected Parseable server.'}
              </span>
              <Button variant="primary" onClick={run} disabled={results.loading || !query.trim()}>
                <Play size={14} />
                Run query
              </Button>
            </div>
          </Card>
          <Card className="query-results">
            <div className="panel-heading">
              <h2>Results</h2>
              <div className="inline wrap results-actions">
                <ColumnPicker
                  fields={[...new Set((results.data || []).flatMap(Object.keys))]}
                  selected={columns || [...new Set((results.data || []).flatMap(Object.keys))]}
                  onChange={setColumns}
                />
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
                  variant="ghost"
                  size="sm"
                  disabled={!results.data?.length || results.loading}
                  onClick={() => exportRecords(results.data || [], 'json')}
                >
                  <Download size={14} />
                  Export JSON
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!results.data?.length || results.loading}
                  onClick={() => exportRecords(results.data || [], 'csv')}
                >
                  Export CSV
                </Button>
              </div>
            </div>
            {!request ? (
              <EmptyState
                title="Ready when you are"
                description="Run a query to inspect your events."
              />
            ) : (
              <>
                <QueryState
                  loading={results.loading}
                  error={results.error}
                  retry={results.reload}
                />
                {!results.loading && !results.error && (
                  <DataTable
                    rows={results.data || []}
                    columns={columns}
                    onSelect={setRow}
                    wrap={wrap}
                  />
                )}
              </>
            )}
          </Card>
        </div>
      </div>
      <RecordSheet row={row} onClose={() => setRow(undefined)} />
    </div>
  );
}
