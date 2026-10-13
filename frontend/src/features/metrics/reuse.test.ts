import { expect, it } from 'vitest';
import { executedMetricTile, metricAlertHandoff } from './reuse';
import {
  createRunSnapshot,
  ensureRowIdentity,
  parseExplorerSearch,
  removeSnapshotQuery,
  serializeExplorerState,
  snapshotState,
  type QueryResult,
} from './helpers';

const state = ensureRowIdentity({
  queries: ['cpu', '', 'rate(counter[5m])'],
  type: 'both',
  step: '30s',
  range: '1h',
  aliases: ['CPU', 'Empty', 'Traffic'],
});
const snapshot = createRunSnapshot(
  state,
  'metrics',
  800,
  Date.parse('2026-10-09T12:00:00Z'),
).snapshot!;
it('round-trips stable identities and aliases through URLs and applied snapshots', () => {
  expect(parseExplorerSearch(serializeExplorerState(state))).toEqual(state);
  expect(snapshotState(snapshot, '1h')).toEqual(state);
  const removed = removeSnapshotQuery(snapshot, state.rowIds![0])!;
  expect(removed.queries[0].id).toBe(state.rowIds![2]);
  expect(removed.queries[0].alias).toBe('Traffic');
  expect(snapshotState(removed, '6h')).toMatchObject({
    queries: ['', 'rate(counter[5m])'],
    rowIds: state.rowIds!.slice(1),
    aliases: ['Empty', 'Traffic'],
  });
});
it('leaves applied results intact when a removed draft identity was never executed', () => {
  const loadedDraft = ensureRowIdentity({
    queries: ['saved query', 'new draft'],
    type: 'both',
    step: '',
    range: '1h',
  });
  expect(removeSnapshotQuery(snapshot, loadedDraft.rowIds![1])).toBe(snapshot);
  const remaining = removeSnapshotQuery(snapshot, state.rowIds![2])!;
  expect(remaining.queries.map((row) => row.id)).toEqual([state.rowIds![0]]);
  expect(remaining.rowOrder).toEqual(state.rowIds!.slice(0, 2));
});
it('rejects duplicate or malformed URL IDs and bounds aliases', () => {
  expect(parseExplorerSearch('?query=cpu&query=memory&qid=a&qid=a').rowIds).toBeUndefined();
  expect(parseExplorerSearch('?query=cpu&qid=a%3Ab').rowIds).toBeUndefined();
  expect(parseExplorerSearch(`?query=cpu&alias=${'x'.repeat(100)}`).aliases?.[0]).toHaveLength(80);
});
it('hands off only a selected completed instant vector and the captured executed text', () => {
  const row = snapshot.queries[1];
  const result: QueryResult = {
    id: row.id,
    pending: 0,
    errors: [],
    instant: { resultType: 'vector', result: [] },
  };
  state.queries[2] = 'unexecuted_edit';
  const handoff = metricAlertHandoff(snapshot, row.id, result);
  const params = new URLSearchParams(handoff.url!.split('?')[1]);
  expect(params.get('alertQuery')).toBe('rate(counter[5m])');
  expect(params.get('dataset')).toBe('metrics');
  expect(params.get('title')).toBe('Traffic');
  expect(metricAlertHandoff(snapshot, row.id, { ...result, pending: 1 }).url).toBeUndefined();
  expect(
    metricAlertHandoff(snapshot, row.id, {
      ...result,
      instant: { resultType: 'scalar', result: [1, '3'] },
    }).reason,
  ).toContain('instant vector');
});
it('captures selected executed query and resolved step in a compatible dashboard tile', () => {
  const row = snapshot.queries[1];
  const tile = executedMetricTile(snapshot, row.id, ' Traffic ');
  expect(tile).toMatchObject({
    title: 'Traffic',
    tileType: 'promql',
    dbName: ['metrics'],
    chartQuery: ['rate(counter[5m])'],
    promqlQueryType: ['range'],
    promqlStep: '30s',
  });
  expect(() => executedMetricTile(snapshot, 'unknown', 'x')).toThrow('Select');
});
