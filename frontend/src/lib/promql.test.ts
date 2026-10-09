import { afterEach, describe, expect, it, vi } from 'vitest';
import { parser } from '@prometheus-io/lezer-promql';
import {
  autoStep,
  formatStep,
  formatValue,
  loadHistory,
  matcher,
  metricSelector,
  parseDuration,
  parseSampleValue,
  pushHistory,
  seriesLabel,
  summarizeSeries,
  toChartSeries,
  validateRange,
  varyingLabelKeys,
} from './promql';
import type { PromqlLabels, PromqlRangeResult } from './types';

afterEach(() => vi.unstubAllGlobals());

describe('PromQL steps and durations', () => {
  it.each([
    { end: 0, width: 100, query: 'cpu', expected: 15 },
    { end: 60, width: 0, query: 'cpu', expected: 15 },
    { end: 3600, width: 800, query: 'cpu', expected: 15 },
    { end: 86400, width: 400, query: 'cpu', expected: 300 },
    { end: 86400, width: 1000, query: 'cpu', expected: 120 },
    { end: 86400, width: 2000, query: 'cpu', expected: 60 },
    { end: 86400, width: 1000, maxDataPoints: 100, query: 'cpu', expected: 900 },
    { end: 3600, width: 800, query: 'rate(cpu[90s])', expected: 15 },
    { end: 10000, width: 400, query: 'rate(cpu[60s])', expected: 15 },
    { end: 86400, width: 400, query: 'rate(cpu[5m])', expected: 120 },
    { end: 86400, width: 400, query: 'sum(rate(cpu[1h30m]))', expected: 300 },
    { end: 6000, width: 400, query: 'rate(cpu[20s]) + rate(other[90s])', expected: 5 },
    { end: 100, width: 400, query: 'rate(cpu[3s])', expected: 1 },
    { end: 31 * 86400, width: 400, query: 'rate(cpu[4s])', expected: 900 },
    { end: 3000, width: 400, query: 'rate(cpu[4s])', expected: 1 },
    { end: 3001, width: 400, query: 'rate(cpu[4s])', expected: 2 },
  ])(
    'autoStep obeys width, window and point caps: $end / $query → $expected',
    ({ expected, ...options }) => {
      expect(autoStep({ start: 0, ...options })).toBe(expected);
    },
  );
  it.each([
    'cpu{label="[4s]"}',
    "cpu{label='[4s]'}",
    'cpu{label=`[4s]`}',
    'cpu{label="escaped \\" [4s]"}',
    'cpu # [4s]\n',
  ])('ignores range-like text inside labels and comments: %s', (query) => {
    expect(autoStep({ start: 0, end: 10000, width: 400, query })).toBe(30);
  });
  it('uses the real range window beside quoted values and ignores subquery windows', () => {
    expect(
      autoStep({ start: 0, end: 10000, width: 400, query: 'rate(cpu{label="[1s]"}[60s]) # [1s]' }),
    ).toBe(15);
    expect(autoStep({ start: 0, end: 10000, width: 400, query: 'cpu[5m:15s]' })).toBe(30);
  });
  it.each([
    ['15s', 15],
    ['1m30s', 90],
    ['1h30m', 5400],
    ['2h', 7200],
    ['1d', 86400],
    ['1w', 604800],
    ['1y', 365 * 86400],
    ['1s500ms', 1.5],
    ['500ms', 0.5],
    ['15', 15],
    ['1.25', 1.25],
    ['.5', 0.5],
    ['0', 0],
    ['-1', -1],
    [' 15s ', 15],
  ])('parses %s into %s seconds', (text, expected) => {
    expect(parseDuration(text as string)).toBe(expected);
  });
  it.each(['', 'nonsense', '1M', 'Infinity', 'NaN', '15sx', '1m 30s', '1s1m', '1m1m', '1e400'])(
    'rejects invalid duration %s',
    (text) => {
      expect(parseDuration(text)).toBeUndefined();
    },
  );
  it.each([
    [0, '0s'],
    [15, '15s'],
    [90, '90s'],
    [300, '5m'],
    [3600, '1h'],
    [86400, '1d'],
    [604800, '1w'],
    [0.5, '500ms'],
  ])('formats %s seconds using the largest exact unit', (seconds, expected) => {
    expect(formatStep(seconds as number)).toBe(expected);
  });
  it.each([
    { start: 0, end: 31 * 86400, step: '1h' },
    { start: 0, end: 10999, step: '1s' },
    { start: 1.123, end: 1.123, step: 0.001 },
    { start: 0, end: 15, step: '1.5' },
  ])('accepts valid inclusive range %#', (range) => {
    expect(validateRange(range)).toBeUndefined();
  });
  it.each([
    [{ start: 0, end: 31 * 86400 + 1, step: '1h' }, '31 days'],
    [{ start: 0, end: 11000, step: '1s' }, '11000 steps'],
    [{ start: 0, end: 1, step: '0s' }, 'positive'],
    [{ start: 0, end: 1, step: '-1' }, 'positive'],
    [{ start: 0, end: 1, step: 'oops' }, 'positive'],
    [{ start: 0, end: 1, step: Infinity }, 'positive'],
    [{ start: 1, end: 0, step: '15s' }, 'end time'],
    [{ start: NaN, end: 0, step: '15s' }, 'valid time'],
  ] as const)('rejects invalid range %#', (range, message) => {
    expect(validateRange(range)).toContain(message);
  });
});

