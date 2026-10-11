import { text } from './tiles';

export type ValueFormat = { unit?: string; precision?: number; humanize?: boolean };

const precisionValue = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.max(-1, Math.min(20, Math.floor(value)))
    : undefined;

/** Read the display settings from a tile's config.layout record. */
export function valueFormat(layout: Record<string, unknown>): ValueFormat {
  return {
    unit: text(layout.unit).trim(),
    precision: precisionValue(layout.precision),
    humanize: layout.humanize === true,
  };
}

const currencies = new Set(['$', '€', '₹', '£', '¥', 'CN¥', 'C$', 'A$', 'CHF', 'S$', 'د.إ', 'R$']);
const suffixes = ['', 'K', 'M', 'B', 'T'];
type UnitScale = readonly [unit: string, scale: number];
const dataUnits: UnitScale[] = [
  ['B', 1],
  ['KB', 1e3],
  ['MB', 1e6],
  ['GB', 1e9],
  ['TB', 1e12],
];
const timeUnits: UnitScale[] = [
  ['ns', 1],
  ['μs', 1e3],
  ['ms', 1e6],
  ['s', 1e9],
  ['min', 60e9],
  ['h', 3_600e9],
  ['d', 86_400e9],
];

const digits = (value: number, precision: number, trim = false, grouped = true) =>
  (value === 0 ? 0 : value).toLocaleString('en-US', {
    minimumFractionDigits: trim ? 0 : precision,
    maximumFractionDigits: precision,
    useGrouping: grouped,
  });

function compact(value: number, precision: number, trim = false): string {
  let index = 0;
  while (index < suffixes.length - 1 && Math.abs(value) >= 1000 ** (index + 1)) index++;
  let number = digits(value / 1000 ** index, precision, trim, false);
  // Rounding 999.95K must promote the suffix instead of displaying 1000K.
  while (index < suffixes.length - 1 && Math.abs(Number(number)) >= 1000) {
    index++;
    number = digits(value / 1000 ** index, precision, trim, false);
  }
  return `${number}${suffixes[index]}`;
}

function withUnit(value: string, unit: string): string {
  if (currencies.has(unit))
    return value.startsWith('-') ? `-${unit}${value.slice(1)}` : `${unit}${value}`;
  // Native keeps a space before non-currency units; classic omits it.
  return `${value} ${unit}`;
}

function scaled(value: number, inputScale: number, units: UnitScale[], precision: number) {
  let [unit, scale] = units[0];
  for (const candidate of units) {
    if (Math.abs(value) < candidate[1] / inputScale) break;
    [unit, scale] = candidate;
  }
  return withUnit(digits(value * (inputScale / scale), precision), unit);
}

// Classic axes convert recognised non-currency units even with humanize off.
// Native uses one formatter for ticks, tooltips and text.
export function formatValue(value: number, format: ValueFormat = {}): string {
  if (!Number.isFinite(value)) return String(value);
  const unit = text(format.unit).trim();
  const precision = precisionValue(format.precision);
  if (!unit) return compact(value, precision !== undefined && precision >= 1 ? precision : 1, true);
  if (format.humanize !== true)
    return withUnit(digits(value, precision === -1 ? 2 : (precision ?? 0), precision === -1), unit);

  const decimals = precision === undefined || precision === -1 ? 1 : precision;
  const dataScale = dataUnits.find(([name]) => name === unit)?.[1];
  if (dataScale !== undefined) return scaled(value, dataScale, dataUnits, decimals);
  const timeScale =
    unit === 'week'
      ? 7 * 86_400e9
      : unit === 'mo'
        ? 30 * 86_400e9
        : timeUnits.find(([name]) => name === (unit === 'µs' ? 'μs' : unit))?.[1];
  if (timeScale !== undefined) return scaled(value, timeScale, timeUnits, decimals);
  return withUnit(compact(value, decimals), unit);
}
