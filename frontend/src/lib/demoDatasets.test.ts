import { describe, expect, it, vi } from 'vitest';
import { createDemoClient } from './demo';
import { gib } from '../features/datasets/helpers';
import type { DatasetRetention, ParseableClient } from './types';

describe('per-client dataset demo', () => {
  it.each(['logs', 'metrics', 'traces'] as const)(
    'creates, inspects, queries and deletes a %s dataset',
    async (telemetryType) => {
      const client = createDemoClient();
      await client.createDataset('new_dataset', {
        telemetryType,
        customPartition: 'service',
      });
      expect(await client.listDatasets()).toContainEqual({
        name: 'new_dataset',
        type: telemetryType,
      });
      expect(await client.datasetInfo('new_dataset')).toMatchObject({
        telemetryType,
        customPartition: 'service',
        staticSchemaFlag: false,
      });
      expect(await client.schema('new_dataset')).toEqual([]);
      expect(await client.datasetStats('new_dataset')).toMatchObject({
        ingestion: { count: 0, size: 0 },
        storage: { size: 0 },
      });
      expect(
        await client.query({ sql: 'SELECT * FROM new_dataset', startTime: '1h', endTime: 'now' }),
      ).toEqual([]);
      await client.deleteDataset('new_dataset');
      expect((await client.listDatasets()).some((item) => item.name === 'new_dataset')).toBe(false);
      await expect(client.datasetInfo('new_dataset')).rejects.toMatchObject({ status: 404 });
      await expect(
        client.query({ sql: 'SELECT * FROM new_dataset', startTime: '1h', endTime: 'now' }),
      ).rejects.toThrow('Unknown demo dataset');
    },
  );
  it('sets and clears retention, validates tasks, and copies both inputs and outputs', async () => {
    const client = createDemoClient();
    const retention: DatasetRetention = [
      { description: 'Thirty days', action: 'delete', duration: '30d' },
    ];
    await client.setDatasetRetention('application_logs', retention);
    retention[0].duration = '1d';
    const returned = await client.datasetRetention('application_logs');
    expect(returned[0].duration).toBe('30d');
    returned.length = 0;
    expect(await client.datasetRetention('application_logs')).toHaveLength(1);
    await expect(
      client.setDatasetRetention('application_logs', [{ ...retention[0], duration: '0d' }]),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      client.setDatasetRetention('application_logs', [{ ...retention[0], duration: '36501d' }]),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      client.setDatasetRetention('application_logs', [retention[0], retention[0]]),
    ).rejects.toMatchObject({ status: 400 });
    await client.setDatasetRetention('application_logs', []);
    expect(await client.datasetRetention('application_logs')).toEqual([]);
  });
  it('configures, resizes and disables hot tier with a ten-GiB minimum', async () => {
    const client = createDemoClient();
    expect(await client.datasetHotTier('application_logs')).toBeNull();
    await expect(
      client.setDatasetHotTier('application_logs', `${gib} Bytes`),
    ).rejects.toMatchObject({ status: 400 });
    await client.setDatasetHotTier('application_logs', `${10 * gib} Bytes`);
    expect((await client.datasetInfo('application_logs')).hotTierEnabled).toBe(true);
    const config = await client.datasetHotTier('application_logs');
    expect(config).toEqual({
      version: 'v2',
      size: `${10 * gib} Bytes`,
      used_size: '0 Bytes',
      available_size: `${10 * gib} Bytes`,
    });
    config!.size = '0 Bytes';
    await client.setDatasetHotTier('application_logs', `${20 * gib} Bytes`);
    expect((await client.datasetHotTier('application_logs'))?.size).toBe(`${20 * gib} Bytes`);
    await client.clearDatasetHotTier('application_logs');
    expect(await client.datasetHotTier('application_logs')).toBeNull();
    expect((await client.datasetInfo('application_logs')).hotTierEnabled).toBe(false);
  });
  it('rejects invalid names, duplicate datasets and unsupported partitions', async () => {
    const client = createDemoClient();
    await expect(client.createDataset('bad.name', { telemetryType: 'logs' })).rejects.toMatchObject(
      { status: 400 },
    );
    await expect(client.createDataset('select', { telemetryType: 'logs' })).rejects.toThrow(
      'SQL keyword',
    );
    await expect(
      client.createDataset('application_logs', { telemetryType: 'logs' }),
    ).rejects.toThrow('already exists');
    await expect(
      client.createDataset('new_dataset', { telemetryType: 'logs', customPartition: 'one,two' }),
    ).rejects.toThrow('Maximum 1');
    await expect(
      client.createDataset('new_dataset', {
        telemetryType: 'logs',
        customPartition: 'nested.field',
      }),
    ).rejects.toThrow("must not contain '.'");
    expect(await client.listDatasets()).toHaveLength(5);
  });
  it('keeps dataset state isolated and returns copies of metadata, inventory, schema and stats', async () => {
    const first = createDemoClient(),
      second = createDemoClient();
    await first.deleteDataset('api_logs');
    const list = await first.listDatasets();
    list[0].name = 'mutated';
    const info = await first.datasetInfo('application_logs');
    info.logSourceFormats.length = 0;
    const schema = await first.schema('application_logs');
    schema.length = 0;
    const stats = await first.datasetStats('application_logs');
    stats.ingestion.count = 0;
    expect((await first.listDatasets())[0].name).toBe('application_logs');
    expect((await first.datasetInfo('application_logs')).logSourceFormats).toEqual(['json']);
    expect(await first.schema('application_logs')).toContain('message');
    expect((await first.datasetStats('application_logs')).ingestion.count).toBe(100);
    expect(await second.listDatasets()).toHaveLength(5);
  });
  const reads = [
    (c: ParseableClient, s?: AbortSignal) => c.datasetInfo('missing', s),
    (c: ParseableClient, s?: AbortSignal) => c.schema('missing', s),
    (c: ParseableClient, s?: AbortSignal) => c.datasetStats('missing', s),
    (c: ParseableClient, s?: AbortSignal) => c.datasetRetention('missing', s),
    (c: ParseableClient, s?: AbortSignal) => c.datasetHotTier('missing', s),
  ];
  it.each(reads)('checks missing datasets and honors read cancellation %#', async (read) => {
    const client = createDemoClient();
    await expect(read(client)).rejects.toMatchObject({ status: 404 });
    const abort = new AbortController();
    abort.abort();
    await expect(read(client, abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('requires an existing dataset for every mutation', async () => {
    const client = createDemoClient();
    for (const operation of [
      client.deleteDataset('missing'),
      client.setDatasetRetention('missing', []),
      client.setDatasetHotTier('missing', `${10 * gib} Bytes`),
      client.clearDatasetHotTier('missing'),
    ]) {
      await expect(operation).rejects.toMatchObject({ status: 404 });
    }
  });
  it('never uses the network', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    try {
      const client = createDemoClient();
      await client.createDataset('offline', { telemetryType: 'logs' });
      await client.setDatasetRetention('offline', []);
      await client.setDatasetHotTier('offline', `${10 * gib} Bytes`);
      await client.clearDatasetHotTier('offline');
      await client.deleteDataset('offline');
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });
});

it('round-trips creation metadata and static types; partition changes preserve historical stats', async () => {
  const client = createDemoClient();
  await client.createDataset('typed', {
    telemetryType: 'metrics',
    logSource: 'otel-metrics',
    datasetTags: ['apm'],
    datasetLabels: ['prod'],
    inferTimestamp: false,
    customPartition: 'service',
    staticSchema: {
      fields: [
        { name: 'service', data_type: 'string' },
        { name: 'value', data_type: 'double' },
      ],
    },
  });
  expect(await client.datasetInfo('typed')).toMatchObject({
    datasetTags: ['apm'],
    datasetLabels: ['prod'],
    inferTimestamp: false,
    staticSchemaFlag: true,
  });
  expect((await client.datasetSchema('typed')).fields).toContainEqual({
    name: 'value',
    dataType: 'Float64',
    nullable: true,
  });
  expect(await client.schema('typed')).toEqual(['p_timestamp', 'service', 'value']);
  await expect(client.updateDatasetCustomPartition('typed', 'missing')).rejects.toMatchObject({
    status: 400,
  });
  await client.updateDatasetCustomPartition('typed', 'value');
  await client.setDatasetTimePartitionLimit('typed', 14);
  expect(await client.datasetInfo('typed')).toMatchObject({
    customPartition: 'value',
    timePartitionLimit: '14',
  });
  await client.updateDatasetCustomPartition('typed');
  expect((await client.datasetInfo('typed')).customPartition).toBeUndefined();
  const before = await client.datasetStats('application_logs');
  await client.updateDatasetCustomPartition('application_logs', 'service');
  expect(await client.datasetStats('application_logs')).toEqual(before);
});

it('demo rejects labels that cannot round-trip through the live header', async () => {
  const client = createDemoClient();
  for (const datasetLabels of [['équipe'], ['prod,staging'], ['\tprod']])
    await expect(
      client.createDataset('unsafe_labels', { telemetryType: 'logs', datasetLabels }),
    ).rejects.toMatchObject({ status: 400 });
  expect((await client.listDatasets()).some((item) => item.name === 'unsafe_labels')).toBe(false);
});
