import { describe, expect, it } from 'vitest';
import type { TeamUser, UserPrivilege, UserRoleSources } from '../../lib/types';
import {
  isRootAdmin,
  oidcManualRoleRemovable,
  oidcRemovalStatus,
  privilegeLabel,
  validateName,
} from './helpers';

describe('Team helpers', () => {
  const user: TeamUser = {
    id: 'frontend-smoke',
    username: 'frontend-smoke',
    method: 'native',
    roles: {},
    groupRoles: {},
    userGroups: [],
  };
  it('identifies root admin by an action in any direct role', () => {
    expect(isRootAdmin({ ...user, roles: { 'super-admin': [{ privilege: 'superadmin' }] } })).toBe(
      true,
    );
    expect(
      isRootAdmin({
        ...user,
        roles: {
          readers: [{ privilege: 'reader' }],
          internal: [{ privilege: 'admin' }, { privilege: 'superadmin' }],
        },
      }),
    ).toBe(true);
  });
  it('does not infer root admin from a name, ordinary admin privilege or inherited role', () => {
    expect(isRootAdmin(user)).toBe(false);
    expect(isRootAdmin({ ...user, id: 'admin', username: 'admin' })).toBe(false);
    expect(isRootAdmin({ ...user, roles: { administrators: [{ privilege: 'admin' }] } })).toBe(
      false,
    );
    expect(isRootAdmin({ ...user, roles: { 'super-admin': [] } })).toBe(false);
    expect(
      isRootAdmin({
        ...user,
        groupRoles: { ops: { 'super-admin': [{ privilege: 'superadmin' }] } },
      }),
    ).toBe(false);
  });
  const labels: Array<[UserPrivilege, string]> = [
    [{ privilege: 'admin' }, 'admin'],
    [{ privilege: 'editor' }, 'editor'],
    [{ privilege: 'superadmin' }, 'superadmin'],
    [{ privilege: 'reader', resource: { stream: 'web_logs' } }, 'reader of web_logs'],
    [{ privilege: 'reader', resource: { stream: '*' } }, 'reader of all datasets'],
    [{ privilege: 'writer', resource: { llmKey: '*' } }, 'writer of all LLM keys'],
    [{ privilege: 'writer', resource: { llmKey: 'assistant' } }, 'writer of assistant'],
    [{ privilege: 'ingestor', resource: 'all' }, 'ingestor of all resources'],
    [{ privilege: 'reader', resource: null }, 'reader of all resources'],
    [{ privilege: 'reader' }, 'reader of all resources'],
  ];
  it.each(labels)('formats %j as %s', (value, label) => expect(privilegeLabel(value)).toBe(label));
  it.each(['abc', 'a'.repeat(64), 'Ops.Read', 'a-b_c.d@e', '-leading'])(
    'accepts a backend-valid name: %s',
    (name) => expect(validateName(name, 'role')).toBeUndefined(),
  );
  it.each([
    '',
    'ab',
    'a'.repeat(65),
    'admin',
    'USER',
    'role',
    'superadmin',
    'super-admin',
    'null',
    'undefined',
    'none',
    'empty',
    'password',
    'username',
    'has space',
    'has/ slash',
    'end-',
    'two..dots',
    'mixed_@separators',
    'unicode-é',
  ])('rejects invalid or reserved name: %s', (name) =>
    expect(validateName(name, 'role')).toBeTruthy(),
  );
  it('rejects the shadowed role endpoint but allows a native user named default', () => {
    expect(validateName('default', 'role')).toContain('default OIDC role endpoint');
    expect(validateName('default', 'user')).toBeUndefined();
  });
  const summary: UserRoleSources = {
    roles: {},
    groupRoles: {},
    oidc: {
      issuer: 'https://issuer.example',
      legacy: false,
      groups: [],
      manualRoles: ['manual', 'overlap'],
      providerRoles: ['provider', 'overlap'],
      defaultRole: 'fallback',
    },
  };
  it('only enables recorded manual grants or legacy roles', () => {
    expect(oidcManualRoleRemovable(undefined, 'manual')).toBe(false);
    expect(oidcManualRoleRemovable({ roles: {}, groupRoles: {} }, 'manual')).toBe(false);
    expect(oidcManualRoleRemovable(summary, 'provider')).toBe(false);
    expect(oidcManualRoleRemovable(summary, 'fallback')).toBe(false);
    expect(oidcManualRoleRemovable(summary, 'manual')).toBe(true);
    expect(oidcManualRoleRemovable(summary, 'overlap')).toBe(true);
    expect(
      oidcManualRoleRemovable(
        { ...summary, oidc: { ...summary.oidc!, manualRoles: null } },
        'manual',
      ),
    ).toBe(false);
    expect(
      oidcManualRoleRemovable(
        { ...summary, oidc: { ...summary.oidc!, legacy: true, manualRoles: null } },
        'any-role',
      ),
    ).toBe(true);
  });
  it('explains provider overlap and manual-only removal with overlay wording', () => {
    expect(oidcRemovalStatus(summary, 'overlap')).toBe(
      'Removing the manual grant leaves this role assigned through the provider group.',
    );
    expect(oidcRemovalStatus(summary, 'manual')).toBe(
      'This removes the administrator’s manual grant.',
    );
    expect(oidcRemovalStatus(summary, 'provider')).toBe(
      'This role has no manual grant to remove. Update the provider group or default role configuration.',
    );
  });
});
