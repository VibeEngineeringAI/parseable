import { ApiError } from './client';
import type { DatasetInfo, ParseableClient } from './types';

export function isPromqlDataset(info: DatasetInfo): boolean {
  return (
    info.logSourceFormats.includes('otel-metrics') ||
    (info.logSourceFormats.length === 0 && info.telemetryType === 'metrics')
  );
}

export async function listMetricsDatasets(
  client: ParseableClient,
  signal?: AbortSignal,
): Promise<DatasetInfo[]> {
  signal?.throwIfAborted();
  const datasets = await client.listDatasets(signal);
  const result: DatasetInfo[] = [];
  let next = 0;
  let failed = false;
  async function worker() {
    while (!failed && next < datasets.length) {
      signal?.throwIfAborted();
      const dataset = datasets[next++];
      try {
        const info = await client.datasetInfo(dataset.name, signal);
        if (isPromqlDataset(info)) result.push(info);
      } catch (error) {
        if (error instanceof ApiError && (error.status === 403 || error.status === 404)) continue;
        failed = true;
        throw error;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, datasets.length) }, worker));
  return result.sort((a, b) => a.name.localeCompare(b.name));
}
