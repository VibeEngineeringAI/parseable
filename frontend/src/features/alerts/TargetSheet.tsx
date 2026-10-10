import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { Button, Input, Select, Sheet, InlineError } from '../../components/ui';
import { useApp } from '../../app/AppProvider';
import { createId } from '../../lib/ids';
import type { AlertTarget } from '../../lib/types';
import {
  buildTargetPayload,
  invalidHeader,
  targetDraft,
  validateTarget,
  type TargetDraft,
} from './targetHelpers';
import { useMutation } from '../../hooks/useMutation';
import { useTouchedErrors } from '../../hooks/useTouchedErrors';

export function TargetSheet({
  target,
  onClose,
  onSaved,
}: {
  target?: AlertTarget;
  onClose: () => void;
  onSaved: (target: AlertTarget) => void;
}) {
  const { client } = useApp();
  const [draft, setDraft] = useState(() => targetDraft(target));
  const headersError = useId();
  const headerInputs = useRef(new Map<string, HTMLInputElement>());
  const addHeader = useRef<HTMLButtonElement>(null);
  const pendingFocus = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    if (!pendingFocus.current) return;
    (headerInputs.current.get(pendingFocus.current) ?? addHeader.current)?.focus();
    pendingFocus.current = undefined;
  }, [draft.headers]);
  const mutation = useMutation();
  const invalid = validateTarget(draft);
  const shown = useTouchedErrors(invalid);
  const errors = shown.errors;
  const badHeader = errors.headers ? invalidHeader(draft.headers) : undefined;
  const headerInvalid = (index: number, field: 'key' | 'value') =>
    badHeader?.index === index && badHeader.fields.includes(field);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (shown.attempts) form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [shown.attempts]);
  function update<K extends keyof TargetDraft>(key: K, value: TargetDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }
  function close() {
    if (!mutation.pending) onClose();
  }
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={target ? 'Edit target' : 'New target'}
      description="Send alert notifications to Slack, a webhook or Alertmanager."
      dismissible={!mutation.pending}
      className="alerts-target-sheet"
    >
      <form
        ref={form}
        className="stack"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (mutation.pending) return;
          if (Object.keys(invalid).length) {
            shown.attempt();
            return;
          }
          void mutation.run(async () => {
            const body = buildTargetPayload(draft);
            const saved = target
              ? await client.updateAlertTarget(target.id, body)
              : await client.createAlertTarget(body);
            if (mutation.isActive()) {
              onSaved(saved);
              onClose();
            }
          });
        }}
      >
        <Input
          label="Target name"
          value={draft.name}
          readOnly={Boolean(target)}
          disabled={mutation.pending}
          error={errors.name}
          onBlur={() => shown.touch('name')}
          onChange={(event) => update('name', event.target.value)}
        />
        <Select
          label="Target type"
          value={draft.type}
          disabled={mutation.pending}
          onChange={(event) => update('type', event.target.value as TargetDraft['type'])}
        >
          <option value="webhook">Webhook</option>
          <option value="slack">Slack</option>
          <option value="alertManager">Alertmanager</option>
        </Select>
        {target && (
          <p className="muted">
            Endpoints are masked by the server. Re-enter the complete endpoint to save.
          </p>
        )}
        <Input
          label="Endpoint URL"
          type="url"
          autoComplete="off"
          value={draft.endpoint}
          disabled={mutation.pending}
          error={errors.endpoint}
          onBlur={() => shown.touch('endpoint')}
          hint={
            target
              ? undefined
              : draft.type === 'alertManager'
                ? 'Use the full Alertmanager endpoint, including /api/v2/alerts.'
                : 'The server checks this destination against its outbound policy.'
          }
          onChange={(event) => update('endpoint', event.target.value)}
        />
        {draft.type === 'webhook' && (
          <fieldset
            className="alerts-fieldset"
            aria-describedby={errors.headers ? headersError : undefined}
          >
            <legend>Custom headers</legend>
            <p className="muted">
              {target
                ? 'Re-enter header values; stored values are masked.'
                : 'Optional headers are kept only in this open form.'}
            </p>
            {draft.headers.map((header, index) => (
              <div className="alerts-header-row" key={header.id}>
                <Input
                  ref={(input) => {
                    if (input) headerInputs.current.set(header.id, input);
                    else headerInputs.current.delete(header.id);
                  }}
                  label={`Header ${index + 1} name`}
                  autoComplete="off"
                  value={header.key}
                  disabled={mutation.pending}
                  aria-invalid={headerInvalid(index, 'key')}
                  aria-describedby={headerInvalid(index, 'key') ? headersError : undefined}
                  onBlur={() => shown.touch('headers')}
                  onChange={(event) =>
                    update(
                      'headers',
                      draft.headers.map((row) =>
                        row.id === header.id ? { ...row, key: event.target.value } : row,
                      ),
                    )
                  }
                />
                <Input
                  label={`Header ${index + 1} value`}
                  type="password"
                  autoComplete="new-password"
                  value={header.value}
                  disabled={mutation.pending}
                  aria-invalid={headerInvalid(index, 'value')}
                  aria-describedby={headerInvalid(index, 'value') ? headersError : undefined}
                  onBlur={() => shown.touch('headers')}
                  onChange={(event) =>
                    update(
                      'headers',
                      draft.headers.map((row) =>
                        row.id === header.id ? { ...row, value: event.target.value } : row,
                      ),
                    )
                  }
                />
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={`Remove header ${index + 1}`}
                  disabled={mutation.pending}
                  onClick={() => {
                    pendingFocus.current =
                      (draft.headers[index + 1] ?? draft.headers[index - 1])?.id ?? 'add';
                    update(
                      'headers',
                      draft.headers.filter((row) => row.id !== header.id),
                    );
                  }}
                >
                  <X size={15} aria-hidden="true" />
                </Button>
              </div>
            ))}
            {errors.headers && (
              <p className="error-text" role="alert" id={headersError}>
                {errors.headers}
              </p>
            )}
            <Button
              ref={addHeader}
              size="sm"
              disabled={mutation.pending}
              onClick={() => {
                const id = createId();
                pendingFocus.current = id;
                update('headers', [...draft.headers, { id, key: '', value: '' }]);
              }}
            >
              <Plus size={14} aria-hidden="true" /> Add header
            </Button>
          </fieldset>
        )}
        {draft.type === 'alertManager' && (
          <>
            <Input
              label="Username"
              autoComplete="off"
              value={draft.username}
              disabled={mutation.pending}
              onChange={(event) => update('username', event.target.value)}
            />
            <Input
              label="Password"
              type="password"
              autoComplete="new-password"
              value={draft.password}
              disabled={mutation.pending}
              hint={
                target
                  ? 'Re-enter the password to retain basic authentication, or clear both fields.'
                  : 'Username and password must both be set, or both empty.'
              }
              error={errors.password}
              onBlur={() => shown.touch('password')}
              onChange={(event) => update('password', event.target.value)}
            />
          </>
        )}
        {draft.type !== 'slack' && (
          <label className="alerts-checkbox">
            <input
              type="checkbox"
              checked={draft.skipTls}
              disabled={mutation.pending}
              onChange={(event) => update('skipTls', event.target.checked)}
            />{' '}
            Skip TLS verification (requires server policy approval)
          </label>
        )}
        <InlineError error={mutation.error} />
        <div className="dialog-actions">
          <Button onClick={close} disabled={mutation.pending}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" data-dialog-confirm disabled={mutation.pending}>
            {mutation.pending ? 'Saving…' : target ? 'Save target' : 'Create target'}
          </Button>
        </div>
      </form>
    </Sheet>
  );
}
