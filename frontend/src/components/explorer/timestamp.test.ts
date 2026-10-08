import { describe, expect, it } from 'vitest';
import { parseEventTimestamp } from './timestamp';
describe('Arrow event timestamps', () => {
  it('interprets timezone-less timestamps as UTC in a non-UTC browser timezone', () => {
    const previous = process.env.TZ;
    process.env.TZ = 'America/Chicago';
    try {
      expect(parseEventTimestamp('2026-10-07T14:00:44.985')).toBe(
        Date.parse('2026-10-07T14:00:44.985Z'),
      );
      expect(parseEventTimestamp('2026-10-07 14:00:44.985')).toBe(
        Date.parse('2026-10-07T14:00:44.985Z'),
      );
      expect(parseEventTimestamp('2026-10-07T09:00:44.985-05:00')).toBe(
        Date.parse('2026-10-07T14:00:44.985Z'),
      );
      expect(parseEventTimestamp(null)).toBeNaN();
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });
});
