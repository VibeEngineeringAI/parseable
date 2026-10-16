import { describe, expect, it } from 'vitest';
import { fuzzyFilter, fuzzyScore } from './fuzzy';

const rank = (names: string[], query: string) => fuzzyFilter(names, query, (name) => name);

describe('fuzzy dataset ranking', () => {
  it('ranks exact, prefix, substring, then subsequence matches ignoring case', () => {
    expect(rank(['a-p-p', 'my-app-logs', 'application', 'APP', 'unrelated'], 'app')).toEqual([
      'APP',
      'application',
      'my-app-logs',
      'a-p-p',
    ]);
  });
  it('preserves incoming order for empty queries and ties', () => {
    expect(rank(['z', '', 'a'], '  ')).toEqual(['z', '', 'a']);
    expect(rank(['APP', 'app'], 'app')).toEqual(['APP', 'app']);
  });
  it('finds minor substitutions, omissions, and transpositions after direct matches', () => {
    expect(rank(['app-logs', 'app-lgos'], 'app-lgos')).toEqual(['app-lgos', 'app-logs']);
    expect(fuzzyScore('app-logz', 'app-logs')).not.toBeNull();
    expect(fuzzyScore('app-logss', 'app-logs')).not.toBeNull();
    expect(fuzzyScore('unrelated', 'app-logs')).toBeNull();
    expect(fuzzyScore('xy', 'xz')).toBeNull();
  });
  it('matches word and separator fragments and retains original items', () => {
    const items = [
      { name: 'production-api-logs', id: 1 },
      { name: 'billing-events', id: 2 },
    ];
    expect(fuzzyFilter(items, 'p-a-l', (item) => item.name)).toEqual([items[0]]);
    expect(fuzzyFilter(items, 'events', (item) => item.name)).toEqual([items[1]]);
  });
});
