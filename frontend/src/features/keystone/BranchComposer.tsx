import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { Button, Spinner } from '../../components/ui';
import {
  branchEligibility,
  formatDuration,
  formatInstant,
  scopeDiff,
  type ScopeDiff,
} from '../../lib/keystone/context';
import {
  CONTEXT_POLICY,
  type CreateNodeRequest,
  type GraphNode,
  type PinnedParentExport,
  type ScopeVersion,
} from '../../lib/keystone/types';

export type ExportState =
  | { state: 'loading' }
  | { state: 'ready'; pinned: PinnedParentExport }
  | { state: 'error'; message: string };

/**
 * `exportedEvidenceIds` names the parent sources the user explicitly chose to pass
 * on. The server re-authorizes each one; unselected sources never reach the child.
 */
export type BranchDraft = Omit<CreateNodeRequest, 'idempotencyKey' | 'expectedSemanticRevision'> & {
  exportedEvidenceIds: string[];
};

export interface BranchComposerProps {
  intent: 'follow_up' | 'explore';
  /** The parent as it is now in the graph; may have moved past the pinned version. */
  parent: GraphNode;
  exported: ExportState;
  /** Datasets the caller may query; the server re-checks on submit. */
  availableDatasets: string[];
  /** Explicit reason runs cannot start, or null. Never replaced by a simulated result. */
  gated: string | null;
  submitting: boolean;
  submitError: string | null;
  onSubmit: (draft: BranchDraft) => void;
  onCancel: () => void;
  /** Saves the question without running it; it runs only when the user asks. */
  saveAsDraft?: boolean;
}

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const ALWAYS_OMITTED = [
  'Questions and answers above the parent',
  'Other branches, including the parent’s other follow-ups',
  'The parent run’s working history and tool transcript',
];

