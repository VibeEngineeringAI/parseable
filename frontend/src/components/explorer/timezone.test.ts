import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TimezoneSelect } from './TimezoneSelect';
import {
  formatTimestamp,
  formatWallTime,
  getTimezones,
  isValidTimezone,
  resolveTimezone,
  resolveWallTime,
} from './timezone';

describe('timezone preferences', () => {
  it('accepts UTC, local, IANA names and aliases, and rejects invalid or fixed-offset zones', () => {
    for (const zone of ['UTC', 'local', 'America/Chicago', 'Asia/Kathmandu', 'US/Eastern'])
      expect(isValidTimezone(zone)).toBe(true);
    for (const zone of ['', 'Mars/Olympus', '+05:00', ' UTC '])
      expect(isValidTimezone(zone)).toBe(false);
  });

  it('resolves local to the current runtime timezone', () => {
    expect(resolveTimezone('local')).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(resolveTimezone('America/Chicago')).toBe('America/Chicago');
  });

  it('offers valid IANA zones with a fallback for older browsers', () => {
    expect(getTimezones()).toContain('America/Chicago');
    vi.stubGlobal('Intl', { ...Intl, supportedValuesOf: undefined });
    try {
      expect(getTimezones()).toContain('Asia/Kolkata');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('renders an accessible selector with UTC, local, IANA zones and saved aliases', () => {
    const html = renderToStaticMarkup(
      createElement(TimezoneSelect, { value: 'US/Eastern', onChange: () => {} }),
    );
    expect(html).toContain('aria-label="Timezone"');
    expect(html).toContain('<option value="UTC">UTC</option>');
    expect(html).toContain('<option value="local">Local (');
    expect(html).toContain('<option value="America/Chicago">America/Chicago</option>');
    expect(html).toContain('<option value="US/Eastern" selected="">US/Eastern</option>');
  });
});

describe('timestamp display', () => {
  it('formats UTC by default and preserves milliseconds', () => {
    expect(formatWallTime('2026-10-07T14:00:44.985Z')).toBe('2026-10-07T14:00:44.985');
    expect(formatTimestamp('2026-10-07T14:00:44.985Z', 'UTC')).toBe('2026-10-07 14:00:44.985');
  });

  it('uses the selected zone and the offset at the instant, including fractional offsets', () => {
    expect(formatTimestamp('2026-01-07T14:00:44Z', 'America/Chicago')).toBe('2026-01-07 08:00:44');
    expect(formatTimestamp('2026-07-07T14:00:44Z', 'America/Chicago')).toBe('2026-07-07 09:00:44');
    expect(formatTimestamp('2026-07-07T14:00:44Z', 'Asia/Kathmandu')).toBe('2026-07-07 19:45:44');
  });

  it('renders midnight as 00 and handles date rollover', () => {
    expect(formatWallTime('2026-07-07T05:00:00Z', 'America/Chicago')).toBe('2026-07-07T00:00:00');
    expect(formatWallTime('2026-07-07T02:00:00Z', 'America/Chicago')).toBe('2026-07-06T21:00:00');
  });

  it('interprets Arrow timestamps without offsets as UTC and honors explicit offsets', () => {
    expect(formatTimestamp('2026-10-07 14:00:44.985', 'America/Chicago')).toBe(
      '2026-10-07 09:00:44.985',
    );
    expect(formatTimestamp('2026-10-07T09:00:44.985-05:00', 'UTC')).toBe('2026-10-07 14:00:44.985');
  });

  it('supports Date and epoch milliseconds and handles malformed table values', () => {
    expect(formatTimestamp(new Date(0), 'UTC')).toBe('1970-01-01 00:00:00');
    expect(formatTimestamp(0, 'UTC')).toBe('1970-01-01 00:00:00');
    expect(formatTimestamp(null, 'UTC')).toBe('—');
    expect(formatTimestamp(undefined, 'UTC')).toBe('—');
    expect(formatTimestamp('not a timestamp', 'UTC')).toBe('not a timestamp');
    expect(formatTimestamp('2026-10-07T14:00:44Z', 'invalid')).toBe('2026-10-07 14:00:44');
  });
});

describe('wall-time conversion', () => {
  it('keeps UTC as the default and accepts datetime-local minute precision', () => {
    expect(resolveWallTime('2026-10-07T14:00')).toEqual({
      status: 'valid',
      instant: '2026-10-07T14:00:00.000Z',
    });
  });

  it('converts selected-zone wall times into UTC with millisecond precision', () => {
    expect(resolveWallTime('2026-10-07T09:00:44.985', 'America/Chicago')).toEqual({
      status: 'valid',
      instant: '2026-10-07T14:00:44.985Z',
    });
    expect(resolveWallTime('2026-10-07T19:45:44.1', 'Asia/Kathmandu')).toEqual({
      status: 'valid',
      instant: '2026-10-07T14:00:44.100Z',
    });
  });

  it('rejects impossible dates and malformed inputs instead of normalizing them', () => {
    for (const wall of [
      '2026-02-29T10:00',
      '2026-04-31T10:00',
      '2026-01-01T24:00',
      '2026-01-01T10:60',
      '2026-01-01T10:00:60',
      '2026-13-01T10:00',
      '',
      'not a date',
      '2026-01-01T10:00Z',
    ])
      expect(resolveWallTime(wall)).toEqual({ status: 'invalid' });
    expect(resolveWallTime('2026-01-01T10:00', 'invalid')).toEqual({ status: 'invalid' });
    expect(resolveWallTime('2024-02-29T10:00')).toEqual({
      status: 'valid',
      instant: '2024-02-29T10:00:00.000Z',
    });
  });

  it('detects a spring DST gap without silently moving the time', () => {
    expect(resolveWallTime('2026-03-08T02:30', 'America/Chicago')).toEqual({
      status: 'nonexistent',
    });
    expect(resolveWallTime('2026-03-08T03:00', 'America/Chicago')).toEqual({
      status: 'valid',
      instant: '2026-03-08T08:00:00.000Z',
    });
  });

  it('returns both fall DST occurrences ordered earlier to later', () => {
    expect(resolveWallTime('2026-11-01T01:30', 'America/Chicago')).toEqual({
      status: 'ambiguous',
      instants: ['2026-11-01T06:30:00.000Z', '2026-11-01T07:30:00.000Z'],
    });
  });

  it('handles half-hour DST transitions', () => {
    expect(resolveWallTime('2026-10-04T02:15', 'Australia/Lord_Howe')).toEqual({
      status: 'nonexistent',
    });
    expect(resolveWallTime('2026-04-05T01:45', 'Australia/Lord_Howe')).toEqual({
      status: 'ambiguous',
      instants: ['2026-04-04T14:45:00.000Z', '2026-04-04T15:15:00.000Z'],
    });
  });

  it('handles a skipped calendar day', () => {
    expect(resolveWallTime('2011-12-30T12:00', 'Pacific/Apia')).toEqual({ status: 'nonexistent' });
  });

  it('round-trips untouched UTC and both DST-fold instants exactly', () => {
    for (const original of [
      '2026-11-01T01:30:00.123456Z',
      '2026-11-01T01:30:00.123-05:00',
      '2026-11-01T01:30:00.123-06:00',
    ]) {
      for (const zone of ['UTC', 'America/Chicago']) {
        expect(resolveWallTime(formatWallTime(original, zone), zone, original)).toEqual({
          status: 'valid',
          instant: original,
        });
      }
    }
  });

  it('does not reuse the original instant after its wall time is edited', () => {
    expect(resolveWallTime('2026-11-01T01:31', 'America/Chicago', '2026-11-01T07:30:00Z')).toEqual({
      status: 'ambiguous',
      instants: ['2026-11-01T06:31:00.000Z', '2026-11-01T07:31:00.000Z'],
    });
  });

  it('converts local wall times using the runtime IANA zone', () => {
    const original = '2026-10-07T14:00:44.985Z';
    expect(resolveWallTime(formatWallTime(original, 'local'), 'local')).toEqual({
      status: 'valid',
      instant: original,
    });
  });
});
