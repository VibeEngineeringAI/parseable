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
import { formatChartValue } from './format';
import { PALETTE_SIZE, assignSeriesSlots, rankSeries, selectTopSeries } from './seriesSelection';
import './charts.css';

export type ChartSeries = { id: string; label: string; values: (number | null)[] };

export interface TimeSeriesChartProps {
  timestamps: number[];
  series: ChartSeries[];
  height?: number;
  title?: string;
  /** Series drawn before "Show all"; the ones with the highest peak value win. */
  maxSeries?: number;
  timeZone?: 'UTC' | 'local';
  formatValue?: (value: number) => string;
  emptyMessage?: string;
}

type Cursor = { index: number; left: number; top: number };
// `slot` is the colour slot, which follows the series id; the plot index is its position in `entries`.
type PositionedSeries = { series: ChartSeries; slot: number };

// 24-hour ticks matching the tooltip; columns follow uPlot's time-axis format table:
// [min increment, default, year, month, day, hour, minute, second, mode].
const timeAxisFormats: uPlot.Axis.Values = [
  [3600 * 24 * 365, '{YYYY}', null, null, null, null, null, null, 1],
  [3600 * 24 * 28, '{MMM}', '\n{YYYY}', null, null, null, null, null, 1],
  [3600 * 24, '{MMM} {D}', '\n{YYYY}', null, null, null, null, null, 1],
  [3600, '{HH}:{mm}', '\n{MMM} {D}', null, '\n{MMM} {D}', null, null, null, 1],
  [60, '{HH}:{mm}', '\n{MMM} {D}', null, '\n{MMM} {D}', null, null, null, 1],
  [1, '{HH}:{mm}:{ss}', '\n{MMM} {D}', null, '\n{MMM} {D}', null, null, null, 1],
];

