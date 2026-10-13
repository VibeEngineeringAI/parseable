import { describe, expect, it } from 'vitest';
import { numericDatasetField, parseStaticSchema, readDatasetSchema } from './datasetsContract';

describe('typed dataset schema', () => {
  it('retains Arrow types, nullability and metadata without coercing compound fields', () => {
    const timestamp = { Timestamp: ['Millisecond', null] };
    expect(
      readDatasetSchema({
        fields: [
          { name: 'value', data_type: 'Float64', nullable: false, metadata: { unit: 'ms' } },
          { name: 'time', dataType: timestamp },
        ],
        metadata: { source: 'otlp' },
      }),
    ).toEqual({
      fields: [
        { name: 'value', dataType: 'Float64', nullable: false, metadata: { unit: 'ms' } },
        { name: 'time', dataType: timestamp, nullable: undefined, metadata: undefined },
      ],
      metadata: { source: 'otlp' },
    });
    expect(
      readDatasetSchema({ fields: [{ name: 'name_only' }] })?.fields[0].dataType,
    ).toBeUndefined();
  });
  it.each([
    null,
    {},
    { fields: [{ name: 1 }] },
    { fields: [{ name: 'a', nullable: 'yes' }] },
    { fields: [], metadata: { unit: 1 } },
  ])('rejects malformed typed responses %#', (value) =>
    expect(readDatasetSchema(value)).toBeUndefined(),
  );
  it.each(['Int8', 'Int64', 'UInt64', 'Float32', 'Float64'])(
    'recognizes numeric Arrow %s',
    (dataType) => expect(numericDatasetField({ name: 'x', dataType })).toBe(true),
  );
  it.each([
    'Utf8',
    'Boolean',
    'Date32',
    undefined,
    { Timestamp: ['Millisecond', null] },
    { List: { data_type: 'Int64' } },
  ])('excludes nonnumeric/unknown fields %#', (dataType) =>
    expect(numericDatasetField({ name: 'x', dataType })).toBe(false),
  );
});
describe('primitive static creation schema', () => {
  it('accepts supported primitive types and a present partition', () =>
    expect(
      parseStaticSchema(
        {
          fields: [
            { name: 'service', data_type: 'string' },
            { name: 'count', data_type: 'int' },
          ],
        },
        'service',
      ),
    ).toEqual({
      fields: [
        { name: 'service', data_type: 'string' },
        { name: 'count', data_type: 'int' },
      ],
    }));
  it.each([
    [{ fields: [] }, 'Provide'],
    [{ fields: [{ name: '', data_type: 'string' }] }, 'nonempty'],
    [{ fields: [{ name: 'p_timestamp', data_type: 'datetime' }] }, 'reserved'],
    [
      {
        fields: [
          { name: 'x', data_type: 'int' },
          { name: 'x', data_type: 'string' },
        ],
      },
      'Duplicate',
    ],
    [{ fields: [{ name: 'x', data_type: 'struct' }] }, 'Unsupported'],
    [{ fields: [{ name: 'x', data_type: 'string', nullable: true }] }, 'Arrow schemas'],
  ])('rejects unsafe or unsupported schema %#', (value, message) =>
    expect(() => parseStaticSchema(value)).toThrow(String(message)),
  );
  it('rejects missing static custom partition', () =>
    expect(() =>
      parseStaticSchema({ fields: [{ name: 'x', data_type: 'int' }] }, 'missing'),
    ).toThrow('must exist'));
});

it('normalizes the server APM acronym while preserving future classifications', async () => {
  const { normalizeDatasetTag } = await import('./datasetsContract');
  expect(['a-p-m', 'apm', 'agent-observability', 'future-domain'].map(normalizeDatasetTag)).toEqual(
    ['apm', 'apm', 'agent-observability', 'future-domain'],
  );
});
