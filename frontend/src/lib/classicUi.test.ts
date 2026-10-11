import { describe, expect, it } from 'vitest';
import { classicUiPath, nextUiPath } from './classicUi';
import { appPath } from './config';

describe('side-by-side classic UI', () => {
  it.each([
    ['/', '/'],
    ['/logs', '/'],
    ['/logs/explore/team%20logs', '/logs/explore/team%20logs'],
    ['/metrics', '/metrics'],
    ['/metrics/explore/x', '/metrics/explore/x'],
    ['/metrics/explore/team%20metrics', '/metrics/explore/team%20metrics'],
    ['/sql-editor', '/sql-editor'],
    ['/datasets', '/datasets'],
    ['/dashboards', '/dashboards'],
    ['/dashboards/01ABC/', '/dashboards/01ABC'],
    ['/team', '/team'],
    ['/alerts', '/alerts'],
    ['/alerts/new', '/alerts'],
    ['/alerts/targets', '/alerts'],
    ['/alerts/abc', '/alerts'],
    ['/alerts/abc/edit', '/alerts'],
    ['/components', '/'],
  ])('maps %s to the classic page %s', (route, classic) => {
    expect(classicUiPath(route)).toBe(classic);
  });
  it('prefixes document navigations with the mount path', () => {
    expect(appPath('/login', '/next')).toBe('/next/login');
    expect(appPath('/login', '')).toBe('/login');
  });
});

it('maps classic alert create links with every query parameter and hash intact', () => {
  expect(
    nextUiPath(
      '/alerts/create?dataset=x&queryBuilderType=sql&alertQuery=SELECT+1&title=Panel#draft',
    ),
  ).toBe('/alerts/new?dataset=x&queryBuilderType=sql&alertQuery=SELECT+1&title=Panel#draft');
  expect(nextUiPath('/alerts/create/?dataset=x')).toBe('/alerts/new?dataset=x');
  expect(nextUiPath('/dashboards/01ABC?range=30m')).toBe('/dashboards/01ABC?range=30m');
});
