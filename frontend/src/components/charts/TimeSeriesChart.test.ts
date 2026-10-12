import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BubbleChart } from './BubbleChart';
import { PieChart } from './PieChart';
import { TimeSeriesChart, type TimeSeriesChartProps } from './TimeSeriesChart';

const label = '😀'.repeat(41);
const defaults: TimeSeriesChartProps = {
  timestamps: [10, 20],
  series: [{ id: 'a', label, values: [1, 2] }],
  colors: ['#2563eb'],
  showTitle: false,
};
const renderChart = (props: Partial<TimeSeriesChartProps> = {}) =>
  renderToStaticMarkup(createElement(TimeSeriesChart, { ...defaults, ...props }));

describe('chart legends', () => {
  it.each([
    [{}, 'charts-line-key', 'line', 'border-color:#2563eb'],
    [{ kind: 'bar' as const }, 'charts-legend-swatch', 'square', 'background:#2563eb'],
    [{ fill: true }, 'charts-legend-swatch', 'square', 'background:#2563eb'],
  ])(
    'renders the legend swatch for %j in the solid series colour',
    (props, className, key, style) => {
      const markup = renderChart(props);
      expect(markup).toContain(`class="${className}" data-legend-swatch="${key}" style="${style}"`);
      expect(markup).toContain(`aria-pressed="true" aria-label="${label}" title="${label}"`);
      expect(markup).toContain(`<span>${'😀'.repeat(40)}…</span>`);
      expect(markup).toContain(
        'Click to toggle; Alt-click or double-click to show only this series.',
      );
      expect(markup).not.toContain('title="Click to toggle');
    },
  );

  it('puts the group title first and includes it in the list name', () => {
    const markup = renderChart({ legendTitle: 'service | level:' });
    expect(markup).toContain(
      '<ul class="charts-legend" aria-label="service | level: series visibility"><li class="charts-legend-title" aria-hidden="true">service | level:</li><li>',
    );
    const plain = renderChart();
    expect(plain).toContain('aria-label="Series visibility"');
    expect(plain).not.toContain('charts-legend-title');
  });

  it('uses the shared square swatch and full accessible label for pie legends', () => {
    const markup = renderToStaticMarkup(
      createElement(PieChart, {
        slices: [{ label, value: 1 }],
        variant: 'pie',
        palette: ['#2563eb'],
      }),
    );
    expect(markup).toContain(
      'class="pie-chart-swatch charts-legend-swatch" data-legend-swatch="square"',
    );
    expect(markup).toContain(`aria-pressed="true" aria-label="${label}" title="${label}"`);
    expect(markup).toContain(`${'😀'.repeat(40)}…</span>`);
  });

  it('keeps bubble legend labels available in full while shortening visible text', () => {
    const markup = renderToStaticMarkup(
      createElement(BubbleChart, {
        points: [{ x: 1, y: 2, radius: 11, groupId: 'a' }],
        groups: [{ id: 'a', label, colour: '#2563eb' }],
        groupLabel: 'service',
      }),
    );
    expect(markup).toContain(
      'class="charts-bubble-swatch charts-legend-swatch" data-legend-swatch="square"',
    );
    expect(markup).toContain(`aria-label="${label}" title="${label}"`);
    expect(markup).toContain(`<span>${'😀'.repeat(40)}…</span>`);
  });
});

describe('zoom accessibility', () => {
  it('only advertises zoom and adds a live region when a time chart opts in', () => {
    const markup = renderChart({ onZoomRange: () => {} });
    expect(markup).toContain('data-zoom-enabled="true"');
    expect(markup).toContain('Shift+ArrowLeft and Shift+ArrowRight');
    expect(markup).toContain('class="charts-sr-only" aria-live="polite" aria-atomic="true"');
    for (const plain of [
      renderChart(),
      renderChart({ categories: ['a', 'b'], onZoomRange: () => {} }),
    ]) {
      expect(plain).not.toContain('data-zoom-enabled');
      expect(plain).not.toContain('Shift+Arrow');
      expect(plain).not.toContain('aria-atomic');
    }
  });
});
