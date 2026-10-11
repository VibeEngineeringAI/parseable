import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { prefilledInvalid, useTouchedErrors, visibleErrors } from './useTouchedErrors';

const errors = { name: 'Enter a name.', url: 'Enter a URL.', type: 'Unavailable.' };

describe('visibleErrors', () => {
  it('shows nothing on a pristine form', () => {
    expect(visibleErrors(errors, new Set(), false)).toEqual({});
  });
  it('shows only the errors of touched fields', () => {
    expect(visibleErrors(errors, new Set(['url' as const]), false)).toEqual({
      url: 'Enter a URL.',
    });
  });
  it('shows every error after a submit attempt', () => {
    expect(visibleErrors(errors, new Set(), true)).toEqual(errors);
  });
  it('always shows errors the user did not type', () => {
    expect(visibleErrors(errors, new Set(), false, ['type'])).toEqual({ type: 'Unavailable.' });
  });
  it('ignores touched fields that are valid', () => {
    expect(visibleErrors({}, new Set(['name']), false)).toEqual({});
  });
});

describe('prefilledInvalid', () => {
  it('keeps invalid fields that open with a value', () => {
    expect(prefilledInvalid(errors, { name: 'x', url: 'not a url', type: 'webhook' })).toEqual([
      'name',
      'url',
      'type',
    ]);
  });
  it('skips blank, whitespace-only, empty-list and missing values', () => {
    expect(
      prefilledInvalid({ ...errors, tags: 'Too many.' }, { name: '', url: '  ', tags: [] }),
    ).toEqual([]);
  });
  it('counts a non-empty list as a value', () => {
    expect(prefilledInvalid({ tags: 'Too many.' }, { tags: ['a'] })).toEqual(['tags']);
  });
  it('skips valid fields, even when they open with a value', () => {
    expect(prefilledInvalid({ url: 'Enter a URL.' }, { name: 'x', url: 'y' })).toEqual(['url']);
  });
});

function firstRender<K extends string>(...args: Parameters<typeof useTouchedErrors<K>>) {
  let result: ReturnType<typeof useTouchedErrors<K>> | undefined;
  function Probe() {
    result = useTouchedErrors(...args);
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  return result!;
}

describe('useTouchedErrors', () => {
  it('opens quiet without initial values', () => {
    expect(firstRender(errors).errors).toEqual({});
  });
  it('shows errors listed in always from the start', () => {
    expect(firstRender(errors, ['type']).errors).toEqual({ type: 'Unavailable.' });
  });
  it('shows the errors of prefilled values from the start, but not of blank ones', () => {
    const shown = firstRender(errors, [], { name: '', url: 'ftp:/x' });
    expect(shown.errors).toEqual({ url: 'Enter a URL.' });
    expect(shown.attempts).toBe(0);
  });
});
