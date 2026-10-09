import type { PromqlLabels, PromqlRangeResult } from './types';

const units: Array<[string, number]> = [
  ['y', 365 * 86400],
  ['w', 7 * 86400],
  ['d', 86400],
  ['h', 3600],
  ['m', 60],
  ['s', 1],
  ['ms', 0.001],
];
const steps = [
  1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400, 21600, 43200, 86400,
];

export function parseDuration(text: string): number | undefined {
  const value = text.trim();
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) {
    const seconds = Number(value);
    return Number.isFinite(seconds) ? seconds : undefined;
  }
  const pattern = /(\d+(?:\.\d+)?)(ms|[ywdhms])/gy;
  let offset = 0,
    total = 0,
    previous = Infinity;
  while (offset < value.length) {
    pattern.lastIndex = offset;
    const match = pattern.exec(value);
    if (!match) return undefined;
    const scale = units.find(([unit]) => unit === match[2])![1];
    if (scale >= previous) return undefined;
    total += Number(match[1]) * scale;
    previous = scale;
    offset = pattern.lastIndex;
  }
  return offset > 0 && Number.isFinite(total) ? total : undefined;
}

export function formatStep(seconds: number): string {
  if (seconds === 0) return '0s';
  for (const [unit, scale] of units) {
    const value = seconds / scale;
    if (Number.isInteger(value)) return `${value}${unit}`;
  }
  return `${seconds}s`;
}

// Leave whitespace where quoted values and comments were, so they cannot supply range windows.
function queryCode(query: string): string {
  let result = '',
    quote = '',
    comment = false;
  for (let index = 0; index < query.length; index++) {
    const character = query[index];
    if (comment) {
      result += ' ';
      if (character === '\n') comment = false;
    } else if (quote) {
      result += ' ';
      if (character === '\\' && quote !== '`') {
        index++;
        result += ' ';
      } else if (character === quote) quote = '';
    } else if (['"', "'", '`'].includes(character)) {
      quote = character;
      result += ' ';
    } else if (character === '#') {
      comment = true;
      result += ' ';
    } else result += character;
  }
  return result;
}

function snapUp(seconds: number): number {
  return steps.find((step) => step >= seconds) ?? Math.ceil(seconds / 86400) * 86400;
}

export function autoStep({
  start,
  end,
  width,
  maxDataPoints,
  query,
}: {
  start: number;
  end: number;
  width: number;
  maxDataPoints?: number;
  query: string;
}): number {
  const maxDP = maxDataPoints ?? Math.max(60, Math.round(Math.max(400, width * 0.9) / 50) * 50);
  const range = Math.max(1, end - start);
  const seconds = Math.max(15, Math.ceil(range / maxDP));
  let window = Infinity;
  for (const match of queryCode(query).matchAll(/\[([^\[\]]+)\]/g)) {
    const duration = parseDuration(match[1]);
    if (duration !== undefined && duration > 0) window = Math.min(window, Math.floor(duration / 4));
  }
  let step = snapUp(Math.max(1, Math.min(seconds, window)));
  if (range / step > 3000) step = snapUp(Math.ceil(range / 3000));
  return step;
}

export function validateRange({
  start,
  end,
  step,
}: {
  start: number;
  end: number;
  step: string | number;
}): string | undefined {
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'Enter a valid time range.';
  if (end < start) return 'The end time must be at or after the start time.';
  if (end - start > 31 * 86400) return 'The time range cannot exceed 31 days.';
  const seconds = typeof step === 'string' ? parseDuration(step) : step;
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0)
    return 'Step must be a positive duration or number of seconds.';
  if ((end - start) / seconds + 1 > 11000)
    return 'The time range exceeds 11000 steps. Increase the step.';
  return undefined;
}

const legacyIdentifier = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const quoted = (value: string) =>
  `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n').replaceAll('\r', '\\r').replaceAll('\t', '\\t')}"`;

export function metricSelector(name: string): string {
  return legacyIdentifier.test(name) ? name : `{${quoted(name)}}`;
}

export function matcher(label: string, value: string, op: '=' | '!=' | '=~' | '!~' = '='): string {
  return `${legacyIdentifier.test(label) ? label : quoted(label)}${op}${quoted(value)}`;
}

