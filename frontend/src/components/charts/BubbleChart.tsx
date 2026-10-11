import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import type { BubbleGroup, BubblePoint } from '../../features/dashboards/bubble';
import { formatChartValue } from './format';
import './charts.css';

export interface BubbleChartProps {
  points: BubblePoint[];
  groups: BubbleGroup[];
  xIsTime?: boolean;
  xTitle?: string;
  yTitle?: string;
  legendPosition?: 'top' | 'bottom' | 'left' | 'right';
  formatValue?: (value: number) => string;
  xLabel?: string;
  yLabel?: string;
  sizeLabel?: string;
  groupLabel?: string;
  title?: string;
  height?: number;
  emptyMessage?: string;
  truncated?: boolean;
  totalRows?: number;
}

type Tick = { value: number; ratio: number };
type Axis = { ticks: Tick[]; ratio: (value: number) => number; step: number };
type TooltipRow = { label: string; value: string; timestamp?: number };
const pointLimit = 2000;
// The largest radius is 18, with three pixels to the ring and one for its stroke.
const pointPadding = 22;
const timeSteps = [
  1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800,
  604800, 1209600, 2592000, 7776000, 31536000,
];
const timeFormat = new Intl.DateTimeFormat('en-GB', {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  timeZone: 'UTC',
  timeZoneName: 'short',
  hourCycle: 'h23',
});

function numericLabel(value: number): string {
  return value.toLocaleString(undefined, { maximumSignificantDigits: 12 });
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  return Number.isFinite(date.getTime()) ? timeFormat.format(date) : '-';
}

function timeTick(timestamp: number, step: number, span: number) {
  const date = new Date(timestamp * 1000);
  if (!Number.isFinite(date.getTime())) return { clock: '-', date: '' };
  return {
    clock: new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      ...(step < 60 ? { second: '2-digit' as const } : {}),
      timeZone: 'UTC',
      hourCycle: 'h23',
    }).format(date),
    date:
      span > 86400
        ? new Intl.DateTimeFormat('en-US', {
            month: 'short',
            day: 'numeric',
            ...(span >= 31536000 ? { year: 'numeric' as const } : {}),
            timeZone: 'UTC',
          }).format(date)
        : '',
  };
}

function niceStep(value: number): number {
  const power = 10 ** Math.floor(Math.log10(value));
  const fraction = value / power;
  const multiple =
    fraction < Math.sqrt(2)
      ? 1
      : fraction < Math.sqrt(5)
        ? 2
        : fraction < Math.sqrt(12.5)
          ? 2.5
          : fraction < Math.sqrt(50)
            ? 5
            : 10;
  return multiple * power;
}

function linearAxis(min: number, max: number, pixels: number, tickCount: number): Axis {
  // Normalizing also keeps the range finite for very large or very small values.
  const magnitude = Math.max(Math.abs(min), Math.abs(max)) || 1;
  let low = min / magnitude;
  let high = max / magnitude;
  if (low === high) {
    const spread = Math.abs(low) * 0.05 || 1;
    low -= spread;
    high += spread;
  }
  const padding = ((high - low) * pointPadding) / Math.max(1, pixels - pointPadding * 2);
  const step = niceStep((high - low + padding * 2) / Math.max(1, tickCount - 1));
  low = Math.floor((low - padding) / step) * step;
  high = Math.ceil((high + padding) / step) * step;
  const count = Math.min(30, Math.round((high - low) / step));
  const ticks = Array.from({ length: count + 1 }, (_, index) => {
    const unit = low + index * step;
    return {
      value: Number((unit * magnitude).toPrecision(12)),
      ratio: (unit - low) / (high - low),
    };
  }).filter((tick) => Number.isFinite(tick.value));
  return {
    ticks,
    step: step * magnitude,
    ratio: (value) => (value / magnitude - low) / (high - low),
  };
}

