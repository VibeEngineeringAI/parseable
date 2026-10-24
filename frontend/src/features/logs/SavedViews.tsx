import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bookmark } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Button, Dialog, Input, Select } from '../../components/ui';
import { useApp } from '../../app/AppProvider';
import { useAsync } from '../../hooks/useAsync';
import { sha256 } from '../../lib/sha256';
import { buildExplorerQuery } from '../../lib/logQuery';
import type { SavedLogView } from '../../lib/types';
import { serverSavedQuery, sqlEditorHandoff } from '../sql/serverSavedQueries';
import { decodeLogView, encodeLogView, type LogViewState } from './logViewState';

export function savedLogViewState(view: SavedLogView): LogViewState {
  if (typeof view.explorer_state !== 'string' || view.query.filter_type !== 'sql')
    throw new Error('This saved view uses a classic format and cannot be opened in this explorer.');
  const state = decodeLogView(view.explorer_state);
  if (view.stream_name !== 'sql' && state.dataset !== view.stream_name)
    throw new Error('This saved view has inconsistent dataset metadata.');
  return state;
}
export function savedLogViewsForDataset(views: SavedLogView[], dataset: string) {
  return views.flatMap<{ view: SavedLogView; decoded: LogViewState | undefined }>((view) => {
    try {
      const decoded = savedLogViewState(view);
      return decoded.dataset === dataset ? [{ view, decoded }] : [];
    } catch {
      // Classic dataset-scoped views remain visible, but canonical views need a
      // valid explorer state to establish which dataset they belong to. Saved
      // PromQL queries share the endpoint but are not log views.
      return view.query.filter_type !== 'promql' &&
        view.stream_name !== 'sql' &&
        view.stream_name === dataset
        ? [{ view, decoded: undefined }]
        : [];
    }
  });
}
function savedLogViewKey(view: SavedLogView): string {
  return view.filter_id ? JSON.stringify([view.user_id ?? null, view.filter_id]) : '';
}
/** Ownership is a display constraint; backend authorization remains authoritative. */
export function ownsSavedLogView(
  view: SavedLogView | undefined,
  hash: string | undefined,
  demo = false,
): boolean {
  return !!view && (demo ? view.user_id === 'demo' : !!hash && view.user_id === hash);
}
export function savedLogViewBody(
  state: LogViewState,
  name: string,
  previous?: SavedLogView,
  timestampField = 'p_timestamp',
): SavedLogView {
  const filter_name = name.trim();
  if (!filter_name || filter_name.length > 200)
    throw new Error('Enter a view name of 1 to 200 characters.');
  return {
    ...previous,
    filter_name,
    stream_name: previous?.stream_name === 'sql' ? 'sql' : state.dataset,
    query: {
      ...(previous?.query ?? {}),
      filter_type: 'sql',
      filter_query: buildExplorerQuery(
        state.dataset,
        state.search,
        state.expression,
        state.limit,
        timestampField,
      ),
      filter_builder: null,
    },
    explorer_state: encodeLogView(state),
    time_filter:
      typeof state.range === 'object'
        ? { from: state.range.startTime, to: state.range.endTime }
        : null,
  };
}

