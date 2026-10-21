import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
} from 'react';
import { useSearchParams } from 'react-router-dom';
import { Play, Download, WrapText, Plus, X, Pencil, Square } from 'lucide-react';
import { Button, Card, EmptyState, Input } from '../../components/ui';
import { PageHeader } from '../../components/explorer/PageHeader';
import { reconcileSelectedColumns } from '../../components/explorer/columnOrder';
import { ColumnPicker } from '../../components/explorer/ColumnPicker';
import { DataTable, exportRecords } from '../../components/explorer/DataTable';
import { QueryState } from '../../components/explorer/QueryState';
import { RecordSheet } from '../../components/explorer/RecordSheet';
import { TimeRangePicker } from '../../components/explorer/TimeRangePicker';
import { SqlEditor, type SqlEditorHandle } from './SqlEditor';
import { SqlSidebar } from './SqlSidebar';
import { SqlChartPanel, readSqlChartConfig } from './SqlChartPanel';
import { createQueryTab, datasetQuery, hydrateQueryTabs, type QueryTab } from './workspace';
import { useApp } from '../../app/AppProvider';
import { useAsync } from '../../hooks/useAsync';
import { timeBounds } from '../../lib/query';
import type { LogRecord } from '../../lib/types';
import { readSavedQueries, sqlStorageScope } from './savedQueries';
import { sqlHandoffRange } from './serverSavedQueries';
import './sql.css';
// Session storage isolates draft workspaces per browser tab while surviving reloads.
// The saved-query library separately uses persistent local storage.
function restoreDrafts(scope: string | null): QueryTab[] {
  if (!scope) return [];
  try {
    return readSavedQueries(sessionStorage.getItem(`${scope}:drafts`)).map((item) => {
      const restored = createQueryTab(item.name, item.sql, item.range);
      restored.savedId = item.savedId;
      restored.columns = item.columns;
      restored.columnFields = item.columnFields;
      restored.datasets = item.datasets;
      restored.chart = readSqlChartConfig(item.chart) || restored.chart;
      return restored;
    });
  } catch {
    return [];
  }
}
function writeDrafts(scope: string, tabs: QueryTab[]) {
  try {
    sessionStorage.setItem(
      `${scope}:drafts`,
      JSON.stringify(
        tabs.map((item) => ({
          id: item.id,
          savedId: item.savedId,
          name: item.name,
          sql: item.query,
          range: item.range,
          datasets: item.datasets,
          chart: item.chart,
          columns: item.columns,
          columnFields: item.columnFields,
          updatedAt: new Date().toISOString(),
        })),
      ),
    );
  } catch {
    /* A blocked/full store must not prevent querying. */
  }
}
function nextQueryName(tabs: QueryTab[]) {
  let number = 1;
  while (tabs.some((item) => item.name === `Query ${number}`)) number++;
  return `Query ${number}`;
}
export function SqlPage() {
  const { mode, session, needsLogin } = useApp();
  return <SqlWorkspace key={`${mode}:${session}:${needsLogin}`} />;
}
function SqlWorkspace() {
  const { client, mode, identity } = useApp();
  const scope = sqlStorageScope(mode, identity);
  const [params, setParams] = useSearchParams();
  const [tabs, setTabs] = useState<QueryTab[]>(() => {
    const drafts = restoreDrafts(scope);
    if (params.has('query')) {
      const query = params.get('query') || '';
      const range = sqlHandoffRange(params);
      const index = drafts.findIndex(
        (item) => item.query === query && JSON.stringify(item.range) === JSON.stringify(range),
      );
      if (index >= 0) drafts.push(...drafts.splice(index, 1));
      else drafts.push(createQueryTab(nextQueryName(drafts), query, range));
    }
    return drafts.length
      ? drafts
      : [
          createQueryTab(
            'Query 1',
            mode === 'demo' ? datasetQuery(['application_logs']) : '',
            sqlHandoffRange(params),
          ),
        ];
  });
  const [hydratedScope, setHydratedScope] = useState(scope);
  const draftSnapshot = useRef<{ scope: string; tabs: QueryTab[] } | undefined>(undefined);
  if (scope && hydratedScope === scope) draftSnapshot.current = { scope, tabs };
  const previousScope = useRef(scope);
  const previousUrl = useRef(params.toString());
  // A handoff placeholder is not a user edit: hydrate its stored metadata once identity arrives.
  // Runtime execution changes do not mark a tab dirty; explicit SQL/config edits do.
  const editedTabs = useRef(new Set<string>());
  const [activeId, setActiveId] = useState(tabs[tabs.length - 1].id);
  const tab = tabs.find((item) => item.id === activeId) || tabs[0];
  const editor = useRef<SqlEditorHandle>(null);
  const [closedTab, setClosedTab] = useState<{
    tab: QueryTab;
    index: number;
    placeholder?: string;
  }>();
  const [sidebarMax, setSidebarMax] = useState(440);
  const [renaming, setRenaming] = useState<string>();
  const [row, setRow] = useState<LogRecord>();
  const [sidebarWidth, setSidebarWidth] = useState(272);
  const [editorHeight, setEditorHeight] = useState(300);
  const requests = useRef(new Map<string, AbortController>());
  const layout = useRef<HTMLDivElement>(null);
  const datasets = useAsync(useCallback((signal) => client.listDatasets(signal), [client]));
  const patch = (id: string, value: Partial<QueryTab>) => {
    const existing = tabs.find((item) => item.id === id);
    if (
      existing &&
      ['name', 'query', 'range', 'datasets', 'chart', 'savedId', 'columns'].some(
        (key) =>
          key in value &&
          JSON.stringify(existing[key as keyof QueryTab]) !==
            JSON.stringify(value[key as keyof QueryTab]),
      )
    )
      editedTabs.current.add(id);
    setTabs((items) => items.map((item) => (item.id === id ? { ...item, ...value } : item)));
  };
  useEffect(() => {
    requests.current.forEach((controller) => controller.abort());
    requests.current.clear();
    setTabs((items) =>
      items.map((item) =>
        item.loading ? { ...item, loading: false, canceled: true, request: undefined } : item,
      ),
    );
    return () => {
      requests.current.forEach((controller) => controller.abort());
      requests.current.clear();
    };
  }, [client]);
  useEffect(() => {
    if (scope === previousScope.current) return;
    if (draftSnapshot.current && draftSnapshot.current.scope !== scope)
      writeDrafts(draftSnapshot.current.scope, draftSnapshot.current.tabs);
    const firstIdentity = previousScope.current === null && scope !== null;
    previousScope.current = scope;
    const drafts = restoreDrafts(scope);
    if (firstIdentity) {
      const anonymous = tabs.filter(
        (item) =>
          item.query.trim() ||
          item.savedId ||
          item.datasets.length ||
          editedTabs.current.has(item.id),
      );
      const merged = hydrateQueryTabs(drafts, anonymous, editedTabs.current);
      const next = merged.length ? merged : tabs;
      setTabs(next);
      setActiveId(anonymous.length ? anonymous[anonymous.length - 1].id : next[next.length - 1].id);
    } else {
      requests.current.forEach((controller) => controller.abort());
      requests.current.clear();
      const next = drafts.length ? drafts : [createQueryTab('Query 1')];
      setTabs(next);
      setActiveId(next[next.length - 1].id);
      setRow(undefined);
      setClosedTab(undefined);
      editedTabs.current.clear();
    }
    setHydratedScope(scope);
  }, [scope]);
  useEffect(() => {
    const url = params.toString();
    if (!params.has('query')) {
      previousUrl.current = url;
      return;
    }
    const alreadyProcessed = url === previousUrl.current;
    // Keep the handoff marked as processed until the router commits its removal.
    // An edit can rerun this effect while params still contains the old query.
    previousUrl.current = url;
    const query = params.get('query') || '';
    const range = sqlHandoffRange(params);
    const existing = tabs.find(
      (item) => item.query === query && JSON.stringify(item.range) === JSON.stringify(range),
    );
    if (!alreadyProcessed && existing) setActiveId(existing.id);
    else if (!alreadyProcessed) {
      const next = createQueryTab(nextQueryName(tabs), query, range);
      setTabs((items) => [...items, next]);
      setActiveId(next.id);
    }
    setRow(undefined);
    const consumed = new URLSearchParams(params);
    for (const key of ['query', 'start', 'end', 'range']) consumed.delete(key);
    setParams(consumed, { replace: true });
  }, [params, tabs, setParams]);
  useEffect(() => {
    if (!scope || hydratedScope !== scope) return;
    const timer = window.setTimeout(() => writeDrafts(scope, tabs), 300);
    return () => window.clearTimeout(timer);
  }, [tabs, scope, hydratedScope]);
  useEffect(() => {
    const flush = () => {
      const snapshot = draftSnapshot.current;
      if (snapshot) writeDrafts(snapshot.scope, snapshot.tabs);
    };
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, []);
  useEffect(() => {
    const element = layout.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      const max = Math.max(200, Math.min(440, element.clientWidth - 408));
      setSidebarMax(max);
      setSidebarWidth((value) => Math.max(200, Math.min(max, value)));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const clampSidebar = (value: number) => Math.max(200, Math.min(sidebarMax, value));
  const focusTab = (id: string) =>
    window.requestAnimationFrame(() => document.getElementById(`tab-${id}`)?.focus());
  const run = async () => {
    if (!tab.query.trim() || requests.current.has(tab.id)) return;
    const id = tab.id;
    let request;
    try {
      request = { sql: tab.query, ...timeBounds(tab.range) };
    } catch (error) {
      patch(id, { error: error instanceof Error ? error : new Error(String(error)) });
      return;
    }
    const controller = new AbortController();
    requests.current.set(id, controller);
    const start = performance.now();
    patch(id, {
      request,
      loading: true,
      error: undefined,
      rows: [],
      elapsed: undefined,
      canceled: false,
    });
    try {
      const rows = await client.query(request, controller.signal);
      if (!controller.signal.aborted && requests.current.get(id) === controller)
        setTabs((items) =>
          items.map((item) => {
            if (item.id !== id) return item;
            const available = [...new Set(rows.flatMap(Object.keys))];
            return {
              ...item,
              rows,
              loading: false,
              elapsed: performance.now() - start,
              columns: reconcileSelectedColumns(available, item.columns, item.columnFields),
              columnFields: available.length ? available : item.columnFields,
            };
          }),
        );
    } catch (error) {
      if (!controller.signal.aborted && requests.current.get(id) === controller)
        patch(id, {
          loading: false,
          error: error instanceof Error ? error : new Error(String(error)),
        });
    } finally {
      if (requests.current.get(id) === controller) requests.current.delete(id);
    }
  };
  const newQuery = (query = '', names: string[] = []) => {
    const next = createQueryTab(nextQueryName(tabs), query, tab.range);
    next.datasets = names;
    editedTabs.current.add(next.id);
    setTabs((items) => [...items, next]);
    setActiveId(next.id);
    setRow(undefined);
  };
  const close = (id: string) => {
    requests.current.get(id)?.abort();
    requests.current.delete(id);
    const index = tabs.findIndex((item) => item.id === id);
    const removed = tabs[index];
    const remaining = tabs.filter((item) => item.id !== id);
    let placeholder: string | undefined;
    if (!remaining.length) {
      const blank = createQueryTab('Query 1', '', removed.range);
      remaining.push(blank);
      placeholder = blank.id;
    }
    setClosedTab({
      tab: {
        ...removed,
        loading: false,
        canceled: removed.loading || removed.canceled,
        request: removed.loading ? undefined : removed.request,
      },
      index,
      placeholder,
    });
    setTabs(remaining);
    const nextId =
      id === activeId ? remaining[Math.max(0, index - 1)]?.id || remaining[0].id : activeId;
    setActiveId(nextId);
    setRow(undefined);
    focusTab(nextId);
  };
  const undoClose = () => {
    if (!closedTab) return;
    setTabs((items) => {
      const restored = items.filter(
        (item) => item.id !== closedTab.placeholder || item.query.trim() || item.savedId,
      );
      restored.splice(Math.min(closedTab.index, restored.length), 0, closedTab.tab);
      return restored;
    });
    setActiveId(closedTab.tab.id);
    setRow(undefined);
    focusTab(closedTab.tab.id);
    setClosedTab(undefined);
  };
  const resize = (event: PointerEvent<HTMLDivElement>, axis: 'sidebar' | 'editor') => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const target = event.currentTarget;
    const start = axis === 'sidebar' ? event.clientX : event.clientY;
    const initial = axis === 'sidebar' ? sidebarWidth : editorHeight;
    const move = (next: globalThis.PointerEvent) => {
      const value = initial + (axis === 'sidebar' ? next.clientX : next.clientY) - start;
      if (axis === 'sidebar') setSidebarWidth(clampSidebar(value));
      else setEditorHeight(Math.max(180, Math.min(650, value)));
    };
    const stop = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', stop);
      target.removeEventListener('pointercancel', stop);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', stop);
    target.addEventListener('pointercancel', stop);
  };
  const fields = [...new Set(tab.rows.flatMap(Object.keys))];
  const setColumns = (columns: string[]) =>
    patch(tab.id, {
      columns,
      columnFields: fields.length ? fields : tab.columnFields,
    });
  return (
    <div className="page sql-page sql-workspace">
      <div className="sql-tabs">
        <div className="sql-tab-list" role="tablist" aria-label="Query tabs">
          {tabs.map((item, index) => (
            <div key={item.id} className={`sql-tab ${item.id === tab.id ? 'is-active' : ''}`}>
              <button
                type="button"
                role="tab"
                id={`tab-${item.id}`}
                aria-controls="sql-query-panel"
                aria-selected={item.id === tab.id}
                tabIndex={item.id === tab.id ? 0 : -1}
                onClick={() => {
                  setActiveId(item.id);
                  setRow(undefined);
                }}
                onDoubleClick={() => setRenaming(item.id)}
                onKeyDown={(event) => {
                  if (
                    event.key === 'ArrowRight' ||
                    event.key === 'ArrowLeft' ||
                    event.key === 'Home' ||
                    event.key === 'End'
                  ) {
                    event.preventDefault();
                    const next =
                      event.key === 'Home'
                        ? 0
                        : event.key === 'End'
                          ? tabs.length - 1
                          : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) %
                            tabs.length;
                    setActiveId(tabs[next].id);
                    setRow(undefined);
                    document.getElementById(`tab-${tabs[next].id}`)?.focus();
                  }
                }}
              >
                {item.name}
                {item.loading && <span className="sql-running-dot" aria-label="Running" />}
              </button>
            </div>
          ))}
        </div>
        {renaming && (
          <Input
            autoFocus
            aria-label="Query tab name"
            defaultValue={tabs.find((item) => item.id === renaming)?.name}
            onBlur={(event) => {
              if (event.target.value.trim()) patch(renaming, { name: event.target.value.trim() });
              setRenaming(undefined);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
              if (event.key === 'Escape') setRenaming(undefined);
            }}
          />
        )}
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Rename ${tab.name}`}
          onClick={() => setRenaming(tab.id)}
        >
          <Pencil size={12} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Close ${tab.name}`}
          onClick={() => close(tab.id)}
        >
          <X size={13} />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-label="New query tab"
          onClick={() => {
            newQuery();
          }}
        >
          <Plus size={15} />
          New query
        </Button>
      </div>
      {closedTab && (
        <div className="sql-results-toolbar inline" role="status">
          Closed {closedTab.tab.name}
          <Button size="sm" variant="ghost" onClick={undoClose}>
            Undo close
          </Button>
        </div>
      )}
      <PageHeader
        title="SQL editor"
        actions={
          <TimeRangePicker value={tab.range} onChange={(range) => patch(tab.id, { range })} />
        }
      />
      <div
        ref={layout}
        className="sql-layout"
        style={
          {
            '--sql-sidebar-width': `${sidebarWidth}px`,
            '--sql-editor-height': `${editorHeight}px`,
          } as CSSProperties
        }
      >
        <SqlSidebar
          datasets={datasets.data || []}
          loading={datasets.loading}
          error={datasets.error}
          retry={datasets.reload}
          selectedDatasets={tab.datasets}
          onSelectedDatasetsChange={(names) => patch(tab.id, { datasets: names })}
          currentQuery={tab.query}
          currentRange={tab.range}
          currentName={tab.name}
          currentChart={tab.chart}
          currentColumns={tab.columns}
          currentColumnFields={tab.columnFields}
          currentSavedId={tab.savedId}
          onSaved={(item) => patch(tab.id, { savedId: item.id, name: item.name })}
          onGenerateQuery={() => newQuery(datasetQuery(tab.datasets), tab.datasets)}
          onInsertText={(text) => editor.current?.insertText(text)}
          onOpenServerQuery={(item) => {
            // Server records stay read only: the tab is an unsaved draft of their SQL.
            const existing = tabs.find(
              (tab) =>
                !tab.savedId &&
                tab.name === item.name &&
                tab.query === item.sql &&
                JSON.stringify(tab.range) === JSON.stringify(item.range),
            );
            if (existing) {
              setActiveId(existing.id);
              setRow(undefined);
              focusTab(existing.id);
              return;
            }
            const next = createQueryTab(item.name, item.sql, item.range);
            next.datasets = [...item.datasets];
            setTabs((items) => [...items, next]);
            setActiveId(next.id);
            setRow(undefined);
          }}
          onOpenQuery={(item) => {
            const existing = tabs.find((tab) => tab.savedId === item.id);
            if (existing) {
              setActiveId(existing.id);
              setRow(undefined);
              focusTab(existing.id);
              return;
            }
            const next = createQueryTab(item.name, item.sql, item.range);
            next.datasets = item.datasets;
            next.savedId = item.id;
            next.columns = item.columns;
            next.columnFields = item.columnFields;
            next.chart = readSqlChartConfig(item.chart) || next.chart;
            setTabs((items) => [...items, next]);
            setActiveId(next.id);
            setRow(undefined);
          }}
        />
        <div
          className="sql-resize sql-resize-sidebar"
          role="separator"
          tabIndex={0}
          aria-label="Resize SQL sidebar"
          aria-orientation="vertical"
          aria-valuemin={200}
          aria-valuemax={sidebarMax}
          aria-controls="sql-query-panel"
          aria-valuenow={sidebarWidth}
          onPointerDown={(event) => resize(event, 'sidebar')}
          onKeyDown={(event) => {
            if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
              event.preventDefault();
              setSidebarWidth((value) =>
                event.key === 'Home'
                  ? 200
                  : event.key === 'End'
                    ? sidebarMax
                    : clampSidebar(value + (event.key === 'ArrowLeft' ? -20 : 20)),
              );
            }
          }}
        />
        <div
          className="sql-main"
          id="sql-query-panel"
          role="tabpanel"
          aria-labelledby={`tab-${tab.id}`}
        >
          <Card className="editor-card">
            <div className="panel-heading">
              <h2>{tab.name}</h2>
              <span className="muted">⌘ / Ctrl + Enter to run</span>
            </div>
            {tab.datasets.length > 1 && (
              <p className="sql-selection-note muted">
                UNION ALL BY NAME fills missing columns with NULL; common columns need compatible
                types.
                {mode === 'demo' ? ' Multi-dataset queries require a live connection.' : ''}
              </p>
            )}
            <SqlEditor
              key={tab.id}
              ref={editor}
              value={tab.query}
              onChange={(query) => patch(tab.id, { query })}
              onRun={run}
            />
            <div className="editor-footer">
              <span className="muted">
                ⌘ / Ctrl + Enter to run{mode === 'demo' ? ' · Demo data' : ''}
              </span>
              {tab.loading ? (
                <Button
                  onClick={() => {
                    requests.current.get(tab.id)?.abort();
                    requests.current.delete(tab.id);
                    patch(tab.id, { loading: false, request: undefined, canceled: true });
                  }}
                >
                  <Square size={13} />
                  Cancel query
                </Button>
              ) : (
                <Button variant="primary" onClick={run} disabled={!tab.query.trim()}>
                  <Play size={14} />
                  Run query
                </Button>
              )}
            </div>
          </Card>
          <div
            className="sql-resize sql-resize-editor"
            role="separator"
            tabIndex={0}
            aria-label="Resize SQL editor"
            aria-orientation="horizontal"
            aria-valuemin={180}
            aria-valuemax={650}
            aria-valuenow={editorHeight}
            aria-controls="sql-output-panel"
            onPointerDown={(event) => resize(event, 'editor')}
            onKeyDown={(event) => {
              if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
                event.preventDefault();
                setEditorHeight((value) =>
                  event.key === 'Home'
                    ? 180
                    : event.key === 'End'
                      ? 650
                      : Math.max(180, Math.min(650, value + (event.key === 'ArrowUp' ? -20 : 20))),
                );
              }
            }}
          />
          <Card className="query-results">
            <div className="panel-heading">
              <div className="sql-result-tabs" role="tablist" aria-label="Query output">
                {(['results', 'chart'] as const).map((view) => (
                  <button
                    type="button"
                    key={view}
                    role="tab"
                    id={`sql-${view}-tab`}
                    aria-controls="sql-output-panel"
                    aria-selected={tab.view === view}
                    tabIndex={tab.view === view ? 0 : -1}
                    onKeyDown={(event) => {
                      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                        event.preventDefault();
                        const next =
                          event.key === 'Home'
                            ? 'results'
                            : event.key === 'End'
                              ? 'chart'
                              : view === 'results'
                                ? 'chart'
                                : 'results';
                        patch(tab.id, { view: next });
                        document.getElementById(`sql-${next}-tab`)?.focus();
                      }
                    }}
                    onClick={() => patch(tab.id, { view })}
                  >
                    {view === 'results' ? 'Results' : 'Chart'}
                  </button>
                ))}
              </div>
              <span className="muted" role="status">
                {tab.request && !tab.loading && !tab.error
                  ? `${tab.rows.length.toLocaleString()} rows${tab.elapsed !== undefined ? ` · ${(tab.elapsed / 1000).toFixed(2)}s` : ''}`
                  : tab.canceled
                    ? 'Query canceled'
                    : ''}
              </span>
            </div>
            <div id="sql-output-panel" role="tabpanel" aria-labelledby={`sql-${tab.view}-tab`}>
              {tab.view === 'results' && (
                <div className="sql-results-toolbar inline wrap">
                  <ColumnPicker
                    fields={fields}
                    selected={tab.columns || fields}
                    onChange={setColumns}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Toggle row wrapping"
                    aria-pressed={tab.wrap}
                    onClick={() => patch(tab.id, { wrap: !tab.wrap })}
                  >
                    <WrapText size={15} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!tab.rows.length || tab.loading}
                    onClick={() => exportRecords(tab.rows, 'json')}
                  >
                    <Download size={14} />
                    Export JSON
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!tab.rows.length || tab.loading}
                    onClick={() => exportRecords(tab.rows, 'csv')}
                  >
                    Export CSV
                  </Button>
                </div>
              )}
              {!tab.request && !tab.error ? (
                <EmptyState
                  title="Ready when you are"
                  description="Run a query to inspect your events."
                />
              ) : (
                <>
                  <QueryState loading={tab.loading} error={tab.error} retry={run} />
                  {tab.request &&
                    !tab.loading &&
                    !tab.error &&
                    (tab.view === 'results' ? (
                      <DataTable
                        key={tab.id}
                        rows={tab.rows}
                        columns={tab.columns}
                        onColumnsChange={setColumns}
                        onSelect={setRow}
                        wrap={tab.wrap}
                      />
                    ) : (
                      <SqlChartPanel
                        key={tab.id}
                        selectedDatasets={tab.datasets}
                        rows={tab.rows}
                        query={tab.request.sql}
                        range={{ startTime: tab.request.startTime, endTime: tab.request.endTime }}
                        config={tab.chart}
                        onConfigChange={(chart) => patch(tab.id, { chart })}
                      />
                    ))}
                </>
              )}
            </div>
          </Card>
        </div>
      </div>
      <RecordSheet row={row} onClose={() => setRow(undefined)} />
    </div>
  );
}
