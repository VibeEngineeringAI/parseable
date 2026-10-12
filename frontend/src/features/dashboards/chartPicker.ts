import type { DashboardTile } from '../../lib/types';
import { record, text } from './tiles';

export type ChartChoice =
  | 'timeseries'
  | 'line'
  | 'bar'
  | 'stacked-bar'
  | 'area'
  | 'pie'
  | 'donut'
  | 'query-value'
  | 'gauge'
  | 'table'
  | 'bubble';

export const chartChoices: { value: ChartChoice; label: string }[] = [
  { value: 'timeseries', label: 'Timeseries' },
  { value: 'line', label: 'Line' },
  { value: 'bar', label: 'Bar' },
  { value: 'stacked-bar', label: 'Stacked bar' },
  { value: 'area', label: 'Area' },
  { value: 'pie', label: 'Pie' },
  { value: 'donut', label: 'Donut' },
  { value: 'query-value', label: 'Query value' },
  { value: 'gauge', label: 'Gauge' },
  { value: 'table', label: 'Table' },
  { value: 'bubble', label: 'Bubble' },
];

export function chartChoice(tile: DashboardTile): ChartChoice | undefined {
  const type = tile.chartType === undefined ? 'timeseries' : text(tile.chartType);
  const config = record(tile.config);
  if (type === 'timeseries' && config.type === 'bar' && record(config.layout).stacked === true)
    return 'stacked-bar';
  return chartChoices.find(({ value }) => value === type && value !== 'stacked-bar')?.value;
}

export type SeriesStyle = 'line' | 'bar' | 'area';

export function seriesStyle(tile: DashboardTile): SeriesStyle {
  const type = record(tile.config).type;
  return type === 'line' || type === 'bar' || type === 'area' ? type : 'line';
}

export function applyChartChoice(tile: DashboardTile, choice: ChartChoice): Partial<DashboardTile> {
  const config = record(tile.config);
  const layout: Record<string, unknown> = {
    ...record(config.layout),
    stacked: choice === 'stacked-bar',
  };
  if (choice !== 'bar' && choice !== 'stacked-bar') delete layout.barOrientation;
  if (choice === 'query-value') layout.sparkline = true;
  return {
    chartType: choice === 'stacked-bar' ? 'timeseries' : choice,
    config: {
      ...config,
      type: choice === 'stacked-bar' ? 'bar' : choice === 'timeseries' ? seriesStyle(tile) : choice,
      layout,
    },
  };
}

export function applySeriesStyle(tile: DashboardTile, style: SeriesStyle): Partial<DashboardTile> {
  const config: Record<string, unknown> = { ...record(tile.config), type: style };
  const layout = record(config.layout);
  if (Object.hasOwn(layout, 'stacked') || Object.hasOwn(layout, 'barOrientation')) {
    const next = { ...layout };
    delete next.stacked;
    delete next.barOrientation;
    config.layout = next;
  }
  return { config };
}

export const queryValueThemeKeys = [
  'blue',
  'brown',
  'emerald',
  'fuchsia',
  'grey',
  'orange',
  'pink',
  'purple',
  'red',
  'yellow',
] as const;

export function queryValueThemeOf(layout: unknown): (typeof queryValueThemeKeys)[number] {
  const theme = record(layout).queryValueTheme;
  return queryValueThemeKeys.find((key) => key === theme) ?? 'blue';
}

export function sparklineOf(layout: unknown): boolean {
  return record(layout).sparkline === true;
}

export type Appearance = {
  colourScheme: boolean;
  legend: 'none' | 'basic' | 'full';
  label: boolean;
  orientation: boolean;
  seriesStyle: boolean;
  range: boolean;
  segments: boolean;
  humanize: boolean;
  axisTitles: boolean;
  queryValueTheme: boolean;
  sparkline: boolean;
};

export function appearanceFor(choice: ChartChoice | undefined): Appearance {
  const scalar = choice === 'gauge' || choice === 'query-value';
  const slices = choice === 'pie' || choice === 'donut';
  return {
    colourScheme: choice !== undefined && !scalar,
    legend: choice === undefined || scalar ? 'none' : slices ? 'full' : 'basic',
    label: slices,
    orientation: choice === 'bar' || choice === 'stacked-bar',
    seriesStyle: choice === 'timeseries',
    range: choice === 'gauge',
    segments: choice === 'gauge',
    humanize: scalar,
    axisTitles: choice !== undefined && !scalar && !slices,
    queryValueTheme: choice === 'query-value',
    sparkline: choice === 'query-value',
  };
}

export type Bindings = {
  x: false | 'single';
  y: false | 'single' | 'multi';
  groupBy: boolean;
  yMax?: number;
  groupByMax?: number;
  size: boolean;
  yLabel: string;
  yHint?: string;
  xLabel: string;
};

