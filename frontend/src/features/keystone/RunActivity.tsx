import { forwardRef, useEffect, useState } from 'react';
import { Check, Circle, CircleDot, CircleX, Minus } from 'lucide-react';
import { Button } from '../../components/ui';
import { isTerminal } from '../../lib/keystone/streaming';
import type { NodeStatus } from '../../lib/keystone/types';
import { isPlainClick } from './runLink';
import { runSteps, type RunLog, type StepKey, type StepState } from './runProgress';
import { statusLabel } from './StatusBadge';

export type FollowStatus = 'following' | 'ended' | 'unavailable';

export interface RunActivityProps {
  status: NodeStatus;
  runId: string;
  log: RunLog;
  /** Whether this page is reading the run's events; null when it never started. */
  follow: FollowStatus | null;
  /** Why live events stopped, when they did. */
  streamNote: string | null;
  /** A shareable URL selecting this question and run, or null where links are not routed. */
  href: string | null;
  /** Handles a plain click on the link in place, without reloading the page. */
  onOpenLink: () => void;
  /** Starts or resumes reading events after an interruption. */
  onReconnect?: () => void;
  /** Replays a finished run's recorded events so its steps can be shown. */
  onLoadHistory?: () => void;
  /** Set when a link named a run that is no longer this question's current run. */
  staleRunId?: string | null;
}

const STEP_LABELS: Record<StepKey, string> = {
  queued: 'Queued',
  reading: 'Reading data',
  answering: 'Writing answer',
  outcome: 'Result',
};

function stepDetail(key: StepKey, state: StepState, status: NodeStatus): string {
  if (state === 'unknown') return 'Not recorded on this page.';
  if (state === 'pending' && key !== 'outcome' && isTerminal(status)) return 'Not reached.';
  switch (key) {
    case 'queued':
      return state === 'current'
        ? 'The server accepted this run and starts it when an execution slot is free. It does not report a queue position.'
        : state === 'stopped'
          ? 'Ended before it started.'
          : state === 'pending'
            ? 'Waiting.'
            : 'Accepted by the server.';
    case 'reading':
      return state === 'current'
        ? status === 'resolving_scope'
          ? 'Checking the approved scope before reading sample data.'
          : status === 'awaiting_confirmation'
            ? 'Waiting for scope confirmation before reading data.'
            : 'Reading sample rows from each dataset in scope. Sources are listed below as each read finishes.'
        : state === 'stopped'
          ? 'Ended while reading data.'
          : state === 'pending'
            ? 'Not started.'
            : 'Sample rows read.';
    case 'answering':
      return state === 'current'
        ? 'Waiting for the model. The answer arrives in one piece, so no partial text is shown meanwhile.'
        : state === 'stopped'
          ? 'Ended before the answer arrived.'
          : state === 'pending'
            ? 'Not started.'
            : 'Answer received.';
    case 'outcome':
      return isTerminal(status)
        ? status === 'completed'
          ? 'The answer is saved. You can follow up on it.'
          : `${statusLabel(status)}. Only a completed answer can be followed up.`
        : 'The outcome appears here when the run finishes.';
  }
}

function StepIcon({ state }: { state: StepState }) {
  const props = { 'aria-hidden': true, size: 14 } as const;
  switch (state) {
    case 'done':
      return <Check {...props} />;
    case 'current':
      return <CircleDot {...props} />;
    case 'stopped':
      return <CircleX {...props} />;
    case 'unknown':
      return <Minus {...props} />;
    default:
      return <Circle {...props} />;
  }
}

const STATE_TEXT: Record<StepState, string> = {
  done: 'done',
  current: 'in progress',
  pending: 'not started',
  stopped: 'stopped',
  unknown: 'not recorded',
};

function readableReason(reason: string) {
  return reason.replace(/_/g, ' ');
}

/**
 * One run's progress as reported by its events. There is no percentage, token count
 * or queue position: the server reports none, and the answer is not streamed.
 */
