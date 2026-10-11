import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import gauge from '../../features/dashboards/__fixtures__/gauge/gauge.json';
import {
  GAUGE_CENTRE,
  GAUGE_TEXT,
  estimateEmWidth,
  fitGaugeText,
  gaugeModel,
  gaugeTextBaseline,
} from '../../features/dashboards/gauge';
import { GaugeChart } from './GaugeChart';

describe('GaugeChart markup', () => {
  it.each([
    [-5, 0, 0],
    [50, 50, 0.5],
    [140, 100, 1],
  ])(
    'keeps the original value %s in text and clamps the accessible meter',
    (value, now, fraction) => {
      const markup = renderToStaticMarkup(
        createElement(GaugeChart, {
          label: 'CPU utilization',
          model: gaugeModel(value, gauge),
          text: `${value} %`,
        }),
      );
      expect(markup).toContain('role="group" aria-label="CPU utilization gauge"');
      expect(markup).toContain('role="meter" aria-label="CPU utilization"');
      expect(markup).toContain('aria-valuemin="0" aria-valuemax="100"');
      expect(markup).toContain(`aria-valuenow="${now}" aria-valuetext="${value} %"`);
      expect(markup).toContain(`stroke-dasharray="${fraction} 1"`);
      expect(markup).toContain(`data-fraction="${fraction}"`);
      expect(markup).toContain(
        '<svg aria-hidden="true" viewBox="0 0 200 104" preserveAspectRatio="xMidYMid meet">',
      );
      expect(markup).not.toMatch(/<svg[^>]*role=/);
      expect(markup.match(/<text\b/g)).toHaveLength(1);
      expect(markup).toContain(`>${value} %</text>`);
    },
  );

  it('exposes a valid meter range for reversed bounds and keeps the semantic colour', () => {
    const model = gaugeModel(25, {
      tile_id: 'reversed',
      config: { layout: { rangeFrom: 20, rangeTo: 10, segments: { value: [10] } } },
    });
    const markup = renderToStaticMarkup(
      createElement(GaugeChart, {
        label: 'Reversed',
        model,
        text: '25',
      }),
    );
    expect(markup).toContain('aria-valuemin="20" aria-valuemax="20" aria-valuenow="20"');
    expect(markup).toContain('data-level="red"');
    expect(markup).toContain('stroke="#dc2626"');
    expect(markup).toContain('fill="#dc2626"');
  });

  it.each(['320.4 GB', '72.5 %', '1,234,567 ms', '54.6%', '-12.5 °C'])(
    'fits and positions %s using the deterministic fallback without a browser',
    (text) => {
      const markup = renderToStaticMarkup(
        createElement(GaugeChart, { label: 'Units', model: gaugeModel(50, gauge), text }),
      );
      const tag = markup.match(/<text\b[^>]*>/)![0];
      const size = Number(tag.match(/font-size="([^"]+)"/)![1]);
      const baseline = Number(tag.match(/\by="([^"]+)"/)![1]);
      expect(size).toBe(fitGaugeText(text));
      expect(baseline).toBe(gaugeTextBaseline(size));
      expect(baseline).toBeLessThanOrEqual(GAUGE_CENTRE.y - 8);
      for (const side of [-0.5, 0.5])
        for (const height of [baseline - GAUGE_TEXT.capHeight * size, baseline])
          expect(
            Math.hypot(estimateEmWidth(text) * size * side, height - GAUGE_CENTRE.y),
          ).toBeLessThanOrEqual(GAUGE_TEXT.fitRadius);
    },
  );
});
