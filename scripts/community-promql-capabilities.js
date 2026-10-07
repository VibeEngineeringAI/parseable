// Separate capabilities keep the community server's OSS license intact.
// Enterprise instances without capability metadata retain their existing behavior.
// This view describes OSS provider claims; Enterprise keeps its native Groups UI.
export const oidcRoleMapping = state => state?.app?.instanceConfig?.license?.plan === 'OSS' &&
  state?.app?.instanceConfig?.oidcActive === true &&
  state?.app?.instanceConfig?.capabilities?.oidcRoleMapping === true;

export function oidcGroupMappings(roles, search = '') {
  return Object.keys(roles || {}).filter(name => name.toLowerCase().includes(search.toLowerCase()))
    .sort((left, right) => left.localeCompare(right)).map(name => ({group: name, role: name}));
}

function oidcError(failure) {
  const body = failure.response?.data;
  return typeof body === 'string' && body ? body : body?.error || failure.message || 'OIDC role configuration failed.';
}

export function CommunityOidcDefaultRole({react: React, api, roles, onClose}) {
  const h = React.createElement;
  const [current, setCurrent] = React.useState(null);
  const [currentKnown, setCurrentKnown] = React.useState(false);
  const [selected, setSelected] = React.useState('');
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [status, setStatus] = React.useState(null);
  React.useEffect(() => {
    let active = true;
    api.get('/api/v1/role/default').then(response => {
      if (active) { setCurrent(response.data); setCurrentKnown(true); setSelected(response.data || ''); }
    }).catch(failure => { if (active) setError(oidcError(failure)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  async function save(clear) {
    setSaving(true); setError(null); setStatus(null);
    try {
      if (clear) await api.delete('/api/v1/role/default');
      else await api.put('/api/v1/role/default', selected, {headers: {'Content-Type': 'application/json'}});
      setCurrent(clear ? null : selected);
      setCurrentKnown(true);
      if (clear) setSelected('');
      setStatus(clear ? 'Default OIDC role cleared.' : 'Default OIDC role saved.');
      onClose?.();
    } catch (failure) { setError(oidcError(failure)); }
    finally { setSaving(false); }
  }
  return h('section', {className: 'flex flex-col gap-3 text-sm', 'aria-label': 'Default OIDC role'},
    h('p', {}, 'The default role applies when an OIDC user has no manual role and no matching provider role. Choose a role with the minimum access those users need.'),
    h('p', {role: 'status'}, loading ? 'Loading default role…' : `Current default: ${currentKnown ? current || 'None' : 'Unknown'}`),
    h('label', {className: 'flex flex-col gap-2'}, 'Default role',
      h('select', {'aria-label': 'Default role', value: selected, disabled: loading || saving,
        className: 'bg-background border border-coolGray-800 rounded px-2 py-1',
        onChange: event => setSelected(event.target.value)},
      h('option', {value: ''}, 'Select an existing role'),
      ...oidcGroupMappings(roles).map(({role}) => h('option', {key: role, value: role}, role)))),
    h('div', {className: 'flex gap-2'},
      h('button', {type: 'button', disabled: loading || saving || !selected || !Object.hasOwn(roles || {}, selected),
        className: 'border rounded px-3 py-1', onClick: () => save(false)}, saving ? 'Saving…' : 'Set default'),
      h('button', {type: 'button', disabled: loading || saving || !current,
        className: 'border rounded px-3 py-1', onClick: () => save(true)}, 'Clear default')),
    error && h('p', {role: 'alert', className: 'text-semRed-600'}, error),
    status && h('p', {role: 'status'}, status));
}

export function CommunityOidcGroups({react: React, roles, search = '', roleSync = false}) {
  const h = React.createElement;
  const mappings = oidcGroupMappings(roles, search);
  return h('section', {className: 'flex flex-col gap-3 text-sm', 'aria-label': 'OIDC group role mappings'},
    h('h2', {className: 'font-semibold'}, 'Provider groups → Parseable roles'),
    h('p', {}, 'Create roles in the Roles tab, then use the exact same names for groups in your identity provider. Include group membership in the ID token’s groups claim. Matching is case-sensitive; unknown group names grant no role.'),
    h('p', {}, 'These groups are managed by your identity provider. Each matching group grants its corresponding role. The default applies when the user has no manual or provider role. With no match or default, provider claims grant no access.'),
    roleSync && h('p', {}, 'Provider and default grants refresh on sign-in and within five minutes during an active session. Removed memberships revoke those grants. Roles explicitly assigned by an administrator remain assigned, including the same role granted by a provider group.'),
    h('div', {className: 'overflow-auto border border-coolGray-900 rounded-lg'},
      h('table', {className: 'w-full text-left'},
        h('thead', {}, h('tr', {}, h('th', {className: 'px-4 py-2'}, 'Provider group name'), h('th', {className: 'px-4 py-2'}, 'Parseable role'))),
        h('tbody', {}, ...mappings.map(({group, role}) => h('tr', {key: role},
          h('td', {className: 'px-4 py-2'}, group), h('td', {className: 'px-4 py-2'}, role)))))),
    !mappings.length && h('p', {role: 'status'}, Object.keys(roles || {}).length ? 'No roles match your search.' : 'Create a role in the Roles tab to map a provider group.'));
}

export function oidcManualRoleRemovable(summary, role) {
  const oidc = summary?.oidc;
  // Legacy users have no provenance; the server edits their assigned roles directly.
  if (oidc?.legacy === true) return true;
  return oidc?.legacy === false && Array.isArray(oidc.manualRoles) && oidc.manualRoles.includes(role);
}

export function CommunityOidcRoleInspector({react: React, api, userId, role, onInspection}) {
  const h = React.createElement;
  const [summary, setSummary] = React.useState(null);
  const [error, setError] = React.useState(null);
  React.useEffect(() => {
    let active = true;
    setSummary(null); setError(null); onInspection?.(false);
    api.get(`/api/v1/user/${encodeURIComponent(userId)}/role`).then(response => {
      if (active) { setSummary(response.data); onInspection?.(oidcManualRoleRemovable(response.data, role)); }
    }).catch(failure => { if (active) setError(oidcError(failure)); });
    return () => { active = false; };
  }, [userId, role]);
  const provenance = summary?.oidc;
  const list = values => Array.isArray(values) ? values.join(', ') || 'None' : 'Unknown';
  return h('section', {className: 'p-3 border border-coolGray-900 rounded text-sm flex flex-col gap-1', 'aria-label': 'OIDC role sources'},
    h('h3', {className: 'font-semibold'}, 'OIDC role sources'),
    error ? h('p', {role: 'alert', className: 'text-semRed-600'}, error) : !summary ? h('p', {role: 'status'}, 'Loading role sources…') :
      !provenance || provenance.legacy ? h('p', {role: 'status'}, 'Role sources are not yet available. This user must sign in again to record current provider groups.') :
        h('div', {},
          h('p', {}, `Provider groups: ${list(provenance.groups)}`),
          h('p', {}, `Roles from provider groups: ${list(provenance.providerRoles)}`),
          h('p', {}, `Roles assigned by administrators: ${list(provenance.manualRoles)}`),
          h('p', {}, `Fallback role (when no manual or provider role): ${provenance.defaultRole || 'None'}`),
          h('p', {}, `Effective direct roles: ${Object.keys(summary.roles || {}).join(', ') || 'None'}`)),
    h('p', {}, 'Assignments here are manual grants. Provider and default grants are managed through the identity provider and default role configuration.'),
    role && provenance && !provenance.legacy && h('p', {role: 'status'},
      oidcManualRoleRemovable(summary, role) ? provenance.providerRoles?.includes(role) ? 'Removing the manual grant leaves this role assigned through the provider group.' : 'This removes the administrator’s manual grant.' : 'This role has no manual grant to remove. Update the provider group or default role configuration.'));
}

// Root and route error boundaries can outlive the normal Redux/router providers.
// Keep recovery independent of application initialization and its data requests.
// Navigate at the top level so the browser follows the server's redirect to the
// provider's end-session endpoint; a fetch would leave the IdP session alive and
// /login would silently sign the same user back in. The server ends the session
// and clears its cookies before redirecting.
export function errorAccountLogout(browser = window) {
  const redirect = new URL('/login', browser.location.origin).href;
  try { browser.localStorage.removeItem('authToken'); } catch { /* storage can be unavailable */ }
  browser.location.assign(`/api/v1/o/logout?redirect=${encodeURIComponent(redirect)}`);
}

export function CommunityErrorAccountMenu({react: React, position = 'fixed'}) {
  const h = React.createElement;
  const [pending, setPending] = React.useState(false);
  const [failure, setFailure] = React.useState('');
  const signOut = async () => {
    if (pending) return;
    setPending(true);
    setFailure('');
    try { errorAccountLogout(); }
    catch (error) { setFailure(error.message || 'Sign out failed. Please try again.'); setPending(false); }
  };
  return h('details', {className: 'right-4 top-4 z-50 text-left', style: {position}, 'data-testid': 'error-account-menu'},
    h('summary', {className: 'cursor-pointer rounded-full border border-coolGray-900 bg-coolGray-950 p-2 text-coolGray-200', 'aria-label': 'Open user menu', title: 'Account', style: {display: 'flex', alignItems: 'center', justifyContent: 'center', width: 40, height: 40, listStyle: 'none', boxSizing: 'border-box'}},
      h('svg', {width: 24, height: 24, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, 'aria-hidden': true},
        h('circle', {cx: 12, cy: 8, r: 4}), h('path', {d: 'M4 21v-2a8 8 0 0 1 16 0v2'}))),
    h('div', {className: 'absolute right-0 mt-2 min-w-40 rounded-lg border border-coolGray-900 bg-coolGray-950 p-2 shadow-lg'},
      h('button', {type: 'button', disabled: pending, className: 'w-full rounded px-3 py-2 text-left text-sm text-coolGray-200 hover:bg-coolGray-900', onClick: signOut}, pending ? 'Signing out…' : 'Sign out'),
      failure && h('p', {role: 'alert', className: 'max-w-64 p-2 text-sm text-semRed-400'}, failure)));
}