function seriesColor(slot: number): string {
  return slot < PALETTE_SIZE ? `var(--chart-series-${slot + 1})` : 'var(--color-border-strong)';
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
  timeZone,
  formatValue,
  id,
}: {
  cursor: Cursor;
  entries: PositionedSeries[];
  timestamps: number[];
  timeZone: 'UTC' | 'local';
  formatValue: (value: number) => string;
  id: string;
}) {
  const element = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 8, top: 8 });
  const rows = entries
    .map(({ series, slot }) => ({ series, slot, value: series.values[cursor.index] }))
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
      <time dateTime={new Date(timestamps[cursor.index] * 1000).toISOString()}>
        {formatTime(timestamps[cursor.index], timeZone)}
      </time>
      {rows.slice(0, 10).map(({ series, slot, value }) => (
        <div key={series.id} className="charts-tooltip-row">
          <strong>{value != null && Number.isFinite(value) ? formatValue(value) : '-'}</strong>
          <span
            aria-hidden="true"
            className="charts-line-key"
            style={{ borderColor: seriesColor(slot) }}
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
  title = 'Time series',
  maxSeries = 20,
  timeZone = 'UTC',
  formatValue = formatChartValue,
  emptyMessage = 'No data',
}: TimeSeriesChartProps) {
  const container = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  const cursorIndex = useRef<number | null>(null);
  const highlighted = useRef<string | null>(null);
  const hiddenRef = useRef(new Set<string>());
  const [hidden, setHidden] = useState(new Set<string>());
  const [showAll, setShowAll] = useState(false);
  const [cursor, setCursor] = useState<Cursor | null>(null);
  const [themeRevision, setThemeRevision] = useState(0);
  const instructionsId = useId();
  const tooltipId = useId();
  const limit = Math.max(1, Math.floor(maxSeries));
  const slotHistory = useRef(new Map<string, number>());
  const entries = useMemo<PositionedSeries[]>(() => {
    const drawn = showAll ? series : selectTopSeries(series, limit);
    const { slots, history } = assignSeriesSlots(
      slotHistory.current,
      rankSeries(drawn).map((entry) => entry.id),
    );
    slotHistory.current = history;
    return drawn.map((entry) => ({ series: entry, slot: slots.get(entry.id)! }));
  }, [series, showAll, limit]);
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
    ? `${title}: ${series.length} series from ${formatTime(timestamps[0], timeZone)} to ${formatTime(timestamps[timestamps.length - 1], timeZone)}`
    : `${title}: ${emptyMessage}`;
  // A shorter result can arrive while a cursor still points into the previous data.
  const activeCursor = cursor && cursor.index < timestamps.length ? cursor : null;

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
    setCursor(null);
    if (!host || !hasData) return;
    const styles = getComputedStyle(host);
    const neutral = styles.getPropertyValue('--color-border-strong').trim();
    const colors = entries.map(({ slot }) =>
      slot < PALETTE_SIZE ? styles.getPropertyValue(`--chart-series-${slot + 1}`).trim() : neutral,
    );
    const grid = styles.getPropertyValue('--color-border').trim();
    const muted = styles.getPropertyValue('--color-muted').trim();
    const surface = styles.getPropertyValue('--color-surface').trim();
    const font = `11px ${styles.getPropertyValue('--font-sans').trim()}`;
    const data: uPlot.AlignedData = [
      timestamps,
      ...entries.map(({ series: entry }) =>
        timestamps.map((_, index) => {
          const value = entry.values[index];
          return value != null && Number.isFinite(value) ? value : null;
        }),
      ),
    ];
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
          select: { show: false, left: 0, top: 0, width: 0, height: 0 },
          tzDate: (timestamp) =>
            timeZone === 'UTC'
              ? uPlot.tzDate(new Date(timestamp * 1000), 'UTC')
              : new Date(timestamp * 1000),
          series: [
            {},
            ...entries.map(({ series: entry, slot }, index) => ({
              label: entry.label,
              stroke: colors[index],
              width: highlighted.current === entry.id ? 2 : slot < PALETTE_SIZE ? 1.5 : 1,
              show: !hiddenRef.current.has(entry.id),
              spanGaps: false,
              points: { show: false },
            })),
          ],
          axes: [
            {
              stroke: muted,
              font,
              grid: { stroke: grid, width: 1 },
              ticks: { stroke: grid, width: 1 },
              values: timeAxisFormats,
            },
            {
              stroke: muted,
              font,
              size: 64,
              grid: { stroke: grid, width: 1 },
              ticks: { stroke: grid, width: 1 },
              values: (_, values) => values.map(formatValue),
            },
          ],
          focus: { alpha: 1 },
          cursor: {
            drag: { x: false, y: false, setScale: false },
            focus: { prox: 16 },
            points: { size: 8, width: 2, stroke: (_, index) => colors[index - 1], fill: surface },
            dataIdx: (_, __, closest) => closest,
            move: (self, left, top) =>
              left < 0 ? [left, top] : [self.valToPos(timestamps[self.posToIdx(left)], 'x'), top],
          },
          hooks: {
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
                  index == null ? null : (entries[index - 1]?.series.id ?? null);
                self.series.forEach((entry, plotIndex) => {
                  if (plotIndex === 0) return;
                  const positioned = entries[plotIndex - 1];
                  entry.width =
                    positioned.series.id === highlighted.current
                      ? 2
                      : positioned.slot < PALETTE_SIZE
                        ? 1.5
                        : 1;
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
  }, [timestamps, entries, height, timeZone, formatValue, hasData, themeRevision]);

  useEffect(() => {
    const chart = plot.current;
    if (!chart) return;
    chart.batch(() =>
      entries.forEach(({ series: entry }, index) =>
        chart.setSeries(index + 1, { show: !hidden.has(entry.id) }),
      ),
    );
  }, [hidden, entries]);

  function hideCursor() {
    setCursor(null);
    plot.current?.setCursor({ left: -1, top: -1 });
  }

  function moveCursor(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      hideCursor();
      return;
    }
    const chart = plot.current;
    if (!chart || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
    event.preventDefault();
    const current = cursorIndex.current;
    const index =
      current == null
        ? 0
        : Math.max(
            0,
            Math.min(timestamps.length - 1, current + (event.key === 'ArrowRight' ? 1 : -1)),
          );
    const value = visibleEntries.find((entry) => Number.isFinite(entry.series.values[index]))
      ?.series.values[index];
    chart.setCursor({
      left: chart.valToPos(timestamps[index], 'x'),
      top: value != null ? chart.valToPos(value, 'y') : chart.bbox.height / uPlot.pxRatio / 2,
    });
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

  function emphasize(index: number | null) {
    plot.current?.setSeries(index == null ? null : index + 1, { focus: true });
  }

  return (
    <figure className="charts-figure" aria-label={title}>
      <figcaption className="charts-title">
        {title}
        {series.length === 1 && title !== series[0].label ? ` · ${series[0].label}` : ''}
      </figcaption>
      <p id={instructionsId} className="charts-sr-only">
        Use Left and Right arrow keys to inspect values. Escape hides the tooltip.
      </p>
      <div className="charts-plot-box" style={{ height }}>
        <div
          ref={container}
          className="charts-plot"
          style={{ height }}
          role="img"
          tabIndex={0}
          aria-label={summary}
          aria-describedby={`${instructionsId}${activeCursor ? ` ${tooltipId}` : ''}`}
          onKeyDown={moveCursor}
          onBlur={hideCursor}
          onMouseLeave={hideCursor}
        >
          {!hasData && <div className="charts-empty">{emptyMessage}</div>}
        </div>
        {activeCursor && hasData && (
          <ChartTooltip
            cursor={activeCursor}
            entries={visibleEntries}
            timestamps={timestamps}
            timeZone={timeZone}
            formatValue={formatValue}
            id={tooltipId}
          />
        )}
      </div>
      <div className="charts-count-row">
        <span aria-live="polite">
          {visibleEntries.length === series.length
            ? `${series.length} series`
            : `${visibleEntries.length} of ${series.length} series`}
        </span>
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
      {series.length > 1 && (
        <ul className="charts-legend" aria-label="Series visibility">
          {entries.map(({ series: entry, slot }, index) => (
            <li key={entry.id}>
              <button
                type="button"
                className="charts-legend-item"
                aria-pressed={!hidden.has(entry.id)}
                title="Click to toggle; Alt-click or double-click to show only this series"
                onClick={(event) => toggleSeries(entry.id, event.altKey)}
                onDoubleClick={() => toggleSeries(entry.id, true)}
                onMouseEnter={() => emphasize(index)}
                onMouseLeave={() => emphasize(null)}
                onFocus={() => emphasize(index)}
                onBlur={() => emphasize(null)}
              >
                <span
                  aria-hidden="true"
                  className="charts-line-key"
                  style={{ borderColor: seriesColor(slot) }}
                />
                <span>{entry.label}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </figure>
  );
}
