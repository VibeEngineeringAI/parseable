import { lazy, Suspense, useCallback, useState } from 'react';
import { Button, Dialog, InlineError, Spinner, TypedConfirmDialog } from '../../components/ui';
import { useApp } from '../../app/AppProvider';
import { useAsync } from '../../hooks/useAsync';
import type { DashboardTile, DashboardVariable } from '../../lib/types';
import type { QueryLimiter } from '../../lib/concurrency';
import { applyTile, applyVariable, removeTile, removeVariable, variableNames } from './draft';
import { DashboardForm } from './DashboardForm';
import { ConflictDialog } from './ConflictDialog';
import { dashboardError, editDashboardMetadata } from './helpers';
import { convertBuilder } from './tileEditing';
import { tileTitle } from './tiles';
import type { useDashboardDraft } from './useDashboardDraft';
import type { useDashboardUrl } from './useDashboardUrl';

const TileEditor = lazy(() =>
  import('./TileEditor').then((module) => ({ default: module.TileEditor })),
);
const VariableEditor = lazy(() =>
  import('./VariableEditor').then((module) => ({ default: module.VariableEditor })),
);
export type DashboardDialog =
  | { kind: 'tile'; tile?: DashboardTile }
  | { kind: 'variable'; variable?: DashboardVariable }
  | { kind: 'convert'; tile: DashboardTile }
  | { kind: 'remove'; tile?: DashboardTile; variable?: DashboardVariable }
  | { kind: 'metadata' }
  | { kind: 'dashboard-delete' };

export function DashboardDialogs({
  dialog,
  setDialog,
  workspace,
  url,
  limit,
  promqlEnabled,
  metadataEnabled,
  onTileDeleted,
  onVariableDeleted,
  onDashboardDeleted,
}: {
  dialog?: DashboardDialog;
  setDialog: (dialog?: DashboardDialog) => void;
  workspace: ReturnType<typeof useDashboardDraft>;
  url: ReturnType<typeof useDashboardUrl>;
  limit: QueryLimiter;
  promqlEnabled?: boolean;
  metadataEnabled: boolean;
  onTileDeleted: (id: string) => void;
  onVariableDeleted: (name: string) => void;
  onDashboardDeleted: () => void;
}) {
  const { client } = useApp(),
    { draft, mutation } = workspace;
  const datasets = useAsync(useCallback((signal) => client.listDatasets(signal), [client]));
  const [conversionError, setConversionError] = useState<string>();
  function closeEditor() {
    if (workspace.editorDirty && !window.confirm('Discard changes in this editor?')) return;
    setDialog(undefined);
    workspace.setEditorDirty(false);
  }
  return (
    <>
      <Suspense fallback={<Spinner />}>
        {dialog?.kind === 'tile' && (
          <TileEditor
            original={dialog.tile}
            tiles={draft.tiles ?? []}
            variables={url.variables}
            values={url.values}
            limit={limit}
            promqlEnabled={promqlEnabled}
            metadataEnabled={metadataEnabled}
            start={Date.parse(url.bounds.startTime) / 1000}
            end={Date.parse(url.bounds.endTime) / 1000}
            onDirty={workspace.setEditorDirty}
            onClose={closeEditor}
            onApply={(tile) => {
              workspace.changeDraft(
                (current) => applyTile(current, tile),
                'Tile applied. Save to keep this change.',
              );
              setDialog(undefined);
            }}
          />
        )}
        {dialog?.kind === 'variable' && (
          <VariableEditor
            original={dialog.variable}
            variables={url.variables}
            names={variableNames(draft)}
            datasets={(datasets.data ?? []).map((dataset) => dataset.name)}
            promqlEnabled={promqlEnabled}
            onDirty={workspace.setEditorDirty}
            onClose={closeEditor}
            onApply={(variable) => {
              workspace.changeDraft(
                (current) => applyVariable(current, variable, dialog.variable),
                'Variable applied. Save to keep this change.',
              );
              setDialog(undefined);
            }}
          />
        )}
      </Suspense>
      {dialog?.kind === 'metadata' && (
        <DashboardForm
          original={draft}
          pending={false}
          draftOnly
          onDirtyChange={workspace.setEditorDirty}
          onClose={closeEditor}
          onSubmit={(title, tags, description) => {
            workspace.changeDraft(
              (current) => editDashboardMetadata(current, title, tags, description),
              'Dashboard details applied. Save to keep this change.',
            );
            workspace.setEditorDirty(false);
            setDialog(undefined);
          }}
        />
      )}
      <Dialog
        open={dialog?.kind === 'convert'}
        onOpenChange={(open) => {
          if (!open) {
            setDialog(undefined);
            setConversionError(undefined);
          }
        }}
        title="Edit builder tile as SQL?"
        description="The visual builder isn't available in /next. Applying this edit converts the tile to SQL; its query and chart settings are kept."
      >
        <div className="stack">
          <InlineError error={conversionError} />
          <div className="dialog-actions">
            <Button
              autoFocus
              onClick={() => {
                setDialog(undefined);
                setConversionError(undefined);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                if (dialog?.kind !== 'convert') return;
                try {
                  setDialog({ kind: 'tile', tile: convertBuilder(dialog.tile) });
                  setConversionError(undefined);
                } catch (error) {
                  setConversionError(error instanceof Error ? error.message : String(error));
                }
              }}
            >
              Edit as SQL
            </Button>
          </div>
        </div>
      </Dialog>
      <Dialog
        open={dialog?.kind === 'remove'}
        onOpenChange={(open) => {
          if (!open) setDialog(undefined);
        }}
        title={dialog?.kind === 'remove' && dialog.tile ? 'Delete tile?' : 'Delete variable?'}
        description={`Remove ${dialog?.kind === 'remove' ? (dialog.tile ? tileTitle(dialog.tile) : dialog.variable?.label) : ''}? Save the dashboard to persist this change.`}
      >
        <div className="dialog-actions">
          <Button autoFocus onClick={() => setDialog(undefined)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              if (dialog?.kind !== 'remove') return;
              if (dialog.tile) {
                onTileDeleted(dialog.tile.tile_id);
                workspace.changeDraft(
                  (current) => removeTile(current, dialog.tile!),
                  'Tile deleted. Save to keep this change.',
                );
              }
              if (dialog.variable) {
                onVariableDeleted(dialog.variable.name);
                workspace.changeDraft(
                  (current) => removeVariable(current, dialog.variable!),
                  'Variable deleted. Save to keep this change.',
                );
              }
              setDialog(undefined);
            }}
          >
            {dialog?.kind === 'remove' && dialog.tile ? 'Delete tile' : 'Delete variable'}
          </Button>
        </div>
      </Dialog>
      <TypedConfirmDialog
        open={dialog?.kind === 'dashboard-delete'}
        onOpenChange={(open) => {
          if (!open) setDialog(undefined);
        }}
        title="Delete dashboard"
        name={draft.title}
        action="Delete dashboard"
        pending={mutation.pending}
        error={dashboardError(mutation.error)}
        onConfirm={() =>
          void mutation.run(async () => {
            await client.deleteDashboard(draft.dashboardId);
            if (mutation.isActive()) {
              workspace.markSaved();
              onDashboardDeleted();
            }
          })
        }
      />
      <ConflictDialog
        open={!!workspace.conflict}
        pending={mutation.pending}
        error={mutation.error}
        onCancel={() => workspace.setConflict(undefined)}
        onOverwrite={() => workspace.save(url.range, true)}
        onReload={() => {
          url.setRange(workspace.storedRange());
          workspace.reload();
        }}
      />
    </>
  );
}
