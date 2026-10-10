import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { MoreHorizontal } from 'lucide-react';
import { Button, type ButtonProps } from './Button';

export type ActionsMenuItem = {
  id: string;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  destructive?: boolean;
  description?: string;
};

/** A menu button with roving focus. The portal keeps menus out of scrolling table clips. */
export function ActionsMenu({
  label,
  items,
  ...props
}: Omit<ButtonProps, 'children' | 'onClick' | 'aria-label'> & {
  label: string;
  items: ActionsMenuItem[];
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const first = useRef<'first' | 'last'>('first');
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });

  function close(restore = true) {
    // Restore before dispatching an action so a dialog captures this surviving opener.
    if (restore) trigger.current?.focus({ preventScroll: true });
    setOpen(false);
  }
  function enabledItems() {
    return Array.from(
      menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [],
    );
  }
  useLayoutEffect(() => {
    if (!open) return;
    function place() {
      if (!trigger.current || !menu.current) return;
      const anchor = trigger.current.getBoundingClientRect();
      const box = menu.current.getBoundingClientRect();
      setPosition({
        left: Math.max(8, Math.min(anchor.right - box.width, innerWidth - box.width - 8)),
        top:
          anchor.bottom + box.height + 8 <= innerHeight
            ? anchor.bottom + 4
            : Math.max(8, anchor.top - box.height - 4),
      });
    }
    place();
    const buttons = enabledItems();
    (first.current === 'last' ? buttons.at(-1) : buttons[0])?.focus();
    if (!buttons.length) menu.current?.focus();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    function outside(event: PointerEvent) {
      if (
        event.target instanceof Node &&
        !menu.current?.contains(event.target) &&
        !trigger.current?.contains(event.target)
      )
        close(false);
    }
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape' || event.key === 'Tab') {
      if (event.key === 'Escape') event.preventDefault();
      close();
      return;
    }
    const buttons = enabledItems();
    if (!buttons.length) return;
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === 'ArrowDown'
        ? (index + 1) % buttons.length
        : event.key === 'ArrowUp'
          ? (index - 1 + buttons.length) % buttons.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? buttons.length - 1
              : undefined;
    if (next !== undefined) {
      event.preventDefault();
      buttons[next].focus();
    }
  }
  return (
    <>
      <Button
        {...props}
        ref={trigger}
        id={`${id}-trigger`}
        size={props.size ?? 'sm'}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? `${id}-menu` : undefined}
        onClick={() => {
          if (open) close();
          else {
            first.current = 'first';
            setOpen(true);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            first.current = event.key === 'ArrowUp' ? 'last' : 'first';
            setOpen(true);
          }
          props.onKeyDown?.(event);
        }}
      >
        <MoreHorizontal size={16} aria-hidden="true" />
      </Button>
      {open &&
        createPortal(
          <div
            ref={menu}
            id={`${id}-menu`}
            role="menu"
            aria-labelledby={`${id}-trigger`}
            tabIndex={-1}
            className="ui-actions-menu"
            style={position}
            onKeyDown={navigate}
            onBlur={(event) => {
              if (
                event.relatedTarget &&
                !event.currentTarget.contains(event.relatedTarget) &&
                !trigger.current?.contains(event.relatedTarget)
              )
                close(false);
            }}
          >
            {items.map((item) => (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                tabIndex={-1}
                disabled={item.disabled && !item.description}
                aria-disabled={item.disabled && item.description ? true : undefined}
                aria-label={item.label}
                title={item.description}
                aria-describedby={item.description ? `${id}-${item.id}-reason` : undefined}
                data-destructive={item.destructive || undefined}
                onClick={() => {
                  if (item.disabled) return;
                  close();
                  item.onSelect();
                }}
              >
                <span>{item.label}</span>
                {item.description && (
                  <span className="ui-actions-reason" id={`${id}-${item.id}-reason`}>
                    {item.description}
                  </span>
                )}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
