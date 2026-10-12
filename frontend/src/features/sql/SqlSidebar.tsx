import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Trash2 } from 'lucide-react';
import { Button, Input } from '../../components/ui';
import { QueryState } from '../../components/explorer/QueryState';
import { useApp } from '../../app/AppProvider';
import { useAsync } from '../../hooks/useAsync';
import { quoteIdentifier } from '../../lib/query';
import type { Dataset, TimeRange } from '../../lib/types';
import { readSavedQueries, saveQuery, sqlStorageScope, type SavedQuery } from './savedQueries';
import './sql-sidebar.css';
export interface SqlSidebarProps {
  datasets: Dataset[];
  loading: boolean;
  error?: Error;
  retry: () => void;
  selectedDatasets: string[];
  onSelectedDatasetsChange: (names: string[]) => void;
  onOpenQuery: (item: SavedQuery) => void;
  onGenerateQuery: () => void;
  onInsertText?: (text: string) => void;
  currentQuery: string;
  currentRange: TimeRange;
  currentName: string;
  currentSavedId?: string;
  currentChart?: unknown;
  onSaved?: (item: SavedQuery) => void;
}
function Schema({ name, onInsertText }: { name: string; onInsertText?: (text: string) => void }) {
  const { client } = useApp();
  const schema = useAsync(useCallback((signal) => client.schema(name, signal), [client, name]));
  return (
    <div className="sql-library-schema">
      <QueryState loading={schema.loading} error={schema.error} retry={schema.reload} />
      {schema.data?.map((field) => (
        <Button
          variant="ghost"
          size="sm"
          key={field}
          disabled={!onInsertText}
          title={`Insert ${field}`}
          onClick={() => onInsertText?.(quoteIdentifier(field))}
        >
          {field}
        </Button>
      ))}
    </div>
  );
}
export function SqlSidebar(props: SqlSidebarProps) {
  const { mode, identity } = useApp();
  const scope = sqlStorageScope(mode, identity);
  const [stored, setStored] = useState<{ scope: string | null; items: SavedQuery[] }>({
    scope: null,
    items: [],
  });
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [librarySearch, setLibrarySearch] = useState('');
  const [name, setName] = useState(props.currentName);
  const [expanded, setExpanded] = useState<string>();
  const items = stored.scope === scope ? stored.items : [];
  useEffect(() => {
    setName(props.currentName);
  }, [props.currentName, props.currentSavedId]);
  useEffect(() => {
    const load = () => {
      try {
        setStored({
          scope,
          items: scope ? readSavedQueries(localStorage.getItem(`${scope}:library`)) : [],
        });
        setError('');
      } catch {
        setStored({ scope, items: [] });
        setError('Browser storage is unavailable.');
      }
    };
    load();
    const onStorage = (event: StorageEvent) => {
      if (event.key === `${scope}:library` || event.key === null) load();
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [scope]);
  const persist = (next: SavedQuery[]) => {
    if (!scope) return false;
    try {
      localStorage.setItem(`${scope}:library`, JSON.stringify(next));
      setStored({ scope, items: next });
      setError('');
      return true;
    } catch {
      setError('Could not save: browser storage is unavailable or full.');
      return false;
    }
  };
  const save = (update: boolean) => {
    const item: SavedQuery = {
      id: update && props.currentSavedId ? props.currentSavedId : crypto.randomUUID(),
      name: name.trim(),
      sql: props.currentQuery,
      range: props.currentRange,
      datasets: [...props.selectedDatasets],
      updatedAt: new Date().toISOString(),
      ...(props.currentChart === undefined ? {} : { chart: props.currentChart }),
    };
    if (persist(saveQuery(items, item))) props.onSaved?.(item);
  };
  const canSave = !!scope && !!name.trim() && !!props.currentQuery.trim();
  return (
    <aside className="sql-datasets sql-library-sidebar" aria-label="SQL datasets and saved queries">
      <div className="panel-heading">
        <h2>Explorer</h2>
        <span className="count-label">{props.datasets.length}</span>
      </div>
      <Input
        aria-label="Search SQL datasets"
        placeholder="Search datasets"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      <QueryState loading={props.loading} error={props.error} retry={props.retry} />
      <div className="sql-library-datasets">
        {props.datasets
          .filter((dataset) => dataset.name.toLowerCase().includes(search.toLowerCase()))
          .map((dataset) => (
            <div key={dataset.name}>
              <div className="sql-library-dataset">
                <input
                  type="checkbox"
                  aria-label={`Select ${dataset.name}`}
                  checked={props.selectedDatasets.includes(dataset.name)}
                  onChange={(event) =>
                    props.onSelectedDatasetsChange(
                      event.target.checked
                        ? [...props.selectedDatasets, dataset.name]
                        : props.selectedDatasets.filter((name) => name !== dataset.name),
                    )
                  }
                />
                <span title={dataset.name}>{dataset.name}</span>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Explore schema for ${dataset.name}`}
                  aria-expanded={expanded === dataset.name}
                  onClick={() => setExpanded(expanded === dataset.name ? undefined : dataset.name)}
                >
                  {expanded === dataset.name ? (
                    <ChevronDown size={14} />
                  ) : (
                    <ChevronRight size={14} />
                  )}
                </Button>
              </div>
              {expanded === dataset.name && (
                <Schema name={dataset.name} onInsertText={props.onInsertText} />
              )}
            </div>
          ))}
      </div>
      <Button size="sm" disabled={!props.selectedDatasets.length} onClick={props.onGenerateQuery}>
        New query from selection
      </Button>
      <p className="muted sql-library-hint">
        Select datasets to start a query. Selection does not change your SQL.
      </p>
      <div className="panel-heading">
        <h2>Saved queries</h2>
        <span className="count-label">{items.length}</span>
      </div>
      <p className="muted sql-library-hint">
        Saved on this browser for {mode === 'demo' ? 'demo' : 'your account'}.
      </p>
      {!scope && (
        <p className="muted" role="status">
          Your account has not been identified. Queries and drafts are not being saved yet.
        </p>
      )}
      <Input
        aria-label="Saved query name"
        placeholder="Query name"
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <div className="sql-library-save">
        <Button size="sm" disabled={!canSave} onClick={() => save(false)}>
          Save as new
        </Button>
        {props.currentSavedId && items.some((item) => item.id === props.currentSavedId) && (
          <Button size="sm" disabled={!canSave} onClick={() => save(true)}>
            Update saved
          </Button>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
      <Input
        aria-label="Search saved queries"
        placeholder="Search saved queries"
        value={librarySearch}
        onChange={(event) => setLibrarySearch(event.target.value)}
      />
      <div className="sql-library-items">
        {items
          .filter((item) =>
            `${item.name} ${item.sql} ${item.datasets.join(' ')}`
              .toLowerCase()
              .includes(librarySearch.toLowerCase()),
          )
          .map((item) => (
            <div className="sql-library-item" key={item.id}>
              <Button
                variant="ghost"
                size="sm"
                title={item.sql}
                onClick={() => props.onOpenQuery(item)}
              >
                {item.name}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Delete saved query ${item.name}`}
                onClick={() => persist(items.filter((existing) => existing.id !== item.id))}
              >
                <Trash2 size={13} />
              </Button>
            </div>
          ))}
        {!items.length && <p className="muted">No saved queries yet.</p>}
      </div>
    </aside>
  );
}