function ContextPreview({
  pinned,
  parent,
  selected,
  onToggle,
}: {
  pinned: PinnedParentExport;
  parent: GraphNode;
  selected: readonly string[];
  onToggle: (id: string, include: boolean) => void;
}) {
  const value = pinned.value;
  const included = value.evidence.filter((item) => selected.includes(item.id));
  const left = value.evidence.filter((item) => !selected.includes(item.id));
  const omitted = [
    ...ALWAYS_OMITTED,
    ...value.omitted.filter((item) => !ALWAYS_OMITTED.includes(item)),
    ...left.map((item) => `Source not selected: ${item.title}`),
  ];
  const duration = Date.parse(value.scope.end) - Date.parse(value.scope.start);
  return (
    <section
      className="ks-context"
      aria-labelledby="ks-context-title"
      data-testid="ks-context-preview"
    >
      <h3 id="ks-context-title">Context for this question</h3>
      <p className="ks-muted">
        The new question sees only what its direct parent exported, fixed at version{' '}
        {value.parentVersion} when you opened this form.
      </p>
      {parent.version !== value.parentVersion ? (
        <p className="ks-note" data-tone="warning" data-testid="ks-parent-moved">
          The parent changed to version {parent.version} after you opened this form. This question
          still uses version {value.parentVersion}.
        </p>
      ) : null}
      <div className="ks-context-grid">
        <div>
          <h4>Included</h4>
          <ul data-testid="ks-context-included">
            <li>
              Parent question: <q>{value.prompt}</q>
            </li>
            <li>
              Parent answer: <q>{value.answer}</q>
            </li>
            <li>
              Approved scope: {value.scope.datasets.join(', ')}, {formatInstant(value.scope.start)}{' '}
              to {formatInstant(value.scope.end)} ({formatDuration(duration)})
            </li>
            {included.length ? (
              included.map((item) => <li key={item.id}>Source: {item.title}</li>)
            ) : (
              <li>No sources selected</li>
            )}
          </ul>
        </div>
        <div>
          <h4>Not included</h4>
          <ul data-testid="ks-context-omitted">
            {omitted.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      </div>
      {value.evidence.length ? (
        <fieldset className="ks-evidence-pick" data-testid="ks-context-sources">
          <legend>Sources to pass on</legend>
          <p className="ks-muted">Only the sources you select are shared with the new question.</p>
          {value.evidence.map((item) => (
            <label key={item.id} className="ks-check">
              <input
                type="checkbox"
                checked={selected.includes(item.id)}
                onChange={(event) => onToggle(item.id, event.target.checked)}
                data-testid={`ks-context-source-${item.id}`}
              />
              {item.title}
            </label>
          ))}
        </fieldset>
      ) : null}
      {value.truncated ? (
        <p className="ks-note" data-tone="warning">
          The parent export was shortened to fit the context limit.
        </p>
      ) : null}
      <details className="ks-sql">
        <summary>
          Exact parent export (
          <code data-testid="ks-context-hash">
            {(value.exportHash ?? pinned.sha256).slice(0, 12)}
          </code>
          )
        </summary>
        <pre data-testid="ks-context-bytes">
          <code>{pinned.bytes}</code>
        </pre>
      </details>
    </section>
  );
}

function ScopeDiffReview({ diff }: { diff: ScopeDiff }) {
  const lines: string[] = [];
  if (diff.startChanged || diff.endChanged) {
    const comparison =
      diff.childDurationMs > diff.parentDurationMs
        ? 'wider'
        : diff.childDurationMs < diff.parentDurationMs
          ? 'narrower'
          : 'same length, moved';
    lines.push(
      `Time window: ${formatDuration(diff.parentDurationMs)} to ${formatDuration(diff.childDurationMs)} (${comparison})`,
    );
  }
  if (diff.datasetsAdded.length) lines.push(`Datasets added: ${diff.datasetsAdded.join(', ')}`);
  if (diff.datasetsRemoved.length)
    lines.push(`Datasets removed: ${diff.datasetsRemoved.join(', ')}`);
  if (diff.filtersAdded.length) lines.push(`Filters added: ${diff.filtersAdded.join('; ')}`);
  if (diff.filtersRemoved.length) lines.push(`Filters removed: ${diff.filtersRemoved.join('; ')}`);
  if (diff.timezoneChanged) lines.push('Display time zone changed');
  return (
    <div className="ks-scope-diff" data-testid="ks-scope-diff" data-widens={diff.widens}>
      <h4>Scope change</h4>
      <ul>
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      {diff.widens ? (
        <p className="ks-note" data-tone="warning">
          This reads data the parent did not. The server checks your access again before running.
        </p>
      ) : null}
    </div>
  );
}

export function BranchComposer({
  intent,
  parent,
  exported,
  availableDatasets,
  gated,
  submitting,
  submitError,
  onSubmit,
  onCancel,
  saveAsDraft = false,
}: BranchComposerProps) {
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const promptId = useId();
  const [prompt, setPrompt] = useState('');
  const [changing, setChanging] = useState(false);
  const [approved, setApproved] = useState(false);
  const [sources, setSources] = useState<string[]>([]);
  const pinned = exported.state === 'ready' ? exported.pinned : null;
  const parentScope = pinned?.value.scope;
  const [draftScope, setDraftScope] = useState<Omit<ScopeVersion, 'id'> | null>(null);

  useEffect(() => promptRef.current?.focus(), []);
  useEffect(() => {
    if (parentScope && !draftScope) {
      const { id: _id, ...rest } = parentScope;
      setDraftScope(rest);
    }
  }, [parentScope, draftScope]);

  const validTimes =
    !!draftScope &&
    INSTANT.test(draftScope.start) &&
    INSTANT.test(draftScope.end) &&
    Date.parse(draftScope.end) > Date.parse(draftScope.start);
  const diff = useMemo(
    () =>
      parentScope && draftScope && validTimes && changing
        ? scopeDiff(parentScope, draftScope)
        : null,
    [parentScope, draftScope, validTimes, changing],
  );
  const eligibility = pinned ? branchEligibility(pinned.value) : null;
  const blocked =
    gated ??
    (eligibility && eligibility.kind !== 'ok'
      ? eligibility.kind === 'parent_active'
        ? 'The parent is still running. Branch once it has a completed answer.'
        : eligibility.kind === 'no_answer'
          ? 'The parent has no answer to follow up on.'
          : `The parent ended as ${eligibility.status}. Branch from a completed answer.`
      : null);
  const scopeReady =
    !changing ||
    (validTimes && (draftScope?.datasets.length ?? 0) > 0 && (!diff?.changed || approved));
  const canSubmit = !!pinned && !blocked && prompt.trim().length > 0 && scopeReady && !submitting;
  const datasets = Array.from(new Set([...(parentScope?.datasets ?? []), ...availableDatasets]));

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit || !pinned) return;
    onSubmit({
      parentNodeId: pinned.value.parentNodeId,
      parentVersion: pinned.value.parentVersion,
      // The server's own export hash when it provides one; the browser hash of the
      // preview JSON is used only by servers without a native export hash.
      parentExportSha256: pinned.value.exportHash ?? pinned.sha256,
      contextPolicy: CONTEXT_POLICY,
      intent,
      prompt: prompt.trim(),
      scope: changing && diff?.changed && draftScope ? draftScope : null,
      // Sources are listed in export order, and only ones this export contains.
      exportedEvidenceIds: pinned.value.evidence
        .map((item) => item.id)
        .filter((id) => sources.includes(id)),
    });
  }

  return (
    <form
      className="ks-composer"
      onSubmit={submit}
      data-testid="ks-composer"
      data-intent={intent}
      aria-labelledby="ks-composer-title"
    >
      <h2 id="ks-composer-title">
        {intent === 'follow_up' ? 'Follow up on answer' : 'Explore another angle'}
      </h2>
      <p className="ks-muted">
        From <strong>{parent.title}</strong>
      </p>
      {exported.state === 'loading' ? (
        <Spinner label="Loading parent context" />
      ) : exported.state === 'error' ? (
        <p className="ks-note" data-tone="danger" role="alert">
          {exported.message}
        </p>
      ) : (
        <ContextPreview
          pinned={exported.pinned}
          parent={parent}
          selected={sources}
          onToggle={(id, include) =>
            setSources((current) =>
              include ? [...current, id] : current.filter((item) => item !== id),
            )
          }
        />
      )}
      <label className="ks-field" htmlFor={promptId}>
        <span>Question</span>
        <textarea
          ref={promptRef}
          id={promptId}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          rows={3}
          maxLength={4000}
          data-testid="ks-composer-prompt"
        />
      </label>
      {pinned && draftScope ? (
        <fieldset className="ks-scope-editor">
          <legend>Scope</legend>
          <label className="ks-check">
            <input
              type="checkbox"
              checked={changing}
              onChange={(event) => {
                setChanging(event.target.checked);
                setApproved(false);
                if (!event.target.checked && parentScope) {
                  const { id: _id, ...rest } = parentScope;
                  setDraftScope(rest);
                }
              }}
              data-testid="ks-scope-change-toggle"
            />
            Change scope for this question
          </label>
          {!changing ? (
            <p className="ks-muted" data-testid="ks-scope-inherited">
              Keeps the parent’s approved scope:{' '}
              {formatDuration(Date.parse(draftScope.end) - Date.parse(draftScope.start))} of{' '}
              {draftScope.datasets.join(', ')}.
            </p>
          ) : (
            <>
              <div className="ks-scope-datasets" role="group" aria-label="Datasets">
                {datasets.map((dataset) => (
                  <label key={dataset} className="ks-check">
                    <input
                      type="checkbox"
                      checked={draftScope.datasets.includes(dataset)}
                      onChange={(event) => {
                        setApproved(false);
                        setDraftScope({
                          ...draftScope,
                          datasets: event.target.checked
                            ? [...draftScope.datasets, dataset]
                            : draftScope.datasets.filter((item) => item !== dataset),
                        });
                      }}
                    />
                    {dataset}
                  </label>
                ))}
              </div>
              <div className="ks-scope-times">
                <label className="ks-field">
                  <span>Start (UTC)</span>
                  <input
                    className="ui-input"
                    value={draftScope.start}
                    onChange={(event) => {
                      setApproved(false);
                      setDraftScope({ ...draftScope, start: event.target.value.trim() });
                    }}
                    aria-invalid={!validTimes || undefined}
                    data-testid="ks-scope-start"
                  />
                </label>
                <label className="ks-field">
                  <span>End (UTC)</span>
                  <input
                    className="ui-input"
                    value={draftScope.end}
                    onChange={(event) => {
                      setApproved(false);
                      setDraftScope({ ...draftScope, end: event.target.value.trim() });
                    }}
                    aria-invalid={!validTimes || undefined}
                    data-testid="ks-scope-end"
                  />
                </label>
              </div>
              {!validTimes ? (
                <p className="ks-note" data-tone="danger">
                  Enter start and end as 2026-10-13T14:00:00Z, with the end after the start.
                </p>
              ) : null}
              {diff?.changed ? (
                <>
                  <ScopeDiffReview diff={diff} />
                  <label className="ks-check">
                    <input
                      type="checkbox"
                      checked={approved}
                      onChange={(event) => setApproved(event.target.checked)}
                      data-testid="ks-scope-approve"
                    />
                    Approve this scope change
                  </label>
                </>
              ) : validTimes ? (
                <p className="ks-muted">No change from the parent scope yet.</p>
              ) : null}
            </>
          )}
        </fieldset>
      ) : null}
      {blocked ? (
        <p className="ks-note" data-tone="danger" data-testid="ks-gated">
          {blocked}
        </p>
      ) : null}
      {submitError ? (
        <p className="ks-note" data-tone="danger" role="alert" data-testid="ks-submit-error">
          {submitError}
        </p>
      ) : null}
      {saveAsDraft ? (
        <p className="ks-muted" data-testid="ks-composer-draft-note">
          Saving does not run the question. Run it from the question once it is saved.
        </p>
      ) : null}
      <div className="ks-composer-actions">
        <Button
          type="submit"
          variant="primary"
          disabled={!canSubmit}
          data-testid="ks-composer-submit"
        >
          {saveAsDraft
            ? submitting
              ? 'Saving'
              : 'Save question'
            : submitting
              ? 'Asking'
              : 'Ask question'}
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}
