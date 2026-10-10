/** A per-view queue. Each request owns a slot and queued requests are removable on abort. */
export function createLimiter(max = 4) {
  let active = 0;
  const queue: Array<() => void> = [];
  return async function limit<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const start = () => {
        signal.removeEventListener('abort', abort);
        active++;
        resolve();
      };
      const abort = () => {
        const index = queue.indexOf(start);
        if (index >= 0) queue.splice(index, 1);
        reject(signal.reason);
      };
      if (active < max) start();
      else {
        queue.push(start);
        signal.addEventListener('abort', abort, { once: true });
      }
    });
    try {
      signal.throwIfAborted();
      return await operation();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}
export type QueryLimiter = ReturnType<typeof createLimiter>;
export async function mapConcurrent<T, R>(
  items: T[],
  max: number,
  operation: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(max, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await operation(items[index], index);
      }
    }),
  );
  return results;
}
