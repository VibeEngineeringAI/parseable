import uPlot from 'uplot';
import {
  barSlotSize,
  categoryBounds,
  formatNumericTicks,
  groupedBarLayout,
  hexToRgba,
  paddedValueBounds,
  stackValues,
  thinCategoryTicks,
  timeBarBounds,
  truncateCategoryLabel,
} from './cartesianData';
import { PALETTE_SIZE } from './seriesSelection';

export type PositionedSeries = {
  series: { id: string; label: string; values: (number | null)[] };
  slot: number;
  color?: string;
};

type PlotSettings = {
  timestamps: number[];
  entries: PositionedSeries[];
  colors: string[];
  hidden: ReadonlySet<string>;
  highlighted: string | null;
  categories?: readonly string[];
  kind: 'line' | 'bar';
  fill: boolean;
  smooth: boolean;
  stacked: boolean;
  horizontal: boolean;
  showXAxis: boolean;
  paddedBounds: boolean;
  xMin?: number;
  xMax?: number;
  xAxisTitle?: string;
  valueAxisTitle?: string;
  zoomable?: boolean;
  references: readonly { value: number }[];
  yAxisSize: number;
  formatValue: (value: number) => string;
  font: string;
  grid: string;
  muted: string;
  surface: string;
};

// 24-hour ticks matching the tooltip: increment, default, year/month/day/hour/minute/second, mode.
const timeAxisFormats: uPlot.Axis.Values = [
  [3600 * 24 * 365, '{YYYY}', null, null, null, null, null, null, 1],
  [3600 * 24 * 28, '{MMM}', '\n{YYYY}', null, null, null, null, null, 1],
  [3600 * 24, '{MMM} {D}', '\n{YYYY}', null, null, null, null, null, 1],
  [3600, '{HH}:{mm}', '\n{MMM} {D}', null, '\n{MMM} {D}', null, null, null, 1],
  [60, '{HH}:{mm}', '\n{MMM} {D}', null, '\n{MMM} {D}', null, null, null, 1],
  [1, '{HH}:{mm}:{ss}', '\n{MMM} {D}', null, '\n{MMM} {D}', null, null, null, 1],
];

export function seriesWidth(
  entry: PositionedSeries,
  highlighted: string | null,
  kind: 'line' | 'bar',
  fill: boolean,
): number {
  if (kind === 'bar') return 0;
  if (fill) return 1;
  return highlighted === entry.series.id ? 2 : entry.slot < PALETTE_SIZE ? 1.5 : 1;
}

function categoryAxis(
  categories: readonly string[],
  horizontal: boolean,
  size: number,
  font: string,
): uPlot.Axis {
  function labels(self: uPlot) {
    const axisLength = (horizontal ? self.bbox.height : self.bbox.width) / uPlot.pxRatio;
    const maxWidth = horizontal
      ? Math.max(16, size - 16)
      : Math.max(16, Math.min(120, axisLength - 16));
    self.ctx.save();
    self.ctx.font = font;
    const measure = (text: string) => self.ctx.measureText(text).width;
    const text = categories.map((label) => truncateCategoryLabel(label, maxWidth, measure));
    const labelWidth = horizontal
      ? 11
      : text.reduce((width, label) => Math.max(width, measure(label)), 0);
    self.ctx.restore();
    return { text, axisLength, labelWidth };
  }

  return {
    scale: 'x',
    side: horizontal ? 3 : 2,
    size: horizontal ? size : 50,
    rotate: 0,
    grid: { show: false },
    splits: (self, _, min, max) => {
      const { axisLength, labelWidth } = labels(self);
      return thinCategoryTicks(categories.length, axisLength, labelWidth).filter(
        (index) => index >= min && index <= max,
      );
    },
    values: (self, splits) => {
      const { text } = labels(self);
      return splits.map((index) => text[index] ?? '');
    },
  };
}

