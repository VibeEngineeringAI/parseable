import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import gauge from '../../features/dashboards/__fixtures__/gauge/gauge.json';
import { gaugeModel } from '../../features/dashboards/gauge';
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
});
