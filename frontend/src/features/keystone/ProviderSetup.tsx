import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button, Input } from '../../components/ui';
import type { KeystonePageCapabilities, KeystonePageTransport } from './pageContract';

/** Key entry is sent directly to the authenticated native endpoint. No browser
 * storage, query-string, test hook or logging receives its value. */
export function ProviderSetup({
  provider,
  save,
  onSaved,
}: {
  provider: NonNullable<KeystonePageCapabilities['provider']>;
  save: NonNullable<KeystonePageTransport['saveProviderCredential']>;
  onSaved: () => void;
}) {
  const field = useRef<HTMLInputElement>(null);
  const request = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!field.current || busy || !provider.credentialEntry) return;
    const key = field.current.value.trim();
    field.current.value = '';
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setMessage(null);
    const result = await save(key, controller.signal);
    if (controller.signal.aborted) return;
    setBusy(false);
    setMessage(
      result.ok
        ? 'Credential saved. The connection will be checked when you run a question.'
        : result.message,
    );
    if (result.ok) onSaved();
  }
  return (
    <details className="ks-note" data-testid="ks-provider-setup">
      <summary>OpenRouter connection</summary>
      <p>
        {provider.model} · {provider.apiBase}
      </p>
      <p className="ks-muted">
        Your administrator chooses the model and destination. The key is encrypted on this server.
        Saving it does not run a question.
      </p>
      <form onSubmit={submit}>
        <Input
          ref={field}
          label="OpenRouter API key"
          type="password"
          autoComplete="new-password"
          minLength={8}
          maxLength={4096}
          required
          disabled={busy || !provider.credentialEntry}
        />
        <Button type="submit" disabled={busy || !provider.credentialEntry}>
          {busy ? 'Saving credential' : 'Save credential'}
        </Button>
      </form>
      {message ? <p role="status">{message}</p> : null}
    </details>
  );
}
