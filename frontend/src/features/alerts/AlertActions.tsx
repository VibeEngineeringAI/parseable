import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, TypedConfirmDialog } from '../../components/ui';
import { useApp } from '../../app/AppProvider';
import type { AlertSummary } from '../../lib/types';
import { muteState } from './helpers';
import { InlineError, useMutation } from './shared';
import { MuteMenu } from './MuteMenu';

export function AlertActions({
  alert,
  canWrite,
  detail = false,
  onChanged,
  onDeleted,
}: {
  alert: AlertSummary;
  canWrite: boolean;
  detail?: boolean;
  onChanged: () => void;
  onDeleted?: () => void;
}) {
  const { client } = useApp();
  const navigate = useNavigate();
  const [muting, setMuting] = useState(false),
    [removing, setRemoving] = useState(false),
    [status, setStatus] = useState('');
  const mutation = useMutation();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const muted = muteState(alert.notificationState).muted;
  const label = (action: string) => (detail ? action : `${action} ${alert.title}`);
  function run(operation: () => Promise<unknown>, message: string, evaluate = false) {
    void mutation.run(async () => {
      await operation();
      if (!mutation.isActive()) return;
      setStatus(message);
      onChanged();
      if (evaluate) {
        clearTimeout(timer.current);
        timer.current = setTimeout(onChanged, 2000);
      }
    });
  }
  if (!canWrite) return <span className="muted">Read-only</span>;
  return (
    <div className="stack alerts-action-block">
      <div className="alerts-actions">
        {detail && alert.queryType !== 'builder' && (
          <Button
            size="sm"
            disabled={mutation.pending}
            onClick={() => navigate(`/alerts/${encodeURIComponent(alert.id)}/edit`)}
          >
            Edit
          </Button>
        )}
        <Button
          size="sm"
          disabled={mutation.pending || alert.state === 'disabled'}
          aria-label={label('Evaluate now')}
          onClick={() =>
            run(
              () => client.evaluateAlert(alert.id),
              'Evaluation requested. Results refresh shortly.',
              true,
            )
          }
        >
          Evaluate now
        </Button>
        <Button
          size="sm"
          disabled={mutation.pending}
          aria-label={label(alert.state === 'disabled' ? 'Enable' : 'Disable')}
          onClick={() =>
            run(
              () =>
                alert.state === 'disabled'
                  ? client.enableAlert(alert.id)
                  : client.disableAlert(alert.id),
              alert.state === 'disabled' ? 'Alert enabled.' : 'Alert disabled.',
            )
          }
        >
          {alert.state === 'disabled' ? 'Enable' : 'Disable'}
        </Button>
        <Button
          size="sm"
          disabled={mutation.pending}
          aria-label={label(muted ? 'Unmute' : 'Mute')}
          onClick={() =>
            muted
              ? run(() => client.muteAlert(alert.id, 'notify'), 'Notifications unmuted.')
              : setMuting(true)
          }
        >
          {muted ? 'Unmute' : 'Mute'}
        </Button>
        {detail && (
          <Button
            size="sm"
            disabled={mutation.pending}
            onClick={() => {
              void mutation.run(async () => {
                const source = await client.getAlert(alert.id);
                if (mutation.isActive()) navigate('/alerts/new', { state: { duplicate: source } });
              });
            }}
          >
            Duplicate
          </Button>
        )}
        <Button
          size="sm"
          variant="danger"
          disabled={mutation.pending}
          aria-label={label('Delete')}
          onClick={() => {
            mutation.reset();
            setRemoving(true);
          }}
        >
          Delete
        </Button>
      </div>
      {!removing && <InlineError error={mutation.error} />}
      {status && (
        <p role="status" className="muted">
          {status}
        </p>
      )}
      {muting && (
        <MuteMenu
          onClose={() => setMuting(false)}
          onMute={async (state) => {
            await client.muteAlert(alert.id, state);
            if (mutation.isActive()) {
              setStatus('Notifications muted.');
              onChanged();
            }
          }}
        />
      )}
      {removing && (
        <TypedConfirmDialog
          open
          title="Delete alert"
          name={alert.title}
          action="Delete alert"
          pending={mutation.pending}
          error={mutation.error}
          onOpenChange={(open) => {
            if (!open) setRemoving(false);
          }}
          onConfirm={() => {
            void mutation.run(async () => {
              await client.deleteAlert(alert.id);
              if (mutation.isActive()) {
                setRemoving(false);
                onDeleted?.();
                onChanged();
              }
            });
          }}
        />
      )}
    </div>
  );
}
