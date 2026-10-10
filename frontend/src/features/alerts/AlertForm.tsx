import { useCallback, useId, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Button, Card, CardHeader, CardBody, EmptyState, Input, Select } from '../../components/ui';
import { PageHeader } from '../../components/explorer/PageHeader';
import { QueryState } from '../../components/explorer/QueryState';
import { PromqlEditor, type PromqlMetadataSource } from '../../components/promql/PromqlEditor';
import { SqlEditor } from '../sql/SqlEditor';
import { useApp } from '../../app/AppProvider';
import { useAsync } from '../../hooks/useAsync';
import { discoverMetricsDatasets, forgetMetricsDatasets } from '../../lib/metrics';
import { matcher } from '../../lib/promql';
import { alert as isAlert } from '../../lib/alertsContract';
import type { Alert } from '../../lib/types';
import { AlertPreview } from './AlertPreview';
import { TagEditor } from './TagEditor';
import { TargetSheet } from './TargetSheet';
import {
  alertDraft,
  buildAlertPayload,
  newAlertDraft,
  operators,
  severities,
  severityLabel,
  validateAlert,
  type AlertDraft,
} from './helpers';
import { InlineError, useAlertAccess, useCollection, useLeaveGuard, useMutation } from './shared';

export function AlertForm({ original }: { original?: Alert }) {
  const { client } = useApp();
  const navigate = useNavigate(),
    location = useLocation(),
    [params] = useSearchParams();
  const about = useAsync(useCallback((signal) => client.about(signal), [client]));
  const canWrite = useAlertAccess();
  const duplicateValue: unknown = location.state?.duplicate;
  const duplicate =
    isAlert(duplicateValue) && duplicateValue.queryType !== 'builder' ? duplicateValue : undefined;
  const source = original ?? duplicate;
  const promqlEnabled = about.data?.capabilities.promqlAlerts === true;
  // Keep draft row IDs stable when the shell re-renders (for example on a theme change).
  const initial = useMemo(
    () =>
      source
        ? { ...alertDraft(source), title: duplicate ? `${source.title} (Copy)` : source.title }
        : newAlertDraft(promqlEnabled, params),
    [source, duplicate, promqlEnabled, params],
  );
  return (
    <div className="page alerts-page">
      <PageHeader
        title={original ? 'Edit alert' : 'New alert'}
        description="Trigger a threshold rule for each query value."
      />
      <QueryState loading={about.loading} error={about.error} retry={about.reload} />
      {duplicateValue !== undefined && !duplicate && (
        <p className="notice">This alert cannot be duplicated. Create a new rule.</p>
      )}
      {about.data &&
        (!canWrite ? (
          <EmptyState
            title="Permission denied"
            description="Ask your administrator for permission to manage alerts."
          />
        ) : original?.queryType === 'builder' ? (
          <EmptyState
            title="Builder alerts are read-only"
            description="Editing builder alerts is not supported yet."
          />
        ) : (
          <AlertFormFields
            key={source?.id ?? location.key}
            original={original}
            source={source}
            promqlEnabled={promqlEnabled}
            initial={initial}
            onSaved={(id) => navigate(`/alerts/${encodeURIComponent(id)}`)}
          />
        ))}
    </div>
  );
}

