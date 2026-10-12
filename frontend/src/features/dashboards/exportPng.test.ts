import { describe, expect, it } from 'vitest';
import { dashboardPngFilename, dashboardPngPixelRatio } from './exportPng';

describe('dashboard PNG export', () => {
  it('makes portable names while retaining Unicode titles', () => {
    expect(dashboardPngFilename('Latency / débit: prod?')).toBe('Latency - débit- prod-.png');
    expect(dashboardPngFilename('... ')).toBe('dashboard.png');
  });
  it('keeps small dashboards crisp and bounds large raster allocations', () => {
    expect(dashboardPngPixelRatio(1200, 800)).toBe(2);
    for (const [width, height] of [
      [1200, 40000],
      [10000, 10000],
    ]) {
      const ratio = dashboardPngPixelRatio(width, height);
      expect(Math.max(width, height) * ratio).toBeLessThanOrEqual(16384);
      expect(width * height * ratio ** 2).toBeLessThanOrEqual(32_000_001);
    }
  });
});
