import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ActionsMenu, Button, TypedConfirmDialog, type ActionsMenuItem } from '../../components/ui';
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
  onStatus,
}: {
  alert: AlertSummary;
  canWrite: boolean;
  detail?: boolean;
  onChanged: () => void;
  onDeleted?: () => void;
  onStatus?: (message: string) => void;
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
  function announce(message: string) {
    if (detail) setStatus(message);
    else onStatus?.(message);
  }
  function run(operation: () => Promise<unknown>, message: string, evaluate = false) {
    void mutation.run(async () => {
      await operation();
      if (!mutation.isActive()) return;
      announce(message);
      onChanged();
      if (evaluate) {
        clearTimeout(timer.current);
        timer.current = setTimeout(onChanged, 2000);
      }
    });
  }
  if (!canWrite) return <span className="muted">Read-only</span>;
  const items: ActionsMenuItem[] = [
    {
      label: 'Evaluate now',
      disabled: mutation.pending || alert.state === 'disabled',
      onSelect: () =>
        run(
          () => client.evaluateAlert(alert.id),
          'Evaluation requested. Results refresh shortly.',
          true,
        ),
    },
    {
      label: alert.state === 'disabled' ? 'Enable' : 'Disable',
      disabled: mutation.pending,
      onSelect: () =>
        run(
          () =>
            alert.state === 'disabled'
              ? client.enableAlert(alert.id)
              : client.disableAlert(alert.id),
          alert.state === 'disabled' ? 'Alert enabled.' : 'Alert disabled.',
        ),
    },
    {
      label: muted ? 'Unmute' : 'Mute…',
      disabled: mutation.pending,
      onSelect: () =>
        muted
          ? run(() => client.muteAlert(alert.id, 'notify'), 'Notifications unmuted.')
          : setMuting(true),
    },
    {
      label: 'Delete',
      destructive: true,
      disabled: mutation.pending,
      onSelect: () => {
        mutation.reset();
        setRemoving(true);
      },
    },
  ];
  return (
    <div className="alerts-action-block">
      {detail ? (
        <div className="alerts-actions">
          {alert.queryType !== 'builder' && (
            <Button
              size="sm"
              disabled={mutation.pending}
              onClick={() => navigate(`/alerts/${encodeURIComponent(alert.id)}/edit`)}
            >
              Edit
            </Button>
          )}
          {items.slice(0, 3).map((item) => (
            <Button key={item.label} size="sm" disabled={item.disabled} onClick={item.onSelect}>
              {item.label === 'Mute…' ? 'Mute' : item.label}
            </Button>
          ))}
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
          <Button
            size="sm"
            variant="danger"
            disabled={mutation.pending}
            onClick={items[3].onSelect}
          >
            Delete
          </Button>
        </div>
      ) : (
        <ActionsMenu
          label={`Actions for ${alert.title}`}
          items={items}
          data-row-action={alert.id}
        />
      )}
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
              announce('Notifications muted.');
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
