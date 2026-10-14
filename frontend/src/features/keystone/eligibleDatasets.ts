import type { DatasetInfo } from '../../lib/types';

/** Parallel metadata lookups per load; a server with many datasets is never flooded. */
export const MAX_DATASET_LOOKUPS = 4;

/**
 * Matches native ScopeVersion validation: 1–128 ASCII letters, digits, `-` or `_`,
 * with no leading underscore. Server metadata must also confirm the stream type.
 */
const INVESTIGABLE_NAME = /^(?!_)[A-Za-z0-9_-]{1,128}$/;

export function investigableName(name: string): boolean {
  return INVESTIGABLE_NAME.test(name);
}

/** Some dataset types could not be confirmed; the list is incomplete, not empty. */
export class DatasetEligibilityError extends Error {
  constructor(
    readonly failed: string[],
    readonly reason?: unknown,
  ) {
    super(`Could not confirm which datasets can be investigated (${failed.join(', ')}).`);
    this.name = 'DatasetEligibilityError';
  }
}

function aborted(signal: AbortSignal): never {
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The dataset lookup was aborted.', 'AbortError');
}

/**
 * Keeps only datasets the server reports as `UserDefined`. Internal, unknown or
 * missing types are excluded, so an internal dataset is never offered whatever its
 * name. Metadata comes from the caller's own dataset info permission. Any failed
 * lookup rejects the whole load rather than returning a silently shorter list.
 */
export async function eligibleDatasets(
  names: readonly string[],
  info: (name: string, signal: AbortSignal) => Promise<Pick<DatasetInfo, 'streamType'>>,
  signal: AbortSignal,
): Promise<string[]> {
  if (signal.aborted) aborted(signal);
  const candidates = [...new Set(names)].filter(investigableName).sort();
  // Stops outstanding lookups when the caller aborts or one lookup fails.
  const local = new AbortController();
  const forward = () => local.abort(signal.reason);
  signal.addEventListener('abort', forward, { once: true });
  const eligible = new Set<string>();
  const failed: string[] = [];
  let firstError: unknown;
  let next = 0;
  async function worker() {
    while (next < candidates.length && !local.signal.aborted) {
      const name = candidates[next++];
      try {
        const metadata = await info(name, local.signal);
        if (metadata?.streamType === 'UserDefined') eligible.add(name);
      } catch (error) {
        if (local.signal.aborted) return;
        failed.push(name);
        firstError = error;
        local.abort(error);
      }
    }
  }
  try {
    await Promise.all(
      Array.from({ length: Math.max(1, Math.min(MAX_DATASET_LOOKUPS, candidates.length)) }, worker),
    );
  } finally {
    signal.removeEventListener('abort', forward);
  }
  if (signal.aborted) aborted(signal);
  if (failed.length) throw new DatasetEligibilityError(failed.sort(), firstError);
  return candidates.filter((name) => eligible.has(name));
}
