import type { ApiKey, Privilege, RoleSource, Roles, UserPrivilege, UserRoleSources } from './types';

export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function userPrivilege(value: unknown): value is UserPrivilege {
  if (!object(value) || typeof value.privilege !== 'string') return false;
  if (['admin', 'editor', 'superadmin'].includes(value.privilege)) return value.resource == null;
  if (!['writer', 'reader', 'ingestor'].includes(value.privilege)) return false;
  const resource = value.resource;
  return (
    resource == null ||
    resource === 'all' ||
    (object(resource) &&
      ((typeof resource.stream === 'string' && resource.llmKey === undefined) ||
        (typeof resource.llmKey === 'string' && resource.stream === undefined)))
  );
}

export function userRoles(value: unknown): value is Record<string, UserPrivilege[]> {
  return (
    object(value) &&
    Object.values(value).every((actions) => Array.isArray(actions) && actions.every(userPrivilege))
  );
}

export function roles(value: unknown): value is Roles {
  return (
    userRoles(value) &&
    Object.values(value).every((actions) =>
      actions.every((action): action is Privilege => action.privilege !== 'superadmin'),
    )
  );
}

export function groupRoles(
  value: unknown,
): value is Record<string, Record<string, UserPrivilege[]>> {
  return object(value) && Object.values(value).every(userRoles);
}

function source(value: unknown): value is RoleSource {
  return (
    object(value) &&
    Array.isArray(value.actions) &&
    value.actions.every(userPrivilege) &&
    (value.roleType === 'user' || value.roleType === 'internal')
  );
}

function sources(value: unknown): value is Record<string, RoleSource> {
  return object(value) && Object.values(value).every(source);
}

export function roleSources(value: unknown): value is UserRoleSources {
  if (
    !object(value) ||
    !sources(value.roles) ||
    !object(value.groupRoles) ||
    !Object.values(value.groupRoles).every(sources)
  )
    return false;
  const oidc = value.oidc;
  return (
    oidc === undefined ||
    (object(oidc) &&
      (oidc.issuer === null || typeof oidc.issuer === 'string') &&
      typeof oidc.legacy === 'boolean' &&
      [oidc.groups, oidc.manualRoles, oidc.providerRoles].every(
        (item) => item === null || strings(item),
      ) &&
      (oidc.defaultRole === null || typeof oidc.defaultRole === 'string'))
  );
}

export function apiKey(value: unknown): value is ApiKey {
  return (
    object(value) &&
    ['keyId', 'apiKey', 'keyName', 'createdBy', 'createdAt', 'modifiedAt'].every(
      (field) => typeof value[field] === 'string',
    ) &&
    strings(value.roles) &&
    Number.isFinite(Date.parse(String(value.createdAt))) &&
    Number.isFinite(Date.parse(String(value.modifiedAt)))
  );
}
