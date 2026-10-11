import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { QueryResult } from '../../lib/promqlResults';
import type { DashboardTile, PromqlInstantResult } from '../../lib/types';
import fixtures from './__fixtures__/pie-tiles.json';
import { TileChart } from './TileChart';
import { promqlSlices, sqlSlices, tileSlices } from './slices';

const tile: DashboardTile = fixtures.pie;
const native: DashboardTile = { tile_id: 'native', chartType: 'pie' };
const query = (instant?: PromqlInstantResult, id = 'A'): QueryResult => ({
  id,
  instant,
  pending: 0,
  errors: [],
});

describe('SQL slices', () => {
  it.each(['pie', 'donut', 'donut-config-type-pie', 'pie-labels-legend-right'] as const)(
    'sums duplicate categories, skips null categories and keeps blank labels for %s',
    (name) => {
      expect(
        sqlSlices(
          [
            { level: 'INFO', events: 4 },
            { level: 'ERROR', events: '2' },
            { level: 'INFO', events: '3' },
            { level: null, events: 100 },
            { events: 100 },
            { level: '', events: 5 },
            { level: undefined, events: 200 },
          ],
          fixtures[name],
        ),
      ).toEqual([
        { label: 'INFO', value: 7 },
        { label: 'ERROR', value: 2 },
        { label: '', value: 5 },
      ]);
    },
  );

  it('uses the first Y field, ignores X and preserves the input', () => {
    const configured = {
      ...tile,
      config: { axes: { x: { field: 'events' }, y: { field: ['level', 'events'] } } },
    };
    const before = structuredClone(configured);
    const rows = [{ level: 'WARN', events: 3 }];
    expect(sqlSlices(rows, configured)).toEqual([{ label: 'WARN', value: 3 }]);
    expect(configured).toEqual(before);
    expect(rows).toEqual([{ level: 'WARN', events: 3 }]);
  });

  it('keeps integer-like keys in numeric order and other keys in appearance order', () => {
    const labels = ['z', '10', '2', 'a', '01', '__proto__', 'constructor', 'z'];
    expect(
      sqlSlices(
        labels.map((level) => ({ level, events: 1 })),
        tile,
      ),
    ).toEqual([
      { label: '2', value: 1 },
      { label: '10', value: 1 },
      { label: 'z', value: 2 },
      { label: 'a', value: 1 },
      { label: '01', value: 1 },
      { label: '__proto__', value: 1 },
      { label: 'constructor', value: 1 },
    ]);
  });

  it('uses the first other key even when it is a text column before the amount', () => {
    expect(
      sqlSlices(
        [
          { level: 'ignored', note: 'text', events: 99 },
          { note: '7', level: 'kept', events: 99 },
          { level: 'negative', events: -2 },
        ],
        tile,
      ),
    ).toEqual([
      { label: 'kept', value: 7 },
      { label: 'negative', value: -2 },
    ]);
  });

  it('converts primitive categories and JSON objects to labels', () => {
    expect(
      sqlSlices(
        [
          { level: false, events: 1 },
          { level: { host: 'node' }, events: 2 },
          { level: ['a', 'b'], events: 3 },
          { level: 404, events: 4 },
        ],
        tile,
      ),
    ).toEqual([
      { label: '404', value: 4 },
      { label: 'false', value: 1 },
      { label: '{"host":"node"}', value: 2 },
      { label: '["a","b"]', value: 3 },
    ]);
  });

  it('converts empty values to zero and accepts numeric strings and booleans', () => {
    const amounts = [null, undefined, '', '  \t', true, false, '2.5', -3];
    expect(
      sqlSlices(
        amounts.map((events, index) => ({ level: `slice-${index}`, events })),
        tile,
      ).map((slice) => slice.value),
    ).toEqual([0, 0, 0, 0, 1, 0, 2.5, -3]);
    expect(sqlSlices([{ level: 'only category' }], tile)).toEqual([
      { label: 'only category', value: 0 },
    ]);
  });

  it('drops non-finite amounts without poisoning duplicate sums', () => {
    const amounts = [NaN, Infinity, -Infinity, 'NaN', 'Infinity', 'text', {}, [], 1n];
    expect(
      sqlSlices(
        [
          { level: 'valid', events: 2 },
          ...amounts.map((events) => ({ level: 'valid', events })),
          { level: 'valid', events: 3 },
          { level: 'overflow', events: 1e308 },
          { level: 'overflow', events: 1e308 },
        ],
        tile,
      ),
    ).toEqual([{ label: 'valid', value: 5 }]);
    expect(sqlSlices([{ level: 'bad', events: NaN }], tile)).toEqual([]);
  });

  it('infers the first non-numeric category and first numeric value from all row keys', () => {
    expect(
      sqlSlices(
        [
          { events: 3, method: 'GET', note: 'text' },
          { events: 5, method: 'POST' },
          { events: null, method: 'GET' },
        ],
        native,
      ),
    ).toEqual([
      { label: 'GET', value: 3 },
      { label: 'POST', value: 5 },
    ]);
    expect(
      sqlSlices(
        [
          { category: 'A', maybe: '3' },
          { category: 'B', maybe: null, actual: 4 },
        ],
        { ...native, config: { axes: { y: { field: [] } } } },
      ),
    ).toEqual([
      { label: 'A', value: 0 },
      { label: 'B', value: 4 },
    ]);
  });

  it('uses a second column as the category when all columns are numeric', () => {
    expect(
      sqlSlices(
        [
          { events: 4, status: 404 },
          { events: 6, status: 200 },
        ],
        { ...native, config: { axes: { y: { field: '' } } } },
      ),
    ).toEqual([
      { label: '200', value: 6 },
      { label: '404', value: 4 },
    ]);
  });

  it('requires a usable inferred pair and numbers in every non-null value of the amount column', () => {
    for (const rows of [
      [],
      [{ category: 'a' }],
      [{ value: 1 }],
      [{ value: null, category: 'a' }],
      [
        { value: 3, category: 'a' },
        { value: '4', category: 'b' },
      ],
    ])
      expect(sqlSlices(rows, native)).toEqual([]);
  });

  it('returns nothing when a configured category column is absent', () => {
    expect(sqlSlices([{ category: 'a', count: 3 }], tile)).toEqual([]);
  });

  it('does not cap or regroup slices', () => {
    const rows = Array.from({ length: 501 }, (_, index) => ({
      level: `category-${index}`,
      events: index,
    }));
    expect(sqlSlices(rows, tile)).toHaveLength(501);
    expect(sqlSlices(rows, tile).at(-1)).toEqual({ label: 'category-500', value: 500 });
  });
});

