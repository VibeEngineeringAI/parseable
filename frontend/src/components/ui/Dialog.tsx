import { type ReactNode, useRef } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { Button } from './Button';
import { cx } from './utils';

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
  dismissible?: boolean;
}

/** Shared modal anatomy; feature forms own submit and cancel actions. */
export function ModalFrame({
  open,
  onOpenChange,
  title,
  description,
  children,
  className,
  dismissible = true,
  side,
}: DialogProps & { side?: 'right' }) {
  const returnFocus = useRef<HTMLElement | null>(null);
  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen || dismissible) onOpenChange(nextOpen);
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="ui-dialog-overlay" />
        <DialogPrimitive.Content
          className={cx(side ? 'ui-sheet' : 'ui-dialog', className)}
          data-side={side}
          {...(!description ? { 'aria-describedby': undefined } : {})}
          onEscapeKeyDown={(event) => {
            if (!dismissible) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (!dismissible) event.preventDefault();
          }}
          onOpenAutoFocus={() => {
            returnFocus.current =
              document.activeElement instanceof HTMLElement ? document.activeElement : null;
          }}
          onCloseAutoFocus={(event) => {
            if (returnFocus.current?.isConnected) {
              event.preventDefault();
              returnFocus.current.focus({ preventScroll: true });
            }
          }}
        >
          <header className="ui-dialog-header">
            <div>
              <DialogPrimitive.Title className="ui-dialog-title">{title}</DialogPrimitive.Title>
              {description && (
                <DialogPrimitive.Description className="ui-dialog-description">
                  {description}
                </DialogPrimitive.Description>
              )}
            </div>
            <DialogPrimitive.Close asChild>
              <Button
                size="icon"
                variant="ghost"
                aria-label="Close dialog"
                data-dialog-close
                disabled={!dismissible}
              >
                <X size={18} aria-hidden="true" />
              </Button>
            </DialogPrimitive.Close>
          </header>
          <div className="ui-dialog-body">{children}</div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export function Dialog(props: DialogProps) {
  return <ModalFrame {...props} />;
}
