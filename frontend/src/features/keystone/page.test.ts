import { describe, expect, it } from 'vitest';
import { freezeRange, titleFromPrompt } from './NewInvestigation';
import { isDraft, nodeRunId } from './pageContract';
import { executionMessage, requestMessage, storageMessage } from './readiness';
import type { TransportFailure } from '../../lib/keystone/transport';

describe('new investigation window', () => {
  const now = Date.parse('2026-10-13T12:34:56.789Z');

  it('freezes a relative preset into whole-second absolute UTC bounds', () => {
    expect(freezeRange('1h', now)).toEqual({
      start: '2026-10-13T11:34:56Z',
      end: '2026-10-13T12:34:57Z',
    });
  });

  it('keeps a custom range absolute and independent of the clock', () => {
    const custom = { startTime: '2026-10-01T00:00:00.000Z', endTime: '2026-10-02T00:00:00.000Z' };
    expect(freezeRange(custom, now)).toEqual(freezeRange(custom, now + 86_400_000));
    expect(freezeRange(custom, now)).toEqual({
      start: '2026-10-01T00:00:00Z',
      end: '2026-10-02T00:00:00Z',
    });
  });

  it('derives a bounded title from the first line of the question', () => {
    expect(titleFromPrompt('  Why did errors rise?\nmore detail')).toBe('Why did errors rise?');
    expect(titleFromPrompt('x'.repeat(200))).toHaveLength(120);
  });
});

describe('readiness copy', () => {
  it('never reports an unknown execution reason as ready', () => {
    expect(executionMessage({ state: 'ready', reason: null })).toBeNull();
    expect(executionMessage({ state: 'unavailable', reason: 'something_new' })).toContain(
      'something_new',
    );
    expect(executionMessage({ state: 'unavailable', reason: null })).toBe(
      'This server cannot run questions yet.',
    );
  });

  it('points administrators at the OpenRouter connection on the investigations list', () => {
    const admin = executionMessage({ state: 'unavailable', reason: 'provider_unconfigured' }, true);
    expect(admin).toContain('OpenRouter connection');
    expect(admin).not.toContain('Settings');
    expect(
      executionMessage({ state: 'unavailable', reason: 'provider_unconfigured' }, false),
    ).toContain('Ask an administrator');
  });

  it('reports a not-found on create as a dataset problem, not a missing investigation', () => {
    const failure = { kind: 'not_found', message: 'not found' } as TransportFailure;
    const create = requestMessage(failure, 'create');
    expect(create).toContain('selected dataset');
    expect(create).toContain('question and scope are kept');
    expect(create).not.toContain('investigation does not exist');
    expect(requestMessage(failure)).toContain('investigation does not exist');
    expect(
      requestMessage({ kind: 'denied', message: 'x' } as TransportFailure, 'create'),
    ).toContain('permission');
  });

  it('reports storage readiness separately', () => {
    expect(storageMessage('ready')).toBeNull();
    expect(storageMessage('degraded')).toContain('restart');
    expect(storageMessage('unavailable')).toContain('not enabled');
  });
});

describe('draft and run attribution', () => {
  it('recognises a saved, never-run question and a reported run', () => {
    expect(isDraft({ status: 'draft' as never })).toBe(true);
    expect(isDraft({ status: 'queued' })).toBe(false);
    expect(nodeRunId({ runId: 'run1' } as never)).toBe('run1');
    expect(nodeRunId({} as never)).toBeNull();
  });
});