describe('PromQL slices', () => {
  it.each(['promql-pie', 'promql-donut'] as const)(
    'maps finite vector series to full metric labels for %s',
    (name) => {
      const instant: PromqlInstantResult = {
        resultType: 'vector',
        result: [
          { metric: { status: '200', __name__: 'requests', service: 'api' }, value: [10, '3'] },
          { metric: { service: 'api', status: '500' }, value: [10, '-2.5'] },
          { metric: {}, value: [10, '0'] },
          ...['NaN', '+Inf', '-Inf', 'Infinity', '', '  '].map((value) => ({
            metric: { status: 'invalid' },
            value: [10, value] as [number, string],
          })),
        ],
      };
      expect(tileSlices({ promql: [query(instant)] }, fixtures[name])).toEqual([
        { label: 'requests{service="api",status="200"}', value: 3 },
        { label: '{service="api",status="500"}', value: -2.5 },
        { label: '{}', value: 0 },
      ]);
    },
  );

  it('maps a finite scalar to value and ignores string results', () => {
    expect(promqlSlices([query({ resultType: 'scalar', result: [10, '7'] })])).toEqual([
      { label: 'value', value: 7 },
    ]);
    expect(promqlSlices([query({ resultType: 'scalar', result: [10, '+Inf'] })])).toEqual([]);
    expect(promqlSlices([query({ resultType: 'string', result: [10, '7'] })])).toEqual([]);
  });

  it('takes the last finite matrix sample by timestamp without requiring sorted samples', () => {
    expect(
      promqlSlices([
        query({
          resultType: 'matrix',
          result: [
            {
              metric: { __name__: 'requests', service: 'api' },
              values: [
                [30, '7'],
                [10, '8'],
                [40, 'NaN'],
                [50, '+Inf'],
                [20, '6'],
              ],
            },
            { metric: { service: 'none' }, values: [] },
            {
              metric: { service: 'invalid' },
              values: [
                [10, '-Inf'],
                [20, 'NaN'],
              ],
            },
            { metric: { service: 'zero' }, values: [[10, '0']] },
          ],
        }),
      ]),
    ).toEqual([
      { label: 'requests{service="api"}', value: 7 },
      { label: '{service="zero"}', value: 0 },
    ]);
  });

  it('uses a range matrix only when the instant result is absent', () => {
    const range: QueryResult['range'] = {
      resultType: 'matrix',
      result: [
        {
          metric: { host: 'a' },
          values: [
            [20, '5'],
            [30, 'NaN'],
            [10, '8'],
          ],
        },
      ],
    };
    expect(promqlSlices([{ ...query(), range }])).toEqual([{ label: '{host="a"}', value: 5 }]);
    expect(
      promqlSlices([{ ...query({ resultType: 'scalar', result: [20, '2'] }), range }]),
    ).toEqual([{ label: 'value', value: 2 }]);
    expect(promqlSlices([{ ...query({ resultType: 'vector', result: [] }), range }])).toEqual([]);
    expect(promqlSlices([query()])).toEqual([]);
  });

  it('prefixes multiple queries with their ids and keeps single-query labels unprefixed', () => {
    const a = query({ resultType: 'scalar', result: [10, '2'] });
    const b = query(
      { resultType: 'vector', result: [{ metric: { job: 'api' }, value: [10, '3'] }] },
      'B',
    );
    expect(promqlSlices([a, b])).toEqual([
      { label: '[A] value', value: 2 },
      { label: '[B] {job="api"}', value: 3 },
    ]);
    expect(promqlSlices([b])).toEqual([{ label: '{job="api"}', value: 3 }]);
  });
});

describe('tile slices and dispatch', () => {
  it('prefers PromQL when present, including an empty result, otherwise uses SQL', () => {
    const rows = [{ level: 'INFO', events: 3 }];
    expect(tileSlices({ rows }, tile)).toEqual([{ label: 'INFO', value: 3 }]);
    expect(tileSlices({ rows, promql: [] }, tile)).toEqual([]);
    expect(tileSlices({}, tile)).toEqual([]);
  });

  it('renders a donut from chartType even when config.type is pie, keeping all stored keys', () => {
    const donut = fixtures['donut-config-type-pie'];
    const before = structuredClone(donut);
    const markup = renderToStaticMarkup(
      createElement(TileChart, {
        tile: donut,
        result: { rows: [{ level: 'INFO', events: 3 }] },
        start: 0,
        end: 60,
        height: 200,
      }),
    );
    expect(markup).toContain('data-variant="donut"');
    expect(markup).toContain('class="pie-chart-legend"');
    expect(donut).toEqual(before);
    expect(donut.chartType).toBe('donut');
    expect(donut.config.type).toBe('pie');
  });
});
