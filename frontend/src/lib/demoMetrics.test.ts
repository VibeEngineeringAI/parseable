import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, promqlErrorType } from './client';
import { createDemoClient, demoDatasets } from './demo';
import { listMetricsDatasets } from './metrics';
import { matcher, metricSelector } from './promql';
import type { ParseableClient, PromqlInstantResult } from './types';

const now = Date.UTC(2026, 9, 9, 12);
const end = now / 1000;
const stream = 'demo_metrics';
const cpu = '{"system.cpu.load_average.1m"}';
const counter = '{"http.server.requests"}';
const oneCounter = '{"http.server.requests","service.name"="checkout",method="GET",status="200"}';
const unsupportedMessage =
  'Demo PromQL supports selectors, rate/increase/irate/delta, *_over_time and sum/avg/min/max/count. Connect to a server for other PromQL.';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function asVector(result: PromqlInstantResult) {
  expect(result.resultType).toBe('vector');
  if (result.resultType !== 'vector') throw new Error('Expected vector');
  return result.result;
}
function asMatrix(result: PromqlInstantResult) {
  expect(result.resultType).toBe('matrix');
  if (result.resultType !== 'matrix') throw new Error('Expected matrix');
  return result.result;
}
const instant = (client: ParseableClient, query: string, time = end) =>
  client.promqlQuery({ stream, query, time });

describe('demo metric inventory and metadata', () => {
  it('adds a metrics dataset and supplies every dataset info/capability without network access', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const client = createDemoClient();
    expect((await client.about()).capabilities.promql).toBe(true);
    expect(await client.listDatasets()).toEqual(demoDatasets);
    expect(demoDatasets.find((dataset) => dataset.name === stream)).toEqual({
      name: stream,
      type: 'metrics',
    });
    for (const dataset of demoDatasets) {
      const info = await client.datasetInfo(dataset.name);
      expect(info).toMatchObject({
        name: dataset.name,
        telemetryType: dataset.type,
        logSourceFormats: [dataset.type === 'metrics' ? 'otel-metrics' : 'json'],
      });
      expect(Number.isFinite(Date.parse(info.latestEventAt!))).toBe(true);
    }
    expect(await listMetricsDatasets(client)).toMatchObject({
      datasets: [{ name: stream }],
      unchecked: [],
    });
    expect(fetch).not.toHaveBeenCalled();
    await expect(client.datasetInfo('missing')).rejects.toMatchObject({ status: 404 });
  });
  it('returns sorted names, labels and dotted label values', async () => {
    const client = createDemoClient();
    expect(await client.promqlLabelValues('__name__', { stream })).toEqual({
      data: ['http.server.requests', 'process.memory.usage', 'system.cpu.load_average.1m'],
      truncated: false,
    });
    expect(await client.promqlLabels({ stream })).toEqual({
      data: ['__name__', 'host', 'method', 'service.name', 'status'],
      truncated: false,
    });
    expect(await client.promqlLabelValues('service.name', { stream })).toEqual({
      data: ['checkout', 'inventory'],
      truncated: false,
    });
    expect((await client.promqlLabelValues('host', { stream })).data).toEqual([
      'node-01',
      'node-02',
      'node-03',
      'node-04',
    ]);
    expect(await client.promqlLabelValues('unknown', { stream })).toEqual({
      data: [],
      truncated: false,
    });
  });
  it.each([cpu, '{__name__="system.cpu.load_average.1m"}'])(
    'honors the metric selector %s in metadata',
    async (selector) => {
      const client = createDemoClient();
      expect((await client.promqlLabels({ stream, match: [selector] })).data).toEqual([
        '__name__',
        'host',
        'service.name',
      ]);
      expect(
        (await client.promqlLabelValues('__name__', { stream, match: [selector] })).data,
      ).toEqual(['system.cpu.load_average.1m']);
      expect(
        (await client.promqlLabelValues('status', { stream, match: [selector] })).data,
      ).toEqual([]);
    },
  );
  it('unions repeatable match selectors, supports legacy name{...} syntax and honors all matcher operators', async () => {
    const client = createDemoClient();
    const params = {
      stream,
      match: [
        'missing_metric{host="node-01"}',
        '{"system.cpu.load_average.1m",host=~"node-0[13]"}',
        '{"http.server.requests",method!="GET",status!~"500","service.name"="checkout"}',
      ],
    };
    expect((await client.promqlLabels(params)).data).toEqual([
      '__name__',
      'host',
      'method',
      'service.name',
      'status',
    ]);
    expect((await client.promqlLabelValues('host', params)).data).toEqual(['node-01', 'node-03']);
    expect((await client.promqlLabelValues('method', params)).data).toEqual(['POST']);
    expect((await client.promqlLabelValues('status', params)).data).toEqual(['200']);
  });
  it('sets truncated only when results exceed limit and treats zero as the maximum', async () => {
    const client = createDemoClient();
    expect(await client.promqlLabelValues('__name__', { stream, limit: 1 })).toEqual({
      data: ['http.server.requests'],
      truncated: true,
    });
    expect(await client.promqlLabelValues('__name__', { stream, match: [cpu], limit: 1 })).toEqual({
      data: ['system.cpu.load_average.1m'],
      truncated: false,
    });
    expect((await client.promqlLabelValues('__name__', { stream, limit: 0 })).data).toHaveLength(3);
    expect(await client.promqlLabels({ stream, limit: 2 })).toEqual({
      data: ['__name__', 'host'],
      truncated: true,
    });
  });
  it('restricts metadata to the fixture time span and keeps info anchored to fixture creation', async () => {
    const client = createDemoClient();
    expect(
      await client.promqlLabels({ stream, start: end - 9 * 86400, end: end - 8 * 86400 }),
    ).toEqual({ data: [], truncated: false });
    expect(
      (await client.promqlLabels({ stream, start: end - 7 * 86400, end: end - 7 * 86400 })).data,
    ).toContain('host');
    vi.setSystemTime(now + 86400000);
    expect((await client.datasetInfo(stream)).latestEventAt).toBe(new Date(now).toISOString());
  });
});

