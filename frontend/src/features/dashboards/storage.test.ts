import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadDashboards, uniqueTitles, type LocalDashboard } from './storage';

const dashboard = (id: string, title: string): LocalDashboard => ({
  id,
  title,
  description: '',
  dataset: 'logs',
});
describe('uniqueTitles', () => {
  it('leaves distinct titles untouched', () => {
    const list = [dashboard('a', 'API errors'), dashboard('b', 'Latency')];
    expect(uniqueTitles(list)).toEqual(list);
  });
  it('renames later duplicates, ignoring case and whitespace', () => {
    const titles = uniqueTitles([
      dashboard('a', 'API errors'),
      dashboard('b', ' api  ERRORS '),
      dashboard('c', 'API errors'),
    ]).map((d) => d.title);
    expect(titles).toEqual(['API errors', 'api ERRORS (2)', 'API errors (3)']);
  });
  it('skips suffixes that are already taken', () => {
    const titles = uniqueTitles([
      dashboard('a', 'API errors'),
      dashboard('b', 'API errors'),
      dashboard('c', 'API errors (2)'),
    ]).map((d) => d.title);
    expect(titles).toEqual(['API errors', 'API errors (3)', 'API errors (2)']);
  });
});

afterEach(() => vi.unstubAllGlobals());
it.each(['not json', '{}', 'null', '1'])(
  'local import reads corrupt/non-array storage without changing it: %s',
  (json) => {
    const setItem = vi.fn();
    vi.stubGlobal('localStorage', { getItem: () => json, setItem });
    expect(loadDashboards('legacy')).toEqual([]);
    expect(setItem).not.toHaveBeenCalled();
  },
);
