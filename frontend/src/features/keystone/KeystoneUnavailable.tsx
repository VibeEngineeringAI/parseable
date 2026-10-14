import type { UnavailableReason } from '../../lib/keystone/types';

const COPY: Record<UnavailableReason, { title: string; user: string; admin?: string }> = {
  backend_missing: {
    title: 'Investigations are not available on this server',
    user: 'This Parseable server does not provide the investigations service. SQL, logs and dashboards are unaffected.',
  },
  provider_unconfigured: {
    title: 'No model provider is configured',
    user: 'Saved investigations can be read, but new questions cannot run. Ask an administrator to configure a provider.',
    admin:
      'Saved investigations can be read, but new questions cannot run until you configure a model provider in Settings.',
  },
  provider_disabled: {
    title: 'The model provider is turned off',
    user: 'New questions cannot run while the provider is disabled. Ask an administrator to turn it on.',
    admin: 'New questions cannot run while the provider is disabled. Turn it on in Settings.',
  },
  tools_unavailable: {
    title: 'Query tools are unavailable',
    user: 'Questions cannot run because the server’s query tools are not available. Try again later.',
  },
  permission_denied: {
    title: 'You do not have access',
    user: 'Your role does not include investigations, or this investigation does not exist. Ask an administrator for access.',
  },
  topology_unsupported: {
    title: 'Not supported on this deployment',
    user: 'Investigations need a single coordinating query node, which this deployment does not have.',
  },
};

export function unavailableMessage(reason: UnavailableReason, isAdmin = false) {
  const copy = COPY[reason];
  return isAdmin && copy.admin ? copy.admin : copy.user;
}

/** An explicit state for a missing or gated capability. It never offers a simulated run. */
export function KeystoneUnavailable({
  reason,
  isAdmin = false,
  compact = false,
}: {
  reason: UnavailableReason;
  isAdmin?: boolean;
  compact?: boolean;
}) {
  const copy = COPY[reason];
  return (
    <section
      className="ks-unavailable"
      data-compact={compact || undefined}
      data-reason={reason}
      data-testid="ks-unavailable"
      role={compact ? 'status' : undefined}
      aria-labelledby={`ks-unavailable-${reason}`}
    >
      <h2 id={`ks-unavailable-${reason}`}>{copy.title}</h2>
      <p>{unavailableMessage(reason, isAdmin)}</p>
    </section>
  );
}
