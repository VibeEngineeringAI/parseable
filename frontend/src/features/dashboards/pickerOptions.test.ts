import { describe, expect, it } from 'vitest';
import { datasetOptions } from './pickerOptions';

describe('datasetOptions', () => {
  it('starts with the empty choice and dedupes choices', () => {
    expect(
      datasetOptions({
        choices: ['a', 'b', 'a', ''],
        selected: 'a',
        emptyLabel: 'None',
        loaded: true,
      }),
    ).toEqual([{ value: '', label: 'None' }, { value: 'a' }, { value: 'b' }]);
  });

  it('keeps a saved selection missing from discovery and marks it once loaded', () => {
    expect(
      datasetOptions({ choices: ['a'], selected: 'gone', emptyLabel: 'None', loaded: true }),
    ).toEqual([
      { value: '', label: 'None' },
      { value: 'gone', label: 'gone (unavailable)' },
      { value: 'a' },
    ]);
  });

  it('does not mark the saved selection while loading or after a failure', () => {
    expect(
      datasetOptions({ choices: [], selected: 'saved', emptyLabel: 'None', loaded: false }),
    ).toEqual([{ value: '', label: 'None' }, { value: 'saved' }]);
  });

  it('adds nothing for an empty or missing selection', () => {
    for (const selected of ['', null, undefined])
      expect(
        datasetOptions({ choices: ['a'], selected, emptyLabel: 'None', loaded: true }),
      ).toEqual([{ value: '', label: 'None' }, { value: 'a' }]);
  });
});
