import { describe, expect, it } from 'vitest';
import { ApiError } from '../../lib/client';
import {
  datasetError,
  gib,
  hotTierBytes,
  hotTierUnavailable,
  retentionDays,
  retentionFromDays,
  validateCustomPartition,
  validateDatasetName,
} from './helpers';

describe('dataset names match the server validator', () => {
  it.each([
    'a',
    'A',
    '_',
    '-',
    '9',
    'logs_2026-prod',
    'UPPERCASE',
    'Select',
    'default_tenant',
    'café',
    '日志',
    'Ⅷ',
    'a'.repeat(1000),
  ])('accepts %s without extra length, case or separator rules', (value) => {
    expect(validateDatasetName(value)).toBeUndefined();
  });
  it.each([
    'select',
    'from',
    'where',
    'group',
    'by',
    'order',
    'limit',
    'offset',
    'join',
    'and',
    'sql',
  ])('rejects the SQL keyword %s', (value) => {
    expect(validateDatasetName(value)).toBe('SQL keyword cannot be used as stream name');
  });
  it.each([
    '',
    'has space',
    'has.dot',
    'slash/name',
    'tabs\t',
    'newline\n',
    'emoji🚀',
    'DEFAULT_TENANT',
  ])('rejects %j', (value) => {
    expect(validateDatasetName(value)).toBeTruthy();
  });
});
describe('partition and duration helpers', () => {
  it.each(['', 'service', 'region_name', 'customer-id'])(
    'accepts a single custom partition %j',
    (value) => {
      expect(validateCustomPartition(value)).toBeUndefined();
    },
  );
  it.each(['one,two', 'nested.field'])('rejects an unsupported partition %s', (value) => {
    expect(validateCustomPartition(value)).toBeTruthy();
  });
  it.each(['1', '7', '30', '36500', '007'])('parses and formats %s retention days', (value) => {
    expect(retentionDays(value)).toBe(Number(value));
    expect(retentionFromDays(Number(value))).toEqual([
      {
        description: `Delete data older than ${Number(value)} days`,
        action: 'delete',
        duration: `${Number(value)}d`,
      },
    ]);
  });
  it.each(['', '0', '-1', '36501', '1.5', '1d', '1e2', 'Infinity', ' 7 ', '999999999999999999999'])(
    'rejects %j retention days',
    (value) => {
      expect(retentionDays(value)).toBeUndefined();
    },
  );
  it.each(['10', '20', '10.5'])('formats %s GiB as the server byte string', (value) => {
    expect(hotTierBytes(value)).toBe(`${Number(value) * gib} Bytes`);
  });
  it.each(['', '9', '-10', '10 GiB', 'Infinity', '1e2', '1000000000000000', '10.0000000001'])(
    'rejects %j hot-tier sizes',
    (value) => {
      expect(hotTierBytes(value)).toBeUndefined();
    },
  );
});
describe('dataset section errors', () => {
  it('explains 403 while retaining the server message', () => {
    expect(datasetError(new ApiError('Forbidden', 403), 'delete this dataset')).toBe(
      "You don't have permission to delete this dataset. Forbidden",
    );
    expect(datasetError(new ApiError('Duplicate dataset', 400), 'create datasets')).toBe(
      'Duplicate dataset',
    );
    expect(datasetError('Network error', 'create datasets')).toBe('Network error');
  });
  it('recognizes disabled server configuration without mistaking authorization or missing dataset allocation', () => {
    expect(
      hotTierUnavailable(
        new ApiError(
          'Hot tier is not enabled at the server config, cannot enable hot tier for stream logs',
          403,
        ),
      ),
    ).toBe(true);
    expect(hotTierUnavailable(new ApiError('Hot tier not configured on the server', 400))).toBe(
      true,
    );
    expect(hotTierUnavailable(new ApiError('Permission denied', 403))).toBe(false);
    expect(hotTierUnavailable(new ApiError('Hot tier not found for stream logs', 500))).toBe(false);
    expect(hotTierUnavailable(new Error('Network error'))).toBe(false);
  });
});
