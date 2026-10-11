import { useLayoutEffect, useRef, useState } from 'react';
import {
  GAUGE_CENTRE,
  GAUGE_INNER_RADIUS,
  GAUGE_OUTER_RADIUS,
  GAUGE_VIEWBOX,
  estimateEmWidth,
  fitGaugeText,
  gaugeTextBaseline,
  type GaugeModel,
} from '../../features/dashboards/gauge';
import './charts.css';

export type GaugeChartProps = { label: string; model: GaugeModel; text: string };

const { x, y } = GAUGE_CENTRE;
const outer = GAUGE_OUTER_RADIUS;
const inner = GAUGE_INNER_RADIUS;
const radius = (outer + inner) / 2;
const track = `M ${x - outer} ${y} A ${outer} ${outer} 0 0 1 ${x + outer} ${y} L ${x + inner} ${y} A ${inner} ${inner} 0 0 0 ${x - inner} ${y} Z`;
const arc = `M ${x - radius} ${y} A ${radius} ${radius} 0 0 1 ${x + radius} ${y}`;

export function GaugeChart({ label, model, text }: GaugeChartProps) {
  const textRef = useRef<SVGTextElement>(null);
  const [measured, setMeasured] = useState<{ text: string; emWidth: number }>();
  const emWidth = measured?.text === text ? measured.emWidth : estimateEmWidth(text);
  const fontSize = fitGaugeText(text, emWidth);
  useLayoutEffect(() => {
    let active = true;
    const measure = () => {
      const node = textRef.current;
      if (!active || !node || typeof node.getComputedTextLength !== 'function') return;
      const length = node.getComputedTextLength();
      const size = Number(node.getAttribute('font-size'));
      if (!Number.isFinite(length) || length <= 0 || !Number.isFinite(size) || size <= 0) return;
      const emWidth = (length / size) * 1.02;
      setMeasured((previous) =>
        previous?.text === text && Math.abs(previous.emWidth - emWidth) <= 0.001
          ? previous
          : { text, emWidth },
      );
    };
    measure();
    void document.fonts?.ready.then(measure);
    return () => {
      active = false;
    };
  }, [text]);
  const max = Math.max(model.min, model.max);
  const value = Math.max(model.min, Math.min(max, model.value));
  return (
    <div className="charts-gauge" role="group" aria-label={`${label} gauge`}>
      <div
        className="charts-gauge-meter"
        role="meter"
        aria-label={label}
        aria-valuemin={model.min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={text}
        data-level={model.level}
        data-fraction={model.fraction}
      >
        <svg aria-hidden="true" viewBox={GAUGE_VIEWBOX} preserveAspectRatio="xMidYMid meet">
          <path d={track} fill="var(--chart-gauge-track)" />
          <path
            className="charts-gauge-arc"
            d={arc}
            fill="none"
            stroke={model.colour}
            strokeWidth={outer - inner}
            strokeLinecap="butt"
            pathLength={1}
            strokeDasharray={`${model.fraction} 1`}
            data-fraction={model.fraction}
          />
          <text
            ref={textRef}
            className="charts-gauge-text"
            textAnchor="middle"
            x={x}
            y={gaugeTextBaseline(fontSize)}
            fontWeight={700}
            fontSize={fontSize}
            fill={model.colour}
          >
            {text}
          </text>
        </svg>
      </div>
    </div>
  );
}
