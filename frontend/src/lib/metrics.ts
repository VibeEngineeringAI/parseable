import { ApiError } from './client';
import type { DatasetInfo, ParseableClient } from './types';

export type MetricsDatasets = {
  datasets: DatasetInfo[];
  // Info failed for these, so they may hold metrics. The page warns instead of failing.
  unchecked: string[];
};

export function isPromqlDataset(info: DatasetInfo): boolean {
  return (
    info.logSourceFormats.includes('otel-metrics') ||
    (info.logSourceFormats.length === 0 && info.telemetryType === 'metrics')
  );
}

export async function listMetricsDatasets(
  client: ParseableClient,
  signal?: AbortSignal,
): Promise<MetricsDatasets> {
  signal?.throwIfAborted();
  const datasets = await client.listDatasets(signal);
  const result: DatasetInfo[] = [];
  const unchecked: string[] = [];
  let next = 0;
  async function worker() {
    while (next < datasets.length) {
      signal?.throwIfAborted();
      const dataset = datasets[next++];
      try {
        const info = await client.datasetInfo(dataset.name, signal);
        if (isPromqlDataset(info)) result.push(info);
      } catch (error) {
        if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
        // One broken dataset must not hide the others. 403/404 mean it is not ours to show.
        if (!(error instanceof ApiError && (error.status === 403 || error.status === 404)))
          unchecked.push(dataset.name);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, datasets.length) }, worker));
  return {
    datasets: result.sort((a, b) => a.name.localeCompare(b.name)),
    unchecked: unchecked.sort((a, b) => a.localeCompare(b)),
  };
}

// Discovery costs one info request per dataset, so it runs once per client. Signing in or
// switching connection creates a new client, which starts empty.
const discovered = new WeakMap<ParseableClient, MetricsDatasets>();

export async function discoverMetricsDatasets(
  client: ParseableClient,
  signal?: AbortSignal,
): Promise<MetricsDatasets> {
  const cached = discovered.get(client);
  if (cached) return cached;
  const result = await listMetricsDatasets(client, signal);
  discovered.set(client, result);
  return result;
}

export function forgetMetricsDatasets(client: ParseableClient) {
  discovered.delete(client);
}
