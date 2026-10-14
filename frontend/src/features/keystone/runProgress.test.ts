import { describe, expect, it } from 'vitest';
import type { NodeStatus } from '../../lib/keystone/types';
import { appendStatus, EMPTY_LOG, runSteps, type RunLog } from './runProgress';

const log = (...trail: NodeStatus[]): RunLog => ({ trail, reason: null });
const states = (status: NodeStatus, value: RunLog) =>
  Object.fromEntries(runSteps(status, value).map((step) => [step.key, step.state]));

describe('appendStatus', () => {
  it('keeps distinct consecutive statuses only', () => {
    let value = EMPTY_LOG;
    for (const status of ['queued', 'queued', 'querying', 'querying', 'composing'] as const)
      value = appendStatus(value, status);
    expect(value.trail).toEqual(['queued', 'querying', 'composing']);
  });

  it('returns the same log when nothing changes', () => {
    const value = log('queued');
    expect(appendStatus(value, 'queued')).toBe(value);
  });
});

describe('runSteps', () => {
  it('shows the current step of an active run from its status', () => {
    expect(states('queued', EMPTY_LOG)).toEqual({
      queued: 'current',
      reading: 'pending',
      answering: 'pending',
      outcome: 'pending',
    });
    expect(states('querying', log('queued', 'querying'))).toEqual({
      queued: 'done',
      reading: 'current',
      answering: 'pending',
      outcome: 'pending',
    });
    expect(states('composing', EMPTY_LOG).answering).toBe('current');
  });

  it('never assumes the steps of a finished run it did not observe', () => {
    expect(states('completed', EMPTY_LOG)).toEqual({
      queued: 'unknown',
      reading: 'unknown',
      answering: 'unknown',
      outcome: 'done',
    });
    expect(states('failed', EMPTY_LOG).outcome).toBe('stopped');
  });

  it('marks where a failed run stopped and what it did not reach', () => {
    expect(states('failed', log('queued', 'querying', 'failed'))).toEqual({
      queued: 'done',
      reading: 'stopped',
      answering: 'pending',
      outcome: 'stopped',
    });
    expect(states('cancelled', log('queued', 'cancelled'))).toEqual({
      queued: 'stopped',
      reading: 'pending',
      answering: 'pending',
      outcome: 'stopped',
    });
  });

  it('shows every observed step of a completed run as done', () => {
    expect(states('completed', log('queued', 'querying', 'composing', 'completed'))).toEqual({
      queued: 'done',
      reading: 'done',
      answering: 'done',
      outcome: 'done',
    });
  });

  it('does not invent a stopping point from a partial log after snapshot recovery', () => {
    expect(states('completed', log('queued'))).toEqual({
      queued: 'done',
      reading: 'unknown',
      answering: 'unknown',
      outcome: 'done',
    });
    expect(states('failed', log('queued', 'resolving_scope'))).toEqual({
      queued: 'done',
      reading: 'unknown',
      answering: 'unknown',
      outcome: 'stopped',
    });
    expect(states('completed', log('queued', 'completed')).reading).toBe('unknown');
  });
});
