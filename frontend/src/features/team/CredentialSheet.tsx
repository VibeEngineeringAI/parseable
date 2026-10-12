import { useCallback, useState, type FormEvent } from 'react';
import { Button, Input, Select, Sheet, InlineError } from '../../components/ui';
import { QueryState } from '../../components/explorer/QueryState';
import { useApp } from '../../app/AppProvider';
import { useAsync } from '../../hooks/useAsync';
import { validateName } from './helpers';
import { RoleCheckboxes, SecretResult } from './shared';
import { useMutation } from '../../hooks/useMutation';
import {
  API_KEY_MAX_TTL_SECONDS,
  customDurationBounds,
  customTtlSeconds,
  expirationPresets,
  type DurationUnit,
} from './apiKeyExpiration';

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
  const [expiration, setExpiration] = useState(String(API_KEY_MAX_TTL_SECONDS));
  const [duration, setDuration] = useState('90');
  const [durationUnit, setDurationUnit] = useState<DurationUnit>('days');
  const [expiresAt, setExpiresAt] = useState<string | null>();
  const mutation = useMutation();
  const native = kind === 'user';
  const nameError = native && name ? validateName(name) : undefined;
  const ttlSeconds =
    expiration === 'none'
      ? null
      : expiration === 'custom'
        ? customTtlSeconds(duration, durationUnit)
        : Number(expiration);
  const expirationError =
    !native && ttlSeconds === undefined
      ? 'Enter a duration from 30 minutes to 90 days, in whole seconds.'
      : undefined;
  const valid =
    !!name.trim() && (!native || !validateName(name)) && assigned.length > 0 && !expirationError;
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!valid) return;
    void mutation.run(async () => {
      if (native) {
        const result = await client.createUser(name, assigned);
        if (mutation.isActive()) setSecret(result);
      } else {
        const result = await client.createApiKey(name, assigned, ttlSeconds);
        if (mutation.isActive()) {
          setSecret(result.apiKey);
          setExpiresAt(result.expiresAt);
        }
      }
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
          {!native && (expiresAt || ttlSeconds === null) && (
            <p className="muted">
              {expiresAt ? (
                <>
                  Expires <time dateTime={expiresAt}>{new Date(expiresAt).toLocaleString()}</time>.
                </>
              ) : (
                'No expiration.'
              )}
            </p>
          )}
          {!native && ttlSeconds != null && expiresAt == null && (
            <p className="error-text" role="alert">
              The server did not apply expiration. This key does not expire; delete it if that is
              not intended.
            </p>
          )}
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
          {!native && (
            <>
              <Select
                label="Expiration"
                value={expiration}
                onChange={(event) => setExpiration(event.target.value)}
                disabled={mutation.pending}
              >
                {expirationPresets.map((preset) => (
                  <option key={preset.seconds} value={preset.seconds}>
                    {preset.label}
                  </option>
                ))}
                <option value="custom">Custom duration</option>
                <option value="none">No expiration</option>
              </Select>
              {expiration === 'custom' && (
                <>
                  <Input
                    label="Duration"
                    type="number"
                    value={duration}
                    onChange={(event) => setDuration(event.target.value)}
                    required
                    {...customDurationBounds(durationUnit)}
                    step="any"
                    error={expirationError}
                    hint="From 30 minutes to 90 days."
                    disabled={mutation.pending}
                  />
                  <Select
                    label="Duration unit"
                    value={durationUnit}
                    onChange={(event) => setDurationUnit(event.target.value as DurationUnit)}
                    disabled={mutation.pending}
                  >
                    <option value="minutes">Minutes</option>
                    <option value="hours">Hours</option>
                    <option value="days">Days</option>
                  </Select>
                </>
              )}
            </>
          )}
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