function timeAxis(min: number, max: number, pixels: number, tickCount: number): Axis {
  if (min === max) {
    min -= 60;
    max += 60;
  }
  const padding = ((max - min) * pointPadding) / Math.max(1, pixels - pointPadding * 2);
  const target = (max - min + padding * 2) / Math.max(1, tickCount - 1);
  const step = timeSteps.find((value) => value >= target) ?? niceStep(target);
  const low = Math.floor((min - padding) / step) * step;
  const high = Math.ceil((max + padding) / step) * step;
  const count = Math.min(30, Math.round((high - low) / step));
  return {
    ticks: Array.from({ length: count + 1 }, (_, index) => {
      const value = low + index * step;
      return { value, ratio: (value - low) / (high - low) };
    }),
    step,
    ratio: (value) => (value - low) / (high - low),
  };
}

function BubbleTooltip({
  left,
  top,
  rows,
  id,
}: {
  left: number;
  top: number;
  rows: TooltipRow[];
  id: string;
}) {
  const element = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 8, top: 8 });
  useLayoutEffect(() => {
    const tooltip = element.current;
    const box = tooltip?.parentElement;
    if (!tooltip || !box) return;
    function measure() {
      if (!tooltip || !box) return;
      const x =
        left + 12 + tooltip.offsetWidth <= box.clientWidth - 8
          ? left + 12
          : left - tooltip.offsetWidth - 12;
      const y =
        top + 12 + tooltip.offsetHeight <= box.clientHeight - 8
          ? top + 12
          : top - tooltip.offsetHeight - 12;
      const next = {
        left: Math.max(8, Math.min(x, box.clientWidth - tooltip.offsetWidth - 8)),
        top: Math.max(8, Math.min(y, box.clientHeight - tooltip.offsetHeight - 8)),
      };
      setPosition((previous) =>
        previous.left === next.left && previous.top === next.top ? previous : next,
      );
    }
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    observer.observe(tooltip);
    return () => observer.disconnect();
  }, [left, top, rows]);
  return (
    <div
      ref={element}
      id={id}
      role="tooltip"
      className="charts-tooltip charts-bubble-tooltip"
      style={position}
    >
      {rows.map((row, index) => (
        <div key={index} className="charts-tooltip-row">
          <span className="charts-tooltip-label">{row.label}</span>
          <strong>
            {row.timestamp !== undefined &&
            Number.isFinite(new Date(row.timestamp * 1000).getTime()) ? (
              <time dateTime={new Date(row.timestamp * 1000).toISOString()}>{row.value}</time>
            ) : (
              row.value
            )}
          </strong>
        </div>
      ))}
    </div>
  );
}