function AlertFormFields({
  original,
  source,
  promqlEnabled,
  initial,
  onSaved,
}: {
  original?: Alert;
  source?: Alert;
  promqlEnabled: boolean;
  initial: AlertDraft;
  onSaved: (id: string) => void;
}) {
  const { client } = useApp();
  const navigate = useNavigate();
  const [draft, setDraft] = useState(initial),
    [status, setStatus] = useState(''),
    [newTarget, setNewTarget] = useState(false);
  const mutation = useMutation();
  const markSaved = useLeaveGuard(JSON.stringify(draft) !== JSON.stringify(initial));
  const datasets = useAsync(useCallback((signal) => client.listDatasets(signal), [client]));
  const metrics = useAsync(
    useCallback(
      (signal) =>
        draft.type === 'promql' && promqlEnabled
          ? discoverMetricsDatasets(client, signal)
          : Promise.resolve({ datasets: [], unchecked: [] }),
      [client, draft.type, promqlEnabled],
    ),
  );
  const targets = useCollection(useCallback((signal) => client.listAlertTargets(signal), [client]));
  const queryMessage = useId(),
    targetsMessage = useId();
  const previewButton = useRef<HTMLButtonElement>(null);
  const errors = validateAlert(draft, promqlEnabled);
  if (
    targets.data &&
    draft.targets.some((id) => !targets.data!.some(({ target }) => target.id === id))
  )
    errors.targets = 'Remove unavailable targets or select existing targets.';
  const choices = draft.type === 'promql' ? (metrics.data?.datasets ?? []) : (datasets.data ?? []);
  const unchecked = draft.type === 'promql' ? (metrics.data?.unchecked ?? []) : [];
  // Keep completion scoped to the selected dataset; changing the query does not reset it.
  const metadata = useMemo<PromqlMetadataSource>(
    () => ({
      metricNames: async (signal) =>
        (await client.promqlLabelValues('__name__', { stream: draft.dataset, limit: 1000 }, signal))
          .data,
      labelNames: async (metric, signal) =>
        (
          await client.promqlLabels(
            {
              stream: draft.dataset,
              limit: 1000,
              ...(metric ? { match: [`{${matcher('__name__', metric)}}`] } : {}),
            },
            signal,
          )
        ).data,
      labelValues: async (label, metric, signal) =>
        (
          await client.promqlLabelValues(
            label,
            {
              stream: draft.dataset,
              limit: 1000,
              ...(metric ? { match: [`{${matcher('__name__', metric)}}`] } : {}),
            },
            signal,
          )
        ).data,
    }),
    [client, draft.dataset],
  );
  function update<K extends keyof AlertDraft>(key: K, value: AlertDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }
  const unverified =
    !metrics.loading &&
    draft.type === 'promql' &&
    Boolean(draft.dataset) &&
    !choices.some((item) => item.name === draft.dataset);
  // The server checks the dataset again on save, so a dataset that could not be checked, or the
  // one the alert already runs on, only warns.
  const datasetError =
    errors.dataset ??
    (unverified && !unchecked.includes(draft.dataset) && draft.dataset !== original?.datasets[0]
      ? 'Select an OTLP metrics dataset.'
      : undefined);
  const canSubmit =
    !Object.keys(errors).length &&
    !datasetError &&
    !mutation.pending &&
    !datasets.loading &&
    !metrics.loading &&
    !targets.loading &&
    !datasets.error &&
    !metrics.error &&
    !targets.error;
  const invalidPreview = Boolean(
    errors.query ||
    errors.dataset ||
    datasetError ||
    errors.threshold ||
    errors.operator ||
    errors.window ||
    errors.type,
  );
  return (
    <form
      className="alerts-form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (!canSubmit) return;
        void mutation.run(async () => {
          const body = buildAlertPayload(draft, source);
          const saved = original
            ? await client.updateAlert(original.id, body)
            : await client.createAlert(body);
          if (mutation.isActive()) {
            markSaved();
            onSaved(saved.id);
          }
        });
      }}
    >
      <div className="stack">
        <Card>
          <CardHeader>
            <h2>Rule</h2>
          </CardHeader>
          <CardBody className="stack">
            <div className="alerts-fields">
              <Select
                label="Alert type"
                value={draft.type}
                disabled={Boolean(original) || mutation.pending}
                error={errors.type}
                onChange={(event) => {
                  update('type', event.target.value as AlertDraft['type']);
                  update('dataset', '');
                  update('query', '');
                }}
              >
                {promqlEnabled && <option value="promql">PromQL threshold</option>}
                {!promqlEnabled && draft.type === 'promql' && (
                  <option value="promql" disabled>
                    PromQL (unavailable)
                  </option>
                )}
                <option value="code">SQL threshold</option>
              </Select>
              <Select
                label="Dataset"
                value={draft.dataset}
                disabled={Boolean(original) || mutation.pending}
                error={datasetError}
                hint={
                  unverified
                    ? 'This dataset could not be verified as OTLP metrics. The server validates it on save.'
                    : draft.type === 'promql'
                      ? 'Only OTLP metrics datasets support PromQL.'
                      : 'SQL can query any accessible dataset.'
                }
                onChange={(event) => update('dataset', event.target.value)}
              >
                <option value="">Select a dataset</option>
                {draft.dataset &&
                  !choices.some((item) => item.name === draft.dataset) &&
                  !unchecked.includes(draft.dataset) && (
                    <option value={draft.dataset}>{draft.dataset}</option>
                  )}
                {choices.map((item) => (
                  <option key={item.name} value={item.name}>
                    {item.name}
                  </option>
                ))}
                {unchecked.map((name) => (
                  <option key={name} value={name}>
                    {name} (not verified)
                  </option>
                ))}
              </Select>
            </div>
            <QueryState
              loading={datasets.loading || metrics.loading}
              error={datasets.error ?? metrics.error}
              retry={() => {
                forgetMetricsDatasets(client);
                datasets.reload();
                metrics.reload();
              }}
            />
            {metrics.data?.unchecked.length ? (
              <p className="notice" role="status">
                Some datasets could not be checked: {metrics.data.unchecked.join(', ')}.{' '}
                <Button
                  size="sm"
                  onClick={() => {
                    forgetMetricsDatasets(client);
                    metrics.reload();
                  }}
                >
                  Check again
                </Button>
              </p>
            ) : null}
            {draft.type === 'promql' ? (
              <PromqlEditor
                value={draft.query}
                onChange={(value) => update('query', value)}
                metadata={draft.dataset ? metadata : undefined}
                invalid={Boolean(errors.query)}
                describedBy={queryMessage}
                readOnly={mutation.pending}
                onRun={() => previewButton.current?.click()}
              />
            ) : (
              <SqlEditor
                value={draft.query}
                onChange={(value) => update('query', value)}
                invalid={Boolean(errors.query)}
                describedBy={queryMessage}
                readOnly={mutation.pending}
                onRun={() => previewButton.current?.click()}
              />
            )}
            <p
              id={queryMessage}
              className={errors.query ? 'error-text' : 'muted'}
              role={errors.query ? 'alert' : undefined}
            >
              {errors.query
                ? errors.query
                : draft.type === 'promql'
                  ? 'Use an instant-vector expression. Each series is evaluated independently.'
                  : 'Use exactly one numeric aggregate expression, optionally with GROUP BY; subqueries are not supported. The server validates the query on save.'}
            </p>
          </CardBody>
        </Card>
        <Card>
          <CardHeader>
            <h2>Threshold and evaluation</h2>
          </CardHeader>
          <CardBody className="stack">
            <div className="alerts-fields">
              <Select
                label="Threshold operator"
                value={draft.operator}
                disabled={mutation.pending}
                error={errors.operator}
                onChange={(event) =>
                  update('operator', event.target.value as AlertDraft['operator'])
                }
              >
                {operators.map((operator) => (
                  <option key={operator} value={operator}>
                    {operator}
                  </option>
                ))}
              </Select>
              <Input
                label="Threshold value"
                type="number"
                step="any"
                value={draft.threshold}
                disabled={mutation.pending}
                error={errors.threshold}
                onChange={(event) => update('threshold', event.target.value)}
              />
              <Input
                label="Evaluation frequency (minutes)"
                type="number"
                min={1}
                max={draft.type === 'promql' ? 1440 : undefined}
                step={1}
                value={draft.frequency}
                disabled={mutation.pending}
                error={errors.frequency}
                onChange={(event) => update('frequency', event.target.value)}
              />
              <Input
                label="Evaluation window"
                value={draft.window}
                disabled={mutation.pending}
                hint={
                  draft.type === 'promql'
                    ? 'Required by the server; PromQL evaluates the current instant.'
                    : 'Query the last duration, for example 10m or 1h.'
                }
                error={errors.window}
                onChange={(event) => update('window', event.target.value)}
              />
            </div>
            {draft.type === 'promql' && (
              <>
                <Input
                  label="Hold duration"
                  value={draft.hold}
                  disabled={mutation.pending}
                  hint="Continuous breach duration; 0s fires immediately. Maximum 30 days."
                  error={errors.hold}
                  onChange={(event) => update('hold', event.target.value)}
                />
                <p className="muted">
                  Missing data retains firing state and resets pending duration. Evaluation errors
                  do not report recovery. Notifications are sent on firing and recovery transitions,
                  with at most three delivery attempts.
                </p>
              </>
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader>
            <h2>Targets</h2>
          </CardHeader>
          <CardBody className="stack">
            <QueryState
              loading={targets.loading && !targets.data}
              error={targets.error}
              retry={targets.reload}
            />
            <fieldset
              className="alerts-fieldset"
              disabled={mutation.pending}
              aria-describedby={targetsMessage}
            >
              <legend>Notification targets</legend>
              <div className="alerts-target-picker">
                {targets.data?.map(({ target, enabled, error }) => (
                  <label className="alerts-checkbox" key={target.id}>
                    <input
                      type="checkbox"
                      checked={draft.targets.includes(target.id)}
                      disabled={!enabled && !draft.targets.includes(target.id)}
                      onChange={(event) =>
                        update(
                          'targets',
                          event.target.checked
                            ? [...draft.targets, target.id]
                            : draft.targets.filter((id) => id !== target.id),
                        )
                      }
                    />{' '}
                    <span>
                      {target.name}
                      {!enabled && <span className="muted"> — Disabled: {error}</span>}
                    </span>
                  </label>
                ))}
                {draft.targets
                  .filter(
                    (id) => targets.data && !targets.data.some(({ target }) => target.id === id),
                  )
                  .map((id) => (
                    <label className="alerts-checkbox" key={id}>
                      <input
                        type="checkbox"
                        checked
                        onChange={() =>
                          update(
                            'targets',
                            draft.targets.filter((value) => value !== id),
                          )
                        }
                      />
                      Unavailable target {id}
                    </label>
                  ))}
                {targets.data && !targets.data.length && <p className="muted">No targets yet.</p>}
              </div>
            </fieldset>
            <p
              id={targetsMessage}
              className={errors.targets ? 'error-text' : 'muted'}
              role={errors.targets ? 'alert' : undefined}
            >
              {errors.targets ??
                (!draft.targets.length
                  ? 'State tracking only: no notifications until a target is selected.'
                  : 'Notify the selected targets when the threshold rule triggers.')}
            </p>
            <div>
              <Button onClick={() => setNewTarget(true)} disabled={mutation.pending}>
                New target
              </Button>
            </div>
          </CardBody>
        </Card>
        <Card>
          <CardHeader>
            <h2>Alert information</h2>
          </CardHeader>
          <CardBody className="stack">
            <Input
              label="Title"
              value={draft.title}
              disabled={mutation.pending}
              error={errors.title}
              onChange={(event) => update('title', event.target.value)}
            />
            <Select
              label="Severity"
              value={draft.severity}
              disabled={mutation.pending}
              onChange={(event) => update('severity', event.target.value as AlertDraft['severity'])}
            >
              {severities.map((severity) => (
                <option key={severity} value={severity}>
                  {severityLabel(severity)}
                </option>
              ))}
            </Select>
            <TagEditor
              tags={draft.tags}
              disabled={mutation.pending}
              onChange={(tags) => update('tags', tags)}
            />
          </CardBody>
        </Card>
        <InlineError error={mutation.error} />
        <p role="status" className="muted alerts-status">
          {status}
        </p>
        <div className="alerts-form-footer">
          {original?.queryType === 'promql' && (
            <p className="muted">
              Saving resets per-series runtime state and makes you the execution owner.
            </p>
          )}
          <div className="dialog-actions">
            <Button
              disabled={mutation.pending}
              onClick={() =>
                navigate(original ? `/alerts/${encodeURIComponent(original.id)}` : '/alerts')
              }
            >
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!canSubmit}>
              {mutation.pending ? 'Saving…' : original ? 'Save alert' : 'Create alert'}
            </Button>
          </div>
        </div>
      </div>
      {/* Changing query inputs clears stale preview results and cancels any pending request. */}
      <AlertPreview
        key={JSON.stringify([
          draft.type,
          draft.dataset,
          draft.query,
          draft.operator,
          draft.threshold,
          draft.window,
        ])}
        draft={draft}
        disabled={invalidPreview || mutation.pending}
        buttonRef={previewButton}
      />
      {newTarget && (
        <TargetSheet
          onClose={() => setNewTarget(false)}
          onSaved={(target) => {
            setStatus(`${target.name}: Target created and selected.`);
            update('targets', [...draft.targets, target.id]);
            targets.reload();
          }}
        />
      )}
    </form>
  );
}
