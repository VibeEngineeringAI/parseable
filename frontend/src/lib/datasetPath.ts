import { ApiError } from './apiError';
import type { Dataset, DatasetInfo, ParseableClient } from './types';

export type DatasetInventoryEntry = {
  name: string;
  type?: Dataset['type'];
  typeError?: string;
};

export function confirmedDatasetType(info: DatasetInfo): Dataset['type'] | undefined {
  if (info.logSourceFormats.includes('otel-traces')) return 'traces';
  if (info.logSourceFormats.includes('otel-metrics')) return 'metrics';
  if (info.logSourceFormats.includes('json') || info.logSourceFormats.includes('otel-logs'))
    return 'logs';
  if (info.telemetryType === 'logs') return 'logs';
  return undefined;
}

/** The live list only supplies names. Resolve types from metadata before routing. */
export async function listDatasetInventory(
  client: Pick<ParseableClient, 'listDatasets' | 'datasetInfo'>,
  signal?: AbortSignal,
): Promise<DatasetInventoryEntry[]> {
  signal?.throwIfAborted();
  const listed = await client.listDatasets(signal);
  const inventory: DatasetInventoryEntry[] = listed.map(({ name }) => ({ name }));
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(6, listed.length) }, async () => {
      while (next < listed.length) {
        signal?.throwIfAborted();
        const index = next++;
        try {
          const info = await client.datasetInfo(listed[index].name, signal);
          const type = confirmedDatasetType(info);
          inventory[index] = {
            name: listed[index].name,
            type,
            typeError: type ? undefined : 'Dataset metadata does not report its telemetry type.',
          };
        } catch (error) {
          if (
            signal?.aborted ||
            (error instanceof Error && error.name === 'AbortError') ||
            (error instanceof ApiError && error.status === 401)
          )
            throw error;
          inventory[index].typeError = error instanceof Error ? error.message : String(error);
        }
      }
    }),
  );
  signal?.throwIfAborted();
  return inventory;
}

/** Send datasets to the explorer for their confirmed telemetry type. */
export function datasetPath(dataset: Pick<Dataset, 'name'> & { type?: string }) {
  const section =
    dataset.type === 'traces' ? 'traces' : dataset.type === 'metrics' ? 'metrics' : 'logs';
  return `/${section}/explore/${encodeURIComponent(dataset.name)}`;
}
