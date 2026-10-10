import { useCallback, useState } from 'react';
import { X } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  Pagination,
  Sheet,
  TypedConfirmDialog,
} from '../../components/ui';
import { QueryState } from '../../components/explorer/QueryState';
import { useApp } from '../../app/AppProvider';
import { useAsync } from '../../hooks/useAsync';
import type { Privilege } from '../../lib/types';
import { privilegeLabel } from './helpers';
import { RoleEditor } from './RoleEditor';
import { DefaultRoleDialog } from './DefaultRoleDialog';
import { InlineError, TeamSearch, useTeamSearch } from './shared';
import { useCollection } from '../../hooks/useCollection';
import { useMutation } from '../../hooks/useMutation';

export function RolesTab({
  creating,
  closeCreate,
  managingDefault,
  closeDefault,
  oidcActive,
}: {
  creating: boolean;
  closeCreate: () => void;
  managingDefault: boolean;
  closeDefault: () => void;
  oidcActive: boolean;
}) {
  const { client } = useApp();
  const roles = useCollection(useCallback((signal) => client.listRoles(signal), [client]));
  const defaultRole = useAsync(
    useCallback(
      (signal) => (oidcActive ? client.defaultRole(signal) : Promise.resolve(null)),
      [client, oidcActive],
    ),
  );
  const [adding, setAdding] = useState<string>();
  const [deleting, setDeleting] = useState<string>();
  const [removing, setRemoving] = useState<{ name: string; privilege: Privilege }>();
  const [actionRevision, setActionRevision] = useState(0);
  const mutation = useMutation();
  const roleMap = roles.data;
  const list = useTeamSearch(
    Object.keys(roleMap ?? {}).sort((a, b) => a.localeCompare(b)),
    (name, search) => name.toLowerCase().includes(search),
  );
  function reload() {
    roles.reload();
    defaultRole.reload();
  }
  function deleteRole() {
    if (!deleting) return;
    void mutation.run(async () => {
      await client.deleteRole(deleting);
      setDeleting(undefined);
      reload();
    });
  }
  function removePrivilege() {
    if (!removing || !roleMap) return;
    const { name, privilege } = removing;
    // Match by value: the list may have refreshed since the dialog opened.
    const target = JSON.stringify(privilege);
    const index = (roleMap[name] ?? []).findIndex((item) => JSON.stringify(item) === target);
    void mutation.run(async () => {
      if (index < 0) throw new Error(`${privilegeLabel(privilege)} is no longer in ${name}.`);
      await client.putRole(
        name,
        roleMap[name].filter((_, i) => i !== index),
      );
      setRemoving(undefined);
      reload();
    });
  }
  return (
    <section aria-label="Roles" className="team-tab">
      <TeamSearch
        noun="roles"
        placeholder="Search by name"
        value={list.search}
        onChange={list.setSearch}
      />
      <QueryState loading={roles.loading && !roleMap} error={roles.error} retry={roles.reload} />
      {roles.loading && roleMap && (
        <p role="status" className="muted">
          Refreshing roles…
        </p>
      )}
      {defaultRole.error && (
        <QueryState loading={false} error={defaultRole.error} retry={defaultRole.reload} />
      )}
      {roleMap && (
        <Card className="team-table" aria-busy={roles.loading}>
          <div className="table-scroll">
            <table>
              <caption className="sr-only">Roles</caption>
              <thead>
                <tr>
                  <th scope="col">Role</th>
                  <th scope="col">Privileges</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {list.rows.map((name) => (
                  <tr key={name}>
                    <td>
                      <div className="inline wrap">
                        <strong>{name}</strong>
                        {defaultRole.data === name && <Badge tone="success">Default</Badge>}
                      </div>
                    </td>
                    <td>
                      <div className="team-chips">
                        {roleMap[name].map((privilege, index) => {
                          const label = privilegeLabel(privilege);
                          return (
                            <Badge key={`${label}-${index}`} className="team-chip">
                              {label}
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label={`Remove ${label} from ${name}`}
                                aria-disabled={roles.loading || mutation.pending}
                                onClick={() => {
                                  if (roles.loading || mutation.pending) return;
                                  mutation.reset();
                                  setActionRevision((v) => v + 1);
                                  setRemoving({ name, privilege });
                                }}
                              >
                                <X size={12} aria-hidden="true" />
                              </Button>
                            </Badge>
                          );
                        })}
                        {!roleMap[name].length && <span className="muted">No privileges</span>}
                      </div>
                    </td>
                    <td>
                      <div className="team-actions">
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`Add privilege to role ${name}`}
                          aria-disabled={roles.loading || mutation.pending}
                          onClick={() => {
                            if (!roles.loading && !mutation.pending) setAdding(name);
                          }}
                        >
                          Add privilege to role
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`Delete role ${name}`}
                          aria-disabled={roles.loading || mutation.pending}
                          onClick={() => {
                            if (roles.loading || mutation.pending) return;
                            mutation.reset();
                            setActionRevision((v) => v + 1);
                            setDeleting(name);
                          }}
                        >
                          Delete role
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!list.total && (
            <EmptyState
              title="No roles found"
              description={
                Object.keys(roleMap).length
                  ? 'No roles found matching your search.'
                  : 'Add a role to define access.'
              }
            />
          )}
          <Pagination
            page={list.page}
            total={list.total}
            noun="roles"
            onPageChange={list.setPage}
          />
        </Card>
      )}
      {creating && roles.data && (
        <RoleEditor roles={roles.data} onClose={closeCreate} onChanged={reload} />
      )}
      {(creating || managingDefault) && !roles.data && (
        <Sheet
          open
          title={creating ? 'Create new role' : 'Default OIDC role'}
          onOpenChange={(open) => {
            if (!open) {
              closeCreate();
              closeDefault();
            }
          }}
        >
          <QueryState loading={roles.loading} error={roles.error} retry={roles.reload} />
        </Sheet>
      )}
      {adding && roles.data && (
        <RoleEditor
          roles={roles.data}
          name={adding}
          onClose={() => setAdding(undefined)}
          onChanged={reload}
        />
      )}
      {managingDefault && roles.data && (
        <DefaultRoleDialog roles={roles.data} onClose={closeDefault} onChanged={reload} />
      )}
      <TypedConfirmDialog
        key={`delete-${actionRevision}`}
        open={deleting !== undefined}
        title="Delete role"
        name={deleting ?? ''}
        action="Delete role"
        onOpenChange={(open) => {
          if (!open) setDeleting(undefined);
        }}
        onConfirm={deleteRole}
        pending={mutation.pending}
        error={deleting ? mutation.error : undefined}
      />
      <Dialog
        key={`remove-${actionRevision}`}
        open={removing !== undefined}
        title="Remove privilege"
        onOpenChange={(open) => {
          if (!open) setRemoving(undefined);
        }}
        description={
          removing
            ? `Remove ${privilegeLabel(removing.privilege)} from ${removing.name}?`
            : undefined
        }
      >
        <div className="stack">
          <InlineError error={mutation.error} />
          <div className="inline">
            <Button onClick={() => setRemoving(undefined)}>Cancel</Button>
            <Button
              variant="danger"
              data-dialog-confirm
              onClick={removePrivilege}
              disabled={mutation.pending}
            >
              Remove privilege
            </Button>
          </div>
        </div>
      </Dialog>
    </section>
  );
}
