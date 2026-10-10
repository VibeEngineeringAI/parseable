import { useCallback, useEffect, useRef, useState } from 'react';
import { useBlocker } from 'react-router-dom';
import { useApp } from '../../app/AppProvider';
import { useAsync } from '../../hooks/useAsync';
import { displayDate, formatAlertDate } from './helpers';

export function InlineError({ error }: { error?: string }) {
  return error ? (
    <p role="alert" className="error-text">
      {error}
    </p>
  ) : null;
}
export function DateText({ value }: { value?: string | null }) {
  const iso = displayDate(value);
  return iso ? (
    <time dateTime={iso}>{formatAlertDate(iso)}</time>
  ) : (
    <span className="muted">Never</span>
  );
}

/** Restore the position in a refreshed list only after the deleted row is gone. */
export function useRowDeletionFocus(ids: string[], refreshing: boolean) {
  const root = useRef<HTMLDivElement>(null);
  const [deleted, setDeleted] = useState<{ id: string; neighbours: string[] }>();
  function onDeleted(id: string) {
    const visible = Array.from(
      root.current?.querySelectorAll<HTMLElement>('[data-row-action]') ?? [],
    ).map((button) => button.dataset.rowAction!);
    const index = visible.indexOf(id);
    setDeleted({
      id,
      neighbours: [...visible.slice(index + 1), ...visible.slice(0, index).reverse()],
    });
  }
  useEffect(() => {
    if (!deleted || refreshing || ids.includes(deleted.id)) return;
    const frame = requestAnimationFrame(() => {
      const buttons = Array.from(
        root.current?.querySelectorAll<HTMLButtonElement>('[data-row-action]') ?? [],
      );
      const neighbour = deleted.neighbours
        .map((id) => buttons.find((button) => button.dataset.rowAction === id))
        .find((button) => button && !button.disabled);
      (
        neighbour ??
        buttons[0] ??
        root.current?.querySelector<HTMLElement>('[data-list-search]')
      )?.focus();
      setDeleted(undefined);
    });
    return () => cancelAnimationFrame(frame);
  }, [deleted, refreshing, ids.join('\n')]);
  return { root, onDeleted };
}
export function useAlertAccess() {
  const { client, identity, mode } = useApp();
  const sources = useAsync(
    useCallback(
      async (signal) =>
        mode === 'demo' || !identity ? undefined : client.userRoleSources(identity.id, signal),
      [client, identity?.id, mode],
    ),
  );
  const privileges =
    sources.data &&
    [
      ...Object.values(sources.data.roles),
      ...Object.values(sources.data.groupRoles).flatMap(Object.values),
    ].flatMap((source) => source.actions);
  // Identity is a display hint. When role inspection is unavailable, the server authorizes each action.
  return privileges
    ? privileges.some((item) =>
        ['superadmin', 'admin', 'editor', 'writer'].includes(item.privilege),
      )
    : true;
}

// The router restores browser history while a blocked navigation awaits confirmation.
export function useLeaveGuard(dirty: boolean) {
  const changed = useRef(dirty);
  changed.current = dirty;
  const blocker = useBlocker(
    useCallback(
      ({ nextLocation }) => changed.current && !nextLocation.pathname.startsWith('/login'),
      [],
    ),
  );
  useEffect(() => {
    if (blocker.state === 'blocked') {
      if (window.confirm('Leave without saving this alert?')) blocker.proceed();
      else blocker.reset();
    }
  }, [blocker]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (changed.current) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, []);
  return () => {
    changed.current = false;
  };
}
