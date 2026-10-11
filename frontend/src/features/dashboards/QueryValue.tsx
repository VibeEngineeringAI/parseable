import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { diagonalFill, type FillStyle } from './chartValue';
import { fitFontSize, queryValueThemes, sparklinePath, type QueryValueTheme } from './queryValue';

export type QueryValueProps = {
  label: string;
  text: string | undefined;
  theme: QueryValueTheme;
  fill?: { style: FillStyle; percent: number };
  spark?: number[];
};

let measurementContext: CanvasRenderingContext2D | null | undefined;

function useFitFontSize(text: string | undefined) {
  const root = useRef<HTMLDivElement>(null),
    [fontSize, setFontSize] = useState<number>();
  useLayoutEffect(() => {
    const element = root.current;
    if (!element || text === undefined) return;
    let active = true;
    const measure = () => {
      if (!active) return;
      if (measurementContext === undefined)
        measurementContext = document.createElement('canvas').getContext('2d');
      const context = measurementContext;
      const family = getComputedStyle(element).fontFamily;
      setFontSize(
        fitFontSize({
          measure: (px) => {
            if (!context) return 0.6 * px * text.length;
            context.font = `700 ${px}px ${family}`;
            return context.measureText(text).width;
          },
          width: Math.max(0, element.clientWidth - 16),
          height: element.clientHeight,
        }),
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    void document.fonts?.ready.then(measure);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [text]);
  return { root, fontSize: text === undefined ? undefined : fontSize };
}

export function QueryValue({ label, text, theme, fill, spark }: QueryValueProps) {
  const fitted = useFitFontSize(text);
  const colour = queryValueThemes[theme];
  const paths = spark && spark.length >= 2 ? sparklinePath(spark) : undefined;
  return (
    <div
      ref={fitted.root}
      className="dashboard-stat"
      role="group"
      aria-label={`${label} value`}
      data-qv={theme}
      data-empty={text === undefined}
      style={
        {
          '--qv-light': colour.light,
          '--qv-ink-light': 'ink' in colour ? colour.ink : colour.light,
          '--qv-dark': colour.dark,
          fontSize: fitted.fontSize,
        } as CSSProperties
      }
    >
      {fill && (
        <span
          className="dashboard-stat-fill"
          data-direction={fill.style}
          style={
            fill.style === 'vertical'
              ? { height: `${fill.percent}%` }
              : fill.style === 'diagonal'
                ? { clipPath: diagonalFill(fill.percent) }
                : { width: `${fill.percent}%` }
          }
          aria-hidden="true"
        />
      )}
      {paths && (
        <svg
          className="dashboard-stat-spark"
          aria-hidden="true"
          focusable="false"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
        >
          <path className="dashboard-stat-spark-area" d={paths.area} />
          <path
            className="dashboard-stat-spark-line"
            d={paths.line}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      )}
      {text ?? 'No values returned'}
    </div>
  );
}