export function varyingLabelKeys(metrics: PromqlLabels[]): string[] {
  const keys = new Set(metrics.flatMap((metric) => Object.keys(metric)));
  return [...keys]
    .filter(
      (key) => key !== '__name__' && metrics.some((metric) => metric[key] !== metrics[0]?.[key]),
    )
    .sort();
}

export function seriesLabel(
  metric: PromqlLabels,
  {
    varyingKeys,
    keepName = false,
  }: {
    varyingKeys?: readonly string[];
    keepName?: boolean;
  } = {},
): string {
  const labels = Object.keys(metric)
    .filter((key) => key !== '__name__' && (varyingKeys === undefined || varyingKeys.includes(key)))
    .sort();
  return `${keepName ? (metric.__name__ ?? '') : ''}{${labels.map((key) => matcher(key, metric[key])).join(',')}}`;
}

export function parseSampleValue(value: string | number): number {
  if (typeof value === 'number') return value;
  if (value === '+Inf' || value === 'Inf') return Infinity;
  if (value === '-Inf') return -Infinity;
  return value.trim() ? Number(value) : NaN;
}

export function formatValue(value: string | number): string {
  const number = parseSampleValue(value);
  if (!Number.isFinite(number)) return '-';
  if (number === 0) return '0';
  const magnitude = Math.abs(number);
  if (magnitude >= 1e9) return number.toExponential(2);
  if (magnitude >= 1e3) return number.toFixed(0);
  if (magnitude >= 1) return number.toFixed(2);
  if (magnitude >= 0.001) return number.toFixed(4);
  return number.toExponential(2);
}

export function toChartSeries(
  result: PromqlRangeResult,
  queryId?: string,
): {
  timestamps: number[];
  series: Array<{ id: string; label: string; metric: PromqlLabels; values: (number | null)[] }>;
} {
  const timestamps = [
    ...new Set(result.result.flatMap((series) => series.values.map(([time]) => time))),
  ].sort((a, b) => a - b);
  const varyingKeys =
    result.result.length > 1
      ? varyingLabelKeys(result.result.map((series) => series.metric))
      : undefined;
  const series = result.result
    .map(({ metric, values }) => {
      const samples = new Map(values.map(([time, value]) => [time, parseSampleValue(value)]));
      const canonical = Object.keys(metric)
        .sort()
        .map((key) => matcher(key, metric[key]))
        .join(',');
      const label = seriesLabel(metric, { varyingKeys });
      return {
        id: `${queryId ?? ''}:{${canonical}}`,
        label: queryId ? `${queryId}: ${label}` : label,
        metric,
        values: timestamps.map((time) => {
          const value = samples.get(time);
          return value !== undefined && Number.isFinite(value) ? value : null;
        }),
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
  return { timestamps, series };
}

export function summarizeSeries(values: readonly (number | null)[]): {
  last: number | null;
  min: number | null;
  max: number | null;
  avg: number | null;
} {
  let last: number | null = null,
    min: number | null = null,
    max: number | null = null,
    avg: number | null = null,
    count = 0;
  for (const value of values) {
    if (value === null || !Number.isFinite(value)) continue;
    last = value;
    min = min === null ? value : Math.min(min, value);
    max = max === null ? value : Math.max(max, value);
    count++;
    avg = avg === null ? value : avg * ((count - 1) / count) + value / count;
  }
  return { last, min, max, avg };
}

export function loadHistory(stream: string): string[] {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(`parseable:promql-history:${stream}`) ?? '[]',
    );
    return Array.isArray(value)
      ? [
          ...new Set(
            value.filter((query): query is string => typeof query === 'string' && !!query.trim()),
          ),
        ].slice(0, 10)
      : [];
  } catch {
    return [];
  }
}

export function pushHistory(stream: string, query: string): void {
  if (!query.trim()) return;
  try {
    localStorage.setItem(
      `parseable:promql-history:${stream}`,
      JSON.stringify(
        [query, ...loadHistory(stream).filter((entry) => entry !== query)].slice(0, 10),
      ),
    );
  } catch {
    /* Storage may be unavailable or full. */
  }
}