describe('demo PromQL evaluation', () => {
  it('returns deterministic gauges on a 15-second grid over seven days', async () => {
    const client = createDemoClient();
    const request = { stream, query: cpu, start: end - 60, end, step: '15s' };
    const result = await client.promqlQueryRange(request);
    expect(result).toEqual(await createDemoClient().promqlQueryRange(request));
    expect(result.resultType).toBe('matrix');
    expect(result.result).toHaveLength(4);
    expect(result.result[0].values.map(([time]) => time)).toEqual([
      end - 60,
      end - 45,
      end - 30,
      end - 15,
      end,
    ]);
    expect(
      result.result.every((item) =>
        item.values.every(
          ([time, value]) =>
            Number.isFinite(time) && typeof value === 'string' && Number.isFinite(Number(value)),
        ),
      ),
    ).toBe(true);
    expect(asVector(await instant(client, cpu, end - 7 * 86400))).toHaveLength(4);
    expect(asVector(await instant(client, cpu, end - 7 * 86400 - 1))).toEqual([]);
    expect(asVector(await instant(client, cpu, end + 301))).toEqual([]);
    expect(asVector(await instant(client, metricSelector('process.memory.usage')))).toHaveLength(4);
  });
  it('uses the latest resolution point while retaining fractional query timestamps', async () => {
    const client = createDemoClient();
    const baseline = asVector(await instant(client, cpu));
    const fractional = asVector(await instant(client, cpu, end + 7.123));
    expect(fractional[0].value).toEqual([end + 7.123, baseline[0].value[1]]);
  });
  it.each([
    ['=', 'node-01', 1],
    ['!=', 'node-01', 3],
    ['=~', 'node-0[13]', 2],
    ['!~', 'node-0[13]', 2],
  ] as const)('supports host %s %s selectors', async (op, value, count) => {
    const query = `{__name__="system.cpu.load_average.1m",${matcher('host', value, op)}}`;
    expect(asVector(await instant(createDemoClient(), query))).toHaveLength(count);
  });
  it('supports dotted labels, quoted names, missing-label matchers and escaped literal values', async () => {
    const client = createDemoClient();
    expect(
      asVector(
        await instant(client, '{"system.cpu.load_average.1m","service.name"="checkout"}'),
      ).map((item) => item.metric.host),
    ).toEqual(['node-01', 'node-03']);
    expect(asVector(await instant(client, 'missing_metric{host="node-01"}'))).toEqual([]);
    expect(
      asVector(await instant(client, '{__name__="system.cpu.load_average.1m",missing!="present"}')),
    ).toHaveLength(4);
    expect(
      asVector(
        await instant(
          client,
          `{__name__="system.cpu.load_average.1m",${matcher('host', 'node-01\\"\n')}}`,
        ),
      ),
    ).toEqual([]);
  });
  it('returns a matrix for an instant range selector with compound windows', async () => {
    const result = asMatrix(await instant(createDemoClient(), `${cpu}[1m30s]`));
    expect(result).toHaveLength(4);
    expect(result[0].values.map(([time]) => time)).toEqual([
      end - 75,
      end - 60,
      end - 45,
      end - 30,
      end - 15,
      end,
    ]);
    expect(result[0].metric.__name__).toBe('system.cpu.load_average.1m');
  });
  it.each(['rate', 'increase', 'irate', 'delta'] as const)(
    'evaluates %s for cumulative sums',
    async (name) => {
      const result = asVector(await instant(createDemoClient(), `${name}(${oneCounter}[5m])`));
      expect(result).toHaveLength(1);
      expect(result[0].metric).toEqual({
        'service.name': 'checkout',
        method: 'GET',
        status: '200',
      });
      expect(Number(result[0].value[1])).toBeCloseTo(
        name === 'increase' || name === 'delta' ? 800 : 40 / 15,
      );
    },
  );
  it('has exactly one counter reset and accounts for it in rate/increase/irate', async () => {
    const client = createDemoClient();
    const points = asMatrix(await instant(client, `${oneCounter}[1w]`))[0].values;
    const resets = points.filter(
      ([, value], index) => index > 0 && Number(value) < Number(points[index - 1][1]),
    );
    expect(resets).toHaveLength(1);
    const time = resets[0][0] + 30;
    const rate = Number(
      asVector(await instant(client, `rate(${oneCounter}[5m])`, time))[0].value[1],
    );
    const increase = Number(
      asVector(await instant(client, `increase(${oneCounter}[5m])`, time))[0].value[1],
    );
    const irate = Number(
      asVector(await instant(client, `irate(${oneCounter}[5m])`, time))[0].value[1],
    );
    expect(rate).toBeGreaterThan(0);
    expect(increase).toBeCloseTo(rate * 300);
    expect(irate).toBeCloseTo(40 / 15);
  });
  it.each(['avg_over_time', 'max_over_time', 'min_over_time', 'sum_over_time'] as const)(
    'evaluates %s against window samples',
    async (name) => {
      const client = createDemoClient();
      const selector = '{"process.memory.usage",host="node-01"}';
      const values = asMatrix(await instant(client, `${selector}[5m]`))[0].values.map(([, value]) =>
        Number(value),
      );
      const sum = values.reduce((total, value) => total + value, 0);
      const expected =
        name === 'min_over_time'
          ? Math.min(...values)
          : name === 'max_over_time'
            ? Math.max(...values)
            : name === 'avg_over_time'
              ? sum / values.length
              : sum;
      const result = asVector(await instant(client, `${name}(${selector}[5m])`));
      expect(Number(result[0].value[1])).toBeCloseTo(expected);
      expect(result[0].metric).not.toHaveProperty('__name__');
    },
  );
  it.each(['sum', 'avg', 'min', 'max', 'count'] as const)(
    'supports outer aggregation %s',
    async (name) => {
      const client = createDemoClient();
      const values = asVector(await instant(client, cpu)).map((item) => Number(item.value[1]));
      const sum = values.reduce((total, value) => total + value, 0);
      const expected =
        name === 'count'
          ? 4
          : name === 'min'
            ? Math.min(...values)
            : name === 'max'
              ? Math.max(...values)
              : name === 'avg'
                ? sum / values.length
                : sum;
      const result = asVector(await instant(client, `${name}(${cpu})`));
      expect(result).toHaveLength(1);
      expect(result[0].metric).toEqual({});
      expect(Number(result[0].value[1])).toBeCloseTo(expected);
    },
  );
  it('supports prefix/suffix by and without modifiers around an expression', async () => {
    const client = createDemoClient();
    const expression = `rate(${counter}[5m])`;
    const prefix = asVector(await instant(client, `sum by ("service.name") (${expression})`));
    const suffix = asVector(await instant(client, `sum(${expression}) by ("service.name")`));
    const without = asVector(await instant(client, `sum without (method,status) (${expression})`));
    expect(prefix).toEqual(suffix);
    expect(prefix).toEqual(without);
    expect(prefix.map((item) => item.metric)).toEqual([
      { 'service.name': 'checkout' },
      { 'service.name': 'inventory' },
    ]);
    expect(
      asVector(await instant(client, `count(${cpu}) by (host)`)).map((item) => item.value[1]),
    ).toEqual(['1', '1', '1', '1']);
    expect(asVector(await instant(client, `sum by () (${cpu})`))).toHaveLength(1);
  });
  it.each([
    ['42', '42'],
    ['-2.5', '-2.5'],
    ['.5', '0.5'],
    ['+4', '4'],
    ['1e3', '1000'],
  ])('supports scalar literal %s', async (query, value) => {
    expect(await instant(createDemoClient(), query)).toEqual({
      resultType: 'scalar',
      result: [end, value],
    });
  });
  it('returns inclusive scalar range samples and supports numeric step strings', async () => {
    const result = await createDemoClient().promqlQueryRange({
      stream,
      query: '2',
      start: end - 30,
      end,
      step: '15',
    });
    expect(result).toEqual({
      resultType: 'matrix',
      result: [
        {
          metric: {},
          values: [
            [end - 30, '2'],
            [end - 15, '2'],
            [end, '2'],
          ],
        },
      ],
    });
  });
  it('supports a range aggregation and returns empty results for unknown metrics', async () => {
    const client = createDemoClient();
    const request = {
      stream,
      query: `sum by ("service.name") (rate(${counter}[5m]))`,
      start: end - 60,
      end,
      step: '15s',
    };
    const result = await client.promqlQueryRange(request);
    expect(result.result).toHaveLength(2);
    expect(result.result.every((item) => item.values.length === 5)).toBe(true);
    expect(await client.promqlQueryRange({ ...request, query: 'missing_metric' })).toEqual({
      resultType: 'matrix',
      result: [],
    });
  });
});

