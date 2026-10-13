import { object } from './teamContract';
import type { DatasetHotTier, DatasetRetention, DatasetStats } from './types';

const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;
const bytes = (value: unknown): value is string =>
  typeof value === 'string' && /^\d+ Bytes$/.test(value);

export function datasetStats(value: unknown): value is DatasetStats {
  if (
    !object(value) ||
    typeof value.stream !== 'string' ||
    typeof value.time !== 'string' ||
    !Number.isFinite(Date.parse(value.time)) ||
    !object(value.ingestion) ||
    !object(value.storage)
  )
    return false;
  const { ingestion, storage } = value;
  return (
    typeof ingestion.format === 'string' &&
    typeof storage.format === 'string' &&
    [
      ingestion.count,
      ingestion.size,
      ingestion.lifetime_count,
      ingestion.lifetime_size,
      ingestion.deleted_count,
      ingestion.deleted_size,
      storage.size,
      storage.lifetime_size,
      storage.deleted_size,
    ].every(count)
  );
}

export function datasetRetention(value: unknown): value is DatasetRetention {
  return (
    Array.isArray(value) &&
    value.length <= 1 &&
    value.every((task) => {
      if (
        !object(task) ||
        typeof task.description !== 'string' ||
        task.action !== 'delete' ||
        typeof task.duration !== 'string' ||
        !/^\d+d$/.test(task.duration)
      )
        return false;
      const days = Number(task.duration.slice(0, -1));
      return days >= 1 && days <= 36500;
    })
  );
}

export function datasetHotTier(value: unknown): value is DatasetHotTier {
  return (
    object(value) &&
    (value.version === null || typeof value.version === 'string') &&
    bytes(value.size) &&
    bytes(value.used_size) &&
    bytes(value.available_size) &&
    (value.oldest_date_time_entry === undefined || typeof value.oldest_date_time_entry === 'string')
  );
}

/** Arrow schemas are read contracts; static creation uses a different, explicit primitive format. */
export function readDatasetSchema(value: unknown): import('./types').DatasetSchema | undefined {
  const metadata = (v: unknown): v is Record<string, string> =>
    object(v) && Object.values(v).every((x) => typeof x === 'string');
  if (
    !object(value) ||
    !Array.isArray(value.fields) ||
    (value.metadata !== undefined && !metadata(value.metadata))
  )
    return undefined;
  const fields: import('./types').DatasetSchemaField[] = [];
  for (const field of value.fields) {
    if (
      !object(field) ||
      typeof field.name !== 'string' ||
      (field.nullable !== undefined && typeof field.nullable !== 'boolean') ||
      (field.metadata !== undefined && !metadata(field.metadata))
    )
      return undefined;
    fields.push({
      name: field.name,
      dataType: field.data_type ?? field.dataType,
      nullable: field.nullable as boolean | undefined,
      metadata: field.metadata as Record<string, string> | undefined,
    });
  }
  return { fields, metadata: value.metadata as Record<string, string> | undefined };
}
export const datasetTags: import('./types').DatasetTag[] = [
  'agent-observability',
  'k8s-observability',
  'database-observability',
  'apm',
  'service-map',
];
export const staticTypes: import('./types').DatasetStaticType[] = [
  'string',
  'int',
  'double',
  'float',
  'boolean',
  'datetime',
  'date',
];
export function parseStaticSchema(
  value: unknown,
  partition = '',
): import('./types').DatasetStaticSchema {
  if (
    !object(value) ||
    !Array.isArray(value.fields) ||
    value.fields.length === 0 ||
    value.fields.length > 200
  )
    throw new Error('Provide 1–200 fields in a {fields:[{name,data_type}]} schema.');
  const names = new Set<string>();
  const fields = value.fields.map((field) => {
    if (!object(field) || typeof field.name !== 'string' || !field.name.trim())
      throw new Error('Every field needs a nonempty name.');
    if (field.name === 'p_timestamp')
      throw new Error('p_timestamp is reserved and added by the server.');
    if (names.has(field.name)) throw new Error(`Duplicate field: ${field.name}`);
    names.add(field.name);
    if (!staticTypes.includes(field.data_type as import('./types').DatasetStaticType))
      throw new Error(`Unsupported type for ${field.name}. Use ${staticTypes.join(', ')}.`);
    if (Object.keys(field).some((key) => key !== 'name' && key !== 'data_type'))
      throw new Error(
        'Creation fields only support name and data_type. Arrow schemas cannot be uploaded directly.',
      );
    return { name: field.name, data_type: field.data_type as import('./types').DatasetStaticType };
  });
  if (partition && !names.has(partition))
    throw new Error(`Custom partition ${partition} must exist in the static schema.`);
  return { fields };
}
export function schemaTypeLabel(value: unknown): string {
  return value === undefined
    ? 'Not reported'
    : typeof value === 'string'
      ? value
      : JSON.stringify(value);
}

/** Keep numeric selection explicit; timestamp and compound Arrow types are not numbers. */
export function numericDatasetField(field: import('./types').DatasetSchemaField): boolean {
  return (
    typeof field.dataType === 'string' &&
    /^(?:U?Int(?:8|16|32|64)|Float(?:16|32|64))$/.test(field.dataType)
  );
}

/** Rust's kebab-case serde spelling for the APM acronym differs from its accepted header/Display spelling. */
export function normalizeDatasetTag(value: string): string {
  return value === 'a-p-m' ? 'apm' : value;
}

export function datasetLabelsError(labels: readonly string[]): string | undefined {
  if (labels.some((label) => /[\x00-\x1f\x7f-\uffff]/.test(label)))
    return 'Dataset labels must use printable ASCII characters only (space through ~).';
  if (labels.some((label) => label.includes(',')))
    return 'Commas separate dataset labels and cannot appear inside a label.';
  if (labels.some((label) => !label.trim())) return 'Dataset labels cannot be empty.';
}
