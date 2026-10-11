type Sample = number | null;

export function paddedValueBounds(min: number, max: number, includeZero = false): [number, number] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  const span = max - min;
  const pad = span > 0 ? span * 0.05 : Math.max(Math.abs(max) * 0.05, 1);
  const lower = min >= 0 ? 0 : min - pad;
  const upper = max + pad;
  return [includeZero ? Math.min(0, lower) : lower, includeZero ? Math.max(0, upper) : upper];
}

export function categoryBounds(count: number, bars: boolean): [number, number] {
  return bars || count <= 1 ? [-0.5, Math.max(0.5, count - 0.5)] : [0, count - 1];
}

export function barSlotSize(timestamps: readonly number[], categorical = false): number {
  if (categorical) return 1;
  let step = Infinity;
  for (let index = 1; index < timestamps.length; index++) {
    const gap = timestamps[index] - timestamps[index - 1];
    if (gap > 0 && gap < step) step = gap;
  }
  return Number.isFinite(step) ? step : 60;
}

export function timeBarBounds(timestamps: readonly number[]): [number, number] {
  const halfSlot = barSlotSize(timestamps) / 2;
  return [(timestamps[0] ?? 0) - halfSlot, (timestamps.at(-1) ?? 0) + halfSlot];
}

/** Cumulative values in incoming order; draw in reverse order to expose each segment. */
export function stackValues(
  values: readonly (readonly Sample[])[],
  shown: readonly boolean[],
): Sample[][] {
  const count = values.reduce((length, samples) => Math.max(length, samples.length), 0);
  const positive = Array<number>(count).fill(0);
  const negative = Array<number>(count).fill(0);
  return values.map((samples, seriesIndex) =>
    Array.from({ length: count }, (_, index) => {
      const value = samples[index];
      if (!shown[seriesIndex] || value == null || !Number.isFinite(value)) return null;
      const totals = value >= 0 ? positive : negative;
      totals[index] += value;
      return totals[index];
    }),
  );
}

export type BarLayout = { offset: number; width: number };

/** Offsets and widths are fractions of one category (or the smallest time interval). */
export function groupedBarLayout(shown: readonly boolean[], stacked = false): (BarLayout | null)[] {
  const count = shown.filter(Boolean).length;
  const slot = 0.8 / Math.max(1, count);
  let position = 0;
  return shown.map((show) => {
    if (!show) return null;
    if (stacked) return { offset: 0, width: 0.8 * 0.9 };
    return { offset: -0.4 + slot * (position++ + 0.5), width: slot * 0.9 };
  });
}

export function hexToRgba(color: string, alpha: number): string {
  let hex = color.trim().replace(/^#/, '');
  if (!/^(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(hex)) return color;
  if (hex.length <= 4) hex = [...hex.slice(0, 3)].map((digit) => digit + digit).join('');
  const channels = [0, 2, 4].map((index) => parseInt(hex.slice(index, index + 2), 16));
  return `rgba(${channels.join(', ')}, ${Math.max(0, Math.min(1, alpha))})`;
}

export function thinCategoryTicks(
  count: number,
  axisLength: number,
  labelWidth: number,
  maxTicks = 8,
): number[] {
  if (count <= 0) return [];
  const available = Math.max(1, Math.floor(axisLength / (labelWidth + 16)));
  const ticks = Math.min(count, Math.max(1, Math.floor(maxTicks)), available);
  if (ticks === 1) return [0];
  return Array.from({ length: ticks }, (_, index) =>
    Math.round((index * (count - 1)) / (ticks - 1)),
  );
}

export function formatNumericTicks(
  values: readonly number[],
  format: (value: number) => string,
): string[] {
  let previous: string | undefined;
  return values.map((value) => {
    const label = format(value);
    const repeated = label === previous;
    previous = label;
    return repeated ? '' : label;
  });
}

export function truncateCategoryLabel(
  label: string,
  maxWidth: number,
  measure: (text: string) => number,
): string {
  if (measure(label) <= maxWidth) return label;
  if (measure('…') > maxWidth) return '';
  const letters = [...label];
  let low = 0;
  let high = letters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (measure(`${letters.slice(0, middle).join('')}…`) <= maxWidth) low = middle;
    else high = middle - 1;
  }
  return `${letters.slice(0, low).join('')}…`;
}
