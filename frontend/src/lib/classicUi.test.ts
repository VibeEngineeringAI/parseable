import { describe, expect, it } from 'vitest';
import { classicUiPath } from './classicUi';
import { appPath } from './config';

describe('side-by-side classic UI', () => {
  it.each([
    ['/', '/'],
    ['/logs', '/'],
    ['/logs/explore/team%20logs', '/logs/explore/team%20logs'],
    ['/sql-editor', '/sql-editor'],
    ['/datasets', '/datasets'],
    ['/dashboards', '/dashboards'],
    ['/components', '/'],
  ])('maps %s to the classic page %s', (route, classic) => {
    expect(classicUiPath(route)).toBe(classic);
  });
  it('prefixes document navigations with the mount path', () => {
    expect(appPath('/login', '/next')).toBe('/next/login');
    expect(appPath('/login', '')).toBe('/login');
  });
});
