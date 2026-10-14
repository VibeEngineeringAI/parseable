import { isTerminal } from '../../lib/keystone/streaming';
import type { NodeStatus } from '../../lib/keystone/types';

/**
 * What this page has observed about one run. Built only from committed run events
 * the server sent (live or replayed); nothing here is estimated.
 */
export interface RunLog {
  /** Distinct consecutive statuses in the order events reported them. */
  trail: NodeStatus[];
  /** The terminal event's reason, when the server gave one. */
  reason: string | null;
}

export const EMPTY_LOG: RunLog = { trail: [], reason: null };

export function appendStatus(log: RunLog, status: NodeStatus): RunLog {
  return log.trail[log.trail.length - 1] === status
    ? log
    : { ...log, trail: [...log.trail, status] };
}

export type StepKey = 'queued' | 'reading' | 'answering' | 'outcome';
export type StepState = 'done' | 'current' | 'pending' | 'stopped' | 'unknown';

export interface RunStep {
  key: StepKey;
  state: StepState;
}

const STEP_STATUSES: Record<Exclude<StepKey, 'outcome'>, readonly NodeStatus[]> = {
  queued: ['queued'],
  reading: ['resolving_scope', 'awaiting_confirmation', 'querying'],
  answering: ['composing'],
};
const ORDER = ['queued', 'reading', 'answering'] as const;

function stepOf(status: NodeStatus) {
  return ORDER.findIndex((key) => STEP_STATUSES[key].includes(status));
}

/**
 * The run's steps. While active, the current step is the node's status now; earlier
 * steps are shown done because the server only moves forward through them. After a
 * terminal status, a step is done only if an event reported it, a failure marks the
 * last reported step as where the run stopped, and later steps were not reached
 * (`pending`). Without observed events a finished run's steps are `unknown`, never assumed.
 */
export function runSteps(status: NodeStatus, log: RunLog): RunStep[] {
  if (!isTerminal(status)) {
    const current = stepOf(status);
    return [
      ...ORDER.map((key, index) => ({
        key,
        state: (current < 0
          ? 'unknown'
          : index < current
            ? 'done'
            : index === current
              ? 'current'
              : 'pending') as StepState,
      })),
      { key: 'outcome', state: 'pending' },
    ];
  }
  const seen = new Set(log.trail.map(stepOf).filter((index) => index >= 0));
  const last = log.trail.reduce((found, item) => {
    const index = stepOf(item);
    return index >= 0 ? index : found;
  }, -1);
  const completeLog = log.trail.at(-1) === status;
  return [
    ...ORDER.map((key, index) => ({
      key,
      state: (!completeLog
        ? seen.has(index) && (index < last || index === 0)
          ? 'done'
          : 'unknown'
        : !seen.size
          ? 'unknown'
          : status !== 'completed' && index === last
            ? 'stopped'
            : seen.has(index)
              ? 'done'
              : status !== 'completed' && index > last
                ? 'pending'
                : 'unknown') as StepState,
    })),
    { key: 'outcome', state: status === 'completed' ? 'done' : 'stopped' },
  ];
}
