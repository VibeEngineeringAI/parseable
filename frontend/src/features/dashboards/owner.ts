import { useCallback } from 'react';
import { useApp } from '../../app/AppProvider';
import { useAsync } from '../../hooks/useAsync';
import { sha256 } from '../../lib/sha256';

export function useDashboardAccess() {
  const { client, identity, mode } = useApp();
  const hash = useAsync(
    useCallback(async () => (identity ? sha256(identity.id) : undefined), [identity?.id]),
  );
  const roles = useAsync(
    useCallback(
      async (signal) =>
        mode === 'demo' || !identity ? undefined : client.userRoleSources(identity.id, signal),
      [client, identity?.id, mode],
    ),
  );
  const privileges =
    roles.data &&
    [
      ...Object.values(roles.data.roles),
      ...Object.values(roles.data.groupRoles).flatMap(Object.values),
    ].flatMap((role) => role.actions);
  return {
    hash: hash.data,
    loading: hash.loading,
    canCreate: privileges
      ? privileges.some((item) =>
          ['superadmin', 'admin', 'editor', 'writer', 'reader'].includes(item.privilege),
        )
      : true,
    isAdmin:
      mode === 'demo' ||
      (privileges?.some((item) => ['superadmin', 'admin'].includes(item.privilege)) ?? false),
  };
}
