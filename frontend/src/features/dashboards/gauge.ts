import type { DashboardTile, LogRecord, PromqlInstantResult } from '../../lib/types';
import type { QueryResult } from '../../lib/promqlResults';
import { chartValue } from './chartValue';
import { gaugeRange as layoutRange } from './chartPicker';
import { paletteColour, tilePalette } from './palettes';
import type { TileResults } from './queries';
import { record, text } from './tiles';

export const gaugeColours = { green: '#10b981', yellow: '#eab308', red: '#dc2626' } as const;
export type GaugeLevel = 'green' | 'yellow' | 'red' | 'neutral';
export type GaugeRange = { min: number; max: number };
export type GaugeModel = GaugeRange & {
  value: number;
  fraction: number;
  level: GaugeLevel;
  colour: string;
};

export const GAUGE_VIEWBOX = '0 0 200 104';
export const GAUGE_CENTRE = { x: 100, y: 100 } as const;
export const GAUGE_OUTER_RADIUS = 100;
export const GAUGE_INNER_RADIUS = 50;
export const GAUGE_TEXT = {
  centreOffset: 24,
  fitRadius: 45,
  capHeight: 0.72,
  maxSize: 32,
  minSize: 4,
  sizeStep: 0.25,
  digitAdvance: 0.6,
  narrowAdvance: 0.3,
  spaceAdvance: 0.28,
  percentAdvance: 0.92,
  uppercaseAdvance: 0.72,
  lowercaseAdvance: 0.62,
  wideAdvance: 0.95,
  otherAdvance: 0.7,
} as const;

export function gaugeRange(tile: DashboardTile): GaugeRange {
  const { from, to } = layoutRange(record(record(tile.config).layout));
  return { min: from, max: to };
}

/** Unlike classic, deliberately guard zero, reversed and NaN spans. The same step
 * at min drives both the filled fraction and percent threshold comparisons. */
function gaugeShare(value: number, { min, max }: GaugeRange): number {
  const span = max - min;
  return span > 0 ? (value - min) / span : value > min ? 1 : 0;
}

export function gaugeFraction(value: number, range: GaugeRange): number {
  return Math.max(0, Math.min(1, gaugeShare(value, range)));
}

/** Thresholds are read here rather than with chartPicker's gaugeSegments: the editor reader keeps only
 * two thresholds, whereas the renderer must see them all (more than two means the palette colour). */
export function gaugeLevel(value: number, range: GaugeRange, segments?: unknown): GaugeLevel {
  const stored = record(segments);
  const values = Array.isArray(stored.value) ? stored.value : undefined;
  const thresholds = values
    ? values
        .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
        .sort((a, b) => a - b)
    : [range.min, range.max];
  const quantity = values && stored.isPercent === true ? gaugeShare(value, range) * 100 : value;
  if (thresholds.length === 1) return quantity <= thresholds[0] ? 'green' : 'red';
  if (thresholds.length === 2)
    return quantity <= thresholds[0] ? 'green' : quantity <= thresholds[1] ? 'yellow' : 'red';
  return 'neutral';
}

export function gaugeModel(value: number, tile: DashboardTile): GaugeModel {
  const range = gaugeRange(tile);
  const level = gaugeLevel(value, range, record(record(tile.config).layout).segments);
  return {
    value,
    ...range,
    fraction: gaugeFraction(value, range),
    level,
    colour: level === 'neutral' ? paletteColour(tilePalette(tile), 0) : gaugeColours[level],
  };
}

const finiteSample = (sample: string): number | undefined => {
  const value = Number(sample);
  return Number.isFinite(value) ? value : undefined;
};

function promqlValue(result: PromqlInstantResult | undefined): number | undefined {
  if (!result) return;
  if (result.resultType === 'scalar') return finiteSample(result.result[1]);
  if (result.resultType === 'vector') {
    for (const series of result.result) {
      const value = finiteSample(series.value[1]);
      if (value !== undefined) return value;
    }
  }
  if (result.resultType === 'matrix') {
    for (const series of result.result)
      for (let index = series.values.length - 1; index >= 0; index--) {
        const value = finiteSample(series.values[index][1]);
        if (value !== undefined) return value;
      }
  }
}

/** Gauges and query values prefer a present instant envelope and use the last
 * query with a finite value, taking the first finite series within each query. */
export function promqlStatValue(queries: QueryResult[]): number | undefined {
  let value: number | undefined;
  for (const query of queries) {
    const next = promqlValue(query.instant ?? query.range);
    if (next !== undefined) value = next;
  }
  return value;
}

/** SQL gauges use the first row's first configured y field. Native-created tiles
 * with an empty field fall back to chartValue: the first numeric column of the
 * last row, matching the query-value tile. PromQL uses the last query with a value. */
export function gaugeValue(
  tile: DashboardTile,
  result: TileResults,
  rows: LogRecord[],
): number | undefined {
  if (result.promql) return promqlStatValue(result.promql);
  const row = result.rows?.[0];
  if (!row) return;
  const configured = record(record(record(tile.config).axes).y).field;
  const field = Array.isArray(configured) ? text(configured[0]) : text(configured);
  if (!field) return chartValue(rows, tile, false);
  const value = Number(row[field] ?? 0);
  return Number.isFinite(value) ? value : undefined;
}

/** Conservative bold Inter advances keep rendering deterministic without font measurements. */
export function estimateEmWidth(text: string): number {
  return [...text].reduce((width, character) => {
    let advance: number = GAUGE_TEXT.otherAdvance;
    if (/\d/.test(character)) advance = GAUGE_TEXT.digitAdvance;
    else if ('.,:ilj'.includes(character)) advance = GAUGE_TEXT.narrowAdvance;
    else if (character === ' ') advance = GAUGE_TEXT.spaceAdvance;
    else if (character === '%') advance = GAUGE_TEXT.percentAdvance;
    else if (/[A-Z]/.test(character)) advance = GAUGE_TEXT.uppercaseAdvance;
    else if ('mw'.includes(character)) advance = GAUGE_TEXT.wideAdvance;
    else if (/[a-z]/.test(character)) advance = GAUGE_TEXT.lowercaseAdvance;
    return width + advance;
  }, 0);
}

/** Centre the visual cap box 48% of the hole radius above the centre line. */
export function gaugeTextBaseline(size: number): number {
  return GAUGE_CENTRE.y - GAUGE_TEXT.centreOffset + (GAUGE_TEXT.capHeight * size) / 2;
}

/** Fit all four cap-box corners inside the hole with a 10% margin from the arc.
 * Measured advances can replace the deterministic estimate in the browser. */
export function fitGaugeText(text: string, emWidth = estimateEmWidth(text)): number {
  const fits = (size: number) => {
    const baseline = gaugeTextBaseline(size);
    return [-0.5, 0.5].every((side) =>
      [baseline - GAUGE_TEXT.capHeight * size, baseline].every(
        (height) =>
          Math.hypot(emWidth * size * side, height - GAUGE_CENTRE.y) <= GAUGE_TEXT.fitRadius,
      ),
    );
  };
  let size: number = GAUGE_TEXT.maxSize;
  while (size > GAUGE_TEXT.minSize && !fits(size)) size -= GAUGE_TEXT.sizeStep;
  return size;
}
