import { useCallback, useState } from 'react';
import { ArrowDown, ArrowUp, X } from 'lucide-react';
import { Badge, Button, Card, EmptyState, Pagination } from '../../components/ui';
import { QueryState } from '../../components/explorer/QueryState';
import { useApp } from '../../app/AppProvider';
import type { TeamUser } from '../../lib/types';
import { CredentialSheet } from './CredentialSheet';
import {
  AssignRolesDialog,
  RemoveUserRoleDialog,
  UserConfirmDialog,
  UserRoleSourcesSheet,
} from './UserDialogs';
import { TeamSearch, useTeamCollection, useTeamSearch } from './shared';
import { isRootAdmin } from './helpers';

type Action = { user: TeamUser } & (
  { kind: 'assign' | 'delete' | 'reset' | 'sources' } | { kind: 'remove'; role: string }
);
type Sort = 'username' | 'email' | 'method';

export function UsersTab({
  creating,
  closeCreate,
}: {
  creating: boolean;
  closeCreate: () => void;
}) {
  const { client } = useApp();
  const users = useTeamCollection(useCallback((signal) => client.listUsers(signal), [client]));
  const [action, setAction] = useState<Action>();
  const [sort, setSort] = useState<Sort>('username');
  const [descending, setDescending] = useState(false);
  const ordered = [...(users.data ?? [])].sort(
    (a, b) =>
      ((a[sort] ?? '').localeCompare(b[sort] ?? '') || a.id.localeCompare(b.id)) *
      (descending ? -1 : 1),
  );
  const list = useTeamSearch(ordered, (user, search) =>
    [
      user.username,
      user.email ?? '',
      ...Object.keys(user.roles),
      ...Object.values(user.groupRoles).flatMap(Object.keys),
    ].some((value) => value.toLowerCase().includes(search)),
  );
  function changeSort(column: Sort) {
    if (sort === column) setDescending(!descending);
    else {
      setSort(column);
      setDescending(false);
    }
    list.setPage(0);
  }
  const close = () => setAction(undefined);
  function open(next: Action) {
    if (!users.loading) setAction(next);
  }
  return (
    <section className="team-tab" aria-label="Users" data-testid="team-user">
      <TeamSearch
        noun="users"
        placeholder="Search by name, email or role"
        value={list.search}
        onChange={list.setSearch}
      />
      <QueryState loading={users.loading && !users.data} error={users.error} retry={users.reload} />
      {users.loading && users.data && (
        <p role="status" className="muted">
          Refreshing users…
        </p>
      )}
      {users.data && (
        <Card className="team-table" aria-busy={users.loading}>
          <div className="table-scroll">
            <table>
              <caption className="sr-only">Users</caption>
              <thead>
                <tr>
                  {(['username', 'email', 'method'] as const).map((column) => (
                    <th
                      scope="col"
                      key={column}
                      aria-sort={
                        sort === column ? (descending ? 'descending' : 'ascending') : 'none'
                      }
                    >
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => changeSort(column)}
                        aria-label={`Sort by ${column === 'username' ? 'name' : column}`}
                      >
                        {column === 'username' ? 'Name' : column === 'email' ? 'Email' : 'Method'}
                        {sort === column &&
                          (descending ? (
                            <ArrowDown size={12} aria-hidden="true" />
                          ) : (
                            <ArrowUp size={12} aria-hidden="true" />
                          ))}
                      </Button>
                    </th>
                  ))}
                  <th scope="col">Roles</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {list.rows.map((user) => (
                  <tr key={user.id}>
                    <td>
                      <div className="team-chips">
                        <strong>{user.username}</strong>
                        {isRootAdmin(user) && <Badge>Root admin</Badge>}
                      </div>
                    </td>
                    <td>{user.email || '—'}</td>
                    <td>
                      <Badge>{user.method === 'oauth' ? 'OAuth' : 'Native'}</Badge>
                    </td>
                    <td>
                      <div className="team-chips">
                        {Object.keys(user.roles)
                          .sort((a, b) => a.localeCompare(b))
                          .map((role) => (
                            <Badge className="team-chip" key={role}>
                              {role}
                              {!isRootAdmin(user) && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  aria-label={`Remove ${role} from ${user.username}`}
                                  aria-disabled={users.loading}
                                  onClick={() => open({ user, kind: 'remove', role })}
                                >
                                  <X size={12} aria-hidden="true" />
                                </Button>
                              )}
                            </Badge>
                          ))}
                        {Object.entries(user.groupRoles)
                          .sort(([a], [b]) => a.localeCompare(b))
                          .flatMap(([group, roles]) =>
                            Object.keys(roles)
                              .sort((a, b) => a.localeCompare(b))
                              .map((role) => (
                                <Badge
                                  className="team-inherited"
                                  tone="warning"
                                  key={`${group}-${role}`}
                                  title={`Inherited from "${group}" group`}
                                >
                                  {role} <span>Inherited from "{group}" group</span>
                                </Badge>
                              )),
                          )}
                        {!Object.keys(user.roles).length &&
                          !Object.keys(user.groupRoles).length && (
                            <span className="muted">No roles</span>
                          )}
                      </div>
                    </td>
                    <td>
                      {isRootAdmin(user) ? (
                        <span className="muted">Managed by server configuration</span>
                      ) : (
                        <div className="team-actions">
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={`Assign roles to ${user.username}`}
                            aria-disabled={users.loading}
                            onClick={() => open({ user, kind: 'assign' })}
                          >
                            Assign roles
                          </Button>
                          {user.method === 'native' && (
                            <Button
                              variant="ghost"
                              size="sm"
                              aria-label={`Reset password for ${user.username}`}
                              aria-disabled={users.loading}
                              onClick={() => open({ user, kind: 'reset' })}
                            >
                              Reset password
                            </Button>
                          )}
                          {user.method === 'oauth' && (
                            <Button
                              variant="ghost"
                              size="sm"
                              aria-label={`View role sources for ${user.username}`}
                              aria-disabled={users.loading}
                              onClick={() => open({ user, kind: 'sources' })}
                            >
                              View role sources
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={`Delete user ${user.username}`}
                            aria-disabled={users.loading}
                            onClick={() => open({ user, kind: 'delete' })}
                          >
                            Delete user
                          </Button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!list.total && (
            <EmptyState
              title="No users found"
              description={
                users.data.length
                  ? 'No users found matching your search.'
                  : 'No users yet. Add a user to grant access.'
              }
            />
          )}
          <Pagination
            page={list.page}
            total={list.total}
            noun="users"
            onPageChange={list.setPage}
          />
        </Card>
      )}
      {creating && <CredentialSheet kind="user" onClose={closeCreate} onChanged={users.reload} />}
      {action?.kind === 'assign' && (
        <AssignRolesDialog user={action.user} onClose={close} onChanged={users.reload} />
      )}
      {action?.kind === 'remove' && (
        <RemoveUserRoleDialog
          user={action.user}
          role={action.role}
          onClose={close}
          onChanged={users.reload}
        />
      )}
      {(action?.kind === 'delete' || action?.kind === 'reset') && (
        <UserConfirmDialog
          user={action.user}
          action={action.kind}
          onClose={close}
          onChanged={users.reload}
        />
      )}
      {action?.kind === 'sources' && <UserRoleSourcesSheet user={action.user} onClose={close} />}
    </section>
  );
}
