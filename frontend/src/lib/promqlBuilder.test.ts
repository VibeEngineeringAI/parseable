import { describe, expect, it } from 'vitest';
import { compilePromqlBuilder, readPromqlBuilder, type PromqlBuilder } from './promqlBuilder';

describe('bounded PromQL builder', () => {
  const input: PromqlBuilder = {
    version: 1,
    metric: 'http.server.requests',
    matchers: [
      { label: 'service.name', operator: '=~', value: 'api\\..*"\n' },
      { label: 'host', operator: '!=', value: 'x' },
    ],
    operations: [
      { kind: 'range', name: 'rate', duration: '5m' },
      { kind: 'function', name: 'abs' },
      { kind: 'aggregate', name: 'sum', grouping: 'by', labels: ['service.name', 'host'] },
    ],
  };
  it('quotes OTLP names, regex strings and grouping, preserving operation order', () => {
    const query = compilePromqlBuilder(input);
    expect(query).toBe(
      'sum by ("service.name", host) (abs(rate({"http.server.requests", "service.name"=~"api\\\\..*\\"\\n", host!="x"}[5m])))',
    );
    expect(readPromqlBuilder(query)).toEqual(input);
  });
  it.each([
    'cpu',
    '{"cpu.load"}',
    'cpu{host="a", region!~"test.*"}',
    '{__name__="cpu.load", host="a"}',
    'rate(counter[5m])',
    'increase(counter[1h30m])',
    'delta(cpu[5m])',
    'min without (host) (avg_over_time(cpu[5m]))',
    'sum(cpu) by (host)',
    'sum by () (cpu)',
    'sum{host="a"}',
  ])('reads the whole supported expression %s', (query) => {
    const parsed = readPromqlBuilder(query);
    expect(parsed).toBeDefined();
    expect(readPromqlBuilder(compilePromqlBuilder(parsed!))).toEqual(parsed);
  });
  it.each([
    'cpu + memory',
    'histogram_quantile(0.95, histogram)',
    'rate(counter[5m]) offset 1h',
    'cpu @ 100',
    'cpu[5m]',
    'abs(cpu[5m])',
    'rate(sum(cpu)[5m])',
    'sum(rate(cpu[5m])) + 1',
    'sum by (host) (cpu) without (region)',
    'cpu{host:a="x"}',
    'sum by (host:a) (cpu)',
    'rate by (host) (cpu[5m])',
    'cpu # comment',
    '"cpu"',
    '{__name__=~"cpu.*"}',
    '{__name__="cpu", __name__="memory"}',
    'cpu{host="a",}',
    'cpu{host="a"} trailing',
    'rate(cpu[0s])',
    'rate(cpu[32d])',
    'rate(cpu[1m2h])',
    'scalar(cpu)',
    '1',
  ])('leaves unsupported or invalid raw source intact by declining %s', (query) => {
    expect(readPromqlBuilder(query)).toBeUndefined();
  });
  it('supports JSON escapes without accepting malformed strings', () => {
    const query = compilePromqlBuilder({
      ...input,
      metric: 'm\u0000',
      operations: [],
      matchers: [{ label: 'a.b', operator: '=', value: '\b\f\t\r\n"\\' }],
    });
    expect(readPromqlBuilder(query)?.metric).toBe('m\u0000');
    expect(readPromqlBuilder('cpu{host="\\q"}')).toBeUndefined();
  });
  it('bounds model complexity and duration and prevents range operations after vector operations', () => {
    expect(() =>
      compilePromqlBuilder({
        ...input,
        operations: Array.from({ length: 9 }, () => ({ kind: 'function', name: 'abs' })),
      }),
    ).toThrow('eight');
    expect(() =>
      compilePromqlBuilder({
        ...input,
        operations: [
          { kind: 'aggregate', name: 'sum', grouping: 'none', labels: [] },
          { kind: 'range', name: 'rate', duration: '5m' },
        ],
      }),
    ).toThrow('first');
    expect(() =>
      compilePromqlBuilder({
        ...input,
        matchers: [{ label: '__name__', operator: '=', value: 'other' }],
      }),
    ).toThrow('__name__');
    expect(() =>
      compilePromqlBuilder({
        ...input,
        operations: [{ kind: 'aggregate', name: 'sum', grouping: 'by', labels: ['host', 'host'] }],
      }),
    ).toThrow('distinct');
  });
});