export const RunActivity = forwardRef<HTMLElement, RunActivityProps>(function RunActivity(
  {
    status,
    runId,
    log,
    follow,
    streamNote,
    href,
    onOpenLink,
    onReconnect,
    onLoadHistory,
    staleRunId,
  },
  ref,
) {
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => setCopy('idle'), [href]);
  const active = !isTerminal(status);
  const steps = runSteps(status, log);
  const noHistory =
    !active && steps.every((step) => step.key === 'outcome' || step.state === 'unknown');

  async function copyLink() {
    if (!href) return;
    try {
      await navigator.clipboard.writeText(new URL(href, window.location.href).toString());
      setCopy('copied');
    } catch {
      setCopy('failed');
    }
  }

  let live: { tone?: 'warning'; text: string } | null = null;
  if (active)
    live =
      follow === 'following'
        ? { text: 'Live. Steps update as the server records them.' }
        : follow === 'unavailable'
          ? null
          : { tone: 'warning', text: 'Not receiving live updates for this run.' };

  return (
    <section
      ref={ref}
      tabIndex={-1}
      className="ks-activity"
      aria-labelledby="ks-activity-title"
      data-testid="ks-run-activity"
      data-run-id={runId}
      data-status={status}
      data-follow={follow ?? 'none'}
    >
      <header className="ks-activity-header">
        <h3 id="ks-activity-title">{active ? 'Run in progress' : 'Last run'}</h3>
        {href ? (
          <span className="ks-activity-links">
            <a
              href={href}
              data-testid="ks-run-link"
              onClick={(event) => {
                if (!isPlainClick(event)) return;
                event.preventDefault();
                onOpenLink();
              }}
            >
              Link to this run
            </a>
            <Button
              size="sm"
              variant="ghost"
              data-testid="ks-copy-run-link"
              onClick={() => void copyLink()}
            >
              {copy === 'copied' ? 'Link copied' : 'Copy link'}
            </Button>
          </span>
        ) : null}
      </header>
      {copy === 'failed' ? (
        <p className="ks-muted" role="status" data-testid="ks-copy-run-link-failed">
          The link could not be copied. Use Link to this run instead.
        </p>
      ) : null}
      {staleRunId ? (
        <p className="ks-note" data-tone="warning" data-testid="ks-stale-run">
          The link names a run that is not this question's current run. Showing the current run.
        </p>
      ) : null}
      <ol className="ks-steps" aria-label="Run steps">
        {steps.map((step) => (
          <li
            key={step.key}
            className="ks-step"
            data-state={step.state}
            data-testid={`ks-run-step-${step.key}`}
            aria-current={step.state === 'current' ? 'step' : undefined}
          >
            <StepIcon state={step.state} />
            <div>
              <p className="ks-step-label">
                {step.key === 'outcome' && !active ? statusLabel(status) : STEP_LABELS[step.key]}
                <span className="sr-only">, {STATE_TEXT[step.state]}</span>
              </p>
              <p className="ks-step-detail">{stepDetail(step.key, step.state, status)}</p>
            </div>
          </li>
        ))}
      </ol>
      {!active && log.reason ? (
        <p className="ks-muted" data-testid="ks-run-reason">
          Reason reported: {readableReason(log.reason)}
        </p>
      ) : null}
      {live ? (
        <p
          className={live.tone ? 'ks-note' : 'ks-muted'}
          data-tone={live.tone}
          data-testid="ks-run-live"
        >
          {live.text}
        </p>
      ) : null}
      {streamNote ? (
        <p className="ks-note" data-tone="warning" data-testid="ks-stream-note">
          {streamNote}
        </p>
      ) : null}
      {active && follow !== 'following' && onReconnect ? (
        <Button size="sm" data-testid="ks-reconnect" onClick={onReconnect}>
          Reconnect live updates
        </Button>
      ) : null}
      {(noHistory || (!active && follow !== 'ended')) && onLoadHistory ? (
        <Button size="sm" data-testid="ks-load-history" onClick={onLoadHistory}>
          Show recorded steps
        </Button>
      ) : null}
      <p className="ks-muted ks-activity-id">
        Run <code>{runId}</code>
      </p>
    </section>
  );
});
