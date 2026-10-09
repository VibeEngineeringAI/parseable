import type { PrivilegeName, TeamUser, UserPrivilege, UserRoleSources } from '../../lib/types';

export const privilegeNames: PrivilegeName[] = ['admin', 'editor', 'writer', 'reader', 'ingestor'];
const reservedNames = new Set([
  'admin',
  'user',
  'role',
  'superadmin',
  'super-admin',
  'null',
  'undefined',
  'none',
  'empty',
  'password',
  'username',
]);

export function validateName(name: string, kind: 'user' | 'role' = 'user'): string | undefined {
  if (name.length < 3 || name.length > 64) return 'Use 3–64 characters.';
  if (reservedNames.has(name.toLowerCase())) return 'This name is reserved.';
  if (kind === 'role' && name.toLowerCase() === 'default')
    return 'The name default is reserved for the default OIDC role endpoint. Choose another name.';
  if (!/^[A-Za-z0-9_.@-]+$/.test(name))
    return 'Use letters, numbers and the separators _ - . @ only.';
  if (!/[A-Za-z0-9]$/.test(name)) return 'End the name with a letter or number.';
  if (/[_.@-]{2}/.test(name)) return 'Do not use consecutive separators.';
  return undefined;
}

export function privilegeLabel(value: UserPrivilege): string {
  if (!('resource' in value) || value.resource == null || value.resource === 'all') {
    return ['writer', 'reader', 'ingestor'].includes(value.privilege)
      ? `${value.privilege} of all resources`
      : value.privilege;
  }
  const resource = value.resource;
  if ('stream' in resource)
    return `${value.privilege} of ${resource.stream === '*' ? 'all datasets' : resource.stream}`;
  return `${value.privilege} of ${resource.llmKey === '*' ? 'all LLM keys' : resource.llmKey}`;
}

export function isRootAdmin(user: TeamUser): boolean {
  return Object.values(user.roles).some((actions) =>
    actions.some((action) => action.privilege === 'superadmin'),
  );
}

export function oidcManualRoleRemovable(
  summary: UserRoleSources | undefined,
  role: string,
): boolean {
  return (
    summary?.oidc?.legacy === true ||
    (summary?.oidc?.legacy === false && summary.oidc.manualRoles?.includes(role) === true)
  );
}

export function oidcRemovalStatus(summary: UserRoleSources, role: string): string | undefined {
  if (!summary.oidc || summary.oidc.legacy) return undefined;
  return oidcManualRoleRemovable(summary, role)
    ? summary.oidc.providerRoles?.includes(role)
      ? 'Removing the manual grant leaves this role assigned through the provider group.'
      : 'This removes the administrator’s manual grant.'
    : 'This role has no manual grant to remove. Update the provider group or default role configuration.';
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
