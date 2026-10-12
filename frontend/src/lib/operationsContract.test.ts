import { describe, expect, it, vi, afterEach } from 'vitest';
import { clusterNodes, clusterMetrics } from './operationsContract';
import { demoClusterNodes, demoClusterMetrics } from './clusterDemo';
import { createClient } from './client';
afterEach(() => vi.unstubAllGlobals());
describe('cluster wire contracts', () => {
  it('reads backend snake-case node fields and nullable diagnostics', () =>
    expect(clusterNodes(demoClusterNodes)).toEqual(demoClusterNodes));
  it('rejects missing reachability and malformed metrics', () => {
    expect(() => clusterNodes([{ domain_name: 'node' }])).toThrow();
    expect(() =>
      clusterMetrics([
        { address: 'node', node_type: 'ingestor', process_cpu_usage_percent_avg: NaN },
      ]),
    ).toThrow();
  });
  it('preserves null metrics while rejecting invalid numeric types', () => {
    const metric = { ...demoClusterMetrics[0], process_cpu_usage_percent_avg: null };
    expect(clusterMetrics([metric])).toEqual([metric]);
    for (const invalid of ['0', {}, undefined, -1, Infinity])
      expect(() =>
        clusterMetrics([{ ...metric, process_cpu_usage_percent_avg: invalid }]),
      ).toThrow();
  });
  it('sends credentials and cancellation to the verified endpoint', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(demoClusterNodes)));
    vi.stubGlobal('fetch', fetch);
    const signal = new AbortController().signal;
    await createClient({ mode: 'live' }).clusterNodes(signal);
    expect(fetch).toHaveBeenCalledWith('/api/v1/cluster/info', {
      signal,
      credentials: 'include',
    });
  });
  it('recovers expired sessions through the shared client', async () => {
    const onUnauthorized = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Expired', { status: 401 })));
    await expect(
      createClient({ mode: 'live', onUnauthorized }).clusterNodes(),
    ).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });
  it('preserves authorization errors and rejects malformed successful JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response('Permission denied', { status: 403 }))
        .mockResolvedValueOnce(new Response('<html>')),
    );
    await expect(createClient({ mode: 'live' }).clusterNodes()).rejects.toMatchObject({
      status: 403,
    });
    await expect(createClient({ mode: 'live' }).clusterNodes()).rejects.toMatchObject({
      status: 502,
    });
  });
});