describe('demo PromQL errors and limits', () => {
  it.each([
    `histogram_quantile(0.95, ${counter})`,
    `topk(2, ${cpu})`,
    `round(${cpu})`,
    `${cpu} + ${cpu}`,
    `${cpu} offset 1m`,
    `sum(sum(${cpu}))`,
    `rate(${counter}[5m:15s])`,
    `rate(avg_over_time(${counter}[5m]))`,
    `sum(${cpu}[5m])`,
    `rate(${cpu})`,
  ])('reports unsupported expression as 422: %s', async (query) => {
    const error = await instant(createDemoClient(), query).catch((error) => error);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 422,
      message: unsupportedMessage,
      detail: { status: 'error', errorType: 'execution', error: unsupportedMessage },
    });
    expect(promqlErrorType(error)).toBe('execution');
  });
  it.each([
    '',
    '  # comment only',
    '{',
    'cpu{host="a"',
    'sum(cpu',
    'cpu[5m',
    'cpu)',
    'cpu{host="a}',
    'cpu{host "a"}',
    'cpu{host=~"["}',
  ])('reports invalid syntax as 400: %s', async (query) => {
    await expect(instant(createDemoClient(), query)).rejects.toMatchObject({
      status: 400,
      detail: { status: 'error', errorType: 'bad_data' },
    });
  });
  it.each([
    { start: end - 31 * 86400 - 1, end, step: '1h' },
    { start: end - 11000, end, step: '1s' },
    { start: end, end: end - 1, step: '15s' },
    { start: end - 1, end, step: '0s' },
    { start: end - 1, end, step: '-1' },
    { start: end - 1, end, step: 'invalid' },
    { start: NaN, end, step: '15s' },
  ])('enforces range/step limits %#', async (request) => {
    await expect(
      createDemoClient().promqlQueryRange({ stream, query: '1', ...request }),
    ).rejects.toMatchObject({ status: 400, detail: { errorType: 'bad_data' } });
  });
  it('accepts exact 31-day and inclusive 11000-point boundaries', async () => {
    const client = createDemoClient();
    expect(
      (
        await client.promqlQueryRange({
          stream,
          query: '1',
          start: end - 31 * 86400,
          end,
          step: '1h',
        })
      ).result[0].values,
    ).toHaveLength(745);
    expect(
      (await client.promqlQueryRange({ stream, query: '1', start: end - 10999, end, step: '1s' }))
        .result[0].values,
    ).toHaveLength(11000);
  });
  it('rejects a range selector in query_range as an execution error', async () => {
    await expect(
      createDemoClient().promqlQueryRange({
        stream,
        query: `${cpu}[5m]`,
        start: end - 60,
        end,
        step: '15s',
      }),
    ).rejects.toMatchObject({ status: 422, detail: { errorType: 'execution' } });
  });
  it('rejects overlong queries measured in UTF-8 bytes and invalid instant times', async () => {
    const client = createDemoClient();
    await expect(instant(client, `{__name__="${'é'.repeat(2048)}"}`)).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('4096 bytes'),
    });
    await expect(instant(client, cpu, Infinity)).rejects.toMatchObject({ status: 400 });
  });
  it.each([-1, 10001, 1.5])('enforces metadata limit %s', async (limit) => {
    const client = createDemoClient();
    await expect(client.promqlLabels({ stream, limit })).rejects.toMatchObject({ status: 400 });
    await expect(client.promqlLabelValues('__name__', { stream, limit })).rejects.toMatchObject({
      status: 400,
    });
  });
  it('rejects too many metadata selectors and invalid selector/time ranges', async () => {
    const client = createDemoClient();
    await expect(client.promqlLabels({ stream, match: Array(17).fill(cpu) })).rejects.toMatchObject(
      { status: 400 },
    );
    await expect(client.promqlLabels({ stream, match: [`sum(${cpu})`] })).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      client.promqlLabelValues('host', { stream, start: end, end: end - 1 }),
    ).rejects.toMatchObject({ status: 400 });
  });
  it('rejects non-metrics datasets and honors cancellation for each new method', async () => {
    const client = createDemoClient();
    await expect(
      client.promqlQuery({ stream: 'application_logs', query: cpu }),
    ).rejects.toMatchObject({ status: 400, detail: { errorType: 'bad_data' } });
    const controller = new AbortController();
    controller.abort();
    await expect(client.datasetInfo(stream, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    await expect(
      client.promqlQuery({ stream, query: cpu }, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    await expect(
      client.promqlQueryRange(
        { stream, query: cpu, start: end - 60, end, step: '15s' },
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    await expect(client.promqlLabels({ stream }, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    await expect(
      client.promqlLabelValues('__name__', { stream }, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
