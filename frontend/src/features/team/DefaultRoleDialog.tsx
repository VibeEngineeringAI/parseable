import { useCallback, useState } from 'react';
import { Button, Dialog, Select } from '../../components/ui';
import { useApp } from '../../app/AppProvider';
import { useAsync } from '../../hooks/useAsync';
import type { Roles } from '../../lib/types';
import { InlineError, useMutation } from './shared';

export function DefaultRoleDialog({
  roles,
  onClose,
  onChanged,
}: {
  roles: Roles;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { client } = useApp();
  const current = useAsync(useCallback((signal) => client.defaultRole(signal), [client]));
  const [choice, setChoice] = useState<string>();
  const selected = choice ?? current.data ?? '';
  const mutation = useMutation();
  function save(clear: boolean) {
    void mutation.run(async () => {
      if (clear) await client.clearDefaultRole();
      else await client.setDefaultRole(selected);
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
      title="Default OIDC role"
    >
      <div className="stack">
        <p>
          The default role applies when an OIDC user has no manual role and no matching provider
          role. Choose a role with the minimum access those users need.
        </p>
        <p role="status">
          {current.loading
            ? 'Loading default role…'
            : `Current default: ${current.error ? 'Unknown' : current.data || 'None'}`}
        </p>
        <Select
          label="Default role"
          value={selected}
          disabled={current.loading || mutation.pending}
          onChange={(event) => setChoice(event.target.value)}
        >
          <option value="">Select an existing role</option>
          {Object.keys(roles)
            .sort((a, b) => a.localeCompare(b))
            .map((name) => (
              <option key={name}>{name}</option>
            ))}
        </Select>
        <InlineError error={mutation.error || current.error?.message} />
        <div className="inline">
          <Button
            variant="primary"
            onClick={() => save(false)}
            data-dialog-confirm
            disabled={
              current.loading || mutation.pending || !selected || !Object.hasOwn(roles, selected)
            }
          >
            Set default
          </Button>
          <Button
            onClick={() => save(true)}
            disabled={current.loading || mutation.pending || !current.data}
          >
            Clear default
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
