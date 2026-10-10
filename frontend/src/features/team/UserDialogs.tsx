import { useCallback, useState, type FormEvent } from 'react';
import { Button, Dialog, Sheet, TypedConfirmDialog, InlineError } from '../../components/ui';
import { QueryState } from '../../components/explorer/QueryState';
import { useApp } from '../../app/AppProvider';
import { useAsync } from '../../hooks/useAsync';
import type { TeamUser } from '../../lib/types';
import { oidcManualRoleRemovable } from './helpers';
import { OidcRoleInspector, useRoleSources } from './OidcRoleInspector';
import { RoleCheckboxes, SecretResult } from './shared';
import { useMutation } from '../../hooks/useMutation';

type Props = { user: TeamUser; onClose: () => void; onChanged: () => void };

export function AssignRolesDialog({ user, onClose, onChanged }: Props) {
  const { client } = useApp();
  const roles = useAsync(useCallback((signal) => client.listRoles(signal), [client]));
  const oauth = user.method === 'oauth';
  const sources = useRoleSources(user.id, oauth);
  const [assigned, setAssigned] = useState<string[]>([]);
  const mutation = useMutation();
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!assigned.length) return;
    void mutation.run(async () => {
      await client.addUserRoles(user.id, assigned);
      if (mutation.isActive()) onClose();
      onChanged();
    });
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Assign roles"
      description={`Assign roles to ${user.username}.`}
    >
      <form className="stack" onSubmit={submit}>
        <QueryState loading={roles.loading} error={roles.error} retry={roles.reload} />
        {oauth && (
          <QueryState loading={sources.loading} error={sources.error} retry={sources.reload} />
        )}
        {roles.data && (!oauth || sources.data) && (
          <RoleCheckboxes
            roles={Object.keys(roles.data)
              .filter((name) =>
                sources.data?.oidc?.legacy === false
                  ? !sources.data.oidc.manualRoles?.includes(name)
                  : !Object.hasOwn(user.roles, name),
              )
              .sort((a, b) => a.localeCompare(b))}
            selected={assigned}
            onChange={setAssigned}
            disabled={mutation.pending}
          />
        )}
        <InlineError error={mutation.error} />
        <Button
          type="submit"
          variant="primary"
          data-dialog-confirm
          disabled={!assigned.length || mutation.pending}
        >
          Assign roles
        </Button>
      </form>
    </Dialog>
  );
}

export function RemoveUserRoleDialog({ user, role, onClose, onChanged }: Props & { role: string }) {
  const { client } = useApp();
  const oauth = user.method === 'oauth';
  const sources = useRoleSources(user.id, oauth);
  const mutation = useMutation();
  const removable =
    !oauth || (!sources.loading && !sources.error && oidcManualRoleRemovable(sources.data, role));
  function remove() {
    if (!removable) return;
    void mutation.run(async () => {
      await client.removeUserRoles(user.id, [role]);
      if (mutation.isActive()) onClose();
      onChanged();
    });
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Remove role"
      description={`Remove ${role} from ${user.username}?`}
    >
      <div className="stack">
        {oauth && <OidcRoleInspector {...sources} retry={sources.reload} role={role} />}
        <InlineError error={mutation.error} />
        <div className="inline">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="danger"
            data-dialog-confirm
            onClick={remove}
            disabled={!removable || mutation.pending}
          >
            Remove
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

export function UserRoleSourcesSheet({ user, onClose }: Omit<Props, 'onChanged'>) {
  const sources = useRoleSources(user.id);
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="View role sources"
      description={`Role sources for ${user.username}.`}
    >
      <OidcRoleInspector {...sources} retry={sources.reload} />
    </Sheet>
  );
}

export function UserConfirmDialog({
  user,
  action,
  onClose,
  onChanged,
}: Props & { action: 'delete' | 'reset' }) {
  const { client } = useApp();
  const [password, setPassword] = useState<string>();
  const mutation = useMutation();
  function confirm() {
    void mutation.run(async () => {
      if (action === 'reset') {
        const result = await client.resetPassword(user.id);
        if (mutation.isActive()) setPassword(result);
      } else {
        await client.deleteUser(user.id);
        if (mutation.isActive()) onClose();
        onChanged();
      }
    });
  }
  return (
    <TypedConfirmDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={action === 'delete' ? 'Delete user' : 'Reset password'}
      name={user.username}
      action={action === 'delete' ? 'Delete user' : 'Reset password'}
      onConfirm={confirm}
      pending={mutation.pending}
      error={mutation.error}
      complete={password !== undefined}
    >
      {password !== undefined && <SecretResult value={password} kind="password" />}
    </TypedConfirmDialog>
  );
}
