import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sha256, sha256Fallback } from './sha256';
afterEach(() => vi.unstubAllGlobals());
describe('ownership SHA-256', () => {
  it.each([
    '',
    'abc',
    'admin',
    'demo',
    'josé😀',
    'a'.repeat(55),
    'a'.repeat(56),
    'a'.repeat(64),
    'a'.repeat(1000),
  ])('matches SHA-256 including padding boundaries: %s', async (value) => {
    const expected = createHash('sha256').update(value).digest('hex');
    expect(sha256Fallback(value)).toBe(expected);
    expect(await sha256(value)).toBe(expected);
  });
  it('works on plain HTTP without SubtleCrypto', async () => {
    vi.stubGlobal('crypto', {});
    expect(await sha256('admin')).toBe(
      '8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918',
    );
  });
  it('falls back when digest rejects', async () => {
    vi.stubGlobal('crypto', {
      subtle: { digest: vi.fn().mockRejectedValue(new Error('Unavailable')) },
    });
    expect(await sha256('abc')).toBe(sha256Fallback('abc'));
  });
});