export function BubbleChart({
  points,
  groups,
  xIsTime = false,
  xTitle,
  yTitle,
  legendPosition = 'bottom',
  formatValue = formatChartValue,
  xLabel = 'x',
  yLabel = 'y',
  sizeLabel,
  groupLabel,
  title = 'Bubble chart',
  height = 280,
  emptyMessage = 'No data',
  truncated = false,
  totalRows,
}: BubbleChartProps) {
  const plotBox = useRef<HTMLDivElement>(null);
  const plot = useRef<HTMLDivElement>(null);
  const pointElements = useRef<(SVGCircleElement | null)[]>([]);
  const keyboardIndex = useRef<number | null>(null);
  const [width, setWidth] = useState(0);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const instructionsId = useId();
  const tooltipId = useId();
  const drawn = useMemo(() => points.slice(0, pointLimit), [points]);
  const groupById = useMemo(() => new Map(groups.map((group) => [group.id, group])), [groups]);
  const legendGroups = useMemo(() => {
    const seen = new Set<string>();
    return drawn.flatMap((point) => {
      const group = groupById.get(point.groupId);
      if (!group || seen.has(group.id)) return [];
      seen.add(group.id);
      return [group];
    });
  }, [drawn, groupById]);
  const order = useMemo(
    () => drawn.map((_, index) => index).sort((a, b) => drawn[a].x - drawn[b].x || a - b),
    [drawn],
  );
  const plotHeight = Math.max(40, Number.isFinite(height) ? height : 280);
  const hasLegend = Boolean(groupLabel && legendGroups.length);
  const sideLegend = hasLegend && (legendPosition === 'left' || legendPosition === 'right');

  useLayoutEffect(() => {
    const box = plotBox.current;
    if (!box) return;
    function measure() {
      if (box) setWidth(Math.max(0, Math.round(box.getBoundingClientRect().width)));
    }
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    pointElements.current.length = drawn.length;
    if (hoveredIndex !== null && hoveredIndex >= drawn.length) setHoveredIndex(null);
    if (focusedIndex !== null && focusedIndex >= drawn.length) {
      const first = order[0];
      if (first !== undefined) focusPoint(first);
      else {
        setFocusedIndex(null);
        keyboardIndex.current = null;
        plot.current?.focus({ preventScroll: true });
      }
    }
  }, [drawn, order, hoveredIndex, focusedIndex]);

  const extent = useMemo(() => {
    let xMin = Infinity;
    let xMax = -Infinity;
    let yMin = 0;
    let yMax = 0;
    for (const point of drawn) {
      xMin = Math.min(xMin, point.x);
      xMax = Math.max(xMax, point.x);
      yMin = Math.min(yMin, point.y);
      yMax = Math.max(yMax, point.y);
    }
    return drawn.length ? { xMin, xMax, yMin, yMax } : { xMin: 0, xMax: 1, yMin: 0, yMax: 1 };
  }, [drawn]);
  const span = extent.xMax - extent.xMin;
  const top = 8;
  const bottom = Math.min(
    plotHeight * 0.45,
    28 + (xIsTime && span > 86400 ? 15 : 0) + (xTitle ? 20 : 0),
  );
  const plotPixelsY = Math.max(1, plotHeight - top - bottom);
  const yAxis = linearAxis(
    extent.yMin,
    extent.yMax,
    plotPixelsY,
    Math.max(2, Math.floor(plotPixelsY / 45)),
  );
  const yTicks = yAxis.ticks.map((tick) => ({ ...tick, label: formatValue(tick.value) }));
  const longestY = Math.max(1, ...yTicks.map((tick) => tick.label.length));
  const left = Math.min(
    width * 0.45,
    Math.max(44, Math.min(112, longestY * 7 + 12) + (yTitle ? 20 : 0)),
  );
  const right = 8;
  const plotPixelsX = Math.max(1, width - left - right);
  const xTickCount = Math.max(2, Math.floor(plotPixelsX / (xIsTime ? 100 : 80)));
  const xAxis = xIsTime
    ? timeAxis(extent.xMin, extent.xMax, plotPixelsX, xTickCount)
    : linearAxis(extent.xMin, extent.xMax, plotPixelsX, xTickCount);
  const x = (value: number) => left + xAxis.ratio(value) * plotPixelsX;
  const y = (value: number) => top + (1 - yAxis.ratio(value)) * plotPixelsY;
  const hover = hoveredIndex !== null && hoveredIndex < drawn.length ? hoveredIndex : null;
  const focus = focusedIndex !== null && focusedIndex < drawn.length ? focusedIndex : null;
  const activeIndex = hover ?? focus;
  const activePoint = activeIndex !== null ? drawn[activeIndex] : undefined;
  useEffect(() => {
    if (activeIndex === null) return;
    function hideTooltip(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') setDismissed(true);
    }
    document.addEventListener('keydown', hideTooltip);
    return () => document.removeEventListener('keydown', hideTooltip);
  }, [activeIndex]);
  const tooltipRows = useMemo<TooltipRow[]>(() => {
    if (!activePoint) return [];
    const rows: TooltipRow[] = [
      {
        label: xLabel,
        value: xIsTime ? formatTime(activePoint.x) : numericLabel(activePoint.x),
        timestamp: xIsTime ? activePoint.x : undefined,
      },
      { label: yLabel, value: formatValue(activePoint.y) },
    ];
    if (sizeLabel)
      rows.push({
        label: sizeLabel,
        value: activePoint.size === undefined ? '-' : formatValue(activePoint.size),
      });
    if (groupLabel)
      rows.push({
        label: groupLabel,
        value: groupById.get(activePoint.groupId)?.label ?? activePoint.groupId,
      });
    return rows;
  }, [activePoint, xLabel, yLabel, xIsTime, sizeLabel, groupLabel, groupById, formatValue]);
  const showTooltip = activePoint !== undefined && !dismissed;
  const rings = [...new Set([hover, focus].filter((index): index is number => index !== null))];
  const rowCount =
    totalRows !== undefined && Number.isFinite(totalRows)
      ? Math.max(points.length, Math.floor(totalRows))
      : points.length;

  function focusPoint(index: number) {
    if (!drawn[index]) return;
    keyboardIndex.current = index;
    setFocusedIndex(index);
    setDismissed(false);
    pointElements.current[index]?.focus({ preventScroll: true });
  }

  function clearInspection() {
    setHoveredIndex(null);
    setFocusedIndex(null);
    keyboardIndex.current = null;
  }

  function movePoint(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      setDismissed(true);
      return;
    }
    if (
      !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key) ||
      !order.length
    )
      return;
    event.preventDefault();
    const current = keyboardIndex.current === null ? -1 : order.indexOf(keyboardIndex.current);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? order.length - 1
          : current < 0
            ? 0
            : Math.max(
                0,
                Math.min(
                  order.length - 1,
                  current + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1),
                ),
              );
    setHoveredIndex(null);
    focusPoint(order[next]);
  }

  function pointLabel(point: BubblePoint) {
    const group = groupLabel ? `${groupById.get(point.groupId)?.label ?? point.groupId}: ` : '';
    const size = sizeLabel
      ? `, ${sizeLabel} ${point.size === undefined ? '-' : formatValue(point.size)}`
      : '';
    return `${group}${xLabel} ${xIsTime ? formatTime(point.x) : numericLabel(point.x)}, ${yLabel} ${formatValue(point.y)}${size}`;
  }

  return (
    <div
      className="charts-figure charts-bubble"
      role="group"
      aria-label={title}
      data-legend-position={legendPosition}
      data-has-legend={hasLegend}
    >
      <p id={instructionsId} className="charts-sr-only">
        Use arrow keys to inspect bubbles in x order. Home and End move to the first and last
        bubble. Escape hides the tooltip. Tab leaves the chart.
      </p>
      <div ref={plotBox} className="charts-plot-box" style={{ height: plotHeight }}>
        <div
          ref={plot}
          className="charts-plot charts-bubble-plot"
          role="group"
          aria-label="Bubble plot"
          aria-describedby={instructionsId}
          tabIndex={0}
          style={{ height: plotHeight }}
          onKeyDown={movePoint}
          onFocus={(event) => {
            if (
              event.target !== event.currentTarget ||
              event.currentTarget.contains(event.relatedTarget)
            )
              return;
            const first = order[0];
            if (first !== undefined) focusPoint(first);
          }}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) clearInspection();
          }}
          onPointerLeave={() => setHoveredIndex(null)}
        >
          {drawn.length === 0 ? (
            <div className="charts-empty">{emptyMessage}</div>
          ) : (
            <svg
              width={width}
              height={plotHeight}
              viewBox={`0 0 ${Math.max(1, width)} ${plotHeight}`}
              role="group"
              aria-label="Bubble points"
            >
              <g aria-hidden="true">
                {yTicks.map((tick, index) => {
                  const position = top + (1 - tick.ratio) * plotPixelsY;
                  const labelSpace = Math.max(1, left - (yTitle ? 28 : 8));
                  return (
                    <g key={index}>
                      <line
                        className="charts-bubble-grid"
                        x1={left}
                        x2={left + plotPixelsX}
                        y1={position}
                        y2={position}
                      />
                      <text
                        className="charts-bubble-tick"
                        x={left - 8}
                        y={position}
                        dy="0.35em"
                        textAnchor="end"
                        textLength={tick.label.length * 7 > labelSpace ? labelSpace : undefined}
                        lengthAdjust="spacingAndGlyphs"
                      >
                        {tick.label}
                      </text>
                    </g>
                  );
                })}
                {xAxis.ticks.map((tick, index) => {
                  const position = left + tick.ratio * plotPixelsX;
                  const label = xIsTime
                    ? timeTick(tick.value, xAxis.step, span)
                    : { clock: numericLabel(tick.value), date: '' };
                  const labelWidth = Math.max(label.clock.length, label.date.length) * 6.5;
                  const anchor =
                    position - labelWidth / 2 < left
                      ? 'start'
                      : position + labelWidth / 2 > width - right
                        ? 'end'
                        : 'middle';
                  return (
                    <g key={index}>
                      <line
                        className="charts-bubble-grid"
                        x1={position}
                        x2={position}
                        y1={top}
                        y2={top + plotPixelsY}
                      />
                      <text
                        className="charts-bubble-tick charts-bubble-x-tick"
                        x={position}
                        y={top + plotPixelsY + 16}
                        textAnchor={anchor}
                      >
                        <tspan x={position}>{label.clock}</tspan>
                        {label.date && (
                          <tspan x={position} dy="1.3em">
                            {label.date}
                          </tspan>
                        )}
                      </text>
                    </g>
                  );
                })}
                {xTitle && (
                  <text
                    className="charts-bubble-axis-title"
                    x={left + plotPixelsX / 2}
                    y={plotHeight - 5}
                    textAnchor="middle"
                    textLength={xTitle.length * 7 > plotPixelsX ? plotPixelsX : undefined}
                    lengthAdjust="spacingAndGlyphs"
                  >
                    {xTitle}
                  </text>
                )}
                {yTitle && (
                  <text
                    className="charts-bubble-axis-title"
                    transform={`translate(13 ${top + plotPixelsY / 2}) rotate(-90)`}
                    textAnchor="middle"
                    textLength={yTitle.length * 7 > plotPixelsY ? plotPixelsY : undefined}
                    lengthAdjust="spacingAndGlyphs"
                  >
                    {yTitle}
                  </text>
                )}
              </g>
              {drawn.map((point, index) => (
                <g
                  key={index}
                  onPointerEnter={() => {
                    setHoveredIndex(index);
                    setDismissed(false);
                  }}
                  onPointerMove={() => {
                    setHoveredIndex(index);
                    setDismissed(false);
                  }}
                  onPointerLeave={() =>
                    setHoveredIndex((previous) => (previous === index ? null : previous))
                  }
                  onPointerDown={(event) => {
                    if (event.button !== 0) return;
                    event.preventDefault();
                    focusPoint(index);
                  }}
                >
                  <circle
                    className="charts-bubble-hit"
                    cx={x(point.x)}
                    cy={y(point.y)}
                    r={Math.max(8, point.radius)}
                    fill="transparent"
                    stroke="none"
                    aria-hidden="true"
                  />
                  <circle
                    ref={(element) => {
                      pointElements.current[index] = element;
                    }}
                    className="charts-bubble-point"
                    cx={x(point.x)}
                    cy={y(point.y)}
                    r={point.radius}
                    fill={groupById.get(point.groupId)?.colour ?? 'var(--chart-series-1)'}
                    fillOpacity={0.2}
                    stroke="none"
                    role="img"
                    aria-label={pointLabel(point)}
                    aria-describedby={showTooltip && activeIndex === index ? tooltipId : undefined}
                    tabIndex={-1}
                    onFocus={() => {
                      keyboardIndex.current = index;
                      setFocusedIndex(index);
                      setDismissed(false);
                    }}
                  />
                </g>
              ))}
              {rings.map((index) => {
                const point = drawn[index];
                return (
                  <circle
                    key={index}
                    className="charts-bubble-ring"
                    cx={x(point.x)}
                    cy={y(point.y)}
                    r={point.radius + 3}
                    fill="none"
                    aria-hidden="true"
                  />
                );
              })}
            </svg>
          )}
        </div>
        {showTooltip && activePoint && (
          <BubbleTooltip
            id={tooltipId}
            left={x(activePoint.x)}
            top={y(activePoint.y)}
            rows={tooltipRows}
          />
        )}
      </div>
      {hasLegend && (
        <ul
          className="charts-legend"
          aria-label="Series"
          style={sideLegend ? { maxHeight: plotHeight } : undefined}
          onFocusCapture={clearInspection}
        >
          {legendGroups.map((group) => (
            <li key={group.id} className="charts-legend-item">
              <span
                className="charts-bubble-swatch"
                style={{ background: group.colour }}
                aria-hidden="true"
              />
              <span>{group.label}</span>
            </li>
          ))}
        </ul>
      )}
      {(truncated || points.length > pointLimit) && (
        <p className="dashboard-chart-note charts-bubble-note">
          Showing the first {drawn.length} of {rowCount} rows
        </p>
      )}
    </div>
  );
}
