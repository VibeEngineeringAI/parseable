import { parseEventTimestamp } from './timestamp';

/** `local` is resolved at use time so a saved preference follows the browser. */
export function resolveTimezone(timezone: string): string {
  return timezone === 'local' ? Intl.DateTimeFormat().resolvedOptions().timeZone : timezone;
}

export function isValidTimezone(timezone: string): boolean {
  if (!timezone || /^[+-]/.test(timezone)) return false;
  try {
    formatter(timezone);
    return true;
  } catch {
    return false;
  }
}

export function getTimezones(): string[] {
  const supportedValuesOf = (
    Intl as typeof Intl & { supportedValuesOf?: (key: 'timeZone') => string[] }
  ).supportedValuesOf;
  return supportedValuesOf
    ? supportedValuesOf('timeZone')
    : [
        'America/Chicago',
        'America/Denver',
        'America/Los_Angeles',
        'America/New_York',
        'Asia/Kolkata',
        'Asia/Tokyo',
        'Australia/Sydney',
        'Europe/Berlin',
        'Europe/London',
        'Pacific/Auckland',
      ];
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string): Intl.DateTimeFormat {
  const zone = resolveTimezone(timezone);
  let result = formatters.get(zone);
  if (!result) {
    result = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      calendar: 'iso8601',
      numberingSystem: 'latn',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(zone, result);
  }
  return result;
}

/** A datetime-local value, including milliseconds, with no implied UTC offset. */
export function formatWallTime(instant: string | number | Date, timezone = 'UTC'): string {
  const date = new Date(instant);
  const parts = Object.fromEntries(
    formatter(timezone)
      .formatToParts(date)
      .map(({ type, value }) => [type, value]),
  );
  const milliseconds = date.getUTCMilliseconds();
  return `${parts.year.padStart(4, '0')}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${milliseconds ? `.${String(milliseconds).padStart(3, '0')}` : ''}`;
}

/** Invalid values retain their table representation; invalid preferences fall back to UTC. */
export function formatTimestamp(value: unknown, timezone: string): string {
  const instant =
    value instanceof Date
      ? value.getTime()
      : typeof value === 'number'
        ? value
        : parseEventTimestamp(value);
  if (!Number.isFinite(instant) || !Number.isFinite(new Date(instant).getTime()))
    return value == null ? '—' : String(value);
  return formatWallTime(instant, isValidTimezone(timezone) ? timezone : 'UTC').replace('T', ' ');
}

export type WallTimeResult =
  | { status: 'valid'; instant: string }
  | { status: 'ambiguous'; instants: string[] }
  | { status: 'nonexistent' }
  | { status: 'invalid' };

function parseWallTime(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(
    value,
  );
  if (!match) return NaN;
  const [, year, month, day, hour, minute, second = '0', fraction = '0'] = match;
  const date = new Date(0);
  date.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  date.setUTCHours(Number(hour), Number(minute), Number(second), Number(fraction.padEnd(3, '0')));
  // Date setters normalize impossible dates; reject that normalization explicitly.
  if (
    date.getUTCFullYear() !== Number(year) ||
    date.getUTCMonth() !== Number(month) - 1 ||
    date.getUTCDate() !== Number(day) ||
    date.getUTCHours() !== Number(hour) ||
    date.getUTCMinutes() !== Number(minute) ||
    date.getUTCSeconds() !== Number(second)
  )
    return NaN;
  return date.getTime();
}

/**
 * Find every matching instant rather than letting Date silently shift a DST gap.
 * Probe offsets on both sides of nearby transitions, including half-hour changes
 * and skipped calendar days, then round-trip each candidate through Intl.
 * An unchanged field retains its exact original instant, even inside a DST fold.
 */
export function resolveWallTime(
  value: string,
  timezone = 'UTC',
  originalInstant?: string,
): WallTimeResult {
  const wall = parseWallTime(value);
  if (!Number.isFinite(wall) || !isValidTimezone(timezone)) return { status: 'invalid' };
  const normalized = formatWallTime(wall, 'UTC');
  if (
    originalInstant &&
    Number.isFinite(Date.parse(originalInstant)) &&
    formatWallTime(originalInstant, timezone) === normalized
  )
    return { status: 'valid', instant: originalInstant };

  const offsets = new Set<number>();
  for (let hours = -48; hours <= 48; hours += 6) {
    const probe = wall + hours * 3_600_000;
    offsets.add(parseWallTime(formatWallTime(probe, timezone)) - probe);
  }
  const instants = [...offsets]
    .map((offset) => wall - offset)
    .filter((candidate) => formatWallTime(candidate, timezone) === normalized)
    .sort((a, b) => a - b)
    .map((candidate) => new Date(candidate).toISOString());
  if (!instants.length) return { status: 'nonexistent' };
  if (instants.length > 1) return { status: 'ambiguous', instants };
  return { status: 'valid', instant: instants[0] };
}
