import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { cartesianPlot, drawThresholds, seriesWidth, type PositionedSeries } from './cartesianPlot';
import { formatChartValue } from './format';
import { shortenLegendLabel } from './legend';
import { PALETTE_SIZE, assignSeriesSlots, rankSeries, selectTopSeries } from './seriesSelection';
import { zoomRange, type ZoomRange } from './zoomRange';
import './charts.css';

export type ChartSeries = { id: string; label: string; values: (number | null)[] };
export type ChartThreshold = { value: number; label?: string };
const noThresholds: ChartThreshold[] = [];

export interface TimeSeriesChartProps {
  timestamps: number[];
  series: ChartSeries[];
  height?: number;
  /** Reserve more axis space for formatted units in compact tiles. */
  yAxisSize?: number;
  /** A page with a shared live region can keep per-chart counts quiet. */
  announceSeries?: boolean;
  title?: string;
  /** Hide the visible caption when a surrounding card already supplies a heading. */
  showTitle?: boolean;
  /** Place a title immediately below the time axis, before counts and legend. */
  xAxisTitle?: string;
  /** Numeric axis label for horizontal category bars. */
  valueAxisTitle?: string;
  /** Group field names shown before the series visibility controls. */
  legendTitle?: string;
  /** Opt time charts into selecting an absolute dashboard range. */
  onZoomRange?: (range: ZoomRange) => void;
  /** Compact cards can omit counts while retaining the Show all control. */
  showSeriesCount?: boolean;
  /** Fixed x-axis bounds in Unix seconds, independent of the sample timestamps. */
  xRange?: readonly [number, number];
  /** Series drawn before "Show all"; the ones with the highest peak value win. */
  maxSeries?: number;
  timeZone?: 'UTC' | 'local';
  formatValue?: (value: number) => string;
  emptyMessage?: string;
  /** Horizontal reference lines, included in the automatic y range. */
  thresholds?: readonly ChartThreshold[];
  /** Numeric x indices with category labels instead of timestamps. */
  categories?: readonly string[];
  kind?: 'line' | 'bar';
  fill?: boolean;
  smooth?: boolean;
  /** Bars share one stack; inspected values remain unstacked. */
  stacked?: boolean;
  /** Category bars with their category axis on the left. */
  horizontal?: boolean;
  /** Hex colours by incoming series index, cycling through the supplied palette. */
  colors?: readonly string[];
  showXAxis?: boolean;
  /** Five percent value-axis padding, starting nonnegative data at zero. */
  paddedBounds?: boolean;
}

type Cursor = { index: number; left: number; top: number };

function seriesColor(slot: number, color?: string): string {
  return (
    color ??
    (slot < PALETTE_SIZE ? `var(--chart-series-${slot + 1})` : 'var(--color-border-strong)')
  );
}

function formatTime(timestamp: number, timeZone: 'UTC' | 'local'): string {
  return new Intl.DateTimeFormat('en-GB', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZone: timeZone === 'UTC' ? 'UTC' : undefined,
    timeZoneName: 'short',
    hourCycle: 'h23',
  }).format(new Date(timestamp * 1000));
}

function ChartTooltip({
  cursor,
  entries,
  timestamps,
  categories,
  timeZone,
  formatValue,
  id,
}: {
  cursor: Cursor;
  entries: PositionedSeries[];
  timestamps: number[];
  categories?: readonly string[];
  timeZone: 'UTC' | 'local';
  formatValue: (value: number) => string;
  id: string;
}) {
  const element = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 8, top: 8 });
  const rows = entries
    .map(({ series, slot, color }) => ({ series, slot, color, value: series.values[cursor.index] }))
    .sort((left, right) => {
      const a = Number.isFinite(left.value) ? left.value! : -Infinity;
      const b = Number.isFinite(right.value) ? right.value! : -Infinity;
      return b - a;
    });

  useLayoutEffect(() => {
    const tooltip = element.current;
    const box = tooltip?.parentElement;
    if (!tooltip || !box) return;
    const left =
      cursor.left + 12 + tooltip.offsetWidth <= box.clientWidth - 8
        ? cursor.left + 12
        : cursor.left - tooltip.offsetWidth - 12;
    const top =
      cursor.top + 12 + tooltip.offsetHeight <= box.clientHeight - 8
        ? cursor.top + 12
        : cursor.top - tooltip.offsetHeight - 12;
    setPosition({
      left: Math.max(8, Math.min(left, box.clientWidth - tooltip.offsetWidth - 8)),
      top: Math.max(8, Math.min(top, box.clientHeight - tooltip.offsetHeight - 8)),
    });
  }, [cursor, entries]);

  return (
    <div ref={element} id={id} role="tooltip" className="charts-tooltip" style={position}>
      {categories !== undefined ? (
        <span className="charts-tooltip-category">{categories[cursor.index]}</span>
      ) : (
        <time dateTime={new Date(timestamps[cursor.index] * 1000).toISOString()}>
          {formatTime(timestamps[cursor.index], timeZone)}
        </time>
      )}
      {rows.slice(0, 10).map(({ series, slot, color, value }) => (
        <div key={series.id} className="charts-tooltip-row">
          <strong>{value != null && Number.isFinite(value) ? formatValue(value) : '-'}</strong>
          <span
            aria-hidden="true"
            className="charts-line-key"
            style={{ borderColor: seriesColor(slot, color) }}
          />
          <span className="charts-tooltip-label">{series.label}</span>
        </div>
      ))}
      {rows.length > 10 && <p className="charts-tooltip-more">and {rows.length - 10} more</p>}
    </div>
  );
}

