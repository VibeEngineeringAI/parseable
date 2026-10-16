import { describe, expect, it } from 'vitest';
import {
  columnStorageKey,
  moveColumn,
  orderedColumns,
  readColumnOrder,
  reconcileSelectedColumns,
} from './columnOrder';

describe('column preferences', () => {
  it('reconciles SQL selections against changed schemas without revealing explicitly hidden fields', () => {
    expect(reconcileSelectedColumns(['a', 'b', 'c', 'new'], ['c', 'a'], ['a', 'b', 'c'])).toEqual([
      'c',
      'a',
      'new',
    ]);
    expect(reconcileSelectedColumns(['new'], ['a'], ['a'])).toEqual(['new']);
    expect(reconcileSelectedColumns(['a', 'b'], ['b'], ['a'])).toEqual(['b']);
    expect(reconcileSelectedColumns([], ['a'], ['a', 'b'])).toEqual(['a']);
    expect(reconcileSelectedColumns(['b'], ['a'], ['a', 'b'])).toBeUndefined();
  });
  it('moves in both directions without changing the input or accepting unknown fields', () => {
    const fields = ['timestamp', 'flags', 'temporality'];
    expect(moveColumn(fields, 'temporality', 'timestamp')).toEqual([
      'temporality',
      'timestamp',
      'flags',
    ]);
    expect(moveColumn(fields, 'timestamp', 'temporality')).toEqual([
      'flags',
      'temporality',
      'timestamp',
    ]);
    expect(moveColumn(fields, 'missing', 'flags')).toBe(fields);
    expect(moveColumn(fields, 'flags', 'flags')).toBe(fields);
    expect(fields).toEqual(['timestamp', 'flags', 'temporality']);
  });
  it('ignores removed fields and appends new fields without losing the preferred order', () => {
    expect(orderedColumns(['a', 'b', 'c'], ['b', 'gone', 'a'])).toEqual(['b', 'a', 'c']);
    expect(orderedColumns([], ['b'])).toEqual([]);
  });
  it('rejects malformed preferences', () => {
    for (const value of [null, {}, [], ['a', 2], ['a', 'a'], 'a'])
      expect(readColumnOrder(value)).toBeUndefined();
    expect(readColumnOrder(['__proto__', 'a'])).toEqual(['__proto__', 'a']);
  });
  it('isolates server, user, mode and table, and waits for live identity', () => {
    const user = { id: 'alice', username: 'alice', source: 'server' as const };
    const key = columnStorageKey('live', user, 'logs:a', 'https://one');
    expect(key).not.toBe(columnStorageKey('live', { ...user, id: 'bob' }, 'logs:a', 'https://one'));
    expect(key).not.toBe(columnStorageKey('live', user, 'logs:a', 'https://two'));
    expect(key).not.toBe(columnStorageKey('live', user, 'logs:b', 'https://one'));
    expect(key).not.toBe(columnStorageKey('demo', user, 'logs:a', 'https://one'));
    expect(columnStorageKey('live', undefined, 'logs:a')).toBeNull();
  });
});