export function bindingsFor(choice: ChartChoice | undefined): Bindings {
  const bindings: Bindings = {
    x: false,
    y: false,
    groupBy: false,
    size: false,
    yLabel: 'Y axis',
    xLabel: 'X axis',
  };
  if (choice === undefined || choice === 'table') return bindings;
  if (choice === 'pie' || choice === 'donut')
    return {
      ...bindings,
      y: 'single',
      yLabel: 'Category column',
      yHint:
        'Pie and donut charts take the slice labels from this column; the slice size is the first other column returned by the query.',
    };
  if (choice === 'gauge' || choice === 'query-value')
    return {
      ...bindings,
      y: 'single',
      yLabel: choice === 'gauge' ? 'Value column' : 'Value column (optional)',
      yHint:
        choice === 'gauge'
          ? 'The first row of this column is shown.'
          : 'Defaults to the first numeric column of the last row.',
    };
  return {
    ...bindings,
    x: 'single',
    y: choice === 'bubble' ? 'single' : 'multi',
    groupBy: true,
    ...(choice === 'stacked-bar'
      ? { yMax: 1, yHint: 'Choose one Y column; use Group by to split it into stacked series.' }
      : {}),
    ...(choice === 'bubble' ? { groupByMax: 1 } : {}),
    size: choice === 'bubble',
    xLabel: choice === 'bubble' ? 'X axis' : 'X axis (time or category)',
  };
}

export function fieldList(value: unknown): string[] {
  if (Array.isArray(value))
    return value.filter((field): field is string => typeof field === 'string');
  return typeof value === 'string' && value !== '' ? [value] : [];
}

export function applyBinding(
  tile: DashboardTile,
  which: 'x' | 'y' | 'size' | 'groupBy',
  value: string | string[],
): Partial<DashboardTile> {
  const config = record(tile.config),
    axes = record(config.axes),
    fields = fieldList(value);
  const field =
    which === 'groupBy'
      ? fields.slice(0, 2)
      : which === 'y' && fields.length > 1
        ? fields
        : (fields[0] ?? '');
  return {
    config: { ...config, axes: { ...axes, [which]: { ...record(axes[which]), field } } },
  };
}

export type Segments = { value: number[]; isPercent: boolean };
type GaugeRange = { from: number; to: number };

export function gaugeRange(value: unknown): GaugeRange {
  const layout = record(value);
  return {
    from:
      typeof layout.rangeFrom === 'number' && Number.isFinite(layout.rangeFrom)
        ? layout.rangeFrom
        : 0,
    to:
      typeof layout.rangeTo === 'number' && Number.isFinite(layout.rangeTo) ? layout.rangeTo : 100,
  };
}

export function gaugeSegments(value: unknown): Segments {
  const layout = record(value);
  if (!Object.hasOwn(layout, 'segments')) {
    const { from, to } = gaugeRange(layout);
    return { value: [from, to], isPercent: false };
  }
  const segments = record(layout.segments);
  return {
    value:
      Array.isArray(segments.value) && segments.value.every((item) => typeof item === 'number')
        ? segments.value.slice(0, 2)
        : [],
    isPercent: segments.isPercent === true,
  };
}

export function setSegmentCount(layout: unknown, count: 0 | 1 | 2): Segments {
  const segments = gaugeSegments(layout);
  const { from, to } = segments.isPercent ? { from: 0, to: 100 } : gaugeRange(layout);
  const value = segments.value.slice(0, count);
  while (value.length < count) value.push(Math.floor(((value[0] ?? from) + to) / 2));
  return { ...segments, value };
}

function scaleThreshold(value: number, oldRange: GaugeRange, newRange: GaugeRange): number {
  if (oldRange.from === oldRange.to) return value;
  const scaled =
    newRange.from +
    ((value - oldRange.from) / (oldRange.to - oldRange.from)) * (newRange.to - newRange.from);
  return Math.round(scaled * 100) / 100;
}

export function setSegmentMode(layout: unknown, isPercent: boolean): Segments {
  const segments = gaugeSegments(layout);
  if (segments.isPercent === isPercent) return segments;
  const range = gaugeRange(layout),
    percent = { from: 0, to: 100 };
  return {
    value: segments.value.map((value) =>
      scaleThreshold(value, isPercent ? range : percent, isPercent ? percent : range),
    ),
    isPercent,
  };
}

export function rescaleSegments(
  oldRange: GaugeRange,
  newRange: GaugeRange,
  segments: Segments,
): Segments {
  if (segments.isPercent) return segments;
  return {
    ...segments,
    value: segments.value.map((value) => scaleThreshold(value, oldRange, newRange)),
  };
}

export function chartIssues(tile: DashboardTile): string[] {
  const choice = chartChoice(tile);
  const axes = record(record(tile.config).axes);
  if (tile.tileType !== 'promql') {
    if (choice === 'stacked-bar' && fieldList(record(axes.y).field).length > 1)
      return [
        'Stacked bar supports one Y column. Remove extra Y fields and use Group by for series.',
      ];
    if (choice === 'bubble' && fieldList(record(axes.groupBy).field).length > 1)
      return ['Bubble supports one Group by column. Remove extra grouping fields.'];
  }
  if (chartChoice(tile) !== 'gauge') return [];
  const layout = record(record(tile.config).layout),
    range = gaugeRange(layout),
    segments = gaugeSegments(layout),
    issues: string[] = [];
  if (range.from >= range.to) issues.push('Range from must be below Range to.');
  if (
    segments.value.some(
      (value, index) =>
        !Number.isFinite(value) || (index > 0 && value <= segments.value[index - 1]),
    )
  )
    issues.push('Segment thresholds must increase.');
  if (segments.isPercent) {
    if (segments.value.some((value) => value < 0 || value > 100))
      issues.push('Percent thresholds must be between 0 and 100.');
  } else if (segments.value.some((value) => value < range.from || value > range.to))
    issues.push('Absolute thresholds must be within the range.');
  return issues;
}