export function SavedViews({
  state,
  onApply,
  timestampField = 'p_timestamp',
}: {
  state: LogViewState;
  timestampField?: string;
  onApply: (state: LogViewState) => void;
}) {
  const { client, identity, mode } = useApp();
  const navigate = useNavigate();
  const ownerHash = useAsync(
    useCallback(
      async () => (identity?.source === 'server' ? sha256(identity.id) : undefined),
      [identity?.id, identity?.source],
    ),
  );
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const generation = useRef(0);
  const pendingMutation = useRef<{ generation: number } | null>(null);
  useEffect(() => {
    generation.current += 1;
    pendingMutation.current = null;
    setSelected('');
    setName('');
    setError('');
    setNotice('');
    setBusy(false);
    return () => {
      generation.current += 1;
      pendingMutation.current = null;
    };
  }, [client, state.dataset]);
  const views = useAsync(
    useCallback(
      (signal) => (open ? client.listLogViews(signal) : Promise.resolve([])),
      [client, open],
    ),
  );
  const available = useMemo(
    () => savedLogViewsForDataset(views.data ?? [], state.dataset),
    [views.data, state.dataset],
  );
  const selectedView = selected
    ? available.find((item) => savedLogViewKey(item.view) === selected)
    : undefined;
  const view = selectedView?.view;
  const owned = ownsSavedLogView(view, ownerHash.data, mode === 'demo');
  async function mutate(action: 'create' | 'update' | 'delete' | 'convert') {
    if (pendingMutation.current) return;
    const requestGeneration = generation.current;
    const mutation = { generation: requestGeneration };
    let completed = false;
    pendingMutation.current = mutation;
    setError('');
    setNotice('');
    setBusy(true);
    try {
      if (action === 'create') {
        const created = await client.createLogView(
          savedLogViewBody(state, name, undefined, timestampField),
        );
        completed = true;
        if (requestGeneration !== generation.current) return;
        setSelected(savedLogViewKey(created));
        setName(created.filter_name);
      } else {
        if (!view?.filter_id) throw new Error('Select a saved view first.');
        if (!owned)
          throw new Error(
            'Only the owner can change this saved view. Apply it or save a new copy instead.',
          );
        if (action === 'convert') {
          if (!selectedView?.decoded) throw new Error('This saved view cannot be converted here.');
          const converted = await client.convertLogViewToSql(view.filter_id);
          completed = true;
          if (requestGeneration !== generation.current) return;
          setName(converted.filter_name);
        } else if (action === 'update') {
          // Classic views remain readable in the list but are never overwritten.
          if (!selectedView?.decoded)
            throw new Error('This saved view cannot be overwritten here.');
          await client.updateLogView(
            view.filter_id,
            savedLogViewBody(state, name, view, timestampField),
          );
          completed = true;
        } else {
          await client.deleteLogView(view.filter_id);
          completed = true;
        }
        if (requestGeneration !== generation.current) return;
        if (action === 'delete') {
          setSelected('');
          setName('');
        }
      }
      setNotice(
        action === 'delete'
          ? 'View deleted.'
          : action === 'convert'
            ? 'View converted to SQL. Its query and dataset were retained.'
            : 'View saved on the server.',
      );
    } catch (cause) {
      if (requestGeneration === generation.current)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (pendingMutation.current === mutation) {
        pendingMutation.current = null;
        // A server write owns the lock across dialog generations. Confirmed
        // writes refresh the list even when their draft and notice are stale.
        if (completed) views.reload();
        setBusy(false);
      }
    }
  }
  const editingDisabled = busy && pendingMutation.current?.generation === generation.current;
  const compatible = !!selectedView?.decoded;
  // Opening uses the stored SQL verbatim and never writes the record.
  const storedSql = view ? serverSavedQuery(view) : undefined;
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        <Bookmark size={15} />
        Saved views
      </Button>
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            generation.current += 1;
          }
          setOpen(nextOpen);
        }}
        title="Saved log views"
        description="Views are saved on your Parseable server for this dataset."
      >
        <div className="stack">
          {views.loading && <p role="status">Loading saved views…</p>}
          {views.error && (
            <div role="alert">
              <p>{views.error.message}</p>
              <Button onClick={views.reload}>Retry saved views</Button>
            </div>
          )}
          <label>
            Saved view
            <Select
              aria-label="Saved log view"
              value={selected}
              disabled={editingDisabled}
              onChange={(event) => {
                const key = event.target.value;
                setSelected(key);
                setName(
                  available.find((item) => savedLogViewKey(item.view) === key)?.view.filter_name ??
                    '',
                );
                setError('');
                setNotice('');
              }}
            >
              <option value="">New view</option>
              {available
                .filter(({ view }) => view.filter_id)
                .map(({ view: item, decoded }) => (
                  <option key={savedLogViewKey(item)} value={savedLogViewKey(item)}>
                    {item.filter_name}
                    {!decoded ? ' (classic or incompatible)' : ''}
                    {!ownsSavedLogView(item, ownerHash.data, mode === 'demo') ? ' (read only)' : ''}
                  </option>
                ))}
            </Select>
          </label>
          {view && !compatible && storedSql && (
            <p>
              This classic view cannot be applied or overwritten here. Open its saved SQL in the SQL
              editor, or save a new view instead.
              {storedSql.rangeFallback
                ? ' Its saved time range is unreadable, so the default range is used.'
                : ''}
            </p>
          )}
          {view && !compatible && !storedSql && (
            <p>
              This classic view stores a filter builder or search instead of SQL, so it cannot be
              opened in this explorer or the SQL editor. Save a new view instead.
            </p>
          )}
          {view && !owned && (
            <p>
              This view is read only because its ownership could not be verified as yours. You can
              apply it or save a new copy.
            </p>
          )}
          {view && owned && compatible && view.stream_name !== 'sql' && (
            <p>Convert this saved view to SQL while keeping its existing query and dataset.</p>
          )}
          <label>
            View name
            <Input
              aria-label="Log view name"
              value={name}
              maxLength={200}
              disabled={editingDisabled}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          {error && <p role="alert">{error}</p>}
          {notice && <p role="status">{notice}</p>}
          <div className="inline">
            <Button
              variant="secondary"
              disabled={busy || !owned || !compatible || view?.stream_name === 'sql'}
              onClick={() => void mutate('convert')}
            >
              Convert to SQL view
            </Button>
            <Button
              variant="secondary"
              disabled={busy || !storedSql}
              onClick={() => {
                if (!storedSql) return;
                setOpen(false);
                navigate(sqlEditorHandoff(storedSql));
              }}
            >
              Open in SQL editor
            </Button>
            <Button
              disabled={busy || !compatible}
              onClick={() => {
                if (!view) return;
                try {
                  if (!selectedView?.decoded) return;
                  onApply(selectedView.decoded);
                  setOpen(false);
                } catch (cause) {
                  setError(cause instanceof Error ? cause.message : String(cause));
                }
              }}
            >
              Apply view
            </Button>
            <Button disabled={busy || !name.trim()} onClick={() => void mutate('create')}>
              Save new view
            </Button>
            <Button
              variant="secondary"
              disabled={busy || !owned || !compatible || !name.trim()}
              onClick={() => void mutate('update')}
            >
              Update selected
            </Button>
            <Button
              variant="secondary"
              disabled={busy || !owned || !view?.filter_id}
              onClick={() => void mutate('delete')}
            >
              Delete selected
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
