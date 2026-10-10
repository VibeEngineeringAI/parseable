import { useLayoutEffect, useRef, useState } from 'react';

/** Fit the plot into its flex body after reserving axis titles, count and legend. */
export function useChartHeight(height: number | 'fit', contentKey: string) {
  const root = useRef<HTMLDivElement>(null),
    [pixels, setPixels] = useState(100);
  useLayoutEffect(() => {
    const element = root.current;
    if (!element || height !== 'fit') return;
    function measure() {
      if (!element) return;
      const figure = element.querySelector<HTMLElement>('.charts-figure');
      const extras = Array.from(
        element.querySelectorAll<HTMLElement>(
          '.dashboard-axis-title, .dashboard-chart-note, .charts-count-row, .charts-legend',
        ),
      );
      const reserved = extras.reduce((total, child) => {
        const css = getComputedStyle(child);
        return (
          total +
          child.getBoundingClientRect().height +
          parseFloat(css.marginTop || '0') +
          parseFloat(css.marginBottom || '0')
        );
      }, 0);
      const sideLegend = ['left', 'right'].includes(element.dataset.legendPosition ?? '');
      const legend = sideLegend
        ? (element.querySelector<HTMLElement>('.charts-legend')?.getBoundingClientRect().height ??
          0)
        : 0;
      const figureCss = figure ? getComputedStyle(figure) : undefined;
      const gap = figureCss ? parseFloat(figureCss.rowGap) || 0 : 0;
      setPixels(Math.max(40, Math.floor(element.clientHeight - reserved + legend - gap * 2)));
    }
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    element
      .querySelectorAll('.dashboard-axis-title, .charts-count-row, .charts-legend')
      .forEach((child) => observer.observe(child));
    return () => observer.disconnect();
  }, [height, contentKey]);
  return { root, pixels: height === 'fit' ? pixels : height };
}