describe('PromQL names, matchers and values', () => {
  it('drops metric names and constant labels, and keeps missing labels as varying', () => {
    const metrics: PromqlLabels[] = [
      { __name__: 'cpu', host: 'a', region: 'eu', 'service.name': 'checkout' },
      { __name__: 'other', host: 'b', region: 'eu', 'service.name': 'inventory', zone: '1' },
    ];
    const varyingKeys = varyingLabelKeys(metrics);
    expect(varyingKeys).toEqual(['host', 'service.name', 'zone']);
    expect(seriesLabel(metrics[0], { varyingKeys })).toBe('{host="a","service.name"="checkout"}');
    expect(seriesLabel(metrics[0], { keepName: true })).toBe(
      'cpu{host="a",region="eu","service.name"="checkout"}',
    );
    expect(seriesLabel(metrics[0], { varyingKeys: [] })).toBe('{}');
    expect(varyingLabelKeys([metrics[0]])).toEqual([]);
    expect(varyingLabelKeys([])).toEqual([]);
    expect(seriesLabel({ __name__: 'cpu' })).toBe('{}');
    expect(seriesLabel({})).toBe('{}');
  });
  it.each([
    ['cpu', 'cpu'],
    ['_cpu:total', '_cpu:total'],
    ['system.cpu.load_average.1m', '{"system.cpu.load_average.1m"}'],
    ['9metric', '{"9metric"}'],
  ])('selects metric %s with the proper syntax', (name, expected) => {
    expect(metricSelector(name)).toBe(expected);
  });
  it('escapes matcher values and quoted names without allowing selector injection', () => {
    const value = 'a\\b"c\nline\r\t';
    expect(matcher('host', value)).toBe('host="a\\\\b\\"c\\nline\\r\\t"');
    expect(matcher('service.name', 'checkout', '!=')).toBe('"service.name"!="checkout"');
    expect(matcher('host', 'node-.*', '=~')).toBe('host=~"node-.*"');
    expect(matcher('host', 'node-.*', '!~')).toBe('host!~"node-.*"');
    expect(metricSelector('a"b\\c\n')).toBe('{"a\\"b\\\\c\\n"}');
  });
  it('the installed Lezer grammar parses dotted metric selectors and quoted label matchers', () => {
    for (const query of [
      metricSelector('system.cpu.load_average.1m'),
      `{${matcher('service.name', 'checkout')}}`,
      `{${matcher('service.name', 'a\\b"c\n')}}`,
    ]) {
      const errors: number[] = [];
      parser.parse(query).iterate({
        enter(node) {
          if (node.type.isError) errors.push(node.from);
        },
      });
      expect(errors, query).toEqual([]);
    }
  });
  it.each([
    [0, '0'],
    ['-0', '0'],
    [1e9, '1.00e+9'],
    [-1e9, '-1.00e+9'],
    [1000.6, '1001'],
    [-1000.6, '-1001'],
    [1.234, '1.23'],
    [-1.234, '-1.23'],
    [0.001, '0.0010'],
    [0.12345, '0.1235'],
    [0.00012, '1.20e-4'],
    ['NaN', '-'],
    ['+Inf', '-'],
    ['-Inf', '-'],
    [Infinity, '-'],
    ['invalid', '-'],
  ])('formats sample %s as %s', (value, expected) => {
    expect(formatValue(value)).toBe(expected);
  });
  it('parses special values and preserves finite samples', () => {
    expect(parseSampleValue('+Inf')).toBe(Infinity);
    expect(parseSampleValue('-Inf')).toBe(-Infinity);
    expect(parseSampleValue('NaN')).toBeNaN();
    expect(parseSampleValue('')).toBeNaN();
    expect(parseSampleValue('2.5')).toBe(2.5);
    expect(parseSampleValue('-2e-3')).toBe(-0.002);
  });
});

