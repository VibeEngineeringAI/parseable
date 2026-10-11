import { describe, expect, it } from 'vitest';
import { zoomRange } from './zoomRange';

const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

describe('zoomRange', () => {
  it('requires at least two points within the selection', () => {
    expect(zoomRange([], 0, 30)).toBeUndefined();
    expect(zoomRange([10], 0, 30)).toBeUndefined();
    expect(zoomRange([10, 20, 30], 11, 29)).toBeUndefined();
    expect(zoomRange([10, 20], 10, 10)).toBeUndefined();
  });

  it('accepts reversed endpoints and timestamps without mutating the input', () => {
    const timestamps = [30, 20, 10];
    expect(zoomRange(timestamps, 25, 5)).toEqual({ startTime: iso(5), endTime: iso(25) });
    expect(timestamps).toEqual([30, 20, 10]);
  });

  it('rounds selection bounds outwards to whole seconds', () => {
    expect(zoomRange([9, 10], 8.2, 12.1)).toEqual({ startTime: iso(8), endTime: iso(13) });
    expect(zoomRange([-1.5, -0.5], -1.8, -0.2)).toEqual({ startTime: iso(-2), endTime: iso(0) });
  });

  it('includes points on both boundaries and preserves whole-second bounds', () => {
    expect(zoomRange([10, 20, 30], 10, 20)).toEqual({ startTime: iso(10), endTime: iso(20) });
    expect(zoomRange([10, 20], 10.001, 20)).toBeUndefined();
    expect(zoomRange([10, 20], 10, 19.999)).toBeUndefined();
  });

  it('rejects non-finite selection bounds and ignores non-finite timestamps', () => {
    expect(zoomRange([10, 20], NaN, 30)).toBeUndefined();
    expect(zoomRange([10, 20], 0, Infinity)).toBeUndefined();
    expect(zoomRange([NaN, Infinity, 10], 0, 30)).toBeUndefined();
  });
});
