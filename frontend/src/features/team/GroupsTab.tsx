import { useCallback } from 'react';
import { Card, Pagination } from '../../components/ui';
import { QueryState } from '../../components/explorer/QueryState';
import { useApp } from '../../app/AppProvider';
import { useAsync } from '../../hooks/useAsync';
import { TeamSearch, useTeamSearch } from './shared';

export function GroupsTab({ roleSync }: { roleSync: boolean }) {
  const { client } = useApp();
  const roles = useAsync(useCallback((signal) => client.listRoles(signal), [client]));
  const list = useTeamSearch(
    Object.keys(roles.data ?? {}).sort((a, b) => a.localeCompare(b)),
    (name, search) => name.toLowerCase().includes(search),
  );
  return (
    <section aria-label="OIDC group role mappings" className="team-tab" data-testid="team-group">
      <div className="team-group-description stack">
        <h2>Provider groups → Parseable roles</h2>
        <p>
          Create roles in the Roles tab, then use the exact same names for groups in your identity
          provider. Include group membership in the ID token’s groups claim. Matching is
          case-sensitive; unknown group names grant no role.
        </p>
        <p>
          These groups are managed by your identity provider. Each matching group grants its
          corresponding role. The default applies when the user has no manual or provider role. With
          no match or default, provider claims grant no access.
        </p>
        {roleSync && (
          <p>
            Provider and default grants refresh on sign-in and within five minutes during an active
            session. Removed memberships revoke those grants. Roles explicitly assigned by an
            administrator remain assigned, including the same role granted by a provider group.
          </p>
        )}
      </div>
      <TeamSearch
        noun="OIDC groups"
        placeholder="Search by group name"
        value={list.search}
        onChange={list.setSearch}
      />
      <QueryState loading={roles.loading} error={roles.error} retry={roles.reload} />
      {roles.data && (
        <Card className="team-table">
          <div className="table-scroll">
            <table>
              <caption className="sr-only">Provider group role mappings</caption>
              <thead>
                <tr>
                  <th scope="col">Provider group name</th>
                  <th scope="col">Parseable role</th>
                </tr>
              </thead>
              <tbody>
                {list.rows.map((name) => (
                  <tr key={name}>
                    <td>{name}</td>
                    <td>{name}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!list.total && (
            <p role="status" className="team-empty">
              {Object.keys(roles.data).length
                ? 'No roles match your search.'
                : 'Create a role in the Roles tab to map a provider group.'}
            </p>
          )}
          <Pagination
            page={list.page}
            total={list.total}
            noun="groups"
            onPageChange={list.setPage}
          />
        </Card>
      )}
    </section>
  );
}
