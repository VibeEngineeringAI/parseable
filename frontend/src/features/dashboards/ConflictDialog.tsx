import { Button, Dialog } from '../../components/ui';
import { InlineError } from '../../components/ui';
import { dashboardError } from './helpers';
export function ConflictDialog({
  open,
  pending,
  error,
  onReload,
  onOverwrite,
}: {
  open: boolean;
  pending: boolean;
  error?: string;
  onReload: () => void;
  onOverwrite: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={() => {}}
      dismissible={false}
      title="Dashboard changed on the server"
      description="Someone saved this dashboard after you loaded it. Reload discards your changes. Overwrite saves your copy."
    >
      <div className="stack">
        <InlineError error={dashboardError(error)} />
        <div className="dialog-actions">
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
