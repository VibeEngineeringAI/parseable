import { useCallback } from 'react';
import { Button } from '../../components/ui';
import { useApp } from '../../app/AppProvider';
import { useAsync } from '../../hooks/useAsync';
import type { UserRoleSources } from '../../lib/types';
import { oidcRemovalStatus } from './helpers';
import { InlineError } from './shared';

export function useRoleSources(id: string, oauth = true) {
  const { client } = useApp();
  return useAsync(
    useCallback(
      (signal) => (oauth ? client.userRoleSources(id, signal) : Promise.resolve(undefined)),
      [client, id, oauth],
    ),
  );
}

const list = (values: string[] | null) =>
  values === null ? 'Unknown' : values.join(', ') || 'None';

export function OidcRoleInspector({
  data,
  loading,
  error,
  retry,
  role,
}: {
  data?: UserRoleSources;
  loading: boolean;
  error?: Error;
  retry: () => void;
  role?: string;
}) {
  const provenance = data?.oidc;
  const status = data && role ? oidcRemovalStatus(data, role) : undefined;
  return (
    <section aria-label="OIDC role sources" className="team-provenance stack">
      <h3>OIDC role sources</h3>
      {error ? (
        <div>
          <InlineError error={error.message} />
          <Button size="sm" onClick={retry}>
            Try again
          </Button>
        </div>
      ) : loading ? (
        <p role="status">Loading role sources…</p>
      ) : !provenance || provenance.legacy ? (
        <p role="status">
          Role sources are not yet available. This user must sign in again to record current
          provider groups.
        </p>
      ) : (
        <div className="team-source-list">
          <p>Provider groups: {list(provenance.groups)}</p>
          <p>Roles from provider groups: {list(provenance.providerRoles)}</p>
          <p>Roles assigned by administrators: {list(provenance.manualRoles)}</p>
          <p>Fallback role (when no manual or provider role): {provenance.defaultRole || 'None'}</p>
          <p>Effective direct roles: {Object.keys(data?.roles ?? {}).join(', ') || 'None'}</p>
        </div>
      )}
      <p>
        Assignments here are manual grants. Provider and default grants are managed through the
        identity provider and default role configuration.
      </p>
      {status && <p role="status">{status}</p>}
    </section>
  );
}
