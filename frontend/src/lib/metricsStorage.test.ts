import { afterEach, expect, it, vi } from 'vitest';
import {
  loadHistory,
  loadMetricLibrary,
  metricsStorageScope,
  pushHistory,
  saveMetricLibrary,
  type NamedMetricQuery,
} from './promql';
import type { SessionIdentity } from './types';
afterEach(() => vi.unstubAllGlobals());
const identity = { id: 'alice' } as SessionIdentity;
const scope = metricsStorageScope('live', identity, 'https://one')!;
function storage() {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  return values;
}
it('isolates by server, identity and demo; unidentified live sessions cannot persist', () => {
  storage();
  const scopes = [
    scope,
    metricsStorageScope('live', { ...identity, id: 'bob' }, 'https://one'),
    metricsStorageScope('live', identity, 'https://two'),
    metricsStorageScope('demo', identity, 'https://one'),
    metricsStorageScope('demo', identity, 'https://two'),
  ];
  expect(new Set(scopes).size).toBe(5);
  expect(metricsStorageScope('live')).toBeNull();
  pushHistory('metrics', 'cpu', scope);
  expect(loadHistory('metrics', scope)).toEqual(['cpu']);
  scopes.slice(1).forEach((other) => expect(loadHistory('metrics', other)).toEqual([]));
  pushHistory('metrics', 'private', null);
  expect(loadHistory('metrics', null)).toEqual([]);
});
it('never imports old dataset-only history into scoped sessions', () => {
  storage().set('parseable:promql-history:metrics', '["private_other_user_query"]');
  expect(loadHistory('metrics', scope)).toEqual([]);
});
const item: NamedMetricQuery = {
  id: 'one',
  name: 'Traffic',
  dataset: 'metrics',
  query: 'rate(counter[5m])',
  type: 'both',
  step: '30s',
  updatedAt: '2026-10-12T00:00:00Z',
};
it('keeps named library text and saved step while filtering malformed records', () => {
  const values = storage();
  expect(saveMetricLibrary(scope, [item])).toBe(true);
  expect(loadMetricLibrary(scope)).toEqual([item]);
  values.set(
    `${scope}:library`,
    JSON.stringify([
      item,
      item,
      { ...item, id: 'two', query: '' },
      { ...item, id: 'three', type: 'unknown' },
    ]),
  );
  expect(loadMetricLibrary(scope)).toEqual([item]);
  expect(loadMetricLibrary(null)).toEqual([]);
});
it('reports failure to write instead of claiming an unsaved library', () => {
  vi.stubGlobal('localStorage', {
    getItem() {
      throw new Error('Unavailable');
    },
    setItem() {
      throw new Error('Full');
    },
  });
  expect(loadMetricLibrary(scope)).toEqual([]);
  expect(saveMetricLibrary(scope, [item])).toBe(false);
});
