import { describe, expect, it } from 'vitest';
import { errorMessage, isStaleChunkError } from './errors';

describe('errorMessage', () => {
  it('reads the message of an Error and stringifies anything else', () => {
    expect(errorMessage(new Error('nope'))).toBe('nope');
    expect(errorMessage('plain')).toBe('plain');
    expect(errorMessage(42)).toBe('42');
    expect(errorMessage(undefined)).toBe('undefined');
  });
});

describe('isStaleChunkError', () => {
  it.each([
    new TypeError(
      'Failed to fetch dynamically imported module: http://h/next/assets/LogsPage-NYJAoOd5.js',
    ),
    new TypeError('error loading dynamically imported module: http://h/assets/LogsPage-x.js'),
    new TypeError('Importing a module script failed.'),
    // Vite's preload helper, in a build, for a page with its own stylesheet.
    new Error('Unable to preload CSS for http://h/next/assets/MetricsPage-CmRgNrLf.css'),
  ])('recognises "$message"', (error) => {
    expect(isStaleChunkError(error)).toBe(true);
  });

  it.each([
    new TypeError('Failed to fetch'),
    new TypeError("Cannot read properties of undefined (reading 'map')"),
    new Error('Invalid time range'),
    'Unable to preload CSS for http://h/x.css',
    undefined,
  ])('does not treat %s as a missing page', (error) => {
    expect(isStaleChunkError(error)).toBe(false);
  });
});
