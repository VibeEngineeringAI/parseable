import { describe, expect, it } from 'vitest';
import { visibleErrors } from './useTouchedErrors';

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