describe('PromQL chart data and history', () => {
  const result: PromqlRangeResult = {
    resultType: 'matrix',
    result: [
      {
        metric: { region: 'eu', host: 'b', __name__: 'cpu' },
        values: [
          [3, 'NaN'],
          [1, '2'],
          [4, '+Inf'],
        ],
      },
      {
        metric: { __name__: 'cpu', host: 'a', region: 'eu' },
        values: [
          [2, '5'],
          [1, '-Inf'],
        ],
      },
    ],
  };
  it('aligns union timestamps, sorts series and creates null gaps for missing/non-finite values', () => {
    const chart = toChartSeries(result, 'A');
    expect(chart.timestamps).toEqual([1, 2, 3, 4]);
    expect(chart.series.map(({ label, values }) => ({ label, values }))).toEqual([
      { label: 'A: {host="a"}', values: [null, 5, null, null] },
      { label: 'A: {host="b"}', values: [2, null, null, null] },
    ]);
    expect(chart.series[0].id).toBe('A:{__name__="cpu",host="a",region="eu"}');
  });
  it('keeps identities stable across result/label ordering and separates queries and metric names', () => {
    const reversed: PromqlRangeResult = {
      resultType: 'matrix',
      result: [...result.result].reverse().map((item) => ({
        ...item,
        metric: Object.fromEntries(Object.entries(item.metric).reverse()),
      })),
    };
    expect(toChartSeries(reversed, 'A')).toEqual(toChartSeries(result, 'A'));
    expect(toChartSeries(result, 'B').series[0].id).not.toBe(
      toChartSeries(result, 'A').series[0].id,
    );
    const differentName: PromqlRangeResult = {
      resultType: 'matrix',
      result: [{ metric: { ...result.result[0].metric, __name__: 'memory' }, values: [] }],
    };
    expect(toChartSeries(differentName).series[0].id).not.toBe(
      toChartSeries({ resultType: 'matrix', result: [result.result[0]] }).series[0].id,
    );
  });
  it('handles empty results and keeps all labels for a single series', () => {
    expect(toChartSeries({ resultType: 'matrix', result: [] })).toEqual({
      timestamps: [],
      series: [],
    });
    expect(
      toChartSeries({ resultType: 'matrix', result: [result.result[0]] }).series[0].label,
    ).toBe('{host="b",region="eu"}');
  });
  it('summarizes finite values and ignores gaps', () => {
    expect(summarizeSeries([null, 1, 5, null, 3, null])).toEqual({
      last: 3,
      min: 1,
      max: 5,
      avg: 3,
    });
    expect(summarizeSeries([null, NaN, Infinity])).toEqual({
      last: null,
      min: null,
      max: null,
      avg: null,
    });
    expect(summarizeSeries([])).toEqual({ last: null, min: null, max: null, avg: null });
  });
  function storage() {
    const data = new Map<string, string>();
    const local = {
      getItem: vi.fn((key: string) => data.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        data.set(key, value);
      }),
    };
    vi.stubGlobal('localStorage', local);
    return local;
  }
  it('deduplicates newest-first history, limits it to ten and separates datasets', () => {
    const local = storage();
    for (let index = 0; index < 12; index++) pushHistory('cpu', `query${index}`);
    pushHistory('cpu', 'query5');
    pushHistory('other', 'different');
    expect(loadHistory('cpu')).toEqual([
      'query5',
      'query11',
      'query10',
      'query9',
      'query8',
      'query7',
      'query6',
      'query4',
      'query3',
      'query2',
    ]);
    expect(loadHistory('other')).toEqual(['different']);
    expect(local.setItem).toHaveBeenCalledWith('parseable:promql-history:other', '["different"]');
    const count = local.setItem.mock.calls.length;
    pushHistory('cpu', '  ');
    expect(local.setItem).toHaveBeenCalledTimes(count);
  });
  it('recovers from malformed JSON and filters invalid stored entries', () => {
    const local = storage();
    local.setItem('parseable:promql-history:cpu', '{bad json');
    expect(loadHistory('cpu')).toEqual([]);
    pushHistory('cpu', 'cpu');
    expect(loadHistory('cpu')).toEqual(['cpu']);
    local.setItem('parseable:promql-history:cpu', '[1,"cpu","cpu",null,""," ","memory"]');
    expect(loadHistory('cpu')).toEqual(['cpu', 'memory']);
    local.setItem('parseable:promql-history:cpu', '{"query":"cpu"}');
    expect(loadHistory('cpu')).toEqual([]);
  });
  it('handles missing or unavailable storage without throwing', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(loadHistory('cpu')).toEqual([]);
    expect(() => pushHistory('cpu', 'cpu')).not.toThrow();
    vi.stubGlobal('localStorage', {
      getItem() {
        throw new Error('Unavailable');
      },
      setItem() {
        throw new Error('Full');
      },
    });
    expect(loadHistory('cpu')).toEqual([]);
    expect(() => pushHistory('cpu', 'cpu')).not.toThrow();
  });
});
