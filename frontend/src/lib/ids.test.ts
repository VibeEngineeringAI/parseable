import { afterEach, describe, expect, it, vi } from 'vitest';
import { createUlid } from './ids';
import { ulid } from './dashboardsContract';
afterEach(() => vi.unstubAllGlobals());
describe('ULIDs', () => {
  it('encodes 48-bit time and 80-bit randomness without ambiguous characters', () => {
    vi.stubGlobal('crypto', { getRandomValues: (bytes: Uint8Array) => bytes.fill(255) });
    expect(createUlid(0)).toBe('0000000000ZZZZZZZZZZZZZZZZ');
    expect(createUlid(2 ** 48 - 1)).toBe('7ZZZZZZZZZZZZZZZZZZZZZZZZZ');
    expect(ulid(createUlid())).toBe(true);
  });
  it('makes distinct tile IDs at the same millisecond', () => {
    const ids = Array.from({ length: 1000 }, () => createUlid(1000));
    expect(new Set(ids).size).toBe(1000);
    expect(ids.every(ulid)).toBe(true);
  });
  it.each([-1, Infinity, NaN, 1.5, 2 ** 48])('rejects invalid time %s', (time) => {
    expect(() => createUlid(time)).toThrow(RangeError);
  });
});
