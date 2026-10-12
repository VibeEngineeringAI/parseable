import { describe, expect, it } from 'vitest';
import { customTtlSeconds, isApiKeyExpired } from './apiKeyExpiration';

describe('API key expiration', () => {
  it('accepts both bounds and converts custom units to integer seconds', () => {
    expect(customTtlSeconds('30', 'minutes')).toBe(1800);
    expect(customTtlSeconds('0.5', 'hours')).toBe(1800);
    expect(customTtlSeconds('90', 'days')).toBe(7776000);
    expect(customTtlSeconds('1.5', 'days')).toBe(129600);
    expect(customTtlSeconds('1.1', 'hours')).toBe(3960);
    expect(customTtlSeconds('1.1', 'days')).toBe(95040);
  });
  it.each(['', ' ', '-1', '0', '29', '129601', 'NaN', 'Infinity', '30.0001'])(
    'rejects invalid minutes: %s',
    (duration) => expect(customTtlSeconds(duration, 'minutes')).toBeUndefined(),
  );
  it('rejects fractional seconds and durations just outside either bound', () => {
    expect(customTtlSeconds('30.001', 'minutes')).toBeUndefined();
    expect(customTtlSeconds('29.999999999', 'minutes')).toBeUndefined();
    expect(customTtlSeconds('90.000000001', 'days')).toBeUndefined();
  });
  it('expires at the exact timestamp and supports legacy keys', () => {
    const timestamp = '2026-01-01T00:00:00Z';
    const now = Date.parse(timestamp);
    expect(isApiKeyExpired(timestamp, now - 1)).toBe(false);
    expect(isApiKeyExpired(timestamp, now)).toBe(true);
    expect(isApiKeyExpired(timestamp, now + 1)).toBe(true);
    expect(isApiKeyExpired(null, now)).toBe(false);
    expect(isApiKeyExpired(undefined, now)).toBe(false);
  });
});
