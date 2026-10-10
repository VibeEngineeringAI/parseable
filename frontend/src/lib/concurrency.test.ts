import { describe, expect, it } from 'vitest';
import { createLimiter } from './concurrency';
describe('dashboard query concurrency', () => {
  it('caps API requests at four and cancels queued work', async () => {
    const limit = createLimiter(4);
    let active = 0,
      peak = 0,
      executed = 0;
    const controller = new AbortController();
    const other = new AbortController();
    const operation = async () => {
      executed++;
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
    };
    const started = Array.from({ length: 4 }, () => limit(operation, controller.signal));
    const cancelled = limit(operation, other.signal);
    other.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.all([
      ...started,
      ...Array.from({ length: 8 }, () => limit(operation, controller.signal)),
    ]);
    expect(peak).toBe(4);
    expect(executed).toBe(12);
  });
});
