import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  localImportBody,
  markerKey,
  planLocalImport,
  readImportMarker,
  runLocalImport,
} from './importLocal';
const local = (id: string, title = id) => ({
  id,
  title,
  description: 'Keep description',
  dataset: 'app"logs',
});
afterEach(() => vi.unstubAllGlobals());
describe('browser-local import', () => {
  it('plans deterministically, resolves exact collisions and skips imported/duplicate IDs', () => {
    const inputs = [
        local('a', 'Title'),
        local('b', 'title'),
        local('c', 'Title'),
        local('c'),
        local('done'),
      ],
      titles = ['Title', 'Title (2)'],
      ids = ['done'];
    const plan = planLocalImport(inputs, titles, ids);
    expect(plan.create.map((item) => item.title)).toEqual(['Title (3)', 'title', 'Title (4)']);
    expect(plan.skip).toHaveLength(2);
    expect(planLocalImport(inputs, titles, ids)).toEqual(plan);
    expect(localImportBody(plan.create[0], '01M4J000000000000000000041')).toMatchObject({
      title: 'Title (3)',
      description: 'Keep description',
      tiles: [
        {
          tileType: 'code',
          dbName: ['app"logs'],
          chartType: 'bar',
          chartQuery: expect.stringContaining('FROM "app""logs"'),
        },
      ],
    });
  });
  it('caps imports at three, records partial failures and retries a racing title once', async () => {
    let active = 0,
      peak = 0,
      conflicted = false;
    const operation = vi.fn(async (body) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      if (body.title === 'b') throw new Error('Denied');
      if (body.title === 'a' && !conflicted) {
        conflicted = true;
        throw new Error('Cannot perform this operation: Dashboard title must be unique');
      }
    });
    const result = await runLocalImport(
      planLocalImport(
        ['a', 'b', 'c', 'd', 'e'].map((id) => local(id)),
        [],
        [],
      ).create,
      operation,
      [],
    );
    expect(peak).toBe(3);
    expect(result.filter((item) => item.imported)).toHaveLength(4);
    expect(result[0].title).toBe('a (2)');
    expect(result[1].error).toBe('Denied');
    expect(operation).toHaveBeenCalledTimes(6);
  });
  it('uses a per-identity marker and tolerates corrupt data', () => {
    vi.stubGlobal('localStorage', {
      getItem: (key: string) =>
        key === markerKey('a')
          ? JSON.stringify({ importedIds: ['one', 1], dismissed: true })
          : 'bad',
    });
    expect(readImportMarker('a')).toEqual({ importedIds: ['one'], dismissed: true });
    expect(readImportMarker('b')).toEqual({ importedIds: [] });
  });
});
