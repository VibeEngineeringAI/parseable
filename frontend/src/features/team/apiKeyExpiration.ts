export const API_KEY_MIN_TTL_SECONDS = 30 * 60;
export const API_KEY_MAX_TTL_SECONDS = 90 * 24 * 60 * 60;
export const durationUnits = { minutes: 60, hours: 60 * 60, days: 24 * 60 * 60 };
export type DurationUnit = keyof typeof durationUnits;

export const expirationPresets = [
  { label: '30 minutes', seconds: 30 * 60 },
  { label: '1 hour', seconds: 60 * 60 },
  { label: '12 hours', seconds: 12 * 60 * 60 },
  { label: '1 day', seconds: 24 * 60 * 60 },
  { label: '7 days', seconds: 7 * 24 * 60 * 60 },
  { label: '30 days', seconds: 30 * 24 * 60 * 60 },
  { label: '90 days', seconds: API_KEY_MAX_TTL_SECONDS },
];

export function customTtlSeconds(duration: string, unit: DurationUnit): number | undefined {
  if (!duration.trim()) return undefined;
  const seconds = Number(duration) * durationUnits[unit];
  const roundedSeconds = Math.round(seconds);
  // Decimal durations can introduce tiny floating-point errors during unit conversion.
  return Number.isFinite(seconds) &&
    Math.abs(seconds - roundedSeconds) <= 1e-6 &&
    seconds >= API_KEY_MIN_TTL_SECONDS &&
    seconds <= API_KEY_MAX_TTL_SECONDS
    ? roundedSeconds
    : undefined;
}

export function isApiKeyExpired(expiresAt: string | null | undefined, now = Date.now()): boolean {
  return !!expiresAt && Date.parse(expiresAt) <= now;
}
