import { useEffect, useState, type ReactNode } from 'react';
import { Button } from './Button';
import { Dialog } from './Dialog';
import { Input } from './Input';

export function TypedConfirmDialog({
  open,
  onOpenChange,
  title,
  name,
  action,
  onConfirm,
  pending,
  error,
  children,
  complete,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  name: string;
  action: string;
  onConfirm: () => void;
  pending?: boolean;
  error?: string;
  children?: ReactNode;
  complete?: boolean;
}) {
  const [typed, setTyped] = useState('');
  useEffect(() => {
    setTyped('');
  }, [open, name]);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      dismissible={!pending}
      title={title}
      description={complete ? undefined : `Type ${name} to confirm.`}
    >
      <div className="stack">
        {children}
        {!complete && (
          <Input
            label="Confirmation name"
            value={typed}
            autoComplete="off"
            onChange={(event) => setTyped(event.target.value)}
            disabled={pending}
          />
        )}
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <div className="inline">
          <Button onClick={() => onOpenChange(false)} disabled={pending}>
            {complete ? 'Done' : 'Cancel'}
          </Button>
          {!complete && (
            <Button
              variant="danger"
              data-dialog-confirm
              disabled={pending || typed !== name}
              onClick={onConfirm}
            >
              {pending ? 'Working…' : action}
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
