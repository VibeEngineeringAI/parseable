import { afterAll, expect, it } from 'vitest';
import { chartValue } from './chartValue';
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
      { time: '2026-10-10T12:00:00+02:00', value: 4 },
    ],
    { tile_id: 'x' },
  );
  expect(result.timestamps).toEqual([
    Date.UTC(2026, 9, 10, 10) / 1000,
    Date.UTC(2026, 9, 10, 10) / 1000,
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
