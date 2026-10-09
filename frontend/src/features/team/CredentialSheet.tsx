import { useCallback, useState, type FormEvent } from 'react';
import { Button, Input, Sheet } from '../../components/ui';
import { QueryState } from '../../components/explorer/QueryState';
import { useApp } from '../../app/AppProvider';
import { useAsync } from '../../hooks/useAsync';
import { validateName } from './helpers';
import { InlineError, RoleCheckboxes, SecretResult, useMutation } from './shared';

export function CredentialSheet({
  kind,
  onClose,
  onChanged,
}: {
  kind: 'user' | 'apikey';
  onClose: () => void;
  onChanged: () => void;
}) {
  const { client } = useApp();
  const roles = useAsync(useCallback((signal) => client.listRoles(signal), [client]));
  const [name, setName] = useState('');
  const [assigned, setAssigned] = useState<string[]>([]);
  const [secret, setSecret] = useState<string>();
  const mutation = useMutation();
  const native = kind === 'user';
  const nameError = native && name ? validateName(name) : undefined;
  const valid = !!name.trim() && (!native || !validateName(name)) && assigned.length > 0;
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!valid) return;
    void mutation.run(async () => {
      const result = native
        ? await client.createUser(name, assigned)
        : (await client.createApiKey(name, assigned)).apiKey;
      if (mutation.isActive()) setSecret(result);
      onChanged();
    });
  }
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      dismissible={!mutation.pending}
      title={native ? 'Create new user' : 'Add API key'}
      description={
        native ? 'Create a native user and assign roles.' : 'Choose a name and roles for this key.'
      }
    >
      {secret !== undefined ? (
        <div className="stack">
          <SecretResult value={secret} kind={native ? 'password' : 'API key'} />
          <Button variant="primary" data-dialog-confirm onClick={onClose}>
            Done
          </Button>
        </div>
      ) : (
        <form className="stack" onSubmit={submit}>
          <Input
            label={native ? 'Username' : 'API key name'}
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={native ? 64 : undefined}
            required
            error={nameError}
            disabled={mutation.pending}
            autoComplete="off"
          />
          <QueryState loading={roles.loading} error={roles.error} retry={roles.reload} />
          {roles.data && (
            <RoleCheckboxes
              roles={Object.keys(roles.data).sort((a, b) => a.localeCompare(b))}
              selected={assigned}
              onChange={setAssigned}
              disabled={mutation.pending}
            />
          )}
          <p className="muted">Select at least one role.</p>
          <InlineError error={mutation.error} />
          <Button
            variant="primary"
            type="submit"
            data-dialog-confirm
            disabled={!valid || !roles.data || mutation.pending}
          >
            {mutation.pending ? 'Creating…' : native ? 'Create user' : 'Create API key'}
          </Button>
        </form>
      )}
    </Sheet>
  );
}
