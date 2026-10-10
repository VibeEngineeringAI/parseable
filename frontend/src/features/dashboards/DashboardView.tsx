import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  ActionsMenu,
  Badge,
  Button,
  Dialog,
  EmptyState,
  Spinner,
  TypedConfirmDialog,
} from '../../components/ui';
import { PageHeader } from '../../components/explorer/PageHeader';
import { QueryState } from '../../components/explorer/QueryState';
import { TimeRangePicker } from '../../components/explorer/TimeRangePicker';
import { useApp } from '../../app/AppProvider';
import { useAsync } from '../../hooks/useAsync';
import { useMutation } from '../../hooks/useMutation';
import { createLimiter } from '../../lib/concurrency';
import { createUlid } from '../../lib/ids';
import { timeBounds } from '../../lib/query';
import type {
  Dashboard,
  DashboardTile as Tile,
  DashboardVariable,
  TimeRange,
} from '../../lib/types';
import { InlineError } from '../../components/ui';
import { useLeaveGuard } from '../../hooks/useLeaveGuard';
import { useDashboardAccess } from './owner';
import {
  checkDashboardConflict,
  dashboardError,
  dashboardPresets,
  duplicateDashboard,
  editDashboardMetadata,
} from './helpers';
import {
  appendLayout,
  moveTile,
  record,
  resolvedLayouts,
  text,
  tileTitle,
  tileVariableNames,
} from './tiles';
import { classicTimeRange, dashboardRange, rangeParams } from './timeRange';
import { readVariables, type VariableValues } from './variables';
import { DashboardTile } from './DashboardTile';
import { VariablesBar } from './VariablesBar';
import { ConflictDialog } from './ConflictDialog';
import { DashboardForm } from './DashboardForm';
import { downloadDashboard } from './importExport';
import './dashboards.css';
const TileEditor = lazy(() =>
  import('./TileEditor').then((module) => ({ default: module.TileEditor })),
);
const VariableEditor = lazy(() =>
  import('./VariableEditor').then((module) => ({ default: module.VariableEditor })),
);
export function DashboardView() {
  const { id = '' } = useParams(),
    { client } = useApp();
  const data = useAsync(useCallback((signal) => client.getDashboard(id, signal), [client, id]));
  return data.data ? (
    <DashboardFields key={id} original={data.data} />
  ) : (
    <div className="page dashboards-page">
      <Link to="/dashboards">Back to dashboards</Link>
      <QueryState loading={data.loading} error={data.error} retry={data.reload} />
    </div>
  );
}
function DashboardFields({ original }: { original: Dashboard }) {
  const { client } = useApp(),
    navigate = useNavigate(),
    access = useDashboardAccess(),
    mutation = useMutation();
  const [params, setParams] = useSearchParams();
  // useSearchParams callbacks do not queue like React state updates. Merge against
  // the latest URL so simultaneous variable defaults and selections keep each other.
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const updateParams = useCallback(
    (edit: (current: URLSearchParams) => URLSearchParams) => {
      const next = edit(new URLSearchParams(paramsRef.current));
      paramsRef.current = next;
      setParams(next, { replace: true });
    },
    [setParams],
  );
  const [loaded, setLoaded] = useState(original),
    [draft, setDraft] = useState(original);
  const [initialRange, setInitialRange] = useState(() =>
    dashboardRange(params, original.timeRange),
  );
  useEffect(() => {
    const current = paramsRef.current;
    if (!current.has('range') && !(current.has('start') && current.has('end')))
      updateParams((params) => rangeParams(params, initialRange));
  }, [initialRange, updateParams]);
  const [rangeDirty, setRangeDirty] = useState(false),
    [anchor, setAnchor] = useState(Date.now()),
    [revision, setRevision] = useState(0);
  const range = useMemo(
      () => dashboardRange(params, draft.timeRange, anchor),
      [params, draft.timeRange, anchor],
    ),
    rangeKey = JSON.stringify(range);
  const [editor, setEditor] = useState<{ tile?: Tile }>(),
    [variableEditor, setVariableEditor] = useState<{ variable?: DashboardVariable }>();
  const [editorDirty, setEditorDirty] = useState(false),
    [metadataOpen, setMetadataOpen] = useState(false);
  const [deletingTile, setDeletingTile] = useState<Tile>(),
    [deletingVariable, setDeletingVariable] = useState<DashboardVariable>(),
    [deleting, setDeleting] = useState(false),
    [convert, setConvert] = useState<Tile>();
  const [conflict, setConflict] = useState<Dashboard>(),
    [status, setStatus] = useState(''),
    [variablesReady, setVariablesReady] = useState<Record<string, boolean>>({});
  const writable = !!access.hash && access.hash === draft.author;
  const dirty = JSON.stringify(draft) !== JSON.stringify(loaded) || rangeDirty;
  const markSaved = useLeaveGuard(dirty || editorDirty, 'dashboard');
  const about = useAsync(useCallback((signal) => client.about(signal), [client]));
  const datasets = useAsync(useCallback((signal) => client.listDatasets(signal), [client]));
  const promqlEnabled = about.data?.capabilities.promqlDashboard === true;
  const variables = useMemo(() => readVariables(draft.variables), [draft.variables]);
  const values = useMemo<VariableValues>(
    () =>
      Object.fromEntries(
        variables.flatMap((variable) => {
          const value =
            params.get(`var-${variable.name}`) ??
            variable.defaultValue ??
            (variable.type === 'list'
              ? variable.options?.[0]
              : variable.type === 'text'
                ? ''
                : undefined);
          return value === undefined ? [] : [[variable.name, value]];
        }),
      ),
    [variables, params],
  );
  const select = useCallback(
    (name: string, value: string) =>
      updateParams((current) => {
        current.set(`var-${name}`, value);
        return current;
      }),
    [updateParams],
  );
  const bounds = useMemo(() => timeBounds(range, anchor), [rangeKey, anchor]);
  const limit = useMemo(() => createLimiter(4), [client]);
  const ordered = useMemo(() => resolvedLayouts(draft.tiles ?? []), [draft.tiles]);
  const readController = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => readController.current?.abort(), []);
  function setRange(value: TimeRange) {
    updateParams((current) => rangeParams(current, value));
    setAnchor(Date.now());
    setRangeDirty(writable);
  }
  function completed(saved: Dashboard) {
    setLoaded(saved);
    setDraft(saved);
    setRangeDirty(false);
    setInitialRange(range);
    setConflict(undefined);
    setStatus('Dashboard saved.');
    mutation.reset();
    markSaved();
  }
  function payload() {
    return {
      ...draft,
      ...(rangeDirty || draft.timeRange == null
        ? { timeRange: classicTimeRange(range, draft.timeRange) }
        : {}),
    };
  }
  function save(overwrite = false) {
    void mutation.run(async () => {
      readController.current?.abort();
      readController.current = new AbortController();
      if (!overwrite) {
        const latest = await checkDashboardConflict(client, loaded, readController.current.signal);
        if (!mutation.isActive()) return;
        if (latest) {
          setConflict(latest);
          return;
        }
      }
      const saved = await client.updateDashboard(draft.dashboardId, payload());
      if (mutation.isActive()) completed(saved);
    });
  }
  function tileAction(action: 'edit' | 'duplicate' | 'earlier' | 'later' | 'delete', tile: Tile) {
    if (action === 'edit') {
      if (tile.tileType === 'builder') setConvert(tile);
      else setEditor({ tile });
    }
    if (action === 'delete') setDeletingTile(tile);
    if (action === 'duplicate')
      setDraft((current) => ({
        ...current,
        tiles: [
          ...(current.tiles ?? []),
          {
            ...structuredClone(tile),
            tile_id: createUlid(),
            title: `${tileTitle(tile)} (Copy)`,
            layout: {
              ...record(tile.layout),
              ...appendLayout(
                current.tiles ?? [],
                resolvedLayouts([tile])[0].layout.w,
                resolvedLayouts([tile])[0].layout.h,
              ),
            },
          },
        ],
      }));
    if (action === 'earlier' || action === 'later')
      setDraft((current) => ({
        ...current,
        tiles: moveTile(current.tiles ?? [], tile.tile_id, action === 'earlier' ? -1 : 1),
      }));
  }
  function closeEditor() {
    if (editorDirty && !window.confirm('Discard changes in this editor?')) return;
    setEditor(undefined);
    setVariableEditor(undefined);
    setEditorDirty(false);
  }
  return (
    <div className="page dashboards-page">
      <nav aria-label="Dashboard breadcrumb" className="dashboard-breadcrumb">
        <Link to="/dashboards">Dashboards</Link>
        <span aria-hidden="true">/</span>
        <span>{draft.title}</span>
      </nav>
      <PageHeader
        title={draft.title}
        description={text(draft.description) || undefined}
        actions={
          <>
            {writable && (
              <>
                <Button
                  variant="primary"
                  onClick={() => save()}
                  disabled={!dirty || mutation.pending}
                >
                  {mutation.pending ? 'Saving…' : 'Save'}
                </Button>
                <Button
                  disabled={!dirty || mutation.pending}
                  onClick={() => {
                    setDraft(loaded);
                    setRangeDirty(false);
                    updateParams((current) => rangeParams(current, initialRange));
                    mutation.reset();
                    setStatus('Changes discarded.');
                  }}
                >
                  Discard
                </Button>
              </>
            )}
            <ActionsMenu
              label="Dashboard actions"
              disabled={mutation.pending}
              items={[
                ...(writable
                  ? [
                      {
                        id: 'rename',
                        label: 'Rename and tags',
                        onSelect: () => {
                          mutation.reset();
                          setMetadataOpen(true);
                        },
                      },
                    ]
                  : []),
                { id: 'export', label: 'Export JSON', onSelect: () => downloadDashboard(draft) },
                {
                  id: 'duplicate',
                  label: 'Duplicate dashboard',
                  disabled: !access.canCreate || dirty,
                  onSelect: () =>
                    void mutation.run(async () => {
                      const created = await client.createDashboard(duplicateDashboard(draft));
                      if (mutation.isActive()) {
                        markSaved();
                        navigate(`/dashboards/${created.dashboardId}`);
                      }
                    }),
                },
                ...(writable || access.isAdmin
                  ? [
                      {
                        id: 'delete',
                        label: 'Delete dashboard',
                        destructive: true,
                        onSelect: () => {
                          mutation.reset();
                          setDeleting(true);
                        },
                      },
                    ]
                  : []),
              ]}
            />
          </>
        }
      />
      <div className="dashboard-time-toolbar">
        <TimeRangePicker
          presets={dashboardPresets}
          disabled={mutation.pending}
          value={range}
          onChange={setRange}
        />
        <Button
          onClick={() => {
            setAnchor(Date.now());
            setRevision((value) => value + 1);
          }}
        >
          Refresh
        </Button>
        {writable && (
          <Badge tone={dirty ? 'warning' : 'success'}>
            {dirty ? 'Unsaved changes' : 'All changes saved'}
          </Badge>
        )}
      </div>
      {!writable && (
        <p className="notice">This dashboard is read-only. Only its owner can edit it.</p>
      )}
      <p className="dashboards-status muted" role="status">
        {status}
      </p>
      <InlineError error={!conflict ? dashboardError(mutation.error) : undefined} />
      <QueryState loading={false} error={about.error} retry={about.reload} />
      <VariablesBar
        variables={variables}
        values={values}
        params={params}
        bounds={bounds}
        writable={writable && !mutation.pending}
        promqlEnabled={promqlEnabled}
        onSelect={select}
        onReady={setVariablesReady}
        onAdd={() => setVariableEditor({})}
        onEdit={(variable) => setVariableEditor({ variable })}
        onDelete={setDeletingVariable}
      />
      {writable && (
        <div className="inline">
          <Button disabled={mutation.pending} onClick={() => setEditor({})}>
            Add tile
          </Button>
        </div>
      )}
      {!ordered.length ? (
        <EmptyState
          title="Start building your dashboard"
          description="Add SQL and PromQL tiles to visualize your telemetry."
        />
      ) : (
        <div className="dashboard-server-grid">
          {ordered.map(({ tile, layout }, index) => (
            <DashboardTile
              key={tile.tile_id}
              tile={tile}
              layout={layout}
              dashboardId={draft.dashboardId}
              variables={variables}
              values={values}
              bounds={bounds}
              anchor={anchor}
              revision={revision}
              ready={variables
                .filter((variable) => tileVariableNames(tile).has(variable.name))
                .every((variable) => variablesReady[variable.name])}
              writable={writable && !mutation.pending}
              promqlEnabled={promqlEnabled}
              promqlAlerts={about.data?.capabilities.promqlAlerts === true}
              limit={limit}
              first={index === 0}
              last={index === ordered.length - 1}
              onAction={tileAction}
            />
          ))}
        </div>
      )}
      <Suspense fallback={<Spinner />}>
        {editor && (
          <TileEditor
            limit={limit}
            original={editor.tile}
            tiles={draft.tiles ?? []}
            variables={variables}
            values={values}
            promqlEnabled={promqlEnabled}
            metadataEnabled={about.data?.capabilities.promqlMetadata === true}
            start={Date.parse(bounds.startTime) / 1000}
            end={Date.parse(bounds.endTime) / 1000}
            onDirty={setEditorDirty}
            onClose={closeEditor}
            onApply={(tile) => {
              setDraft((current) => ({
                ...current,
                tiles: editor.tile
                  ? (current.tiles ?? []).map((stored) =>
                      stored.tile_id === tile.tile_id ? tile : stored,
                    )
                  : [...(current.tiles ?? []), tile],
              }));
              setEditor(undefined);
            }}
          />
        )}
        {variableEditor && (
          <VariableEditor
            original={variableEditor.variable}
            variables={variables}
            datasets={(datasets.data ?? []).map((dataset) => dataset.name)}
            promqlEnabled={promqlEnabled}
            onDirty={setEditorDirty}
            onClose={closeEditor}
            onApply={(variable) => {
              setDraft((current) => ({
                ...current,
                variables: variableEditor.variable
                  ? (Array.isArray(current.variables) ? current.variables : []).map((stored) =>
                      record(stored).name === variableEditor.variable!.name ? variable : stored,
                    )
                  : [...(Array.isArray(current.variables) ? current.variables : []), variable],
              }));
              setVariableEditor(undefined);
            }}
          />
        )}
      </Suspense>
      {metadataOpen && (
        <DashboardForm
          original={draft}
          pending={false}
          onDirtyChange={setEditorDirty}
          onClose={() => {
            setMetadataOpen(false);
            setEditorDirty(false);
          }}
          onSubmit={(title, tags, description) => {
            setDraft((current) => editDashboardMetadata(current, title, tags, description));
            setMetadataOpen(false);
            setEditorDirty(false);
          }}
        />
      )}
      <Dialog
        open={!!convert}
        onOpenChange={(open) => {
          if (!open) setConvert(undefined);
        }}
        title="Edit builder tile as SQL?"
        description="The visual builder isn't available in /next. Applying this edit converts the tile to SQL; its stored query and chart settings are kept."
      >
        <div className="dialog-actions">
          <Button onClick={() => setConvert(undefined)}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => {
              if (convert) {
                setEditor({ tile: { ...convert, tileType: 'code' } });
                setConvert(undefined);
              }
            }}
          >
            Edit as SQL
          </Button>
        </div>
      </Dialog>
      <Dialog
        open={!!deletingTile || !!deletingVariable}
        onOpenChange={(open) => {
          if (!open) {
            setDeletingTile(undefined);
            setDeletingVariable(undefined);
          }
        }}
        title={deletingTile ? 'Delete tile?' : 'Delete variable?'}
        description={`Remove ${deletingTile ? tileTitle(deletingTile) : (deletingVariable?.label ?? 'this variable')}? Save the dashboard to persist this change.`}
      >
        <div className="dialog-actions">
          <Button
            onClick={() => {
              setDeletingTile(undefined);
              setDeletingVariable(undefined);
            }}
          >
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              if (deletingTile)
                setDraft((current) => ({
                  ...current,
                  tiles: (current.tiles ?? []).filter(
                    (tile) => tile.tile_id !== deletingTile.tile_id,
                  ),
                }));
              if (deletingVariable)
                setDraft((current) => ({
                  ...current,
                  variables: (Array.isArray(current.variables) ? current.variables : []).filter(
                    (variable) => record(variable).name !== deletingVariable.name,
                  ),
                }));
              setDeletingTile(undefined);
              setDeletingVariable(undefined);
            }}
          >
            {deletingTile ? 'Delete tile' : 'Delete variable'}
          </Button>
        </div>
      </Dialog>
      <TypedConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title="Delete dashboard"
        name={draft.title}
        action="Delete dashboard"
        pending={mutation.pending}
        error={dashboardError(mutation.error)}
        onConfirm={() =>
          void mutation.run(async () => {
            await client.deleteDashboard(draft.dashboardId);
            if (mutation.isActive()) {
              markSaved();
              navigate('/dashboards');
            }
          })
        }
      />
      <ConflictDialog
        open={!!conflict}
        pending={mutation.pending}
        error={mutation.error}
        onReload={() => {
          if (conflict) {
            setLoaded(conflict);
            setDraft(conflict);
            setInitialRange(dashboardRange(new URLSearchParams(), conflict.timeRange));
            updateParams((current) =>
              rangeParams(current, dashboardRange(new URLSearchParams(), conflict.timeRange)),
            );
            setRangeDirty(false);
            setConflict(undefined);
            mutation.reset();
            setStatus('Loaded the server copy.');
          }
        }}
        onOverwrite={() => save(true)}
      />
    </div>
  );
}
