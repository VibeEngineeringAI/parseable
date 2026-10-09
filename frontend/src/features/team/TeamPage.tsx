import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { Button, Tabs } from '../../components/ui';
import { PageHeader } from '../../components/explorer/PageHeader';
import { QueryState } from '../../components/explorer/QueryState';
import { useApp } from '../../app/AppProvider';
import { useAsync } from '../../hooks/useAsync';
import { RolesTab } from './RolesTab';
import { UsersTab } from './UsersTab';
import { GroupsTab } from './GroupsTab';
import { ApiKeysTab } from './ApiKeysTab';
import './team.css';

export function TeamPage() {
  const { client } = useApp();
  const about = useAsync(useCallback((signal) => client.about(signal), [client]));
  const [params, setParams] = useSearchParams();
  const requested = params.get('tab') ?? 'roles';
  const groupsEnabled = about.data?.oidcActive && about.data.capabilities.oidcRoleMapping;
  const invalid =
    !['roles', 'user', 'groups', 'apikeys'].includes(requested) ||
    (requested === 'groups' && about.data !== undefined && !groupsEnabled);
  const tab = invalid ? 'roles' : requested;
  const [creating, setCreating] = useState(false);
  const [managingDefault, setManagingDefault] = useState(false);
  useEffect(() => {
    if (invalid) {
      const next = new URLSearchParams(params);
      next.set('tab', 'roles');
      setParams(next, { replace: true });
    }
  }, [invalid, params, setParams]);
  useEffect(() => {
    setCreating(false);
    setManagingDefault(false);
  }, [tab]);
  function selectTab(value: string) {
    setCreating(false);
    setManagingDefault(false);
    const next = new URLSearchParams(params);
    next.set('tab', value);
    setParams(next);
  }
  return (
    <div className="page team-page">
      <PageHeader
        title="Access management"
        description="Manage users, roles and access for this Parseable instance."
        actions={
          about.data && (
            <>
              {tab === 'roles' && about.data.oidcActive && (
                <Button onClick={() => setManagingDefault(true)}>Manage default OIDC role</Button>
              )}
              {tab !== 'groups' && (
                <Button variant="primary" onClick={() => setCreating(true)}>
                  <Plus size={15} aria-hidden="true" />
                  {tab === 'user' ? 'Add user' : tab === 'apikeys' ? 'Add API key' : 'Add role'}
                </Button>
              )}
            </>
          )
        }
      />
      <QueryState loading={about.loading} error={about.error} retry={about.reload} />
      {about.data && (
        <Tabs
          value={tab}
          onValueChange={selectTab}
          aria-label="Access management"
          items={[
            {
              value: 'roles',
              label: 'Roles',
              content: (
                <RolesTab
                  creating={creating}
                  closeCreate={() => setCreating(false)}
                  managingDefault={managingDefault}
                  closeDefault={() => setManagingDefault(false)}
                  oidcActive={about.data.oidcActive}
                />
              ),
            },
            {
              value: 'user',
              label: 'Users',
              content: <UsersTab creating={creating} closeCreate={() => setCreating(false)} />,
            },
            ...(groupsEnabled
              ? [
                  {
                    value: 'groups',
                    label: 'OIDC groups',
                    content: <GroupsTab roleSync={about.data.capabilities.oidcRoleSync} />,
                  },
                ]
              : []),
            {
              value: 'apikeys',
              label: 'API keys',
              content: <ApiKeysTab creating={creating} closeCreate={() => setCreating(false)} />,
            },
          ]}
        />
      )}
    </div>
  );
}
