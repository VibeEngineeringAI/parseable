import { Button } from '../../components/ui';

export interface RunControlsProps {
  /** `run` for a saved question that has never run, `cancel` while a run is active. */
  action: 'run' | 'cancel' | null;
  retry?: boolean;
  /** Why the action cannot be taken now, or null. Shown instead of a simulated run. */
  blocked: string | null;
  pending: boolean;
  error: string | null;
  /** A problem following the live result, reported separately from the run itself. */
  streamNote: string | null;
  onRun: () => void;
  onCancel: () => void;
}

/** Explicit run and cancel actions. Nothing here runs a question implicitly. */
export function RunControls({
  action,
  retry = false,
  blocked,
  pending,
  error,
  streamNote,
  onRun,
  onCancel,
}: RunControlsProps) {
  if (!action && !error && !streamNote) return null;
  return (
    <div className="ks-run" role="group" aria-label="Run" data-testid="ks-run-controls">
      {action === 'run' ? (
        <Button
          variant="primary"
          disabled={blocked !== null || pending}
          aria-describedby={blocked ? 'ks-run-blocked' : undefined}
          onClick={onRun}
          data-testid="ks-run"
        >
          {pending ? 'Starting run' : retry ? 'Retry question' : 'Run question'}
        </Button>
      ) : action === 'cancel' ? (
        <Button
          disabled={blocked !== null || pending}
          aria-describedby={blocked ? 'ks-run-blocked' : undefined}
          onClick={onCancel}
          data-testid="ks-cancel-run"
        >
          {pending ? 'Cancelling' : 'Cancel run'}
        </Button>
      ) : null}
      {action && blocked ? (
        <p id="ks-run-blocked" className="ks-muted" data-testid="ks-run-blocked">
          {blocked}
        </p>
      ) : null}
      {error ? (
        <p className="ks-note" data-tone="danger" role="alert" data-testid="ks-run-error">
          {error}
        </p>
      ) : null}
      {streamNote ? (
        <p className="ks-note" data-tone="warning" data-testid="ks-stream-note">
          {streamNote}
        </p>
      ) : null}
    </div>
  );
}
