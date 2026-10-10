import { timeBounds } from '../../lib/query';
import { object } from '../../lib/guards';
import type { TimeRange } from '../../lib/types';
import { dashboardPresets } from './helpers';
const presets: string[] = dashboardPresets.map((preset) => preset.value);
export function storedRange(value: unknown, now = Date.now()): TimeRange {
  if (object(value)) {
    if (
      value.type === 'fixed' &&
      typeof value.startTime === 'string' &&
      presets.includes(value.startTime)
    )
      return value.startTime as TimeRange;
    if (typeof value.startTime === 'string' && typeof value.endTime === 'string') {
      try {
        return timeBounds({
          startTime: value.startTime,
          endTime: value.endTime === 'now' ? new Date(now).toISOString() : value.endTime,
        });
      } catch {
        /* Older/custom ranges may be unavailable. */
      }
    }
    if (typeof value.interval === 'number') {
      const preset = dashboardPresets.find(
        (preset) =>
          Date.parse(timeBounds(preset.value, 0).endTime) -
            Date.parse(timeBounds(preset.value, 0).startTime) ===
          value.interval,
      );
      if (preset) return preset.value;
    }
  }
  return '1h';
}
export function dashboardRange(
  params: URLSearchParams,
  stored: unknown,
  now = Date.now(),
): TimeRange {
  const range = params.get('range');
  if (range && presets.includes(range)) return range as TimeRange;
  const startTime = params.get('start'),
    endTime = params.get('end');
  if (startTime && endTime) {
    try {
      return timeBounds({ startTime, endTime });
    } catch {
      /* Fall back to the saved range. */
    }
  }
  return storedRange(stored, now);
}
export function rangeParams(params: URLSearchParams, range: TimeRange) {
  const next = new URLSearchParams(params);
  for (const key of ['range', 'start', 'end']) next.delete(key);
  if (typeof range === 'string') next.set('range', range);
  else {
    next.set('start', range.startTime);
    next.set('end', range.endTime);
  }
  return next;
}
export function classicTimeRange(range: TimeRange, previous: unknown) {
  const bounds = timeBounds(range, 0),
    interval = Date.parse(bounds.endTime) - Date.parse(bounds.startTime);
  return {
    ...(object(previous) ? previous : {}),
    ...(typeof range === 'string'
      ? {
          startTime: range,
          endTime: 'now',
          type: 'fixed',
          label: dashboardPresets.find((preset) => preset.value === range)?.label ?? range,
        }
      : { ...range, type: 'custom', label: `${range.startTime} to ${range.endTime}` }),
    interval,
    shiftInterval: 1,
  };
}
