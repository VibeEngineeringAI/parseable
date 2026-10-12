import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../../app/AppProvider';
import { PageHeader } from '../../components/explorer/PageHeader';
import { useLeaveGuard } from '../../hooks/useLeaveGuard';
import { ApiError } from '../../lib/apiError';
import { invalidPolicyDomain, policyLines, policyListFields } from '../../lib/networkPolicy';
import type { AlertTargetPolicy, ParseableClient } from '../../lib/types';
import './settings.css';

const labels = {
  allowedDomains: 'Allowed domains',
  allowedCidrs: 'Allowed CIDRs',
  deniedDomains: 'Denied domains',
  deniedCidrs: 'Denied CIDRs',
};
type Lists = Record<(typeof policyListFields)[number], string>;
const toLists = (policy: AlertTargetPolicy): Lists =>
  Object.fromEntries(policyListFields.map((key) => [key, policy[key].join('\n')])) as Lists;
export function NetworkAccessPage() {
  const { client, mode, session } = useApp();
  return <NetworkAccessEditor key={`${mode}-${session}`} client={client} demo={mode === 'demo'} />;
}
export function NetworkAccessEditor({
  client,
  demo = false,
}: {
  client: ParseableClient;
  demo?: boolean;
}) {
  const formId = useId();
  const fields = useRef<Partial<Record<keyof Lists, HTMLTextAreaElement | null>>>({});
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof Lists, string>>>({});
  const [saved, setSaved] = useState<AlertTargetPolicy>();
  const [draft, setDraft] = useState<AlertTargetPolicy>();
  const [lists, setLists] = useState<Lists>();
  const [error, setError] = useState<unknown>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const flight = useRef(false);
  const mounted = useRef(true);
  const dirty =
    !!saved &&
    !!draft &&
    !!lists &&
    (JSON.stringify(draft) !== JSON.stringify(saved) ||
      policyListFields.some((key) => lists[key] !== saved[key].join('\n')));
  const markSaved = useLeaveGuard(dirty, 'network policy');
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    setSaved(undefined);
    setDraft(undefined);
    setLists(undefined);
    client
      .getAlertTargetPolicy(controller.signal)
      .then((policy) => {
        if (!controller.signal.aborted) {
          setSaved(policy);
          setDraft(policy);
          setLists(toLists(policy));
        }
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(reason);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [client, attempt]);
  const forbidden = error instanceof ApiError && error.status === 403;
  function edited() {
    setSuccess(false);
    if (!forbidden) setError(undefined);
  }
  async function save() {
    if (flight.current || forbidden || !draft || !lists || !dirty) return;
    const errors: Partial<Record<keyof Lists, string>> = {};
    for (const key of ['allowedDomains', 'deniedDomains'] as const) {
      const invalid = invalidPolicyDomain(lists[key]);
      if (invalid)
        errors[key] =
          `Invalid domain: ${invalid}. Enter a plain hostname without wildcards, URLs, ports or paths.`;
    }
    setFieldErrors(errors);
    const first = policyListFields.find((key) => errors[key]);
    if (first) {
      fields.current[first]?.focus();
      return;
    }
    flight.current = true;
    setSaving(true);
    setError(undefined);
    setSuccess(false);
    const policy = { ...draft };
    for (const key of policyListFields) policy[key] = policyLines(lists[key]);
    try {
      const result = await client.putAlertTargetPolicy(policy);
      if (mounted.current) {
        markSaved();
        setSaved(result);
        setDraft(result);
        setLists(toLists(result));
        setSuccess(true);
      }
    } catch (reason) {
      if (mounted.current) setError(reason);
    } finally {
      flight.current = false;
      if (mounted.current) setSaving(false);
    }
  }
  return (
    <div className="page settings-capability-page">
      <PageHeader
        title="Network access"
        description="Manage outbound connections from alert targets."
      />
      {demo && (
        <p className="settings-demo-notice" role="status">
          Sample workspace: changes are stored locally for this session. No server policy is
          changed. Server CIDR and overlap validation is not simulated.
        </p>
      )}
      <p>
        This policy controls outbound Slack, webhook and Alertmanager delivery. Public destinations
        are allowed by default. Private destinations require both permission and an allowed domain
        or CIDR match. An allowed domain or CIDR match is also required to send Authorization
        headers, even to public targets.
      </p>
      <p>
        Domains include their subdomains. Allow and deny lists must not overlap. Policy updates are
        cached per server node; other nodes load policy on restart.
      </p>
      {loading && <p role="status">Loading network policy…</p>}
      {error !== undefined && (
        <div role="alert" className="network-policy-error">
          <strong>
            {forbidden
              ? 'Administrator permission required'
              : draft
                ? 'Could not save network policy'
                : 'Could not load network policy'}
          </strong>
          <p>
            {forbidden
              ? 'Only administrators with full server access can read or update this policy.'
              : error instanceof Error
                ? error.message
                : 'The request failed.'}
          </p>
          {!draft && !forbidden && (
            <button
              type="button"
              className="ui-button"
              onClick={() => setAttempt((value) => value + 1)}
            >
              Retry
            </button>
          )}
        </div>
      )}
      {success && (
        <p role="status">{demo ? 'Local sample policy saved.' : 'Network policy saved.'}</p>
      )}
      {draft && lists && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <fieldset disabled={saving || forbidden} className="network-policy-fields">
            <legend>Alert target policy</legend>
            <label>
              <input
                type="checkbox"
                checked={draft.allowPrivate}
                onChange={(event) => {
                  setDraft({ ...draft, allowPrivate: event.target.checked });
                  edited();
                }}
              />{' '}
              Allow private destinations
            </label>
            <p className="muted">
              An allowed domain or CIDR match is also required for private destinations.
            </p>
            {policyListFields.map((key) => (
              <div key={key} className="network-policy-list">
                <label htmlFor={`${formId}-policy-${key}`}>{labels[key]}</label>
                <textarea
                  id={`${formId}-policy-${key}`}
                  ref={(element) => {
                    fields.current[key] = element;
                  }}
                  aria-invalid={!!fieldErrors[key]}
                  rows={4}
                  value={lists[key]}
                  aria-describedby={`${formId}-help-${key}${fieldErrors[key] ? ` ${formId}-error-${key}` : ''}`}
                  onChange={(event) => {
                    setLists({ ...lists, [key]: event.target.value });
                    setFieldErrors((current) => ({ ...current, [key]: undefined }));
                    edited();
                  }}
                />
                <span id={`${formId}-help-${key}`} className="muted">
                  One {key.endsWith('Domains') ? 'domain' : 'IPv4 or IPv6 CIDR'} per line. Leave
                  empty for no entries.
                </span>
                {fieldErrors[key] && (
                  <span id={`${formId}-error-${key}`} role="alert">
                    {fieldErrors[key]}
                  </span>
                )}
              </div>
            ))}
            <label>
              <input
                type="checkbox"
                checked={draft.allowInvalidTls}
                onChange={(event) => {
                  setDraft({ ...draft, allowInvalidTls: event.target.checked });
                  edited();
                }}
              />{' '}
              Allow invalid TLS certificates
            </label>
            <p className="muted">
              Permits targets to skip TLS verification. Slack targets always require valid TLS.
            </p>
          </fieldset>
          <div className="network-policy-actions">
            <button className="ui-button" type="submit" disabled={!dirty || saving || forbidden}>
              {saving ? 'Saving…' : 'Save policy'}
            </button>
            <button
              className="ui-button"
              data-variant="secondary"
              type="button"
              disabled={!dirty || saving}
              onClick={() => {
                if (saved) {
                  markSaved();
                  setDraft(saved);
                  setLists(toLists(saved));
                  if (!forbidden) setError(undefined);
                  setFieldErrors({});
                  edited();
                }
              }}
            >
              Discard changes
            </button>
          </div>
        </form>
      )}
      <nav className="settings-related" aria-label="Related pages">
        <Link to="/team">Manage users and roles</Link>
        <Link to="/settings/llm-key">LLM settings</Link>
        <Link to="/keystone">Keystone</Link>
      </nav>
    </div>
  );
}
