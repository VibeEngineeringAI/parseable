import { describe, expect, it, vi } from 'vitest';
import { parser } from '@prometheus-io/lezer-promql';
import {
  createMetadataClient,
  filterSupportedCompletions,
  quoteCompletionName,
  type PromqlMetadataSource,
} from './completion';

function source(): PromqlMetadataSource {
  return {
    metricNames: vi.fn(async () => ['system.cpu.load_average.1m', 'histogram_quantile']),
    labelNames: vi.fn(async () => ['host', 'service.name']),
    labelValues: vi.fn(async () => ['gateway']),
  };
}

describe('PromQL completion', () => {
  it('filters unsupported functions, aggregations, modifiers and snippets without filtering metadata', () => {
    const options = [
      { label: 'rate', type: 'function' },
      { label: 'histogram_quantile', type: 'function' },
      { label: 'sum', type: 'keyword', detail: 'aggregation' },
      { label: 'topk', type: 'keyword', detail: 'aggregation' },
      { label: 'sum(rate(vector[5m]))', type: 'function', detail: 'snippet' },
      { label: 'histogram_quantile(0.99, vector)', type: 'function', detail: 'snippet' },
      { label: 'on', type: 'keyword' },
      { label: 'group_left', type: 'keyword' },
      { label: 'offset' },
      { label: 'and' },
      { label: 'histogram_quantile', type: 'constant' },
      { label: 'offset', type: 'text' },
    ];
    expect(filterSupportedCompletions(options).map((option) => option.label)).toEqual([
      'rate',
      'sum',
      'sum(rate(vector[5m]))',
      'on',
      'histogram_quantile',
      'offset',
    ]);
  });

  it('inserts dotted metrics as quoted selectors and dotted labels as quoted names', () => {
    expect(
      quoteCompletionName({ label: 'system.cpu.load_average.1m', type: 'constant' }, false).apply,
    ).toBe('{"system.cpu.load_average.1m"}');
    expect(quoteCompletionName({ label: 'service.name', type: 'constant' }, true).apply).toBe(
      '"service.name"',
    );
    expect(
      quoteCompletionName({ label: 'service.name', type: 'constant' }, true, 'content').apply,
    ).toBe('service.name');
    const legacy = { label: 'cpu_total', type: 'constant' };
    expect(quoteCompletionName(legacy, false)).toBe(legacy);
    expect(quoteCompletionName(legacy, true, 'name').apply).toBe('"cpu_total"');
    const tree = parser.parse('{"system.cpu.load_average.1m","service.name"="gateway"}');
    let errors = 0;
    tree.iterate({
      enter: (node) => {
        if (node.type.isError) errors++;
      },
    });
    expect(errors).toBe(0);
  });

  it('shares in-flight metadata, expires it after 60 seconds, and swallows failures', async () => {
    vi.useFakeTimers();
    try {
      const metadata = source();
      const client = createMetadataClient(metadata);
      await Promise.all([client.metricNames(), client.metricNames('system')]);
      expect(metadata.metricNames).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(60_000);
      await client.metricNames();
      expect(metadata.metricNames).toHaveBeenCalledTimes(2);
      metadata.labelValues = vi.fn(async () => {
        throw new Error('Forbidden');
      });
      expect(await client.labelValues('host')).toEqual([]);
      expect(await client.metricMetadata()).toEqual({});
      expect(await client.series('metric')).toEqual([]);
      expect(await client.flags()).toEqual({});
      client.destroy?.();
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts pending metadata on disposal', async () => {
    let signal: AbortSignal | undefined;
    const metadata = source();
    metadata.metricNames = vi.fn((requestSignal) => {
      signal = requestSignal;
      return new Promise<string[]>((_, reject) =>
        requestSignal?.addEventListener('abort', () => reject(new Error('Aborted'))),
      );
    });
    const client = createMetadataClient(metadata);
    const pending = client.metricNames();
    await Promise.resolve();
    client.destroy?.();
    expect(signal?.aborted).toBe(true);
    expect(await pending).toEqual([]);
  });
});
