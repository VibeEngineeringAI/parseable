import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, RefreshCw } from 'lucide-react';
import { Button, TypedConfirmDialog, InlineError } from '../../components/ui';
import { PageHeader } from '../../components/explorer/PageHeader';
import { QueryState } from '../../components/explorer/QueryState';
import { useApp } from '../../app/AppProvider';
import { useCollection } from '../../hooks/useCollection';
import { useMutation } from '../../hooks/useMutation';
import type { Dashboard, DashboardSummary } from '../../lib/types';
import { useLeaveGuard } from '../../hooks/useLeaveGuard';
import { dashboardError, duplicateDashboard, metadataPatch, patchConflicts } from './helpers';
import { patchedDocument } from './draft';
import { useDashboardAccess } from './owner';
import { DashboardsList } from './DashboardsList';
import { DashboardForm } from './DashboardForm';
import { ConflictDialog } from './ConflictDialog';
import { downloadDashboard } from './importExport';
import { ImportDialog } from './ImportDialog';
import { LocalImportNotice } from './LocalImportNotice';
import './dashboards.css';

export function DashboardsPage() {
  const { client, mode, identity } = useApp(),
    navigate = useNavigate();
  const collection = useCollection(
    useCallback((signal) => client.listDashboards(signal), [client]),
  );
  const access = useDashboardAccess(),
    mutation = useMutation();
  const controller = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => controller.current?.abort(), []);
  const [form, setForm] = useState<{
      original?: Dashboard;
      values?: Dashboard;
      recovered?: boolean;
    }>(),
    [deleting, setDeleting] = useState<DashboardSummary>();
  const [importing, setImporting] = useState(false);
  const [formDirty, setFormDirty] = useState(false);
  const [deleted, setDeleted] = useState<string>(),
    [status, setStatus] = useState('');
  const [conflict, setConflict] = useState<{ latest: Dashboard; patch: Partial<Dashboard> }>();
  const markSaved = useLeaveGuard(formDirty || !!conflict || !!form?.recovered, 'dashboard');
  function readSignal() {
    controller.current?.abort();
    controller.current = new AbortController();
    return controller.current.signal;
  }
  function completed(message: string) {
    setStatus(message);
    setForm(undefined);
    setConflict(undefined);
    collection.reload();
  }
  /** Applies a metadata patch to the latest stored copy, so newer tiles and settings survive. */
  async function save(loaded: Dashboard, patch: Partial<Dashboard>, overwrite = false) {
    const latest = await client.getDashboard(loaded.dashboardId, readSignal());
    if (!mutation.isActive()) return;
    if (!overwrite && patchConflicts(loaded, latest, patch)) {
      setForm(undefined);
      setConflict({ latest, patch });
      return;
    }
    await client.updateDashboard(latest.dashboardId, patchedDocument(latest, patch));
    if (mutation.isActive()) {
      markSaved();
      completed('Dashboard updated.');
    }
  }
  function action(
    kind: 'rename' | 'duplicate' | 'delete' | 'favourite' | 'export',
    row: DashboardSummary,
  ) {
    mutation.reset();
    if (kind === 'delete') {
      setDeleting(row);
      return;
    }
    void mutation.run(async () => {
      const original = await client.getDashboard(row.dashboardId, readSignal());
      if (!mutation.isActive()) return;
      if (kind === 'export') downloadDashboard(original);
      else if (kind === 'rename') setForm({ original });
      else if (kind === 'favourite') {
        await client.setDashboardFavorite(original.dashboardId, !original.isFavorite);
        if (mutation.isActive()) completed('Dashboard updated.');
      } else if (kind === 'duplicate') {
        const created = await client.createDashboard(
          duplicateDashboard(
            original,
            (collection.data ?? []).map((item) => item.title),
          ),
        );
        if (mutation.isActive()) navigate(`/dashboards/${created.dashboardId}`);
      }
    });
  }
  return (
    <div className="page dashboards-page">
      <PageHeader
        title="Dashboards"
        description="Visualize logs and metrics with your team."
        actions={
          <>
            <Button disabled={collection.loading || mutation.pending} onClick={collection.reload}>
              <RefreshCw size={15} aria-hidden="true" />
              Refresh
            </Button>
            {access.canCreate && (
              <Button
                disabled={mutation.pending}
                onClick={() => {
                  mutation.reset();
                  setImporting(true);
                }}
              >
                Import dashboard
              </Button>
            )}
            {access.canCreate && (
              <Button
                disabled={mutation.pending}
                variant="primary"
                onClick={() => {
                  mutation.reset();
                  setForm({});
                }}
              >
                <Plus size={16} aria-hidden="true" />
                Create dashboard
              </Button>
            )}
          </>
        }
      />
      <QueryState
        loading={collection.loading && !collection.data}
        error={collection.error}
        retry={collection.reload}
      />
      {!form && !importing && !deleting && !conflict && (
        <InlineError error={dashboardError(mutation.error)} />
      )}
      <p role="status" className="muted dashboards-status">
        {status}
      </p>
      {mode === 'live' && identity && collection.data && (
        <LocalImportNotice
          key={identity.id}
          identity={identity.id}
          titles={collection.data.map((row) => row.title)}
          onImported={collection.reload}
        />
      )}
      {collection.data && (
        <DashboardsList
          rows={collection.data}
          refreshing={collection.loading || mutation.pending}
          owner={access.hash}
          isAdmin={access.isAdmin}
          canCreate={access.canCreate}
          deleted={deleted}
          onAction={action}
        />
      )}
      {form && (
        <DashboardForm
          original={form.values ?? form.original}
          pending={mutation.pending}
          error={mutation.error}
          onDirtyChange={setFormDirty}
          onClose={() => {
            setForm(undefined);
            mutation.reset();
          }}
          onSubmit={(title, tags, description) =>
            void mutation.run(async () => {
              if (form.original)
                await save(form.original, metadataPatch(form.original, title, tags, description));
              else {
                const created = await client.createDashboard({
                  title,
                  tags,
                  description,
                  tiles: [],
                  variables: [],
                  sections: [],
                  isFavorite: false,
                });
                if (mutation.isActive()) {
                  markSaved();
                  setForm(undefined);
                  navigate(`/dashboards/${created.dashboardId}`);
                }
              }
            })
          }
        />
      )}
      {importing && (
        <ImportDialog
          pending={mutation.pending}
          error={mutation.error}
          onDirtyChange={setFormDirty}
          onClose={() => {
            setImporting(false);
            mutation.reset();
          }}
          onSubmit={(body) =>
            void mutation.run(async () => {
              const created = await client.createDashboard(body);
              if (mutation.isActive()) {
                markSaved();
                setImporting(false);
                navigate(`/dashboards/${created.dashboardId}`);
              }
            })
          }
        />
      )}
      <TypedConfirmDialog
        open={!!deleting}
        onOpenChange={(open) => {
          if (!open) {
            setDeleting(undefined);
            mutation.reset();
          }
        }}
        title="Delete dashboard"
        name={deleting?.title ?? ''}
        action="Delete dashboard"
        pending={mutation.pending}
        error={dashboardError(mutation.error)}
        onConfirm={() =>
          void mutation.run(async () => {
            if (!deleting) return;
            await client.deleteDashboard(deleting.dashboardId);
            if (mutation.isActive()) {
              setDeleted(deleting.dashboardId);
              setDeleting(undefined);
              completed('Dashboard deleted.');
            }
          })
        }
      />
      <ConflictDialog
        open={!!conflict}
        pending={mutation.pending}
        error={mutation.error}
        onReload={() => {
          setConflict(undefined);
          mutation.reset();
          collection.reload();
        }}
        onCancel={() => {
          if (conflict)
            setForm({
              original: conflict.latest,
              values: { ...conflict.latest, ...conflict.patch },
              recovered: true,
            });
          setConflict(undefined);
        }}
        onOverwrite={() =>
          void mutation.run(async () => {
            if (conflict) await save(conflict.latest, conflict.patch, true);
          })
        }
      />
    </div>
  );
}
