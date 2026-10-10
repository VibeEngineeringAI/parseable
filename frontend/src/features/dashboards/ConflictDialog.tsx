import { Button, Dialog, InlineError } from '../../components/ui';
import { dashboardError } from './helpers';
export function ConflictDialog({
  open,
  pending,
  error,
  onReload,
  onOverwrite,
  onCancel,
}: {
  open: boolean;
  pending: boolean;
  error?: string;
  onReload: () => void;
  onOverwrite: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(open) => {
        if (!open && !pending) onCancel();
      }}
      dismissible={!pending}
      title="Dashboard changed on the server"
      description="Someone saved this dashboard after you loaded it. Reload discards your changes. Overwrite saves your copy."
    >
      <div className="stack">
        <InlineError error={dashboardError(error)} />
        <div className="dialog-actions">
          <Button autoFocus onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={onReload} disabled={pending}>
            Reload
          </Button>
          <Button variant="primary" onClick={onOverwrite} disabled={pending}>
            {pending ? 'Saving…' : 'Overwrite'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
