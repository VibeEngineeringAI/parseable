import { useState } from 'react';
import { Button, Dialog, Input, InlineError } from '../../components/ui';
import { utcMuteDate } from './helpers';
import { useMutation } from '../../hooks/useMutation';

export function MuteMenu({
  onClose,
  onMute,
}: {
  onClose: () => void;
  onMute: (state: string) => Promise<void>;
}) {
  const [until, setUntil] = useState('');
  const mutation = useMutation();
  const parsed = utcMuteDate(until);
  function mute(state: string) {
    void mutation.run(async () => {
      await onMute(state);
      if (mutation.isActive()) onClose();
    });
  }
  return (
    <Dialog
      open
      title="Mute notifications"
      description="The alert continues to evaluate while notifications are muted."
      dismissible={!mutation.pending}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <div className="stack">
        <div className="alerts-actions">
          {[
            ['5m', '5 minutes'],
            ['1h', '1 hour'],
            ['1d', '1 day'],
            ['1w', '1 week'],
            ['indefinite', 'Indefinitely'],
          ].map(([state, label]) => (
            <Button key={state} disabled={mutation.pending} onClick={() => mute(state)}>
              {label}
            </Button>
          ))}
        </div>
        <Input
          label="Mute until (UTC)"
          type="datetime-local"
          step={1}
          value={until}
          hint="Choose a future date and time in UTC."
          error={until ? parsed.error : undefined}
          disabled={mutation.pending}
          onChange={(event) => setUntil(event.target.value)}
        />
        <InlineError error={mutation.error} />
        <div className="dialog-actions">
          <Button disabled={mutation.pending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={mutation.pending || !parsed.state}
            onClick={() => mute(parsed.state!)}
          >
            Mute until date
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
