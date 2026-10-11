import { useId, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { colourSchemes, paletteColour } from '../../features/dashboards/palettes';
import type { Slice } from '../../features/dashboards/slices';
import { formatChartValue } from './format';
import {
  filterOverlappingLabels,
  labelAnchor,
  polarPoint,
  sectorPath,
  sliceAngles,
} from './pieGeometry';
import './charts.css';
import './pieChart.css';

export interface PieChartProps {
  slices: Slice[];
  variant: 'pie' | 'donut';
  palette: readonly string[];
  showLabels?: boolean;
  legendPosition?: 'top' | 'bottom' | 'left' | 'right';
  formatValue?: (value: number) => string;
  title?: string;
  height?: number;
  emptyMessage?: string;
}

type Cursor = { index: number; label: string; left: number; top: number };
const displayLabel = (label: string) => (label === '' ? '(empty)' : label);
const shortened = (label: string, limit: number) =>
  label.length > limit ? `${label.slice(0, limit)}…` : label;

function PieTooltip({ cursor, text, id }: { cursor: Cursor; text: string; id: string }) {
  const element = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 8, top: 8 });
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
  }, [cursor, text]);
  return (
    <div ref={element} id={id} role="tooltip" className="pie-chart-tooltip" style={position}>
      {text}
    </div>
  );
}

