import { useCallback } from 'react';
import { useApp } from '../../app/AppProvider';
import { useAsync } from '../../hooks/useAsync';
import { displayDate, formatAlertDate } from './helpers';

export function DateText({ value }: { value?: string | null }) {
  const iso = displayDate(value);
  return iso ? (
    <time dateTime={iso}>{formatAlertDate(iso)}</time>
  ) : (
    <span className="muted">Never</span>
  );
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