export function cartesianPlot({
  timestamps,
  entries,
  colors,
  hidden,
  highlighted,
  categories,
  kind,
  fill,
  smooth,
  stacked,
  horizontal,
  showXAxis,
  paddedBounds,
  xMin,
  xMax,
  xAxisTitle,
  valueAxisTitle,
  zoomable = false,
  references,
  yAxisSize,
  formatValue,
  font,
  grid,
  muted,
  surface,
}: PlotSettings): {
  data: uPlot.AlignedData;
  options: Pick<uPlot.Options, 'scales' | 'series' | 'axes' | 'cursor'>;
} {
  const bars = kind === 'bar';
  horizontal = bars && categories !== undefined && horizontal;
  const shown = entries.map(({ series }) => !hidden.has(series.id));
  const values = entries.map(({ series }) =>
    timestamps.map((_, index) => {
      const value = series.values[index];
      return value != null && Number.isFinite(value) ? value : null;
    }),
  );
  // Stacked entries arrive in drawing order (top first); accumulate from the baseline up.
  const plotted =
    bars && stacked ? stackValues([...values].reverse(), [...shown].reverse()).reverse() : values;
  const data: uPlot.AlignedData = [timestamps, ...plotted];
  const layout = bars ? groupedBarLayout(shown, stacked) : [];
  const slotSize = bars ? barSlotSize(timestamps, categories !== undefined) : 0;
  const themeAxis: uPlot.Axis = {
    stroke: muted,
    font,
    grid: { stroke: grid, width: 1 },
    ticks: { stroke: grid, width: 1 },
  };
  const xAxis: uPlot.Axis = {
    ...themeAxis,
    values: timeAxisFormats,
    ...(categories !== undefined ? categoryAxis(categories, horizontal, yAxisSize, font) : {}),
    ...(!showXAxis ? { show: false } : {}),
    ...(horizontal && xAxisTitle ? { label: xAxisTitle, labelFont: font, labelSize: 24 } : {}),
  };
  const yAxis: uPlot.Axis = {
    ...themeAxis,
    size: yAxisSize,
    values: (_, values) =>
      bars || paddedBounds || categories !== undefined
        ? formatNumericTicks(values, formatValue)
        : values.map(formatValue),
    ...(horizontal
      ? {
          scale: 'y',
          side: 2,
          size: 40,
          space: (_self, _axis, _min, _max, plotSize) => Math.max(50, plotSize / 7),
          ...(valueAxisTitle ? { label: valueAxisTitle, labelFont: font, labelSize: 24 } : {}),
        }
      : {}),
  };
  const xScale: uPlot.Scale = {
    range:
      categories !== undefined
        ? categoryBounds(categories.length, bars)
        : xMin !== undefined && xMax !== undefined
          ? [xMin, xMax]
          : bars
            ? timeBarBounds(timestamps)
            : undefined,
    ...(categories !== undefined ? { time: false } : {}),
    ...(horizontal ? { ori: 1, dir: -1 } : {}),
  };
  const scales: Record<string, uPlot.Scale> = { x: xScale };
  if (references.length || bars || paddedBounds || horizontal) {
    scales.y = {
      ...(horizontal ? { ori: 0, dir: 1 } : {}),
      range: (_, min, max) => {
        if (!bars && !paddedBounds)
          return uPlot.rangeNum(
            Math.min(min, ...references.map(({ value }) => value)),
            Math.max(max, ...references.map(({ value }) => value)),
            0.1,
            true,
          );
        min = Math.min(min ?? Infinity, ...references.map(({ value }) => value));
        max = Math.max(max ?? -Infinity, ...references.map(({ value }) => value));
        if (paddedBounds) return paddedValueBounds(min, max, bars);
        if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
        return uPlot.rangeNum(
          bars ? Math.min(0, min) : min,
          bars ? Math.max(0, max) : max,
          0.1,
          true,
        );
      },
    };
  }

  return {
    data,
    options: {
      scales,
      series: [
        {},
        ...entries.map((entry, index): uPlot.Series => {
          const bar = layout[index];
          const paths = bars
            ? uPlot.paths.bars!({
                size: [1, Infinity, 0],
                radius: 0,
                disp: {
                  x0: {
                    unit: 1,
                    values: () =>
                      timestamps.map(
                        (x) => x + ((bar?.offset ?? 0) - (bar?.width ?? 0) / 2) * slotSize,
                      ),
                  },
                  size: { unit: 1, values: () => [(bar?.width ?? 0) * slotSize] },
                },
              })
            : smooth
              ? uPlot.paths.spline!()
              : undefined;
          return {
            label: entry.series.label,
            stroke: colors[index],
            width: seriesWidth(entry, highlighted, kind, fill),
            show: shown[index],
            spanGaps: false,
            points: { show: false },
            ...(paths ? { paths } : {}),
            ...(bars
              ? { fill: colors[index] }
              : fill
                ? { fill: hexToRgba(colors[index], 0.1), fillTo: 0 }
                : {}),
          };
        }),
      ],
      axes: [xAxis, yAxis],
      cursor: {
        drag: {
          x: zoomable && categories === undefined,
          y: false,
          setScale: false,
          ...(zoomable && categories === undefined ? { dist: 3 } : {}),
        },
        focus: { prox: bars ? -1 : 16 },
        points: bars
          ? { show: false }
          : { size: 8, width: 2, stroke: (_, index) => colors[index - 1], fill: surface },
        ...(bars ? { x: !horizontal, y: horizontal } : {}),
        dataIdx: (_, __, closest) => closest,
        move: (self, left, top) => {
          if (left < 0 || (horizontal && top < 0)) return [left, top];
          const position = horizontal ? top : left;
          const snapped = self.valToPos(timestamps[self.posToIdx(position)], 'x');
          return horizontal ? [left, snapped] : [snapped, top];
        },
      },
    },
  };
}

export function drawThresholds(
  self: uPlot,
  references: readonly { value: number }[],
  color: string,
  horizontal: boolean,
) {
  if (!references.length) return;
  const { ctx, bbox } = self;
  ctx.save();
  ctx.beginPath();
  ctx.rect(bbox.left, bbox.top, bbox.width, bbox.height);
  ctx.clip();
  ctx.strokeStyle = color;
  ctx.lineWidth = uPlot.pxRatio;
  ctx.setLineDash([6 * uPlot.pxRatio, 4 * uPlot.pxRatio]);
  for (const { value } of references) {
    const position = self.valToPos(value, 'y', true);
    ctx.beginPath();
    ctx.moveTo(horizontal ? position : bbox.left, horizontal ? bbox.top : position);
    ctx.lineTo(
      horizontal ? position : bbox.left + bbox.width,
      horizontal ? bbox.top + bbox.height : position,
    );
    ctx.stroke();
  }
  ctx.restore();
}
