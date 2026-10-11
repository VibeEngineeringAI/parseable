import { describe, expect, it } from 'vitest';
import { linearAxis, timeAxis } from './bubbleAxes';

type Axis = ReturnType<typeof linearAxis>;
const values = (axis: Axis) => axis.ticks.map((tick) => tick.value);

function expectPointPadding(axis: Axis, min: number, max: number, pixels: number) {
  expect(axis.ratio(min) * pixels).toBeCloseTo(22, 8);
  expect((1 - axis.ratio(max)) * pixels).toBeCloseTo(22, 8);
}

function expectFiniteTicks(axis: Axis) {
  expect(Number.isFinite(axis.step)).toBe(true);
  expect(axis.step).toBeGreaterThan(0);
  expect(axis.ticks.length).toBeGreaterThan(0);
  for (const tick of axis.ticks) {
    expect(Number.isFinite(tick.value)).toBe(true);
    expect(Number.isFinite(tick.ratio)).toBe(true);
    expect(tick.ratio).toBeGreaterThanOrEqual(0);
    expect(tick.ratio).toBeLessThanOrEqual(1);
    expect(tick.ratio).toBe(axis.ratio(tick.value));
  }
}

describe('bubble numeric axes', () => {
  it.each([
    { max: 303, pixels: 400, count: 5, step: 100, ticks: [0, 100, 200, 300] },
    {
      max: 4818,
      pixels: 500,
      count: 11,
      step: 500,
      ticks: [0, 500, 1000, 1500, 2000, 2500, 3000, 3500, 4000, 4500, 5000],
    },
    { max: 4818, pixels: 244, count: 5, step: 2000, ticks: [0, 2000, 4000] },
  ])(
    'uses round real-unit ticks for 0..$max at $pixels px',
    ({ max, pixels, count, step, ticks }) => {
      const axis = linearAxis(0, max, pixels, count);
      expect(axis.step).toBe(step);
      expect(values(axis)).toEqual(ticks);
      expectPointPadding(axis, 0, max, pixels);
      expectFiniteTicks(axis);
    },
  );

  it.each([
    { max: 0.9, count: 5, step: 0.25, ticks: [0, 0.25, 0.5, 0.75] },
    { max: 0.95, count: 6, step: 0.2, ticks: [0, 0.2, 0.4, 0.6, 0.8, 1] },
    { max: 0.009, count: 5, step: 0.0025, ticks: [0, 0.0025, 0.005, 0.0075] },
  ])('keeps decimal ticks clean with step $step', ({ max, count, step, ticks }) => {
    const axis = linearAxis(0, max, 440, count);
    expect(axis.step).toBe(step);
    expect(values(axis)).toEqual(ticks);
    expectFiniteTicks(axis);
  });

  it('changes tick density without changing the padded domain', () => {
    const sparse = linearAxis(13, 303, 500, 3);
    const dense = linearAxis(13, 303, 500, 9);
    expect(sparse.step).not.toBe(dense.step);
    for (const value of [0, 13, 150, 303, 320]) {
      expect(sparse.ratio(value)).toBe(dense.ratio(value));
    }
    expectPointPadding(sparse, 13, 303, 500);
    expectPointPadding(dense, 13, 303, 500);
  });

  it('keeps endpoints between tick multiples instead of rounding the domain outward', () => {
    const axis = linearAxis(103, 303, 500, 6);
    const padding = (200 * 22) / 456;
    expect(axis.ratio(103 - padding)).toBeCloseTo(0, 12);
    expect(axis.ratio(303 + padding)).toBeCloseTo(1, 12);
    expect(values(axis)).toEqual([100, 150, 200, 250, 300]);
    expect(axis.ticks[0].ratio).toBeGreaterThan(0);
    expect(axis.ticks.at(-1)!.ratio).toBeLessThan(1);
    expectPointPadding(axis, 103, 303, 500);
  });

  it('includes both sides for mixed signs and avoids negative zero or decimal noise', () => {
    const axis = linearAxis(-0.9, 0.9, 500, 11);
    expect(axis.step).toBe(0.2);
    expect(values(axis)).toEqual([-0.8, -0.6, -0.4, -0.2, 0, 0.2, 0.4, 0.6, 0.8]);
    expect(axis.ticks.some((tick) => Object.is(tick.value, -0))).toBe(false);
    expectPointPadding(axis, -0.9, 0.9, 500);
  });

  it('allows negative padding ticks on an ordinary x axis', () => {
    const axis = linearAxis(0, 303, 100, 5);
    expect(values(axis)).toEqual([-100, 0, 100, 200, 300, 400]);
    expectPointPadding(axis, 0, 303, 100);
  });

  it.each([0, 100, -100, 1e300, 1e-300])(
    'centers singleton %s with sensible expansion',
    (value) => {
      const axis = linearAxis(value, value, 500, 5);
      const spread = Math.abs(value) * 0.05 || 1;
      expect(axis.ratio(value)).toBeCloseTo(0.5, 12);
      expectPointPadding(axis, value - spread, value + spread, 500);
      expectFiniteTicks(axis);
      if (value === 0) expect(values(axis)).toEqual([-1, -0.5, 0, 0.5, 1]);
    },
  );

  it.each([1e300, 1e-300])('keeps finite, round ticks for magnitude %s', (magnitude) => {
    for (const min of [0, -magnitude]) {
      const axis = linearAxis(min, magnitude, 500, 6);
      expect(axis.step / magnitude).toBeCloseTo(min === 0 ? 0.2 : 0.5, 12);
      expectFiniteTicks(axis);
      expect(values(axis)).toContain(0);
      expect(values(axis)).toContain(magnitude);
      expectPointPadding(axis, min, magnitude, 500);
      expect(Number.isFinite(axis.ratio(min) * 500)).toBe(true);
      expect(Number.isFinite(axis.ratio(magnitude) * 500)).toBe(true);
    }
  });

  it.each([1e308, Number.MAX_VALUE])(
    'keeps geometry finite when opposite endpoints span %s',
    (max) => {
      for (const count of [2, 6]) {
        const axis = linearAxis(-max, max, 500, count);
        expectFiniteTicks(axis);
        expect(axis.ratio(0)).toBeCloseTo(0.5, 12);
        expectPointPadding(axis, -max, max, 500);
        for (const value of [-max, 0, max]) {
          expect(Number.isFinite(axis.ratio(value) * 500)).toBe(true);
        }
      }
    },
  );
});

