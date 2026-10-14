import { decodeJson, decodeRunEvent } from './decode';
import type { RunEvent } from './types';

export interface SseFrame {
  id: string | null;
  event: string;
  data: string;
}

/**
 * Incremental text/event-stream parser. Accepts arbitrary byte chunks, including
 * UTF-8 sequences and CRLF pairs split across chunk boundaries. Comment lines
 * (heartbeats) and frames without data are dropped, as the SSE spec requires.
 */
export class SseParser {
  private decoder = new TextDecoder('utf-8');
  private buffer = '';
  private data: string[] = [];
  private event = '';
  private id: string | null = null;
  private pendingCr = false;

  push(chunk: Uint8Array | string): SseFrame[] {
    let text = typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
    if (this.pendingCr && text.startsWith('\n')) text = text.slice(1);
    this.pendingCr = text.endsWith('\r');
    this.buffer += text;
    const frames: SseFrame[] = [];
    const lines = this.buffer.split(/\r\n|\r|\n/);
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      const frame = this.line(line);
      if (frame) frames.push(frame);
    }
    return frames;
  }

  /** Flushes a final unterminated frame at end of stream. */
  end(): SseFrame[] {
    const tail = this.decoder.decode();
    const frames = tail || this.buffer ? this.push(tail + '\n') : [];
    const last = this.line('');
    return last ? [...frames, last] : frames;
  }

  private line(line: string): SseFrame | null {
    if (line === '') {
      if (this.data.length === 0) {
        this.event = '';
        return null;
      }
      const frame = { id: this.id, event: this.event || 'message', data: this.data.join('\n') };
      this.data = [];
      this.event = '';
      return frame;
    }
    if (line.startsWith(':')) return null;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this.data.push(value);
    else if (field === 'event') this.event = value;
    else if (field === 'id' && !value.includes('\0')) this.id = value;
    return null;
  }
}

export type SequenceResult =
  | { type: 'apply'; event: RunEvent }
  | { type: 'duplicate'; seq: number }
  | { type: 'gap'; expected: number; received: number }
  | { type: 'invalid'; error: string };

/**
 * Applies run events strictly in sequence. Replayed events at or below the last
 * applied sequence are dropped; a jump forward stops application until the caller
 * resynchronizes from `resumeAfter` (a snapshot or an `?after=` replay).
 */
export class RunEventSequencer {
  private last: number;
  private stalled = false;

  constructor(
    readonly runId: string,
    after = 0,
  ) {
    this.last = after;
  }

  get resumeAfter() {
    return this.last;
  }

  get needsResync() {
    return this.stalled;
  }

  /** Resumes after a snapshot taken at `seq`. */
  resync(seq: number) {
    this.last = Math.max(this.last, seq);
    this.stalled = false;
  }

  accept(frame: SseFrame): SequenceResult {
    const decoded = decodeJson(frame.data, decodeRunEvent);
    if (!decoded.ok) return { type: 'invalid', error: decoded.error };
    const event = decoded.value;
    if (event.runId !== this.runId) return { type: 'invalid', error: 'event for another run' };
    if (frame.id !== null && frame.id !== String(event.seq))
      return { type: 'invalid', error: 'SSE id does not match event sequence' };
    if (event.seq <= this.last) return { type: 'duplicate', seq: event.seq };
    if (this.stalled || event.seq !== this.last + 1) {
      this.stalled = true;
      return { type: 'gap', expected: this.last + 1, received: event.seq };
    }
    this.last = event.seq;
    return { type: 'apply', event };
  }
}
