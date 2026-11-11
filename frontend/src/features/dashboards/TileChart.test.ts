import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DashboardTile, LogRecord } from '../../lib/types';
import { TileChart } from './TileChart';

const time = '2026-10-10T10:00:00.000Z';
const renderChart = (tile: DashboardTile, rows: LogRecord[], zoomable = true) =>
  renderToStaticMarkup(
    createElement(TileChart, {
      tile,
      result: { rows },
      start: Date.parse(time) / 1000,
      end: Date.parse(time) / 1000 + 60,
      height: 200,
      onZoomRange: zoomable ? () => {} : undefined,
    }),
  );
const tile = (chartType: string) =>
  ({
    tile_id: 'chart',
    chartType,
    config: {
      axes: { x: { field: 'x', title: 'Service' }, y: { field: 'value', title: 'Requests' } },
    },
  }) satisfies DashboardTile;

describe('TileChart', () => {
  it('renders saved PromQL display names in the legend without opaque aggregate labels', () => {
    const markup = renderToStaticMarkup(
      createElement(TileChart, {
        tile: {
          tile_id: 'load',
          tileType: 'promql',
          chartType: 'line',
          config: { queryAliases: { A: '1-minute average', B: '5-minute average' } },
        },
        result: {
          promql: ['A', 'B'].map((id) => ({
            id,
            pending: 0,
            errors: [],
            range: {
              resultType: 'matrix' as const,
              result: [
                {
                  metric: {},
                  values: [
                    [1, '3'],
                    [2, '4'],
                  ] as [number, string][],
                },
              ],
            },
          })),
        },
        start: 1,
        end: 2,
        height: 200,
      }),
    );
    expect(markup).toContain('1-minute average');
    expect(markup).toContain('5-minute average');
    expect(markup).not.toContain('A: {}');
    expect(markup).not.toContain('B: {}');
  });
  it.each(['timeseries', 'line', 'area', 'bar'])(
    'only enables zoom for time data in timeseries tiles: %s',
    (chartType) => {
      const markup = renderChart(tile(chartType), [{ x: time, value: 2 }]);
      expect(markup.includes('data-zoom-enabled="true"')).toBe(chartType === 'timeseries');
      expect(renderChart(tile(chartType), [{ x: 'api', value: 2 }])).not.toContain(
        'data-zoom-enabled',
      );
    },
  );

  it('leaves previews without a zoom callback unchanged', () => {
    expect(renderChart(tile('timeseries'), [{ x: time, value: 2 }], false)).not.toContain(
      'data-zoom-enabled',
    );
  });

  it('passes grouped SQL legend titles through to the time and categorical legends', () => {
    const grouped = {
      ...tile('timeseries'),
      config: {
        axes: { x: { field: 'x' }, y: { field: 'value' }, groupBy: { field: ['service'] } },
      },
    };
    for (const x of [time, 'category']) {
      const markup = renderChart(grouped, [{ x, value: 2, service: 'api' }]);
      expect(markup).toContain('aria-label="service: series visibility"');
      expect(markup).toContain('<li class="charts-legend-title" aria-hidden="true">service:</li>');
    }
  });

  it('keeps the value title above vertical charts and removes it for horizontal category bars', () => {
    const vertical = tile('bar');
    const horizontal = {
      ...vertical,
      config: { ...vertical.config, layout: { barOrientation: 'horizontal' } },
    };
    expect(renderChart(vertical, [{ x: 'api', value: 2 }])).toContain(
      '<p class="muted dashboard-axis-title">Requests</p>',
    );
    expect(renderChart(horizontal, [{ x: 'api', value: 2 }])).not.toContain('dashboard-axis-title');
    expect(renderChart(horizontal, [{ x: time, value: 2 }])).toContain(
      '<p class="muted dashboard-axis-title">Requests</p>',
    );
  });
});
