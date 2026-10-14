import { decodeJson, decodeRunEvent } from '../../lib/keystone/decode';
import type { SseFrame } from '../../lib/keystone/sse';
import type { RunEventSource, TransportFailure } from '../../lib/keystone/transport';
import type { KeystonePageTransport } from './pageContract';

export type FollowState =
  { state: 'following' } | { state: 'ended' } | { state: 'unavailable'; failure: TransportFailure };

export interface RunFollower extends RunEventSource {
  /** Starts reading a run's events; following the same run twice is a no-op. */
  follow(runId: string): void;
  onState(listener: (runId: string, state: FollowState) => void): () => void;
  close(): void;
}

const MAX_RECONNECTS = 5;

/**
 * Turns per-request SSE reads into a run event source. Each read resumes after the
 * last frame delivered; a stream that ends before a terminal event is reopened with
 * bounded backoff. A gated or failed read stops following and reports why, so a
 * missing live stream is visible rather than shown as progress.
 */
export function createRunFollower(
  transport: Pick<KeystonePageTransport, 'runEvents'>,
  investigationId: string,
  { delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms)) } = {},
): RunFollower {
  const listeners = new Set<(runId: string, frame: SseFrame) => void>();
  const stateListeners = new Set<(runId: string, state: FollowState) => void>();
  const runs = new Map<string, { after: number; controller: AbortController; done: boolean }>();
  let closed = false;

  const report = (runId: string, state: FollowState) => {
    for (const listener of stateListeners) listener(runId, state);
  };

  async function read(runId: string) {
    let attempts = 0;
    for (;;) {
      const run = runs.get(runId);
      if (!run || closed || run.done) return;
      const controller = run.controller;
      const cursorBeforeRead = run.after;
      let terminal = false;
      const result = await transport.runEvents(
        investigationId,
        runId,
        run.after,
        (frame) => {
          if (controller.signal.aborted) return;
          const seq = frame.id === null ? NaN : Number(frame.id);
          const decoded = decodeJson(frame.data, decodeRunEvent);
          if (
            decoded.ok &&
            decoded.value.runId === runId &&
            seq === decoded.value.seq &&
            seq === run.after + 1
          ) {
            run.after = seq;
            if (decoded.value.kind === 'terminal') terminal = true;
          }
          for (const listener of listeners) listener(runId, frame);
        },
        controller.signal,
      );
      if (closed) return;
      if (controller.signal.aborted) {
        // A replay replaced this read's controller; continue with the new cursor.
        if (runs.get(runId)?.controller !== controller) continue;
        return;
      }
      if (!result.ok) {
        run.done = true;
        report(runId, { state: 'unavailable', failure: result });
        return;
      }
      if (terminal) {
        run.done = true;
        report(runId, { state: 'ended' });
        return;
      }
      // Normal bounded SSE responses may close after delivering progress. Only
      // consecutive reads without progress should exhaust the reconnect budget.
      if (run.after > cursorBeforeRead) attempts = 0;
      attempts += 1;
      if (attempts > MAX_RECONNECTS) {
        run.done = true;
        report(runId, {
          state: 'unavailable',
          failure: {
            ok: false,
            kind: 'error',
            message: 'The run’s event stream keeps closing before the run finishes.',
          },
        });
        return;
      }
      await delay(Math.min(8000, 500 * 2 ** (attempts - 1)));
    }
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    replay(runId, after) {
      const run = runs.get(runId);
      if (!run || closed) return;
      run.after = after;
      const previous = run.controller;
      run.controller = new AbortController();
      previous.abort();
      if (run.done) {
        run.done = false;
        report(runId, { state: 'following' });
        void read(runId);
      }
    },
    follow(runId) {
      if (closed || runs.has(runId)) return;
      runs.set(runId, { after: 0, controller: new AbortController(), done: false });
      report(runId, { state: 'following' });
      void read(runId);
    },
    onState(listener) {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    close() {
      closed = true;
      for (const run of runs.values()) run.controller.abort();
      listeners.clear();
      stateListeners.clear();
    },
  };
}
