import { describe, expect, it, vi } from 'vitest';
import { ApiError, createClient } from './client';
import {
  discoverMetricsDatasets,
  forgetMetricsDatasets,
  isPromqlDataset,
  listMetricsDatasets,
} from './metrics';

const metrics = (name: string) => ({ name, logSourceFormats: ['otel-metrics'] });

describe('metrics dataset discovery', () => {
  it('uses formats first and falls back to telemetry type when formats are absent', () => {
    const info = { name: 'cpu', telemetryType: 'metrics', logSourceFormats: [] };
    expect(isPromqlDataset(info)).toBe(true);
    expect(
      isPromqlDataset({ ...info, telemetryType: 'logs', logSourceFormats: ['otel-metrics'] }),
    ).toBe(true);
    expect(isPromqlDataset({ ...info, logSourceFormats: ['json'] })).toBe(false);
    expect(isPromqlDataset({ ...info, telemetryType: 'logs' })).toBe(false);
  });
  it('limits info lookups to six, skips 403/404 and returns sorted metrics', async () => {
    const client = createClient({ mode: 'live' });
    const datasets = Array.from({ length: 15 }, (_, index) => ({
      name: `dataset-${String(14 - index).padStart(2, '0')}`,
      type: 'logs' as const,
    }));
    vi.spyOn(client, 'listDatasets').mockResolvedValue(datasets);
    let active = 0,
      maximum = 0;
    const info = vi.spyOn(client, 'datasetInfo').mockImplementation(async (name) => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      if (name === 'dataset-00' || name === 'dataset-01')
        throw new ApiError('Unavailable', name === 'dataset-00' ? 403 : 404);
      return { name, logSourceFormats: [name === 'dataset-02' ? 'json' : 'otel-metrics'] };
    });
    const signal = new AbortController().signal;
    const result = await listMetricsDatasets(client, signal);
    expect(maximum).toBe(6);
    expect(result.datasets.map((item) => item.name)).toEqual(
      datasets
        .map((item) => item.name)
        .filter((name) => !['dataset-00', 'dataset-01', 'dataset-02'].includes(name))
        .sort(),
    );
    expect(result.unchecked).toEqual([]);
    expect(info).toHaveBeenCalledTimes(15);
    expect(info).toHaveBeenCalledWith('dataset-14', signal);
  });
  it('keeps checking after other info failures and reports them as unchecked', async () => {
    const client = createClient({ mode: 'live' });
    vi.spyOn(client, 'listDatasets').mockResolvedValue(
      ['web', 'cpu', 'broken', 'flaky', 'memory'].map((name) => ({ name, type: 'logs' as const })),
    );
    const info = vi.spyOn(client, 'datasetInfo').mockImplementation(async (name) => {
      if (name === 'broken') throw new ApiError('Server failed', 500);
      if (name === 'flaky') throw new TypeError('Failed to fetch');
      return name === 'web' ? { name, logSourceFormats: ['json'] } : metrics(name);
    });
    expect(await listMetricsDatasets(client)).toEqual({
      datasets: [metrics('cpu'), metrics('memory')],
      unchecked: ['broken', 'flaky'],
    });
    expect(info).toHaveBeenCalledTimes(5);
  });
  it('fails when the dataset list fails and honors cancellation', async () => {
    const client = createClient({ mode: 'live' });
    const error = new ApiError('Server failed', 500);
    vi.spyOn(client, 'listDatasets').mockRejectedValueOnce(error);
    await expect(listMetricsDatasets(client)).rejects.toBe(error);
    const controller = new AbortController();
    controller.abort();
    await expect(listMetricsDatasets(client, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    vi.spyOn(client, 'listDatasets').mockResolvedValue([{ name: 'cpu', type: 'logs' }]);
    vi.spyOn(client, 'datasetInfo').mockRejectedValue(
      new DOMException('The operation was aborted.', 'AbortError'),
    );
    await expect(listMetricsDatasets(client)).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('returns an empty list without requesting info', async () => {
    const client = createClient({ mode: 'live' });
    vi.spyOn(client, 'listDatasets').mockResolvedValue([]);
    const info = vi.spyOn(client, 'datasetInfo');
    expect(await listMetricsDatasets(client)).toEqual({ datasets: [], unchecked: [] });
    expect(info).not.toHaveBeenCalled();
  });
  it('reuses a discovery per client until it is forgotten', async () => {
    const client = createClient({ mode: 'live' });
    const list = vi
      .spyOn(client, 'listDatasets')
      .mockResolvedValue([{ name: 'cpu', type: 'logs' as const }]);
    const info = vi
      .spyOn(client, 'datasetInfo')
      .mockRejectedValueOnce(new ApiError('Server failed', 503))
      .mockResolvedValue(metrics('cpu'));
    const partial = await discoverMetricsDatasets(client);
    expect(partial).toEqual({ datasets: [], unchecked: ['cpu'] });
    expect(await discoverMetricsDatasets(client)).toBe(partial);
    expect(list).toHaveBeenCalledTimes(1);
    forgetMetricsDatasets(client);
    expect(await discoverMetricsDatasets(client)).toEqual({
      datasets: [metrics('cpu')],
      unchecked: [],
    });
    expect(info).toHaveBeenCalledTimes(2);

    const other = createClient({ mode: 'live' });
    vi.spyOn(other, 'listDatasets').mockResolvedValue([]);
    expect(await discoverMetricsDatasets(other)).toEqual({ datasets: [], unchecked: [] });
  });
  it('does not cache a failed discovery', async () => {
    const client = createClient({ mode: 'live' });
    const list = vi
      .spyOn(client, 'listDatasets')
      .mockRejectedValueOnce(new ApiError('Server failed', 500))
      .mockResolvedValue([]);
    await expect(discoverMetricsDatasets(client)).rejects.toMatchObject({ status: 500 });
    expect(await discoverMetricsDatasets(client)).toEqual({ datasets: [], unchecked: [] });
    expect(list).toHaveBeenCalledTimes(2);
  });
});
