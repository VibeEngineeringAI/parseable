import { useCallback, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { Button, Input, Spinner } from '../../components/ui';
import { TimeRangePicker } from '../../components/explorer/TimeRangePicker';
import { useAsync } from '../../hooks/useAsync';
import { formatDuration, formatInstant } from '../../lib/keystone/context';
import { timeBounds } from '../../lib/query';
import type { TimeRange } from '../../lib/types';
import type { CreateInvestigationRequest, InvestigationSummary } from './pageContract';
import type { TransportResult } from '../../lib/keystone/transport';
import { DatasetEligibilityError, investigableName } from './eligibleDatasets';
import { requestMessage } from './readiness';

export interface NewInvestigationProps {
  /** User-defined dataset names the user can see; the server re-checks every one on save. */
  loadDatasets: (signal: AbortSignal) => Promise<string[]>;
  create: (request: CreateInvestigationRequest) => Promise<TransportResult<InvestigationSummary>>;
  onCreated: (investigation: InvestigationSummary) => void;
  /** Why saving is not possible, or null. */
  blocked: string | null;
  now?: () => number;
  createIdempotencyKey?: () => string;
}

export interface FrozenWindow {
  start: string;
  end: string;
}

const MAX_TITLE = 120;

function toSecond(ms: number) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Turns a picker range into absolute whole-second UTC bounds. Relative presets are
 * resolved once, at the moment given; the result never moves afterwards.
 */
export function freezeRange(range: TimeRange, now: number): FrozenWindow {
  const bounds = timeBounds(range, now);
  const start = Math.floor(Date.parse(bounds.startTime) / 1000) * 1000;
  const end = Math.ceil(Date.parse(bounds.endTime) / 1000) * 1000;
  return { start: toSecond(start), end: toSecond(Math.max(end, start + 1000)) };
}

export function titleFromPrompt(prompt: string) {
  const line = prompt.trim().split('\n')[0].trim();
  return line.length > MAX_TITLE ? `${line.slice(0, MAX_TITLE - 1)}…` : line;
}

function localZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function defaultKey() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `ks-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** Saves a new investigation whose first question is a draft. It never runs anything. */
export function NewInvestigation({
  loadDatasets,
  create,
  onCreated,
  blocked,
  now = Date.now,
  createIdempotencyKey = defaultKey,
}: NewInvestigationProps) {
  const promptId = useId();
  const [prompt, setPrompt] = useState('');
  const [title, setTitle] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);
  const [filter, setFilter] = useState('');
  const [range, setRange] = useState<TimeRange>('1h');
  const [frozen, setFrozen] = useState<FrozenWindow>(() => freezeRange('1h', now()));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One key per form state: retrying the same content is idempotent, and any edit
  // makes a new request rather than colliding with the earlier fingerprint.
  const key = useRef<string | null>(null);
  const edited = () => {
    key.current = null;
    setError(null);
  };

  const datasets = useAsync(useCallback((signal) => loadDatasets(signal), [loadDatasets]));
  // The loader already keeps only confirmed user-defined datasets; names that cannot
  // be scoped are still never offered.
  const names = useMemo(
    () => (datasets.data ?? []).filter(investigableName).sort(),
    [datasets.data],
  );
  const visible = filter
    ? names.filter((name) => name.toLowerCase().includes(filter.trim().toLowerCase()))
    : names;

  const effectiveTitle = title.trim() || titleFromPrompt(prompt);
  const missing = !prompt.trim()
    ? 'Enter a question.'
    : chosen.length === 0
      ? 'Choose at least one dataset.'
      : null;
  const canSave = !blocked && !missing && !saving;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSave) return;
    key.current ??= createIdempotencyKey();
    setSaving(true);
    setError(null);
    const result = await create({
      title: effectiveTitle,
      prompt: prompt.trim(),
      scope: {
        datasets: [...chosen].sort(),
        start: frozen.start,
        end: frozen.end,
        timezone: localZone(),
        filters: [],
      },
      idempotencyKey: key.current,
    });
    setSaving(false);
    if (!result.ok) {
      setError(requestMessage(result, 'create'));
      return;
    }
    key.current = null;
    onCreated(result.value);
  }

  return (
    <form
      className="ks-new"
      onSubmit={submit}
      aria-labelledby="ks-new-title"
      data-testid="ks-new-investigation"
    >
      <h2 id="ks-new-title">New investigation</h2>
      <label className="ks-field" htmlFor={promptId}>
        <span>Question</span>
        <textarea
          id={promptId}
          value={prompt}
          rows={4}
          maxLength={4000}
          placeholder="Why did checkout errors rise after the last deploy?"
          onChange={(event) => {
            setPrompt(event.target.value);
            edited();
          }}
          data-testid="ks-new-prompt"
        />
      </label>
      <Input
        label="Title"
        hint={title.trim() ? undefined : 'Defaults to the first line of the question.'}
        value={title}
        maxLength={MAX_TITLE}
        placeholder={titleFromPrompt(prompt) || 'Untitled'}
        onChange={(event) => {
          setTitle(event.target.value);
          edited();
        }}
        data-testid="ks-new-title"
      />
      <fieldset className="ks-new-datasets" data-testid="ks-new-datasets">
        <legend>Datasets</legend>
        {datasets.loading ? (
          <Spinner label="Loading datasets" />
        ) : datasets.error ? (
          <p className="ks-note" data-tone="danger" role="alert">
            {datasets.error instanceof DatasetEligibilityError
              ? datasets.error.message
              : 'Datasets could not be loaded.'}{' '}
            <Button size="sm" variant="ghost" onClick={datasets.reload}>
              Try again
            </Button>
          </p>
        ) : names.length === 0 ? (
          <p className="ks-muted">You do not have access to any datasets.</p>
        ) : (
          <>
            {names.length > 8 ? (
              <Input
                aria-label="Filter datasets"
                placeholder="Filter datasets"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              />
            ) : null}
            <div className="ks-new-dataset-list" role="group" aria-label="Datasets to investigate">
              {visible.map((name) => (
                <label key={name} className="ks-check">
                  <input
                    type="checkbox"
                    checked={chosen.includes(name)}
                    onChange={(event) => {
                      setChosen((current) =>
                        event.target.checked
                          ? [...current, name]
                          : current.filter((item) => item !== name),
                      );
                      edited();
                    }}
                  />
                  {name}
                </label>
              ))}
              {visible.length === 0 ? <p className="ks-muted">No dataset matches.</p> : null}
            </div>
          </>
        )}
      </fieldset>
      <fieldset className="ks-new-window">
        <legend>Time window</legend>
        <TimeRangePicker
          presets={[
            { value: '15m', label: 'Last 15 minutes' },
            { value: '1h', label: 'Last 1 hour' },
            { value: '6h', label: 'Last 6 hours' },
            { value: '24h', label: 'Last 24 hours' },
            { value: '7d', label: 'Last 7 days' },
            { value: '30d', label: 'Last 30 days' },
          ]}
          value={range}
          disabled={saving}
          onChange={(value) => {
            setRange(value);
            setFrozen(freezeRange(value, now()));
            edited();
          }}
        />
        <p className="ks-new-frozen" data-testid="ks-new-window">
          {formatInstant(frozen.start)} to {formatInstant(frozen.end)} (
          {formatDuration(Date.parse(frozen.end) - Date.parse(frozen.start))}). This window is fixed
          and does not move with the clock.
        </p>
        {typeof range === 'string' ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setFrozen(freezeRange(range, now()));
              edited();
            }}
            data-testid="ks-new-window-refresh"
          >
            Move window to now
          </Button>
        ) : null}
      </fieldset>
      {blocked ? (
        <p className="ks-note" data-tone="danger" data-testid="ks-new-blocked">
          {blocked}
        </p>
      ) : null}
      {error ? (
        <p className="ks-note" data-tone="danger" role="alert" data-testid="ks-new-error">
          {error}
        </p>
      ) : null}
      <div className="ks-new-actions">
        <Button type="submit" variant="primary" disabled={!canSave} data-testid="ks-new-save">
          {saving ? 'Saving' : 'Save investigation'}
        </Button>
        <p className="ks-muted">
          {missing && !blocked
            ? missing
            : 'Saving keeps the question as a draft. You run it from the investigation.'}
        </p>
      </div>
    </form>
  );
}
