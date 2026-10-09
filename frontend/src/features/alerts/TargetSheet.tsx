import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import { Button, Input, Select, Sheet } from '../../components/ui';
import { useApp } from '../../app/AppProvider';
import { createId } from '../../lib/ids';
import type { AlertTarget } from '../../lib/types';
import { buildTargetPayload, targetDraft, validateTarget, type TargetDraft } from './targetHelpers';
import { InlineError, useMutation } from './shared';

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
  const [touched, setTouched] = useState(false);
  const mutation = useMutation();
  const errors = validateTarget(draft);
  function update<K extends keyof TargetDraft>(key: K, value: TargetDraft[K]) {
    setTouched(true);
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
        className="stack"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setTouched(true);
          if (Object.keys(errors).length) return;
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
          error={touched ? errors.name : undefined}
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
        <Input
          label="Endpoint URL"
          type="url"
          autoComplete="off"
          value={draft.endpoint}
          disabled={mutation.pending}
          error={touched ? errors.endpoint : undefined}
          hint={
            target
              ? 'Endpoints are masked by the server. Re-enter the complete endpoint to save.'
              : draft.type === 'alertManager'
                ? 'Use the full Alertmanager endpoint, including /api/v2/alerts.'
                : 'The server checks this destination against its outbound policy.'
          }
          onChange={(event) => update('endpoint', event.target.value)}
        />
        {draft.type === 'webhook' && (
          <fieldset
            className="alerts-fieldset"
            aria-describedby={errors.headers && touched ? 'target-headers-error' : undefined}
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
                  label={`Header ${index + 1} name`}
                  autoComplete="off"
                  value={header.key}
                  disabled={mutation.pending}
                  aria-invalid={Boolean(errors.headers && touched)}
                  aria-describedby={errors.headers && touched ? 'target-headers-error' : undefined}
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
                  aria-invalid={Boolean(errors.headers && touched)}
                  aria-describedby={errors.headers && touched ? 'target-headers-error' : undefined}
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
                  onClick={() =>
                    update(
                      'headers',
                      draft.headers.filter((row) => row.id !== header.id),
                    )
                  }
                >
                  <X size={15} aria-hidden="true" />
                </Button>
              </div>
            ))}
            {touched && errors.headers && (
              <p className="error-text" role="alert" id="target-headers-error">
                {errors.headers}
              </p>
            )}
            <Button
              size="sm"
              disabled={mutation.pending}
              onClick={() =>
                update('headers', [...draft.headers, { id: createId(), key: '', value: '' }])
              }
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
              error={touched ? errors.password : undefined}
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
          <Button
            type="submit"
            variant="primary"
            data-dialog-confirm
            disabled={mutation.pending || Object.keys(errors).length > 0}
          >
            {mutation.pending ? 'Saving…' : target ? 'Save target' : 'Create target'}
          </Button>
        </div>
      </form>
    </Sheet>
  );
}
