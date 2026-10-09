import { afterEach, describe, expect, it, vi } from 'vitest';
import { cookieIdentity, safeReturnPath, startSso } from './auth';
afterEach(() => vi.unstubAllGlobals());

describe('safe authentication navigation', () => {
  it.each([
    'https://evil.test/logs',
    '//evil.test/logs',
    '/\\evil.test',
    '/api/v1/o/logout',
    '/login?next=/logs',
    '/oidc-not-configured',
    '/\n/evil.test',
  ])('rejects unsafe return path %s', (path) => {
    expect(safeReturnPath(path, 'https://logs.example.test')).toBe('/');
  });
  it('preserves a local application path, filters and fragment', () => {
    expect(
      safeReturnPath('/logs/explore/team%20logs?range=1h#event', 'https://logs.example.test'),
    ).toBe('/logs/explore/team%20logs?range=1h#event');
  });
  it('starts OAuth as a document navigation and remembers the intended local route', () => {
    const assign = vi.fn();
    const setItem = vi.fn();
    vi.stubGlobal('window', { location: { origin: 'https://logs.example.test', assign } });
    vi.stubGlobal('sessionStorage', { setItem });
    vi.stubGlobal('document', { cookie: 'session=expired' });
    startSso('/logs?range=1h');
    expect(assign).toHaveBeenCalledWith(
      '/api/v1/o/login?redirect=https%3A%2F%2Flogs.example.test%2Flogs%3Frange%3D1h',
    );
    expect(setItem).toHaveBeenCalledWith('parseable-return-path', '/logs?range=1h');
    expect(setItem).toHaveBeenCalledWith('parseable-mode', 'live');
  });
  it('handles cookie hints without requiring both display cookies', () => {
    expect(cookieIdentity('user_id=team%2Freader')).toEqual({
      id: 'team/reader',
      username: 'team/reader',
      source: 'cookie',
    });
    expect(cookieIdentity('session=anything')).toBeUndefined();
  });
});
