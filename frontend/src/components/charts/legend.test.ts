import { describe, expect, it } from 'vitest';
import { LEGEND_LABEL_LIMIT, shortenLegendLabel } from './legend';

describe('shortenLegendLabel', () => {
  it('keeps short ASCII labels and empty labels unchanged', () => {
    expect(shortenLegendLabel('service: api')).toBe('service: api');
    expect(shortenLegendLabel('')).toBe('');
  });

  it('keeps exactly 40 code points and shortens 41 with an ellipsis', () => {
    expect(LEGEND_LABEL_LIMIT).toBe(40);
    expect(shortenLegendLabel('a'.repeat(40))).toBe('a'.repeat(40));
    expect(shortenLegendLabel('a'.repeat(41))).toBe(`${'a'.repeat(40)}…`);
  });

  it('counts emoji as code points and never splits surrogate pairs', () => {
    expect(shortenLegendLabel('😀'.repeat(40))).toBe('😀'.repeat(40));
    expect(shortenLegendLabel('😀'.repeat(41))).toBe(`${'😀'.repeat(40)}…`);
    expect(shortenLegendLabel(`${'a'.repeat(39)}😀z`)).toBe(`${'a'.repeat(39)}😀…`);
  });

  it('uses a custom limit, including zero', () => {
    expect(shortenLegendLabel('abc', 3)).toBe('abc');
    expect(shortenLegendLabel('a😀bc', 2)).toBe('a😀…');
    expect(shortenLegendLabel('abc', 0)).toBe('…');
    expect(shortenLegendLabel('', 0)).toBe('');
  });
});
