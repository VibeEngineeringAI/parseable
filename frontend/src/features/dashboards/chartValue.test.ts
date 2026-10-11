import { afterAll, expect, it } from 'vitest';
import { chartValue, diagonalFill, percentFill } from './chartValue';
import { sqlChart } from './tiles';
const originalZone = process.env.TZ;
process.env.TZ = 'Europe/Berlin';
afterAll(() => {
  if (originalZone === undefined) delete process.env.TZ;
  else process.env.TZ = originalZone;
});
it('parses offset-less Arrow timestamps as UTC even outside UTC, and honors explicit offsets', () => {
  expect(new Date('2026-10-10T10:00:00').getTimezoneOffset()).toBe(-120);
  const result = sqlChart(
    [
      { time: '2026-10-10T10:00:00.000', value: 3 },
      { time: '2026-10-10T12:30:00+02:00', value: 4 },
    ],
    { tile_id: 'x' },
  );
  expect(result.timestamps).toEqual([
    Date.UTC(2026, 9, 10, 10) / 1000,
    Date.UTC(2026, 9, 10, 10, 30) / 1000,
  ]);
  expect(result.series).toEqual([{ id: 'value', label: 'value', values: [3, 4] }]);
});
it('selects the first numeric column of the last row, accepts numeric strings, and honors a configured field', () => {
  const rows = [
    { total: 10, avg: 2 },
    { total: '20', avg: 3 },
  ];
  expect(chartValue(rows, { tile_id: 'x' })).toBe(20);
  expect(chartValue(rows, { tile_id: 'x', config: { axes: { y: { field: 'avg' } } } })).toBe(3);
  expect(chartValue([{ Series: 'host', Value: 12, Samples: 99 }], { tile_id: 'x' }, true)).toBe(12);
  expect(chartValue([{ value: 'NaN' }], { tile_id: 'x' })).toBeUndefined();
});
it('fills percent query values to their clamped share of 100 and leaves other units unfilled', () => {
  const tile = (unit: unknown) => ({ tile_id: 'x', config: { layout: { unit } } });
  expect(percentFill(42.5, tile('%'))).toBe(42.5);
  expect(percentFill(130, tile(' Percent '))).toBe(100);
  expect(percentFill(-5, tile('%'))).toBe(0);
  expect(percentFill(42, tile('ms'))).toBeUndefined();
  expect(percentFill(42, { tile_id: 'x' })).toBeUndefined();
  expect(
    percentFill(42, { tile_id: 'x', config: { layout: { unit: '%', percentFill: 'none' } } }),
  ).toBeUndefined();
});
it('sweeps a diagonal fill from the top-left corner and covers exactly the percent', () => {
  // Shoelace area of the clip polygon, as a percent of the tile.
  const area = (path: string) => {
    const points = [...path.matchAll(/([\d.]+)% ([\d.]+)%/g)].map(([, x, y]) => [+x, +y]);
    return (
      Math.abs(
        points.reduce((sum, [x, y], index) => {
          const [nextX, nextY] = points[(index + 1) % points.length];
          return sum + x * nextY - nextX * y;
        }, 0),
      ) / 200
    );
  };
  expect(diagonalFill(0)).toBe('polygon(0% 0%, 0% 0%, 0% 0%)');
  expect(diagonalFill(50)).toBe('polygon(0% 0%, 100% 0%, 0% 100%)');
  expect(diagonalFill(100)).toBe('polygon(0% 0%, 100% 0%, 100% 100%, 100% 100%, 0% 100%)');
  for (const percent of [8, 32, 50, 77, 99])
    expect(area(diagonalFill(percent))).toBeCloseTo(percent, 1);
});
