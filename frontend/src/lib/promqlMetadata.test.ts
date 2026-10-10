import { expect, it, vi } from 'vitest';
import { createPromqlMetadata, metadataRequest, boundsError } from './promqlMetadata';
import type { ParseableClient } from './types';
it('shares bounds validation and the exact match construction with Metrics', async () => {
  const bounds = { start: 1, end: 2 },
    signal = new AbortController().signal;
  const client = {
    promqlLabelValues: vi.fn().mockResolvedValue({ data: ['a'] }),
    promqlLabels: vi.fn().mockResolvedValue({ data: ['host'] }),
  } as unknown as ParseableClient;
  const metadata = createPromqlMetadata(client, 'metrics', bounds);
  expect(metadataRequest('metrics', bounds, ['cpu.load', 'up'])).toEqual({
    stream: 'metrics',
    ...bounds,
    limit: 1000,
    match: ['{__name__="cpu.load"}', '{__name__="up"}'],
  });
  expect(await metadata.metricNames(signal)).toEqual(['a']);
  expect(client.promqlLabelValues).toHaveBeenCalledWith(
    '__name__',
    { stream: 'metrics', ...bounds, limit: 1000 },
    signal,
  );
  expect(await metadata.labelNames('cpu.load', signal)).toEqual(['host']);
  expect(client.promqlLabels).toHaveBeenCalledWith(
    { stream: 'metrics', ...bounds, limit: 1000, match: ['{__name__="cpu.load"}'] },
    signal,
  );
  expect(await metadata.labelValues('host', 'up', signal)).toEqual(['a']);
  expect(client.promqlLabelValues).toHaveBeenLastCalledWith(
    'host',
    { stream: 'metrics', ...bounds, limit: 1000, match: ['{__name__="up"}'] },
    signal,
  );
});
it.each([
  { start: NaN, end: 1 },
  { start: 2, end: 1 },
  { start: 0, end: Infinity },
  { start: 0, end: 32 * 86400 },
])('suppresses metadata calls for invalid bounds %j', async (bounds) => {
  const client = {
    promqlLabelValues: vi.fn(),
    promqlLabels: vi.fn(),
  } as unknown as ParseableClient;
  expect(boundsError(bounds)).toBeDefined();
  expect(metadataRequest('metrics', bounds)).toBeUndefined();
  const metadata = createPromqlMetadata(client, 'metrics', bounds);
  expect(await metadata.metricNames()).toEqual([]);
  expect(await metadata.labelNames('up')).toEqual([]);
  expect(await metadata.labelValues('host', 'up')).toEqual([]);
  expect(client.promqlLabelValues).not.toHaveBeenCalled();
  expect(client.promqlLabels).not.toHaveBeenCalled();
});
it('supports unbounded metadata and suppresses requests for an unresolved dataset', () => {
  expect(metadataRequest('metrics')).toEqual({ stream: 'metrics', limit: 1000 });
  expect(metadataRequest('', { start: 1, end: 2 })).toBeUndefined();
});
