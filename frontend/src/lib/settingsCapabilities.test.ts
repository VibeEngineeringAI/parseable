import { describe, expect, it } from 'vitest';
import { settingsClassicPath } from './settingsCapabilities';

describe('classic management destinations', () => {
  it('uses fixed same-origin routes for settings', () => {
    expect(settingsClassicPath('llm')).toBe('/settings/llm-key');
    expect(settingsClassicPath('keystone')).toBe('/keystone');
  });
  it('preserves an investigation ID as one segment without query or redirect injection', () => {
    const id = 'tenant/id?key=secret#//evil.example';
    const path = settingsClassicPath('keystone', id);
    const url = new URL(path, 'https://parseable.example');
    expect(url.origin).toBe('https://parseable.example');
    expect(url.search).toBe('');
    expect(url.hash).toBe('');
    expect(decodeURIComponent(url.pathname.slice('/keystone/'.length))).toBe(id);
  });
  it('falls back to the list for IDs that cannot be routed safely', () => {
    for (const id of ['.', '..', '\ud800'])
      expect(settingsClassicPath('keystone', id)).toBe('/keystone');
  });
});