describe('bubble time axes', () => {
  const start = Date.parse('2026-10-10T00:00:00Z') / 1000;
  const end = Date.parse('2026-10-10T03:15:00Z') / 1000;

  it('keeps the 03:15 extent tight with hourly ticks inside the padded domain', () => {
    const axis = timeAxis(start, end, 500, 5);
    expect(axis.step).toBe(3600);
    expect(values(axis)).toEqual([start, start + 3600, start + 7200, start + 10800]);
    expectPointPadding(axis, start, end, 500);
    const padding = (11700 * 22) / 456;
    expect(axis.ratio(start - padding)).toBeCloseTo(0, 8);
    expect(axis.ratio(end + padding)).toBeCloseTo(1, 8);
    expectFiniteTicks(axis);
  });

  it('changes time tick density without moving either endpoint', () => {
    const sparse = timeAxis(start, end, 500, 2);
    const dense = timeAxis(start, end, 500, 5);
    expect(sparse.step).toBe(21600);
    expect(values(sparse)).toEqual([start]);
    for (const value of [start - 1800, start, start + 3600, end, end + 1800]) {
      expect(sparse.ratio(value)).toBe(dense.ratio(value));
    }
    expectPointPadding(sparse, start, end, 500);
  });

  it('expands a singleton time by sixty seconds on either side', () => {
    const axis = timeAxis(start, start, 500, 5);
    expect(axis.ratio(start)).toBeCloseTo(0.5, 12);
    expect(axis.step).toBe(60);
    expect(values(axis)).toEqual([start - 60, start, start + 60]);
    expectPointPadding(axis, start - 60, start + 60, 500);
    expectFiniteTicks(axis);
  });

  it('preserves the time step list for subminute data', () => {
    const axis = timeAxis(start, start + 40, 500, 5);
    expect(axis.step).toBe(15);
    expect(values(axis)).toEqual([start, start + 15, start + 30]);
    expectPointPadding(axis, start, start + 40, 500);
    expectFiniteTicks(axis);
  });
});
