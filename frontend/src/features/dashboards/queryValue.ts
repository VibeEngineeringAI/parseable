import type { DashboardTile, LogRecord } from '../../lib/types';
import type { CartesianChart } from './cartesian';
import { chartValue } from './chartValue';
import { promqlStatValue } from './gauge';
import type { TileResults } from './queries';
import { record, text } from './tiles';

/** Classic light colours are unchanged. On white, emerald is 3.77:1 and orange
 * 3.56:1: below 4.5:1 but above 3:1 for our minimum 20px bold large text.
 * Yellow is 2.94:1 on white, below even 3:1, so the value text (not the tint or
 * sparkline) uses `ink` #A16207 (4.92:1) for yellow; every other ink is the classic hex.
 * Dark colours were chosen by mixing each light hue with white in 1% steps,
 * stopping at >= 4.7:1 against both #1d1f2a and an 18% sRGB self-tint.
 * Ratios (surface / tinted surface): blue 6.55/4.74, brown 6.48/4.73,
 * emerald 6.46/4.73, fuchsia 6.51/4.74, grey 6.52/4.73, orange 6.37/4.73,
 * pink 6.40/4.72, purple 6.53/4.74, red 6.42/4.73, yellow 6.40/4.72. */
export const queryValueThemes = {
  blue: { label: 'Blue', light: '#3563E9', dark: '#86A1F2' },
  brown: { label: 'Brown', light: '#9A3412', dark: '#CB9786' },
  emerald: { label: 'Emerald', light: '#059669', dark: '#4EB494' },
  fuchsia: { label: 'Fuchsia', light: '#A21CAF', dark: '#D08BD6' },
  grey: { label: 'Grey', light: '#52525B', dark: '#A3A3A8' },
  orange: { label: 'Orange', light: '#EA580C', dark: '#F0854E' },
  pink: { label: 'Pink', light: '#DB2777', dark: '#EA80AF' },
  purple: { label: 'Purple', light: '#6D28D9', dark: '#B693EC' },
  red: { label: 'Red', light: '#DC2626', dark: '#EB8585' },
  yellow: { label: 'Yellow', light: '#CA8A04', dark: '#D09822', ink: '#A16207' },
} as const satisfies Record<string, { label: string; light: string; dark: string; ink?: string }>;
export type QueryValueTheme = keyof typeof queryValueThemes;

export function queryValueTheme(tile: DashboardTile): QueryValueTheme {
  const stored = text(record(record(tile.config).layout).queryValueTheme);
  return Object.hasOwn(queryValueThemes, stored) ? (stored as QueryValueTheme) : 'blue';
}

export const sparklineEnabled = (tile: DashboardTile): boolean =>
  tile.chartType === 'query-value' && record(record(tile.config).layout).sparkline === true;

/** Classic starts at 100px and shrinks in 4px steps to fit 90% of the width.
 * Deliberately also cap at 70% of the height: classic's canvas always had room.
 * The 20px minimum takes precedence over the height cap. Deliberate deviation: when
 * the text still overflows the width at 20px (a long formatted value in a narrow
 * tile) it keeps shrinking by 1px down to 10px, because a clipped number is worse. */
export function fitFontSize({
  measure,
  width,
  height,
}: {
  measure: (px: number) => number;
  width: number;
  height: number;
}): number {
  let size = 100;
  while (size > 20 && (size > height * 0.7 || measure(size) > width * 0.9)) size -= 4;
  while (size > 10 && measure(size) > width * 0.9) size -= 1;
  return size;
}

export function sparklineValues(
  tile: DashboardTile,
  result: TileResults,
  chart: CartesianChart,
): number[] | undefined {
  if (!sparklineEnabled(tile)) return;
  let values: number[] | undefined;
  if (result.promql) {
    const series = result.promql[0]?.range?.result.find((series) =>
      series.values.some(([, value]) => Number.isFinite(Number(value))),
    );
    values = series?.values
      .slice()
      .sort(([a], [b]) => a - b)
      .map(([, value]) => Number(value))
      .filter(Number.isFinite);
  } else if (!chart.categorical && !chart.categories) {
    // Classic runs an extra time-bucketed SQL query. Native deliberately only
    // draws a trend when the tile's own rows already form a timestamp series.
    values = chart.series[0]?.values.filter(
      (value): value is number => value !== null && Number.isFinite(value),
    );
  }
  return values && values.length >= 2 ? values : undefined;
}

/** Preserve SQL's last-row rule; PromQL shares the gauge's instant preference
 * and last usable query, while a sparkline takes only the first query's trend. */
export function queryValueNumber(
  tile: DashboardTile,
  result: TileResults,
  rows: LogRecord[],
): number | undefined {
  return result.promql ? promqlStatValue(result.promql) : chartValue(rows, tile, false);
}

/** Evenly spaced points in a 100x100 viewBox, with 8% vertical padding. */
export function sparklinePath(values: number[]): { line: string; area: string } {
  if (values.length < 2) return { line: '', area: '' };
  const min = Math.min(...values),
    max = Math.max(...values);
  const at = (value: number) => Number(value.toFixed(2));
  const line = values
    .map((value, index) => {
      const x = at((index / (values.length - 1)) * 100);
      const y = at(max === min ? 50 : 8 + ((max - value) / (max - min)) * 84);
      return `${index === 0 ? 'M' : 'L'} ${x} ${y}`;
    })
    .join(' ');
  return { line, area: `${line} L 100 100 L 0 100 Z` };
}
