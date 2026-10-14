import { describe, expect, it } from 'vitest';
import {
  DatasetEligibilityError,
  MAX_DATASET_LOOKUPS,
  eligibleDatasets,
  investigableName,
} from './eligibleDatasets';

type Info = { streamType?: string };

function lookup(types: Record<string, Info | Error>) {
  const calls: string[] = [];
  const info = async (name: string) => {
    calls.push(name);
    const value = types[name];
    if (value instanceof Error) throw value;
    return value ?? {};
  };
  return { info, calls };
}

describe('dataset eligibility', () => {
  it('keeps only datasets the server reports as UserDefined, whatever their names', async () => {
    const { info } = lookup({
      keystone_smoke_synthetic: { streamType: 'UserDefined' },
      pstats: { streamType: 'Internal' },
      // An internal dataset with an ordinary-looking name is still excluded.
      billing: { streamType: 'Internal' },
      checkout: { streamType: 'UserDefined' },
    });
    const names = ['pstats', 'keystone_smoke_synthetic', 'billing', 'checkout'];
    await expect(eligibleDatasets(names, info, new AbortController().signal)).resolves.toEqual([
      'checkout',
      'keystone_smoke_synthetic',
    ]);
  });

  it('fails closed on missing or unknown types', async () => {
    const { info } = lookup({
      nothing: {},
      future: { streamType: 'Ephemeral' },
      lower: { streamType: 'userdefined' },
      ok: { streamType: 'UserDefined' },
    });
    await expect(
      eligibleDatasets(['nothing', 'future', 'lower', 'ok'], info, new AbortController().signal),
    ).resolves.toEqual(['ok']);
  });

  it('never looks up names that cannot be scoped', async () => {
    const { info, calls } = lookup({ app: { streamType: 'UserDefined' } });
    const names = ['_internal', 'app', 'has space', 'semi;colon', '', 'app'];
    await expect(eligibleDatasets(names, info, new AbortController().signal)).resolves.toEqual([
      'app',
    ]);
    expect(calls).toEqual(['app']);
    expect(investigableName('_pmeta')).toBe(false);
    expect(investigableName('web-logs_2')).toBe(true);
    expect(investigableName('-logs')).toBe(true);
    expect(investigableName('a'.repeat(128))).toBe(true);
    expect(investigableName('a'.repeat(129))).toBe(false);
    expect(investigableName('lögs')).toBe(false);
  });

  it('reports a failed lookup instead of returning a shorter list', async () => {
    const { info } = lookup({
      a: { streamType: 'UserDefined' },
      b: new Error('500'),
      c: { streamType: 'UserDefined' },
    });
    const result = eligibleDatasets(['a', 'b', 'c'], info, new AbortController().signal);
    await expect(result).rejects.toBeInstanceOf(DatasetEligibilityError);
    await expect(result).rejects.toMatchObject({ failed: ['b'] });
  });

  it('runs at most four lookups at a time', async () => {
    let active = 0;
    let peak = 0;
    const names = Array.from({ length: 11 }, (_, i) => `ds${i}`);
    const info = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return { streamType: 'UserDefined' };
    };
    const result = await eligibleDatasets(names, info, new AbortController().signal);
    expect(result).toHaveLength(11);
    expect(MAX_DATASET_LOOKUPS).toBe(4);
    expect(peak).toBe(4);
  });

  it('stops outstanding lookups and rejects when the caller aborts', async () => {
    const controller = new AbortController();
    const signals: AbortSignal[] = [];
    let started = 0;
    const info = (_name: string, signal: AbortSignal) =>
      new Promise<Info>((_resolve, reject) => {
        started += 1;
        signals.push(signal);
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    const result = eligibleDatasets(['a', 'b', 'c', 'd', 'e', 'f'], info, controller.signal);
    await Promise.resolve();
    controller.abort();
    await expect(result).rejects.toSatisfy((error: Error) => error.name === 'AbortError');
    expect(started).toBe(4);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it('does nothing for an already aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const { info, calls } = lookup({ a: { streamType: 'UserDefined' } });
    await expect(eligibleDatasets(['a'], info, controller.signal)).rejects.toBeDefined();
    expect(calls).toEqual([]);
  });
});