export function TimeSeriesChart({
  timestamps,
  series,
  height = 280,
  yAxisSize = 64,
  announceSeries = true,
  title = 'Time series',
  showTitle = true,
  xAxisTitle,
  valueAxisTitle,
  legendTitle,
  onZoomRange,
  showSeriesCount = true,
  xRange,
  maxSeries = 20,
  timeZone = 'UTC',
  formatValue = formatChartValue,
  emptyMessage = 'No data',
  thresholds = noThresholds,
  categories,
  kind = 'line',
  fill = false,
  smooth = false,
  stacked = false,
  horizontal = false,
  colors,
  showXAxis = true,
  paddedBounds = false,
}: TimeSeriesChartProps) {
  const container = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  const cursorIndex = useRef<number | null>(null);
  const highlighted = useRef<string | null>(null);
  const keyboardSelection = useRef<{ anchor: number; index: number } | null>(null);
  const onZoomRangeRef = useRef(onZoomRange);
  const hiddenRef = useRef(new Set<string>());
  const [hidden, setHidden] = useState(new Set<string>());
  const [showAll, setShowAll] = useState(false);
  const [cursor, setCursor] = useState<Cursor | null>(null);
  const [themeRevision, setThemeRevision] = useState(0);
  const [zoomStatus, setZoomStatus] = useState('');
  const instructionsId = useId();
  const tooltipId = useId();
  const xMin = xRange?.[0];
  const xMax = xRange?.[1];
  const limit = Math.max(1, Math.floor(maxSeries));
  // Callers can use inline arrays without replacing the plot on unrelated renders.
  const thresholdsKey = JSON.stringify(thresholds.map(({ value, label }) => [value, label]));
  const references = useMemo(
    () => thresholds.filter(({ value }) => Number.isFinite(value)),
    [thresholdsKey],
  );
  const categoriesKey = JSON.stringify(categories);
  const categoryLabels = useMemo(() => categories, [categoriesKey]);
  const colorsKey = JSON.stringify(colors ?? []);
  const isHorizontal = kind === 'bar' && categoryLabels !== undefined && horizontal;
  const horizontalTitle = isHorizontal ? xAxisTitle : undefined;
  const horizontalValueTitle = isHorizontal ? valueAxisTitle : undefined;
  const zoomEnabled = onZoomRange !== undefined && categoryLabels === undefined;
  onZoomRangeRef.current = onZoomRange;
  // Bar visibility changes require fresh stack totals and group positions.
  const barVisibility = kind === 'bar' ? hidden : undefined;
  const slotHistory = useRef(new Map<string, number>());
  const entries = useMemo<PositionedSeries[]>(() => {
    const drawn = showAll ? series : selectTopSeries(series, limit);
    const { slots, history } = assignSeriesSlots(
      slotHistory.current,
      rankSeries(drawn).map((entry) => entry.id),
    );
    slotHistory.current = history;
    const incomingColors = new Map(
      series.map((entry, index) => [
        entry.id,
        colors?.length ? colors[index % colors.length] : undefined,
      ]),
    );
    return drawn.map((entry) => ({
      series: entry,
      slot: slots.get(entry.id)!,
      color: incomingColors.get(entry.id),
    }));
  }, [series, showAll, limit, colorsKey]);
  const plotEntries = useMemo(
    () => (kind === 'bar' && stacked ? [...entries].reverse() : entries),
    [entries, kind, stacked],
  );
  const visibleEntries = useMemo(
    () => entries.filter((entry) => !hidden.has(entry.series.id)),
    [entries, hidden],
  );
  hiddenRef.current = hidden;
  const hasData = useMemo(
    () =>
      timestamps.length > 0 &&
      series.some((entry) =>
        entry.values.some(
          (value, index) => index < timestamps.length && value != null && Number.isFinite(value),
        ),
      ),
    [timestamps, series],
  );
  const summary = hasData
    ? categoryLabels !== undefined
      ? `${title}: ${series.length} series across ${categoryLabels.length} categories`
      : `${title}: ${series.length} series from ${formatTime(timestamps[0], timeZone)} to ${formatTime(timestamps[timestamps.length - 1], timeZone)}`
    : `${title}: ${emptyMessage}`;
  // A shorter result can arrive while a cursor still points into the previous data.
  const activeCursor = cursor && cursor.index < timestamps.length ? cursor : null;

  function clearSelection(chart = plot.current) {
    const selected = keyboardSelection.current !== null || (chart?.select.width ?? 0) > 0;
    keyboardSelection.current = null;
    chart?.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
    if (selected) setZoomStatus('Selection cleared.');
  }

  function applyZoom(chart: uPlot, from: number, to: number) {
    const range = zoomRange(timestamps, from, to);
    if (range) onZoomRangeRef.current?.(range);
    clearSelection(chart);
    setZoomStatus(
      range
        ? `Zoomed to ${formatTime(Date.parse(range.startTime) / 1000, timeZone)} to ${formatTime(Date.parse(range.endTime) / 1000, timeZone)}.`
        : 'Selection cleared. Select at least two points to zoom.',
    );
  }

  useEffect(() => {
    const observer = new MutationObserver(() => setThemeRevision((revision) => revision + 1));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const host = container.current;
    cursorIndex.current = null;
    keyboardSelection.current = null;
    setCursor(null);
    if (!host || !hasData) return;
    const styles = getComputedStyle(host);
    const neutral = styles.getPropertyValue('--color-border-strong').trim();
    const plotColors = plotEntries.map(
      ({ slot, color }) =>
        color ??
        (slot < PALETTE_SIZE
          ? styles.getPropertyValue(`--chart-series-${slot + 1}`).trim()
          : neutral),
    );
    const grid = styles.getPropertyValue('--color-border').trim();
    const muted = styles.getPropertyValue('--color-muted').trim();
    const surface = styles.getPropertyValue('--color-surface').trim();
    const thresholdColor = styles.getPropertyValue('--color-warning').trim();
    const font = `11px ${styles.getPropertyValue('--font-sans').trim()}`;
    const { data, options } = cartesianPlot({
      timestamps,
      entries: plotEntries,
      colors: plotColors,
      hidden: hiddenRef.current,
      highlighted: highlighted.current,
      categories: categoryLabels,
      kind,
      fill,
      smooth,
      stacked,
      horizontal: isHorizontal,
      showXAxis,
      paddedBounds,
      xMin,
      xMax,
      xAxisTitle: horizontalTitle,
      valueAxisTitle: horizontalValueTitle,
      zoomable: zoomEnabled,
      references,
      yAxisSize,
      formatValue,
      font,
      grid,
      muted,
      surface,
    });
    let chart: uPlot | null = null;

    function resize(width: number) {
      width = Math.round(width);
      if (width <= 0) return;
      if (chart) {
        chart.setSize({ width, height });
        return;
      }
      chart = new uPlot(
        {
          width,
          height,
          legend: { show: false },
          select: { show: zoomEnabled, left: 0, top: 0, width: 0, height: 0 },
          tzDate: (timestamp) =>
            timeZone === 'UTC'
              ? uPlot.tzDate(new Date(timestamp * 1000), 'UTC')
              : new Date(timestamp * 1000),
          ...options,
          focus: { alpha: 1 },
          hooks: {
            ...(zoomEnabled
              ? {
                  setSelect: [
                    (self: uPlot) => {
                      if (self.select.width <= 0) return;
                      applyZoom(
                        self,
                        self.posToVal(self.select.left, 'x'),
                        self.posToVal(self.select.left + self.select.width, 'x'),
                      );
                    },
                  ],
                }
              : {}),
            draw: [(self) => drawThresholds(self, references, thresholdColor, isHorizontal)],
            setCursor: [
              (self) => {
                const index = self.cursor.idx;
                if (index == null || self.cursor.left! < 0 || self.cursor.top! < 0) {
                  setCursor(null);
                  return;
                }
                cursorIndex.current = index;
                setCursor({
                  index,
                  left: self.bbox.left / uPlot.pxRatio + self.cursor.left!,
                  top: self.bbox.top / uPlot.pxRatio + self.cursor.top!,
                });
              },
            ],
            setSeries: [
              (self, index, options) => {
                if (options.show !== undefined) return;
                highlighted.current =
                  index == null ? null : (plotEntries[index - 1]?.series.id ?? null);
                self.series.forEach((entry, plotIndex) => {
                  if (plotIndex === 0) return;
                  entry.width = seriesWidth(
                    plotEntries[plotIndex - 1],
                    highlighted.current,
                    kind,
                    fill,
                  );
                });
                self.redraw(true, false);
              },
            ],
          },
        },
        data,
        host!,
      );
      chart.root.querySelector('canvas')?.setAttribute('aria-hidden', 'true');
      plot.current = chart;
    }

    resize(host.getBoundingClientRect().width);
    const observer = new ResizeObserver((changes) => resize(changes[0].contentRect.width));
    observer.observe(host);
    return () => {
      observer.disconnect();
      plot.current = null;
      chart?.destroy();
    };
  }, [
    timestamps,
    plotEntries,
    height,
    yAxisSize,
    timeZone,
    formatValue,
    hasData,
    themeRevision,
    references,
    xMin,
    xMax,
    categoryLabels,
    kind,
    fill,
    smooth,
    stacked,
    isHorizontal,
    horizontalTitle,
    horizontalValueTitle,
    zoomEnabled,
    showXAxis,
    paddedBounds,
    barVisibility,
  ]);

  useEffect(() => {
    const chart = plot.current;
    if (!chart) return;
    chart.batch(() =>
      plotEntries.forEach(({ series: entry }, index) =>
        chart.setSeries(index + 1, { show: !hidden.has(entry.id) }),
      ),
    );
  }, [hidden, plotEntries]);

  function hideCursor() {
    setCursor(null);
    plot.current?.setCursor({ left: -1, top: -1 });
  }

  function moveCursor(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      hideCursor();
      if (zoomEnabled) clearSelection();
      return;
    }
    const chart = plot.current;
    const selection = keyboardSelection.current;
    if (zoomEnabled && chart && event.key === 'Enter' && selection) {
      event.preventDefault();
      applyZoom(chart, timestamps[selection.anchor], timestamps[selection.index]);
      return;
    }
    const forward = event.key === 'ArrowRight' || (isHorizontal && event.key === 'ArrowDown');
    const backward = event.key === 'ArrowLeft' || (isHorizontal && event.key === 'ArrowUp');
    if (!chart || (!forward && !backward)) return;
    event.preventDefault();
    const current = cursorIndex.current;
    const extending =
      zoomEnabled &&
      event.shiftKey &&
      current !== null &&
      chart.cursor.idx != null &&
      chart.cursor.left! >= 0 &&
      chart.cursor.top! >= 0;
    if (zoomEnabled && !extending && selection) clearSelection(chart);
    const index =
      current == null
        ? 0
        : Math.max(0, Math.min(timestamps.length - 1, current + (forward ? 1 : -1)));
    const value = visibleEntries.find((entry) => Number.isFinite(entry.series.values[index]))
      ?.series.values[index];
    const categoryPosition = chart.valToPos(timestamps[index], 'x');
    const valuePosition =
      value != null
        ? chart.valToPos(value, 'y')
        : (isHorizontal ? chart.bbox.width : chart.bbox.height) / uPlot.pxRatio / 2;
    chart.setCursor(
      isHorizontal
        ? { left: valuePosition, top: categoryPosition }
        : { left: categoryPosition, top: valuePosition },
    );
    if (extending) {
      const anchor = selection?.anchor ?? current;
      keyboardSelection.current = { anchor, index };
      const from = timestamps[anchor],
        to = timestamps[index],
        left = chart.valToPos(from, 'x'),
        right = chart.valToPos(to, 'x');
      chart.setSelect(
        {
          left: Math.min(left, right),
          top: 0,
          width: Math.abs(right - left),
          height: chart.bbox.height / uPlot.pxRatio,
        },
        false,
      );
      const start = Math.min(from, to),
        end = Math.max(from, to),
        count = timestamps.filter((time) => time >= start && time <= end).length;
      setZoomStatus(
        `Selected ${count} ${count === 1 ? 'point' : 'points'} from ${formatTime(start, timeZone)} to ${formatTime(end, timeZone)}. Press Enter to zoom.`,
      );
    }
  }

  function toggleSeries(id: string, isolate = false) {
    setHidden((previous) => {
      if (isolate)
        return new Set(series.filter((entry) => entry.id !== id).map((entry) => entry.id));
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function emphasize(id: string | null) {
    plot.current?.setSeries(
      id == null ? null : plotEntries.findIndex((entry) => entry.series.id === id) + 1,
      { focus: true },
    );
  }

  return (
    <figure className="charts-figure" aria-label={title}>
      {showTitle && (
        <figcaption className="charts-title">
          {title}
          {series.length === 1 && title !== series[0].label ? ` · ${series[0].label}` : ''}
        </figcaption>
      )}
      <p id={instructionsId} className="charts-sr-only">
        {isHorizontal
          ? 'Use Up and Down or Left and Right arrow keys to inspect values. Escape hides the tooltip.'
          : 'Use Left and Right arrow keys to inspect values. Escape hides the tooltip.'}
        {' Click to toggle; Alt-click or double-click to show only this series.'}
        {zoomEnabled &&
          ' Drag to select a time range, or use Shift+ArrowLeft and Shift+ArrowRight to select points, then Enter to zoom. Escape cancels the selection.'}
      </p>
      {zoomEnabled && (
        <p className="charts-sr-only" aria-live="polite" aria-atomic="true">
          {zoomStatus}
        </p>
      )}
      <div className="charts-plot-box" style={{ height }}>
        <div
          ref={container}
          className="charts-plot"
          data-zoom-enabled={zoomEnabled ? 'true' : undefined}
          style={{ height }}
          role="img"
          tabIndex={0}
          aria-label={summary}
          aria-describedby={`${instructionsId}${activeCursor ? ` ${tooltipId}` : ''}`}
          onKeyDown={moveCursor}
          onBlur={hideCursor}
          onMouseLeave={hideCursor}
          onMouseDown={zoomEnabled ? () => clearSelection() : undefined}
        >
          {!hasData && <div className="charts-empty">{emptyMessage}</div>}
        </div>
        {activeCursor && hasData && (
          <ChartTooltip
            cursor={activeCursor}
            entries={visibleEntries}
            timestamps={timestamps}
            categories={categoryLabels}
            timeZone={timeZone}
            formatValue={formatValue}
            id={tooltipId}
          />
        )}
      </div>
      {xAxisTitle && !isHorizontal && <p className="charts-axis-title">{xAxisTitle}</p>}
      {references.length > 0 && (
        <div className="charts-thresholds">
          {references.map(({ value, label }, index) => (
            <span key={index}>
              <span className="charts-threshold-key" aria-hidden="true" />
              {label ?? 'Threshold'}: {formatValue(value)}
            </span>
          ))}
        </div>
      )}
      {(showSeriesCount || series.length > limit) && (
        <div className="charts-count-row">
          {showSeriesCount && (
            <span aria-live={announceSeries ? 'polite' : 'off'}>
              {visibleEntries.length === series.length
                ? `${series.length} series`
                : `${visibleEntries.length} of ${series.length} series`}
            </span>
          )}
          {series.length > limit && (
            <button
              type="button"
              className="charts-toggle"
              title={`Series are ranked by their highest value; the top ${limit} are drawn`}
              onClick={() => setShowAll((previous) => !previous)}
            >
              {showAll ? `Show top ${limit}` : `Show all ${series.length}`}
            </button>
          )}
        </div>
      )}
      {series.length > 0 && (series.length > 1 || !showTitle) && (
        <ul
          className="charts-legend"
          aria-label={legendTitle ? `${legendTitle} series visibility` : 'Series visibility'}
        >
          {legendTitle && (
            <li className="charts-legend-title" aria-hidden="true">
              {legendTitle}
            </li>
          )}
          {entries.map(({ series: entry, slot, color }) => (
            <li key={entry.id}>
              <button
                type="button"
                className="charts-legend-item"
                aria-pressed={!hidden.has(entry.id)}
                aria-label={entry.label}
                title={entry.label}
                aria-describedby={instructionsId}
                onClick={(event) => toggleSeries(entry.id, event.altKey)}
                onDoubleClick={() => toggleSeries(entry.id, true)}
                onMouseEnter={() => emphasize(entry.id)}
                onMouseLeave={() => emphasize(null)}
                onFocus={() => emphasize(entry.id)}
                onBlur={() => emphasize(null)}
              >
                <span
                  aria-hidden="true"
                  className={kind === 'bar' || fill ? 'charts-legend-swatch' : 'charts-line-key'}
                  data-legend-swatch={kind === 'bar' || fill ? 'square' : 'line'}
                  style={
                    kind === 'bar' || fill
                      ? { background: seriesColor(slot, color) }
                      : { borderColor: seriesColor(slot, color) }
                  }
                />
                <span>{shortenLegendLabel(entry.label)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </figure>
  );
}
