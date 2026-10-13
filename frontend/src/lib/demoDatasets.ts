import { ApiError } from './client';
import {
  datasetRetention as validRetention,
  datasetLabelsError,
  parseStaticSchema,
} from './datasetsContract';
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
  | 'datasetSchema'
  | 'updateDatasetCustomPartition'
  | 'setDatasetTimePartitionLimit'
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
  fixtureRecords: Record<string, LogRecord[]> = {},
): Pick<ParseableClient, Methods> {
  type Entry = {
    dataset: Dataset;
    info: DatasetInfo;
    schema: import('./types').DatasetSchema;
    stats: DatasetStats;
    retention: DatasetRetention;
    hotTier: DatasetHotTier | null;
  };
  const entries = new Map<string, Entry>();
  const clone = <T>(value: T): T => structuredClone(value);
  function entry(name: string, options: DatasetCreateOptions, seeded = false): Entry {
    const source = fixtureRecords[name] ?? records;
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
            : String(source[0].p_timestamp)
          : undefined,
        logSourceFormats: [
          options.logSource ??
            (seeded && options.telemetryType !== 'logs' ? `otel-${options.telemetryType}` : 'json'),
        ],
        customPartition: options.customPartition || undefined,
        streamType: 'user',
        staticSchemaFlag: !!options.staticSchema,
        datasetTags: options.datasetTags ?? [],
        datasetLabels: options.datasetLabels ?? [],
        inferTimestamp: options.inferTimestamp ?? true,
        hotTierEnabled: false,
      },
      schema: {
        fields: options.staticSchema
          ? [
              {
                name: 'p_timestamp',
                dataType: { Timestamp: ['Millisecond', null] },
                nullable: true,
              },
              ...options.staticSchema.fields.map((field) => ({
                name: field.name,
                dataType: (
                  {
                    int: 'Int64',
                    double: 'Float64',
                    float: 'Float64',
                    boolean: 'Boolean',
                    string: 'Utf8',
                    datetime: { Timestamp: ['Millisecond', null] },
                    date: 'Date32',
                  } as Record<string, unknown>
                )[field.data_type],
                nullable: true,
              })),
            ]
          : seeded
            ? [...new Set(source.flatMap((row) => Object.keys(row)))].map((name) => ({
                name,
                dataType:
                  typeof source.find((row) => row[name] != null)?.[name] === 'number'
                    ? 'Float64'
                    : 'Utf8',
                nullable: true,
              }))
            : [],
      },
      stats: {
        stream: name,
        time: new Date(now).toISOString(),
        ingestion: {
          count: seeded ? source.length : 0,
          size,
          format: 'json',
          lifetime_count: seeded ? source.length : 0,
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
      return find(name).schema.fields.map((field) => field.name);
    },
    async datasetSchema(name, signal) {
      await ready(signal);
      return clone(find(name).schema);
    },
    async updateDatasetCustomPartition(name, field) {
      await ready();
      const value = find(name);
      const error = validateCustomPartition(field ?? '');
      if (error) throw new ApiError(error, 400);
      if (
        field &&
        value.info.staticSchemaFlag &&
        !value.schema.fields.some((item) => item.name === field)
      )
        throw new ApiError(`custom partition field ${field} does not exist in the schema`, 400);
      if (field && field === value.info.timePartition)
        throw new ApiError('Time partition cannot be set as custom partition', 400);
      value.info.customPartition = field || undefined;
    },
    async setDatasetTimePartitionLimit(name, days) {
      await ready();
      const value = find(name);
      if (!Number.isInteger(days) || days < 1 || days > 4294967295)
        throw new ApiError('Invalid time partition limit', 400);
      value.info.timePartitionLimit = String(days);
    },
    async createDataset(name, options) {
      await ready();
      const error =
        datasetLabelsError(options.datasetLabels ?? []) ||
        validateDatasetName(name) ||
        validateCustomPartition(options.customPartition ?? '');
      if (error) throw new ApiError(error, 400);
      if (entries.has(name))
        throw new ApiError(
          `Logstream ${name} already exists, please create a new log stream with unique name`,
          400,
        );
      if (options.staticSchema) parseStaticSchema(options.staticSchema, options.customPartition);
      if (
        options.inferTimestamp !== undefined &&
        (options.telemetryType !== 'metrics' || options.logSource !== 'otel-metrics')
      )
        throw new ApiError('Timestamp inference is only supported for otel-metrics datasets', 400);
      entries.set(name, entry(name, clone(options)));
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