export function PieChart({
  slices,
  variant,
  palette,
  showLabels = false,
  legendPosition = 'bottom',
  formatValue = formatChartValue,
  title,
  height,
  emptyMessage = 'No values returned',
}: PieChartProps) {
  const plot = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [hidden, setHidden] = useState(new Set<string>());
  const [hovered, setHovered] = useState<number | null>(null);
  const [focused, setFocused] = useState<number | null>(null);
  const [cursor, setCursor] = useState<Cursor | null>(null);
  const tooltipId = useId();
  const instructionsId = useId();
  const hasSlices = slices.length > 0;
  const colours = palette.length ? palette : colourSchemes.classic.colours;
  const arcs = useMemo(
    () => sliceAngles(slices.map((slice) => (hidden.has(slice.label) ? 0 : slice.value))),
    [slices, hidden],
  );
  const total = useMemo(() => slices.reduce((sum, slice) => sum + slice.value, 0), [slices]);

  useLayoutEffect(() => {
    const host = plot.current;
    if (!host) return;
    const resize = (width: number, height: number) => {
      width = Math.max(0, Math.round(width));
      height = Math.max(0, Math.round(height));
      setSize((previous) =>
        previous.width === width && previous.height === height ? previous : { width, height },
      );
    };
    const initial = host.getBoundingClientRect();
    resize(initial.width, initial.height);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) resize(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, [hasSlices]);

  const center = { x: size.width / 2, y: size.height / 2 };
  const radius = Math.max(0, Math.min(size.width, size.height) / 2 - (showLabels ? 32 : 8));
  const innerRadius = variant === 'donut' ? radius * 0.5 : 0;
  const allHidden = hasSlices && slices.every((slice) => hidden.has(slice.label));
  const activeCursor =
    cursor &&
    slices[cursor.index]?.label === cursor.label &&
    arcs.some((arc) => arc.index === cursor.index)
      ? cursor
      : null;
  const labels = showLabels
    ? filterOverlappingLabels(
        arcs.flatMap((arc) => {
          const label = slices[arc.index].label;
          const anchor = labelAnchor(center, radius, (arc.startAngle + arc.endAngle) / 2);
          const available =
            anchor.textAnchor === 'start' ? size.width - anchor.x - 8 : anchor.x - 8;
          // Smaller plots shorten labels further so the text stays inside the measured box.
          const limit = Math.min(18, Math.floor(available / 7) - 1);
          if (limit < 3 || anchor.y < 8 || anchor.y > size.height - 8) return [];
          const text = shortened(displayLabel(label), limit);
          return [{ ...anchor, label, index: arc.index, text, width: text.length * 7, height: 14 }];
        }),
      )
    : [];
  const style = height === undefined ? undefined : { height, flex: '0 0 auto' };

  function sliceText(index: number) {
    const { label, value } = slices[index];
    return total > 0
      ? `${displayLabel(label)}  ${((value / total) * 100).toFixed(1)}% (${formatValue(value)})`
      : `${displayLabel(label)}  ${formatValue(value)}`;
  }

  function pointCursor(event: MouseEvent<SVGPathElement>, index: number) {
    const box = plot.current?.getBoundingClientRect();
    if (!box) return;
    setHovered(index);
    setCursor({
      index,
      label: slices[index].label,
      left: event.clientX - box.left,
      top: event.clientY - box.top,
    });
  }

  function toggleSlice(label: string) {
    setCursor(null);
    setHidden((previous) => {
      const next = new Set(previous);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  }

  return (
    <div
      className="pie-chart"
      data-variant={variant}
      data-legend-position={legendPosition}
      style={style}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          setCursor(null);
          setHovered(null);
        }
      }}
    >
      {!hasSlices ? (
        <p className="pie-chart-empty">{emptyMessage}</p>
      ) : (
        <>
          <p id={instructionsId} className="charts-sr-only">
            Tab to inspect slices and toggle their visibility in the legend. Escape hides the
            tooltip.
          </p>
          <div ref={plot} className="pie-chart-plot-box">
            {radius > 1 && arcs.length > 0 && (
              <svg
                width={size.width}
                height={size.height}
                role="group"
                aria-roledescription={`${variant} chart`}
                aria-label={`${title ?? (variant === 'donut' ? 'Donut chart' : 'Pie chart')}: ${arcs.length} slices`}
                aria-describedby={instructionsId}
                data-outer-radius={radius}
                data-inner-radius={innerRadius}
              >
                {arcs.map((arc) => {
                  const slice = slices[arc.index];
                  return (
                    <path
                      key={`${arc.index}:${slice.label}`}
                      className="pie-chart-slice"
                      data-slice=""
                      data-label={slice.label}
                      data-value={slice.value}
                      data-fraction={arc.fraction}
                      data-emphasized={(hovered ?? focused) === arc.index}
                      d={sectorPath(center, radius, arc.startAngle, arc.endAngle, innerRadius)}
                      tabIndex={0}
                      role="img"
                      aria-label={sliceText(arc.index)}
                      aria-describedby={activeCursor?.index === arc.index ? tooltipId : undefined}
                      fill={paletteColour(colours, arc.index)}
                      stroke="var(--color-surface)"
                      strokeWidth={1}
                      onMouseEnter={(event) => pointCursor(event, arc.index)}
                      onMouseMove={(event) => pointCursor(event, arc.index)}
                      onMouseLeave={() => {
                        setHovered(null);
                        setCursor(null);
                      }}
                      onFocus={() => {
                        const point = polarPoint(
                          center,
                          radius * 0.75,
                          (arc.startAngle + arc.endAngle) / 2,
                        );
                        setFocused(arc.index);
                        setCursor({
                          index: arc.index,
                          label: slice.label,
                          left: point.x,
                          top: point.y,
                        });
                      }}
                      onBlur={() => {
                        setFocused(null);
                        setCursor(null);
                      }}
                    />
                  );
                })}
                {labels.map((label) => (
                  <text
                    key={`${label.index}:${label.label}`}
                    className="pie-chart-label"
                    data-label={label.label}
                    x={label.x}
                    y={label.y}
                    textAnchor={label.textAnchor}
                    dominantBaseline="middle"
                    fill="var(--color-text)"
                    fontSize={12}
                    fontFamily="var(--font-sans)"
                    aria-label={displayLabel(label.label)}
                  >
                    <title>{displayLabel(label.label)}</title>
                    {label.text}
                  </text>
                ))}
              </svg>
            )}
            {(allHidden || arcs.length === 0) && (
              <p className="pie-chart-empty" role="status">
                {allHidden ? 'All slices are hidden' : emptyMessage}
              </p>
            )}
            {activeCursor && (
              <PieTooltip
                cursor={activeCursor}
                text={sliceText(activeCursor.index)}
                id={tooltipId}
              />
            )}
          </div>
          <ul className="pie-chart-legend" aria-label="Slice visibility">
            {slices.map((slice, index) => (
              <li key={`${index}:${slice.label}`}>
                <button
                  type="button"
                  className="pie-chart-legend-item"
                  aria-pressed={!hidden.has(slice.label)}
                  aria-label={displayLabel(slice.label)}
                  title={displayLabel(slice.label)}
                  onClick={() => toggleSlice(slice.label)}
                  onMouseEnter={() => setHovered(index)}
                  onMouseLeave={() => setHovered(null)}
                  onFocus={() => setFocused(index)}
                  onBlur={() => setFocused(null)}
                >
                  <span
                    aria-hidden="true"
                    className="pie-chart-swatch"
                    style={{ background: paletteColour(colours, index) }}
                  />
                  <span className="pie-chart-legend-label">
                    {shortened(displayLabel(slice.label), 40)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
