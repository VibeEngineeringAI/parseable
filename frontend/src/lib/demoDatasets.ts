import { ApiError } from './client';
import { datasetRetention as validRetention } from './datasetsContract';
import { gib, validateCustomPartition, validateDatasetName } from '../features/datasets/helpers';
import type {
  Dataset,
  DatasetCreateOptions,
  DatasetHotTier,
  DatasetInfo,
  DatasetRetention,
  DatasetStats,
  LogRecord,
  ParseableClient,
} from './types';

type Methods =
  | 'listDatasets'
  | 'datasetInfo'
  | 'schema'
  | 'createDataset'
  | 'deleteDataset'
  | 'datasetStats'
  | 'datasetRetention'
  | 'setDatasetRetention'
  | 'datasetHotTier'
  | 'setDatasetHotTier'
  | 'clearDatasetHotTier';

export function createDemoDatasets(
  fixtures: Dataset[],
  records: LogRecord[],
  now: number,
): Pick<ParseableClient, Methods> {
  type Entry = {
    dataset: Dataset;
    info: DatasetInfo;
    schema: string[];
    stats: DatasetStats;
    retention: DatasetRetention;
    hotTier: DatasetHotTier | null;
  };
  const entries = new Map<string, Entry>();
  const clone = <T>(value: T): T => structuredClone(value);
  function entry(name: string, options: DatasetCreateOptions, seeded = false): Entry {
    const size = seeded ? 102400 : 0;
    return {
      dataset: { name, type: options.telemetryType },
      info: {
        name,
        telemetryType: options.telemetryType,
        createdAt: new Date(now).toISOString(),
        latestEventAt: seeded
          ? options.telemetryType === 'metrics'
            ? new Date(Math.floor(now / 15000) * 15000).toISOString()
            : String(records[0].p_timestamp)
          : undefined,
        logSourceFormats: [options.telemetryType === 'metrics' && seeded ? 'otel-metrics' : 'json'],
        customPartition: options.customPartition || undefined,
        streamType: 'user',
        staticSchemaFlag: false,
        hotTierEnabled: false,
      },
      schema: seeded ? Object.keys(records[0]) : [],
      stats: {
        stream: name,
        time: new Date(now).toISOString(),
        ingestion: {
          count: seeded ? records.length : 0,
          size,
          format: 'json',
          lifetime_count: seeded ? records.length : 0,
          lifetime_size: size,
          deleted_count: 0,
          deleted_size: 0,
        },
        storage: { size: size / 2, format: 'parquet', lifetime_size: size / 2, deleted_size: 0 },
      },
      retention: [],
      hotTier: null,
    };
  }
  for (const dataset of fixtures)
    entries.set(dataset.name, entry(dataset.name, { telemetryType: dataset.type }, true));
  function find(name: string): Entry {
    const found = entries.get(name);
    if (!found) throw new ApiError(`Stream not found: ${name}`, 404);
    return found;
  }
  async function ready(signal?: AbortSignal) {
    signal?.throwIfAborted();
    await Promise.resolve();
    signal?.throwIfAborted();
  }
  return {
    async listDatasets(signal) {
      await ready(signal);
      return Array.from(entries.values(), (value) => clone(value.dataset));
    },
    async datasetInfo(name, signal) {
      await ready(signal);
      const value = find(name);
      return { ...clone(value.info), hotTierEnabled: value.hotTier !== null };
    },
    async schema(name, signal) {
      await ready(signal);
      return [...find(name).schema];
    },
    async createDataset(name, options) {
      await ready();
      const error =
        validateDatasetName(name) || validateCustomPartition(options.customPartition ?? '');
      if (error) throw new ApiError(error, 400);
      if (entries.has(name))
        throw new ApiError(
          `Logstream ${name} already exists, please create a new log stream with unique name`,
          400,
        );
      entries.set(name, entry(name, options));
    },
    async deleteDataset(name) {
      await ready();
      find(name);
      entries.delete(name);
    },
    async datasetStats(name, signal) {
      await ready(signal);
      return clone(find(name).stats);
    },
    async datasetRetention(name, signal) {
      await ready(signal);
      return clone(find(name).retention);
    },
    async setDatasetRetention(name, retention) {
      await ready();
      const value = find(name);
      if (!validRetention(retention)) throw new ApiError('Invalid retention configuration', 400);
      value.retention = clone(retention);
    },
    async datasetHotTier(name, signal) {
      await ready(signal);
      return clone(find(name).hotTier);
    },
    async setDatasetHotTier(name, size) {
      await ready();
      const value = find(name);
      const bytes = Number(size.replace(/ Bytes$/, ''));
      if (!/^\d+(?: Bytes)?$/.test(size) || !Number.isSafeInteger(bytes) || bytes < 10 * gib)
        throw new ApiError('Stream should have atleast 10.00 GiB size', 400);
      value.hotTier = {
        version: 'v2',
        size: `${bytes} Bytes`,
        used_size: '0 Bytes',
        available_size: `${bytes} Bytes`,
      };
    },
    async clearDatasetHotTier(name) {
      await ready();
      const value = find(name);
      if (!value.hotTier) throw new ApiError(`Hot tier not found for stream ${name}`, 500);
      value.hotTier = null;
    },
  };
}
