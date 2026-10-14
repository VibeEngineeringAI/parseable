import type { TransportFailure } from '../../lib/keystone/transport';
import type { KeystonePageCapabilities, StorageState } from './pageContract';

const EXECUTION: Record<string, { user: string; admin?: string }> = {
  execution_unavailable: { user: 'This server cannot run questions yet.' },
  query_bridge_unavailable: {
    user: 'This server cannot run questions yet: scoped data access for runs is not available.',
  },
  provider_unconfigured: {
    user: 'No model provider is configured. Ask an administrator to configure one.',
    admin:
      'No model provider is configured. Add a key under OpenRouter connection on the investigations list to run questions.',
  },
  provider_disabled: {
    user: 'The model provider is turned off. Ask an administrator to turn it on.',
    admin: 'The model provider is turned off. Turn it on in Settings to run questions.',
  },
  secret_store_unavailable: {
    user: 'This server cannot store model credentials yet, so no provider can be configured.',
  },
  permission_denied: { user: 'Your role cannot run questions.' },
  topology_unsupported: {
    user: 'Runs need a single coordinating query node, which this deployment does not have.',
  },
};

/** Why questions cannot run, or null when they can. Unknown codes are never ready. */
export function executionMessage(
  execution: KeystonePageCapabilities['execution'],
  isAdmin = false,
): string | null {
  if (execution.state === 'ready') return null;
  const copy = execution.reason ? EXECUTION[execution.reason] : undefined;
  if (!copy)
    return execution.reason
      ? `This server cannot run questions yet (${execution.reason}).`
      : 'This server cannot run questions yet.';
  return isAdmin && copy.admin ? copy.admin : copy.user;
}

/** Why saved investigations cannot be used, or null when storage is ready. */
export function storageMessage(state: StorageState): string | null {
  switch (state) {
    case 'ready':
      return null;
    case 'degraded':
      return 'Investigation storage stopped accepting changes after a failed write. Saved investigations are kept; an administrator must restart the server to recover.';
    case 'unavailable':
      return 'Investigation storage is not enabled on this server. An administrator can enable it on one query node.';
  }
}

/**
 * What the page shows first. The server reports `read: false` whenever storage is
 * not ready, so readiness is explained before `read` is taken as a role decision.
 */
export function pageGate(capabilities: KeystonePageCapabilities): 'readiness' | 'denied' | 'open' {
  if (capabilities.storage.state !== 'ready') return 'readiness';
  return capabilities.workspace.actions.read ? 'open' : 'denied';
}

/**
 * What the request was for. Creating names no investigation yet, so a not-found
 * there means a selected dataset, not a missing investigation.
 */
export type RequestContext = 'investigation' | 'create';

export function requestMessage(
  failure: TransportFailure,
  context: RequestContext = 'investigation',
): string {
  switch (failure.kind) {
    case 'denied':
      return 'You do not have permission for this. Sign in again or ask an administrator.';
    case 'not_found':
      return context === 'create'
        ? 'A selected dataset is unavailable or you do not have permission to investigate it. Your question and scope are kept; change the datasets and save again.'
        : 'This investigation does not exist or you do not have access to it.';
    case 'conflict':
      return 'This changed on the server since you started. Reload and try again.';
    case 'invalid':
      return `The server sent a response this page cannot read. ${failure.message}`;
    default:
      return failure.message;
  }
}
