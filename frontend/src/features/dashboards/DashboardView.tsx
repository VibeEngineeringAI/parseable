import { useCallback, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ActionsMenu, Badge, Button, InlineError } from '../../components/ui';
import { PageHeader } from '../../components/explorer/PageHeader';
import { QueryState } from '../../components/explorer/QueryState';
import { TimeRangePicker } from '../../components/explorer/TimeRangePicker';
import { useApp } from '../../app/AppProvider';
import { useAsync } from '../../hooks/useAsync';
import { useRowDeletionFocus } from '../../hooks/useRowDeletionFocus';
import { createLimiter } from '../../lib/concurrency';
import type { Dashboard, DashboardTile as Tile } from '../../lib/types';
import { useDashboardAccess } from './owner';
import { dashboardError, dashboardPresets, duplicateDashboard } from './helpers';
import { moveTile, text, tileType } from './tiles';
import { duplicateTile } from './draft';
import { DashboardSections } from './DashboardSections';
import { VariablesBar } from './VariablesBar';
import type { VariableResolutions } from './VariableControl';
import { DashboardDialogs, type DashboardDialog } from './DashboardDialogs';
import { useDashboardDraft } from './useDashboardDraft';
import { useDashboardUrl } from './useDashboardUrl';
import { downloadDashboard } from './importExport';
import './dashboards.css';

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
    access = useDashboardAccess();
  const page = useRef<HTMLDivElement>(null);
  const focusHeading = useCallback(
    () =>
      requestAnimationFrame(() => {
        const heading = page.current?.querySelector('h1');
        if (heading) {
          heading.tabIndex = -1;
          heading.focus();
        }
      }),
    [],
  );
  const workspace = useDashboardDraft(original, focusHeading),
    { draft, dirty, mutation } = workspace;
  const url = useDashboardUrl(draft);
  const [dialog, setDialog] = useState<DashboardDialog>();
  const [resolutions, setResolutions] = useState<VariableResolutions>({});
  const about = useAsync(useCallback((signal) => client.about(signal), [client]));
  const promqlEnabled = about.data ? about.data.capabilities.promqlDashboard === true : undefined;
  const writable = !!access.hash && access.hash === draft.author;
  const editing = writable && !mutation.pending;
  const limit = useMemo(() => createLimiter(4), [client]);
  const tileFocus = useRowDeletionFocus(
    (draft.tiles ?? []).map((tile) => tile.tile_id),
    false,
  );
  const variableFocus = useRowDeletionFocus(
    url.variables.map((variable) => variable.name),
    false,
  );
  function tileAction(action: 'edit' | 'duplicate' | 'earlier' | 'later' | 'delete', tile: Tile) {
    if (action === 'edit')
      setDialog({ kind: tileType(tile) === 'builder' ? 'convert' : 'tile', tile });
    if (action === 'delete') setDialog({ kind: 'remove', tile });
    if (action === 'duplicate')
      workspace.changeDraft(
        (current) => duplicateTile(current, tile),
        'Tile duplicated. Save to keep this change.',
      );
    if (action === 'earlier' || action === 'later')
      workspace.changeDraft(
        (current) => ({
          ...current,
          tiles: moveTile(
            current.tiles ?? [],
            tile.tile_id,
            action === 'earlier' ? -1 : 1,
            current.sections,
          ),
        }),
        `Tile moved ${action}. Save to keep this change.`,
      );
  }
  return (
    <div ref={page} className="page dashboards-page">
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
                  onClick={() => workspace.save(url.range)}
                  disabled={!dirty || mutation.pending}
                >
                  {mutation.pending ? 'Saving…' : 'Save'}
                </Button>
                <Button
                  disabled={!dirty || mutation.pending}
                  onClick={() => {
                    url.setRange(workspace.storedRange());
                    workspace.discard();
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
                          setDialog({ kind: 'metadata' });
                        },
                      },
                    ]
                  : []),
                { id: 'export', label: 'Export JSON', onSelect: () => downloadDashboard(draft) },
                {
                  id: 'duplicate',
                  label: 'Duplicate dashboard',
                  disabled: !access.canCreate || dirty,
                  description: dirty
                    ? 'Save or discard your changes before duplicating this dashboard.'
                    : !access.canCreate
                      ? 'You do not have permission to create dashboards.'
                      : undefined,
                  onSelect: () =>
                    void mutation.run(async () => {
                      const created = await client.createDashboard(duplicateDashboard(draft));
                      if (mutation.isActive()) {
                        workspace.markSaved();
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
                          setDialog({ kind: 'dashboard-delete' });
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
          value={url.range}
          onChange={(value) => {
            url.setRange(value);
            workspace.setRangeDirty(writable);
          }}
        />
        <Button
          onClick={() => {
            url.refresh();
            workspace.announce(
              `Refreshing ${(draft.tiles ?? []).length} ${(draft.tiles ?? []).length === 1 ? 'tile' : 'tiles'}.`,
            );
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
      {!access.loading && !writable && (
        <p className="notice">
          This dashboard is read-only. Only its owner can edit it.
          {access.canCreate ? ' Duplicate it to make an editable copy.' : ''}
        </p>
      )}
      {!!workspace.repaired && (
        <p className="notice">
          This dashboard has duplicate or nil tile IDs. Saving will assign new IDs to{' '}
          {workspace.repaired} {workspace.repaired === 1 ? 'tile' : 'tiles'}.
        </p>
      )}
      <p className="dashboards-status muted" role="status" aria-live="polite">
        {workspace.status}
      </p>
      <InlineError error={!workspace.conflict ? dashboardError(mutation.error) : undefined} />
      {about.error && (
        <div>
          <InlineError error={`Could not load server capabilities: ${about.error.message}`} />
          <Button onClick={about.reload}>Retry capabilities</Button>
        </div>
      )}
      <div ref={variableFocus.root}>
        <VariablesBar
          variables={url.variables}
          values={url.values}
          params={url.params}
          bounds={url.bounds}
          writable={editing}
          promqlEnabled={promqlEnabled}
          resolutions={resolutions}
          onSelect={url.select}
          onResolve={setResolutions}
          onEdit={(variable) => setDialog({ kind: 'variable', variable })}
          onDelete={(variable) => setDialog({ kind: 'remove', variable })}
        />
        {writable && (
          <div className="dashboard-add-actions">
            <Button
              data-list-search
              disabled={mutation.pending}
              onClick={() => setDialog({ kind: 'variable' })}
            >
              Add variable
            </Button>
            <Button disabled={mutation.pending} onClick={() => setDialog({ kind: 'tile' })}>
              Add tile
            </Button>
          </div>
        )}
      </div>
      <div ref={tileFocus.root} className="dashboard-sections">
        <DashboardSections
          dashboard={draft}
          url={url}
          writable={editing}
          promqlEnabled={promqlEnabled}
          promqlAlerts={about.data?.capabilities.promqlAlerts === true}
          resolutions={resolutions}
          limit={limit}
          onAction={tileAction}
        />
      </div>
      <DashboardDialogs
        dialog={dialog}
        setDialog={setDialog}
        workspace={workspace}
        url={url}
        limit={limit}
        promqlEnabled={promqlEnabled}
        metadataEnabled={about.data?.capabilities.promqlMetadata === true}
        onTileDeleted={(id) => {
          tileFocus.onDeleted(id);
          if (draft.tiles?.length === 1)
            requestAnimationFrame(() =>
              page.current
                ?.querySelector<HTMLButtonElement>('.dashboard-add-actions button:last-child')
                ?.focus(),
            );
        }}
        onVariableDeleted={variableFocus.onDeleted}
        onDashboardDeleted={() => navigate('/dashboards')}
      />
    </div>
  );
}
