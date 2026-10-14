import { describe, expect, it } from 'vitest';
import type { SseFrame } from '../../lib/keystone/sse';
import type { TransportResult } from '../../lib/keystone/transport';
import { createRunFollower, type FollowState } from './runFollower';

type Reader = (
  after: number,
  onFrame: (frame: SseFrame) => void,
  signal: AbortSignal,
) => Promise<TransportResult<'ended'>>;

const event = (seq: number, kind: 'status' | 'terminal' = 'status') => ({
  id: String(seq),
  event: 'message',
  data: JSON.stringify(
    kind === 'terminal'
      ? {
          schemaVersion: 1,
          runId: 'run1',
          nodeId: 'n1',
          seq,
          kind,
          status: 'completed',
          reason: null,
        }
      : { schemaVersion: 1, runId: 'run1', nodeId: 'n1', seq, kind, status: 'querying' },
  ),
});

function harness(readers: Reader[]) {
  const calls: number[] = [];
  const frames: number[] = [];
  const states: FollowState[] = [];
  const follower = createRunFollower(
    {
      runEvents: (_investigation, _run, after, onFrame, signal) => {
        calls.push(after);
        const reader = readers.shift();
        return reader
          ? reader(after, onFrame, signal)
          : Promise.resolve({ ok: true, value: 'ended' });
      },
    },
    'inv1',
    { delay: () => Promise.resolve() },
  );
  follower.subscribe((_run, frame) => frames.push(Number(frame.id)));
  follower.onState((_run, state) => states.push(state));
  return { follower, calls, frames, states };
}

const settle = () => new Promise((done) => setTimeout(done, 0));

describe('run follower', () => {
  it('resumes after the last delivered event and stops at a terminal event', async () => {
    const { follower, calls, frames, states } = harness([
      async (_after, onFrame) => {
        onFrame(event(1));
        onFrame(event(2));
        return { ok: true, value: 'ended' };
      },
      async (_after, onFrame) => {
        onFrame(event(3, 'terminal'));
        return { ok: true, value: 'ended' };
      },
    ]);
    follower.follow('run1');
    follower.follow('run1');
    await settle();
    expect(calls).toEqual([0, 2]);
    expect(frames).toEqual([1, 2, 3]);
    expect(states.at(-1)).toEqual({ state: 'ended' });
  });

  it('reports a gated live stream instead of showing progress', async () => {
    const { follower, states } = harness([
      async () => ({
        ok: false,
        kind: 'gated',
        reason: 'backend_missing',
        message: 'live_events_unavailable',
      }),
    ]);
    follower.follow('run1');
    await settle();
    expect(states.at(-1)).toMatchObject({ state: 'unavailable', failure: { kind: 'gated' } });
  });

  it('keeps following across successful stream rotations that deliver progress', async () => {
    const readers: Reader[] = Array.from({ length: 8 }, (_, index) => async (_after, emit) => {
      emit(event(index + 1, index === 7 ? 'terminal' : 'status'));
      return { ok: true, value: 'ended' };
    });
    const { follower, calls, states } = harness(readers);
    follower.follow('run1');
    await settle();
    expect(calls).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(states.at(-1)).toEqual({ state: 'ended' });
  });

  it('gives up after bounded reconnects when the stream keeps ending early', async () => {
    const { follower, calls, states } = harness([]);
    follower.follow('run1');
    await settle();
    expect(calls).toHaveLength(6);
    expect(states.at(-1)).toMatchObject({ state: 'unavailable', failure: { kind: 'error' } });
  });

  it('replays from the requested cursor', async () => {
    let release: (() => void) | null = null;
    const { follower, calls } = harness([
      (_after, onFrame, signal) =>
        new Promise((done) => {
          onFrame(event(1));
          onFrame(event(3));
          release = () => done({ ok: true, value: 'ended' });
          signal.addEventListener('abort', () => release?.());
        }),
      async (_after, onFrame) => {
        onFrame(event(2));
        onFrame(event(3));
        onFrame(event(4, 'terminal'));
        return { ok: true, value: 'ended' };
      },
    ]);
    follower.follow('run1');
    await settle();
    follower.replay('run1', 1);
    await settle();
    expect(calls).toEqual([0, 1]);
  });

  it('stops reading when closed', async () => {
    const { follower, calls } = harness([
      (_after, _onFrame, signal) =>
        new Promise((done) =>
          signal.addEventListener('abort', () => done({ ok: true, value: 'ended' })),
        ),
    ]);
    follower.follow('run1');
    follower.close();
    await settle();
    expect(calls).toEqual([0]);
  });
});
